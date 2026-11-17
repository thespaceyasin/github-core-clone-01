// The forge's whole store: repositories, git objects, refs, issues, pull requests,
// labels and comments — everything in memory, nothing on disk, nothing clocked.
//
// Determinism rule: no wall-clock time and no unseeded randomness ever enters stored
// state. Commit timestamps derive from a fixed epoch plus a per-repository counter, so
// the same requests in the same order always build the same objects, and a replayed
// trial exports byte-identical state.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflate, deflateSync as zlibDeflate } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
/** Fixed epoch (2025-01-01T00:00:00Z) every server-made commit timestamp derives from. */
export const COMMIT_EPOCH = 1735689600;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  mergeBase: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Comment {
  id: number;
  issueNumber: number;
  body: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  /** git object store: oid -> object. */
  objects: Map<string, GitObject>;
  /** refs/heads/* and refs/tags/* -> tip oid. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  comments: Comment[];
  /** Next shared issue/PR number. */
  nextNumber: number;
  /** Counts server-made commits, for deterministic commit timestamps. */
  commitSeq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextRepoSeq = 1;
  private nextItemId = 10000;
  private nextCommentId = 1;

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      seq: this.nextRepoSeq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: [],
      nextNumber: 1,
      commitSeq: 0,
    };
    this.nextRepoId += 1;
    this.nextRepoSeq += 1;
    this.repos.set(`${owner}/${name}`, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  nextItemIdValue(): number {
    const id = this.nextItemId;
    this.nextItemId += 1;
    return id;
  }

  nextCommentIdValue(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  /** A deterministic timestamp for the next server-made commit in this repository. */
  nextCommitTimestamp(repo: Repo): number {
    const stamp = COMMIT_EPOCH + repo.commitSeq;
    repo.commitSeq += 1;
    return stamp;
  }
}

// ---------------------------------------------------------------------------------------------
// object ids and object parsing
// ---------------------------------------------------------------------------------------------

const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry is truncated');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  author?: string;
  committer?: string;
  timestamp: number;
  message: string;
}): Buffer {
  const who = `${fields.author ?? VIEWER_IDENTITY} ${fields.timestamp} +0000`;
  const committer = `${fields.committer ?? VIEWER_IDENTITY} ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export function parseCommit(data: Uint8Array): CommitView {
  const text = (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Uint8Array): TagView {
  const text = (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Every object reachable from `roots` (commits, tags, trees, blobs). */
export function collectReachable(
  repo: Repo,
  roots: Iterable<string>,
  options: { stopAt?: ReadonlySet<string> } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (options.stopAt?.has(oid)) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or they are equal). */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return false;
}

/** The nearest common ancestor of two commits (linear histories: the exact merge-base). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, depth] = queueA.shift()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.set(oid, depth);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push([parent, depth + 1]);
  }
  const queueB: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>();
  let best: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  while (queueB.length > 0) {
    const [oid, depth] = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const depthA = ancestorsA.get(oid);
    if (depthA !== undefined) {
      const total = depthA + depth;
      if (total < bestDepth) {
        best = oid;
        bestDepth = total;
      }
    }
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push([parent, depth + 1]);
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// flat tree views: path -> blob oid, for merges and diffs
// ---------------------------------------------------------------------------------------------

export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, entry.oid);
  }
  return out;
}

/** Build (and store) the tree objects for a flat path -> blob map; returns the root tree oid. */
export function treeFromFlat(repo: Repo, flat: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of [...flat.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The blob oid at `path` in the tree `treeOid`, or null when absent. */
export function blobAtPath(repo: Repo, treeOid: string, path: string): string | null {
  const segments = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The tree oid of the directory `path` in `treeOid`, or null when it is not a directory. */
export function treeAtPath(repo: Repo, treeOid: string, path: string): string | null {
  if (path === '' || path === '/') return treeOid;
  const segments = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return current;
}

/** Three-way merge of flat file maps. Returns the merged map and whether it conflicts. */
export function threeWayMerge(
  base: ReadonlyMap<string, string>,
  head: ReadonlyMap<string, string>,
  tip: ReadonlyMap<string, string>,
): { merged: Map<string, string>; conflict: boolean } {
  const merged = new Map<string, string>();
  let conflict = false;
  const paths = new Set<string>([...base.keys(), ...head.keys(), ...tip.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const t = tip.get(path);
    if (h === b) {
      if (t !== undefined) merged.set(path, t);
    } else if (t === b) {
      if (h !== undefined) merged.set(path, h);
    } else if (h === t) {
      if (h !== undefined) merged.set(path, h);
    } else {
      conflict = true;
    }
  }
  return { merged, conflict };
}

/** One file's line diff between two blobs (or null when unchanged). */
export function diffLines(
  oldData: Buffer | null,
  newData: Buffer | null,
): { status: 'added' | 'modified' | 'removed'; additions: number; deletions: number } | null {
  if (oldData === null && newData === null) return null;
  if (oldData !== null && newData !== null && oldData.equals(newData)) return null;
  if (oldData === null) {
    return { status: 'added', additions: countLines(newData!), deletions: 0 };
  }
  if (newData === null) {
    return { status: 'removed', additions: 0, deletions: countLines(oldData) };
  }
  const oldLines = splitLines(oldData);
  const newLines = splitLines(newData);
  const { added, removed } = lcsDiff(oldLines, newLines);
  return { status: 'modified', additions: added, deletions: removed };
}

function countLines(data: Buffer): number {
  const text = data.toString('utf8');
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function splitLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** LCS-based line diff counts (small files only; the suite's files are tiny). */
function lcsDiff(oldLines: readonly string[], newLines: readonly string[]): { added: number; removed: number } {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      removed += 1;
      i += 1;
    } else {
      added += 1;
      j += 1;
    }
  }
  removed += m - i;
  added += n - j;
  return { added, removed };
}

// ---------------------------------------------------------------------------------------------
// packfiles (plain objects only on write; read handles deltas too)
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain objects (no deltas). */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(zlibDeflate(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let byte = buffer[offset]!;
  let value = byte & 0x7f;
  let next = offset + 1;
  while (byte & 0x80) {
    byte = buffer[next]!;
    next += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { value, next };
}

function readSizeVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset]!;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

/** Apply a git delta to its base bytes (the standard copy/insert op stream). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readDeltaVarint = (): number => {
    let byte = delta[offset]!;
    offset += 1;
    let value = byte & 0x7f;
    while (byte & 0x80) {
      byte = delta[offset]!;
      offset += 1;
      value = (value << 7) + (byte & 0x7f);
    }
    return value;
  };
  const sourceSize = readDeltaVarint();
  const targetSize = readDeltaVarint();
  if (sourceSize !== base.length) throw new Error('delta base size does not match');
  const parts: Buffer[] = [];
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset]! << (bit * 8);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset]! << (bit * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      written += op;
    } else {
      throw new Error('delta op 0x00 is invalid');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || written !== targetSize) throw new Error('delta result size does not match');
  return out;
}

/**
 * Parse a packfile into objects (plain entries and OFS/REF deltas alike). Throws on any
 * structural problem; the caller reports that as an unpack failure. `external` lets a
 * REF_DELTA name a base that already lives in the repository rather than in this pack.
 */
export function readPack(pack: Buffer, external?: ReadonlyMap<string, GitObject>): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is shorter than its trailer');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum does not match');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readSizeVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readVarint(pack, offset);
      offset = base.next;
      if (base.value <= 0 || base.value > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - base.value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const streamLength = zlibStreamLength(pack, offset, trailerStart, header.size);
    const inflated = zlibInflate(pack.subarray(offset, offset + streamLength));
    if (inflated.length !== header.size) throw new Error('pack entry inflated size does not match its header');
    entry.data = inflated;
    offset = offset + streamLength;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      // A REF_DELTA base may live in this pack (resolved in the first pass) or already in
      // the repository; it cannot be looked up by offset, so resolve it from either map.
      const inPack = [...resolved.values()].find((candidate) => candidate.oid === entry.baseOid);
      const outside = entry.baseOid ? external?.get(entry.baseOid) : undefined;
      if (inPack) {
        type = inPack.type;
        data = applyDelta(inPack.data, entry.data);
      } else if (outside) {
        type = outside.type;
        data = applyDelta(outside.data, entry.data);
      } else {
        throw new Error('ref-delta base is neither in the pack nor in the repository');
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const result = { type, data, oid };
    resolved.set(entry.offset, result);
    resolving.delete(entry.offset);
    return result;
  };
  // First pass: plain entries and OFS deltas (their bases are found by offset, in any order).
  // Second pass: REF deltas, whose bases are found by oid once the first pass is complete.
  for (const entry of raw) {
    if (entry.typeCode === 7) continue;
    const result = resolve(entry);
    if (!objects.has(result.oid)) objects.set(result.oid, { type: result.type, data: result.data });
  }
  for (const entry of raw) {
    if (entry.typeCode !== 7) continue;
    const result = resolve(entry);
    if (!objects.has(result.oid)) objects.set(result.oid, { type: result.type, data: result.data });
  }
  return objects;
}

/**
 * Length in bytes of the zlib stream starting at `offset` (streams are self-terminating).
 * inflateSync throws on a truncated stream and ignores trailing bytes, so "inflates
 * without error" is monotone in the end position: false below the stream's end, true at
 * and past it. The first guess is the entry's raw size plus slack — a deflate stream is
 * rarely longer than the data it holds — then the window doubles until it works, and a
 * bisection inside the window finds the exact end.
 */
function zlibStreamLength(buffer: Buffer, offset: number, limit: number, hintSize: number): number {
  const works = (end: number): boolean => {
    try {
      zlibInflate(buffer.subarray(offset, end));
      return true;
    } catch {
      return false;
    }
  };
  let low = offset; // an empty input never inflates, so `offset` is a known-failing end
  let high = Math.min(limit, offset + Math.max(32, hintSize + 16));
  if (!works(high)) {
    let size = high - offset;
    let found = false;
    while (high < limit) {
      low = high;
      size *= 2;
      high = Math.min(limit, offset + size);
      if (works(high)) {
        found = true;
        break;
      }
    }
    if (!found) throw new Error('pack entry zlib stream is truncated');
  }
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (works(mid)) high = mid;
    else low = mid + 1;
  }
  return low - offset;
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode a whole buffer of pkt-lines; throws on a malformed header or truncation. */
export function decodePktLines(bytes: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3 || length > 65520) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

// ---------------------------------------------------------------------------------------------
// Relay-style global ids (opaque, stable): base64url of a typed key
// ---------------------------------------------------------------------------------------------

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}
