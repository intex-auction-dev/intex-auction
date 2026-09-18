export const SECONDS_PER_HOUR = 3_600;
export const SECONDS_PER_DAY = 86_400;
export const USD_REFERENCE_CURRENCY = 840;
export const ORACLE_RETENTION_DAYS = 365;
export const CHART_WINDOW_POINTS = 450;
export const PAYMENT_TOKEN_DECIMALS = 18;
// Chain truth: SeriesData.promisLoadMinor / entry/floor/callPriceMinor are all 1e6
// (IIntexNFT1155.sol SeriesData; IIntex.sol:24-32; schema.rs:189-197).
export const PROMIS_DECIMALS = 6;

/** The 1e18 Oracle rate / COEN minor scale. Was declared twice in `src/auction/`. */
export const ORACLE_RATE_SCALE = 10n ** 18n;
/**
 * The 1e6 auction price scale (entry/floor/call, strike amounts) and the single PROMIS/1e6 scale.
 * Chain: SeriesData fields are all 1e6 (IIntexNFT1155.sol). Distinct from the Oracle rate scale.
 */
export const PRICE_SCALE = 10n ** 6n;
/**
 * Native/WCOEN atomic units per six-decimal protocol unit.
 * Chain: IntexAuction.sol:39 `NATIVE_UNITS_PER_PROTOCOL_UNIT = 1e12`; the six-decimal escrow-lock
 * result is converted exactly once into 18-decimal WCOEN before locking (IntexAuction.sol:403-405).
 */
export const NATIVE_UNITS_PER_PROTOCOL_UNIT = 10n ** 12n;
