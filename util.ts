// util.ts — small HTTP helpers shared by the REST, GraphQL, MCP and git
// handlers: JSON replies, request ids, pagination links, opaque global ids.

import type { ServerResponse } from 'node:http';

let requestCounter = 0;

/** A deterministic request id: req-1, req-2, ... (no clock, no randomness). */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Send a JSON body with the standard headers. Extra headers (e.g. Link) may be added. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

/** Send a raw body (used by the git protocol, which is not JSON). */
export function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
  });
  res.end(body);
}

/** A GitHub-style error body: {"message": "<string>"}. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Read a request body fully (cap 16 MiB). Rejects on overflow. */
export function readBody(req: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 16 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a body as JSON. Returns undefined for an empty body; throws on malformed JSON. */
export function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8').trim();
  if (text === '') return undefined;
  return JSON.parse(text) as unknown;
}

/** An opaque, stable global id: base64("<Kind>:<local id>"). */
export function globalId(kind: string, local: string): string {
  return Buffer.from(`${kind}:${local}`, 'utf8').toString('base64');
}

/** Decode an opaque global id back into {kind, local}, or null. */
export function parseGlobalId(id: string): { kind: string; local: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), local: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** A cursor for offset pagination: base64("cursor:<offset>"). */
export function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

export function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export interface PageParams {
  page: number;
  perPage: number;
}

export function pageParams(query: URLSearchParams, defaultPerPage = 30): PageParams {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(query.get('per_page') ?? String(defaultPerPage), 10);
  const perPage = Math.min(100, Math.max(1, Number.isFinite(perPageRaw) ? perPageRaw : defaultPerPage));
  return { page, perPage };
}

/** Slice a list for one page; also reports whether a next page exists. */
export function paginate<T>(items: readonly T[], page: number, perPage: number): { items: T[]; hasNext: boolean; total: number } {
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), hasNext: start + perPage < items.length, total: items.length };
}

/**
 * A GitHub-style Link header for the next page. `base` is the request's origin
 * (e.g. http://127.0.0.1:4123); `path` the route; `query` the other params.
 */
export function nextLink(base: string, path: string, query: URLSearchParams, page: number, perPage: number): string {
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  return `<${base}${path}?${next.toString()}>; rel="next"`;
}

/** Whether `value` is a plain record (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The request's origin (scheme + host) for absolute URLs in Link headers. */
export function requestOrigin(req: { headers: Record<string, string | string[] | undefined> }): string {
  const host = req.headers.host;
  const hostText = Array.isArray(host) ? host[0] : host;
  return `http://${hostText ?? '127.0.0.1'}`;
}
