import { getAddress, type Address, type Hash, type Hex, type TransactionReceipt } from 'viem';
import {
  asAddress,
  asArray,
  asBigint,
  asBoolean,
  asHash,
  asRecord,
  asSafeNumber,
  asUint,
  asUintNumber,
  tupleValue,
} from '../chain/abi-coerce';
import {
  ERC1967_IMPLEMENTATION_SLOT,
  IncompatibleDeploymentError,
  IncompatibleWiringError,
  VenueAuctionNotFoundError,
  implementationAddressFromStorage,
  isAuctionNotFound,
} from '../chain/revert-classify';
import { toDurationSeconds, toUtcTimestamp, type WorldwideDayKey } from '../domain/protocol-time';
import { SECONDS_PER_DAY, USD_REFERENCE_CURRENCY } from '../domain/protocol-constants';
import { decodeVenueAuctionStage } from './read-model';
import { requireCode, type AuctionReadClient } from './read-client';
import type { VenueDeploymentProfile } from '../chain/deployment-profile';
import {
  asVenueDayType,
  dayNumber,
  decodeVenueAuctionEscrowState,
  decodeVenueBidLock,
  decodeVenueCommitBond,
} from './venue-decode';
import {
  buildApprovalCall,
  buildCancelCommitCall,
  buildCommitCall,
  buildRecoveryCall,
  buildRevealCall,
} from './venue-calls';
import {
  readCancellationReceiptEvidence,
  readCommitReceiptEvidence,
  readRecoveryReceiptEvidence,
  readRevealReceiptEvidence,
} from './venue-receipt-evidence';
import type {
  VenueAuctionRecoveryState,
  VenueAuctionSnapshot,
  VenueBidderState,
  VenueEscrowBidderState,
  VenueEscrowRecoveryState,
  VenueRecoveryContractConstants,
  VenueRecoveryPath,
} from './profile-types';

/** The reviewed venue auction adapter. */
export class VenueAuctionAdapter {
  private validation: Promise<void> | null = null;

  constructor(
    private readonly client: AuctionReadClient,
    private readonly profile: VenueDeploymentProfile,
  ) {}

  async validateDeployment(): Promise<void> {
    if (!this.validation) {
      this.validation = this.validateDeploymentUncached().catch((error) => {
        this.validation = null;
        throw error;
      });
    }
    return this.validation;
  }

  private async validateDeploymentUncached(): Promise<void> {
    const chainId = await this.client.getChainId();
    if (chainId !== this.profile.chainId) {
      throw new IncompatibleDeploymentError(
        `Venue chain mismatch: expected ${this.profile.chainId}, received ${chainId}.`,
      );
    }
    const codeChecks = [
      requireCode(this.client, 'IntexAuction', this.profile.addresses.intexAuction),
      requireCode(this.client, 'EscrowAdapter', this.profile.addresses.escrowAdapter),
      requireCode(this.client, 'TargetRouter', this.profile.addresses.targetRouter),
      requireCode(this.client, 'IntexNFT1155', this.profile.addresses.intexNFT1155),
      requireCode(this.client, 'payment token', this.profile.addresses.paymentToken),
    ];
    const reviewedImplementation = this.profile.addresses.intexAuctionImplementation;
    if (reviewedImplementation) {
      codeChecks.push(requireCode(this.client, 'IntexAuction implementation', reviewedImplementation));
    }
    await Promise.all(codeChecks);

    if (reviewedImplementation) {
      if (!this.client.getStorageAt) {
        throw new IncompatibleDeploymentError('IntexAuction proxy implementation evidence is unavailable.');
      }
      const actualImplementation = implementationAddressFromStorage(
        await this.client.getStorageAt({
          address: this.profile.addresses.intexAuction,
          slot: ERC1967_IMPLEMENTATION_SLOT,
        }),
      );
      if (actualImplementation !== getAddress(reviewedImplementation)) {
        throw new IncompatibleDeploymentError(
          'IntexAuction proxy implementation does not match the reviewed implementation.',
        );
      }

      const domain = await this.client.readContract({
        address: this.profile.addresses.intexAuction,
        abi: this.profile.abis.intexAuction,
        functionName: 'eip712Domain',
      });
      const domainName = tupleValue(domain, 'name', 1, 'IntexAuction.eip712Domain');
      const domainVersion = tupleValue(domain, 'version', 2, 'IntexAuction.eip712Domain');
      const domainChainId = tupleValue(domain, 'chainId', 3, 'IntexAuction.eip712Domain');
      const verifyingContract = tupleValue(domain, 'verifyingContract', 4, 'IntexAuction.eip712Domain');
      if (
        domainName !== 'IntexAuction' ||
        domainVersion !== '1' ||
        asBigint(domainChainId, 'IntexAuction EIP-712 chain ID') !== BigInt(this.profile.chainId) ||
        asAddress(verifyingContract, 'IntexAuction EIP-712 verifying contract') !==
          getAddress(this.profile.addresses.intexAuction)
      ) {
        throw new IncompatibleDeploymentError('IntexAuction EIP-712 domain does not match the reviewed proxy domain.');
      }
    }

    const [auction, escrow, intex, auctionEscrow, escrowAuction, paymentToken] = await Promise.all([
      this.client.readContract({
        address: this.profile.addresses.targetRouter,
        abi: this.profile.abis.targetRouter,
        functionName: 'auction',
      }),
      this.client.readContract({
        address: this.profile.addresses.targetRouter,
        abi: this.profile.abis.targetRouter,
        functionName: 'escrowAdapter',
      }),
      this.client.readContract({
        address: this.profile.addresses.targetRouter,
        abi: this.profile.abis.targetRouter,
        functionName: 'intex',
      }),
      this.client.readContract({
        address: this.profile.addresses.intexAuction,
        abi: this.profile.abis.intexAuction,
        functionName: 'escrowContract',
      }),
      this.client.readContract({
        address: this.profile.addresses.escrowAdapter,
        abi: this.profile.abis.escrowAdapter,
        functionName: 'intexAuctionContract',
      }),
      this.client.readContract({
        address: this.profile.addresses.escrowAdapter,
        abi: this.profile.abis.escrowAdapter,
        functionName: 'paymentToken',
      }),
    ]);
    if (asAddress(auction, 'TargetRouter.auction') !== getAddress(this.profile.addresses.intexAuction)) {
      throw new IncompatibleWiringError('TargetRouter auction wiring does not match the venue profile.');
    }
    if (asAddress(escrow, 'TargetRouter.escrowAdapter') !== getAddress(this.profile.addresses.escrowAdapter)) {
      throw new IncompatibleWiringError('TargetRouter escrow wiring does not match the venue profile.');
    }
    if (asAddress(intex, 'TargetRouter.intex') !== getAddress(this.profile.addresses.intexNFT1155)) {
      throw new IncompatibleWiringError('TargetRouter NFT wiring does not match the venue profile.');
    }
    if (asAddress(auctionEscrow, 'IntexAuction.escrowContract') !== getAddress(this.profile.addresses.escrowAdapter)) {
      throw new IncompatibleWiringError('IntexAuction escrow wiring does not match the venue profile.');
    }
    if (
      asAddress(escrowAuction, 'EscrowAdapter.intexAuctionContract') !== getAddress(this.profile.addresses.intexAuction)
    ) {
      throw new IncompatibleWiringError('EscrowAdapter auction wiring does not match the venue profile.');
    }
    if (asAddress(paymentToken, 'EscrowAdapter.paymentToken') !== getAddress(this.profile.addresses.paymentToken)) {
      throw new IncompatibleWiringError('EscrowAdapter payment-token wiring does not match the venue profile.');
    }
  }

  async readAuction(worldwideDay: WorldwideDayKey): Promise<VenueAuctionSnapshot> {
    const args = [dayNumber(worldwideDay)] as const;
    let stageRaw: unknown;
    let infoRaw: unknown;
    let countsRaw: unknown;
    try {
      [stageRaw, infoRaw, countsRaw] = await Promise.all([
        this.client.readContract({
          address: this.profile.addresses.intexAuction,
          abi: this.profile.abis.intexAuction,
          functionName: 'getAuctionStage',
          args,
        }),
        this.client.readContract({
          address: this.profile.addresses.intexAuction,
          abi: this.profile.abis.intexAuction,
          functionName: 'getAuctionInfo',
          args,
        }),
        this.client.readContract({
          address: this.profile.addresses.intexAuction,
          abi: this.profile.abis.intexAuction,
          functionName: 'auctionRunningCounts',
          args,
        }),
      ]);
    } catch (error) {
      if (isAuctionNotFound(error)) {
        throw new VenueAuctionNotFoundError(`Venue auction ${worldwideDay} was not found.`);
      }
      throw error;
    }
    const info = asRecord(infoRaw, 'IntexAuction.getAuctionInfo');
    const schedule = asRecord(info.schedule, 'IntexAuction.schedule');
    const params = asRecord(info.params, 'IntexAuction.params');
    const callTrigger = asRecord(params.callTrigger, 'IntexAuction.callTrigger');
    const result = asRecord(info.result, 'IntexAuction.result');
    const counts = asArray(countsRaw, 'IntexAuction.auctionRunningCounts');
    if (counts.length !== 2) throw new TypeError('IntexAuction.auctionRunningCounts returned an incompatible tuple.');
    const priceRows = asArray(params.prices, 'Auction reference-currency prices').map((row, index) => {
      const parsed = asRecord(row, `Auction.reference-currency price ${index}`);
      return {
        isoCode: asSafeNumber(parsed.isoCode, `Auction reference-currency ISO ${index}`),
        entryPriceMinor: asBigint(parsed.entryPriceMinor, `Auction entry price ${index}`),
        floorPriceMinor: asBigint(parsed.floorPriceMinor, `Auction floor price ${index}`),
        callPriceMinor: asBigint(parsed.callPriceMinor, `Auction call price ${index}`),
      };
    });
    const referenceCurrency =
      priceRows.find((row) => row.isoCode === USD_REFERENCE_CURRENCY)?.isoCode ?? priceRows[0]?.isoCode ?? 0;
    const activePrice = priceRows.find((row) => row.isoCode === referenceCurrency);
    const promisLoadMinor = asBigint(params.promisLoadMinor, 'Auction.promisLoadMinor');

    return {
      worldwideDay,
      stage: decodeVenueAuctionStage(asSafeNumber(stageRaw, 'Venue auction stage')),
      dayType: asVenueDayType(info.worldwideDayState),
      paymentToken: getAddress(this.profile.addresses.paymentToken),
      schedule: {
        commitEnd: toUtcTimestamp(asBigint(schedule.commitEnd, 'Auction.commitEnd')),
        revealEnd: toUtcTimestamp(asBigint(schedule.revealEnd, 'Auction.revealEnd')),
        issuanceEnd: toUtcTimestamp(asBigint(schedule.issuanceEnd, 'Auction.issuanceEnd')),
      },
      params: {
        issuanceCurrency: 0,
        issuanceCurrencies: [],
        referenceCurrency,
        referenceCurrencies: priceRows.map((row) => row.isoCode),
        referenceEntryPrices: priceRows.map((row) => row.entryPriceMinor),
        promisLoadMinor,
        minIntexBidRate: asSafeNumber(params.minIntexBidRate, 'Auction.minIntexBidRate'),
        minIntexBidQuantity: asSafeNumber(params.minIntexBidQuantity, 'Auction.minIntexBidQuantity'),
        entryPriceMinor: activePrice?.entryPriceMinor ?? 0n,
        floorPriceMinor: activePrice?.floorPriceMinor ?? 0n,
        callPriceMinor: activePrice?.callPriceMinor ?? 0n,
        commitBondMinor: asBigint(params.commitBondMinor, 'Auction.commitBondMinor'),
        callTrigger: {
          windowDays: Math.round(
            Number(asBigint(callTrigger.callWindow, 'Auction.callTrigger.callWindow')) / SECONDS_PER_DAY,
          ),
          thresholdDays: Math.round(
            Number(asBigint(callTrigger.callThreshold, 'Auction.callTrigger.callThreshold')) / SECONDS_PER_DAY,
          ),
          intexCallPeriod: toDurationSeconds(
            asBigint(callTrigger.callNoticePeriod, 'Auction.callTrigger.callNoticePeriod'),
          ),
        },
      },
      runningCounts: {
        committedBids: asSafeNumber(counts[0], 'Auction committed-bid count'),
        revealedBids: asSafeNumber(counts[1], 'Auction revealed-bid count'),
      },
      result: {
        auctionClearingRate: asBigint(result.auctionClearingRate, 'Auction.auctionClearingRate'),
        wonBidsCount: asSafeNumber(result.wonBidsCount, 'Auction.wonBidsCount'),
        issuedIntexCount: asSafeNumber(result.issuedIntexCount, 'Auction.issuedIntexCount'),
        issuedIntexLoadedPromis: asBigint(result.issuedIntexLoadedPromis, 'Auction.issuedIntexLoadedPromis'),
      },
    };
  }

  private async readEscrowBidderState(
    escrowContract: Address,
    worldwideDay: WorldwideDayKey,
    bidder: Address,
    symbolFallback?: string,
  ): Promise<VenueEscrowBidderState> {
    const args = [dayNumber(worldwideDay), bidder] as const;
    const [auctionRaw, paymentTokenRaw, bondRaw, bidLockRaw] = await Promise.all([
      this.client.readContract({
        address: escrowContract,
        abi: this.profile.abis.escrowAdapter,
        functionName: 'intexAuctionContract',
      }),
      this.client.readContract({
        address: escrowContract,
        abi: this.profile.abis.escrowAdapter,
        functionName: 'paymentToken',
      }),
      this.client.readContract({
        address: escrowContract,
        abi: this.profile.abis.escrowAdapter,
        functionName: 'getCommitBond',
        args,
      }),
      this.client.readContract({
        address: escrowContract,
        abi: this.profile.abis.escrowAdapter,
        functionName: 'getBidLock',
        args,
      }),
    ]);
    const paymentToken = asAddress(paymentTokenRaw, 'EscrowAdapter.paymentToken');
    const [decimalsRaw, symbolRaw] = await Promise.all([
      this.client.readContract({
        address: paymentToken,
        abi: this.profile.abis.paymentToken,
        functionName: 'decimals',
      }),
      this.client.readContract({
        address: paymentToken,
        abi: this.profile.abis.paymentToken,
        functionName: 'symbol',
      }),
    ]);
    const symbol = typeof symbolRaw === 'string' && symbolRaw.trim() ? symbolRaw.trim() : symbolFallback;
    if (!symbol) throw new TypeError('Payment-token symbol is unavailable.');
    return {
      auctionContract: asAddress(auctionRaw, 'EscrowAdapter.intexAuctionContract'),
      paymentToken,
      paymentTokenDecimals: asUintNumber(decimalsRaw, 8, 'Payment-token decimals'),
      paymentTokenSymbol: symbol,
      bond: decodeVenueCommitBond(bondRaw),
      bidLock: decodeVenueBidLock(bidLockRaw),
    };
  }

  async readBidderState(worldwideDay: WorldwideDayKey, bidder: Address): Promise<VenueBidderState> {
    const day = dayNumber(worldwideDay);
    const [stageRaw, infoRaw, liveCommitRaw, revealedRaw, escrowRaw] = await Promise.all([
      this.client.readContract({
        address: this.profile.addresses.intexAuction,
        abi: this.profile.abis.intexAuction,
        functionName: 'getAuctionStage',
        args: [day],
      }),
      this.client.readContract({
        address: this.profile.addresses.intexAuction,
        abi: this.profile.abis.intexAuction,
        functionName: 'getAuctionInfo',
        args: [day],
      }),
      this.client.readContract({
        address: this.profile.addresses.intexAuction,
        abi: this.profile.abis.intexAuction,
        functionName: 'committedBidsByHash',
        args: [day, bidder],
      }),
      this.client.readContract({
        address: this.profile.addresses.intexAuction,
        abi: this.profile.abis.intexAuction,
        functionName: 'revealedBidsByBidder',
        args: [day, bidder],
      }),
      this.client.readContract({
        address: this.profile.addresses.intexAuction,
        abi: this.profile.abis.intexAuction,
        functionName: 'escrowContract',
      }),
    ]);
    const escrowAdapter = asAddress(escrowRaw, 'IntexAuction.escrowContract');
    if (escrowAdapter !== getAddress(this.profile.addresses.escrowAdapter)) {
      throw new IncompatibleWiringError('IntexAuction escrow wiring does not match the venue profile.');
    }
    const escrow = await this.readEscrowBidderState(escrowAdapter, worldwideDay, bidder, 'wCOEN');
    if (escrow.auctionContract !== getAddress(this.profile.addresses.intexAuction)) {
      throw new IncompatibleWiringError('EscrowAdapter auction wiring does not match the venue profile.');
    }
    if (escrow.paymentToken !== getAddress(this.profile.addresses.paymentToken)) {
      throw new IncompatibleWiringError('EscrowAdapter payment-token wiring does not match the venue profile.');
    }
    const [balanceRaw, allowanceRaw] = await Promise.all([
      this.client.readContract({
        address: escrow.paymentToken,
        abi: this.profile.abis.paymentToken,
        functionName: 'balanceOf',
        args: [bidder],
      }),
      this.client.readContract({
        address: escrow.paymentToken,
        abi: this.profile.abis.paymentToken,
        functionName: 'allowance',
        args: [bidder, escrowAdapter],
      }),
    ]);

    const info = asRecord(infoRaw, 'IntexAuction.getAuctionInfo');
    const schedule = asRecord(info.schedule, 'IntexAuction.schedule');
    const params = asRecord(info.params, 'IntexAuction.params');
    const priceRows = asArray(params.prices, 'Auction reference-currency prices').map((row, index) => {
      const parsed = asRecord(row, `Auction reference-currency price ${index}`);
      return [
        asSafeNumber(parsed.isoCode, `Auction reference-currency ISO ${index}`),
        asBigint(parsed.entryPriceMinor, `Auction entry price ${index}`),
        asBigint(parsed.floorPriceMinor, `Auction floor price ${index}`),
        asBigint(parsed.callPriceMinor, `Auction call price ${index}`),
      ] as const;
    });
    const referenceCurrency =
      priceRows.find(([isoCode]) => isoCode === USD_REFERENCE_CURRENCY)?.[0] ?? priceRows[0]?.[0] ?? 0;
    const activePrice = priceRows.find(([isoCode]) => isoCode === referenceCurrency) ?? ([0, 0n, 0n, 0n] as const);
    const promisLoadMinor = asBigint(params.promisLoadMinor, 'Auction Promis load');

    return {
      stage: decodeVenueAuctionStage(asSafeNumber(stageRaw, 'Auction stage')),
      schedule: {
        commitEnd: asBigint(schedule.commitEnd, 'Auction commit deadline'),
        revealEnd: asBigint(schedule.revealEnd, 'Auction reveal deadline'),
        issuanceEnd: asBigint(schedule.issuanceEnd, 'Auction issuance deadline'),
      },
      params: {
        issuanceCurrencies: [],
        issuanceEntryPrices: [],
        strikeAmountsMinor: [],
        oraclePairIds: [],
        referenceCurrency,
        referenceCurrencies: priceRows.map(([isoCode]) => isoCode),
        referenceEntryPrices: priceRows.map(([, entryPriceMinor]) => entryPriceMinor),
        entryPriceMinor: activePrice[1],
        floorPriceMinor: activePrice[2],
        callPriceMinor: activePrice[3],
        promisLoadMinor,
        minIntexBidRate: asSafeNumber(params.minIntexBidRate, 'Auction minimum bid rate'),
        minIntexBidQuantity: asSafeNumber(params.minIntexBidQuantity, 'Auction minimum quantity'),
        commitBondMinor: asBigint(params.commitBondMinor, 'Auction commit bond'),
      },
      liveCommitHash: asHash(liveCommitRaw, 'Bidder commitment'),
      bidderRevealed: asBoolean(revealedRaw, 'Bidder revealed flag'),
      escrowAdapter,
      escrowAuction: escrow.auctionContract,
      paymentToken: escrow.paymentToken,
      paymentTokenDecimals: escrow.paymentTokenDecimals,
      paymentTokenSymbol: escrow.paymentTokenSymbol,
      balance: asUint(balanceRaw, 256, 'Payment-token balance'),
      allowance: asUint(allowanceRaw, 256, 'Payment-token allowance'),
      bidderBondAmount: escrow.bond.amount,
      bidderBondLockedAt: escrow.bond.lockedAt,
      bidLock: escrow.bidLock,
    };
  }

  async readEscrowRecoveryState(
    escrowContract: Address,
    worldwideDay: WorldwideDayKey,
    bidder: Address,
  ): Promise<VenueEscrowRecoveryState> {
    await requireCode(this.client, 'Recovery escrow', escrowContract);
    const [bidderState, [abandonedRaw, unfinalizedRaw, postFinalizeRaw, escrowStateRaw]] = await Promise.all([
      this.readEscrowBidderState(escrowContract, worldwideDay, bidder),
      Promise.all([
        this.client.readContract({
          address: escrowContract,
          abi: this.profile.abis.escrowAdapter,
          functionName: 'COMMIT_BOND_ABANDON_DELAY',
        }),
        this.client.readContract({
          address: escrowContract,
          abi: this.profile.abis.escrowAdapter,
          functionName: 'UNFINALIZED_REFUND_DELAY',
        }),
        this.client.readContract({
          address: escrowContract,
          abi: this.profile.abis.escrowAdapter,
          functionName: 'POST_FINALIZE_REFUND_DELAY',
        }),
        this.client.readContract({
          address: escrowContract,
          abi: this.profile.abis.escrowAdapter,
          functionName: 'auctionEscrowState',
          args: [dayNumber(worldwideDay)],
        }),
      ]),
    ]);
    const constants: VenueRecoveryContractConstants = {
      abandonedCommitBondDelay: asUint(abandonedRaw, 32, 'COMMIT_BOND_ABANDON_DELAY'),
      unfinalizedRefundDelay: asUint(unfinalizedRaw, 32, 'UNFINALIZED_REFUND_DELAY'),
      postFinalizeRefundDelay: asUint(postFinalizeRaw, 32, 'POST_FINALIZE_REFUND_DELAY'),
    };
    return {
      ...bidderState,
      constants,
      escrowState: decodeVenueAuctionEscrowState(escrowStateRaw),
    };
  }

  async readAuctionRecoveryState(worldwideDay: WorldwideDayKey): Promise<VenueAuctionRecoveryState> {
    const args = [dayNumber(worldwideDay)] as const;
    let stageRaw: unknown;
    let infoRaw: unknown;
    let escrowRaw: unknown;
    let delayRaw: unknown;
    try {
      [stageRaw, infoRaw, escrowRaw, delayRaw] = await Promise.all([
        this.client.readContract({
          address: this.profile.addresses.intexAuction,
          abi: this.profile.abis.intexAuction,
          functionName: 'getAuctionStage',
          args,
        }),
        this.client.readContract({
          address: this.profile.addresses.intexAuction,
          abi: this.profile.abis.intexAuction,
          functionName: 'getAuctionInfo',
          args,
        }),
        this.client.readContract({
          address: this.profile.addresses.intexAuction,
          abi: this.profile.abis.intexAuction,
          functionName: 'escrowContract',
        }),
        this.client.readContract({
          address: this.profile.addresses.intexAuction,
          abi: this.profile.abis.intexAuction,
          functionName: 'UNREVEALED_BOND_LOCK_PERIOD',
        }),
      ]);
    } catch (error) {
      if (isAuctionNotFound(error)) {
        throw new VenueAuctionNotFoundError(`Venue auction ${worldwideDay} was not found.`);
      }
      throw error;
    }
    const escrowContract = asAddress(escrowRaw, 'IntexAuction.escrowContract');
    if (escrowContract !== getAddress(this.profile.addresses.escrowAdapter)) {
      throw new IncompatibleWiringError('Current auction-to-escrow wiring does not match the venue profile.');
    }
    const info = asRecord(infoRaw, 'IntexAuction.getAuctionInfo');
    const schedule = asRecord(info.schedule, 'IntexAuction.schedule');
    return {
      escrowContract,
      stage: decodeVenueAuctionStage(asSafeNumber(stageRaw, 'Auction stage')),
      revealEnd: asBigint(schedule.revealEnd, 'Auction reveal deadline'),
      unrevealedBondLockPeriod: asUint(delayRaw, 32, 'UNREVEALED_BOND_LOCK_PERIOD'),
    };
  }

  buildApprovalCall(input: { readonly token: Address; readonly spender: Address; readonly amount: bigint }) {
    return buildApprovalCall(this.profile, input);
  }

  buildCommitCall(worldwideDay: WorldwideDayKey, commitHash: Hash) {
    return buildCommitCall(this.profile, worldwideDay, commitHash);
  }

  buildCancelCommitCall(worldwideDay: WorldwideDayKey) {
    return buildCancelCommitCall(this.profile, worldwideDay);
  }

  buildRevealCall(input: {
    readonly worldwideDay: WorldwideDayKey;
    readonly quantity: number;
    readonly bidRate: number;
    readonly issuanceCurrency: number;
    readonly referenceCurrency: number;
    readonly chainId: number;
    readonly signature: Hex;
  }) {
    return buildRevealCall(this.profile, input);
  }

  buildRecoveryCall(input: {
    readonly path: VenueRecoveryPath;
    readonly worldwideDay: WorldwideDayKey;
    readonly bidder: Address;
    readonly auctionContract: Address;
    readonly escrowContract: Address;
  }) {
    return buildRecoveryCall(this.profile, input);
  }

  readCommitReceiptEvidence(
    receipt: TransactionReceipt,
    expected: {
      readonly worldwideDay: WorldwideDayKey;
      readonly bidder: Address;
      readonly commitHash: Hash;
    },
  ): { readonly committed: boolean } {
    return readCommitReceiptEvidence(this.profile, receipt, expected);
  }

  readCancellationReceiptEvidence(
    receipt: TransactionReceipt,
    expected: {
      readonly worldwideDay: WorldwideDayKey;
      readonly bidder: Address;
      readonly escrowContract: Address;
      readonly bondAmount: bigint;
    },
  ): { readonly cancelled: boolean; readonly released: boolean } {
    return readCancellationReceiptEvidence(this.profile, receipt, expected);
  }

  readRevealReceiptEvidence(
    receipt: TransactionReceipt,
    expected: {
      readonly worldwideDay: WorldwideDayKey;
      readonly bidder: Address;
      readonly escrowContract: Address;
      readonly issuanceCurrency: number;
      readonly quantity: number;
      readonly bidRate: number;
      readonly lockAmount: bigint;
      readonly bondAmount: bigint;
    },
  ): { readonly revealed: boolean; readonly locked: boolean; readonly released: boolean } {
    return readRevealReceiptEvidence(this.profile, receipt, expected);
  }

  readRecoveryReceiptEvidence(
    receipt: TransactionReceipt,
    expected: {
      readonly worldwideDay: WorldwideDayKey;
      readonly bidder: Address;
      readonly escrowContract: Address;
      readonly returnedAmount: bigint;
      readonly burnedAmount: bigint;
    },
  ): {
    readonly released: boolean;
    readonly refunded: boolean;
    readonly burned: boolean;
    readonly unexpectedRefund: boolean;
    readonly unexpectedBurn: boolean;
  } {
    return readRecoveryReceiptEvidence(this.profile, receipt, expected);
  }
}
