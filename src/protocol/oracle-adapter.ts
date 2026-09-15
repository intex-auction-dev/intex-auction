import type { Address } from 'viem';
import { asArray, asBigint, asSafeNumber } from '../chain/abi-coerce';
import { iso4217Currency } from '../domain/iso-4217';
import { CHART_WINDOW_POINTS } from '../domain/protocol-constants';
import { toUtcTimestamp, type UtcAccountingDay } from '../domain/protocol-time';
import type { AuctionReadClient } from './read-client';
import type { OutbeDeploymentProfile } from '../chain/deployment-profile';
import type {
  OracleExchangeRate,
  OraclePriceHistory,
  OraclePriceSnapshot,
  OracleSettlementCurrency,
} from './profile-types';

/**
 * The Outbe Oracle reads. Split out of `OutbeAuctionAdapter`: origin WWD/global/series
 * reads and Oracle price reads are two responsibilities that merely share the Outbe
 * deployment profile and read client, so they are two adapters over the same client.
 */
export class OracleAdapter {
  constructor(
    private readonly client: AuctionReadClient,
    private readonly profile: OutbeDeploymentProfile,
  ) {}

  async readCoenExchangeRate(isoCode: number): Promise<bigint> {
    return asBigint(
      await this.client.readContract({
        address: this.profile.addresses.oracle,
        abi: this.profile.abis.oracle,
        functionName: 'getCoenExchangeRateFor',
        args: [isoCode],
      }),
      'Oracle COEN exchange rate',
    );
  }

  async readExchangeRate(base: Address, quote: Address): Promise<OracleExchangeRate> {
    const raw = asArray(
      await this.client.readContract({
        address: this.profile.addresses.oracle,
        abi: this.profile.abis.oracle,
        functionName: 'getExchangeRateData',
        args: [base, quote],
      }),
      'Oracle.getExchangeRateData',
    );
    if (raw.length !== 3) throw new TypeError('Oracle.getExchangeRateData returned an incompatible tuple.');
    return {
      pair: { base, quote },
      rate: asBigint(raw[0], 'Oracle exchange rate'),
      lastBlock: asBigint(raw[1], 'Oracle exchange-rate block'),
      lastTimestamp: toUtcTimestamp(asBigint(raw[2], 'Oracle exchange-rate timestamp')),
    };
  }

  async readSettlementCurrencies(): Promise<readonly OracleSettlementCurrency[]> {
    const isoCodes = asArray(
      await this.client.readContract({
        address: this.profile.addresses.oracle,
        abi: this.profile.abis.oracle,
        functionName: 'getReferenceCurrencies',
      }),
      'Oracle.getReferenceCurrencies',
    );
    const seen = new Set<number>();
    return isoCodes
      .map((value, index) => {
        const isoCode = asSafeNumber(value, `Oracle reference currency ${index}`);
        if (isoCode <= 0 || seen.has(isoCode))
          throw new TypeError('Oracle reference ISO codes must be unique and non-zero.');
        seen.add(isoCode);
        return { isoCode, denomination: iso4217Currency(isoCode)?.alphaCode ?? `ISO ${isoCode}` };
      })
      .sort((left, right) => left.isoCode - right.isoCode);
  }

  async readPriceSnapshotHistory(base: Address, quote: Address, count: number): Promise<OraclePriceHistory> {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError('Oracle history count must be a non-negative safe integer.');
    }
    const requestedCount = Math.min(count, CHART_WINDOW_POINTS);
    const raw = asArray(
      await this.client.readContract({
        address: this.profile.addresses.oracle,
        abi: this.profile.abis.oracle,
        functionName: 'getPriceSnapshotHistory',
        args: [base, quote, requestedCount],
      }),
      'Oracle.getPriceSnapshotHistory',
    );
    if (raw.length !== 3) {
      throw new TypeError('Oracle.getPriceSnapshotHistory returned an incompatible tuple.');
    }
    const timestamps = asArray(raw[0], 'Oracle snapshot timestamps');
    const rates = asArray(raw[1], 'Oracle snapshot rates');
    const volumes = asArray(raw[2], 'Oracle snapshot volumes');
    if (timestamps.length !== rates.length || timestamps.length !== volumes.length) {
      throw new TypeError('Oracle snapshot arrays must have identical lengths.');
    }

    const seen = new Set<bigint>();
    const pointsNewestFirst: OraclePriceSnapshot[] = [];
    let previousTimestamp: bigint | null = null;
    for (let index = 0; index < timestamps.length; index += 1) {
      const timestamp = asBigint(timestamps[index], `Oracle snapshot timestamp ${index}`);
      const rate = asBigint(rates[index], `Oracle snapshot rate ${index}`);
      const volume = asBigint(volumes[index], `Oracle snapshot volume ${index}`);
      if (timestamp < 0n || rate < 0n || volume < 0n) {
        throw new RangeError('Oracle snapshot values must be unsigned integers.');
      }
      if (previousTimestamp !== null && timestamp > previousTimestamp) {
        throw new TypeError('Oracle snapshot history must be newest-first.');
      }
      previousTimestamp = timestamp;
      if (seen.has(timestamp)) continue;
      seen.add(timestamp);
      pointsNewestFirst.push({
        timestamp: toUtcTimestamp(timestamp),
        rate,
        volume,
      });
    }

    return { pair: { base, quote }, requestedCount, pointsNewestFirst };
  }

  async readUtcDayVwap(base: Address, quote: Address, day: UtcAccountingDay): Promise<bigint> {
    return asBigint(
      await this.client.readContract({
        address: this.profile.addresses.oracle,
        abi: this.profile.abis.oracle,
        functionName: 'getUtcDayVwap',
        args: [base, quote, day],
      }),
      'Oracle UTC day VWAP',
    );
  }
}
