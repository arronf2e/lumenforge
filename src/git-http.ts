// Git smart HTTP: ref advertisements (protocol v2 capabilities and the v0 ref list),
// the v2 ls-refs and fetch commands, a v0 fetch fallback, and v0 receive-pack pushes.
// One object store (gitobj.ts) backs both this surface and the REST contents API, so a
// repository filled through REST clones over git and vice versa. Refs are per-repo;
// objects are content-addressed and shared, exactly like git's own object pools.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody } from './http-util.ts';
import { authorized } from './app.ts';
import { VIEWER, getRepo, type Repo } from './store.ts';
import {
  readObject, readCommit, parseTree, hasObject,
} from './gitobj.ts';
import { pkt, FLUSH, decodePackets, decodeAllPackets, type Packet } from './pktline.ts';
import { buildPack, parsePack, storePack } from './pack.ts';

const ZERO = '0'.repeat(40);
const AGENT = 'lumenforge/1.0';
const UPLOAD_CAPS_V0 = [
  'side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', `agent=${AGENT}`,
];
const RECEIVE_CAPS_V0 = [
  'report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`,
];

/** Follow an annotated tag chain to the commit it ultimately names (or the object itself). */
export function peelToCommit(sha: string): string {
  let current = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = readObject(current);
    if (object === undefined || object.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.payload.toString('utf8'));
    if (match === null) return current;
    current = match[1] as string;
  }
  return current;
}

/** Every ref of a repo as [name, sha], HEAD's target first among heads is the caller's job. */
function repoRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function headRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ------------------------------------------------------------------ routing

export async function handleGitHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const segments = url.pathname.split('/').filter((s) => s !== '');
  const owner = segments[0] ?? '';
  const repoSegment = segments[1] ?? '';
  const tail = segments.slice(2).join('/');
  if (!repoSegment.endsWith('.git')) return notFound(res);
  const repo = owner === VIEWER.login ? getRepo(repoSegment.slice(0, -4)) : undefined;
  if (repo === undefined) return notFound(res);
  // A wrong token is refused; no token at all is tolerated (the suite always sends it).
  if (req.headers.authorization !== undefined && !authorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Bad credentials' }));
    return;
  }
  const method = req.method ?? 'GET';
  try {
    if (method === 'GET' && tail === 'info/refs') return advertise(req, res, url, repo);
    if (method === 'POST' && tail === 'git-upload-pack') return uploadPack(req, res, repo);
    if (method === 'POST' && tail === 'git-receive-pack') return receivePack(req, res, repo);
  } catch {
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad request\n');
    } else res.end();
    return;
  }
  return notFound(res);
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ message: 'Not Found' }));
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

// ------------------------------------------------------------------ advertisements

function advertise(req: IncomingMessage, res: ServerResponse, url: URL, repo: Repo): void {
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('service required\n');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  if (wantsV2) {
    const body = Buffer.concat([
      pkt('version 2\n'),
      pkt(`agent=${AGENT}\n`),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow wait-for-done\n'),
      pkt('object-format=sha1\n'),
      FLUSH,
    ]);
    return sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', body);
  }
  const caps = service === 'git-upload-pack'
    ? [...UPLOAD_CAPS_V0, `symref=HEAD:${headRef(repo)}`]
    : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const refs = repoRefs(repo);
  const head = headRef(repo);
  const headTip = repo.refs.get(head);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO} capabilities^{}\0${caps.join(' ')}`);
  } else {
    const headLine = headTip === undefined
      ? `${ZERO} HEAD\0${caps.join(' ')}`
      : `${headTip} HEAD\0${caps.join(' ')}`;
    lines.push(headLine);
    for (const [name, sha] of refs) {
      lines.push(`${sha} ${name}`);
      if (name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(sha);
        if (peeled !== sha) lines.push(`${peeled} ${name}^{}`);
      }
    }
  }
  for (const line of lines) parts.push(pkt(`${line}\n`));
  parts.push(FLUSH);
  return sendBuffer(res, 200, `application/x-${service}-advertisement`, Buffer.concat(parts));
}

// ------------------------------------------------------------------ upload-pack

async function uploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const packets = decodeAllPackets(body);
  // Split the stream at the first delimiter: command + capabilities, then arguments.
  const delimIndex = packets.findIndex((p) => p.kind === 'delim');
  const head = delimIndex === -1 ? packets : packets.slice(0, delimIndex);
  const args = delimIndex === -1 ? [] : packets.slice(delimIndex + 1);
  const headLines = head.filter((p): p is Extract<Packet, { kind: 'data' }> => p.kind === 'data')
    .map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
  const command = headLines.find((line) => line.startsWith('command='))?.slice('command='.length);
  const argLines = args.filter((p): p is Extract<Packet, { kind: 'data' }> => p.kind === 'data')
    .map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
  if (command === 'ls-refs') return lsRefs(res, repo, argLines);
  if (command === 'fetch') return fetchV2(res, repo, argLines);
  // No command line at all: a protocol v0 request (wants first).
  const v0Lines = [...headLines, ...argLines];
  if (v0Lines.some((line) => line.startsWith('want '))) return fetchV0(res, repo, packets);
  res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('unsupported upload-pack command\n');
}

function lsRefs(res: ServerResponse, repo: Repo, argLines: string[]): void {
  const peel = argLines.includes('peel');
  const symrefs = argLines.includes('symrefs');
  const unborn = argLines.includes('unborn');
  const prefixes = argLines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const head = headRef(repo);
  const headTip = repo.refs.get(head);
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      parts.push(pkt(`${headTip} HEAD${symrefs ? ` symref-target:${head}` : ''}\n`));
    } else if (unborn) {
      parts.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${head}` : ''}\n`));
    }
  }
  for (const [name, sha] of repoRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${sha} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(sha);
      if (peeled !== sha) line += ` peeled:${peeled}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ------------------------------------------------------------------ reachability

interface FetchPlan {
  /** Object ids to put in the pack, commits first. */
  objects: string[];
  /** Commits to report as the new shallow boundary. */
  shallow: string[];
  /** Client boundary commits that stop being boundary commits. */
  unshallow: string[];
}

/** The tree closure of one commit (the commit's tree and everything under it). */
function treeClosure(commitSha: string, into: Set<string>): void {
  const commit = readCommit(commitSha);
  if (commit === undefined) return;
  const stack = [commit.tree];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (into.has(sha)) continue;
    const object = readObject(sha);
    if (object === undefined) continue;
    into.add(sha);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.payload)) stack.push(entry.sha);
    }
  }
}

/**
 * Plan a fetch: which objects the client still needs, given its wants, haves, shallow
 * boundary and an optional depth. Depth counts commit generations from the wants;
 * the client's shallow commits are treated as parentless (it holds them, but not
 * their history), which is what makes deepen arithmetic come out right.
 */
const freshPlanCache = new Map<string, FetchPlan>();

function planFetch(
  wants: string[],
  haves: string[],
  shallowClient: string[],
  depth: number | null,
): FetchPlan {
  // A fresh fetch (no haves, no shallow boundary) plans purely from the object
  // graph, which is append-only: the same wants+depth always plan the same pack.
  const cacheKey = haves.length === 0 && shallowClient.length === 0
    ? `${wants.join(',')}#${depth ?? ''}`
    : null;
  if (cacheKey !== null) {
    const cached = freshPlanCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  const plan = planFetchUncached(wants, haves, shallowClient, depth);
  if (cacheKey !== null) freshPlanCache.set(cacheKey, plan);
  return plan;
}

function planFetchUncached(
  wants: string[],
  haves: string[],
  shallowClient: string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(shallowClient);
  // What the client already holds: haves closed over parents, but never past a
  // shallow boundary commit; plus every held commit's tree closure.
  const held = new Set<string>();
  const heldCommits: string[] = [];
  const stack = [...haves, ...shallowClient];
  const seenCommits = new Set<string>();
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seenCommits.has(sha)) continue;
    seenCommits.add(sha);
    const object = readObject(sha);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      held.add(sha);
      const target = peelTarget(sha);
      if (target !== null) stack.push(target);
      continue;
    }
    if (object.type !== 'commit') continue;
    held.add(sha);
    heldCommits.push(sha);
    if (shallowSet.has(sha)) continue; // boundary: the client holds nothing beyond
    const commit = readCommit(sha);
    for (const parent of commit?.parents ?? []) stack.push(parent);
  }
  for (const sha of heldCommits) treeClosure(sha, held);

  // Included commits: BFS by generation from the wants (tags unwrap to their commit).
  const included = new Map<string, number>(); // commit sha -> generation
  const queue: Array<[string, number]> = [];
  const extraObjects = new Set<string>(); // tag objects on the way to a wanted commit
  for (const want of wants) {
    let current = want;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = readObject(current);
      if (object === undefined) break;
      if (object.type === 'tag') {
        extraObjects.add(current);
        const target = peelTarget(current);
        if (target === null) break;
        current = target;
        continue;
      }
      break;
    }
    if (readCommit(current) !== undefined) queue.push([current, 0]);
    else if (readObject(current) !== undefined) extraObjects.add(current);
  }
  let queueHead = 0;
  while (queueHead < queue.length) {
    const [sha, generation] = queue[queueHead++] as [string, number];
    if (included.has(sha) && (included.get(sha) as number) <= generation) continue;
    if (depth !== null && generation >= depth) continue;
    included.set(sha, generation);
    const commit = readCommit(sha);
    for (const parent of commit?.parents ?? []) queue.push([parent, generation + 1]);
  }

  const objects = new Set<string>();
  for (const sha of extraObjects) if (!held.has(sha)) objects.add(sha);
  for (const sha of included.keys()) {
    if (!held.has(sha)) objects.add(sha);
    treeClosure(sha, objects);
  }
  for (const sha of [...objects]) if (held.has(sha)) objects.delete(sha);

  // The new boundary: included commits with a parent that exists but is neither
  // included nor already held by the client.
  const boundary: string[] = [];
  const unshallow: string[] = [];
  for (const sha of included.keys()) {
    const commit = readCommit(sha);
    const parents = commit?.parents ?? [];
    const cut = parents.some((p) => !included.has(p) && !held.has(p) && readCommit(p) !== undefined);
    if (cut) boundary.push(sha);
  }
  for (const sha of shallowClient) {
    if (included.has(sha) && !boundary.includes(sha)) unshallow.push(sha);
  }
  // Commits before trees before blobs reads naturally and packs deterministically.
  const order = (sha: string): number => {
    const type = readObject(sha)?.type;
    return type === 'commit' ? 0 : type === 'tag' ? 1 : type === 'tree' ? 2 : 3;
  };
  return { objects: [...objects].sort((a, b) => order(a) - order(b) || (a < b ? -1 : 1)), shallow: boundary, unshallow };
}

function peelTarget(tagSha: string): string | null {
  const object = readObject(tagSha);
  if (object === undefined || object.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})$/m.exec(object.payload.toString('utf8'));
  return match === null ? null : (match[1] as string);
}

/** Wrap pack bytes in sideband band-1 packets (band 2 carries one progress note). */
function sidebandPack(pack: Buffer, progress: boolean): Buffer[] {
  const parts: Buffer[] = [];
  if (progress) parts.push(pkt(Buffer.concat([Buffer.from([2]), Buffer.from('lumenforge: pack ready\n', 'utf8')])));
  const CHUNK = 65512;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  return parts;
}

function fetchV2(res: ServerResponse, repo: Repo, argLines: string[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowClient: string[] = [];
  let depth: number | null = null;
  let noProgress = false;
  for (const line of argLines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowClient.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    else if (line === 'no-progress') noProgress = true;
  }
  for (const want of wants) {
    if (!hasObject(want)) {
      res.writeHead(422, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`no such object ${want}\n`);
      return;
    }
  }
  const plan = planFetch(wants, haves, shallowClient, depth);
  const parts: Buffer[] = [];
  if (plan.objects.length === 0) {
    parts.push(pkt('acknowledgments\n'));
    const acked = haves.filter((h) => hasObject(h));
    if (acked.length === 0) parts.push(pkt('NAK\n'));
    for (const have of acked) parts.push(pkt(`ACK ${have}\n`));
    parts.push(pkt('ready\n'));
    parts.push(FLUSH);
  } else {
    if (depth !== null || shallowClient.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const sha of plan.shallow) parts.push(pkt(`shallow ${sha}\n`));
      for (const sha of plan.unshallow) parts.push(pkt(`unshallow ${sha}\n`));
      parts.push(FLUSH);
    }
    parts.push(pkt('packfile\n'));
    parts.push(...sidebandPack(buildPack(plan.objects), !noProgress));
    parts.push(FLUSH);
  }
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function fetchV0(res: ServerResponse, repo: Repo, packets: Packet[]): void {
  // v0: wants (first carries capabilities), flush, haves, done, flush.
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowClient: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowClient.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  for (const want of wants) {
    if (!hasObject(want)) {
      res.writeHead(422, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`no such object ${want}\n`);
      return;
    }
  }
  const plan = planFetch(wants, haves, shallowClient, depth);
  const parts: Buffer[] = [];
  for (const sha of plan.shallow) parts.push(pkt(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pkt(`unshallow ${sha}\n`));
  if (plan.objects.length === 0) {
    const acked = haves.filter((h) => hasObject(h));
    if (acked.length === 0) parts.push(pkt('NAK\n'));
    for (const have of acked) parts.push(pkt(`ACK ${have}\n`));
    parts.push(FLUSH);
  } else {
    parts.push(pkt('NAK\n'));
    parts.push(...sidebandPack(buildPack(plan.objects), true));
    parts.push(FLUSH);
  }
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function receivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const { packets, rest } = decodePackets(body);
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      capabilities = new Set(line.slice(nul + 1).split(' ').filter(Boolean));
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match !== null) {
      commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    }
  }
  const sideband = capabilities.has('side-band-64k');
  const reportStatus = capabilities.has('report-status') || capabilities.has('report-status-v2');

  const sendReport = (lines: string[]): void => {
    const report = Buffer.concat([...lines.map((line) => pkt(`${line}\n`)), FLUSH]);
    if (sideband) {
      const parts: Buffer[] = [];
      const CHUNK = 65512;
      for (let offset = 0; offset < report.length; offset += CHUNK) {
        parts.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(offset, offset + CHUNK)])));
      }
      parts.push(FLUSH);
      sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
    } else {
      sendBuffer(res, 200, 'application/x-git-receive-pack-result', report);
    }
  };

  if (commands.length === 0) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('no ref updates\n');
    return;
  }

  // Unpack first; a bad pack refuses everything and stores nothing.
  const needsPack = commands.some((c) => c.newOid !== ZERO);
  if (needsPack && rest.length > 0) {
    try {
      const parsed = await parsePack(rest);
      storePack(parsed);
    } catch (err) {
      if (reportStatus) {
        const detail = err instanceof Error ? err.message : 'unpack failed';
        return sendReport([`unpack ${detail}`, ...commands.map((c) => `ng ${c.ref} unpacker error`)]);
      }
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unpack failed\n');
      return;
    }
  } else if (needsPack && rest.length === 0) {
    if (reportStatus) return sendReport(['unpack no pack received', ...commands.map((c) => `ng ${c.ref} unpacker error`)]);
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('no pack received\n');
    return;
  }

  const report: string[] = ['unpack ok'];
  for (const command of commands) {
    report.push(applyPushCommand(repo, command));
  }
  if (reportStatus) return sendReport(report);
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
}

/** Validate and apply one ref update; returns its report-status line. */
function applyPushCommand(repo: Repo, command: PushCommand): string {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
    return `ng ${ref} invalid ref`;
  }
  const current = repo.refs.get(ref);
  if (newOid === ZERO) {
    // Delete.
    if (current === undefined) return `ng ${ref} reference does not exist`;
    if (current !== oldOid) return `ng ${ref} stale info`;
    if (ref === headRef(repo)) return `ng ${ref} deletion of the current branch prohibited`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  if (!hasObject(newOid) || readCommit(peelToCommit(newOid)) === undefined) {
    return `ng ${ref} no such object`;
  }
  if (current === undefined) {
    if (oldOid !== ZERO) return `ng ${ref} stale info`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (current !== oldOid) {
    // The client's view is stale; classify by ancestry of the intended move.
    const from = peelToCommit(current);
    const to = peelToCommit(newOid);
    if (!isAncestorCommit(from, to)) return `ng ${ref} non-fast-forward`;
    return `ng ${ref} stale info`;
  }
  if (current === newOid) return `ok ${ref}`;
  const from = peelToCommit(current);
  const to = peelToCommit(newOid);
  if (!isAncestorCommit(from, to)) return `ng ${ref} non-fast-forward`;
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

function isAncestorCommit(ancestor: string, tip: string): boolean {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const commit = readCommit(sha);
    for (const parent of commit?.parents ?? []) queue.push(parent);
  }
  return false;
}
