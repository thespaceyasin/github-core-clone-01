// The HTTP server: routing, Bearer authentication and body handling around the three
// surfaces (REST v3, GraphQL, MCP) and git smart HTTP. The entry lifecycle (bind, register,
// wait for done) lives in main.ts, which imports createApp from here.
//
// Authentication: the token is MAKEFUN_SHOP_TOKEN. Every surface except /healthz requires
// `Authorization: Bearer <token>`; a missing or wrong token is a 401 JSON answer. When the
// variable is not set at all (local development only — the trial always sets it) the check
// is skipped so the server can be smoke-tested by hand.
//
// Every response carries a non-empty X-GitHub-Request-Id. Malformed JSON bodies are a 400,
// never a crash; any unexpected error is a 500 JSON answer and the server stays up.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphQL } from './graphql.ts';
import { handleGit } from './git.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
if (SHOP_TOKEN === '') {
  process.stderr.write('[entry] MAKEFUN_SHOP_TOKEN is not set: authentication is disabled (local dev mode)\n');
}

const store = new Store();
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer | string, contentType: string, extraHeaders: Record<string, string> = {}): void {
  const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': data.length,
    'X-GitHub-Request-Id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(data);
}

/** True when the request carries the shop token (or when no token is configured). */
function authorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  return header === `Bearer ${SHOP_TOKEN}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        res.destroy();
      }
    });
  });
  // The conformance suite issues thousands of sequential requests on one keep-alive
  // connection (the read workload is 2,000 GETs on a single connection). Node's default
  // 5 s keep-alive timeout would drop an idle connection mid-workload and force a
  // reconnect, so hold idle connections much longer than any gap between requests.
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;

  // Health: the only unauthenticated route.
  if (pathname === '/healthz') {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  const segments = pathname.split('/').filter((part) => part !== '').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });

  // MCP: POST /mcp, raw body (its own parse-error handling applies).
  if (pathname === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    const answer = handleMcp(body.toString('utf8'), store);
    if (answer.body === undefined) {
      res.writeHead(answer.status, { 'X-GitHub-Request-Id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.body);
    return;
  }

  // GraphQL: POST /api/graphql.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
      return;
    }
    const result = executeGraphQL(parsed, store);
    sendJson(res, 200, result);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) headers[key] = value;
    const answer = handleGit({ method, segments, query: url.searchParams, body, headers }, store);
    if (answer === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (typeof answer.body === 'string') {
      sendBytes(res, answer.status, answer.body, answer.headers?.['Content-Type'] ?? 'application/json', answer.headers);
      return;
    }
    sendBytes(res, answer.status, answer.body, answer.headers?.['Content-Type'] ?? 'application/octet-stream', answer.headers);
    return;
  }

  // REST v3: /api/v3/...
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    let parsed: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const body = await readBody(req);
      if (body.length > 0) {
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Request body is not valid JSON' });
          return;
        }
      }
    }
    const answer = handleRest({ method, segments, query: url.searchParams, body: parsed, baseUrl }, store);
    if (answer.status === 204) {
      res.writeHead(204, { 'X-GitHub-Request-Id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.body, answer.headers);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
