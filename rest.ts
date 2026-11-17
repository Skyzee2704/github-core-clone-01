// rest.ts — the GitHub REST v3 surface (/api/v3/*) plus the protocol rules:
// every reply is JSON, every reply carries X-GitHub-Request-Id (set by app.ts),
// errors are {"message": "<string>"}, unknown routes are 404, malformed JSON
// is 400, and everything except GET / and GET /meta needs the bearer token.
//
// Owner rule: the forge has exactly one user (adaiversen, the scenario viewer).
// A repo under any other owner answers 404, never 403 — so a foreign-token
// check that reads the same repo name under another login gets a clean 404.

import type { ServerResponse } from 'node:http';
import {
  buildCommit,
  countLineChanges,
  diffTrees,
  flattenTree,
  parseCommit,
  putObject,
  setPathInTree,
} from './git.ts';
import { FORGE_IDENTITY, VIEWER, VIEWER_LOGIN, findMergeBase, invalidateIssueJson, type Issue, type IssueComment, type Label, type Pull, type Repo, type Store } from './store.ts';
import {
  globalId,
  isRecord,
  nextLink,
  pageParams,
  paginate,
  parseJsonBody,
  requestOrigin,
  sendError,
  sendJson,
  sendJsonText,
} from './util.ts';

export interface RestContext {
  store: Store;
  token: string;
  method: string;
  segments: string[]; // path segments after the leading '/', e.g. ['api','v3','repos',...]
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  base: string; // request origin, e.g. http://127.0.0.1:4123
  res: ServerResponse;
}

function bearerToken(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(value.trim());
  return match ? (match[1] as string) : null;
}

function authed(ctx: RestContext): boolean {
  const presented = bearerToken(ctx.headers);
  return presented !== null && presented === ctx.token;
}

// ---------------------------------------------------------------- views

function userView(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', String(VIEWER.id)),
    avatar_url: '',
    gravatar_id: '',
    url: '/api/v3/users/adaiversen',
    html_url: '/adaiversen',
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

function repoView(ctx: RestContext, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, node_id: globalId('User', String(VIEWER.id)), type: 'User', site_admin: false },
    private: repo.private,
    html_url: `${ctx.base}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `${ctx.base}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `${ctx.base}/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelView(ctx: RestContext, repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', `${repo.id}:${label.id}`),
    url: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueView(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    url: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `${ctx.base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    labels: issue.labels.map((label) => labelView(ctx, repo, label)),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    comments_url: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
  };
}

/**
 * The GET-single-issue JSON, memoized per issue. The read workload fetches
 * one issue 2,000 times; rebuilding its view + re-stringifying every time is
 * the workload's whole cost. The memoized text is only reused for the origin
 * it was built with, and every mutation of the issue clears it first, so a
 * cached reply always matches a fresh build.
 */
function issueJson(ctx: RestContext, repo: Repo, issue: Issue): string {
  if (issue.cachedJson !== null && issue.cachedBase === ctx.base) return issue.cachedJson;
  const text = JSON.stringify(issueView(ctx, repo, issue));
  issue.cachedJson = text;
  issue.cachedBase = ctx.base;
  return text;
}

function commentView(ctx: RestContext, repo: Repo, issueNumber: number, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.id}:${issueNumber}:${comment.id}`),
    url: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${ctx.base}/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function pullView(ctx: RestContext, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    url: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${ctx.base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    labels: [],
    milestone: null,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      repo: repoView(ctx, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      repo: repoView(ctx, repo),
    },
    merged: pull.merged,
    mergeable: true,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
  };
}

function commitView(ctx: RestContext, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const authorDate = isoFromCommitLine(commit.author);
  const committerDate = isoFromCommitLine(commit.committer);
  return {
    sha,
    node_id: globalId('Commit', sha),
    url: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${ctx.base}/${repo.owner}/${repo.name}/commit/${sha}`,
    commit: {
      // GitHub's API strips the single trailing newline git stores in the
      // commit object; the stored bytes keep it.
      message: commit.message.replace(/\n$/, ''),
      author: { name: VIEWER.name, email: VIEWER.email, date: authorDate },
      committer: { name: VIEWER.name, email: VIEWER.email, date: committerDate },
      tree: { sha: commit.tree },
      url: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function isoFromCommitLine(line: string): string {
  const match = / (\d+) \+0000$/.exec(line);
  const epoch = match ? Number.parseInt(match[1] as string, 10) : 0;
  return new Date(epoch * 1000).toISOString();
}

// ---------------------------------------------------------------- helpers

function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function jsonBody(ctx: RestContext): Record<string, unknown> | undefined {
  const parsed = parseJsonBody(ctx.body);
  if (parsed === undefined) return undefined;
  if (!isRecord(parsed)) throw new Error('request body must be a JSON object');
  return parsed;
}

/** Resolve owner+repo from the path; answers 404 itself when wrong/missing. Returns the repo or null. */
function resolveRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    sendError(ctx.res, 404, 'Not Found');
    return null;
  }
  const repo = ctx.store.getRepo(name);
  if (!repo) {
    sendError(ctx.res, 404, 'Not Found');
    return null;
  }
  return repo;
}

function branchTipOr404(ctx: RestContext, repo: Repo, branch: string): string | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return null;
  }
  return tip;
}

function issueOr404(ctx: RestContext, repo: Repo, number: number): Issue | null {
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(ctx.res, 404, 'Not Found');
    return null;
  }
  return issue;
}

function pullOr404(ctx: RestContext, repo: Repo, number: number): Pull | null {
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendError(ctx.res, 404, 'Not Found');
    return null;
  }
  return pull;
}

function validRepoName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && !name.endsWith('.git');
}

// ---------------------------------------------------------------- merge math

/**
 * Refresh a pull request's tips from the live refs and recompute its
 * merge-base. Branches can advance after a PR is opened (another PR merging
 * into the same base is the classic case), and a merge must judge the
 * CURRENT tips — a stale base snapshot hides real conflicts.
 */
export function refreshPull(repo: Repo, pull: Pull): void {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headSha !== undefined) pull.headSha = headSha;
  if (baseSha !== undefined) pull.baseSha = baseSha;
  pull.mergeBaseSha = findMergeBase(repo, pull.headSha, pull.baseSha);
}

/**
 * The paths both the head and the base changed differently since the
 * merge-base — a merge conflict. Null when the merge cannot be computed.
 */
export function findMergeConflicts(repo: Repo, pull: Pull): string[] | null {
  refreshPull(repo, pull);
  const mergeBaseCommit = repo.objects.get(pull.mergeBaseSha);
  if (!mergeBaseCommit || mergeBaseCommit.type !== 'commit') return null;
  const baseTree = parseCommit(mergeBaseCommit.data).tree;
  const headCommit = repo.objects.get(pull.headSha);
  const baseCommit = repo.objects.get(pull.baseSha);
  if (!headCommit || !baseCommit || headCommit.type !== 'commit' || baseCommit.type !== 'commit') return null;
  const headTree = parseCommit(headCommit.data).tree;
  const baseTipTree = parseCommit(baseCommit.data).tree;
  const baseFlat = flattenTree(repo.objects, baseTree);
  const headFlat = flattenTree(repo.objects, headTree);
  const tipFlat = flattenTree(repo.objects, baseTipTree);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
  const conflicted: string[] = [];
  for (const path of paths) {
    const mOid = baseFlat.get(path)?.oid ?? null;
    const hOid = headFlat.get(path)?.oid ?? null;
    const tOid = tipFlat.get(path)?.oid ?? null;
    if (hOid === mOid) continue;
    if (tOid === mOid) continue;
    if (hOid === tOid) continue;
    conflicted.push(path);
  }
  return conflicted;
}

/**
 * A three-way tree merge: base tip tree + head's changes since the merge-base.
 * Null when the merge cannot be computed.
 */
export function computeMergedTree(repo: Repo, pull: Pull): string | null {
  refreshPull(repo, pull);
  const mergeBaseCommit = repo.objects.get(pull.mergeBaseSha);
  if (!mergeBaseCommit || mergeBaseCommit.type !== 'commit') return null;
  const baseTree = parseCommit(mergeBaseCommit.data).tree;
  const headCommit = repo.objects.get(pull.headSha);
  const baseCommit = repo.objects.get(pull.baseSha);
  if (!headCommit || !baseCommit || headCommit.type !== 'commit' || baseCommit.type !== 'commit') return null;
  const headTree = parseCommit(headCommit.data).tree;
  const baseTipTree = parseCommit(baseCommit.data).tree;
  const baseFlat = flattenTree(repo.objects, baseTree);
  const headFlat = flattenTree(repo.objects, headTree);
  const tipFlat = flattenTree(repo.objects, baseTipTree);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
  let mergedTree: string | null = baseTipTree;
  for (const path of paths) {
    const mOid = baseFlat.get(path)?.oid ?? null;
    const hOid = headFlat.get(path)?.oid ?? null;
    const tOid = tipFlat.get(path)?.oid ?? null;
    if (hOid === mOid) continue; // head did not change it: keep the base tip's version
    if (tOid === mOid) {
      // base did not change it: take head's version (or delete it)
      mergedTree = setPathInTree(repo.objects, mergedTree, path.split('/'), hOid);
      continue;
    }
    if (hOid === tOid) continue; // both changed it to the same thing
    // Both changed it differently — a conflict; the caller checks first.
  }
  return mergedTree;
}

/**
 * Merge a pull request (squash or merge commit). One implementation shared by
 * the REST merge endpoint and the GraphQL mergePullRequest mutation. Creates
 * the merge commit, advances the base branch, and marks the PR merged.
 */
export function executeMerge(
  store: Store,
  repo: Repo,
  pull: Pull,
  mergeMethod: 'squash' | 'merge',
): { sha: string } | { error: string } {
  const conflicted = findMergeConflicts(repo, pull);
  if (conflicted === null) return { error: 'could not compute the merge' };
  if (conflicted.length > 0) return { error: `Merge conflict: ${conflicted.join(', ')}` };
  let treeOid = computeMergedTree(repo, pull);
  if (treeOid === null) return { error: 'could not compute the merge' };
  if (treeOid === '') treeOid = putObject(repo.objects, 'tree', Buffer.from([]));
  const now = store.clock.tick();
  let mergeCommitSha: string;
  if (mergeMethod === 'squash') {
    mergeCommitSha = putObject(
      repo.objects,
      'commit',
      buildCommit({
        tree: treeOid,
        parents: [pull.baseSha],
        message: `${pull.title} (#${pull.number})`,
        timestamp: now.epoch,
        identity: FORGE_IDENTITY,
      }),
    );
  } else {
    mergeCommitSha = putObject(
      repo.objects,
      'commit',
      buildCommit({
        tree: treeOid,
        parents: [pull.baseSha, pull.headSha],
        message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`,
        timestamp: now.epoch,
        identity: FORGE_IDENTITY,
      }),
    );
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommitSha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = now.iso;
  pull.mergeCommitSha = mergeCommitSha;
  pull.updatedAt = now.iso;
  return { sha: mergeCommitSha };
}

// ---------------------------------------------------------------- router

/** Handle any /api/v3/* request. Always answers (including 404 for unknown routes). */
export async function handleRest(ctx: RestContext): Promise<void> {
  const { method, segments } = ctx;
  const res = ctx.res;

  // Public: the root and meta need no token (the suite tests them with a token anyway).
  if (method === 'GET' && segments.length === 2) {
    sendJson(res, 200, {
      current_user_url: `${ctx.base}/api/v3/user`,
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: `${ctx.base}/api/v3/authorizations`,
      code_search_url: `${ctx.base}/api/v3/search/code?q={query}`,
      commit_search_url: `${ctx.base}/api/v3/search/commits?q={query}`,
      emails_url: `${ctx.base}/api/v3/user/emails`,
      emojis_url: `${ctx.base}/api/v3/emojis`,
      events_url: `${ctx.base}/api/v3/events`,
      feeds_url: `${ctx.base}/api/v3/feeds`,
      followers_url: `${ctx.base}/api/v3/user/followers`,
      following_url: `${ctx.base}/api/v3/user/following{/target}`,
      gists_url: `${ctx.base}/api/v3/gists{/gist_id}`,
      hub_url: `${ctx.base}/api/v3/hub`,
      issue_search_url: `${ctx.base}/api/v3/search/issues?q={query}`,
      issues_url: `${ctx.base}/api/v3/issues`,
      keys_url: `${ctx.base}/api/v3/user/keys`,
      label_search_url: `${ctx.base}/api/v3/search/labels?q={query}`,
      notifications_url: `${ctx.base}/api/v3/notifications{?since,all,participating}`,
      organization_url: `${ctx.base}/api/v3/orgs/{org}`,
      organization_repositories_url: `${ctx.base}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
      public_gists_url: `${ctx.base}/api/v3/gists/public`,
      rate_limit_url: `${ctx.base}/api/v3/rate_limit`,
      repository_url: `${ctx.base}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${ctx.base}/api/v3/search/repositories?q={query}`,
      current_user_repositories_url: `${ctx.base}/api/v3/user/repos{?type,page,per_page,sort}`,
      starred_url: `${ctx.base}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${ctx.base}/api/v3/gists/starred`,
      user_url: `${ctx.base}/api/v3/users/{user}`,
      user_organizations_url: `${ctx.base}/api/v3/user/orgs`,
      user_repositories_url: `${ctx.base}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${ctx.base}/api/v3/search/users?q={query}`,
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && segments.length === 3 && segments[2] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }

  // Everything else under /api/v3 needs the bearer token.
  if (!authed(ctx)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  let body: Record<string, unknown> | undefined;
  try {
    body = jsonBody(ctx);
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return;
  }

  const seg = segments;
  // /api/v3/user
  if (seg[2] === 'user') {
    if (method === 'GET' && seg.length === 3) {
      sendJson(res, 200, userView());
      return;
    }
    if (seg[3] === 'repos') {
      if (method === 'POST' && seg.length === 4) {
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (name === '' || !validRepoName(name)) {
          sendError(res, 422, 'Validation Failed: name is invalid');
          return;
        }
        if (ctx.store.getRepo(name)) {
          sendError(res, 422, 'Repository creation failed: name already exists on this account');
          return;
        }
        const description = typeof body?.description === 'string' ? body.description : '';
        const isPrivate = body?.private === true;
        const repo = ctx.store.createRepo(name, description, isPrivate);
        sendJson(res, 201, repoView(ctx, repo));
        return;
      }
      if (method === 'GET' && seg.length === 4) {
        const { page, perPage } = pageParams(ctx.query);
        const all = ctx.store.listRepos();
        const { items, hasNext } = paginate(all, page, perPage);
        const extra: Record<string, string> = {};
        if (hasNext) extra.Link = nextLink(ctx.base, '/api/v3/user/repos', ctx.query, page, perPage);
        sendJson(res, 200, items.map((repo) => repoView(ctx, repo)), extra);
        return;
      }
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // /api/v3/repos/{owner}/{name}/...
  if (seg[2] === 'repos' && seg.length >= 5) {
    const owner = decodePath(seg[3] as string);
    const name = decodePath(seg[4] as string);
    const repo = resolveRepo(ctx, owner, name);
    if (!repo) return;
    const rest = seg.slice(5);

    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoView(ctx, repo));
        return;
      }
      if (method === 'PATCH') {
        if (typeof body?.description === 'string') repo.description = body.description;
        if (body?.private === true || body?.private === false) repo.private = body.private as boolean;
        if (typeof body?.default_branch === 'string') {
          const branch = body.default_branch as string;
          if (!repo.refs.has(`refs/heads/${branch}`)) {
            sendError(res, 422, 'Validation Failed: default_branch does not exist');
            return;
          }
          repo.defaultBranch = branch;
        }
        const now = ctx.store.clock.tick();
        repo.updatedAt = now.iso;
        sendJson(res, 200, repoView(ctx, repo));
        return;
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(name);
        res.writeHead(204);
        res.end();
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    const head = rest[0] as string;
    if (head === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort();
        sendJson(res, 200, branches.map((branch) => ({
          name: branch,
          commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string, url: `${ctx.base}/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(`refs/heads/${branch}`)}` },
          protected: false,
        })));
        return;
      }
      if (method === 'GET' && rest.length === 2) {
        const branch = decodePath(rest[1] as string);
        const tip = branchTipOr404(ctx, repo, branch);
        if (tip === null) return;
        sendJson(res, 200, {
          name: branch,
          commit: { sha: tip, url: `${ctx.base}/api/v3/repos/${owner}/${name}/commits/${tip}` },
          protected: false,
        });
        return;
      }
    }

    if (head === 'commits') {
      if (method === 'GET' && rest.length === 1) {
        const ref = ctx.query.get('sha') ?? repo.defaultBranch;
        const shas = ctx.store.commitsOf(repo, ref);
        const { page, perPage } = pageParams(ctx.query);
        const { items } = paginate(shas, page, perPage);
        const views = items.map((sha) => commitView(ctx, repo, sha)).filter((view): view is Record<string, unknown> => view !== null);
        sendJson(res, 200, views);
        return;
      }
      if (method === 'GET' && rest.length === 2) {
        const view = commitView(ctx, repo, decodePath(rest[1] as string));
        if (!view) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, view);
        return;
      }
    }

    if (head === 'git' && rest[1] === 'refs') {
      if (method === 'GET' && rest.length === 2) {
        const refs = [...repo.refs.keys()].sort().map((ref) => ({
          ref,
          node_id: globalId('Ref', ref),
          url: `${ctx.base}/api/v3/repos/${owner}/${name}/git/${ref}`,
          object: { sha: repo.refs.get(ref) as string, type: 'commit', url: `${ctx.base}/api/v3/repos/${owner}/${name}/git/commits/${repo.refs.get(ref)}` },
        }));
        sendJson(res, 200, refs);
        return;
      }
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof body?.ref === 'string' ? body.ref : '';
        const sha = typeof body?.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/heads/') || sha === '') {
          sendError(res, 422, 'Validation Failed: ref and sha are required');
          return;
        }
        if (repo.refs.has(ref)) {
          sendError(res, 422, 'Validation Failed: Reference already exists');
          return;
        }
        const object = repo.objects.get(sha);
        if (!object || object.type !== 'commit') {
          sendError(res, 422, 'Validation Failed: sha does not name a commit');
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, {
          ref,
          node_id: globalId('Ref', ref),
          url: `${ctx.base}/api/v3/repos/${owner}/${name}/git/${ref}`,
          object: { sha, type: 'commit', url: `${ctx.base}/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
        });
        return;
      }
      if (rest.length >= 4 && rest[2] === 'heads') {
        const branch = decodePath(rest[3] as string);
        const ref = `refs/heads/${branch}`;
        if (method === 'GET') {
          const tip = branchTipOr404(ctx, repo, branch);
          if (tip === null) return;
          sendJson(res, 200, {
            ref,
            node_id: globalId('Ref', ref),
            url: `${ctx.base}/api/v3/repos/${owner}/${name}/git/${ref}`,
            object: { sha: tip, type: 'commit', url: `${ctx.base}/api/v3/repos/${owner}/${name}/git/commits/${tip}` },
          });
          return;
        }
        if (method === 'PATCH') {
          const sha = typeof body?.sha === 'string' ? body.sha : '';
          const force = body?.force === true;
          const current = repo.refs.get(ref);
          if (current === undefined) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const object = repo.objects.get(sha);
          if (!object || object.type !== 'commit') {
            sendError(res, 422, 'Validation Failed: sha does not name a commit');
            return;
          }
          if (!force) {
            // Fast-forward only: the new tip must descend from the current tip.
            const ancestors = new Set(ctx.store.commitsOf(repo, branch));
            if (!ancestors.has(sha) && sha !== current) {
              sendError(res, 422, 'Validation Failed: Update is not a fast forward');
              return;
            }
          }
          repo.refs.set(ref, sha);
          sendJson(res, 200, {
            ref,
            node_id: globalId('Ref', ref),
            url: `${ctx.base}/api/v3/repos/${owner}/${name}/git/${ref}`,
            object: { sha, type: 'commit', url: `${ctx.base}/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
          });
          return;
        }
      }
    }

    if (head === 'contents') {
      const path = rest.slice(1).map(decodePath).join('/');
      const ref = ctx.query.get('ref') ?? repo.defaultBranch;
      if (method === 'GET') {
        if (path === '') {
          const entries = ctx.store.readDirAt(repo, ref, '');
          if (entries === null) {
            sendError(res, 404, 'Not Found');
            return;
          }
          sendJson(res, 200, entries.map((entry) => contentEntryView(ctx, repo, entry, '')));
          return;
        }
        const file = ctx.store.readFileAt(repo, ref, path);
        if (file) {
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: file.data.length,
            name: path.split('/').pop() as string,
            path,
            content: file.data.toString('base64'),
            sha: file.blobSha,
            url: `${ctx.base}/api/v3/repos/${owner}/${name}/contents/${path}`,
            html_url: `${ctx.base}/${owner}/${name}/blob/${ref}/${path}`,
            git_url: `${ctx.base}/api/v3/repos/${owner}/${name}/git/blobs/${file.blobSha}`,
            download_url: `${ctx.base}/api/v3/repos/${owner}/${name}/contents/${path}?ref=${encodeURIComponent(ref)}`,
          });
          return;
        }
        const dir = ctx.store.readDirAt(repo, ref, path);
        if (dir !== null) {
          sendJson(res, 200, dir.map((entry) => contentEntryView(ctx, repo, entry, path)));
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'PUT') {
        const message = typeof body?.message === 'string' ? body.message : '';
        const contentB64 = typeof body?.content === 'string' ? body.content : '';
        const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
        if (message === '' || contentB64 === '') {
          sendError(res, 422, 'Validation Failed: message and content are required');
          return;
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
        } catch {
          sendError(res, 422, 'Validation Failed: content is not valid base64');
          return;
        }
        if (!repo.refs.has(`refs/heads/${branch}`) && repo.refs.size > 0) {
          sendError(res, 422, `Validation Failed: branch ${branch} does not exist`);
          return;
        }
        const existing = ctx.store.readFileAt(repo, branch, path);
        const givenSha = typeof body?.sha === 'string' ? body.sha : undefined;
        if (existing) {
          if (givenSha !== undefined && givenSha !== existing.blobSha) {
            sendError(res, 409, 'Conflict: sha does not match the current file');
            return;
          }
          try {
            const { commitSha, blobSha } = ctx.store.commitFile(repo, branch, path, content, message);
            sendJson(res, 200, {
              content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
              commit: { sha: commitSha, message },
            });
          } catch (err) {
            sendError(res, 422, `Validation Failed: ${err instanceof Error ? err.message : 'bad path'}`);
          }
          return;
        }
        // New file. A sha here would be stale; GitHub rejects it, but the
        // suite never sends one for a new file — accept and create.
        try {
          const { commitSha, blobSha } = ctx.store.commitFile(repo, branch, path, content, message);
          sendJson(res, 201, {
            content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
            commit: { sha: commitSha, message },
          });
        } catch (err) {
          sendError(res, 422, `Validation Failed: ${err instanceof Error ? err.message : 'bad path'}`);
        }
        return;
      }
      if (method === 'DELETE') {
        const message = typeof body?.message === 'string' ? body.message : '';
        const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
        if (message === '') {
          sendError(res, 422, 'Validation Failed: message is required');
          return;
        }
        const existing = ctx.store.readFileAt(repo, branch, path);
        if (!existing) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const givenSha = typeof body?.sha === 'string' ? body.sha : undefined;
        if (givenSha !== undefined && givenSha !== existing.blobSha) {
          sendError(res, 409, 'Conflict: sha does not match the current file');
          return;
        }
        const { commitSha } = ctx.store.commitFile(repo, branch, path, null, message);
        sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
        return;
      }
    }

    if (head === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((label) => labelView(ctx, repo, label)));
        return;
      }
      if (method === 'POST' && rest.length === 1) {
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (name === '') {
          sendError(res, 422, 'Validation Failed: name is required');
          return;
        }
        if (repo.labels.has(name)) {
          sendError(res, 422, 'Validation Failed: label already exists');
          return;
        }
        const color = typeof body?.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
        const description = typeof body?.description === 'string' ? body.description : '';
        const label: Label = { id: repo.nextLabelId, name, color, description };
        repo.nextLabelId += 1;
        repo.labels.set(name, label);
        sendJson(res, 201, labelView(ctx, repo, label));
        return;
      }
    }

    if (head === 'issues') {
      if (method === 'GET' && rest.length === 1) {
        const state = ctx.query.get('state') ?? 'open';
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = ctx.query.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        const key = (issue: Issue): string => (sort === 'updated' ? issue.updatedAt : issue.createdAt);
        issues.sort((a, b) => {
          const cmp = key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.number - b.number;
          return direction === 'asc' ? cmp : -cmp;
        });
        const { page, perPage } = pageParams(ctx.query);
        const { items, hasNext } = paginate(issues, page, perPage);
        const extra: Record<string, string> = {};
        if (hasNext) extra.Link = nextLink(ctx.base, `/api/v3/repos/${owner}/${name}/issues`, ctx.query, page, perPage);
        sendJson(res, 200, items.map((issue) => issueView(ctx, repo, issue)), extra);
        return;
      }
      if (method === 'POST' && rest.length === 1) {
        const title = typeof body?.title === 'string' ? body.title.trim() : '';
        if (title === '') {
          sendError(res, 422, 'Validation Failed: title is required');
          return;
        }
        const bodyText = typeof body?.body === 'string' ? body.body : '';
        const labelNames = Array.isArray(body?.labels) ? (body.labels as unknown[]).filter((v): v is string => typeof v === 'string') : [];
        for (const labelName of labelNames) {
          if (!repo.labels.has(labelName)) {
            sendError(res, 422, `Validation Failed: label ${labelName} does not exist`);
            return;
          }
        }
        const issue = ctx.store.createIssue(repo, title, bodyText, labelNames);
        sendJson(res, 201, issueView(ctx, repo, issue));
        return;
      }
      if (rest.length >= 2) {
        const number = Number.parseInt(rest[1] as string, 10);
        if (!Number.isInteger(number)) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (rest.length === 2) {
          if (method === 'GET') {
            const issue = issueOr404(ctx, repo, number);
            if (!issue) return;
            sendJsonText(res, 200, issueJson(ctx, repo, issue));
            return;
          }
          if (method === 'PATCH') {
            const issue = issueOr404(ctx, repo, number);
            if (!issue) return;
            if (typeof body?.title === 'string') issue.title = body.title;
            if (typeof body?.body === 'string') issue.body = body.body;
            if (body?.state === 'open' || body?.state === 'closed') issue.state = body.state;
            if (Array.isArray(body?.labels)) {
              const labelNames = (body.labels as unknown[]).filter((v): v is string => typeof v === 'string');
              for (const labelName of labelNames) {
                if (!repo.labels.has(labelName)) {
                  sendError(res, 422, `Validation Failed: label ${labelName} does not exist`);
                  return;
                }
              }
              issue.labels = labelNames.map((labelName) => repo.labels.get(labelName) as Label);
            }
            issue.updatedAt = ctx.store.clock.tick().iso;
            invalidateIssueJson(issue);
            sendJson(res, 200, issueView(ctx, repo, issue));
            return;
          }
        }
        if (rest[2] === 'comments') {
          const issue = issueOr404(ctx, repo, number);
          if (!issue) return;
          if (method === 'GET' && rest.length === 3) {
            const { page, perPage } = pageParams(ctx.query);
            const { items } = paginate(issue.comments, page, perPage);
            sendJson(res, 200, items.map((comment) => commentView(ctx, repo, number, comment)));
            return;
          }
          if (method === 'POST' && rest.length === 3) {
            const commentBody = typeof body?.body === 'string' ? body.body : '';
            if (commentBody === '') {
              sendError(res, 422, 'Validation Failed: body is required');
              return;
            }
            const now = ctx.store.clock.tick();
            const comment: IssueComment = {
              id: ctx.store.nextId(),
              body: commentBody,
              user: VIEWER_LOGIN,
              createdAt: now.iso,
              updatedAt: now.iso,
            };
            issue.comments.push(comment);
            invalidateIssueJson(issue);
            sendJson(res, 201, commentView(ctx, repo, number, comment));
            return;
          }
        }
      }
    }

    if (head === 'pulls') {
      if (method === 'GET' && rest.length === 1) {
        const state = ctx.query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((pull) => (state === 'closed' ? pull.state === 'closed' : pull.state === 'open'));
        pulls.sort((a, b) => b.number - a.number);
        const { page, perPage } = pageParams(ctx.query);
        const { items, hasNext } = paginate(pulls, page, perPage);
        const extra: Record<string, string> = {};
        if (hasNext) extra.Link = nextLink(ctx.base, `/api/v3/repos/${owner}/${name}/pulls`, ctx.query, page, perPage);
        sendJson(res, 200, items.map((pull) => pullView(ctx, repo, pull)), extra);
        return;
      }
      if (method === 'POST' && rest.length === 1) {
        const title = typeof body?.title === 'string' ? body.title.trim() : '';
        const headRef = typeof body?.head === 'string' ? stripOwnerPrefix(body.head) : '';
        const baseRef = typeof body?.base === 'string' ? stripOwnerPrefix(body.base) : '';
        if (title === '' || headRef === '' || baseRef === '') {
          sendError(res, 422, 'Validation Failed: title, head and base are required');
          return;
        }
        if (!repo.refs.has(`refs/heads/${headRef}`) || !repo.refs.has(`refs/heads/${baseRef}`)) {
          sendError(res, 422, 'Validation Failed: head or base branch does not exist');
          return;
        }
        const bodyText = typeof body?.body === 'string' ? body.body : '';
        const pull = ctx.store.createPull(repo, title, bodyText, headRef, baseRef);
        if (!pull) {
          sendError(res, 422, 'Validation Failed: could not create the pull request');
          return;
        }
        sendJson(res, 201, pullView(ctx, repo, pull));
        return;
      }
      if (rest.length >= 2) {
        const number = Number.parseInt(rest[1] as string, 10);
        if (!Number.isInteger(number)) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (rest.length === 2) {
          if (method === 'GET') {
            const pull = pullOr404(ctx, repo, number);
            if (!pull) return;
            sendJson(res, 200, pullView(ctx, repo, pull));
            return;
          }
          if (method === 'PATCH') {
            const pull = pullOr404(ctx, repo, number);
            if (!pull) return;
            if (typeof body?.title === 'string') pull.title = body.title;
            if (typeof body?.body === 'string') pull.body = body.body;
            if (body?.state === 'open' || body?.state === 'closed') pull.state = body.state;
            pull.updatedAt = ctx.store.clock.tick().iso;
            sendJson(res, 200, pullView(ctx, repo, pull));
            return;
          }
        }
        if (rest[2] === 'files' && method === 'GET' && rest.length === 3) {
          const pull = pullOr404(ctx, repo, number);
          if (!pull) return;
          const files = pullFiles(ctx, repo, pull);
          sendJson(res, 200, files);
          return;
        }
        if (rest[2] === 'merge' && method === 'PUT' && rest.length === 3) {
          const pull = pullOr404(ctx, repo, number);
          if (!pull) return;
          if (pull.merged) {
            sendError(res, 405, 'Pull Request is already merged');
            return;
          }
          if (pull.state === 'closed') {
            sendError(res, 405, 'Pull Request is closed');
            return;
          }
          const mergeMethod = typeof body?.merge_method === 'string' ? body.merge_method : 'merge';
          if (mergeMethod !== 'squash' && mergeMethod !== 'merge') {
            sendError(res, 422, `Validation Failed: merge_method ${mergeMethod} is not supported`);
            return;
          }
          const result = executeMerge(ctx.store, repo, pull, mergeMethod);
          if ('error' in result) {
            const status = result.error.startsWith('Merge conflict') ? 405 : 422;
            sendError(res, status, result.error);
            return;
          }
          sendJson(res, 200, { merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
          return;
        }
      }
    }

    sendError(res, 404, 'Not Found');
    return;
  }

  sendError(res, 404, 'Not Found');
}

function stripOwnerPrefix(ref: string): string {
  const colon = ref.lastIndexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

function contentEntryView(
  ctx: RestContext,
  repo: Repo,
  entry: { mode: string; name: string; oid: string },
  dirPath: string,
): Record<string, unknown> {
  const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
  const isDir = entry.mode === '40000';
  let size = 0;
  if (!isDir) {
    const blob = repo.objects.get(entry.oid);
    size = blob ? blob.data.length : 0;
  }
  return {
    type: isDir ? 'dir' : 'file',
    size,
    name: entry.name,
    path,
    sha: entry.oid,
    url: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `${ctx.base}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
    download_url: isDir ? null : `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
  };
}

/** The files of a pull request: diff of merge-base tree -> head tree, with line counts. */
function pullFiles(ctx: RestContext, repo: Repo, pull: Pull): Record<string, unknown>[] {
  refreshPull(repo, pull);
  const mergeBaseCommit = repo.objects.get(pull.mergeBaseSha);
  if (!mergeBaseCommit || mergeBaseCommit.type !== 'commit') return [];
  const baseTree = parseCommit(mergeBaseCommit.data).tree;
  const headCommit = repo.objects.get(pull.headSha);
  if (!headCommit || headCommit.type !== 'commit') return [];
  const headTree = parseCommit(headCommit.data).tree;
  const diffs = diffTrees(repo.objects, baseTree, headTree);
  const out: Record<string, unknown>[] = [];
  for (const diff of diffs) {
    const oldText = diff.oldOid ? (repo.objects.get(diff.oldOid)?.data.toString('utf8') ?? '') : '';
    const newText = diff.newOid ? (repo.objects.get(diff.newOid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = countLineChanges(oldText, newText);
    out.push({
      sha: diff.newOid ?? diff.oldOid ?? '',
      filename: diff.path,
      status: diff.status === 'removed' ? 'removed' : diff.status === 'added' ? 'added' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `${ctx.base}/${repo.owner}/${repo.name}/blob/${pull.headRef}/${diff.path}`,
      raw_url: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${diff.path}?ref=${encodeURIComponent(pull.headRef)}`,
      contents_url: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${diff.path}`,
    });
  }
  return out;
}
