// The app's workspace API and the append_chat reducer, in SpacetimeDB's
// in-process module harness (no server needed): npm test.
import { describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';
import { CHUNK_SIZE, objectKey, readObject, type Db } from '../src/store';
import { hashObject, serializeTree } from '../src/chat';
import { avatarOf, codeView, parseQuery, parseTree, workspace, type Meta, type Snapshot } from '../src/workspace';

let nextConnection = 1n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Obj = { oid: string; kind: string; data: Uint8Array };
type Files = Record<string, string | Uint8Array | { symlink: string }>;
const CONVERSATION = JSON.stringify({ type: 'conversation', title: 'quirq chat', messages: [{ role: 'assistant', content: 'Hi from the hub.' }] });
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);

function build(files: Files, objects: Obj[]): string {
  const folders = new Map<string, Files>();
  const entries: { mode: string; name: string; oid: string }[] = [];
  const add = (kind: string, data: Uint8Array) => {
    const oid = hashObject(kind, data);
    objects.push({ oid, kind, data });
    return oid;
  };
  for (const [name, content] of Object.entries(files)) {
    const [head, ...rest] = name.split('/');
    if (rest.length) folders.set(head, { ...folders.get(head), [rest.join('/')]: content });
    else if (typeof content === 'object' && 'symlink' in content) entries.push({ mode: '120000', name, oid: add('blob', encoder.encode(content.symlink)) });
    else entries.push({ mode: '100644', name, oid: add('blob', typeof content === 'string' ? encoder.encode(content) : content) });
  }
  for (const [name, inner] of folders) entries.push({ mode: '40000', name, oid: build(inner, objects) });
  return add('tree', serializeTree(entries));
}

function hub() {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) => h.withReducerTx(auth, ctx => reducer(ctx, args));
  const alice = as('alice');
  const bob = as('bob');
  call(alice, mod.registerUser, { username: 'alice' });
  call(bob, mod.registerUser, { username: 'bob' });
  call(alice, mod.createOrg, { name: 'quirq', description: 'our team' });
  call(alice, mod.createProject, { space: 'quirq', name: 'quirq', description: 'the workspace' });
  let head = '';
  const push = (files: Files, big: Obj[] = []) => {
    const objects: Obj[] = [];
    const tree = build(files, objects);
    const who = 'seed <seed@example.com> 1800000000 +0000';
    const commit = { kind: 'commit', data: encoder.encode(`tree ${tree}\n${head ? `parent ${head}\n` : ''}author ${who}\ncommitter ${who}\n\nseed\n`) } as Obj;
    commit.oid = hashObject('commit', commit.data);
    for (const object of big) {
      const chunks = Math.ceil(object.data.length / CHUNK_SIZE);
      for (let idx = 0; idx < chunks; idx++) call(alice, mod.putChunk, { project: 'quirq/quirq', oid: object.oid, idx, data: object.data.subarray(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE) });
      call(alice, mod.finishObject, { project: 'quirq/quirq', oid: object.oid, kind: object.kind, size: BigInt(object.data.length), chunks });
    }
    const small = objects.filter(object => !big.some(other => other.oid === object.oid));
    call(alice, mod.putObjects, { project: 'quirq/quirq', objects: [...small, commit] });
    call(alice, mod.updateRef, { project: 'quirq/quirq', name: 'refs/heads/main', oldOid: head, newOid: commit.oid, force: false });
    head = commit.oid;
  };
  push({
    'README.md': '# quirq',
    'Chat/index.json': CONVERSATION,
    'Activity/example.jsonl': '{"author":"suraj","content":"first"}\n',
    'Library/logo.png': PNG,
    '.private/token.txt': 'secret',
    'link-out': { symlink: '/etc/passwd' },
  });
  const db = h.db as unknown as Db;
  const view = (query: Record<string, string>, viewer: string | null = null) =>
    workspace(db, { query: new Map(Object.entries(query)), viewer, now: 1_800_000_100 }) as { snapshot: Snapshot; meta: Meta };
  const project = () => h.db.project.fullName.find('quirq/quirq')!;
  const turn = (id: string, content: string, role = 'user') => ({ id, role, content, links: [] as { label: string; path: string }[] });
  return { h, db, call, alice, bob, push, view, project, turn, head: () => head };
}

const status = (fn: () => unknown) => {
  try {
    fn();
    return 200;
  } catch (error) {
    return (error as { status?: number }).status ?? 0;
  }
};

describe('workspace API', () => {
  it('shows the hub, a space and a project as folders, and a project as files', () => {
    const { view } = hub();
    const top = view({});
    expect(top.meta.level).toBe('hub');
    const quirq = top.snapshot.directory.entries.find(entry => entry.name === 'quirq')!;
    expect(quirq).toMatchObject({ kind: 'directory', detail: 'org · 1 project' });

    const space = view({ space: 'quirq' });
    expect(space.snapshot.directory.entries.map(entry => [entry.name, entry.detail])).toEqual([['quirq', 'the workspace']]);
    expect(space.meta).toMatchObject({ level: 'space', kind: 'org', owners: ['alice'], members: [], projects: 1 });

    const project = view({ space: 'quirq', project: 'quirq' }, 'alice');
    // Hidden names and symlinks stay out, as in open-chat.
    expect(project.snapshot.directory.entries.map(entry => entry.name)).toEqual(['Activity', 'Chat', 'Library', 'README.md']);
    expect(project.snapshot.roots.map(entry => entry.name)).toEqual(['Activity', 'Chat', 'Library']);
    expect(project.meta).toMatchObject({ level: 'project', fullName: 'quirq/quirq', defaultBranch: 'main', canWrite: true });
    expect(view({ space: 'quirq', project: 'quirq' }, 'bob').meta).toMatchObject({ canWrite: false });
  });

  it('counts every activity event, the humans and the agents on the hub', () => {
    const { db, call, alice, view } = hub();
    const id = (n: number) => n.toString(16).padStart(64, '0');
    call(alice, mod.createAgent, { name: 'scout', parent: 'quirq', identity: id(1), token: 'one', description: '' });
    const meta = view({}).meta as Extract<Meta, { level: 'hub' }>;
    expect(meta.events).toBe([...db.activity.iter()].length);
    expect(meta.events).toBeGreaterThan(5);
    expect(meta).toMatchObject({ humans: 2, agents: 1, spaces: 4 });
  });

  it('opens files the way open-chat does and refuses what it must not show', () => {
    const { view } = hub();
    const chat = view({ space: 'quirq', project: 'quirq', path: 'Chat/index.json' }).snapshot;
    expect(chat.file).toMatchObject({ format: 'json', path: 'Chat/index.json', size: CONVERSATION.length });
    expect((chat.file!.data as { title: string }).title).toBe('quirq chat');
    expect(chat.directory.path).toBe('Chat');
    expect(view({ space: 'quirq', project: 'quirq', path: 'Activity/example.jsonl' }).snapshot.file?.format).toBe('jsonl');
    const image = view({ space: 'quirq', project: 'quirq', path: 'Library/logo.png' }).snapshot.file!;
    expect(image).toMatchObject({ format: 'image', size: PNG.length });
    expect(image.content).toBeUndefined();

    for (const [path, code] of [['.private/token.txt', 403], ['../x', 400], ['link-out', 404], ['missing.md', 404]] as const) {
      expect(status(() => view({ space: 'quirq', project: 'quirq', path }))).toBe(code);
    }
    expect(status(() => view({ space: 'nobody' }))).toBe(404);
    expect(status(() => view({ space: 'quirq', project: 'nope' }))).toBe(404);
    expect(parseQuery('space=quirq&path=Chat%2Findex.json#x')).toEqual(new Map([['space', 'quirq'], ['path', 'Chat/index.json']]));
  });

  it('changes its revision when the project changes', () => {
    const { view, push } = hub();
    const before = view({ space: 'quirq', project: 'quirq', path: 'README.md' }).snapshot;
    push({ 'README.md': '# quirq, edited', 'Chat/index.json': CONVERSATION });
    const after = view({ space: 'quirq', project: 'quirq', path: 'README.md' }).snapshot;
    expect(after.file?.content).toBe('# quirq, edited');
    expect(after.revision).not.toBe(before.revision);
  });
});

describe('append_chat', () => {
  it('commits turns to a log beside the conversation, as the caller', () => {
    const { call, alice, view, project, turn, head, db } = hub();
    const before = head();
    call(alice, mod.appendChat, { project: 'quirq/quirq', conversation: 'Chat/index.json', turns: [turn('u1', 'Where is the brief?')] });
    call(alice, mod.appendChat, { project: 'quirq/quirq', conversation: 'Chat/index.json', turns: [turn('a1', 'In Library.', 'assistant')] });
    const log = view({ space: 'quirq', project: 'quirq', path: 'Chat/index.log.jsonl' }).snapshot.file!;
    expect(log.format).toBe('jsonl');
    const lines = log.content!.trim().split('\n').map(line => JSON.parse(line));
    expect(lines.map(line => [line.id, line.role, line.author])).toEqual([['u1', 'user', 'alice'], ['a1', 'assistant', 'quirqy']]);
    expect(view({ space: 'quirq', project: 'quirq', path: 'README.md' }).snapshot.file?.content).toBe('# quirq');
    const meta = view({ space: 'quirq', project: 'quirq' }).meta;
    expect(meta).toMatchObject({ head: { subject: 'chat: 1 message in Chat/index.log.jsonl', author: 'alice' } });
    expect(meta.level === 'project' && meta.activity[0]).toMatchObject({ kind: 'ref_updated', agent: 'alice', count: 1 });

    // The new commit sits on the old head, and every object it reaches hashes to its id
    // (scripts/e2e.sh also clones it with git and runs git fsck).
    const id = project().id;
    const tip = db.gitRef.key.find(`${id}:refs/heads/main`)!.oid;
    const queue = [tip];
    const seen = new Set<string>();
    let commits = 0;
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = readObject(db, id, oid)!;
      expect(hashObject(object.kind, object.data)).toBe(oid);
      if (object.kind === 'commit') {
        const text = decoder.decode(object.data);
        if (oid !== before && commits++ < 2) queue.push(...[...text.matchAll(/^(?:tree|parent) ([0-9a-f]{40})$/gm)].map(m => m[1]));
      }
      if (object.kind === 'tree') queue.push(...parseTree(object.data).filter(entry => entry.mode !== '160000').map(entry => entry.oid));
    }
    expect(seen.has(before)).toBe(true);
    expect(commits).toBe(2);
  });

  it('stores a log over one chunk in chunks and keeps appending to it', () => {
    const { call, alice, view, push, project, turn, db } = hub();
    const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ id: `old-${i}`, role: 'user', content: 'x'.repeat(3600) })).join('\n') + '\n';
    const big = { kind: 'blob', data: encoder.encode(lines) } as Obj;
    big.oid = hashObject('blob', big.data);
    push({ 'Chat/index.json': CONVERSATION, 'Chat/index.log.jsonl': big.data }, [big]);
    call(alice, mod.appendChat, { project: 'quirq/quirq', conversation: 'Chat/index.json', turns: [turn('new-1', 'still saving')] });
    const content = view({ space: 'quirq', project: 'quirq', path: 'Chat/index.log.jsonl' }).snapshot.file!.content!;
    expect(content.startsWith(lines)).toBe(true);
    expect(JSON.parse(content.trim().split('\n').pop()!).id).toBe('new-1');
    const id = project().id;
    const tip = db.gitRef.key.find(`${id}:refs/heads/main`)!.oid;
    expect(db.gitObject.key.find(objectKey(id, tip))).toBeTruthy();
  });

  it('refuses what it must not write', () => {
    const { call, alice, bob, turn } = hub();
    const append = (who: TestAuth, conversation: string, turns: object[]) => () => call(who, mod.appendChat, { project: 'quirq/quirq', conversation, turns });
    expect(append(bob, 'Chat/index.json', [turn('b1', 'hi')])).toThrow(/permission denied/);
    expect(append(alice, 'README.md', [turn('x', 'hi')])).toThrow(/conversation/);
    expect(append(alice, 'Activity/example.jsonl', [turn('x', 'hi')])).toThrow(/conversation/);
    expect(append(alice, 'Chat/missing.json', [turn('x', 'hi')])).toThrow(/not found/);
    expect(append(alice, '../x.json', [turn('x', 'hi')])).toThrow(/traversal/);
    expect(append(alice, 'Chat/index.json', [turn('x', 'hi', 'system')])).toThrow(/user or the assistant/);
    expect(append(alice, 'Chat/index.json', [turn('x', 'y'.repeat(4001))])).toThrow(/4000/);
    expect(append(alice, 'Chat/index.json', [])).toThrow(/1 to 2/);
    expect(append(alice, 'Chat/index.json', [turn('bad id!', 'hi')])).toThrow(/id/);
  });
});

describe('code views', () => {
  const code = (db: Db, query: Record<string, string>) => codeView(db, { query: new Map(Object.entries({ space: 'quirq', project: 'quirq', ...query })), viewer: null, now: 1_800_000_100 }) as any;

  it('list branches, folders with their last commit and README, and files', () => {
    const { db, push } = hub();
    push({ 'README.md': '# quirq, edited', 'Chat/index.json': CONVERSATION, '.github/ci.yml': 'on: push' });
    const refs = code(db, { view: 'refs' });
    expect(refs.branches.map((b: { name: string }) => b.name)).toEqual(['main']);
    expect(refs.branches[0].commit.subject).toBe('seed');
    const root = code(db, { view: 'tree' });
    expect(root.kind).toBe('tree');
    // The code view shows dotfiles, unlike the workspace.
    expect(root.entries.map((e: { name: string }) => e.name)).toEqual(['.github', 'Chat', 'README.md']);
    expect(root.readme).toEqual({ name: 'README.md', content: '# quirq, edited' });
    expect(root.entries.find((e: { name: string }) => e.name === 'README.md').last.subject).toBe('seed');
    const blob = code(db, { view: 'tree', path: 'Chat/index.json' });
    expect(blob).toMatchObject({ kind: 'blob', binary: false, size: CONVERSATION.length, path: 'Chat/index.json' });
    expect(JSON.parse(blob.text).title).toBe('quirq chat');
    expect(code(db, { view: 'files' }).paths).toEqual(['.github/ci.yml', 'Chat/index.json', 'README.md']);
    expect(status(() => code(db, { view: 'tree', path: 'nope' }))).toBe(404);
    expect(status(() => code(db, { view: 'tree', ref: 'nobranch' }))).toBe(404);
    expect(status(() => code(db, { view: 'tree', path: '../x' }))).toBe(400);
  });

  it('page history, filter it by path, and show a commit with its diff', () => {
    const { db, push, call, alice, turn } = hub();
    push({ 'README.md': '# quirq\nsecond line', 'Chat/index.json': CONVERSATION });
    call(alice, mod.appendChat, { project: 'quirq/quirq', conversation: 'Chat/index.json', turns: [turn('u1', 'hi')] });
    const all = code(db, { view: 'commits' });
    expect(all.commits.map((c: { subject: string }) => c.subject)).toEqual(['chat: 1 message in Chat/index.log.jsonl', 'seed', 'seed']);
    expect(all.more).toBe(false);
    const readme = code(db, { view: 'commits', path: 'README.md' });
    expect(readme.commits).toHaveLength(2);
    const diff = code(db, { view: 'commit', oid: readme.commits[0].oid });
    const file = diff.files.find((f: { path: string }) => f.path === 'README.md');
    expect(file).toMatchObject({ status: 'M', adds: 1, dels: 0 });
    expect(file.hunks[0].lines).toContainEqual(['+', null, 2, 'second line']);
    expect(diff.files.find((f: { path: string }) => f.path === 'Library/logo.png')).toMatchObject({ status: 'D', note: 'Binary file.' });
    expect(status(() => code(db, { view: 'commit', oid: 'f'.repeat(40) }))).toBe(404);
  });

  it('describe people: avatars, profiles and who works on a project', () => {
    const { db, call, alice, bob, view } = hub();
    call(alice, mod.addProjectMember, { project: 'quirq/quirq', agent: 'bob' });
    expect(avatarOf(db, 'alice')).toEqual({ name: 'alice', kind: 'personal', githubLogin: '' });
    expect(avatarOf(db, 'quirq')).toMatchObject({ kind: 'org' });
    expect(avatarOf(db, 'nobody')).toEqual({ name: 'nobody', kind: '', githubLogin: '' });
    const profile = view({ space: 'alice' }).meta;
    expect(profile).toMatchObject({ level: 'space', kind: 'personal', memberOf: [{ space: 'quirq', kind: 'org', role: 'owner' }], collaborates: [] });
    expect(view({ space: 'bob' }).meta).toMatchObject({ collaborates: ['quirq/quirq'] });
    expect(view({ space: 'quirq', project: 'quirq' }).meta).toMatchObject({ owners: ['alice'], members: [], collaborators: ['bob'] });
    expect(view({}).meta).toMatchObject({ allProjects: [{ fullName: 'quirq/quirq', description: 'the workspace' }] });
    void bob;
  });
});

describe('agents', () => {
  it('get their own list, apart from the members, with who owns them and where they run', () => {
    const { db, call, alice, view } = hub();
    const id = (n: number) => n.toString(16).padStart(64, '0');
    call(alice, mod.createAgent, { name: 'scout', parent: 'quirq', identity: id(1), token: 'one', description: 'reads the web' });
    call(alice, mod.createAgent, { name: 'helper', parent: 'alice', identity: id(2), token: 'two', description: '' });
    call(alice, mod.connectAgent, { agent: 'helper', space: 'quirq' });
    call(alice, mod.addSpaceMember, { space: 'quirq', member: 'bob', role: 'member' });

    const space = view({ space: 'quirq' }).meta;
    expect(space).toMatchObject({ level: 'space', owners: ['alice'], members: ['bob'], agents: ['scout'] });
    const agents = space.level === 'space' ? space.agentList : [];
    expect(agents.map(a => [a.name, a.owned, a.connected, a.parent])).toEqual([['helper', false, true, 'alice'], ['scout', true, false, 'quirq']]);
    expect(agents[0].spaces).toEqual(['quirq']);
    expect(agents.every(a => a.running.length === 0)).toBe(true);
    expect(view({ space: 'alice' }).meta).toMatchObject({ agents: ['helper'] });
    expect(view({ space: 'quirq', project: 'quirq' }).meta).toMatchObject({ members: ['bob'], agents: ['helper'], brought: [], collaborators: [] });
    void db;
  });

  it('show which agents were brought to one project, and by whom', () => {
    const { call, alice, view } = hub();
    call(alice, mod.createAgent, { name: 'helper', parent: 'alice', identity: '7'.padStart(64, '0'), token: 'seven', description: '' });
    call(alice, mod.addProjectMember, { project: 'quirq/quirq', agent: 'helper' });
    expect(view({ space: 'quirq', project: 'quirq' }).meta).toMatchObject({ agents: ['helper'], brought: [{ agent: 'helper', by: 'alice' }], collaborators: [] });
  });
});
