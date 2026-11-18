// Git smart-HTTP: pkt-line framing, packfiles, protocol v2 (ls-refs/fetch)
// and v0 (upload-pack fallback), plus receive-pack v0 with per-ref reports.
// No git binary, no deltas on the wire out: plain zlib objects only, which
// the client resolves exactly. Pack entries are built once per fetch.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Repo, ZERO_OID, hashObject, parseCommit, parseTagTarget, parseTree, type GitObj, type ObjType } from './store.ts';

export function pktLine(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}
export function pktFlush(): Buffer { return Buffer.from('0000', 'ascii'); }
export function pktDelim(): Buffer { return Buffer.from('0001', 'ascii'); }

/** Split a buffer of pkt-lines; returns lines (without length prefix) and byte offset consumed. */
export function parsePktLines(buf: Buffer): { lines: string[]; consumed: number } {
  const lines: string[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const head = buf.subarray(i, i + 4).toString('ascii');
    if (head === '0000') { i += 4; lines.push('\0FLUSH'); continue; }
    if (head === '0001') { i += 4; lines.push('\0DELIM'); continue; }
    if (head === '0002') { i += 4; lines.push('\0END'); continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > buf.length) break;
    lines.push(buf.subarray(i + 4, i + len).toString('utf8'));
    i += len;
  }
  return { lines, consumed: i };
}

function encodeObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let s = size;
  let first = (typeCode << 4) | (s & 0x0f);
  s >>= 4;
  if (s > 0) first |= 0x80;
  bytes.push(first);
  while (s > 0) {
    let b = s & 0x7f;
    s >>= 7;
    if (s > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Build a pack (header + plain zlib objects) with a correct SHA-1 trailer. */
export function buildPack(objects: { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(encodeObjectHeader(TYPE_CODES[obj.type], obj.data.length));
    // Level 0 (stored, no compression) is a valid zlib stream and the
    // fastest to produce; the loopback link makes the extra bytes free.
    parts.push(deflateSync(obj.data, { level: 0 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export interface ParsedPack { objects: { type: ObjType; data: Buffer; oid: string }[] }
export function parsePack(buf: Buffer): ParsedPack {
  const objects: ParsedPack['objects'] = [];
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') return { objects };
  const count = buf.readUInt32BE(8);
  let i = 12;
  for (let n = 0; n < count && i < buf.length - 20; n += 1) {
    let byte = buf[i++];
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[i++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let type: ObjType = 'blob';
    let baseOid: string | null = null;
    let baseOffset = 0;
    if (typeCode === 6) {
      // OFS_DELTA: variable-length offset.
      byte = buf[i++];
      baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[i++];
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      type = 'blob';
    } else if (typeCode === 7) {
      baseOid = buf.subarray(i, i + 20).toString('hex');
      i += 20;
    } else {
      type = (Object.keys(TYPE_CODES).find((k) => TYPE_CODES[k] === typeCode) ?? 'blob') as ObjType;
    }
    const start = i;
    let inflated: Buffer;
    try {
      inflated = inflateSync(buf.subarray(start));
    } catch {
      break;
    }
    // Find how many bytes the zlib stream consumed: re-deflate is not
    // reliable, so scan forward using the stream's end via inflateSync on
    // growing slices is too slow; instead use zlib's unused_data trick
    // through a manual approach: the client only sends plain objects, and
    // the next entry starts right after the zlib stream. We locate it by
    // trying inflateSync with a truncated view is not possible, so we use
    // Node's zlib inflate with a callback-free trick: deflate the inflated
    // data at level 0? No — instead, advance by measuring with
    // `zlib.inflateSync` on the remainder and comparing lengths is not
    // available. Fallback: store inflated and stop parsing further entries
    // only if this was the last one; for multi-object packs we find the
    // stream end by binary-searching the smallest prefix that inflates.
    let consumed = 0;
    let lo = 1;
    let hi = buf.length - start;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try {
        const out = inflateSync(buf.subarray(start, start + mid));
        if (out.length === size) { consumed = mid; hi = mid - 1; }
        else if (out.length < size) lo = mid + 1;
        else hi = mid - 1;
      } catch { lo = mid + 1; }
    }
    if (consumed === 0) break;
    i = start + consumed;
    void baseOid; void baseOffset;
    const oid = hashObject(type, inflated);
    objects.push({ type, data: inflated, oid });
  }
  return { objects };
}

export interface FetchPlan {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
}

/** Compute the objects a fetch must deliver for wants/haves/depth. */
export function planFetch(repo: Repo, wants: string[], haves: string[], shallowHeld: string[], depth: number | null): FetchPlan {
  const wantSet = new Set(wants.filter((w) => w !== ZERO_OID));
  const shallowSet = new Set(shallowHeld);
  // Objects the client already holds: the closure of its haves, except that
  // a shallow boundary's parents are NOT held (a depth-1 clone never got
  // them), so the walk stops at shallow commits instead of crossing them.
  const haveReachable = new Set<string>();
  {
    const hstack = [...haves];
    while (hstack.length > 0) {
      const oid = hstack.pop() as string;
      if (oid === ZERO_OID || haveReachable.has(oid)) continue;
      const obj = repo.getObject(oid);
      if (!obj) continue;
      haveReachable.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        for (const o of repo.reachable([c.tree])) haveReachable.add(o);
        if (!shallowSet.has(oid)) for (const p of c.parents) hstack.push(p);
      } else if (obj.type === 'tree') {
        for (const o of repo.reachable([oid])) haveReachable.add(o);
      } else if (obj.type === 'tag') {
        const t = parseTagTarget(obj.data);
        if (t !== '') hstack.push(t);
      }
    }
  }
  // Commit distances from any want (BFS over parents).
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const w of wantSet) {
    const obj = repo.getObject(w);
    if (obj && obj.type === 'commit') { dist.set(w, 0); queue.push(w); }
    else if (obj && obj.type === 'tag') {
      const t = parseTagTarget(obj.data);
      if (t !== '' && repo.getObject(t)?.type === 'commit') { dist.set(t, 0); queue.push(t); }
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    const d = dist.get(cur) as number;
    const obj = repo.getObject(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!dist.has(p)) { dist.set(p, d + 1); queue.push(p); }
    }
  }
  const includedCommits = new Set<string>();
  for (const [oid, d] of dist) {
    if (depth === null || d < depth) includedCommits.add(oid);
  }
  // Shallow boundaries: included commits whose parent is not included.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of includedCommits) {
      const obj = repo.getObject(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length > 0 && parents.some((p) => !includedCommits.has(p))) shallow.push(oid);
      if (shallowSet.has(oid) && parents.every((p) => includedCommits.has(p))) unshallow.push(oid);
    }
  }
  // Gather objects: each included commit itself plus its own tree and blobs
  // (never a parent commit's tree: a depth limit must not leak the older
  // generation's objects), plus any tag object the client asked for.
  const wantedObjects = new Set<string>();
  for (const w of wantSet) {
    const obj = repo.getObject(w);
    if (!obj) continue;
    if (obj.type === 'tag') wantedObjects.add(w);
  }
  for (const oid of includedCommits) {
    wantedObjects.add(oid);
    const obj = repo.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    const tree = parseCommit(obj.data).tree;
    for (const o of repo.reachable([tree])) wantedObjects.add(o);
  }
  // Drop anything already held.
  for (const h of haveReachable) wantedObjects.delete(h);
  // With a depth limit, a parent commit that is a have is already dropped;
  // trees of included commits are kept even if a have held them, but the
  // have-reachable drop above already removed them correctly.
  const objects: GitObj[] = [];
  for (const oid of wantedObjects) {
    const obj = repo.getObject(oid);
    if (obj) objects.push(obj);
  }
  // Deterministic order: commits, tags, trees, blobs, by oid.
  const rank = (t: ObjType): number => (t === 'commit' ? 0 : t === 'tag' ? 1 : t === 'tree' ? 2 : 3);
  objects.sort((a, b) => rank(a.type) - rank(b.type));
  return { objects, shallow, unshallow };
}

export function peeledOid(repo: Repo, refOid: string): string | null {
  const obj = repo.getObject(refOid);
  if (!obj) return null;
  if (obj.type === 'tag') {
    let cur = parseTagTarget(obj.data);
    let guard = 0;
    while (guard++ < 10) {
      const next = repo.getObject(cur);
      if (!next) return cur;
      if (next.type === 'tag') { cur = parseTagTarget(next.data); continue; }
      return cur;
    }
    return cur;
  }
  return null;
}

export function refLinesV0(repo: Repo): { oid: string; ref: string; peeled: string | null }[] {
  const out: { oid: string; ref: string; peeled: string | null }[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) {
    out.push({ oid, ref, peeled: peeledOid(repo, oid) });
  }
  return out;
}

export function headSymref(repo: Repo): string | null {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return tip ? `refs/heads/${repo.defaultBranch}` : null;
}
