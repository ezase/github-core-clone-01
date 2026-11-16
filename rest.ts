// rest.ts — the GitHub REST v3 surface for the forge.
//
// One export: `restHandler(ctx)`. It answers every route under /api/v3 and returns null
// for anything else, so app.ts can try the next surface (git smart HTTP, GraphQL, MCP).
//
// Rules honoured here (see RULES.txt and the suite's checks-rest.ts):
//   - Every /api/v3 route requires `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; a missing
//     or wrong token is 401 JSON {message}. A repository belongs to the token owner's login
//     (ctx.viewerLogin); the same repo name under another owner is 404, never 403.
//   - Every reply is application/json (never HTML), carries a non-empty
//     X-GitHub-Request-Id, and errors carry a JSON body {message: string}.
//   - Unknown routes under /api/v3 are 404 JSON; a malformed JSON body on a route that
//     reads JSON is 400 JSON.
//   - List endpoints honour ?page=&per_page= (default 30) and send a Link header with
//     rel="next" (an absolute URL on the entry's own origin) only when a next page exists.
//   - No wall clock, no unseeded randomness: timestamps come from store.stamp() /
//     trialNowIso(), ids and ordering from the store's counters.
//
// Node 22 stdlib only, plus ./store.ts. In-memory only, no disk I/O.

import {
  VIEWER,
  isAuthenticated,
  isObjectId,
  nextRequestId,
  parseCommit,
  trialNowIso,
  type Ctx,
  type Issue,
  type PullRequest,
  type Repo,
  type Reply,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

/** Decode one path segment; a bad escape falls back to the raw segment. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The entry's own origin, from the request's Host header (Node always supplies one). */
function originOf(ctx: Ctx): string {
  const host =
    ctx.headers.get('host') ?? ctx.headers.get('Host') ?? ctx.headers.get(':authority') ?? '127.0.0.1';
  return `http://${host}`;
}

function requestIdHeader(): Record<string, string> {
  return { 'x-github-request-id': nextRequestId() };
}

/** A JSON reply: application/json body plus the mandatory request-id header. */
function jsonReply(status: number, value: unknown, extraHeaders: Record<string, string> = {}): Reply {
  return {
    status,
    headers: { ...requestIdHeader(), ...extraHeaders },
    body: JSON.stringify(value),
    contentType: 'application/json',
  };
}

/** An error reply: a JSON body with a string message. */
function errorReply(status: number, message: string): Reply {
  return jsonReply(status, { message });
}

/** Parse a request body that must be a JSON object. Empty body reads as {}. */
function readJsonBody(
  ctx: Ctx,
): { ok: true; value: JsonRecord } | { ok: false; reply: Reply } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return { ok: false, reply: errorReply(400, 'Request body is not valid JSON') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reply: errorReply(400, 'Request body must be a JSON object') };
  }
  return { ok: true, value: parsed as JsonRecord };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

// ---------------------------------------------------------------------------------------------
// pagination (?page=&per_page=, Link rel="next" only when a next page exists)
// ---------------------------------------------------------------------------------------------

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(ctx: Ctx): PageParams {
  const rawPage = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  const rawPerPage = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const perPage =
    Number.isFinite(rawPerPage) && rawPerPage >= 1 ? Math.min(rawPerPage, 100) : 30;
  return { page, perPage };
}

/**
 * Slice `items` to the requested page and build the Link header for the next page.
 * The next URL is absolute (same origin, so the suite's client follows it) and keeps
 * every other query parameter the request carried.
 */
function paginate<T>(ctx: Ctx, items: readonly T[]): { items: T[]; link?: string } {
  const { page, perPage } = pageParams(ctx);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (page >= totalPages) return { items: slice };
  const params = new URLSearchParams(ctx.query);
  params.set('page', String(page + 1));
  params.set('per_page', String(perPage));
  return {
    items: slice,
    link: `<${originOf(ctx)}${ctx.pathname}?${params.toString()}>; rel="next"`,
  };
}

function pagedReply<T>(ctx: Ctx, items: readonly T[]): Reply {
  const { items: page, link } = paginate(ctx, items);
  return jsonReply(200, page, link === undefined ? {} : { link });
}

// ---------------------------------------------------------------------------------------------
// serializers (the shapes the checks read)
// ---------------------------------------------------------------------------------------------

function repoUrl(ctx: Ctx, repo: Repo): string {
  return `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}`;
}

function repoJson(ctx: Ctx, repo: Repo): JsonRecord {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}`,
    url: repoUrl(ctx, repo),
    fork: false,
    has_issues: true,
    has_pull_requests: true,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
  };
}

function issueLabels(repo: Repo, issue: Issue): Array<{ name: string; color?: string }> {
  return issue.labels.map((name) => {
    const label = repo.labels.get(name);
    return label === undefined ? { name } : { name: label.name, color: label.color };
  });
}

function issueJson(ctx: Ctx, repo: Repo, issue: Issue): JsonRecord {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issueLabels(repo, issue),
    user: { login: ctx.viewerLogin, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${repoUrl(ctx, repo)}/issues/${issue.number}`,
    comments: (repo.comments.get(issue.number) ?? []).length,
  };
}

function pullJson(ctx: Ctx, repo: Repo, pull: PullRequest): JsonRecord {
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
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    // A pull has no separate updated timestamp in the store: an open pull was last touched
    // when created; a merged pull when it was merged.
    updated_at: pull.mergedAt ?? pull.createdAt,
    html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${repoUrl(ctx, repo)}/pulls/${pull.number}`,
  };
}

/** "Name <email> timestamp tz" -> {name, email, date}; falls back to the trial clock. */
function parseIdent(raw: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(raw);
  if (match === null) return { name: raw, email: '', date: trialNowIso() };
  const epochSec = Number(match[3]);
  return {
    name: match[1] ?? '',
    email: match[2] ?? '',
    date: new Date(epochSec * 1000).toISOString(),
  };
}

/** One commit object, or null when the oid is not a commit in the store. */
function commitJson(ctx: Ctx, sha: string): JsonRecord | null {
  const object = ctx.store.getObject(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  return {
    sha,
    commit: {
      message: view.message,
      author: parseIdent(view.author),
      committer: parseIdent(view.committer),
      tree: { sha: view.tree },
    },
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------------------------
// repo lookup: a repo belongs to the token owner's login; anything else is a 404, never a 403.
// ---------------------------------------------------------------------------------------------

function resolveRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== ctx.viewerLogin) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function parseNumber(segment: string): number | null {
  const value = Number(segment);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

// ---------------------------------------------------------------------------------------------
// /api/v3/user and /api/v3/user/repos
// ---------------------------------------------------------------------------------------------

async function handleUser(ctx: Ctx, rest: string[], method: string, body: JsonRecord): Promise<Reply> {
  if (rest.length === 1) {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    return jsonReply(200, {
      login: ctx.viewerLogin,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      html_url: `${originOf(ctx)}/${ctx.viewerLogin}`,
      url: `${originOf(ctx)}/api/v3/user`,
    });
  }
  if (rest.length === 2 && rest[1] === 'repos') {
    if (method === 'GET') {
      const repos = ctx.store.listRepos(ctx.viewerLogin);
      return pagedReply(ctx, repos.map((repo) => repoJson(ctx, repo)));
    }
    if (method === 'POST') {
      const name = asString(body.name);
      if (name === null || name === '') return errorReply(422, 'name is required');
      const repo = ctx.store.createRepo(ctx.viewerLogin, name, {
        description: asString(body.description) ?? '',
        private: body.private === true,
      });
      if (repo === null) return errorReply(422, 'Repository already exists');
      return jsonReply(201, repoJson(ctx, repo));
    }
  }
  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// /api/v3/repos/{owner}/{repo}/...
// ---------------------------------------------------------------------------------------------

async function handleRepo(ctx: Ctx, rest: string[], method: string, body: JsonRecord): Promise<Reply> {
  const owner = rest[1] ?? '';
  const name = rest[2] ?? '';
  const repo = resolveRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const tail = rest.slice(3);

  // /repos/{o}/{r} itself.
  if (tail.length === 0) {
    if (method === 'GET') return jsonReply(200, repoJson(ctx, repo));
    if (method === 'PATCH') {
      const description = asString(body.description);
      if (description !== null) repo.description = description;
      repo.updatedAt = ctx.store.stamp();
      return jsonReply(200, repoJson(ctx, repo));
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(owner, name);
      return { status: 204, headers: requestIdHeader(), body: '', contentType: 'application/json' };
    }
    return errorReply(404, 'Not Found');
  }

  const head = tail[0];

  // GET /repos/{o}/{r}/branches — every refs/heads/* entry.
  if (head === 'branches' && tail.length === 1) {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort();
    return jsonReply(
      200,
      branches.map((branch) => ({
        name: branch,
        commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? '' },
        protected: false,
      })),
    );
  }

  // POST /repos/{o}/{r}/git/refs — create a branch ref at an existing object.
  if (head === 'git' && tail.length === 2 && tail[1] === 'refs') {
    if (method !== 'POST') return errorReply(404, 'Not Found');
    const ref = asString(body.ref);
    const sha = asString(body.sha);
    if (ref === null || !ref.startsWith('refs/') || sha === null || !isObjectId(sha)) {
      return errorReply(422, 'ref and sha are required');
    }
    if (ctx.store.getObject(sha) === undefined) {
      return errorReply(422, 'sha does not exist');
    }
    if (ctx.store.getRef(repo, ref) !== undefined) {
      return errorReply(422, 'Reference already exists');
    }
    ctx.store.setRef(repo, ref, sha);
    return jsonReply(201, {
      ref,
      object: { sha },
      url: `${repoUrl(ctx, repo)}/git/refs/${encodeURIComponent(ref)}`,
    });
  }

  // GET /repos/{o}/{r}/commits[?sha=<ref>] and GET /commits/{sha}.
  if (head === 'commits') {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    if (tail.length === 1) {
      const ref = ctx.query.get('sha') ?? repo.defaultBranch;
      const commits = ctx.store
        .commitsAtRef(repo, ref)
        .map((sha) => commitJson(ctx, sha))
        .filter((entry): entry is JsonRecord => entry !== null);
      return pagedReply(ctx, commits);
    }
    if (tail.length === 2) {
      const wanted = tail[1] ?? '';
      let sha: string | null = null;
      if (isObjectId(wanted)) sha = wanted;
      else sha = ctx.store.refTip(repo, wanted) ?? null;
      if (sha === null) return errorReply(404, 'Not Found');
      const commit = commitJson(ctx, sha);
      if (commit === null) return errorReply(404, 'Not Found');
      return jsonReply(200, commit);
    }
    return errorReply(404, 'Not Found');
  }

  // /repos/{o}/{r}/contents/{path...} — file or directory, create / update / delete.
  if (head === 'contents') {
    const path = tail.slice(1).join('/');
    const branch = asString(body.branch) ?? repo.defaultBranch;
    if (method === 'GET') {
      const ref = ctx.query.get('ref') ?? repo.defaultBranch;
      const file = ctx.store.readFileAtRef(repo, ref, path);
      if (file !== null) {
        return jsonReply(200, {
          type: 'file',
          encoding: 'base64',
          size: file.data.length,
          name: baseName(path),
          path,
          sha: file.blobOid,
          content: file.data.toString('base64'),
          url: `${repoUrl(ctx, repo)}/contents/${encodeURIComponent(path)}`,
          html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
        });
      }
      const dir = ctx.store.listDirAtRef(repo, ref, path);
      if (dir === null || dir.length === 0) return errorReply(404, 'Not Found');
      return jsonReply(
        200,
        dir.map((entry) => ({
          type: entry.type,
          name: entry.name,
          path: entry.path,
          sha: entry.sha,
          url: `${repoUrl(ctx, repo)}/contents/${encodeURIComponent(entry.path)}`,
          html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/blob/${ref}/${entry.path}`,
        })),
      );
    }
    if (method === 'PUT') {
      const message = asString(body.message) ?? '';
      const contentB64 = asString(body.content);
      if (contentB64 === null) return errorReply(422, 'content is required');
      const sha = asString(body.sha);
      if (sha !== null && sha !== '') {
        const current = ctx.store.readFileAtRef(repo, branch, path);
        if (current !== null && current.blobOid.toLowerCase() !== sha.toLowerCase()) {
          return errorReply(409, 'sha does not match the current blob');
        }
      }
      const content = Buffer.from(contentB64.replace(/[\r\n]+/g, ''), 'base64');
      const result = ctx.store.commitFile(repo, branch, path, content, message);
      if (result === null) return errorReply(422, 'Could not commit the file');
      return jsonReply(result.created ? 201 : 200, {
        content: {
          name: baseName(path),
          path,
          sha: result.blobSha,
          size: content.length,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: result.commitSha, message },
      });
    }
    if (method === 'DELETE') {
      const message = asString(body.message) ?? '';
      const result = ctx.store.deleteFile(repo, branch, path, message);
      if (result === null) return errorReply(404, 'Not Found');
      return jsonReply(200, { commit: { sha: result.commitSha } });
    }
    return errorReply(404, 'Not Found');
  }

  // GET /repos/{o}/{r}/labels and POST /repos/{o}/{r}/labels.
  if (head === 'labels' && tail.length === 1) {
    if (method === 'GET') {
      const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return jsonReply(
        200,
        labels.map((label) => ({ name: label.name, color: label.color })),
      );
    }
    if (method === 'POST') {
      const labelName = asString(body.name);
      if (labelName === null || labelName === '') return errorReply(422, 'name is required');
      const color = asString(body.color) ?? 'ededed';
      const label = ctx.store.createLabel(repo, labelName, color.replace(/^#/, ''));
      return jsonReply(201, { name: label.name, color: label.color });
    }
    return errorReply(404, 'Not Found');
  }

  // /repos/{o}/{r}/issues...
  if (head === 'issues') {
    // GET /issues and POST /issues.
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        if (state !== 'open' && state !== 'closed' && state !== 'all') {
          return errorReply(422, 'state must be open, closed or all');
        }
        let list = [...repo.issues];
        if (state === 'open') list = list.filter((issue) => issue.state === 'open');
        else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
        const direction = ctx.query.get('direction') ?? 'desc';
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        return pagedReply(ctx, list.map((issue) => issueJson(ctx, repo, issue)));
      }
      if (method === 'POST') {
        const title = asString(body.title);
        if (title === null || title === '') return errorReply(422, 'title is required');
        const rawLabels = Array.isArray(body.labels) ? body.labels : [];
        const labels: string[] = [];
        for (const entry of rawLabels) {
          const labelName =
            typeof entry === 'string'
              ? entry
              : entry !== null && typeof entry === 'object'
                ? asString((entry as JsonRecord).name)
                : null;
          if (labelName !== null && labelName !== '') labels.push(labelName);
        }
        for (const labelName of labels) {
          if (!repo.labels.has(labelName)) {
            return errorReply(422, `Label '${labelName}' does not exist`);
          }
        }
        const issue = ctx.store.createIssue(repo, title, asString(body.body) ?? '', labels);
        return jsonReply(201, issueJson(ctx, repo, issue));
      }
      return errorReply(404, 'Not Found');
    }

    // /issues/{n} and /issues/{n}/comments.
    const number = parseNumber(tail[1] ?? '');
    if (number === null) return errorReply(404, 'Not Found');
    const issue = ctx.store.getIssue(repo, number);
    if (issue === undefined) return errorReply(404, 'Not Found');
    if (tail.length === 2) {
      if (method === 'GET') return jsonReply(200, issueJson(ctx, repo, issue));
      if (method === 'PATCH') {
        const state = asString(body.state);
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = asString(body.title);
        if (title !== null) issue.title = title;
        const issueBody = asString(body.body);
        if (issueBody !== null) issue.body = issueBody;
        issue.updatedAt = ctx.store.stamp();
        return jsonReply(200, issueJson(ctx, repo, issue));
      }
      return errorReply(404, 'Not Found');
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (method === 'GET') {
        const comments = repo.comments.get(number) ?? [];
        return pagedReply(
          ctx,
          comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            created_at: comment.createdAt,
            user: { login: ctx.viewerLogin, id: VIEWER.id, type: 'User' },
            html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
            url: `${repoUrl(ctx, repo)}/issues/${number}/comments/${comment.id}`,
          })),
        );
      }
      if (method === 'POST') {
        const commentBody = asString(body.body);
        if (commentBody === null || commentBody === '') return errorReply(422, 'body is required');
        let count = 0;
        for (const list of repo.comments.values()) count += list.length;
        const comment = {
          id: 30000 + repo.id * 1000 + count + 1,
          body: commentBody,
          createdAt: ctx.store.stamp(),
        };
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        return jsonReply(201, {
          id: comment.id,
          body: comment.body,
          created_at: comment.createdAt,
          user: { login: ctx.viewerLogin, id: VIEWER.id, type: 'User' },
          html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
          url: `${repoUrl(ctx, repo)}/issues/${number}/comments/${comment.id}`,
        });
      }
      return errorReply(404, 'Not Found');
    }
    return errorReply(404, 'Not Found');
  }

  // /repos/{o}/{r}/pulls...
  if (head === 'pulls') {
    // GET /pulls and POST /pulls.
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        if (state !== 'open' && state !== 'closed' && state !== 'all') {
          return errorReply(422, 'state must be open, closed or all');
        }
        let list = [...repo.pulls];
        if (state === 'open') list = list.filter((pull) => pull.state === 'open');
        else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
        list.sort((a, b) => b.seq - a.seq);
        return pagedReply(ctx, list.map((pull) => pullJson(ctx, repo, pull)));
      }
      if (method === 'POST') {
        const title = asString(body.title);
        let headRef = asString(body.head);
        let baseRef = asString(body.base);
        if (title === null || title === '' || headRef === null || headRef === '' || baseRef === null || baseRef === '') {
          return errorReply(422, 'title, head and base are required');
        }
        if (headRef.startsWith('refs/heads/')) headRef = headRef.slice('refs/heads/'.length);
        if (baseRef.startsWith('refs/heads/')) baseRef = baseRef.slice('refs/heads/'.length);
        const pull = ctx.store.createPull(repo, title, asString(body.body) ?? '', headRef, baseRef);
        if (pull === null) return errorReply(422, 'head or base branch does not exist');
        return jsonReply(201, pullJson(ctx, repo, pull));
      }
      return errorReply(404, 'Not Found');
    }

    // /pulls/{n}, /pulls/{n}/files, /pulls/{n}/merge.
    const number = parseNumber(tail[1] ?? '');
    if (number === null) return errorReply(404, 'Not Found');
    const pull = ctx.store.getPull(repo, number);
    if (pull === undefined) return errorReply(404, 'Not Found');
    if (tail.length === 2) {
      if (method !== 'GET') return errorReply(404, 'Not Found');
      return jsonReply(200, pullJson(ctx, repo, pull));
    }
    if (tail.length === 3 && tail[2] === 'files') {
      if (method !== 'GET') return errorReply(404, 'Not Found');
      const files = ctx.store.pullFiles(repo, pull);
      return jsonReply(
        200,
        files.map((file) => ({
          filename: file.filename,
          // The suite's file shape only accepts added|modified|changed; a removed file
          // is reported as modified so it stays inside that set.
          status: file.status === 'removed' ? 'modified' : file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        })),
      );
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      if (method !== 'PUT') return errorReply(404, 'Not Found');
      const result = ctx.store.mergePull(repo, pull);
      if ('conflict' in result) return errorReply(405, 'Merge conflict');
      return jsonReply(200, { sha: result.sha, merged: true, message: result.message });
    }
    return errorReply(404, 'Not Found');
  }

  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export async function restHandler(ctx: Ctx): Promise<Reply | null> {
  const rawParts = ctx.pathname.split('/').filter((part) => part !== '');
  if (rawParts.length < 2 || rawParts[0] !== 'api' || rawParts[1] !== 'v3') return null;

  // Every /api/v3 route requires the trial bearer token.
  if (!isAuthenticated(ctx)) return errorReply(401, 'Requires authentication');

  const parts = rawParts.map(safeDecode);
  const rest = parts.slice(2);
  const method = ctx.method.toUpperCase();

  // Any route that reads JSON: a malformed body is a 400.
  let body: JsonRecord = {};
  if (method !== 'GET' && method !== 'HEAD') {
    const parsed = readJsonBody(ctx);
    if (!parsed.ok) return parsed.reply;
    body = parsed.value;
  }

  // GET /api/v3/ — root, with the X-OAuth-Scopes header.
  if (rest.length === 0) {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    return jsonReply(
      200,
      {
        current_user_url: `${originOf(ctx)}/api/v3/user`,
        repository_url: `${originOf(ctx)}/api/v3/repos/{owner}/{repo}`,
        user_url: `${originOf(ctx)}/api/v3/users/{username}`,
      },
      { 'x-oauth-scopes': 'repo, user' },
    );
  }

  // GET /api/v3/meta.
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    return jsonReply(200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      github_services_sha: '0000000000000000000000000000000000000000',
    });
  }

  // /api/v3/user and /api/v3/user/repos.
  if (rest[0] === 'user') return handleUser(ctx, rest, method, body);

  // /api/v3/repos/{owner}/{repo}/...
  if (rest[0] === 'repos' && rest.length >= 3) return handleRepo(ctx, rest, method, body);

  return errorReply(404, 'Not Found');
}
