// Small HTTP helpers shared by every surface: JSON replies with GitHub's content type,
// request-body collection with a size cap, and JSON body parsing that reports malformed
// input instead of throwing (the wire contract answers it 400, never 500).

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** Send one JSON reply; `headers` ride beside the JSON ones. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = JSON.stringify(body) ?? 'null';
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/** Send a reply with no body at all (a 204, a git pkt-line stream sets its own type). */
export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-length': 0 });
  res.end();
}

const MAX_BODY = 64 * 1024 * 1024;

/** Collect a request body, rejecting past the cap so a bad client cannot balloon memory. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A parsed JSON body: {ok:true,value} or {ok:false} for malformed or non-object input. */
export async function readJsonBody(
  req: IncomingMessage,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}
