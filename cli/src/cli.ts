// spacehub: the client for a spacehub server, shaped like gh. `auth` manages
// who you are on which server, `space` manages the hub's top-level spaces
// (builders' personal spaces, orgs and agents), and `project` (alias `repo`)
// manages the git projects inside them. Moving code is plain git through
// git-remote-quirq, on a remote always named quirq that points at a quirq URL
// (quirq://hub.quirq.dev/<space>/<project>).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { configFile, githubLogin, loadConfig, removeToken, saveSettings, saveToken } from './config';
import os from 'node:os';
import { connect, connectTo, errorMessage, findSpace, findProject, findUser, hubObjects, hubProtocol, listRefs, projectsIn, PROTOCOL, quietSdkLogs, snapshot, spaceRoles, tables, type Conn } from './conn';
import { accountCheck, binDir, findOnPath, hubCheck, pathCheck, report, restartCheck, type Account, type Check } from './doctor';
import { permissionHelp, spacesNamed } from './permission';
import { AgentRun } from './agentrun';
import { agentTemplate } from './agenttemplate';
import { Autosync, AutosyncLoop, AutosyncStop, conflictHelp, UNFINISHED, unfinishedWork } from './autosync';
import { git } from './git';
import { cloneProject, findManifest, SpaceSync, writeManifest } from './spacesync';
import { DEFAULT_HUB_HOST, githubTokenTarget, hubUrl, parseHubUrl, REMOTE } from './url';
import { deviceSignIn } from './devicelogin';
import { formatLine, formatState, linesSince, newPost, POST_KINDS, readChat, TASK_STATUSES, type CollabLine } from './collab';

quietSdkLogs();

const VERSION = '0.4.0';

const HELP = `spacehub: git hosting on SpacetimeDB, laid out like GitHub

  space    a top-level name, like a GitHub user or organization: a builder's
           personal space, an org (like a GitHub organization), or an agent
  project  a git repository in a space: <space>/<project>
  builder  a person's login (with a personal space of the same name)
  agent    a space with an identity of its own: launched, connected to spaces

USAGE
  spacehub <command> <subcommand> [flags]

AUTH
  auth login      Sign up or log in with the GitHub account logged in on this machine
                    (gh auth login, or GH_TOKEN): your builder name is its GitHub login,
                    and logging in again on any machine gets the same builder back
                    [--server <url>] [--db <name>]
                  --with-token   log in with a token from "auth token" instead (read from stdin)
                  --builder <name>   register a name without GitHub, on hubs with open sign-up
                    (--agent and --username are aliases of --builder)
  auth status     Show the server, builder and identity in use
  auth token      Print the identity token (log in elsewhere with --with-token)
  auth logout     Forget the token for the current server  [--yes]
  auth delete     Delete this builder from the server: its projects, agents, places in
                    orgs and activity history; its name is free again  [--yes]

SETUP
  doctor          Check this machine: where the CLI is installed and whether your shell
                    finds it (with the PATH line to add if not), whether the install
                    survives a restart, the CLI vs the hub, and who you are signed in as

SPACES
  space create <org> [-d <text>]           Create an org (you are its owner)
  space list [<builder>]                   List spaces (or the ones a builder belongs to)
  space view <space>                       Kind, owners, members and projects
  space edit <space> --description <text>
  space delete <org> --yes                 Delete an empty org
  space member add <space> <name> [--owner]   Add a builder as a member (or owner)
  space member remove <space> <name>          (a member can remove itself)
  space member list <space>
  space clone <space> [<dir>]              Clone every project of a space into one folder
  space sync [--watch] [--auto] [--interval <seconds>]
                                    In that folder: fast-forward every project and clone new ones;
                                    --watch on every push; --auto runs autosync in every project
                                    (a conflict pauses only its project). Inside one project's
                                    clone, it syncs that project as before.
  space link <space> <github account>      Mirror a GitHub user's or organization's public repos
                                    as projects with the same names, kept in step by the hub
                                    (GitHub to hub; work done here is kept, never overwritten)
  space link <space> --sync | --remove     Sync now, or stop mirroring (the projects stay)

AGENTS
  agent create <name> [--in <space>] [-d <text>] [--template <git url>] [--no-home]
                                    An agent owned by your personal space (or an org you own),
                                    with its definition in <name>/home (xo-agent-template layout)
  agent list [<space>]                     Agents, where they are connected and where they run
  agent view <agent>
  agent connect <agent> <space>            Let it work in a space (you own both)
  agent disconnect <agent> <space>
  agent token <agent>                      Its token, for its owners (XO Swarm launches with it)
  agent run <agent> [<dir>] [--interval <seconds>] [--host <label>]
                                    Run it here: its home and every connected space in one
                                    folder, autosynced, pushing as the agent. Logged in as the
                                    agent (SPACEHUB_TOKEN) or as one of its owners.
  agent delete <agent> --yes               Delete it and its own projects

PROJECTS (alias: repo)
  project create <name> | <space>/<name>   Create a project (in your personal space by default)
                                    [-d <text>] [--source <dir> [--remote <name>] [--push]] [--clone]
                                    [--template goal | <space>/<project>] [--goal <text>]
                                    (a template: the built-in goal space, or a project with "## Template" in SPACE.md)
  project list [<space>]                   List projects
  project view [<project>]                 Default branch, size and refs
  project clone <project> [<dir>]          git clone a project (extra flags after --)
  project edit [<project>]                 [--description <text>] [--default-branch <name>]
                                    [--builder <GitHub user/org or github.com URL>]
                                    (--builder "" goes back to the default)
  project delete <project> --yes           Delete a project and all its history
  project sync                             Fast-forward the current branch from its quirq remote
                                    [--remote <name>] [--push] [--watch]
                                    --auto (implies --watch): edit together. Commit local changes
                                    every few seconds [--interval <seconds>, default 3], rebase onto
                                    every push to the branch, push. Stops on a conflict (exit 2).
  project watch [<project>]                Stream ref changes live  [--exec <command>]
  project who [<project>]                  Who is connected to a project right now
  project member add [<project>] <builder>     Let one more builder push to this project
  project member add [<project>] <agent>       Bring your own agent to this project only
                                    (you own the agent and work on the project)
  project member remove [<project>] <name>     (a collaborator can remove itself; whoever
                                    brought an agent can take it away; a collaborator's
                                    agents leave with them)
  project member list [<project>]

PROJECT CHAT (collab/ in the project: one conversation for its people and their agents)
  collab post [-p <project>] <text>        Post as yourself (or as the agent you run as); "-" reads stdin
                                    [--type message|goal|decision|finding|status|join]
                                    [--to <name,...>] [--reply-to <id>] [--meta <json>] [--id <id>]
  collab read [<project>]                  The conversation  [--since <seq>] [--last <n>] [--json]
  collab state [<project>]                 Goal, tasks and owners, decisions, findings, who said what
                                    [--json]
  collab watch [<project>]                 Print each new post as it lands  [--since <seq>] [--json]
                                    [--exec <command>]: run it per post, with the post as JSON
                                    in SPACEHUB_COLLAB_POST
  collab task [-p <project>] <id> [<note>] Open or update a task  [--title <text>]
                                    [--status open|in_progress|blocked|done|cancelled]
                                    [--owner <name> | --claim]
  collab handoff [-p <project>] <id> <to> [<note>]   Hand a task to someone else on the project

  <project> is space/name, or just name for your personal space. Inside a clone
  it defaults to the repository's quirq remote. Older forms still work: space
  commands given space/name (or run inside a clone) act on that project.

GIT
  The hub's remote is always named "quirq" and points at a quirq URL, so origin
  stays free for GitHub:
  git clone -o quirq quirq://hub.quirq.dev/<space>/<project>
  git remote add quirq quirq://hub.quirq.dev/<space>/<project>
  git push quirq | git fetch quirq | git pull quirq main
  (the default server is wss://hub.quirq.dev)

ENVIRONMENT
  SPACEHUB_SERVER, SPACEHUB_DB, SPACEHUB_TOKEN, SPACEHUB_HOME override the saved settings.`;

class Usage extends Error {}

// Ends the command with a message and a chosen exit status.
class Exit extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function out(text = '') {
  process.stdout.write(text + '\n');
}

function note(text: string) {
  process.stderr.write(text + '\n');
}

function die(message: string): never {
  throw new Usage(message);
}

// Pull `--name value` (or a boolean `--name`) out of args.
function takeFlag(args: string[], names: string[], boolean = false): string | true | undefined {
  for (const name of names) {
    const i = args.indexOf(name);
    if (i < 0) continue;
    if (boolean) {
      args.splice(i, 1);
      return true;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) die(`${name} needs a value`);
    args.splice(i, 2);
    return value;
  }
  return undefined;
}

const opt = (args: string[], ...names: string[]) => takeFlag(args, names) as string | undefined;
const bool = (args: string[], ...names: string[]) => takeFlag(args, names, true) === true;

function formatBytes(n: bigint) {
  const b = Number(n);
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

// Bytes each project stores (git objects, uncompressed); a project the hub is
// still measuring has no entry.
function projectSizes(conn: Conn) {
  return snapshot(conn, tables.projectSize, () => new Map([...conn.db.projectSize.iter()].map(r => [r.projectId, r.bytes])));
}

function sizeText(sizes: Map<bigint, bigint>, id: bigint) {
  const b = sizes.get(id);
  return b === undefined ? 'measuring' : formatBytes(b);
}

function totalText(sizes: Map<bigint, bigint>, ids: bigint[]) {
  let total = 0n;
  let waiting = 0;
  for (const id of ids) {
    const b = sizes.get(id);
    if (b === undefined) waiting++;
    else total += b;
  }
  return `${formatBytes(total)}${waiting ? ` (${waiting} still measuring)` : ''}`;
}

function when(ts: { microsSinceUnixEpoch: bigint }) {
  return new Date(Number(ts.microsSinceUnixEpoch / 1000n)).toISOString().replace('T', ' ').slice(0, 16);
}

function run(cmd: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
  });
}

async function runOrDie(cmd: string, args: string[], cwd?: string) {
  const code = await run(cmd, args, cwd);
  if (code !== 0) die(`"${[cmd, ...args].join(' ')}" exited with ${code}`);
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------- session

let session: { conn: Conn; identity: Parameters<typeof findUser>[1]; server: string; database: string } | null = null;
// Commands that follow the hub until stopped reconnect when it goes away.
let longLived = false;

async function open() {
  session ??= await connect(undefined, { reconnect: longLived });
  return session;
}

async function username(): Promise<string> {
  const { conn, identity } = await open();
  const user = await findUser(conn, identity);
  if (!user) die('not logged in; run: spacehub auth login');
  return user.username;
}

// ---------------------------------------------------------------- projects in git

function parseProjectUrl(url: string): string | null {
  return parseHubUrl(url)?.project ?? null;
}

// The hub remote of the repository in `cwd`: the one named `prefer`, else
// "quirq", else "spacehub" or origin (older clones), else any quirq:// remote.
async function projectRemote(prefer?: string, cwd?: string): Promise<{ remote: string; project: string } | null> {
  let names: string[];
  try {
    names = (await git(['-C', cwd ?? '.', 'remote'])).split('\n').filter(Boolean);
  } catch {
    return null;
  }
  if (prefer && !names.includes(prefer)) die(`no remote named "${prefer}"`);
  const order = [...new Set([prefer, REMOTE, 'spacehub', 'origin', ...names].filter((n): n is string => !!n && names.includes(n)))];
  for (const remote of order) {
    const url = (await git(['-C', cwd ?? '.', 'remote', 'get-url', remote]).catch(() => '')).trim();
    const project = parseProjectUrl(url);
    if (project) return { remote, project };
    if (prefer && remote === prefer) die(`remote "${prefer}" is not a quirq remote`);
  }
  return null;
}

// "space/name", a quirq URL, or a bare name in your personal space; inside a
// clone, nothing means its quirq remote.
async function resolveProject(arg: string | undefined): Promise<string> {
  if (arg) {
    const parsed = parseHubUrl(arg);
    if (parsed) return parsed.project;
    const name = arg.replace(/\.git$/, '');
    if (name.includes('/')) {
      if (!/^[^/\s]+\/[^/\s]+$/.test(name)) die(`"${arg}" is not space/name`);
      return name;
    }
    return `${await username()}/${name}`;
  }
  const found = await projectRemote();
  if (!found) die('no project given and this directory has no quirq remote');
  return found.project;
}

async function requireProject(fullName: string) {
  const { conn } = await open();
  return (await findProject(conn, fullName)) ?? die(`project "${fullName}" not found`);
}

async function requireHubSpace(name: string) {
  const { conn } = await open();
  return (await findSpace(conn, name.toLowerCase())) ?? die(`no space named "${name}"`);
}

// What a `space` command's argument names: a top-level space, or (older
// forms) a project. space/name, a quirq URL or no argument in a clone is a
// project; a bare name is the space of that name, else your own project.
async function spaceOrProject(arg: string | undefined): Promise<{ space: string } | { project: string }> {
  if (!arg || arg.includes('/') || parseHubUrl(arg)) return { project: await resolveProject(arg) };
  const { conn } = await open();
  if (await findSpace(conn, arg.toLowerCase())) return { space: arg.toLowerCase() };
  const mine = `${await username()}/${arg.replace(/\.git$/, '')}`;
  if (await findProject(conn, mine)) return { project: mine };
  die(`no space named "${arg}" (and no project ${mine})`);
}

// Run `onChange` (serialized, coalesced) whenever a ref of the space changes.
async function followRefs(fullName: string, onChange: (refName: string, oid: string, sign: string) => void) {
  const { conn } = await open();
  const sp = await requireProject(fullName);
  conn.db.gitRef.onInsert((ctx, r) => {
    if (r.projectId === sp.id && ctx.event.tag !== 'SubscribeApplied') onChange(r.name, r.oid, '+');
  });
  conn.db.gitRef.onUpdate((_ctx, _old, r) => {
    if (r.projectId === sp.id) onChange(r.name, r.oid, '~');
  });
  conn.db.gitRef.onDelete((ctx, r) => {
    if (r.projectId === sp.id && ctx.event.tag !== 'UnsubscribeApplied') onChange(r.name, '', '-');
  });
  await new Promise<void>((resolve, reject) =>
    conn
      .subscriptionBuilder()
      .onApplied(() => resolve())
      .onError(ctx => reject(new Error(`subscription failed: ${(ctx as { event?: unknown }).event}`)))
      .subscribe(tables.gitRef.where(r => r.projectId.eq(sp.id)))
  );
  return { conn, sp };
}

function serialized(task: () => Promise<unknown>) {
  let running = false;
  let again = false;
  const tick = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await task();
    } catch (err) {
      note(`spacehub: ${errorMessage(err)}`);
    }
    running = false;
    if (again) {
      again = false;
      void tick();
    }
  };
  return tick;
}

// Tell the hub this connection follows `project`, then keep saying so: the
// heartbeat lets the hub drop rows of connections that vanished without
// closing. Agents only; presence never stops the command itself.
const HEARTBEAT_MS = 60_000;

async function announce(project: string, mode: 'watch' | 'sync' | 'autosync', branch = '') {
  const { conn, identity } = await open();
  if (!(await findUser(conn, identity))) return;
  let warned = false;
  const beat = () =>
    conn.reducers.watchProject({ project, mode, branch }).catch(err => {
      if (!warned) note(`spacehub: could not show presence: ${errorMessage(err)}`);
      warned = true;
    });
  await beat();
  setInterval(beat, HEARTBEAT_MS);
}

// The same, for a connection that follows every project of a space.
async function announceSpace(space: string, mode: 'sync' | 'autosync') {
  const { conn, identity } = await open();
  if (!(await findUser(conn, identity))) return;
  let warned = false;
  const beat = () =>
    conn.reducers.watchSpace({ space, mode, host: '' }).catch(err => {
      if (!warned) note(`spacehub: could not show presence: ${errorMessage(err)}`);
      warned = true;
    });
  await beat();
  setInterval(beat, HEARTBEAT_MS);
}

function clock() {
  return new Date().toISOString().slice(11, 19);
}

// ---------------------------------------------------------------- auth

async function authLogin(args: string[]) {
  const server = opt(args, '--server', '--hostname');
  const database = opt(args, '--db');
  const wanted = opt(args, '--builder', '-b', '--agent', '-a', '--username', '-u')?.toLowerCase();
  const withToken = bool(args, '--with-token');
  if (server || database) saveSettings({ server, database });
  if (withToken) {
    let token = '';
    for await (const chunk of process.stdin) token += chunk;
    token = token.trim();
    if (!token) die('--with-token reads a token from stdin, and none arrived');
    saveToken(loadConfig().server, token);
  }
  if (!withToken && !wanted) return githubSignIn();
  const { conn, identity, server: at, database: db } = await open();
  let user = await findUser(conn, identity);
  if (user && wanted && wanted !== user.username) {
    die(`this identity is already the builder ${user.username} on ${at}; log out first to be another builder`);
  }
  if (!user) {
    let name = wanted;
    if (!name) {
      if (!process.stdin.isTTY) die('first login on this server needs --builder <name>');
      name = (await ask('Choose a builder name: ')).toLowerCase();
    }
    if (!name) die('no builder name given');
    await conn.reducers.registerUser({ username: name });
    user = await findUser(conn, identity);
  }
  out(`Logged in to ${at} (database ${db}) as builder ${user?.username ?? wanted}`);
}

// The token of the GitHub account logged in on this machine: GH_TOKEN or
// GITHUB_TOKEN (as gh reads them), else gh's own login.
function localGithubToken(): string {
  const set = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  if (set) return set;
  const help = 'run "gh auth login" (or set GH_TOKEN), then try again';
  let token = '';
  try {
    token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      die(`sign-up uses the GitHub account logged in on this machine, through the GitHub CLI: install it (https://cli.github.com), ${help}`);
    }
    die(`no GitHub account is logged in on this machine: ${help}`);
  }
  if (!token) die(`no GitHub account is logged in on this machine: ${help}`);
  return token;
}

// Where the hub's web service answers: the server's address over http(s), or
// SPACEHUB_WEB when it runs on a port of its own (a local test server).
function webUrl(server: string) {
  return (process.env.SPACEHUB_WEB ?? server.replace(/^ws/, 'http')).replace(/\/+$/, '');
}

// Sign up or log in with GitHub: the hub learns whose GitHub account it is
// (from its own device flow, or by asking GitHub about gh's token) and answers with that account's builder and token, making the builder the
// first time. The saved token is kept when it already is a builder.
async function githubSignIn() {
  const cfg = loadConfig();
  if (cfg.token) {
    const { conn, identity, server: at, database: db } = await open();
    const user = await findUser(conn, identity);
    if (user) return out(`Logged in to ${at} (database ${db}) as builder ${user.username}`);
    if (process.env.SPACEHUB_TOKEN) die(`SPACEHUB_TOKEN is not a builder on ${at}`);
    session?.conn.disconnect();
    session = null;
  }
  const web = webUrl(cfg.server);
  const url = `${web}/-/api/auth/github`;
  let target: 'send' | 'ask';
  try {
    target = githubTokenTarget(url);
  } catch (err) {
    die((err as Error).message);
  }
  const host = new URL(url).host;
  type Answer = { builder?: string; token?: string; created?: boolean; error?: string };
  let body: Answer | null;
  try {
    // A code for this hub's GitHub app signs in to whichever hub holds it, and a
    // hostile hub can hand on another hub's code. So, as for gh's token, a hub
    // that is not the default asks first, and says what to check on GitHub.
    const confirm = async () => {
      if (target === 'send') return;
      if (!process.stdin.isTTY) throw new Error(`${host} is not ${DEFAULT_HUB_HOST}: run spacehub auth login at a terminal to confirm signing in to it`);
      const answer = await ask(
        `${host} is not ${DEFAULT_HUB_HOST}. On GitHub, approve only an app you know belongs to ${host}: approving another hub's app (such as ${DEFAULT_HUB_HOST}'s) would give ${host} your account there. Continue? [y/N] `
      );
      if (!/^y(es)?$/i.test(answer)) throw new Error('nothing was done');
    };
    body = (await deviceSignIn(web, host, note, confirm)) as Answer | null;
  } catch (err) {
    die((err as Error).message);
  }
  if (!body) {
    if (target === 'ask') {
      // gh's token can usually read and write your repositories: only a hub you
      // trust gets it, and only after you say so.
      if (!process.stdin.isTTY) die(`${host} is not ${DEFAULT_HUB_HOST}: run spacehub auth login at a terminal to confirm sending it your GitHub token`);
      const answer = await ask(`${host} is not ${DEFAULT_HUB_HOST}. Signing in sends it your GitHub token, which can act as you on GitHub. Send it? [y/N] `);
      if (!/^y(es)?$/i.test(answer)) die('nothing was sent');
    }
    const github = localGithubToken();
    process.stderr.write(`Checking your GitHub account with ${host} (the GitHub token is used once, not kept)\n`);
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${github}` }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
    } catch {
      die(`could not reach ${url}`);
    }
    body = (await res.json().catch(() => null)) as Answer | null;
    if (!body || res.status === 404 || res.status === 405) {
      die(`${cfg.server} has no GitHub sign-in (HTTP ${res.status}); on a hub with open sign-up, use --builder <name>`);
    }
    if (!res.ok) die(body.error ?? `GitHub sign-in failed (HTTP ${res.status})`);
  }
  const token = body.token;
  if (typeof token !== 'string' || !token) die(body.error ?? 'GitHub sign-in failed: the hub sent no token');
  saveToken(cfg.server, token);
  const { conn, identity, server: at, database: db } = await open();
  const user = await findUser(conn, identity);
  if (!user) die(`the hub signed you in as ${body.builder}, but database ${db} on ${at} has no such builder`);
  out(`${body.created ? 'Signed up on' : 'Logged in to'} ${at} (database ${db}) as builder ${user.username}, with your GitHub account`);
}

async function authStatus() {
  const cfg = loadConfig();
  out(`server    ${cfg.server}`);
  out(`database  ${cfg.database}`);
  if (!cfg.token) {
    out('builder   not logged in (spacehub auth login)');
    return;
  }
  const { conn, identity } = await open();
  const user = await findUser(conn, identity);
  out(`builder   ${user ? user.username : 'identity has no builder name yet (spacehub auth login)'}`);
  out(`identity  ${identity.toHexString()}`);
  out(`token     ${process.env.SPACEHUB_TOKEN ? 'from SPACEHUB_TOKEN' : `saved in ${configFile()}`}`);
}

function authToken() {
  out(loadConfig().token ?? die('not logged in'));
}

function authLogout(args: string[]) {
  const cfg = loadConfig();
  if (!cfg.token) die(`not logged in to ${cfg.server}`);
  if (!bool(args, '--yes', '-y')) {
    die(
      `if you signed up with GitHub, "spacehub auth login" gets this builder back later; otherwise the\n` +
        `token is its only key: back it up with "spacehub auth token" first. Then run "spacehub auth logout --yes"`
    );
  }
  removeToken(cfg.server);
  out(`Logged out of ${cfg.server}`);
}

// This builder leaves the hub, with its projects and agents. What the hub
// would refuse (being the last owner of an org) is read from the hub's rows
// right before the first delete, and the projects and agents to delete are
// read then too, so nothing is deleted for a builder the hub then keeps.
async function authDelete(args: string[]) {
  const yes = bool(args, '--yes', '-y');
  const name = await username();
  const { conn, server } = await open();
  const owned = async () => ({
    projects: await projectsIn(conn, name),
    agents: await snapshot(conn, tables.space.where(s => s.kind.eq('agent')), () =>
      [...conn.db.space.iter()].filter(s => s.kind === 'agent' && s.parent === name).map(s => s.name)
    ),
  });
  const refuseLastOwner = async () => {
    const roles = await snapshot(conn, tables.spaceRole, () => [...conn.db.spaceRole.iter()]);
    for (const r of roles.filter(r => r.member === name && r.role === 'owner')) {
      if (roles.filter(o => o.space === r.space && o.role === 'owner').length === 1) {
        die(`${name} is the last owner of ${r.space}; first add another owner: spacehub space member add ${r.space} <builder> --owner`);
      }
    }
  };
  if (!yes) {
    const { projects, agents } = await owned();
    await refuseLastOwner();
    const list = (items: string[]) => (items.length ? `: ${items.join(', ')}` : '');
    die(
      `this deletes the builder ${name} on ${server} for good, with ${projects.length} projects${list(projects.map(p => p.name))}, ` +
        `${agents.length} agents${list(agents)}, its places in orgs and its activity history; re-run with --yes`
    );
  }
  await refuseLastOwner();
  const { projects, agents } = await owned();
  for (const agent of agents) {
    for (const p of await projectsIn(conn, agent)) await conn.reducers.deleteProject({ project: p.fullName });
    await conn.reducers.deleteAgent({ name: agent });
    out(`Deleted the agent ${agent}`);
  }
  for (const p of projects) {
    await conn.reducers.deleteProject({ project: p.fullName });
    out(`Deleted ${p.fullName}`);
  }
  await conn.reducers.deleteBuilder({});
  removeToken(server);
  out(`Deleted the builder ${name} and logged out of ${server}`);
}

// ---------------------------------------------------------------- space

async function projectCreate(args: string[]) {
  const description = opt(args, '-d', '--description') ?? '';
  const source = opt(args, '--source', '-s');
  let remote = opt(args, '--remote', '-r');
  const pushAfter = bool(args, '--push');
  const cloneAfter = bool(args, '--clone', '-c');
  const goal = opt(args, '--goal', '-g');
  const template = opt(args, '--template', '-t') ?? (goal !== undefined ? 'goal' : undefined);
  const target = (args[0] ?? die('usage: spacehub project create <name> | <space>/<name>')).replace(/\.git$/, '');
  const [spaceArg, name] = target.includes('/') ? target.split('/', 2) : [undefined, target];
  if (pushAfter && !source) die('--push needs --source <dir>');
  if (template !== undefined && source) die('--template starts the project with its own first commit; leave out --source');
  if (source) {
    // Check the remote name before creating anything. It defaults to
    // "quirq" so origin is never touched (it is usually GitHub).
    const existing = (await git(['-C', source, 'remote']).catch(() => die(`${source} is not a git repository`)))
      .split('\n')
      .filter(Boolean);
    remote ??= REMOTE;
    if (existing.includes(remote)) die(`${source} already has a remote named "${remote}"; choose another with --remote <name>`);
  }
  const space = (spaceArg ?? (await username())).toLowerCase();
  const { conn } = await open();
  if (template !== undefined) await conn.reducers.createProjectFromTemplate({ space, name, description, template, goal: goal ?? '' });
  else await conn.reducers.createProject({ space, name, description });
  const fullName = `${space}/${name}`;
  const url = hubUrl(loadConfig().server, fullName);
  out(`Created project ${fullName}${template !== undefined ? ` from ${template === 'goal' || !template ? 'the goal space template' : template}` : ''}`);
  if (source) {
    await runOrDie('git', ['-C', source, 'remote', 'add', remote!, url]);
    out(`Added remote ${remote} -> ${url}`);
    if (pushAfter) await runOrDie('git', ['-C', source, 'push', remote!, 'HEAD']);
  } else if (cloneAfter) {
    await runOrDie('git', ['clone', '--origin', REMOTE, url]);
  } else if (template !== undefined) {
    out(`Its goal and outcomes are in SPACE.md.\n\n  spacehub project clone ${fullName}`);
  } else {
    out(`\n  spacehub project clone ${fullName}\n  # or, in an existing repository:\n  git remote add ${REMOTE} ${url} && git push ${REMOTE} HEAD`);
  }
}

async function projectList(args: string[]) {
  const owner = args[0];
  const { conn } = await open();
  const query = owner ? tables.project.where(s => s.owner.eq(owner)) : tables.project;
  const spaces = await snapshot(conn, query, () => [...conn.db.project.iter()].filter(s => !owner || s.owner === owner));
  if (spaces.length === 0) {
    out(owner ? `no projects in ${owner}` : 'no projects yet');
    return;
  }
  const sizes = await projectSizes(conn);
  const width = Math.max(...spaces.map(s => s.fullName.length));
  for (const s of spaces.sort((a, b) => Number(b.pushedAt.microsSinceUnixEpoch - a.pushedAt.microsSinceUnixEpoch))) {
    out(`${s.fullName.padEnd(width)}  ${sizeText(sizes, s.id).padStart(9)}  ${when(s.pushedAt)}  ${s.description}`.trimEnd());
  }
}

// Same rule as the web UI: the credited GitHub account, else the GitHub
// source's owner, else the builder who made it here.
function findUserByIdentity(conn: Conn, identity: Parameters<typeof findUser>[1]) {
  return findUser(conn, identity).then(u => u?.username);
}

async function builderLine(conn: Conn, sp: { id: bigint; owner: string; ownerIdentity: Parameters<typeof findUser>[1] }) {
  const row = await snapshot(conn, tables.projectBuilder.where(r => r.projectId.eq(sp.id)), () =>
    [...conn.db.projectBuilder.iter()].find(r => r.projectId === sp.id)
  );
  if (row?.url.startsWith('https://github.com/')) return `${row.name} (${row.url.replace('https://', '')})`;
  const imp = await snapshot(conn, tables.projectImport.where(r => r.projectId.eq(sp.id)), () =>
    [...conn.db.projectImport.iter()].find(r => r.projectId === sp.id)
  );
  const gh = imp ? /^https:\/\/github\.com\/([^/]+)\//.exec(imp.source) : null;
  if (gh) return `${gh[1]} (github.com/${gh[1]})`;
  const space = await findSpace(conn, sp.owner);
  const maker = !space || space.kind === 'personal' ? sp.owner : ((await findUserByIdentity(conn, sp.ownerIdentity)) ?? sp.owner);
  return `${maker} (builder)`;
}

async function projectView(args: string[]) {
  const fullName = await resolveProject(args[0]);
  const sp = await requireProject(fullName);
  const { conn } = await open();
  const refs = await listRefs(conn, sp.id);
  out(sp.fullName);
  if (sp.description) out(sp.description);
  out();
  out(`url       ${hubUrl(loadConfig().server, sp.fullName)}`);
  out(`default   ${sp.defaultBranch}`);
  out(`space     ${sp.owner}`);
  const members = await memberRows(conn, sp.id);
  out(`collaborators  ${members.map(m => m.agent).join(', ') || 'none'}`);
  out(`builder   ${await builderLine(conn, sp)}`);
  out(`size      ${sizeText(await projectSizes(conn), sp.id)} (${sp.objectCount} objects)`);
  out(`created   ${when(sp.createdAt)}`);
  out(`pushed    ${when(sp.pushedAt)}`);
  out();
  if (refs.length === 0) out('(empty: push something to it)');
  const diverged = await snapshot(conn, tables.refSync.where(r => r.projectId.eq(sp.id)), () =>
    new Set([...conn.db.refSync.iter()].filter(r => r.projectId === sp.id && r.status === 'diverged').map(r => r.ref))
  );
  for (const r of refs) out(`${r.oid.slice(0, 12)}  ${r.name.replace(/^refs\/(heads|tags)\//, '$1/')}  ${when(r.updatedAt)}${diverged.has(r.name) ? '  (diverged from GitHub)' : ''}`);
}

async function projectClone(args: string[]) {
  const dash = args.indexOf('--');
  const extra = dash >= 0 ? args.splice(dash).slice(1) : [];
  const fullName = await resolveProject(args[0] ?? die('usage: spacehub project clone <project> [<dir>]'));
  const dir = args[1];
  const named = extra.some(f => f === '-o' || f.startsWith('--origin'));
  await runOrDie('git', ['clone', ...(named ? [] : ['--origin', REMOTE]), ...extra, hubUrl(loadConfig().server, fullName), ...(dir ? [dir] : [])]);
}

async function projectEdit(args: string[]) {
  const description = opt(args, '--description', '-d');
  const defaultBranch = opt(args, '--default-branch');
  const builder = opt(args, '--builder');
  if (description === undefined && defaultBranch === undefined && builder === undefined) {
    die('nothing to change; pass --description, --default-branch and/or --builder');
  }
  const fullName = await resolveProject(args[0]);
  const { conn } = await open();
  if (description !== undefined || defaultBranch !== undefined) {
    await conn.reducers.editProject({ project: fullName, description, defaultBranch });
  }
  if (builder !== undefined) {
    // A builder is a GitHub account; "" resets to the default.
    const login = builder.trim() ? githubLogin(builder) : '';
    if (login === null) die(`--builder takes a GitHub user or organization, like anthropics or https://github.com/anthropics`);
    await conn.reducers.setProjectBuilder({ project: fullName, handle: login, name: login });
  }
  out(`Updated ${fullName}`);
}

async function projectDelete(args: string[]) {
  const yes = bool(args, '--yes', '-y');
  const fullName = await resolveProject(args[0] ?? die('usage: spacehub project delete <project> --yes'));
  if (!yes) die(`this deletes ${fullName} and all of its history; re-run with --yes`);
  const { conn } = await open();
  await conn.reducers.deleteProject({ project: fullName });
  out(`Deleted ${fullName}`);
}

async function projectSync(args: string[]) {
  const prefer = opt(args, '--remote', '-r');
  const pushToo = bool(args, '--push');
  const auto = bool(args, '--auto');
  const watch = bool(args, '--watch', '-w') || auto;
  const interval = opt(args, '--interval');
  const found = (await projectRemote(prefer)) ?? die('this directory has no quirq remote');
  const branch = (await git(['symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim();
  if (!branch && auto) {
    // A paused rebase leaves HEAD detached; say what is really going on.
    const files = await unfinishedWork((await git(['rev-parse', '--show-toplevel'])).trim());
    if (files) throw new Exit(listFiles(UNFINISHED, files), 2);
  }
  if (!branch) die('not on a branch');
  if (auto) return autosync(found, branch, interval === undefined ? 3 : Number(interval));
  if (interval !== undefined) die('--interval goes with --auto');
  const sync = async () => {
    await runOrDie('git', ['pull', '--ff-only', found.remote, branch]);
    if (pushToo) await runOrDie('git', ['push', found.remote, branch]);
  };
  await sync();
  if (!watch) return;
  const tick = serialized(sync);
  await followRefs(found.project, refName => {
    if (refName === `refs/heads/${branch}`) void tick();
  });
  await announce(found.project, 'sync', branch);
  note(`Watching ${found.project} ${branch}; syncing on every push (ctrl-c to stop)`);
  await new Promise(() => {});
}

function listFiles(message: string, files: string[]) {
  return files.length ? `${message}:\n${files.map(f => `  ${f}`).join('\n')}` : message;
}

// sync --watch --auto: one step at a time, every `seconds` and on every push
// to the branch, until a conflict, a refused push, or ctrl-c.
async function autosync(found: { remote: string; project: string }, branch: string, seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0.2 || seconds > 3600) die('--interval is a number of seconds, from 0.2 to 3600');
  const agent = await username();
  const top = (await git(['rev-parse', '--show-toplevel'])).trim();
  const engine = new Autosync({ cwd: top, remote: found.remote, branch, agent, log: line => note(`${clock()}  ${line}`) });
  const restart = 'spacehub project sync --watch --auto';
  const stopped = (err: AutosyncStop) =>
    new Exit(err.files.length || /conflict|rebase|merge/.test(err.message) ? conflictHelp(err.files, branch, restart) : `autosync stopped: ${err.message}`, 2);
  try {
    await engine.init();
  } catch (err) {
    if (err instanceof AutosyncStop) throw new Exit(listFiles(err.message, err.files), 2);
    throw err;
  }
  const ref = `refs/heads/${branch}`;
  let wake = () => {};
  const { conn, sp } = await followRefs(found.project, refName => {
    if (refName === ref) wake();
  });
  const remoteOid = () => [...conn.db.gitRef.iter()].find(r => r.projectId === sp.id && r.name === ref)?.oid ?? '';
  await announce(found.project, 'autosync', branch);
  note(`Autosync ${found.project} ${branch}: committing every ${seconds}s, rebasing onto every push (ctrl-c to stop)`);

  const loop = new AutosyncLoop(engine, seconds * 1000, remoteOid, err => note(`${clock()}  ${errorMessage(err)}; trying again`));
  wake = () => loop.wake();
  process.once('SIGINT', () => void loop.stop());
  process.once('SIGTERM', () => void loop.stop());
  const ended = await loop.start();
  const stop = ended ? stopped(ended) : null;
  if (stop) throw stop;
  note('Autosync stopped');
}

async function projectWatch(args: string[]) {
  const command = opt(args, '--exec');
  const fullName = await resolveProject(args[0]);
  const tick = command ? serialized(() => run('sh', ['-c', command])) : null;
  const { conn, sp } = await followRefs(fullName, (refName, oid, sign) => {
    out(`${new Date().toISOString().slice(11, 19)}  ${sign} ${refName}${oid ? ` ${oid.slice(0, 12)}` : ''}`);
    if (tick) void tick();
  });
  await announce(fullName, 'watch');
  out(`Watching ${fullName} (ctrl-c to stop)`);
  for (const r of conn.db.gitRef.iter()) if (r.projectId === sp.id) out(`          ${r.name} ${r.oid.slice(0, 12)}`);
  await new Promise(() => {});
}

function memberRows(conn: Conn, projectId: bigint) {
  return snapshot(conn, tables.projectMember.where(r => r.projectId.eq(projectId)), () =>
    [...conn.db.projectMember.iter()].filter(r => r.projectId === projectId).sort((a, b) => a.agent.localeCompare(b.agent))
  );
}

// member add|remove [<project>] <builder>, member list [<project>]: the
// project's collaborators.
async function projectMember(args: string[]) {
  const sub = args.shift();
  const usage = 'usage: spacehub project member <add|remove> [<project>] <builder> | member list [<project>]';
  if (sub === 'add' || sub === 'remove' || sub === 'rm') {
    if (args.length < 1 || args.length > 2) die(usage);
    const agent = args[args.length - 1].toLowerCase();
    const fullName = await resolveProject(args.length === 2 ? args[0] : undefined);
    const { conn } = await open();
    if (sub === 'add') {
      await conn.reducers.addProjectMember({ project: fullName, agent });
      out(`${agent} is a collaborator on ${fullName} and can push to it`);
    } else {
      await conn.reducers.removeProjectMember({ project: fullName, agent });
      out(`${agent} is no longer a collaborator on ${fullName}`);
    }
    return;
  }
  if (sub === 'list' || sub === 'ls') {
    const sp = await requireProject(await resolveProject(args[0]));
    const { conn } = await open();
    const rows = await memberRows(conn, sp.id);
    const width = Math.max(sp.owner.length, ...rows.map(r => r.agent.length));
    out(`${sp.owner.padEnd(width)}  space`);
    for (const r of rows) out(`${r.agent.padEnd(width)}  collaborator  added ${when(r.addedAt)} by ${r.addedBy}`);
    return;
  }
  die(usage);
}

// Who follows a space right now, from its presence rows.
async function projectWho(args: string[]) {
  const sp = await requireProject(await resolveProject(args[0]));
  const { conn } = await open();
  const now = Date.now() * 1000;
  const rows = await snapshot(conn, tables.presence, () =>
    [...conn.db.presence.iter()].filter(
      r => (r.projectId === sp.id || (r.projectId === 0n && r.space === sp.owner)) && now - Number(r.seenAt.microsSinceUnixEpoch) <= 180_000_000
    )
  );
  if (rows.length === 0) {
    out(`nobody is connected to ${sp.fullName} right now`);
    return;
  }
  rows.sort((a, b) => a.agent.localeCompare(b.agent) || Number(a.since.microsSinceUnixEpoch - b.since.microsSinceUnixEpoch));
  const width = Math.max(...rows.map(r => r.agent.length));
  for (const r of rows) out(`${r.agent.padEnd(width)}  ${r.mode.padEnd(8)}  ${(r.projectId === 0n ? `(all of ${r.space})` : r.branch || '-').padEnd(12)}  since ${when(r.since)}`.trimEnd());
}

// ---------------------------------------------------------------- project chat

// The project chat as it is on the hub now.
async function hubChat(fullName: string) {
  const sp = await requireProject(fullName);
  const { conn } = await open();
  const read = hubObjects(conn, sp.id);
  const head = (await listRefs(conn, sp.id)).find(r => r.name === `refs/heads/${sp.defaultBranch}`)?.oid;
  if (!head) die(`${fullName} has no commits yet`);
  return { sp, conn, read, chat: await readChat(read, head) };
}

function printLine(line: CollabLine, json: boolean) {
  out(json ? JSON.stringify(line) : formatLine(line));
}

async function sendPost(fullName: string, fields: Parameters<typeof newPost>[0], json: boolean) {
  const post = newPost(fields);
  const { conn } = await open();
  await conn.reducers.collabPost({ project: fullName, ...post });
  out(json ? JSON.stringify({ project: fullName, id: post.id }) : `posted to ${fullName}`);
}

function names(list: string | undefined) {
  return (list ?? '').split(',').map(n => n.trim().toLowerCase()).filter(Boolean);
}

async function collabPost(args: string[]) {
  const project = opt(args, '-p', '--project');
  const kind = opt(args, '--type', '-t') ?? 'message';
  const to = names(opt(args, '--to'));
  const replyTo = opt(args, '--reply-to') ?? '';
  const id = opt(args, '--id');
  const meta = opt(args, '--meta') ?? '';
  const json = bool(args, '--json');
  if (!(POST_KINDS as readonly string[]).includes(kind) || kind === 'task' || kind === 'handoff') die(`--type is one of ${POST_KINDS.filter(k => k !== 'task' && k !== 'handoff').join(', ')} (tasks: spacehub collab task)`);
  let content = args.join(' ');
  if (content === '-') content = fs.readFileSync(0, 'utf8');
  if (!content.trim() && kind !== 'join') die('usage: spacehub collab post [-p <project>] <text> [--type <kind>] [--to <names>]');
  await sendPost(await resolveProject(project), { kind, content, to, replyTo, meta, ...(id ? { id } : {}) }, json);
}

async function collabTask(args: string[], handoff: boolean) {
  const project = opt(args, '-p', '--project');
  const title = opt(args, '--title') ?? '';
  const status = opt(args, '--status') ?? '';
  const ownerFlag = opt(args, '--owner');
  const claim = bool(args, '--claim');
  const json = bool(args, '--json');
  if (status && !(TASK_STATUSES as readonly string[]).includes(status)) die(`--status is one of ${TASK_STATUSES.join(', ')}`);
  const task = args.shift() ?? die(handoff ? 'usage: spacehub collab handoff [-p <project>] <task> <to> [<note>]' : 'usage: spacehub collab task [-p <project>] <task> [<note>] [--title <text>] [--status <status>] [--owner <name> | --claim]');
  const owner = handoff ? (args.shift() ?? die('usage: spacehub collab handoff [-p <project>] <task> <to> [<note>]')).toLowerCase() : claim ? await whoAmI() : (ownerFlag ?? '').toLowerCase();
  const fullName = await resolveProject(project);
  await sendPost(fullName, { kind: handoff ? 'handoff' : 'task', task, taskTitle: title, taskStatus: status, taskOwner: owner, content: args.join(' ') }, json);
}

// The builder or agent this token signs in as.
async function whoAmI() {
  const { conn, identity } = await open();
  const user = await findUser(conn, identity);
  if (user) return user.username;
  const agent = await snapshot(conn, tables.agent.where(a => a.identity.eq(identity)), () => [...conn.db.agent.iter()].find(a => a.identity.isEqual(identity)));
  return agent?.name ?? die('not logged in; run: spacehub auth login');
}

async function collabRead(args: string[]) {
  const since = Number(opt(args, '--since') ?? 0);
  const last = opt(args, '--last');
  const json = bool(args, '--json');
  const fullName = await resolveProject(opt(args, '-p', '--project') ?? args[0]);
  const { read, chat } = await hubChat(fullName);
  let lines = await linesSince(read, chat, since);
  if (last) lines = lines.slice(-Math.max(1, Number(last)));
  if (!lines.length && !json) out(chat.state.seq ? `nothing after #${since}` : `nobody has posted in ${fullName} yet`);
  for (const line of lines) printLine(line, json);
}

async function collabState(args: string[]) {
  const json = bool(args, '--json');
  const fullName = await resolveProject(opt(args, '-p', '--project') ?? args[0]);
  const { chat } = await hubChat(fullName);
  out(json ? JSON.stringify({ ...chat.state, recent_ids: undefined }, null, 2) : formatState(chat.state));
}

// Follow the default branch; each new post prints once, in order. After a
// reconnect (or a restart with --since) it carries on from the last seen.
async function collabWatch(args: string[]) {
  const sinceArg = opt(args, '--since');
  const command = opt(args, '--exec');
  const json = bool(args, '--json');
  const fullName = await resolveProject(opt(args, '-p', '--project') ?? args[0]);
  let defaultRef = '';
  let last = sinceArg === undefined ? -1 : Number(sinceArg);
  const tick = serialized(async () => {
    const head = [...conn.db.gitRef.iter()].find(r => r.projectId === sp.id && r.name === defaultRef)?.oid;
    if (!head) return;
    const chat = await readChat(read, head);
    if (last < 0) last = chat.state.seq;
    if (chat.state.seq <= last) return;
    for (const line of await linesSince(read, chat, last)) {
      printLine(line, json);
      last = line.seq;
      if (command) await new Promise<void>(resolve => spawn('sh', ['-c', command], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, SPACEHUB_COLLAB_POST: JSON.stringify(line) } }).on('close', () => resolve()).on('error', () => resolve()));
    }
  });
  const { conn, sp } = await followRefs(fullName, refName => {
    if (refName === defaultRef) void tick();
  });
  defaultRef = `refs/heads/${sp.defaultBranch}`;
  const read = hubObjects(conn, sp.id);
  await announce(fullName, 'watch');
  note(`Watching the chat of ${fullName}${last >= 0 ? ` after #${last}` : ''} (ctrl-c to stop)`);
  void tick();
  await new Promise(() => {});
}

// ---------------------------------------------------------------- spaces

// Flags that take a value, so the first positional argument can be found
// before a command decides whether it names a space or a project.
const VALUE_FLAGS = new Set(['-d', '--description', '--default-branch', '--builder', '-r', '--remote', '--exec', '--interval', '-s', '--source']);

function firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') return undefined;
    if (VALUE_FLAGS.has(args[i])) i++;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return undefined;
}

async function spaceCreate(args: string[]) {
  // Older form: "space create <name> --source ..." made a project.
  if (['--source', '-s', '--push', '--clone', '-c', '--remote', '-r'].some(f => args.includes(f)) || firstPositional(args)?.includes('/')) {
    note('spacehub: making a project ("spacehub project create" is the command for that now)');
    return projectCreate(args);
  }
  const description = opt(args, '-d', '--description') ?? '';
  const name = args[0] ?? die('usage: spacehub space create <org> [-d <text>]');
  const { conn } = await open();
  await conn.reducers.createOrg({ name, description });
  const org = name.toLowerCase();
  out(`Created the org ${org}`);
  out(`\n  spacehub space member add ${org} <builder>\n  spacehub project create ${org}/<project> --source . --push`);
}

async function spaceList(args: string[]) {
  const who = args[0]?.toLowerCase();
  const { conn } = await open();
  const spaces = await snapshot(conn, tables.space, () => [...conn.db.space.iter()]);
  const counts = await snapshot(conn, tables.project, () => {
    const n = new Map<string, number>();
    for (const p of conn.db.project.iter()) n.set(p.owner, (n.get(p.owner) ?? 0) + 1);
    return n;
  });
  let shown = spaces;
  if (who) {
    const mine = await snapshot(conn, tables.spaceRole.where(r => r.member.eq(who)), () => new Set([...conn.db.spaceRole.iter()].filter(r => r.member === who).map(r => r.space)));
    shown = spaces.filter(s => s.name === who || mine.has(s.name) || (s.kind === 'agent' && (s.parent === who || mine.has(s.parent))));
  }
  if (shown.length === 0) {
    out(who ? `${who} belongs to no spaces` : 'no spaces yet');
    return;
  }
  const width = Math.max(...shown.map(s => s.name.length));
  for (const s of shown.sort((a, b) => a.name.localeCompare(b.name))) {
    const kind = s.kind === 'personal' ? 'builder' : s.kind;
    out(`${s.name.padEnd(width)}  ${kind.padEnd(7)}  ${String(counts.get(s.name) ?? 0).padStart(3)} projects  ${s.description}`.trimEnd());
  }
}

async function spaceView(args: string[]) {
  const target = await spaceOrProject(firstPositional(args));
  if ('project' in target) return projectView([target.project]);
  const sp = await requireHubSpace(target.space);
  const { conn } = await open();
  const roles = await spaceRoles(conn, sp.name);
  const projects = await projectsIn(conn, sp.name);
  out(`${sp.displayName || sp.name}${sp.displayName && sp.displayName !== sp.name ? ` (${sp.name})` : ''}`);
  if (sp.description) out(sp.description);
  out();
  out(`kind      ${sp.kind === 'personal' ? "a builder's personal space" : sp.kind === 'org' ? 'an org' : sp.kind}`);
  if (sp.kind === 'agent') out(`owned by  ${sp.parent}`);
  out(`created   ${when(sp.createdAt)} by ${sp.createdBy}`);
  const owners = sp.kind === 'personal' ? [sp.name] : roles.filter(r => r.role === 'owner').map(r => r.member);
  out(`owners    ${owners.join(', ') || (sp.kind === 'agent' ? `the owners of ${sp.parent}` : 'none')}`);
  out(`members   ${roles.filter(r => r.role === 'member').map(r => r.member).join(', ') || 'none'}`);
  const link = await snapshot(conn, tables.spaceLink.where(r => r.space.eq(sp.name)), () => [...conn.db.spaceLink.iter()].find(r => r.space === sp.name));
  if (link) {
    const synced = link.syncedAt.microsSinceUnixEpoch > 0n ? `synced ${when(link.syncedAt)}` : 'not synced yet';
    out(`github    ${link.source.replace('https://', '')} (${link.status === 'done' ? synced : link.status}: ${link.message})`);
  }
  const sizes = await projectSizes(conn);
  if (projects.length) out(`size      ${totalText(sizes, projects.map(p => p.id))} in ${projects.length} projects`);
  out();
  if (projects.length === 0) out('(no projects yet)');
  for (const p of projects) out(`${p.fullName}  ${sizeText(sizes, p.id)}  ${when(p.pushedAt)}  ${p.description}`.trimEnd());
}

async function spaceEdit(args: string[]) {
  const target = await spaceOrProject(firstPositional(args));
  if ('project' in target) return projectEdit(args);
  const description = opt(args, '--description', '-d') ?? die('nothing to change; pass --description');
  const { conn } = await open();
  await conn.reducers.editSpace({ space: target.space, description });
  out(`Updated ${target.space}`);
}

async function spaceDelete(args: string[]) {
  const target = await spaceOrProject(firstPositional(args) ?? die('usage: spacehub space delete <org> --yes'));
  if ('project' in target) return projectDelete(args);
  if (!bool(args, '--yes', '-y')) die(`this deletes the org ${target.space}; re-run with --yes`);
  const { conn } = await open();
  await conn.reducers.deleteOrg({ space: target.space });
  out(`Deleted ${target.space}`);
}

// space member add|remove <space> <name> [--owner], space member list <space>.
// Given a project (space/name, or one argument inside a clone), these are the
// project's collaborators, as before orgs.
async function spaceMember(args: string[]) {
  const sub = args[0];
  const owner = args.includes('--owner');
  const rest = args.slice(1).filter(a => a !== '--owner');
  const usage = 'usage: spacehub space member <add|remove> <space> <name> [--owner] | member list <space>';
  if (sub === 'list' || sub === 'ls') {
    const target = await spaceOrProject(rest[0]);
    if ('project' in target) return projectMember(['list', target.project]);
    const sp = await requireHubSpace(target.space);
    const { conn } = await open();
    const roles = await spaceRoles(conn, sp.name);
    const rows = sp.kind === 'personal' ? [{ member: sp.name, role: 'owner' }, ...roles] : roles;
    const width = Math.max(4, ...rows.map(r => r.member.length));
    for (const r of rows) out(`${r.member.padEnd(width)}  ${r.role}`);
    return;
  }
  if (sub !== 'add' && sub !== 'remove' && sub !== 'rm') die(usage);
  if (rest.length === 1) return projectMember([sub, rest[0]]);
  if (rest.length !== 2) die(usage);
  const target = await spaceOrProject(rest[0]);
  if ('project' in target) {
    if (owner) die('--owner is for spaces; a project has collaborators');
    return projectMember([sub, target.project, rest[1]]);
  }
  const member = rest[1].toLowerCase();
  const { conn } = await open();
  if (sub === 'add') {
    await conn.reducers.addSpaceMember({ space: target.space, member, role: owner ? 'owner' : 'member' });
    out(`${member} is ${owner ? 'an owner' : 'a member'} of ${target.space}`);
  } else {
    await conn.reducers.removeSpaceMember({ space: target.space, member });
    out(`${member} is no longer in ${target.space}`);
  }
}

// space link <space> <github account> | --sync | --remove
async function spaceLink(args: string[]) {
  const sync = bool(args, '--sync');
  const remove = bool(args, '--remove', '--unlink');
  const space = (args[0] ?? die('usage: spacehub space link <space> <github account> | --sync | --remove')).toLowerCase();
  const { conn } = await open();
  if (remove) {
    await conn.reducers.unlinkSpace({ space });
    out(`${space} no longer mirrors GitHub; its projects stay`);
    return;
  }
  if (sync) {
    await conn.reducers.requestSync({ space });
    out(`Asked the hub to sync ${space} from GitHub (spacehub space view ${space} shows how it went)`);
    return;
  }
  const login = githubLogin(args[1] ?? die('usage: spacehub space link <space> <github account>'));
  if (!login) die('link a GitHub user or organization, like anthropics or https://github.com/anthropics');
  await conn.reducers.linkSpace({ space, source: `https://github.com/${login}` });
  out(`${space} now mirrors github.com/${login}; the hub is importing its public repositories`);
  out(`(spacehub space view ${space} shows how it goes)`);
}

// space clone <space> [<dir>]: every project of the space, side by side.
// Given a project (space/name, or a bare name of yours), clones that project.
async function spaceClone(args: string[]) {
  const target = await spaceOrProject(firstPositional(args) ?? die('usage: spacehub space clone <space> [<dir>]'));
  if ('project' in target) return projectClone([target.project, ...args.slice(1)]);
  const { conn, server } = await open();
  const projects = await projectsIn(conn, target.space);
  const dir = path.resolve(args[1] ?? target.space);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) die(`${dir} already exists and is not empty`);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { hub: server, space: target.space, projects: [] as string[] };
  for (const p of projects) {
    await cloneProject(server, target.space, p.name, path.join(dir, p.name), p.defaultBranch);
    manifest.projects.push(p.name);
    out(`cloned ${p.fullName}`);
  }
  writeManifest(dir, manifest);
  out(`\n${target.space}: ${projects.length} projects in ${dir}`);
  out(`  cd ${path.relative(process.cwd(), dir) || '.'} && spacehub space sync --watch --auto   # keep them all current, editing together`);
}

// space sync in a folder made by space clone. Inside one project's clone (or
// given space/name), it syncs that project, as before.
async function spaceSync(args: string[]) {
  const named = firstPositional(args);
  const inProject = !named && (await projectRemote(opt([...args], '--remote', '-r')).catch(() => null));
  if (named?.includes('/')) die('a project syncs inside its clone: cd there and run spacehub project sync');
  if (inProject) return projectSync(args);
  const found = findManifest(process.cwd()) ?? die('not in a space folder (make one with: spacehub space clone <space>) nor in a project clone');
  if (named && named.toLowerCase() !== found.manifest.space) die(`this folder holds ${found.manifest.space}, not ${named}`);
  const auto = bool(args, '--auto');
  const watch = bool(args, '--watch', '-w') || auto;
  const interval = Number(opt(args, '--interval') ?? 3);
  if (!Number.isFinite(interval) || interval < 0.2 || interval > 3600) die('--interval is a number of seconds, from 0.2 to 3600');
  const agent = await username();
  const { conn, server } = await open();
  const space = found.manifest.space;
  const sync = new SpaceSync({
    conn,
    dir: found.dir,
    manifest: found.manifest,
    server,
    mode: auto ? 'auto' : watch ? 'watch' : 'once',
    intervalMs: interval * 1000,
    agent,
    restart: 'spacehub space sync --watch --auto',
    log: line => note(`${clock()}  ${line}`),
  });
  if (watch) {
    await announceSpace(space, auto ? 'autosync' : 'sync');
    note(`${auto ? 'Autosync' : 'Watching'} every project of ${space} in ${found.dir} (ctrl-c to stop)`);
    process.once('SIGINT', () => void sync.stop());
    process.once('SIGTERM', () => void sync.stop());
  }
  const allPaused = await sync.run();
  if (allPaused) throw new Exit(`every project of ${space} is paused; resolve them and start again`, 2);
  if (!watch) out(`${space}: every project is up to date`);
}

async function spaceWho(args: string[]) {
  const target = await spaceOrProject(firstPositional(args));
  if ('project' in target) return projectWho([target.project]);
  const { conn } = await open();
  const projects = new Map((await projectsIn(conn, target.space)).map(p => [p.id, p.name]));
  projects.set(0n, '(all projects)');
  const now = Date.now() * 1000;
  const rows = await snapshot(conn, tables.presence, () =>
    [...conn.db.presence.iter()].filter(
      r => (r.projectId === 0n ? r.space === target.space : projects.has(r.projectId)) && now - Number(r.seenAt.microsSinceUnixEpoch) <= 180_000_000
    )
  );
  if (rows.length === 0) {
    out(`nobody is connected to ${target.space} right now`);
    return;
  }
  const width = Math.max(...rows.map(r => r.agent.length));
  for (const r of rows.sort((a, b) => a.agent.localeCompare(b.agent))) {
    out(`${r.agent.padEnd(width)}  ${r.mode.padEnd(8)}  ${projects.get(r.projectId)}  ${r.branch || '-'}  since ${when(r.since)}`);
  }
}

// ---------------------------------------------------------------- agents

async function requireAgent(name: string) {
  const sp = await requireHubSpace(name);
  if (sp.kind !== 'agent') die(`"${name}" is ${sp.kind === 'personal' ? "a builder's personal space" : sp.kind === 'org' ? 'an org' : `a ${sp.kind}`}, not an agent`);
  return sp;
}

async function agentCreate(args: string[]) {
  const parentArg = opt(args, '--in');
  const description = opt(args, '-d', '--description') ?? '';
  const template = opt(args, '--template');
  const noHome = bool(args, '--no-home');
  const name = (args[0] ?? die('usage: spacehub agent create <name> [--in <space>] [-d <text>] [--template <git url>]')).toLowerCase();
  const parent = (parentArg ?? (await username())).toLowerCase();
  const { conn, server, database } = await open();
  // The agent's own identity: a fresh one, whose token the hub keeps for its owners.
  const minted = await connectTo(server, database, undefined);
  minted.conn.disconnect();
  await conn.reducers.createAgent({ name, parent, identity: minted.identity.toHexString(), token: minted.token, description });
  out(`Created agent ${name}, owned by ${parent}`);
  if (!noHome) {
    await conn.reducers.createProject({ space: name, name: 'home', description: `The definition of the agent ${name}` });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spacehub-agent-'));
    try {
      const repo = path.join(tmp, 'home');
      if (template) {
        const from = path.join(tmp, 'template');
        await runOrDie('git', ['clone', '-q', '--depth', '1', template, from]);
        const inner = fs.existsSync(path.join(from, 'workspace')) ? path.join(from, 'workspace') : from;
        fs.cpSync(inner, repo, { recursive: true, filter: src => path.basename(src) !== '.git' && path.basename(src) !== '.DS_Store' });
      } else {
        for (const [file, text] of Object.entries(agentTemplate(name, description))) {
          fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
          fs.writeFileSync(path.join(repo, file), text);
        }
      }
      const who = ['-c', `user.name=${await username()}`, '-c', `user.email=${await username()}@spacehub`];
      await git(['-C', repo, 'init', '-q', '-b', 'main']);
      await git(['-C', repo, 'add', '-A']);
      await git(['-C', repo, ...who, 'commit', '-q', '-m', `The agent ${name}`]);
      await git(['-C', repo, 'remote', 'add', REMOTE, hubUrl(server, `${name}/home`)]);
      await runOrDie('git', ['-C', repo, 'push', '-q', REMOTE, 'main']);
      out(`Its definition is in ${name}/home${template ? ` (from ${template})` : ''}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  out(`\n  spacehub agent connect ${name} <space>   # let it work in a space\n  spacehub agent run ${name}               # run it here; XO Swarm runs the same\n  spacehub agent token ${name}             # its token, for XO Swarm`);
}

async function agentRows(conn: Conn) {
  const agents = await snapshot(conn, tables.space.where(s => s.kind.eq('agent')), () => [...conn.db.space.iter()].filter(s => s.kind === 'agent'));
  const roles = await snapshot(conn, tables.spaceRole, () => [...conn.db.spaceRole.iter()]);
  const now = Date.now() * 1000;
  const here = await snapshot(conn, tables.presence, () => [...conn.db.presence.iter()].filter(p => p.mode === 'agent' && now - Number(p.seenAt.microsSinceUnixEpoch) <= 180_000_000));
  return agents
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(a => ({
      agent: a,
      connected: roles.filter(r => r.member === a.name).map(r => r.space).sort(),
      hosts: [...new Set(here.filter(p => p.agent === a.name).map(p => p.host || '?'))],
    }));
}

async function agentList(args: string[]) {
  const parent = args[0]?.toLowerCase();
  const { conn } = await open();
  const rows = (await agentRows(conn)).filter(r => !parent || r.agent.parent === parent || r.connected.includes(parent));
  if (rows.length === 0) {
    out(parent ? `no agents in ${parent}` : 'no agents yet');
    return;
  }
  const width = Math.max(...rows.map(r => r.agent.name.length));
  for (const r of rows) {
    const running = r.hosts.length ? `running on ${r.hosts.join(', ')}` : 'not running';
    out(`${r.agent.name.padEnd(width)}  owned by ${r.agent.parent}  connected to ${r.connected.join(', ') || 'nothing'}  ${running}`);
  }
}

async function agentView(args: string[]) {
  const name = (args[0] ?? die('usage: spacehub agent view <agent>')).toLowerCase();
  await requireAgent(name);
  await spaceView([name]);
  const { conn } = await open();
  const row = (await agentRows(conn)).find(r => r.agent.name === name);
  out();
  out(`connected ${row?.connected.join(', ') || 'nothing yet (spacehub agent connect ' + name + ' <space>)'}`);
  out(`running   ${row?.hosts.length ? row.hosts.join(', ') : 'no'}`);
}

async function agentConnect(args: string[], connect: boolean) {
  const [agent, space] = args.map(a => a.toLowerCase());
  if (!agent || !space) die(`usage: spacehub agent ${connect ? 'connect' : 'disconnect'} <agent> <space>`);
  const { conn } = await open();
  if (connect) {
    await conn.reducers.connectAgent({ agent, space });
    out(`${agent} is connected to ${space} and can push to its projects`);
  } else {
    await conn.reducers.disconnectAgent({ agent, space });
    out(`${agent} is no longer connected to ${space}`);
  }
}

async function fetchAgentToken(name: string) {
  const { conn } = await open();
  return conn.procedures.agentToken({ agent: name });
}

async function agentToken(args: string[]) {
  const name = (args[0] ?? die('usage: spacehub agent token <agent>')).toLowerCase();
  await requireAgent(name);
  out(await fetchAgentToken(name));
}

async function agentDelete(args: string[]) {
  const yes = bool(args, '--yes', '-y');
  const name = (args[0] ?? die('usage: spacehub agent delete <agent> --yes')).toLowerCase();
  await requireAgent(name);
  if (!yes) die(`this deletes the agent ${name} and its own projects; re-run with --yes`);
  const { conn } = await open();
  for (const p of await projectsIn(conn, name)) await conn.reducers.deleteProject({ project: p.fullName });
  await conn.reducers.deleteAgent({ name });
  out(`Deleted ${name}`);
}

async function agentRun(args: string[]) {
  const interval = Number(opt(args, '--interval') ?? 3);
  const host = opt(args, '--host') ?? os.hostname();
  if (!Number.isFinite(interval) || interval < 0.2 || interval > 3600) die('--interval is a number of seconds, from 0.2 to 3600');
  const name = (args[0] ?? die('usage: spacehub agent run <agent> [<dir>]')).toLowerCase();
  const dir = path.resolve(args[1] ?? name);
  const { conn, identity, server, database } = await open();
  await requireAgent(name);
  // Logged in as the agent itself (XO Swarm), or as one of its owners.
  const self = await snapshot(conn, tables.agent.where(a => a.name.eq(name)), () => [...conn.db.agent.iter()].find(a => a.name === name));
  const token = self?.identity.isEqual(identity) ? loadConfig().token! : await fetchAgentToken(name);
  if (!token) die(`no token for ${name}`);
  note(`Running ${name} in ${dir} on ${host} (ctrl-c to stop)`);
  await new AgentRun({ server, db: database, token, agent: name, dir, intervalMs: interval * 1000, host, log: line => note(`${clock()}  ${line}`) }).run();
  note(`${name} stopped`);
}

// ---------------------------------------------------------------- doctor

// Who owns a space: a builder owns its personal space, an agent belongs to
// the owners of the space it was made in, an org has owner roles.
async function ownersOf(conn: Conn, name: string, depth = 0): Promise<string[]> {
  const sp = await findSpace(conn, name);
  if (!sp) return [];
  if (sp.kind === 'personal') return [sp.name];
  if (sp.kind === 'agent') return depth < 4 ? ownersOf(conn, sp.parent, depth + 1) : [];
  return (await spaceRoles(conn, name)).filter(r => r.role === 'owner').map(r => r.member);
}

// A permission refusal, followed by who is signed in and who could do it.
// Anything else (or a hub that cannot be asked) adds nothing.
async function refusalHelp(message: string): Promise<string[]> {
  const spaces = spacesNamed(message);
  if (!spaces.length || !session) return [];
  const { conn, identity, server } = session;
  const ask = async () => {
    const user = await findUser(conn, identity);
    const owners = await Promise.all(spaces.map(async space => ({ space, owners: await ownersOf(conn, space) })));
    return permissionHelp(user?.username ?? null, server, owners);
  };
  const late = new Promise<string[]>(resolve => setTimeout(() => resolve([]), 5_000).unref());
  return Promise.race([ask().catch(() => []), late]);
}

async function doctor() {
  const cfg = loadConfig();
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bin = binDir(packageDir, process.argv[1] ?? packageDir);
  const checks: Check[] = [
    { name: 'CLI', level: 'ok', text: `spacehub ${VERSION} (protocol ${PROTOCOL}) in ${packageDir}` },
    pathCheck(bin, findOnPath('spacehub', process.env.PATH ?? ''), process.env.SHELL),
    restartCheck(fs.realpathSync(packageDir), os.homedir(), os.tmpdir()),
  ];
  // The hub check connects without saving a token, so doctor never signs you up.
  let account: Account | null = null;
  try {
    const { conn, identity } = await connectTo(cfg.server, cfg.database, cfg.token);
    session = { conn, identity, server: cfg.server, database: cfg.database };
    checks.push(hubCheck(cfg.server, PROTOCOL, await hubProtocol(conn), null));
    if (cfg.token) {
      const user = await findUser(conn, identity);
      account = { builder: user?.username ?? null, owner: [], member: [] };
      if (user) {
        const name = user.username;
        const roles = await snapshot(conn, tables.spaceRole.where(r => r.member.eq(name)), () =>
          [...conn.db.spaceRole.iter()].filter(r => r.member === name).sort((a, b) => a.space.localeCompare(b.space))
        );
        account.owner = [name, ...roles.filter(r => r.role === 'owner').map(r => r.space)];
        account.member = roles.filter(r => r.role !== 'owner').map(r => r.space);
      }
    }
  } catch (err) {
    checks.push(hubCheck(cfg.server, PROTOCOL, null, errorMessage(err)));
  }
  checks.push(accountCheck(cfg.server, !!cfg.token, account));
  out(report(checks));
  if (checks.some(c => c.level === 'fail')) throw new Exit('', 1);
}

// ---------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const group = args.shift();
  const sub = args.shift();

  if (!group || group === 'help' || group === '--help' || group === '-h') return out(HELP);
  if (group === '--version' || group === 'version') return out(`spacehub ${VERSION} (protocol ${PROTOCOL})`);
  if (group === 'doctor') return doctor();

  if (group === 'auth') {
    switch (sub) {
      case 'login': return authLogin(args);
      case 'status': return authStatus();
      case 'token': return authToken();
      case 'logout': return authLogout(args);
      case 'delete': return authDelete(args);
    }
    die(`usage: spacehub auth <login|status|token|logout|delete>`);
  }

  const following = (sub: string | undefined) => sub === 'watch' || (sub === 'sync' && args.some(a => ['--watch', '-w', '--auto'].includes(a)));

  if (group === 'project' || group === 'repo') {
    longLived = following(sub);
    switch (sub) {
      case 'create': return projectCreate(args);
      case 'list': case 'ls': return projectList(args);
      case 'view': return projectView(args);
      case 'clone': return projectClone(args);
      case 'edit': return projectEdit(args);
      case 'delete': return projectDelete(args);
      case 'sync': return projectSync(args);
      case 'watch': return projectWatch(args);
      case 'who': return projectWho(args);
      case 'member': case 'members': return projectMember(args);
    }
    die(`usage: spacehub project <create|list|view|clone|edit|delete|sync|watch|who|member>`);
  }

  if (group === 'agent' || group === 'agents') {
    longLived = sub === 'run';
    switch (sub) {
      case 'create': return agentCreate(args);
      case 'list': case 'ls': return agentList(args);
      case 'view': return agentView(args);
      case 'connect': return agentConnect(args, true);
      case 'disconnect': return agentConnect(args, false);
      case 'token': return agentToken(args);
      case 'run': return agentRun(args);
      case 'delete': return agentDelete(args);
    }
    die(`usage: spacehub agent <create|list|view|connect|disconnect|token|run|delete>`);
  }

  if (group === 'space') {
    longLived = following(sub);
    switch (sub) {
      case 'create': return spaceCreate(args);
      case 'list': case 'ls': return spaceList(args);
      case 'view': return spaceView(args);
      case 'edit': return spaceEdit(args);
      case 'delete': return spaceDelete(args);
      case 'member': case 'members': return spaceMember(args);
      case 'clone': return spaceClone(args);
      case 'who': return spaceWho(args);
      case 'link': return spaceLink(args);
      case 'sync': return spaceSync(args);
      // Run inside a project's clone, as before.
      case 'watch': return projectWatch(args);
    }
    die(`usage: spacehub space <create|list|view|edit|delete|member|link|clone|sync|who>`);
  }

  if (group === 'collab' || group === 'chat') {
    longLived = sub === 'watch';
    switch (sub) {
      case 'post': case 'say': return collabPost(args);
      case 'read': case 'log': return collabRead(args);
      case 'state': return collabState(args);
      case 'watch': return collabWatch(args);
      case 'task': return collabTask(args, false);
      case 'handoff': return collabTask(args, true);
    }
    die(`usage: spacehub collab <post|read|state|watch|task|handoff>`);
  }

  die(`unknown command "${group}"; see spacehub help`);
}

main()
  .then(() => {
    session?.conn.disconnect();
    process.exit(0);
  })
  .catch(async err => {
    const message = err instanceof Usage || err instanceof Exit ? err.message : errorMessage(err);
    if (message) note(`spacehub: ${message}`);
    for (const line of await refusalHelp(message)) note(`  ${line}`);
    session?.conn.disconnect();
    process.exit(err instanceof Exit ? err.status : 1);
  });
