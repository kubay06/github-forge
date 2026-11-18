// Forge HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP in one
// process, on one in-memory store. Only Node's standard library is used.
// Every reply is JSON (never HTML) and carries X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, Repo, ZERO_OID, viewerLogin, hashObject, parseCommit, parseTagTarget, isoOf, type Issue } from './store.ts';
import { userJson, repoJson, issueJson, pullJson, branchJson } from './views.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { pktLine, pktFlush, pktDelim, parsePktLines, buildPack, parsePack, planFetch, peeledOid, refLinesV0 } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
let requestCounter = 0;
let store = new Store();

export function resetStore(): void { store = new Store(); }
export function getStore(): Store { return store; }

function tokenOf(): string { return process.env.MAKEFUN_SHOP_TOKEN ?? ''; }

function authed(req: IncomingMessage): boolean {
  const expected = tokenOf();
  const header = req.headers.authorization ?? '';
  if (expected === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === `Bearer ${expected}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${++requestCounter}`,
    ...extra,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${++requestCounter}`,
  });
  res.end(body);
}

function notFound(res: ServerResponse): void { sendJson(res, 404, { message: 'Not Found' }); }
function unauthorized(res: ServerResponse): void { sendJson(res, 401, { message: 'Requires authentication' }); }

function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}
function hostOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function decodeSegment(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function pageParams(q: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(q.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(q.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function linkHeader(req: IncomingMessage, basePath: string, q: URLSearchParams, page: number, perPage: number, total: number): string {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(q);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `${hostOf(req)}${basePath}?${params.toString()}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value: value as Record<string, unknown> };
    return { ok: true, value: {} };
  } catch { return { ok: false }; }
}

function requireRepo(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== viewerLogin()) { notFound(res); return null; }
  const repo = store.getRepo(owner, name);
  if (!repo) { notFound(res); return null; }
  return repo;
}

function branchName(head: string): string {
  const idx = head.indexOf(':');
  return idx >= 0 ? head.slice(idx + 1) : head;
}

// ---------------------------------------------------------------- REST v3

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, raw: Buffer): Promise<boolean> {
  const method = req.method ?? 'GET';
  const q = queryOf(req);
  const segments = path.split('/').filter((s) => s !== '');
  // segments[0..1] are 'api','v3' for every REST route.
  const rest = segments.slice(2);

  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }
  if (method === 'GET' && path === '/api/v3/user') {
    if (!authed(req)) { unauthorized(res); return true; }
    sendJson(res, 200, userJson());
    return true;
  }
  if (method === 'GET' && path === '/api/v3/user/repos') {
    if (!authed(req)) { unauthorized(res); return true; }
    const { page, perPage } = pageParams(q);
    const all = store.reposOf(viewerLogin());
    const extra: Record<string, string> = {};
    if (all.length > perPage) extra.link = linkHeader(req, path, q, page, perPage, all.length);
    sendJson(res, 200, paginate(all, page, perPage).map((r) => repoJson(r)), extra);
    return true;
  }
  if (method === 'POST' && path === '/api/v3/user/repos') {
    if (!authed(req)) { unauthorized(res); return true; }
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON body' }); return true; }
    const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
    if (name === '') { sendJson(res, 422, { message: 'name is required' }); return true; }
    if (store.getRepo(viewerLogin(), name)) { sendJson(res, 422, { message: 'Repository already exists' }); return true; }
    const repo = store.createRepo(
      name, viewerLogin(), parsed.value.private === true,
      typeof parsed.value.description === 'string' ? parsed.value.description : '',
    );
    sendJson(res, 201, repoJson(repo));
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeSegment(rest[1]);
    const repoName = decodeSegment(rest[2]);
    const tail = rest.slice(3);
    if (!authed(req)) { unauthorized(res); return true; }
    const repo = requireRepo(res, owner, repoName);
    if (!repo) return true;

    if (tail.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON body' }); return true; }
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        store.repos.delete(repo.fullName());
        res.writeHead(204, { 'x-github-request-id': `req-${++requestCounter}` });
        res.end();
        return true;
      }
      return false;
    }
    if (tail[0] === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const list = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => branchJson(repo, ref.slice('refs/heads/'.length), sha));
        sendJson(res, 200, list);
        return true;
      }
      if (method === 'GET' && tail.length === 2) {
        const sha = repo.refs.get(`refs/heads/${decodeSegment(tail[1])}`);
        if (!sha) { notFound(res); return true; }
        sendJson(res, 200, branchJson(repo, decodeSegment(tail[1]), sha));
        return true;
      }
      return false;
    }
    if (tail[0] === 'commits') {
      if (method === 'GET' && tail.length === 1) {
        const shaParam = q.get('sha');
        const refName = shaParam ? branchName(shaParam) : repo.defaultBranch;
        const list = repo.commitsFrom(refName).map((c) => ({
          sha: c.sha,
          commit: {
            message: c.message,
            author: { name: viewerLogin(), email: `${viewerLogin()}@example.invalid`, date: isoOf(c.ts || 1700000000) },
            committer: { name: viewerLogin(), email: `${viewerLogin()}@example.invalid`, date: isoOf(c.ts || 1700000000) },
          },
          author: { login: viewerLogin(), id: 1000, type: 'User' },
          parents: [],
        }));
        sendJson(res, 200, list);
        return true;
      }
      if (method === 'GET' && tail.length === 2) {
        const oid = decodeSegment(tail[1]);
        const obj = repo.getObject(oid);
        if (!obj || obj.type !== 'commit') { notFound(res); return true; }
        const c = parseCommit(obj.data);
        sendJson(res, 200, {
          sha: oid,
          commit: { message: c.message, author: { name: viewerLogin(), email: `${viewerLogin()}@example.invalid` }, committer: { name: viewerLogin(), email: `${viewerLogin()}@example.invalid` } },
          parents: c.parents.map((p) => ({ sha: p })),
        });
        return true;
      }
      return false;
    }
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON body' }); return true; }
        const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
        const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) { sendJson(res, 422, { message: 'Invalid ref or sha' }); return true; }
        repo.refs.set(ref, sha.toLowerCase());
        sendJson(res, 201, { ref, object: { sha: sha.toLowerCase(), type: 'commit' }, url: `/api/v3/repos/${repo.fullName()}/git/refs/${ref.slice(5)}` });
        return true;
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = `refs/${tail.slice(2).map(decodeSegment).join('/')}`;
        const sha = repo.refs.get(ref);
        if (!sha) { notFound(res); return true; }
        sendJson(res, 200, { ref, object: { sha, type: 'commit' } });
        return true;
      }
      return false;
    }
    if (tail[0] === 'contents') {
      const contentPath = tail.slice(1).map(decodeSegment).join('/');
      const branch = q.get('ref') ?? repo.defaultBranch;
      if (method === 'GET') {
        if (contentPath === '') {
          const entries = repo.listDirAt(branch, '') ?? [];
          sendJson(res, 200, entries.map((e) => ({ type: e.type, name: e.name, path: e.path, sha: e.oid, size: e.size })));
          return true;
        }
        const file = repo.readFileAt(branch, contentPath);
        if (file) {
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: file.data.length, name: contentPath.split('/').pop(),
            path: contentPath, content: file.data.toString('base64'), sha: file.oid,
          });
          return true;
        }
        const dir = repo.listDirAt(branch, contentPath);
        if (dir && dir.length > 0) {
          sendJson(res, 200, dir.map((e) => ({ type: e.type, name: e.name, path: e.path, sha: e.oid, size: e.size })));
          return true;
        }
        // Distinguish a missing file from an empty directory: check the tree.
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip) {
          const c = repo.getObject(tip);
          if (c && c.type === 'commit') {
            const flat = repo.flattenTree(parseCommit(c.data).tree);
            const isDir = [...flat.keys()].some((p) => p.startsWith(`${contentPath}/`));
            if (isDir) { sendJson(res, 200, []); return true; }
          }
        }
        notFound(res);
        return true;
      }
      if (method === 'PUT') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON body' }); return true; }
        const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Update file';
        const contentB64 = typeof parsed.value.content === 'string' ? parsed.value.content : '';
        const targetBranch = typeof parsed.value.branch === 'string' ? parsed.value.branch : branch;
        const givenSha = typeof parsed.value.sha === 'string' ? parsed.value.sha.toLowerCase() : '';
        let content: Buffer;
        try { content = Buffer.from(contentB64, 'base64'); } catch { sendJson(res, 422, { message: 'Invalid base64 content' }); return true; }
        const existing = repo.readFileAt(targetBranch, contentPath);
        const isUpdate = existing !== null;
        if (isUpdate && givenSha !== '' && givenSha !== existing.oid) {
          sendJson(res, 409, { message: 'sha does not match the current blob' });
          return true;
        }
        if (isUpdate && givenSha === '') {
          // Update without a sha: GitHub requires it, but accept it as an update.
        }
        const newBlobOid = hashObject('blob', content);
        const commitSha = repo.writeFile(targetBranch, contentPath, content, message);
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: contentPath.split('/').pop(), path: contentPath, sha: newBlobOid, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitSha, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON body' }); return true; }
        const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Delete file';
        const givenSha = typeof parsed.value.sha === 'string' ? parsed.value.sha.toLowerCase() : '';
        const existing = repo.readFileAt(branch, contentPath);
        if (!existing) { notFound(res); return true; }
        if (givenSha !== '' && givenSha !== existing.oid) { sendJson(res, 409, { message: 'sha does not match the current blob' }); return true; }
        const commitSha = repo.writeFile(branch, contentPath, null, message);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return true;
      }
      return false;
    }
    if (tail[0] === 'labels') {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
        return true;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON body' }); return true; }
        const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
        if (name === '') { sendJson(res, 422, { message: 'name is required' }); return true; }
        const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { name, color, description: '' });
        return true;
      }
      return false;
    }
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const { page, perPage } = pageParams(q);
          const state = q.get('state') ?? 'open';
          const sort = q.get('sort') ?? 'created';
          const direction = q.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const extra: Record<string, string> = {};
          if (list.length > perPage) extra.link = linkHeader(req, path, q, page, perPage, list.length);
          sendJson(res, 200, paginate(list, page, perPage).map((i) => issueJson(repo, i)), extra);
          return true;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON body' }); return true; }
          const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
          if (title === '') { sendJson(res, 422, { message: 'title is required' }); return true; }
          const labels = Array.isArray(parsed.value.labels) ? (parsed.value.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) { sendJson(res, 422, { message: `Label does not exist: ${label}` }); return true; }
          }
          const issue: Issue = {
            id: store.nextId(), number: repo.nextIssue++, title,
            body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
            state: 'open', labels, seq: ++repo.seq, comments: [], closedAt: null,
          };
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        return false;
      }
      const num = Number(tail[1]);
      const issue = repo.issues.find((i) => i.number === num);
      if (tail.length === 2) {
        if (!issue) { notFound(res); return true; }
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return true; }
        if (method === 'PATCH') {
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON body' }); return true; }
          if (parsed.value.state === 'closed') { issue.state = 'closed'; issue.closedAt = isoOf(1700000000 + issue.seq); }
          else if (parsed.value.state === 'open') { issue.state = 'open'; issue.closedAt = null; }
          if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
          if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        return false;
      }
      if (tail[2] === 'comments') {
        if (!issue) { notFound(res); return true; }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: viewerLogin(), id: 1000, type: 'User' }, created_at: isoOf(1700000000 + c.seq) })));
          return true;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON body' }); return true; }
          const body = typeof parsed.value.body === 'string' ? parsed.value.body : '';
          const comment = { id: repo.nextCommentId++, body, seq: ++repo.seq };
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, body, user: { login: viewerLogin(), id: 1000, type: 'User' }, created_at: isoOf(1700000000 + comment.seq) });
          return true;
        }
        return false;
      }
      return false;
    }
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const { page, perPage } = pageParams(q);
          const state = q.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const extra: Record<string, string> = {};
          if (list.length > perPage) extra.link = linkHeader(req, path, q, page, perPage, list.length);
          sendJson(res, 200, paginate(list, page, perPage).map((p) => pullJson(repo, p)), extra);
          return true;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON body' }); return true; }
          const headRef = branchName(typeof parsed.value.head === 'string' ? parsed.value.head : '');
          const baseRef = branchName(typeof parsed.value.base === 'string' ? parsed.value.base : repo.defaultBranch);
          const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? '';
          const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? '';
          if (headSha === '' || baseSha === '') { sendJson(res, 422, { message: 'Head or base branch does not exist' }); return true; }
          const pull = {
            id: store.nextId(), number: repo.nextPull++,
            title: typeof parsed.value.title === 'string' ? parsed.value.title : '',
            body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
            state: 'open' as const, merged: false, mergedAt: null as string | null,
            mergeCommitSha: null as string | null, headRef, baseRef, headSha, baseSha,
            files: repo.diffFiles(baseSha, headSha), seq: ++repo.seq,
          };
          repo.pulls.push(pull);
          sendJson(res, 201, pullJson(repo, pull));
          return true;
        }
        return false;
      }
      const num = Number(tail[1]);
      const pull = repo.pulls.find((p) => p.number === num);
      if (tail.length === 2) {
        if (!pull) { notFound(res); return true; }
        if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return true; }
        return false;
      }
      if (tail[2] === 'files' && method === 'GET') {
        if (!pull) { notFound(res); return true; }
        sendJson(res, 200, pull.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes })));
        return true;
      }
      if (tail[2] === 'commits' && method === 'GET') {
        if (!pull) { notFound(res); return true; }
        const commits = repo.commitsFrom(pull.headRef).filter((c) => !repo.isAncestor(c.sha, pull.baseSha));
        sendJson(res, 200, commits.map((c) => ({ sha: c.sha, commit: { message: c.message } })));
        return true;
      }
      if (tail[2] === 'merge' && method === 'PUT') {
        if (!pull) { notFound(res); return true; }
        if (pull.state !== 'open') { sendJson(res, 405, { message: 'Pull request is not open' }); return true; }
        if (repo.pullConflicts(pull)) { sendJson(res, 405, { message: 'Merge conflict' }); return true; }
        const sha = repo.mergePull(pull);
        if (sha === null) { sendJson(res, 405, { message: 'Merge conflict' }); return true; }
        sendJson(res, 200, { sha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
      return false;
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------- git smart HTTP

function pktBin(payload: Buffer): Buffer {
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    out.push(pktBin(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

function gitRepo(path: string): { owner: string; name: string; rest: string } | null {
  const m = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
  if (!m) return null;
  return { owner: decodeSegment(m[1]), name: decodeSegment(m[2]), rest: m[3] };
}

function v0RefAdvertisement(repo: Repo, caps: string): Buffer {
  const parts: Buffer[] = [];
  const refs = refLinesV0(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((r, idx) => {
      const suffix = idx === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${r.oid} ${r.ref}${suffix}\n`));
      if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.ref}^{}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, raw: Buffer): Promise<boolean> {
  const g = gitRepo(path);
  if (!g) return false;
  const method = req.method ?? 'GET';
  const q = queryOf(req);
  if (g.owner !== viewerLogin()) { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const repo = store.getRepo(g.owner, g.name);
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return true; }

  if (method === 'GET' && g.rest === 'info/refs') {
    const service = q.get('service') ?? '';
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-upload-pack') {
      if (wantsV2) {
        const body = Buffer.concat([
          pktLine('version 2\n'),
          pktLine('ls-refs=unborn\n'),
          pktLine('fetch=shallow filter\n'),
          pktLine('object-format=sha1\n'),
          pktLine('agent=git-forge/1.0\n'),
          pktFlush(),
        ]);
        sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
        return true;
      }
      const caps = 'side-band-64k thin-pack ofs-delta multi_ack_detailed agent=git-forge/1.0 object-format=sha1 shallow symref=HEAD:refs/heads/main';
      const body = Buffer.concat([pktLine('# service=git-upload-pack\n'), pktFlush(), v0RefAdvertisement(repo, caps)]);
      sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      const caps = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=git-forge/1.0 object-format=sha1';
      const body = Buffer.concat([pktLine('# service=git-receive-pack\n'), pktFlush(), v0RefAdvertisement(repo, caps)]);
      sendRaw(res, 200, body, 'application/x-git-receive-pack-advertisement');
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  if (method === 'POST' && g.rest === 'git-upload-pack') {
    try {
      const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (wantsV2) {
        const { lines } = parsePktLines(raw);
        const commandLine = lines.find((l) => l.startsWith('command='));
        const command = commandLine ? commandLine.slice('command='.length).trim() : '';
        const delimIdx = lines.indexOf('\0DELIM');
        const args = (delimIdx >= 0 ? lines.slice(delimIdx + 1) : []).filter((l) => !l.startsWith('\0')).map((l) => l.replace(/\r?\n$/, ''));
        if (command === 'ls-refs') {
          const peel = args.includes('peel');
          const symrefs = args.includes('symrefs');
          const unborn = args.includes('unborn');
          const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
          const out: Buffer[] = [];
          const refs = refLinesV0(repo);
          const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          // HEAD is not a refs/* name, so a prefix-filtered answer must not
          // carry it: the client checks the filtered set contains only the
          // prefix. Without prefixes HEAD is reported like any other ref.
          if (prefixes.length === 0 && headTip && symrefs) {
            out.push(pktLine(`${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
          } else if (prefixes.length === 0 && !headTip && unborn) {
            out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
          }
          for (const r of refs) {
            if (prefixes.length > 0 && !prefixes.some((p) => r.ref.startsWith(p))) continue;
            let line = `${r.oid} ${r.ref}`;
            if (peel && r.peeled) line += ` peeled:${r.peeled}`;
            out.push(pktLine(`${line}\n`));
          }
          out.push(pktFlush());
          sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
          return true;
        }
        if (command === 'fetch') {
          const wants: string[] = [];
          const haves: string[] = [];
          const shallowHeld: string[] = [];
          let depth: number | null = null;
          for (const a of args) {
            if (a.startsWith('want ')) wants.push(a.slice(5).trim());
            else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
            else if (a.startsWith('shallow ')) shallowHeld.push(a.slice(8).trim());
            else if (a.startsWith('deepen ')) depth = Number(a.slice(7).trim());
          }
          const plan = planFetch(repo, wants, haves, shallowHeld, depth);
          const sections: Buffer[] = [];
          const ack = Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n')]);
          sections.push(ack);
          if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
            const lines2: Buffer[] = [pktLine('shallow-info\n')];
            for (const s of plan.shallow) lines2.push(pktLine(`shallow ${s}\n`));
            for (const s of plan.unshallow) lines2.push(pktLine(`unshallow ${s}\n`));
            sections.push(Buffer.concat(lines2));
          }
          const wantedRefs = wants
            .map((w) => {
              for (const [ref, oid] of repo.refs) if (oid === w) return { oid: w, ref };
              return null;
            })
            .filter((x): x is { oid: string; ref: string } => x !== null);
          if (wantedRefs.length > 0) {
            const lines2: Buffer[] = [pktLine('wanted-refs\n')];
            for (const wr of wantedRefs) lines2.push(pktLine(`${wr.oid} ${wr.ref}\n`));
            sections.push(Buffer.concat(lines2));
          }
          if (plan.objects.length > 0) {
            const pack = buildPack(plan.objects.map((o) => ({ type: o.type, data: o.data })));
            sections.push(Buffer.concat([pktLine('packfile\n'), ...sidebandPackets(pack)]));
          }
          const body = Buffer.concat(sections.flatMap((s, i) => (i === 0 ? [s] : [pktDelim(), s])));
          sendRaw(res, 200, body, 'application/x-git-upload-pack-result');
          return true;
        }
        sendJson(res, 400, { message: 'Unknown upload-pack command' });
        return true;
      }
      // v0 fetch fallback.
      const { lines } = parsePktLines(raw);
      const wants: string[] = [];
      const haves: string[] = [];
      const shallowHeld: string[] = [];
      let depth: number | null = null;
      for (const l of lines) {
        if (l.startsWith('\0')) continue;
        if (l.startsWith('want ')) wants.push(l.slice(5).trim().split(' ')[0]);
        else if (l.startsWith('have ')) haves.push(l.slice(5).trim());
        else if (l.startsWith('shallow ')) shallowHeld.push(l.slice(8).trim());
        else if (l.startsWith('deepen ')) depth = Number(l.slice(7).trim());
      }
      const plan = planFetch(repo, wants, haves, shallowHeld, depth);
      const parts: Buffer[] = [pktLine('NAK\n')];
      for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
      if (plan.objects.length > 0) {
        const pack = buildPack(plan.objects.map((o) => ({ type: o.type, data: o.data })));
        parts.push(...sidebandPackets(pack));
      }
      sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return true;
    } catch (err) {
      process.stderr.write(`[forge] upload-pack error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      sendJson(res, 400, { message: 'Malformed upload-pack request' });
      return true;
    }
  }

  if (method === 'POST' && g.rest === 'git-receive-pack') {
    try {
      const { lines, consumed } = parsePktLines(raw);
      const commands: { oldOid: string; newOid: string; ref: string }[] = [];
      let useSideband = false;
      for (const line of lines) {
        if (line.startsWith('\0')) continue;
        const nul = line.indexOf('\0');
        const text = nul >= 0 ? line.slice(0, nul) : line;
        const caps = nul >= 0 ? line.slice(nul + 1) : '';
        if (caps.includes('side-band-64k')) useSideband = true;
        const parts = text.trim().split(' ');
        if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      }
      const packBytes = raw.subarray(consumed);
      if (packBytes.length > 12) {
        const parsed = parsePack(packBytes);
        for (const obj of parsed.objects) repo.putObject(obj.type, obj.data);
      }
      const reportLines: string[] = ['unpack ok\n'];
      for (const cmd of commands) {
        const current = repo.refs.get(cmd.ref);
        if (cmd.newOid === ZERO_OID) {
          if (current === undefined) { reportLines.push(`ng ${cmd.ref} no such ref\n`); continue; }
          repo.refs.delete(cmd.ref);
          reportLines.push(`ok ${cmd.ref}\n`);
          continue;
        }
        if (cmd.oldOid === ZERO_OID) {
          if (current !== undefined) { reportLines.push(`ng ${cmd.ref} non-fast-forward\n`); continue; }
          repo.refs.set(cmd.ref, cmd.newOid);
          reportLines.push(`ok ${cmd.ref}\n`);
          continue;
        }
        if (current === undefined || current.toLowerCase() !== cmd.oldOid.toLowerCase()) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
          continue;
        }
        if (!repo.isAncestor(cmd.oldOid, cmd.newOid)) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}\n`);
      }
      const report = Buffer.concat(reportLines.map((l) => pktLine(l)));
      let body: Buffer;
      if (useSideband) {
        const packets: Buffer[] = [];
        const CHUNK = 65515;
        for (let i = 0; i < report.length; i += CHUNK) {
          packets.push(pktBin(Buffer.concat([Buffer.from([1]), report.subarray(i, Math.min(report.length, i + CHUNK))])));
        }
        body = Buffer.concat([...packets, pktFlush()]);
      } else {
        body = Buffer.concat([report, pktFlush()]);
      }
      sendRaw(res, 200, body, 'application/x-git-receive-pack-result');
      return true;
    } catch {
      sendJson(res, 400, { message: 'Malformed receive-pack request' });
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- server

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        const raw = await readBody(req);
        if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        if (path === '/api/graphql') {
          if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
          if (!authed(req)) { unauthorized(res); return; }
          let body: unknown;
          try { body = JSON.parse(raw.toString('utf8')); } catch { sendJson(res, 400, { message: 'Invalid JSON body' }); return; }
          sendJson(res, 200, handleGraphQL(store, viewerLogin(), body));
          return;
        }
        if (path === '/mcp') {
          if (method === 'DELETE') { res.writeHead(202, { 'x-github-request-id': `req-${++requestCounter}` }); res.end(); return; }
          if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
          const outcome = handleMcp(store, viewerLogin(), authed(req), raw);
          if (outcome.body === null) {
            res.writeHead(outcome.status, { 'x-github-request-id': `req-${++requestCounter}`, ...outcome.headers });
            res.end();
            return;
          }
          res.writeHead(outcome.status, {
            'content-length': Buffer.byteLength(outcome.body),
            'x-github-request-id': `req-${++requestCounter}`,
            ...outcome.headers,
          });
          res.end(outcome.body);
          return;
        }
        if (path.includes('.git/')) {
          const handled = await handleGit(req, res, path, raw);
          if (handled) return;
          notFound(res);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const handled = await handleRest(req, res, path, raw);
          if (handled) return;
          notFound(res);
          return;
        }
        notFound(res);
      } catch (err) {
        try { sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' }); } catch { /* socket gone */ }
      }
    })();
  });
}
