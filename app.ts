// The HTTP server: one in-memory store, four surfaces (git smart HTTP, REST v3, GraphQL, MCP),
// and the env's boot probe. Dispatch is by handler order — each surface returns null when the
// path is not its own — and nothing here ever throws out of a request: a handler failure becomes
// a 500 JSON reply, never a dropped connection.
//
// Performance notes (the bench workloads are 200 pushes, 50 concurrent shallow clones, 2,000
// sequential issue GETs on one keep-alive, 200 issue creations): the store is in-memory, no
// request touches disk, and the server keeps connections alive (Node's default) so the read
// workload reuses one socket. Bodies are read fully before dispatch; packfiles are the only
// large bodies and are capped well above any trial's push size.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gitHandler } from './git.ts';
import { restHandler } from './rest.ts';
import { graphqlHandler } from './graphql.ts';
import { mcpHandler } from './mcp.ts';
import { nextRequestId, Store, VIEWER, type Ctx, type Reply } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body accepted (a push packfile is the only large body; 128 MiB is far above it). */
const MAX_BODY_BYTES = 128 * 1024 * 1024;

function sendReply(res: ServerResponse, reply: Reply): void {
  const body = typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : reply.body;
  const headers: Record<string, string> = {
    'content-type': reply.contentType ?? JSON_TYPE,
    'content-length': String(body.length),
    ...(reply.headers ?? {}),
  };
  res.writeHead(reply.status, headers);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendReply(res, { status, headers, body: JSON.stringify(body), contentType: JSON_TYPE });
}

/** The path and query of a request URL, or '/' when it does not parse. */
function parseUrl(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

/** Read the request body fully (up to MAX_BODY_BYTES); an empty body reads as an empty buffer. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, store).catch((err: unknown) => {
      // A handler failure must never drop the connection: answer 500 JSON and stay up.
      try {
        sendJson(res, 500, { message: `internal error: ${err instanceof Error ? err.message : String(err)}` }, { 'x-github-request-id': nextRequestId() });
      } catch {
        try {
          res.destroy();
        } catch {
          // The socket is already gone.
        }
      }
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const { pathname, query } = parseUrl(req);
  const method = (req.method ?? 'GET').toUpperCase();

  // The env's boot check calls this twice: 200 {"ok":true}. Answered here, before any surface,
  // so it can never be slowed by a store lookup.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name.toLowerCase(), value);
  }
  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

  const ctx: Ctx = {
    store,
    viewerLogin: VIEWER.login,
    method,
    pathname,
    query,
    headers,
    body,
  };

  // Surfaces in order of specificity: git paths are the most distinctive, then REST, then
  // GraphQL, then MCP. Each returns null when the path is not its own.
  const reply =
    (await gitHandler(ctx)) ??
    (await restHandler(ctx)) ??
    (await graphqlHandler(ctx)) ??
    (await mcpHandler(ctx));

  if (reply) {
    sendReply(res, reply);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': nextRequestId() });
}
