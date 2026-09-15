import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FileKey2, Upload } from 'lucide-react';
import { expectedSeriesLabel } from '../domain/expected-issuance';
import { formatContractBidRatePercent } from '../domain/commit-domain';
import { calculateEscrowLockMinor } from '../domain/escrow-lock';
import { fromViemPublicClient } from '../protocol/read-client';
import { VenueAuctionAdapter } from '../protocol/venue-adapter';
import { contractCurrencyTerms, formatCoenCurrency } from '../oracle/multi-currency-evidence';
import { formatPaymentTokenAmount as formatTokenAmount, formatPromisAmount, intexUnit } from '../ui/display-format';
import { useCurrencyRates } from '../oracle/currency-state';
import type { OracleConversions } from '../oracle/oracle-conversions';
import { createPublicReadClient } from '../chain/create-public-read-client';
import type { WorldwideDayKey } from '../domain/protocol-time';
import type { ResolvedVenueReadProfile } from '../runtime-config/load-reviewed-runtime-config';
import {
  browserReceiptDownload,
  downloadReceipt,
  exportAllReceipts,
  importReceiptFiles,
} from '../receipts/import-export';
import {
  listStoredRevealMaterials,
  listTransactionAttempts,
  receiptMatchesContext,
  type ReceiptActiveContext,
  type ReceiptStorage,
  type StoredRevealMaterialV1,
} from '../receipts/receipt-store';
import { Button, Icon, Notice } from '../ui/primitives';
import { Modal, ModalTitle } from '../ui/modal';
import './receipt-tools.css';

interface ReceiptToolsProps {
  activeContext?: ReceiptActiveContext;
  profile?: ResolvedVenueReadProfile;
  showTrigger?: boolean;
}

interface ReceiptSummary {
  key: string;
  worldwideDay: number;
  commitHash: string;
  bidder: string;
}

export interface BidReceiptDetailModel {
  auctionLabel: string;
  seriesCode: string;
  quantity: string;
  bidRate: string;
  totalEscrow: string;
  totalPromis: string;
  commitHash: string;
  commitExplorerUrl: string | null;
  chainId: string;
  bidder: string;
  auctionContract: string;
  contractExplorerUrl: string | null;
  readFailure: string | null;
}

const localReceiptStorage = (): Storage => {
  try {
    return globalThis.localStorage;
  } catch {
    throw new Error('Browser receipt storage is unavailable.');
  }
};

const shortHash = (value: string): string => `${value.slice(0, 10)}…${value.slice(-8)}`;
const auditId = (fileName: string, index: number): string => {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${index}`;
  return `${random}:${fileName}`;
};
const spacedWorldwideDay = (worldwideDay: number): string => {
  const value = String(worldwideDay).padStart(8, '0');
  return `${value.slice(0, 4)} ${value.slice(4, 6)} ${value.slice(6, 8)}`;
};
const currentWorldwideDay = (): number | null => {
  const match = globalThis.location?.pathname.match(/\/auction\/(\d{8})(?:\/|$)/);
  return match?.[1] === undefined ? null : Number(match[1]);
};
const explorerUrl = (base: string | null, kind: 'tx' | 'address', value: string): string | null => {
  if (base === null) return null;
  try {
    const normalized = base.endsWith('/') ? base : `${base}/`;
    return new URL(`${kind}/${value}`, normalized).toString();
  } catch {
    return null;
  }
};
// Explorer links target broadcast transaction hashes, never commitHash; unconfigured explorers render no link.
export const latestCommitTransaction = (storage: ReceiptStorage, key: string): string | null => {
  const attempts = listTransactionAttempts(storage, key)
    .filter(
      (attempt) => (attempt.kind === 'commit' || attempt.kind === 'recommit') && attempt.transactionHash !== undefined,
    )
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  return attempts.at(-1)?.transactionHash ?? null;
};

export const baseReceiptDetailModel = (
  stored: StoredRevealMaterialV1,
  key: string,
  profile: ResolvedVenueReadProfile,
  storage: ReceiptStorage = localReceiptStorage(),
): BidReceiptDetailModel => {
  const material = stored.material;
  const transactionHash = latestCommitTransaction(storage, key);
  return {
    auctionLabel: `Auction ${spacedWorldwideDay(material.worldwideDay)}`,
    seriesCode: 'Assigned at issuance',
    quantity: `${material.quantity.toLocaleString('en-GB')} ${intexUnit(material.quantity)}`,
    bidRate: `${formatContractBidRatePercent(material.bidRate)} of strike`,
    totalEscrow: 'Unavailable',
    totalPromis: 'Unavailable',
    commitHash: material.commitHash,
    commitExplorerUrl: transactionHash === null ? null : explorerUrl(profile.explorerUrl, 'tx', transactionHash),
    chainId: String(material.chainId),
    bidder: material.bidder,
    auctionContract: material.auctionProxy,
    contractExplorerUrl: explorerUrl(profile.explorerUrl, 'address', material.auctionProxy),
    readFailure: null,
  };
};

export const loadBidReceiptDetailModel = async (
  stored: StoredRevealMaterialV1,
  key: string,
  profile: ResolvedVenueReadProfile,
  oracleConversions?: OracleConversions | null,
): Promise<BidReceiptDetailModel> => {
  const base = baseReceiptDetailModel(stored, key, profile);
  try {
    const selected = await createPublicReadClient(profile);
    const adapter = new VenueAuctionAdapter(fromViemPublicClient(selected.client), profile);
    const worldwideDay = String(stored.material.worldwideDay).padStart(8, '0') as WorldwideDayKey;
    const [auction, decimalsValue, symbolValue] = await Promise.all([
      adapter.readAuction(worldwideDay),
      selected.client.readContract({
        address: profile.addresses.paymentToken,
        abi: profile.abis.paymentToken,
        functionName: 'decimals',
      }),
      selected.client.readContract({
        address: profile.addresses.paymentToken,
        abi: profile.abis.paymentToken,
        functionName: 'symbol',
      }),
    ]);
    const decimals = Number(decimalsValue);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
      throw new RangeError('Payment-token decimals are outside the ERC-20 range.');
    }
    if (typeof symbolValue !== 'string' || symbolValue.length === 0) {
      throw new TypeError('Payment-token symbol is unavailable.');
    }

    const material = stored.material;
    const worldwideDayStr = String(material.worldwideDay).padStart(8, '0');
    const issuanceCurrencyNumber = material.issuanceCurrency ?? auction.params.issuanceCurrency;
    const referenceCurrencyNumber = material.referenceCurrency ?? auction.params.referenceCurrency;
    const seriesCode =
      expectedSeriesLabel(worldwideDayStr, issuanceCurrencyNumber, referenceCurrencyNumber) ?? 'Assigned at issuance';
    const quantity = BigInt(material.quantity);
    const totalEscrowMinor = calculateEscrowLockMinor({
      quantity,
      promisLoadMinor: auction.params.promisLoadMinor,
      bidRate: BigInt(material.bidRate),
    });
    const perIntexMinor = calculateEscrowLockMinor({
      quantity: 1n,
      promisLoadMinor: auction.params.promisLoadMinor,
      bidRate: BigInt(material.bidRate),
    });
    const terms = contractCurrencyTerms({
      issuanceCurrencies: auction.params.issuanceCurrencies ?? [],
      issuanceEntryPrices: auction.params.issuanceEntryPrices ?? [],
      strikeAmountsMinor: auction.params.strikeAmountsMinor ?? [],
      oraclePairIds: auction.params.oraclePairIds ?? [],
      issuanceCurrency: issuanceCurrencyNumber,
      referenceCurrency: auction.params.referenceCurrency,
      referenceEntryPriceMinor: auction.params.entryPriceMinor,
      promisLoadMinor: auction.params.promisLoadMinor,
    });
    const totalIssuance =
      terms === null
        ? null
        : formatCoenCurrency(
            totalEscrowMinor,
            terms.issuanceCurrency,
            oracleConversions,
            terms.issuanceEntryPriceMinor,
          );

    return {
      ...base,
      seriesCode,
      quantity: `${material.quantity.toLocaleString('en-GB')} ${intexUnit(material.quantity)}`,
      bidRate: `${formatContractBidRatePercent(material.bidRate)} of strike · ${formatTokenAmount(perIntexMinor, decimals, symbolValue)} / Intex`,
      totalEscrow: `${formatTokenAmount(totalEscrowMinor, decimals, symbolValue)}${totalIssuance === null || totalIssuance === 'Conversion unavailable' ? '' : ` · ${totalIssuance}`}`,
      totalPromis: `${formatPromisAmount(quantity * auction.params.promisLoadMinor)} Promis`,
    };
  } catch (error) {
    return {
      ...base,
      readFailure: `Current auction details could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

export function BidReceiptPanel({
  model,
  busy,
  message,
  failure,
  onDownload,
}: {
  model: BidReceiptDetailModel;
  busy: boolean;
  message: string | null;
  failure: string | null;
  onDownload: () => void;
}) {
  const summary = [
    ['Intex Series', model.seriesCode],
    ['Quantity', model.quantity],
    ['Bid rate', model.bidRate],
    ['Total escrow at reveal', model.totalEscrow],
    ['Total Promis', model.totalPromis],
  ] as const;
  const metadata = [
    ['Commit hash', model.commitHash, model.commitExplorerUrl],
    ['Chain ID', model.chainId, null],
    ['Bidder', model.bidder, null],
    ['Auction Contract', model.auctionContract, model.contractExplorerUrl],
  ] as const;

  return (
    <div className="receipt-tools__receipt-panel">
      <ModalTitle title="Bid Receipt" subtitle={model.auctionLabel} closeLabel="Close bid receipt" />
      <div className="receipt-modal__body">
        <dl className="receipt-modal__summary">
          {summary.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="receipt-modal__metadata">
          {metadata.map(([label, value, url]) => (
            <div key={label}>
              <span>{label}</span>
              <div>
                <code>{value}</code>
                {url && (
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    <Icon icon={ExternalLink} size={13} /> Explorer
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
        {model.readFailure && (
          <Notice tone="warning" live="polite">
            {model.readFailure}
          </Notice>
        )}
        <p className="receipt-modal__backup-note">
          Your bid is stored in local storage by default. Download a backup in case local storage is cleared or you need
          to reveal from another device. This file can be re-imported to recover and reveal your bid.
        </p>
        {message && (
          <Notice tone="info" live="polite">
            {message}
          </Notice>
        )}
        {failure && (
          <Notice tone="danger" live="assertive">
            {failure}
          </Notice>
        )}
        <Button className="receipt-modal__download" disabled={busy} onClick={onDownload}>
          <Icon icon={Download} size={16} /> Download bid receipt
        </Button>
      </div>
    </div>
  );
}

export function ReceiptTools({ activeContext, profile, showTrigger = true }: ReceiptToolsProps) {
  const oracleConversions = useCurrencyRates();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'manager' | 'detail'>('manager');
  const [busy, setBusy] = useState(false);
  const [receipts, setReceipts] = useState<readonly ReceiptSummary[]>([]);
  const [selectedReceipt, setSelectedReceipt] = useState<{ key: string; stored: StoredRevealMaterialV1 } | null>(null);
  const [detail, setDetail] = useState<BidReceiptDetailModel | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refreshGeneration = useRef(0);

  const close = () => {
    setOpen(false);
  };

  const closeComplete = () => {
    setSelectedReceipt(null);
    setDetail(null);
    setMode('manager');
  };

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const stored = await listStoredRevealMaterials(localReceiptStorage());
      if (generation !== refreshGeneration.current) return;
      setReceipts(
        stored.map(({ key, stored: record }) => ({
          key,
          worldwideDay: record.material.worldwideDay,
          commitHash: record.material.commitHash,
          bidder: record.material.bidder,
        })),
      );
      setFailure(null);
    } catch (error) {
      if (generation !== refreshGeneration.current) return;
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    const openFromApplication = () => {
      void (async () => {
        setMessage(null);
        setFailure(null);
        const worldwideDay = currentWorldwideDay();
        if (activeContext === undefined || worldwideDay === null) {
          setMode('manager');
          setOpen(true);
          return;
        }
        try {
          const stored = await listStoredRevealMaterials(localReceiptStorage());
          const selected = stored.find(
            ({ stored: record }) =>
              record.material.worldwideDay === worldwideDay && receiptMatchesContext(record.material, activeContext),
          );
          if (selected === undefined) {
            setMode('manager');
            setOpen(true);
            return;
          }
          setSelectedReceipt(selected);
          setMode('detail');
          setOpen(true);
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error));
          setMode('manager');
          setOpen(true);
        }
      })();
    };
    const manageFromApplication = () => {
      setSelectedReceipt(null);
      setDetail(null);
      setMessage(null);
      setFailure(null);
      setMode('manager');
      setOpen(true);
    };
    const importFromApplication = () => fileRef.current?.click();
    globalThis.addEventListener('itx-acn:open-receipts', openFromApplication);
    globalThis.addEventListener('itx-acn:manage-receipts', manageFromApplication);
    globalThis.addEventListener('itx-acn:import-receipt', importFromApplication);
    return () => {
      globalThis.removeEventListener('itx-acn:open-receipts', openFromApplication);
      globalThis.removeEventListener('itx-acn:manage-receipts', manageFromApplication);
      globalThis.removeEventListener('itx-acn:import-receipt', importFromApplication);
    };
  }, [activeContext]);

  useEffect(() => {
    if (open && mode === 'manager') void refresh();
  }, [open, mode, refresh]);

  useEffect(() => {
    if (!open || mode !== 'detail' || selectedReceipt === null || profile === undefined) return undefined;
    let cancelled = false;
    setDetail(null);
    void loadBidReceiptDetailModel(selectedReceipt.stored, selectedReceipt.key, profile, oracleConversions).then(
      (model) => {
        if (!cancelled) setDetail(model);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, mode, oracleConversions, profile, selectedReceipt]);

  const exportAll = async () => {
    setBusy(true);
    setMessage(null);
    setFailure(null);
    try {
      const exportedAt = new Date().toISOString();
      const contents = await exportAllReceipts(localReceiptStorage(), exportedAt);
      await browserReceiptDownload(`intex-bid-receipts-${exportedAt.slice(0, 10)}.json`, contents, 'application/json');
      setMessage('Receipt export download was initiated. Confirm the backup exists before relying on it.');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const downloadOne = async (receipt: ReceiptSummary) => {
    setBusy(true);
    setMessage(null);
    setFailure(null);
    try {
      const result = await downloadReceipt({
        storage: localReceiptStorage(),
        revealMaterialKey: receipt.key,
        downloadedAt: new Date().toISOString(),
      });
      if (result === 'failed') throw new Error('The browser did not complete the receipt download.');
      setMessage(`Receipt ${shortHash(receipt.commitHash)} download was initiated.`);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      if (mode === 'manager') await refresh();
    }
  };

  const importFiles = async (files: readonly File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    setMessage(null);
    setFailure(null);
    try {
      const results = await importReceiptFiles({
        storage: localReceiptStorage(),
        files,
        importedAt: new Date().toISOString(),
        ...(activeContext === undefined ? {} : { activeContext }),
        auditId,
      });
      const imported = results
        .flatMap((result) => result.items)
        .filter((item) => item.outcome === 'imported' || item.outcome === 'valid-inactive-context').length;
      const duplicates = results
        .flatMap((result) => result.items)
        .filter((item) => item.outcome === 'duplicate').length;
      const rejected = results.flatMap((result) => result.items).length - imported - duplicates;
      setMessage(`Import complete: ${imported} retained, ${duplicates} duplicate, ${rejected} rejected.`);
      await refresh();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const selectedSummary =
    selectedReceipt === null
      ? null
      : {
          key: selectedReceipt.key,
          worldwideDay: selectedReceipt.stored.material.worldwideDay,
          commitHash: selectedReceipt.stored.material.commitHash,
          bidder: selectedReceipt.stored.material.bidder,
        };

  return (
    <>
      {showTrigger && (
        <Button
          className="app-shell__wallet receipt-tools__trigger"
          ref={triggerRef}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setMode('manager');
            setOpen(true);
          }}
        >
          <Icon icon={FileKey2} size={14} /> Receipts
        </Button>
      )}
      <input
        ref={fileRef}
        className="receipt-tools__file"
        type="file"
        accept="application/json,.json"
        multiple
        aria-label="Import bid receipt"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = '';
          void importFiles(files);
        }}
      />
      <Modal open={open} onClose={close} onCloseComplete={closeComplete} panelClassName="receipt-tools__panel">
        {mode === 'detail' && selectedReceipt !== null ? (
          detail === null ? (
            <div className="receipt-tools__receipt-panel">
              <ModalTitle
                title="Bid Receipt"
                subtitle={`Auction ${spacedWorldwideDay(selectedReceipt.stored.material.worldwideDay)}`}
                closeLabel="Close bid receipt"
              />
              <p className="receipt-modal__loading" role="status">
                Loading receipt details…
              </p>
            </div>
          ) : (
            <BidReceiptPanel
              model={detail}
              busy={busy}
              message={message}
              failure={failure}
              onDownload={() => {
                if (selectedSummary !== null) void downloadOne(selectedSummary);
              }}
            />
          )
        ) : (
          <div className="receipt-tools__manager">
            <ModalTitle title="Bid receipts" subtitle="Local safety records" closeLabel="Close receipt tools" />

            <div className="receipt-tools__actions">
              <Button disabled={busy} onClick={() => fileRef.current?.click()}>
                <Icon icon={Upload} size={16} /> Import JSON files
              </Button>
              <Button
                variant="secondary"
                disabled={busy || receipts.length === 0}
                onClick={() => {
                  void exportAll();
                }}
              >
                <Icon icon={Download} size={16} /> Export all receipts
              </Button>
            </div>

            {message && (
              <Notice tone="info" live="polite">
                {message}
              </Notice>
            )}
            {failure && (
              <Notice tone="danger" live="assertive">
                {failure}
              </Notice>
            )}

            <div className="receipt-tools__list" aria-live="polite">
              {receipts.length === 0 ? (
                <p className="receipt-tools__empty">No local bid receipts are stored.</p>
              ) : (
                receipts.map((receipt) => (
                  <div className="receipt-tools__row" key={receipt.key}>
                    <div>
                      <strong>WorldwideDay {receipt.worldwideDay}</strong>
                      <span>
                        {shortHash(receipt.commitHash)} · {receipt.bidder.slice(0, 8)}…{receipt.bidder.slice(-6)}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        void downloadOne(receipt);
                      }}
                    >
                      Download receipt
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
