// One connection to the spacehub database plus small read helpers. Reads are
// short-lived subscriptions: subscribe, take what arrived, unsubscribe.
import { DbConnection, tables } from './module_bindings';
import type { Identity, RowTypedQuery } from 'spacetimedb';
import { loadConfig, saveToken } from './config';
import { isDecodeError, protocolProblem, unreadableData, type HubProtocol } from './compat';
import { PROTOCOL } from '../../module/src/protocol';
import type { ObjectReader } from './collab';

export { tables, PROTOCOL };
export type Conn = DbConnection;

const debug = !!process.env.SPACEHUB_DEBUG;

// The SDK logs connection chatter through console.log/info. stdout belongs to
// git when we run as a remote helper, so route it to stderr (debug only).
export function quietSdkLogs() {
  const toStderr = (...args: unknown[]) => {
    if (debug) process.stderr.write(args.map(String).join(' ') + '\n');
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

// Connect with an explicit token (or none, which creates a new identity).
// Long-lived connections pass `reconnect`: if the hub goes away after the
// connection opened, the SDK reconnects and replays the subscriptions.
export interface ConnectOptions {
  reconnect?: boolean;
}

export function connectTo(
  server: string,
  database: string,
  token?: string,
  options: ConnectOptions = {}
): Promise<{ conn: Conn; identity: Identity; token: string }> {
  guardHubData(server);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out connecting to ${server} (database "${database}")`)), 15_000);
    const builder = DbConnection.builder().withUri(server).withDatabaseName(database).withToken(token);
    if (options.reconnect) {
      // The hub may have been updated while it was away.
      builder.withAutomaticReconnect().onAutomaticReconnect(conn => {
        void hubProtocol(conn).then(hub => {
          const problem = protocolProblem(PROTOCOL, hub, server);
          if (problem) quit(problem);
        });
      });
    }
    builder
      .onConnect((conn, identity, issued) => {
        clearTimeout(timer);
        void hubProtocol(conn).then(hub => {
          const problem = protocolProblem(PROTOCOL, hub, server);
          if (!problem) return resolve({ conn, identity, token: issued });
          conn.disconnect();
          reject(new Error(problem));
        });
      })
      .onConnectError((_ctx, err) => {
        clearTimeout(timer);
        reject(new Error(`cannot connect to ${server} (database "${database}"): ${err?.message ?? err}`));
      })
      .build();
  });
}

// The client protocol the hub speaks, or null when it is too old to say (no
// client_protocol procedure) or does not answer in time.
export function hubProtocol(conn: Conn): Promise<HubProtocol | null> {
  const asked = conn.procedures.clientProtocol({}).then(
    p => ({ current: p.current, oldest: p.oldest }),
    () => null
  );
  const late = new Promise<null>(resolve => setTimeout(() => resolve(null), 10_000).unref());
  return Promise.race([asked, late]);
}

// A long-running command cannot go on with a hub it no longer matches.
function quit(message: string): never {
  process.stderr.write(`spacehub: ${message}\n`);
  process.exit(1);
}

// Rows this CLI cannot decode surface as an uncaught RangeError from the SDK.
// Say what it means instead of printing the SDK's stack; anything else ends
// the process as Node would.
let guarded = false;
function guardHubData(server: string) {
  if (guarded) return;
  guarded = true;
  process.on('uncaughtException', err => {
    if (!isDecodeError(err)) {
      process.stderr.write(`${err instanceof Error && err.stack ? err.stack : err}\n`);
      process.exit(1);
    }
    if (debug) process.stderr.write(`${err.stack}\n`);
    quit(unreadableData(server));
  });
}

// Connect as the identity saved for `server` (default: the configured one),
// creating and saving one on first use.
export async function connect(server?: string, options: ConnectOptions = {}): Promise<{ conn: Conn; identity: Identity; server: string; database: string }> {
  const cfg = loadConfig(server);
  const { conn, identity, token } = await connectTo(cfg.server, cfg.database, cfg.token, options);
  if (!cfg.token && !process.env.SPACEHUB_TOKEN) saveToken(cfg.server, token);
  return { conn, identity, server: cfg.server, database: cfg.database };
}

// Subscribe to `query`, run `read` once the rows are in the cache, then drop
// the subscription so the rows do not linger in memory.
export function snapshot<T>(conn: Conn, query: string | RowTypedQuery<any, any>, read: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const handle = conn
      .subscriptionBuilder()
      .onApplied(() => {
        let value: T;
        try {
          value = read();
        } catch (err) {
          reject(err);
          return;
        }
        handle.unsubscribeThen(() => resolve(value));
      })
      .onError(ctx => reject(new Error(`query failed: ${(ctx as { event?: unknown }).event ?? 'unknown error'}`)))
      .subscribe(query);
  });
}

export function findProject(conn: Conn, fullName: string) {
  return snapshot(conn, tables.project.where(s => s.fullName.eq(fullName)), () =>
    [...conn.db.project.iter()].find(s => s.fullName === fullName)
  );
}

// A top-level space: a builder's personal space, an org or an agent.
export function findSpace(conn: Conn, name: string) {
  return snapshot(conn, tables.space.where(s => s.name.eq(name)), () => [...conn.db.space.iter()].find(s => s.name === name));
}

export function spaceRoles(conn: Conn, space: string) {
  return snapshot(conn, tables.spaceRole.where(r => r.space.eq(space)), () =>
    [...conn.db.spaceRole.iter()].filter(r => r.space === space).sort((a, b) => (a.role === b.role ? a.member.localeCompare(b.member) : a.role === 'owner' ? -1 : 1))
  );
}

export function projectsIn(conn: Conn, space: string) {
  return snapshot(conn, tables.project.where(p => p.owner.eq(space)), () =>
    [...conn.db.project.iter()].filter(p => p.owner === space).sort((a, b) => a.name.localeCompare(b.name))
  );
}

export function listRefs(conn: Conn, projectId: bigint) {
  return snapshot(conn, tables.gitRef.where(r => r.projectId.eq(projectId)), () =>
    [...conn.db.gitRef.iter()].filter(r => r.projectId === projectId).sort((a, b) => a.name.localeCompare(b.name))
  );
}

// A project's git objects, read from the hub one at a time (the project chat
// reads a few small files this way; clones use the remote helper).
export function hubObjects(conn: Conn, projectId: bigint): ObjectReader {
  return async oid => {
    const key = `${projectId}:${oid}`;
    const row = await snapshot(conn, tables.gitObject.where(o => o.key.eq(key)), () => [...conn.db.gitObject.iter()].find(o => o.key === key));
    if (!row) return null;
    if (row.chunks === 0) return { kind: row.kind, data: row.data };
    const data = new Uint8Array(Number(row.size));
    for (let idx = 0; idx < row.chunks; idx++) {
      const chunkKey = `${key}:${idx}`;
      const chunk = await snapshot(conn, tables.objectChunk.where(c => c.key.eq(chunkKey)), () => [...conn.db.objectChunk.iter()].find(c => c.key === chunkKey));
      if (!chunk) return null;
      data.set(chunk.data, idx * 1024 * 1024);
    }
    return { kind: row.kind, data };
  };
}

export function findUser(conn: Conn, identity: Identity) {
  return snapshot(conn, tables.user.where(u => u.identity.eq(identity)), () =>
    [...conn.db.user.iter()].find(u => u.identity.isEqual(identity))
  );
}

export function errorMessage(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error: /, '');
}
