// The forge's state: repositories and everything in them (refs, labels, issues,
// comments, pull requests), held in memory for the life of the process. The trial is
// one process against a fresh store, and the suite builds every fixture through the
// APIs, so nothing needs to persist. Timestamps come from a logical clock — a fixed
// epoch plus a per-event second — so a replayed trial produces identical bytes.

import { buildTree, commitTree, flattenTree, readCommit, writeBlob, writeCommit } from './gitobj.ts';

/** The login the trial's token belongs to (the suite's seeded viewer). */
export const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };

/** The default branch every new repository reports. */
export const DEFAULT_BRANCH = 'main';

const EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z, the scenario's epoch
let clockSeq = 0;

/** The next logical timestamp, in seconds since the epoch. */
export function tick(): number {
  clockSeq += 1;
  return EPOCH_SEC + clockSeq;
}

/** An ISO timestamp for the logical second `sec`. */
export function iso(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A git author/committer line for the viewer at logical second `sec`. */
export function ident(sec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${sec} +0000`;
}

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdSec: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSec: number;
  updatedSec: number;
  isPull: boolean;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedSec: number | null;
  mergeCommitSha: string | null;
  createdSec: number;
  updatedSec: number;
}

export interface Repo {
  id: number;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>; // 'refs/heads/main' -> commit sha
  labels: Map<string, Label>;
  items: Map<number, Issue>; // issues and pulls share one numbering, as on GitHub
  pulls: Map<number, Pull>;
  nextNumber: number;
  createdSec: number;
  updatedSec: number;
}

const repos = new Map<string, Repo>(); // key: repo name (the viewer owns every repo)
let nextRepoId = 1;
let nextCommentId = 1;
let nextItemId = 1;

export function createRepo(name: string, options: { private?: boolean; description?: string; defaultBranch?: string }): Repo {
  const now = tick();
  const repo: Repo = {
    id: nextRepoId++,
    name,
    private: options.private ?? false,
    description: options.description ?? '',
    defaultBranch: options.defaultBranch ?? DEFAULT_BRANCH,
    refs: new Map(),
    labels: new Map(),
    items: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    createdSec: now,
    updatedSec: now,
  };
  repos.set(name, repo);
  return repo;
}

/** The viewer's repository by name, or undefined. Owner checks happen in the router. */
export function getRepo(name: string): Repo | undefined {
  return repos.get(name);
}

export function deleteRepo(name: string): boolean {
  return repos.delete(name);
}

export function listRepos(): Repo[] {
  return [...repos.values()];
}

/** The commit a branch points at, by short name ('main') or full ref. */
export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(branch.startsWith('refs/') ? branch : `refs/heads/${branch}`);
}

export function setBranch(repo: Repo, branch: string, sha: string): void {
  repo.refs.set(branch.startsWith('refs/') ? branch : `refs/heads/${branch}`, sha);
  repo.updatedSec = tick();
}

/** The flattened file map at a commit (empty for an unborn or unknown commit). */
export function filesAt(commitSha: string | undefined): Map<string, { sha: string; mode: string }> {
  if (commitSha === undefined) return new Map();
  const tree = commitTree(commitSha);
  return tree === undefined ? new Map() : flattenTree(tree);
}

export interface FileChange {
  path: string;
  content: Buffer | null; // null deletes the path
}

/**
 * Apply file changes on top of a branch and commit them; returns the new commit sha.
 * With no parent (an unborn branch) the commit is a root commit. The branch ref moves.
 */
export function commitFiles(
  repo: Repo,
  branch: string,
  changes: FileChange[],
  message: string,
): string {
  const parent = branchTip(repo, branch);
  const files = filesAt(parent);
  for (const change of changes) {
    if (change.content === null) files.delete(change.path);
    else files.set(change.path, { sha: writeBlob(change.content), mode: '100644' });
  }
  const now = tick();
  const who = ident(now);
  const sha = writeCommit({
    tree: buildTree(files),
    parents: parent === undefined ? [] : [parent],
    author: who,
    committer: who,
    message,
  });
  setBranch(repo, branch, sha);
  return sha;
}

/** Create a commit with an explicit tree and parents (merges); the caller moves refs. */
export function makeCommit(tree: string, parents: string[], message: string): string {
  const now = tick();
  const who = ident(now);
  return writeCommit({ tree, parents, author: who, committer: who, message });
}

export function newComment(body: string): Comment {
  return { id: nextCommentId++, body, createdSec: tick() };
}

export function newItemId(): number {
  return nextItemId++;
}

export function commitMessageOf(sha: string): string {
  return readCommit(sha)?.message ?? '';
}
