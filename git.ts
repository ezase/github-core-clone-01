// Git smart HTTP: upload-pack (protocol v2 + v0 fallback) and receive-pack (v0).
// No git binary anywhere: the object model, packfiles and delta resolution live in store.ts.
//
// Wire notes (from the suite's git-client.ts, which is the exact client):
// - GET /{owner}/{repo}.git/info/refs?service=git-upload-pack with header `Git-Protocol:
//   version=2` -> v2 capability advertisement; without it (or for git-receive-pack) -> v0.
// - v0 advertisement: `# service=...` pkt-line, flush, `<oid> <ref>\0<caps>` on the first line.
// - v2 ls-refs: `command=ls-refs`, delim, args (peel/symrefs/unborn/ref-prefix), flush;
//   answer `<oid> <ref> [symref-target:<t>] [peeled:<o>]` per pkt-line.
// - v2 fetch: `command=fetch`, delim, args (thin-pack/no-progress/ofs-delta/filter/want/have/
//   shallow/deepen/deepen-since/deepen-not/done), flush; answer sections `acknowledgments`,
//   `shallow-info`, `packfile` (side-band-64k, band 1 = pack bytes), each closed by flush.
// - v0 fetch: `want <oid> [caps]`, `shallow`/`deepen` lines, flush, `have`/`done`, flush;
//   answer `NAK` (or ACK) pkt-lines, `shallow` lines, then the pack in side-band-64k band 1.
// - receive-pack: `<old> <new> <ref>\0<caps>` lines, flush, then the raw packfile; answer a
//   report-status stream (`unpack ok`, `ok <ref>`, `ng <ref> <reason>`) pkt-lined inside
//   side-band-64k band 1. Every update is fast-forward only.

import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  type Ctx,
  type GitObject,
  type GitObjectType,
  type Handler,
  type Reply,
  type Repo,
} from './store.ts';

const AGENT = 'github-forge/1.0.0';
const GIT_OBJECT_FORMAT = 'sha1';

/** The capabilities a v0 advertisement carries (first line, after the NUL). */
const V0_CAPABILITIES = [
  'multi_ack',
  'multi_ack_detailed',
  'side-band-64k',
  'thin-pack',
  'ofs-delta',
  'shallow',
  'report-status',
  'report-status-v2',
  'delete-refs',
  `agent=${AGENT}`,
  'symref=HEAD:refs/heads/main',
].join(' ');

/** The capabilities a v2 advertisement carries. */
const V2_CAPABILITIES: Array<[string, string]> = [
  ['agent', AGENT],
  ['ls-refs', 'unborn'],
  ['fetch', 'shallow filter'],
  ['object-format', GIT_OBJECT_FORMAT],
  ['server-option', ''],
];

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

/** Every ref the repo advertises, in git's order (heads sorted, then tags sorted). */
function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const object = repoStoreGet(repo, oid);
      if (object && object.type === 'tag') {
        line.peeled = parseTag(object.data).object;
      }
    }
    out.push(line);
  }
  return out;
}

// The store is reached through the Ctx; this indirection keeps the helpers pure.
let currentStore: { getObject: (oid: string) => GitObject | undefined } | null = null;

function repoStoreGet(_repo: Repo, oid: string): GitObject | undefined {
  return currentStore?.getObject(oid);
}

function defaultBranchTip(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** The body of a v0 advertisement (service preamble + ref lines + flush). */
function v0Advertisement(service: string, repo: Repo): Buffer {
  const lines: Array<string | Buffer | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = listRefs(repo);
  const tip = defaultBranchTip(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${V0_CAPABILITIES}\n`);
  } else {
    lines.push(`${tip ?? ZERO_OID} HEAD\0${V0_CAPABILITIES}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The body of a v2 capability advertisement. */
function v2Advertisement(service: string): Buffer {
  const lines: Array<string | Buffer | 'flush'> = [`# service=${service}\n`, 'flush', 'version 2\n'];
  for (const [name, value] of V2_CAPABILITIES) {
    lines.push(value === '' ? `${name}\n` : `${name}=${value}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** Decode pkt-lines from the start of a buffer, stopping at the first flush; returns the packets
 *  and the offset just past the flush (the packfile, if any, starts there). */
function decodePktLinesUntilFlush(bytes: Buffer): { packets: ReturnType<typeof decodePktLines>; packOffset: number } {
  const packets: ReturnType<typeof decodePktLines> = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const hex = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, packOffset: offset + 4 };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > bytes.length) throw new Error('pkt-line length out of range');
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  throw new Error('pkt-line stream ended without a flush');
}

/** The text of the data packets, in order, with the trailing newline stripped. */
function packetTexts(packets: ReturnType<typeof decodePktLines>): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    out.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return out;
}

/** Split a side-band-64k payload into band-1 pkt-lines of at most 65,500 data bytes each. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunkSize = 65_500;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

/** The objects a fetch must send for `wants`, minus what `haves` already cover.
 *  A `shallow` boundary cuts the "already have" walk: the client holds that commit and its
 *  tree, but NOT its parents, so the parents must still be sent when a deepen asks for them. */
function collectHaveReachable(
  ctx: Ctx,
  haves: readonly string[],
  shallowBoundaries: ReadonlySet<string>,
): Set<string> {
  const lookup = (oid: string) => ctx.store.getObject(oid);
  const seen = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      queue.push(view.tree);
      // A shallow boundary's parents are NOT held by the client: do not walk past it.
      if (!shallowBoundaries.has(oid)) {
        for (const parent of view.parents) queue.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

function objectsForFetch(
  ctx: Ctx,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  filter: string | null,
  shallowBoundaries: ReadonlySet<string> = new Set(),
): { objects: GitObject[]; shallow: string[] } {
  const lookup = (oid: string) => ctx.store.getObject(oid);
  const haveReachable = haves.length > 0 ? collectHaveReachable(ctx, haves, shallowBoundaries) : new Set<string>();
  let wanted: Set<string>;
  const shallow: string[] = [];
  if (depth != null) {
    // Depth-limited walk: commits at depth < N are included; commits at depth N are the boundary
    // (their parents are cut) and are reported as shallow.
    const included = new Set<string>();
    const queue: Array<{ oid: string; depth: number }> = wants.map((oid) => ({ oid, depth: 0 }));
    const seenCommits = new Set<string>();
    while (queue.length > 0) {
      const { oid, depth: currentDepth } = queue.shift()!;
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      // A commit at depth N is beyond the deepen limit: it is neither included nor walked.
      // (Depth 0 is the want itself, so deepen 1 includes only the want commit.)
      if (currentDepth >= depth) continue;
      const object = lookup(oid);
      if (!object) continue;
      included.add(oid);
      if (object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        queue.push({ oid: parent, depth: currentDepth + 1 });
      }
    }
    // The boundary is every included commit whose parent is not included.
    for (const oid of included) {
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!included.has(parent)) {
          shallow.push(oid);
          break;
        }
      }
    }
    // Only the objects reachable from the included commits' trees (never through a cut parent).
    wanted = new Set<string>();
    for (const oid of included) {
      const object = lookup(oid);
      if (!object) continue;
      wanted.add(oid);
      if (object.type === 'commit') {
        const tree = parseCommit(object.data).tree;
        for (const reachable of collectReachable([tree], lookup, { allowMissing: true })) wanted.add(reachable);
      } else if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (included.has(target)) {
          for (const reachable of collectReachable([target], lookup, { allowMissing: true })) wanted.add(reachable);
        }
      }
    }
  } else {
    wanted = collectReachable(wants, lookup, { allowMissing: true });
  }
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (haveReachable.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    if (filter === 'blob:none' && object.type === 'blob') continue;
    if (filter === 'tree:0' && (object.type === 'tree' || object.type === 'blob')) continue;
    if (filter != null && filter.startsWith('blob:limit=')) {
      const limit = Number(filter.slice('blob:limit='.length));
      if (object.type === 'blob' && Number.isFinite(limit) && object.data.length > limit) continue;
    }
    objects.push(object);
  }
  return { objects, shallow };
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(texts: string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const text of texts) {
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    // agent= / object-format= / ref-limit are accepted and ignored.
  }
  return args;
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: Array<string | 'flush'> = [];
  const refs = listRefs(repo);
  const tip = defaultBranchTip(repo);
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    // An empty repo has no refs at all: only the unborn HEAD is reported (with its symref
    // target). Never emit an `unborn refs/heads/<branch>` line — the suite reads that as an
    // existing branch whose tree it then tries to fetch, and the fetch of the zero oid fails.
    if (args.unborn) {
      lines.push('unborn HEAD symref-target:refs/heads/main\n');
    }
  } else {
    if (keep('HEAD')) {
      const headLine = `${tip ?? ZERO_OID} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`;
      lines.push(headLine);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------------------------------------
// fetch (upload-pack, protocol v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  shallow: string[];
  filter: string | null;
}

function parseFetchArgs(texts: string[]): FetchArgs {
  const args: FetchArgs = {
    wants: [],
    haves: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
    shallow: [],
    filter: null,
  };
  for (const text of texts) {
    // A v0 `want` line carries capabilities after the oid (`want <oid> side-band-64k ...`);
    // only the first token is the object id.
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim().split(/\s+/)[0]);
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim().split(/\s+/)[0]);
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim().split(/\s+/)[0]);
    else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (Number.isFinite(n)) args.depth = n;
    } else if (text.startsWith('deepen-since ')) {
      const n = Number(text.slice(12).trim());
      if (Number.isFinite(n)) args.deepenSince = n;
    } else if (text.startsWith('deepen-not ')) args.deepenNot.push(text.slice(11).trim());
    else if (text.startsWith('filter ')) args.filter = text.slice(7).trim();
    // thin-pack / no-progress / ofs-delta / done / agent= / object-format= are accepted.
  }
  return args;
}

function fetchV2Response(ctx: Ctx, args: FetchArgs): Buffer {
  const { objects, shallow } = objectsForFetch(ctx, args.wants, args.haves, args.depth, args.filter, new Set(args.shallow));
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']));
  // shallow-info
  if (args.depth != null) {
    const lines: Array<string | 'flush'> = ['shallow-info\n'];
    for (const oid of shallow) lines.push(`shallow ${oid}\n`);
    lines.push('flush');
    parts.push(encodePktLines(lines));
  }
  // packfile
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function fetchV0Response(ctx: Ctx, args: FetchArgs): Buffer {
  const { objects, shallow } = objectsForFetch(ctx, args.wants, args.haves, args.depth, args.filter, new Set(args.shallow));
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('NAK\n'));
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

// ---------------------------------------------------------------------------------------------
// receive-pack (protocol v0)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

function receivePack(ctx: Ctx, repo: Repo, body: Buffer): Buffer {
  const { packets, packOffset } = decodePktLinesUntilFlush(body);
  const texts = packetTexts(packets);
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  texts.forEach((text, index) => {
    let line = text;
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        for (const token of line.slice(nul + 1).split(' ')) {
          if (token) capabilities.add(token);
        }
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(line)}`);
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  });

  // The packfile follows the flush. A delete-only command list carries none.
  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  if (hasUpdates) {
    const packBytes = body.subarray(packOffset);
    if (packBytes.length === 0) throw new Error('receive-pack update without a packfile');
    if (!verifyPackChecksum(packBytes)) throw new Error('receive-pack packfile checksum mismatch');
    const read = readPack(packBytes, { resolveBase: (oid) => ctx.store.getObject(oid) });
    for (const [oid, object] of read.objects) {
      if (!ctx.store.getObject(oid)) ctx.store.putObject(object.type, object.data);
    }
  }

  const report: PushReportLine[] = [];
  for (const command of commands) {
    report.push(applyPushCommand(ctx, repo, command));
  }

  // report-status: `unpack ok` + one line per ref, pkt-lined inside side-band-64k band 1.
  const wantsReport = capabilities.has('report-status') || capabilities.has('report-status-v2');
  if (!wantsReport) return Buffer.alloc(0);
  const reportLines: Array<string | 'flush'> = ['unpack ok\n'];
  for (const line of report) {
    reportLines.push(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`);
  }
  reportLines.push('flush');
  const reportBytes = encodePktLines(reportLines);
  if (capabilities.has('side-band-64k')) {
    return Buffer.concat([encodePktLine(Buffer.concat([Buffer.from([1]), reportBytes])), pktLineFlush()]);
  }
  return reportBytes;
}

function applyPushCommand(ctx: Ctx, repo: Repo, command: PushCommand): PushReportLine {
  const { oldOid, newOid, ref } = command;
  const fail = (reason: string): PushReportLine => ({ ref, ok: false, reason });
  if (!ref.startsWith('refs/') || /[\s\u0000-\u001f~^:?*[\\]/.test(ref) || ref.includes('..')) {
    return fail('invalid ref name');
  }
  const current = ctx.store.getRef(repo, ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return fail('remote ref does not exist');
    if (oldOid !== ZERO_OID && oldOid !== current) return fail('invalid old value');
    ctx.store.deleteRef(repo, ref);
    return { ref, ok: true, reason: '' };
  }
  const newObject = ctx.store.getObject(newOid);
  if (!newObject) return fail('object not found');
  if (ref.startsWith('refs/heads/') && newObject.type !== 'commit') {
    return fail('branch ref must point at a commit');
  }
  if (ref.startsWith('refs/tags/') && newObject.type !== 'commit' && newObject.type !== 'tag') {
    return fail('tag ref must point at a commit or tag');
  }
  if (current === undefined) {
    // Create.
    if (oldOid !== ZERO_OID) return fail('remote ref does not exist');
    ctx.store.setRef(repo, ref, newOid);
    return { ref, ok: true, reason: '' };
  }
  // Update: old must match, and new must be a fast-forward of current.
  if (oldOid !== current) return fail('non-fast-forward');
  if (!isAncestor(current, newOid, (oid) => ctx.store.getObject(oid))) {
    return fail('non-fast-forward');
  }
  ctx.store.setRef(repo, ref, newOid);
  return { ref, ok: true, reason: '' };
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

interface GitRoute {
  owner: string;
  repoName: string;
  service: 'git-upload-pack' | 'git-receive-pack';
  action: 'info-refs' | 'upload-pack' | 'receive-pack';
}

function matchGitRoute(ctx: Ctx): GitRoute | null {
  const segments = ctx.pathname.split('/').filter((segment) => segment !== '');
  if (segments.length < 3) return null;
  const [owner, repoGit, tail] = segments;
  if (!repoGit.endsWith('.git')) return null;
  const repoName = repoGit.slice(0, -'.git'.length);
  if (!repoName) return null;
  // GET /{owner}/{repo}.git/info/refs — four segments: owner, repo.git, info, refs.
  if (tail === 'info' && segments[3] === 'refs' && segments.length === 4) {
    const service = ctx.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return null;
    return { owner, repoName, service, action: 'info-refs' };
  }
  if (tail === 'git-upload-pack' && segments.length === 3) {
    return { owner, repoName, service: 'git-upload-pack', action: 'upload-pack' };
  }
  if (tail === 'git-receive-pack' && segments.length === 3) {
    return { owner, repoName, service: 'git-receive-pack', action: 'receive-pack' };
  }
  return null;
}

function notFoundJson(message: string): Reply {
  return {
    status: 404,
    headers: { 'x-github-request-id': 'git-404' },
    body: JSON.stringify({ message }),
    contentType: 'application/json',
  };
}

export const gitHandler: Handler = async (ctx: Ctx): Promise<Reply | null> => {
  const route = matchGitRoute(ctx);
  if (!route) return null;
  currentStore = ctx.store;
  try {
    const repo = ctx.store.getRepo(route.owner, route.repoName);
    if (!repo) return notFoundJson(`Repository ${route.owner}/${route.repoName} not found`);
    if (route.owner !== ctx.viewerLogin) return notFoundJson(`Repository ${route.owner}/${route.repoName} not found`);

    if (route.action === 'info-refs') {
      const protocol = ctx.headers.get('git-protocol') ?? '';
      const wantsV2 = route.service === 'git-upload-pack' && protocol.trim() === 'version=2';
      const body = wantsV2 ? v2Advertisement(route.service) : v0Advertisement(route.service, repo);
      return {
        status: 200,
        body,
        contentType: `application/x-${route.service}-advertisement`,
      };
    }

    if (route.action === 'upload-pack') {
      const protocol = ctx.headers.get('git-protocol') ?? '';
      const isV2 = protocol.trim() === 'version=2';
      if (!isV2) {
        // Protocol v0: a bare pkt-line request (want/have/done), no command= line.
        const args = parseFetchArgs(packetTexts(decodePktLines(ctx.body)));
        return {
          status: 200,
          body: fetchV0Response(ctx, args),
          contentType: 'application/x-git-upload-pack-result',
        };
      }
      const packets = decodePktLines(ctx.body);
      const texts = packetTexts(packets);
      const command = texts.find((text) => text.startsWith('command='));
      if (!command) throw new Error('upload-pack request has no command');
      if (command === 'command=ls-refs') {
        const args = parseLsRefsArgs(texts);
        return {
          status: 200,
          body: lsRefsResponse(repo, args),
          contentType: 'application/x-git-upload-pack-result',
        };
      }
      if (command === 'command=fetch') {
        const args = parseFetchArgs(texts);
        return {
          status: 200,
          body: fetchV2Response(ctx, args),
          contentType: 'application/x-git-upload-pack-result',
        };
      }
      throw new Error(`unknown upload-pack command ${JSON.stringify(command)}`);
    }

    // receive-pack (v0 only): the body is command lines, a flush, then the raw packfile.
    if (route.action === 'receive-pack') {
      const body = receivePack(ctx, repo, ctx.body);
      return {
        status: 200,
        body,
        contentType: 'application/x-git-receive-pack-result',
      };
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 500,
      body: JSON.stringify({ message: `git error: ${message}` }),
      contentType: 'application/json',
    };
  } finally {
    currentStore = null;
  }
};
