// gitproto.ts — the smart-HTTP git protocol, served at /{owner}/{repo}.git/...
// (root level, not under /api/v3):
//   GET  /info/refs?service=git-upload-pack   v2 advertisement (when the
//          client asks with Git-Protocol: version=2) or v0 advertisement
//   GET  /info/refs?service=git-receive-pack  v0 advertisement
//   POST /git-upload-pack                     v2 ls-refs / v2 fetch, or v0 fetch
//   POST /git-receive-pack                    push (command list + packfile)
//
// The suite's client never sends deltas (its writePack emits plain objects),
// and it always authenticates. Upload-pack advertises side-band-64k (the
// client's v0 fetch requires it) and `shallow`; receive-pack advertises
// report-status, side-band-64k and delete-refs, so its report is framed in
// sideband band 1.

import type { ServerResponse } from 'node:http';
import {
  ZERO_OID,
  collectHeld,
  collectReachable,
  collectShallow,
  parseCommit,
  parsePktLines,
  parseTag,
  parseTree,
  peelToCommit,
  pktDelim,
  pktFlush,
  pktLine,
  putObject,
  readPack,
  walkCommits,
  writePack,
  type GitObject,
} from './git.ts';
import { VIEWER_LOGIN, type Repo, type Store } from './store.ts';
import { sendError, sendRaw } from './util.ts';

const SERVER_AGENT = 'github-core-clone-forge/1.0';

function bearerToken(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(value.trim());
  return match ? (match[1] as string) : null;
}

interface GitContext {
  store: Store;
  token: string;
  method: string;
  segments: string[]; // path segments, e.g. ['adaiversen','amber-thistle.git','info','refs']
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  res: ServerResponse;
}

function resolveGitRepo(ctx: GitContext, owner: string, repoName: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    sendError(ctx.res, 404, 'Not Found');
    return null;
  }
  const repo = ctx.store.getRepo(repoName);
  if (!repo) {
    sendError(ctx.res, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** All refs for an advertisement: HEAD first, then every ref sorted. */
function refLines(repo: Repo): Array<{ oid: string; name: string }> {
  const lines: Array<{ oid: string; name: string }> = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.refs.get(defaultRef);
  if (defaultTip !== undefined) lines.push({ oid: defaultTip, name: 'HEAD' });
  for (const ref of [...repo.refs.keys()].sort()) {
    lines.push({ oid: repo.refs.get(ref) as string, name: ref });
  }
  return lines;
}

/** The v0 advertisement: service preamble, flush, ref lines (caps on the first), flush. */
function advertisementV0(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const capabilities =
    service === 'git-upload-pack'
      ? `side-band-64k multi_ack shallow symref=HEAD:refs/heads/${repo.defaultBranch}`
      : 'report-status side-band-64k delete-refs';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${capabilities}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pktLine(line));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement for upload-pack. */
function advertisementV2(): Buffer {
  const lines = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'server-option\n',
    'object-format=sha1\n',
    `agent=${SERVER_AGENT}\n`,
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
}

const SIDEBAND_MAX_DATA = 65515; // pkt-line max (65520) minus length (4) minus band byte (1)

/** Frame bytes as sideband band-1 pkt-lines (the pack channel). */
function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_MAX_DATA) {
    const chunk = pack.subarray(offset, offset + SIDEBAND_MAX_DATA);
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

/** Frame a text report (receive-pack) as sideband band-1 pkt-lines. */
function sidebandText(text: string): Buffer[] {
  const bytes = Buffer.from(text, 'utf8');
  const packets: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += SIDEBAND_MAX_DATA) {
    const chunk = bytes.subarray(offset, offset + SIDEBAND_MAX_DATA);
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

// ---------------------------------------------------------------- fetch core

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[]; // the client's current shallow boundaries
  depth: number | null; // deepen N, or null for a full fetch
}

/** Parse the pkt-line sections of a fetch request body (v0 or v2) into wants/haves/shallow/deepen. */
function parseFetchBody(body: Buffer): FetchRequest {
  const { packets } = parsePktLines(body);
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5, 45);
      if (/^[0-9a-f]{40}$/.test(oid)) request.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5, 45);
      if (/^[0-9a-f]{40}$/.test(oid)) request.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8, 48);
      if (/^[0-9a-f]{40}$/.test(oid)) request.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n >= 1) request.depth = n;
    }
    // command=/agent=/object-format=/thin-pack/no-progress/ofs-delta/filter/done
    // are read and ignored: this forge always answers a full (non-thin) pack.
  }
  return request;
}

interface FetchPlan {
  /** The objects to send (already minus what the client holds). */
  oids: string[];
  /** The new shallow boundary (only when depth was requested). */
  boundary: string[];
  /** Old client boundaries whose parents are now delivered (no longer shallow). */
  unshallow: string[];
  /** The wants the forge does not hold at all. */
  missing: string[];
}

/** Plan a fetch: what to send, what is now shallow, what is now unshallow. */
function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const missing = request.wants.filter((oid) => !repo.objects.has(oid));
  const boundaries = new Set(request.shallow);
  let fetchSet: string[];
  let boundary: string[] = [];
  if (request.depth !== null) {
    const shallow = collectShallow(repo.objects, request.wants, request.depth);
    fetchSet = shallow.oids;
    boundary = shallow.boundary;
  } else {
    fetchSet = collectReachable(repo.objects, request.wants);
  }
  const held = request.haves.length > 0 ? new Set(collectHeld(repo.objects, request.haves, boundaries)) : new Set<string>();
  const oids = fetchSet.filter((oid) => !held.has(oid));
  const delivered = new Set([...oids, ...held]);
  const unshallow: string[] = [];
  for (const old of request.shallow) {
    if (!delivered.has(old)) continue;
    const object = repo.objects.get(old);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => delivered.has(parent))) unshallow.push(old);
  }
  return { oids, boundary, unshallow, missing };
}

function packFor(repo: Repo, oids: readonly string[]): Buffer {
  const objects: GitObject[] = [];
  for (const oid of oids) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return writePack(objects);
}

// ---------------------------------------------------------------- v0 fetch

function handleFetchV0(ctx: GitContext, repo: Repo): void {
  const { res } = ctx;
  const request = parseFetchBody(ctx.body);
  const plan = planFetch(repo, request);
  if (request.wants.length === 0) {
    sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat([pktLine('NAK\n'), pktFlush()]));
    return;
  }
  if (plan.missing.length > 0) {
    const errorPacket = pktLine(Buffer.concat([Buffer.from([3]), Buffer.from(`object ${plan.missing[0]} not found\n`, 'utf8')]));
    sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat([errorPacket, pktFlush()]));
    return;
  }
  const parts: Buffer[] = [];
  // Negotiation: ACK the haves the forge holds, NAK when none are common.
  const commonHaves = request.haves.filter((oid) => repo.objects.has(oid));
  if (commonHaves.length > 0) {
    for (const oid of commonHaves) parts.push(pktLine(`ACK ${oid}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.boundary) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(packFor(repo, plan.oids)));
  parts.push(pktFlush());
  sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- v2

/** The v2 ls-refs command: ref lines with optional peel / symref-target tokens. */
function handleLsRefsV2(ctx: GitContext, repo: Repo): void {
  const { res } = ctx;
  const { packets } = parsePktLines(ctx.body);
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.refs.get(defaultRef);
  if (repo.refs.size === 0) {
    // An unborn repo: only HEAD is unborn (the branch itself does not exist
    // yet, so it must not be advertised — not even as unborn).
    if (keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`));
    }
  } else {
    if (keep('HEAD') && defaultTip !== undefined) {
      parts.push(pktLine(`${defaultTip} HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`));
    }
    for (const ref of [...repo.refs.keys()].sort()) {
      if (!keep(ref)) continue;
      const oid = repo.refs.get(ref) as string;
      let suffix = '';
      if (peel && ref.startsWith('refs/tags/')) {
        const object = repo.objects.get(oid);
        if (object?.type === 'tag') {
          const peeled = peelToCommit(repo.objects, oid);
          if (peeled !== null && peeled !== oid) suffix = ` peeled:${peeled}`;
        }
      }
      parts.push(pktLine(`${oid} ${ref}${suffix}\n`));
    }
  }
  parts.push(pktFlush());
  sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** The v2 fetch command: acknowledgments, shallow-info, packfile sections. */
function handleFetchV2(ctx: GitContext, repo: Repo): void {
  const { res } = ctx;
  const request = parseFetchBody(ctx.body);
  const plan = planFetch(repo, request);
  if (request.wants.length === 0) {
    const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktLine('ready\n'), pktDelim(), pktLine('packfile\n')];
    parts.push(...sidebandPack(packFor(repo, [])));
    parts.push(pktFlush());
    sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  if (plan.missing.length > 0) {
    const errorPacket = pktLine(Buffer.concat([Buffer.from([3]), Buffer.from(`object ${plan.missing[0]} not found\n`, 'utf8')]));
    // A missing want is reported inside the packfile section as a band-3 error.
    const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktLine('ready\n'), pktDelim(), pktLine('packfile\n'), errorPacket, pktFlush()];
    sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  const commonHaves = request.haves.filter((oid) => repo.objects.has(oid));
  if (commonHaves.length > 0) {
    for (const oid of commonHaves) parts.push(pktLine(`ACK ${oid}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktLine('ready\n'));
  parts.push(pktDelim());
  if (plan.boundary.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(packFor(repo, plan.oids)));
  parts.push(pktFlush());
  sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- router

/** Handle any /{owner}/{repo}.git/* request. Always answers. */
export async function handleGit(ctx: GitContext): Promise<void> {
  const { method, segments, res } = ctx;
  const repoSegment = segments[1] ?? '';
  if (!repoSegment.endsWith('.git')) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const owner = segments[0] as string;
  const repoName = repoSegment.slice(0, -'.git'.length);

  if (bearerToken(ctx.headers) !== ctx.token) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const repo = resolveGitRepo(ctx, owner, repoName);
  if (!repo) return;

  const tail = segments.slice(2);
  const protocolV2 = (ctx.headers['git-protocol'] === 'version=2') || (Array.isArray(ctx.headers['git-protocol']) && ctx.headers['git-protocol'].includes('version=2'));

  // GET /info/refs?service=...
  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = ctx.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(res, 400, 'service is required');
      return;
    }
    if (service === 'git-upload-pack' && protocolV2) {
      sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', advertisementV2());
      return;
    }
    sendRaw(res, 200, `application/x-${service}-advertisement`, advertisementV0(service, repo));
    return;
  }

  // POST /git-upload-pack (v2 ls-refs / v2 fetch, or v0 fetch)
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    if (protocolV2) {
      const { packets } = parsePktLines(ctx.body);
      const firstLine = packets.find((packet) => packet.kind === 'data')?.payload.toString('utf8').replace(/\n$/, '') ?? '';
      if (firstLine === 'command=ls-refs') {
        handleLsRefsV2(ctx, repo);
        return;
      }
      handleFetchV2(ctx, repo);
      return;
    }
    handleFetchV0(ctx, repo);
    return;
  }

  // POST /git-receive-pack (push)
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    handleReceivePack(ctx, repo);
    return;
  }

  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(ctx: GitContext, repo: Repo): void {
  const { res } = ctx;
  const { packets, restOffset } = parsePktLines(ctx.body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul); // first line carries capabilities after NUL
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ...refParts] = parts as [string, string, ...string[]];
    commands.push({ oldOid: oldOid as string, newOid: newOid as string, ref: refParts.join(' ') });
  }

  // The packfile follows the command list (absent for a delete-only push).
  const packBytes = ctx.body.subarray(restOffset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const object of objects.values()) putObject(repo.objects, object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpacker error';
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    const isTag = command.ref.startsWith('refs/tags/');
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} old oid does not match\n`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    const object = repo.objects.get(command.newOid);
    if (!object) {
      reportLines.push(`ng ${command.ref} new oid is not an object this forge holds\n`);
      continue;
    }
    // Branches point at commits; tags may point at any object (usually a tag).
    if (!isTag && object.type !== 'commit') {
      reportLines.push(`ng ${command.ref} new oid is not a commit this forge holds\n`);
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} old oid does not match\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    // A fast-forward update: the new tip must descend from the current tip.
    if (!isTag && command.newOid !== current) {
      const ancestors = walkCommits(repo.objects, command.newOid);
      if (!ancestors.includes(current)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  // The report is framed in sideband band 1 (the advertisement promises it).
  const body = Buffer.concat([...sidebandText(reportLines.join('')), pktFlush()]);
  sendRaw(res, 200, 'application/x-git-receive-pack-result', body);
}
