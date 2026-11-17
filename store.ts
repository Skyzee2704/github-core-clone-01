// store.ts — the forge's whole state lives here, in memory, in one process.
// No disk, no database, no clock: every timestamp comes from a logical clock
// (base instant + a counter), so the same sequence of operations always
// produces the same state — a replay exports byte-identical data.
//
// Identity: the suite's scenario is deterministic from a fixed sealed seed
// (wire.ts SCENARIO_SEED), so the viewer is always the same user. The forge
// hardcodes that viewer and owns every repo under it.

import {
  buildCommit,
  buildTree,
  getEntryAtPath,
  listDirAtPath,
  parseCommit,
  parseTree,
  putObject,
  setPathInTree,
  walkCommits,
  type GitObject,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const FORGE_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
/** Base instant for the logical clock: 2026-01-01T00:00:00Z. */
export const CLOCK_BASE_EPOCH = 1767225600;

export interface UserView {
  login: string;
  id: number;
  name: string;
  email: string;
  type: string;
}

export const VIEWER: UserView = {
  login: VIEWER_LOGIN,
  id: VIEWER_ID,
  name: VIEWER_NAME,
  email: VIEWER_EMAIL,
  type: 'User',
};

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** refs/heads/<branch> -> commit sha. */
  refs: Map<string, string>;
  /** The repo's own git object store. */
  objects: Map<string, GitObject>;
  /** Shared issue+PR number sequence (GitHub numbers issues and PRs together). */
  nextNumber: number;
  nextLabelId: number;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
}

/** A deterministic clock: each tick advances one second from the base instant. */
export class LogicalClock {
  private counter = 0;

  tick(): { iso: string; epoch: number } {
    this.counter += 1;
    const epoch = CLOCK_BASE_EPOCH + this.counter;
    return { iso: new Date(epoch * 1000).toISOString(), epoch };
  }

  peek(): { iso: string; epoch: number } {
    const epoch = CLOCK_BASE_EPOCH + this.counter;
    return { iso: new Date(epoch * 1000).toISOString(), epoch };
  }
}

export class Store {
  readonly clock = new LogicalClock();
  private nextRepoId = 1;
  private nextGlobalId = 1;
  readonly repos = new Map<string, Repo>();

  /** A globally unique integer id (issues, comments, PRs). */
  nextId(): number {
    const id = this.nextGlobalId;
    this.nextGlobalId += 1;
    return id;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const now = this.clock.tick();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now.iso,
      updatedAt: now.iso,
      refs: new Map(),
      objects: new Map(),
      nextNumber: 1,
      nextLabelId: 1,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** The tip commit of a repo's default branch, or null when the repo is unborn. */
  defaultTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  /** The tree oid of a branch tip, or null when the branch does not exist. */
  branchTree(repo: Repo, branch: string): string | null {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return null;
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return null;
    return parseCommit(commit.data).tree;
  }

  /** The tree oid of a ref (branch name or full ref), or null. */
  treeOfRef(repo: Repo, ref: string): string | null {
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    return this.branchTree(repo, branch);
  }

  /** Create a commit on `branch` that sets `path` to `content` (or deletes it when null). */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitSha: string; blobSha: string | null } {
    const now = this.clock.tick();
    const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
    const parentTree = tip === null ? null : parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
    let blobSha: string | null = null;
    let newTree: string | null;
    if (content !== null) {
      blobSha = putObject(repo.objects, 'blob', content);
      newTree = setPathInTree(repo.objects, parentTree, path.split('/'), blobSha);
    } else {
      newTree = setPathInTree(repo.objects, parentTree, path.split('/'), null);
    }
    if (newTree === null) {
      // The tree became empty: store an empty tree so the commit still has one.
      newTree = putObject(repo.objects, 'tree', buildTree([]));
    }
    const commitSha = putObject(
      repo.objects,
      'commit',
      buildCommit({
        tree: newTree,
        parents: tip === null ? [] : [tip],
        message,
        timestamp: now.epoch,
        identity: FORGE_IDENTITY,
      }),
    );
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha };
  }

  /** Read a file's blob at a branch (or full ref); null when absent/not a file. */
  readFileAt(repo: Repo, ref: string, path: string): { blobSha: string; data: Buffer } | null {
    const tree = this.treeOfRef(repo, ref);
    if (tree === null) return null;
    const entry = getEntryAtPath(repo.objects, tree, path.split('/'));
    if (!entry || entry.mode === '40000') return null;
    const blob = repo.objects.get(entry.oid);
    if (!blob || blob.type !== 'blob') return null;
    return { blobSha: entry.oid, data: blob.data };
  }

  /** List a directory at a branch (empty path = root); null when not a directory. */
  readDirAt(repo: Repo, ref: string, path: string): ReturnType<typeof listDirAtPath> {
    const tree = this.treeOfRef(repo, ref);
    if (tree === null) return path === '' ? [] : null;
    return listDirAtPath(repo.objects, tree, path === '' ? [] : path.split('/'));
  }

  /** Commits on a branch, newest first (depth-first parent walk from the tip). */
  commitsOf(repo: Repo, ref: string): string[] {
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return [];
    return walkCommits(repo.objects, tip);
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    const now = this.clock.tick();
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label) labels.push(label);
    }
    const issue: Issue = {
      id: this.nextId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      createdAt: now.iso,
      updatedAt: now.iso,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) return null;
    const mergeBaseSha = findMergeBase(repo, headSha, baseSha);
    const now = this.clock.tick();
    const pull: Pull = {
      id: this.nextId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      mergeBaseSha,
      createdAt: now.iso,
      updatedAt: now.iso,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }
}

/** The merge-base of two commits: the first commit reachable from both (newest-first walk). */
export function findMergeBase(repo: Repo, a: string, b: string): string {
  const ancestorsA = new Set(walkCommits(repo.objects, a));
  const walkB = walkCommits(repo.objects, b);
  for (const oid of walkB) {
    if (ancestorsA.has(oid)) return oid;
  }
  return a;
}

/** Read a commit object as a parsed view, or null. */
export function readCommit(repo: Repo, sha: string): ReturnType<typeof parseCommit> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data);
}
