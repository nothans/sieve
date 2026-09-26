# Sieve

**Sift a whole folder of notes by any judgment, in seconds, for pennies.**

Point Sieve at a folder of Markdown (research notes, briefs, a blog, a knowledge base, 313 of Aesop's fables) and ask it anything in plain words: "security risks of AI agents", "a trick that backfires on the trickster", "a hands-on build I could demo at a meetup".
Every item gets the same typed question, [Jev](https://openrouter.ai/docs/guides/community/jev) answers each one with a calibrated probability, and Sieve ranks the whole corpus by the answer while you watch.

![Sieve asking all 313 of Aesop's fables "someone boasts and is proven wrong": 20 requests, 0.5 seconds, $0.0035, with the estimate above and a line saying what the percentage means](docs/images/sieve-ask.png)

- **Fast enough to feel like search.** Items are packed 16 to a request and requests run 16 at a time. A 1,140-item research notebook comes back in 2-3 seconds, streaming.
- **Cheap enough to ask everything.** Jev bills input tokens only, at $0.042 per million. A full sweep of that notebook costs about 2.5 cents.
- **Calibrated, so it can say "not sure".** Every answer is a probability or a confidence, so Sieve ranks, thresholds, and hands you the uncertain middle instead of pretending.
- **Typed.** Answers are the options you defined, never a paragraph to parse.
- **Just Node.** Node 20.6+, no dependencies, no build step, no database. Your notes stay files.

## What is Jev?

Jev is TypeSafe's first "System One" model, available through [OpenRouter](https://openrouter.ai/typesafe/jev-1.13) as `typesafe/jev-1.13`.
It does not write text.
You send a *state* (any text or JSON) and *typed questions*, and it returns typed answers with probabilities in one parallel pass:

| Type | Question | Answer |
|---|---|---|
| `noul` | Yes or no? | the probability of yes |
| `choice` | Which of these options (up to 255)? | the pick, every option's probability, a confidence |
| `score` | Where on this ordered scale (2-10 levels)? | a position, per-level probabilities, a confidence |

That shape is exactly what "judge every item in a pile" needs: fast, cheap, and honest about uncertainty.
It is the wrong tool for anything that needs a sentence back.

## Quick start

```bash
git clone https://github.com/nothans/sieve && cd sieve
echo "OPENROUTER_API_KEY=sk-or-..." > .env      # any OpenRouter key; no TypeSafe account needed

# the web UI on the Aesop demo (localhost only)
node sieve.cjs serve --config examples/aesop/sieve.config.json
# open http://127.0.0.1:4177

# or the command line
node sieve.cjs ask "a clever animal outwits a stronger one" --config examples/aesop/sieve.config.json
node sieve.cjs lens moral --config examples/aesop/sieve.config.json
```

### Using the web UI

The page is built to explain itself as you go:
- **Before you sift**, the line under the question box says how many items will be asked, roughly what it will cost, and how long it will take (on a local model, once the first sift has timed it). Each preset tab shows the exact question it asks and the options or scale it picks from.
- **While it runs**, results arrive best first, with a progress bar and a time left.
- **After**, a line above the list says what the percentage means for that question, the slider sets how high an item must score to show, and clicking a title opens what the model read and why it scored that way.
- **When nothing clears the bar**, the page says what came closest and offers to show it, or to try a second wording side by side.
- **Without an API key**, the page lists the setup steps instead of failing on every item.
- **Press `?`** (or the help icon) for a guide written from your own config: your tabs, your examples, your backend's cost and privacy. `/` jumps to the question box.

Two demos ship in `examples/`:
- **`aesop/`**: 313 public-domain fables (Project Gutenberg #21), with lenses for the moral, how harsh the ending is, and whether it is bedtime-safe.
- **`research-notes/`**: a small synthetic research notebook (briefs, news digests, insight logs), with a routing report and an accuracy eval. All of it is invented sample data.

![The Moral preset: every fable filed under its lesson, filtered to greed, with "The Dog and the Shadow" expanded to show the full probability distribution and the text Jev read](docs/images/sieve-moral.png)

## Commands

```bash
node sieve.cjs index                         # count items by kind
node sieve.cjs ask "<plain words>"           # rank everything; --type score for a 4-step scale
node sieve.cjs ask "<A>" --vs "<B>"          # compare two wordings of the same question
node sieve.cjs ask "<A>" --then "<B>"        # ask B of only the items A matched (--min 0.5)
node sieve.cjs lens <preset>                 # run a preset from the config
node sieve.cjs related "<title words>"       # how every other item relates to one item
node sieve.cjs lint                          # check plain-English rules; exits 1 on a fail
node sieve.cjs route                         # write a routing report (orphans, hooks, second looks)
node sieve.cjs eval                          # accuracy of a choice lens against labels you already have
node sieve.cjs eval --backend local          # the same eval against a local model (see Backends)
node sieve.cjs serve                         # the web UI
```

Common options: `--config <file>`, `--kind a,b`, `--since 2026-06`, `--top 20`, `--json`, `--pack <n>`, `--no-cache`.
`node sieve.cjs --help` lists them all.
Answers are cached in `.cache/answers.jsonl`, so re-running an unchanged sift is free.

## More than search

A typed question with a probability is a building block, not only a search box.
Related, compare, and narrow work in the web UI and on the command line; lint is a command for CI; export is in the web UI.

### Related: "more like this", as a stance

Open any result's **Details** and press **Find related**.
Every other item is asked how it relates to that one: it makes the *same* point, *supports* it with its own evidence, *contradicts* it, shares only the *topic*, or is *unrelated*.
The anchor item rides along in every request, so there is no embedding index to build or keep fresh, and the answer is a relation you can act on rather than a distance.

![Related to "Grants reward launches, not upkeep": the panel brief that makes the same point on top, eight items that support it, and a news story split 46% supports, 37% contradicts](docs/images/sieve-related.png)

On the research-notes demo it finds the brief behind an insight at 94% "same", and the evidence around it as "supports".
Mixed cases come back mixed: a news story about a new maintenance-only fund comes back about half *supports* and a third *contradicts* (the split moves a few points between runs), because a fund for upkeep cuts against "nobody funds upkeep" while being ten times oversubscribed backs it up.
On six invented pairs written to test it (two contradictions, one of each other relation, and an unrelated one), Jev picked the intended relation every time.
It is built for notes that make claims or report events; on fables, where the point is a moral, most items land on "same topic".
It runs on a local backend too; Kev-4B put the closest item first but called most of the rest "unrelated", the same habit as its "none" answers.

```bash
node sieve.cjs related "grants reward" --config examples/research-notes/sieve.config.json
```

### Compare two wordings

Most of the work in Sieve is wording the question (see "How to ask Jev" below), so test two wordings side by side.
Both are asked in the same request, which reads each item once, so the second wording costs almost nothing ($0.0005 against $0.0004 for the demo).
Results are grouped into *both*, *only A*, *only B*, and *neither*.

![Comparing "security risks of AI agents" with "attacks on AI systems": five items match both, and two (over-broad credentials and tool permissions) match only the first wording](docs/images/sieve-compare.png)

"Security risks of AI agents" and "attacks on AI systems" agree on five items and part ways on two: credential sprawl and tool permissions are risks, not attacks, and Jev reads the wording literally.

### Narrow, one question at a time

After a sift, **Then ask of these** puts a follow-up question to only the items above the bar (and inside the group chip you picked).
Each step is a breadcrumb you can click to go back, so a search can be built up like a funnel and every step shows what it kept and what it dropped.
On the demo, "small hardware that runs AI models on its own" keeps 9 of 44 items; "something shown working at an event" then puts the maker-conference story and the two live-demo notes on top at 95-97% and drops the chip announcements below 10%.
The follow-up only reads the 9 survivors, so it costs a fraction of the first question.

```bash
node sieve.cjs ask "small hardware that runs AI models on its own" --then "something shown working at an event"
```

### Lint: plain-English rules, with an exit code

A lint rule is a yes/no lens where *yes* means a problem.
`sieve lint` asks every rule of every item it covers (all rules for an item in one request) and sorts the answers into **fail**, **review**, and pass by the rule's thresholds, so the uncertain middle goes to a person instead of being guessed.
It exits with 1 when anything fails, which makes it a check for CI or a pre-publish step.
A backend error also exits with 1: a check that could not ask about a note never counts as passing it.

```json
"lint": { "rules": [
  { "id": "unsourced-figure", "lens": "unsourced", "kinds": ["brief", "insight"], "fail": 0.9, "warn": 0.6 }
] }
```

```text
$ node sieve.cjs lint --config examples/research-notes/sieve.config.json
fail   96%  unsourced-figure  insights/edge-ai.md:35  Wake-word models live or die on the audio front end
fail   92%  unsourced-figure  insights/edge-ai.md:28  Misclassifications are the best part of a live vision demo
warn   87%  unsourced-figure  insights/ai-safety.md:28  Leaderboard gaps often sit inside the error bars
...
2 failed, 3 to review, 32 items checked against unsourced-figure (12 not covered by any rule)
```

The two fails are real: "a $4 chip" and "a sub-$150 rig" are figures with no source.
In a pull request, check only what changed and get the findings as annotations on the diff:

```yaml
# .github/workflows/notes.yml
on: pull_request
jobs:
  sieve:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: git clone --depth 1 https://github.com/nothans/sieve /tmp/sieve
      - run: node /tmp/sieve/sieve.cjs lint --config sieve.config.json --changed origin/${{ github.base_ref }} --format github
        env: { OPENROUTER_API_KEY: "${{ secrets.OPENROUTER_API_KEY }}" }
```

`--format json` gives the findings to a script instead.
Rules that suit a notes repo: a figure without a source, a private phone number or address, a claim about "today" that will date badly, a draft marked as final.

### Export

The toolbar copies the rows on screen as a Markdown list (with links to each file and line), or downloads them as CSV or JSON (every probability included, and the narrowing steps that produced them).

## Point it at your own notes

Copy an example config into `local/` (git ignores everything there but its README) and edit it:

```bash
cp examples/research-notes/sieve.config.json local/sieve.config.json
node sieve.cjs index        # local/sieve.config.json is the default config
```

A config has six parts: `sources`, `lenses`, and `presets` below, plus the optional `route`, `eval`, and `lint` sections.
Paths are relative to the config file.

### `sources`: what counts as an item

```json
{ "root": "../../my-notes",
  "sources": [
    { "kind": "brief",   "display": "briefs",   "glob": "briefs/*.md", "exclude": ["_*", "README.md"],
      "text": "gist", "gist": ["tl;?dr", "implications"], "dateFrom": ["field", "filename"] },
    { "kind": "news",    "glob": "news/*.md", "split": { "heading": 3, "requireBody": true }, "maxChars": 1600 },
    { "kind": "insight", "glob": "insights/*.md", "split": { "heading": 2, "requireDate": true, "stripDate": true },
      "dateFrom": ["title"], "label": "filename" },
    { "kind": "signal",  "glob": "trends/*.md", "split": "dated-bullets", "counterKind": "counter-signal" },
    { "kind": "post",    "glob": "blog/*/*.md", "sameNameAsFolder": true, "text": "body" },
    { "kind": "talk",    "glob": "talks/*/*.md", "firstOf": ["abstract.md", "README.md"], "text": "full" }
  ] }
```

| Option | Meaning |
|---|---|
| `glob` | One pattern or a list. `*` and `?` match within a folder, `**` across folders. |
| `exclude` | Patterns to skip. One without a slash matches the file name. |
| `split` | `"file"` (default): one item per file. `{"heading": n}`: one per level-n section (`requireBody`, `requireDate`, `stripDate`). `"dated-bullets"`: one per `- **YYYY-MM-DD - Title.** ...` line; a heading containing "counter" switches to `counterKind`. |
| `text` | For whole files: `"gist"` (default: only the sections whose titles match `gist`, else the file), `"body"` (after front matter), or `"full"`. |
| `maxChars` | Clip each item's text (default 2,400). Jev's accuracy drops when the state is full of text the question does not need. |
| `dateFrom` | Where to find the date, in order: `frontmatter`, `field` (a `**Date:**` line), `title` (the section heading), `filename`, `folder`, `head:N` (the first N characters). Undated items fall back to the commit that added the file unless `"gitDates": false`. |
| `titleFallback` | When there is no front matter title or `#` heading: `filename`, `folder`, `titlecase-folder`, or the default title-cased file name. |
| `label` | `"filename"` or `"folder"`: attach a label to each item, for `eval` and second looks. |
| `sameNameAsFolder`, `firstOf` | Keep only `x/x.md`; or keep the first of these names in each folder. |
| `display` | The plural shown in the UI. |

### `lenses`: the questions

```json
"lenses": {
  "theme":  { "type": "choice", "label": "Theme", "question": "Which theme is {item} mainly about?",
              "options": { "edge-ai": "Running models on small local hardware...", "none": "None of these themes." } },
  "demo":   { "type": "noul", "label": "Live-demo ready", "question": "Does {item} describe a working build that could be demonstrated live?",
              "true": "A concrete, runnable thing.", "false": "Analysis, opinion, or news without something to show." },
  "strength": { "type": "score", "label": "Evidence", "question": "How well does {item} support its main claim?",
              "levels": ["No evidence.", "An anecdote.", "One measured result.", "Several agreeing sources."] }
}
```

`{item}` becomes "this item" or a pointer into a packed request.
The option descriptions are the whole prompt, so write them carefully (see "How to ask Jev" below).
Give a choice a `none` option so it is never forced to pick.

### `presets`: what the UI and `lens` offer

```json
"presets": [
  { "id": "ask" },
  { "id": "theme", "lens": "theme", "group": true },
  { "id": "counter", "lens": "counter", "thesis": "the default claim to test" },
  { "id": "fit", "title": "Fits the book", "lenses": { "a": "angleA", "b": "angleB", "ch": "chapter" },
    "value": { "max": ["a", "b"] }, "label": { "choice": "ch", "via": { "a": "angle A", "b": "angle B" } }, "group": "ch" }
]
```

- `ask` is built in: the free-text box.
- A single-`lens` preset ranks by that lens. `group` adds filter chips by choice. `thesis` adds a text box that tests a typed claim instead of the lens.
- A composite preset asks several lenses in the same request and ranks by the strongest (`value.max`). This is how to turn an interpretive question ("does this fit my book?") into literal ones Jev answers well.
- `examples`, `name`, and `tagline` at the top level fill in the UI.

### `route`: the routing report

```json
"route": {
  "lenses": { "theme": "theme" }, "category": "theme", "confident": 0.8,
  "orphans": { "kinds": ["brief"], "linkFiles": ["index.md", "insights/*.md"] },
  "hooks": { "title": "Book hooks", "angles": { "a": "angle A" }, "choice": "ch", "min": 0.6, "notLinkedIn": ["book/signals.md"] },
  "secondLooks": { "kinds": ["insight"], "min": 0.9 },
  "reportsDir": "reports"
}
```

`sieve route` writes a Markdown report with up to three sections:
**orphans** (items that none of the `linkFiles` mention yet, grouped by the category the model picks);
**hooks** (items that clear a composite bar and are not yet in `notLinkedIn`);
**second looks** (labeled items the model is at least `min` sure belong to a different category, which usually means misfiled or cross-cutting).
The report names the backend and model that answered, so a report made with a local model says so.
The research-notes demo finds exactly the four briefs its index leaves out.

### `eval`: is it any good on your notes?

```json
"eval": { "lens": "theme", "kinds": ["insight"], "strip": ["^\\*\\*Tags:\\*\\*.*$"], "n": 240 }
```

If a source carries labels (`"label": "filename"` when files are already sorted by topic), that filing is ground truth.
`sieve eval` strips anything that would give the answer away (`strip`, regexes), asks the lens, and reports accuracy, top-2 accuracy, accuracy by confidence band, and the most common confusions, at several pack sizes.
It also reports the confidence to act at for 90% and 95% accuracy on your labels.
A threshold needs at least 20 answers above it; with fewer labeled items, eval says how accurate the top slice was and asks for more labels instead of inventing a cutoff.

### `lint`: rules for `sieve lint`

A list of rules, each a yes/no lens where yes means a problem, with the item kinds it covers and its `fail` and `warn` thresholds (defaults 0.9 and 0.6).
See "Lint" above.

## Backends: Jev in the cloud, or a model on your machine

Every backend speaks the same request (`{ model, state, questions }` in, typed answers out), so Sieve can send its questions to:

| Backend | What it is | Defaults |
|---|---|---|
| **Jev via OpenRouter** (default) | `typesafe/jev-1.13`; key in `OPENROUTER_API_KEY` | 16 items per request, 16 requests at once |
| **Jev via TypeSafe** | `jev-latest` direct; key in `TYPESAFE_API_KEY` | 16 and 16 |
| **Local server** | any server with TypeSafe's `/v1/systemone` API: [Kev](https://github.com/jaredpalmer/kev), [Laya](https://github.com/NandhaKishorM/laya), [openjev](https://github.com/razorback16/openjev), JevK5 | 1 item per request, 1 at a time, 5-minute timeout |

Pick one in the web UI's **Settings** tab (or `--backend <id>` on the command line), edit its URL, model, and limits, add more local servers, and **Test connection** before you save.
Settings live in `local/settings.json`.
Keys never do: a profile names the environment variable that holds its key, and the page only shows whether it is set.
Plain `http` is allowed only for this machine.
Answers are cached per backend (and per checkpoint a local server reports), so switching backends never mixes their answers.

Running Kev locally (it needs about 9 GB of RAM or VRAM for Kev-4B in bf16, twice that in fp32; see its README for Macs and GPUs):

```bash
git clone https://github.com/jaredpalmer/kev && cd kev && uv sync --extra serve
KEV_DTYPE=bf16 uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009
# then in Sieve: Settings > Local server > Test connection, or
node sieve.cjs eval --backend local --packs 1 --concurrency 3
```

Two setup problems to know about before you start:
- **CPUs without native bf16 run bf16 slowly.** On an Intel i9-9900K, `KEV_DTYPE=fp32` answered in 2.2 s where bf16 took 7.2 s, with the same probabilities. Laptops with bf16 support (the Ryzen AI 9 below) are fine in bf16. Time one request each way before a long run.
- **Windows without Developer Mode cannot create symlinks**, and the first download fails with `WinError 1314`. Set `HF_HUB_DISABLE_SYMLINKS=1` (PowerShell: `$env:HF_HUB_DISABLE_SYMLINKS=1`) before starting the server.

**What to expect (measured 2026-09-25, same 240 hand-filed items as above, one item per request):**

| | Kev-4B, local CPU (Ryzen AI 9 HX 370, bf16) | Jev 1.13 via OpenRouter |
|---|---|---|
| Accuracy | 55.0% | 77.9% (same items) |
| Best real theme, with the "none" option removed | 75.8% | 81.8% |
| Right answer in the top two | 79.6% | 94.4% |
| To be right 90% of the time, act at | confidence ≥ 0.52, covering 25% of items | ≥ 0.91, covering 58% |
| Speed | about 5-7 s per item (11 items a minute at 3 requests at once) | about 0.3-0.8 s per request of 16 items |
| Cost | electricity | about $0.01 for all 240 |

Most of Kev's gap is one habit: it picked "none of these themes" on 83 of 240 items (Jev: 17).
It is also underconfident here (answers it rated 0.5-0.8 were right 86% of the time), which is why its 90% threshold sits at 0.52.
A second run (2026-09-26, the synthetic research-notes demo, Kev-4B in fp32 on an i9-9900K desktop) found the same pattern: whenever Kev picked a real theme it matched Jev, 36 times out of 36, and all eight disagreements were Kev choosing "none".
It took about 6 s per item there, so 44 items took 4-5 minutes per question against under a second on OpenRouter.
Your numbers will differ by corpus and hardware, so run `sieve eval --backend <id>` before trusting a local backend: it reports accuracy, accuracy without the escape option, and the threshold that reaches 90% and 95% on your own labels.
Thresholds do not transfer between backends.

## How well does it work? (measured)

On a real 1,140-item research notebook (the author's own; not included), against 240 insights and signals already filed into six themes by hand, with the tags stripped:

| Items per request | Accuracy | Top-2 | When Jev's confidence is 0.8+ | Requests | Cost | Time |
|---|---|---|---|---|---|---|
| 1 | 77.5% | 93.3% | 88.5% (69% of items) | 240 | $0.0106 | 5.9 s |
| 8 | 80.0-80.4% | 93.3-93.8% | 88.8-89.3% | 30 | $0.0084 | 0.9-1.8 s |
| **16 (default)** | 81.7-82.1% | 94.2-95.4% | 92.5-93.5% (64-66% of items) | 15 | $0.0083 | 0.9-1.4 s |
| 26 | 84.2-85.0% | 95.8% | 92.5-92.6% | 10 | $0.0082 | 1.0-1.5 s |

Two runs; below 0.5 confidence, accuracy was close to a coin flip, and Jev said so.
Packing did not cost accuracy here, and may have helped, but the eval interleaves themes, so a folder sorted by topic could behave differently: run `eval` on yours.
On the synthetic research-notes demo the theme lens scores 95% (19 of 20, and the miss is a deliberately cross-cutting entry).

## How to ask Jev

Most of the work is wording the questions so a literal reader gets them right.
TypeSafe documents these failure modes in its [jev-1.13 jaggedness notes](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md); here is how each one showed up in practice.
- **Interpretive questions over-fire.** "Which chapter of my book does this feed?" put 76 of 612 items in the chapter about trust, because "trust" reads broadly. Three literal yes/no questions, the max taken in code, then the chapter choice: 15 precise hits. That is the composite preset above.
- **Indirection turns to mush.** "Is this evidence against thesis X?" left every item near 0.45. Asking for the concrete thing that would contradict X put the one real counter-argument on top and dropped the rest near zero.
- **Put both things in the state.** Comparing two texts works when both are in front of Jev and the question points at them by name: "How does `item` relate to `anchor`?" with each relation described in the options. That is how Related works, and it called all six of its test pairs, contradictions included.
- **Say what the text says.** "Hardware small enough to fit in a pocket" left every item on the demo under 50%, because no note mentions pockets; "small hardware that runs AI models on its own" found the same items at 83-97%. When a question comes back empty, reword it toward the words the notes use, and compare the two wordings side by side.
- **Pronouns mean nothing.** "Projects I could demo" ranked a product launch first; Jev does not know who "I" is. "A hands-on build that could be demoed live at a developer meetup" ranked the right talk first.
- **Keep arithmetic, counting, and dates in code.** Filter by kind and date before asking; Jev never sees what it does not need to judge.
- **It cannot explain itself.** Every result opens to show the probabilities and exactly the text Jev read, so you can judge the judgment.
- **Adversarial text can move it.** Content is data to Jev, not something it defends against. Test before gating anything that matters.

## The Jev client

`lib/jev.cjs` is a standalone, dependency-free client and CLI for Jev on OpenRouter, usable without the rest of Sieve:

```bash
node lib/jev.cjs noul "Is the writer frustrated?" --state "The build is red again. Third time today."
node lib/jev.cjs choice "Which team owns this?" billing="Payments, refunds" tech="Bugs, outages" --state-file ticket.txt
node lib/jev.cjs score "How risky is this?" "No risk" "Some risk" "High risk" --state -
node lib/jev.cjs batch --in items.jsonl --questions questions.json --out answers.jsonl
```

```js
const { createClient, noul, choice, gate } = require('./lib/jev.cjs');
const jev = createClient({ cacheFile: '.cache/answers.jsonl' });
const r = await jev.decide(ticketText, { refund: noul('Does the customer ask for a refund?') });
gate(r.answers.refund.noul);   // 'approve' at 0.9+, 'block' at 0.1-, else 'review'
```

It validates questions against the documented limits before spending anything, retries 429s and gateway errors with backoff (never a 400), caches answers on disk, runs batches with bounded concurrency, and keeps a running tally of cost and latency.
Set `JEV_MODEL` to `~typesafe/jev-latest` to follow new releases; the default pins `typesafe/jev-1.13` so tuned thresholds do not drift.

## Safety notes

- `sieve serve` binds to 127.0.0.1 only. Every sift spends API credit and the server holds your keys, so it is not for the network.
- Binding to localhost is not enough on its own, because any web page you have open can send requests to 127.0.0.1. Sieve's API answers only its own page: it checks the Host header (which stops DNS rebinding), the Origin, and `Sec-Fetch-Site`, and settings changes also require an `X-Sieve` header that a cross-site page cannot send.
- One sift runs at a time, the page validates with a free preflight, and it never lets the browser silently reconnect a stream (a reconnect would be a second, paid sift).
- Every command sends the text of the items it asks about to the backend, `sieve lint` in CI included. Use a local backend for notes that must not leave the machine.
- Jev has a 64k-token request limit (32k for the state plus the longest question) and 1,200 requests per minute. Sieve's packing keeps a 1,000-item sweep to about 70 requests.

## Tests

```bash
npm test        # or: node --test "test/*.test.cjs"
```

46 tests, no network: the corpus reader on every source mode (and ids that survive a re-index), config loading, lenses and presets, related and compare, backend profiles and settings, packing at sizes 1-99 with and without a shared anchor, the report, eval, and lint logic (thresholds, the escape-option check, rule scoping, GitHub annotations, `--changed` against a real git repo), both shipped examples, the Jev client's retries and cache, and the web server end to end against a fake backend: the cross-site guard, related, compare, narrowing a finished sift, stopping a sift when the page closes, catching a missing API key before anything runs, and the cost and time estimate.

## Credits

Built by [Hans Scharler](https://nothans.com).
Jev is TypeSafe's model ([docs](https://docs.typesafe.ai/llms.txt)), served here through OpenRouter; Sieve is not affiliated with either.
The Aesop demo is George Fyler Townsend's 1867 translation from [Project Gutenberg eBook #21](https://www.gutenberg.org/ebooks/21), public domain in the US.

MIT License.
