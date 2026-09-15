const KNOWN_CONTRACT_ERRORS: ReadonlyMap<string, string> = new Map([
  ['0x429eabc6', 'The Oracle is temporarily unavailable. Price data cannot be read right now.'],
  ['0x4100ba82', 'The requested currency pair is not configured in the Oracle.'],

  ['0x0e28b8be', 'This auction does not exist on the active venue yet.'],
  ['0x04581cc8', 'An auction for this WorldwideDay already exists.'],
  ['0xdba16ce8', 'The auction schedule is invalid.'],
  ['0xca135e19', 'This action is not available during the current auction stage.'],

  ['0xcc9c2df5', 'A bid has already been committed for this auction.'],
  ['0x3f077648', 'No committed bid was found for this bidder.'],
  ['0x8509cf4f', 'This bid has already been revealed.'],
  ['0xa24a96b9', 'The reveal does not match the original commitment. Reveal material may be incorrect.'],
  ['0x86f63ff8', 'The bid rate is below the minimum allowed for this auction.'],
  ['0x56c744b5', 'The bid quantity is below the minimum allowed for this auction.'],
  ['0x173d238e', 'The commit hash is invalid.'],
  ['0x24497bc3', 'Transaction was submitted on the wrong chain.'],

  ['0x1e0c6cb7', 'The commit bond is not yet claimable. The lock period has not elapsed.'],
  ['0x4a366fe2', 'The escrow still has active locks and cannot be rotated.'],

  ['0x2520be98', 'No active escrow lock exists for this bidder.'],
  ['0x475a2535', 'The escrow for this auction has already been finalized.'],
  ['0xc01b3f48', 'The escrow refund is not yet claimable. The waiting period has not elapsed.'],
  ['0x39b2e90c', 'No commit bond was found for this bidder.'],
  ['0x7e825755', 'The commit bond has not been abandoned long enough to claim.'],
  ['0xa7d36e11', 'The auction has not been finalized yet.'],
]);

const extractSelector = (error: unknown): string | null => {
  if (!(error instanceof Error)) return null;
  const selectorMatch = error.message.match(/signature "?(0x[0-9a-fA-F]{8})"?/);
  if (selectorMatch) return selectorMatch[1]!.toLowerCase();
  const customMatch = error.message.match(/custom error (0x[0-9a-fA-F]{8})/);
  if (customMatch) return customMatch[1]!.toLowerCase();
  return null;
};

export const describeContractError = (error: unknown): string | null => {
  const selector = extractSelector(error);
  if (!selector) return null;
  return KNOWN_CONTRACT_ERRORS.get(selector) ?? null;
};

export const friendlyErrorMessage = (error: unknown): string => {
  const known = describeContractError(error);
  if (known) return known;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  return 'An unexpected application error occurred.';
};
