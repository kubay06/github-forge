// JSON views for REST and GraphQL: one shape per resource, shared by every
// surface so MCP, GraphQL and REST always read back the same objects.

import { Repo, viewerLogin, viewerName, viewerEmail, isoOf, type Issue, type Pull } from './store.ts';

export function userJson(): Record<string, unknown> {
  const login = viewerLogin();
  return {
    login, id: 1000, node_id: Buffer.from(`user:${login}`, 'utf8').toString('base64url'),
    avatar_url: '', gravatar_id: '', url: `/api/v3/users/${login}`, html_url: `https://example.invalid/${login}`,
    type: 'User', site_admin: false, name: viewerName(), email: viewerEmail(),
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, node_id: repo.nodeId(), name: repo.name, full_name: repo.fullName(),
    owner: { login: repo.owner, id: 1000, node_id: Buffer.from(`user:${repo.owner}`, 'utf8').toString('base64url'), type: 'User' },
    private: repo.isPrivate, html_url: `https://example.invalid/${repo.fullName()}`,
    description: repo.description, fork: false,
    url: `/api/v3/repos/${repo.fullName()}`,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', pushed_at: '2026-01-01T00:00:00Z',
    git_url: `git://example.invalid/${repo.fullName()}.git`,
    ssh_url: `git@example.invalid:${repo.fullName()}.git`,
    clone_url: `https://example.invalid/${repo.fullName()}.git`,
    homepage: null, size: repo.objects.size, stargazers_count: 0, watchers_count: 0,
    language: null, has_issues: true, has_projects: true, has_downloads: true,
    has_wiki: true, has_pages: false, has_discussions: false,
    forks_count: 0, open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null, allow_forking: true, is_template: false,
    topics: [], visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: Buffer.from(`issue:${repo.id}:${issue.number}`, 'utf8').toString('base64url'),
    url: `/api/v3/repos/${repo.fullName()}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName()}`,
    labels_url: `/api/v3/repos/${repo.fullName()}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.fullName()}/issues/${issue.number}/comments`,
    html_url: `https://example.invalid/${repo.fullName()}/issues/${issue.number}`,
    number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    locked: false, user: { login: viewerLogin(), id: 1000, type: 'User' },
    labels: issue.labels.map((name) => ({ name, color: 'ededed', description: '' })),
    assignee: null, assignees: [], milestone: null,
    comments: issue.comments.length,
    created_at: isoOf(1700000000 + issue.seq),
    updated_at: isoOf(1700000000 + issue.seq),
    closed_at: issue.closedAt,
    author_association: 'OWNER', active_lock_reason: null,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    node_id: Buffer.from(`pr:${repo.id}:${pull.number}`, 'utf8').toString('base64url'),
    url: `/api/v3/repos/${repo.fullName()}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.fullName()}/pull/${pull.number}`,
    number: pull.number, title: pull.title, body: pull.body, state: pull.state,
    locked: false, user: { login: viewerLogin(), id: 1000, type: 'User' },
    labels: [], assignee: null, assignees: [], milestone: null,
    comments: 0, review_comments: 0,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: { login: viewerLogin(), id: 1000, type: 'User' }, repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: { login: viewerLogin(), id: 1000, type: 'User' }, repo: repoJson(repo) },
    merged: pull.merged, mergeable: repo.pullConflicts(pull) ? false : true,
    mergeable_state: repo.pullConflicts(pull) ? 'dirty' : 'clean',
    merged_at: pull.mergedAt, merge_commit_sha: pull.mergeCommitSha,
    created_at: isoOf(1700000000 + pull.seq),
    updated_at: isoOf(1700000000 + pull.seq),
    closed_at: pull.state === 'closed' ? pull.mergedAt ?? isoOf(1700000000 + pull.seq) : null,
    author_association: 'OWNER', draft: false,
  };
}

export function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name, commit: { sha, url: `/api/v3/repos/${repo.fullName()}/commits/${sha}` },
    protected: false, protection_url: `/api/v3/repos/${repo.fullName()}/branches/${name}/protection`,
  };
}
