// app.ts — the HTTP server and router. One process, one store. Every reply
// carries X-GitHub-Request-Id (set before routing, so even 401s and 404s have
// one) and answers JSON, except the git protocol endpoints, which speak
// pkt-lines and packfiles.
//
//   GET  /healthz                  liveness (no auth)
//   /api/v3/*                      GitHub REST v3 (rest.ts)
//   POST /api/graphql              GraphQL v4 (graphql.ts)
//   POST /mcp                      MCP Streamable HTTP (mcp.ts)
//   /{owner}/{repo}.git/*          smart-HTTP git (gitproto.ts)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './gitproto.ts';
import type { Store } from './store.ts';
import { nextRequestId, readBody, requestOrigin, sendError, sendJson } from './util.ts';

export function createApp(store: Store, token: string): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(store, token, req, res).catch((err: unknown) => {
      // Never leave a request hanging: an unexpected bug answers 500 JSON.
      try {
        if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        else res.end();
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
  return server;
}

async function handleRequest(store: Store, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  res.setHeader('X-GitHub-Request-Id', requestId);
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const segments = url.pathname.split('/').filter((part) => part !== '');
  const method = req.method ?? 'GET';
  const base = requestOrigin(req);
  const headers = req.headers as Record<string, string | string[] | undefined>;

  if (method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = hasBody ? await readBody(req) : Buffer.alloc(0);

  if (segments[0] === 'api' && segments[1] === 'v3') {
    await handleRest({ store, token, method, segments, query: url.searchParams, headers, body, base, res });
    return;
  }

  if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    await handleGraphQL(store, token, headers, body, res);
    return;
  }

  if (segments[0] === 'mcp' && segments.length === 1) {
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    await handleMcp(store, token, base, headers, body, res);
    return;
  }

  if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
    await handleGit({ store, token, method, segments, query: url.searchParams, headers, body, res });
    return;
  }

  sendError(res, 404, 'Not Found');
}
