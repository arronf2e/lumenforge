// GraphQL v4 surface (stub for the first boot; the schema subset lands here next).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './http-util.ts';

export async function handleGraphql(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 404, { message: 'Not Found' });
}
