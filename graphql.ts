// The GraphQL surface (POST /api/graphql): a small hand-written parser and executor for
// the document shapes the suite actually sends — named queries and mutations, variables,
// aliases, inline fragments, __type introspection, connections with cursor pagination.
// It is deliberately not a general GraphQL implementation: unknown fields on a type are
// reported as errors (HTTP 200 with an `errors` array naming the field), which is the
// behaviour the suite's invalid-field check verifies.

import {
  flattenTree,
  globalId,
  mergeBase as mergeBaseOf,
  parseCommit,
  parseGlobalId,
  threeWayMerge,
  VIEWER_ID,
  VIEWER_LOGIN,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { mergePullRequest } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct';
  value: string;
}

const PUNCT = new Set(['{', '}', '(', ')', ':', '!', '$', '=', '[', ']', '@', '&', '|', '.', ',']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      // A block string (""") or a plain string.
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        const text = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text.replace(/\\"""/g, '"""') });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escaped = source[j + 1]!;
          out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser (AST)
// ---------------------------------------------------------------------------------------------

export interface Argument {
  name: string;
  value: ValueNode;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Argument[] };

export interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  arguments: Argument[];
  selectionSet?: SelectionNode[];
}

export interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition?: string;
  selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface VariableDefinition {
  name: string;
  defaultValue?: ValueNode;
}

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: VariableDefinition[];
  selectionSet: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

export type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new Error('Unexpected end of document');
    this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected ${JSON.stringify(value)} but got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected a name but got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new Error(`Expected ${JSON.stringify(value)} but got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek() !== undefined) definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek()!;
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', variableDefinitions: [], selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | undefined;
      if (this.peek()?.kind === 'name') name = this.next().value;
      const variableDefinitions = this.atPunct('(') ? this.parseVariableDefinitions() : [];
      const selectionSet = this.parseSelectionSet();
      return { kind: 'operation', operation, name, variableDefinitions, selectionSet };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`Unexpected token ${JSON.stringify(token.value)} at the start of a definition`);
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    const definitions: VariableDefinition[] = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.atPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      definitions.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return definitions;
  }

  /** A type reference: Named, [Named], Named!, [Named!]! and so on — consumed, not kept. */
  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.atPunct('...')) {
      this.next();
      const token = this.peek()!;
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      return { kind: 'inline', selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.atPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.atPunct('(') ? this.parseArguments() : [];
    // Directives (@name or @name(...)) are accepted and ignored.
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) this.parseArguments();
    }
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : undefined;
    return { kind: 'field', alias, name, arguments: args, selectionSet };
  }

  private parseArguments(): Argument[] {
    const args: Argument[] = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Argument[] = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value token ${JSON.stringify(token.value)}`);
  }
}

export function parseGraphQL(source: string): DefinitionNode[] {
  return new Parser(lex(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

class UnknownFieldError extends Error {
  readonly typeName: string;
  readonly fieldName: string;

  constructor(typeName: string, fieldName: string) {
    super(`Cannot query field "${fieldName}" on type "${typeName}".`);
    this.typeName = typeName;
    this.fieldName = fieldName;
  }
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

/** A resolved GraphQL object: its type name plus a field reader that may throw UnknownFieldError. */
interface GqlNode {
  __typename: string;
  getField(name: string, args: Record<string, unknown>): unknown;
}

function isGqlNode(value: unknown): value is GqlNode {
  return typeof value === 'object' && value !== null && typeof (value as GqlNode).__typename === 'string' && typeof (value as GqlNode).getField === 'function';
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => resolveValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArguments(args: Argument[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

/**
 * Resolve one field's value against its sub-selections. Returns the JSON value and whether
 * an error occurred below it (which, per GraphQL's null propagation, nulls this field).
 */
function resolveFieldValue(
  value: unknown,
  field: FieldNode,
  ctx: ExecContext,
): { value: unknown; hasError: boolean } {
  if (value === null || value === undefined) return { value: null, hasError: false };
  if (!field.selectionSet) {
    if (isGqlNode(value) || Array.isArray(value)) {
      ctx.errors.push({ message: `Field "${field.name}" does not return a scalar value.` });
      return { value: null, hasError: true };
    }
    return { value, hasError: false };
  }
  if (isGqlNode(value)) {
    const resolved = resolveSelectionSet(value, field.selectionSet, ctx);
    return resolved.hasError ? { value: null, hasError: true } : { value: resolved.data, hasError: false };
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    let hasError = false;
    for (const item of value) {
      if (isGqlNode(item)) {
        const resolved = resolveSelectionSet(item, field.selectionSet, ctx);
        if (resolved.hasError) hasError = true;
        items.push(resolved.hasError ? null : resolved.data);
      } else {
        items.push(item);
      }
    }
    return { value: items, hasError };
  }
  ctx.errors.push({ message: `Field "${field.name}" does not return an object value.` });
  return { value: null, hasError: true };
}

function resolveSelectionSet(
  node: GqlNode,
  selections: SelectionNode[],
  ctx: ExecContext,
): { data: Record<string, unknown>; hasError: boolean } {
  const data: Record<string, unknown> = {};
  let hasError = false;
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        hasError = true;
        continue;
      }
      if (fragment.typeCondition !== node.__typename) continue;
      const resolved = resolveSelectionSet(node, fragment.selectionSet, ctx);
      Object.assign(data, resolved.data);
      if (resolved.hasError) hasError = true;
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== node.__typename) continue;
      const resolved = resolveSelectionSet(node, selection.selectionSet, ctx);
      Object.assign(data, resolved.data);
      if (resolved.hasError) hasError = true;
      continue;
    }
    const field = selection;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      data[key] = node.__typename;
      continue;
    }
    const args = resolveArguments(field.arguments, ctx.variables);
    let raw: unknown;
    try {
      raw = node.getField(field.name, args);
    } catch (err) {
      if (err instanceof UnknownFieldError) {
        ctx.errors.push({ message: err.message });
        data[key] = null;
        hasError = true;
        continue;
      }
      throw err;
    }
    const resolved = resolveFieldValue(raw, field, ctx);
    data[key] = resolved.value;
    if (resolved.hasError) hasError = true;
  }
  return { data, hasError };
}

// ---------------------------------------------------------------------------------------------
// cursors and connections
// ---------------------------------------------------------------------------------------------

function cursorOf(kind: string, seq: number): string {
  return Buffer.from(`${kind}:${seq}`, 'utf8').toString('base64url');
}

function seqOfCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const [, seq] = text.split(':');
    const value = Number.parseInt(seq ?? '', 10);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

interface ConnectionEntry {
  seq: number;
  kind: string;
  node: GqlNode;
}

/** Slice entries by `first`/`after` and wrap them in a connection node. */
function connectionNode(entries: ConnectionEntry[], args: Record<string, unknown>, typename: string): GqlNode {
  const first = typeof args.first === 'number' ? args.first : entries.length;
  const after = typeof args.after === 'string' ? args.after : null;
  let start = 0;
  if (after !== null) {
    const seq = seqOfCursor(after);
    if (seq !== null) {
      const index = entries.findIndex((entry) => entry.seq === seq);
      if (index >= 0) start = index + 1;
    }
  }
  const page = entries.slice(start, start + Math.max(0, first));
  const hasNextPage = start + page.length < entries.length;
  const endCursor = page.length > 0 ? cursorOf(page[page.length - 1]!.kind, page[page.length - 1]!.seq) : null;
  return {
    __typename: typename,
    getField(name) {
      if (name === 'nodes') return page.map((entry) => entry.node);
      if (name === 'edges') return page.map((entry) => edgeNode(entry));
      if (name === 'totalCount') return entries.length;
      if (name === 'pageInfo') {
        return {
          __typename: 'PageInfo',
          getField(fieldName) {
            if (fieldName === 'hasNextPage') return hasNextPage;
            if (fieldName === 'endCursor') return endCursor;
            if (fieldName === 'hasPreviousPage') return start > 0;
            if (fieldName === 'startCursor') return page.length > 0 ? cursorOf(page[0]!.kind, page[0]!.seq) : null;
            throw new UnknownFieldError('PageInfo', fieldName);
          },
        } satisfies GqlNode;
      }
      throw new UnknownFieldError(typename, name);
    },
  };
}

function edgeNode(entry: ConnectionEntry): GqlNode {
  return {
    __typename: 'Edge',
    getField(name) {
      if (name === 'node') return entry.node;
      if (name === 'cursor') return cursorOf(entry.kind, entry.seq);
      throw new UnknownFieldError('Edge', name);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// type nodes (Repository, Issue, PullRequest, User, __Type)
// ---------------------------------------------------------------------------------------------

function ownerNode(login: string): GqlNode {
  return {
    __typename: 'User',
    getField(name) {
      if (name === 'login') return login;
      if (name === 'id') return globalId('User', login);
      throw new UnknownFieldError('User', name);
    },
  };
}

function refNode(name: string): GqlNode {
  return {
    __typename: 'Ref',
    getField(fieldName) {
      if (fieldName === 'name') return name;
      throw new UnknownFieldError('Ref', fieldName);
    },
  };
}

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return {
    __typename: 'Issue',
    getField(name) {
      switch (name) {
        case 'id':
          return globalId('Issue', repo.id, issue.number);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return issue.body;
        default:
          throw new UnknownFieldError('Issue', name);
      }
    },
  };
}

function commentNode(repo: Repo, comment: { id: number; issueNumber: number; body: string }): GqlNode {
  return {
    __typename: 'IssueComment',
    getField(name) {
      if (name === 'id') return globalId('IssueComment', repo.id, comment.issueNumber, comment.id);
      if (name === 'databaseId') return comment.id;
      if (name === 'body') return comment.body;
      throw new UnknownFieldError('IssueComment', name);
    },
  };
}

/**
 * A pull request's mergeability as GitHub's GraphQL reports it: the MergeableState enum,
 * not a boolean. MERGEABLE when the head merges cleanly into the base, CONFLICTING when
 * the three-way merge conflicts, UNKNOWN when the branches cannot be read.
 */
function mergeableOf(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const base = mergeBaseOf(repo, headTip, baseTip);
  if (base === null) return 'UNKNOWN';
  const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const tipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  return threeWayMerge(flattenTree(repo, baseTree), flattenTree(repo, headTree), flattenTree(repo, tipTree)).conflict
    ? 'CONFLICTING'
    : 'MERGEABLE';
}

function pullRequestNode(repo: Repo, pull: PullRequest): GqlNode {
  return {
    __typename: 'PullRequest',
    getField(name, args) {
      switch (name) {
        case 'id':
          return globalId('PullRequest', repo.id, pull.number);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'mergeable':
          return mergeableOf(repo, pull);
        case 'merged':
          return pull.merged;
        case 'files': {
          const headTip = repo.refs.get(`refs/heads/${pull.head}`);
          const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
          if (!headTip || !baseTip) return connectionNode([], args, 'PullRequestFileConnection');
          const base = mergeBaseOf(repo, headTip, baseTip) ?? pull.mergeBase;
          const baseFlat = flattenTree(repo, parseCommit(repo.objects.get(base)!.data).tree);
          const headFlat = flattenTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
          const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
          const entries: ConnectionEntry[] = [];
          let seq = 0;
          for (const path of [...paths].sort()) {
            if (baseFlat.get(path) === headFlat.get(path)) continue;
            seq += 1;
            entries.push({
              seq,
              kind: 'file',
              node: {
                __typename: 'PullRequestFile',
                getField(fieldName) {
                  if (fieldName === 'path') return path;
                  throw new UnknownFieldError('PullRequestFile', fieldName);
                },
              },
            });
          }
          return connectionNode(entries, args, 'PullRequestFileConnection');
        }
        default:
          throw new UnknownFieldError('PullRequest', name);
      }
    },
  };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  let items = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    items = items.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : 'DESC';
  items.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  const entries: ConnectionEntry[] = items.map((issue) => ({ seq: issue.seq, kind: 'issue', node: issueNode(repo, issue) }));
  return connectionNode(entries, args, 'IssueConnection');
}

function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  const items = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
  const entries: ConnectionEntry[] = items.map((pull) => ({ seq: pull.seq, kind: 'pull', node: pullRequestNode(repo, pull) }));
  return connectionNode(entries, args, 'PullRequestConnection');
}

function repositoryNode(repo: Repo): GqlNode {
  return {
    __typename: 'Repository',
    getField(name, args) {
      switch (name) {
        case 'id':
          return globalId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return ownerNode(repo.owner);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip ? refNode(repo.defaultBranch) : null;
        }
        case 'viewerPermission':
          return 'WRITE';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = args.number as number | undefined;
          if (typeof number !== 'number') return null;
          const issue = repo.issues.get(number);
          return issue ? issueNode(repo, issue) : null;
        }
        case 'issues':
          return issuesConnection(repo, args);
        case 'pullRequest': {
          const number = args.number as number | undefined;
          if (typeof number !== 'number') return null;
          const pull = repo.pulls.get(number);
          return pull ? pullRequestNode(repo, pull) : null;
        }
        case 'pullRequests':
          return pullRequestsConnection(repo, args);
        default:
          throw new UnknownFieldError('Repository', name);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// introspection (__type)
// ---------------------------------------------------------------------------------------------

const TYPE_INFO: Readonly<Record<string, { kind: string; fields: readonly string[]; enumValues?: readonly string[] }>> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'databaseId', 'url', 'author', 'createdAt', 'closedAt', 'comments', 'labels'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'databaseId', 'url', 'headRef', 'baseRef'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  },
};

function typeNode(name: string): GqlNode | null {
  const info = TYPE_INFO[name];
  if (!info) return null;
  return {
    __typename: '__Type',
    getField(fieldName) {
      switch (fieldName) {
        case 'name':
          return name;
        case 'kind':
          return info.kind;
        case 'fields':
          return info.fields.map((fieldName) => ({
            __typename: '__Field',
            getField(subName) {
              if (subName === 'name') return fieldName;
              if (subName === 'type') {
                return {
                  __typename: '__Type',
                  getField(typeField) {
                    if (typeField === 'name') return 'String';
                    if (typeField === 'kind') return 'SCALAR';
                    throw new UnknownFieldError('__Type', typeField);
                  },
                } satisfies GqlNode;
              }
              throw new UnknownFieldError('__Field', subName);
            },
          }));
        case 'enumValues':
          return (info.enumValues ?? []).map((value) => ({
            __typename: '__EnumValue',
            getField(subName) {
              if (subName === 'name') return value;
              throw new UnknownFieldError('__EnumValue', subName);
            },
          }));
        default:
          throw new UnknownFieldError('__Type', fieldName);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// root resolvers and mutations
// ---------------------------------------------------------------------------------------------

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function nodeByGlobalId(store: Store, id: string): GqlNode | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  const [first, second] = parsed.parts;
  if (parsed.kind === 'Repository') {
    const repo = findRepoById(store, Number.parseInt(first ?? '', 10));
    return repo ? repositoryNode(repo) : null;
  }
  if (parsed.kind === 'Issue') {
    const repo = findRepoById(store, Number.parseInt(first ?? '', 10));
    const issue = repo?.issues.get(Number.parseInt(second ?? '', 10));
    return repo && issue ? issueNode(repo, issue) : null;
  }
  if (parsed.kind === 'PullRequest') {
    const repo = findRepoById(store, Number.parseInt(first ?? '', 10));
    const pull = repo?.pulls.get(Number.parseInt(second ?? '', 10));
    return repo && pull ? pullRequestNode(repo, pull) : null;
  }
  if (parsed.kind === 'IssueComment') {
    const repo = findRepoById(store, Number.parseInt(first ?? '', 10));
    const comment = repo?.comments.find((candidate) => candidate.issueNumber === Number.parseInt(second ?? '', 10));
    return repo && comment ? commentNode(repo, comment) : null;
  }
  return null;
}

function queryRoot(store: Store): GqlNode {
  return {
    __typename: 'Query',
    getField(name, args) {
      switch (name) {
        case 'viewer':
          return {
            __typename: 'User',
            getField(fieldName) {
              if (fieldName === 'login') return VIEWER_LOGIN;
              if (fieldName === 'id') return globalId('User', VIEWER_ID);
              throw new UnknownFieldError('User', fieldName);
            },
          } satisfies GqlNode;
        case 'repository': {
          const owner = args.owner as string | undefined;
          const repoName = args.name as string | undefined;
          if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
          const repo = store.getRepo(owner, repoName);
          return repo ? repositoryNode(repo) : null;
        }
        case 'node': {
          const id = args.id as string | undefined;
          if (typeof id !== 'string') return null;
          return nodeByGlobalId(store, id);
        }
        case '__type': {
          const typeName = args.name as string | undefined;
          if (typeof typeName !== 'string') return null;
          return typeNode(typeName);
        }
        case '__schema':
          return {
            __typename: '__Schema',
            getField(fieldName) {
              if (fieldName === 'queryType') return typeNode('Query');
              if (fieldName === 'mutationType') return typeNode('Mutation');
              throw new UnknownFieldError('__Schema', fieldName);
            },
          } satisfies GqlNode;
        default:
          throw new UnknownFieldError('Query', name);
      }
    },
  };
}

function payloadNode(typename: string, fields: Record<string, unknown>): GqlNode {
  return {
    __typename: typename,
    getField(name) {
      if (name in fields) return fields[name];
      throw new UnknownFieldError(typename, name);
    },
  };
}

function mutationRoot(store: Store): GqlNode {
  return {
    __typename: 'Mutation',
    getField(name, args) {
      const input = (args.input ?? {}) as Record<string, unknown>;
      switch (name) {
        case 'createIssue': {
          const decoded = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
          const target = decoded?.kind === 'Repository' ? findRepoById(store, Number.parseInt(decoded.parts[0] ?? '', 10)) : undefined;
          if (!target) throw new Error('createIssue: repository not found');
          const title = typeof input.title === 'string' ? input.title : '';
          const issue: Issue = {
            id: store.nextItemIdValue(),
            number: target.nextNumber,
            title,
            body: typeof input.body === 'string' ? input.body : '',
            state: 'open',
            labels: [],
            seq: target.nextNumber,
          };
          target.nextNumber += 1;
          target.issues.set(issue.number, issue);
          return payloadNode('CreateIssuePayload', { issue: issueNode(target, issue) });
        }
        case 'closeIssue': {
          const decoded = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
          const repo = decoded?.kind === 'Issue' ? findRepoById(store, Number.parseInt(decoded.parts[0] ?? '', 10)) : undefined;
          const issue = repo?.issues.get(Number.parseInt(decoded?.parts[1] ?? '', 10));
          if (!repo || !issue) throw new Error('closeIssue: issue not found');
          issue.state = 'closed';
          return payloadNode('CloseIssuePayload', { issue: issueNode(repo, issue) });
        }
        case 'createPullRequest': {
          const decoded = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
          const repo = decoded?.kind === 'Repository' ? findRepoById(store, Number.parseInt(decoded.parts[0] ?? '', 10)) : undefined;
          if (!repo) throw new Error('createPullRequest: repository not found');
          const head = typeof input.headRefName === 'string' ? input.headRefName : '';
          const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
          const headTip = repo.refs.get(`refs/heads/${head}`);
          const baseTip = repo.refs.get(`refs/heads/${base}`);
          if (!headTip || !baseTip) throw new Error('createPullRequest: head or base branch does not exist');
          const baseOid = mergeBaseOf(repo, headTip, baseTip) ?? baseTip;
          const pull: PullRequest = {
            id: store.nextItemIdValue(),
            number: repo.nextNumber,
            title: typeof input.title === 'string' ? input.title : '',
            body: typeof input.body === 'string' ? input.body : '',
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
          return payloadNode('CreatePullRequestPayload', { pullRequest: pullRequestNode(repo, pull) });
        }
        case 'mergePullRequest': {
          const decoded = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
          const repo = decoded?.kind === 'PullRequest' ? findRepoById(store, Number.parseInt(decoded.parts[0] ?? '', 10)) : undefined;
          const pull = repo?.pulls.get(Number.parseInt(decoded?.parts[1] ?? '', 10));
          if (!repo || !pull) throw new Error('mergePullRequest: pull request not found');
          const result = mergePullRequest(store, repo, pull);
          if (!result.ok) throw new Error(`mergePullRequest: ${result.message}`);
          return payloadNode('MergePullRequestPayload', { pullRequest: pullRequestNode(repo, pull) });
        }
        case 'addComment': {
          const decoded = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
          const repo = decoded?.kind === 'Issue' ? findRepoById(store, Number.parseInt(decoded.parts[0] ?? '', 10)) : undefined;
          const number = Number.parseInt(decoded?.parts[1] ?? '', 10);
          if (!repo || !Number.isInteger(number)) throw new Error('addComment: subject not found');
          const comment = { id: store.nextCommentIdValue(), issueNumber: number, body: typeof input.body === 'string' ? input.body : '' };
          repo.comments.push(comment);
          return payloadNode('AddCommentPayload', {
            commentEdge: {
              __typename: 'IssueCommentEdge',
              getField(fieldName) {
                if (fieldName === 'node') return commentNode(repo, comment);
                if (fieldName === 'cursor') return cursorOf('comment', comment.id);
                throw new UnknownFieldError('IssueCommentEdge', fieldName);
              },
            } satisfies GqlNode,
          });
        }
        default:
          throw new UnknownFieldError('Mutation', name);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function executeOperation(operation: OperationNode, fragments: Map<string, FragmentNode>, store: Store, variables: Record<string, unknown>): GraphQLResult {
  const ctx: ExecContext = { store, variables, fragments, errors: [] };
  const root = operation.operation === 'mutation' ? mutationRoot(store) : queryRoot(store);
  try {
    const resolved = resolveSelectionSet(root, operation.selectionSet, ctx);
    const result: GraphQLResult = { data: resolved.data };
    if (ctx.errors.length > 0) result.errors = ctx.errors;
    return result;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Internal error' }] };
  }
}

/**
 * Execute one GraphQL request body (a single operation, or an array of them for a batch).
 * Returns the response object (or array) to JSON-encode.
 */
export function executeGraphQL(body: unknown, store: Store): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((item) => executeGraphQL(item, store) as GraphQLResult);
  }
  if (typeof body !== 'object' || body === null) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object.' }] };
  }
  const request = body as Record<string, unknown>;
  const query = request.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'query is required' }] };
  }
  let definitions: DefinitionNode[];
  try {
    definitions = parseGraphQL(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation found in document.' }] };
  }
  const operationName = typeof request.operationName === 'string' ? request.operationName : undefined;
  const operation = operationName
    ? operations.find((candidate) => candidate.name === operationName) ?? operations[0]!
    : operations[0]!;
  const variables = (request.variables ?? {}) as Record<string, unknown>;
  // Apply variable defaults from the operation's own definitions.
  const merged: Record<string, unknown> = { ...variables };
  for (const definition of operation.variableDefinitions) {
    if (merged[definition.name] === undefined && definition.defaultValue !== undefined) {
      merged[definition.name] = resolveValue(definition.defaultValue, merged);
    }
  }
  return executeOperation(operation, fragments, store, merged);
}
