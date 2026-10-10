import { getAddress, type Abi, type Address, type Hex } from 'viem';
import {
  asArray,
  asBoundedNumber,
  asBytes,
  asRecord,
  asUnsignedBigint,
  eventFromAbi,
  tupleValue,
} from '../chain/abi-coerce';
import type { WorldwideDayKey } from '../domain/protocol-time';
import type { AuctionReadClient } from '../protocol/read-client';
import { decodeVenueBidLock } from '../protocol/venue-decode';
import type { VenueBidLockState } from '../protocol/profile-types';
import type { VenueDeploymentProfile } from '../chain/deployment-profile';
import { decodeIntexLifecycle, type IntexLifecycle, type IntexTokenStatus } from '../domain/completion-domain';

export interface CompletionVenueProfile extends VenueDeploymentProfile {
  deploymentBlock: bigint;
  logBatchSize: number;
}

export interface TargetSeriesSnapshot {
  seriesId: Hex;
  worldwideDay: number;
  lifecycle: IntexLifecycle;
  issuedAt: bigint;
  calledAt: bigint;
  intexCallPeriod: bigint;
  issuedTokenId: bigint;
  settledTokenId: bigint;
  issuedIntexCount: number;
  promisLoadMinor: bigint;
  entryPriceMinor: bigint;
  floorPriceMinor: bigint;
  callPriceMinor: bigint;
}

export interface RecipientSeriesEvidence {
  seriesId: Hex;
  issuanceInstructionsReceived: boolean;
  deferred: boolean;
  deliveredEvent: boolean;
  wonCount: bigint;
  currentIssuedBalance: bigint;
  currentSettledBalance: bigint;
}

export interface BidderCompletionEvidence {
  lock: VenueBidLockState;
  recoveredAmount: bigint | null;
  burnedAmount: bigint | null;
}

export interface PortfolioTokenRow {
  seriesId: Hex;
  tokenId: bigint;
  tokenStatus: IntexTokenStatus;
  balance: bigint;
  targetSeries: TargetSeriesSnapshot;
}

const PAYMENT_TOKEN_SYMBOL_FALLBACK = 'wCOEN';

const logArgs = (value: unknown, label: string): Record<string, unknown> => {
  const record = asRecord(value, label);
  return asRecord(record.args, `${label}.args`);
};

const sameAddress = (left: unknown, right: Address): boolean =>
  typeof left === 'string' && getAddress(left) === getAddress(right);

const readPage = (value: unknown, itemLabel: string): { items: readonly unknown[]; total: bigint } => {
  const items = asArray(tupleValue(value, 'series', 0, itemLabel), `${itemLabel}.items`);
  const total = asUnsignedBigint(
    tupleValue(value, 'total', 2, itemLabel) ?? tupleValue(value, 'total', 1, itemLabel),
    `${itemLabel}.total`,
  );
  return { items, total };
};

export class CompletionVenueAdapter {
  constructor(
    private readonly client: AuctionReadClient,
    private readonly profile: CompletionVenueProfile,
  ) {}

  async readLatestBlockTimestamp(): Promise<bigint> {
    const blockNumber = await this.client.getBlockNumber();
    const block = asRecord(await this.client.getBlock({ blockNumber }), 'latest venue block');
    return asUnsignedBigint(block.timestamp, 'latest venue block timestamp');
  }

  async readPaymentToken(): Promise<{ decimals: number; symbol: string }> {
    const [decimalsRaw, symbolRaw] = await Promise.all([
      this.client.readContract({
        address: this.profile.addresses.paymentToken,
        abi: this.profile.abis.paymentToken,
        functionName: 'decimals',
      }),
      this.client.readContract({
        address: this.profile.addresses.paymentToken,
        abi: this.profile.abis.paymentToken,
        functionName: 'symbol',
      }),
    ]);
    const symbol =
      typeof symbolRaw === 'string' && symbolRaw.trim().length > 0 ? symbolRaw.trim() : PAYMENT_TOKEN_SYMBOL_FALLBACK;
    return { decimals: asBoundedNumber(decimalsRaw, 'Payment-token decimals', 255), symbol };
  }

  async readWalletBalances(wallet: Address): Promise<{
    nativeBalance: bigint;
    paymentTokenBalance: bigint;
    paymentTokenDecimals: number;
    paymentTokenSymbol: string;
  }> {
    const [nativeBalance, paymentTokenBalance, paymentToken] = await Promise.all([
      this.client.getBalance({ address: wallet }),
      this.client
        .readContract({
          address: this.profile.addresses.paymentToken,
          abi: this.profile.abis.paymentToken,
          functionName: 'balanceOf',
          args: [wallet],
        })
        .then((raw) => asUnsignedBigint(raw, 'wallet payment-token balance')),
      this.readPaymentToken(),
    ]);
    return {
      nativeBalance,
      paymentTokenBalance,
      paymentTokenDecimals: paymentToken.decimals,
      paymentTokenSymbol: paymentToken.symbol,
    };
  }

  async readSeriesIdsByWorldwideDay(worldwideDay: WorldwideDayKey): Promise<readonly Hex[]> {
    const raw = asArray(
      await this.client.readContract({
        address: this.profile.addresses.intexNFT1155,
        abi: this.profile.abis.intexNFT1155,
        functionName: 'seriesIdsByWorldwideDay',
        args: [Number(worldwideDay)],
      }),
      'IntexNFT1155.seriesIdsByWorldwideDay',
    );
    const seen = new Set<string>();
    return raw.map((value, index) => {
      const seriesId = asBytes(value, 14, `series id ${index}`);
      if (seen.has(seriesId)) throw new TypeError(`Duplicate target series id ${seriesId}.`);
      seen.add(seriesId);
      return seriesId;
    });
  }

  async readTargetSeries(seriesId: Hex): Promise<TargetSeriesSnapshot> {
    const [dataRaw, tokenIdsRaw] = await Promise.all([
      this.client.readContract({
        address: this.profile.addresses.intexNFT1155,
        abi: this.profile.abis.intexNFT1155,
        functionName: 'readData',
        args: [seriesId],
      }),
      this.client.readContract({
        address: this.profile.addresses.intexNFT1155,
        abi: this.profile.abis.intexNFT1155,
        functionName: 'tokenIds',
        args: [seriesId],
      }),
    ]);
    const data = asRecord(dataRaw, 'IntexNFT1155.readData');
    const callTrigger = asRecord(data.callTrigger, 'IntexNFT1155.callTrigger');
    return {
      seriesId,
      worldwideDay: asBoundedNumber(data.worldwideDay, 'target series worldwideDay', 0xffff_ffff),
      lifecycle: decodeIntexLifecycle(asBoundedNumber(data.state, 'target series lifecycle', 0xff)),
      issuedAt: asUnsignedBigint(data.issuedAt, 'target series issuedAt'),
      calledAt: asUnsignedBigint(data.calledAt, 'target series calledAt'),
      intexCallPeriod: asUnsignedBigint(callTrigger.callNoticePeriod, 'target series call period'),
      issuedTokenId: asUnsignedBigint(tupleValue(tokenIdsRaw, 'issued', 0, 'IntexNFT1155.tokenIds'), 'issued token id'),
      settledTokenId: asUnsignedBigint(
        tupleValue(tokenIdsRaw, 'settled', 1, 'IntexNFT1155.tokenIds'),
        'settled token id',
      ),
      issuedIntexCount: asBoundedNumber(data.issuedIntexCount, 'target issued count', 0xffff_ffff),
      promisLoadMinor: asUnsignedBigint(data.promisLoadMinor, 'target Promis load'),
      entryPriceMinor: asUnsignedBigint(data.entryPriceMinor, 'target Entry'),
      floorPriceMinor: asUnsignedBigint(data.floorPriceMinor, 'target Floor'),
      callPriceMinor: asUnsignedBigint(data.callPriceMinor, 'target Call'),
    };
  }

  private async scanEvent(
    address: Address,
    abi: Abi,
    name: string,
    args?: Readonly<Record<string, unknown>>,
  ): Promise<readonly unknown[]> {
    const latest = await this.client.getBlockNumber();
    const logs: unknown[] = [];
    const batch = BigInt(Math.max(1, this.profile.logBatchSize));
    for (let fromBlock = this.profile.deploymentBlock; fromBlock <= latest; fromBlock += batch) {
      const toBlock = fromBlock + batch - 1n > latest ? latest : fromBlock + batch - 1n;
      const request = { address, event: eventFromAbi(abi, name), fromBlock, toBlock };
      logs.push(...(await this.client.getLogs(args ? { ...request, args } : request)));
    }
    return logs;
  }

  async readRecipientEvidence(seriesId: Hex, wallet: Address): Promise<RecipientSeriesEvidence> {
    const [instructions, parkedLogs, appliedLogs, issuedLogs, balancesRaw, tokenIdsRaw] = await Promise.all([
      this.scanEvent(
        this.profile.addresses.targetRouter,
        this.profile.abis.targetRouter,
        'IssuanceInstructionsReceived',
        { seriesId },
      ),
      this.scanEvent(this.profile.addresses.targetRouter, this.profile.abis.targetRouter, 'IssuanceParked', {
        seriesId,
        recipient: wallet,
      }),
      this.scanEvent(this.profile.addresses.targetRouter, this.profile.abis.targetRouter, 'ParkedIssuanceApplied', {
        seriesId,
      }),
      this.scanEvent(this.profile.addresses.intexNFT1155, this.profile.abis.intexNFT1155, 'IntexIssued', {
        to: wallet,
      }),
      this.client.readContract({
        address: this.profile.addresses.intexNFT1155,
        abi: this.profile.abis.intexNFT1155,
        functionName: 'ownerBalances',
        args: [seriesId, wallet],
      }),
      this.client.readContract({
        address: this.profile.addresses.intexNFT1155,
        abi: this.profile.abis.intexNFT1155,
        functionName: 'tokenIds',
        args: [seriesId],
      }),
    ]);
    const parkedIndices = new Set(
      parkedLogs.map((log, index) =>
        asUnsignedBigint(logArgs(log, `parked log ${index}`).idx, 'parked index').toString(),
      ),
    );
    for (const [index, log] of appliedLogs.entries()) {
      parkedIndices.delete(asUnsignedBigint(logArgs(log, `applied log ${index}`).idx, 'applied index').toString());
    }
    const issuedTokenId = asUnsignedBigint(
      tupleValue(tokenIdsRaw, 'issued', 0, 'IntexNFT1155.tokenIds'),
      'series issued token id',
    );
    const wonCount = issuedLogs.reduce<bigint>((sum, log, index) => {
      const args = logArgs(log, `issued log ${index}`);
      if (!sameAddress(args.to, wallet)) return sum;
      if (asUnsignedBigint(args.tokenId, 'issued token id') !== issuedTokenId) return sum;
      return sum + asUnsignedBigint(args.quantity, 'issued quantity');
    }, 0n);
    const deliveredEvent = wonCount > 0n;
    return {
      seriesId,
      issuanceInstructionsReceived: instructions.length > 0,
      deferred: parkedIndices.size > 0,
      deliveredEvent,
      wonCount,
      currentIssuedBalance: asUnsignedBigint(tupleValue(balancesRaw, 'issued', 0, 'owner balances'), 'issued balance'),
      currentSettledBalance: asUnsignedBigint(
        tupleValue(balancesRaw, 'settled', 1, 'owner balances'),
        'settled balance',
      ),
    };
  }

  async readBidderCompletion(worldwideDay: WorldwideDayKey, wallet: Address): Promise<BidderCompletionEvidence> {
    const [lockRaw, refunds, burns] = await Promise.all([
      this.client.readContract({
        address: this.profile.addresses.escrowAdapter,
        abi: this.profile.abis.escrowAdapter,
        functionName: 'getBidLock',
        args: [Number(worldwideDay), wallet],
      }),
      this.scanEvent(this.profile.addresses.escrowAdapter, this.profile.abis.escrowAdapter, 'FundsRefunded', {
        worldwideDay: Number(worldwideDay),
        bidder: wallet,
      }),
      this.scanEvent(this.profile.addresses.escrowAdapter, this.profile.abis.escrowAdapter, 'ProceedsBurned', {
        worldwideDay: Number(worldwideDay),
        bidder: wallet,
      }),
    ]);
    const recoveryRefunds = refunds.reduce<bigint>((sum, log, index) => {
      const args = logArgs(log, `refund log ${index}`);
      return args.receiveId === `0x${'0'.repeat(64)}`
        ? sum + asUnsignedBigint(args.amount, 'recovery refund amount')
        : sum;
    }, 0n);
    const burnedAmount = burns.reduce<bigint>(
      (sum, log, index) => sum + asUnsignedBigint(logArgs(log, `burn log ${index}`).amount, 'burn amount'),
      0n,
    );
    return {
      lock: decodeVenueBidLock(lockRaw),
      recoveredAmount: recoveryRefunds > 0n ? recoveryRefunds : null,
      burnedAmount: burnedAmount > 0n ? burnedAmount : null,
    };
  }

  /**
   * The bidder's original submitted terms from the authoritative `BidRevealed` log
   * on the auction proxy. Logs are used rather than a live `getAuctionDetails`
   * bid-array read because `reapAuction` can delete stored bid arrays after a terminal
   * auction, whereas the log stays reconstructible. Returns `null` when no matching
   * event exists, so the caller does not fabricate original bid terms.
   */
  async readBidderRevealedBid(
    worldwideDay: WorldwideDayKey,
    wallet: Address,
  ): Promise<{ readonly quantity: bigint; readonly bidRate: bigint } | null> {
    const logs = await this.scanEvent(
      this.profile.addresses.intexAuction,
      this.profile.abis.intexAuction,
      'BidRevealed',
      { worldwideDay: Number(worldwideDay), bidder: wallet },
    );
    let latest: { key: readonly [bigint, number, number]; quantity: bigint; bidRate: bigint } | null = null;
    for (const [index, log] of logs.entries()) {
      const raw = asRecord(log, `BidRevealed log ${index}`);
      const args = logArgs(log, `BidRevealed log ${index}`);
      const quantity = asUnsignedBigint(args.quantity, 'BidRevealed quantity');
      const bidRate = asUnsignedBigint(args.bidRate, 'BidRevealed bidRate');
      if (quantity <= 0n || quantity > 65_535n) {
        throw new RangeError('BidRevealed quantity must be a positive uint16.');
      }
      if (bidRate <= 0n || bidRate > 1_000_000n) {
        throw new RangeError('BidRevealed bid rate must be within the reviewed 1e6 scale.');
      }
      const key = [
        asUnsignedBigint(raw.blockNumber, 'BidRevealed blockNumber'),
        asBoundedNumber(raw.transactionIndex ?? Number.MAX_SAFE_INTEGER, 'BidRevealed transactionIndex'),
        asBoundedNumber(raw.logIndex, 'BidRevealed logIndex'),
      ] as const;
      if (
        !latest ||
        key[0] > latest.key[0] ||
        (key[0] === latest.key[0] && key[1] > latest.key[1]) ||
        (key[0] === latest.key[0] && key[1] === latest.key[1] && key[2] > latest.key[2])
      ) {
        latest = { key, quantity, bidRate };
      }
    }
    return latest ? { quantity: latest.quantity, bidRate: latest.bidRate } : null;
  }

  async readPortfolio(wallet: Address, pageSize = 100): Promise<readonly PortfolioTokenRow[]> {
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new RangeError('Portfolio page size must be positive.');
    const allSeriesTokenIds: bigint[] = [];
    let totalSeries: bigint | null = null;
    for (let offset = 0n; totalSeries === null || offset < totalSeries; offset += BigInt(pageSize)) {
      const page = readPage(
        await this.client.readContract({
          address: this.profile.addresses.intexNFT1155,
          abi: this.profile.abis.intexNFT1155,
          functionName: 'getSeriesPaginated',
          args: [offset, pageSize],
        }),
        'target series page',
      );
      if (totalSeries !== null && page.total !== totalSeries)
        throw new TypeError('Target series total changed during pagination.');
      totalSeries = page.total;
      if (page.items.length === 0 && offset < page.total)
        throw new TypeError('Target series pagination ended before total.');
      allSeriesTokenIds.push(
        ...page.items.map((item, index) => asUnsignedBigint(item, `target series token ${index}`)),
      );
    }

    const tokenMap = new Map<string, { seriesId: Hex; tokenStatus: IntexTokenStatus }>();
    const targetBySeries = new Map<Hex, TargetSeriesSnapshot>();
    const knownTokenIds: bigint[] = [];
    for (const issuedToken of allSeriesTokenIds) {
      const seriesId = asBytes(`0x${issuedToken.toString(16).padStart(28, '0')}`, 14, 'target series id');
      const series = await this.readTargetSeries(seriesId);
      targetBySeries.set(seriesId, series);
      tokenMap.set(series.issuedTokenId.toString(), { seriesId, tokenStatus: 'issued' });
      tokenMap.set(series.settledTokenId.toString(), { seriesId, tokenStatus: 'settled' });
      knownTokenIds.push(series.issuedTokenId, series.settledTokenId);
    }

    const owned: Array<{ tokenId: bigint; balance: bigint }> = [];
    for (let offset = 0; offset < knownTokenIds.length; offset += pageSize) {
      const ids = knownTokenIds.slice(offset, offset + pageSize);
      const balances = asArray(
        await this.client.readContract({
          address: this.profile.addresses.intexNFT1155,
          abi: this.profile.abis.intexNFT1155,
          functionName: 'balanceOfBatch',
          args: [ids.map(() => wallet), ids],
        }),
        'owned balances',
      );
      if (balances.length !== ids.length) throw new TypeError('balanceOfBatch returned a mismatched balance count.');
      ids.forEach((tokenId, index) => {
        owned.push({ tokenId, balance: asUnsignedBigint(balances[index], `owned balance ${index}`) });
      });
    }

    return owned.flatMap(({ tokenId, balance }) => {
      if (balance <= 0n) return [];
      const mapping = tokenMap.get(tokenId.toString());
      if (!mapping) throw new TypeError(`Owned token ${tokenId} is not mapped by canonical target series enumeration.`);
      const targetSeries = targetBySeries.get(mapping.seriesId);
      if (!targetSeries) throw new TypeError(`Target series ${mapping.seriesId} was not loaded.`);
      return [{ ...mapping, tokenId, balance, targetSeries }];
    });
  }
}
