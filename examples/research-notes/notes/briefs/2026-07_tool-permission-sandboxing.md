# Infrastructure engineer talk: "Give the agent a key, not the keyring"

**Date:** 2026-07-21
**Source:** cloud security meetup talk (fictional sample)

## TL;DR

- Coding and ops agents are commonly run with the developer's full credentials.
- The speaker's team moved agents to short-lived, task-scoped tokens and a sandboxed shell.
- A malicious package install inside the sandbox was contained without touching production secrets.
- Human approval gates on destructive commands caught several agent mistakes in the first month.

## Their Argument

The talk argues that agent security is mostly old security applied to a new principal.
An agent is a process that runs untrusted-influenced code at high speed, so least privilege, isolation, and audit trails matter more than ever.

The speaker described a layered setup: a container per task, network egress allowlists, credentials minted for one job and expiring in minutes, and an approval step for anything that deletes or deploys.
None of it is novel, which is the point.

## Implications

- Credential scoping for agents is a concrete, fixable security gap.
- Sandboxed execution plus egress controls limits supply-chain blast radius.
- Approval gates double as a useful audit record of agent behavior.
