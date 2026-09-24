# Insights - AI Safety

Theme: keeping AI systems and agents trustworthy, contained, and honest about what they do not know.

---

## 2026-09-18 - Most off-the-shelf classifiers are overconfident
**Status:** new

A new toolkit for measuring and correcting language-model classifier calibration found overconfidence on most models tested.
Temperature scaling and an explicit abstain threshold fix much of it cheaply.
Systems that gate actions on model scores should treat "not sure" as a real output.

## 2026-09-07 - Hidden page text can drive a browsing agent
**Status:** new

A demonstration showed a browsing agent changing account settings after reading instructions hidden in a web page.
Default configurations of two products were vulnerable.
Confirmation prompts for sensitive actions were the vendors' fix, which confirms that limiting capability beats filtering content.

## 2026-07-21 - Coding agents inherit too many credentials
**Status:** new

Agents are often run with a developer's full keys, so a single malicious dependency install can reach production secrets.
Short-lived, task-scoped tokens, a sandbox per task, and egress allowlists contained exactly that case in one team's setup.
Poisoned packages in public registries make this a supply-chain problem as much as an agent problem.

## 2026-07-08 - Leaderboard gaps often sit inside the error bars
**Status:** new

Bootstrapped intervals on a 500-item eval are often plus or minus 3 to 4 points, larger than many claimed gains.
Model-graded evals add a second, unmeasured source of noise.
Decisions about which model to trust should rest on paired comparisons with stated uncertainty.

## 2026-05-06 - The content an agent reads is part of its prompt
**Status:** new

In a red-team exercise, one hidden line in a support ticket got an agent to send a draft reply to an outside address.
Detection classifiers were bypassed within hours; separating read and act phases and requiring confirmation for outbound actions held up.
Logging every tool call with its triggering input made incidents traceable.
