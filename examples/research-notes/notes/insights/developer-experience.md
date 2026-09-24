# Insights - Developer Experience

Theme: how easy, predictable, and pleasant it is for developers to adopt and keep using a platform.

---

## 2026-09-15 - Completion tools now read your docs before your users do
**Status:** new

Code completion that consults a library's official docs cut calls to deprecated functions for early users.
That makes docs an input to generated code, not just a reference for humans.
Library authors are asking for a standard way to mark pages as machine-readable.

## 2026-09-02 - Failing CI moves migrations; warnings do not
**Status:** new

In one SDK deprecation, terminal warnings were ignored for months while a failing CI check with a link got immediate action.
Codemods handled most call sites but not all.
Dated removal timelines and migration tooling shipped with the breaking release kept churn down.

## 2026-08-18 - Rate limit headers may finally get a common shape
**Status:** new

A proposed shared set of rate limit response headers covers remaining quota, reset time, and a hint for automated clients.
Opaque limits drive more support tickets than strict ones.
Agent traffic arrives in dense bursts, so burst-friendly token buckets and published algorithms matter more than they used to.

## 2026-06-03 - Time to first successful call beats page views
**Status:** new

Copy-paste quickstarts with working test keys cut median onboarding time from about 40 to 9 minutes in one team's data (author-reported).
Error messages that link to the exact docs section outperformed longer reference pages.
It is a clean metric that travels well between products.

## 2026-04-09 - A 429 is a message, write it like one
**Status:** new

Returning Retry-After and remaining-quota headers reduced support load for one platform team (speaker-reported).
When a client hits an unexplained wall, people assume the service is broken and write retry storms.
Retry guidance in the error body is a near-free improvement.
