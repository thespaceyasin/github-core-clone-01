// Git smart HTTP (/{owner}/{repo}.git/*) written from scratch on the standard library:
// the object store, packfiles and the upload-pack v2 / receive-pack v0 exchanges.
//
// The shapes here follow the suite's own git client, which is the only reader:
//  - v0 advertisements carry capabilities after a NUL on the first ref line, including
//    `symref=HEAD:refs/heads/<default>` so a clone learns the default branch.
//  - v2 advertisements open with `version 2` and list `ls-refs`, `fetch`, `server-option`,
//    `object-format=sha1`.
//  - v2 fetch answers in sections (`acknowledgments`, `shallow-info`, `packfile`) with the
//    packfile framed as sideband-64k packets; v0 fetch answers NAK/shallow lines followed by
//    the same sideband pack.
//  - receive-pack is v0 only and answers a report-status stream inside sideband band 1.
//  - A push is fast-forward only: a non-fast-forward update is refused per ref with
//    `ng <ref> non-fast-forward` and the ref is left unmoved.
//  - Repositories are never created by a push; a missing repository is a 404 on info/refs.

import {
  collectReachable,
  decodePktLines,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  pktLines,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

export interface GitResponse {
  status: number;
  headers?: Record<string, string>;
  body: Buffer | string;
}

function jsonError(status: number, message: string): GitResponse {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) };
}

const AGENT = 'github-core-clone/1.0.0';

// Capabilities the v0 upload-pack advertisement carries. `side-band-64k` is the one the
// suite's client requires before it will frame a fetch at all; `shallow` is required
// before it will send `deepen`.
const UPLOAD_PACK_CAPS = [
  'multi_ack',
  'multi_ack_detailed',
  'thin-pack',
  'side-band',
  'side-band-64k',
  'ofs-delta',
  'shallow',
  'deepen-since',
  'deepen-not',
  'deepen-relative',
  'no-progress',
  'include-tag',
  'allow-tip-sha1-in-want',
  'allow-reachable-sha1-in-want',
  'no-done',
  'filter',
  `agent=${AGENT}`,
].join(' ');

const RECEIVE_PACK_CAPS = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`].join(' ');

interface RefLine {
  oid: string;
  name: string;
}

/** Every ref the server advertises, HEAD first, then branches and tags sorted by name. */
function advertisedRefs(repo: Repo): RefLine[] {
  const refs: RefLine[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip) refs.push({ oid: defaultTip, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) refs.push({ oid: repo.refs.get(name)!, name });
  return refs;
}

/** The symref capability value for this repository's HEAD. */
function symrefCap(repo: Repo): string {
  return `symref=HEAD:refs/heads/${repo.defaultBranch}`;
}

/** A v0 advertisement body: service preamble, ref lines (capabilities on the first), flush. */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo, caps: string): Buffer {
  const refs = advertisedRefs(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  const allCaps = `${symrefCap(repo)} ${caps}`;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${allCaps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${allCaps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
    });
    // Peeled lines for annotated tags (a tag object peels to its target commit).
    for (const ref of refs) {
      if (!ref.name.startsWith('refs/tags/')) continue;
      const object = repo.objects.get(ref.oid);
      if (!object || object.type !== 'tag') continue;
      parts.push(pktLine(`${parseTag(object.data).object} ${ref.name}^{}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** A v2 capability advertisement: `version 2`, capability lines, flush. No service header. */
function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'server-option\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

/** The v2 capability advertisement never changes; build it once, not per clone. */
const V2_ADVERTISEMENT = v2Advertisement();

/**
 * Per-repository caches for the two repeated upload-pack answers. A fetch pack
 * depends only on the request (wants, haves, depth, shallow boundaries) and the
 * content-addressed object graph — objects are immutable and only ever appended —
 * so the same request always yields the same pack bytes. An ls-refs answer
 * additionally depends on the current refs, so its key carries a refs fingerprint.
 * Entries are capped; the map is cleared wholesale past the cap.
 */
const fetchCache = new WeakMap<Repo, Map<string, Buffer>>();
const lsRefsCache = new WeakMap<Repo, Map<string, Buffer>>();
const FETCH_CACHE_CAP = 64;

function cacheGet(cache: WeakMap<Repo, Map<string, Buffer>>, repo: Repo, key: string): Buffer | undefined {
  return cache.get(repo)?.get(key);
}

function cachePut(cache: WeakMap<Repo, Map<string, Buffer>>, repo: Repo, key: string, value: Buffer): void {
  let map = cache.get(repo);
  if (!map) {
    map = new Map();
    cache.set(repo, map);
  }
  if (map.size >= FETCH_CACHE_CAP) map.clear();
  map.set(key, value);
}

/** Split a packfile into sideband-64k data packets (band 1), each carrying at most 65515 bytes. */
function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

// ---------------------------------------------------------------------------------------------
// fetch: which objects to send
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  depth?: number;
  shallowBoundaries: string[];
}

/**
 * The objects the client already holds, from its `haves`: the reachable closure, except
 * that a shallow boundary's parents are NOT held — a shallow clone has the boundary
 * commit and its tree, but nothing above it. That is what makes a `deepen` fetch work:
 * the parent of a boundary is new to the client even though it is reachable from a have.
 */
function heldClosure(repo: Repo, haves: readonly string[], shallowBoundaries: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  const queue = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const reachable of collectReachable(repo, [commit.tree])) held.add(reachable);
      if (!shallowBoundaries.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    }
  }
  return held;
}

/**
 * The objects a fetch must send for `wants` (plus, when `depth` is set, the shallow
 * boundary commits). A full fetch sends the whole reachable closure; a depth-limited one
 * sends only the commits within `depth` levels of the wants, with their trees and blobs.
 * In both cases the pack is thin: anything the client already holds is left out, so an
 * incremental fetch sends only the new objects and a fetch with everything already held
 * sends an empty pack. `unshallow` names the old boundaries whose parent this fetch
 * delivered — they stop being shallow.
 */
function fetchObjects(
  repo: Repo,
  request: FetchRequest,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const held = heldClosure(repo, request.haves, new Set(request.shallowBoundaries));
  if (request.depth === undefined) {
    const oids = collectReachable(repo, request.wants);
    const objects: GitObject[] = [];
    for (const oid of oids) {
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object) objects.push(object);
    }
    return { objects, shallow: [], unshallow: [] };
  }
  const depth = Math.max(1, request.depth);
  const included = new Set<string>();
  const shallow: string[] = [];
  // Breadth-first over commits, level by level.
  let level = request.wants.filter((oid) => repo.objects.get(oid)?.type === 'commit');
  const seenCommits = new Set<string>();
  for (let current = 0; current < depth && level.length > 0; current += 1) {
    const next: string[] = [];
    for (const oid of level) {
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      included.add(oid);
      if (current === depth - 1) shallow.push(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) next.push(parent);
    }
    level = next;
  }
  // Every included commit's tree and blobs.
  for (const oid of [...included]) {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const tree = parseCommit(object.data).tree;
    for (const reachable of collectReachable(repo, [tree])) included.add(reachable);
  }
  const objects: GitObject[] = [];
  for (const oid of included) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  // An old boundary stops being shallow when this fetch delivered its parent.
  const unshallow: string[] = [];
  for (const boundary of request.shallowBoundaries) {
    if (!included.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (!object || object.type !== 'commit') continue;
    if (parseCommit(object.data).parents.some((parent) => included.has(parent))) unshallow.push(boundary);
  }
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

function parseV2Fetch(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  const request: FetchRequest = { wants: [], haves: [], shallowBoundaries: [] };
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue; // command= / agent= / object-format= lines
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') break;
  }
  return request;
}

function parseV0Fetch(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  const request: FetchRequest = { wants: [], haves: [], shallowBoundaries: [] };
  let section = 0; // 0 = wants, 1 = haves (after the first flush)
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section = 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const first = line.slice(5).split(' ')[0]!;
        request.wants.push(first);
      } else if (line.startsWith('shallow ')) request.shallowBoundaries.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7).trim(), 10);
    } else {
      if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      else if (line === 'done') break;
    }
  }
  return request;
}

/** A v2 fetch answer: acknowledgments, optional shallow-info, then the sideband packfile. */
function v2FetchResponse(repo: Repo, request: FetchRequest): Buffer {
  const { objects, shallow, unshallow } = fetchObjects(repo, request);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), Buffer.from('0001', 'ascii'));
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** A v0 fetch answer: NAK, shallow/unshallow lines, then the sideband pack. */
function v0FetchResponse(repo: Repo, request: FetchRequest): Buffer {
  const { objects, shallow, unshallow } = fetchObjects(repo, request);
  const pack = writePack(objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function handleUploadPack(repo: Repo, body: Buffer, protocolVersion: string | undefined): GitResponse {
  // protocolVersion is the raw Git-Protocol header value, e.g. 'version=2'.
  const isV2 = protocolVersion === 'version=2';
  let request: FetchRequest;
  try {
    request = isV2 ? parseV2Fetch(body) : parseV0Fetch(body);
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : 'Malformed pkt-line stream');
  }
  // A want the server does not have is a protocol error, not a crash.
  for (const want of request.wants) {
    if (!isObjectId(want) || !repo.objects.has(want)) {
      return jsonError(400, `want ${want} is not known`);
    }
  }
  const response = (() => {
    const cacheKey = `${isV2 ? '2' : '0'}|${request.wants.join(',')}|${request.haves.join(',')}|${request.depth ?? ''}|${request.shallowBoundaries.join(',')}`;
    const cached = cacheGet(fetchCache, repo, cacheKey);
    if (cached) return cached;
    const built = isV2 ? v2FetchResponse(repo, request) : v0FetchResponse(repo, request);
    cachePut(fetchCache, repo, cacheKey, built);
    return built;
  })();
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    body: response,
  };
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

function handleLsRefs(repo: Repo, body: Buffer): GitResponse {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  try {
    const packets = decodePktLines(body);
    let afterDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (packet.kind !== 'data' || !afterDelim) continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : 'Malformed pkt-line stream');
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  // The answer depends on the refs and the requested options; identical clones
  // repeat the same ls-refs, so cache it under a fingerprint of both.
  const refsKey = [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, oid]) => `${name}=${oid}`)
    .join(';');
  const cacheKey = `${refsKey}|${peel}|${symrefs}|${unborn}|${prefixes.join(',')}`;
  const cached = cacheGet(lsRefsCache, repo, cacheKey);
  if (cached) {
    return {
      status: 200,
      headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
      body: cached,
    };
  }
  const parts: Buffer[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip && keep('HEAD')) {
    const extra = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    parts.push(pktLine(`${defaultTip} HEAD${extra}\n`));
  }
  if (!defaultTip && unborn && keep('HEAD')) {
    const extra = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    parts.push(pktLine(`unborn HEAD${extra}\n`));
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    let extra = '';
    if (peel) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') extra += ` peeled:${parseTag(object.data).object}`;
    }
    parts.push(pktLine(`${oid} ${name}${extra}\n`));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  const responseBody = Buffer.concat(parts);
  cachePut(lsRefsCache, repo, cacheKey, responseBody);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    body: responseBody,
  };
}

// ---------------------------------------------------------------------------------------------
// receive-pack (v0)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Parse pkt-lines from the front of `body` until the first flush, and return the commands
 * plus the offset just past that flush — where the raw pack begins. The pack bytes that
 * follow are not pkt-lines, so a whole-body decode would (wrongly) reject them.
 */
function parsePushCommands(body: Buffer): { commands: PushCommand[]; packOffset: number } {
  const commands: PushCommand[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) return { commands, packOffset: offset + 4 };
    if (length === 1 || length === 2 || length === 3 || length > 65520 || offset + length > body.length) {
      throw new Error(`invalid pkt-line length ${length}`);
    }
    const payload = body.subarray(offset + 4, offset + length);
    const text = payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const commandText = nul >= 0 ? text.slice(0, nul) : text;
    const [oldOid, newOid, ref] = commandText.split(' ');
    if (!oldOid || !newOid || !ref || !isObjectId(oldOid) || !isObjectId(newOid)) {
      throw new Error(`bad push command ${JSON.stringify(commandText)}`);
    }
    commands.push({ oldOid, newOid, ref });
    offset += length;
  }
  throw new Error('push command list has no terminating flush');
}

function handleReceivePack(repo: Repo, body: Buffer): GitResponse {
  let commands: PushCommand[] = [];
  let packOffset = 0;
  try {
    const parsed = parsePushCommands(body);
    commands = parsed.commands;
    packOffset = parsed.packOffset;
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : 'Malformed pkt-line stream');
  }
  if (commands.length === 0) {
    return jsonError(400, 'receive-pack needs at least one command');
  }

  // Unpack first: the new objects must exist before any ref may point at them.
  const packBytes = body.subarray(packOffset);
  const report: string[] = [];
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, repo.objects);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch {
      report.push('unpack error');
      for (const command of commands) {
        report.push(`ng ${command.ref} unpacker error`);
      }
      return receivePackReport(report);
    }
  } else if (commands.some((command) => command.newOid !== ZERO_OID)) {
    // A create/update command list without a pack is an unpacker error (real git agrees).
    report.push('unpack error');
    for (const command of commands) {
      report.push(command.newOid === ZERO_OID ? `ok ${command.ref}` : `ng ${command.ref} unpacker error`);
    }
    return receivePackReport(report);
  }

  report.push('unpack ok');
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (!current) {
        report.push(`ng ${command.ref} remote ref does not exist`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        report.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      report.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        report.push(`ng ${command.ref} already exists`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        report.push(`ok ${command.ref}`);
      }
      continue;
    }
    // Update: the old value must match, and the new tip must descend from it.
    if (current === undefined) {
      report.push(`ng ${command.ref} remote ref does not exist`);
    } else if (command.oldOid !== current) {
      report.push(`ng ${command.ref} non-fast-forward`);
    } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
      report.push(`ng ${command.ref} non-fast-forward`);
    } else {
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}`);
    }
  }
  return receivePackReport(report);
}

/** The report-status stream, pkt-framed inside one sideband band-1 packet, then a flush. */
function receivePackReport(lines: string[]): GitResponse {
  const inner = pktLines([...lines.map((line) => `${line}\n`), 'flush']);
  const outer = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), Buffer.from('0000', 'ascii')]);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-receive-pack-result' },
    body: outer,
  };
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

export interface GitRequest {
  method: string;
  /** Decoded path segments after the leading slash. */
  segments: string[];
  query: URLSearchParams;
  /** Raw request body (for POSTs). */
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export function handleGit(request: GitRequest, store: Store): GitResponse | null {
  const { method, segments, query, body, headers } = request;
  // /{owner}/{repo}.git/...
  if (segments.length < 2 || !segments[1]!.endsWith('.git')) return null;
  const owner = segments[0]!;
  const repoName = segments[1]!.slice(0, -4);
  const repo = store.getRepo(owner, repoName);
  const tail = segments.slice(2);

  if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return jsonError(400, 'service is required');
    if (!repo) return jsonError(404, 'Not Found');
    const protocol = typeof headers['git-protocol'] === 'string' ? headers['git-protocol'] : undefined;
    if (service === 'git-upload-pack' && protocol === 'version=2') {
      return { status: 200, headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' }, body: V2_ADVERTISEMENT };
    }
    const caps = service === 'git-upload-pack' ? UPLOAD_PACK_CAPS : RECEIVE_PACK_CAPS;
    return {
      status: 200,
      headers: { 'Content-Type': `application/x-${service}-advertisement` },
      body: v0Advertisement(service, repo, caps),
    };
  }

  if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
    if (!repo) return jsonError(404, 'Not Found');
    const protocol = typeof headers['git-protocol'] === 'string' ? headers['git-protocol'] : undefined;
    // A v2 ls-refs command arrives on the same endpoint: `command=ls-refs`.
    if (protocol === 'version=2') {
      try {
        const packets = decodePktLines(body);
        const first = packets.find((packet) => packet.kind === 'data');
        const command = first?.kind === 'data' ? first.payload.toString('utf8').replace(/\n$/, '') : '';
        if (command === 'command=ls-refs') return handleLsRefs(repo, body);
      } catch {
        return jsonError(400, 'Malformed pkt-line stream');
      }
    }
    return handleUploadPack(repo, body, protocol);
  }

  if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
    if (!repo) return jsonError(404, 'Not Found');
    return handleReceivePack(repo, body);
  }

  return null;
}
