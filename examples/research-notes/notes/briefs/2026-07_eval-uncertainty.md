# Jonas Brecht: "Your leaderboard gap is inside the error bars"

**Date:** 2026-07-08
**Source:** ML evaluation seminar recording (fictional sample)

## TL;DR

- Many reported benchmark gains are smaller than the sampling error of the test set.
- Bootstrapped confidence intervals on a 500-item eval are often plus or minus 3 to 4 points.
- Re-running with different seeds or prompt orders changed rankings in his examples.
- He recommends reporting intervals and paired comparisons, not single scores.

## Their Argument

Brecht argues that the field reads benchmark tables as exact when they are noisy estimates.
A two-point win on a small eval set is often indistinguishable from chance, yet it drives model selection and headlines.

His prescription is statistical hygiene: paired bootstrap tests on the same items, multiple seeds, and honest reporting of uncertainty.
He also points out that LLM-graded evals add a second source of noise that almost nobody quantifies.

## Implications

- Any small in-house eval should report confidence intervals alongside accuracy.
- Judge-model noise is an under-measured source of uncertainty.
- Good grounding for skepticism about marginal benchmark claims.
