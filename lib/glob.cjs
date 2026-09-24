// A small glob for corpus sources: `*` and `?` within one path segment, `**` across segments.
// Paths are relative to the corpus root, always with forward slashes. Only the directories a
// pattern can reach are walked, so a corpus inside a big repo stays fast.

const fs = require('fs');
const path = require('path');

const SKIP = new Set(['.git', 'node_modules']);

function segmentRegex(seg) {
  const re = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${re}$`);
}

function toRegex(pattern) {
  const segs = pattern.split('/').filter(Boolean);
  const parts = segs.map((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === '**') return last ? '.*' : '(?:[^/]*/)*';
    const re = segmentRegex(seg).source.slice(1, -1);
    return last ? re : `${re}/`;
  });
  return new RegExp(`^${parts.join('')}$`);
}

// Match a relative path against a pattern. A pattern with no slash matches the basename.
function matches(rel, pattern) {
  if (!pattern.includes('/')) return segmentRegex(pattern).test(path.posix.basename(rel));
  return toRegex(pattern).test(rel);
}

function readdir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}

// Files matching the pattern, in directory order (so item order is stable across runs).
function glob(root, pattern) {
  const segs = pattern.split('/').filter(Boolean);
  const out = [];
  function walk(dir, rel, i) {
    if (i === segs.length) return;
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === '**') {
      walk(dir, rel, i + 1); // zero directories
      for (const e of readdir(dir)) {
        if (e.isDirectory() && !SKIP.has(e.name)) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, i);
      }
      return;
    }
    if (!/[*?]/.test(seg)) {
      const p = path.join(dir, seg);
      const r = rel ? `${rel}/${seg}` : seg;
      let st;
      try { st = fs.statSync(p); } catch (_) { return; }
      if (last) { if (st.isFile()) out.push(r); } else if (st.isDirectory()) walk(p, r, i + 1);
      return;
    }
    const re = segmentRegex(seg);
    for (const e of readdir(dir)) {
      if (!re.test(e.name) || SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (last) { if (e.isFile()) out.push(r); } else if (e.isDirectory()) walk(path.join(dir, e.name), r, i + 1);
    }
  }
  walk(root, '', 0);
  return [...new Set(out)];
}

module.exports = { glob, matches };
