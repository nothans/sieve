# Sample research notes for Sieve

This is a synthetic corpus for trying Sieve.
Every person, quote, survey, company, and number in it is invented.
It is shaped like a real researcher's Markdown notes folder, so you can rank, filter, and report on it without using your own notes.

What is in `notes/`:

- `briefs/` - 12 briefs on invented talks, posts, and panels (2026-03 to 2026-09).
- `news/` - 2 monthly digests with 6 stories each (12 stories).
- `insights/` - 4 theme files with 5 entries each (20 entries): `edge-ai`, `developer-experience`, `open-source`, `ai-safety`.
- `index.md` - a hub page that links 8 of the 12 briefs, leaving 4 as orphans.

The four insight files double as ground-truth labels for `sieve eval`: each entry's file is its theme, and the entry text never names it.
A few entries are deliberately cross-cutting, so a perfect score is not expected.
