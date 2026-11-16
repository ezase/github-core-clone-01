// The GraphQL v4 surface: POST /api/graphql.
//
// A hand-rolled executor for the exact documents gh and github-mcp-server send
// (see the suite's checks-graphql.ts / graphql-client.ts). No general GraphQL
// engine: a tiny recursive-descent parser reads the operation type, the root
// field and the requested sub-fields, then resolves straight from the store.
// Node 22 stdlib only; no Date.now / Math.random anywhere the suite can see.

import {
  VIEWER,
  ZERO_OID,
  decodeGlobalId,
  globalId,
  isAuthenticated,
} from './store.ts';
import type { Ctx, Issue, PullRequest, Repo, Reply, Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// Tiny GraphQL document parser
// ---------------------------------------------------------------------------------------------

interface GField {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  children: GField[];
  /** Inline fragment type condition (`... on Repository`), or null. */
  fragmentOn: string | null;
}

interface GOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  fields: GField[];
}

function isNameStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

class Parser {
  private pos = 0;
  private readonly text: string;
  private readonly vars: Record<string, unknown>;

  constructor(text: string, vars: Record<string, unknown>) {
    this.text = text;
    this.vars = vars;
  }

  parseOperation(): GOperation {
    this.skipWs();
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (this.peekWord('query')) {
      this.pos += 5;
      this.skipWs();
      if (this.peek() !== '{' && this.peek() !== '(' && this.peek() !== '') {
        name = this.parseName();
        this.skipWs();
      }
    } else if (this.peekWord('mutation')) {
      kind = 'mutation';
      this.pos += 8;
      this.skipWs();
      if (this.peek() !== '{' && this.peek() !== '(' && this.peek() !== '') {
        name = this.parseName();
        this.skipWs();
      }
    }
    // Variable definitions ($x: Type!): skipped, values come from `vars`.
    if (this.peek() === '(') this.skipBalanced('(', ')');
    this.skipWs();
    const fields = this.parseSelectionSet();
    return { kind, name, fields };
  }

  private peek(): string {
    return this.pos < this.text.length ? this.text[this.pos]! : '';
  }

  private peekWord(word: string): boolean {
    if (!this.text.startsWith(word, this.pos)) return false;
    const after = this.text[this.pos + word.length] ?? '';
    return after === '' || !isNameChar(after);
  }

  private skipWs(): void {
    for (;;) {
      const ch = this.peek();
      if (ch === '' ) return;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === '#') {
        while (this.peek() !== '' && this.peek() !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  private skipBalanced(open: string, close: string): void {
    // Assumes peek() === open. Skips to the matching close, string-aware.
    let depth = 0;
    let inStr = false;
    let escaped = false;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      this.pos += 1;
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseName(): string {
    this.skipWs();
    const start = this.pos;
    while (this.pos < this.text.length && isNameChar(this.text[this.pos]!)) this.pos += 1;
    if (this.pos === start) throw new Error(`expected a name at offset ${this.pos}`);
    return this.text.slice(start, this.pos);
  }

  private parseSelectionSet(): GField[] {
    this.skipWs();
    if (this.peek() !== '{') throw new Error(`expected '{' at offset ${this.pos}`);
    this.pos += 1;
    const fields: GField[] = [];
    for (;;) {
      this.skipWs();
      const ch = this.peek();
      if (ch === '') throw new Error('unterminated selection set');
      if (ch === '}') {
        this.pos += 1;
        return fields;
      }
      fields.push(this.parseField());
    }
  }

  private parseField(): GField {
    this.skipWs();
    if (this.text.startsWith('...', this.pos)) {
      this.pos += 3;
      this.skipWs();
      if (this.peekWord('on')) {
        this.pos += 2;
        this.skipWs();
        const typeName = this.parseName();
        this.skipWs();
        const children = this.parseSelectionSet();
        return { alias: null, name: '', args: {}, children, fragmentOn: typeName };
      }
      // Named fragment spread: the checked documents never use one; skip it.
      this.parseName();
      return { alias: null, name: '', args: {}, children: [], fragmentOn: '__unknown__' };
    }
    const first = this.parseName();
    this.skipWs();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.pos += 1;
      this.skipWs();
      alias = first;
      name = this.parseName();
      this.skipWs();
    }
    let args: Record<string, unknown> = {};
    if (this.peek() === '(') args = this.parseArgs();
    this.skipWs();
    let children: GField[] = [];
    if (this.peek() === '{') children = this.parseSelectionSet();
    return { alias, name, args, children, fragmentOn: null };
  }

  private parseArgs(): Record<string, unknown> {
    this.pos += 1; // consume '('
    const args: Record<string, unknown> = {};
    for (;;) {
      this.skipWs();
      const ch = this.peek();
      if (ch === '') throw new Error('unterminated argument list');
      if (ch === ')') {
        this.pos += 1;
        return args;
      }
      const argName = this.parseName();
      this.skipWs();
      if (this.peek() !== ':') throw new Error(`expected ':' after argument ${argName}`);
      this.pos += 1;
      args[argName] = this.parseValue();
    }
  }

  private parseValue(): unknown {
    this.skipWs();
    const ch = this.peek();
    if (ch === '"') return this.parseString();
    if (ch === '[') {
      this.pos += 1;
      const items: unknown[] = [];
      for (;;) {
        this.skipWs();
        if (this.peek() === ']') {
          this.pos += 1;
          return items;
        }
        items.push(this.parseValue());
      }
    }
    if (ch === '{') {
      this.pos += 1;
      const obj: Record<string, unknown> = {};
      for (;;) {
        this.skipWs();
        if (this.peek() === '}') {
          this.pos += 1;
          return obj;
        }
        const key = this.parseName();
        this.skipWs();
        if (this.peek() !== ':') throw new Error(`expected ':' in input object at ${key}`);
        this.pos += 1;
        obj[key] = this.parseValue();
      }
    }
    if (ch === '$') {
      this.pos += 1;
      const varName = this.parseName();
      const value = this.vars[varName];
      return value === undefined ? null : value;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const start = this.pos;
      while (this.pos < this.text.length && /[-0-9.eE+]/.test(this.text[this.pos]!)) this.pos += 1;
      const num = Number(this.text.slice(start, this.pos));
      return Number.isFinite(num) ? num : null;
    }
    if (isNameStart(ch)) {
      const word = this.parseName();
      if (word === 'true') return true;
      if (word === 'false') return false;
      if (word === 'null') return null;
      return word; // enum value, carried as its name
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${this.pos}`);
  }

  private parseString(): string {
    this.pos += 1; // consume opening quote
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      this.pos += 1;
      if (ch === '"') return out;
      if (ch === '\\') {
        const esc = this.text[this.pos] ?? '';
        this.pos += 1;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else if (esc === 'u') {
          const hex = this.text.slice(this.pos, this.pos + 4);
          this.pos += 4;
          const code = parseInt(hex, 16);
          out += Number.isFinite(code) ? String.fromCharCode(code) : '';
        } else out += esc;
        continue;
      }
      out += ch;
    }
    throw new Error('unterminated string');
  }
}

/** Split a query string holding several top-level operations into one string each. */
function splitOperations(text: string): string[] {
  const starts: number[] = [];
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (depth === 0) {
      for (const word of ['query', 'mutation']) {
        if (!text.startsWith(word, i)) continue;
        const prev = i === 0 ? ' ' : text[i - 1]!;
        const next = text[i + word.length] ?? ' ';
        if (!isNameChar(prev) && !isNameChar(next)) starts.push(i);
      }
    }
  }
  if (starts.length === 0) return [text];
  return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length));
}

// ---------------------------------------------------------------------------------------------
// Execution state and small helpers
// ---------------------------------------------------------------------------------------------

interface ExecState {
  store: Store;
  viewerLogin: string;
  errors: Array<{ message: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addError(state: ExecState, message: string): void {
  state.errors.push({ message });
}

function unknownField(state: ExecState, field: string, typeName: string): null {
  addError(state, `Cannot query field "${field}" on type "${typeName}".`);
  return null;
}

/** Inline fragments whose type condition matches `typeName` are flattened in. */
function flattenFields(children: GField[], typeName: string): GField[] {
  const out: GField[] = [];
  for (const child of children) {
    if (child.fragmentOn !== null) {
      if (child.fragmentOn === typeName) out.push(...flattenFields(child.children, typeName));
      continue;
    }
    out.push(child);
  }
  return out;
}

function argString(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' ? value : null;
}

function argInt(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  return null;
}

/** Opaque cursor over a filtered, sorted list: base64("cursor:<index>"). */
function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function parseCursor(after: unknown): number {
  if (typeof after !== 'string' || after === '') return -1;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match) return parseInt(match[1]!, 10);
  } catch {
    // fall through to the plain-integer form
  }
  const plain = parseInt(after, 10);
  return Number.isFinite(plain) ? plain : -1;
}

// ---------------------------------------------------------------------------------------------
// Global-id lookups
// ---------------------------------------------------------------------------------------------

function repoFromGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const slash = decoded.key.indexOf('/');
  if (slash < 0) return null;
  return store.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1)) ?? null;
}

function issueFromGlobalId(
  store: Store,
  id: string,
): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const hash = decoded.key.lastIndexOf('#');
  if (hash < 0) return null;
  const number = parseInt(decoded.key.slice(hash + 1), 10);
  if (!Number.isFinite(number)) return null;
  const ownerName = decoded.key.slice(0, hash);
  const slash = ownerName.indexOf('/');
  if (slash < 0) return null;
  const repo = store.getRepo(ownerName.slice(0, slash), ownerName.slice(slash + 1));
  if (!repo) return null;
  const issue = store.getIssue(repo, number);
  if (!issue) return null;
  return { repo, issue };
}

function pullFromGlobalId(
  store: Store,
  id: string,
): { repo: Repo; pull: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const hash = decoded.key.lastIndexOf('#');
  if (hash < 0) return null;
  const number = parseInt(decoded.key.slice(hash + 1), 10);
  if (!Number.isFinite(number)) return null;
  const ownerName = decoded.key.slice(0, hash);
  const slash = ownerName.indexOf('/');
  if (slash < 0) return null;
  const repo = store.getRepo(ownerName.slice(0, slash), ownerName.slice(slash + 1));
  if (!repo) return null;
  const pull = store.getPull(repo, number);
  if (!pull) return null;
  return { repo, pull };
}

// ---------------------------------------------------------------------------------------------
// Introspection tables
// ---------------------------------------------------------------------------------------------

const TYPE_DEFS: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Query: {
    kind: 'OBJECT',
    fields: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
    enumValues: [],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'createRepository'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests', 'issueCount', 'pullRequestCount'],
    enumValues: [],
  },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'labels', 'author', 'repository'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt', 'author', 'repository'],
    enumValues: [],
  },
  User: {
    kind: 'OBJECT',
    fields: ['login', 'id', 'name', 'email'],
    enumValues: [],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: ['edges', 'nodes', 'totalCount', 'pageInfo'],
    enumValues: [],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: ['edges', 'nodes', 'totalCount', 'pageInfo'],
    enumValues: [],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: ['path', 'filename', 'additions', 'deletions', 'changes', 'status'],
    enumValues: [],
  },
  Label: {
    kind: 'OBJECT',
    fields: ['id', 'name', 'color'],
    enumValues: [],
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: ['id', 'body', 'createdAt', 'author'],
    enumValues: [],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
    enumValues: [],
  },
  Ref: {
    kind: 'OBJECT',
    fields: ['name', 'target'],
    enumValues: [],
  },
  Commit: {
    kind: 'OBJECT',
    fields: ['oid'],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  },
  IssueState: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['OPEN', 'CLOSED'],
  },
  PullRequestState: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['OPEN', 'CLOSED', 'MERGED'],
  },
  MergeableState: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  },
  IssueOrderField: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  },
  OrderDirection: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ASC', 'DESC'],
  },
  RepositoryPermission: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  },
  PullRequestMergeMethod: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['MERGE', 'SQUASH', 'REBASE'],
  },
};

// ---------------------------------------------------------------------------------------------
// Object projectors: each turns a store object + requested fields into a JSON value
// ---------------------------------------------------------------------------------------------

function projectUser(
  state: ExecState,
  login: string,
  children: GField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of flattenFields(children, 'User')) {
    if (field.name === 'login') out[field.alias ?? field.name] = login;
    else if (field.name === 'id') out[field.alias ?? field.name] = VIEWER.id;
    else if (field.name === 'name') out[field.alias ?? field.name] = login === state.viewerLogin ? VIEWER.name : login;
    else if (field.name === 'email') out[field.alias ?? field.name] = login === state.viewerLogin ? VIEWER.email : `${login}@example.invalid`;
    else if (field.name === '__typename') out[field.alias ?? field.name] = 'User';
    else out[field.alias ?? field.name] = unknownField(state, field.name, 'User');
  }
  return out;
}

function viewerUser(state: ExecState, children: GField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of flattenFields(children, 'User')) {
    if (field.name === 'login') out[field.alias ?? field.name] = state.viewerLogin;
    else if (field.name === 'id') out[field.alias ?? field.name] = VIEWER.id;
    else if (field.name === 'name') out[field.alias ?? field.name] = VIEWER.name;
    else if (field.name === 'email') out[field.alias ?? field.name] = VIEWER.email;
    else if (field.name === '__typename') out[field.alias ?? field.name] = 'User';
    else out[field.alias ?? field.name] = unknownField(state, field.name, 'User');
  }
  return out;
}

function projectLabel(
  state: ExecState,
  repo: Repo,
  labelName: string,
  children: GField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of flattenFields(children, 'Label')) {
    if (field.name === 'name') out[field.alias ?? field.name] = labelName;
    else if (field.name === 'color') out[field.alias ?? field.name] = repo.labels.get(labelName)?.color ?? 'ededed';
    else if (field.name === 'id') out[field.alias ?? field.name] = globalId('Label', `${repo.owner}/${repo.name}#${labelName}`);
    else if (field.name === '__typename') out[field.alias ?? field.name] = 'Label';
    else out[field.alias ?? field.name] = unknownField(state, field.name, 'Label');
  }
  return out;
}

function projectConnection<T>(
  state: ExecState,
  items: T[],
  args: Record<string, unknown>,
  children: GField[],
  typename: string,
  projectItem: (item: T, itemChildren: GField[]) => unknown,
): Record<string, unknown> {
  const first = argInt(args, 'first');
  const afterIndex = parseCursor(args['after']);
  const start = afterIndex < 0 ? 0 : afterIndex + 1;
  const page = first === null ? items.slice(start) : items.slice(start, start + Math.max(0, first));
  const out: Record<string, unknown> = {};
  for (const field of flattenFields(children, typename)) {
    const key = field.alias ?? field.name;
    if (field.name === 'edges') {
      out[key] = page.map((item, offset) => {
        const edge: Record<string, unknown> = {};
        const globalIndex = start + offset;
        for (const edgeField of flattenFields(field.children, `${typename}Edge`)) {
          if (edgeField.name === 'node') edge[edgeField.alias ?? edgeField.name] = projectItem(item, edgeField.children);
          else if (edgeField.name === 'cursor') edge[edgeField.alias ?? edgeField.name] = cursorFor(globalIndex);
          else if (edgeField.name === '__typename') edge[edgeField.alias ?? edgeField.name] = `${typename}Edge`;
          else edge[edgeField.alias ?? edgeField.name] = unknownField(state, edgeField.name, `${typename}Edge`);
        }
        return edge;
      });
    } else if (field.name === 'nodes') {
      out[key] = page.map((item) => projectItem(item, field.children));
    } else if (field.name === 'totalCount') {
      out[key] = items.length;
    } else if (field.name === 'pageInfo') {
      const info: Record<string, unknown> = {};
      for (const infoField of flattenFields(field.children, 'PageInfo')) {
        const infoKey = infoField.alias ?? infoField.name;
        if (infoField.name === 'hasNextPage') info[infoKey] = start + page.length < items.length;
        else if (infoField.name === 'hasPreviousPage') info[infoKey] = start > 0;
        else if (infoField.name === 'startCursor') info[infoKey] = page.length > 0 ? cursorFor(start) : null;
        else if (infoField.name === 'endCursor') info[infoKey] = page.length > 0 ? cursorFor(start + page.length - 1) : null;
        else if (infoField.name === '__typename') info[infoKey] = 'PageInfo';
        else info[infoKey] = unknownField(state, infoField.name, 'PageInfo');
      }
      out[key] = info;
    } else if (field.name === '__typename') {
      out[key] = typename;
    } else {
      out[key] = unknownField(state, field.name, typename);
    }
  }
  return out;
}

function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const sorted = [...issues];
  if (isRecord(orderBy)) {
    const field = orderBy['field'];
    const direction = orderBy['direction'];
    const desc = direction === 'DESC';
    if (field === 'CREATED_AT' || field === 'UPDATED_AT') {
      sorted.sort((a, b) => {
        const byTime =
          field === 'CREATED_AT'
            ? a.createdAt < b.createdAt
              ? -1
              : a.createdAt > b.createdAt
                ? 1
                : 0
            : a.updatedAt < b.updatedAt
              ? -1
              : a.updatedAt > b.updatedAt
                ? 1
                : 0;
        if (byTime !== 0) return desc ? -byTime : byTime;
        // Ties (same timestamp) break by number, same direction as the sort.
        return desc ? b.number - a.number : a.number - b.number;
      });
      return sorted;
    }
  }
  sorted.sort((a, b) => a.seq - b.seq);
  return sorted;
}

function filterIssues(issues: Issue[], states: unknown): Issue[] {
  if (!Array.isArray(states) || states.length === 0) return issues;
  const wanted = new Set(states.map((entry) => String(entry)));
  return issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function sortPulls(pulls: PullRequest[], orderBy: unknown): PullRequest[] {
  const sorted = [...pulls];
  if (isRecord(orderBy)) {
    const desc = orderBy['direction'] === 'DESC';
    sorted.sort((a, b) => {
      const byTime = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
      if (byTime !== 0) return desc ? -byTime : byTime;
      return desc ? b.number - a.number : a.number - b.number;
    });
    return sorted;
  }
  sorted.sort((a, b) => a.seq - b.seq);
  return sorted;
}

function filterPulls(pulls: PullRequest[], states: unknown): PullRequest[] {
  if (!Array.isArray(states) || states.length === 0) return pulls;
  const wanted = new Set(states.map((entry) => String(entry)));
  return pulls.filter((pull) => wanted.has(pullState(pull)));
}

function projectIssue(
  state: ExecState,
  repo: Repo,
  issue: Issue,
  children: GField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of flattenFields(children, 'Issue')) {
    const key = field.alias ?? field.name;
    if (field.name === 'id') out[key] = globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
    else if (field.name === 'databaseId') out[key] = issue.id;
    else if (field.name === 'number') out[key] = issue.number;
    else if (field.name === 'title') out[key] = issue.title;
    else if (field.name === 'body') out[key] = issue.body;
    else if (field.name === 'state') out[key] = issue.state === 'open' ? 'OPEN' : 'CLOSED';
    else if (field.name === 'createdAt') out[key] = issue.createdAt;
    else if (field.name === 'updatedAt') out[key] = issue.updatedAt;
    else if (field.name === 'labels') {
      out[key] = projectConnection(state, issue.labels, field.args, field.children, 'LabelConnection', (labelName, itemChildren) =>
        projectLabel(state, repo, labelName, itemChildren),
      );
    } else if (field.name === 'author') out[key] = projectUser(state, state.viewerLogin, field.children);
    else if (field.name === 'repository') out[key] = projectRepo(state, repo, field.children);
    else if (field.name === '__typename') out[key] = 'Issue';
    else out[key] = unknownField(state, field.name, 'Issue');
  }
  return out;
}

function projectPull(
  state: ExecState,
  repo: Repo,
  pull: PullRequest,
  children: GField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of flattenFields(children, 'PullRequest')) {
    const key = field.alias ?? field.name;
    if (field.name === 'id') out[key] = globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
    else if (field.name === 'databaseId') out[key] = pull.id;
    else if (field.name === 'number') out[key] = pull.number;
    else if (field.name === 'title') out[key] = pull.title;
    else if (field.name === 'body') out[key] = pull.body;
    else if (field.name === 'state') out[key] = pullState(pull);
    else if (field.name === 'merged') out[key] = pull.merged;
    else if (field.name === 'mergeable') out[key] = state.store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    else if (field.name === 'headRefName') out[key] = pull.headRef;
    else if (field.name === 'baseRefName') out[key] = pull.baseRef;
    else if (field.name === 'createdAt') out[key] = pull.createdAt;
    else if (field.name === 'updatedAt') out[key] = pull.createdAt;
    else if (field.name === 'files') {
      const files = state.store.pullFiles(repo, pull);
      out[key] = projectConnection(
        state,
        files,
        field.args,
        field.children,
        'PullRequestChangedFileConnection',
        (file, itemChildren) => {
          const node: Record<string, unknown> = {};
          for (const fileField of flattenFields(itemChildren, 'PullRequestChangedFile')) {
            const fileKey = fileField.alias ?? fileField.name;
            if (fileField.name === 'path' || fileField.name === 'filename') node[fileKey] = file.filename;
            else if (fileField.name === 'additions') node[fileKey] = file.additions;
            else if (fileField.name === 'deletions') node[fileKey] = file.deletions;
            else if (fileField.name === 'changes') node[fileKey] = file.changes;
            else if (fileField.name === 'status') {
              node[fileKey] = file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED';
            } else if (fileField.name === '__typename') node[fileKey] = 'PullRequestChangedFile';
            else node[fileKey] = unknownField(state, fileField.name, 'PullRequestChangedFile');
          }
          return node;
        },
      );
    } else if (field.name === 'author') out[key] = projectUser(state, state.viewerLogin, field.children);
    else if (field.name === 'repository') out[key] = projectRepo(state, repo, field.children);
    else if (field.name === '__typename') out[key] = 'PullRequest';
    else out[key] = unknownField(state, field.name, 'PullRequest');
  }
  return out;
}

function projectRepo(
  state: ExecState,
  repo: Repo,
  children: GField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of flattenFields(children, 'Repository')) {
    const key = field.alias ?? field.name;
    if (field.name === 'id') out[key] = globalId('Repository', `${repo.owner}/${repo.name}`);
    else if (field.name === 'databaseId') out[key] = repo.id;
    else if (field.name === 'name') out[key] = repo.name;
    else if (field.name === 'nameWithOwner') out[key] = `${repo.owner}/${repo.name}`;
    else if (field.name === 'description') out[key] = repo.description;
    else if (field.name === 'isPrivate') out[key] = repo.private;
    else if (field.name === 'createdAt') out[key] = repo.createdAt;
    else if (field.name === 'updatedAt') out[key] = repo.updatedAt;
    else if (field.name === 'viewerPermission') out[key] = 'ADMIN';
    else if (field.name === 'hasIssuesEnabled') out[key] = true;
    else if (field.name === 'owner') out[key] = projectUser(state, repo.owner, field.children);
    else if (field.name === 'defaultBranchRef') {
      const tip = state.store.refTip(repo, repo.defaultBranch);
      const ref: Record<string, unknown> = {};
      for (const refField of flattenFields(field.children, 'Ref')) {
        const refKey = refField.alias ?? refField.name;
        if (refField.name === 'name') ref[refKey] = repo.defaultBranch;
        else if (refField.name === 'target') {
          const target: Record<string, unknown> = {};
          for (const targetField of flattenFields(refField.children, 'Commit')) {
            const targetKey = targetField.alias ?? targetField.name;
            if (targetField.name === 'oid') target[targetKey] = tip ?? ZERO_OID;
            else if (targetField.name === '__typename') target[targetKey] = 'Commit';
            else target[targetKey] = unknownField(state, targetField.name, 'Commit');
          }
          ref[refKey] = target;
        } else if (refField.name === '__typename') ref[refKey] = 'Ref';
        else ref[refKey] = unknownField(state, refField.name, 'Ref');
      }
      out[key] = ref;
    } else if (field.name === 'issue') {
      const number = argInt(field.args, 'number');
      const issue = number === null ? undefined : state.store.getIssue(repo, number);
      out[key] = issue ? projectIssue(state, repo, issue, field.children) : null;
    } else if (field.name === 'issues') {
      const items = sortIssues(filterIssues(repo.issues, field.args['states']), field.args['orderBy']);
      out[key] = projectConnection(state, items, field.args, field.children, 'IssueConnection', (issue, itemChildren) =>
        projectIssue(state, repo, issue, itemChildren),
      );
    } else if (field.name === 'pullRequest') {
      const number = argInt(field.args, 'number');
      const pull = number === null ? undefined : state.store.getPull(repo, number);
      out[key] = pull ? projectPull(state, repo, pull, field.children) : null;
    } else if (field.name === 'pullRequests') {
      const items = sortPulls(filterPulls(repo.pulls, field.args['states']), field.args['orderBy']);
      out[key] = projectConnection(state, items, field.args, field.children, 'PullRequestConnection', (pull, itemChildren) =>
        projectPull(state, repo, pull, itemChildren),
      );
    } else if (field.name === 'issueCount') {
      out[key] = filterIssues(repo.issues, field.args['states']).length;
    } else if (field.name === 'pullRequestCount') {
      out[key] = filterPulls(repo.pulls, field.args['states']).length;
    } else if (field.name === '__typename') out[key] = 'Repository';
    else out[key] = unknownField(state, field.name, 'Repository');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Introspection projectors
// ---------------------------------------------------------------------------------------------

function projectType(
  state: ExecState,
  typeName: string,
  children: GField[],
): Record<string, unknown> | null {
  const def = TYPE_DEFS[typeName];
  if (!def) return null;
  const out: Record<string, unknown> = {};
  for (const field of flattenFields(children, '__Type')) {
    const key = field.alias ?? field.name;
    if (field.name === 'name') out[key] = typeName;
    else if (field.name === 'kind') out[key] = def.kind;
    else if (field.name === 'description') out[key] = null;
    else if (field.name === 'fields') {
      out[key] = def.fields.map((fieldName) => {
        const entry: Record<string, unknown> = {};
        for (const entryField of flattenFields(field.children, '__Field')) {
          const entryKey = entryField.alias ?? entryField.name;
          if (entryField.name === 'name') entry[entryKey] = fieldName;
          else if (entryField.name === 'description') entry[entryKey] = null;
          else if (entryField.name === 'args') entry[entryKey] = [];
          else if (entryField.name === '__typename') entry[entryKey] = '__Field';
          else entry[entryKey] = unknownField(state, entryField.name, '__Field');
        }
        return entry;
      });
    } else if (field.name === 'enumValues') {
      out[key] = def.enumValues.map((valueName) => {
        const entry: Record<string, unknown> = {};
        for (const entryField of flattenFields(field.children, '__EnumValue')) {
          const entryKey = entryField.alias ?? entryField.name;
          if (entryField.name === 'name') entry[entryKey] = valueName;
          else if (entryField.name === 'description') entry[entryKey] = null;
          else if (entryField.name === '__typename') entry[entryKey] = '__EnumValue';
          else entry[entryKey] = unknownField(state, entryField.name, '__EnumValue');
        }
        return entry;
      });
    } else if (field.name === '__typename') out[key] = '__Type';
    else out[key] = unknownField(state, field.name, '__Type');
  }
  return out;
}

function projectSchema(state: ExecState, children: GField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of flattenFields(children, '__Schema')) {
    const key = field.alias ?? field.name;
    if (field.name === 'queryType') {
      const entry: Record<string, unknown> = {};
      for (const entryField of flattenFields(field.children, '__Type')) {
        const entryKey = entryField.alias ?? entryField.name;
        if (entryField.name === 'name') entry[entryKey] = 'Query';
        else if (entryField.name === 'kind') entry[entryKey] = 'OBJECT';
        else if (entryField.name === '__typename') entry[entryKey] = '__Type';
        else entry[entryKey] = unknownField(state, entryField.name, '__Type');
      }
      out[key] = entry;
    } else if (field.name === 'mutationType') {
      const entry: Record<string, unknown> = {};
      for (const entryField of flattenFields(field.children, '__Type')) {
        const entryKey = entryField.alias ?? entryField.name;
        if (entryField.name === 'name') entry[entryKey] = 'Mutation';
        else if (entryField.name === 'kind') entry[entryKey] = 'OBJECT';
        else if (entryField.name === '__typename') entry[entryKey] = '__Type';
        else entry[entryKey] = unknownField(state, entryField.name, '__Type');
      }
      out[key] = entry;
    } else if (field.name === 'subscriptionType') out[key] = null;
    else if (field.name === 'types') {
      out[key] = Object.keys(TYPE_DEFS).map((typeName) => projectType(state, typeName, field.children));
    } else if (field.name === 'directives') out[key] = [];
    else if (field.name === '__typename') out[key] = '__Schema';
    else out[key] = unknownField(state, field.name, '__Schema');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Root fields: queries and mutations
// ---------------------------------------------------------------------------------------------

function resolveRoot(state: ExecState, op: GOperation, field: GField): unknown {
  const typeName = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const key = field.alias ?? field.name;
  void key;
  switch (field.name) {
    case '__typename':
      return typeName;
    case 'viewer':
      return viewerUser(state, field.children);
    case 'repository': {
      const owner = argString(field.args, 'owner');
      const name = argString(field.args, 'name');
      if (owner === null || name === null) return null;
      if (owner !== state.viewerLogin) return null;
      const repo = state.store.getRepo(owner, name);
      if (!repo) return null;
      return projectRepo(state, repo, field.children);
    }
    case 'node': {
      const id = argString(field.args, 'id');
      if (id === null) return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoFromGlobalId(state.store, id);
        if (!repo) return null;
        return projectRepo(state, repo, field.children);
      }
      if (decoded.kind === 'Issue') {
        const found = issueFromGlobalId(state.store, id);
        if (!found) return null;
        return projectIssue(state, found.repo, found.issue, field.children);
      }
      if (decoded.kind === 'PullRequest') {
        const found = pullFromGlobalId(state.store, id);
        if (!found) return null;
        return projectPull(state, found.repo, found.pull, field.children);
      }
      return null;
    }
    case 'search': {
      const query = argString(field.args, 'query') ?? '';
      const needle = query.toLowerCase();
      const matches: Array<{ repo: Repo; issue: Issue }> = [];
      for (const repo of state.store.listRepos(state.viewerLogin)) {
        for (const issue of repo.issues) {
          if (needle === '' || issue.title.toLowerCase().includes(needle) || issue.body.toLowerCase().includes(needle)) {
            matches.push({ repo, issue });
          }
        }
      }
      return projectConnection(
        state,
        matches,
        field.args,
        field.children,
        'SearchResultItemConnection',
        (match, itemChildren) => projectIssue(state, match.repo, match.issue, itemChildren),
      );
    }
    case '__type': {
      const name = argString(field.args, 'name');
      if (name === null) return null;
      return projectType(state, name, field.children);
    }
    case '__schema':
      return projectSchema(state, field.children);
    case 'createIssue':
      return mutateCreateIssue(state, field);
    case 'closeIssue':
      return mutateCloseIssue(state, field);
    case 'createPullRequest':
      return mutateCreatePullRequest(state, field);
    case 'mergePullRequest':
      return mutateMergePullRequest(state, field);
    case 'addComment':
      return mutateAddComment(state, field);
    case 'createRepository':
      return mutateCreateRepository(state, field);
    default:
      return unknownField(state, field.name, typeName);
  }
}

function projectPayload(
  state: ExecState,
  field: GField,
  resolve: (child: GField) => unknown,
  typeName: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of flattenFields(field.children, typeName)) {
    out[child.alias ?? child.name] = resolve(child);
  }
  return out;
}

function mutateCreateIssue(state: ExecState, field: GField): Record<string, unknown> {
  const input = isRecord(field.args['input']) ? field.args['input'] : {};
  const repositoryId = typeof input['repositoryId'] === 'string' ? input['repositoryId'] : '';
  const repo = repoFromGlobalId(state.store, repositoryId);
  if (!repo) {
    addError(state, 'createIssue: repository not found for the given repositoryId');
    return projectPayload(state, field, (child) => {
      if (child.name === 'issue') return null;
      if (child.name === 'clientMutationId') return typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null;
      return unknownField(state, child.name, 'CreateIssuePayload');
    }, 'CreateIssuePayload');
  }
  const title = typeof input['title'] === 'string' ? input['title'] : '';
  const body = typeof input['body'] === 'string' ? input['body'] : '';
  const issue = state.store.createIssue(repo, title, body, []);
  return projectPayload(state, field, (child) => {
    if (child.name === 'issue') return projectIssue(state, repo, issue, child.children);
    if (child.name === 'clientMutationId') return typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null;
    return unknownField(state, child.name, 'CreateIssuePayload');
  }, 'CreateIssuePayload');
}

function mutateCloseIssue(state: ExecState, field: GField): Record<string, unknown> {
  const input = isRecord(field.args['input']) ? field.args['input'] : {};
  const issueId = typeof input['issueId'] === 'string' ? input['issueId'] : '';
  const found = issueFromGlobalId(state.store, issueId);
  if (!found) {
    addError(state, 'closeIssue: issue not found for the given issueId');
    return projectPayload(state, field, (child) => {
      if (child.name === 'issue') return null;
      if (child.name === 'clientMutationId') return typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null;
      return unknownField(state, child.name, 'CloseIssuePayload');
    }, 'CloseIssuePayload');
  }
  found.issue.state = 'closed';
  found.issue.updatedAt = state.store.stamp();
  return projectPayload(state, field, (child) => {
    if (child.name === 'issue') return projectIssue(state, found.repo, found.issue, child.children);
    if (child.name === 'clientMutationId') return typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null;
    return unknownField(state, child.name, 'CloseIssuePayload');
  }, 'CloseIssuePayload');
}

function mutateCreatePullRequest(state: ExecState, field: GField): Record<string, unknown> {
  const input = isRecord(field.args['input']) ? field.args['input'] : {};
  const repositoryId = typeof input['repositoryId'] === 'string' ? input['repositoryId'] : '';
  const repo = repoFromGlobalId(state.store, repositoryId);
  const head = typeof input['headRefName'] === 'string' ? input['headRefName'] : '';
  const base = typeof input['baseRefName'] === 'string' ? input['baseRefName'] : '';
  const title = typeof input['title'] === 'string' ? input['title'] : '';
  const body = typeof input['body'] === 'string' ? input['body'] : '';
  if (!repo) {
    addError(state, 'createPullRequest: repository not found for the given repositoryId');
    return projectPayload(state, field, (child) => {
      if (child.name === 'pullRequest') return null;
      if (child.name === 'clientMutationId') return typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null;
      return unknownField(state, child.name, 'CreatePullRequestPayload');
    }, 'CreatePullRequestPayload');
  }
  const pull = state.store.createPull(repo, title, body, head, base);
  if (!pull) {
    addError(state, `createPullRequest: head branch "${head}" or base branch "${base}" does not exist`);
    return projectPayload(state, field, (child) => {
      if (child.name === 'pullRequest') return null;
      if (child.name === 'clientMutationId') return typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null;
      return unknownField(state, child.name, 'CreatePullRequestPayload');
    }, 'CreatePullRequestPayload');
  }
  return projectPayload(state, field, (child) => {
    if (child.name === 'pullRequest') return projectPull(state, repo, pull, child.children);
    if (child.name === 'clientMutationId') return typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null;
    return unknownField(state, child.name, 'CreatePullRequestPayload');
  }, 'CreatePullRequestPayload');
}

function mutateMergePullRequest(state: ExecState, field: GField): Record<string, unknown> {
  const input = isRecord(field.args['input']) ? field.args['input'] : {};
  const pullRequestId = typeof input['pullRequestId'] === 'string' ? input['pullRequestId'] : '';
  const found = pullFromGlobalId(state.store, pullRequestId);
  if (!found) {
    addError(state, 'mergePullRequest: pull request not found for the given pullRequestId');
    return projectPayload(state, field, (child) => {
      if (child.name === 'pullRequest') return null;
      if (child.name === 'clientMutationId') return typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null;
      return unknownField(state, child.name, 'MergePullRequestPayload');
    }, 'MergePullRequestPayload');
  }
  const result = state.store.mergePull(found.repo, found.pull);
  if ('conflict' in result) {
    addError(state, `mergePullRequest: pull request #${found.pull.number} cannot be merged`);
  }
  return projectPayload(state, field, (child) => {
    if (child.name === 'pullRequest') return projectPull(state, found.repo, found.pull, child.children);
    if (child.name === 'clientMutationId') return typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null;
    return unknownField(state, child.name, 'MergePullRequestPayload');
  }, 'MergePullRequestPayload');
}

function mutateAddComment(state: ExecState, field: GField): Record<string, unknown> {
  const input = isRecord(field.args['input']) ? field.args['input'] : {};
  const subjectId = typeof input['subjectId'] === 'string' ? input['subjectId'] : '';
  const body = typeof input['body'] === 'string' ? input['body'] : '';
  const found = issueFromGlobalId(state.store, subjectId);
  if (!found) {
    addError(state, 'addComment: subject not found for the given subjectId');
    return projectPayload(state, field, (child) => {
      if (child.name === 'commentEdge') return null;
      if (child.name === 'clientMutationId') return typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null;
      return unknownField(state, child.name, 'AddCommentPayload');
    }, 'AddCommentPayload');
  }
  const { repo, issue } = found;
  const existing = repo.comments.get(issue.number) ?? [];
  const commentId = 100000 + repo.id * 10000 + issue.number * 100 + existing.length + 1;
  const comment = { id: commentId, body, createdAt: state.store.stamp() };
  existing.push(comment);
  repo.comments.set(issue.number, existing);
  return projectPayload(state, field, (child) => {
    if (child.name === 'commentEdge') {
      const edge: Record<string, unknown> = {};
      for (const edgeField of flattenFields(child.children, 'IssueCommentEdge')) {
        if (edgeField.name === 'node') {
          const node: Record<string, unknown> = {};
          for (const nodeField of flattenFields(edgeField.children, 'IssueComment')) {
            const nodeKey = nodeField.alias ?? nodeField.name;
            if (nodeField.name === 'id') node[nodeKey] = globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${commentId}`);
            else if (nodeField.name === 'body') node[nodeKey] = body;
            else if (nodeField.name === 'createdAt') node[nodeKey] = comment.createdAt;
            else if (nodeField.name === 'author') node[nodeKey] = projectUser(state, state.viewerLogin, nodeField.children);
            else if (nodeField.name === '__typename') node[nodeKey] = 'IssueComment';
            else node[nodeKey] = unknownField(state, nodeField.name, 'IssueComment');
          }
          edge[edgeField.alias ?? edgeField.name] = node;
        } else if (edgeField.name === 'cursor') edge[edgeField.alias ?? edgeField.name] = cursorFor(existing.length - 1);
        else if (edgeField.name === '__typename') edge[edgeField.alias ?? edgeField.name] = 'IssueCommentEdge';
        else edge[edgeField.alias ?? edgeField.name] = unknownField(state, edgeField.name, 'IssueCommentEdge');
      }
      return edge;
    }
    if (child.name === 'clientMutationId') return typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null;
    return unknownField(state, child.name, 'AddCommentPayload');
  }, 'AddCommentPayload');
}

function mutateCreateRepository(state: ExecState, field: GField): Record<string, unknown> {
  const input = isRecord(field.args['input']) ? field.args['input'] : {};
  const name = typeof input['name'] === 'string' ? input['name'] : '';
  const description = typeof input['description'] === 'string' ? input['description'] : '';
  const visibility = typeof input['visibility'] === 'string' ? input['visibility'] : '';
  const isPrivate = input['private'] === true || visibility === 'PRIVATE';
  if (name === '') {
    addError(state, 'createRepository: a name is required');
    return projectPayload(state, field, (child) => {
      if (child.name === 'repository') return null;
      if (child.name === 'clientMutationId') return typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null;
      return unknownField(state, child.name, 'CreateRepositoryPayload');
    }, 'CreateRepositoryPayload');
  }
  const repo = state.store.createRepo(state.viewerLogin, name, { description, private: isPrivate });
  if (!repo) {
    addError(state, `createRepository: repository "${name}" already exists`);
    return projectPayload(state, field, (child) => {
      if (child.name === 'repository') return null;
      if (child.name === 'clientMutationId') return typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null;
      return unknownField(state, child.name, 'CreateRepositoryPayload');
    }, 'CreateRepositoryPayload');
  }
  return projectPayload(state, field, (child) => {
    if (child.name === 'repository') return projectRepo(state, repo, child.children);
    if (child.name === 'clientMutationId') return typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null;
    return unknownField(state, child.name, 'CreateRepositoryPayload');
  }, 'CreateRepositoryPayload');
}

// ---------------------------------------------------------------------------------------------
// One operation -> one result envelope
// ---------------------------------------------------------------------------------------------

interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function runQueryText(query: string, variables: Record<string, unknown>, ctx: Ctx): GraphQLResult {
  const state: ExecState = { store: ctx.store, viewerLogin: ctx.viewerLogin, errors: [] };
  let operation: GOperation;
  try {
    operation = new Parser(query, variables).parseOperation();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const data: Record<string, unknown> = {};
  for (const field of operation.fields) {
    if (field.fragmentOn !== null) continue;
    data[field.alias ?? field.name] = resolveRoot(state, operation, field);
  }
  if (state.errors.length > 0) return { data, errors: state.errors };
  return { data };
}

function runOperationObject(
  entry: unknown,
  ctx: Ctx,
): GraphQLResult | GraphQLResult[] {
  if (!isRecord(entry) || typeof entry['query'] !== 'string') {
    return { data: null, errors: [{ message: 'Each batched entry must be an object with a query string' }] };
  }
  const variables = isRecord(entry['variables']) ? (entry['variables'] as Record<string, unknown>) : {};
  const operationName = typeof entry['operationName'] === 'string' ? entry['operationName'] : null;
  const parts = splitOperations(entry['query']);
  if (parts.length > 1) {
    if (operationName !== null) {
      for (const part of parts) {
        try {
          const parsed = new Parser(part, variables).parseOperation();
          if (parsed.name === operationName) return runQueryText(part, variables, ctx);
        } catch {
          // try the next part
        }
      }
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
    return parts.map((part) => runQueryText(part, variables, ctx));
  }
  if (operationName !== null) {
    try {
      const parsed = new Parser(entry['query'], variables).parseOperation();
      if (parsed.name !== null && parsed.name !== operationName) {
        return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
      }
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  }
  return runQueryText(entry['query'], variables, ctx);
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------

function jsonReply(status: number, value: unknown): Reply {
  return { status, body: JSON.stringify(value), contentType: 'application/json' };
}

export async function graphqlHandler(ctx: Ctx): Promise<Reply | null> {
  if (ctx.pathname !== '/api/graphql') return null;
  if (ctx.method !== 'POST') {
    return jsonReply(405, { message: 'Method not allowed' });
  }
  if (!isAuthenticated(ctx)) {
    return jsonReply(401, { message: 'Unauthorized' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return jsonReply(400, { errors: [{ message: 'Malformed JSON body' }] });
  }
  if (Array.isArray(parsed)) {
    // GitHub operation batching: a JSON array of operations, answered in order.
    const results = parsed.map((entry) => runOperationObject(entry, ctx));
    return jsonReply(200, results);
  }
  if (!isRecord(parsed) || typeof parsed['query'] !== 'string') {
    return jsonReply(400, { errors: [{ message: 'Request body must be a JSON object with a query string' }] });
  }
  const result = runOperationObject(parsed, ctx);
  return jsonReply(200, result);
}
