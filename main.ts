// The forge's entry point: the trial lifecycle, and nothing else. The env beside this
// process owns the clock — this program binds an ephemeral port, tells the env where it
// bound, serves until the env says the trial is done, and exits 0. All of the forge
// itself (git smart HTTP, REST v3, GraphQL, MCP) lives under src/, behind createApp().
//
//   MAKEFUN_ENV_URL   the env's origin; without it there is no trial, so exit 1 at once
//   MAKEFUN_SHOP_TOKEN  the bearer token every API call presents; src/app.ts checks it

import { createApp } from './src/app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Backoff between retries of a register or poll: 200ms doubling to a 2s cap. */
function backoff(attempt: number): number {
  return Math.min(2000, 200 * 2 ** Math.min(attempt, 6));
}

/** POST {port} to the env until it accepts (200) or says a first register won (409). */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

/** Poll the env's /done until it answers {"done": true}; never leave before that. */
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
        attempt = 0;
      }
    } catch {
      // The env is still starting or a poll timed out: it is not done, so poll again.
    }
    await sleep(backoff(attempt));
  }
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') {
  process.stderr.write('[forge] the server did not bind an ephemeral TCP port\n');
  process.exit(1);
}
process.stdout.write(`[forge] listening on ${address.port}\n`);
await register(address.port);
process.stdout.write('[forge] registered; serving until the env says done\n');
await waitUntilDone();
server.close();
process.stdout.write('[forge] done\n');
process.exit(0);
