// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON tool calls), applies its edits to the tree of text files
// in the working directory, and changes every file or none. The whole contract
// is SPEC.md in the kit this entry was built from: exit codes, exact stdout,
// three-tier line matching, safe paths, and all-or-nothing writes.
//
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI above it.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch that cannot be read in its format: exit 2 with this one line. */
class ParseFault {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: exit 1 with `error: <code> <path>` for it. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed per line, and the
 *  empty piece after a final `\n` dropped. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 *  `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

const stripTrailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

/** One file as lines: its line break, and whether it ends with one. */
interface Doc {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderDoc(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 *  everything else read from disk on demand. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p) as string | null;
  }

  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }
}

/** What an edit records for the exit-0 report: the moves it made. */
interface RunNotes {
  moves: Array<[string, string]>;
}

type EditFn = (tree: Tree, notes: RunNotes) => void;

/** Line equality at one matching tier. */
function linesEqualAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

/** Every 0-based position where `old` occurs in `lines` at this tier. */
function occurrencesAt(lines: string[], old: string[], tier: number): number[] {
  const found: number[] = [];
  if (old.length === 0) return found;
  for (let i = 0; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!linesEqualAt(lines[i + j] as string, old[j] as string, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier at which `old` occurs at least once, with its positions. */
function firstTierWith(
  lines: string[],
  old: string[],
  strict: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrencesAt(lines, old, t);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** Re-indent one new line at tier 2: the leading spaces and tabs P of the
 *  old block's first line are replaced by F, those of the file's first
 *  matched line. Empty and whitespace-only lines are written as they are. */
function reindentLine(line: string, f: string, p: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/** Build the replacement lines for a matched block: context lines are the
 *  file's own matched lines, other lines are re-indented at tier 2 only. */
function replacementLines(
  fileLines: string[],
  at: number,
  items: Array<{ text: string; ctxPos: number | null }>,
  tier: number,
  oldFirst: string,
): string[] {
  const f = leadingWs(fileLines[at] as string);
  const p = leadingWs(oldFirst);
  return items.map((it) => {
    if (it.ctxPos !== null) return fileLines[at + it.ctxPos] as string;
    if (tier === 2) return reindentLine(it.text, f, p);
    return it.text;
  });
}

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const c = (lines[first] as string).trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  )
    return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const needFile = (tree: Tree): string => {
    if (!isSafePath(p)) throw new EditFault('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFault('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = splitPatchLines(o.new_str);
    return (tree) => {
      const before = needFile(tree);
      const doc = parseDoc(before);
      if (line < 0 || line > doc.lines.length) throw new EditFault('no-match', p);
      const out = [...doc.lines.slice(0, line), ...add, ...doc.lines.slice(line)];
      tree.now.set(p, renderDoc({ lines: out, br: doc.br, final: doc.final }));
    };
  }
  return null;
}

function parseJsonEdits(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  const edits: EditFn[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseFault(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFault(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

type BodyKind = 'ctx' | 'del' | 'add' | 'bs';

interface BodyLine {
  kind: BodyKind;
  text: string;
  rawEmpty: boolean;
}

interface Hunk {
  a: number;
  c: number;
  body: BodyLine[];
}

interface DiffSection {
  oldPath: string | null;
  newPath: string | null;
  namedBy: 'none' | 'git' | 'rename' | 'pair';
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path a `--- ` or `+++ ` line names, or null for `/dev/null`. */
function headerPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const cut = tab >= 0 ? rest.slice(0, tab) : rest;
  const p = trimSpaces(cut);
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: DiffSection[] = [];
  const n = lines.length;
  let i = 0;
  let cur: DiffSection | null = null;
  let inHeader = false;
  const startSection = (oldPath: string | null, newPath: string | null, namedBy: DiffSection['namedBy']): DiffSection => {
    const s: DiffSection = { oldPath, newPath, namedBy, newFile: false, deletedFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  while (i < n) {
    const line = lines[i] as string;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      startSection(m[1] as string, m[2] as string, 'git');
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const nextIsPlus = (lines[i + 1] ?? '').startsWith('+++ ');
      if (!nextIsPlus) {
        if (cur !== null && inHeader) throw new ParseFault(`error: parse ${i + 2}`);
        i += 1;
        continue;
      }
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1] as string);
      if (cur !== null && inHeader && cur.namedBy !== 'pair') {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.namedBy = 'pair';
      } else {
        startSection(oldP, newP, 'pair');
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFault(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), c: Number(m[3]), body: [] };
      let k = i + 1;
      while (k < n) {
        const l = lines[k] as string;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          hunk.body.push({ kind: 'ctx', text: '', rawEmpty: true });
          k += 1;
        } else if (l[0] === ' ') {
          hunk.body.push({ kind: 'ctx', text: l.slice(1), rawEmpty: false });
          k += 1;
        } else if (l[0] === '-') {
          hunk.body.push({ kind: 'del', text: l.slice(1), rawEmpty: false });
          k += 1;
        } else if (l[0] === '+') {
          hunk.body.push({ kind: 'add', text: l.slice(1), rawEmpty: false });
          k += 1;
        } else if (l[0] === '\\') {
          if (hunk.body.length === 0) throw new ParseFault(`error: parse ${k + 1}`);
          hunk.body.push({ kind: 'bs', text: l.slice(1), rawEmpty: false });
          k += 1;
        } else {
          break;
        }
      }
      while (hunk.body.length > 0 && (hunk.body[hunk.body.length - 1] as BodyLine).rawEmpty) hunk.body.pop();
      cur.hunks.push(hunk);
      inHeader = false;
      i = k;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ') && cur.namedBy !== 'pair') {
        cur.oldPath = trimSpaces(line.slice('rename from '.length));
        cur.namedBy = 'rename';
      } else if (line.startsWith('rename to ') && cur.namedBy !== 'pair') {
        cur.newPath = trimSpaces(line.slice('rename to '.length));
        cur.namedBy = 'rename';
      } else if (line.startsWith('new file mode')) {
        cur.newFile = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => diffSectionEdit(s, strict));
}

/** Is a `\` line the body line right after the hunk's last context or `+` line? */
function backslashAfterLast(hunk: Hunk): boolean {
  let last = -1;
  hunk.body.forEach((b, idx) => {
    if (b.kind === 'ctx' || b.kind === 'add') last = idx;
  });
  if (last < 0) return false;
  return hunk.body[last + 1] !== undefined && (hunk.body[last + 1] as BodyLine).kind === 'bs';
}

/** The split of one hunk body into the old lines O and the new lines N. */
function hunkSides(hunk: Hunk): { oldLines: string[]; items: Array<{ text: string; ctxPos: number | null }> } {
  const oldLines: string[] = [];
  const items: Array<{ text: string; ctxPos: number | null }> = [];
  let oPos = 0;
  for (const b of hunk.body) {
    if (b.kind === 'ctx') {
      oldLines.push(b.text);
      items.push({ text: b.text, ctxPos: oPos });
      oPos += 1;
    } else if (b.kind === 'del') {
      oldLines.push(b.text);
      oPos += 1;
    } else if (b.kind === 'add') {
      items.push({ text: b.text, ctxPos: null });
    }
  }
  return { oldLines, items };
}

function applyOneHunk(doc: Doc, hunk: Hunk, d: number, strict: boolean, path: string): Doc {
  const { oldLines, items } = hunkSides(hunk);
  const lines = doc.lines;
  const bsAfter = backslashAfterLast(hunk);
  if (oldLines.length === 0) {
    const idx = Math.min(Math.max(hunk.a + d, 0), lines.length);
    const inserted = items.map((it) => it.text);
    const out = [...lines.slice(0, idx), ...inserted, ...lines.slice(idx)];
    const final = idx === lines.length ? !bsAfter : doc.final;
    return { lines: out, br: doc.br, final };
  }
  const found = firstTierWith(lines, oldLines, strict);
  if (found === null) throw new EditFault('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.positions[0] as number;
  let bestDist = Math.abs(best - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const at = best;
  const nLines = replacementLines(lines, at, items, found.tier, oldLines[0] as string);
  const out = [...lines.slice(0, at), ...nLines, ...lines.slice(at + oldLines.length)];
  const final = at + oldLines.length === lines.length ? !bsAfter : doc.final;
  return { lines: out, br: doc.br, final };
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let doc = parseDoc(text);
  let d = 0;
  for (const h of hunks) {
    doc = applyOneHunk(doc, h, d, strict, path);
    const { oldLines, items } = hunkSides(h);
    d += items.length - oldLines.length;
  }
  return renderDoc(doc);
}

function diffSectionEdit(sec: DiffSection, strict: boolean): EditFn {
  return (tree, notes) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (sec.newFile || oldP === null) {
      if (newP === null) return;
      if (!isSafePath(newP)) throw new EditFault('unsafe', newP);
      if (tree.get(newP) !== null) throw new EditFault('exists', newP);
      const plus: string[] = [];
      let noBreak = false;
      sec.hunks.forEach((h) => {
        h.body.forEach((b, idx) => {
          if (b.kind === 'add') {
            plus.push(b.text);
            const next = h.body[idx + 1];
            noBreak = next !== undefined && next.kind === 'bs';
          }
        });
      });
      const text = plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n');
      tree.now.set(newP, text);
      return;
    }
    if (sec.deletedFile || newP === null) {
      if (oldP === null) return;
      if (!isSafePath(oldP)) throw new EditFault('unsafe', oldP);
      if (tree.get(oldP) === null) throw new EditFault('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (!isSafePath(oldP)) throw new EditFault('unsafe', oldP);
      if (!isSafePath(newP)) throw new EditFault('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new EditFault('missing', oldP);
      if (tree.get(newP) !== null) throw new EditFault('exists', newP);
      const out = applyHunks(cur, sec.hunks, strict, oldP);
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      notes.moves.push([oldP, newP]);
      return;
    }
    if (!isSafePath(oldP)) throw new EditFault('unsafe', oldP);
    const cur = tree.get(oldP);
    if (cur === null) throw new EditFault('missing', oldP);
    tree.now.set(oldP, applyHunks(cur, sec.hunks, strict, oldP));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  const n = lines.length;
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if ((lines[i] as string).trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      if ((lines[j] as string).trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new ParseFault(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if ((lines[j] as string).trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new ParseFault(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = (lines[j] as string).trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseFault('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new EditFault('missing', path);
    const doc = parseDoc(cur);
    const found = firstTierWith(doc.lines, oldLines, strict);
    if (found === null) throw new EditFault('no-match', path);
    if (found.positions.length > 1) throw new EditFault('ambiguous', path);
    const at = found.positions[0] as number;
    const items = newLines.map((t) => ({ text: t, ctxPos: null as number | null }));
    const nLines = replacementLines(doc.lines, at, items, found.tier, oldLines[0] as string);
    const out = [...doc.lines.slice(0, at), ...nLines, ...doc.lines.slice(at + oldLines.length)];
    tree.now.set(path, renderDoc({ lines: out, br: doc.br, final: doc.final }));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

type V4aKind = 'add' | 'delete' | 'update';

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface V4aSection {
  kind: V4aKind;
  path: string;
  headLine: number;
  moveTo: string | null;
  fileLines: string[];
  chunks: V4aChunk[];
}

function v4aSectionKind(line: string): V4aKind | null {
  if (line.startsWith('*** Add File: ')) return 'add';
  if (line.startsWith('*** Delete File: ')) return 'delete';
  if (line.startsWith('*** Update File: ')) return 'update';
  return null;
}

function v4aSectionPath(line: string): string {
  const colon = line.indexOf(': ');
  return trimSpaces(line.slice(colon + 2));
}

function isEndOfFileLine(line: string): boolean {
  return line.trim() === '*** End of File' && !line.startsWith(' ') && !line.startsWith('\t');
}

function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  if ((lines[first] as string).trim() !== '*** Begin Patch') throw new ParseFault(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i] as string)) {
      last = i;
      break;
    }
  }
  if ((lines[last] as string).trim() !== '*** End Patch') throw new ParseFault(`error: parse ${lines.length + 1}`);
  interface RawSection {
    kind: V4aKind;
    path: string;
    headLine: number;
    lines: string[];
    nums: number[];
  }
  const raw: RawSection[] = [];
  let cur: RawSection | null = null;
  for (let i = first + 1; i < last; i++) {
    const line = lines[i] as string;
    const kind = v4aSectionKind(line);
    if (kind !== null) {
      cur = { kind, path: v4aSectionPath(line), headLine: i + 1, lines: [], nums: [] };
      raw.push(cur);
      continue;
    }
    if (cur === null) {
      if (isBlank(line)) continue;
      throw new ParseFault(`error: parse ${i + 1}`);
    }
    cur.lines.push(line);
    cur.nums.push(i + 1);
  }
  const edits: EditFn[] = [];
  for (const sec of raw) {
    while (sec.lines.length > 0 && isBlank(sec.lines[sec.lines.length - 1] as string)) {
      sec.lines.pop();
      sec.nums.pop();
    }
    if (sec.kind === 'add') {
      const fileLines: string[] = [];
      sec.lines.forEach((l, k) => {
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new ParseFault(`error: parse ${sec.nums[k] as number}`);
      });
      edits.push(v4aAddEdit(sec.path, fileLines));
    } else if (sec.kind === 'delete') {
      sec.lines.forEach((l, k) => {
        if (!isBlank(l)) throw new ParseFault(`error: parse ${sec.nums[k] as number}`);
      });
      edits.push(v4aDeleteEdit(sec.path));
    } else {
      let moveTo: string | null = null;
      let moveSeen = false;
      const chunks: V4aChunk[] = [];
      let chunk: V4aChunk | null = null;
      let chunkStarted = false;
      sec.lines.forEach((line, k) => {
        const num = sec.nums[k] as number;
        if (k === 0 && line.startsWith('*** Move to: ')) {
          moveTo = trimSpaces(line.slice('*** Move to: '.length));
          moveSeen = true;
          return;
        }
        if (isEndOfFileLine(line)) {
          if (chunk !== null) {
            chunk.eof = true;
            chunks.push(chunk);
            chunk = null;
          }
          return;
        }
        if (line.startsWith('@@')) {
          if (chunk !== null) chunks.push(chunk);
          const anchor = trimSpaces(line.slice(2));
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunkStarted = true;
          return;
        }
        if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
          if (chunk === null) {
            if (chunkStarted) throw new ParseFault(`error: parse ${num}`);
            chunk = { anchor: null, eof: false, body: [] };
            chunkStarted = true;
          }
          if (line === '') chunk.body.push({ kind: 'ctx', text: '', rawEmpty: true });
          else if (line[0] === ' ') chunk.body.push({ kind: 'ctx', text: line.slice(1), rawEmpty: false });
          else if (line[0] === '-') chunk.body.push({ kind: 'del', text: line.slice(1), rawEmpty: false });
          else chunk.body.push({ kind: 'add', text: line.slice(1), rawEmpty: false });
          return;
        }
        throw new ParseFault(`error: parse ${num}`);
      });
      if (chunk !== null) chunks.push(chunk);
      if (chunks.length === 0 && !moveSeen) throw new ParseFault(`error: parse ${sec.headLine}`);
      edits.push(v4aUpdateEdit(sec.path, moveTo, chunks, strict));
    }
  }
  if (edits.length === 0) throw new ParseFault('error: parse 1');
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): EditFn {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) !== null) throw new EditFault('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): EditFn {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) === null) throw new EditFault('missing', path);
    tree.now.set(path, null);
  };
}

/** The first line at or after `from` equal to a single line, at the first
 *  tier where one is; -1 when there is none. */
function findSingleLine(lines: string[], want: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let j = from; j < lines.length; j++) {
      if (linesEqualAt(lines[j] as string, want, t)) return j;
    }
  }
  return -1;
}

function applyV4aChunk(
  doc: Doc,
  chunk: V4aChunk,
  cursor: number,
  strict: boolean,
  path: string,
): { doc: Doc; cursor: number } {
  const lines = doc.lines;
  let cur = cursor;
  if (chunk.anchor !== null) {
    const at = findSingleLine(lines, chunk.anchor, cur, strict);
    if (at === -1) throw new EditFault('no-match', path);
    cur = at + 1;
  }
  const oldLines: string[] = [];
  const items: Array<{ text: string; ctxPos: number | null }> = [];
  let oPos = 0;
  for (const b of chunk.body) {
    if (b.kind === 'ctx') {
      oldLines.push(b.text);
      items.push({ text: b.text, ctxPos: oPos });
      oPos += 1;
    } else if (b.kind === 'del') {
      oldLines.push(b.text);
      oPos += 1;
    } else if (b.kind === 'add') {
      items.push({ text: b.text, ctxPos: null });
    }
  }
  if (oldLines.length === 0) {
    const idx = chunk.eof ? lines.length : cur;
    const inserted = items.map((it) => it.text);
    const out = [...lines.slice(0, idx), ...inserted, ...lines.slice(idx)];
    return { doc: { lines: out, br: doc.br, final: doc.final }, cursor: idx + inserted.length };
  }
  const tiers = strict ? [0] : [0, 1, 2];
  let found: { tier: number; pos: number } | null = null;
  for (const t of tiers) {
    for (let i = cur; i + oldLines.length <= lines.length; i++) {
      if (chunk.eof && i + oldLines.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (!linesEqualAt(lines[i + j] as string, oldLines[j] as string, t)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        found = { tier: t, pos: i };
        break;
      }
    }
    if (found !== null) break;
  }
  if (found === null) throw new EditFault('no-match', path);
  const nLines = replacementLines(lines, found.pos, items, found.tier, oldLines[0] as string);
  const out = [...lines.slice(0, found.pos), ...nLines, ...lines.slice(found.pos + oldLines.length)];
  return { doc: { lines: out, br: doc.br, final: doc.final }, cursor: found.pos + nLines.length };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): EditFn {
  return (tree, notes) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFault('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new EditFault('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
    let doc = parseDoc(cur);
    let cursor = 0;
    for (const ch of chunks) {
      const r = applyV4aChunk(doc, ch, cursor, strict, path);
      doc = r.doc;
      cursor = r.cursor;
    }
    const out = renderDoc(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      notes.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Running the CLI (SPEC.md sections 1, 2 and 10)                      */
/* ------------------------------------------------------------------ */

interface RunResult {
  code: number;
  out: string[];
}

function usageResult(): RunResult {
  return { code: 2, out: ['error: usage'] };
}

function parsePatch(kind: string, text: string, lines: string[], strict: boolean): EditFn[] {
  if (kind === 'unified') return parseUnified(lines, strict);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  if (kind === 'v4a') return parseV4a(lines, strict);
  return parseJsonEdits(text, lines);
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function run(args: string[]): RunResult {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return usageResult();
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return usageResult();
        format = v;
      } else if (a === '--check') {
        if (check) return usageResult();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usageResult();
        strict = true;
      } else {
        return usageResult();
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usageResult();
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    edits = parsePatch(kind, text, lines, strict);
    if (edits.length === 0) throw new ParseFault('error: parse 1');
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const notes: RunNotes = { moves: [] };
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const movesLen = notes.moves.length;
    try {
      edit(tree, notes);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      notes.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of notes.moves) {
    if (
      tree.original(oldP) !== null &&
      tree.original(newP) === null &&
      tree.get(oldP) === null &&
      tree.get(newP) !== null
    ) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was === now) continue;
    changed.push(p);
    if (covered.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  if (!check) {
    for (const p of [...changed].sort(byteCompare)) {
      const now = tree.now.get(p) as string | null;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
