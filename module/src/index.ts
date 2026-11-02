// spacehub: GitHub-shaped git hosting where the database is the server.
//
// The hub has GitHub's two levels. Every top-level name is a space (like a
// GitHub user or organization), and spaces hold projects (repositories),
// addressed as "space/project":
//
//   user            a builder: a person's login, one identity per name
//   space           the top-level names: a builder's personal space, an org,
//                   or an agent
//   space_role      owners and members of a space
//   project         a repository; `owner` is its space
//   git_ref         branch and tag pointers of a project (refs/heads/main -> oid)
//   git_object      content-addressed git objects of a project
//   object_chunk    bodies of objects larger than one chunk, split in order
//   project_member  collaborators on one project
//   presence        which connected clients follow which project right now
//   project_size    how many bytes of git objects each project stores
//   agent           an agent: a space of its own, with its own identity
//   agent_secret    (private) an agent's token, for its owners to launch it with
//   space_link      the GitHub user or organization a space mirrors
//   ref_sync        where GitHub had each mirrored ref at the last sync
//
// A database from before these names (when `space` held repositories) cannot
// take this schema, since SpacetimeDB renames neither tables nor columns. The
// server moves such a database aside and starts a new one (see
// docker/server-entrypoint.sh).
//
// Reducers are the only write path, so every push is checked here: the
// caller must own or belong to the project's space (or collaborate on the
// project), every object must hash to its id, and a ref only moves if the
// caller saw its current value (compare-and-swap) and, unless forced, the
// move is a fast-forward.
import { schema, table, t, Router, SenderError, SyncResponse, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { Identity, Timestamp } from 'spacetimedb';
import { Sha1, objectHeader } from './sha1';
import { CHUNK_SIZE, PRESENCE_STALE_SECONDS, commitParents, inSpace, memberKey, objectKey, ownsSpace, readObject, refKey, roleKey } from './store';
import { renderUi } from './ui';
import { ApiError, parseCommit, parseQuery, parseTree, renderApi, templateFiles } from './workspace';
import { appendTurns, editFiles, readFileAt, type FileChange, type NewObject } from './chat';
import { commitFiles, instantiate } from './space';
import { BUILTIN_TEMPLATE } from './spacetemplate';
import { OLDEST_PROTOCOL, PROTOCOL } from './protocol';
import { CHAT_FILE, CHAT_PATH, COLLAB_DIR, LOG_PATH, STATE_PATH, applyPost, parseState, postFiles, type Author, type PostIn } from './collab';
import { COWORK_CHAT_PATH, coworkChatFile, COWORK_LOG_PATH, COWORK_STATE_PATH, applyCoworkPost, coworkPostFiles, parseCoworkState, type CoworkPostIn } from './cowork';

const MAX_OBJECT_SIZE = 100 * 1024 * 1024;
// Fetch windows are cut on `pos`, a running total of row weights per project.
const ROW_OVERHEAD = 64;

const user = table(
  { name: 'user', public: true },
  {
    identity: t.identity().primaryKey(),
    username: t.string().unique(),
    createdAt: t.timestamp(),
  }
);

const project = table(
  { name: 'project', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    fullName: t.string().unique(),
    owner: t.string().index('btree'),
    ownerIdentity: t.identity(),
    name: t.string(),
    description: t.string(),
    defaultBranch: t.string(),
    objectCount: t.u64(),
    objectPos: t.u64(),
    createdAt: t.timestamp(),
    pushedAt: t.timestamp(),
  }
);

const gitRef = table(
  { name: 'git_ref', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    key: t.string().unique(),
    projectId: t.u64().index('btree'),
    name: t.string(),
    oid: t.string(),
    updatedAt: t.timestamp(),
    updatedBy: t.identity(),
  }
);

const gitObject = table(
  {
    name: 'git_object',
    public: true,
    indexes: [{ accessor: 'byProjectPos', algorithm: 'btree', columns: ['projectId', 'pos'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    key: t.string().unique(),
    projectId: t.u64(),
    pos: t.u64(),
    oid: t.string(),
    kind: t.string(),
    size: t.u64(),
    chunks: t.u32(),
    data: t.byteArray(),
  }
);

const objectChunk = table(
  {
    name: 'object_chunk',
    public: true,
    indexes: [{ accessor: 'byProjectOid', algorithm: 'btree', columns: ['projectId', 'oid'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    key: t.string().unique(),
    projectId: t.u64(),
    oid: t.string(),
    idx: t.u32(),
    data: t.byteArray(),
  }
);

// Where a project was imported from (GitHub) and how the last import went.
// Written by the web service on behalf of the project's space owner.
const projectImport = table(
  { name: 'project_import', public: true },
  {
    projectId: t.u64().primaryKey(),
    source: t.string(),
    status: t.string(), // running | done | failed
    message: t.string(),
    startedAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

// The GitHub account that built a project's code (its builder). Set on
// GitHub imports, or by hand. Projects without a row are credited to their
// import source's GitHub owner, else to the builder who made them here.
const projectBuilder = table(
  { name: 'project_builder', public: true },
  {
    projectId: t.u64().primaryKey(),
    handle: t.string().index('btree'), // GitHub login, lowercase
    name: t.string(), // display name ("Anthropic" for anthropics)
    url: t.string(), // https://github.com/<login>
  }
);

// The hub's activity feed: every change, oldest first. Pages sort by `at`.
const activity = table(
  { name: 'activity', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.timestamp().index('btree'),
    projectId: t.u64().index('btree'), // the project; 0 for events about a space (an org, a builder joining)
    path: t.string(), // space/project at the time, or the space's name; kept after a delete
    agent: t.string(), // who did it: a builder (or an agent)
    kind: t.string(), // agent_registered (a builder joined), project_created, org_created, ref_updated, ...
    subject: t.string(), // ref name, GitHub source or builder login
    oid: t.string(), // commit or tag the event points at
    count: t.u32(), // new commits in a push, or refs in an import
    text: t.string(), // commit subject, import message, builder name, what changed
  }
);

// Collaborators on one project, besides its space's owners and members
// (GitHub's repository collaborators). Its space's owners add and remove
// them; a collaborator can also leave.
const projectMember = table(
  { name: 'project_member', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    key: t.string().unique(), // "<projectId>:<builder>"
    projectId: t.u64().index('btree'), // the project
    agent: t.string().index('btree'), // the collaborator
    addedBy: t.string(),
    addedAt: t.timestamp(),
  }
);

// The hub's top-level names, like GitHub's users and organizations: every
// /<name> is a space. A builder has a personal space of the same name, an
// org collects projects for several builders, and an agent is a space too.
// Agents, builders and orgs share these names.
const space = table(
  { name: 'space', public: true },
  {
    name: t.string().primaryKey(), // lowercase, a valid GitHub login
    kind: t.string().index('btree'), // personal | org | agent
    displayName: t.string(), // as written, e.g. a GitHub organization's case
    description: t.string(),
    parent: t.string(), // the space that owns an agent; "" otherwise
    createdBy: t.string(),
    createdAt: t.timestamp(),
  }
);

// Who belongs to a space. Owners manage it (members, links, deletes); members
// push to every project in it and create projects. A personal space's owner
// is its builder, and an agent's owners are its parent space's owners, with
// no row for either.
const spaceRole = table(
  { name: 'space_role', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    key: t.string().unique(), // "<space>:<member>"
    space: t.string().index('btree'),
    member: t.string().index('btree'), // a builder or an agent
    role: t.string(), // owner | member
    addedBy: t.string(),
    addedAt: t.timestamp(),
  }
);

// One row per client connection that said which project (watchProject) or
// whole space (watchSpace) it follows: `project watch`, `project sync --watch`,
// autosync, `space sync` and running agents. The row goes with the connection
// (clientDisconnected). Clients repeat the call as a heartbeat; a row whose
// heartbeat stopped belongs to a connection the server never saw close, and
// is swept when the next client connects.
const presence = table(
  { name: 'presence', public: true },
  {
    connectionId: t.connectionId().primaryKey(),
    projectId: t.u64().index('btree'), // the project; 0 when following a whole space
    agent: t.string(),
    mode: t.string(), // watch | sync | autosync | agent
    branch: t.string(), // what sync and autosync keep current ("" for watch)
    since: t.timestamp(),
    seenAt: t.timestamp(),
    space: t.string(), // the project's space, or the space followed whole
    host: t.string(), // where a running agent runs, as it says
  }
);

// How much a project stores: the bytes of its git objects as git counts them
// (uncompressed), kept as objects arrive. Every project has a row from the
// start.
const projectSize = table(
  { name: 'project_size', public: true },
  {
    projectId: t.u64().primaryKey(),
    bytes: t.u64(),
  }
);

// An agent is a space (space kind "agent") with an identity of its own:
// it pushes as itself to its own projects and to the spaces it is connected
// to (as a member there). Its owners are its parent space's owners. XO Swarm
// launches it with `spacehub agent run`, which needs its token.
const agent = table(
  { name: 'agent', public: true },
  {
    name: t.string().primaryKey(),
    identity: t.identity().unique(),
    createdBy: t.string(),
    createdAt: t.timestamp(),
  }
);

// Private: only the module reads it, for the agent's owners (agentToken).
const agentSecret = table({ name: 'agent_secret' }, { name: t.string().primaryKey(), token: t.string() });

// The GitHub account (user or organization) a space mirrors: its public
// repositories become projects with the same names, kept in step by the
// web service, which syncs as the hub admin. GitHub to hub only.
const spaceLink = table(
  { name: 'space_link', public: true },
  {
    space: t.string().primaryKey(),
    source: t.string(), // https://github.com/<login>
    status: t.string(), // requested | running | done | failed
    message: t.string(),
    requestedAt: t.timestamp(),
    updatedAt: t.timestamp(),
    syncedAt: t.timestamp(), // the last sync that finished (the epoch before one has)
    projects: t.u32(), // repositories mirrored at the last sync
  }
);

// Where GitHub had each ref of a mirrored project at the last sync. A ref
// that still holds that value has no work done here, so it follows GitHub,
// force pushes included; a ref that moved here only moves forward, and is
// left alone and marked diverged when GitHub went another way.
const refSync = table(
  { name: 'ref_sync', public: true },
  {
    key: t.string().primaryKey(), // "<projectId>:<ref>"
    projectId: t.u64().index('btree'),
    ref: t.string(),
    githubOid: t.string(),
    status: t.string(), // synced | diverged
    at: t.timestamp(),
  }
);

// The hub's settings: who its admin is ("admin") and where accounts come from
// ("accounts": "github" for sign-up with GitHub, "xo" once xo makes them;
// no row is open sign-up).
const hubState = table({ name: 'hub_state' }, { key: t.string().primaryKey(), value: t.string() });

// What xo.quirq.dev keeps for each xo user (Clerk only says who they are):
// their projects, spaces and invites, as one JSON document per Clerk user id.
// Private: only the admin (the server's own web service, for xo.quirq.dev)
// reads or writes it. `version` moves by one on every write, and a write must
// name the version it read (compare-and-swap).
const xoRecord = table(
  { name: 'xo_record' },
  {
    subject: t.string().primaryKey(),
    doc: t.string(),
    version: t.u64(),
    updatedAt: t.timestamp(),
  }
);

// The hub agent that xo made for a Clerk user: its name is the user's xo
// username, and its token is handed back to that user's xo on every machine.
// Private, like xo_record.
const xoAgent = table(
  { name: 'xo_agent' },
  {
    subject: t.string().primaryKey(),
    username: t.string().unique(),
    identity: t.identity().unique(),
    token: t.string(),
    createdAt: t.timestamp(),
  }
);

// Builders who signed up with GitHub: the GitHub account (by its id, which
// stays when the login is renamed), and the hub token the web service hands
// back whenever that account signs in again, on any machine. Private: only
// the admin (the server's own web service) reads or writes it.
const githubAccount = table(
  { name: 'github_account' },
  {
    githubId: t.u64().primaryKey(),
    login: t.string(), // the GitHub login at sign-up
    username: t.string().unique(),
    identity: t.identity().unique(),
    token: t.string(),
    createdAt: t.timestamp(),
  }
);

const spacetimedb = schema({
  user,
  project,
  gitRef,
  gitObject,
  objectChunk,
  projectImport,
  projectBuilder,
  activity,
  projectMember,
  presence,
  space,
  spaceRole,
  spaceLink,
  refSync,
  projectSize,
  agent,
  agentSecret,
  hubState,
  xoRecord,
  xoAgent,
  githubAccount,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type Project = NonNullable<ReturnType<Ctx['db']['project']['fullName']['find']>>;
type GitRef = NonNullable<ReturnType<Ctx['db']['gitRef']['key']['find']>>;

const ObjectIn = t.object('ObjectIn', {
  oid: t.string(),
  kind: t.string(),
  data: t.byteArray(),
});

// Space names (builders, orgs, agents) are GitHub logins, lowercased,
// so any GitHub user or organization has the same name here.
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
// First path segments the server's proxy needs for itself.
const RESERVED_USERNAMES = new Set(['v1', 'healthz']);
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// Project names are GitHub repository names.
const PROJECT_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const OID = /^[0-9a-f]{40}$/;
const KINDS = new Set(['commit', 'tree', 'blob', 'tag']);
const ZERO_OID = '';
const REMOTE_HINT = 'quirq';

// The hub admin acting for a space that mirrors GitHub (the web service's
// sync). Shown in the activity feed as "GitHub sync".
const SYNCER = '-github';

function isAdmin(ctx: Ctx) {
  return ctx.db.hubState.key.find('admin')?.value === ctx.sender.toHexString();
}

function isSyncer(ctx: Ctx, space: string) {
  return isAdmin(ctx) && !!ctx.db.spaceLink.space.find(space);
}

function requireUser(ctx: Ctx) {
  const me = ctx.db.user.identity.find(ctx.sender);
  if (!me) throw new SenderError('no builder name yet: run spacehub auth login --builder <name>');
  return me;
}

// Who is calling: a builder's name, an agent's name, or null.
function actorName(ctx: Ctx): string | null {
  return ctx.db.user.identity.find(ctx.sender)?.username ?? ctx.db.agent.identity.find(ctx.sender)?.name ?? null;
}

function requireActor(ctx: Ctx): string {
  const me = actorName(ctx);
  if (!me) throw new SenderError('no builder or agent name for this identity: run spacehub auth login --builder <name>');
  return me;
}

function requireSpace(ctx: Ctx, name: string) {
  const row = ctx.db.space.name.find(name);
  if (!row) throw new SenderError(`no space named "${name}"`);
  return row;
}

const isOwner = (ctx: Ctx, space: string, actor: string | null) => ownsSpace(ctx.db, space, actor);
const isMember = (ctx: Ctx, space: string, actor: string | null) => inSpace(ctx.db, space, actor);

function requireSpaceOwner(ctx: Ctx, space: string) {
  const row = requireSpace(ctx, space);
  if (!isOwner(ctx, space, actorName(ctx))) throw new SenderError(`permission denied: only owners of "${space}" can do this`);
  return row;
}

function requireProject(ctx: Ctx, fullName: string) {
  const row = ctx.db.project.fullName.find(fullName);
  if (!row) throw new SenderError(`project "${fullName}" not found`);
  return row;
}

// Owner-only actions on a project: edits, imports, builder credits,
// collaborators, delete. The owners of its space.
function requireProjectAdmin(ctx: Ctx, fullName: string) {
  const row = requireProject(ctx, fullName);
  if (!isOwner(ctx, row.owner, actorName(ctx)) && !isSyncer(ctx, row.owner)) {
    throw new SenderError(`permission denied: only owners of "${row.owner}" can change "${fullName}"`);
  }
  return row;
}

// Who may push to a project: its space's owners and members, and its
// collaborators (builders, and agents they brought).
function canWrite(ctx: Ctx, sp: { id: bigint; owner: string }, name: string | null) {
  return isMember(ctx, sp.owner, name) || (!!name && !!ctx.db.projectMember.key.find(memberKey(sp.id, name)));
}

// Pushes: the space's owners and members, and the project's collaborators.
function requireWritable(ctx: Ctx, fullName: string) {
  const row = requireProject(ctx, fullName);
  const me = actorName(ctx);
  if (canWrite(ctx, row, me) || isSyncer(ctx, row.owner)) return row;
  throw new SenderError(`permission denied: you are not an owner or member of "${row.owner}", nor a collaborator on "${fullName}"`);
}

function validRefName(name: string) {
  if (!name.startsWith('refs/') || name.length > 255) return false;
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return !name.split('/').some(part => part === '' || part.startsWith('.'));
}

const textDecoder = new TextDecoder('utf-8');
const IMPORT_STALE_MICROS = 3_600_000_000n;

interface ActivityIn {
  kind: string;
  at?: Timestamp;
  projectId?: bigint;
  path?: string;
  agent?: string;
  subject?: string;
  oid?: string;
  count?: number;
  text?: string;
}

function logActivity(ctx: Ctx, e: ActivityIn) {
  ctx.db.activity.insert({
    id: 0n,
    at: e.at ?? ctx.timestamp,
    projectId: e.projectId ?? 0n,
    path: e.path ?? '',
    agent: e.agent ?? actorName(ctx) ?? (isAdmin(ctx) ? SYNCER : ''),
    kind: e.kind,
    subject: e.subject ?? '',
    oid: e.oid ?? '',
    count: e.count ?? 0,
    text: (e.text ?? '').slice(0, 300),
  });
}

// While a GitHub import runs its many ref updates are not logged one by
// one; the import's own events summarize them.
function importing(ctx: Ctx, projectId: bigint) {
  const row = ctx.db.projectImport.projectId.find(projectId);
  return !!row && row.status === 'running' && ctx.timestamp.microsSinceUnixEpoch - row.updatedAt.microsSinceUnixEpoch < IMPORT_STALE_MICROS;
}

// First line of a commit's (or annotated tag's) message.
function subjectOf(ctx: Ctx, projectId: bigint, oid: string) {
  const obj = readObject(ctx.db, projectId, oid);
  if (!obj) return '';
  const text = textDecoder.decode(obj.data.subarray(0, 64 * 1024));
  const split = text.indexOf('\n\n');
  return split >= 0 ? text.slice(split + 2).split('\n')[0].slice(0, 200) : '';
}

// Commits from `from` back to `to` along first parents (0 when unknown).
function firstParentDistance(ctx: Ctx, projectId: bigint, from: string, to: string, cap = 1000) {
  let oid = from;
  for (let n = 0; n < cap; n++) {
    if (oid === to) return n;
    const obj = readObject(ctx.db, projectId, oid);
    if (!obj || obj.kind !== 'commit') return 0;
    const parent = commitParents(obj.data)[0];
    if (!parent) return 0;
    oid = parent;
  }
  return 0;
}

function isAncestor(ctx: Ctx, projectId: bigint, ancestor: string, tip: string): boolean {
  const seen = new Set<string>([tip]);
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (oid === ancestor) return true;
    const obj = readObject(ctx.db, projectId, oid);
    if (!obj || obj.kind !== 'commit') continue;
    for (const parent of commitParents(obj.data)) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

// Count `bytes` more for a project that is already counted.
function grow(ctx: Ctx, projectId: bigint, bytes: bigint) {
  const row = ctx.db.projectSize.projectId.find(projectId);
  if (row && bytes > 0n) ctx.db.projectSize.projectId.update({ ...row, bytes: row.bytes + bytes });
}

function insertObject(ctx: Ctx, sp: { id: bigint; objectCount: bigint; objectPos: bigint }, oid: string, kind: string, size: number, chunks: number, data: Uint8Array) {
  sp.objectCount += 1n;
  sp.objectPos += BigInt(data.length + ROW_OVERHEAD);
  ctx.db.gitObject.insert({
    id: 0n,
    key: objectKey(sp.id, oid),
    projectId: sp.id,
    pos: sp.objectPos,
    oid,
    kind,
    size: BigInt(size),
    chunks,
    data,
  });
}

// A new top-level name: free across builders, orgs and agents.
function checkSpaceName(ctx: Ctx, name: string) {
  if (!USERNAME.test(name)) {
    throw new SenderError('a name is 1-39 lowercase letters, digits or inner hyphens');
  }
  if (RESERVED_USERNAMES.has(name)) throw new SenderError(`the name "${name}" is reserved`);
  if (ctx.db.user.username.find(name) || ctx.db.space.name.find(name)) throw new SenderError(`the name "${name}" is taken`);
}

// A builder's login and its personal space.
function addBuilder(ctx: Ctx, identity: Identity, username: string) {
  checkSpaceName(ctx, username);
  ctx.db.user.insert({ identity, username, createdAt: ctx.timestamp });
  ctx.db.space.insert({ name: username, kind: 'personal', displayName: username, description: '', parent: '', createdBy: username, createdAt: ctx.timestamp });
  logActivity(ctx, { kind: 'agent_registered', agent: username });
}

// Where builders come from: "open" (anyone registers a name), "github" (sign
// up with a GitHub account, through the web service) or "xo".
function accounts(ctx: Ctx) {
  return ctx.db.hubState.key.find('accounts')?.value ?? 'open';
}

export const registerUser = spacetimedb.reducer({ username: t.string() }, (ctx, { username }) => {
  const source = accounts(ctx);
  if (source === 'xo') throw new SenderError('builders on this hub are made by xo: run xo login');
  if (source === 'github') {
    throw new SenderError('builders on this hub sign up with GitHub: log in with gh auth login, then run spacehub auth login');
  }
  const existing = ctx.db.user.identity.find(ctx.sender);
  if (existing) throw new SenderError(`this identity is already the builder "${existing.username}"`);
  const agent = ctx.db.agent.identity.find(ctx.sender);
  if (agent) throw new SenderError(`this identity is the agent "${agent.name}"`);
  addBuilder(ctx, ctx.sender, username);
});

// A builder leaves the hub: its login, its personal space, its places in
// other spaces, and every record of it in the activity feed. Its projects
// and agents go first (spacehub auth delete deletes them), and it cannot be
// the last owner of an org. Its name is free again afterwards.
export const deleteBuilder = spacetimedb.reducer(ctx => {
  const name = requireUser(ctx).username;
  const projects = [...ctx.db.project.owner.filter(name)].length;
  if (projects) throw new SenderError(`${name} still has ${projects} projects; delete them first`);
  const agents = [...ctx.db.space.kind.filter('agent')].filter(a => a.parent === name).map(a => a.name);
  if (agents.length) throw new SenderError(`${name} still owns the agents ${agents.join(', ')}; delete them first`);
  const roles = [...ctx.db.spaceRole.member.filter(name)];
  for (const r of roles) {
    if (r.role === 'owner' && [...ctx.db.spaceRole.space.filter(r.space)].filter(o => o.role === 'owner').length === 1) {
      throw new SenderError(`${name} is the last owner of "${r.space}"; add another owner first`);
    }
  }
  for (const r of roles) ctx.db.spaceRole.id.delete(r.id);
  // Its personal space goes as an org does (deleteOrg): the members it
  // added, its GitHub link and whoever follows it, so a builder who takes the
  // name later starts with none of them.
  for (const r of [...ctx.db.spaceRole.space.filter(name)]) ctx.db.spaceRole.id.delete(r.id);
  ctx.db.spaceLink.space.delete(name);
  for (const m of [...ctx.db.projectMember.agent.filter(name)]) ctx.db.projectMember.id.delete(m.id);
  for (const p of [...ctx.db.presence.iter()]) {
    if (p.agent === name || p.space === name || p.space.startsWith(`${name}/`)) ctx.db.presence.connectionId.delete(p.connectionId);
  }
  const about = new Set(['space_member_added', 'space_member_removed', 'project_member_added', 'project_member_removed']);
  for (const e of [...ctx.db.activity.iter()]) {
    const mine = e.agent === name || e.path === name || e.path.startsWith(`${name}/`) || (about.has(e.kind) && e.subject === name);
    if (mine) ctx.db.activity.id.delete(e.id);
  }
  const xo = [...ctx.db.xoAgent.iter()].find(a => a.username === name);
  if (xo) ctx.db.xoAgent.subject.delete(xo.subject);
  ctx.db.githubAccount.username.delete(name);
  ctx.db.space.name.delete(name);
  ctx.db.user.identity.delete(ctx.sender);
});

// ---------------------------------------------------------------- admin and xo

// The first identity to call this becomes the hub's admin, for good. The
// server's entrypoint calls it right after publishing, as the identity that
// owns the database, and refuses to start if someone else holds it.
export const claimAdmin = spacetimedb.reducer(ctx => {
  const admin = ctx.db.hubState.key.find('admin');
  if (admin) {
    if (admin.value !== ctx.sender.toHexString()) throw new SenderError('the hub admin is already another identity');
    return;
  }
  ctx.db.hubState.insert({ key: 'admin', value: ctx.sender.toHexString() });
});

function requireAdmin(ctx: Ctx) {
  if (ctx.db.hubState.key.find('admin')?.value !== ctx.sender.toHexString()) {
    throw new SenderError('permission denied: only the hub admin can do this');
  }
}

// "open": anyone can register a name; "github": builders sign up with a
// GitHub account and get its login as their name; "xo": only xo makes them.
export const setAccounts = spacetimedb.reducer({ source: t.string() }, (ctx, { source }) => {
  requireAdmin(ctx);
  if (source !== 'xo' && source !== 'open' && source !== 'github') throw new SenderError('accounts are "open", "github" or come from "xo"');
  const row = ctx.db.hubState.key.find('accounts');
  if (row) ctx.db.hubState.key.update({ ...row, value: source });
  else ctx.db.hubState.insert({ key: 'accounts', value: source });
});

// Clerk user ids, as Clerk writes them (user_2abc...).
const XO_SUBJECT = /^[A-Za-z0-9_]{1,64}$/;
const MAX_XO_DOC = 256 * 1024;

function checkSubject(subject: string) {
  if (!XO_SUBJECT.test(subject)) throw new SenderError(`invalid xo user id "${subject}"`);
}

export const xoPutRecord = spacetimedb.reducer(
  { subject: t.string(), version: t.u64(), doc: t.string() },
  (ctx, { subject, version, doc }) => {
    requireAdmin(ctx);
    checkSubject(subject);
    if (doc.length > MAX_XO_DOC) throw new SenderError(`record is larger than ${MAX_XO_DOC} bytes`);
    try {
      const parsed: unknown = JSON.parse(doc);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    } catch {
      throw new SenderError('record must be a JSON object');
    }
    const current = ctx.db.xoRecord.subject.find(subject);
    const at = current?.version ?? 0n;
    if (at !== version) throw new SenderError(`stale: the record of ${subject} is at version ${at}`);
    const row = { subject, doc, version: at + 1n, updatedAt: ctx.timestamp };
    if (current) ctx.db.xoRecord.subject.update(row);
    else ctx.db.xoRecord.insert(row);
  }
);

// Make `identity` (a new identity whose token the admin holds) the agent
// `username` for the xo user `subject`.
export const xoLinkAgent = spacetimedb.reducer(
  { subject: t.string(), username: t.string(), identity: t.string(), token: t.string() },
  (ctx, { subject, username, identity: hex, token }) => {
    requireAdmin(ctx);
    checkSubject(subject);
    if (ctx.db.xoAgent.subject.find(subject)) throw new SenderError(`xo user ${subject} already has an agent`);
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hex)) throw new SenderError('identity must be 64 hex digits');
    if (!token || token.length > 4096) throw new SenderError('invalid token');
    const identity = Identity.fromString(hex.replace(/^0x/, '').toLowerCase());
    if (ctx.db.user.identity.find(identity)) throw new SenderError('that identity is already a builder');
    addBuilder(ctx, identity, username);
    ctx.db.xoAgent.insert({ subject, username, identity, token, createdAt: ctx.timestamp });
  }
);

// Make `identity` (a new identity whose token the admin holds) the builder for
// the GitHub account `githubId`, named after its login. The web service calls
// this once it has checked the account with GitHub; on a hub whose builders
// come only from xo (accounts "xo"), GitHub sign-up is off.
export const githubLinkBuilder = spacetimedb.reducer(
  { githubId: t.u64(), login: t.string(), identity: t.string(), token: t.string() },
  (ctx, { githubId, login, identity: hex, token }) => {
    requireAdmin(ctx);
    if (accounts(ctx) === 'xo') throw new SenderError('builders on this hub are made by xo: run xo login');
    if (githubId === 0n) throw new SenderError('invalid GitHub account id');
    if (!GITHUB_LOGIN.test(login)) throw new SenderError(`invalid GitHub login "${login}"`);
    const known = ctx.db.githubAccount.githubId.find(githubId);
    if (known) throw new SenderError(`that GitHub account is already the builder "${known.username}"`);
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hex)) throw new SenderError('identity must be 64 hex digits');
    if (!token || token.length > 4096) throw new SenderError('invalid token');
    const identity = Identity.fromString(hex.replace(/^0x/, '').toLowerCase());
    if (ctx.db.user.identity.find(identity) || ctx.db.agent.identity.find(identity)) throw new SenderError('that identity is already a builder or an agent');
    const username = login.toLowerCase();
    addBuilder(ctx, identity, username);
    ctx.db.githubAccount.insert({ githubId, login, username, identity, token, createdAt: ctx.timestamp });
  }
);

function createProjectIn(ctx: Ctx, space: string, name: string, description: string) {
  const me = isSyncer(ctx, space) ? SYNCER : requireActor(ctx);
  if (!PROJECT_NAME.test(name) || name === '.' || name === '..' || name.endsWith('.git')) {
    throw new SenderError('a project name may use letters, digits, ".", "_" and "-" and must not end in .git');
  }
  if (!ctx.db.space.name.find(space) && space !== me) throw new SenderError(`no space named "${space}"`);
  if (me !== SYNCER && !isMember(ctx, space, me)) throw new SenderError(`permission denied: only owners and members of "${space}" create projects in it`);
  const fullName = `${space}/${name}`;
  if (ctx.db.project.fullName.find(fullName)) throw new SenderError(`project "${fullName}" already exists`);
  const created = ctx.db.project.insert({
    id: 0n,
    fullName,
    owner: space,
    ownerIdentity: ctx.sender,
    name,
    description: description.slice(0, 500),
    defaultBranch: 'main',
    objectCount: 0n,
    objectPos: 0n,
    createdAt: ctx.timestamp,
    pushedAt: ctx.timestamp,
  });
  ctx.db.projectSize.insert({ projectId: created.id, bytes: 0n });
  logActivity(ctx, { kind: 'project_created', projectId: created.id, path: fullName, agent: me });
  return created;
}

export const createProject = spacetimedb.reducer(
  { space: t.string(), name: t.string(), description: t.string() },
  (ctx, { space, name, description }) => { createProjectIn(ctx, space.trim().toLowerCase(), name, description); }
);

// Start a project from a template (space.ts): the built-in goal space (""
// or "goal") or a project whose SPACE.md has "## Template". Its files become
// the new project's first commit, with the goal and the caller as owner
// filled in, all in one transaction.
export const createProjectFromTemplate = spacetimedb.reducer(
  { space: t.string(), name: t.string(), description: t.string(), template: t.string(), goal: t.string() },
  (ctx, { space, name, description, template, goal }) => {
    const owner = space.trim().toLowerCase();
    let files: ReturnType<typeof templateFiles>;
    try {
      files = templateFiles(ctx.db, template.trim());
    } catch (err) {
      throw new SenderError(err instanceof ApiError ? err.message : String(err));
    }
    const sp = createProjectIn(ctx, owner, name, description);
    const me = requireActor(ctx);
    const now = Number(ctx.timestamp.microsSinceUnixEpoch / 1_000_000n);
    const date = new Date(now * 1000).toISOString().slice(0, 10);
    const filled = instantiate(files, { space: owner, project: name, goal: goal.trim().replace(/\s+/g, ' ').slice(0, 500), owner: me, date });
    const from = template.trim() && template.trim() !== BUILTIN_TEMPLATE ? template.trim() : 'the goal space template';
    const built = commitFiles(filled, me, now, `Start ${sp.fullName} from ${from}`);
    let added = 0n;
    for (const object of built.objects) added += writeObject(ctx, sp, object);
    ctx.db.gitRef.insert({ id: 0n, key: refKey(sp.id, 'refs/heads/main'), projectId: sp.id, name: 'refs/heads/main', oid: built.commit, updatedAt: ctx.timestamp, updatedBy: ctx.sender });
    ctx.db.project.id.update({ ...sp, defaultBranch: 'main', pushedAt: ctx.timestamp });
    grow(ctx, sp.id, added);
    logActivity(ctx, { projectId: sp.id, path: sp.fullName, kind: 'ref_created', subject: 'refs/heads/main', oid: built.commit, text: `Start ${sp.fullName} from ${from}` });
  }
);

// Store one object the server built (chat turns, a template's files),
// chunked when it is big; returns the bytes it added.
function writeObject(ctx: Ctx, sp: Parameters<typeof insertObject>[1] & { id: bigint }, object: NewObject): bigint {
  if (ctx.db.gitObject.key.find(objectKey(sp.id, object.oid))) return 0n;
  const chunks = object.data.length > CHUNK_SIZE ? Math.ceil(object.data.length / CHUNK_SIZE) : 0;
  for (let idx = 0; idx < chunks; idx++) {
    const data = object.data.slice(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE);
    ctx.db.objectChunk.insert({ id: 0n, key: `${sp.id}:${object.oid}:${idx}`, projectId: sp.id, oid: object.oid, idx, data });
  }
  insertObject(ctx, sp, object.oid, object.kind, object.data.length, chunks, chunks ? new Uint8Array(0) : object.data);
  return BigInt(object.data.length);
}

export const deleteProject = spacetimedb.reducer({ project: t.string() }, (ctx, { project: fullName }) => {
  const sp = requireProjectAdmin(ctx, fullName);
  logActivity(ctx, { kind: 'project_deleted', projectId: sp.id, path: sp.fullName });
  for (const ref of [...ctx.db.gitRef.projectId.filter(sp.id)]) ctx.db.gitRef.id.delete(ref.id);
  for (const obj of [...ctx.db.gitObject.byProjectPos.filter(sp.id)]) ctx.db.gitObject.id.delete(obj.id);
  for (const chunk of [...ctx.db.objectChunk.byProjectOid.filter(sp.id)]) ctx.db.objectChunk.id.delete(chunk.id);
  for (const m of [...ctx.db.projectMember.projectId.filter(sp.id)]) ctx.db.projectMember.id.delete(m.id);
  for (const p of [...ctx.db.presence.projectId.filter(sp.id)]) ctx.db.presence.connectionId.delete(p.connectionId);
  for (const r of [...ctx.db.refSync.projectId.filter(sp.id)]) ctx.db.refSync.key.delete(r.key);
  ctx.db.projectSize.projectId.delete(sp.id);
  ctx.db.projectImport.projectId.delete(sp.id);
  ctx.db.projectBuilder.projectId.delete(sp.id);
  ctx.db.project.id.delete(sp.id);
});

// Credit the GitHub account (user or organization) that built the project's
// code. `handle` is its login; the profile link is derived from it. An empty
// handle clears the credit, so the project falls back to its import source's
// owner, else the builder who made it here.
export const setProjectBuilder = spacetimedb.reducer(
  { project: t.string(), handle: t.string(), name: t.string() },
  (ctx, { project: fullName, handle, name }) => {
    const sp = requireProjectAdmin(ctx, fullName);
    const login = handle.trim();
    if (login === '') {
      if (ctx.db.projectBuilder.projectId.delete(sp.id)) logActivity(ctx, { kind: 'builder_cleared', projectId: sp.id, path: sp.fullName });
      return;
    }
    if (!GITHUB_LOGIN.test(login)) throw new SenderError(`"${login}" is not a GitHub user or organization name`);
    const row = { projectId: sp.id, handle: login.toLowerCase(), name: (name.trim() || login).slice(0, 100), url: `https://github.com/${login}` };
    if (ctx.db.projectBuilder.projectId.find(sp.id)) ctx.db.projectBuilder.projectId.update(row);
    else ctx.db.projectBuilder.insert(row);
    logActivity(ctx, { kind: 'builder_set', projectId: sp.id, path: sp.fullName, subject: row.handle, text: row.name });
  }
);

// Change a project's description and/or default branch; omitted fields stay.
export const editProject = spacetimedb.reducer(
  { project: t.string(), description: t.option(t.string()), defaultBranch: t.option(t.string()) },
  (ctx, { project: fullName, description, defaultBranch }) => {
    const sp = requireProjectAdmin(ctx, fullName);
    if (defaultBranch !== undefined && !validRefName(`refs/heads/${defaultBranch}`)) {
      throw new SenderError(`invalid branch name "${defaultBranch}"`);
    }
    const next = {
      ...sp,
      description: description === undefined ? sp.description : description.slice(0, 500),
      defaultBranch: defaultBranch ?? sp.defaultBranch,
    };
    ctx.db.project.id.update(next);
    const changed: string[] = [];
    if (next.description !== sp.description) changed.push('changed the description');
    if (next.defaultBranch !== sp.defaultBranch) changed.push(`set the default branch to ${next.defaultBranch}`);
    if (changed.length > 0 && !importing(ctx, sp.id)) {
      logActivity(ctx, { kind: 'project_edited', projectId: sp.id, path: sp.fullName, text: changed.join(' and ') });
    }
  }
);

// Upload a batch of whole objects. Objects the project already has are
// skipped, so retrying a failed push is safe.
export const putObjects = spacetimedb.reducer(
  { project: t.string(), objects: t.array(ObjectIn) },
  (ctx, { project: fullName, objects }) => {
    const sp = requireWritable(ctx, fullName);
    let added = 0n;
    for (const { oid, kind, data } of objects) {
      if (!OID.test(oid)) throw new SenderError(`invalid object id "${oid}"`);
      if (!KINDS.has(kind)) throw new SenderError(`invalid object kind "${kind}"`);
      if (data.length > CHUNK_SIZE) throw new SenderError(`object ${oid} is larger than one chunk; upload it with putChunk`);
      if (ctx.db.gitObject.key.find(objectKey(sp.id, oid))) continue;
      const actual = new Sha1().update(objectHeader(kind, data.length)).update(data).hex();
      if (actual !== oid) throw new SenderError(`object ${oid} hashes to ${actual}`);
      insertObject(ctx, sp, oid, kind, data.length, 0, data);
      added += BigInt(data.length);
    }
    ctx.db.project.id.update(sp);
    grow(ctx, sp.id, added);
  }
);

// Stage one chunk of a large object. Re-uploading a chunk replaces it.
export const putChunk = spacetimedb.reducer(
  { project: t.string(), oid: t.string(), idx: t.u32(), data: t.byteArray() },
  (ctx, { project: fullName, oid, idx, data }) => {
    const sp = requireWritable(ctx, fullName);
    if (!OID.test(oid)) throw new SenderError(`invalid object id "${oid}"`);
    if (data.length > CHUNK_SIZE) throw new SenderError('chunk too large');
    if (ctx.db.gitObject.key.find(objectKey(sp.id, oid))) return;
    const key = `${sp.id}:${oid}:${idx}`;
    const existing = ctx.db.objectChunk.key.find(key);
    if (existing) ctx.db.objectChunk.id.delete(existing.id);
    ctx.db.objectChunk.insert({ id: 0n, key, projectId: sp.id, oid, idx, data });
  }
);

// Seal a large object once all its chunks are staged: check the hash over
// the chunks in order, then record the object.
export const finishObject = spacetimedb.reducer(
  { project: t.string(), oid: t.string(), kind: t.string(), size: t.u64(), chunks: t.u32() },
  (ctx, { project: fullName, oid, kind, size, chunks }) => {
    const sp = requireWritable(ctx, fullName);
    if (!KINDS.has(kind)) throw new SenderError(`invalid object kind "${kind}"`);
    if (ctx.db.gitObject.key.find(objectKey(sp.id, oid))) return;
    const total = Number(size);
    if (total > MAX_OBJECT_SIZE) throw new SenderError(`object ${oid} exceeds ${MAX_OBJECT_SIZE} bytes`);
    if (chunks !== Math.ceil(total / CHUNK_SIZE)) throw new SenderError('chunk count does not match size');
    const hash = new Sha1().update(objectHeader(kind, total));
    let seen = 0;
    for (let idx = 0; idx < chunks; idx++) {
      const chunk = ctx.db.objectChunk.key.find(`${sp.id}:${oid}:${idx}`);
      if (!chunk) throw new SenderError(`object ${oid} is missing chunk ${idx}`);
      hash.update(chunk.data);
      seen += chunk.data.length;
    }
    if (seen !== total) throw new SenderError(`object ${oid} chunks hold ${seen} bytes, expected ${total}`);
    const actual = hash.hex();
    if (actual !== oid) throw new SenderError(`object ${oid} hashes to ${actual}`);
    insertObject(ctx, sp, oid, kind, total, chunks, new Uint8Array(0));
    ctx.db.project.id.update(sp);
    grow(ctx, sp.id, BigInt(total));
  }
);

// Move, create or delete one ref. `oldOid` is what the pusher believes the
// ref holds now ("" for absent, "*" for a plain force push that overwrites
// anything); a mismatch means someone pushed in between.
export const updateRef = spacetimedb.reducer(
  { project: t.string(), name: t.string(), oldOid: t.string(), newOid: t.string(), force: t.bool() },
  (ctx, { project: fullName, name, oldOid, newOid, force }) => {
    const sp = requireWritable(ctx, fullName);
    if (!validRefName(name)) throw new SenderError(`invalid ref name "${name}"`);
    const current = ctx.db.gitRef.key.find(refKey(sp.id, name));
    const currentOid = current?.oid ?? ZERO_OID;
    if (oldOid !== '*' && currentOid !== oldOid) {
      throw new SenderError(`stale info: ${name} is at ${currentOid || 'nothing'}, fetch first`);
    }
    if (newOid === ZERO_OID) {
      if (current) {
        ctx.db.gitRef.id.delete(current.id);
        if (!importing(ctx, sp.id)) logActivity(ctx, { kind: 'ref_deleted', projectId: sp.id, path: sp.fullName, subject: name, oid: current.oid });
      }
      ctx.db.project.id.update({ ...sp, pushedAt: ctx.timestamp });
      return;
    }
    if (!OID.test(newOid)) throw new SenderError(`invalid object id "${newOid}"`);
    const target = ctx.db.gitObject.key.find(objectKey(sp.id, newOid));
    if (!target) throw new SenderError(`object ${newOid} has not been uploaded`);
    const isBranch = name.startsWith('refs/heads/');
    if (isBranch && target.kind !== 'commit') throw new SenderError(`${name} must point at a commit`);
    let fastForward = true;
    if (current && !force) {
      if (!isBranch) throw new SenderError(`${name} already exists`);
      if (!isAncestor(ctx, sp.id, current.oid, newOid)) throw new SenderError(`non-fast-forward update of ${name}`);
    } else if (current && current.oid !== newOid) {
      fastForward = isBranch && isAncestor(ctx, sp.id, current.oid, newOid);
    }
    // After the usual checks, so a race still reads as a stale or non-fast-forward push.
    guardCollab(ctx, sp, name, current?.oid ?? '', newOid, force);
    if (current) {
      ctx.db.gitRef.id.update({ ...current, oid: newOid, updatedAt: ctx.timestamp, updatedBy: ctx.sender });
    } else {
      ctx.db.gitRef.insert({
        id: 0n,
        key: refKey(sp.id, name),
        projectId: sp.id,
        name,
        oid: newOid,
        updatedAt: ctx.timestamp,
        updatedBy: ctx.sender,
      });
    }
    // The first branch pushed to an empty project becomes its default branch.
    let defaultBranch = sp.defaultBranch;
    if (isBranch && !ctx.db.gitRef.key.find(refKey(sp.id, `refs/heads/${defaultBranch}`))) {
      defaultBranch = name.slice('refs/heads/'.length);
    }
    ctx.db.project.id.update({ ...sp, defaultBranch, pushedAt: ctx.timestamp });
    if (!importing(ctx, sp.id) && current?.oid !== newOid) {
      const base = { projectId: sp.id, path: sp.fullName, subject: name, oid: newOid, text: subjectOf(ctx, sp.id, newOid) };
      if (!current) logActivity(ctx, { ...base, kind: 'ref_created' });
      else if (!fastForward) logActivity(ctx, { ...base, kind: 'ref_forced' });
      else logActivity(ctx, { ...base, kind: 'ref_updated', count: firstParentDistance(ctx, sp.id, newOid, current.oid) });
    }
  }
);

// ---------------------------------------------------------------- chat

const ChatLinkIn = t.object('ChatLinkIn', { label: t.string(), path: t.string() });
const ChatTurnIn = t.object('ChatTurnIn', { id: t.string(), role: t.string(), content: t.string(), links: t.array(ChatLinkIn) });

// Save chat turns from the app: append them to the conversation's
// `.log.jsonl` on the default branch as one commit by the caller (chat.ts
// builds the objects). Being a reducer, it never races another push.
export const appendChat = spacetimedb.reducer(
  { project: t.string(), conversation: t.string(), turns: t.array(ChatTurnIn) },
  (ctx, { project: fullName, conversation, turns }) => {
    const sp = requireWritable(ctx, fullName);
    const me = requireActor(ctx);
    // The project chat takes app messages as posts, attributed by the hub.
    if (conversation.replace(/^\/+/, '') === CHAT_PATH) {
      for (const turn of turns) {
        if (turn.role !== 'user') throw new SenderError('The project chat takes your own messages; agents post as themselves.');
        postToCollab(ctx, sp, { id: turn.id, kind: 'message', content: turn.content, to: [], replyTo: '', task: '', taskTitle: '', taskStatus: '', taskOwner: '', meta: '' });
      }
      return;
    }
    // The cowork chat takes them as plain messages from a person, with no cowork.
    if (conversation.replace(/^\/+/, '') === COWORK_CHAT_PATH) {
      for (const turn of turns) {
        if (turn.role !== 'user') throw new SenderError('The cowork chat takes your own messages; agents post from their cowork.');
        postToCowork(ctx, sp, { id: turn.id, kind: 'message', cowork: '', agent: '', content: turn.content, to: [], replyTo: '', delegation: '', title: '', status: '', key: '', meta: '' });
      }
      return;
    }
    if (conversation.replace(/^\/+/, '').startsWith(`${COLLAB_DIR}/`)) throw new SenderError(`Only ${CHAT_PATH} and ${COWORK_CHAT_PATH} take messages in ${COLLAB_DIR}/.`);
    const name = `refs/heads/${sp.defaultBranch}`;
    const current = ctx.db.gitRef.key.find(refKey(sp.id, name));
    let built: ReturnType<typeof appendTurns>;
    try {
      built = appendTurns({
        head: current?.oid ?? '',
        conversation,
        turns,
        author: me,
        now: Number(ctx.timestamp.microsSinceUnixEpoch / 1_000_000n),
        read: oid => readObject(ctx.db, sp.id, oid),
      });
    } catch (err) {
      throw new SenderError(err instanceof Error ? err.message : String(err));
    }
    commitToDefault(ctx, sp, current!, built);
    logActivity(ctx, { projectId: sp.id, path: sp.fullName, kind: 'ref_updated', subject: name, oid: built.commit, count: 1, text: built.subject });
  }
);

// Store a commit built here (chat.ts) and move the default branch to it.
function commitToDefault(ctx: Ctx, sp: Project, current: GitRef, built: { commit: string; objects: NewObject[] }) {
  let added = 0n;
  for (const object of built.objects) added += writeObject(ctx, sp, object);
  ctx.db.gitRef.id.update({ ...current, oid: built.commit, updatedAt: ctx.timestamp, updatedBy: ctx.sender });
  ctx.db.project.id.update({ ...sp, pushedAt: ctx.timestamp });
  grow(ctx, sp.id, added);
}

// ---------------------------------------------------------------- project chat

// The project chat (collab.ts): every collaborator and the agents they
// bring post here, and each post is one commit to collab/ on the default
// branch, made by the hub as the poster. Being a reducer, posts are
// serialized: no locks, no lost lines, and a post's id makes resending it
// harmless.
export const collabPost = spacetimedb.reducer(
  {
    project: t.string(),
    id: t.string(),
    kind: t.string(),
    content: t.string(),
    to: t.array(t.string()),
    replyTo: t.string(),
    task: t.string(),
    taskTitle: t.string(),
    taskStatus: t.string(),
    taskOwner: t.string(),
    meta: t.string(),
  },
  (ctx, { project: fullName, ...post }) => {
    postToCollab(ctx, requireWritable(ctx, fullName), post);
  }
);

// Who is posting: a builder, or an agent and whom it works for (the
// collaborator who brought it to this project, else the space that owns it).
function collabAuthor(ctx: Ctx, sp: Project): Author {
  const me = requireActor(ctx);
  if (ctx.db.user.identity.find(ctx.sender)) return { name: me, kind: 'builder', user: me };
  const brought = ctx.db.projectMember.key.find(memberKey(sp.id, me));
  return { name: me, kind: 'agent', user: brought?.addedBy ?? ctx.db.space.name.find(me)?.parent ?? '' };
}

function postToCollab(ctx: Ctx, sp: Project, post: PostIn) {
  const author = collabAuthor(ctx, sp);
  const name = `refs/heads/${sp.defaultBranch}`;
  const current = ctx.db.gitRef.key.find(refKey(sp.id, name));
  if (!current) throw new SenderError(`"${sp.fullName}" has no commits on ${sp.defaultBranch} yet; push one before chatting`);
  const read = (oid: string) => readObject(ctx.db, sp.id, oid);
  const now = Number(ctx.timestamp.microsSinceUnixEpoch / 1_000_000n);
  const time = new Date(Number(ctx.timestamp.microsSinceUnixEpoch / 1000n)).toISOString();
  try {
    const log = readFileAt(current.oid, LOG_PATH, read);
    const before = parseState(readFileAt(current.oid, STATE_PATH, read)?.text);
    const applied = applyPost(before, post, author, {
      time,
      admin: isOwner(ctx, sp.owner, author.name),
      isParticipant: who => canWrite(ctx, sp, who),
    });
    if (!applied) return; // already posted
    const { files, moved } = postFiles(log?.text ?? '', before, applied);
    const encoder = new TextEncoder();
    const changes: Record<string, FileChange> = {};
    if (moved && log) changes[moved.to] = { oid: log.oid };
    for (const [path, text] of Object.entries(files)) changes[path] = encoder.encode(text);
    if (!readFileAt(current.oid, CHAT_PATH, read)) changes[CHAT_PATH] = encoder.encode(CHAT_FILE);
    const subject = `collab: ${post.kind} #${applied.line.seq} from ${author.name}`;
    const built = editFiles({ head: current.oid, changes, author: author.name, now, message: `${subject}\n\nPosted to the project chat (${LOG_PATH}).`, read });
    commitToDefault(ctx, sp, current, built);
    logActivity(ctx, { projectId: sp.id, path: sp.fullName, kind: 'collab_posted', subject: post.kind, oid: built.commit, count: applied.line.seq, text: applied.line.content || applied.line.task?.title || '' });
  } catch (err) {
    if (err instanceof SenderError) throw err;
    throw new SenderError(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------- cowork chat

// The cowork chat (cowork.ts): each collaborator's own Cowork connects to
// the project here, and its agents talk, delegate work and announce their
// branches to the other coworks. Like the project chat, each envelope is one
// commit to collab/ on the default branch, made by the hub as the sender, so
// envelopes are ordered, attributed and never race; the project chat's own
// files are left alone.
export const coworkPost = spacetimedb.reducer(
  {
    project: t.string(),
    id: t.string(),
    kind: t.string(),
    cowork: t.string(),
    agent: t.string(),
    content: t.string(),
    to: t.array(t.string()),
    replyTo: t.string(),
    delegation: t.string(),
    title: t.string(),
    status: t.string(),
    key: t.string(),
    meta: t.string(),
  },
  (ctx, { project: fullName, ...post }) => {
    postToCowork(ctx, requireWritable(ctx, fullName), post);
  }
);

function postToCowork(ctx: Ctx, sp: Project, post: CoworkPostIn) {
  const author = collabAuthor(ctx, sp);
  const name = `refs/heads/${sp.defaultBranch}`;
  const current = ctx.db.gitRef.key.find(refKey(sp.id, name));
  if (!current) throw new SenderError(`"${sp.fullName}" has no commits on ${sp.defaultBranch} yet; push one before connecting a cowork`);
  const read = (oid: string) => readObject(ctx.db, sp.id, oid);
  const now = Number(ctx.timestamp.microsSinceUnixEpoch / 1_000_000n);
  const time = new Date(Number(ctx.timestamp.microsSinceUnixEpoch / 1000n)).toISOString();
  try {
    const log = readFileAt(current.oid, COWORK_LOG_PATH, read);
    const before = parseCoworkState(readFileAt(current.oid, COWORK_STATE_PATH, read)?.text);
    const applied = applyCoworkPost(before, post, author, {
      time,
      admin: isOwner(ctx, sp.owner, author.name),
      isOwner: who => isOwner(ctx, sp.owner, who),
      isParticipant: who => canWrite(ctx, sp, who),
      hasCommit: oid => read(oid)?.kind === 'commit',
    });
    if (!applied) return; // already posted
    const { files, moved } = coworkPostFiles(log?.text ?? '', before, applied);
    const encoder = new TextEncoder();
    const changes: Record<string, FileChange> = {};
    if (moved && log) changes[moved.to] = { oid: log.oid };
    for (const [path, text] of Object.entries(files)) changes[path] = encoder.encode(text);
    // The conversation file: made with the first post, and holding one object per thread (cowork.ts).
    const chatFile = coworkChatFile(readFileAt(current.oid, COWORK_CHAT_PATH, read)?.text, applied.line);
    if (chatFile !== null) changes[COWORK_CHAT_PATH] = encoder.encode(chatFile);
    const subject = `cowork: ${post.kind} #${applied.line.seq} from ${applied.line.from}`;
    const built = editFiles({ head: current.oid, changes, author: author.name, now, message: `${subject}\n\nPosted to the cowork chat (${COWORK_LOG_PATH}).`, read });
    commitToDefault(ctx, sp, current, built);
    logActivity(ctx, { projectId: sp.id, path: sp.fullName, kind: 'cowork_posted', subject: post.kind, oid: built.commit, count: applied.line.seq, text: applied.line.content || applied.line.delegation?.title || '' });
  } catch (err) {
    if (err instanceof SenderError) throw err;
    throw new SenderError(err instanceof Error ? err.message : String(err));
  }
}

// The tree id of collab/ in a commit ("" when it has none).
function collabTreeOf(ctx: Ctx, projectId: bigint, commitOid: string) {
  if (!commitOid) return '';
  const commit = readObject(ctx.db, projectId, commitOid);
  if (!commit || commit.kind !== 'commit') return '';
  const root = readObject(ctx.db, projectId, parseCommit(commit.data).tree);
  if (!root || root.kind !== 'tree') return '';
  return parseTree(root.data).find(entry => entry.name === COLLAB_DIR)?.oid ?? '';
}

// collab/ on the default branch changes only through collabPost, so pushes
// cannot rewrite or forge the chat. Owners of the project's space may
// replace it (a force push, or the branch's first push), to repair it.
function guardCollab(ctx: Ctx, sp: Project, ref: string, oldOid: string, newOid: string, force: boolean) {
  const defaultRef = `refs/heads/${sp.defaultBranch}`;
  const becomesDefault = !ctx.db.gitRef.key.find(refKey(sp.id, defaultRef)) && ref.startsWith('refs/heads/');
  if (ref !== defaultRef && !becomesDefault) return;
  if (collabTreeOf(ctx, sp.id, oldOid) === collabTreeOf(ctx, sp.id, newOid)) return;
  if (isSyncer(ctx, sp.owner)) return;
  if (isOwner(ctx, sp.owner, actorName(ctx)) && (force || !oldOid)) return;
  throw new SenderError(
    `${COLLAB_DIR}/ is the project chat and the cowork chat, and changes only through "spacehub collab" and "spacehub cowork"; undo your changes to ${COLLAB_DIR}/ (git checkout ${REMOTE_HINT}/${sp.defaultBranch} -- ${COLLAB_DIR}) and push again`
  );
}

// ---------------------------------------------------------------- spaces

// A builder or an agent: someone who can belong to a space.
function requireMemberName(ctx: Ctx, name: string) {
  const row = ctx.db.space.name.find(name);
  if (ctx.db.user.username.find(name) || row?.kind === 'agent') return row?.kind === 'agent' ? 'agent' : 'builder';
  throw new SenderError(`no builder or agent named "${name}"`);
}

export const createOrg = spacetimedb.reducer({ name: t.string(), description: t.string() }, (ctx, { name: raw, description }) => {
  const me = requireUser(ctx).username;
  const name = raw.trim().toLowerCase();
  checkSpaceName(ctx, name);
  ctx.db.space.insert({ name, kind: 'org', displayName: raw.trim(), description: description.slice(0, 500), parent: '', createdBy: me, createdAt: ctx.timestamp });
  ctx.db.spaceRole.insert({ id: 0n, key: roleKey(name, me), space: name, member: me, role: 'owner', addedBy: me, addedAt: ctx.timestamp });
  logActivity(ctx, { kind: 'org_created', path: name, subject: name });
});

// Change a space's description (an org's, a builder's own, an agent's).
export const editSpace = spacetimedb.reducer({ space: t.string(), description: t.string() }, (ctx, { space, description }) => {
  const row = requireSpaceOwner(ctx, space);
  ctx.db.space.name.update({ ...row, description: description.slice(0, 500) });
  logActivity(ctx, { kind: 'space_edited', path: space, subject: space, text: 'changed the description' });
});

// Only an empty org goes: its projects and agents first.
export const deleteOrg = spacetimedb.reducer({ space: t.string() }, (ctx, { space }) => {
  const row = requireSpaceOwner(ctx, space);
  if (row.kind !== 'org') throw new SenderError(`"${space}" is not an org`);
  const projects = [...ctx.db.project.owner.filter(space)].length;
  const agents = [...ctx.db.space.kind.filter('agent')].filter(a => a.parent === space).length;
  if (projects || agents) throw new SenderError(`"${space}" still has ${projects} projects and ${agents} agents; delete or move them first`);
  for (const r of [...ctx.db.spaceRole.space.filter(space)]) ctx.db.spaceRole.id.delete(r.id);
  ctx.db.spaceLink.space.delete(space);
  for (const p of [...ctx.db.presence.projectId.filter(0n)]) if (p.space === space) ctx.db.presence.connectionId.delete(p.connectionId);
  ctx.db.space.name.delete(space);
  logActivity(ctx, { kind: 'org_deleted', path: space, subject: space });
});

// Add a member or owner, or change a member's role. A personal space has
// one owner, its builder.
export const addSpaceMember = spacetimedb.reducer(
  { space: t.string(), member: t.string(), role: t.string() },
  (ctx, { space, member: raw, role }) => {
    const row = requireSpaceOwner(ctx, space);
    const member = raw.trim().toLowerCase();
    if (requireMemberName(ctx, member) === 'agent' && !isOwner(ctx, member, actorName(ctx))) {
      throw new SenderError(`permission denied: only the owners of the agent "${member}" connect it`);
    }
    if (role !== 'owner' && role !== 'member') throw new SenderError('a role is "owner" or "member"');
    if (row.kind !== 'org' && role === 'owner') {
      throw new SenderError(`only orgs have more owners; "${space}" is ${row.kind === 'agent' ? 'an agent' : "a builder's personal space"}`);
    }
    if (member === space || (row.kind === 'agent' && isOwner(ctx, space, member))) throw new SenderError(`${member} already owns "${space}"`);
    const key = roleKey(space, member);
    const current = ctx.db.spaceRole.key.find(key);
    if (current?.role === role) return;
    const me = requireActor(ctx);
    if (current) ctx.db.spaceRole.id.update({ ...current, role });
    else ctx.db.spaceRole.insert({ id: 0n, key, space, member, role, addedBy: me, addedAt: ctx.timestamp });
    logActivity(ctx, { kind: 'space_member_added', path: space, subject: member, text: role });
  }
);

// An owner removes a member, or a member leaves. An org keeps at
// least one owner.
export const removeSpaceMember = spacetimedb.reducer({ space: t.string(), member: t.string() }, (ctx, { space, member: raw }) => {
  requireSpace(ctx, space);
  const member = raw.trim().toLowerCase();
  const me = actorName(ctx);
  if (!isOwner(ctx, space, me) && me !== member) throw new SenderError(`permission denied: only owners of "${space}" remove its members`);
  const row = ctx.db.spaceRole.key.find(roleKey(space, member));
  if (!row) throw new SenderError(`${member} is not a member of "${space}"`);
  if (row.role === 'owner' && [...ctx.db.spaceRole.space.filter(space)].filter(r => r.role === 'owner').length === 1) {
    throw new SenderError(`${member} is the last owner of "${space}"; add another owner first`);
  }
  ctx.db.spaceRole.id.delete(row.id);
  logActivity(ctx, { kind: 'space_member_removed', path: space, subject: member });
});

// ---------------------------------------------------------------- agents

// Make an agent: a space named `name`, owned by `parent` (your personal space
// or an org you own), whose identity is `identity`. The caller made that
// identity and holds its token, which the hub keeps for the agent's owners.
export const createAgent = spacetimedb.reducer(
  { name: t.string(), parent: t.string(), identity: t.string(), token: t.string(), description: t.string() },
  (ctx, { name: raw, parent, identity: hex, token, description }) => {
    const me = requireUser(ctx).username;
    const name = raw.trim().toLowerCase();
    const owner = requireSpace(ctx, parent);
    if (owner.kind === 'agent') throw new SenderError('an agent belongs to a builder or an org, not to another agent');
    if (!isOwner(ctx, parent, me)) throw new SenderError(`permission denied: only owners of "${parent}" make agents in it`);
    checkSpaceName(ctx, name);
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hex)) throw new SenderError('identity must be 64 hex digits');
    if (!token || token.length > 4096) throw new SenderError('invalid token');
    const identity = Identity.fromString(hex.replace(/^0x/, '').toLowerCase());
    if (ctx.db.user.identity.find(identity) || ctx.db.agent.identity.find(identity)) throw new SenderError('that identity is already a builder or an agent');
    ctx.db.space.insert({ name, kind: 'agent', displayName: raw.trim(), description: description.slice(0, 500), parent, createdBy: me, createdAt: ctx.timestamp });
    ctx.db.agent.insert({ name, identity, createdBy: me, createdAt: ctx.timestamp });
    ctx.db.agentSecret.insert({ name, token });
    logActivity(ctx, { kind: 'agent_created', path: name, subject: parent });
  }
);

function requireAgent(ctx: Ctx, name: string) {
  const row = ctx.db.space.name.find(name);
  if (row?.kind !== 'agent') throw new SenderError(`no agent named "${name}"`);
  return row;
}

// Delete an agent with no projects left (delete them first).
export const deleteAgent = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  requireAgent(ctx, name);
  if (!isOwner(ctx, name, actorName(ctx))) throw new SenderError(`permission denied: only the owners of "${name}" delete it`);
  const projects = [...ctx.db.project.owner.filter(name)].length;
  if (projects) throw new SenderError(`"${name}" still has ${projects} projects; delete them first`);
  for (const r of [...ctx.db.spaceRole.member.filter(name)]) ctx.db.spaceRole.id.delete(r.id);
  for (const r of [...ctx.db.spaceRole.space.filter(name)]) ctx.db.spaceRole.id.delete(r.id);
  for (const m of [...ctx.db.projectMember.agent.filter(name)]) ctx.db.projectMember.id.delete(m.id);
  for (const p of [...ctx.db.presence.iter()]) if (p.agent === name) ctx.db.presence.connectionId.delete(p.connectionId);
  ctx.db.agentSecret.name.delete(name);
  ctx.db.agent.name.delete(name);
  ctx.db.space.name.delete(name);
  logActivity(ctx, { kind: 'agent_deleted', path: name });
});

// Connect an agent to a space: it becomes a member there. The caller must
// own both, so neither side is volunteered by the other.
export const connectAgent = spacetimedb.reducer({ agent: t.string(), space: t.string() }, (ctx, { agent: name, space }) => {
  requireAgent(ctx, name);
  const row = requireSpaceOwner(ctx, space);
  const me = requireActor(ctx);
  if (!isOwner(ctx, name, me)) throw new SenderError(`permission denied: only the owners of "${name}" connect it`);
  if (row.kind === 'agent') throw new SenderError('agents connect to builders\' spaces and orgs, not to other agents');
  const key = roleKey(space, name);
  if (ctx.db.spaceRole.key.find(key)) return;
  ctx.db.spaceRole.insert({ id: 0n, key, space, member: name, role: 'member', addedBy: me, addedAt: ctx.timestamp });
  logActivity(ctx, { kind: 'agent_connected', path: space, subject: name });
});

// Owners of either side can disconnect.
export const disconnectAgent = spacetimedb.reducer({ agent: t.string(), space: t.string() }, (ctx, { agent: name, space }) => {
  requireAgent(ctx, name);
  const me = actorName(ctx);
  if (!isOwner(ctx, name, me) && !isOwner(ctx, space, me)) throw new SenderError(`permission denied: only owners of "${name}" or "${space}" disconnect them`);
  const row = ctx.db.spaceRole.key.find(roleKey(space, name));
  if (!row) throw new SenderError(`${name} is not connected to "${space}"`);
  ctx.db.spaceRole.id.delete(row.id);
  logActivity(ctx, { kind: 'agent_disconnected', path: space, subject: name });
});

// An agent's token, for its owners (to launch it, e.g. from XO Swarm).
// A procedure, so the token goes back to the caller alone.
export const agentToken = spacetimedb.procedure({ agent: t.string() }, t.string(), (ctx, { agent: name }) =>
  ctx.withTx(tx => {
    const db = tx.db as Ctx['db'];
    const me = db.user.identity.find(ctx.sender)?.username ?? null;
    if (db.space.name.find(name)?.kind !== 'agent') throw new SenderError(`no agent named "${name}"`);
    if (!ownsSpace(db, name, me)) throw new SenderError(`permission denied: only the owners of "${name}" read its token`);
    return db.agentSecret.name.find(name)?.token ?? '';
  })
);

// The client protocol this hub speaks (protocol.ts). Clients ask on connect,
// so an out-of-date CLI says so instead of failing on a table it cannot read.
// Keep this procedure's name and shape as they are: every CLI version calls it.
export const clientProtocol = spacetimedb.procedure(
  {},
  t.object('ClientProtocol', { current: t.u32(), oldest: t.u32() }),
  () => ({ current: PROTOCOL, oldest: OLDEST_PROTOCOL })
);

// ---------------------------------------------------------------- GitHub links

const GITHUB_ACCOUNT = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/?$/;

// Mirror a GitHub user's or organization's public repositories into the
// space, and sync now.
export const linkSpace = spacetimedb.reducer({ space: t.string(), source: t.string() }, (ctx, { space, source }) => {
  requireSpaceOwner(ctx, space);
  const m = GITHUB_ACCOUNT.exec(source.trim());
  if (!m) throw new SenderError('link a GitHub user or organization, like https://github.com/anthropics');
  const url = `https://github.com/${m[1]}`;
  const current = ctx.db.spaceLink.space.find(space);
  const row = {
    space,
    source: url,
    status: 'requested',
    message: 'waiting for the hub',
    requestedAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
    syncedAt: current && current.source === url ? current.syncedAt : Timestamp.UNIX_EPOCH,
    projects: current && current.source === url ? current.projects : 0,
  };
  if (current) ctx.db.spaceLink.space.update(row);
  else ctx.db.spaceLink.insert(row);
  if (current?.source !== url) logActivity(ctx, { kind: 'space_linked', path: space, subject: url });
});

export const requestSync = spacetimedb.reducer({ space: t.string() }, (ctx, { space }) => {
  requireSpaceOwner(ctx, space);
  const row = ctx.db.spaceLink.space.find(space);
  if (!row) throw new SenderError(`"${space}" is not linked to GitHub`);
  if (row.status === 'requested' || row.status === 'running') return;
  ctx.db.spaceLink.space.update({ ...row, status: 'requested', message: 'waiting for the hub', requestedAt: ctx.timestamp, updatedAt: ctx.timestamp });
});

// Stop mirroring; the projects stay.
export const unlinkSpace = spacetimedb.reducer({ space: t.string() }, (ctx, { space }) => {
  requireSpaceOwner(ctx, space);
  const row = ctx.db.spaceLink.space.find(space);
  if (!row) throw new SenderError(`"${space}" is not linked to GitHub`);
  ctx.db.spaceLink.space.delete(space);
  logActivity(ctx, { kind: 'space_unlinked', path: space, subject: row.source });
});

// The web service's progress on a space's sync.
export const setLinkStatus = spacetimedb.reducer(
  { space: t.string(), status: t.string(), message: t.string(), projects: t.u32() },
  (ctx, { space, status, message, projects }) => {
    requireAdmin(ctx);
    const row = ctx.db.spaceLink.space.find(space);
    if (!row) throw new SenderError(`"${space}" is not linked to GitHub`);
    if (!['running', 'done', 'failed'].includes(status)) throw new SenderError(`invalid sync status "${status}"`);
    const done = status === 'done';
    ctx.db.spaceLink.space.update({ ...row, status, message: message.slice(0, 2000), updatedAt: ctx.timestamp, syncedAt: done ? ctx.timestamp : row.syncedAt, projects: done ? projects : row.projects });
    if (done) logActivity(ctx, { kind: 'space_synced', path: space, subject: row.source, count: projects, text: message });
    if (status === 'failed') logActivity(ctx, { kind: 'space_sync_failed', path: space, subject: row.source, text: message });
  }
);

const RefSyncIn = t.object('RefSyncIn', { ref: t.string(), githubOid: t.string(), status: t.string() });

// Where GitHub had refs at this sync, and whether the hub's copy follows
// each one ("synced"), went its own way ("diverged"), or is gone with it
// ("gone").
export const recordRefSync = spacetimedb.reducer(
  { project: t.string(), refs: t.array(RefSyncIn) },
  (ctx, { project: fullName, refs }) => {
    const sp = requireProjectAdmin(ctx, fullName);
    for (const { ref, githubOid, status } of refs) {
      if (!validRefName(ref)) throw new SenderError(`invalid ref name "${ref}"`);
      const key = `${sp.id}:${ref}`;
      const current = ctx.db.refSync.key.find(key);
      if (status === 'gone') {
        if (current) ctx.db.refSync.key.delete(key);
        continue;
      }
      if (status !== 'synced' && status !== 'diverged') throw new SenderError(`invalid ref status "${status}"`);
      if (!OID.test(githubOid)) throw new SenderError(`invalid object id "${githubOid}"`);
      const row = { key, projectId: sp.id, ref, githubOid, status, at: ctx.timestamp };
      if (current) ctx.db.refSync.key.update(row);
      else ctx.db.refSync.insert(row);
      if (status === 'diverged' && current?.status !== 'diverged') {
        logActivity(ctx, { kind: 'ref_diverged', projectId: sp.id, path: sp.fullName, subject: ref, oid: githubOid });
      }
    }
  }
);

// ---------------------------------------------------------------- collaborators

// Let one more builder (or agent) push to one project: a collaborator.
// The space's owners add builders. Anyone who works on the project brings
// their own agents to it (this project only): owners and members of the
// space, and collaborators. Adding one twice is a no-op.
export const addProjectMember = spacetimedb.reducer({ project: t.string(), agent: t.string() }, (ctx, { project: fullName, agent }) => {
  const sp = requireProject(ctx, fullName);
  const me = actorName(ctx);
  const admin = isOwner(ctx, sp.owner, me) || isSyncer(ctx, sp.owner);
  const name = agent.trim().toLowerCase();
  if (requireMemberName(ctx, name) === 'agent') {
    if (!isOwner(ctx, name, me)) throw new SenderError(`permission denied: only the owners of the agent "${name}" connect it`);
    if (!admin && !canWrite(ctx, sp, me)) throw new SenderError(`permission denied: only people working on "${fullName}" bring their agents to it`);
  } else if (!admin) {
    throw new SenderError(`permission denied: only owners of "${sp.owner}" change "${fullName}"`);
  }
  if (isMember(ctx, sp.owner, name)) throw new SenderError(`${name} belongs to "${sp.owner}" and can already push to "${sp.fullName}"`);
  const key = memberKey(sp.id, name);
  if (ctx.db.projectMember.key.find(key)) return;
  ctx.db.projectMember.insert({ id: 0n, key, projectId: sp.id, agent: name, addedBy: requireActor(ctx), addedAt: ctx.timestamp });
  logActivity(ctx, { kind: 'project_member_added', projectId: sp.id, path: sp.fullName, subject: name });
});

// A space owner removes a collaborator, or a collaborator leaves. An agent
// also goes when whoever brought it, or its owners, take it away. Agents a
// collaborator brought leave with them.
export const removeProjectMember = spacetimedb.reducer({ project: t.string(), agent: t.string() }, (ctx, { project: fullName, agent }) => {
  const sp = requireProject(ctx, fullName);
  const name = agent.trim().toLowerCase();
  const me = actorName(ctx);
  const row = ctx.db.projectMember.key.find(memberKey(sp.id, name));
  const mayRemove = isOwner(ctx, sp.owner, me) || me === name || (!!row && (row.addedBy === me || isOwner(ctx, name, me)));
  if (!mayRemove) {
    throw new SenderError(`permission denied: only owners of "${sp.owner}" remove collaborators on "${fullName}"`);
  }
  if (!row) throw new SenderError(`${name} is not a collaborator on "${sp.fullName}"`);
  ctx.db.projectMember.id.delete(row.id);
  logActivity(ctx, { kind: 'project_member_removed', projectId: sp.id, path: sp.fullName, subject: name });
  if (ctx.db.space.name.find(name)?.kind === 'agent') return;
  for (const brought of [...ctx.db.projectMember.projectId.filter(sp.id)]) {
    if (brought.addedBy !== name || ctx.db.space.name.find(brought.agent)?.kind !== 'agent' || canWrite(ctx, sp, name)) continue;
    ctx.db.projectMember.id.delete(brought.id);
    logActivity(ctx, { kind: 'project_member_removed', projectId: sp.id, path: sp.fullName, subject: brought.agent, text: `brought by ${name}` });
  }
});

// ---------------------------------------------------------------- presence

const PRESENCE_MODES = new Set(['watch', 'sync', 'autosync', 'agent']);
const PRESENCE_STALE_MICROS = BigInt(PRESENCE_STALE_SECONDS) * 1_000_000n;

// This connection follows `project` (`branch` for sync and autosync). Called
// again as a heartbeat; `since` stays while the project, mode and branch do.
export const watchProject = spacetimedb.reducer(
  { project: t.string(), mode: t.string(), branch: t.string() },
  (ctx, { project: fullName, mode, branch }) => {
    const me = { username: requireActor(ctx) };
    const sp = requireProject(ctx, fullName);
    if (!PRESENCE_MODES.has(mode)) throw new SenderError(`invalid presence mode "${mode}"`);
    if (branch !== '' && !validRefName(`refs/heads/${branch}`)) throw new SenderError(`invalid branch name "${branch}"`);
    const connectionId = ctx.connectionId;
    if (!connectionId) throw new SenderError('presence needs a live connection');
    const current = ctx.db.presence.connectionId.find(connectionId);
    const same = current && current.projectId === sp.id && current.mode === mode && current.branch === branch;
    const row = { connectionId, projectId: sp.id, agent: me.username, mode, branch, since: same ? current.since : ctx.timestamp, seenAt: ctx.timestamp, space: sp.owner, host: '' };
    if (current) ctx.db.presence.connectionId.update(row);
    else ctx.db.presence.insert(row);
  }
);

// This connection follows every project of `space` (space clone and sync,
// and agents, which name the host they run on). Called again as a heartbeat.
export const watchSpace = spacetimedb.reducer({ space: t.string(), mode: t.string(), host: t.string() }, (ctx, { space, mode, host }) => {
  const me = requireActor(ctx);
  requireSpace(ctx, space);
  if (!PRESENCE_MODES.has(mode)) throw new SenderError(`invalid presence mode "${mode}"`);
  const connectionId = ctx.connectionId;
  if (!connectionId) throw new SenderError('presence needs a live connection');
  const current = ctx.db.presence.connectionId.find(connectionId);
  const same = current && current.projectId === 0n && current.space === space && current.mode === mode;
  const row = { connectionId, projectId: 0n, agent: me, mode, branch: '', since: same ? current.since : ctx.timestamp, seenAt: ctx.timestamp, space, host: host.slice(0, 100) };
  if (current) ctx.db.presence.connectionId.update(row);
  else ctx.db.presence.insert(row);
});

// This connection stops following anything.
export const unwatch = spacetimedb.reducer(ctx => {
  if (ctx.connectionId) ctx.db.presence.connectionId.delete(ctx.connectionId);
});

// Sweep presence left by connections whose close the server never saw.
export const clientConnected = spacetimedb.clientConnected(ctx => {
  const cutoff = ctx.timestamp.microsSinceUnixEpoch - PRESENCE_STALE_MICROS;
  for (const row of [...ctx.db.presence.iter()]) {
    if (row.seenAt.microsSinceUnixEpoch < cutoff) ctx.db.presence.connectionId.delete(row.connectionId);
  }
});

export const clientDisconnected = spacetimedb.clientDisconnected(ctx => {
  if (ctx.connectionId) ctx.db.presence.connectionId.delete(ctx.connectionId);
});

// ---------------------------------------------------------------- imports

const GITHUB_SOURCE = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

// Record that an import into the project has started.
export const startImport = spacetimedb.reducer(
  { project: t.string(), source: t.string() },
  (ctx, { project: fullName, source }) => {
    const sp = requireProjectAdmin(ctx, fullName);
    if (!GITHUB_SOURCE.test(source)) throw new SenderError('only https://github.com/<owner>/<repo> can be imported');
    const row = ctx.db.projectImport.projectId.find(sp.id);
    if (row && row.status === 'running' && ctx.timestamp.microsSinceUnixEpoch - row.updatedAt.microsSinceUnixEpoch < IMPORT_STALE_MICROS) {
      throw new SenderError('an import into this project is already running');
    }
    const next = { projectId: sp.id, source, status: 'running', message: 'starting', startedAt: ctx.timestamp, updatedAt: ctx.timestamp };
    if (row) ctx.db.projectImport.projectId.update(next);
    else ctx.db.projectImport.insert(next);
    const syncing = ctx.db.gitRef.projectId.filter(sp.id).next().done === false;
    logActivity(ctx, { kind: syncing ? 'sync_started' : 'import_started', projectId: sp.id, path: sp.fullName, subject: source });
  }
);

// Report progress or the outcome of an import.
export const updateImport = spacetimedb.reducer(
  { project: t.string(), status: t.string(), message: t.string() },
  (ctx, { project: fullName, status, message }) => {
    const sp = requireProjectAdmin(ctx, fullName);
    if (!['running', 'done', 'failed'].includes(status)) throw new SenderError(`invalid import status "${status}"`);
    const row = ctx.db.projectImport.projectId.find(sp.id);
    if (!row) throw new SenderError(`no import recorded for "${fullName}"`);
    ctx.db.projectImport.projectId.update({ ...row, status, message: message.slice(0, 2000), updatedAt: ctx.timestamp });
    const base = { projectId: sp.id, path: sp.fullName, subject: row.source, text: message };
    if (status === 'done') logActivity(ctx, { ...base, kind: 'import_done', count: [...ctx.db.gitRef.projectId.filter(sp.id)].length });
    if (status === 'failed') logActivity(ctx, { ...base, kind: 'import_failed' });
  }
);

// The web UI. Behind the server image's proxy every page lands here with
// the original request URI in X-Spacehub-Uri; see ui.ts for the pages.
export const ui = spacetimedb.httpHandler((ctx, req) => {
  const res = ctx.withTx(tx =>
    renderUi(tx.db, {
      uri: req.uri,
      forwardedUri: req.headers.get('x-spacehub-uri'),
      cookie: req.headers.get('cookie'),
      proto: req.headers.get('x-forwarded-proto'),
      now: Number(ctx.timestamp.microsSinceUnixEpoch / 1_000_000n),
    })
  );
  return new SyncResponse(res.body, { status: res.status, headers: res.headers });
});

// The app's data: the hub, a space or a project's files as JSON (workspace.ts).
// The display cookie names the viewer only to say whether saving is possible;
// the reducers check every write.
export const api = spacetimedb.httpHandler((ctx, req) => {
  const q = req.uri.indexOf('?');
  const query = parseQuery(q >= 0 ? req.uri.slice(q + 1) : '');
  const viewer = /(?:^|;\s*)spacehub_user=([^;]*)/.exec(req.headers.get('cookie') ?? '')?.[1];
  const res = ctx.withTx(tx =>
    renderApi(tx.db, { query, viewer: viewer ? decodeURIComponent(viewer) : null, now: Number(ctx.timestamp.microsSinceUnixEpoch / 1_000_000n) })
  );
  return new SyncResponse(res.body, { status: res.status, headers: res.headers });
});

export const routes = spacetimedb.httpRouter(new Router().get('/ui', ui).get('/api', api));
