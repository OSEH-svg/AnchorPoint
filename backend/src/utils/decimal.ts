import BigNumber from "bignumber.js";

export const DECIMAL_PRECISION = 7;

BigNumber.config({
  DECIMAL_PLACES: DECIMAL_PRECISION + 4,
  ROUNDING_MODE: BigNumber.ROUND_HALF_UP,
  EXPONENTIAL_AT: 1e9,
});

export const toDecimal = (value: BigNumber.Value): BigNumber => new BigNumber(value);

export const formatDecimal = (value: BigNumber.Value, precision = DECIMAL_PRECISION): string =>
  toDecimal(value).decimalPlaces(precision, BigNumber.ROUND_HALF_UP).toFixed(precision);

