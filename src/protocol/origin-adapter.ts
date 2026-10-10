import { getAddress, type Hex } from 'viem';
import {
  asAddress,
  asArray,
  asBigint,
  asBoolean,
  asRecord,
  asSafeNumber,
  asWorldwideDayKey,
  eventFromAbi,
} from '../chain/abi-coerce';
import {
  IncompatibleDeploymentError,
  IncompatibleWiringError,
  OriginWorldwideDayNotFoundError,
  isUnknownTerminalReceipt,
  isWorldwideDayNotFound,
} from '../chain/revert-classify';
import { toDurationSeconds, toUtcTimestamp, type WorldwideDayKey } from '../domain/protocol-time';
import { SECONDS_PER_DAY } from '../domain/protocol-constants';
import { decodeGlobalAuctionStage, decodeWorldwideDayLifecycle, decodeWorldwideDayType } from './read-model';
import { requireCode, type AuctionReadClient } from './read-client';
import type { OutbeDeploymentProfile } from '../chain/deployment-profile';
import { dayNumber } from './venue-decode';
import type {
  CanonicalSeriesSnapshot,
  GlobalAuctionSnapshot,
  OriginTerminalDisposition,
  OriginTerminalEvidence,
  WorldwideDayReadState,
  WorldwideDaySnapshot,
} from './profile-types';

const decodeTerminalReceipt = (raw: unknown): OriginTerminalEvidence | null => {
  const values = asArray(raw, 'Metadosis.getWorldwideDayTerminalReceipt');
  if (values.length !== 6) {
    throw new TypeError('Metadosis.getWorldwideDayTerminalReceipt returned an incompatible tuple.');
  }
  const outcome = asSafeNumber(values[0], 'Metadosis terminal outcome');
  if (outcome === 0) return null;
  const disposition: OriginTerminalDisposition =
    outcome === 1
      ? 'missed-offering'
      : outcome === 2
        ? 'capacity-forfeiture'
        : (() => {
            throw new RangeError(`Unsupported Metadosis terminal outcome ${outcome}.`);
          })();
  const retirementTag = asSafeNumber(values[4], 'Metadosis retirement outcome');
  const retirement =
    retirementTag === 1
      ? 'not-present'
      : retirementTag === 2
        ? 'requested'
        : (() => {
            throw new RangeError(`Unsupported Metadosis retirement outcome ${retirementTag}.`);
          })();
  return {
    disposition,
    valueRouted: asBigint(values[1], 'Metadosis value routed'),
    carryOverBefore: asBigint(values[2], 'Metadosis carry-over before'),
    carryOverAfter: asBigint(values[3], 'Metadosis carry-over after'),
    retirement,
    blockNumber: asBigint(values[5], 'Metadosis terminal block number'),
  };
};

export class OutbeAuctionAdapter {
  private validation: Promise<void> | null = null;

  constructor(
    private readonly client: AuctionReadClient,
    private readonly profile: OutbeDeploymentProfile,
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
        `Outbe chain mismatch: expected ${this.profile.chainId}, received ${chainId}.`,
      );
    }
    await Promise.all([
      requireCode(this.client, 'Metadosis', this.profile.addresses.metadosis),
      requireCode(this.client, 'Desis', this.profile.addresses.desis),
      requireCode(this.client, 'OriginRouter', this.profile.addresses.originRouter),
      requireCode(this.client, 'Oracle', this.profile.addresses.oracle),
      requireCode(this.client, 'Intex', this.profile.addresses.intex),
    ]);

    const configuredDesis = asAddress(
      await this.client.readContract({
        address: this.profile.addresses.originRouter,
        abi: this.profile.abis.originRouter,
        functionName: 'desis',
      }),
      'OriginRouter.desis',
    );
    if (configuredDesis !== getAddress(this.profile.addresses.desis)) {
      throw new IncompatibleWiringError('OriginRouter Desis wiring does not match the configured Outbe profile.');
    }
  }

  async readTerminalEvidence(worldwideDay: WorldwideDayKey): Promise<OriginTerminalEvidence | null> {
    try {
      return decodeTerminalReceipt(
        await this.client.readContract({
          address: this.profile.addresses.metadosis,
          abi: this.profile.abis.metadosis,
          functionName: 'getWorldwideDayTerminalReceipt',
          args: [dayNumber(worldwideDay)],
        }),
      );
    } catch (error) {
      if (isUnknownTerminalReceipt(error)) return null;
      throw error;
    }
  }

  private async readCleanupEvidence(worldwideDay: WorldwideDayKey): Promise<'completed' | 'failed' | null> {
    const logs = await this.client.getLogs({
      address: this.profile.addresses.metadosis,
      event: eventFromAbi(this.profile.abis.metadosis, 'WorldwideDayCleanedUp'),
      args: { worldwideDay: dayNumber(worldwideDay) },
      fromBlock: this.profile.deploymentBlock,
      toBlock: 'latest',
    });
    if (logs.length === 0) return null;
    const last = asRecord(logs[logs.length - 1], 'WorldwideDayCleanedUp log');
    const args = asRecord(last.args, 'WorldwideDayCleanedUp args');
    const finalStatus = decodeWorldwideDayLifecycle(asSafeNumber(args.finalStatus, 'cleanup final status'));
    if (finalStatus !== 'completed' && finalStatus !== 'failed') {
      throw new TypeError('WorldwideDayCleanedUp contains a non-terminal lifecycle.');
    }
    return finalStatus;
  }

  async readWorldwideDayState(worldwideDay: WorldwideDayKey): Promise<WorldwideDayReadState> {
    try {
      const snapshot = await this.readWorldwideDay(worldwideDay);
      return {
        kind: 'retained',
        snapshot,
        terminal: await this.readTerminalEvidence(worldwideDay),
      };
    } catch (error) {
      if (!isWorldwideDayNotFound(error)) throw error;
      const [terminal, cleanedFinalLifecycle] = await Promise.all([
        this.readTerminalEvidence(worldwideDay),
        this.readCleanupEvidence(worldwideDay),
      ]);
      if (terminal || cleanedFinalLifecycle) {
        return { kind: 'history-unavailable', terminal, cleanedFinalLifecycle };
      }
      return { kind: 'not-found' };
    }
  }

  async readWorldwideDay(worldwideDay: WorldwideDayKey): Promise<WorldwideDaySnapshot> {
    let raw: readonly unknown[];
    try {
      raw = asArray(
        await this.client.readContract({
          address: this.profile.addresses.metadosis,
          abi: this.profile.abis.metadosis,
          functionName: 'getWorldwideDay',
          args: [dayNumber(worldwideDay)],
        }),
        'Metadosis.getWorldwideDay',
      );
    } catch (error) {
      if (isWorldwideDayNotFound(error)) {
        throw new OriginWorldwideDayNotFoundError(`WorldwideDay ${worldwideDay} was not found.`);
      }
      throw error;
    }
    if (raw.length !== 9) throw new TypeError('Metadosis.getWorldwideDay returned an incompatible tuple.');

    return {
      worldwideDay,
      lifecycle: decodeWorldwideDayLifecycle(asSafeNumber(raw[0], 'WorldwideDay.status')),
      dayType: decodeWorldwideDayType(asSafeNumber(raw[1], 'WorldwideDay.dayType')),
      formingStart: toUtcTimestamp(asBigint(raw[2], 'WorldwideDay.formingStart')),
      formingEnd: toUtcTimestamp(asBigint(raw[3], 'WorldwideDay.formingEnd')),
      lookbackEnd: toUtcTimestamp(asBigint(raw[4], 'WorldwideDay.lookbackEnd')),
      offeringEnd: toUtcTimestamp(asBigint(raw[5], 'WorldwideDay.offeringEnd')),
      scheduledProcessTime: toUtcTimestamp(asBigint(raw[6], 'WorldwideDay.scheduledProcessTime')),
      previousVwap: asBigint(raw[7], 'WorldwideDay.previousVwap'),
      currentVwap: asBigint(raw[8], 'WorldwideDay.currentVwap'),
    };
  }

  async readRetainedWorldwideDays(): Promise<readonly WorldwideDayKey[]> {
    const [activeRaw, completedRaw, failedRaw] = await Promise.all([
      this.client.readContract({
        address: this.profile.addresses.metadosis,
        abi: this.profile.abis.metadosis,
        functionName: 'getActiveWorldwideDays',
      }),
      this.client.readContract({
        address: this.profile.addresses.metadosis,
        abi: this.profile.abis.metadosis,
        functionName: 'getWorldwideDaysByStatus',
        args: [6],
      }),
      this.client.readContract({
        address: this.profile.addresses.metadosis,
        abi: this.profile.abis.metadosis,
        functionName: 'getWorldwideDaysByStatus',
        args: [7],
      }),
    ]);
    const keys = [
      ...asArray(activeRaw, 'Metadosis active WorldwideDays'),
      ...asArray(completedRaw, 'Metadosis completed WorldwideDays'),
      ...asArray(failedRaw, 'Metadosis failed WorldwideDays'),
    ].map((value) => asWorldwideDayKey(value, 'Metadosis retained WorldwideDay'));
    return [...new Set(keys)].sort();
  }

  async readGlobalAuction(worldwideDay: WorldwideDayKey, venueChainId: number): Promise<GlobalAuctionSnapshot> {
    const args = [dayNumber(worldwideDay)] as const;
    const venueArgs = [dayNumber(worldwideDay), venueChainId] as const;
    const [stage, totalBids, venueBids, venueDone, targets] = await Promise.all([
      this.client.readContract({
        address: this.profile.addresses.desis,
        abi: this.profile.abis.desis,
        functionName: 'getAuctionStage',
        args,
      }),
      this.client.readContract({
        address: this.profile.addresses.desis,
        abi: this.profile.abis.desis,
        functionName: 'getBidsCount',
        args,
      }),
      this.client.readContract({
        address: this.profile.addresses.desis,
        abi: this.profile.abis.desis,
        functionName: 'getChainBidsCount',
        args: venueArgs,
      }),
      this.client.readContract({
        address: this.profile.addresses.desis,
        abi: this.profile.abis.desis,
        functionName: 'isChainDone',
        args: venueArgs,
      }),
      this.client.readContract({
        address: this.profile.addresses.originRouter,
        abi: this.profile.abis.originRouter,
        functionName: 'targetsOf',
        args,
      }),
    ]);

    const targetIds = asArray(targets, 'OriginRouter.targetsOf').map((value) => asSafeNumber(value, 'target chain id'));
    return {
      stage: decodeGlobalAuctionStage(asSafeNumber(stage, 'Desis auction stage')),
      totalBids: asBigint(totalBids, 'Desis total bids'),
      venueBids: asBigint(venueBids, 'Desis venue bids'),
      venueIntakeComplete: asBoolean(venueDone, 'Desis venue completion'),
      venueInTargetSnapshot: targetIds.includes(venueChainId),
    };
  }

  async readCanonicalSeries(seriesId: Hex): Promise<CanonicalSeriesSnapshot | null> {
    const exists = asBoolean(
      await this.client.readContract({
        address: this.profile.addresses.intex,
        abi: this.profile.abis.intex,
        functionName: 'seriesExists',
        args: [seriesId],
      }),
      'Intex.seriesExists',
    );
    if (!exists) return null;

    const raw = asRecord(
      await this.client.readContract({
        address: this.profile.addresses.intex,
        abi: this.profile.abis.intex,
        functionName: 'seriesData',
        args: [seriesId],
      }),
      'Intex.seriesData',
    );

    return {
      seriesId,
      promisLoadMinor: asBigint(raw.promisLoadMinor, 'Intex.promisLoadMinor'),
      entryPriceMinor: asBigint(raw.entryPriceMinor, 'Intex.entryPriceMinor'),
      floorPriceMinor: asBigint(raw.floorPriceMinor, 'Intex.floorPriceMinor'),
      issuedIntexCount: asSafeNumber(raw.issuedUnits, 'Intex.issuedUnits'),
      callWindowDays: Math.round(Number(asBigint(raw.callWindow, 'Intex.callWindow')) / SECONDS_PER_DAY),
      callThresholdDays: Math.round(Number(asBigint(raw.callThreshold, 'Intex.callThreshold')) / SECONDS_PER_DAY),
      callPriceMinor: asBigint(raw.callPriceMinor, 'Intex.callPriceMinor'),
      state: asSafeNumber(raw.state, 'Intex.state'),
      issuedAt: toUtcTimestamp(asBigint(raw.issuedAt, 'Intex.issuedAt')),
      calledAt: toUtcTimestamp(asBigint(raw.calledAt, 'Intex.calledAt')),
      intexCallPeriod: toDurationSeconds(asBigint(raw.callNoticePeriod, 'Intex.callNoticePeriod')),
      issuanceCurrency: asSafeNumber(raw.issuanceCurrency, 'Intex.issuanceCurrency'),
      referenceCurrency: asSafeNumber(raw.referenceCurrency, 'Intex.referenceCurrency'),
      worldwideDay: String(asSafeNumber(raw.worldwideDay, 'Intex.worldwideDay')) as WorldwideDayKey,
    };
  }
}
