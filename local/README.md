# local/

Your own corpus lives here, and git ignores everything in this folder except this README.

- `local/sieve.config.json` is the config Sieve uses when you pass no `--config`.
  Point its `root` at your notes (relative to this folder, e.g. `"root": "../../my-notes"`).
- Routing reports land in `local/reports/` if your config says `"reportsDir": "reports"`.
- Anything else you keep next to it (lens drafts, screenshots, notes about your corpus) stays private too.

Start from one of the examples: `cp examples/research-notes/sieve.config.json local/`, then edit `root`, `sources`, and `lenses`.
