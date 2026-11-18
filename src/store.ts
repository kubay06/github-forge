// In-memory store for the forge: git objects, refs, issues and pull requests.
// Everything lives in RAM (no disk, no network) so the hot paths stay fast.
// A single monotonic counter drives every timestamp and ordering key, which
// keeps a live run and its replay producing the same object ids.

import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObj { type: ObjType; data: Buffer }

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export function viewerLogin(): string {
  const fromEnv = (process.env.MAKEFUN_FORGE_LOGIN ?? '').trim();
  return fromEnv !== '' ? fromEnv : 'adaiversen';
}

export function viewerName(): string {
  return viewerLogin() === 'adaiversen' ? 'ada iversen' : viewerLogin();
}

export function viewerEmail(): string {
  return `${viewerLogin()}@example.invalid`;
}

// Deterministic clock: base epoch plus one second per commit/issue event.
let tick = 0;
export function nextTick(): number {
  tick += 1;
  return 1700000000 + tick;
}
export function isoOf(ts: number): string {
  return new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
}

export interface TreeEntry { mode: string; name: string; oid: string }
export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const nul = data.indexOf(0, sp);
    if (nul < 0 || nul + 21 > data.length) break;
    out.push({ mode: data.subarray(i, sp).toString('utf8'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    i = nul + 21;
  }
  return out;
}

export interface CommitInfo { tree: string; parents: string[]; message: string; authorLine: string }
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
  }
  return { tree, parents, message, authorLine };
}

export function parseTagTarget(data: Buffer): string {
  const text = data.toString('utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
    if (line === '') break;
  }
  return '';
}

export interface IssueComment { id: number; body: string; seq: number }
export interface Issue {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: string[]; seq: number;
  comments: IssueComment[]; closedAt: string | null;
}
export interface PullFile { filename: string; status: string; additions: number; deletions: number; changes: number }
export interface Pull {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; mergedAt: string | null;
  mergeCommitSha: string | null; headRef: string; baseRef: string;
  headSha: string; baseSha: string; files: PullFile[]; seq: number;
}

export class Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch = 'main';
  refs = new Map<string, string>();
  objects = new Map<string, GitObj>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  labels = new Map<string, { name: string; color: string }>();
  nextIssue = 1;
  nextPull = 1;
  nextCommentId = 1;
  seq = 0;

  constructor(id: number, name: string, owner: string, isPrivate: boolean, description: string) {
    this.id = id; this.name = name; this.owner = owner;
    this.isPrivate = isPrivate; this.description = description;
    for (const n of ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']) {
      this.labels.set(n, { name: n, color: 'ededed' });
    }
  }

  nodeId(): string {
    return Buffer.from(`repo:${this.id}`, 'utf8').toString('base64url');
  }
  fullName(): string { return `${this.owner}/${this.name}`; }
  headOid(): string | null {
    return this.refs.get(`refs/heads/${this.defaultBranch}`) ?? null;
  }
  getObject(oid: string): GitObj | undefined { return this.objects.get(oid); }
  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    // Fast path: the common case is a direct parent (one new commit on the tip).
    const tipObj = this.objects.get(tip);
    if (tipObj && tipObj.type === 'commit' && parseCommit(tipObj.data).parents.includes(ancestor)) return true;
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = this.objects.get(cur);
      if (obj && obj.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) stack.push(p);
      }
    }
    return false;
  }

  /** All object ids reachable from the given tips (commits, trees, blobs, tags). */
  reachable(tips: readonly string[]): Set<string> {
    const out = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ZERO_OID || out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        const t = parseTagTarget(obj.data);
        if (t !== '') stack.push(t);
      }
    }
    return out;
  }

  /** Flat path -> {oid, mode} for the tree at a commit. */
  flattenTree(treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const obj = this.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') {
        for (const [p, v] of this.flattenTree(e.oid, path)) out.set(p, v);
      } else {
        out.set(path, { oid: e.oid, mode: e.mode });
      }
    }
    return out;
  }

  /** Build (and store) a tree object from a flat path map. */
  buildTree(files: Map<string, { oid: string; mode: string }>): string {
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    const rootFiles = new Map<string, { oid: string; mode: string }>();
    for (const [path, v] of files) {
      const slash = path.indexOf('/');
      if (slash < 0) rootFiles.set(path, v);
      else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        let sub = dirs.get(dir);
        if (!sub) { sub = new Map(); dirs.set(dir, sub); }
        sub.set(rest, v);
      }
    }
    const entries: TreeEntry[] = [];
    for (const [name, v] of rootFiles) entries.push({ mode: v.mode, name, oid: v.oid });
    for (const [dir, sub] of dirs) {
      // Rebuild nested paths by recursing on the sub-map with full paths.
      const nested = new Map<string, { oid: string; mode: string }>();
      for (const [p, v] of sub) nested.set(p, v);
      entries.push({ mode: '40000', name: dir, oid: this.buildTreeFromNested(nested) });
    }
    entries.sort((a, b) => {
      const an = a.mode === '40000' ? `${a.name}/` : a.name;
      const bn = b.mode === '40000' ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const e of entries) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      parts.push(Buffer.from(e.oid, 'hex'));
    }
    return this.putObject('tree', Buffer.concat(parts));
  }

  private buildTreeFromNested(files: Map<string, { oid: string; mode: string }>): string {
    return this.buildTree(files);
  }

  commitObject(treeOid: string, parents: string[], message: string): string {
    const ts = nextTick();
    const who = `${viewerName()} <${viewerEmail()}> ${ts} +0000`;
    let text = `tree ${treeOid}\n`;
    for (const p of parents) text += `parent ${p}\n`;
    text += `author ${who}\ncommitter ${who}\n\n${message}`;
    return this.putObject('commit', Buffer.from(text, 'utf8'));
  }

  /** Create a commit on a branch that sets/deletes one path. Returns commit oid. */
  writeFile(branch: string, path: string, content: Buffer | null, message: string): string {
    const ref = `refs/heads/${branch}`;
    const tip = this.refs.get(ref) ?? this.headOid();
    let files = new Map<string, { oid: string; mode: string }>();
    const parents: string[] = [];
    if (tip) {
      const c = this.objects.get(tip);
      if (c && c.type === 'commit') {
        files = this.flattenTree(parseCommit(c.data).tree);
        parents.push(tip);
      }
    }
    if (content === null) files.delete(path);
    else files.set(path, { oid: this.putObject('blob', content), mode: '100644' });
    const treeOid = this.buildTree(files);
    const commitOid = this.commitObject(treeOid, parents, message);
    this.refs.set(ref, commitOid);
    return commitOid;
  }

  readFileAt(refName: string, path: string): { oid: string; data: Buffer } | null {
    const tip = this.refs.get(`refs/heads/${refName}`);
    if (!tip) return null;
    const c = this.objects.get(tip);
    if (!c || c.type !== 'commit') return null;
    const flat = this.flattenTree(parseCommit(c.data).tree);
    const hit = flat.get(path);
    if (!hit) return null;
    const blob = this.objects.get(hit.oid);
    if (!blob) return null;
    return { oid: hit.oid, data: blob.data };
  }

  listDirAt(refName: string, dirPath: string): { name: string; path: string; oid: string; type: 'file' | 'dir'; size: number }[] | null {
    const tip = this.refs.get(`refs/heads/${refName}`);
    if (!tip) return null;
    const c = this.objects.get(tip);
    if (!c || c.type !== 'commit') return null;
    const flat = this.flattenTree(parseCommit(c.data).tree);
    const out = new Map<string, { name: string; path: string; oid: string; type: 'file' | 'dir'; size: number }>();
    const prefix = dirPath === '' ? '' : `${dirPath}/`;
    for (const [path, v] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const blob = this.objects.get(v.oid);
        out.set(rest, { name: rest, path, oid: v.oid, type: 'file', size: blob ? blob.data.length : 0 });
      } else {
        const dir = rest.slice(0, slash);
        if (!out.has(dir)) {
          // Directory oid: find the tree object for this directory.
          out.set(dir, { name: dir, path: `${prefix}${dir}`, oid: v.oid, type: 'dir', size: 0 });
        }
      }
    }
    return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  commitsFrom(refName: string): { sha: string; message: string; ts: number }[] {
    const tip = this.refs.get(`refs/heads/${refName}`);
    if (!tip) return [];
    const out: { sha: string; message: string; ts: number }[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      let ts = 0;
      const m = c.authorLine.match(/ (\d+) \+0000$/);
      if (m) ts = Number(m[1]);
      out.push({ sha: oid, message: c.message, ts });
      for (const p of c.parents) stack.push(p);
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }

  diffFiles(baseSha: string, headSha: string): PullFile[] {
    const baseTree = this.objects.get(baseSha)?.type === 'commit'
      ? parseCommit(this.objects.get(baseSha)!.data).tree : '';
    const headTree = this.objects.get(headSha)?.type === 'commit'
      ? parseCommit(this.objects.get(headSha)!.data).tree : '';
    const baseFiles = baseTree === '' ? new Map() : this.flattenTree(baseTree);
    const headFiles = headTree === '' ? new Map() : this.flattenTree(headTree);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: PullFile[] = [];
    for (const path of [...paths].sort()) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      if (b && h && b.oid === h.oid) continue;
      const countLines = (oid: string): number => {
        const o = this.objects.get(oid);
        if (!o) return 0;
        const s = o.data.toString('utf8');
        if (s === '') return 0;
        return s.split('\n').filter((l) => l !== '' || s.endsWith('\n')).length;
      };
      if (!b && h) {
        const adds = Math.max(1, countLines(h.oid));
        out.push({ filename: path, status: 'added', additions: adds, deletions: 0, changes: adds });
      } else if (b && !h) {
        const dels = Math.max(1, countLines(b.oid));
        out.push({ filename: path, status: 'removed', additions: 0, deletions: dels, changes: dels });
      } else if (b && h) {
        const adds = Math.max(1, countLines(h.oid));
        const dels = countLines(b.oid);
        out.push({ filename: path, status: 'modified', additions: adds, deletions: dels, changes: adds + dels });
      }
    }
    return out;
  }

  /** True when merging this pull would conflict with the current base tip. */
  pullConflicts(pull: Pull): boolean {
    const baseTip = this.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip || baseTip === pull.baseSha) return false;
    const baseAtPr = this.objects.get(pull.baseSha)?.type === 'commit'
      ? this.flattenTree(parseCommit(this.objects.get(pull.baseSha)!.data).tree) : new Map();
    const baseNow = this.objects.get(baseTip)?.type === 'commit'
      ? this.flattenTree(parseCommit(this.objects.get(baseTip)!.data).tree) : new Map();
    const headFiles = this.objects.get(pull.headSha)?.type === 'commit'
      ? this.flattenTree(parseCommit(this.objects.get(pull.headSha)!.data).tree) : new Map();
    for (const f of pull.files) {
      const oldV = baseAtPr.get(f.filename)?.oid;
      const nowV = baseNow.get(f.filename)?.oid;
      const headV = headFiles.get(f.filename)?.oid;
      if (nowV !== oldV && headV !== nowV) return true;
    }
    return false;
  }

  mergePull(pull: Pull): string | null {
    if (pull.state !== 'open' || this.pullConflicts(pull)) return null;
    const baseTip = this.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) return null;
    const headTree = this.objects.get(pull.headSha)?.type === 'commit'
      ? parseCommit(this.objects.get(pull.headSha)!.data).tree : '';
    if (headTree === '') return null;
    const sha = this.commitObject(headTree, [baseTip], `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`);
    this.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoOf(nextTick());
    pull.mergeCommitSha = sha;
    return sha;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextGlobalId = 1;

  createRepo(name: string, owner: string, isPrivate: boolean, description: string): Repo {
    const repo = new Repo(this.nextRepoId++, name, owner, isPrivate, description);
    this.repos.set(`${owner}/${name}`, repo);
    return repo;
  }
  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }
  reposOf(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner);
  }
  nextId(): number { return this.nextGlobalId++; }
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return Buffer.from(`issue:${repo.id}:${issue.number}`, 'utf8').toString('base64url');
}
export function pullGlobalId(repo: Repo, pull: Pull): string {
  return Buffer.from(`pr:${repo.id}:${pull.number}`, 'utf8').toString('base64url');
}
export function commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return Buffer.from(`comment:${repo.id}:${issue.number}:${comment.id}`, 'utf8').toString('base64url');
}
export function decodeGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], repoId: Number(parts[1]), number: parts.length >= 3 ? Number(parts[2]) : 0 };
  } catch { return null; }
}
