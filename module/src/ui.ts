// The web UI: a GitHub-like view of everything in the database, rendered to
// HTML inside the module. Pages work without JavaScript; behind the server's
// proxy, live pages (home, spaces, projects) also load /-/live.js, which
// swaps in each new rendering the web service streams when their data changes.
//
//   /                                         projects, spaces, builders, activity
//   /<space>                                  a builder's, org's or agent's space
//   /<space>/<project>                        files at the default branch + README
//   /<space>/<project>/tree/<ref>/<path>      a folder (last commit per entry)
//   /<space>/<project>/blob/<ref>/<path>      a file: code with line links, Markdown
//                                             preview (?plain=1 for source), images
//   /<space>/<project>/raw/<ref>/<path>       a file, as plain bytes
//   /<space>/<project>/commits/<ref>/<path>   history, optionally of one path (?page=N)
//   /<space>/<project>/commit/<oid>           one commit with line diffs
//   /<space>/<project>/refs                   branches and tags
//   /<space>/<project>/activity               that project's activity (?page=N); the
//                                             home page shows the whole hub's (?page=N)
//   /-/builders, /-/builders/<login>          who built the code (builders and GitHub accounts)
//   /-/guide                                  get started, words, working together, agents, GitHub, git, help
//
// The hub's own pages live under /-/ so any GitHub name can be a space;
// /guide and /builders redirect there unless a space has that name.
//
// Behind the server's proxy the original request URI arrives in an
// X-Spacehub-Uri header and links are written as /<path>. Opened directly on
// SpacetimeDB (/v1/database/<db>/route/ui?p=<path>) links stay as ?p=<path>.
// Sign-in state comes from a display-only cookie; every write goes through
// the web service (/-/...), which checks the real session.
import { PRESENCE_STALE_SECONDS, inSpace, ownsSpace, readObject, type Db } from './store';
import { DELETE, INSERT, diffLines, toHunks } from './diff';
import { renderMarkdown, type Resolve } from './markdown';
import { esc, navFor, PAGE_CSP, shell, sideFor } from './style';
import { guideHome, guidePage } from './guide';

export interface UiRequest {
  uri: string;
  forwardedUri: string | null;
  cookie: string | null;
  proto: string | null;
  now: number;
}

export interface UiResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

type Project = NonNullable<ReturnType<Db['project']['fullName']['find']>>;
type Activity = NonNullable<ReturnType<Db['activity']['id']['find']>>;
type Presence = NonNullable<ReturnType<Db['presence']['connectionId']['find']>>;

interface Person {
  name: string;
  email: string;
  time: number;
}

export interface Commit {
  oid: string;
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}

export interface Entry {
  mode: string;
  name: string;
  oid: string;
  type: 'tree' | 'blob' | 'commit';
}

// Who built a project's code: a GitHub account (an explicit project_builder
// row, else the owner of the project's GitHub import source), else the
// builder here who made it (a personal space's builder, or whoever created
// the project in an org).
interface Builder {
  kind: 'github' | 'hub';
  handle: string; // GitHub login (lowercase) or builder name
  name: string;
  url: string; // GitHub profile, or "" for a builder here
}

export interface Change {
  status: string;
  path: string;
  before: string | null;
  after: string | null;
}

export class NotFound extends Error {}

const decoder = new TextDecoder('utf-8');
const MAX_SHOWN_BYTES = 1024 * 1024;
const PAGE_SIZE = 50;
const ACTIVITY_PAGE = 30;
const HISTORY_SCAN = 5000;
const LAST_COMMIT_SCAN = 400;
const COUNT_CAP = 10000;
const DIFF_FILES = 300;
const DIFF_MAX_BYTES = 256 * 1024;
const DIFF_MAX_ROWS = 4000;
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------- request

function decodeParam(s: string) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

function parseQuery(qs: string) {
  const query = new Map<string, string>();
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    query.set(decodeParam(eq < 0 ? pair : pair.slice(0, eq)), eq < 0 ? '' : decodeParam(pair.slice(eq + 1)));
  }
  return query;
}

function parseRequest(req: UiRequest) {
  if (req.forwardedUri !== null) {
    const [path, qs = ''] = req.forwardedUri.split('#')[0].split('?', 2);
    const segs = path
      .split('/')
      .filter(Boolean)
      .map(seg => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return seg;
        }
      });
    return { segs, query: parseQuery(qs) };
  }
  const q = req.uri.indexOf('?');
  const query = parseQuery(q >= 0 ? req.uri.slice(q + 1) : '');
  const segs = (query.get('p') ?? '').split('/').filter(Boolean);
  query.delete('p');
  return { segs, query };
}

function cookie(header: string | null, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeParam(part.slice(eq + 1).trim());
  }
  return null;
}

function hostOf(uri: string) {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(uri);
  return m ? m[1] : 'localhost';
}

// ---------------------------------------------------------------- formatting

function hex(bytes: Uint8Array) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function size(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function seconds(ts: { microsSinceUnixEpoch: bigint }) {
  return Number(ts.microsSinceUnixEpoch / 1_000_000n);
}

function shortRef(name: string) {
  return name.replace(/^refs\/(heads|tags)\//, '');
}

function dayLabel(t: number) {
  const d = new Date(t * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function plural(n: number, word: string) {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

function isBinary(data: Uint8Array) {
  return data.subarray(0, 8000).includes(0);
}

function extOf(path: string) {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? m[1].toLowerCase() : '';
}

function textLines(data: Uint8Array) {
  if (data.length === 0) return [];
  const lines = decoder.decode(data).split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---------------------------------------------------------------- git parsing

function parsePerson(value: string): Person {
  const m = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(value);
  return m ? { name: m[1], email: m[2], time: Number(m[3]) } : { name: value, email: '', time: 0 };
}

function parseHeaders(data: Uint8Array) {
  const text = decoder.decode(data);
  const split = text.indexOf('\n\n');
  const headers: [string, string][] = [];
  for (const line of (split >= 0 ? text.slice(0, split) : text).split('\n')) {
    if (line.startsWith(' ')) continue;
    const sp = line.indexOf(' ');
    headers.push([line.slice(0, sp), line.slice(sp + 1)]);
  }
  return { headers, message: split >= 0 ? text.slice(split + 2) : '' };
}

function parseCommit(oid: string, data: Uint8Array): Commit {
  const { headers, message } = parseHeaders(data);
  const commit: Commit = { oid, tree: '', parents: [], author: parsePerson(''), committer: parsePerson(''), message };
  for (const [key, value] of headers) {
    if (key === 'tree') commit.tree = value;
    else if (key === 'parent') commit.parents.push(value);
    else if (key === 'author') commit.author = parsePerson(value);
    else if (key === 'committer') commit.committer = parsePerson(value);
  }
  return commit;
}

function parseTree(data: Uint8Array): Entry[] {
  const entries: Entry[] = [];
  let i = 0;
  while (i < data.length) {
    let sp = i;
    while (data[sp] !== 0x20) sp++;
    let nul = sp + 1;
    while (data[nul] !== 0) nul++;
    const mode = String.fromCharCode(...data.subarray(i, sp));
    const type = mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
    entries.push({ mode, name: decoder.decode(data.subarray(sp + 1, nul)), oid: hex(data.subarray(nul + 1, nul + 21)), type });
    i = nul + 21;
  }
  return entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : b.type === 'tree' ? 1 : a.name.localeCompare(b.name)
  );
}

// ---------------------------------------------------------------- rendering

const ICON_DIR =
  '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.22.78 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg>';
const ICON_FILE =
  '<svg class="i f" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/></svg>';

// Also the app's code views (code.ts) reuse its git helpers: commit, tree,
// locate, resolve, history, touches, lastChanges, changes, blobText, refs.
export class Renderer {
  private base: string | null;
  private host: string;
  private secure: boolean;
  private viewer: string | null;
  private now: number;
  private commits = new Map<string, Commit | null>();
  private trees = new Map<string, Entry[]>();
  private refreshing = false;
  // Set by route() for pages the web service keeps live.
  live = false;
  // Which place of the sidebar the page belongs to (set by route()).
  current: 'home' | 'guide' | 'builders' | 'me' | '' = '';

  constructor(
    private db: Db,
    req: UiRequest,
    private query: Map<string, string>
  ) {
    const proxied = req.forwardedUri !== null;
    this.base = proxied ? '/' : null;
    this.host = hostOf(req.uri);
    this.secure = req.proto === 'https' || !/^(localhost|127\.|\[::1\])/.test(this.host);
    const who = proxied ? cookie(req.cookie, 'spacehub_user') : null;
    // Display only (the web service checks the real session); still, never
    // show a username this database does not know.
    this.viewer = who && /^[a-z0-9-]{1,39}$/.test(who) && db.user.username.find(who) ? who : null;
    this.now = req.now;
  }

  // ------------------------------------------------------------ links

  link(path: string, query: Record<string, string | number> = {}) {
    const clean = path.split('/').filter(Boolean);
    const qs = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    if (this.base === null) return `?p=${encodeURIComponent(clean.join('/'))}${qs ? `&${qs}` : ''}`;
    return `/${clean.map(encodeURIComponent).join('/')}${qs ? `?${qs}` : ''}`;
  }

  a(path: string, text: string, cls = '', query: Record<string, string | number> = {}) {
    return `<a href="${esc(this.link(path, query))}"${cls ? ` class="${cls}"` : ''}>${text}</a>`;
  }

  ago(t: number) {
    const d = this.now - t;
    const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'} ago`;
    if (d < 60) return 'just now';
    if (d < 3600) return unit(Math.floor(d / 60), 'minute');
    if (d < 86400) return unit(Math.floor(d / 3600), 'hour');
    if (d < 86400 * 30) return unit(Math.floor(d / 86400), 'day');
    return `on ${dayLabel(t)}`;
  }

  page(title: string, body: string, status = 200): UiResponse {
    const nav = this.base === null ? '' : navFor(this.viewer);
    const side = this.base === null ? '' : sideFor(this.viewer, this.current);
    // Live pages update themselves; without JavaScript they fall back to
    // reloading while an import runs.
    const live = this.live && this.base !== null;
    const refresh = '<meta http-equiv="refresh" content="4">';
    const head = `${this.refreshing ? (live ? `<noscript>${refresh}</noscript>` : refresh) : ''}${live ? '<script src="/-/live.js" defer></script>' : ''}`;
    return { status, headers: { 'content-type': 'text/html; charset=utf-8' }, body: shell(title, nav, body, head, this.link(''), side) };
  }

  notFound(message: string) {
    return this.page('Not found', `<h1>Not found</h1><p class="desc">${esc(message)}</p><p>${this.a('', 'Back to all spaces')}</p>`, 404);
  }

  // ------------------------------------------------------------ git access

  commit(sp: Project, oid: string): Commit | null {
    if (this.commits.has(oid)) return this.commits.get(oid)!;
    let target = oid;
    let obj = readObject(this.db, sp.id, target);
    for (let hops = 0; obj && obj.kind === 'tag' && hops < 8; hops++) {
      const m = /^object ([0-9a-f]{40})$/m.exec(decoder.decode(obj.data));
      target = m ? m[1] : '';
      obj = m ? readObject(this.db, sp.id, target) : null;
    }
    const commit = obj && obj.kind === 'commit' ? parseCommit(target, obj.data) : null;
    this.commits.set(oid, commit);
    return commit;
  }

  tree(sp: Project, oid: string): Entry[] {
    const cached = this.trees.get(oid);
    if (cached) return cached;
    const obj = readObject(this.db, sp.id, oid);
    if (!obj || obj.kind !== 'tree') throw new NotFound(`tree ${oid} is missing`);
    const entries = parseTree(obj.data);
    this.trees.set(oid, entries);
    return entries;
  }

  // The entry at `path` under a root tree, or null when it does not exist.
  locate(sp: Project, root: string, path: string[]): { type: Entry['type']; oid: string } | null {
    let current: { type: Entry['type']; oid: string } = { type: 'tree', oid: root };
    for (const name of path) {
      if (current.type !== 'tree') return null;
      const entry = this.tree(sp, current.oid).find(e => e.name === name);
      if (!entry) return null;
      current = { type: entry.type, oid: entry.oid };
    }
    return current;
  }

  refs(sp: Project) {
    return [...this.db.gitRef.projectId.filter(sp.id)].sort((a, b) => a.name.localeCompare(b.name));
  }

  // "<ref>/<path...>": the longest prefix naming a branch or tag wins, else
  // a full commit id.
  resolve(sp: Project, segs: string[]) {
    const refs = this.refs(sp);
    for (let k = segs.length; k >= 1; k--) {
      const name = segs.slice(0, k).join('/');
      const ref = refs.find(r => r.name === `refs/heads/${name}`) ?? refs.find(r => r.name === `refs/tags/${name}`);
      if (ref) return { ref: name, oid: ref.oid, rest: segs.slice(k) };
    }
    if (segs[0] && /^[0-9a-f]{40}$/.test(segs[0])) return { ref: segs[0], oid: segs[0], rest: segs.slice(1) };
    throw new NotFound(`no branch, tag or commit "${segs.join('/')}"`);
  }

  // Commits reachable from `tip`, newest first by commit time.
  history(sp: Project, tip: string, limit: number): Commit[] {
    const first = this.commit(sp, tip);
    if (!first) return [];
    const seen = new Set([first.oid]);
    const frontier = [first];
    const out: Commit[] = [];
    while (frontier.length > 0 && out.length < limit) {
      let best = 0;
      for (let i = 1; i < frontier.length; i++) if (frontier[i].committer.time > frontier[best].committer.time) best = i;
      const c = frontier.splice(best, 1)[0];
      out.push(c);
      for (const p of c.parents) {
        if (seen.has(p)) continue;
        seen.add(p);
        const pc = this.commit(sp, p);
        if (pc) frontier.push(pc);
      }
    }
    return out;
  }

  countCommits(sp: Project, tip: string) {
    const first = this.commit(sp, tip);
    if (!first) return 0;
    const seen = new Set([first.oid]);
    const stack = [first];
    while (stack.length > 0 && seen.size < COUNT_CAP) {
      for (const p of stack.pop()!.parents) {
        if (seen.has(p)) continue;
        seen.add(p);
        const pc = this.commit(sp, p);
        if (pc) stack.push(pc);
      }
    }
    return seen.size;
  }

  // Did `c` change `path` compared with its first parent?
  touches(sp: Project, c: Commit, path: string[]) {
    if (path.length === 0) return true;
    const now = this.locate(sp, c.tree, path)?.oid ?? null;
    const parent = c.parents[0] ? this.commit(sp, c.parents[0]) : null;
    const before = parent ? (this.locate(sp, parent.tree, path)?.oid ?? null) : null;
    return now !== before;
  }

  // The most recent commit that changed each named entry of a folder, and
  // the folder itself, scanning back at most LAST_COMMIT_SCAN commits.
  lastChanges(sp: Project, tip: string, folder: string[], names: string[]) {
    const byName = new Map<string, Commit>();
    let folderCommit: Commit | null = null;
    const folderAt = (c: Commit) => (folder.length ? (this.locate(sp, c.tree, folder)?.oid ?? null) : c.tree);
    const entriesAt = (oid: string | null) => new Map(oid ? this.tree(sp, oid).map(e => [e.name, e.oid] as [string, string]) : []);
    for (const c of this.history(sp, tip, LAST_COMMIT_SCAN)) {
      const now = folderAt(c);
      const parent = c.parents[0] ? this.commit(sp, c.parents[0]) : null;
      const before = parent ? folderAt(parent) : null;
      if (now === before) continue;
      folderCommit ??= c;
      const cur = entriesAt(now);
      const prev = entriesAt(before);
      for (const name of names) {
        if (byName.has(name)) continue;
        const oid = cur.get(name);
        if (oid !== undefined && oid !== prev.get(name)) byName.set(name, c);
      }
      if (byName.size === names.length) break;
    }
    return { folderCommit, byName };
  }

  // ------------------------------------------------------------ shared parts

  importRow(sp: Project) {
    return this.db.projectImport.projectId.find(sp.id) ?? null;
  }

  builderOf(sp: Project): Builder {
    const row = this.db.projectBuilder.projectId.find(sp.id);
    if (row && row.url.startsWith('https://github.com/')) return { kind: 'github', handle: row.handle, name: this.builderName(row.handle, row.name), url: row.url };
    const source = this.importRow(sp)?.source ?? '';
    const gh = /^https:\/\/github\.com\/([^/]+)\//.exec(source);
    if (gh) {
      const handle = gh[1].toLowerCase();
      return { kind: 'github', handle, name: this.builderName(handle, gh[1]), url: `https://github.com/${gh[1]}` };
    }
    const space = this.db.space.name.find(sp.owner);
    const maker = !space || space.kind === 'personal' ? sp.owner : (this.db.user.identity.find(sp.ownerIdentity)?.username ?? sp.owner);
    return { kind: 'hub', handle: maker, name: maker, url: '' };
  }

  // A GitHub builder's best known name: any recorded display name
  // ("Anthropic") beats the bare login ("anthropics").
  private displayNames: Map<string, string> | null = null;
  builderName(handle: string, fallback: string) {
    if (!this.displayNames) {
      this.displayNames = new Map();
      for (const r of this.db.projectBuilder.iter()) if (r.name.toLowerCase() !== r.handle) this.displayNames.set(r.handle, r.name);
    }
    return this.displayNames.get(handle) ?? fallback;
  }

  builderLink(b: Builder) {
    return b.kind === 'hub' ? this.a(b.handle, esc(b.name)) : this.a(`-/builders/${b.handle}`, esc(b.name));
  }

  builderKind(b: Builder) {
    return `<span class="pill">${b.kind === 'hub' ? 'builder' : 'GitHub'}</span>`;
  }

  // "built by X" for listings, when someone other than the space built it.
  builtBy(sp: Project) {
    const b = this.builderOf(sp);
    return b.kind === 'hub' && b.handle === sp.owner ? '' : `<div class="muted">built by ${this.builderLink(b)}</div>`;
  }

  // Every builder here (with or without projects) and every GitHub account
  // credited with a project, by how many projects they built.
  builders() {
    const groups = new Map<string, { builder: Builder; spaces: Project[] }>();
    for (const u of this.db.user.iter()) groups.set(`hub:${u.username}`, { builder: { kind: 'hub', handle: u.username, name: u.username, url: '' }, spaces: [] });
    for (const sp of this.db.project.iter()) {
      const b = this.builderOf(sp);
      const key = `${b.kind}:${b.handle}`;
      const g = groups.get(key) ?? { builder: b, spaces: [] };
      g.spaces.push(sp);
      groups.set(key, g);
    }
    return [...groups.values()].sort((x, y) => y.spaces.length - x.spaces.length || x.builder.name.localeCompare(y.builder.name));
  }

  kindOf(space: string) {
    return this.db.space.name.find(space)?.kind ?? 'personal';
  }

  spacePill(space: string) {
    const kind = this.kindOf(space);
    return `<span class="pill">${kind === 'personal' ? 'builder' : esc(kind)}</span>`;
  }

  syncForm(sp: Project, label: string) {
    if (this.base === null || !ownsSpace(this.db, sp.owner, this.viewer)) return '';
    return `<form method="post" action="/-/sync/${encodeURIComponent(sp.owner)}/${encodeURIComponent(sp.name)}" class="inline"><button class="btn" type="submit">${esc(label)}</button></form>`;
  }

  members(sp: Project) {
    return [...this.db.projectMember.projectId.filter(sp.id)].sort((a, b) => a.agent.localeCompare(b.agent));
  }

  // The space a presence row is about: its own column, or (rows from older
  // clients) its project's space.
  presenceSpace(p: Presence) {
    return p.space || this.db.project.id.find(p.projectId)?.owner || '';
  }

  // Connections that follow a project (with those following its whole
  // space), a space, or the whole hub, and are still heartbeating; one line
  // per agent, mode, branch and project.
  hereNow(where: { project: Project } | { space: string } | null) {
    let rows = [...this.db.presence.iter()];
    if (where && 'project' in where) rows = rows.filter(p => p.projectId === where.project.id || (p.projectId === 0n && p.space === where.project.owner));
    else if (where) rows = rows.filter(p => this.presenceSpace(p) === where.space);
    const groups = new Map<string, { row: Presence; count: number }>();
    for (const p of rows) {
      if (this.now - seconds(p.seenAt) > PRESENCE_STALE_SECONDS) continue;
      const key = `${p.projectId}:${p.space}:${p.agent}:${p.mode}:${p.branch}`;
      const g = groups.get(key);
      if (!g) groups.set(key, { row: p, count: 1 });
      else {
        g.count++;
        if (seconds(p.since) < seconds(g.row.since)) g.row = p;
      }
    }
    return [...groups.values()].sort((x, y) => x.row.agent.localeCompare(y.row.agent) || seconds(x.row.since) - seconds(y.row.since));
  }

  hereBox(groups: { row: Presence; count: number }[], withSpace: boolean) {
    const rows = groups
      .slice(0, 30)
      .map(({ row: p, count }) => {
        const sp = withSpace ? this.db.project.id.find(p.projectId) : undefined;
        const whole = p.projectId === 0n;
        const branch = p.branch ? ` ${esc(p.branch)}` : whole ? ' all projects' : '';
        const where = sp ? ` <span class="muted">in</span> ${this.a(sp.fullName, esc(sp.fullName))}` : whole && withSpace ? ` <span class="muted">of</span> ${this.a(p.space, esc(p.space))}` : '';
        const times = count > 1 ? ` <span class="muted">×${count}</span>` : '';
        const host = p.host ? ` <span class="muted">on ${esc(p.host)}</span>` : '';
        return `<tr><td>${this.a(p.agent, `<b>${esc(p.agent)}</b>`)} <span class="pill">${esc(p.mode)}</span><span class="muted">${branch}</span>${where}${host}${times}</td><td class="r muted">${this.ago(seconds(p.since))}</td></tr>`;
      })
      .join('');
    return `<div class="box here">${rows ? `<table>${rows}</table>` : '<div class="empty">Nobody is connected right now.</div>'}</div>`;
  }

  importBanner(sp: Project) {
    const row = this.importRow(sp);
    if (!row) return '';
    const source = `<a href="${esc(row.source)}">${esc(row.source.replace(/^https:\/\//, ''))}</a>`;
    const stale = this.now - seconds(row.updatedAt) > 3600;
    if (row.status === 'running' && !stale) {
      this.refreshing = true;
      return `<div class="banner"><b>Importing from ${source}</b> <span class="muted">${esc(row.message)}</span><br><span class="muted">Started ${this.ago(seconds(row.startedAt))}. This page refreshes on its own.</span></div>`;
    }
    if (row.status === 'failed' || (row.status === 'running' && stale)) {
      const why = row.status === 'failed' ? row.message : 'the import was interrupted';
      const retry = this.syncForm(sp, 'Try again');
      return `<div class="banner err"><b>Import from ${source} failed.</b> <span class="muted">${esc(why)}</span>${retry ? `<div>${retry}</div>` : ''}</div>`;
    }
    return '';
  }

  spaceHead(sp: Project, tab: 'code' | 'commits' | 'activity' | 'refs', ref: string) {
    const refs = this.refs(sp);
    const branches = refs.filter(r => r.name.startsWith('refs/heads/')).length;
    const tags = refs.filter(r => r.name.startsWith('refs/tags/')).length;
    const tabLink = (key: string, path: string, label: string) => this.a(path, label, key === tab ? 'on' : '');
    return `<h1>${this.a(sp.owner, esc(sp.owner))} / <b>${this.a(sp.fullName, esc(sp.name))}</b></h1>
${sp.description ? `<p class="desc">${esc(sp.description)}</p>` : ''}${this.builtByLine(sp)}
<nav class="tabs">${tabLink('code', `${sp.fullName}/tree/${ref}`, 'Code')}${tabLink('commits', `${sp.fullName}/commits/${ref}`, 'Commits')}${tabLink('activity', `${sp.fullName}/activity`, 'Activity')}${tabLink('refs', `${sp.fullName}/refs`, `Branches ${branches} · Tags ${tags}`)}</nav>${this.importBanner(sp)}`;
  }

  // Branch and tag picker; keeps the current view and path.
  refMenu(sp: Project, current: string, view: 'tree' | 'blob' | 'commits', path: string[]) {
    const refs = this.refs(sp);
    const item = (name: string) => this.a(`${sp.fullName}/${view}/${name}/${path.join('/')}`, esc(name), name === current ? 'on' : '');
    const branches = refs.filter(r => r.name.startsWith('refs/heads/')).map(r => item(shortRef(r.name)));
    const tags = refs.filter(r => r.name.startsWith('refs/tags/')).map(r => item(shortRef(r.name)));
    const label = /^[0-9a-f]{40}$/.test(current) ? current.slice(0, 7) : current;
    return `<details class="menu"><summary class="btn">${esc(label)} &#9662;</summary><div class="pop"><div class="h">Branches</div>${branches.join('') || '<div class="h">none</div>'}${
      tags.length ? `<div class="h">Tags</div>${tags.join('')}` : ''
    }</div></details>`;
  }

  crumbs(sp: Project, ref: string, path: string[], lastIsLink = false) {
    const parts = [this.a(`${sp.fullName}/tree/${ref}`, `<b>${esc(sp.name)}</b>`)];
    path.forEach((name, i) => {
      const sub = path.slice(0, i + 1).join('/');
      parts.push(i === path.length - 1 && !lastIsLink ? `<b>${esc(name)}</b>` : this.a(`${sp.fullName}/tree/${ref}/${sub}`, esc(name)));
    });
    return parts.join(' / ');
  }

  commitBar(sp: Project, c: Commit, historyPath: string, ref: string) {
    const subject = c.message.split('\n')[0];
    return `<div class="bar"><span class="nowrap"><b>${esc(c.author.name)}</b></span><span class="grow">${this.a(`${sp.fullName}/commit/${c.oid}`, esc(subject), 'muted')}</span>
<span class="muted mono nowrap">${this.a(`${sp.fullName}/commit/${c.oid}`, c.oid.slice(0, 7))} · ${this.ago(c.committer.time)}</span>
<span class="nowrap">${this.a(`${sp.fullName}/commits/${ref}/${historyPath}`, 'History')}</span></div>`;
  }

  aside(sp: Project, ref: string, commits: number) {
    const refs = this.refs(sp);
    const row = this.importRow(sp);
    const source = row
      ? `<dt>Source</dt><dd><a href="${esc(row.source)}">${esc(row.source.replace(/^https:\/\//, ''))}</a></dd><dt>Synced</dt><dd>${row.status === 'done' ? this.ago(seconds(row.updatedAt)) : esc(row.status)}</dd>`
      : '';
    const sync = row && row.status !== 'running' ? this.syncForm(sp, 'Sync from GitHub') : '';
    const count = commits >= COUNT_CAP ? `${COUNT_CAP.toLocaleString('en-US')}+` : commits.toLocaleString('en-US');
    const here = this.hereNow({ project: sp });
    const members = this.members(sp).map(m => this.a(m.agent, esc(m.agent)));
    return `<aside><h2>Clone</h2><code class="clone">spacehub project clone ${esc(sp.fullName)}</code>
<code class="clone">git clone -o quirq quirq://${esc(this.host)}/${esc(sp.fullName)}</code>
<h2>Here now <span class="muted">${here.reduce((n, g) => n + g.count, 0)}</span></h2>${this.hereBox(here, false)}
<h2>About</h2><dl><dt>Space</dt><dd>${this.a(sp.owner, esc(sp.owner))} ${this.spacePill(sp.owner)}</dd><dt>Collaborators</dt><dd class="collaborators">${members.join(', ') || '<span class="muted">none</span>'}</dd><dt>Builder</dt><dd>${this.builderLink(this.builderOf(sp))}</dd><dt>Default</dt><dd>${esc(sp.defaultBranch)}</dd>
<dt>Commits</dt><dd>${this.a(`${sp.fullName}/commits/${ref}`, count)}</dd>
<dt>Branches</dt><dd>${this.a(`${sp.fullName}/refs`, String(refs.filter(r => r.name.startsWith('refs/heads/')).length))}</dd><dt>Tags</dt><dd>${this.a(`${sp.fullName}/refs`, String(refs.filter(r => r.name.startsWith('refs/tags/')).length))}</dd>
<dt>Size</dt><dd>${this.sizeOf(sp)} <span class="muted">in ${plural(Number(sp.objectCount), 'object')}</span></dd><dt>Created</dt><dd>${this.ago(seconds(sp.createdAt))}</dd><dt>Pushed</dt><dd>${this.ago(seconds(sp.pushedAt))}</dd>${source}</dl>${sync}</aside>`;
  }

  // Links inside Markdown: external links stay, repo paths become UI links,
  // and repo images are shown inline from the raw view.
  resolver(sp: Project, ref: string, dir: string[]): Resolve {
    return (url, image) => {
      if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return { href: url, inline: false };
      if (url.startsWith('#')) return { href: url, inline: false };
      if (url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
      const hashAt = url.indexOf('#');
      const hash = hashAt >= 0 ? url.slice(hashAt) : '';
      const pathOnly = (hashAt >= 0 ? url.slice(0, hashAt) : url).split('?')[0];
      const parts = pathOnly.startsWith('/') ? [] : [...dir];
      for (const seg of pathOnly.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') parts.pop();
        else parts.push(decodeParam(seg));
      }
      const view = image ? 'raw' : pathOnly.endsWith('/') ? 'tree' : 'blob';
      return { href: this.link(`${sp.fullName}/${view}/${ref}/${parts.join('/')}`) + hash, inline: image };
    };
  }

  builtByLine(sp: Project) {
    const b = this.builderOf(sp);
    if (b.kind === 'hub' && b.handle === sp.owner) return '';
    const profile = b.url ? ` <span class="muted">·</span> <a href="${esc(b.url)}">${esc(b.url.replace(/^https?:\/\//, ''))}</a>` : '';
    return `<p class="desc">Built by <b>${this.builderLink(b)}</b>${profile}</p>`;
  }

  // One activity as a sentence: who did what, where, and when.
  activityItem(e: Activity) {
    const sp = e.projectId ? this.db.project.id.find(e.projectId) : undefined;
    const who = e.agent === '-github' ? '<b>GitHub sync</b>' : e.agent ? this.a(e.agent, `<b>${esc(e.agent)}</b>`) : '<b>someone</b>';
    const project = sp ? this.a(sp.fullName, `<b>${esc(sp.fullName)}</b>`) : `<b>${esc(e.path)}</b>`;
    const refName = shortRef(e.subject);
    const refKind = e.subject.startsWith('refs/tags/') ? 'tag' : 'branch';
    const refLink = sp ? this.a(`${sp.fullName}/tree/${refName}`, esc(refName)) : esc(refName);
    const commit = sp && e.oid ? `${this.a(`${sp.fullName}/commit/${e.oid}`, e.oid.slice(0, 7), 'mono')} ` : '';
    const source = `<a href="${esc(e.subject)}">${esc(e.subject.replace(/^https:\/\//, ''))}</a>`;
    const pushed = commit || e.text ? `${commit}${esc(e.text)}` : '';
    // Events about a top-level space (an org, a builder's space, an agent) name it.
    const top = this.db.space.name.find(e.path) ? this.a(e.path, `<b>${esc(e.path)}</b>`) : `<b>${esc(e.path)}</b>`;
    const member = this.a(e.subject, `<b>${esc(e.subject)}</b>`);
    let line: string;
    let more = '';
    switch (e.kind) {
      case 'agent_registered':
        line = `${who} joined as a builder`;
        break;
      case 'org_created':
        line = `${who} created the org ${top}`;
        break;
      case 'space_edited':
        line = `${who} updated ${top}`;
        more = esc(e.text);
        break;
      case 'org_deleted':
        line = `${who} deleted the org ${top}`;
        break;
      case 'space_member_added':
        line = `${who} added ${member} to ${top} as ${e.text === 'owner' ? 'an owner' : 'a member'}`;
        break;
      case 'space_member_removed':
        line = e.subject === e.agent ? `${who} left ${top}` : `${who} removed ${member} from ${top}`;
        break;
      case 'agent_created':
        line = `${who} created the agent ${top} in ${member}`;
        break;
      case 'agent_deleted':
        line = `${who} deleted the agent <b>${esc(e.path)}</b>`;
        break;
      case 'agent_connected':
        line = `${who} connected the agent ${member} to ${top}`;
        break;
      case 'agent_disconnected':
        line = `${who} disconnected the agent ${member} from ${top}`;
        break;
      case 'project_created':
        line = `${who} created ${project}`;
        break;
      case 'project_deleted':
        line = `${who} deleted ${project}`;
        break;
      case 'project_edited':
        line = `${who} updated ${project}`;
        more = esc(e.text);
        break;
      case 'builder_set':
        line = `${who} credited ${this.a(`-/builders/${e.subject}`, `<b>${esc(e.text || e.subject)}</b>`)} as the builder of ${project}`;
        break;
      case 'builder_cleared':
        line = `${who} removed the builder credit from ${project}`;
        break;
      case 'collab_posted':
        line = `${who} posted ${e.subject === 'message' ? '' : `a ${esc(e.subject)} `}in the chat of ${project}`;
        more = esc(e.text);
        break;
      case 'ref_created':
        line = `${who} created ${refKind} ${refLink} in ${project}`;
        more = pushed;
        break;
      case 'ref_updated':
        line = `${who} pushed ${e.count ? `${plural(e.count, 'commit')} ` : ''}to ${refLink} in ${project}`;
        more = pushed;
        break;
      case 'ref_forced':
        line = `${who} force-pushed ${refKind} ${refLink} in ${project}`;
        more = pushed;
        break;
      case 'ref_deleted':
        line = `${who} deleted ${refKind} ${esc(refName)} from ${project}`;
        break;
      case 'import_started':
        line = `${who} started importing ${source} into ${project}`;
        break;
      case 'sync_started':
        line = `${who} started syncing ${project} from ${source}`;
        break;
      case 'import_done':
        line = e.text.startsWith('synced') ? `${who} synced ${project} from ${source}` : `${who} imported ${source} into ${project}`;
        more = e.count ? `${plural(e.count, 'branch or tag').replace('branch or tags', 'branches and tags')}` : '';
        break;
      case 'space_linked':
        line = `${who} linked ${top} to ${source}`;
        break;
      case 'space_unlinked':
        line = `${who} unlinked ${top} from ${source}`;
        break;
      case 'space_synced':
        line = `${who} synced ${top} from ${source}`;
        more = esc(e.text);
        break;
      case 'space_sync_failed':
        line = `${who}'s sync of ${top} from ${source} failed`;
        more = esc(e.text);
        break;
      case 'ref_diverged':
        line = `${refKind} ${refLink} in ${project} diverged from GitHub; the hub kept its own commits`;
        more = e.oid ? `GitHub has ${esc(e.oid.slice(0, 7))}` : '';
        break;
      case 'import_failed':
        line = `${who}'s import of ${source} into ${project} failed`;
        more = esc(e.text);
        break;
      case 'project_member_added':
        line = `${who} added ${member} as a collaborator on ${project}`;
        break;
      case 'project_member_removed':
        line = e.subject === e.agent ? `${who} left the collaborators on ${project}` : `${who} removed ${member} from the collaborators on ${project}`;
        break;
      default:
        line = `${who} ${esc(e.kind.replace(/_/g, ' '))} ${project}`;
    }
    return `<tr><td>${line}${more ? `<div class="muted">${more}</div>` : ''}</td><td class="r muted">${this.ago(seconds(e.at))}</td></tr>`;
  }

  // Newest first, ACTIVITY_PAGE per page, with Newer/Older links on `path`.
  activityFeed(events: Activity[], path: string) {
    const page = Math.max(1, Number.parseInt(this.query.get('page') ?? '1', 10) || 1);
    events.sort((x, y) => {
      const d = y.at.microsSinceUnixEpoch - x.at.microsSinceUnixEpoch;
      return d !== 0n ? (d > 0n ? 1 : -1) : y.id > x.id ? 1 : y.id < x.id ? -1 : 0;
    });
    const start = (page - 1) * ACTIVITY_PAGE;
    const shown = events.slice(start, start + ACTIVITY_PAGE);
    const rows = shown.map(e => this.activityItem(e)).join('');
    const newer = page > 1 ? this.a(path, 'Newer', 'btn', page > 2 ? { page: page - 1 } : {}) : '';
    const older = events.length > start + ACTIVITY_PAGE ? this.a(path, 'Older', 'btn', { page: page + 1 }) : '';
    const range = shown.length ? `<span class="muted">${start + 1} to ${start + shown.length} of ${events.length.toLocaleString('en-US')}</span>` : '';
    const pager = newer || older ? `<div class="bar" style="background:none;border:0;padding:8px 0">${newer}${older}<span class="grow"></span>${range}</div>` : '';
    return `<div class="box">${rows ? `<table>${rows}</table>` : `<div class="empty">${page > 1 ? 'No more activity.' : 'No activity yet.'}</div>`}</div>${pager}`;
  }

  // ------------------------------------------------------------ sizes

  // What a project stores (its git objects, uncompressed), or "measuring"
  // while the server is still counting a project from before sizes were kept.
  sizeOf(sp: Project) {
    const row = this.db.projectSize.projectId.find(sp.id);
    return row ? size(Number(row.bytes)) : 'measuring';
  }

  // What some projects store together, noting any still being measured.
  totalOf(projects: Project[]) {
    let total = 0n;
    let waiting = 0;
    for (const sp of projects) {
      const row = this.db.projectSize.projectId.find(sp.id);
      if (row) total += row.bytes;
      else waiting++;
    }
    return `${size(Number(total))}${waiting ? ` (${waiting} still measuring)` : ''}`;
  }

  // ------------------------------------------------------------ pages

  projectRows(projects: Project[], fullNames: boolean) {
    return projects
      .sort((a, b) => seconds(b.pushedAt) - seconds(a.pushedAt))
      .map(
        s => `<tr><td>${this.a(s.fullName, `<b>${esc(fullNames ? s.fullName : s.name)}</b>`)}${s.description ? `<div class="muted">${esc(s.description)}</div>` : ''}${this.builtBy(s)}</td>
<td class="r muted">Updated ${this.ago(seconds(s.pushedAt))} · ${this.sizeOf(s)}</td></tr>`
      )
      .join('');
  }

  home() {
    const projects = [...this.db.project.iter()];
    const counts = new Map<string, number>();
    for (const p of projects) counts.set(p.owner, (counts.get(p.owner) ?? 0) + 1);
    const orgs = [...this.db.space.kind.filter('org')].sort((a, b) => (counts.get(b.name) ?? 0) - (counts.get(a.name) ?? 0) || a.name.localeCompare(b.name));
    const orgRows = orgs
      .slice(0, 20)
      .map(t => `<tr><td>${this.a(t.name, esc(t.displayName || t.name))}</td><td class="r muted">${plural(counts.get(t.name) ?? 0, 'project')} · ${this.totalOf(projects.filter(p => p.owner === t.name))}</td></tr>`)
      .join('');
    const builders = this.builders();
    const builderRows = builders
      .slice(0, 20)
      .map(g => `<tr><td>${this.builderLink(g.builder)} ${this.builderKind(g.builder)}</td><td class="r muted">${plural(g.spaces.length, 'project')}</td></tr>`)
      .join('');
    const agents = [...this.db.space.kind.filter('agent')].sort((a, b) => a.name.localeCompare(b.name));
    const agentRows = agents
      .slice(0, 20)
      .map(a => `<tr><td>${this.a(a.name, esc(a.name))} <span class="muted">of ${esc(a.parent)}</span></td><td class="r muted">${this.running(a.name).length ? 'running' : ''}</td></tr>`)
      .join('');
    const guide = guideHome(this.guideContext());
    const create = this.viewer ? `<a class="btn primary" href="/-/new">New project</a>` : '';
    const rows = this.projectRows(projects, true);
    return this.page(
      'spacehub',
      `${guide}<div class="grid"><div><div class="bar" style="background:none;border:0;padding:0 0 8px"><h1 class="grow"><b>Projects</b> <span class="muted">${projects.length}</span></h1>${create}</div>
<p class="desc">Git projects on this hub, most recently pushed first. All spaces together store <b class="total">${this.totalOf(projects)}</b>.</p>
<div class="box">${rows ? `<table>${rows}</table>` : '<div class="empty">No projects yet.</div>'}</div>
<h2 style="margin:24px 0 8px">Activity</h2>${this.activityFeed([...this.db.activity.iter()], '')}</div>
<aside><h2>Here now</h2>${this.hereBox(this.hereNow(null), true)}
<h2>Orgs <span class="muted">${orgs.length}</span></h2><div class="box">${orgRows ? `<table>${orgRows}</table>` : '<div class="empty">No orgs yet.</div>'}</div>
<h2>Agents <span class="muted">${agents.length}</span></h2><div class="box">${agentRows ? `<table>${agentRows}</table>` : '<div class="empty">No agents yet.</div>'}</div>
<h2>${this.a('-/builders', 'Builders')} <span class="muted">${builders.length}</span></h2><div class="box">${builderRows ? `<table>${builderRows}</table>` : '<div class="empty">No builders yet.</div>'}</div></aside></div>`
    );
  }

  // Owners first, then members.
  roles(space: string) {
    return [...this.db.spaceRole.space.filter(space)].sort((a, b) => (a.role === b.role ? a.member.localeCompare(b.member) : a.role === 'owner' ? -1 : 1));
  }

  // A space's GitHub link: what it mirrors and how the last sync went, with
  // the owners' forms (behind the server's proxy, where the web service is).
  githubBox(name: string) {
    const link = this.db.spaceLink.space.find(name);
    const owner = this.base !== null && ownsSpace(this.db, name, this.viewer);
    const form = (action: string, label: string, extra = '') =>
      `<form method="post" action="/-/link/${encodeURIComponent(name)}" class="inline"><input type="hidden" name="action" value="${action}">${extra}<button class="btn" type="submit">${label}</button></form>`;
    if (!link) {
      if (!owner) return '';
      return `<h2>GitHub</h2><div class="box" style="padding:12px 16px"><p class="muted" style="margin:0 0 8px">Mirror a GitHub user's or organization's public repositories here, as projects with the same names.</p>${form('link', 'Link', '<input type="text" name="source" placeholder="https://github.com/owner" aria-label="GitHub account" style="margin:0 0 8px">')}</div>`;
    }
    const synced = seconds(link.syncedAt) > 0 ? `synced ${this.ago(seconds(link.syncedAt))}` : 'not synced yet';
    const state = link.status === 'running' || link.status === 'requested' ? `<b>${esc(link.status === 'running' ? 'syncing' : 'sync requested')}</b> ${esc(link.message)}` : `${synced}${link.status === 'failed' ? ' · <b>last sync failed</b>' : ''}`;
    const detail = link.status === 'done' || link.status === 'failed' ? `<div class="muted">${esc(link.message)}</div>` : '';
    const forms = owner ? `<div style="margin-top:8px">${form('sync', 'Sync now')} ${form('unlink', 'Unlink')}</div>` : '';
    return `<h2>GitHub</h2><div class="box github" style="padding:12px 16px">Mirrors <a href="${esc(link.source)}">${esc(link.source.replace(/^https:\/\//, ''))}</a><div class="muted">${state}</div>${detail}${forms}</div>`;
  }

  // /<name>: a builder's personal space, an org, or an agent.
  spacePage(name: string) {
    const row = this.db.space.name.find(name);
    const user = this.db.user.username.find(name);
    const projects = [...this.db.project.owner.filter(name)];
    if (!row && !user && projects.length === 0) return this.notFound(`No space "${name}".`);
    const kind = row?.kind ?? 'personal';
    const rows = this.projectRows(projects, false);
    const list = `<div class="box">${rows ? `<table>${rows}</table>` : '<div class="empty">No projects yet.</div>'}</div>`;
    const title = `<h1><b>${esc(row?.displayName || name)}</b> ${this.spacePill(name)}</h1>${row?.description ? `<p class="desc">${esc(row.description)}</p>` : ''}`;
    const here = this.hereBox(this.hereNow({ space: name }), true);
    if (kind === 'agent' && row) return this.agentPage(row, list);
    const agents = this.agentsOf(name);
    if (kind === 'personal') {
      const since = user ? `<p class="desc">Builder · joined ${this.ago(seconds(user.createdAt))} · ${plural(projects.length, 'project')} · ${this.totalOf(projects)}</p>` : '';
      const spaces = [...this.db.spaceRole.member.filter(name)]
        .map(r => `<tr><td>${this.a(r.space, `<b>${esc(r.space)}</b>`)} ${this.spacePill(r.space)}</td><td class="r muted">${esc(r.role)}</td></tr>`)
        .join('');
      const collab = [...this.db.projectMember.agent.filter(name)]
        .map(m => this.db.project.id.find(m.projectId))
        .filter((s): s is Project => !!s)
        .map(s => `<tr><td>${this.a(s.fullName, `<b>${esc(s.fullName)}</b>`)}</td><td class="r muted">collaborator</td></tr>`)
        .join('');
      const memberOf = spaces + collab ? `<h2 style="margin:24px 0 8px">Member of</h2><div class="box"><table>${spaces}${collab}</table></div>` : '';
      const github = this.githubBox(name);
      const main = `${list}${agents}${memberOf}`;
      return this.page(name, `${title}${since}${github ? `<div class="grid"><div>${main}</div><aside>${github}</aside></div>` : main}`);
    }
    const created = row ? `<p class="desc">${kind === 'org' ? 'Org' : 'Agent'} · created by ${this.a(row.createdBy, esc(row.createdBy))} ${this.ago(seconds(row.createdAt))} · ${plural(projects.length, 'project')} · ${this.totalOf(projects)}</p>` : '';
    const people = this.roles(name)
      .map(r => `<tr><td>${this.a(r.member, `<b>${esc(r.member)}</b>`)} ${this.spacePill(r.member)}</td><td class="r muted">${esc(r.role)}</td></tr>`)
      .join('');
    const aside = `<aside><h2>Members</h2><div class="box members">${people ? `<table>${people}</table>` : '<div class="empty">No members yet.</div>'}</div>${this.githubBox(name)}<h2>Here now</h2>${here}</aside>`;
    return this.page(name, `${title}${created}<div class="grid"><div>${list}${agents}</div>${aside}</div>`);
  }

  // The agents a builder or org owns.
  agentsOf(parent: string) {
    const rows = [...this.db.space.kind.filter('agent')]
      .filter(a => a.parent === parent)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(a => `<tr><td>${this.a(a.name, `<b>${esc(a.name)}</b>`)}${a.description ? `<div class="muted">${esc(a.description)}</div>` : ''}</td><td class="r muted">${this.running(a.name).length ? 'running' : ''}</td></tr>`)
      .join('');
    return rows ? `<h2 style="margin:24px 0 8px">Agents</h2><div class="box agents"><table>${rows}</table></div>` : '';
  }

  // Where an agent runs right now: one line per host it reported.
  running(name: string) {
    const hosts = new Map<string, { host: string; since: number; spaces: Set<string> }>();
    for (const p of this.db.presence.iter()) {
      if (p.agent !== name || p.mode !== 'agent' || this.now - seconds(p.seenAt) > PRESENCE_STALE_SECONDS) continue;
      const key = p.host || '?';
      const h = hosts.get(key) ?? { host: p.host, since: seconds(p.since), spaces: new Set<string>() };
      h.since = Math.min(h.since, seconds(p.since));
      h.spaces.add(p.space);
      hosts.set(key, h);
    }
    return [...hosts.values()];
  }

  // /<agent>: what it is (its projects), where it is connected, where it runs.
  agentPage(row: NonNullable<ReturnType<Db['space']['name']['find']>>, list: string) {
    const name = row.name;
    const connected = [...this.db.spaceRole.member.filter(name)]
      .sort((a, b) => a.space.localeCompare(b.space))
      .map(r => `<tr><td>${this.a(r.space, `<b>${esc(r.space)}</b>`)} ${this.spacePill(r.space)}</td><td class="r muted">${this.ago(seconds(r.addedAt))}</td></tr>`)
      .join('');
    const runs = this.running(name)
      .map(h => `<tr><td><b>${esc(h.host || 'somewhere')}</b><div class="muted">${[...h.spaces].sort().map(sp => this.a(sp, esc(sp))).join(', ')}</div></td><td class="r muted">${this.ago(h.since)}</td></tr>`)
      .join('');
    const title = `<h1><b>${esc(row.displayName || name)}</b> ${this.spacePill(name)}</h1>${row.description ? `<p class="desc">${esc(row.description)}</p>` : ''}`;
    const desc = `<p class="desc">Agent · owned by ${this.a(row.parent, esc(row.parent))} · created by ${this.a(row.createdBy, esc(row.createdBy))} ${this.ago(seconds(row.createdAt))} · ${this.totalOf([...this.db.project.owner.filter(name)])}</p>`;
    const aside = `<aside><h2>Running</h2><div class="box running">${runs ? `<table>${runs}</table>` : '<div class="empty">Not running.</div>'}</div>
<h2>Launch</h2><code class="clone">spacehub agent run ${esc(name)}</code><p class="muted">Its owners print its token with <code>spacehub agent token ${esc(name)}</code>; XO Swarm runs it the same way.</p></aside>`;
    const connections = `<h2 style="margin:24px 0 8px">Connected to</h2><div class="box connected">${connected ? `<table>${connected}</table>` : '<div class="empty">Not connected to any space yet.</div>'}</div>`;
    return this.page(name, `${title}${desc}<div class="grid"><div>${list}${connections}</div>${aside}</div>`);
  }

  emptySpace(sp: Project) {
    const head = this.spaceHead(sp, 'code', sp.defaultBranch);
    const pushHint = `<code>git remote add quirq quirq://${esc(this.host)}/${esc(sp.fullName)}<br>git push quirq ${esc(sp.defaultBranch)}</code>`;
    const body =
      this.importRow(sp)?.status === 'running'
        ? '<div class="empty">Waiting for the import to finish.</div>'
        : `<div class="empty">This space is empty. Push to it:<br><br>${pushHint}</div>`;
    return this.page(sp.fullName, `${head}<div class="grid"><div class="box">${body}</div>${this.aside(sp, sp.defaultBranch, 0)}</div>`);
  }

  treePage(sp: Project, segs: string[] | null): UiResponse {
    if (segs === null) {
      const refs = this.refs(sp);
      if (refs.length === 0) return this.emptySpace(sp);
      segs = [refs.some(r => r.name === `refs/heads/${sp.defaultBranch}`) ? sp.defaultBranch : shortRef(refs[0].name)];
    }
    const { ref, oid, rest } = this.resolve(sp, segs);
    const tip = this.commit(sp, oid);
    if (!tip) throw new NotFound(`"${ref}" does not point at a commit`);
    const target = this.locate(sp, tip.tree, rest);
    if (!target) throw new NotFound(`"${rest.join('/')}" not found at ${ref}`);
    if (target.type === 'blob') return this.blobPage(sp, segs);
    if (target.type !== 'tree') throw new NotFound(`"${rest.join('/')}" is a submodule`);

    const entries = this.tree(sp, target.oid);
    const { folderCommit, byName } = this.lastChanges(sp, tip.oid, rest, entries.map(e => e.name));
    const prefix = rest.length ? `${rest.join('/')}/` : '';
    const up = rest.length ? `<tr><td colspan="3">${this.a(`${sp.fullName}/tree/${ref}/${rest.slice(0, -1).join('/')}`, '..')}</td></tr>` : '';
    const rows = entries
      .map(e => {
        const c = byName.get(e.name);
        const last = c
          ? `<td class="msg">${this.a(`${sp.fullName}/commit/${c.oid}`, esc(c.message.split('\n')[0]))}</td><td class="r muted">${this.ago(c.committer.time)}</td>`
          : '<td class="msg"></td><td class="r"></td>';
        if (e.type === 'commit') return `<tr><td>${ICON_DIR}${esc(e.name)} <span class="muted">@ ${e.oid.slice(0, 7)}</span></td>${last}</tr>`;
        const view = e.type === 'tree' ? 'tree' : 'blob';
        return `<tr><td class="nowrap">${e.type === 'tree' ? ICON_DIR : ICON_FILE}${this.a(`${sp.fullName}/${view}/${ref}/${prefix}${e.name}`, esc(e.name))}</td>${last}</tr>`;
      })
      .join('');

    const readme = entries.find(e => e.type === 'blob' && /^readme(\.(md|markdown|txt|rst))?$/i.test(e.name));
    let readmeBox = '';
    if (readme) {
      const obj = readObject(this.db, sp.id, readme.oid);
      if (obj && obj.data.length <= MAX_SHOWN_BYTES && !isBinary(obj.data)) {
        const text = decoder.decode(obj.data);
        const inner = /\.(md|markdown)$/i.test(readme.name)
          ? `<div class="md">${renderMarkdown(text, this.resolver(sp, ref, rest))}</div>`
          : `<pre>${esc(text)}</pre>`;
        readmeBox = `<div class="box"><div class="bar"><b class="grow">${esc(readme.name)}</b>${this.a(`${sp.fullName}/blob/${ref}/${prefix}${readme.name}`, 'View file')}</div>${inner}</div>`;
      }
    }

    const commits = this.countCommits(sp, tip.oid);
    const countLink = this.a(`${sp.fullName}/commits/${ref}`, `<b>${plural(commits, 'commit')}</b>${commits >= COUNT_CAP ? '+' : ''}`);
    const toolbar = `<div class="bar" style="background:none;border:0;padding:0 0 12px">${this.refMenu(sp, ref, 'tree', rest)}<span class="grow">${
      rest.length ? this.crumbs(sp, ref, rest) : ''
    }</span>${rest.length ? '' : countLink}</div>`;
    const listing = `${toolbar}<div class="box">${this.commitBar(sp, folderCommit ?? tip, rest.join('/'), ref)}<table>${up}${rows}</table></div>${readmeBox}`;
    const body = rest.length ? listing : `<div class="grid"><div>${listing}</div>${this.aside(sp, ref, commits)}</div>`;
    return this.page(`${sp.fullName}${rest.length ? `/${rest.join('/')}` : ''}`, `${this.spaceHead(sp, 'code', ref)}${body}`);
  }

  fileAt(sp: Project, segs: string[]) {
    const { ref, oid, rest } = this.resolve(sp, segs);
    const tip = this.commit(sp, oid);
    if (!tip) throw new NotFound(`"${ref}" does not point at a commit`);
    if (rest.length === 0) throw new NotFound('no file path given');
    const target = this.locate(sp, tip.tree, rest);
    if (!target) throw new NotFound(`"${rest.join('/')}" not found at ${ref}`);
    return { ref, rest, tip, target };
  }

  blobPage(sp: Project, segs: string[]): UiResponse {
    const { ref, rest, tip, target } = this.fileAt(sp, segs);
    if (target.type === 'tree') return this.treePage(sp, segs);
    if (target.type !== 'blob') throw new NotFound(`"${rest.join('/')}" is a submodule`);
    const obj = readObject(this.db, sp.id, target.oid);
    if (!obj) throw new NotFound(`blob ${target.oid} is missing`);
    const data = obj.data;
    const path = rest.join('/');
    const name = rest[rest.length - 1];
    const ext = extOf(name);
    const rawPath = `${sp.fullName}/raw/${ref}/${path}`;
    const binary = isBinary(data);
    const markdown = !binary && /^(md|markdown)$/.test(ext) && data.length <= MAX_SHOWN_BYTES;
    const plain = this.query.get('plain') === '1';

    let content: string;
    let info = size(data.length);
    let toggle = '';
    if (IMAGE_TYPES[ext] && data.length <= 10 * 1024 * 1024) {
      content = `<div class="img"><img src="${esc(this.link(rawPath))}" alt="${esc(name)}"></div>`;
    } else if (binary) {
      content = `<div class="empty">Binary file, ${size(data.length)}. ${this.a(rawPath, 'Download it raw')}.</div>`;
    } else if (data.length > MAX_SHOWN_BYTES) {
      content = `<div class="empty">This file is too large to show (${size(data.length)}). ${this.a(rawPath, 'View it raw')}.</div>`;
    } else {
      const lines = textLines(data);
      info = `${plural(lines.length, 'line')} · ${size(data.length)}`;
      if (markdown) {
        const blobPath = `${sp.fullName}/blob/${ref}/${path}`;
        toggle = `${this.a(blobPath, plain ? 'Preview' : '<b>Preview</b>', 'btn')}${this.a(blobPath, plain ? '<b>Code</b>' : 'Code', 'btn', { plain: 1 })}`;
      }
      content =
        markdown && !plain
          ? `<div class="md">${renderMarkdown(decoder.decode(data), this.resolver(sp, ref, rest.slice(0, -1)))}</div>`
          : `<div class="code scroll"><table>${lines
              .map((l, i) => `<tr id="L${i + 1}"><td class="n"><a href="#L${i + 1}">${i + 1}</a></td><td>${esc(l)}</td></tr>`)
              .join('')}</table></div>`;
    }
    const { byName } = this.lastChanges(sp, tip.oid, rest.slice(0, -1), [name]);
    const last = byName.get(name);
    return this.page(
      `${path} at ${ref} · ${sp.fullName}`,
      `${this.spaceHead(sp, 'code', ref)}<div class="bar" style="background:none;border:0;padding:0 0 12px">${this.refMenu(sp, ref, 'blob', rest)}<span class="grow">${this.crumbs(sp, ref, rest)}</span></div>
<div class="box">${last ? this.commitBar(sp, last, path, ref) : ''}<div class="bar"><span class="grow muted">${info}</span>${toggle}${this.a(rawPath, 'Raw', 'btn')}</div>${content}</div>`
    );
  }

  raw(sp: Project, segs: string[]): UiResponse {
    const { rest, target } = this.fileAt(sp, segs);
    if (target.type !== 'blob') throw new NotFound(`"${rest.join('/')}" is not a file`);
    const obj = readObject(this.db, sp.id, target.oid);
    if (!obj) throw new NotFound(`blob ${target.oid} is missing`);
    const ext = extOf(rest[rest.length - 1]);
    const image = IMAGE_TYPES[ext];
    // A real PDF opens in the browser's viewer (the app frames it); a viewer
    // will not run inside a sandbox, so it gets no scripts or fetches instead.
    if (ext === 'pdf' && decoder.decode(obj.data.subarray(0, 5)) === '%PDF-') {
      return { status: 200, headers: { 'content-type': 'application/pdf', 'content-security-policy': "default-src 'none'; frame-ancestors 'self'" }, body: obj.data };
    }
    // Never text/html: a pushed file must not run as a page on this origin.
    const type = image ?? (isBinary(obj.data) ? 'application/octet-stream' : 'text/plain; charset=utf-8');
    return { status: 200, headers: { 'content-type': type, 'content-security-policy': "default-src 'none'; sandbox" }, body: obj.data };
  }

  commitsPage(sp: Project, segs: string[]) {
    if (segs.length === 0) segs = [sp.defaultBranch];
    const { ref, oid, rest } = this.resolve(sp, segs);
    const page = Math.max(1, Math.min(1000, Number.parseInt(this.query.get('page') ?? '1', 10) || 1));
    const want = page * PAGE_SIZE + 1;
    const matches: Commit[] = [];
    for (const c of this.history(sp, oid, rest.length ? HISTORY_SCAN : want)) {
      if (this.touches(sp, c, rest)) matches.push(c);
      if (matches.length >= want) break;
    }
    const shown = matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    let lastDay = '';
    const rows = shown
      .map(c => {
        const day = dayLabel(c.committer.time);
        const header = day !== lastDay ? `<tr><td colspan="2" class="day">Commits on ${day}</td></tr>` : '';
        lastDay = day;
        const subject = c.message.split('\n')[0];
        return `${header}<tr><td>${this.a(`${sp.fullName}/commit/${c.oid}`, `<b>${esc(subject || '(no message)')}</b>`)}<div class="muted">${esc(c.author.name)} committed ${this.ago(c.committer.time)}</div></td>
<td class="r mono">${this.a(`${sp.fullName}/commit/${c.oid}`, c.oid.slice(0, 7))}<br>${this.a(`${sp.fullName}/tree/${c.oid}/${rest.join('/')}`, 'Browse')}</td></tr>`;
      })
      .join('');
    const listPath = `${sp.fullName}/commits/${ref}/${rest.join('/')}`;
    const newer = page > 1 ? this.a(listPath, 'Newer', 'btn', page > 2 ? { page: page - 1 } : {}) : '';
    const older = matches.length > page * PAGE_SIZE ? this.a(listPath, 'Older', 'btn', { page: page + 1 }) : '';
    const scope = rest.length ? ` of ${this.crumbs(sp, ref, rest, true)}` : '';
    return this.page(
      `Commits · ${sp.fullName}`,
      `${this.spaceHead(sp, 'commits', ref)}<div class="bar" style="background:none;border:0;padding:0 0 12px">${this.refMenu(sp, ref, 'commits', rest)}<span class="grow">History${scope}</span></div>
<div class="box">${rows ? `<table>${rows}</table>` : '<div class="empty">No commits.</div>'}</div><p>${newer} ${older}</p>`
    );
  }

  changes(sp: Project, before: string | null, after: string | null, prefix: string, out: Change[]) {
    const a = new Map(before ? this.tree(sp, before).map(e => [e.name, e] as [string, Entry]) : []);
    const b = new Map(after ? this.tree(sp, after).map(e => [e.name, e] as [string, Entry]) : []);
    for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      if (out.length >= DIFF_FILES) return;
      const x = a.get(name);
      const y = b.get(name);
      if (x && y && x.oid === y.oid && x.mode === y.mode) continue;
      const path = prefix + name;
      if (x?.type === 'tree' || y?.type === 'tree') {
        this.changes(sp, x?.type === 'tree' ? x.oid : null, y?.type === 'tree' ? y.oid : null, `${path}/`, out);
        if (x && x.type !== 'tree') out.push({ status: 'D', path, before: x.oid, after: null });
        if (y && y.type !== 'tree') out.push({ status: 'A', path, before: null, after: y.oid });
      } else {
        out.push({ status: !x ? 'A' : !y ? 'D' : 'M', path, before: x?.oid ?? null, after: y?.oid ?? null });
      }
    }
  }

  blobText(sp: Project, oid: string | null): string[] | 'binary' | 'large' {
    if (!oid) return [];
    const obj = readObject(this.db, sp.id, oid);
    if (!obj) return [];
    if (obj.data.length > DIFF_MAX_BYTES) return 'large';
    if (isBinary(obj.data)) return 'binary';
    return textLines(obj.data);
  }

  commitPage(sp: Project, oid: string) {
    const c = /^[0-9a-f]{40}$/.test(oid) ? this.commit(sp, oid) : null;
    if (!c) throw new NotFound(`no commit ${oid}`);
    const files: Change[] = [];
    const first = c.parents[0] ? this.commit(sp, c.parents[0]) : null;
    this.changes(sp, first ? first.tree : null, c.tree, '', files);

    let budget = DIFF_MAX_ROWS;
    let adds = 0;
    let dels = 0;
    const blocks = files.map((f, n) => {
      const link = f.status === 'D' ? esc(f.path) : this.a(`${sp.fullName}/blob/${c.oid}/${f.path}`, esc(f.path));
      const head = (stats: string) => `<div class="bar"><span class="st ${f.status}">${f.status}</span><span class="grow">${link}</span>${stats}</div>`;
      const note = (text: string) => `<div class="box" id="f${n}">${head('')}<div class="empty">${text}</div></div>`;
      if (budget <= 0) return note('Diff not shown: this commit changes too much to display at once.');
      const before = this.blobText(sp, f.before);
      const after = this.blobText(sp, f.after);
      if (before === 'binary' || after === 'binary') return note('Binary file not shown.');
      if (before === 'large' || after === 'large') return note('Large file, diff not shown.');
      const ops = before.length + after.length > 20000 ? null : diffLines(before, after);
      if (!ops) return note('Diff too large to show.');
      const plus = ops.filter(o => o[0] === INSERT).length;
      const minus = ops.filter(o => o[0] === DELETE).length;
      adds += plus;
      dels += minus;
      const stats = `<span class="mono nowrap"><span class="A">+${plus}</span> <span class="D">-${minus}</span></span>`;
      const rows: string[] = [];
      for (const h of toHunks(ops)) {
        if (budget <= 0) break;
        rows.push(`<tr class="hunk"><td class="n"></td><td class="n"></td><td>@@ -${h.aStart},${h.aLen} +${h.bStart},${h.bLen} @@</td></tr>`);
        for (const [kind, ai, bi] of h.ops) {
          if (kind === INSERT) rows.push(`<tr class="add"><td class="n"></td><td class="n">${bi + 1}</td><td>+${esc(after[bi])}</td></tr>`);
          else if (kind === DELETE) rows.push(`<tr class="del"><td class="n">${ai + 1}</td><td class="n"></td><td>-${esc(before[ai])}</td></tr>`);
          else rows.push(`<tr><td class="n">${ai + 1}</td><td class="n">${bi + 1}</td><td> ${esc(after[bi])}</td></tr>`);
        }
        budget -= h.ops.length + 1;
      }
      const body = rows.length ? `<div class="diff scroll"><table>${rows.join('')}</table></div>` : '<div class="empty">No content changes (mode only).</div>';
      return `<div class="box" id="f${n}">${head(stats)}${body}</div>`;
    });

    const [subject, ...bodyLines] = c.message.replace(/\n+$/, '').split('\n');
    const bodyText = bodyLines.join('\n').trim();
    const parents = c.parents.map(p => this.a(`${sp.fullName}/commit/${p}`, p.slice(0, 7))).join(' + ');
    const summary = files.map((f, n) => `<tr><td><span class="st ${f.status}">${f.status}</span><a href="#f${n}">${esc(f.path)}</a></td></tr>`).join('');
    const capped = files.length >= DIFF_FILES ? `<p class="muted">Showing the first ${DIFF_FILES} changed files.</p>` : '';
    const committed = c.committer.name !== c.author.name ? ` · ${esc(c.committer.name)} committed ${this.ago(c.committer.time)}` : '';
    return this.page(
      `${subject} · ${sp.fullName}@${c.oid.slice(0, 7)}`,
      `${this.spaceHead(sp, 'commits', c.oid)}<div class="box"><div class="bar"><b class="grow" style="white-space:normal">${esc(subject || '(no message)')}</b>${this.a(`${sp.fullName}/tree/${c.oid}`, 'Browse files', 'btn')}</div>
${bodyText ? `<pre>${esc(bodyText)}</pre>` : ''}
<div class="bar" style="border-top:1px solid var(--line);border-bottom:0;background:none"><span class="grow" style="white-space:normal"><b>${esc(c.author.name)}</b> <span class="muted">authored ${this.ago(c.author.time)}${committed}</span></span>
<span class="muted mono">${parents ? `${c.parents.length > 1 ? 'parents' : 'parent'} ${parents} · ` : ''}commit ${c.oid.slice(0, 12)}</span></div></div>
<div class="box"><div class="bar"><b class="grow">${plural(files.length, 'changed file')}</b><span class="mono"><span class="A">+${adds}</span> <span class="D">-${dels}</span></span><span class="muted">${
        first ? `compared with ${c.parents[0].slice(0, 7)}` : 'root commit'
      }</span></div>${summary ? `<table>${summary}</table>` : '<div class="empty">No file changes.</div>'}</div>${capped}${blocks.join('')}`
    );
  }

  // Refs whose GitHub copy went another way: the hub kept its own.
  diverged(sp: Project) {
    return new Map([...this.db.refSync.projectId.filter(sp.id)].filter(r => r.status === 'diverged').map(r => [r.ref, r.githubOid]));
  }

  refsPage(sp: Project) {
    const refs = this.refs(sp);
    const diverged = this.diverged(sp);
    const mark = (ref: string) => (diverged.has(ref) ? ` <span class="pill" title="GitHub has ${esc(diverged.get(ref)!.slice(0, 7))}">diverged from GitHub</span>` : '');
    const branches = refs
      .filter(r => r.name.startsWith('refs/heads/'))
      .map(r => {
        const name = shortRef(r.name);
        const c = this.commit(sp, r.oid);
        const isDefault = name === sp.defaultBranch ? ' <span class="pill">default</span>' : '';
        return `<tr><td>${this.a(`${sp.fullName}/tree/${name}`, `<b>${esc(name)}</b>`)}${isDefault}${mark(r.name)}${c ? `<div class="muted">${esc(c.message.split('\n')[0])}</div>` : ''}</td>
<td class="r muted">${c ? `${esc(c.author.name)} · ${this.ago(c.committer.time)}<br>` : ''}<span class="mono">${this.a(`${sp.fullName}/commit/${c?.oid ?? r.oid}`, (c?.oid ?? r.oid).slice(0, 7))}</span></td></tr>`;
      })
      .join('');
    const tags = refs
      .filter(r => r.name.startsWith('refs/tags/'))
      .map(r => {
        const name = shortRef(r.name);
        const obj = readObject(this.db, sp.id, r.oid);
        const c = this.commit(sp, r.oid);
        let note = '';
        if (obj?.kind === 'tag') {
          const { headers, message } = parseHeaders(obj.data);
          const tagger = headers.find(([k]) => k === 'tagger');
          const who = tagger ? parsePerson(tagger[1]) : null;
          note = `<div class="muted">${esc(message.split('\n')[0])}${who ? ` · tagged by ${esc(who.name)} ${this.ago(who.time)}` : ''}</div>`;
        }
        return `<tr><td>${this.a(`${sp.fullName}/tree/${name}`, `<b>${esc(name)}</b>`)}${mark(r.name)}${note}</td>
<td class="r muted"><span class="mono">${c ? this.a(`${sp.fullName}/commit/${c.oid}`, c.oid.slice(0, 7)) : r.oid.slice(0, 7)}</span><br>${c ? this.ago(c.committer.time) : ''}</td></tr>`;
      })
      .join('');
    const count = (prefix: string) => refs.filter(r => r.name.startsWith(prefix)).length;
    const section = (title: string, n: number, rows: string) =>
      `<div class="box"><div class="bar"><b>${title}</b><span class="muted">${n}</span></div>${rows ? `<table>${rows}</table>` : '<div class="empty">None.</div>'}</div>`;
    return this.page(
      `Branches and tags · ${sp.fullName}`,
      `${this.spaceHead(sp, 'refs', sp.defaultBranch)}${section('Branches', count('refs/heads/'), branches)}${section('Tags', count('refs/tags/'), tags)}`
    );
  }

  buildersPage() {
    const rows = this.builders()
      .map(
        g => `<tr><td>${this.builderLink(g.builder)} ${this.builderKind(g.builder)}${g.builder.url ? `<div class="muted">${esc(g.builder.url.replace(/^https?:\/\//, ''))}</div>` : ''}</td>
<td class="r muted">${plural(g.spaces.length, 'project')}</td></tr>`
      )
      .join('');
    return this.page(
      'Builders · spacehub',
      `<h1><b>Builders</b></h1><p class="desc">Who built the code in this hub's projects: the builders here, and GitHub accounts. A project imported from GitHub is credited to its GitHub owner (or to the GitHub account set with <code>spacehub project edit --builder</code>); a project a builder pushed is credited to that builder.</p>
<div class="box">${rows ? `<table>${rows}</table>` : '<div class="empty">No builders yet.</div>'}</div>`
    );
  }

  builderPage(handle: string) {
    const group = this.builders().find(g => g.builder.kind === 'github' && g.builder.handle === handle.toLowerCase());
    if (!group) return this.notFound(`No GitHub builder "${handle}".`);
    const b = group.builder;
    const rows = group.spaces
      .sort((x, y) => seconds(y.pushedAt) - seconds(x.pushedAt))
      .map(
        s => `<tr><td>${this.a(s.fullName, `<b>${esc(s.fullName)}</b>`)}${s.description ? `<div class="muted">${esc(s.description)}</div>` : ''}</td>
<td class="r muted">Updated ${this.ago(seconds(s.pushedAt))}</td></tr>`
      )
      .join('');
    return this.page(
      `${b.name} · builders`,
      `<h1><b>${esc(b.name)}</b> <span class="muted">${esc(b.handle)}</span></h1><p class="desc">GitHub builder · <a href="${esc(b.url)}">${esc(b.url.replace(/^https?:\/\//, ''))}</a> · built ${plural(group.spaces.length, 'space')} on this server</p>
<div class="box"><table>${rows}</table></div>`
    );
  }

  activityPage(sp: Project) {
    return this.page(
      `Activity · ${sp.fullName}`,
      `${this.spaceHead(sp, 'activity', sp.defaultBranch)}${this.activityFeed([...this.db.activity.projectId.filter(sp.id)], `${sp.fullName}/activity`)}`
    );
  }

  private guideContext() {
    const scheme = this.secure ? 'wss' : 'ws';
    const accounts = this.db.hubState.key.find('accounts')?.value ?? 'open';
    return { server: `${scheme}://${this.host}`, host: this.host, link: (p: string) => this.link(p), accounts };
  }

  // The hub's own pages, at /-/<page>.
  hubPage(segs: string[]): UiResponse | null {
    if (segs[0] === 'guide' && segs.length === 1) {
      return this.page('Guide · spacehub', guidePage(this.guideContext()));
    }
    if (segs[0] === 'builders' && segs.length <= 2) return segs[1] ? this.builderPage(segs[1]) : this.buildersPage();
    return null;
  }

  redirect(path: string): UiResponse {
    return { status: 301, headers: { location: this.link(path), 'content-type': 'text/plain; charset=utf-8' }, body: '' };
  }

  route(segs: string[]): UiResponse {
    // The hub's own pages stay still; everything else follows its data.
    this.live = segs[0] !== '-' && segs[2] !== 'raw';
    this.current = segs.length === 0 ? 'home' : segs[0] === '-' ? (segs[1] === 'guide' ? 'guide' : segs[1] === 'builders' ? 'builders' : '') : segs.length === 1 && segs[0] === this.viewer ? 'me' : '';
    if (segs.length === 0) return this.home();
    if (segs[0] === '-') return this.hubPage(segs.slice(1)) ?? this.notFound(`No page "${segs.join('/')}".`);
    // Old addresses of the hub's pages, unless a space took the name.
    if ((segs[0] === 'guide' || segs[0] === 'builders') && !this.db.space.name.find(segs[0]) && this.hubPage(segs)) {
      return this.redirect(`-/${segs.join('/')}`);
    }
    if (segs.length === 1) return this.spacePage(segs[0]);
    const sp = this.db.project.fullName.find(`${segs[0]}/${segs[1]}`);
    if (!sp) return this.notFound(`No project "${segs[0]}/${segs[1]}".`);
    const [view, ...rest] = segs.slice(2);
    switch (view) {
      case undefined:
        return this.treePage(sp, null);
      case 'tree':
        return this.treePage(sp, rest.length ? rest : null);
      case 'blob':
        return this.blobPage(sp, rest);
      case 'raw':
        return this.raw(sp, rest);
      case 'commits':
        return this.commitsPage(sp, rest);
      case 'commit':
        return this.commitPage(sp, rest[0] ?? '');
      case 'refs':
      case 'branches':
      case 'tags':
        return this.refsPage(sp);
      case 'activity':
        return this.activityPage(sp);
    }
    return this.notFound(`No page "${segs.join('/')}".`);
  }
}

export function renderUi(db: Db, req: UiRequest): UiResponse {
  const { segs, query } = parseRequest(req);
  const r = new Renderer(db, req, query);
  let res: UiResponse;
  try {
    res = r.route(segs);
  } catch (err) {
    if (err instanceof NotFound) res = r.notFound(err.message);
    else res = r.page('Error', `<h1>Something went wrong</h1><pre>${esc(String(err))}</pre>`, 500);
  }
  res.headers['x-content-type-options'] = 'nosniff';
  res.headers['content-security-policy'] ??= PAGE_CSP;
  res.headers['referrer-policy'] = 'same-origin';
  return res;
}
