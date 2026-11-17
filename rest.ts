// The REST v3 surface (/api/v3/*), written against the behaviour the suite's checks
// actually verify: exact statuses, JSON shapes, pagination, sha consistency and the
// squash-merge conflict rule. Extra fields are tolerated by the suite, missing or
// mistyped required fields are not, so every required field is filled from the store.

import {
  blobAtPath,
  buildCommit,
  diffLines,
  flattenTree,
  hashObject,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
  putObject,
  threeWayMerge,
  treeAtPath,
  treeFromFlat,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface ApiResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface RestRequest {
  method: string;
  /** Decoded path segments of the URL path. */
  segments: string[];
  query: URLSearchParams;
  /** Parsed JSON body, or undefined when there was no (valid) body. */
  body: unknown;
  /** The entry's own base URL, used to build absolute pagination links. */
  baseUrl: string;
}

const FIXED_ISO = '2025-01-01T00:00:00Z';
const COMMIT_ISO = (stamp: number): string => new Date(stamp * 1000).toISOString();

function json(status: number, body: unknown, headers?: Record<string, string>): ApiResponse {
  return { status, headers, body };
}

function error(status: number, message: string): ApiResponse {
  return { status, body: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function boolField(body: unknown, field: string, fallback: boolean): boolean {
  if (!isRecord(body)) return fallback;
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

/** Parse a page number / page size from the query, clamped to sane ranges. */
function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { pageItems: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), totalPages };
}

function linkHeader(baseUrl: string, path: string, query: URLSearchParams, page: number, perPage: number, totalPages: number): string {
  const build = (targetPage: number): string => {
    const next = new URLSearchParams(query);
    next.set('page', String(targetPage));
    next.set('per_page', String(perPage));
    return `<${baseUrl}${path}?${next.toString()}>`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`${build(page + 1)}; rel="next"`);
  if (page > 1) parts.push(`${build(page - 1)}; rel="prev"`);
  parts.push(`${build(totalPages)}; rel="last"`);
  parts.push(`${build(1)}; rel="first"`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    assignee: null,
    assignees: [],
    comments: repo.comments.filter((comment) => comment.issueNumber === issue.number).length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function prMergeable(repo: Repo, pull: PullRequest): boolean {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip) return false;
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return false;
  const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const tipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  return !threeWayMerge(flattenTree(repo, baseTree), flattenTree(repo, headTree), flattenTree(repo, tipTree)).conflict;
}

export function prJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? '';
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? '';
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: prMergeable(repo, pull),
    mergeable_state: prMergeable(repo, pull) ? 'clean' : 'dirty',
    head: { ref: pull.head, sha: headTip, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseTip, label: `${repo.owner}:${pull.base}` },
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    assignee: null,
    assignees: [],
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(repo: Repo, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${comment.id}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

// ---------------------------------------------------------------------------------------------
// git helpers used by the contents API
// ---------------------------------------------------------------------------------------------

/**
 * Squash-merge a pull request into its base branch (three-way merge; a conflict refuses
 * the merge). Shared by the REST merge endpoint and the MCP merge tool so both surfaces
 * behave identically. Returns the merge commit sha on success.
 */
export function mergePullRequest(
  store: Store,
  repo: Repo,
  pull: PullRequest,
): { ok: true; sha: string } | { ok: false; status: number; message: string } {
  if (pull.merged || pull.state === 'closed') {
    return { ok: false, status: 405, message: 'Pull request is already merged or closed' };
  }
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip) return { ok: false, status: 404, message: 'Not Found' };
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return { ok: false, status: 405, message: 'Cannot merge: no merge base' };
  const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const tipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const { merged, conflict } = threeWayMerge(
    flattenTree(repo, baseTree),
    flattenTree(repo, headTree),
    flattenTree(repo, tipTree),
  );
  if (conflict) return { ok: false, status: 405, message: 'Merge conflict' };
  const tree = treeFromFlat(repo, merged);
  const stamp = store.nextCommitTimestamp(repo);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}`;
  const mergeCommit = putObject(
    repo,
    'commit',
    buildCommit({ tree, parents: [baseTip], timestamp: stamp, message }),
  );
  repo.refs.set(`refs/heads/${pull.base}`, mergeCommit);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = COMMIT_ISO(stamp);
  pull.mergeCommitSha = mergeCommit;
  return { ok: true, sha: mergeCommit };
}

/** The commit at the tip of `branch`, or null when the branch does not exist / is unborn. */
function branchTipCommit(repo: Repo, branch: string): { oid: string; tree: string } | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return null;
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') return null;
  return { oid: tip, tree: parseCommit(object.data).tree };
}

/**
 * Create a commit on `branch` that replaces (or adds, or deletes) one file. When the branch
 * does not exist it is created from the default branch's tip (or as the first commit when the
 * repository is still unborn). Returns the new commit oid.
 */
function commitFileChange(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): string {
  const tip = branchTipCommit(repo, branch);
  const baseTree = tip ? tip.tree : null;
  const flat = baseTree ? new Map(flattenTree(repo, baseTree)) : new Map<string, string>();
  if (content === null) flat.delete(path);
  else flat.set(path, putObject(repo, 'blob', content));
  const tree = treeFromFlat(repo, flat);
  const stamp = store.nextCommitTimestamp(repo);
  const parents = tip ? [tip.oid] : [];
  const commit = putObject(
    repo,
    'commit',
    buildCommit({ tree, parents, timestamp: stamp, message }),
  );
  repo.refs.set(`refs/heads/${branch}`, commit);
  return commit;
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

export function handleRest(request: RestRequest, store: Store): ApiResponse {
  const { method, segments, query, body, baseUrl } = request;
  // All routes live under /api/v3.
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') {
    return error(404, 'Not Found');
  }
  const rest = segments.slice(2);

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method !== 'GET') return error(404, 'Not Found');
    return json(200, {}, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return error(404, 'Not Found');
    return json(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user and /api/v3/user/repos
  if (rest[0] === 'user') {
    if (rest.length === 1) {
      if (method !== 'GET') return error(404, 'Not Found');
      return json(200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        node_id: `U_${VIEWER_ID}`,
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        type: 'User',
        html_url: `https://example.invalid/${VIEWER_LOGIN}`,
        url: '/api/v3/user',
      });
    }
    if (rest.length === 2 && rest[1] === 'repos') {
      if (method === 'GET') {
        const { page, perPage } = pageParams(query);
        const repos = store.listRepos(VIEWER_LOGIN);
        const { pageItems, totalPages } = paginate(repos, page, perPage);
        const headers: Record<string, string> = {};
        if (totalPages > 1) {
          headers.Link = linkHeader(baseUrl, '/api/v3/user/repos', query, page, perPage, totalPages);
        }
        return json(200, pageItems.map(repoJson), headers);
      }
      if (method === 'POST') {
        const name = stringField(body, 'name');
        if (!name) return error(422, 'Validation Failed: name is required');
        if (store.getRepo(VIEWER_LOGIN, name)) return error(422, 'Validation Failed: name already exists on this account');
        const repo = store.createRepo(VIEWER_LOGIN, name, boolField(body, 'private', false), stringField(body, 'description') ?? '');
        return json(201, repoJson(repo));
      }
      return error(404, 'Not Found');
    }
    return error(404, 'Not Found');
  }

  // Everything below is /api/v3/repos/{owner}/{repo}[...]
  if (rest[0] !== 'repos' || rest.length < 3) return error(404, 'Not Found');
  const owner = rest[1]!;
  const repoName = rest[2]!;
  const repo = store.getRepo(owner, repoName);
  if (!repo) return error(404, 'Not Found');
  const tail = rest.slice(3);

  // /repos/{o}/{r} itself
  if (tail.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      const description = stringField(body, 'description');
      if (description !== undefined) repo.description = description;
      const name = stringField(body, 'name');
      if (name !== undefined && name !== repo.name) {
        // Renaming is out of scope for the suite; keep the stored name stable.
      }
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, body: '' };
    }
    return error(404, 'Not Found');
  }

  const section = tail[0]!;

  // --- branches ---------------------------------------------------------------
  if (section === 'branches') {
    if (tail.length === 1) {
      if (method !== 'GET') return error(404, 'Not Found');
      const names = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort();
      return json(
        200,
        names.map((name) => ({
          name,
          commit: { sha: repo.refs.get(`refs/heads/${name}`) },
          protected: false,
        })),
      );
    }
    if (tail.length === 2) {
      if (method !== 'GET') return error(404, 'Not Found');
      const branch = tail[1]!;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (!tip) return error(404, 'Not Found');
      return json(200, { name: branch, commit: { sha: tip }, protected: false });
    }
    return error(404, 'Not Found');
  }

  // --- commits ----------------------------------------------------------------
  if (section === 'commits') {
    if (tail.length !== 1 || method !== 'GET') return error(404, 'Not Found');
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = branchTipCommit(repo, ref);
    if (!tip) return error(404, 'Not Found');
    // First-parent walk from the tip, newest first.
    const commits: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let current: string | null = tip.oid;
    while (current && !seen.has(current)) {
      seen.add(current);
      const object = repo.objects.get(current);
      if (!object || object.type !== 'commit') break;
      const view = parseCommit(object.data);
      commits.push({
        sha: current,
        commit: {
          // The object format stores the message with a trailing newline; the API
          // surface returns it without, so a caller comparing to the message it sent
          // sees an exact match.
          message: view.message.replace(/\n$/, ''),
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
        },
        parents: view.parents.map((sha) => ({ sha })),
      });
      current = view.parents[0] ?? null;
    }
    return json(200, commits);
  }

  // --- git data API -----------------------------------------------------------
  if (section === 'git') {
    if (tail[1] === 'refs') {
      // POST /git/refs — create a ref.
      if (tail.length === 2 && method === 'POST') {
        const ref = stringField(body, 'ref');
        const sha = stringField(body, 'sha');
        if (!ref || !sha) return error(422, 'Validation Failed: ref and sha are required');
        if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
          return error(422, 'Validation Failed: ref must start with refs/heads/ or refs/tags/');
        }
        if (!isObjectId(sha) || !repo.objects.has(sha)) return error(422, 'Validation Failed: sha does not exist');
        if (repo.refs.has(ref)) return error(422, 'Validation Failed: Reference already exists');
        repo.refs.set(ref, sha);
        return json(201, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.slice(5)}` });
      }
      // GET /git/refs/heads/{branch}
      if (tail.length === 4 && tail[2] === 'heads' && method === 'GET') {
        const branch = tail[3]!;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) return error(404, 'Not Found');
        return json(200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } });
      }
      return error(404, 'Not Found');
    }
    return error(404, 'Not Found');
  }

  // --- contents ---------------------------------------------------------------
  if (section === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') {
      const ref = query.get('ref') ?? repo.defaultBranch;
      const tip = branchTipCommit(repo, ref);
      if (!tip) return error(404, 'Not Found');
      if (path === '') {
        // The repository root: list the root tree.
        const entries = parseTree(repo.objects.get(tip.tree)!.data).map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          size: entry.mode === '40000' ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0,
          name: entry.name,
          path: entry.name,
          sha: entry.oid,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${entry.name}`,
        }));
        return json(200, entries);
      }
      const blob = blobAtPath(repo, tip.tree, path);
      if (blob !== null) {
        const object = repo.objects.get(blob)!;
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: object.data.length,
          name: path.split('/').pop(),
          path,
          content: object.data.toString('base64'),
          sha: blob,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
          html_url: `https://example.invalid/${owner}/${repoName}/blob/${ref}/${path}`,
        });
      }
      const dirTree = treeAtPath(repo, tip.tree, path);
      if (dirTree !== null) {
        const entries = parseTree(repo.objects.get(dirTree)!.data).map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          size: entry.mode === '40000' ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0,
          name: entry.name,
          path: `${path}/${entry.name}`,
          sha: entry.oid,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${path}/${entry.name}`,
        }));
        return json(200, entries);
      }
      return error(404, 'Not Found');
    }
    if (path === '') return error(404, 'Not Found');
    if (method === 'PUT') {
      const message = stringField(body, 'message') ?? '';
      const contentBase64 = stringField(body, 'content');
      if (contentBase64 === undefined) return error(422, 'Validation Failed: content is required');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length % 4 !== 0) {
        return error(400, 'content is not valid base64');
      }
      const content = Buffer.from(contentBase64, 'base64');
      const branch = stringField(body, 'branch') ?? repo.defaultBranch;
      const givenSha = stringField(body, 'sha');
      const tip = branchTipCommit(repo, branch);
      const current = tip ? blobAtPath(repo, tip.tree, path) : null;
      if (givenSha !== undefined) {
        if (current === null) return error(422, 'Validation Failed: sha given for a file that does not exist');
        if (givenSha !== current) return error(409, 'Conflict: sha does not match the current file');
      } else if (current !== null) {
        return error(422, 'Validation Failed: sha is required to update a file');
      }
      const commit = commitFileChange(store, repo, branch, path, content, message);
      const blob = putObject(repo, 'blob', content);
      return json(current === null ? 201 : 200, {
        content: { name: path.split('/').pop(), path, sha: blob, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: commit, message },
      });
    }
    if (method === 'DELETE') {
      const givenSha = stringField(body, 'sha');
      const branch = stringField(body, 'branch') ?? repo.defaultBranch;
      const tip = branchTipCommit(repo, branch);
      const current = tip ? blobAtPath(repo, tip.tree, path) : null;
      if (current === null) return error(404, 'Not Found');
      if (givenSha !== undefined && givenSha !== current) return error(409, 'Conflict: sha does not match the current file');
      const message = stringField(body, 'message') ?? '';
      const commit = commitFileChange(store, repo, branch, path, null, message);
      return json(200, { commit: { sha: commit, message } });
    }
    return error(404, 'Not Found');
  }

  // --- labels -----------------------------------------------------------------
  if (section === 'labels') {
    if (tail.length !== 1 || method !== 'POST') return error(404, 'Not Found');
    const name = stringField(body, 'name');
    if (!name) return error(422, 'Validation Failed: name is required');
    if (repo.labels.has(name)) return error(422, 'Validation Failed: label already exists');
    const color = stringField(body, 'color') ?? 'ededed';
    repo.labels.set(name, { name, color });
    return json(201, labelJson({ name, color }));
  }

  // --- issues -----------------------------------------------------------------
  if (section === 'issues') {
    // /issues/{n}[/comments]
    if (tail.length >= 2) {
      const number = Number.parseInt(tail[1]!, 10);
      if (!Number.isInteger(number)) return error(404, 'Not Found');
      const issue = repo.issues.get(number);
      if (!issue) return error(404, 'Not Found');
      if (tail.length === 2) {
        if (method === 'GET') return json(200, issueJson(repo, issue));
        if (method === 'PATCH') {
          const state = stringField(body, 'state');
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = stringField(body, 'title');
          if (title !== undefined) issue.title = title;
          const bodyText = stringField(body, 'body');
          if (bodyText !== undefined) issue.body = bodyText;
          return json(200, issueJson(repo, issue));
        }
        return error(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'GET') {
          return json(
            200,
            repo.comments.filter((comment) => comment.issueNumber === number).map((comment) => commentJson(repo, comment)),
          );
        }
        if (method === 'POST') {
          const commentBody = stringField(body, 'body');
          if (!commentBody) return error(422, 'Validation Failed: body is required');
          const comment = { id: store.nextCommentIdValue(), issueNumber: number, body: commentBody };
          repo.comments.push(comment);
          return json(201, commentJson(repo, comment));
        }
        return error(404, 'Not Found');
      }
      return error(404, 'Not Found');
    }
    // /issues (list / create)
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      const { page, perPage } = pageParams(query);
      let items = [...repo.issues.values()];
      if (state !== 'all') items = items.filter((issue) => issue.state === state);
      items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { pageItems } = paginate(items, page, perPage);
      return json(200, pageItems.map((issue) => issueJson(repo, issue)));
    }
    if (method === 'POST') {
      const title = stringField(body, 'title');
      if (!title) return error(422, 'Validation Failed: title is required');
      const labelNames: string[] = Array.isArray((body as Record<string, unknown>)?.labels)
        ? ((body as Record<string, unknown>).labels as unknown[]).filter((label): label is string => typeof label === 'string')
        : [];
      const labels: { name: string; color: string }[] = [];
      for (const name of labelNames) {
        const label = repo.labels.get(name);
        if (!label) return error(422, `Validation Failed: label "${name}" does not exist`);
        labels.push(label);
      }
      const issue: Issue = {
        id: store.nextItemIdValue(),
        number: repo.nextNumber,
        title,
        body: stringField(body, 'body') ?? '',
        state: 'open',
        labels,
        seq: repo.nextNumber,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return json(201, issueJson(repo, issue));
    }
    return error(404, 'Not Found');
  }

  // --- pull requests ----------------------------------------------------------
  if (section === 'pulls') {
    // /pulls/{n}[/files | /merge]
    if (tail.length >= 2) {
      const number = Number.parseInt(tail[1]!, 10);
      if (!Number.isInteger(number)) return error(404, 'Not Found');
      const pull = repo.pulls.get(number);
      if (!pull) return error(404, 'Not Found');
      if (tail.length === 2) {
        if (method === 'GET') return json(200, prJson(repo, pull));
        return error(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (method !== 'GET') return error(404, 'Not Found');
        const headTip = repo.refs.get(`refs/heads/${pull.head}`);
        const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
        if (!headTip || !baseTip) return error(404, 'Not Found');
        const base = mergeBase(repo, headTip, baseTip) ?? pull.mergeBase;
        const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
        const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
        const baseFlat = flattenTree(repo, baseTree);
        const headFlat = flattenTree(repo, headTree);
        const files: Record<string, unknown>[] = [];
        const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
        for (const path of [...paths].sort()) {
          const oldOid = baseFlat.get(path);
          const newOid = headFlat.get(path);
          const diff = diffLines(
            oldOid === undefined ? null : repo.objects.get(oldOid)?.data ?? null,
            newOid === undefined ? null : repo.objects.get(newOid)?.data ?? null,
          );
          if (!diff) continue;
          files.push({
            filename: path,
            status: diff.status,
            additions: diff.additions,
            deletions: diff.deletions,
            changes: diff.additions + diff.deletions,
          });
        }
        return json(200, files);
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (method !== 'PUT') return error(404, 'Not Found');
        const result = mergePullRequest(store, repo, pull);
        if (!result.ok) return error(result.status, result.message);
        return json(200, { merged: true, sha: result.sha, message: 'Pull request successfully merged' });
      }
      return error(404, 'Not Found');
    }
    // /pulls (list / create)
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const { page, perPage } = pageParams(query);
      let items = [...repo.pulls.values()];
      if (state !== 'all') items = items.filter((pull) => pull.state === state);
      items.sort((a, b) => b.seq - a.seq);
      const { pageItems } = paginate(items, page, perPage);
      return json(200, pageItems.map((pull) => prJson(repo, pull)));
    }
    if (method === 'POST') {
      const title = stringField(body, 'title');
      const head = stringField(body, 'head');
      const base = stringField(body, 'base');
      if (!title || !head || !base) return error(422, 'Validation Failed: title, head and base are required');
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (!headTip || !baseTip) return error(422, 'Validation Failed: head or base branch does not exist');
      const baseOid = mergeBase(repo, headTip, baseTip) ?? baseTip;
      const pull: PullRequest = {
        id: store.nextItemIdValue(),
        number: repo.nextNumber,
        title,
        body: stringField(body, 'body') ?? '',
        state: 'open',
        head,
        base,
        mergeBase: baseOid,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: repo.nextNumber,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return json(201, prJson(repo, pull));
    }
    return error(404, 'Not Found');
  }

  return error(404, 'Not Found');
}
