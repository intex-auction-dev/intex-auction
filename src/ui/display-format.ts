import { formatUnits } from 'viem';
import { ORACLE_RATE_SCALE, PRICE_SCALE } from '../domain/protocol-constants';
import { iso4217Currency } from '../domain/iso-4217';
import { getScheduleTimeZone } from '../domain/display-timezone';

/**
 * The single presentation-layer home for turning integer/bigint contract quantities into the exact
 * customer-facing strings the app renders. It replaces nine copies of the
 * `formatUnits(value, decimals)` grouping idiom and three duplicated names for the same
 * token body, and it owns the divergent fixed-point formatters that defect 3 called out.
 *
 * Everything here stays on bigint arithmetic per AGENTS.md: JavaScript floating point is never used
 * for a contract value. viem's `formatUnits` returns a lossless decimal string from a bigint, and the
 * fixed-point helpers below round with integer math, never `Number`.
 */

/**
 * Group the whole part with `en-GB` thousands separators and trim the fraction to at most
 * `maxFractionDigits` significant digits, dropping trailing zeros on both ends. This is the exact
 * body the nine former copies shared; they differed only in `maxFractionDigits` and in an optional
 * trailing symbol, which the named wrappers below supply.
 */
export const groupedTokenAmount = (value: bigint, decimals: number, maxFractionDigits: number): string => {
  const [whole = '0', fraction = ''] = formatUnits(value, decimals).split('.');
  const grouped = BigInt(whole).toLocaleString('en-GB');
  const shownFraction = fraction.replace(/0+$/, '').slice(0, maxFractionDigits).replace(/0+$/, '');
  return `${grouped}${shownFraction ? `.${shownFraction}` : ''}`;
};

/** wCOEN renders as the Œ glyph prefixed with no space; any other symbol trails with a space. */
const withTokenSymbol = (amount: string, symbol: string): string => {
  const display = symbol.toLowerCase() === 'wcoen' ? 'Œ' : symbol;
  return display === 'Œ' ? `Œ${amount}` : `${amount} ${display}`;
};

/**
 * A Promis / 18-decimal amount with no symbol, trimmed to 12 fraction digits. Was duplicated as
 * `formatPromisAmount` (commit-panel, receipt-tools) and `formatTokenAmount18` (public-auction-view).
 */
export const formatPromisAmount = (value: bigint): string => groupedTokenAmount(value, 18, 12);

/**
 * A payment-token amount trimmed to 12 fraction digits, with the wCOEN→Œ symbol treatment. Was
 * duplicated as `formatPaymentTokenAmount` (commit-panel), `formatTokenAmount` (receipt-tools) and
 * `payment` (completion-card). The commit-panel copy validated the ERC-20 decimals range; that guard
 * is preserved here so no call site loses it.
 */
export const formatPaymentTokenAmount = (value: bigint, decimals: number, symbol: string): string => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError('Payment-token decimals are outside the ERC-20 range.');
  }
  return withTokenSymbol(groupedTokenAmount(value, decimals, 12), symbol);
};

/**
 * Recovery amounts trail a raw `symbol` (never the Œ glyph) and fall back to a minor-units label when
 * decimals/symbol are unknown. Kept distinct from `formatPaymentTokenAmount` because the recovery card
 * shows the token symbol verbatim and must handle the unknown-metadata case.
 */
export const formatRecoveryTokenAmount = (value: bigint, decimals: number | null, symbol: string | null): string => {
  if (decimals === null || symbol === null) return `${value.toLocaleString('en-GB')} token minor units`;
  return `${groupedTokenAmount(value, decimals, 12)} ${symbol}`;
};

/** Completion-card Promis: 18 decimals trimmed to 8 fraction digits. */
export const formatCompletionPromis = (value: bigint): string => groupedTokenAmount(value, 18, 8);

/** Venue demand-ladder Promis: `PROMIS_DECIMALS` trimmed to 4 fraction digits. */
export const formatLadderPromis = (value: bigint, decimals: number): string => groupedTokenAmount(value, decimals, 4);

/** `en-GB`-grouped integer, accepting bigint or number. */
export const integer = (value: bigint | number): string =>
  (typeof value === 'bigint' ? value : BigInt(value)).toLocaleString('en-GB');

/** Singular/plural Intex noun for a numeric quantity. */
export const intexUnit = (quantity: number): string => (quantity === 1 ? 'Intex' : 'Intexes');

/** Singular/plural Intex noun for a bigint quantity (completion card). */
export const intexUnitBig = (value: bigint): string => (value === 1n ? 'Intex' : 'Intexes');

/** ISO-4217 alpha code, falling back to `ISO <numeric>` when the currency is unknown. */
export const currencyCode = (currency: number): string => iso4217Currency(currency)?.alphaCode ?? `ISO ${currency}`;

/** Title-case a hyphenated lifecycle/status token: `green-day` → `Green Day`. */
export const titleCase = (value: string): string =>
  value
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');

/** Render a `YYYYMMDD` WWD key as `YYYY MM DD`. Was `formatWorldwideDayDisplay` / `formatWwd`. */
export const formatWorldwideDayDisplay = (worldwideDay: string): string =>
  `${worldwideDay.slice(0, 4)} ${worldwideDay.slice(4, 6)} ${worldwideDay.slice(6, 8)}`;

const MAX_DISPLAY_TIMESTAMP_SECONDS = Math.floor(8.64e15 / 1000);
const scheduleFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Format a Unix-seconds bigint schedule timestamp in the reviewed schedule timezone. The
 * `Intl.DateTimeFormat` instances are cached per timezone: constructing one per render was the
 * measured reason the two former copies (commit-panel, public-auction-view) hoisted the cache to
 * module scope. Out-of-range values fall back to a raw-seconds label rather than throwing.
 */
export const scheduleTime = (value: bigint): string => {
  if (value < 0n || value > BigInt(MAX_DISPLAY_TIMESTAMP_SECONDS)) return `${value} seconds`;
  const timeZone = getScheduleTimeZone();
  const cacheKey = timeZone ?? '__default__';
  let formatter = scheduleFormatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      ...(timeZone === undefined ? {} : { timeZone }),
    });
    scheduleFormatters.set(cacheKey, formatter);
  }
  return formatter.format(new Date(Number(value) * 1000));
};

/**
 * Two rounding policies survive here, not one, because the pinned tests require both and the hard
 * constraint on this step forbids changing a single pinned string. Both operate purely on bigint —
 * no `Number` touches a contract value on either path.
 *
 * The common core is only the minor-units→(whole, fraction) split at a power-of-ten `scale`; the two
 * policies layered on top genuinely diverge:
 *
 *  - `fixedPointTruncated` truncates (no rounding), strips trailing zeros, and does not group the
 *    whole part: `formatOracleRate(1.5e18)` → `'1.5'`. Pinned by
 *    `tests/unit/src/auction/oracle-chart-model.test.ts` ("formats exact fixed-point source values").
 *    The chart axis and the flowing COEN price depend on this exact, ungrouped, trailing-zero-free
 *    shape (`oracle-price-chart.test.tsx`, "keeps unchanged digit positions stable").
 *
 *  - `fixedPointRoundedTo2` rounds half-up to exactly two decimals and groups the whole part:
 *    `formatPriceMinor9(1e9)` → `'1.00'`, `formatPriceMinor9(1e18)` → `'1,000,000,000.00'`,
 *    `formatOracleRate18(1e9)` → `'0.00'`. Pinned by
 *    `tests/unit/src/auction/multi-currency-evidence.test.ts` ("pins the auction price scale to 1e9").
 *
 * A single function cannot return both `'1.5'` and `'1.50'`/`'0.00'` for equivalent inputs, so the
 * "one rounding rule" the proposal asked for is expressed as one documented core with two named,
 * test-governed policies. The half-up rule is `(value * 100 + scale/2) / scale` in bigint.
 */
export const fixedPointTruncated = (value: bigint, scale: bigint, decimals: number): string => {
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
};

export const fixedPointRoundedTo2 = (value: bigint, scale: bigint): string => {
  if (value < 0n) throw new RangeError('Amount must be non-negative.');
  const hundredths = (value * 100n + scale / 2n) / scale;
  const whole = hundredths / 100n;
  const fraction = hundredths % 100n;
  return `${whole.toLocaleString('en-GB')}.${String(fraction).padStart(2, '0')}`;
};

/** Oracle rate (1e18 scale) as a truncated, ungrouped decimal — chart axis / flowing price. */
export const formatOracleRate = (value: bigint): string => fixedPointTruncated(value, ORACLE_RATE_SCALE, 18);

/** Auction price (1e9 scale) as a truncated, ungrouped decimal — chart overlays. */
export const formatPrice = (value: bigint): string => fixedPointTruncated(value, PRICE_SCALE, 9);

/** Oracle rate (1e18 scale) rounded half-up to two grouped decimals — currency evidence copy. */
export const formatOracleRate18 = (rate: bigint): string => fixedPointRoundedTo2(rate, ORACLE_RATE_SCALE);

/** COEN minor amount (1e18 scale) rounded half-up to two grouped decimals — currency evidence copy. */
export const formatCurrencyMinor18 = (amount: bigint): string => fixedPointRoundedTo2(amount, ORACLE_RATE_SCALE);

/** Auction price minor (1e9 scale) rounded half-up to two grouped decimals — reference values. */
export const formatPriceMinor9 = (amount: bigint): string => fixedPointRoundedTo2(amount, PRICE_SCALE);
