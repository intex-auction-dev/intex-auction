const activeAmount = (record, field) => record !== null && record !== undefined && BigInt(record[field]) > 0n;

export const deriveRecoveryTimes = ({
  auction,
  bond,
  lock,
  escrow,
  revealed,
  unrevealedBondDelay,
  abandonedBondDelay,
  unfinalizedRefundDelay,
  postFinalizeRefundDelay,
}) => {
  const activeBond = activeAmount(bond, 'amount') && !revealed;
  const activeLock = activeAmount(lock, 'lockedAmount') && Number(lock.status) === 1;

  let escrowRecoveryClaimableAt = null;
  if (activeLock) {
    if (!escrow?.finalized) {
      escrowRecoveryClaimableAt = BigInt(lock.lockedAt) + BigInt(unfinalizedRefundDelay);
    } else {
      escrowRecoveryClaimableAt = BigInt(escrow.finalizedAt) + BigInt(postFinalizeRefundDelay);
    }
  }

  return {
    recoveryClaimableAt:
      activeBond && auction ? BigInt(auction.schedule.revealEnd) + BigInt(unrevealedBondDelay) : null,
    abandonedBondClaimableAt: activeBond ? BigInt(bond.lockedAt) + BigInt(abandonedBondDelay) : null,
    escrowRecoveryClaimableAt,
  };
};
