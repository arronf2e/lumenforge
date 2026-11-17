// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP at /mcp, speaking both
// protocol eras the clients negotiate — the 2026-07-28 server/discover revision
// (stateless, no handshake) and the legacy initialize handshake. The six GitHub
// tools share the one store with REST and GraphQL, so an object made over MCP is
// the same object over REST, ids included. tools/list is a constant, so two
// answers are byte-identical by construction.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody } from './http-util.ts';
import { authorized } from './app.ts';
import {
  VIEWER, createRepo, getRepo, branchTip, tick, newItemId, filesAt, makeCommit, setBranch,
  type Repo, type Issue, type Pull,
} from './store.ts';
import { mergeBase, buildTree } from './gitobj.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';

const SERVER_INFO = { name: 'lumenforge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name.'),
        description: stringProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: stringProp('The repository owner login.'), repo: stringProp('The repository name.') },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository\'s issues, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp('Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        body: stringProp('The pull request body.'),
        head: stringProp('The head branch name.'),
        base: stringProp('The base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

interface RpcOutcome {
  status: number;
  body: Record<string, unknown> | null; // null: no body (a notification's 202)
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): RpcOutcome {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** The viewer's repository addressed by a tool call, or null when it cannot be one. */
function addressedRepo(args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== VIEWER.login || name === '') return null;
  return getRepo(name) ?? null;
}

function missingArgs(tool: Tool, args: Record<string, unknown>): string[] {
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  return required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS_BY_NAME.get(name);
  if (tool === undefined) throw new ToolUnknown(name);
  const missing = missingArgs(tool, args);
  if (missing.length > 0) return toolFailure(`Missing required argument(s): ${missing.join(', ')}`);
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (getRepo(repoName) !== undefined) return toolFailure(`Repository ${repoName} already exists`);
      const repo = createRepo(repoName, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = addressedRepo(args);
      if (repo === null) return toolFailure('Repository not found');
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = addressedRepo(args);
      if (repo === null) return toolFailure('Repository not found');
      const labels = Array.isArray(args.labels) ? args.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return toolFailure(`Label ${label} does not exist`);
      }
      const now = tick();
      const issue: Issue = {
        id: newItemId(), number: repo.nextNumber++, title: String(args.title), body: typeof args.body === 'string' ? args.body : '',
        state: 'open', labels, comments: [], createdSec: now, updatedSec: now, isPull: false,
      };
      repo.items.set(issue.number, issue);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = addressedRepo(args);
      if (repo === null) return toolFailure('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...repo.items.values()].filter((issue) => !issue.isPull);
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      items.sort((a, b) => b.number - a.number);
      return toolResult(items.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = addressedRepo(args);
      if (repo === null) return toolFailure('Repository not found');
      const head = String(args.head).split(':').pop() as string;
      const base = String(args.base).split(':').pop() as string;
      if (branchTip(repo, head) === undefined || branchTip(repo, base) === undefined) {
        return toolFailure('Head or base branch does not exist');
      }
      const now = tick();
      const number = repo.nextNumber++;
      const pull: Pull = {
        id: newItemId(), number, title: String(args.title), body: typeof args.body === 'string' ? args.body : '',
        state: 'open', headRef: head, baseRef: base, merged: false, mergedSec: null, mergeCommitSha: null,
        createdSec: now, updatedSec: now,
      };
      repo.pulls.set(number, pull);
      repo.items.set(number, {
        id: pull.id, number, title: pull.title, body: pull.body, state: 'open', labels: [], comments: [],
        createdSec: now, updatedSec: now, isPull: true,
      });
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = addressedRepo(args);
      if (repo === null) return toolFailure('Repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolFailure('Pull request not found');
      const failure = squashMerge(repo, pull);
      if (failure !== null) return toolFailure(failure);
      return toolResult(pullJson(repo, pull));
    }
    default:
      throw new ToolUnknown(name);
  }
}

class ToolUnknown extends Error {
  constructor(name: string) {
    super(`Unknown tool: ${name}`);
  }
}

/** Squash-merge a pull request; returns a failure message or null. */
function squashMerge(repo: Repo, pull: Pull): string | null {
  if (pull.state !== 'open') return 'Pull request is not open';
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return 'A branch is missing';
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
      return 'Pull request has conflicts';
    }
  }
  const mergeSha = makeCommit(buildTree(merged), [baseTip], `${pull.title} (#${pull.number})${pull.body !== '' ? `\n\n${pull.body}` : ''}`);
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

// ------------------------------------------------------------------ dispatch

function dispatch(message: Record<string, unknown>): RpcOutcome {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      try {
        return rpcResult(id, callTool(name, args));
      } catch (err) {
        if (err instanceof ToolUnknown) return rpcError(id, -32602, err.message);
        throw err;
      }
    }
    default:
      if (isNotification) return { status: 202, body: null };
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } }));
    return;
  }
  if (!authorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }));
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  const send = (outcome: RpcOutcome): void => {
    if (outcome.body === null) {
      res.writeHead(outcome.status, { 'content-length': 0 });
      res.end();
      return;
    }
    const text = JSON.stringify(outcome.body);
    res.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (Array.isArray(parsed)) {
    const results: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      const outcome = dispatch((entry ?? {}) as Record<string, unknown>);
      if (outcome.body !== null) results.push(outcome.body);
    }
    const text = JSON.stringify(results);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return;
  }
  try {
    send(dispatch((parsed ?? {}) as Record<string, unknown>));
  } catch {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }));
  }
}
