export const SECONDS_PER_HOUR = 3_600;
export const SECONDS_PER_DAY = 86_400;
export const USD_REFERENCE_CURRENCY = 840;
export const ORACLE_RETENTION_DAYS = 365;
export const CHART_WINDOW_POINTS = 450;
export const PAYMENT_TOKEN_DECIMALS = 18;
export const PROMIS_DECIMALS = 18;

/** The 1e18 Oracle rate / COEN minor scale. Was declared twice in `src/auction/`. */
export const ORACLE_RATE_SCALE = 10n ** 18n;
/** The 1e9 auction price scale (entry/floor/call, strike amounts). Distinct from the Oracle rate scale. */
export const PRICE_SCALE = 10n ** 9n;
