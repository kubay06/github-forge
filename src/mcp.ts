// MCP over Streamable HTTP: modern 2026-07-28 (server/discover) and the
// legacy handshake (initialize + notifications/initialized). The tools act
// on the same store as REST, with the same ids, so a repository or issue
// created over MCP reads back over /api/v3 unchanged.

import { Store, decodeGlobalId, type Issue } from './store.ts';
import { repoJson, issueJson, pullJson } from './views.ts';

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository' },
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
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
        owner: { type: 'string', description: 'Owner login of the repository' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: [],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
      },
      required: [],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        number: { type: 'number', description: 'Issue number' },
      },
      required: ['number'],
    },
  },
];

function toolResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  const full = typeof args.full_name === 'string' ? args.full_name : '';
  if (repo === '' && full.includes('/')) {
    const [o, r] = full.split('/');
    owner = o; repo = r;
  }
  return { owner, repo };
}

function callTool(store: Store, viewer: string, name: string, args: Record<string, unknown>): { ok: boolean; result?: Record<string, unknown>; errorCode?: number; errorMessage?: string } {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const bySuffix = (want: string): boolean => norm === want || norm.endsWith(want);
  if (bySuffix('createrepo') || bySuffix('createrepository')) {
    const repoName = typeof args.name === 'string' ? args.name : typeof args.repo === 'string' ? args.repo : '';
    if (repoName === '') return { ok: true, result: toolError('missing required argument: name') };
    const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : viewer;
    let repo = store.getRepo(owner, repoName);
    if (!repo) {
      repo = store.createRepo(repoName, owner, args.private === true, typeof args.description === 'string' ? args.description : '');
    }
    const obj = { ...repoJson(repo), full_name: repo.fullName() };
    return { ok: true, result: toolResult(obj) };
  }
  if (bySuffix('getrepo') || bySuffix('getrepository')) {
    const { owner, repo: repoName } = splitFullName(args);
    const repo = store.getRepo(owner || viewer, repoName);
    if (!repo) return { ok: true, result: toolError(`repository ${owner}/${repoName} not found`) };
    return { ok: true, result: toolResult({ ...repoJson(repo), full_name: repo.fullName() }) };
  }
  if (bySuffix('createissue') || bySuffix('issuecreate')) {
    const { owner, repo: repoName } = splitFullName(args);
    const repo = store.getRepo(owner || viewer, repoName);
    if (!repo) return { ok: true, result: toolError(`repository ${owner}/${repoName} not found`) };
    if (typeof args.title !== 'string' || args.title === '') return { ok: true, result: toolError('missing required argument: title') };
    const issue: Issue = {
      id: store.nextId(), number: repo.nextIssue++, title: args.title,
      body: typeof args.body === 'string' ? args.body : '', state: 'open', labels: [],
      seq: ++repo.seq, comments: [], closedAt: null,
    };
    repo.issues.push(issue);
    const obj = { ...issueJson(repo, issue), full_name: repo.fullName() };
    return { ok: true, result: toolResult(obj) };
  }
  if (bySuffix('listissues') || bySuffix('issueslist') || bySuffix('issuelist')) {
    const { owner, repo: repoName } = splitFullName(args);
    const repo = store.getRepo(owner || viewer, repoName);
    if (!repo) return { ok: true, result: toolError(`repository ${owner}/${repoName} not found`) };
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues.filter((i) => state === 'all' || i.state === state);
    const obj = { issues: list.map((i) => issueJson(repo, i)) };
    return { ok: true, result: toolResult(obj) };
  }
  if (bySuffix('createpullrequest') || bySuffix('pullrequestcreate') || bySuffix('createpr') || bySuffix('prcreate')) {
    const { owner, repo: repoName } = splitFullName(args);
    const repo = store.getRepo(owner || viewer, repoName);
    if (!repo) return { ok: true, result: toolError(`repository ${owner}/${repoName} not found`) };
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
    if (typeof args.title !== 'string' || args.title === '' || head === '') {
      return { ok: true, result: toolError('missing required argument: title or head') };
    }
    const headSha = repo.refs.get(`refs/heads/${head}`) ?? '';
    const baseSha = repo.refs.get(`refs/heads/${base}`) ?? '';
    const pull = {
      id: store.nextId(), number: repo.nextPull++, title: args.title,
      body: typeof args.body === 'string' ? args.body : '', state: 'open' as const,
      merged: false, mergedAt: null as string | null, mergeCommitSha: null as string | null,
      headRef: head, baseRef: base, headSha, baseSha,
      files: repo.diffFiles(baseSha, headSha), seq: ++repo.seq,
    };
    repo.pulls.push(pull);
    const obj = { ...pullJson(repo, pull), number: pull.number, pull_number: pull.number, full_name: repo.fullName() };
    return { ok: true, result: toolResult(obj) };
  }
  if (bySuffix('mergepullrequest') || bySuffix('pullrequestmerge') || bySuffix('mergepr') || bySuffix('prmerge')) {
    const { owner, repo: repoName } = splitFullName(args);
    const repo = store.getRepo(owner || viewer, repoName);
    if (!repo) return { ok: true, result: toolError(`repository ${owner}/${repoName} not found`) };
    const num = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : NaN;
    if (!Number.isFinite(num)) return { ok: true, result: toolError('missing required argument: pull_number') };
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) return { ok: true, result: toolError(`pull request #${num} not found`) };
    const sha = repo.mergePull(pull);
    if (sha === null) return { ok: true, result: toolError('pull request cannot be merged') };
    return { ok: true, result: toolResult({ merged: true, sha, number: pull.number, pull_number: pull.number, full_name: repo.fullName() }) };
  }
  if (bySuffix('listrepos')) {
    const list = store.reposOf(viewer).map((r) => ({ ...repoJson(r), full_name: r.fullName() }));
    return { ok: true, result: toolResult({ repos: list }) };
  }
  if (bySuffix('getissue')) {
    const { owner, repo: repoName } = splitFullName(args);
    const repo = store.getRepo(owner || viewer, repoName);
    const num = typeof args.number === 'number' ? args.number : NaN;
    const issue = repo?.issues.find((i) => i.number === num);
    if (!repo || !issue) return { ok: true, result: toolError('issue not found') };
    return { ok: true, result: toolResult(issueJson(repo, issue)) };
  }
  return { ok: false, errorCode: -32601, errorMessage: `Unknown tool: ${name}` };
}

export interface McpOutcome { status: number; headers: Record<string, string>; body: string | null }

export function handleMcp(store: Store, viewer: string, authed: boolean, raw: Buffer): McpOutcome {
  const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
  if (!authed) {
    return { status: 401, headers: jsonHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return {
      status: 400, headers: jsonHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  const req = (parsed ?? {}) as Record<string, unknown>;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, headers: {}, body: null };
  }
  const reply = (result: unknown): McpOutcome => ({
    status: 200, headers: jsonHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  });
  const replyError = (code: number, message: string, status = 200): McpOutcome => ({
    status, headers: jsonHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  });
  if (method === 'server/discover') {
    return reply({
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      supportedVersions: SUPPORTED_VERSIONS,
      protocolVersion: '2026-07-28',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    const negotiated = SUPPORTED_VERSIONS.includes(wanted) ? wanted : '2026-07-28';
    return {
      status: 200,
      headers: { ...jsonHeaders, 'mcp-session-id': 'forge-session-1' },
      body: JSON.stringify({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      }),
    };
  }
  if (method === 'tools/list') {
    return reply({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '') return replyError(-32602, 'Missing tool name');
    const called = callTool(store, viewer, name, args);
    if (!called.ok) return replyError(called.errorCode ?? -32601, called.errorMessage ?? 'Unknown tool');
    return reply(called.result);
  }
  if (method === 'ping') return reply({});
  return replyError(-32601, `Method not found: ${method}`);
}

export { decodeGlobalId };
