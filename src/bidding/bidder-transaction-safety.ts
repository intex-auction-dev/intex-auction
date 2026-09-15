import type { TransactionAttemptV1, StoredRevealMaterialV1 } from '../receipts/receipt-store';
import type { FreshCommitState } from './commit-transaction';

type ActivityEntry = {
  readonly record: { readonly stored: StoredRevealMaterialV1 };
  readonly attempts: readonly TransactionAttemptV1[];
};

export const unresolvedBidderActionBlocker = (_fresh: FreshCommitState, _entries: readonly ActivityEntry[]): null => {
  return null;
};
