// A whole space in one folder: a clone of every project of a space side by
// side, like quirq's DEPS, kept current by one process with one connection.
//
//   <dir>/.spacehub/space.json   {"hub": "<server>", "space": "acme", "projects": ["site", ...]}
//   <dir>/<project>/             a normal clone with its quirq remote
//
// `space sync` once fast-forwards every project (cloning new ones);
// --watch does it on every push; --auto runs autosync in every project. A
// conflict pauses only its project; the others carry on.
import fs from 'node:fs';
import path from 'node:path';
import { Autosync, AutosyncLoop, AutosyncStop, conflictHelp, runGit } from './autosync';
import type { RowTypedQuery } from 'spacetimedb';
import { tables, type Conn } from './conn';
import { hubUrl, REMOTE } from './url';

export const MANIFEST = path.join('.spacehub', 'space.json');

export interface Manifest {
  hub: string;
  space: string;
  projects: string[];
}

// The space folder holding `from`, if any.
export function findManifest(from: string): { dir: string; manifest: Manifest } | null {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')) as Manifest;
      if (typeof manifest.space === 'string' && Array.isArray(manifest.projects)) return { dir, manifest };
    } catch {
      // not here
    }
    if (path.dirname(dir) === dir) return null;
  }
}

export function writeManifest(dir: string, manifest: Manifest) {
  fs.mkdirSync(path.join(dir, '.spacehub'), { recursive: true });
  const sorted = { ...manifest, projects: [...new Set(manifest.projects)].sort() };
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(sorted, null, 2) + '\n');
}

// Clone one project. A project nothing was pushed to yet starts on its
// default branch, so the first push lands where the sync looks.
export async function cloneProject(server: string, space: string, name: string, dir: string, defaultBranch: string, env: Record<string, string> = {}) {
  const r = await runGit(path.dirname(dir), ['clone', '-q', '-o', REMOTE, hubUrl(server, `${space}/${name}`), dir], env);
  if (r.code !== 0) throw new Error(`git clone of ${space}/${name} failed: ${r.err.trim().split('\n').slice(-2).join(' ')}`);
  if ((await runGit(dir, ['rev-parse', '-q', '--verify', 'HEAD'], env)).code !== 0) {
    await runGit(dir, ['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`], env);
  }
}

interface Project {
  id: bigint;
  name: string;
  dir: string;
  branch: string;
  loop: AutosyncLoop | null;
  paused: boolean;
  busy: boolean; // a watch-mode pull is running
  again: boolean;
}

export interface SpaceSyncOptions {
  conn: Conn;
  dir: string;
  manifest: Manifest;
  server: string;
  mode: 'once' | 'watch' | 'auto';
  intervalMs: number;
  agent: string; // committer name when git has none
  restart: string; // the command that starts this again, for conflict help
  log: (line: string) => void;
  env?: Record<string, string>;
  author?: string; // commit as this name (agents)
  // Follow only these projects of the space (an agent that collaborates on
  // some projects there), not every project; the folder's manifest is left alone.
  only?: string[];
}

export class SpaceSync {
  private o: SpaceSyncOptions;
  private projects = new Map<string, Project>();
  private finish: (paused: boolean) => void = () => {};
  private stopping = false;
  private watching = false; // past the first pass: new projects are followed as they come

  constructor(options: SpaceSyncOptions) {
    this.o = options;
  }

  private get space() {
    return this.o.manifest.space;
  }

  private wanted(name: string) {
    return !this.o.only || this.o.only.includes(name);
  }

  // Runs until stop(), or (watching) until every project is paused: then
  // resolves true. Once: resolves after one pass.
  async run(): Promise<boolean> {
    const { conn } = this.o;
    conn.db.project.onInsert((ctx, p) => {
      if (p.owner === this.space && this.wanted(p.name) && ctx.event.tag !== 'SubscribeApplied') void this.add(p.id, p.name, p.defaultBranch);
    });
    await this.subscribe(tables.project.where(p => p.owner.eq(this.space)));
    const rows = [...conn.db.project.iter()].filter(p => p.owner === this.space && this.wanted(p.name));
    for (const p of rows) await this.add(p.id, p.name, p.defaultBranch);
    if (this.o.mode === 'once') {
      for (const p of this.projects.values()) await this.pull(p);
      return false;
    }
    conn.db.gitRef.onInsert((ctx, r) => ctx.event.tag !== 'SubscribeApplied' && this.changed(r.projectId, r.name));
    conn.db.gitRef.onUpdate((_ctx, _old, r) => this.changed(r.projectId, r.name));
    const done = new Promise<boolean>(resolve => {
      this.finish = resolve;
    });
    for (const p of this.projects.values()) await this.follow(p);
    this.watching = true;
    this.check();
    return done;
  }

  async stop() {
    this.stopping = true;
    await Promise.all([...this.projects.values()].map(p => p.loop?.stop()));
    this.finish(false);
  }

  private subscribe(query: RowTypedQuery<any, any>) {
    return new Promise<void>((resolve, reject) =>
      this.o.conn
        .subscriptionBuilder()
        .onApplied(() => resolve())
        .onError(ctx => reject(new Error(`subscription failed: ${(ctx as { event?: unknown }).event}`)))
        .subscribe(query)
    );
  }

  private log(p: string, line: string) {
    this.o.log(`${p}: ${line}`);
  }

  // A project of the space: clone it if this folder lacks it.
  private async add(id: bigint, name: string, defaultBranch: string) {
    if (this.projects.has(name) || this.stopping) return;
    const dir = path.join(this.o.dir, name);
    const p: Project = { id, name, dir, branch: '', loop: null, paused: false, busy: false, again: false };
    this.projects.set(name, p);
    if (!fs.existsSync(dir)) {
      try {
        await cloneProject(this.o.server, this.space, name, dir, defaultBranch, this.o.env);
        this.log(name, 'cloned');
      } catch (err) {
        this.log(name, String(err instanceof Error ? err.message : err));
        p.paused = true;
        return;
      }
    }
    if (!this.o.only && !this.o.manifest.projects.includes(name)) {
      this.o.manifest.projects.push(name);
      writeManifest(this.o.dir, this.o.manifest);
    }
    p.branch = (await runGit(dir, ['symbolic-ref', '--short', 'HEAD'], this.o.env)).out.trim();
    // A project that turns up while the space is followed is followed too.
    if (this.watching && !this.stopping) await this.follow(p);
  }

  private remoteOid(p: Project) {
    return [...this.o.conn.db.gitRef.iter()].find(r => r.projectId === p.id && r.name === `refs/heads/${p.branch}`)?.oid ?? '';
  }

  private async follow(p: Project) {
    if (p.paused) return this.check();
    await this.subscribe(tables.gitRef.where(r => r.projectId.eq(p.id)));
    if (this.o.mode === 'watch') return void this.pull(p);
    if (!p.branch) {
      this.log(p.name, 'paused: not on a branch (an unfinished rebase or merge?)');
      p.paused = true;
      return this.check();
    }
    const engine = new Autosync({ cwd: p.dir, remote: REMOTE, branch: p.branch, agent: this.o.agent, log: line => this.log(p.name, line), env: this.o.env, author: this.o.author });
    try {
      await engine.init();
    } catch (err) {
      this.log(p.name, `paused: ${err instanceof Error ? err.message : err}`);
      p.paused = true;
      return this.check();
    }
    p.loop = new AutosyncLoop(engine, this.o.intervalMs, () => this.remoteOid(p), err => this.log(p.name, `${err instanceof Error ? err.message : err}; trying again`));
    void p.loop.start().then(stopped => {
      if (!stopped) return;
      p.paused = true;
      const help = stopped.files.length || /conflict|rebase|merge/.test(stopped.message) ? conflictHelp(stopped.files, p.branch, `${this.o.restart} (in ${this.o.dir})`) : `autosync stopped: ${stopped.message}`;
      this.log(p.name, `paused. ${help.replace(/\n/g, `\n  `)}`);
      this.check();
    });
  }

  private changed(id: bigint, ref: string) {
    for (const p of this.projects.values()) {
      if (p.id !== id || ref !== `refs/heads/${p.branch}`) continue;
      if (p.loop) p.loop.wake();
      else if (this.o.mode === 'watch') void this.pull(p);
    }
  }

  // Fast-forward one project's branch from the hub.
  private async pull(p: Project) {
    if (p.paused || !p.branch) return;
    if (p.busy) {
      p.again = true;
      return;
    }
    p.busy = true;
    do {
      p.again = false;
      if (!this.remoteOid(p) && this.o.mode !== 'once') break;
      const r = await runGit(p.dir, ['pull', '-q', '--ff-only', REMOTE, p.branch], this.o.env);
      if (r.code !== 0) this.log(p.name, `not fast-forwarded: ${r.err.trim().split('\n').slice(-1)[0] ?? ''}`);
    } while (p.again);
    p.busy = false;
  }

  // Watching ends when every project is paused.
  private check() {
    if (this.o.mode === 'once' || this.stopping || !this.watching) return;
    if (this.projects.size > 0 && [...this.projects.values()].every(p => p.paused)) this.finish(true);
  }
}
