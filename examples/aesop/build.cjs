#!/usr/bin/env node
// Rebuild fables.md from Project Gutenberg eBook #21, "Three hundred Aesop's fables"
// (translated by George Fyler Townsend, public domain in the US).
//
//   node examples/aesop/build.cjs                 downloads the text, writes fables.md
//   node examples/aesop/build.cjs pg21.txt        uses a local copy instead
//
// Output: one "## Title" section per fable, wrapped lines joined into paragraphs, the
// Gutenberg header, footer, and the book's preface and index left out.

const fs = require('fs');
const path = require('path');

const SOURCE = 'https://www.gutenberg.org/cache/epub/21/pg21.txt';
const OUT = path.join(__dirname, 'fables.md');

async function load() {
  const local = process.argv[2];
  if (local) return fs.readFileSync(local, 'utf8');
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  return res.text();
}

function convert(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  const start = text.indexOf('\nAESOP’S FABLES\n');
  const end = text.indexOf('*** END OF THE PROJECT GUTENBERG EBOOK');
  if (start < 0 || end < 0) throw new Error('unexpected layout: cannot find the fables section');
  // Fables are separated by three or more blank lines; within one, the first line is the title.
  const blocks = text.slice(start + '\nAESOP’S FABLES\n'.length, end).split(/\n{4,}/).map((b) => b.trim()).filter(Boolean);
  const fables = [];
  for (const block of blocks) {
    const [title, ...rest] = block.split('\n');
    const body = rest.join('\n').trim();
    if (/^(FOOTNOTES|INDEX)$/.test(title.trim())) break; // the book's back matter
    if (!body || title.length > 80) continue; // stray notes, not fables
    const paragraphs = body.split(/\n\s*\n/).map((p) => p.split('\n').map((l) => l.trim()).join(p.startsWith('    ') ? '\n' : ' ').trim());
    fables.push(`## ${title.trim()}\n\n${paragraphs.join('\n\n')}`);
  }
  return fables;
}

(async () => {
  const fables = convert(await load());
  const head = [
    "# Aesop's Fables",
    '',
    `${fables.length} fables translated by George Fyler Townsend (1867), from Project Gutenberg eBook #21 (public domain in the US).`,
    'Rebuild with `node examples/aesop/build.cjs`.',
    '',
  ].join('\n');
  fs.writeFileSync(OUT, `${head}\n${fables.join('\n\n')}\n`);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${fables.length} fables`);
})().catch((err) => { console.error(err.message); process.exit(1); });
