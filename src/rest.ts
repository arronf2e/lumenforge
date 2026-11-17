// REST v3: the repository, contents, branch, commit, label, issue, comment and pull
// surfaces under /api/v3, with GitHub's status codes, JSON shapes and error bodies.
// Every call needs the trial's bearer token; a repository addressed under any owner
// other than the token's login is a 404, never a 403. Lists paginate with Link
// headers, the way api.github.com does.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendEmpty, readBody } from './http-util.ts';
import { authorized } from './app.ts';
import {
  VIEWER, createRepo, getRepo, deleteRepo, listRepos, branchTip, setBranch,
  filesAt, commitFiles, makeCommit, newComment, newItemId, iso, tick,
  type Repo, type Issue, type Pull,
} from './store.ts';
import {
  readBlob, readCommit, walkHistory, mergeBase, diffFlatTrees,
  hasObject, buildTree, parseTree, readObject,
} from './gitobj.ts';

const SCOPES = 'repo, read:org';
const NOT_FOUND = { message: 'Not Found' };

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, type: 'User' };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner: userJson(),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${VIEWER.login}/${repo.name}`,
    clone_url: `/${VIEWER.login}/${repo.name}.git`,
    created_at: iso(repo.createdSec),
    updated_at: iso(repo.updatedSec),
  };
}

function labelJson(name: string, color: string): Record<string, unknown> {
  return { name, color, description: null, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(name, repo.labels.get(name)?.color ?? 'ededed')),
    user: userJson(),
    comments: issue.comments.length,
    created_at: iso(issue.createdSec),
    updated_at: iso(issue.updatedSec),
  };
  if (issue.isPull) {
    body.pull_request = { url: `/api/v3/repos/${VIEWER.login}/${repo.name}/pulls/${issue.number}` };
  }
  return body;
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? '';
  const baseSha = branchTip(repo, pull.baseRef) ?? '';
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${VIEWER.login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER.login}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedSec === null ? null : iso(pull.mergedSec),
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(),
    created_at: iso(pull.createdSec),
    updated_at: iso(pull.updatedSec),
  };
}

function commitJson(sha: string): Record<string, unknown> {
  const commit = readCommit(sha);
  const parse = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) /.exec(line);
    if (match === null) return { name: '', email: '', date: iso(0) };
    return { name: match[1] ?? '', email: match[2] ?? '', date: iso(Number(match[3])) };
  };
  return {
    sha,
    commit: {
      message: commit?.message ?? '',
      author: parse(commit?.author ?? ''),
      committer: parse(commit?.committer ?? ''),
      tree: { sha: commit?.tree ?? '' },
    },
    parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: Record<string, unknown> | null; // parsed lazily by jsonBody()
  rawBody: Buffer | null;
}

async function jsonBody(ctx: Ctx): Promise<Record<string, unknown> | null> {
  if (ctx.body !== null) return ctx.body;
  if (ctx.rawBody === null) ctx.rawBody = await readBody(ctx.req);
  if (ctx.rawBody.length === 0) {
    ctx.body = {};
    return ctx.body;
  }
  try {
    const value = JSON.parse(ctx.rawBody.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    ctx.body = value as Record<string, unknown>;
    return ctx.body;
  } catch {
    return null;
  }
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function pagination(url: URL): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 30));
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  return { page, perPage };
}

/** Slice a list for the page and set the Link header when more pages exist. */
function paginate<T>(ctx: Ctx, items: T[]): T[] {
  const { page, perPage } = pagination(ctx.url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const host = ctx.req.headers.host ?? 'localhost';
    const next = new URL(ctx.url.pathname, `http://${host}`);
    for (const [key, value] of ctx.url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    const last = new URL(next);
    last.searchParams.set('page', String(Math.ceil(items.length / perPage)));
    ctx.res.setHeader('link', `<${next}>; rel="next", <${last}>; rel="last"`);
  }
  return slice;
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const ctx: Ctx = { req, res, url, body: null, rawBody: null };
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  const segments = url.pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
  // segments[0..1] are 'api','v3'
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': SCOPES });
    } else sendJson(res, 404, NOT_FOUND);
    return;
  }
  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: 'lumenforge 1.0.0' });
    return;
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, userJson());
    return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') return createRepoRoute(ctx);
    if (method === 'GET') {
      sendJson(res, 200, paginate(ctx, listRepos().map(repoJson)));
      return;
    }
  }
  if (rest[0] === 'repos' && rest.length >= 3) {
    const [, owner, name] = rest as [string, string, string];
    if (owner !== VIEWER.login) {
      sendJson(res, 404, NOT_FOUND);
      return;
    }
    const repo = getRepo(name);
    if (repo === undefined) {
      sendJson(res, 404, NOT_FOUND);
      return;
    }
    return repoRoute(ctx, repo, rest.slice(3), method);
  }
  sendJson(res, 404, NOT_FOUND);
}

async function createRepoRoute(ctx: Ctx): Promise<void> {
  const body = await jsonBody(ctx);
  if (body === null) return sendJson(ctx.res, 400, { message: 'Problems parsing JSON' });
  const name = str(body, 'name');
  if (name === undefined || name === '') return sendJson(ctx.res, 422, { message: 'Validation Failed: name is required' });
  if (getRepo(name) !== undefined) return sendJson(ctx.res, 422, { message: 'Validation Failed: name already exists on this account' });
  const repo = createRepo(name, {
    private: body.private === true,
    description: str(body, 'description') ?? '',
    defaultBranch: str(body, 'default_branch'),
  });
  sendJson(ctx.res, 201, repoJson(repo));
}

async function repoRoute(ctx: Ctx, repo: Repo, tail: string[], method: string): Promise<void> {
  const { res, url } = ctx;
  if (tail.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      const body = await jsonBody(ctx);
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const description = str(body, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      deleteRepo(repo.name);
      return sendEmpty(res, 204);
    }
    return sendJson(res, 404, NOT_FOUND);
  }

  const [head, ...more] = tail as [string, ...string[]];

  if (head === 'branches' && method === 'GET') {
    if (more.length === 0) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
      return sendJson(res, 200, branches);
    }
    const branch = more.join('/');
    const tip = branchTip(repo, branch);
    if (tip === undefined) return sendJson(res, 404, NOT_FOUND);
    return sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
  }

  if (head === 'git' && more[0] === 'refs' && method === 'POST') {
    const body = await jsonBody(ctx);
    if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
    const ref = str(body, 'ref') ?? '';
    const sha = (str(body, 'sha') ?? '').toLowerCase();
    if (!ref.startsWith('refs/') || !hasObject(sha) || readCommit(sha) === undefined) {
      return sendJson(res, 422, { message: 'Validation Failed: invalid ref or sha' });
    }
    if (repo.refs.has(ref)) return sendJson(res, 422, { message: 'Validation Failed: reference already exists' });
    repo.refs.set(ref, sha);
    return sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
  }

  if (head === 'commits' && method === 'GET') {
    if (more.length === 1) {
      const sha = (more[0] as string).toLowerCase();
      if (readCommit(sha) === undefined) return sendJson(res, 404, NOT_FOUND);
      return sendJson(res, 200, commitJson(sha));
    }
    const shaParam = url.searchParams.get('sha');
    const tip = shaParam === null
      ? branchTip(repo, repo.defaultBranch)
      : (branchTip(repo, shaParam) ?? (readCommit(shaParam.toLowerCase()) !== undefined ? shaParam.toLowerCase() : undefined));
    if (tip === undefined) return sendJson(res, 200, []);
    const history = walkHistory(tip).map(commitJson);
    return sendJson(res, 200, paginate(ctx, history));
  }

  if (head === 'contents') return contentsRoute(ctx, repo, more.join('/'), method);
  if (head === 'labels') return labelsRoute(ctx, repo, more, method);
  if (head === 'issues') return issuesRoute(ctx, repo, more, method);
  if (head === 'pulls') return pullsRoute(ctx, repo, more, method);

  return sendJson(res, 404, NOT_FOUND);
}

// ---------------------------------------------------------------- contents

async function contentsRoute(ctx: Ctx, repo: Repo, path: string, method: string): Promise<void> {
  const { res, url } = ctx;
  const refParam = url.searchParams.get('ref');

  if (method === 'GET') {
    const branch = refParam ?? repo.defaultBranch;
    const tip = branchTip(repo, branch) ?? (refParam !== null && readCommit(refParam.toLowerCase()) !== undefined ? refParam.toLowerCase() : undefined);
    const files = filesAt(tip);
    if (path === '') {
      return sendJson(res, 200, dirListing(files, ''));
    }
    const file = files.get(path);
    if (file !== undefined) {
      const content = readBlob(file.sha) ?? Buffer.alloc(0);
      return sendJson(res, 200, {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: file.sha,
        size: content.length,
        encoding: 'base64',
        content: content.toString('base64'),
      });
    }
    const listing = dirListing(files, path);
    if (listing !== null) return sendJson(res, 200, listing);
    return sendJson(res, 404, NOT_FOUND);
  }

  if (method === 'PUT') {
    const body = await jsonBody(ctx);
    if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
    const message = str(body, 'message') ?? '';
    const contentB64 = str(body, 'content');
    if (contentB64 === undefined) return sendJson(res, 422, { message: 'Validation Failed: content is required' });
    const branch = str(body, 'branch') ?? repo.defaultBranch;
    const files = filesAt(branchTip(repo, branch));
    const existing = files.get(path);
    const givenSha = str(body, 'sha')?.toLowerCase();
    if (existing !== undefined) {
      if (givenSha === undefined) return sendJson(res, 422, { message: 'Validation Failed: sha is required when updating' });
      if (givenSha !== existing.sha) return sendJson(res, 409, { message: `${path} does not match ${givenSha}` });
    } else if (givenSha !== undefined) {
      return sendJson(res, 404, NOT_FOUND);
    }
    const content = Buffer.from(contentB64, 'base64');
    const commitSha = commitFiles(repo, branch, [{ path, content }], message);
    const blobSha = filesAt(commitSha).get(path)?.sha ?? '';
    return sendJson(res, existing === undefined ? 201 : 200, {
      content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
  }

  if (method === 'DELETE') {
    const body = await jsonBody(ctx);
    if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
    const message = str(body, 'message') ?? '';
    const branch = str(body, 'branch') ?? repo.defaultBranch;
    const files = filesAt(branchTip(repo, branch));
    const existing = files.get(path);
    if (existing === undefined) return sendJson(res, 404, NOT_FOUND);
    const givenSha = str(body, 'sha')?.toLowerCase();
    if (givenSha !== undefined && givenSha !== existing.sha) {
      return sendJson(res, 409, { message: `${path} does not match ${givenSha}` });
    }
    const commitSha = commitFiles(repo, branch, [{ path, content: null }], message);
    return sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
  }

  return sendJson(res, 404, NOT_FOUND);
}

/** A directory listing from a flat file map, or null when the dir has no entries. */
function dirListing(files: Map<string, { sha: string; mode: string }>, dir: string): Record<string, unknown>[] | null {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, Record<string, unknown>>();
  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { type: 'file', name: rest, path, sha: file.sha, size: (readBlob(file.sha)?.length ?? 0) });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) {
        seen.set(name, { type: 'dir', name, path: `${prefix}${name}`, sha: dirTreeSha(files, `${prefix}${name}`) });
      }
    }
  }
  if (seen.size === 0 && dir !== '') return null;
  return [...seen.values()].sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
}

/** The tree sha of a directory inside a flat map: rebuild the root, then walk down. */
function dirTreeSha(files: Map<string, { sha: string; mode: string }>, dir: string): string {
  let tree = buildTree(files);
  for (const part of dir.split('/')) {
    const object = readObject(tree);
    if (object === undefined || object.type !== 'tree') return tree;
    const entry = parseTree(object.payload).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return tree;
    tree = entry.sha;
  }
  return tree;
}

// ---------------------------------------------------------------- labels

async function labelsRoute(ctx: Ctx, repo: Repo, tail: string[], method: string): Promise<void> {
  const { res } = ctx;
  if (tail.length === 0) {
    if (method === 'GET') {
      return sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label.name, label.color)));
    }
    if (method === 'POST') {
      const body = await jsonBody(ctx);
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const name = str(body, 'name');
      if (name === undefined || name === '') return sendJson(res, 422, { message: 'Validation Failed: name is required' });
      if (repo.labels.has(name)) return sendJson(res, 422, { message: 'Validation Failed: name already exists' });
      const color = str(body, 'color') ?? 'ededed';
      repo.labels.set(name, { name, color, description: null });
      return sendJson(res, 201, labelJson(name, color));
    }
  }
  return sendJson(res, 404, NOT_FOUND);
}

// ---------------------------------------------------------------- issues

async function issuesRoute(ctx: Ctx, repo: Repo, tail: string[], method: string): Promise<void> {
  const { res, url } = ctx;
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await jsonBody(ctx);
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const title = str(body, 'title');
      if (title === undefined) return sendJson(res, 422, { message: 'Validation Failed: title is required' });
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return sendJson(res, 422, { message: `Validation Failed: label ${label} does not exist` });
      }
      const now = tick();
      const issue: Issue = {
        id: newItemId(), number: repo.nextNumber++, title, body: str(body, 'body') ?? '',
        state: 'open', labels, comments: [], createdSec: now, updatedSec: now, isPull: false,
      };
      repo.items.set(issue.number, issue);
      return sendJson(res, 201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let items = [...repo.items.values()];
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return sendJson(res, 200, paginate(ctx, items.map((i) => issueJson(repo, i))));
    }
    return sendJson(res, 404, NOT_FOUND);
  }

  const number = Number(tail[0]);
  const issue = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (issue === undefined) return sendJson(res, 404, NOT_FOUND);

  if (tail.length === 1) {
    if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
    if (method === 'PATCH') {
      const body = await jsonBody(ctx);
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const state = str(body, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = str(body, 'title');
      if (title !== undefined) issue.title = title;
      const text = str(body, 'body');
      if (text !== undefined) issue.body = text;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((l): l is string => typeof l === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) return sendJson(res, 422, { message: `Validation Failed: label ${label} does not exist` });
        }
        issue.labels = labels;
      }
      issue.updatedSec = tick();
      return sendJson(res, 200, issueJson(repo, issue));
    }
    return sendJson(res, 404, NOT_FOUND);
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const body = await jsonBody(ctx);
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const text = str(body, 'body');
      if (text === undefined) return sendJson(res, 422, { message: 'Validation Failed: body is required' });
      const comment = newComment(text);
      issue.comments.push(comment);
      return sendJson(res, 201, { id: comment.id, body: comment.body, user: userJson(), created_at: iso(comment.createdSec), updated_at: iso(comment.createdSec) });
    }
    if (method === 'GET') {
      return sendJson(res, 200, paginate(ctx, issue.comments.map((c) => ({ id: c.id, body: c.body, user: userJson(), created_at: iso(c.createdSec), updated_at: iso(c.createdSec) }))));
    }
  }
  return sendJson(res, 404, NOT_FOUND);
}

// ---------------------------------------------------------------- pulls

async function pullsRoute(ctx: Ctx, repo: Repo, tail: string[], method: string): Promise<void> {
  const { res, url } = ctx;
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await jsonBody(ctx);
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const title = str(body, 'title');
      const head = str(body, 'head');
      const base = str(body, 'base');
      if (title === undefined || head === undefined || base === undefined) {
        return sendJson(res, 422, { message: 'Validation Failed: title, head and base are required' });
      }
      const headBranch = head.includes(':') ? (head.split(':').pop() as string) : head;
      const baseBranch = base.includes(':') ? (base.split(':').pop() as string) : base;
      if (branchTip(repo, headBranch) === undefined || branchTip(repo, baseBranch) === undefined) {
        return sendJson(res, 422, { message: 'Validation Failed: head or base branch does not exist' });
      }
      const now = tick();
      const number = repo.nextNumber++;
      const pull: Pull = {
        id: newItemId(), number, title, body: str(body, 'body') ?? '', state: 'open',
        headRef: headBranch, baseRef: baseBranch, merged: false, mergedSec: null,
        mergeCommitSha: null, createdSec: now, updatedSec: now,
      };
      repo.pulls.set(number, pull);
      // The shared issue numbering: a pull also occupies its number in the items map.
      repo.items.set(number, {
        id: pull.id, number, title, body: pull.body, state: 'open', labels: [], comments: [],
        createdSec: now, updatedSec: now, isPull: true,
      });
      return sendJson(res, 201, pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      return sendJson(res, 200, paginate(ctx, pulls.map((p) => pullJson(repo, p))));
    }
    return sendJson(res, 404, NOT_FOUND);
  }

  const number = Number(tail[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) return sendJson(res, 404, NOT_FOUND);

  if (tail.length === 1 && method === 'GET') return sendJson(res, 200, pullJson(repo, pull));

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const headTip = branchTip(repo, pull.headRef);
    const baseTip = branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return sendJson(res, 200, []);
    const base = mergeBase(headTip, baseTip) ?? baseTip;
    const diffs = diffFlatTrees(filesAt(base), filesAt(headTip));
    return sendJson(res, 200, paginate(ctx, diffs.map((d) => ({
      sha: d.newSha ?? d.oldSha ?? '',
      filename: d.path,
      status: d.status === 'modified' ? 'modified' : d.status,
      additions: d.additions,
      deletions: d.deletions,
      changes: d.additions + d.deletions,
    }))));
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    const body = await jsonBody(ctx);
    if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
    if (pull.state !== 'open') return sendJson(res, 405, { message: 'Pull Request is not open' });
    const headTip = branchTip(repo, pull.headRef);
    const baseTip = branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
    const ancestor = mergeBase(headTip, baseTip) ?? baseTip;
    const baseFiles = filesAt(baseTip);
    const headFiles = filesAt(headTip);
    const ancestorFiles = filesAt(ancestor);
    // Three-way merge per path: a path both sides changed differently conflicts.
    const merged = new Map(ancestorFiles);
    const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const a = ancestorFiles.get(path)?.sha;
      const b = baseFiles.get(path)?.sha;
      const h = headFiles.get(path)?.sha;
      if (h === a) {
        // Head did not touch it: take base's version.
        if (b === undefined) merged.delete(path);
        else merged.set(path, baseFiles.get(path) as { sha: string; mode: string });
      } else if (b === a || b === h) {
        // Base did not touch it, or both made the same change: take head's.
        if (h === undefined) merged.delete(path);
        else merged.set(path, headFiles.get(path) as { sha: string; mode: string });
      } else {
        return sendJson(res, 405, { message: 'Pull Request is not mergeable: conflict' });
      }
    }
    const methodWanted = str(body, 'merge_method') ?? 'squash';
    const tree = buildTree(merged);
    let mergeSha: string;
    if (methodWanted === 'merge') {
      mergeSha = makeCommit(tree, [baseTip, headTip], `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`);
    } else {
      mergeSha = makeCommit(tree, [baseTip], `${pull.title} (#${pull.number})${pull.body !== '' ? `\n\n${pull.body}` : ''}`);
    }
    setBranch(repo, pull.baseRef, mergeSha);
    const now = tick();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedSec = now;
    pull.mergeCommitSha = mergeSha;
    pull.updatedSec = now;
    const item = repo.items.get(pull.number);
    if (item !== undefined) {
      item.state = 'closed';
      item.updatedSec = now;
    }
    return sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
  }

  return sendJson(res, 404, NOT_FOUND);
}
