// The MCP surface: POST /mcp, JSON-RPC 2.0 over Streamable HTTP.
//
// Speaks both protocol eras the suite negotiates:
//   modern 2026-07-28: `server/discover` (no handshake, no session), every
//     request declaring its revision in `_meta` / the MCP-Protocol-Version header;
//   legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`,
//     with an optional Mcp-Session-Id echoed back in responses.
// Answers are plain JSON (Content-Type: application/json); the client accepts
// that in place of an SSE stream. Node 22 stdlib only; no Date.now /
// Math.random anywhere the suite can see.

import { VIEWER, isAuthenticated } from './store.ts';
import type { Ctx, Issue, PullRequest, Repo, Reply } from './store.ts';

// ---------------------------------------------------------------------------------------------
// Server identity and the tool catalogue (built once: two tools/list calls
// must be byte-identical, so this table is a module-level constant)
// ---------------------------------------------------------------------------------------------

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login; defaults to the authenticated user.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository. Any label it names must already exist in the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to attach; each must already exist.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed, or all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: [],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge an open pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        number: { type: 'integer', description: 'Alias for pull_number.' },
      },
      required: ['pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by a user (defaults to the authenticated user).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login; defaults to the authenticated user.' },
      },
      required: [],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
        number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['number'],
    },
  },
  {
    name: 'close_issue',
    description: 'Close an issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
        number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['number'],
    },
  },
  {
    name: 'create_label',
    description: 'Create a label in a repository (an issue may only carry labels created first).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
        name: { type: 'string', description: 'The label name.' },
        color: { type: 'string', description: 'The label colour as six hex digits.' },
      },
      required: ['name'],
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function headerOf(ctx: Ctx, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of ctx.headers) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** The first defined, non-empty argument under any of the candidate names. */
function arg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function argStr(args: Record<string, unknown>, ...names: string[]): string | undefined {
  const value = arg(args, ...names);
  return typeof value === 'string' ? value : undefined;
}

function argNum(args: Record<string, unknown>, ...names: string[]): number | undefined {
  const value = arg(args, ...names);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  return undefined;
}

function argBool(args: Record<string, unknown>, ...names: string[]): boolean {
  const value = arg(args, ...names);
  return value === true || value === 'true';
}

// ---------------------------------------------------------------------------------------------
// Store projections (the same shapes REST serves, so ids are stable across surfaces)
// ---------------------------------------------------------------------------------------------

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login, id: VIEWER.id },
    repository: `${repo.owner}/${repo.name}`,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullObject(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable: pull.mergeable,
    created_at: pull.createdAt,
  };
}

interface RepoLookup {
  owner: string;
  repoName: string;
  repo: Repo;
}

/** Resolve owner/repo from the many argument spellings the suite may send. */
function resolveRepo(ctx: Ctx, args: Record<string, unknown>): RepoLookup | { error: string } {
  const fullName = argStr(args, 'full_name', 'fullname', 'repository_full_name');
  let owner = argStr(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login');
  let repoName = argStr(args, 'repo', 'repository', 'repo_name', 'repository_name', 'repo_slug', 'project', 'project_name', 'name');
  if (fullName !== undefined && fullName.includes('/')) {
    const slash = fullName.indexOf('/');
    const fullOwner = fullName.slice(0, slash);
    const fullRepo = fullName.slice(slash + 1);
    if (repoName === undefined) repoName = fullRepo;
    if (owner === undefined) owner = fullOwner;
  }
  if (owner === undefined) owner = ctx.viewerLogin;
  if (repoName === undefined) return { error: 'Missing required argument: repo' };
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) return { error: `Repository not found: ${owner}/${repoName}` };
  return { owner, repoName, repo };
}

// ---------------------------------------------------------------------------------------------
// Tool implementations. Each returns either { value } (success) or { toolError } (isError).
// ---------------------------------------------------------------------------------------------

type ToolOutcome = { value: unknown } | { toolError: string };

function toolCreateRepo(ctx: Ctx, args: Record<string, unknown>): ToolOutcome {
  const name = argStr(args, 'name', 'repo', 'repository', 'repository_name', 'repo_name');
  if (name === undefined) return { toolError: 'Missing required argument: name' };
  const description = argStr(args, 'description', 'about', 'summary', 'body') ?? '';
  const isPrivate = argBool(args, 'private', 'is_private');
  const repo = ctx.store.createRepo(ctx.viewerLogin, name, { description, private: isPrivate });
  if (!repo) return { toolError: `Repository already exists: ${ctx.viewerLogin}/${name}` };
  return { value: repoObject(repo) };
}

function toolGetRepo(ctx: Ctx, args: Record<string, unknown>): ToolOutcome {
  const found = resolveRepo(ctx, args);
  if ('error' in found) return { toolError: found.error };
  return { value: repoObject(found.repo) };
}

function toolCreateIssue(ctx: Ctx, args: Record<string, unknown>): ToolOutcome {
  const found = resolveRepo(ctx, args);
  if ('error' in found) return { toolError: found.error };
  const title = argStr(args, 'title', 'issue_title', 'pr_title', 'subject');
  if (title === undefined) return { toolError: 'Missing required argument: title' };
  const body = argStr(args, 'body', 'issue_body', 'description', 'content', 'text') ?? '';
  const rawLabels = arg(args, 'labels');
  const labels: string[] = [];
  if (rawLabels !== undefined) {
    const list = Array.isArray(rawLabels) ? rawLabels : [rawLabels];
    for (const entry of list) {
      if (typeof entry !== 'string') continue;
      const names = entry.includes(',') ? entry.split(',').map((part) => part.trim()) : [entry];
      for (const name of names) {
        if (name === '') continue;
        if (!found.repo.labels.has(name)) return { toolError: `Label does not exist: ${name}` };
        labels.push(name);
      }
    }
  }
  const issue = ctx.store.createIssue(found.repo, title, body, labels);
  return { value: issueObject(found.repo, issue) };
}

function toolListIssues(ctx: Ctx, args: Record<string, unknown>): ToolOutcome {
  const found = resolveRepo(ctx, args);
  if ('error' in found) return { toolError: found.error };
  const state = (argStr(args, 'state', 'status') ?? 'open').toLowerCase();
  const issues = found.repo.issues.filter((issue) => {
    if (state === 'all') return true;
    if (state === 'closed') return issue.state === 'closed';
    return issue.state === 'open';
  });
  return {
    value: {
      issues: issues.map((issue) => issueObject(found.repo, issue)),
      total_count: issues.length,
    },
  };
}

function toolCreatePullRequest(ctx: Ctx, args: Record<string, unknown>): ToolOutcome {
  const found = resolveRepo(ctx, args);
  if ('error' in found) return { toolError: found.error };
  const title = argStr(args, 'title', 'pr_title', 'pull_request_title', 'subject');
  if (title === undefined) return { toolError: 'Missing required argument: title' };
  const head = argStr(args, 'head', 'head_ref', 'head_branch', 'headRef', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch');
  if (head === undefined) return { toolError: 'Missing required argument: head' };
  const base = argStr(args, 'base', 'base_ref', 'base_branch', 'baseRef', 'target', 'target_ref', 'target_branch', 'into', 'into_branch');
  if (base === undefined) return { toolError: 'Missing required argument: base' };
  const body = argStr(args, 'body', 'description', 'content', 'text') ?? '';
  const pull = ctx.store.createPull(found.repo, title, body, head, base);
  if (!pull) return { toolError: `Cannot create pull request: head branch "${head}" or base branch "${base}" does not exist` };
  return { value: pullObject(found.repo, pull) };
}

function toolMergePullRequest(ctx: Ctx, args: Record<string, unknown>): ToolOutcome {
  const found = resolveRepo(ctx, args);
  if ('error' in found) return { toolError: found.error };
  const number = argNum(args, 'pull_number', 'pullNumber', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index');
  if (number === undefined) return { toolError: 'Missing required argument: pull_number' };
  const pull = ctx.store.getPull(found.repo, number);
  if (!pull) return { toolError: `Pull request not found: #${number}` };
  const result = ctx.store.mergePull(found.repo, pull);
  if ('conflict' in result) return { toolError: `Pull request #${number} cannot be merged: conflict` };
  return { value: { sha: result.sha, merged: true, message: result.message, number: pull.number } };
}

function toolListRepos(ctx: Ctx, args: Record<string, unknown>): ToolOutcome {
  const owner = argStr(args, 'owner', 'owner_login', 'login') ?? ctx.viewerLogin;
  return { value: { repos: ctx.store.listRepos(owner).map((repo) => repoObject(repo)) } };
}

function toolGetIssue(ctx: Ctx, args: Record<string, unknown>): ToolOutcome {
  const found = resolveRepo(ctx, args);
  if ('error' in found) return { toolError: found.error };
  const number = argNum(args, 'number', 'issue_number', 'index');
  if (number === undefined) return { toolError: 'Missing required argument: number' };
  const issue = ctx.store.getIssue(found.repo, number);
  if (!issue) return { toolError: `Issue not found: #${number}` };
  return { value: issueObject(found.repo, issue) };
}

function toolCloseIssue(ctx: Ctx, args: Record<string, unknown>): ToolOutcome {
  const found = resolveRepo(ctx, args);
  if ('error' in found) return { toolError: found.error };
  const number = argNum(args, 'number', 'issue_number', 'index');
  if (number === undefined) return { toolError: 'Missing required argument: number' };
  const issue = ctx.store.getIssue(found.repo, number);
  if (!issue) return { toolError: `Issue not found: #${number}` };
  issue.state = 'closed';
  issue.updatedAt = ctx.store.stamp();
  return { value: issueObject(found.repo, issue) };
}

function toolCreateLabel(ctx: Ctx, args: Record<string, unknown>): ToolOutcome {
  const found = resolveRepo(ctx, args);
  if ('error' in found) return { toolError: found.error };
  const name = argStr(args, 'label', 'name', 'title');
  if (name === undefined) return { toolError: 'Missing required argument: name' };
  const color = argStr(args, 'color') ?? 'ededed';
  const label = ctx.store.createLabel(found.repo, name, color);
  return { value: { name: label.name, color: label.color } };
}

function dispatchTool(ctx: Ctx, name: string, args: Record<string, unknown>): ToolOutcome | { rpcError: { code: number; message: string } } {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  let matched: ToolDef | undefined = TOOLS.find((tool) => tool.name === name);
  if (matched === undefined) {
    matched = TOOLS.find((tool) => {
      const toolNorm = tool.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return normalized === toolNorm || (normalized.length > toolNorm.length && normalized.endsWith(toolNorm));
    });
  }
  if (matched === undefined) {
    return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  switch (matched.name) {
    case 'create_repo':
      return toolCreateRepo(ctx, args);
    case 'get_repo':
      return toolGetRepo(ctx, args);
    case 'create_issue':
      return toolCreateIssue(ctx, args);
    case 'list_issues':
      return toolListIssues(ctx, args);
    case 'create_pull_request':
      return toolCreatePullRequest(ctx, args);
    case 'merge_pull_request':
      return toolMergePullRequest(ctx, args);
    case 'list_repos':
      return toolListRepos(ctx, args);
    case 'get_issue':
      return toolGetIssue(ctx, args);
    case 'close_issue':
      return toolCloseIssue(ctx, args);
    case 'create_label':
      return toolCreateLabel(ctx, args);
    default:
      return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC dispatch. Returns null for a notification (no id): the HTTP layer
// answers 202 with an empty body.
// ---------------------------------------------------------------------------------------------

type JsonRpcId = string | number | null;

interface RpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function discoverResult(): Record<string, unknown> {
  return {
    protocolVersion: '2026-07-28',
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
  };
}

function initializeResult(params: Record<string, unknown>): Record<string, unknown> {
  const requested = params['protocolVersion'];
  const version =
    typeof requested === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : '2025-11-25';
  return {
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

function handleRpc(ctx: Ctx, request: unknown): RpcResponse | null {
  if (!isRecord(request)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const method = request['method'];
  if (typeof method !== 'string' || method === '') {
    const id = 'id' in request && (typeof request['id'] === 'string' || typeof request['id'] === 'number') ? request['id'] : null;
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }
  const hasId = 'id' in request && request['id'] !== undefined && request['id'] !== null;
  const id: JsonRpcId = hasId && (typeof request['id'] === 'string' || typeof request['id'] === 'number') ? request['id'] : null;
  const params = isRecord(request['params']) ? request['params'] : {};

  // Notifications carry no id and get no JSON-RPC response.
  if (!hasId) return null;

  if (method === 'server/discover') {
    return { jsonrpc: '2.0', id, result: discoverResult() };
  }
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: initializeResult(params) };
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const toolName = typeof params['name'] === 'string' ? params['name'] : '';
    const args = isRecord(params['arguments']) ? params['arguments'] : {};
    if (toolName === '') {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing required argument: name' } };
    }
    const outcome = dispatchTool(ctx, toolName, args);
    if ('rpcError' in outcome) {
      return { jsonrpc: '2.0', id, error: outcome.rpcError };
    }
    if ('toolError' in outcome) {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: outcome.toolError }], isError: true },
      };
    }
    const text = JSON.stringify(outcome.value);
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text }], structuredContent: outcome.value },
    };
  }
  if (method.startsWith('notifications/')) {
    return null;
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------

function jsonReply(status: number, value: unknown, headers?: Record<string, string>): Reply {
  return { status, headers, body: JSON.stringify(value), contentType: 'application/json' };
}

export async function mcpHandler(ctx: Ctx): Promise<Reply | null> {
  if (ctx.pathname !== '/mcp') return null;

  if (ctx.method === 'GET') {
    // Capability advertisement: the modern era's server/discover, over GET.
    return jsonReply(200, discoverResult());
  }
  if (ctx.method === 'DELETE') {
    return { status: 200, body: '', contentType: 'application/json' };
  }
  if (ctx.method !== 'POST') {
    return jsonReply(405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed' } });
  }
  if (!isAuthenticated(ctx)) {
    return jsonReply(401, { message: 'Unauthorized' });
  }

  const sessionId = headerOf(ctx, 'mcp-session-id');
  const headers = sessionId !== undefined ? { 'mcp-session-id': sessionId } : undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return jsonReply(
      400,
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      headers,
    );
  }

  if (Array.isArray(parsed)) {
    const responses = parsed.map((entry) => handleRpc(ctx, entry)).filter((entry) => entry !== null);
    return jsonReply(200, responses, headers);
  }

  const response = handleRpc(ctx, parsed);
  if (response === null) {
    // A notification (e.g. notifications/initialized): 202, empty body.
    return { status: 202, headers, body: '', contentType: 'application/json' };
  }
  return jsonReply(200, response, headers);
}
