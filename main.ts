// main.ts — the entrypoint. One process, in-memory store, stdlib only.
//
// Lifecycle (the suite's contract): bind an ephemeral port, register it with
// the environment, then long-poll until the trial is done and exit 0. A
// program that exits, crashes, or never registers before the boot budget
// scores 0. When MAKEFUN_ENV_URL is unset (a local run), the server just
// serves until it is killed.
//
// [forge] the git forge boots here — listening log below is this entry's own line.

import { createApp } from './app.ts';
import { Store } from './store.ts';

const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const envUrl = process.env.MAKEFUN_ENV_URL ?? '';

const store = new Store();
const server = createApp(store, token);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  // Retry until the environment accepts the registration; giving up early
  // would zero the trial, so this loop has no deadline of its own.
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return;
    } catch {
      // The environment is not up yet; try again.
    }
    await sleep(500);
  }
}

async function waitDone(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A failed poll is not a done signal; keep waiting.
    }
    await sleep(500);
  }
}

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`[forge] listening on port ${port}`);
  void (async () => {
    if (envUrl !== '') {
      await register(port);
      await waitDone();
      server.close(() => process.exit(0));
      // If the server does not close promptly, exit anyway.
      setTimeout(() => process.exit(0), 2000).unref();
    }
    // No environment URL: serve until killed (local runs, manual testing).
  })();
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
