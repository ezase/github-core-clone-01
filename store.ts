// The forge's in-memory store and the git object model.
//
// Everything the suite sees is deterministic: no wall clock, no unseeded randomness.
// Timestamps come from MAKEFUN_TRIAL_NOW (the trial's opening time, identical on live and
// replay); ids and ordering come from counters. The viewer identity is the competition's
// fixed scenario viewer (SCENARIO_SEED is a constant, so the viewer is the same every trial):
// login "adaiversen", id 1000. MAKEFUN_VIEWER_LOGIN overrides it if the harness ever sets one.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflateSync, deflateSync as zlibDeflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// viewer + deterministic time
// ---------------------------------------------------------------------------------------------

/** The token owner's identity: the scenario viewer, fixed by the competition's SCENARIO_SEED. */
export const VIEWER = {
  login: process.env.MAKEFUN_VIEWER_LOGIN ?? 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** The trial's opening time (MAKEFUN_TRIAL_NOW), or a fixed fallback for local runs. */
export function trialNowMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
    const n = Number(raw);
    if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  }
  return 1_735_689_600_000;
}

export function trialNowIso(): string {
  return new Date(trialNowMs()).toISOString();
}

export function trialNowEpochSec(): number {
  return Math.floor(trialNowMs() / 1000);
}

// ---------------------------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export const ZERO_OID = '0'.repeat(40);

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  extraHeaders: Array<[string, string]>;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? trialNowEpochSec();
  const timezone = fields.timezone ?? '+0000';
  const who = `${fields.author ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${fields.committer ? `${fields.committer} ${timestamp} ${timezone}` : who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? trialNowEpochSec();
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

/** Every object reachable from `roots` (commit -> tree + parents, tree -> entries, tag -> target). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    if (root === ZERO_OID) continue;
    if (!seen.has(root)) {
      seen.add(root);
      queue.push(root);
    }
  }
  while (queue.length > 0) {
    const oid = queue.pop()!;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`missing object ${oid}`);
    }
    const next: string[] = [];
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      next.push(view.tree, ...view.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') next.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      next.push(parseTag(object.data).object);
    }
    for (const child of next) {
      if (child === ZERO_OID || seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` (or they are equal). */
export function isAncestor(
  ancestor: string,
  descendant: string,
  lookup: (oid: string) => GitObject | undefined,
): boolean {
  if (ancestor === descendant) return true;
  if (ancestor === ZERO_OID) return true;
  const reachable = collectReachable([descendant], lookup, { allowMissing: true });
  return reachable.has(ancestor);
}

/** The merge-base: the first common ancestor of two commits (by BFS from both, newest first). */
export function mergeBase(
  a: string,
  b: string,
  lookup: (oid: string) => GitObject | undefined,
): string | null {
  if (a === b) return a;
  const ancestorsA = collectReachable([a], lookup, { allowMissing: true });
  // Walk b's history breadth-first (parents in order) and return the first commit also in a.
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = lookup(oid);
    if (object && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = zlibInflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA; `resolveBase` supplies thin-pack bases. */
export function readPack(pack: Buffer, options: { resolveBase?: (oid: string) => GitObject | undefined } = {}): PackReadResult {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} not in pack or supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas); trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(zlibDeflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return actual === expected;
}

// ---------------------------------------------------------------------------------------------
// packet lines
// ---------------------------------------------------------------------------------------------

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.alloc(4);
  header.write(length.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type GitPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function decodePktLines(bytes: Buffer): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const hex = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
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
  if (offset !== bytes.length) throw new Error('trailing bytes after pkt-lines');
  return packets;
}

export function encodePktLines(lines: Array<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktLineFlush());
    else if (line === 'delim') parts.push(pktLineDelim());
    else if (line === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: boolean;
  createdAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  comments: Map<number, Comment[]>;
  nextIssue: number;
  nextPull: number;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

/** Opaque, stable global ids (GraphQL `node(id:)` round-trips them). */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}-${trialNowEpochSec().toString(36)}`;
}

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private seq = 0;

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** A timestamp that increases with every mutation, so created/updated ordering is stable. */
  stamp(): string {
    return new Date(trialNowMs() + this.nextSeq() * 1000).toISOString();
  }

  // -- objects --
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  // -- repos --
  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean } = {}): Repo | null {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    this.repoSeq += 1;
    const now = this.stamp();
    const repo: Repo = {
      id: 5000 + this.repoSeq,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      comments: new Map(),
      nextIssue: 1,
      nextPull: 1,
      seq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  // -- refs --
  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  refTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  // -- trees / files --
  /** The tree oid at a ref (branch name or full ref or commit oid), or null. */
  treeAtRef(repo: Repo, ref: string): string | null {
    let oid: string | undefined;
    if (isObjectId(ref)) oid = ref;
    else if (ref.startsWith('refs/')) oid = repo.refs.get(ref);
    else oid = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
    if (!oid) return null;
    const object = this.objects.get(oid);
    if (!object) return null;
    if (object.type === 'commit') return parseCommit(object.data).tree;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = this.objects.get(target);
      if (targetObject && targetObject.type === 'commit') return parseCommit(targetObject.data).tree;
      return null;
    }
    if (object.type === 'tree') return oid;
    return null;
  }

  /** All files (path -> blob oid) under a tree, recursively. */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build a tree from a flat path map, creating intermediate trees. Returns the root tree oid. */
  buildTreeFromFiles(files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      entries: Map<string, { mode: string; oid: string }>;
    }
    const root: Node = { entries: new Map() };
    const nodes = new Map<string, Node>();
    nodes.set('', root);
    const nodeFor = (dir: string): Node => {
      let node = nodes.get(dir);
      if (node) return node;
      node = { entries: new Map() };
      nodes.set(dir, node);
      const slash = dir.lastIndexOf('/');
      const parentDir = slash < 0 ? '' : dir.slice(0, slash);
      const name = slash < 0 ? dir : dir.slice(slash + 1);
      nodeFor(parentDir).entries.set(name, { mode: '40000', oid: '' });
      return node;
    };
    for (const [path, file] of files) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      nodeFor(dir).entries.set(name, { mode: file.mode, oid: file.oid });
    }
    const build = (dir: string): string => {
      const node = nodes.get(dir)!;
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.entries) {
        let oid = entry.oid;
        if (entry.mode === '40000') oid = build(dir === '' ? name : `${dir}/${name}`);
        entries.push({ mode: entry.mode, name, oid });
      }
      return this.putObject('tree', buildTree(entries));
    };
    return build('');
  }

  /** Read one file's blob at a ref. Returns null when the ref or path does not exist. */
  readFileAtRef(repo: Repo, ref: string, path: string): { blobOid: string; data: Buffer } | null {
    const treeOid = this.treeAtRef(repo, ref);
    if (!treeOid) return null;
    const files = this.flattenTree(treeOid);
    const file = files.get(path);
    if (!file) return null;
    const object = this.objects.get(file.oid);
    if (!object || object.type !== 'blob') return null;
    return { blobOid: file.oid, data: object.data };
  }

  /** List the direct entries of a directory at a ref (for GET /contents on a directory). */
  listDirAtRef(repo: Repo, ref: string, dirPath: string): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> | null {
    const treeOid = this.treeAtRef(repo, ref);
    if (!treeOid) return null;
    const files = this.flattenTree(treeOid);
    const out: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> = [];
    const seen = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    const prefix = dirPath === '' ? '' : `${dirPath}/`;
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash < 0) {
        seen.set(rest, { type: 'file', name: rest, path, sha: file.oid });
      } else {
        const dirName = rest.slice(0, slash);
        if (!seen.has(dirName)) {
          // The dir's sha is its tree oid; compute it from the files under it.
          const sub = new Map<string, { oid: string; mode: string }>();
          for (const [p, f] of files) {
            if (p.startsWith(`${prefix}${dirName}/`)) sub.set(p.slice(prefix.length + dirName.length + 1), f);
          }
          const dirTree = this.buildTreeFromFiles(sub);
          seen.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: dirTree });
        }
      }
    }
    for (const entry of seen.values()) out.push(entry);
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /**
   * Commit a file change on a branch: creates the blob, the tree and the commit, and moves the
   * branch. `expectedBlobSha` is the stale-sha guard (null = no check). Returns null when the
   * branch does not exist or the sha is stale.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string; created: boolean } | null {
    const ref = `refs/heads/${branch}`;
    const currentTip = repo.refs.get(ref);
    const blobSha = this.putObject('blob', content);
    let baseFiles = new Map<string, { oid: string; mode: string }>();
    let created = true;
    if (currentTip) {
      const treeOid = this.treeAtRef(repo, ref);
      if (treeOid) baseFiles = this.flattenTree(treeOid);
      created = !baseFiles.has(path);
    }
    baseFiles.set(path, { oid: blobSha, mode: '100644' });
    const treeOid = this.buildTreeFromFiles(baseFiles);
    const commitData = buildCommit({
      tree: treeOid,
      parents: currentTip ? [currentTip] : [],
      message,
      author: `${VIEWER.name} <${VIEWER.email}>`,
    });
    const commitSha = this.putObject('commit', commitData);
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha, created };
  }

  /** Delete a file on a branch (creates a commit). Returns null when the branch/file is missing. */
  deleteFile(
    repo: Repo,
    branch: string,
    path: string,
    message: string,
  ): { commitSha: string } | null {
    const ref = `refs/heads/${branch}`;
    const currentTip = repo.refs.get(ref);
    if (!currentTip) return null;
    const treeOid = this.treeAtRef(repo, ref);
    if (!treeOid) return null;
    const files = this.flattenTree(treeOid);
    if (!files.has(path)) return null;
    files.delete(path);
    const newTree = this.buildTreeFromFiles(files);
    const commitSha = this.putObject(
      'commit',
      buildCommit({ tree: newTree, parents: [currentTip], message, author: `${VIEWER.name} <${VIEWER.email}>` }),
    );
    repo.refs.set(ref, commitSha);
    return { commitSha };
  }

  /** The commits reachable from a ref, newest first (by parent chain, then seq). */
  commitsAtRef(repo: Repo, ref: string): string[] {
    let tip: string | undefined;
    if (isObjectId(ref)) tip = ref;
    else if (ref.startsWith('refs/')) tip = repo.refs.get(ref);
    else tip = repo.refs.get(`refs/heads/${ref}`);
    if (!tip) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  // -- issues --
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const now = this.stamp();
    const issue: Issue = {
      number: repo.nextIssue,
      id: 10000 + repo.id * 1000 + repo.nextIssue,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      createdAt: now,
      updatedAt: now,
      seq: this.nextSeq(),
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  // -- labels --
  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { name, color: color || 'ededed' };
    repo.labels.set(name, label);
    return label;
  }

  // -- pulls --
  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | null {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return null;
    const now = this.stamp();
    const pull: PullRequest = {
      number: repo.nextPull,
      id: 20000 + repo.id * 1000 + repo.nextPull,
      title,
      body: body ?? '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      mergeable: true,
      createdAt: now,
      seq: this.nextSeq(),
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** The files a pull request changes (merge-base tree vs head tree), with line counts. */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const base = mergeBase(pull.headSha, pull.baseSha, (oid) => this.objects.get(oid));
    const baseTree = base ? this.treeAtRef(repo, base) : null;
    const headTree = this.treeAtRef(repo, pull.headSha);
    const baseFiles = baseTree ? this.flattenTree(baseTree) : new Map<string, { oid: string; mode: string }>();
    const headFiles = headTree ? this.flattenTree(headTree) : new Map<string, { oid: string; mode: string }>();
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const inBase = baseFiles.get(path);
      const inHead = headFiles.get(path);
      if (inBase && inHead && inBase.oid === inHead.oid) continue;
      let status: string;
      let additions = 0;
      let deletions = 0;
      const baseText = inBase ? (this.objects.get(inBase.oid)?.data.toString('utf8') ?? '') : '';
      const headText = inHead ? (this.objects.get(inHead.oid)?.data.toString('utf8') ?? '') : '';
      if (!inBase && inHead) {
        status = 'added';
        additions = headText === '' ? 0 : headText.split('\n').length;
      } else if (inBase && !inHead) {
        status = 'removed';
        deletions = baseText === '' ? 0 : baseText.split('\n').length;
      } else {
        status = 'modified';
        const baseLines = baseText.split('\n');
        const headLines = headText.split('\n');
        const baseSet = new Set(baseLines);
        const headSet = new Set(headLines);
        additions = headLines.filter((line) => !baseSet.has(line)).length;
        deletions = baseLines.filter((line) => !headSet.has(line)).length;
        if (additions === 0 && deletions === 0) {
          additions = 1;
        }
      }
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  /** Whether a pull request can merge cleanly (no file changed on both sides differently). */
  pullMergeable(repo: Repo, pull: PullRequest): boolean {
    const base = mergeBase(pull.headSha, pull.baseSha, (oid) => this.objects.get(oid));
    if (!base) return true;
    const baseTree = this.treeAtRef(repo, base);
    const headTree = this.treeAtRef(repo, pull.headSha);
    const baseTipTree = this.treeAtRef(repo, `refs/heads/${pull.baseRef}`);
    if (!baseTree || !headTree || !baseTipTree) return true;
    const baseFiles = this.flattenTree(baseTree);
    const headFiles = this.flattenTree(headTree);
    const tipFiles = this.flattenTree(baseTipTree);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
    for (const path of paths) {
      const atBase = baseFiles.get(path)?.oid ?? null;
      const atHead = headFiles.get(path)?.oid ?? null;
      const atTip = tipFiles.get(path)?.oid ?? null;
      const headChanged = atHead !== atBase;
      const tipChanged = atTip !== atBase;
      if (headChanged && tipChanged && atHead !== atTip) return false;
    }
    return true;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit sha, or null
   * when the pull is unknown/already closed, or { conflict: true } when it cannot merge.
   */
  mergePull(
    repo: Repo,
    pull: PullRequest,
  ): { sha: string; message: string } | { conflict: true } {
    if (pull.state !== 'open') return { conflict: true };
    if (!this.pullMergeable(repo, pull)) return { conflict: true };
    const base = mergeBase(pull.headSha, pull.baseSha, (oid) => this.objects.get(oid));
    const baseTree = base ? this.treeAtRef(repo, base) : null;
    const headTree = this.treeAtRef(repo, pull.headSha);
    const baseTipTree = this.treeAtRef(repo, `refs/heads/${pull.baseRef}`);
    if (!headTree || !baseTipTree) return { conflict: true };
    const baseFiles = baseTree ? this.flattenTree(baseTree) : new Map<string, { oid: string; mode: string }>();
    const headFiles = this.flattenTree(headTree);
    const tipFiles = this.flattenTree(baseTipTree);
    // Apply the pull's changes onto the base tip: for each path the pull changed vs merge-base,
    // take the head's version; untouched paths keep the tip's version.
    const merged = new Map<string, { oid: string; mode: string }>(tipFiles);
    for (const [path, headFile] of headFiles) {
      const atBase = baseFiles.get(path)?.oid ?? null;
      if (headFile.oid !== atBase) merged.set(path, headFile);
    }
    for (const [path] of baseFiles) {
      if (!headFiles.has(path) && baseFiles.get(path)?.oid !== tipFiles.get(path)?.oid) {
        // Deleted by the pull and untouched on the tip: delete it.
        if (tipFiles.get(path)?.oid === baseFiles.get(path)?.oid) merged.delete(path);
      }
    }
    const treeOid = this.buildTreeFromFiles(merged);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) return { conflict: true };
    const message = `${pull.title} (#${pull.number})`;
    const commitSha = this.putObject(
      'commit',
      buildCommit({ tree: treeOid, parents: [baseTip], message, author: `${VIEWER.name} <${VIEWER.email}>` }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.stamp();
    pull.mergeCommitSha = commitSha;
    return { sha: commitSha, message };
  }
}

// ---------------------------------------------------------------------------------------------
// the request context / reply contract shared by the surface modules
// ---------------------------------------------------------------------------------------------

export interface Ctx {
  store: Store;
  /** The token owner's login (the bearer token names the viewer). */
  viewerLogin: string;
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Map<string, string>;
  body: Buffer;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
  contentType?: string;
}

export type Handler = (ctx: Ctx) => Promise<Reply | null>;

/** The bearer token this request carries, or null. */
export function bearerToken(ctx: Ctx): string | null {
  const value = ctx.headers.get('authorization') ?? '';
  if (!value.toLowerCase().startsWith('bearer ')) return null;
  return value.slice('bearer '.length).trim();
}

/** The expected token, from the environment (the trial's MAKEFUN_SHOP_TOKEN). */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** True when the request carries the trial's token (or when no token is configured locally). */
export function isAuthenticated(ctx: Ctx): boolean {
  const expected = expectedToken();
  if (expected === '') return true;
  const token = bearerToken(ctx);
  return token !== null && token === expected;
}
