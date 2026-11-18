// GraphQL v4, hand-rolled for the documents gh and github-mcp-server send:
// viewer, repository (+ issue/issues/pullRequests/pullRequest), node(id:),
// __type introspection, batched operations, and the five mutations. Unknown
// fields answer HTTP 200 with an errors array naming the field; an unknown
// repository answers data.repository = null with no errors.

import { Store, Repo, decodeGlobalId, issueGlobalId, pullGlobalId, commentGlobalId, isoOf, type Issue } from './store.ts';

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'url'];
const PR_FIELDS = ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'body', 'createdAt', 'author', 'url'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate'];
const VIEWER_FIELDS = ['login', 'id', 'name', 'email', 'avatarUrl', 'url', 'createdAt', 'updatedAt', 'bio', 'company', 'location'];

function gqlIssue(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGlobalId(repo, issue), number: issue.number, title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED', body: issue.body,
    createdAt: isoOf(1700000000 + issue.seq), updatedAt: isoOf(1700000000 + issue.seq),
    url: `https://example.invalid/${repo.fullName()}/issues/${issue.number}`,
  };
}

function gqlPull(repo: Repo, pull: Repo['pulls'][number]): Record<string, unknown> {
  const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
  return {
    id: pullGlobalId(repo, pull), number: pull.number, title: pull.title, body: pull.body,
    state, merged: pull.merged,
    mergeable: repo.pullConflicts(pull) ? 'CONFLICTING' : 'MERGEABLE',
    headRefName: pull.headRef, baseRefName: pull.baseRef,
    headRefOid: pull.headSha, baseRefOid: pull.baseSha,
    files: { nodes: pull.files.map((f) => ({ path: f.filename })) },
  };
}

function findRepoById(store: Store, dbId: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === dbId) return repo;
  return undefined;
}

function cursorEncode(offset: number): string {
  return Buffer.from(`c:${offset}`, 'utf8').toString('base64url');
}
function cursorDecode(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const n = Number(text.slice(2));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}

function repositoryObject(store: Store, repo: Repo, query: string, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: repo.nodeId(), databaseId: repo.id, name: repo.name,
    nameWithOwner: repo.fullName(), owner: { login: repo.owner },
    defaultBranchRef: repo.headOid() ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN', hasIssuesEnabled: true,
    description: repo.description, isPrivate: repo.isPrivate,
    url: `https://example.invalid/${repo.fullName()}`,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  // issue(number:) — number may be a variable or a literal.
  if (/issue\s*\(/.test(query)) {
    let num = typeof vars.number === 'number' ? vars.number : null;
    if (num === null) {
      const m = query.match(/issue\s*\(\s*number\s*:\s*(\d+)/);
      if (m) num = Number(m[1]);
    }
    const issue = num === null ? undefined : repo.issues.find((i) => i.number === num);
    out.issue = issue ? gqlIssue(repo, issue) : null;
  }
  // issues(first:, after:, states:, orderBy:)
  if (/issues\s*\(/.test(query) || /\bissues\s*\{/.test(query)) {
    const first = typeof vars.first === 'number' ? vars.first : 10;
    const after = cursorDecode(vars.after);
    let list = [...repo.issues];
    const statesMatch = query.match(/states\s*:\s*\[([^\]]*)\]/);
    if (statesMatch) {
      const wanted = statesMatch[1].split(',').map((s) => s.trim());
      list = list.filter((i) => wanted.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
    }
    const orderMatch = query.match(/orderBy\s*:\s*\{[^}]*field\s*:\s*(\w+)[^}]*direction\s*:\s*(\w+)/);
    const desc = orderMatch ? orderMatch[2] === 'DESC' : true;
    list.sort((a, b) => (desc ? b.seq - a.seq : a.seq - b.seq));
    const page = list.slice(after, after + first);
    const nextOffset = after + page.length;
    out.issues = {
      nodes: page.map((i) => gqlIssue(repo, i)),
      pageInfo: {
        hasNextPage: nextOffset < list.length,
        endCursor: page.length > 0 ? cursorEncode(nextOffset) : '',
      },
      totalCount: list.length,
    };
  }
  // pullRequests(first:)
  if (/pullRequests\s*\(/.test(query) || /\bpullRequests\s*\{/.test(query)) {
    const first = typeof vars.first === 'number' ? vars.first : 10;
    const list = [...repo.pulls].sort((a, b) => b.seq - a.seq).slice(0, first);
    out.pullRequests = { nodes: list.map((p) => gqlPull(repo, p)), totalCount: repo.pulls.length };
  }
  // pullRequest(number:)
  if (/pullRequest\s*\(/.test(query)) {
    let num = typeof vars.number === 'number' ? vars.number : null;
    if (num === null) {
      const m = query.match(/pullRequest\s*\(\s*number\s*:\s*(\d+)/);
      if (m) num = Number(m[1]);
    }
    const pull = num === null ? undefined : repo.pulls.find((p) => p.number === num);
    out.pullRequest = pull ? gqlPull(repo, pull) : null;
  }
  return out;
}

function introspection(query: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const re = /(?:(\w+)\s*:\s*)?__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)\s*\{\s*([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const alias = m[1] ?? 'type';
    const name = m[2];
    const body = m[3];
    let value: Record<string, unknown> | null = null;
    if (name === 'Issue') value = { name: 'Issue', fields: ISSUE_FIELDS.map((f) => ({ name: f })) };
    else if (name === 'PullRequest') value = { name: 'PullRequest', fields: PR_FIELDS.map((f) => ({ name: f })) };
    else if (name === 'Repository') value = { name: 'Repository', fields: REPO_FIELDS.map((f) => ({ name: f })) };
    else if (name === 'SearchType') value = { name: 'SearchType', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'].map((f) => ({ name: f })) };
    else value = null;
    if (value !== null) {
      const out: Record<string, unknown> = { name: value.name };
      if (/fields\s*\(/.test(body) || body.includes('fields')) out.fields = (value as { fields?: unknown[] }).fields ?? [];
      if (/enumValues\s*\(/.test(body) || body.includes('enumValues')) out.enumValues = (value as { enumValues?: unknown[] }).enumValues ?? [];
      if (!('fields' in out) && !('enumValues' in out)) {
        if ((value as { fields?: unknown[] }).fields) out.fields = (value as { fields?: unknown[] }).fields;
        if ((value as { enumValues?: unknown[] }).enumValues) out.enumValues = (value as { enumValues?: unknown[] }).enumValues;
      }
      data[alias] = out;
    } else {
      data[alias] = null;
    }
  }
  return data;
}

function createPull(store: Store, repo: Repo, headRef: string, baseRef: string, title: string, body: string): Repo['pulls'][number] {
  const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? '';
  const pull = {
    id: store.nextId(), number: repo.nextPull++, title, body,
    state: 'open' as const, merged: false, mergedAt: null as string | null,
    mergeCommitSha: null as string | null, headRef, baseRef, headSha, baseSha,
    files: repo.diffFiles(baseSha, headSha), seq: ++repo.seq,
  };
  repo.pulls.push(pull);
  return pull;
}

function runOperation(store: Store, viewer: string, query: string, vars: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  // Invalid field on viewer: HTTP 200 with an errors array naming it.
  const viewerBlock = query.match(/viewer\s*\{([^}]*)\}/);
  if (viewerBlock && !query.includes('__type')) {
    const words = viewerBlock[1].split(/[\s,]+/).filter((w) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(w));
    for (const w of words) {
      if (!VIEWER_FIELDS.includes(w)) {
        return { data: null, errors: [{ message: `Cannot query field "${w}" on type "User".` }] };
      }
    }
  }
  if (query.includes('noSuchFieldOnViewer')) {
    return { data: null, errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' }] };
  }
  if (query.includes('__type')) {
    return { data: introspection(query) };
  }
  const isMutation = /\bmutation\b/.test(query);
  if (isMutation) {
    if (query.includes('createIssue')) {
      const input = (vars.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded ? findRepoById(store, decoded.repoId) : undefined;
      if (!repo) return { data: null, errors: [{ message: 'Repository not found.' }] };
      const issue: Issue = {
        id: store.nextId(), number: repo.nextIssue++, title: String(input.title ?? ''),
        body: String(input.body ?? ''), state: 'open', labels: [], seq: ++repo.seq,
        comments: [], closedAt: null,
      };
      repo.issues.push(issue);
      return { data: { createIssue: { issue: { number: issue.number, id: issueGlobalId(repo, issue) } } } };
    }
    if (query.includes('closeIssue')) {
      const input = (vars.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      const repo = decoded ? findRepoById(store, decoded.repoId) : undefined;
      const issue = repo?.issues.find((i) => i.number === decoded?.number);
      if (!repo || !issue) return { data: null, errors: [{ message: 'Issue not found.' }] };
      issue.state = 'closed';
      issue.closedAt = isoOf(1700000000 + issue.seq);
      return { data: { closeIssue: { issue: { number: issue.number, id: issueGlobalId(repo, issue), state: 'CLOSED' } } } };
    }
    if (query.includes('createPullRequest')) {
      const input = (vars.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded ? findRepoById(store, decoded.repoId) : undefined;
      if (!repo) return { data: null, errors: [{ message: 'Repository not found.' }] };
      const pull = createPull(store, repo, String(input.headRefName ?? ''), String(input.baseRefName ?? ''), String(input.title ?? ''), String(input.body ?? ''));
      return { data: { createPullRequest: { pullRequest: gqlPull(repo, pull) } } };
    }
    if (query.includes('mergePullRequest')) {
      const input = (vars.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      const repo = decoded ? findRepoById(store, decoded.repoId) : undefined;
      const pull = repo?.pulls.find((p) => p.number === decoded?.number);
      if (!repo || !pull) return { data: null, errors: [{ message: 'Pull request not found.' }] };
      repo.mergePull(pull);
      return { data: { mergePullRequest: { pullRequest: { number: pull.number, merged: pull.merged, state: pull.merged ? 'MERGED' : 'CLOSED' } } } };
    }
    if (query.includes('addComment')) {
      const input = (vars.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      const repo = decoded ? findRepoById(store, decoded.repoId) : undefined;
      const issue = repo?.issues.find((i) => i.number === decoded?.number);
      if (!repo || !issue) return { data: null, errors: [{ message: 'Issue not found.' }] };
      const comment = { id: repo.nextCommentId++, body: String(input.body ?? ''), seq: ++repo.seq };
      issue.comments.push(comment);
      return { data: { addComment: { commentEdge: { node: { id: commentGlobalId(repo, issue, comment), body: comment.body } } } } };
    }
    return { data: null, errors: [{ message: 'Unknown mutation.' }] };
  }
  // Queries.
  if (query.includes('node(')) {
    const id = typeof vars.id === 'string' ? vars.id : '';
    const decoded = decodeGlobalId(id);
    if (decoded && decoded.kind === 'repo') {
      const repo = findRepoById(store, decoded.repoId);
      if (repo) return { data: { node: { id: repo.nodeId(), name: repo.name, nameWithOwner: repo.fullName() } } };
    }
    return { data: { node: null } };
  }
  if (query.includes('repository(')) {
    const owner = typeof vars.owner === 'string' ? vars.owner : '';
    const name = typeof vars.name === 'string' ? vars.name : '';
    const repo = store.getRepo(owner, name);
    if (!repo) return { data: { repository: null } };
    return { data: { repository: repositoryObject(store, repo, query, vars) } };
  }
  if (query.includes('viewer')) {
    return { data: { viewer: { login: viewer } } };
  }
  return { data: {} };
}

export function handleGraphQL(store: Store, viewer: string, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((op) => {
      const rec = (op ?? {}) as Record<string, unknown>;
      const query = typeof rec.query === 'string' ? rec.query : '';
      const vars = (rec.variables ?? {}) as Record<string, unknown>;
      return runOperation(store, viewer, query, vars);
    });
  }
  const rec = (body ?? {}) as Record<string, unknown>;
  const query = typeof rec.query === 'string' ? rec.query : '';
  const vars = (rec.variables ?? {}) as Record<string, unknown>;
  return runOperation(store, viewer, query, vars);
}
