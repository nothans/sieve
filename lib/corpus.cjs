// Turn a folder of Markdown into a flat list of items Jev can judge one at a time.
//
// What counts as an item is set per source in the config: a whole file, one section per
// heading, or one dated bullet per line. Each item keeps a pointer back to its file and line
// so a result is one click from its source.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { glob, matches } = require('./glob.cjs');

// Jev's accuracy drops as state fills with material the question does not need
// (docs: "Large state full of irrelevant detail"), so each item carries its gist, not
// the whole file.
const MAX_TEXT = 2400;
const DEFAULT_GIST = ['tl;?dr', 'implications', 'summary', 'the idea', 'status', 'why'];
const DEFAULT_DATE_FROM = ['frontmatter', 'field', 'title', 'filename', 'folder', 'head:400'];

const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

function clip(text, max = MAX_TEXT) {
  const t = text.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return (stop > max * 0.6 ? cut.slice(0, stop + 1) : cut).trim() + ' ...';
}

// First top-level heading outside code fences (a "# Node" comment in a shell block is not a title).
function firstHeading(text) {
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    else if (!inFence && /^#\s+\S/.test(line)) return line.replace(/^#\s+/, '').trim();
  }
  return null;
}

const titleCase = (slug) => slug.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// Dates come from the text when it has one, then the path; never from mtime, which git
// checkouts rewrite.
function findDate(...sources) {
  for (const s of sources) {
    if (!s) continue;
    const full = s.match(/(20\d\d)-(\d\d)-(\d\d)/);
    if (full) return full[0];
    const month = s.match(/(20\d\d)-(\d\d)/);
    if (month) return `${month[0]}-01`;
  }
  return null;
}

// Split markdown at a heading level, keeping each section's heading, body, and start line.
function sections(text, level) {
  const marker = '#'.repeat(level) + ' ';
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  let inFence = false;
  lines.forEach((line, i) => {
    if (line.startsWith('```')) inFence = !inFence;
    if (!inFence && line.startsWith(marker)) {
      if (cur) out.push(cur);
      cur = { title: line.slice(marker.length).trim(), line: i + 1, body: [] };
    } else if (!inFence && cur && /^#{1,6} /.test(line) && line.match(/^#+/)[0].length < level) {
      out.push(cur);
      cur = null;
    } else if (cur) {
      cur.body.push(line);
    }
  });
  if (cur) out.push(cur);
  return out.map((s) => ({ ...s, body: s.body.join('\n').trim() }));
}

// Keep the parts of a document that carry its argument (TL;DR, Implications, ...), else the top.
function gist(text, patterns = DEFAULT_GIST) {
  const re = new RegExp(patterns.join('|'), 'i');
  const wanted = sections(text, 2).filter((s) => re.test(s.title));
  if (wanted.length) return wanted.map((s) => `${s.title}\n${s.body}`).join('\n\n');
  return text.replace(/^#\s+.+\n/, '');
}

// Simple "key: value" front matter; enough for title and date.
function frontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { fields: {}, body: text };
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { fields, body: text.slice(m[0].length) };
}

const asList = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const stem = (rel) => path.posix.basename(rel, path.posix.extname(rel));
const folder = (rel) => path.posix.basename(path.posix.dirname(rel));

function sourceFiles(root, src) {
  const excludes = asList(src.exclude);
  let files = asList(src.glob).flatMap((g) => glob(root, g));
  files = files.filter((f) => !excludes.some((x) => matches(f, x)));
  if (src.sameNameAsFolder) files = files.filter((f) => stem(f) === folder(f));
  if (src.firstOf) {
    // One file per folder: the first name in `firstOf` that exists there.
    const byDir = new Map();
    for (const f of files) {
      const d = path.posix.dirname(f);
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d).push(f);
    }
    files = [...byDir.values()]
      .map((group) => src.firstOf.map((n) => group.find((f) => path.posix.basename(f) === n)).find(Boolean))
      .filter(Boolean);
  }
  return files;
}

// `dateFrom` names where to look, in order: frontmatter, field (**Date:** line), title (the
// section heading), filename, folder, head:N (the first N characters of the body).
function dateFor(order, ctx) {
  return findDate(...order.map((s) => {
    if (s === 'frontmatter') return ctx.fields.date;
    if (s === 'field') return ctx.raw.match(/\*\*Date:\*\*\s*(\S+)/)?.[1];
    if (s === 'title') return ctx.sectionTitle;
    if (s === 'filename') return path.posix.basename(ctx.rel);
    if (s === 'folder') return folder(ctx.rel);
    const head = s.match(/^head:(\d+)$/);
    if (head) return ctx.body.slice(0, Number(head[1]));
    return null;
  }));
}

function fallbackTitle(mode, rel) {
  if (mode === 'filename') return stem(rel);
  if (mode === 'folder') return folder(rel);
  if (mode === 'titlecase-folder') return titleCase(folder(rel));
  return titleCase(stem(rel));
}

function labelFor(mode, rel) {
  if (mode === 'filename') return stem(rel);
  if (mode === 'folder') return folder(rel);
  return undefined;
}

function itemsFromFile(src, root, rel) {
  const raw = read(path.join(root, rel));
  const { fields, body } = frontMatter(raw);
  const dateFrom = src.dateFrom || DEFAULT_DATE_FROM;
  const max = src.maxChars || MAX_TEXT;
  const label = labelFor(src.label, rel);
  const kind = src.kind;
  const split = src.split || 'file';

  if (split === 'file') {
    const mode = src.text || 'gist';
    const text = mode === 'full' ? raw : mode === 'body' ? body : gist(body, src.gist);
    return [{
      kind, path: rel, line: 1,
      title: fields.title || firstHeading(body) || fallbackTitle(src.titleFallback, rel),
      date: dateFor(dateFrom, { fields, raw, body, rel }),
      label, text: clip(text, max),
    }];
  }

  if (split === 'dated-bullets') {
    // "- **YYYY-MM-DD - Title.** detail" lines; a heading containing "counter" switches the kind.
    const items = [];
    let counter = false;
    raw.split('\n').forEach((line, i) => {
      if (/^#+ /.test(line)) counter = /counter/i.test(line);
      const m = line.match(/^- \*\*(20\d\d-\d\d-\d\d)\s*[—-]\s*(.+)$/);
      if (!m) return;
      const title = m[2].replace(/\*\*.*$/, '').replace(/[:.]\s*$/, '').trim();
      items.push({
        kind: counter && src.counterKind ? src.counterKind : kind, path: rel, line: i + 1,
        title: title.length > 140 ? title.slice(0, 137) + '...' : title,
        date: m[1], label, text: clip(line.replace(/^- /, ''), max),
      });
    });
    return items;
  }

  if (split.heading) {
    const items = [];
    for (const s of sections(raw, split.heading)) {
      if (split.requireBody && !s.body) continue;
      if (split.requireDate && !findDate(s.title)) continue;
      items.push({
        kind, path: rel, line: s.line,
        title: split.stripDate ? s.title.replace(/^20\d\d-\d\d-\d\d\s*[—-]\s*/, '') : s.title,
        date: dateFor(dateFrom, { fields, raw, body, rel, sectionTitle: s.title }),
        label, text: clip(`${s.title}\n${s.body}`, max),
      });
    }
    return items;
  }

  throw new Error(`source "${kind}": unknown split ${JSON.stringify(split)}`);
}

function gitAddedDate(root, file) {
  try {
    const out = execFileSync('git', ['log', '--diff-filter=A', '--follow', '--format=%cs', '--', file], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n');
    return out[out.length - 1] || null;
  } catch (_) {
    return null; // not a git checkout, or git missing
  }
}

// config: { root, sources: [...], gitDates }. See README for the source options.
function buildCorpus(config) {
  const { root } = config;
  const all = [];
  for (const src of config.sources) {
    for (const rel of sourceFiles(root, src)) all.push(...itemsFromFile(src, root, rel));
  }
  const items = all.filter((it) => it.text && it.text.length > 40);
  // Undated items fall back to the commit that added the file, when the corpus is a git checkout.
  if (config.gitDates !== false) for (const it of items) if (!it.date) it.date = gitAddedDate(root, it.path);
  // Stable, short ids: cheap to repeat in a packed state.
  return items.map((it, i) => ({ id: `i${i}`, ref: `${it.path}:${it.line}`, ...it }));
}

module.exports = { buildCorpus, sourceFiles, itemsFromFile, sections, clip, findDate, gist, frontMatter, firstHeading, MAX_TEXT };
