// Entrypoint: the forge's lifecycle inside a trial.
//
// The trial env owns the trial. This process only has to do three things, in order:
//   1. start the HTTP server (app.ts) on a port the kernel picks,
//   2. tell the env which port that is, so the suite can dial it,
//   3. wait until the env reports the trial finished, then stop and exit 0.
//
// The forge itself — REST, GraphQL, MCP, git smart HTTP — lives in app.ts and the
// modules it imports. Nothing in this file serves a request; if this file crashes,
// the whole trial is lost before a single check runs, so it stays small and it
// never gives up: a failed register or poll is retried forever, with a delay that
// doubles after each failure (250 ms, 500 ms, 1 s, then 2 s) until the env answers.
// Register promptly: the env expects the port within 20 seconds of boot, so the
// first attempt runs at once and retries start 250 ms apart.
// The only ways out are: no env to talk to at all (exit 1 at once), a register
// answer that says the request itself is wrong (HTTP 400/405, exit 1), or the env
// saying the trial is done (exit 0).

import { createApp } from './app.ts';

// The env's origin, for example http://store:8080 inside a trial container.
// Trailing slashes are dropped so the URLs built below stay well-formed.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One HTTP call may take at most this long before it is abandoned and retried.
const CALL_BUDGET_MS = 30_000;
// Retries start this far apart and double each time, up to MAX_WAIT_MS.
const FIRST_WAIT_MS = 250;
const MAX_WAIT_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((wake) => setTimeout(wake, ms));
}

/** Thrown by an attempt that must NOT be retried — it ends the process instead. */
class GiveUp extends Error {}

/**
 * Keep calling `attempt` until it succeeds. Between failures, wait a delay that
 * doubles each time (250 ms, 500 ms, 1 s, capped at 2 s). An attempt that throws
 * GiveUp is rethrown at once instead of being retried.
 */
async function keepTrying<T>(attempt: () => Promise<T>): Promise<T> {
  let wait = FIRST_WAIT_MS;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof GiveUp) throw err;
      await pause(wait);
      wait = Math.min(MAX_WAIT_MS, wait * 2);
    }
  }
}

/**
 * POST the bound port to the env until it is accepted. HTTP 200 is the normal
 * answer; 409 means another entry registered first, which is fine — this process
 * still waits like any other. 400/405 mean the request itself breaks the contract,
 * so give up. Any other status, or a network failure, is retried: the env may
 * still be starting.
 */
async function register(port: number): Promise<void> {
  await keepTrying(async () => {
    const res = await fetch(`${envOrigin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(CALL_BUDGET_MS),
    });
    if (res.status === 200 || res.status === 409) return;
    if (res.status === 400 || res.status === 405) {
      throw new GiveUp(`register was rejected with HTTP ${res.status}: ${await res.text()}`);
    }
    throw new Error(`register answered HTTP ${res.status}`);
  });
}

/**
 * GET /done until the env answers {"done": true}. The env answers immediately
 * ({"done": false} while the suite runs), so this is a poll: any failure, a
 * non-200 answer, or a body that does not yet say done simply means "not yet"
 * and the poll is retried.
 */
async function waitForDone(): Promise<void> {
  await keepTrying(async () => {
    const res = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(CALL_BUDGET_MS) });
    if (!res.ok) throw new Error(`done poll answered HTTP ${res.status}`);
    const body = (await res.json()) as { done?: unknown };
    if (body.done !== true) throw new Error('trial is not done yet');
  });
}

/** Start the server, register its port, then wait for the env to finish the trial. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0: the kernel picks a free port. Never bind 8080 — the env owns it.
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await register(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
