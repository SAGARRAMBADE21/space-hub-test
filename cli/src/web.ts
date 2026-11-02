// spacehub web service: the write side of the web UI. It runs next to
// SpacetimeDB inside the server image, behind the same proxy, at /-/*:
//
//   GET/POST /-/login            sign in with an identity token
//   GET/POST /-/signup           register a builder (new identity + name), or how to
//                                sign up with GitHub on a hub where builders do
//   POST     /-/api/auth/github  sign up or in with a GitHub token (signin.ts), for the CLI
//   GET      /-/login/xo         sign in with xo in the browser, and its callback (xosignin.ts)
//   POST     /-/logout           forget the session
//   GET/POST /-/new              create a project: from a template (with its goal), empty,
//                                or imported from GitHub
//   POST     /-/sync/<o>/<name>  pull a project's GitHub source again
//   POST     /-/link/<space>     link a space to a GitHub account (or sync it, or unlink)
//   GET      /-/live, /-/live.js live pages: a page's new rendering on every change (live.ts)
//   GET      /, /<space>, /<space>/<project>, /-/app/*, /-/api/view, /-/api/me,
//   POST     /-/api/chat, /-/api/collaborators
//                                the hub's app: open-chat's interface over the hub (app.ts)
//   *        /-/api/agenthub/... the orgs' worker agents, launched from a chat (agenthub.ts),
//                                only with SPACEHUB_AGENTHUB_URL and _TOKEN set
//   *        /-/api/xo/v1/...    xo.quirq.dev's store and agents (xo.ts), only
//                                with SPACEHUB_XO_KEY set
//
// Pages are read by the module (ui.ts); this service only acts. A session is
// the user's identity token in an HttpOnly cookie, so every action runs as
// that user and the module's own ownership checks apply.
import http from 'node:http';
import { connectTo, errorMessage, findProject, findUser, quietSdkLogs, snapshot, tables, type Conn } from './conn';
import { githubLogin, normalizeServer } from './config';
import { esc, navFor, PAGE_CSP, shell, sideFor } from '../../module/src/style';
import { signInWays, xoButton, type Hub } from '../../module/src/howto';
import { Fail, GithubSync, githubApi, githubBuilder as builderOf, githubInfo as infoOf, mirrorProject } from './github';
import { LiveHub } from './live';
import { accountsSetting, handleSignIn, signInConfig } from './signin';
import { handleXo, xoConfig } from './xo';
import { CALLBACK_ROUTE, finishSignIn, offerFor, START_ROUTE, startSignIn, STATE_COOKIE, WAIT_SECONDS, xoSignInConfig } from './xosignin';
import { appDir, handleApp } from './app';
import { Reply } from './admin';
import { agentHubConfig, handleAgentHub } from './agenthub';

quietSdkLogs();

const PORT = Number(process.env.SPACEHUB_WEB_PORT ?? 3002);
const SERVER = normalizeServer(process.env.SPACEHUB_SERVER ?? 'ws://127.0.0.1:3001');
const DB = process.env.SPACEHUB_DB ?? 'spacehub';
const MAX_IMPORT_MB = Number(process.env.SPACEHUB_IMPORT_MAX_MB ?? 500);
const MAX_CONCURRENT_IMPORTS = 2;
const YEAR = 60 * 60 * 24 * 365;
// SpacetimeDB's HTTP side, where the module renders pages.
const INTERNAL_HTTP = (process.env.SPACEHUB_INTERNAL_HTTP ?? SERVER.replace(/^ws/, 'http')).replace(/\/+$/, '');
const XO = xoConfig(DB, INTERNAL_HTTP);
const XO_SIGNIN = xoSignInConfig(XO);
const AGENTHUB = agentHubConfig();
const LIVE = new LiveHub({ server: SERVER, db: DB, http: INTERNAL_HTTP });
const GITHUB = githubApi();
const APP_DIR = appDir();
const githubInfo = (owner: string, repo: string) => infoOf(GITHUB, owner, repo);
const githubBuilder = (login: string) => builderOf(GITHUB, login);
// GitHub sign-in makes builders as the hub admin.
const SIGNIN = signInConfig(DB, INTERNAL_HTTP, GITHUB);
// Spaces linked to GitHub sync as the hub admin, whose token the entrypoint
// hands over.
const ADMIN_TOKEN = process.env.SPACEHUB_ADMIN_TOKEN ?? '';
const SYNC = ADMIN_TOKEN
  ? new GithubSync({
      server: SERVER,
      db: DB,
      adminToken: ADMIN_TOKEN,
      api: GITHUB,
      maxRepos: Number(process.env.SPACEHUB_GITHUB_MAX_REPOS ?? 100),
      maxImportMb: MAX_IMPORT_MB,
      everyMinutes: Number(process.env.SPACEHUB_GITHUB_SYNC_MINUTES ?? 60),
    })
  : null;

const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const PROJECT_NAME = /^[A-Za-z0-9._-]{1,100}$/;

// ---------------------------------------------------------------- http bits

function send(res: http.ServerResponse, status: number, html: string, extra: Record<string, string | string[]> = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': PAGE_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(html);
}

function redirect(res: http.ServerResponse, to: string, cookies: string[] = [], extra: Record<string, string> = {}) {
  res.writeHead(303, { location: to, 'cache-control': 'no-store', ...(cookies.length ? { 'set-cookie': cookies } : {}), ...extra });
  res.end();
}

// A form page in a narrow card; wide pages (the sign-in steps) use the page's width, like the guide.
function page(title: string, viewer: string | null, body: string, wide = false) {
  return shell(title, navFor(viewer), wide ? `<div class="wide-page">${body}</div>` : `<div class="narrow">${body}</div>`, '', '/', sideFor(viewer));
}

function cookieValue(req: http.IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function sessionCookies(req: http.IncomingMessage, token: string, username: string, maxAge = YEAR) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const attrs = `; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  return [`spacehub_session=${encodeURIComponent(token)}${attrs}; HttpOnly`, `spacehub_user=${encodeURIComponent(username)}${attrs}`];
}

// The state of a sign-in with xo, sent back only to its two routes.
function signInCookie(req: http.IncomingMessage, state: string, maxAge = WAIT_SECONDS) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${STATE_COOKIE}=${state}; Path=${START_ROUTE}; SameSite=Lax; Max-Age=${maxAge}; HttpOnly${secure}`;
}

// Form posts must come from this site: compare Origin (or Referer) with Host.
function sameOrigin(req: http.IncomingMessage) {
  const host = req.headers.host;
  const from = req.headers.origin ?? req.headers.referer;
  if (!host || !from) return false;
  try {
    return new URL(from).host === host;
  } catch {
    return false;
  }
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Fail('form too large');
  }
  return new URLSearchParams(body);
}

function localPath(next: string | null) {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

// ---------------------------------------------------------------- sessions

async function withConn<T>(token: string | undefined, fn: (conn: Conn, identity: Parameters<typeof findUser>[1], token: string) => Promise<T>) {
  const { conn, identity, token: issued } = await connectTo(SERVER, DB, token);
  try {
    return await fn(conn, identity, issued);
  } finally {
    conn.disconnect();
  }
}

// The signed-in user for this request, checked against the database.
async function sessionOf(req: http.IncomingMessage): Promise<{ token: string; username: string } | null> {
  const token = cookieValue(req, 'spacehub_session');
  if (!token) return null;
  try {
    const user = await withConn(token, (conn, identity) => findUser(conn, identity));
    return user ? { token, username: user.username } : null;
  } catch {
    return null;
  }
}

// Save chat turns as the builder; the module's push rules decide who may.
async function appendChat(session: { token: string }, input: { project: string; conversation: string; turns: { id: string; role: string; content: string; links: { label: string; path: string }[] }[] }) {
  await withConn(session.token, conn => conn.reducers.appendChat(input));
}

// Where the signed-in builder may create projects: its personal space and
// the spaces it belongs to.
async function spacesOf(session: { token: string; username: string }): Promise<string[]> {
  const others = await withConn(session.token, conn =>
    snapshot(conn, tables.spaceRole.where(r => r.member.eq(session.username)), () =>
      [...conn.db.spaceRole.iter()].filter(r => r.member === session.username).map(r => r.space)
    )
  ).catch(() => [] as string[]);
  return [session.username, ...others.sort()];
}

// ---------------------------------------------------------------- GitHub

function parseGithub(input: string) {
  const s = input.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(s) ??
    /^git@github\.com:([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(s);
  return m ? { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` } : null;
}

// ---------------------------------------------------------------- imports

interface Job {
  token: string;
  project: string;
  source: string;
  sync: boolean;
}

const queue: Job[] = [];
let running = 0;

// An import or sync of one project, as the builder who asked: the same
// rules as linked spaces, so work done on the hub is never overwritten.
async function runJob(job: Job) {
  await withConn(job.token, async conn => {
    const report = (status: string, message: string) =>
      conn.reducers.updateImport({ project: job.project, status, message }).catch(() => undefined);
    try {
      await report('running', 'copying from GitHub');
      const project = (await findProject(conn, job.project)) ?? (() => { throw new Error(`no project ${job.project}`); })();
      const result = await mirrorProject(conn, project, `${job.source}.git`, { SPACEHUB_TOKEN: job.token, SPACEHUB_SERVER: SERVER, SPACEHUB_DB: DB });
      if (result.head && !job.sync) await conn.reducers.editProject({ project: job.project, description: undefined, defaultBranch: result.head }).catch(() => undefined);
      if (result.failed && result.failed === result.refs) throw new Error(`no refs could be pushed`);
      const note = `${result.diverged ? `; ${result.diverged} refs diverged (kept here)` : ''}${result.failed ? `; ${result.failed} refs not pushed` : ''}`;
      await report('done', `${job.sync ? 'synced' : 'imported'}${note}`);
    } catch (err) {
      await report('failed', errorMessage(err).slice(-500));
    }
  }).catch(err => process.stderr.write(`spacehub-web: import of ${job.project} could not report: ${errorMessage(err)}\n`));
}

function pump() {
  while (running < MAX_CONCURRENT_IMPORTS && queue.length > 0) {
    const job = queue.shift()!;
    running++;
    runJob(job).finally(() => {
      running--;
      pump();
    });
  }
}

// ---------------------------------------------------------------- pages

// Sign in: the ways to get a token from the terminal (howto.ts), then the
// form that takes it.
function loginPage(viewer: string | null, hub: Hub, error = '', next = '/') {
  return page(
    'Sign in · spacehub',
    viewer,
    `<div class="page-title"><h1>Sign in</h1><p>${hub.xo ? 'There are no passwords here. Sign in with xo, or once from your terminal, then paste your token.' : 'There are no passwords here. Sign in once from your terminal, then paste your token to use this site.'}</p></div>
${error ? `<div class="banner err">${esc(error)}</div>` : ''}
${hub.xo ? xoButton('Sign in with xo', next) : ''}
${signInWays(hub, true)}
<h2 class="section-title">Paste your token</h2>
<form class="signin-form" method="post" action="/-/login"><input type="hidden" name="next" value="${esc(next)}">
<label for="token">Identity token</label><textarea id="token" name="token" required spellcheck="false" autocomplete="off"></textarea>
<p><button class="btn primary" type="submit">Sign in</button></p></form>
${hub.accounts === 'open' ? '<p class="muted">New here? <a href="/-/signup">Register</a>.</p>' : ''}`,
    true
  );
}

function signupPage(viewer: string | null, hub: Hub, error = '', username = '') {
  return page(
    'Register · spacehub',
    viewer,
    `<h1><b>Register</b></h1>
<p class="desc">Pick your builder name. It is also your personal space: your projects live at <code>&lt;name&gt;/&lt;project&gt;</code>.</p>
${error ? `<div class="banner err">${esc(error)}</div>` : ''}
${hub.xo ? xoButton('Sign up with xo', '/', 'Or pick a name') : ''}
<form method="post" action="/-/signup"><label for="username">Builder name <span class="muted">lowercase letters, digits and hyphens</span></label>
<input type="text" id="username" name="username" value="${esc(username)}" required pattern="[a-z0-9][a-z0-9-]{0,38}" autocomplete="username">
<p><button class="btn primary" type="submit">Register</button></p></form>
<p class="muted">Already registered? <a href="/-/login">Sign in</a>.</p>`
  );
}

// On a hub where builders sign up with GitHub (or xo), they do it from the terminal.
function terminalSignupPage(viewer: string | null, hub: Hub, error = '') {
  return page(
    'Sign up · spacehub',
    viewer,
    `<div class="page-title"><h1>Sign up</h1><p>${hub.xo ? 'Builders on this hub sign up with xo or from the terminal. There is no password: sign in the same way on any machine to get your builder back.' : 'Builders on this hub sign up from the terminal. There is no password: run the same login on any machine to get your builder back.'}</p></div>
${error ? `<div class="banner err">${esc(error)}</div>` : ''}
${hub.xo ? xoButton('Sign up with xo', '/') : ''}
${signInWays(hub, true).replace('Paste it below.', 'Paste it at <a href="/-/login">Sign in</a> to use this site too.')}`,
    true
  );
}

// Where builders come from: "open", "github" or "xo" (unknown without the admin: open).
async function accountsMode() {
  if (!SIGNIN) return 'open';
  try {
    return await accountsSetting(SIGNIN);
  } catch {
    return 'open';
  }
}

// This hub as the sign-in pages describe it.
async function hubOf(req: http.IncomingMessage): Promise<Hub> {
  const [accounts, offer] = await Promise.all([accountsMode(), offerFor(XO_SIGNIN, callbackOf(req))]);
  return { server: serverOf(req), host: req.headers.host ?? 'localhost', accounts, xo: offer !== null };
}

// Where XO's sign-in sends the browser back to this hub, as the browser reached it.
function callbackOf(req: http.IncomingMessage) {
  const scheme = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${scheme}://${req.headers.host ?? 'localhost'}${CALLBACK_ROUTE}`;
}

// This hub's websocket address, as the browser reached it.
function serverOf(req: http.IncomingMessage) {
  const scheme = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
  return `${scheme}://${req.headers.host ?? 'localhost'}`;
}

// The templates a project can start from (the module's ?templates view);
// the built-in goal space alone when the module cannot be asked.
type Template = { id: string; title: string; about: string; builtin: boolean };
async function templatesList(): Promise<Template[]> {
  const builtin: Template[] = [{ id: 'goal', title: 'Goal space', about: '', builtin: true }];
  try {
    const response = await fetch(`${INTERNAL_HTTP}/v1/database/${encodeURIComponent(DB)}/route/api?templates`);
    if (!response.ok) return builtin;
    const body = (await response.json()) as { templates?: Template[] };
    return body.templates?.length ? body.templates : builtin;
  } catch {
    return builtin;
  }
}

function newPage(viewer: string, spaces: string[], templates: Template[], error = '', values: Record<string, string> = {}) {
  const v = (k: string) => esc(values[k] ?? '');
  const chosen = values.space || viewer;
  const options = spaces.map(sp => `<option value="${esc(sp)}"${sp === chosen ? ' selected' : ''}>${esc(sp)}</option>`).join('');
  const template = values.template ?? 'goal';
  const known = templates.some(t => t.id === template) || template === '';
  const choices = [
    ...templates.map(t => ({ id: t.id, label: t.builtin ? `${t.title} (built in)` : `${t.title} · ${t.id}`, about: t.about })),
    ...(known ? [] : [{ id: template, label: template, about: '' }]),
    { id: '', label: 'Empty project', about: 'No files: push your own.' },
  ];
  const picker = choices
    .map(c => `<option value="${esc(c.id)}"${c.id === template ? ' selected' : ''}${c.about ? ` title="${esc(c.about)}"` : ''}>${esc(c.label)}</option>`)
    .join('');
  const about = choices.find(c => c.id === template)?.about ?? '';
  return page(
    'New project · spacehub',
    viewer,
    `<h1><b>Create a new project</b></h1>
<p class="desc">Start a space around a goal from a template, start empty, or import a public GitHub repository with its branches, tags and history.</p>
${error ? `<div class="banner err">${esc(error)}</div>` : ''}
<form method="post" action="/-/new">
<label for="goal">Goal <span class="muted">what this space is for, in one sentence; it opens the space, above its outcomes</span></label>
<textarea id="goal" name="goal" rows="2" maxlength="500" style="font:inherit;min-height:56px" placeholder="Ship the new site by December 1, with sign-ups working.">${v('goal')}</textarea>
<label for="template">Start from <span class="muted">a template brings its files: SPACE.md (goal, outcomes, owners, rules, routines), channels and guides</span></label>
<select id="template" name="template">${picker}</select>
${about ? `<p class="muted">${esc(about)}</p>` : ''}
<label for="github">Or import from GitHub <span class="muted">optional, e.g. https://github.com/owner/repo; an import ignores the template</span></label>
<input type="url" id="github" name="github" value="${v('github')}" placeholder="https://github.com/owner/repo">
<label for="name">Space and project name <span class="muted">the name defaults to the repository's</span></label>
<div style="display:flex;gap:8px;align-items:center"><select id="space" name="space" aria-label="Space">${options}</select><span class="muted">/</span><input type="text" id="name" name="name" value="${v('name')}" pattern="[A-Za-z0-9._-]{1,100}"></div>
<label for="description">Description <span class="muted">optional; defaults to GitHub's</span></label>
<input type="text" id="description" name="description" value="${v('description')}" maxlength="500">
<label for="builder">Built by <span class="muted">optional; a GitHub user or organization (name or github.com URL). Defaults to the GitHub owner when importing, otherwise you</span></label>
<input type="text" id="builder" name="builder" value="${v('builder')}" maxlength="100">
<p><button class="btn primary" type="submit">Create project</button></p></form>`
  );
}

function welcomePage(username: string, token: string) {
  return page(
    'Welcome · spacehub',
    username,
    `<h1>Welcome, <b>${esc(username)}</b></h1>
<div class="banner ok">You are registered and signed in on this browser.</div>
<h2>Save your identity token</h2>
<p class="desc">This token is your login. There is no password reset, so keep it somewhere safe. Use it to sign in elsewhere, or with the CLI: <code>spacehub auth login --with-token</code>.</p>
<code class="clone">${esc(token)}</code>
<p><a class="btn primary" href="/-/new">Create your first project</a> <a class="btn" href="/">Go to the hub</a></p>`
  );
}

// ---------------------------------------------------------------- routes

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://local');
  const route = url.pathname;
  // Called by xo.quirq.dev with its key, not from the site's forms.
  if (await handleXo(XO, req, res)) return;
  // Called by the CLI with a GitHub token, not from the site's forms.
  if (await handleSignIn(SIGNIN, req, res)) return;
  if (LIVE.handle(req, res, url)) return;
  if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, page('Forbidden', null, '<h1>Forbidden</h1><p class="desc">This form must be sent from this site.</p>'));
  if (await handleAgentHub(AGENTHUB, { sessionOf, spacesOf, appendChat, sameOrigin }, req, res, url)) return;
  if (await handleApp({ dir: APP_DIR, internalHttp: INTERNAL_HTTP, db: DB, withConn, sessionOf }, req, res, url)) return;

  if (route === '/-/login') {
    const session = await sessionOf(req);
    if (req.method === 'GET') return send(res, 200, loginPage(session?.username ?? null, await hubOf(req), '', localPath(url.searchParams.get('next'))));
    const form = await readForm(req);
    const token = (form.get('token') ?? '').trim();
    const next = localPath(form.get('next'));
    if (!token) return send(res, 400, loginPage(null, await hubOf(req), 'Paste your identity token.', next));
    let username: string | null = null;
    try {
      username = (await withConn(token, (conn, identity) => findUser(conn, identity)))?.username ?? null;
    } catch {
      return send(res, 400, loginPage(null, await hubOf(req), 'That token is not valid on this server.', next));
    }
    if (!username) return send(res, 400, loginPage(null, await hubOf(req), 'That identity has no builder yet. Log in from the terminal first, as above.', next));
    return redirect(res, next, sessionCookies(req, token, username));
  }

  if (route === START_ROUTE && req.method === 'GET') {
    const next = localPath(url.searchParams.get('next'));
    const offer = await offerFor(XO_SIGNIN, callbackOf(req));
    if (!offer) return send(res, 404, loginPage(null, await hubOf(req), 'Sign-in with xo is not on for this hub. Sign in from the terminal below.', next));
    try {
      const { state, location } = startSignIn(offer, next);
      return redirect(res, location, [signInCookie(req, state)]);
    } catch (err) {
      return send(res, err instanceof Reply ? err.status : 500, loginPage(null, await hubOf(req), errorMessage(err), next));
    }
  }

  if (route === CALLBACK_ROUTE && req.method === 'GET') {
    // The URL holds a one-time code: it goes to no other page, and the state cookie is spent.
    const quiet = { 'referrer-policy': 'no-referrer' };
    const spent = signInCookie(req, '', 0);
    try {
      if (!XO_SIGNIN) throw new Reply(404, 'Sign-in with xo is not on for this hub.');
      const q = url.searchParams;
      const out = await finishSignIn(XO_SIGNIN, { state: q.get('state'), cookie: cookieValue(req, STATE_COOKIE), code: q.get('code'), error: q.get('error') });
      const username = (await withConn(out.token, (conn, identity) => findUser(conn, identity)))?.username;
      if (username !== out.username) throw new Reply(502, `The builder ${out.username} cannot sign in on this hub.`);
      return redirect(res, out.next, [...sessionCookies(req, out.token, username), spent], quiet);
    } catch (err) {
      const status = err instanceof Reply ? err.status : 500;
      if (!(err instanceof Reply)) process.stderr.write(`spacehub-web: sign-in with xo: ${errorMessage(err)}\n`);
      return send(res, status, loginPage(null, await hubOf(req), err instanceof Reply ? err.message : 'Sign-in with xo failed. Try again.'), { ...quiet, 'set-cookie': spent });
    }
  }

  if (route === '/-/signup') {
    const session = await sessionOf(req);
    const hub = await hubOf(req);
    if (hub.accounts !== 'open') {
      const error = req.method === 'POST' ? 'Builders on this hub sign up from the terminal.' : '';
      return send(res, error ? 400 : 200, terminalSignupPage(session?.username ?? null, hub, error));
    }
    if (req.method === 'GET') return send(res, 200, signupPage(session?.username ?? null, hub));
    const form = await readForm(req);
    const username = (form.get('username') ?? '').trim().toLowerCase();
    if (!USERNAME.test(username)) return send(res, 400, signupPage(null, hub, 'Use 1 to 39 lowercase letters, digits or inner hyphens.', username));
    try {
      const token = await withConn(undefined, async (conn, _identity, issued) => {
        await conn.reducers.registerUser({ username });
        return issued;
      });
      return send(res, 200, welcomePage(username, token), { 'set-cookie': sessionCookies(req, token, username) });
    } catch (err) {
      return send(res, 400, signupPage(null, hub, errorMessage(err), username));
    }
  }

  if (route === '/-/logout' && req.method === 'POST') {
    return redirect(res, '/', sessionCookies(req, '', '', 0));
  }

  if (route === '/-/new') {
    const session = await sessionOf(req);
    // Keep ?template= through sign-in, so "Use this template" still picks it.
    if (!session) return redirect(res, `/-/login?next=${encodeURIComponent('/-/new' + url.search)}`);
    const spaces = await spacesOf(session);
    const templates = await templatesList();
    if (req.method === 'GET') {
      const template = url.searchParams.get('template');
      return send(res, 200, newPage(session.username, spaces, templates, '', template === null ? {} : { template }));
    }
    const form = await readForm(req);
    const values = Object.fromEntries(['github', 'space', 'name', 'description', 'builder', 'template', 'goal'].map(k => [k, (form.get(k) ?? '').trim()]));
    try {
      const source = values.github ? parseGithub(values.github) : null;
      if (values.github && !source) throw new Fail('Use a GitHub repository URL like https://github.com/owner/repo.');
      const name = (values.name || source?.repo || '').replace(/\.git$/, '');
      if (!PROJECT_NAME.test(name)) throw new Fail('Pick a project name: letters, digits, ".", "_" and "-".');
      const owner = values.space || session.username;
      if (!spaces.includes(owner)) throw new Fail(`You cannot create projects in "${owner}".`);
      let description = values.description;
      let builder: { handle: string; name: string } | null = null;
      if (values.builder) {
        const login = githubLogin(values.builder);
        if (!login) throw new Fail('Built by must be a GitHub user or organization, like anthropics or https://github.com/anthropics.');
        builder = await githubBuilder(login);
      }
      if (source) {
        const info = await githubInfo(source.owner, source.repo);
        if (info?.private) throw new Fail('Only public GitHub repositories can be imported.');
        if (info && info.sizeKb > MAX_IMPORT_MB * 1024) throw new Fail(`That repository is about ${Math.round(info.sizeKb / 1024)} MB; this server imports up to ${MAX_IMPORT_MB} MB.`);
        description ||= info?.description ?? '';
        builder ??= await githubBuilder(info?.ownerLogin ?? source.owner);
      }
      const project = `${owner}/${name}`;
      await withConn(session.token, async conn => {
        if (!source && values.template) await conn.reducers.createProjectFromTemplate({ space: owner, name, description, template: values.template, goal: values.goal });
        else await conn.reducers.createProject({ space: owner, name, description });
        if (builder) await conn.reducers.setProjectBuilder({ project, ...builder });
        if (source) await conn.reducers.startImport({ project, source: source.url });
      });
      if (source) {
        queue.push({ token: session.token, project, source: source.url, sync: false });
        pump();
      }
      return redirect(res, `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
    } catch (err) {
      return send(res, 400, newPage(session.username, spaces, templates, errorMessage(err), values));
    }
  }

  const sync = /^\/-\/sync\/([^/]+)\/([^/]+)$/.exec(route);
  if (sync && req.method === 'POST') {
    const session = await sessionOf(req);
    if (!session) return redirect(res, `/-/login?next=${encodeURIComponent(route)}`);
    const project = `${decodeURIComponent(sync[1])}/${decodeURIComponent(sync[2])}`;
    const back = `/${sync[1]}/${sync[2]}`;
    try {
      const source = await withConn(session.token, async conn => {
        const sp = await findProject(conn, project);
        if (!sp) throw new Fail(`No project ${project}.`);
        const row = await snapshot(conn, tables.projectImport.where(r => r.projectId.eq(sp.id)), () =>
          [...conn.db.projectImport.iter()].find(r => r.projectId === sp.id)
        );
        if (!row) throw new Fail(`${project} was not imported from GitHub.`);
        await conn.reducers.startImport({ project, source: row.source });
        // Projects imported before builders existed get theirs on first sync.
        const credited = await snapshot(conn, tables.projectBuilder.where(r => r.projectId.eq(sp.id)), () =>
          [...conn.db.projectBuilder.iter()].some(r => r.projectId === sp.id)
        );
        const owner = /^https:\/\/github\.com\/([^/]+)\//.exec(row.source)?.[1];
        if (!credited && owner) {
          await githubBuilder(owner)
            .then(b => conn.reducers.setProjectBuilder({ project, ...b }))
            .catch(() => undefined);
        }
        return row.source;
      });
      queue.push({ token: session.token, project, source, sync: true });
      pump();
      return redirect(res, back);
    } catch (err) {
      return send(res, 400, page('Sync failed · spacehub', session.username, `<h1><b>Sync failed</b></h1><div class="banner err">${esc(errorMessage(err))}</div><p><a href="${esc(back)}">Back to ${esc(project)}</a></p>`));
    }
  }

  // A space's GitHub link: link (with a source), sync now, or unlink.
  const link = /^\/-\/link\/([^/]+)$/.exec(route);
  if (link && req.method === 'POST') {
    const session = await sessionOf(req);
    if (!session) return redirect(res, `/-/login?next=${encodeURIComponent(`/${link[1]}`)}`);
    const space = decodeURIComponent(link[1]);
    const form = await readForm(req);
    const action = form.get('action') ?? 'link';
    try {
      await withConn(session.token, async conn => {
        if (action === 'sync') await conn.reducers.requestSync({ space });
        else if (action === 'unlink') await conn.reducers.unlinkSpace({ space });
        else {
          const login = githubLogin((form.get('source') ?? '').trim());
          if (!login) throw new Fail('Link a GitHub user or organization, like anthropics or https://github.com/anthropics.');
          await conn.reducers.linkSpace({ space, source: `https://github.com/${login}` });
        }
      });
      return redirect(res, `/${link[1]}`);
    } catch (err) {
      return send(res, 400, page('GitHub link · spacehub', session.username, `<h1><b>Could not change the GitHub link</b></h1><div class="banner err">${esc(errorMessage(err))}</div><p><a href="/${esc(link[1])}">Back to ${esc(space)}</a></p>`));
    }
  }

  return send(res, 404, page('Not found · spacehub', null, '<h1>Not found</h1>'));
}

http
  .createServer((req, res) => {
    handle(req, res).catch(err => {
      process.stderr.write(`spacehub-web: ${errorMessage(err)}\n`);
      if (!res.headersSent) send(res, err instanceof Fail ? 400 : 500, page('Error · spacehub', null, `<h1>Something went wrong</h1><div class="banner err">${esc(errorMessage(err))}</div>`));
      else res.end();
    });
  })
  .listen(PORT, '127.0.0.1', () => process.stderr.write(`spacehub-web: listening on 127.0.0.1:${PORT} (database ${DB} at ${SERVER})${XO ? ', xo API on' : ''}\n`));
LIVE.start();
if (SYNC) SYNC.start();
else process.stderr.write('spacehub-web: no SPACEHUB_ADMIN_TOKEN, so spaces linked to GitHub are not synced\n');
