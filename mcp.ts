// The MCP surface (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
// via `server/discover`, with the pre-discover `initialize` handshake as a fallback.
// The tools act on the same in-memory store as REST, so a repository or issue created
// over MCP reads back over REST and vice versa.
//
// The tools list is a module-level constant: the suite requires it to be byte-identical
// across calls, and a constant array serialized the same way every time satisfies that.

import { issueJson, mergePullRequest, prJson, repoJson } from './rest.ts';
import {
  VIEWER_LOGIN,
  mergeBase,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_REVISION = '2026-07-28';

export interface McpResponse {
  /** HTTP status. */
  status: number;
  /** JSON body to send (undefined = no body, e.g. a notification's 202). */
  body?: unknown;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): McpResponse {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error } };
}

// ---------------------------------------------------------------------------------------------
// the tool catalogue (fixed; only the properties the suite can fill are required)
// ---------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------------------------
// argument lookup: canonical names first, common synonyms as a fallback, and a
// `full_name` of "owner/repo" when the caller supplies the pair that way
// ---------------------------------------------------------------------------------------------

const ARG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'user', 'login'],
  repo: ['repo', 'repository', 'name'],
  pull_number: ['pull_number', 'pullNumber', 'number', 'pr_number'],
};

function pickArg(args: Record<string, unknown>, field: string): unknown {
  for (const alias of ARG_ALIASES[field] ?? [field]) {
    const value = args[alias];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function splitFullName(args: Record<string, unknown>): { owner?: string; repo?: string } {
  const full = args.full_name ?? args.fullName;
  if (typeof full !== 'string') return {};
  const slash = full.indexOf('/');
  if (slash <= 0 || slash === full.length - 1) return {};
  return { owner: full.slice(0, slash), repo: full.slice(slash + 1) };
}

function stringArg(args: Record<string, unknown>, field: string): string | undefined {
  const value = pickArg(args, field);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function intArg(args: Record<string, unknown>, field: string): number | undefined {
  const value = pickArg(args, field);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

function boolArg(args: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = pickArg(args, field);
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------------------------
// tool implementations
// ---------------------------------------------------------------------------------------------

interface ToolOutcome {
  /** The object the checks read first (structuredContent) and the text carries as JSON. */
  payload: Record<string, unknown>;
  isError?: boolean;
}

function toolError(message: string): ToolOutcome {
  return { payload: { error: message }, isError: true };
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | { error: string } {
  const split = splitFullName(args);
  const owner = stringArg(args, 'owner') ?? split.owner;
  const repo = stringArg(args, 'repo') ?? split.repo;
  if (!owner || !repo) return { error: 'owner and repo are required' };
  const found = store.getRepo(owner, repo);
  if (!found) return { error: `Repository ${owner}/${repo} not found` };
  return found;
}

function callCreateRepo(store: Store, args: Record<string, unknown>): ToolOutcome {
  const name = stringArg(args, 'name');
  if (!name) return toolError('name is required');
  if (store.getRepo(VIEWER_LOGIN, name)) return toolError(`Repository ${VIEWER_LOGIN}/${name} already exists`);
  const description = stringArg(args, 'description') ?? '';
  const isPrivate = boolArg(args, 'private', false);
  const repo = store.createRepo(VIEWER_LOGIN, name, isPrivate, description);
  return { payload: repoJson(repo) };
}

function callGetRepo(store: Store, args: Record<string, unknown>): ToolOutcome {
  const repo = resolveRepo(store, args);
  if ('error' in repo) return toolError(repo.error);
  return { payload: repoJson(repo) };
}

function callCreateIssue(store: Store, args: Record<string, unknown>): ToolOutcome {
  const repo = resolveRepo(store, args);
  if ('error' in repo) return toolError(repo.error);
  const title = stringArg(args, 'title');
  if (!title) return toolError('title is required');
  const body = stringArg(args, 'body') ?? '';
  const issue: Issue = {
    id: store.nextItemIdValue(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [],
    seq: repo.nextNumber,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return { payload: issueJson(repo, issue) };
}

function callListIssues(store: Store, args: Record<string, unknown>): ToolOutcome {
  const repo = resolveRepo(store, args);
  if ('error' in repo) return toolError(repo.error);
  const state = stringArg(args, 'state') ?? 'open';
  let items = [...repo.issues.values()];
  if (state !== 'all') items = items.filter((issue) => issue.state === state);
  items.sort((a, b) => b.seq - a.seq);
  const payload = { issues: items.map((issue) => issueJson(repo, issue)) };
  return { payload };
}

function callCreatePullRequest(store: Store, args: Record<string, unknown>): ToolOutcome {
  const repo = resolveRepo(store, args);
  if ('error' in repo) return toolError(repo.error);
  const title = stringArg(args, 'title');
  const head = stringArg(args, 'head');
  const base = stringArg(args, 'base');
  if (!title || !head || !base) return toolError('title, head and base are required');
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (!headTip || !baseTip) return toolError('head or base branch does not exist');
  const baseOid = mergeBase(repo, headTip, baseTip) ?? baseTip;
  const pull: PullRequest = {
    id: store.nextItemIdValue(),
    number: repo.nextNumber,
    title,
    body: stringArg(args, 'body') ?? '',
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
  const payload = prJson(repo, pull);
  payload.pull_number = pull.number;
  return { payload };
}

function callMergePullRequest(store: Store, args: Record<string, unknown>): ToolOutcome {
  const repo = resolveRepo(store, args);
  if ('error' in repo) return toolError(repo.error);
  const number = intArg(args, 'pull_number');
  if (number === undefined) return toolError('pull_number is required');
  const pull = repo.pulls.get(number);
  if (!pull) return toolError(`Pull request #${number} not found`);
  const result = mergePullRequest(store, repo, pull);
  if (!result.ok) return toolError(result.message);
  return { payload: { merged: true, sha: result.sha, number: pull.number, pull_number: pull.number, message: 'Pull request successfully merged' } };
}

const TOOL_CALLS: Readonly<Record<string, (store: Store, args: Record<string, unknown>) => ToolOutcome>> = {
  create_repo: callCreateRepo,
  get_repo: callGetRepo,
  create_issue: callCreateIssue,
  list_issues: callListIssues,
  create_pull_request: callCreatePullRequest,
  merge_pull_request: callMergePullRequest,
};

// ---------------------------------------------------------------------------------------------
// JSON-RPC dispatcher
// ---------------------------------------------------------------------------------------------

/**
 * Handle one POST /mcp body. `rawBody` is the request text: when it is not JSON the
 * answer is HTTP 400 carrying JSON-RPC -32700, per the suite's protocol checks.
 */
export function handleMcp(rawBody: string, store: Store): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const request = parsed as JsonRpcRequest;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};

  // A notification (no id) gets no JSON-RPC answer: HTTP 202 with an empty body.
  if (request.id === undefined) {
    return { status: 202 };
  }

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
      return rpcResult(id, {
        resultType: 'server/discover',
        supportedVersions: [MCP_REVISION, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = requested === '' ? MCP_REVISION : requested;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOL_CALLS[name];
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = isRecord(params.arguments) ? params.arguments : {};
      // A missing required argument is a tool failure, never an HTTP 500.
      const def = TOOLS.find((candidate) => candidate.name === name)!;
      for (const required of def.inputSchema.required) {
        if (pickArg(args, required) === undefined && !(required === 'repo' && splitFullName(args).repo) && !(required === 'owner' && splitFullName(args).owner)) {
          const outcome = toolError(`Missing required argument: ${required}`);
          return rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
            structuredContent: outcome.payload,
            isError: true,
          });
        }
      }
      const outcome = tool(store, args);
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
        structuredContent: outcome.payload,
        ...(outcome.isError ? { isError: true } : {}),
      });
    }
    default: {
      return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }
}
