// spacehub agent run: an agent at work. One folder holds the agent's own
// space (its definition), every space it is connected to, and every project
// it was brought to as a collaborator, each kept current by autosync,
// pushing as the agent:
//
//   <dir>/<agent>/home/...        its own projects
//   <dir>/<space>/<project>/...   each connected space, whole
//   <dir>/<space>/<project>/...   a project it collaborates on (only that one)
//
// One connection per connected space, which shows the agent as running
// there ("agent" presence, with the host), and one per project it
// collaborates on, shown on that project only. Connections and
// collaborations made or dropped while it runs are picked up. XO Swarm
// starts this in a workspace with the agent's token in SPACEHUB_TOKEN.
import fs from 'node:fs';
import path from 'node:path';
import type { RowTypedQuery } from 'spacetimedb';
import { connectTo, errorMessage, projectsIn, tables, type Conn } from './conn';
import { cloneProject, findManifest, SpaceSync, writeManifest } from './spacesync';

const HEARTBEAT_MS = 60_000;

export interface AgentRunOptions {
  server: string;
  db: string;
  token: string; // the agent's
  agent: string;
  dir: string;
  intervalMs: number;
  host: string;
  log: (line: string) => void;
}

interface Running {
  conn: Conn;
  sync: SpaceSync;
  beat: ReturnType<typeof setInterval>;
}

// What runs: a whole space ("acme"), or one project the agent collaborates
// on in a space it is not connected to ("acme/site").
type Unit = string;

export class AgentRun {
  private o: AgentRunOptions;
  private units = new Map<Unit, Running | 'starting'>();
  private main: Conn | null = null;
  private stopping = false;
  private env: Record<string, string>;

  constructor(options: AgentRunOptions) {
    this.o = options;
    // git (and git-remote-quirq) push as the agent, whatever else is set up.
    this.env = { SPACEHUB_TOKEN: options.token, SPACEHUB_SERVER: options.server, SPACEHUB_DB: options.db, SPACEHUB_HOME: path.join(options.dir, '.spacehub', 'home') };
  }

  async run() {
    fs.mkdirSync(this.o.dir, { recursive: true });
    const { conn } = await connectTo(this.o.server, this.o.db, this.o.token, { reconnect: true });
    this.main = conn;
    const me = this.o.agent;
    const subscribe = (query: RowTypedQuery<any, any>) =>
      new Promise<void>((resolve, reject) =>
        conn
          .subscriptionBuilder()
          .onApplied(() => resolve())
          .onError(ctx => reject(new Error(`subscription failed: ${(ctx as { event?: unknown }).event}`)))
          .subscribe(query)
      );
    const live = (tag: string) => tag !== 'SubscribeApplied' && tag !== 'UnsubscribeApplied';
    conn.db.spaceRole.onInsert((ctx, r) => r.member === me && live(ctx.event.tag) && void this.rescope());
    conn.db.spaceRole.onDelete((ctx, r) => r.member === me && live(ctx.event.tag) && void this.rescope());
    conn.db.projectMember.onInsert((ctx, r) => r.agent === me && live(ctx.event.tag) && void this.rescope());
    conn.db.projectMember.onDelete((ctx, r) => r.agent === me && live(ctx.event.tag) && void this.rescope());
    // A project it collaborates on may be renamed into view after the row.
    conn.db.project.onInsert((ctx, p) => live(ctx.event.tag) && this.collaborations().has(`${p.owner}/${p.name}`) && void this.rescope());
    await subscribe(tables.spaceRole.where(r => r.member.eq(me)));
    await subscribe(tables.projectMember.where(r => r.agent.eq(me)));
    await subscribe(tables.project);
    await this.rescope();
    await new Promise<void>(resolve => {
      const stop = async () => {
        this.stopping = true;
        await Promise.all([...this.units.keys()].map(u => this.drop(u)));
        conn.disconnect();
        resolve();
      };
      process.once('SIGINT', () => void stop());
      process.once('SIGTERM', () => void stop());
    });
  }

  // Spaces it works in whole: its own, and those it is connected to.
  private spaces(): Set<string> {
    const conn = this.main!;
    return new Set([this.o.agent, ...[...conn.db.spaceRole.iter()].filter(r => r.member === this.o.agent).map(r => r.space)]);
  }

  // "space/project" of every project it collaborates on.
  private collaborations(): Set<string> {
    const conn = this.main!;
    const ids = new Set([...conn.db.projectMember.iter()].filter(r => r.agent === this.o.agent).map(r => r.projectId));
    return new Set([...conn.db.project.iter()].filter(p => ids.has(p.id)).map(p => p.fullName));
  }

  private rescoping: Promise<void> = Promise.resolve();

  // Start what it may now work in, stop what it may not. A project inside a
  // space it follows whole needs no unit of its own.
  private rescope() {
    this.rescoping = this.rescoping.then(async () => {
      if (this.stopping) return;
      const spaces = this.spaces();
      const wanted = new Set<Unit>([...spaces, ...[...this.collaborations()].filter(full => !spaces.has(full.split('/')[0]))]);
      for (const unit of [...this.units.keys()]) if (!wanted.has(unit)) await this.drop(unit);
      for (const unit of wanted) await this.start(unit);
    });
    return this.rescoping;
  }

  // Follow one unit: clone its projects into <dir>/<space> if this folder
  // lacks them, then autosync them.
  private async start(unit: Unit) {
    if (this.units.has(unit) || this.stopping) return;
    this.units.set(unit, 'starting');
    const [space, only] = unit.split('/');
    try {
      const { conn } = await connectTo(this.o.server, this.o.db, this.o.token, { reconnect: true });
      const dir = path.join(this.o.dir, space);
      let found = findManifest(dir);
      if (only) {
        // One project: a manifest of its own space would claim the rest of it.
        fs.mkdirSync(dir, { recursive: true });
        found = { dir, manifest: { hub: this.o.server, space, projects: found?.dir === dir ? found.manifest.projects : [] } };
      } else if (!found || found.dir !== dir) {
        fs.mkdirSync(dir, { recursive: true });
        const manifest = { hub: this.o.server, space, projects: [] as string[] };
        for (const p of await projectsIn(conn, space)) {
          if (!fs.existsSync(path.join(dir, p.name))) await cloneProject(this.o.server, space, p.name, path.join(dir, p.name), p.defaultBranch, this.env);
          manifest.projects.push(p.name);
        }
        writeManifest(dir, manifest);
        found = { dir, manifest };
      }
      const sync = new SpaceSync({
        conn,
        dir,
        manifest: found.manifest,
        server: this.o.server,
        mode: 'auto',
        intervalMs: this.o.intervalMs,
        agent: this.o.agent,
        restart: `spacehub agent run ${this.o.agent}`,
        log: line => this.o.log(`${space}/${line}`),
        env: this.env,
        author: this.o.agent,
        ...(only ? { only: [only] } : {}),
      });
      const beat = () =>
        (only ? conn.reducers.watchProject({ project: unit, mode: 'agent', branch: '' }) : conn.reducers.watchSpace({ space, mode: 'agent', host: this.o.host })).catch(err =>
          this.o.log(`${unit}: could not show presence: ${errorMessage(err)}`)
        );
      await beat();
      const running = { conn, sync, beat: setInterval(beat, HEARTBEAT_MS) };
      this.units.set(unit, running);
      this.o.log(only ? `${unit}: following (a collaborator on this project)` : `${space}: following (${found.manifest.projects.length} projects)`);
      void sync.run().then(paused => {
        if (paused) this.o.log(`${unit}: every project is paused; resolve them and restart`);
      });
    } catch (err) {
      this.units.delete(unit);
      this.o.log(`${unit}: ${errorMessage(err)}`);
    }
  }

  private async drop(unit: Unit) {
    const running = this.units.get(unit);
    this.units.delete(unit);
    if (!running || running === 'starting') return;
    clearInterval(running.beat);
    await running.sync.stop();
    running.conn.disconnect();
    if (!this.stopping) this.o.log(`${unit}: no longer connected; stopped following it (the folder stays)`);
  }
}
