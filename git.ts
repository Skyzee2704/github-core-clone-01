// git.ts — the git object store: SHA-1 objects, trees, commits, packfiles and
// pkt-lines. Pure logic, no HTTP. Everything here is deterministic: object ids
// come only from content, never from the wall clock or randomness, so two runs
// over the same operations produce byte-identical state.
//
// Object model (the git standard, reimplemented from the protocol):
//   blob   "<content bytes>"
//   tree   entries "<mode> <name>\0<20-byte sha>", sorted git-style
//   commit "tree <sha>\nparent <sha>\n...author ...\ncommitter ...\n\n<message>"
//   tag    like a commit header block (parsed, rarely produced)

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

/** SHA-1 id of a loose object: sha1("<type> <len>\0<data>"). */
export function sha1Object(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object in the map (idempotent) and return its id. */
export function putObject(objects: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = sha1Object(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000'
  name: string;
  oid: string;
}

/** Parse a raw tree object into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no space after mode');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('malformed tree: no NUL after name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: directories compare as if their name had a trailing '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize entries into a raw tree object (sorted git-style). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits

export interface CommitView {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}

/** Parse a raw commit object. Headers run to the first blank line; the rest is the message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}

export interface BuildCommitFields {
  tree: string;
  parents: readonly string[];
  message: string;
  timestamp: number; // unix seconds (logical clock — deterministic)
  identity: string; // e.g. "ada iversen <adaiversen@example.invalid>"
}

/** Serialize a commit. The message is stored with exactly one trailing newline. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.identity} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.identity} ${fields.timestamp} +0000`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  message: string;
}

/** Parse a raw annotated-tag object. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

// ---------------------------------------------------------------- deltas

function readDeltaVarint(data: Buffer, offset: number): { value: number; next: number } {
  let byte = data[offset] ?? 0;
  let value = byte & 0x7f;
  let next = offset + 1;
  while (byte & 0x80) {
    byte = data[next] ?? 0;
    value = ((value + 1) << 7) | (byte & 0x7f);
    next += 1;
  }
  return { value, next };
}

/**
 * Apply a git delta to a base object. Delta format: varint source size, varint
 * target size, then ops — copy (high bit set: offset/size bytes per flag bits)
 * or insert (low 7 bits = literal length).
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readDeltaVarint(delta, 0);
  if (src.value !== base.length) throw new Error(`delta base size ${src.value} != ${base.length}`);
  const tgt = readDeltaVarint(delta, src.next);
  const out: Buffer[] = [];
  let offset = tgt.next;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          copyOffset |= (delta[offset] ?? 0) << (i * 8);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          copySize |= (delta[offset] ?? 0) << (i * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta op 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== tgt.value) throw new Error(`delta target size ${tgt.value} != ${result.length}`);
  return result;
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPE_NUM: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_ID: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeId = PACK_TYPE_ID[type];
  const bytes: number[] = [];
  let first = (typeId << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas): PACK header + zlib objects + SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Parse a packfile. Full objects (commit/tree/blob/tag) and both delta kinds are
 * resolved; a delta's base may come from earlier in the same pack or from the
 * supplied lookup (objects the reader already holds).
 */
export function readPack(
  pack: Buffer,
  lookup?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // The trailer is SHA-1 over everything before it; reject a corrupt pack early.
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (trailer !== expected) throw new Error('pack trailer checksum mismatch');
  const result = new Map<string, GitObject>();
  // Objects are indexed by pack offset for OFS_DELTA resolution.
  const byOffset = new Map<number, { oid: string; object: GitObject }>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset] ?? 0;
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] ?? 0;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeId === 6) {
      // OFS_DELTA: offset varint (offset+1 based), base lives earlier in this pack.
      const back = readDeltaVarint(pack, offset);
      offset = back.next;
      baseOffset = start - back.value;
    } else if (typeId === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, next } = inflateOne(pack, offset);
    offset = next;
    let object: GitObject;
    if (typeId >= 1 && typeId <= 4) {
      const type = PACK_TYPE_NUM[typeId] as GitObjectType;
      if (data.length !== size) throw new Error(`pack object size ${data.length} != header ${size}`);
      object = { type, data };
    } else if (typeId === 6 || typeId === 7) {
      const base = resolvePackBase(typeId, baseOid, baseOffset, byOffset, lookup, result);
      const dataOut = applyDelta(base.data, data);
      object = { type: base.type, data: dataOut };
    } else {
      throw new Error(`unknown pack object type ${typeId}`);
    }
    const oid = sha1Object(object.type, object.data);
    result.set(oid, object);
    byOffset.set(start, { oid, object });
  }
  return result;
}

function resolvePackBase(
  typeId: number,
  baseOid: string | undefined,
  baseOffset: number | undefined,
  byOffset: Map<number, { oid: string; object: GitObject }>,
  lookup: ((oid: string) => GitObject | undefined) | undefined,
  result: Map<string, GitObject>,
): GitObject {
  if (typeId === 7) {
    const found = result.get(baseOid ?? '') ?? lookup?.(baseOid ?? '');
    if (!found) throw new Error(`ref-delta base ${baseOid} not available`);
    return found;
  }
  const found = byOffset.get(baseOffset ?? -1);
  if (!found) throw new Error(`ofs-delta base at offset ${baseOffset} not available`);
  return found.object;
}

/** Inflate exactly one zlib stream starting at `offset`; return its bytes and the next offset. */
function inflateOne(pack: Buffer, offset: number): { data: Buffer; next: number } {
  // inflateSync stops at the end of the first zlib stream and ignores the
  // trailing bytes, so one call yields the object. Its consumed length is
  // recovered without a search: deflateSync is deterministic for the same
  // input and level, so re-deflating the object reproduces the exact bytes
  // the client wrote; the match is verified, and a mismatch falls back to
  // the binary search below (which never depends on that assumption).
  const data = inflateSync(pack.subarray(offset, pack.length - 20));
  const deflated = deflateSync(data);
  const end = offset + deflated.length;
  if (end <= pack.length - 20 && pack.subarray(offset, end).equals(deflated)) {
    return { data, next: end };
  }
  // Fallback: the stream's true end is the smallest end position that
  // inflates cleanly — found by binary search.
  let low = offset + 2;
  let high = pack.length - 20; // leave room for the trailer
  let found: Buffer | null = null;
  let foundEnd = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      const out = inflateSync(pack.subarray(offset, mid));
      found = out;
      foundEnd = mid;
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  if (found === null || foundEnd < 0) throw new Error('pack object deflate stream is truncated');
  return { data: found, next: foundEnd };
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 hex length digits (including the 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/**
 * Parse pkt-lines from the start of `buf` until the first flush (or the end).
 * Returns the packets and the offset where the pkt-line section ended — the
 * bytes after that offset are raw payload (e.g. a packfile).
 */
export function parsePktLines(buf: Buffer): { packets: PktPacket[]; restOffset: number } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    if (lenHex === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, restOffset: offset + 4 };
    }
    if (lenHex === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, restOffset: offset };
}

// ---------------------------------------------------------------- reachability

/** All objects reachable from `tips` (commits -> parents + trees -> blobs; tags -> target). */
export function collectReachable(objects: Map<string, GitObject>, tips: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...tips];
  const ordered: string[] = [];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    ordered.push(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree) queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      const text = object.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match) queue.push(match[1] as string);
    }
  }
  return ordered;
}

/** Walk a commit's parents (depth-first, tip first, deduped). */
export function walkCommits(objects: Map<string, GitObject>, tip: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') return;
    seen.add(oid);
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) visit(parent);
  };
  visit(tip);
  return out;
}

/**
 * Whether `ancestor` is reachable from `descendant` by following parents.
 * Stops at the first hit (unlike walkCommits, which lists the whole history),
 * so a fast-forward check on a long linear chain is one parent lookup instead
 * of a full-history walk: the push workload's 200-commit chain made every
 * push re-walk all of history (O(n^2) over the run).
 */
export function isAncestor(objects: Map<string, GitObject>, descendant: string, ancestor: string): boolean {
  if (descendant === ancestor) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/**
 * Depth-limited reachability for shallow fetches: include commits less than
 * `depth` generations from the wants, with their whole trees, but not the
 * parents of the deepest included commits. `boundary` is the shallow line:
 * the deepest included commits (distance depth-1), whose parents are cut.
 */
export function collectShallow(
  objects: Map<string, GitObject>,
  wants: readonly string[],
  depth: number,
): { oids: string[]; boundary: string[] } {
  const included = new Set<string>();
  const boundary: string[] = [];
  const seenCommit = new Set<string>();
  const queue: Array<{ oid: string; distance: number }> = wants.map((oid) => ({ oid, distance: 0 }));
  while (queue.length > 0) {
    const current = queue.shift() as { oid: string; distance: number };
    if (seenCommit.has(current.oid)) continue;
    const object = objects.get(current.oid);
    if (!object) continue;
    if (object.type !== 'commit') {
      included.add(current.oid);
      continue;
    }
    seenCommit.add(current.oid);
    if (current.distance >= depth) continue;
    included.add(current.oid);
    const commit = parseCommit(object.data);
    for (const treeOid of collectReachable(objects, [commit.tree])) included.add(treeOid);
    if (current.distance === depth - 1) {
      boundary.push(current.oid);
    } else {
      for (const parent of commit.parents) queue.push({ oid: parent, distance: current.distance + 1 });
    }
  }
  return { oids: [...included], boundary };
}

/** Peel an annotated tag (recursively) to the commit it names, or null. */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const object = objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * The objects a fetching client already holds, from its `have` lines and its
 * shallow boundaries: traverse from the haves, but never descend into the
 * parents of a boundary commit (a shallow clone holds the boundary commit
 * and its tree, not its history). This is the set a fetch must NOT re-send.
 */
export function collectHeld(
  objects: Map<string, GitObject>,
  tips: readonly string[],
  boundaries: ReadonlySet<string>,
): string[] {
  const included = new Set<string>();
  const seen = new Set<string>();
  const queue = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    included.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const treeOid of collectReachable(objects, [commit.tree])) included.add(treeOid);
      if (!boundaries.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return [...included];
}

// ---------------------------------------------------------------- tree paths

/** The entry (blob or tree) at `segments` under `rootTreeOid`, or null. */
export function getEntryAtPath(
  objects: Map<string, GitObject>,
  rootTreeOid: string | null,
  segments: readonly string[],
): TreeEntry | null {
  if (rootTreeOid === null) return null;
  let currentOid = rootTreeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = objects.get(currentOid);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    currentOid = entry.oid;
  }
  return null;
}

/** The entries of the directory at `segments` (empty segments = root), or null when it is not a dir. */
export function listDirAtPath(
  objects: Map<string, GitObject>,
  rootTreeOid: string | null,
  segments: readonly string[],
): TreeEntry[] | null {
  if (rootTreeOid === null) return segments.length === 0 ? [] : null;
  if (segments.length === 0) {
    const object = objects.get(rootTreeOid);
    if (!object || object.type !== 'tree') return null;
    return parseTree(object.data);
  }
  const entry = getEntryAtPath(objects, rootTreeOid, segments);
  if (!entry || entry.mode !== '40000') return null;
  const object = objects.get(entry.oid);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data);
}

function setPathRecursive(
  objects: Map<string, GitObject>,
  treeOid: string | null,
  segments: readonly string[],
  blobOid: string | null,
  mode: string,
): string | null {
  const entries = treeOid === null ? [] : parseTree(objects.get(treeOid)?.data ?? Buffer.alloc(0));
  const [head, ...rest] = segments as [string, ...string[]];
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    const existing = entries.find((entry) => entry.name === head);
    if (existing !== undefined && existing.mode === '40000') {
      // A directory at this path: a file cannot replace it, and the file API
      // cannot delete a whole directory.
      throw new Error(`path conflicts with an existing directory: ${head}`);
    }
    if (blobOid !== null) kept.push({ mode, name: head, oid: blobOid });
    // blobOid null = delete the entry; an empty tree is dropped by the caller.
  } else {
    const child = entries.find((entry) => entry.name === head);
    if (child !== undefined && child.mode !== '40000') {
      throw new Error(`path conflicts with an existing file: ${head}`);
    }
    const childTree = child !== undefined && child.mode === '40000' ? child.oid : null;
    const newChild = setPathRecursive(objects, childTree, rest, blobOid, mode);
    if (newChild !== null) kept.push({ mode: '40000', name: head, oid: newChild });
  }
  if (kept.length === 0) return null;
  return putObject(objects, 'tree', buildTree(kept));
}

/**
 * Set (blobOid given) or delete (blobOid null) the file at `segments` in the
 * tree rooted at `rootTreeOid`. Returns the new root tree oid, or null when the
 * tree became empty. Intermediate directories are created as needed.
 */
export function setPathInTree(
  objects: Map<string, GitObject>,
  rootTreeOid: string | null,
  segments: readonly string[],
  blobOid: string | null,
  mode = '100644',
): string | null {
  if (segments.length === 0) return rootTreeOid;
  return setPathRecursive(objects, rootTreeOid, segments, blobOid, mode);
}

// ---------------------------------------------------------------- tree diffs

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** Flatten a tree into path -> {oid, mode} for blobs only. */
export function flattenTree(objects: Map<string, GitObject>, rootTreeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (treeOid: string, prefix: string): void => {
    const object = objects.get(treeOid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  if (rootTreeOid !== null) walk(rootTreeOid, '');
  return out;
}

/** File-level diff between two trees (base -> head). */
export function diffTrees(
  objects: Map<string, GitObject>,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): FileDiff[] {
  const base = flattenTree(objects, baseTreeOid);
  const head = flattenTree(objects, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const diffs: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) diffs.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (b === undefined && h !== undefined) diffs.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b !== undefined && h !== undefined && b.oid !== h.oid) diffs.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  return diffs;
}

/** Count added/removed lines between two blob contents (prefix/suffix trim, then the middle). */
export function countLineChanges(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return { additions: newEnd - start, deletions: oldEnd - start };
}
