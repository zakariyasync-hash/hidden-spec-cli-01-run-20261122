// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers (section 5), and writes every change or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ from: string; to: string }> = [];
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
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3) and three-tier matching (section 5)
// ---------------------------------------------------------------------------

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function lineKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions i where O matches the file's lines i, i+1, ... at this tier. */
function occurrences(O: string[], F: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (lineKey(O[j]!, tier) !== lineKey(F[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only when strict) with an occurrence at or after `from`. */
function firstTier(O: string[], F: string[], strict: boolean, from = 0, eof = false): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    let occ = occurrences(O, F, t, from);
    if (eof) occ = occ.filter((i) => i + O.length === F.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** A line of N: a context line (written as the file's own matched line) or a new line. */
type NewLine = { text: string; ctx: number | null };

/** N with context lines taken from the file and the rest re-indented at tier 2 (section 5). */
function buildReplacement(O: string[], N: NewLine[], F: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  let p = '';
  let f = '';
  if (tier === 2 && O.length > 0) {
    p = leadingWs(O[0]!);
    f = leadingWs(F[at]!);
  }
  for (const item of N) {
    if (item.ctx !== null) {
      out.push(F[at + item.ctx]!);
      continue;
    }
    let t = item.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** Plain new lines (no context lines) through the same tier-2 re-indentation. */
function buildNewLines(O: string[], N: string[], F: string[], at: number, tier: number): string[] {
  return buildReplacement(
    O,
    N.map((text) => ({ text, ctx: null })),
    F,
    at,
    tier,
  );
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

type UBodyKind = 'ctx' | 'old' | 'new' | 'bs';
interface UBodyLine {
  kind: UBodyKind;
  text: string;
}

interface UHunk {
  a: number;
  body: UBodyLine[];
  o: string[];
  n: NewLine[];
  noFinal: boolean;
}

type UPath = string | null; // null: /dev/null
interface USection {
  pairOld?: UPath;
  pairNew?: UPath;
  renameFrom?: string;
  renameTo?: string;
  diffOld?: string;
  diffNew?: string;
  create: boolean;
  del: boolean;
  hunks: UHunk[];
}

function diffPath(line: string): UPath {
  const p0 = line.slice(4).split('\t')[0]!.trim();
  if (p0 === '/dev/null') return null;
  if (p0.startsWith('a/') || p0.startsWith('b/')) return p0.slice(2);
  return p0;
}

function deriveHunk(h: UHunk): void {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      const idx = o.length;
      o.push(b.text);
      n.push({ text: b.text, ctx: idx });
    } else if (b.kind === 'old') o.push(b.text);
    else if (b.kind === 'new') n.push({ text: b.text, ctx: null });
  }
  h.o = o;
  h.n = n;
  let noFinal = false;
  for (let k = h.body.length - 1; k >= 0; k--) {
    const b = h.body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') {
      const next = h.body[k + 1];
      noFinal = next !== undefined && next.kind === 'bs';
      break;
    }
  }
  h.noFinal = noFinal;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let curHasPair = false;
  let headerDone = false;
  let body: UBodyLine[] | null = null;
  let bodyHunk: UHunk | null = null;
  const closeBody = (): void => {
    if (body !== null && bodyHunk !== null) {
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') body.pop();
        else break;
      }
      bodyHunk.body = body;
      deriveHunk(bodyHunk);
    }
    body = null;
    bodyHunk = null;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (body !== null) {
      if (l.startsWith('diff --git ')) {
        closeBody();
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeBody();
        continue;
      }
      if (l.startsWith('@@')) {
        closeBody();
        continue;
      }
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
        body.push({
          kind: l === '' ? 'ctx' : l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : l[0] === '+' ? 'new' : 'bs',
          text: l === '' ? '' : l.slice(1),
        });
        i++;
        continue;
      }
      closeBody();
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1]!, diffNew: m[2]!, create: false, del: false, hunks: [] };
      sections.push(cur);
      curHasPair = false;
      headerDone = false;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !headerDone && !curHasPair) {
        cur.pairOld = diffPath(l);
        cur.pairNew = diffPath(lines[i + 1]!);
        curHasPair = true;
        i += 2;
        continue;
      }
      cur = { pairOld: diffPath(l), pairNew: diffPath(lines[i + 1]!), create: false, del: false, hunks: [] };
      sections.push(cur);
      curHasPair = true;
      headerDone = false;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && !headerDone) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const h: UHunk = { a: Number(m[1]!), body: [], o: [], n: [], noFinal: false };
      cur.hunks.push(h);
      headerDone = true;
      body = [];
      bodyHunk = h;
      i++;
      continue;
    }
    if (cur !== null && !headerDone) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
    }
    i++;
  }
  closeBody();
  return sections;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld !== undefined ? sec.diffOld : null;
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew !== undefined ? sec.diffNew : null;
    return (tree: Tree): void => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      const isCreate = oldP === null || sec.create;
      const isDelete = newP === null || sec.del;
      if (isCreate) {
        if (newP === null) throw new Fail('unsafe', '/dev/null');
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const added: string[] = [];
        for (const h of sec.hunks) {
          for (const b of h.body) if (b.kind === 'new') added.push(b.text);
        }
        // A created file ends with a line break unless a `\` line follows its last `+` line.
        let noFinal = false;
        outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const h = sec.hunks[hi]!;
          for (let bi = h.body.length - 1; bi >= 0; bi--) {
            if (h.body[bi]!.kind === 'new') {
              const next = h.body[bi + 1];
              noFinal = next !== undefined && next.kind === 'bs';
              break outer;
            }
          }
        }
        tree.now.set(newP, added.length === 0 ? '' : added.join('\n') + (noFinal ? '' : '\n'));
        return;
      }
      if (isDelete) {
        if (oldP === null) throw new Fail('missing', '/dev/null');
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      // oldP and newP are both non-null here.
      const oldPath = oldP!;
      const newPath = newP!;
      const isMove = oldPath !== newPath;
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const model = parseFile(tree.get(oldPath)!);
      let d = 0;
      for (const h of sec.hunks) {
        const beforeLen = model.lines.length;
        if (h.o.length === 0) {
          const at = Math.min(Math.max(h.a + d, 0), beforeLen);
          const atEnd = at === beforeLen;
          const ins = h.n.map((x) => x.text);
          model.lines.splice(at, 0, ...ins);
          if (atEnd) model.final = !h.noFinal;
        } else {
          const found = firstTier(h.o, model.lines, strict);
          if (!found) throw new Fail('no-match', oldPath);
          const target = h.a - 1 + d;
          let best = found.occ[0]!;
          let bestDist = Math.abs(best - target);
          for (const p of found.occ) {
            const dist = Math.abs(p - target);
            if (dist < bestDist) {
              best = p;
              bestDist = dist;
            }
          }
          const rep = buildReplacement(h.o, h.n, model.lines, best, found.tier);
          const runsToEnd = best + h.o.length === beforeLen;
          model.lines.splice(best, h.o.length, ...rep);
          if (runsToEnd) model.final = !h.noFinal;
        }
        d += h.n.length - h.o.length;
      }
      const text = serializeFile(model);
      if (isMove) {
        tree.now.set(newPath, text);
        tree.now.set(oldPath, null);
        tree.moves.push({ from: oldPath, to: newPath });
      } else {
        tree.now.set(oldPath, text);
      }
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevEnd = end;
    prevPath = path;
    i = end + 1;
  }
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((b) => {
    return (tree: Tree): void => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(b.path);
      if (cur === null) throw new Fail('missing', b.path);
      const model = parseFile(cur);
      const found = firstTier(b.oldLines, model.lines, strict);
      if (!found) throw new Fail('no-match', b.path);
      if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
      const at = found.occ[0]!;
      const rep = buildNewLines(b.oldLines, b.newLines, model.lines, at, found.tier);
      model.lines.splice(at, b.oldLines.length, ...rep);
      tree.now.set(b.path, serializeFile(model));
    };
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

type VBodyKind = 'ctx' | 'old' | 'new';
interface VBodyLine {
  kind: VBodyKind;
  text: string;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewLine[];
}

type VSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; chunks: VChunk[] };

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function finishVChunk(anchor: string | null, eof: boolean, body: VBodyLine[]): VChunk {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const idx = o.length;
      o.push(b.text);
      n.push({ text: b.text, ctx: idx });
    } else if (b.kind === 'old') o.push(b.text);
    else n.push({ text: b.text, ctx: null });
  }
  return { anchor, eof, o, n };
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  const isSectionStart = (l: string): boolean => l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith(V_ADD)) {
      const path = l.slice(V_ADD.length).trim();
      const collected: Array<{ text: string; blankLine: boolean }> = [];
      i++;
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m)) break;
        if (m.startsWith('+')) {
          collected.push({ text: m.slice(1), blankLine: false });
          i++;
          continue;
        }
        if (m === '') {
          collected.push({ text: '', blankLine: true });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (collected.length > 0 && collected[collected.length - 1]!.blankLine) collected.pop();
      sections.push({ kind: 'add', path, lines: collected.map((c) => c.text) });
      continue;
    }
    if (l.startsWith(V_DEL)) {
      sections.push({ kind: 'delete', path: l.slice(V_DEL.length).trim() });
      i++;
      continue;
    }
    if (l.startsWith(V_UPD)) {
      const updLine = i + 1;
      const path = l.slice(V_UPD.length).trim();
      i++;
      let moveTo: string | undefined;
      if (i < last && lines[i]!.startsWith(V_MOVE)) {
        moveTo = lines[i]!.slice(V_MOVE.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; eof: boolean; body: VBodyLine[]; explicit: boolean } | null = null;
      // Only blank lines at the end of the section are dropped (strip=true); blanks before
      // another chunk are part of the chunk they close.
      const pushCur = (strip: boolean): void => {
        if (cur === null) return;
        if (strip) {
          while (cur.body.length > 0) {
            const b = cur.body[cur.body.length - 1]!;
            if (b.kind === 'ctx' && b.text === '') cur.body.pop();
            else break;
          }
        }
        chunks.push(finishVChunk(cur.anchor, cur.eof, cur.body));
        cur = null;
      };
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m)) break;
        if (m === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          pushCur(false);
          i++;
          continue;
        }
        if (m.startsWith('@@')) {
          pushCur(false);
          const anchor = m.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [], explicit: true };
          i++;
          continue;
        }
        if (m.startsWith(' ') || m.startsWith('-') || m.startsWith('+') || m === '') {
          if (cur === null) cur = { anchor: null, eof: false, body: [], explicit: false };
          cur.body.push({
            kind: m === '' ? 'ctx' : m[0] === ' ' ? 'ctx' : m[0] === '-' ? 'old' : 'new',
            text: m === '' ? '' : m.slice(1),
          });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // The last chunk's trailing blank lines are not part of the section.
      if (cur !== null) {
        while (cur.body.length > 0) {
          const b = cur.body[cur.body.length - 1]!;
          if (b.kind === 'ctx' && b.text === '') cur.body.pop();
          else break;
        }
        if (cur.body.length === 0 && !cur.explicit && !cur.eof) cur = null;
        else {
          chunks.push(finishVChunk(cur.anchor, cur.eof, cur.body));
          cur = null;
        }
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${updLine}`);
      sections.push({ kind: 'update', path, moveTo, chunks });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4a(lines).map((sec) => {
    if (sec.kind === 'add') {
      return (tree: Tree): void => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      return (tree: Tree): void => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
      };
    }
    return (tree: Tree): void => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      const cur = tree.get(sec.path);
      if (cur === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      const model = parseFile(cur);
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          let foundAt = -1;
          const max = strict ? 0 : 2;
          for (let t = 0; t <= max && foundAt === -1; t++) {
            for (let k = cursor; k < model.lines.length; k++) {
              if (lineKey(ch.anchor, t) === lineKey(model.lines[k]!, t)) {
                foundAt = k;
                break;
              }
            }
          }
          if (foundAt === -1) throw new Fail('no-match', sec.path);
          cursor = foundAt + 1;
        }
        if (ch.o.length === 0) {
          const at = ch.eof ? model.lines.length : cursor;
          const ins = ch.n.map((x) => x.text);
          model.lines.splice(at, 0, ...ins);
          cursor = at + ins.length;
          continue;
        }
        const found = firstTier(ch.o, model.lines, strict, cursor, ch.eof);
        if (!found) throw new Fail('no-match', sec.path);
        const at = found.occ[0]!;
        const rep = buildReplacement(ch.o, ch.n, model.lines, at, found.tier);
        model.lines.splice(at, ch.o.length, ...rep);
        cursor = at + rep.length;
      }
      const text = serializeFile(model);
      if (sec.moveTo !== undefined) {
        tree.now.set(sec.moveTo, text);
        tree.now.set(sec.path, null);
        tree.moves.push({ from: sec.path, to: sec.moveTo });
      } else {
        tree.now.set(sec.path, text);
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Command line (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  const rows: Array<{ text: string; key: string }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    rows.push({ text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, key: p });
  }
  for (const m of tree.moves) {
    if (tree.original(m.from) !== null && tree.now.get(m.from) === null && tree.original(m.to) === null && tree.now.get(m.to) !== null) {
      const fi = rows.findIndex((r) => r.key === m.from);
      if (fi >= 0) rows.splice(fi, 1);
      const ti = rows.findIndex((r) => r.key === m.to);
      if (ti >= 0) rows.splice(ti, 1);
      rows.push({ text: `R ${m.from} -> ${m.to}`, key: m.to });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of changed) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out };
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
