## Summary

<!-- Describe the user-visible and functional result. -->

## Customer-facing impact

- [ ] No customer-facing structure, copy, controls or behaviour changed.
- [ ] Customer-facing changes are included and the accepted product requirement or reviewed contract behaviour driving them is named below.

Accepted requirement or reviewed source:

Affected states:

Known differences:

## Verification

- [ ] Content, copy, controls, ordering and behaviour were reviewed before geometry.
- [ ] Only the affected states were exercised, including relevant pending, success and error behaviour.
- [ ] One small rendered-DOM regression check covers important changed copy, controls, ordering or enabled/disabled behaviour where the change is non-trivial.
- [ ] Affected states were checked at `1440 × 900` and, where layout can differ, `1280 × 720`.
- [ ] Dynamic values and realistic error text do not overlap, clip or create horizontal overflow.
- [ ] Screenshots are evidence only; no screenshot-specific positioning hacks were added.

## Merge hygiene

- [ ] The final diff was reviewed against `main`.
- [ ] Stacked work was updated after its parent merged and inherited diff noise was removed.
- [ ] Required checks completed successfully; none are queued, skipped, cancelled, missing or failing.
- [ ] The PR does not claim “1:1”, “exact parity” or “approved” based only on author self-review.
