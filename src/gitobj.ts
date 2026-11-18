// The git object database, in memory: blobs, trees and commits addressed by their
// SHA-1, with the encodings the wire protocol and the contents API both speak. Objects
// are immutable and content-addressed, so one store serves every repository; refs live
// in the store module (store.ts). Tree flatten/rebuild helpers power the contents API
// and squash merges; the ancestor walk powers merge bases and commit listings.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface StoredObject {
  type: ObjectType;
  payload: Buffer;
}

const objects = new Map<string, StoredObject>();

/** SHA-1 of a git object: the header "type length\0" followed by the payload. */
export function hashObject(type: ObjectType, payload: Buffer): string {
  const header = Buffer.from(`${type} ${payload.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(payload).digest('hex');
}

/** Store an object and return its id; storing the same bytes twice is a no-op. */
export function writeObject(type: ObjectType, payload: Buffer): string {
  const sha = hashObject(type, payload);
  if (!objects.has(sha)) objects.set(sha, { type, payload });
  return sha;
}

export function readObject(sha: string): StoredObject | undefined {
  return objects.get(sha.toLowerCase());
}

export function hasObject(sha: string): boolean {
  return objects.has(sha.toLowerCase());
}

/** The loose-object encoding (zlib of header+payload); the pack builder reuses it. */
export function encodeLoose(type: ObjectType, payload: Buffer): Buffer {
  return deflateSync(Buffer.concat([Buffer.from(`${type} ${payload.length}\0`, 'utf8'), payload]));
}

/** Decode a loose object; returns null when the bytes are not one. */
export function decodeLoose(data: Buffer): StoredObject | null {
  try {
    const raw = inflateSync(data);
    const nul = raw.indexOf(0);
    if (nul === -1) return null;
    const header = raw.subarray(0, nul).toString('utf8');
    const [type, sizeText] = header.split(' ');
    if (type !== 'blob' && type !== 'tree' && type !== 'commit' && type !== 'tag') return null;
    const payload = raw.subarray(nul + 1);
    if (payload.length !== Number(sizeText)) return null;
    return { type, payload };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- blobs

export function writeBlob(content: Buffer): string {
  return writeObject('blob', content);
}

export function readBlob(sha: string): Buffer | undefined {
  const object = readObject(sha);
  return object !== undefined && object.type === 'blob' ? object.payload : undefined;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000' (tree)
  name: string;
  sha: string;
}

/** Parse a tree payload into its entries, in stored order. */
export function parseTree(payload: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    const mode = payload.subarray(offset, space).toString('utf8');
    const nul = payload.indexOf(0, space + 1);
    const name = payload.subarray(space + 1, nul).toString('utf8');
    const sha = payload.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with directories compared as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Encode entries as a tree payload, sorted the way git sorts them. */
export function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function writeTree(entries: TreeEntry[]): string {
  return writeObject('tree', encodeTree(entries));
}

const flatCache = new Map<string, Map<string, { sha: string; mode: string }>>();

/**
 * Every file under a tree, as path -> {sha, mode}; the empty tree flattens to empty.
 * Trees are immutable, so a root flattening is cached and shared; callers that need
 * to mutate the map must copy it first (commitFiles does).
 */
export function flattenTree(treeSha: string, prefix = ''): Map<string, { sha: string; mode: string }> {
  if (prefix === '') {
    const cached = flatCache.get(treeSha);
    if (cached !== undefined) return cached;
  }
  const out = new Map<string, { sha: string; mode: string }>();
  const object = readObject(treeSha);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.payload)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [childPath, child] of flattenTree(entry.sha, path)) out.set(childPath, child);
    } else {
      out.set(path, { sha: entry.sha, mode: entry.mode });
    }
  }
  if (prefix === '') flatCache.set(treeSha, out);
  return out;
}

/** Rebuild a tree from a flat path map; the inverse of flattenTree. */
export function buildTree(files: Map<string, { sha: string; mode: string }>): string {
  interface Dir {
    files: Map<string, { sha: string; mode: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1] ?? path, file);
  }
  const encode = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, sha: file.sha });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, sha: encode(sub) });
    return writeTree(entries);
  };
  return encode(root);
}

// ---------------------------------------------------------------- commits

export interface Commit {
  tree: string;
  parents: string[];
  author: string; // the full "Name <email> ts tz" line
  committer: string;
  message: string;
}

export function encodeCommit(commit: Commit): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

export function writeCommit(commit: Commit): string {
  return writeObject('commit', encodeCommit(commit));
}

export function parseCommit(payload: Buffer): Commit {
  const text = payload.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const commit: Commit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  return commit;
}

const commitCache = new Map<string, Commit>();

/** Parse a commit once and keep it: commits are immutable, and every surface re-reads them. */
export function readCommit(sha: string): Commit | undefined {
  const key = sha.toLowerCase();
  const cached = commitCache.get(key);
  if (cached !== undefined) return cached;
  const object = readObject(key);
  if (object === undefined || object.type !== 'commit') return undefined;
  const commit = parseCommit(object.payload);
  commitCache.set(key, commit);
  return commit;
}

/** The tree a commit points at. */
export function commitTree(sha: string): string | undefined {
  return readCommit(sha)?.tree;
}

/** History from a tip, newest first (breadth by generation), each commit once. */
export function walkHistory(tip: string, limit = 10_000): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [tip];
  let head = 0;
  while (head < queue.length && order.length < limit) {
    const sha = queue[head++] as string;
    if (seen.has(sha)) continue;
    const commit = readCommit(sha);
    if (commit === undefined) continue;
    seen.add(sha);
    order.push(sha);
    for (const parent of commit.parents) if (!seen.has(parent)) queue.push(parent);
  }
  return order;
}

/** Every ancestor of a commit (including itself) with its shortest distance. */
export function ancestorsOf(tip: string): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: Array<[string, number]> = [[tip, 0]];
  let head = 0;
  while (head < queue.length) {
    const [sha, distance] = queue[head++] as [string, number];
    if (distances.has(sha) && (distances.get(sha) as number) <= distance) continue;
    const commit = readCommit(sha);
    if (commit === undefined) continue;
    distances.set(sha, distance);
    for (const parent of commit.parents) queue.push([parent, distance + 1]);
  }
  return distances;
}

/** The best common ancestor of two commits, or null when they share no history. */
export function mergeBase(a: string, b: string): string | null {
  const ancestorsA = ancestorsOf(a);
  const ancestorsB = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [sha, distanceA] of ancestorsA) {
    const distanceB = ancestorsB.get(sha);
    if (distanceB === undefined) continue;
    const score = distanceA + distanceB;
    if (score < bestScore) {
      bestScore = score;
      best = sha;
    }
  }
  return best;
}

/** True when `ancestor` is `tip` itself or one of its ancestors (a fast-forward test). */
export function isAncestor(ancestor: string, tip: string): boolean {
  return ancestorsOf(tip).has(ancestor);
}

// ---------------------------------------------------------------- diffs

export interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldSha: string | null;
  newSha: string | null;
  additions: number;
  deletions: number;
}

/** Line counts of a text diff: an LCS over lines, exact for the sizes this forge sees. */
function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // Trim common prefix/suffix first so the LCS table stays small.
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const oldMid = oldLines.slice(start, oldEnd);
  const newMid = newLines.slice(start, newEnd);
  if (oldMid.length === 0) return { additions: newMid.length, deletions: 0 };
  if (newMid.length === 0) return { additions: 0, deletions: oldMid.length };
  const width = newMid.length + 1;
  const table = new Uint32Array((oldMid.length + 1) * width);
  for (let i = oldMid.length - 1; i >= 0; i -= 1) {
    for (let j = newMid.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = oldMid[i] === newMid[j]
        ? (table[(i + 1) * width + j + 1] as number) + 1
        : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
    }
  }
  const common = table[0] as number;
  return { additions: newMid.length - common, deletions: oldMid.length - common };
}

/** Diff two flattened trees path by path. */
export function diffFlatTrees(
  before: Map<string, { sha: string; mode: string }>,
  after: Map<string, { sha: string; mode: string }>,
): FileDiff[] {
  const diffs: FileDiff[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldFile = before.get(path);
    const newFile = after.get(path);
    if (oldFile !== undefined && newFile !== undefined && oldFile.sha === newFile.sha) continue;
    const oldText = oldFile === undefined ? '' : (readBlob(oldFile.sha)?.toString('utf8') ?? '');
    const newText = newFile === undefined ? '' : (readBlob(newFile.sha)?.toString('utf8') ?? '');
    const { additions, deletions } = lineDiffCounts(oldText, newText);
    diffs.push({
      path,
      status: oldFile === undefined ? 'added' : newFile === undefined ? 'removed' : 'modified',
      oldSha: oldFile?.sha ?? null,
      newSha: newFile?.sha ?? null,
      additions,
      deletions,
    });
  }
  return diffs;
}
