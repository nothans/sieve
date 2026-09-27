# Sample research notes for Sieve

This is a synthetic corpus for trying Sieve.
Every person, quote, survey, company, and number in it is invented.
It is shaped like a real researcher's Markdown notes folder, so you can rank, filter, and report on it without using your own notes.

What is in `notes/`:

- `briefs/` - 12 briefs on invented talks, posts, and panels (2026-03 to 2026-09).
- `news/` - 2 monthly digests with 6 stories each (12 stories).
- `insights/` - 4 theme files with 5 entries each (20 entries): `edge-ai`, `developer-experience`, `open-source`, `ai-safety`.
- `index.md` - a hub page that links 8 of the 12 briefs, leaving 4 as orphans.
- `field-notes/` - 16 later notes, read only by `crosscheck.config.json`.

The four insight files double as ground-truth labels for `sieve eval`: each entry's file is its theme, and the entry text never names it.
A few entries are deliberately cross-cutting, so a perfect score is not expected.

## Two configs

- `sieve.config.json` reads the briefs, news, and insights: 44 items. The README's numbers for ask, lint, route, and eval come from this one.
- `crosscheck.config.json` reads the same 44 plus the field notes: 60 items, for `sieve crosscheck`.

The field notes are the test for crosscheck.
The first ten were each written to disagree with one insight.

| Field note | The insight it disagrees with |
|---|---|
| Deprecation warnings alone finished the migration | Failing CI moves migrations; warnings do not |
| Four-bit models kept their calibration | Quantization quietly breaks confidence scores |
| Wrong labels lose the room | Misclassifications are the best part of a live vision demo |
| A content screen held for six months | Hidden page text can drive a browsing agent |
| The people behind top packages draw a salary for it | Critical packages often rest on one tired person |
| An upkeep grant round closed half empty | A maintenance-only fund was oversubscribed ten to one |
| The network did the work in a keyword spotter | Wake-word models live or die on the audio front end |
| Test keys in the quickstart left onboarding at forty minutes | Time to first successful call beats page views |
| Exposing quota raised ticket volume | Rate limit headers may finally get a common shape |
| Hobby boards still have nothing to run for speech | Offline voice assistants are becoming a hobby build |

The last six are decoys that should not be listed against the notebook:

- "Nobody acted until the build went red" and "Compression barely dents accuracy, so check the thresholds instead" agree with an insight in negative wording.
- "Salaried maintainers cluster in flagship projects" qualifies an insight without contradicting it.
- "Quota dashboards help the sales conversation", "Venue Wi-Fi is the demo killer", and "Keyword filters did not reduce forum spam" share a topic with an insight and make another point.

A decoy that agrees with an insight does contradict the field note written against that insight, and crosscheck should say so.
