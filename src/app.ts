// The forge's HTTP server: one router over the four surfaces the suite drives — git
// smart HTTP at /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL at /api/graphql and
// MCP at /mcp — plus the env's health probe. Every API reply is JSON with a request id;
// every unknown route is GitHub's JSON 404, never HTML. Handlers live in their own
// modules; this file only dispatches and enforces the shared wire discipline (auth,
// malformed-JSON 400s, method handling).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleGitHttp } from './git-http.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { sendJson, readBody } from './http-util.ts';

let requestSeq = 0;

/** The token every API call must present; the env puts it in this process's environment. */
export const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** True when the request carries the trial's bearer token. */
export function authorized(req: IncomingMessage): boolean {
  return TOKEN !== '' && req.headers.authorization === `Bearer ${TOKEN}`;
}

export function createApp(): Server {
  return createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  res.setHeader('x-github-request-id', `LF-${(++requestSeq).toString(36).toUpperCase()}`);

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // The git surface carries its own auth discipline inside the protocol handlers.
  if (path.endsWith('.git') || path.includes('.git/')) {
    await handleGitHttp(req, res, url);
    return;
  }

  if (path === '/api/graphql') {
    await handleGraphql(req, res);
    return;
  }
  if (path === '/mcp') {
    await handleMcp(req, res);
    return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(req, res, url);
    return;
  }
  // Drain any body so the connection stays well-formed, then GitHub's 404.
  await readBody(req).catch(() => Buffer.alloc(0));
  sendJson(res, 404, { message: 'Not Found' });
}
