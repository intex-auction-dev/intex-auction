// Reuse the reviewed-RPC gas estimate so wallets do not re-estimate on a flaky provider.
export const bufferedGasLimit = (estimated: bigint): bigint => {
  if (estimated <= 0n) throw new TypeError('A positive gas estimate is required.');
  const buffered = (estimated * 120n) / 100n;
  return buffered > estimated ? buffered : estimated + 1n;
};
