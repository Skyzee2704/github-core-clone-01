// mcp.ts — the Model Context Protocol surface (POST /mcp, Streamable HTTP).
// Speaks the modern 2026-07-28 era: server/discover (no handshake, no
// session) plus the legacy initialize handshake for older clients. Every
// request carries the bearer token; without it the answer is HTTP 401. A body
// that is not JSON answers HTTP 400 with JSON-RPC -32700. Unknown tools answer
// -32601 (never HTTP 500); missing required arguments answer isError: true.
//
// Tools work on the same store as REST and GraphQL: a repo or issue created
// through MCP is the same object REST reads, with the same stable ids.

import type { ServerResponse } from 'node:http';
import { executeMerge } from './rest.ts';
import { VIEWER_LOGIN, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { globalId, isRecord, sendJson } from './util.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

/** The tool list is a fixed constant: two tools/list calls answer byte-identical JSON. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository (the authenticated user).' },
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'The state of the issues to list.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The name of the branch with the changes.' },
        base: { type: 'string', description: 'The name of the branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------- results

function repoResult(base: string, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    html_url: `${base}/${repo.owner}/${repo.name}`,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
  };
}

function issueResult(base: string, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullResult(base: string, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function toolOk(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function validRepoName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && !name.endsWith('.git');
}

function resolveRepo(store: Store, owner: unknown, repoName: unknown): { repo: Repo } | { error: string } {
  if (typeof owner !== 'string' || owner !== VIEWER_LOGIN) return { error: `repository ${String(owner)}/${String(repoName)} was not found` };
  if (typeof repoName !== 'string') return { error: 'repo is required' };
  const repo = store.getRepo(repoName);
  if (!repo) return { error: `repository ${owner}/${repoName} was not found` };
  return { repo };
}

// ---------------------------------------------------------------- tools/call

function callTool(store: Store, base: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    // Unknown tools are reported by the dispatcher as JSON-RPC -32601; this is
    // unreachable, but keep it total.
    return toolErr(`unknown tool: ${name}`);
  }
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolErr(`Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
      if (owner !== VIEWER_LOGIN) return toolErr(`cannot create a repository under ${owner}`);
      if (!validRepoName(repoName)) return toolErr(`invalid repository name: ${repoName}`);
      if (store.getRepo(repoName)) return toolErr(`repository ${VIEWER_LOGIN}/${repoName} already exists`);
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      const repo = store.createRepo(repoName, description, isPrivate);
      return toolOk(repoResult(base, repo));
    }
    case 'get_repo': {
      const resolved = resolveRepo(store, args.owner, args.repo);
      if ('error' in resolved) return toolErr(resolved.error);
      return toolOk(repoResult(base, resolved.repo));
    }
    case 'create_issue': {
      const resolved = resolveRepo(store, args.owner, args.repo);
      if ('error' in resolved) return toolErr(resolved.error);
      const title = String(args.title);
      const body = typeof args.body === 'string' ? args.body : '';
      const issue = store.createIssue(resolved.repo, title, body, []);
      return toolOk(issueResult(base, resolved.repo, issue));
    }
    case 'list_issues': {
      const resolved = resolveRepo(store, args.owner, args.repo);
      if ('error' in resolved) return toolErr(resolved.error);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...resolved.repo.issues.values()]
        .filter((issue) => (state === 'all' ? true : issue.state === state))
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueResult(base, resolved.repo, issue));
      return toolOk(issues);
    }
    case 'create_pull_request': {
      const resolved = resolveRepo(store, args.owner, args.repo);
      if ('error' in resolved) return toolErr(resolved.error);
      const title = String(args.title);
      const body = typeof args.body === 'string' ? args.body : '';
      const head = String(args.head);
      const baseRef = String(args.base);
      const pull = store.createPull(resolved.repo, title, body, head, baseRef);
      if (!pull) return toolErr(`head or base branch does not exist: ${head} / ${baseRef}`);
      return toolOk(pullResult(base, resolved.repo, pull));
    }
    case 'merge_pull_request': {
      const resolved = resolveRepo(store, args.owner, args.repo);
      if ('error' in resolved) return toolErr(resolved.error);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pull = resolved.repo.pulls.get(number);
      if (!pull) return toolErr(`pull request #${String(args.pull_number)} was not found`);
      if (pull.merged) return toolErr(`pull request #${number} is already merged`);
      const result = executeMerge(store, resolved.repo, pull, 'merge');
      if ('error' in result) return toolErr(result.error);
      return toolOk(pullResult(base, resolved.repo, pull));
    }
    default:
      return toolErr(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- HTTP

function bearerToken(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(value.trim());
  return match ? (match[1] as string) : null;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/** Handle POST /mcp. */
export async function handleMcp(
  store: Store,
  token: string,
  base: string,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  res: ServerResponse,
): Promise<void> {
  // A body that is not JSON answers HTTP 400 with JSON-RPC -32700.
  let request: JsonRpcRequest;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!isRecord(parsed)) throw new Error('not an object');
    request = parsed as JsonRpcRequest;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  // No Authorization answers HTTP 401.
  const presented = bearerToken(headers);
  if (presented === null || presented !== token) {
    sendJson(res, 401, rpcError(request.id, -32001, 'Unauthorized'));
    return;
  }

  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};

  // Notifications carry no id and get no JSON-RPC answer.
  if (method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    sendJson(res, 200, rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    }));
    return;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    sendJson(res, 200, rpcResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return;
  }

  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return;
  }

  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
    return;
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    if (!TOOLS.some((tool) => tool.name === toolName)) {
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${toolName}`));
      return;
    }
    const result = callTool(store, base, toolName, args);
    sendJson(res, 200, rpcResult(id, result));
    return;
  }

  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
}
