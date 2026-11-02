// The hub's app: open-chat's interface over the whole hub. The proxy sends
// the hub's own pages here; the module still renders the code views
// (tree, blob, raw, commits, commit, refs, activity) and the guide.
//
//   GET  /, /<space>, /<space>/<project>   the app's page (its path within a project is in the #hash)
//   GET  /-/app/<file>                     the app's script, styles and images (built from app/)
//   GET  /-/api/view?space=&project=&path= the hub, a space or a project as folders and files
//                                          (the module's /api, see module/src/workspace.ts)
//   GET  /-/api/me                         who is signed in
//   GET  /-/avatar/<name>                  a builder's, org's or agent's picture (avatar.ts)
//   POST /-/api/chat                       save chat turns as the signed-in builder (append_chat)
//   POST /-/api/collaborators              add or remove a project's collaborator as the signed-in
//                                          builder (add_project_member, remove_project_member)
//
// The browser never talks to SpacetimeDB: reads come from the module over
// HTTP, and a chat is saved with the session's own token, so the module's
// push rules decide who may write.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Conn } from './conn';
import { findUser } from './conn';
import { handleAvatar } from './avatar';

export const APP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};
// Pages the proxy sends here: the hub, a space, a project.
const PAGE = /^\/(?:([a-z0-9][a-z0-9-]*)(?:\/([A-Za-z0-9_.-]+))?)?\/?$/;
const MAX_BODY = 64 * 1024;

export interface AppDeps {
  dir: string;
  internalHttp: string;
  db: string;
  /** Run `fn` on a connection made with `token`, closed afterwards. */
  withConn: <T>(token: string, fn: (conn: Conn, identity: Parameters<typeof findUser>[1]) => Promise<T>) => Promise<T>;
  sessionOf: (req: http.IncomingMessage) => Promise<{ token: string; username: string } | null>;
}

/** Where the built app lives: SPACEHUB_APP_DIR, else app/dist beside this checkout. */
export function appDir(): string {
  if (process.env.SPACEHUB_APP_DIR) return process.env.SPACEHUB_APP_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../app/dist');
}

let version: { dir: string; hash: string } | null = null;
function versionOf(dir: string) {
  if (version?.dir === dir) return version.hash;
  const hash = crypto.createHash('sha256');
  for (const name of ['app.js', 'app.css']) {
    try {
      hash.update(fs.readFileSync(path.join(dir, name)));
    } catch {
      /* A missing build shows up as a failed script load, not a crash. */
    }
  }
  version = { dir, hash: hash.digest('hex').slice(0, 12) };
  return version.hash;
}

function esc(text: string) {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

export function appPage(dir: string, title: string) {
  const v = versionOf(dir);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="icon" href="/-/app/quirq-icon.svg"><script src="/-/app/theme.js?v=${v}"></script><link rel="stylesheet" href="/-/app/app.css?v=${v}"></head><body><div id="root"></div><script type="module" src="/-/app/app.js?v=${v}"></script></body></html>`;
}

function json(res: http.ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(JSON.stringify(value));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('This message is too long.');
  }
  return JSON.parse(body);
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The turns a browser may send; the module checks the rest. */
export function parseChat(input: unknown) {
  if (!object(input) || typeof input.space !== 'string' || typeof input.project !== 'string' || typeof input.conversation !== 'string' || !Array.isArray(input.turns)) return null;
  const turns = input.turns.map(turn => {
    if (!object(turn) || typeof turn.id !== 'string' || typeof turn.role !== 'string' || typeof turn.content !== 'string') return null;
    const links = turn.links === undefined ? [] : Array.isArray(turn.links) && turn.links.every(link => object(link) && typeof link.label === 'string' && typeof link.path === 'string') ? (turn.links as { label: string; path: string }[]).map(({ label, path }) => ({ label, path })) : null;
    return links ? { id: turn.id, role: turn.role, content: turn.content, links } : null;
  });
  if (turns.some(turn => !turn)) return null;
  return { project: `${input.space}/${input.project}`, conversation: input.conversation, turns: turns as { id: string; role: string; content: string; links: { label: string; path: string }[] }[] };
}

/** A collaborator change a browser may send; the module checks who may make it. */
export function parseCollaborator(input: unknown) {
  if (!object(input) || typeof input.space !== 'string' || typeof input.project !== 'string' || typeof input.name !== 'string') return null;
  if (input.action !== 'add' && input.action !== 'remove') return null;
  const name = input.name.trim().replace(/^@/, '').toLowerCase();
  if (!input.space || !input.project || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
  return { action: input.action as 'add' | 'remove', project: `${input.space}/${input.project}`, agent: name };
}

/** Handle the app's routes; false when the request is not one of them. */
export async function handleApp(deps: AppDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname;
  const lookup = async (name: string) => {
    const response = await fetch(`${deps.internalHttp}/v1/database/${encodeURIComponent(deps.db)}/route/api?avatar=${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`avatar lookup failed: ${response.status}`);
    return (await response.json()) as { kind: string; githubLogin: string };
  };
  if (await handleAvatar({ lookup, githubBase: process.env.SPACEHUB_GITHUB_AVATARS }, req, res, url)) return true;

  if (req.method === 'GET' && route.startsWith('/-/app/')) {
    const name = route.slice('/-/app/'.length);
    const type = TYPES[path.extname(name)];
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || !type) return false;
    try {
      const body = fs.readFileSync(path.join(deps.dir, name));
      const cache = url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache';
      res.writeHead(200, { 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
    return true;
  }

  if (req.method === 'GET' && route === '/-/api/view') {
    const upstream = await fetch(`${deps.internalHttp}/v1/database/${encodeURIComponent(deps.db)}/route/api${url.search}`, { headers: { cookie: req.headers.cookie ?? '' } });
    const body = await upstream.text();
    const etag = upstream.headers.get('etag');
    const matches = etag && (req.headers['if-none-match'] ?? '').split(',').some(value => value.trim().replace(/^W\//, '') === etag);
    if (matches) {
      res.writeHead(304, { etag, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(etag ? { etag } : {}) });
    res.end(body);
    return true;
  }

  if (req.method === 'GET' && route === '/-/api/me') {
    const session = await deps.sessionOf(req);
    json(res, 200, { name: session?.username ?? null });
    return true;
  }

  if (route === '/-/api/chat') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Send chat messages with POST.' }), true;
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'Send JSON.' }), true;
    const token = /(?:^|;\s*)spacehub_session=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
    if (!token) return json(res, 401, { error: 'Sign in to save chats.' }), true;
    let input: ReturnType<typeof parseChat>;
    try {
      input = parseChat(await readJson(req));
    } catch (error) {
      return json(res, 400, { error: error instanceof Error && error.message.includes('too long') ? error.message : 'Invalid chat message.' }), true;
    }
    if (!input) return json(res, 400, { error: 'Send a space, project, conversation and its new messages.' }), true;
    try {
      const saved = await deps.withConn(decodeURIComponent(token), async (conn, identity) => {
        if (!(await findUser(conn, identity))) return false;
        await conn.reducers.appendChat(input);
        return true;
      });
      if (!saved) return json(res, 401, { error: 'Sign in to save chats.' }), true;
      return json(res, 200, { ok: true }), true;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/^Error: /, '');
      return json(res, /permission denied/.test(message) ? 403 : 400, { error: message }), true;
    }
  }

  if (route === '/-/api/collaborators') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Change collaborators with POST.' }), true;
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'Send JSON.' }), true;
    const token = /(?:^|;\s*)spacehub_session=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
    if (!token) return json(res, 401, { error: 'Sign in to change collaborators.' }), true;
    let input: ReturnType<typeof parseCollaborator>;
    try {
      input = parseCollaborator(await readJson(req));
    } catch {
      return json(res, 400, { error: 'Invalid request.' }), true;
    }
    if (!input) return json(res, 400, { error: 'Send a space, project, action (add or remove) and a builder or agent name.' }), true;
    const { action, ...change } = input;
    try {
      const done = await deps.withConn(decodeURIComponent(token), async (conn, identity) => {
        if (!(await findUser(conn, identity))) return false;
        if (action === 'add') await conn.reducers.addProjectMember(change);
        else await conn.reducers.removeProjectMember(change);
        return true;
      });
      if (!done) return json(res, 401, { error: 'Sign in to change collaborators.' }), true;
      return json(res, 200, { ok: true }), true;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/^Error: /, '');
      return json(res, /permission denied/.test(message) ? 403 : 400, { error: message }), true;
    }
  }

  const page = req.method === 'GET' || req.method === 'HEAD' ? PAGE.exec(route) : null;
  if (page) {
    const [, space, project] = page;
    const title = space ? `${project ? `${space}/${project}` : space} · spacehub` : 'spacehub';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': APP_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
    res.end(appPage(deps.dir, title));
    return true;
  }
  return false;
}
