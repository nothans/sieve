# Security researcher talk: "The web page is now part of your prompt"

**Date:** 2026-05-06
**Source:** security conference talk (fictional sample)

## TL;DR

- Agents that browse or read email can be steered by instructions hidden in the content they read.
- In the speaker's red-team exercise, a hidden line in a support ticket got an agent to leak a draft reply to an outside address.
- Filtering prompts does not fix it; limiting what the agent can do after reading untrusted content does.
- Logging every tool call with its triggering input made incidents traceable.

## Their Argument

The speaker frames prompt injection as a confused-deputy problem.
The agent holds the user's authority, reads attacker-controlled text, and cannot reliably tell data from instructions.
Every new tool connected to the agent widens what an injected instruction can reach.

Mitigations that worked in their exercises were architectural: separate read and act phases, require confirmation for outbound actions, strip secrets from context, and scope credentials per task.
Detection classifiers helped as a tripwire but were bypassed within hours by a motivated tester.

## Implications

- Any agent with both untrusted input and outbound tools is a live security risk today.
- Capability scoping beats content filtering as a primary defense.
- Audit logs of tool calls are a cheap, high-value default.
