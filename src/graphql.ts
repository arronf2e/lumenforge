// GraphQL v4: the subset gh and github-mcp-server speak — viewer and repository
// reads, issue/pull connections with cursor pagination, the create/close/merge
// mutations, Relay node(id:) lookups, and the __type introspection probes gh uses
// for feature detection. Global ids are opaque base64 tokens that encode the
// entity's kind and keys, so an id minted by any surface resolves on every other.
// Unknown fields answer 200 with an errors array, as the GraphQL spec requires;
// a missing token answers exactly 401; a batched body answers an array in order.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, readBody } from './http-util.ts';
import { authorized } from './app.ts';
import {
  VIEWER, getRepo, listRepos, branchTip, tick, iso, newComment, newItemId,
  filesAt, makeCommit, setBranch,
  type Repo, type Issue, type Pull,
} from './store.ts';
import { mergeBase, buildTree, readCommit, commitTree } from './gitobj.ts';
import { parseGraphQL, resolveValue, type Operation, type SelectionNode, type FieldNode } from './gql-parse.ts';

// ------------------------------------------------------------------ global ids

/** Mint an opaque global id for an entity: base64 of "LF:<kind>:<keys...>". */
function gid(kind: string, ...keys: Array<string | number>): string {
  return Buffer.from(`LF:${kind}:${keys.join(':')}`, 'utf8').toString('base64');
}

/** Decode a global id into its kind and keys, or null when it is not one of ours. */
function parseGid(id: string): { kind: string; keys: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts[0] !== 'LF' || parts.length < 3) return null;
    return { kind: parts[1] as string, keys: parts.slice(2) };
  } catch {
    return null;
  }
}

function repoByGlobalId(id: string): Repo | undefined {
  const parsed = parseGid(id);
  if (parsed === null) return undefined;
  const repoId = Number(parsed.keys[0]);
  return listRepos().find((repo) => repo.id === repoId);
}

// ------------------------------------------------------------------ schema surface

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'url', 'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'prefix'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'author', 'createdAt', 'updatedAt', 'comments', 'labels'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'createdAt', 'updatedAt', 'mergeCommit', 'url',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  Comment: ['id', 'body', 'author', 'createdAt'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['CODE', 'COMMIT', 'DISCUSSION', 'ISSUE', 'MARKETPLACE', 'REPOSITORY', 'USER', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ------------------------------------------------------------------ entities

type Entity = Record<string, unknown> & { __typename: string };

function userEntity(): Entity {
  return { __typename: 'User', id: gid('User', VIEWER.id), login: VIEWER.login, name: VIEWER.name, url: '' };
}

function repoEntity(repo: Repo): Entity {
  const defaultTip = branchTip(repo, repo.defaultBranch);
  return {
    __typename: 'Repository',
    _repo: repo,
    id: gid('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${VIEWER.login}/${repo.name}`,
    owner: userEntity(),
    defaultBranchRef: defaultTip === undefined ? null : ({ __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' } as Entity),
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.private,
    url: '',
    createdAt: iso(repo.createdSec),
    updatedAt: iso(repo.updatedSec),
  };
}

function issueEntity(repo: Repo, issue: Issue): Entity {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: gid('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    url: '',
    author: userEntity(),
    createdAt: iso(issue.createdSec),
    updatedAt: iso(issue.updatedSec),
  };
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** A read-only three-way merge test: would merging head into base conflict? */
function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return 'CONFLICTING';
  const ancestor = mergeBase(headTip, baseTip) ?? baseTip;
  const ancestorFiles = filesAt(ancestor);
  const baseFiles = filesAt(baseTip);
  const headFiles = filesAt(headTip);
  const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const a = ancestorFiles.get(path)?.sha;
    const b = baseFiles.get(path)?.sha;
    const h = headFiles.get(path)?.sha;
    if (h !== a && b !== a && b !== h) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function pullEntity(repo: Repo, pull: Pull): Entity {
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pull: pull,
    id: gid('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullState(pull),
    merged: pull.merged,
    mergeable: pull.state === 'open' ? pullMergeable(repo, pull) : 'UNKNOWN',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    author: userEntity(),
    createdAt: iso(pull.createdSec),
    updatedAt: iso(pull.updatedSec),
    url: '',
    mergeCommit: null,
  };
}

// ------------------------------------------------------------------ connections

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface Page<T> {
  items: T[];
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

/** Page a number-ordered list by the cursor convention (after = last seen number). */
function paginate<T extends { number: number }>(items: T[], first: number | undefined, after: unknown): Page<T> {
  let startIndex = 0;
  if (typeof after === 'string' && after !== '') {
    const afterNumber = numberFromCursor(after);
    if (afterNumber !== null) {
      const index = items.findIndex((item) => item.number === afterNumber);
      if (index !== -1) startIndex = index + 1;
    }
  }
  const limit = first === undefined ? items.length : Math.max(0, first);
  const slice = items.slice(startIndex, startIndex + limit);
  return {
    items: slice,
    hasNextPage: startIndex + slice.length < items.length,
    endCursor: slice.length > 0 ? cursorFor((slice[slice.length - 1] as T).number) : null,
    startCursor: slice.length > 0 ? cursorFor((slice[0] as T).number) : null,
  };
}

function connectionEntity(kind: 'Issue' | 'PullRequest', page: Page<Entity>, total: number): Entity {
  return {
    __typename: `${kind}Connection`,
    nodes: page.items,
    edges: page.items.map((node) => ({ __typename: `${kind}Edge`, node, cursor: cursorFor(node.number as number) } as Entity)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: page.hasNextPage,
      hasPreviousPage: false,
      startCursor: page.startCursor,
      endCursor: page.endCursor,
    } as Entity,
    totalCount: total,
  };
}

// ------------------------------------------------------------------ field resolution

type Args = Record<string, unknown>;

function argString(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function argInt(args: Args, name: string): number | undefined {
  const value = args[name];
  return typeof value === 'number' ? value : undefined;
}

function resolveField(source: Entity | null, field: FieldNode, args: Args, errors: string[]): unknown {
  const typename = source === null ? 'Query' : source.__typename;
  const name = field.name;

  if (name === '__type' && typename === 'Query') {
    const typeName = argString(args, 'name') ?? '';
    return typeEntity(typeName);
  }
  if (name === '__typename') return typename;

  // Object-typed fields whose value depends on arguments are resolved here; every
  // other field is a plain property the entity builders already shaped.
  if (typename === 'Query') {
    if (name === 'viewer') return userEntity();
    if (name === 'repository') {
      const owner = argString(args, 'owner');
      const repoName = argString(args, 'name');
      if (owner !== VIEWER.login || repoName === undefined) return null;
      const repo = getRepo(repoName);
      return repo === undefined ? null : repoEntity(repo);
    }
    if (name === 'node') {
      const id = argString(args, 'id') ?? '';
      return nodeById(id);
    }
  }
  if (typename === 'Mutation') return resolveMutation(name, args, errors);
  if (typename === 'Repository' && source !== null) {
    const repo = source._repo as Repo;
    if (name === 'issue') {
      const number = argInt(args, 'number');
      const issue = number === undefined ? undefined : repo.items.get(number);
      if (issue === undefined || issue.isPull) return null;
      return issueEntity(repo, issue);
    }
    if (name === 'issues') return issuesConnection(repo, args);
    if (name === 'pullRequest') {
      const number = argInt(args, 'number');
      const pull = number === undefined ? undefined : repo.pulls.get(number);
      return pull === undefined ? null : pullEntity(repo, pull);
    }
    if (name === 'pullRequests') return pullsConnection(repo, args);
  }
  if (typename === 'PullRequest' && source !== null && name === 'files') {
    const repo = source._repo as Repo;
    const pull = source._pull as Pull;
    return filesConnection(repo, pull, args);
  }

  if (source !== null && name in source) return source[name];
  errors.push(`Field '${name}' doesn't exist on type '${typename}'`);
  return null;
}

function typeEntity(typeName: string): Entity | null {
  const fields = TYPE_FIELDS[typeName];
  const enumValues = ENUM_VALUES[typeName];
  if (fields === undefined && enumValues === undefined) return null;
  return {
    __typename: '__Type',
    name: typeName,
    kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
    description: null,
    fields: (fields ?? []).map((name) => ({ __typename: '__Field', name, description: null } as Entity)),
    enumValues: (enumValues ?? []).map((name) => ({ __typename: '__EnumValue', name, description: null } as Entity)),
  };
}

function nodeById(id: string): Entity | null {
  const parsed = parseGid(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = repoByGlobalId(id);
    return repo === undefined ? null : repoEntity(repo);
  }
  if (parsed.kind === 'User') return userEntity();
  if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
    const repo = listRepos().find((r) => r.id === Number(parsed.keys[0]));
    if (repo === undefined) return null;
    const number = Number(parsed.keys[1]);
    if (parsed.kind === 'Issue') {
      const issue = repo.items.get(number);
      return issue === undefined ? null : issueEntity(repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullEntity(repo, pull);
  }
  return null;
}

function issuesConnection(repo: Repo, args: Args): Entity {
  let items = [...repo.items.values()].filter((issue) => !issue.isPull);
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = states.map((s) => String(s).toLowerCase());
    items = items.filter((issue) => wanted.includes(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Args;
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  items.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const total = items.length;
  const page = paginate(items.map((issue) => issueEntity(repo, issue)), argInt(args, 'first'), args.after);
  return connectionEntity('Issue', page, total);
}

function pullsConnection(repo: Repo, args: Args): Entity {
  let pulls = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = states.map((s) => String(s));
    pulls = pulls.filter((pull) => wanted.includes(pullState(pull)));
  } else {
    pulls = pulls.filter((pull) => pull.state === 'open');
  }
  pulls.sort((a, b) => b.number - a.number);
  const total = pulls.length;
  const page = paginate(pulls.map((pull) => pullEntity(repo, pull)), argInt(args, 'first'), args.after);
  return connectionEntity('PullRequest', page, total);
}

function filesConnection(repo: Repo, pull: Pull, args: Args): Entity {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  let files: Array<{ path: string; additions: number; deletions: number }> = [];
  if (headTip !== undefined && baseTip !== undefined) {
    const ancestor = mergeBase(headTip, baseTip) ?? baseTip;
    const before = filesAt(ancestor);
    const after = filesAt(headTip);
    const paths = new Set([...before.keys(), ...after.keys()]);
    for (const path of [...paths].sort()) {
      const oldSha = before.get(path)?.sha;
      const newSha = after.get(path)?.sha;
      if (oldSha === newSha) continue;
      files.push({ path, additions: 0, deletions: 0 });
    }
  }
  const first = argInt(args, 'first');
  const sliced = first === undefined ? files : files.slice(0, first);
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes: sliced.map((file) => ({ __typename: 'PullRequestChangedFile', ...file } as Entity)),
    totalCount: files.length,
  };
}

// ------------------------------------------------------------------ mutations

function resolveMutation(name: string, args: Args, errors: string[]): unknown {
  const input = (args.input ?? {}) as Args;
  switch (name) {
    case 'createIssue': {
      const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(input.repositoryId) : undefined;
      if (repo === undefined) {
        errors.push('createIssue: repository not found');
        return null;
      }
      const now = tick();
      const issue: Issue = {
        id: newItemId(), number: repo.nextNumber++, title: String(input.title ?? ''), body: String(input.body ?? ''),
        state: 'open', labels: [], comments: [], createdSec: now, updatedSec: now, isPull: false,
      };
      repo.items.set(issue.number, issue);
      return { __typename: 'CreateIssuePayload', issue: issueEntity(repo, issue), clientMutationId: input.clientMutationId ?? null };
    }
    case 'closeIssue': {
      const target = typeof input.issueId === 'string' ? nodeById(input.issueId) : null;
      if (target === null || target.__typename !== 'Issue') {
        errors.push('closeIssue: issue not found');
        return null;
      }
      const issue = target._issue as Issue;
      issue.state = 'closed';
      issue.updatedSec = tick();
      return { __typename: 'CloseIssuePayload', issue: target, clientMutationId: input.clientMutationId ?? null };
    }
    case 'createPullRequest': {
      const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(input.repositoryId) : undefined;
      if (repo === undefined) {
        errors.push('createPullRequest: repository not found');
        return null;
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      if (branchTip(repo, headRef) === undefined || branchTip(repo, baseRef) === undefined) {
        errors.push('createPullRequest: head or base branch does not exist');
        return null;
      }
      const now = tick();
      const number = repo.nextNumber++;
      const pull: Pull = {
        id: newItemId(), number, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open',
        headRef, baseRef, merged: false, mergedSec: null, mergeCommitSha: null, createdSec: now, updatedSec: now,
      };
      repo.pulls.set(number, pull);
      repo.items.set(number, {
        id: pull.id, number, title: pull.title, body: pull.body, state: 'open', labels: [], comments: [],
        createdSec: now, updatedSec: now, isPull: true,
      });
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullEntity(repo, pull), clientMutationId: input.clientMutationId ?? null };
    }
    case 'mergePullRequest': {
      const target = typeof input.pullRequestId === 'string' ? nodeById(input.pullRequestId) : null;
      if (target === null || target.__typename !== 'PullRequest') {
        errors.push('mergePullRequest: pull request not found');
        return null;
      }
      const repo = target._repo as Repo;
      const pull = target._pull as Pull;
      const failure = mergePull(repo, pull, String(input.mergeMethod ?? 'MERGE'));
      if (failure !== null) {
        errors.push(`mergePullRequest: ${failure}`);
        return null;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullEntity(repo, pull), clientMutationId: input.clientMutationId ?? null };
    }
    case 'addComment': {
      const target = typeof input.subjectId === 'string' ? nodeById(input.subjectId) : null;
      if (target === null || (target.__typename !== 'Issue' && target.__typename !== 'PullRequest')) {
        errors.push('addComment: subject not found');
        return null;
      }
      const repo = target._repo as Repo;
      const number = target.number as number;
      const issue = repo.items.get(number);
      if (issue === undefined) {
        errors.push('addComment: subject not found');
        return null;
      }
      const comment = newComment(String(input.body ?? ''));
      issue.comments.push(comment);
      const node = {
        __typename: 'Comment',
        id: gid('Comment', repo.id, number, comment.id),
        body: comment.body,
        author: userEntity(),
        createdAt: iso(comment.createdSec),
      } as Entity;
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node, cursor: cursorFor(comment.id) } as Entity,
        subject: target,
        clientMutationId: input.clientMutationId ?? null,
      };
    }
    default:
      errors.push(`Field '${name}' doesn't exist on type 'Mutation'`);
      return null;
  }
}

/** Merge a pull request the GraphQL way; returns a failure reason or null. Shared shape with REST. */
function mergePull(repo: Repo, pull: Pull, method: string): string | null {
  if (pull.state !== 'open') return 'pull request is not open';
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return 'a branch is missing';
  const ancestor = mergeBase(headTip, baseTip) ?? baseTip;
  const ancestorFiles = filesAt(ancestor);
  const baseFiles = filesAt(baseTip);
  const headFiles = filesAt(headTip);
  const merged = new Map(ancestorFiles);
  const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const a = ancestorFiles.get(path)?.sha;
    const b = baseFiles.get(path)?.sha;
    const h = headFiles.get(path)?.sha;
    if (h === a) {
      if (b === undefined) merged.delete(path);
      else merged.set(path, baseFiles.get(path) as { sha: string; mode: string });
    } else if (b === a || b === h) {
      if (h === undefined) merged.delete(path);
      else merged.set(path, headFiles.get(path) as { sha: string; mode: string });
    } else {
      return 'merge conflict';
    }
  }
  const tree = buildTree(merged);
  let mergeSha: string;
  if (method === 'MERGE') {
    mergeSha = makeCommit(tree, [baseTip, headTip], `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`);
  } else if (method === 'REBASE') {
    // Replay the head-only commits oldest-first onto the base tip, keeping each
    // commit's tree and message; the last replayed commit is the merge result.
    const base = mergeBase(headTip, baseTip);
    const chain: string[] = [];
    let cursor: string | undefined = headTip;
    while (cursor !== undefined && cursor !== base) {
      chain.push(cursor);
      cursor = readCommit(cursor)?.parents[0];
    }
    chain.reverse();
    let tip = baseTip;
    for (const sha of chain) {
      const original = readCommit(sha);
      const originalTree = commitTree(sha);
      if (original === undefined || originalTree === undefined) continue;
      tip = makeCommit(originalTree, [tip], original.message);
    }
    mergeSha = tip;
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
  return null;
}

// ------------------------------------------------------------------ execution

function executeSelection(
  source: Entity | null,
  selection: SelectionNode[],
  variables: Record<string, unknown>,
  errors: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typename = source === null ? 'Query' : source.__typename;
  for (const node of selection) {
    if (node.kind === 'fragment') {
      if (node.typeCondition === typename || node.typeCondition === 'Node') {
        Object.assign(out, executeSelection(source, node.selection, variables, errors));
      }
      continue;
    }
    const field = node.field;
    const key = field.alias ?? field.name;
    const args: Args = {};
    for (const [argName, argValue] of field.args) args[argName] = resolveValue(argValue, variables);
    const value = resolveField(source, field, args, errors);
    out[key] = shapeValue(value, field, variables, errors);
  }
  return out;
}

function shapeValue(
  value: unknown,
  field: FieldNode,
  variables: Record<string, unknown>,
  errors: string[],
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => shapeValue(item, field, variables, errors));
  if (typeof value === 'object') {
    const entity = value as Entity;
    if (typeof entity.__typename === 'string' && field.selection !== null) {
      return executeSelection(entity, field.selection, variables, errors);
    }
    return value;
  }
  return value;
}

function runOperation(operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const errors: string[] = [];
  const root: Entity | null = operation.type === 'mutation'
    ? ({ __typename: 'Mutation' } as Entity)
    : null;
  const data = executeSelection(root, operation.selection, variables, errors);
  const response: Record<string, unknown> = { data };
  if (errors.length > 0) response.errors = errors.map((message) => ({ message }));
  return response;
}

// ------------------------------------------------------------------ HTTP

export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: Record<string, unknown>): Record<string, unknown> => {
    const query = typeof entry.query === 'string' ? entry.query : '';
    const variables = (typeof entry.variables === 'object' && entry.variables !== null ? entry.variables : {}) as Record<string, unknown>;
    try {
      const operations = parseGraphQL(query);
      const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
      const operation = operations.find((op) => operationName === null || op.name === operationName) ?? operations[0];
      if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
      return runOperation(operation, variables);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => runOne((entry ?? {}) as Record<string, unknown>));
    sendJson(res, 200, results);
    return;
  }
  sendJson(res, 200, runOne((parsed ?? {}) as Record<string, unknown>));
}
