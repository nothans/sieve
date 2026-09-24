# Platform engineer talk: "Your 429 is part of your API"

**Date:** 2026-04-09
**Source:** API design meetup talk by a platform engineer (fictional sample)

## TL;DR

- Rate limits are a product surface; developers read them as a statement of trust.
- Token bucket per key plus a global concurrency cap handled most abuse cases in the speaker's system.
- Returning Retry-After and remaining-quota headers cut support tickets noticeably (speaker-reported).
- Agent traffic bursts differently from human traffic and breaks naive per-minute windows.

## Their Argument

The speaker argues that most rate-limiting pain comes from opaque limits, not strict ones.
When a client hits a wall with no headers and no docs, developers assume the platform is broken and open tickets or write retry storms that make things worse.

A second thread was automated clients.
Agents that fan out tool calls produce short, dense bursts, so the team moved from fixed windows to token buckets with generous burst allowance and hard concurrency caps, and published the exact algorithm in their docs.

## Implications

- Clear, documented limits are a developer experience win that costs almost nothing.
- Agent-driven traffic is a real design input for API platforms now.
- Retry guidance in the error body is worth a checklist item in any API review.
