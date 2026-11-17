// graphql.ts — a small, strict GraphQL executor for the forge's v4 surface
// (POST /api/graphql). It parses the query documents the suite sends, resolves
// them against the same store the REST API uses, and answers batched operations
// in order. Unknown fields answer HTTP 200 with an errors array naming the
// field; unknown repositories answer data.repository = null with no errors.
//
// Supported: viewer, repository, node, __type/__schema, issue(s), pullRequest(s),
// createIssue, closeIssue, createPullRequest, mergePullRequest, addComment,
// cursor pagination, orderBy, and introspection of the types below.

import type { ServerResponse } from 'node:http';
import { countLineChanges, diffTrees, parseCommit } from './git.ts';
import { executeMerge, findMergeConflicts, refreshPull } from './rest.ts';
import { VIEWER, VIEWER_LOGIN, type Issue, type IssueComment, type Pull, type Repo, type Store } from './store.ts';
import { decodeCursor, encodeCursor, globalId, isRecord, parseGlobalId, parseJsonBody, sendError, sendJson } from './util.ts';

// ---------------------------------------------------------------- schema

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'private', 'isPrivate', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email'],
  Ref: ['name', 'target'],
  Commit: ['oid', 'message'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'repository', 'comments', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'headRefOid', 'baseRefOid'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentEdge: ['node', 'cursor'],
  FileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  FileEdge: ['node', 'cursor'],
  FileChange: ['path', 'additions', 'deletions', 'status'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name', 'type'],
  __EnumValue: ['name'],
  __Schema: ['queryType', 'mutationType', 'types'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const EDGE_TYPE: Record<string, string> = {
  IssueConnection: 'IssueEdge',
  PullRequestConnection: 'PullRequestEdge',
  IssueCommentConnection: 'IssueCommentEdge',
  FileConnection: 'FileEdge',
};

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$=@![]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          value += map[esc] ?? esc;
          i += 2;
        } else {
          value += input[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      const raw = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number.parseFloat(raw) } : { kind: 'int', value: Number.parseInt(raw, 10) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- AST

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  directives: Array<{ name: string; args: Record<string, ValueNode> }>;
  selections: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
  directives: Array<{ name: string; args: Record<string, ValueNode> }>;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  directives: Array<{ name: string; args: Record<string, ValueNode> }>;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of query');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}", got ${JSON.stringify(token)}`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token)}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
        continue;
      }
      let kind: 'query' | 'mutation' | 'subscription' = 'query';
      let name: string | null = null;
      if (token.kind === 'punct' && token.value === '{') {
        // Anonymous shorthand query.
      } else if (token.kind === 'name' && ['query', 'mutation', 'subscription'].includes(token.value)) {
        kind = token.value as 'query' | 'mutation' | 'subscription';
        this.next();
        const nextToken = this.peek();
        if (nextToken && nextToken.kind === 'name') name = this.next().value as string;
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token)} at document top level`);
      }
      const variables = this.parseVariableDefinitions();
      const selections = this.parseSelectionSet();
      operations.push({ kind, name, variables, selections });
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const variables: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (!this.acceptPunct('(')) return variables;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseTypeName();
      let defaultValue: ValueNode | null = null;
      if (this.acceptPunct('=')) defaultValue = this.parseValue();
      variables.push({ name, defaultValue });
    }
    return variables;
  }

  private parseTypeName(): void {
    // A type name like String, [String!]!, etc. — its shape is irrelevant here;
    // only the token stream position matters.
    if (this.acceptPunct('[')) {
      this.parseTypeName();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        const selections = this.parseSelectionSet();
        return { kind: 'inline', typeCondition, directives, selections };
      }
      if (next && next.kind === 'name') {
        const name = this.next().value as string;
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      const directives = this.parseDirectives();
      const selections = this.parseSelectionSet();
      return { kind: 'inline', typeCondition: null, directives, selections };
    }
    // Field: [alias ':'] name [args] [directives] [selection set]
    let name = this.expectName();
    let alias: string | null = null;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selections: SelectionNode[] = [];
    const next = this.peek();
    if (next && next.kind === 'punct' && next.value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, directives, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  private parseDirectives(): Array<{ name: string; args: Record<string, ValueNode> }> {
    const directives: Array<{ name: string; args: Record<string, ValueNode> }> = [];
    while (this.acceptPunct('@')) {
      const name = this.expectName();
      const args = this.parseArguments();
      directives.push({ name, args });
    }
    return directives;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as Token).value === ']')) {
        items.push(this.parseValue());
      }
      this.next();
      return { kind: 'literal', value: items.map((item) => resolveLiteral(item)) };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.peek()?.kind === 'punct' && (this.peek() as Token).value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        const value = this.parseValue();
        obj[key] = resolveLiteral(value);
      }
      this.next();
      return { kind: 'literal', value: obj };
    }
    if (token.kind === 'string' || token.kind === 'int' || token.kind === 'float') {
      return { kind: 'literal', value: token.value };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: token.value }; // enum
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

/** Resolve a parsed value node to a plain value (variables resolved by the caller). */
function resolveLiteral(node: ValueNode): unknown {
  if (node.kind === 'literal') return node.value;
  return null;
}

// ---------------------------------------------------------------- execution

interface GqlNode {
  __typename: string;
  [key: string]: unknown;
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function valueOf(node: ValueNode, ctx: ExecContext): unknown {
  if (node.kind === 'literal') return node.value;
  return ctx.variables[node.name] ?? null;
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = valueOf(value, ctx);
  return out;
}

function directiveSkip(directives: Array<{ name: string; args: Record<string, ValueNode> }>, ctx: ExecContext): boolean {
  for (const directive of directives) {
    const ifValue = directive.args.if !== undefined ? valueOf(directive.args.if, ctx) : undefined;
    if (directive.name === 'skip' && ifValue === true) return true;
    if (directive.name === 'include' && ifValue === false) return true;
  }
  return false;
}

/** Execute a selection set against a node; returns the resolved object (or null). */
function executeSelections(typeName: string, node: GqlNode | null, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> | null {
  if (node === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      if (directiveSkip(selection.directives, ctx)) continue;
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) continue;
      const resolved = executeSelections(typeName, node, fragment.selections, ctx);
      if (resolved) Object.assign(out, resolved);
      continue;
    }
    if (selection.kind === 'inline') {
      if (directiveSkip(selection.directives, ctx)) continue;
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const resolved = executeSelections(typeName, node, selection.selections, ctx);
      if (resolved) Object.assign(out, resolved);
      continue;
    }
    // Field.
    if (directiveSkip(selection.directives, ctx)) continue;
    const key = selection.alias ?? selection.name;
    out[key] = executeField(typeName, node, selection, ctx);
  }
  return out;
}

function executeField(typeName: string, node: GqlNode, field: FieldNode, ctx: ExecContext): unknown {
  if (field.name === '__typename') return typeName;
  const known = OBJECT_FIELDS[typeName] ?? [];
  if (!known.includes(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  }
  const args = argsOf(field, ctx);
  const value = resolveField(typeName, node, field.name, args, ctx);
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (isGqlNode(item)) {
        const resolved = executeSelections(item.__typename, item, field.selections, ctx);
        return resolved ?? null;
      }
      return item;
    });
  }
  if (isGqlNode(value)) {
    if (field.selections.length === 0) return {};
    return executeSelections(value.__typename, value, field.selections, ctx);
  }
  return value;
}

function isGqlNode(value: unknown): value is GqlNode {
  return isRecord(value) && typeof value.__typename === 'string';
}

// ---------------------------------------------------------------- resolvers

function userNode(): GqlNode {
  return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function repoNode(repo: Repo): GqlNode {
  return { __typename: 'Repository', repo };
}

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): GqlNode {
  return { __typename: 'PullRequest', repo, pull };
}

function commentNode(repo: Repo, issueNumber: number, comment: IssueComment): GqlNode {
  return { __typename: 'IssueComment', repo, issueNumber, comment };
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

interface ConnectionData {
  nodes: GqlNode[];
  totalCount: number;
  offset: number;
  end: number;
}

function makeConnection(typeName: string, nodes: GqlNode[], first: unknown, after: unknown): GqlNode {
  const offset = typeof after === 'string' && after !== '' ? (decodeCursor(after) ?? 0) : 0;
  const total = nodes.length;
  const limit = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.floor(first)) : total;
  const end = Math.min(offset + limit, total);
  const pageNodes = nodes.slice(offset, end);
  return {
    __typename: typeName,
    _nodes: pageNodes,
    _totalCount: total,
    _offset: offset,
    _end: end,
    _hasNextPage: end < total,
    _hasPreviousPage: offset > 0,
    // A cursor names the offset just after the node it points at, so `after`
    // a page's endCursor resumes exactly where the page stopped.
    _startCursor: pageNodes.length > 0 ? encodeCursor(offset + 1) : null,
    _endCursor: pageNodes.length > 0 ? encodeCursor(end) : null,
  };
}

function resolveConnectionField(conn: GqlNode, field: string): unknown {
  if (field === 'nodes') return conn._nodes as GqlNode[];
  if (field === 'totalCount') return conn._totalCount as number;
  if (field === 'edges') {
    const nodes = conn._nodes as GqlNode[];
    const offset = conn._offset as number;
    const edgeType = EDGE_TYPE[conn.__typename] ?? 'IssueEdge';
    return nodes.map((node, i) => ({ __typename: edgeType, node, cursor: encodeCursor(offset + i + 1) }));
  }
  if (field === 'pageInfo') {
    return {
      __typename: 'PageInfo',
      hasNextPage: conn._hasNextPage as boolean,
      hasPreviousPage: conn._hasPreviousPage as boolean,
      startCursor: conn._startCursor as string | null,
      endCursor: conn._endCursor as string | null,
    };
  }
  return null;
}

function issueStateFilter(states: unknown): Array<'open' | 'closed'> {
  if (!Array.isArray(states) || states.length === 0) return ['open'];
  const out: Array<'open' | 'closed'> = [];
  for (const state of states) {
    if (state === 'OPEN') out.push('open');
    else if (state === 'CLOSED') out.push('closed');
  }
  return out.length > 0 ? out : ['open'];
}

function pullStateFilter(states: unknown): Array<'open' | 'closed' | 'merged'> {
  if (!Array.isArray(states) || states.length === 0) return ['open'];
  const out: Array<'open' | 'closed' | 'merged'> = [];
  for (const state of states) {
    if (state === 'OPEN') out.push('open');
    else if (state === 'CLOSED') out.push('closed');
    else if (state === 'MERGED') out.push('merged');
  }
  return out.length > 0 ? out : ['open'];
}

function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const sorted = [...issues];
  const order = isRecord(orderBy) ? orderBy : {};
  const direction = order.direction === 'DESC' ? -1 : 1;
  const field = order.field === 'UPDATED_AT' ? 'updatedAt' : 'createdAt';
  sorted.sort((a, b) => {
    const cmp = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : a.number - b.number;
    return cmp * direction;
  });
  return sorted;
}

function pullFilesNodes(repo: Repo, pull: Pull): GqlNode[] {
  const mergeBaseCommit = repo.objects.get(pull.mergeBaseSha);
  if (!mergeBaseCommit || mergeBaseCommit.type !== 'commit') return [];
  const baseTree = parseCommit(mergeBaseCommit.data).tree;
  const headCommit = repo.objects.get(pull.headSha);
  if (!headCommit || headCommit.type !== 'commit') return [];
  const headTree = parseCommit(headCommit.data).tree;
  const diffs = diffTrees(repo.objects, baseTree, headTree);
  return diffs.map((diff) => {
    const oldText = diff.oldOid ? (repo.objects.get(diff.oldOid)?.data.toString('utf8') ?? '') : '';
    const newText = diff.newOid ? (repo.objects.get(diff.newOid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = countLineChanges(oldText, newText);
    return {
      __typename: 'FileChange',
      path: diff.path,
      additions,
      deletions,
      status: diff.status === 'removed' ? 'REMOVED' : diff.status === 'added' ? 'ADDED' : 'MODIFIED',
    };
  });
}

function resolveField(typeName: string, node: GqlNode, field: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const store = ctx.store;
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') return userNode();
      if (field === 'repository') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        if (owner !== VIEWER_LOGIN) return null;
        const repo = store.getRepo(name);
        return repo ? repoNode(repo) : null;
      }
      if (field === 'node') {
        const id = typeof args.id === 'string' ? args.id : '';
        const parsed = parseGlobalId(id);
        if (!parsed) return null;
        if (parsed.kind === 'User' && parsed.local === String(VIEWER.id)) return userNode();
        if (parsed.kind === 'Repository') {
          const repo = findRepoById(store, Number.parseInt(parsed.local, 10));
          return repo ? repoNode(repo) : null;
        }
        if (parsed.kind === 'Issue') {
          const [repoId, number] = parsed.local.split(':');
          const repo = findRepoById(store, Number.parseInt(repoId ?? '', 10));
          const issue = repo?.issues.get(Number.parseInt(number ?? '', 10));
          return repo && issue ? issueNode(repo, issue) : null;
        }
        if (parsed.kind === 'PullRequest') {
          const [repoId, number] = parsed.local.split(':');
          const repo = findRepoById(store, Number.parseInt(repoId ?? '', 10));
          const pull = repo?.pulls.get(Number.parseInt(number ?? '', 10));
          return repo && pull ? pullNode(repo, pull) : null;
        }
        if (parsed.kind === 'IssueComment') {
          const [repoId, issueNumber, commentId] = parsed.local.split(':');
          const repo = findRepoById(store, Number.parseInt(repoId ?? '', 10));
          const issue = repo?.issues.get(Number.parseInt(issueNumber ?? '', 10));
          const comment = issue?.comments.find((c) => c.id === Number.parseInt(commentId ?? '', 10));
          return repo && issue && comment ? commentNode(repo, issue.number, comment) : null;
        }
        return null;
      }
      if (field === '__type') {
        const name = typeof args.name === 'string' ? args.name : '';
        if (OBJECT_FIELDS[name] !== undefined) {
          return {
            __typename: '__Type',
            name,
            kind: 'OBJECT',
            fields: (OBJECT_FIELDS[name] as string[]).map((fieldName) => ({ __typename: '__Field', name: fieldName })),
            enumValues: null,
          };
        }
        if (ENUM_VALUES[name] !== undefined) {
          return {
            __typename: '__Type',
            name,
            kind: 'ENUM',
            fields: null,
            enumValues: (ENUM_VALUES[name] as string[]).map((value) => ({ __typename: '__EnumValue', name: value })),
          };
        }
        return null;
      }
      if (field === '__schema') {
        return {
          __typename: '__Schema',
          queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' },
          mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' },
          types: [
            ...Object.keys(OBJECT_FIELDS).map((name) => ({ __typename: '__Type', name, kind: 'OBJECT' })),
            ...Object.keys(ENUM_VALUES).map((name) => ({ __typename: '__Type', name, kind: 'ENUM' })),
          ],
        };
      }
      return null;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const repoId = parseGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
        const repo = repoId?.kind === 'Repository' ? findRepoById(store, Number.parseInt(repoId.local, 10)) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'createIssue: repositoryId does not name a repository' });
          return { __typename: 'CreateIssuePayload', issue: null, clientMutationId: (input.clientMutationId as string | null) ?? null };
        }
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const issue = store.createIssue(repo, title, body, []);
        return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue), clientMutationId: (input.clientMutationId as string | null) ?? null };
      }
      if (field === 'closeIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(typeof input.issueId === 'string' ? input.issueId : '');
        let found: { repo: Repo; issue: Issue } | null = null;
        if (parsed?.kind === 'Issue') {
          const [repoId, number] = parsed.local.split(':');
          const repo = findRepoById(store, Number.parseInt(repoId ?? '', 10));
          const issue = repo?.issues.get(Number.parseInt(number ?? '', 10));
          if (repo && issue) found = { repo, issue };
        }
        if (!found) {
          ctx.errors.push({ message: 'closeIssue: issueId does not name an issue' });
          return { __typename: 'CloseIssuePayload', issue: null, clientMutationId: (input.clientMutationId as string | null) ?? null };
        }
        found.issue.state = 'closed';
        found.issue.updatedAt = store.clock.tick().iso;
        return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue), clientMutationId: (input.clientMutationId as string | null) ?? null };
      }
      if (field === 'createPullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const repoId = parseGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
        const repo = repoId?.kind === 'Repository' ? findRepoById(store, Number.parseInt(repoId.local, 10)) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'createPullRequest: repositoryId does not name a repository' });
          return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: (input.clientMutationId as string | null) ?? null };
        }
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
        const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const pull = store.createPull(repo, title, body, headRefName, baseRefName);
        if (!pull) {
          ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
          return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: (input.clientMutationId as string | null) ?? null };
        }
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull), clientMutationId: (input.clientMutationId as string | null) ?? null };
      }
      if (field === 'mergePullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
        let found: { repo: Repo; pull: Pull } | null = null;
        if (parsed?.kind === 'PullRequest') {
          const [repoId, number] = parsed.local.split(':');
          const repo = findRepoById(store, Number.parseInt(repoId ?? '', 10));
          const pull = repo?.pulls.get(Number.parseInt(number ?? '', 10));
          if (repo && pull) found = { repo, pull };
        }
        if (!found) {
          ctx.errors.push({ message: 'mergePullRequest: pullRequestId does not name a pull request' });
          return { __typename: 'MergePullRequestPayload', pullRequest: null, clientMutationId: (input.clientMutationId as string | null) ?? null };
        }
        if (found.pull.merged) {
          ctx.errors.push({ message: 'mergePullRequest: pull request is already merged' });
          return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull), clientMutationId: (input.clientMutationId as string | null) ?? null };
        }
        const method = input.mergeMethod === 'SQUASH' ? 'squash' : 'merge';
        const result = executeMerge(store, found.repo, found.pull, method);
        if ('error' in result) {
          ctx.errors.push({ message: `mergePullRequest: ${result.error}` });
          return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull), clientMutationId: (input.clientMutationId as string | null) ?? null };
        }
        return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull), clientMutationId: (input.clientMutationId as string | null) ?? null };
      }
      if (field === 'addComment') {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(typeof input.subjectId === 'string' ? input.subjectId : '');
        let found: { repo: Repo; issue: Issue } | null = null;
        if (parsed?.kind === 'Issue') {
          const [repoId, number] = parsed.local.split(':');
          const repo = findRepoById(store, Number.parseInt(repoId ?? '', 10));
          const issue = repo?.issues.get(Number.parseInt(number ?? '', 10));
          if (repo && issue) found = { repo, issue };
        }
        if (!found) {
          ctx.errors.push({ message: 'addComment: subjectId does not name an issue' });
          return { __typename: 'AddCommentPayload', commentEdge: null, clientMutationId: (input.clientMutationId as string | null) ?? null };
        }
        const body = typeof input.body === 'string' ? input.body : '';
        const now = store.clock.tick();
        const comment: IssueComment = { id: store.nextId(), body, user: VIEWER_LOGIN, createdAt: now.iso, updatedAt: now.iso };
        found.issue.comments.push(comment);
        const node = commentNode(found.repo, found.issue.number, comment);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: { __typename: 'IssueCommentEdge', node, cursor: encodeCursor(found.issue.comments.length) },
          clientMutationId: (input.clientMutationId as string | null) ?? null,
        };
      }
      return null;
    }
    case 'Repository': {
      const repo = node.repo as Repo;
      switch (field) {
        case 'id': return globalId('Repository', String(repo.id));
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return userNode();
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch, oid: tip, repo };
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'private':
        case 'isPrivate': return repo.private;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'issue': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const issue = repo.issues.get(number);
          return issue ? issueNode(repo, issue) : null;
        }
        case 'issues': {
          const states = issueStateFilter(args.states);
          const issues = sortIssues(
            [...repo.issues.values()].filter((issue) => states.includes(issue.state)),
            args.orderBy,
          );
          return makeConnection('IssueConnection', issues.map((issue) => issueNode(repo, issue)), args.first, args.after);
        }
        case 'pullRequest': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const pull = repo.pulls.get(number);
          return pull ? pullNode(repo, pull) : null;
        }
        case 'pullRequests': {
          const states = pullStateFilter(args.states);
          const pulls = [...repo.pulls.values()]
            .filter((pull) => {
              if (pull.merged) return states.includes('merged');
              return states.includes(pull.state);
            })
            .sort((a, b) => b.number - a.number);
          return makeConnection('PullRequestConnection', pulls.map((pull) => pullNode(repo, pull)), args.first, args.after);
        }
        default: return null;
      }
    }
    case 'User': {
      switch (field) {
        case 'id': return globalId('User', String(VIEWER.id));
        case 'login': return VIEWER.login;
        case 'name': return VIEWER.name;
        case 'email': return VIEWER.email;
        default: return null;
      }
    }
    case 'Ref': {
      if (field === 'name') return node.name as string;
      if (field === 'target') return { __typename: 'Commit', repo: node.repo as Repo, oid: node.oid as string };
      return null;
    }
    case 'Commit': {
      const repo = node.repo as Repo;
      if (field === 'oid') return node.oid as string;
      if (field === 'message') {
        const object = repo.objects.get(node.oid as string);
        if (!object || object.type !== 'commit') return null;
        return parseCommit(object.data).message.replace(/\n$/, '');
      }
      return null;
    }
    case 'Issue': {
      const issue = node.issue as Issue;
      const repo = node.repo as Repo;
      switch (field) {
        case 'id': return globalId('Issue', `${repo.id}:${issue.number}`);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return issue.body;
        case 'author': return userNode();
        case 'repository': return repoNode(repo);
        case 'comments': {
          const nodes = issue.comments.map((comment) => commentNode(repo, issue.number, comment));
          return makeConnection('IssueCommentConnection', nodes, args.first, args.after);
        }
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        default: return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'IssueCommentConnection':
    case 'FileConnection': {
      return resolveConnectionField(node, field);
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'IssueCommentEdge':
    case 'FileEdge': {
      if (field === 'node') return node.node as GqlNode;
      if (field === 'cursor') return node.cursor as string;
      return null;
    }
    case 'PageInfo': {
      switch (field) {
        case 'hasNextPage': return node.hasNextPage as boolean;
        case 'hasPreviousPage': return node.hasPreviousPage as boolean;
        case 'startCursor': return node.startCursor as string | null;
        case 'endCursor': return node.endCursor as string | null;
        default: return null;
      }
    }
    case 'PullRequest': {
      const pull = node.pull as Pull;
      const repo = node.repo as Repo;
      // The head/base branches may have advanced since the PR was opened.
      refreshPull(repo, pull);
      switch (field) {
        case 'id': return globalId('PullRequest', `${repo.id}:${pull.number}`);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN';
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRefOid': return pull.headSha;
        case 'baseRefOid': return pull.baseSha;
        case 'mergeable': {
          const conflicts = findMergeConflicts(repo, pull);
          if (conflicts === null) return 'UNKNOWN';
          return conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'files': {
          const nodes = pullFilesNodes(repo, pull);
          return makeConnection('FileConnection', nodes, args.first, args.after);
        }
        case 'author': return userNode();
        case 'repository': return repoNode(repo);
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        default: return null;
      }
    }
    case 'IssueComment': {
      const comment = node.comment as IssueComment;
      const repo = node.repo as Repo;
      const issueNumber = node.issueNumber as number;
      switch (field) {
        case 'id': return globalId('IssueComment', `${repo.id}:${issueNumber}:${comment.id}`);
        case 'body': return comment.body;
        case 'author': return userNode();
        default: return null;
      }
    }
    case 'FileChange': {
      switch (field) {
        case 'path': return node.path as string;
        case 'additions': return node.additions as number;
        case 'deletions': return node.deletions as number;
        case 'status': return node.status as string;
        default: return null;
      }
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field === 'issue') return node.issue as GqlNode | null;
      if (field === 'clientMutationId') return node.clientMutationId as string | null;
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return node.pullRequest as GqlNode | null;
      if (field === 'clientMutationId') return node.clientMutationId as string | null;
      return null;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return node.commentEdge as GqlNode | null;
      if (field === 'clientMutationId') return node.clientMutationId as string | null;
      return null;
    }
    case '__Type': {
      if (field === 'name') return node.name as string;
      if (field === 'kind') return node.kind as string;
      if (field === 'fields') return (node.fields as GqlNode[] | null) ?? null;
      if (field === 'enumValues') return (node.enumValues as GqlNode[] | null) ?? null;
      return null;
    }
    case '__Field': {
      if (field === 'name') return node.name as string;
      if (field === 'type') return { __typename: '__Type', name: 'String', kind: 'SCALAR' };
      return null;
    }
    case '__EnumValue': {
      if (field === 'name') return node.name as string;
      return null;
    }
    case '__Schema': {
      if (field === 'queryType') return node.queryType as GqlNode;
      if (field === 'mutationType') return node.mutationType as GqlNode;
      if (field === 'types') return node.types as GqlNode[];
      return null;
    }
    default:
      return null;
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

interface GraphQLOperation {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function runOperation(store: Store, operation: GraphQLOperation): Record<string, unknown> {
  if (typeof operation.query !== 'string' || operation.query.trim() === '') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(operation.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
  }
  const variables: Record<string, unknown> = isRecord(operation.variables) ? { ...operation.variables } : {};
  let selected: OperationNode | undefined;
  if (typeof operation.operationName === 'string' && operation.operationName !== '') {
    selected = document.operations.find((op) => op.name === operation.operationName);
    if (!selected) return { data: null, errors: [{ message: `Unknown operation named "${operation.operationName}".` }] };
  } else {
    selected = document.operations[0];
  }
  if (!selected) return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  // Apply variable defaults from the operation definition.
  for (const variable of selected.variables) {
    if (variables[variable.name] === undefined && variable.defaultValue !== null) {
      variables[variable.name] = valueOf(variable.defaultValue, { store, variables, fragments: document.fragments, errors: [] });
    }
  }
  const ctx: ExecContext = { store, variables, fragments: document.fragments, errors: [] };
  const rootType = selected.kind === 'mutation' ? 'Mutation' : 'Query';
  const rootNode: GqlNode = { __typename: rootType };
  const data = executeSelections(rootType, rootNode, selected.selections, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Handle POST /api/graphql (single operation or a batch array). */
export async function handleGraphQL(
  store: Store,
  token: string,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  res: ServerResponse,
): Promise<void> {
  const presented = bearerToken(headers);
  if (presented === null || presented !== token) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonBody(body);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => (isRecord(item) ? runOperation(store, item as GraphQLOperation) : { data: null, errors: [{ message: 'Must provide query string.' }] }));
    sendJson(res, 200, results);
    return;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, { errors: [{ message: 'Must provide query string.' }] });
    return;
  }
  sendJson(res, 200, runOperation(store, parsed as GraphQLOperation));
}
