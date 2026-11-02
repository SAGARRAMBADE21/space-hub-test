// The workspace API: the hub as one tree of folders and files, as JSON, for
// the app the web service serves at /, /<space> and /<space>/<project>.
// It speaks open-chat's snapshot format, so the app renders conversations,
// collections, feeds, documents and previews exactly as open-chat does.
//
//   GET /v1/database/<db>/route/api?space=&project=&path=
//
//   no space                 the hub: every space as a folder
//   space                    a space: its projects as folders
//   space + project (+path)  the project's default branch: folders and files,
//                            with `path` (relative to the project) opened
//   templates                the templates a new project can start from
//
// Reads come straight from the tables, so nothing is cached and every answer
// is current. Writes go through the append_chat reducer (chat.ts).
import { PRESENCE_STALE_SECONDS, inSpace, objectKey, readObject, refKey, type Db } from './store';
import { Sha1 } from './sha1';
import { CodeError, README_BYTES, commitView, commitsView, filesView, refsView, treeView } from './code';
import { DEPS_FILE, depsText, depsView, parseDeps } from './deps';
import { MAX_TEMPLATE_BYTES, MAX_TEMPLATE_FILES, SPACE_FILE, parseSpace, progressOf, textFiles, type SpaceGoal, type TemplateFile } from './space';
import { BUILTIN_ABOUT, BUILTIN_FILES, BUILTIN_TEMPLATE, BUILTIN_TITLE } from './spacetemplate';

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
export const MAX_DIRECTORY_ENTRIES = 2000;
const ACTIVITY_SHOWN = 30;
/** Folders summarized from their READMEs, at most, in one listing. */
const SUMMARIZED_FOLDERS = 200;
const SUMMARY_BYTES = 64 * 1024;
/** The documents shown under a project's root listing, in this order; any other folder shows its README. */
const ROOT_DOCS = ['readme', 'agents', 'project', 'contributing', 'work_items'];
const DOC_NAME = /^([a-z_]+?)(?:\.(?:md|markdown|txt))?$/i;

const OMITTED_NAMES = new Set(['node_modules']);
const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'csv', 'tsv', 'log', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'jsonc', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg', 'yaml',
  'yml', 'toml', 'ini', 'conf', 'config', 'sql', 'py', 'rb', 'rs', 'go', 'java',
  'kt', 'kts', 'swift', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'c', 'cpp',
  'cc', 'h', 'hpp', 'cs', 'vue', 'svelte', 'astro', 'prisma', 'graphql', 'gql',
  'proto', 'diff', 'patch', 'r', 'rmd', 'tex', 'dockerfile', 'lock',
]);
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', 'changelog']);
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

export interface Entry {
  name: string;
  /** Slash-separated, relative to the level's root (the hub, a space or a project). */
  path: string;
  kind: 'directory' | 'file';
  extension: string;
  size: number;
  modifiedAt: string;
  /** A short line shown instead of "Folder": for spaces and projects, and for folders with a README. */
  detail?: string;
  /** From a folder's README, its "## Status", "## Owner" and "## Output format" sections. */
  status?: string;
  owner?: string;
  outputFormat?: string;
  /** A project's goal and outcomes done, from its SPACE.md, and whether it is a template. */
  goal?: string;
  progress?: { done: number; total: number };
  template?: boolean;
}

/** A Markdown document of a folder, shown under its listing. */
export interface Doc {
  name: string;
  path: string;
  content: string;
}

export interface FileView extends Entry {
  kind: 'file';
  format: 'url' | 'jsonl' | 'json' | 'markdown' | 'text' | 'image' | 'pdf' | 'unsupported';
  content?: string;
  data?: unknown;
  error?: string;
}

export interface Snapshot {
  rootName: string;
  rootId: string;
  roots: Entry[];
  directory: { path: string; name: string; entries: Entry[]; docs?: Doc[] };
  file?: FileView;
  revision: string;
}

export interface Person {
  name: string;
  kind: string;
}

export interface Here {
  agent: string;
  mode: string;
  project: string;
}

export interface ActivityItem {
  at: string;
  agent: string;
  kind: string;
  path: string;
  subject: string;
  text: string;
  count: number;
  /** The commit or tag the event points at, when there is one. */
  oid: string;
}

export interface ProjectCard {
  fullName: string;
  description: string;
  pushedAt: string;
}

/** An agent seen from a space: whether the space owns it, whether it may push here, where it runs. */
export interface AgentInfo {
  name: string;
  description: string;
  parent: string;
  owned: boolean;
  connected: boolean;
  spaces: string[];
  running: { host: string; since: string }[];
}

export interface Membership {
  space: string;
  kind: string;
  role: string;
}

export type Meta =
  | { level: 'hub'; spaces: number; projects: number; bytes: number; events: number; humans: number; agents: number; activity: ActivityItem[]; here: Here[]; allProjects: ProjectCard[] }
  | {
      level: 'space';
      name: string;
      displayName: string;
      kind: string;
      description: string;
      parent: string;
      owners: string[];
      members: string[];
      projects: number;
      bytes: number;
      github: string;
      /** The GitHub account behind a builder (from sign-up) or an org (from its link), for its avatar. */
      githubLogin: string;
      createdAt: string;
      memberOf: Membership[];
      /** Agents this space owns (names). */
      agents: string[];
      /** Agents connected to this space or owned by it, for the Agents tab. */
      agentList: AgentInfo[];
      collaborates: string[];
      here: Here[];
      activity: ActivityItem[];
    }
  | {
      level: 'project';
      fullName: string;
      space: string;
      name: string;
      description: string;
      defaultBranch: string;
      bytes: number;
      head: { oid: string; subject: string; author: string; time: string } | null;
      /** Repositories pinned by the DEPS file at the root (deps.ts); 0 without one. */
      deps: number;
      canWrite: boolean;
      owners: string[];
      members: string[];
      /** Agents that may push here: connected to the space, or collaborators on the project. */
      agents: string[];
      /** Agents brought to this project only, and who brought each; they may take it away. */
      brought: { agent: string; by: string }[];
      collaborators: string[];
      here: Here[];
      activity: ActivityItem[];
      /** The project's SPACE.md, read: its goal, outcomes, owners, rules and routines. */
      goal: SpaceGoal | null;
    };

/** What a new project can start from: the built-in goal space, or a project marked as a template. */
export interface Template {
  /** "goal" for the built-in one, else the project's full name. */
  id: string;
  title: string;
  about: string;
  builtin: boolean;
  outcomes: number;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const notFound = () => new ApiError('The requested file or folder was not found.', 404);

export function isVisibleName(name: string) {
  return !name.startsWith('.') && !OMITTED_NAMES.has(name) && !name.includes('\\') && !name.includes(':');
}

/** Same rules as open-chat: a rejected path stays rejected, never normalized. */
export function relativePath(requested: string): string {
  if (requested.includes('\0') || requested.includes('\\') || requested.includes(':') || requested.startsWith('/')) {
    throw new ApiError('Use a relative path inside the project.', 400);
  }
  const parts = requested.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw new ApiError('Path traversal is not allowed.', 400);
  if (parts.some(part => !isVisibleName(part))) throw new ApiError('Hidden files and dependency folders are not available.', 403);
  return parts.join('/');
}

// ---------------------------------------------------------------- git

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function hex(bytes: Uint8Array) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new ApiError('A folder on the hub is damaged.', 500);
    entries.push({ mode: decoder.decode(data.subarray(i, sp)), name: decoder.decode(data.subarray(sp + 1, nul)), oid: hex(data.subarray(nul + 1, nul + 21)) });
    i = nul + 21;
  }
  return entries;
}

export const isDirectoryMode = (mode: string) => mode === '40000' || mode === '040000';
/** Regular and executable files; symlinks and submodules are not files here. */
export const isFileMode = (mode: string) => mode === '100644' || mode === '100755';

export interface CommitInfo {
  tree: string;
  author: string;
  /** Committer time, seconds since the epoch. */
  time: number;
  subject: string;
}

export function parseCommit(data: Uint8Array): CommitInfo {
  const text = decoder.decode(data);
  const split = text.indexOf('\n\n');
  const info: CommitInfo = { tree: '', author: '', time: 0, subject: split >= 0 ? text.slice(split + 2).split('\n')[0].slice(0, 200) : '' };
  for (const line of (split >= 0 ? text.slice(0, split) : text).split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5);
    else if (line.startsWith('author ')) info.author = /^author (.*) <[^>]*> \d+ [+-]\d{4}$/.exec(line)?.[1] ?? '';
    else if (line.startsWith('committer ')) info.time = Number(/ (\d+) [+-]\d{4}$/.exec(line)?.[1] ?? 0);
  }
  return info;
}

type Project = NonNullable<ReturnType<Db['project']['fullName']['find']>>;

export function headOf(db: Db, project: Project): string {
  return db.gitRef.key.find(refKey(project.id, `refs/heads/${project.defaultBranch}`))?.oid ?? '';
}

function objectOf(db: Db, project: Project, oid: string, kind: string) {
  const object = readObject(db, project.id, oid);
  if (!object || object.kind !== kind) throw new ApiError(`The hub is missing a ${kind} of ${project.fullName}.`, 500);
  return object.data;
}

export function treeOf(db: Db, project: Project, oid: string): TreeEntry[] {
  return oid ? parseTree(objectOf(db, project, oid, 'tree')) : [];
}

/** Walk a project's default branch to `inner`: a folder (its entries) or a regular file. */
export function locate(db: Db, project: Project, root: string, inner: string): { kind: 'directory'; tree: TreeEntry[] } | { kind: 'file'; oid: string; mode: string } {
  let tree = treeOf(db, project, root);
  const parts = inner.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = tree.find(candidate => candidate.name === parts[i]);
    if (!entry) throw notFound();
    if (isDirectoryMode(entry.mode)) {
      tree = treeOf(db, project, entry.oid);
      continue;
    }
    if (!isFileMode(entry.mode) || i < parts.length - 1) throw notFound();
    return { kind: 'file', oid: entry.oid, mode: entry.mode };
  }
  return { kind: 'directory', tree };
}

// ---------------------------------------------------------------- files

function extensionOf(name: string) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function entryOf(path: string, kind: Entry['kind'], size: number, modifiedAt: string, detail?: string): Entry {
  const name = path.split('/').pop() ?? path;
  return { name, path, kind, extension: kind === 'directory' ? '' : extensionOf(name), size: kind === 'directory' ? 0 : size, modifiedAt, ...(detail ? { detail } : {}) };
}

export function compareEntries(left: Entry, right: Entry) {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
  return left.name.localeCompare(right.name, 'en', { numeric: true, sensitivity: 'base' }) || left.name.localeCompare(right.name, 'en');
}

export function fileFormat(entry: Entry): FileView['format'] {
  if (entry.path === DEPS_FILE) return 'json';
  if (['jsonl', 'ndjson'].includes(entry.extension)) return 'jsonl';
  if (entry.extension === 'url') return 'url';
  if (entry.extension === 'json') return 'json';
  if (['md', 'markdown', 'mdx'].includes(entry.extension)) return 'markdown';
  if (IMAGES.has(entry.extension)) return 'image';
  if (entry.extension === 'pdf') return 'pdf';
  if (TEXT_EXTENSIONS.has(entry.extension) || TEXT_NAMES.has(entry.name.toLowerCase())) return 'text';
  return 'unsupported';
}

/** Valid UTF-8 survives a decode and re-encode unchanged. */
function utf8(bytes: Uint8Array): string | null {
  const text = decoder.decode(bytes);
  if (text.includes('\0')) return null;
  const again = encoder.encode(text);
  if (again.length !== bytes.length) return null;
  for (let i = 0; i < again.length; i++) if (again[i] !== bytes[i]) return null;
  return text;
}

function fileView(entry: Entry, read: () => Uint8Array): FileView {
  const format = fileFormat(entry);
  const view: FileView = { ...entry, kind: 'file', format };
  if (format === 'unsupported') return { ...view, error: 'This file type has no preview. Its name and details are still shown.' };
  if (format === 'image' || format === 'pdf') return entry.size > MAX_PREVIEW_BYTES ? { ...view, error: 'This file is larger than the 20 MB preview limit.' } : view;
  if (entry.size > MAX_TEXT_BYTES) return { ...view, error: 'This file is larger than the 2 MB text preview limit.' };
  const content = utf8(read());
  if (content === null) return { ...view, format: 'unsupported', error: 'This file contains binary data or text that is not UTF-8.' };
  if (format === 'json') {
    try {
      return { ...view, content, data: JSON.parse(content) as unknown };
    } catch {
      // A DEPS file need not be JSON; then it is plain text.
      if (entry.extension !== 'json') return { ...view, format: 'text', content };
      return { ...view, content, error: 'This JSON is not valid yet. The original file contents are shown below.' };
    }
  }
  return { ...view, content };
}

// ---------------------------------------------------------------- folder READMEs

export interface Summary {
  title: string;
  line: string;
  status: string;
  owner: string;
  outputFormat: string;
}

/** Markdown on one line as plain text: no links, code marks, bold, bullets or quotes. */
function plainLine(line: string, max: number) {
  const text = line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/^(?:[-*+]|\d+\.)\s+/, '')
    .replace(/^>\s?/, '')
    .trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

/**
 * What a README says about its folder: its "# Title", its first line of
 * text, and the first line under "## Status", "## Owner" and "## Output
 * format" (the sections quirq's channels use; other READMEs rarely have them).
 */
export function summarize(markdown: string): Summary {
  const out: Summary = { title: '', line: '', status: '', owner: '', outputFormat: '' };
  const fields: Record<string, 'status' | 'owner' | 'outputFormat'> = { status: 'status', owner: 'owner', 'output format': 'outputFormat' };
  let fence = false;
  let field: 'status' | 'owner' | 'outputFormat' | undefined;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) fence = !fence;
    if (fence || /^(```|~~~)/.test(line) || !line || /^(\||<!--|---+$|===+$)/.test(line)) continue;
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      if (heading[1].length === 1 && !out.title) out.title = plainLine(heading[2], 80);
      field = heading[1].length === 2 ? fields[heading[2].toLowerCase()] : undefined;
      continue;
    }
    if (field) {
      if (!out[field]) out[field] = plainLine(line, 40);
    } else if (!out.line) out.line = plainLine(line, 160);
  }
  return out;
}

const looseName = (name: string) => name.toLowerCase().replace(/[-_\s]+/g, ' ').trim();

function readText(db: Db, project: Project, oid: string, limit: number): string | null {
  const size = Number(db.gitObject.key.find(objectKey(project.id, oid))?.size ?? 0n);
  if (size > limit) return null;
  const object = readObject(db, project.id, oid);
  return object && object.kind === 'blob' ? utf8(object.data) : null;
}

const readmeOf = (tree: TreeEntry[]) => tree.find(entry => isFileMode(entry.mode) && DOC_NAME.exec(entry.name)?.[1].toLowerCase() === 'readme');

/** A folder's row, with its README's title and first line instead of "Folder", and its labels. */
function folderSummary(db: Db, project: Project, name: string, oid: string): Pick<Entry, 'detail' | 'status' | 'owner' | 'outputFormat'> {
  const readme = readmeOf(treeOf(db, project, oid));
  const text = readme ? readText(db, project, readme.oid, SUMMARY_BYTES) : null;
  if (!text) return {};
  const { title, line, status, owner, outputFormat } = summarize(text);
  const named = title && looseName(title) !== looseName(name) ? title : '';
  const detail = [named, line].filter(Boolean).join(' · ');
  return { ...(detail ? { detail } : {}), ...(status ? { status } : {}), ...(owner ? { owner } : {}), ...(outputFormat ? { outputFormat } : {}) };
}

/** The documents shown under a folder: its README, and at the root the workspace's guides too. */
function docsOf(db: Db, project: Project, tree: TreeEntry[], base: string): Doc[] {
  const wanted = base ? ['readme'] : ROOT_DOCS;
  const found = new Map<string, Doc>();
  for (const entry of tree) {
    const kind = DOC_NAME.exec(entry.name)?.[1].toLowerCase() ?? '';
    if (!isFileMode(entry.mode) || !wanted.includes(kind) || found.has(kind)) continue;
    const content = readText(db, project, entry.oid, README_BYTES);
    if (content !== null) found.set(kind, { name: entry.name, path: base ? `${base}/${entry.name}` : entry.name, content });
  }
  return wanted.flatMap(kind => found.get(kind) ?? []);
}

// ---------------------------------------------------------------- levels

function iso(ts: { microsSinceUnixEpoch: bigint }) {
  return new Date(Number(ts.microsSinceUnixEpoch / 1000n)).toISOString();
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function bytesOf(db: Db, projectId: bigint) {
  return Number(db.projectSize.projectId.find(projectId)?.bytes ?? 0n);
}

function here(db: Db, now: number, keep: (row: { space: string; projectId: bigint; agent: string }) => boolean): Here[] {
  const rows = [...db.presence.iter()].filter(row => now - Number(row.seenAt.microsSinceUnixEpoch / 1_000_000n) <= PRESENCE_STALE_SECONDS && keep(row));
  const seen = new Set<string>();
  const out: Here[] = [];
  for (const row of rows) {
    const project = row.projectId === 0n ? '' : db.project.id.find(row.projectId)?.fullName ?? '';
    const key = `${row.agent}\0${row.mode}\0${project}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ agent: row.agent, mode: row.mode, project });
  }
  return out.sort((a, b) => a.agent.localeCompare(b.agent));
}

function activity(db: Db, keep: (row: { path: string; projectId: bigint }) => boolean): ActivityItem[] {
  const rows = [...db.activity.iter()].filter(keep).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, ACTIVITY_SHOWN);
  return rows.map(row => ({ at: iso(row.at), agent: row.agent, kind: row.kind, path: row.path, subject: row.subject, text: row.text, count: row.count, oid: row.oid }));
}

function finish(snapshot: Omit<Snapshot, 'revision'>, meta: Meta) {
  // Content and metadata both participate, so any change refreshes the app.
  const revision = new Sha1().update(encoder.encode(JSON.stringify([snapshot, meta]))).hex();
  return { snapshot: { ...snapshot, revision }, meta };
}

function rootId(key: string) {
  return new Sha1().update(encoder.encode(`hub\0${key}`)).hex();
}

const isAgent = (db: Db, name: string) => db.space.name.find(name)?.kind === 'agent';

/** Owners, the people who are members, and the agents connected as members. */
function rolesOf(db: Db, space: string) {
  const row = db.space.name.find(space);
  const roles = [...db.spaceRole.space.filter(space)];
  const owners = row?.kind === 'personal' ? [space] : row?.kind === 'agent' ? [row.parent] : roles.filter(role => role.role === 'owner').map(role => role.member).sort();
  const rest = roles.filter(role => role.role !== 'owner').map(role => role.member).sort();
  return { owners, members: rest.filter(name => !isAgent(db, name)), agents: rest.filter(name => isAgent(db, name)) };
}

function projectPeople(db: Db, project: Project) {
  const { owners, members, agents } = rolesOf(db, project.owner);
  const rows = [...db.projectMember.projectId.filter(project.id)];
  const collaborators = rows.map(row => row.agent);
  return {
    owners,
    members,
    agents: [...new Set([...agents, ...collaborators.filter(name => isAgent(db, name))])].sort(),
    brought: rows.filter(row => isAgent(db, row.agent)).map(row => ({ agent: row.agent, by: row.addedBy })).sort((a, b) => a.agent.localeCompare(b.agent)),
    collaborators: collaborators.filter(name => !isAgent(db, name)).sort(),
  };
}

function agentInfo(db: Db, name: string, space: string, now: number): AgentInfo {
  const row = db.space.name.find(name);
  const spaces = [...db.spaceRole.member.filter(name)].map(role => role.space).sort();
  const running = [...db.presence.iter()]
    .filter(p => p.agent === name && p.mode === 'agent' && now - Number(p.seenAt.microsSinceUnixEpoch / 1_000_000n) <= PRESENCE_STALE_SECONDS)
    .map(p => ({ host: p.host, since: iso(p.since) }));
  const hosts = new Set<string>();
  return {
    name,
    description: row?.description ?? '',
    parent: row?.parent ?? '',
    owned: row?.parent === space,
    connected: spaces.includes(space),
    spaces,
    running: running.filter(r => (hosts.has(r.host) ? false : (hosts.add(r.host), true))),
  };
}

/** Every agent a space owns or lets push to it, running ones first. */
function agentsOf(db: Db, space: string, now: number): AgentInfo[] {
  const names = new Set<string>([
    ...[...db.space.kind.filter('agent')].filter(agent => agent.parent === space).map(agent => agent.name),
    ...rolesOf(db, space).agents,
  ]);
  return [...names].map(name => agentInfo(db, name, space, now)).sort((a, b) => Number(b.running.length > 0) - Number(a.running.length > 0) || a.name.localeCompare(b.name));
}

/** The GitHub login behind a space: a builder who signed up with GitHub, or an org linked to a GitHub account. */
function githubLoginOf(db: Db, name: string): string {
  const account = db.githubAccount.username.find(name);
  if (account) return account.login;
  const source = db.spaceLink.space.find(name)?.source ?? '';
  return /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})$/.exec(source)?.[1] ?? '';
}

/** What an avatar needs: the kind of name and its GitHub login, if any. */
export function avatarOf(db: Db, name: string) {
  const space = db.space.name.find(name);
  const kind = space?.kind ?? (db.agent.name.find(name) ? 'agent' : db.user.username.find(name) ? 'personal' : '');
  return { name, kind, githubLogin: kind ? githubLoginOf(db, name) : '' };
}

function hubLevel(db: Db, now: number) {
  const projects = [...db.project.iter()];
  const counts = new Map<string, number>();
  for (const project of projects) counts.set(project.owner, (counts.get(project.owner) ?? 0) + 1);
  const latest = new Map<string, string>();
  for (const project of projects) {
    const at = iso(project.pushedAt);
    if ((latest.get(project.owner) ?? '') < at) latest.set(project.owner, at);
  }
  const spaces = [...db.space.iter()].filter(space => isVisibleName(space.name));
  const entries = spaces
    .map(space => entryOf(space.name, 'directory', 0, latest.get(space.name) ?? iso(space.createdAt), `${space.kind === 'personal' ? 'builder' : space.kind} · ${plural(counts.get(space.name) ?? 0, 'project')}`))
    .sort(compareEntries);
  const bytes = projects.reduce((sum, project) => sum + bytesOf(db, project.id), 0);
  return finish(
    { rootName: 'spacehub', rootId: rootId(''), roots: [], directory: { path: '', name: 'spacehub', entries } },
    {
      level: 'hub',
      spaces: spaces.length,
      projects: projects.length,
      bytes,
      // Every activity row since the hub began, and who builds here: builders' personal spaces and agents.
      events: Number(db.activity.count()),
      humans: spaces.filter(space => space.kind === 'personal').length,
      agents: spaces.filter(space => space.kind === 'agent').length,
      activity: activity(db, () => true),
      here: here(db, now, () => true),
      allProjects: projects
        .map(project => ({ fullName: project.fullName, description: project.description, pushedAt: iso(project.pushedAt) }))
        .sort((a, b) => b.pushedAt.localeCompare(a.pushedAt))
        .slice(0, 1000),
    }
  );
}

function spaceLevel(db: Db, name: string, now: number) {
  const space = db.space.name.find(name);
  if (!space) throw new ApiError(`There is no space named ${name}.`, 404);
  const projects = [...db.project.owner.filter(name)];
  const entries = projects
    .filter(project => isVisibleName(project.name))
    .map(project => ({
      ...entryOf(project.name, 'directory', 0, iso(project.pushedAt), project.description || `${headOf(db, project) ? 'branch ' + project.defaultBranch : 'empty'}`),
      ...goalFields(goalOf(db, project)),
    }))
    .sort(compareEntries);
  const { owners, members } = rolesOf(db, name);
  const agentList = agentsOf(db, name, now);
  const ids = new Set(projects.map(project => project.id));
  const memberOf = [...db.spaceRole.member.filter(name)].map(role => ({ space: role.space, kind: db.space.name.find(role.space)?.kind ?? '', role: role.role })).sort((a, b) => a.space.localeCompare(b.space));
  return finish(
    { rootName: name, rootId: rootId(name), roots: [], directory: { path: '', name, entries } },
    {
      level: 'space',
      name,
      displayName: space.displayName || name,
      kind: space.kind,
      description: space.description,
      parent: space.parent,
      owners,
      members,
      projects: projects.length,
      bytes: projects.reduce((sum, project) => sum + bytesOf(db, project.id), 0),
      github: db.spaceLink.space.find(name)?.source ?? '',
      githubLogin: githubLoginOf(db, name),
      createdAt: iso(space.createdAt),
      memberOf,
      agents: [...db.space.kind.filter('agent')].filter(agent => agent.parent === name).map(agent => agent.name).sort(),
      agentList,
      collaborates: [...db.projectMember.agent.filter(name)].map(row => db.project.id.find(row.projectId)?.fullName ?? '').filter(Boolean).sort(),
      here: here(db, now, row => (row.projectId === 0n ? row.space === name : ids.has(row.projectId)) || row.agent === name),
      activity: activity(db, row => row.path === name || row.path.startsWith(`${name}/`) || ids.has(row.projectId)),
    }
  );
}

function projectLevel(db: Db, project: Project, requested: string, viewer: string | null, now: number) {
  const relative = relativePath(requested);
  const head = headOf(db, project);
  const commit = head ? parseCommit(objectOf(db, project, head, 'commit')) : null;
  const time = commit?.time ? new Date(commit.time * 1000).toISOString() : iso(project.pushedAt);
  const at = locate(db, project, commit?.tree ?? '', relative);
  const isFile = at.kind === 'file';
  const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
  const directoryPath = isFile ? parent : relative;
  const list = (tree: TreeEntry[], base: string, summaries: boolean) => {
    const visible = tree.filter(entry => isVisibleName(entry.name) && (isDirectoryMode(entry.mode) || isFileMode(entry.mode)));
    if (visible.length > MAX_DIRECTORY_ENTRIES) throw new ApiError(`This folder contains more than ${MAX_DIRECTORY_ENTRIES} entries.`, 413);
    const summarized = summaries && visible.filter(entry => isDirectoryMode(entry.mode)).length <= SUMMARIZED_FOLDERS;
    return visible
      .map(entry => isDirectoryMode(entry.mode)
        ? { ...entryOf(base ? `${base}/${entry.name}` : entry.name, 'directory', 0, time), ...(summarized ? folderSummary(db, project, entry.name, entry.oid) : {}) }
        : entryOf(base ? `${base}/${entry.name}` : entry.name, 'file', Number(db.gitObject.key.find(objectKey(project.id, entry.oid))?.size ?? 0n), time))
      .sort(compareEntries);
  };
  const rootTree = treeOf(db, project, commit?.tree ?? '');
  const directoryTree = directoryPath === '' ? rootTree : (() => {
    const dir = locate(db, project, commit?.tree ?? '', directoryPath);
    if (dir.kind !== 'directory') throw notFound();
    return dir.tree;
  })();
  // Summaries and documents only for the folder being looked at, not for the file beside them.
  const directory = list(directoryTree, directoryPath, !isFile);
  const rootEntries = directoryPath === '' ? directory : list(rootTree, '', false);
  const docs = isFile ? [] : docsOf(db, project, directoryTree, directoryPath);
  let file: FileView | undefined;
  if (at.kind === 'file') {
    const size = Number(db.gitObject.key.find(objectKey(project.id, at.oid))?.size ?? 0n);
    file = fileView(entryOf(relative, 'file', size, time), () => objectOf(db, project, at.oid, 'blob'));
  }
  const depsSource = depsText(db, project, rootTree);
  const deps = depsSource === null ? 0 : parseDeps(depsSource)?.length ?? 0;
  const canWrite = !!viewer && (inSpace(db, project.owner, viewer) || !!db.projectMember.key.find(`${project.id}:${viewer}`));
  return finish(
    {
      rootName: project.name,
      rootId: rootId(project.fullName),
      roots: rootEntries.filter(entry => entry.kind === 'directory'),
      directory: { path: directoryPath, name: directoryPath ? directoryPath.split('/').pop()! : project.name, entries: directory, ...(docs.length ? { docs } : {}) },
      ...(file ? { file } : {}),
    },
    {
      level: 'project',
      fullName: project.fullName,
      space: project.owner,
      name: project.name,
      description: project.description,
      defaultBranch: project.defaultBranch,
      bytes: bytesOf(db, project.id),
      head: commit ? { oid: head, subject: commit.subject, author: commit.author, time } : null,
      deps,
      canWrite,
      ...projectPeople(db, project),
      here: here(db, now, row => row.projectId === project.id),
      activity: activity(db, row => row.projectId === project.id),
      goal: goalOf(db, project, rootTree),
    }
  );
}

// ---------------------------------------------------------------- goals and templates

/** A project's SPACE.md at the root of its default branch, read; null without one. */
export function goalOf(db: Db, project: Project, rootTree?: TreeEntry[]): SpaceGoal | null {
  const tree = rootTree ?? (() => {
    const head = headOf(db, project);
    return head ? treeOf(db, project, parseCommit(objectOf(db, project, head, 'commit')).tree) : [];
  })();
  const entry = tree.find(candidate => candidate.name === SPACE_FILE && isFileMode(candidate.mode));
  const text = entry ? readText(db, project, entry.oid, SUMMARY_BYTES) : null;
  return text === null ? null : parseSpace(text);
}

function goalFields(goal: SpaceGoal | null): Pick<Entry, 'goal' | 'progress' | 'template'> {
  if (!goal) return {};
  const progress = progressOf(goal);
  // A template's goal is a placeholder for the spaces it starts; its card says what it is for instead.
  const line = goal.template ? goal.template : goal.goal;
  return { ...(line ? { goal: line } : {}), ...(progress.total ? { progress } : {}), ...(goal.template !== null ? { template: true } : {}) };
}

/** The built-in goal space first, then every project whose SPACE.md has "## Template", by name. */
export function templatesView(db: Db): Template[] {
  const builtin = parseSpace(BUILTIN_FILES[SPACE_FILE]);
  const projects = [...db.project.iter()]
    .filter(project => isVisibleName(project.name))
    .flatMap(project => {
      const goal = goalOf(db, project);
      if (!goal || goal.template === null) return [];
      return [{ id: project.fullName, title: goal.title || project.fullName, about: goal.template || project.description, builtin: false, outcomes: goal.outcomes.length }];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return [{ id: BUILTIN_TEMPLATE, title: BUILTIN_TITLE, about: BUILTIN_ABOUT, builtin: true, outcomes: builtin.outcomes.length }, ...projects];
}

/**
 * A template's files: the built-in goal space, or a template project's
 * default branch (regular files and symlinks; submodules are left out).
 */
export function templateFiles(db: Db, id: string): Map<string, TemplateFile> {
  if (!id || id === BUILTIN_TEMPLATE) return textFiles(BUILTIN_FILES);
  const project = db.project.fullName.find(id.toLowerCase()) ?? db.project.fullName.find(id);
  if (!project) throw new ApiError(`There is no template ${id}.`, 404);
  const goal = goalOf(db, project);
  if (!goal || goal.template === null) throw new ApiError(`${id} is not a template: its SPACE.md needs a "## Template" section.`, 400);
  const head = headOf(db, project);
  const files = new Map<string, TemplateFile>();
  let bytes = 0;
  const walk = (oid: string, base: string) => {
    for (const entry of treeOf(db, project, oid)) {
      const path = base ? `${base}/${entry.name}` : entry.name;
      if (isDirectoryMode(entry.mode)) { walk(entry.oid, path); continue; }
      if (!isFileMode(entry.mode) && entry.mode !== '120000') continue;
      if (files.size >= MAX_TEMPLATE_FILES) throw new ApiError(`A template holds at most ${MAX_TEMPLATE_FILES} files.`, 413);
      const data = objectOf(db, project, entry.oid, 'blob');
      bytes += data.length;
      if (bytes > MAX_TEMPLATE_BYTES) throw new ApiError(`A template holds at most ${MAX_TEMPLATE_BYTES / 1024 / 1024} MB.`, 413);
      files.set(path, { mode: entry.mode, data });
    }
  };
  walk(parseCommit(objectOf(db, project, head, 'commit')).tree, '');
  return files;
}

export function parseQuery(qs: string) {
  const query = new Map<string, string>();
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      return value;
    }
  };
  for (const pair of qs.split('#')[0].split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    query.set(decode(eq < 0 ? pair : pair.slice(0, eq)), eq < 0 ? '' : decode(pair.slice(eq + 1)));
  }
  return query;
}

export interface ApiRequest {
  query: Map<string, string>;
  /** The signed-in builder's name, from the display cookie; only used to show what is possible. */
  viewer: string | null;
  now: number;
}

export function workspace(db: Db, req: ApiRequest) {
  const space = (req.query.get('space') ?? '').toLowerCase();
  const project = req.query.get('project') ?? '';
  if (!space) return hubLevel(db, req.now);
  if (!project) return spaceLevel(db, space, req.now);
  const row = db.project.fullName.find(`${space}/${project}`);
  if (!row) throw new ApiError(`There is no project ${space}/${project}.`, 404);
  return projectLevel(db, row, req.query.get('path') ?? '', req.viewer, req.now);
}

/** The code views (code.ts) of a project, by `view`. */
export function codeView(db: Db, req: ApiRequest): unknown {
  const space = (req.query.get('space') ?? '').toLowerCase();
  const row = db.project.fullName.find(`${space}/${req.query.get('project') ?? ''}`);
  if (!row) throw new ApiError('There is no such project.', 404);
  const ref = req.query.get('ref') ?? '';
  const path = req.query.get('path') ?? '';
  try {
    switch (req.query.get('view')) {
      case 'refs': return refsView(db, row, req.now);
      case 'tree': return treeView(db, row, ref, path, req.now);
      case 'commits': return commitsView(db, row, ref, path, Number(req.query.get('page') ?? 1), req.now);
      case 'commit': return commitView(db, row, req.query.get('oid') ?? '', req.now);
      case 'files': return filesView(db, row, ref, req.now);
      case 'deps': return depsView(db, row, req.now);
      default: throw new ApiError('Unknown view.', 400);
    }
  } catch (error) {
    if (error instanceof CodeError) throw new ApiError(error.message, error.status);
    throw error;
  }
}

export function renderApi(db: Db, req: ApiRequest): { status: number; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  try {
    if (req.query.has('avatar')) return { status: 200, headers, body: JSON.stringify(avatarOf(db, (req.query.get('avatar') ?? '').toLowerCase())) };
    if (req.query.has('templates')) return { status: 200, headers, body: JSON.stringify({ templates: templatesView(db) }) };
    if (req.query.has('view')) {
      const body = JSON.stringify(codeView(db, req));
      // Same content, same tag: the app polls these views too.
      return { status: 200, headers: { ...headers, etag: `"${new Sha1().update(encoder.encode(body)).hex()}"` }, body };
    }
    const result = workspace(db, req);
    return { status: 200, headers: { ...headers, etag: `"${result.snapshot.revision}"` }, body: JSON.stringify(result) };
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return { status, headers, body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) };
  }
}
