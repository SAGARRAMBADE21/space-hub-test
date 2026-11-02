// The project chat: collaborators and the agents they bring post to
// collab/ on the default branch through collab_post. Run in SpacetimeDB's
// in-process module harness (no server needed): npm test.
import { describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';
import { Sha1, objectHeader } from '../src/sha1';
import { readObject } from '../src/store';
import { editFiles, readFileAt } from '../src/chat';
import { CHAT_PATH, LOG_PATH, ROTATE_BYTES, STATE_PATH, parseLog, parseState } from '../src/collab';

let nextConnection = 1000n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

const encoder = new TextEncoder();
function object(kind: string, text: string) {
  const data = encoder.encode(text);
  return { oid: new Sha1().update(objectHeader(kind, data.length)).update(data).hex(), kind, data };
}
const TREE = object('tree', '');
const FIRST = object('commit', `tree ${TREE.oid}\nauthor a <a@x> 0 +0000\ncommitter a <a@x> 0 +0000\n\nfirst\n`);
const PROJECT = 'acme/site';

function hub() {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) => h.withReducerTx(auth, ctx => reducer(ctx, args));
  const alice = as('alice'); // owns the org acme
  const bob = as('bob'); // a collaborator on acme/site
  const carol = as('carol'); // works elsewhere
  for (const [auth, username] of [[alice, 'alice'], [bob, 'bob'], [carol, 'carol']] as const) call(auth, mod.registerUser, { username });
  call(alice, mod.createOrg, { name: 'acme', description: '' });
  call(alice, mod.createProject, { space: 'acme', name: 'site', description: '' });
  call(alice, mod.createProject, { space: 'acme', name: 'private-plans', description: '' });
  call(alice, mod.putObjects, { project: PROJECT, objects: [TREE, FIRST] });
  call(alice, mod.updateRef, { project: PROJECT, name: 'refs/heads/main', oldOid: '', newOid: FIRST.oid, force: false });
  call(alice, mod.addProjectMember, { project: PROJECT, agent: 'bob' });

  const head = () => [...h.db.gitRef.iter()].find(r => r.name === 'refs/heads/main' && r.projectId === h.db.project.fullName.find(PROJECT)!.id)!.oid;
  const read = (path: string) => {
    const sp = h.db.project.fullName.find(PROJECT)!;
    return readFileAt(head(), path, oid => readObject(h.db as any, sp.id, oid))?.text ?? null;
  };
  const post = (auth: TestAuth, fields: Partial<Record<string, unknown>>) =>
    call(auth, mod.collabPost, { project: PROJECT, id: crypto.randomUUID(), kind: 'message', content: '', to: [], replyTo: '', task: '', taskTitle: '', taskStatus: '', taskOwner: '', meta: '', ...fields });
  const log = () => parseLog(read(LOG_PATH) ?? '');
  const state = () => parseState(read(STATE_PATH));
  return { h, call, alice, bob, carol, head, read, post, log, state };
}

// The harness signs agents in by their identity through a JWT subject; find
// the agent identity it derived and register the agent with that identity.
function agentHub() {
  const base = hub();
  const { h, call, bob } = base;
  const scout = as('scout-runtime');
  const identity = h.withReducerTx(scout, ctx => ctx.sender.toHexString());
  call(bob, mod.createAgent, { name: 'scribe', parent: 'bob', identity, token: 't', description: '' });
  return { ...base, scribe: scout };
}

describe('project chat', () => {
  it('appends attributed lines, folds the state and opens the chat file', () => {
    const { alice, bob, post, log, state, read } = hub();
    post(alice, { kind: 'goal', content: 'Ship the new landing page by Friday' });
    post(bob, { content: 'On it', to: ['alice'] });
    const lines = log();
    expect(lines.map(l => [l.seq, l.author, l.user, l.type, l.role])).toEqual([
      [1, 'alice', 'alice', 'goal', 'user'],
      [2, 'bob', 'bob', 'message', 'user'],
    ]);
    expect(lines[1].to).toEqual(['alice']);
    expect(state().goal?.content).toBe('Ship the new landing page by Friday');
    expect(Object.keys(state().participants).sort()).toEqual(['alice', 'bob']);
    expect(JSON.parse(read(CHAT_PATH)!).type).toBe('conversation');
  });

  it('takes the same post once, so resending after a reconnect is safe', () => {
    const { bob, post, log } = hub();
    post(bob, { id: 'retry-1', content: 'hello' });
    post(bob, { id: 'retry-1', content: 'hello' });
    expect(log().length).toBe(1);
  });

  it('is only for people working on the project', () => {
    const { carol, post } = hub();
    expect(() => post(carol, { content: 'let me in' })).toThrow(/permission denied/);
  });

  it('checks posts', () => {
    const { bob, post } = hub();
    expect(() => post(bob, { kind: 'shout', content: 'x' })).toThrow(/one of/);
    expect(() => post(bob, { content: '   ' })).toThrow(/needs some text/);
    expect(() => post(bob, { content: 'x', meta: '[1]' })).toThrow(/JSON object/);
    expect(() => post(bob, { content: 'x', task: 'nope' })).toThrow(/no open task/);
  });

  it('attributes an agent to the collaborator who brought it, and keeps it to that project', () => {
    const { call, alice, bob, carol, scribe, post, log } = agentHub();
    expect(() => post(scribe, { content: 'hi' })).toThrow(/permission denied/);
    // carol does not own scribe; alice owns the space but not the agent.
    expect(() => call(carol, mod.addProjectMember, { project: PROJECT, agent: 'scribe' })).toThrow(/owners of the agent/);
    expect(() => call(alice, mod.addProjectMember, { project: PROJECT, agent: 'scribe' })).toThrow(/owners of the agent/);
    // bob is a collaborator, not an owner of acme, and still brings his agent.
    call(bob, mod.addProjectMember, { project: PROJECT, agent: 'scribe' });
    post(scribe, { kind: 'finding', content: 'The hero image is 4 MB' });
    const line = log().slice(-1)[0];
    expect([line.author, line.agent, line.user, line.role, line.type]).toEqual(['scribe', 'scribe', 'bob', 'assistant', 'finding']);
    // Only this project: not the rest of acme.
    expect(() => call(scribe, mod.collabPost, { project: 'acme/private-plans', id: 'x', kind: 'message', content: 'hi', to: [], replyTo: '', task: '', taskTitle: '', taskStatus: '', taskOwner: '', meta: '' })).toThrow(/permission denied/);
  });

  it('lets builders who are not collaborators bring no agents, and keeps adding builders with the owners', () => {
    const { call, bob, carol } = agentHub();
    call(carol, mod.createAgent, { name: 'helper', parent: 'carol', identity: '0x' + 'ab'.repeat(32), token: 't', description: '' });
    expect(() => call(carol, mod.addProjectMember, { project: PROJECT, agent: 'helper' })).toThrow(/people working on/);
    expect(() => call(bob, mod.addProjectMember, { project: PROJECT, agent: 'carol' })).toThrow(/permission denied/);
  });

  it("takes a collaborator's agents away with them, and lets them take their agent back", () => {
    const { h, call, alice, bob, scribe, post } = agentHub();
    call(bob, mod.addProjectMember, { project: PROJECT, agent: 'scribe' });
    call(bob, mod.removeProjectMember, { project: PROJECT, agent: 'scribe' });
    expect([...h.db.projectMember.iter()].map(m => m.agent)).toEqual(['bob']);
    call(bob, mod.addProjectMember, { project: PROJECT, agent: 'scribe' });
    call(alice, mod.removeProjectMember, { project: PROJECT, agent: 'bob' });
    expect([...h.db.projectMember.iter()].map(m => m.agent)).toEqual([]);
    expect(() => post(scribe, { content: 'still here?' })).toThrow(/permission denied/);
  });

  it('tracks tasks: open, claim, update, hand off; only their people change them', () => {
    const { call, alice, bob, scribe, post, state, log } = agentHub();
    call(bob, mod.addProjectMember, { project: PROJECT, agent: 'scribe' });
    post(alice, { kind: 'task', task: 'hero', taskTitle: 'Compress the hero image', content: '' });
    expect(state().tasks.hero).toMatchObject({ status: 'open', owner: '', created_by: 'alice' });
    // Anyone may claim a task nobody owns.
    post(scribe, { kind: 'task', task: 'hero', taskOwner: 'scribe', taskStatus: 'in_progress', content: 'taking this' });
    expect(state().tasks.hero).toMatchObject({ status: 'in_progress', owner: 'scribe' });
    // Owned now: bob (neither owner nor opener) cannot change it.
    expect(() => post(bob, { kind: 'task', task: 'hero', taskStatus: 'done', content: '' })).toThrow(/Only scribe \(its owner\)/);
    // Owners hand off to someone taking part, not to an outsider.
    expect(() => post(scribe, { kind: 'handoff', task: 'hero', taskOwner: 'carol', content: 'yours' })).toThrow(/does not take part/);
    post(scribe, { kind: 'handoff', task: 'hero', taskOwner: 'bob', content: 'Resized to 400 KB; needs a WebP pass' });
    expect(state().tasks.hero).toMatchObject({ status: 'open', owner: 'bob', updated_by: 'scribe' });
    expect(log().slice(-1)[0].task).toEqual({ id: 'hero', status: 'open', owner: 'bob', from: 'scribe' });
    post(bob, { kind: 'task', task: 'hero', taskStatus: 'done', content: 'WebP shipped' });
    expect(state().tasks.hero.status).toBe('done');
  });

  it('keeps the last status of everyone and the decisions', () => {
    const { bob, alice, post, state } = hub();
    post(bob, { kind: 'status', content: 'reviewing PR 12' });
    post(alice, { kind: 'decision', content: 'We use WebP everywhere' });
    post(bob, { content: 'ok' });
    expect(state().participants.bob.status).toBe('reviewing PR 12');
    expect(state().decisions.map(d => d.content)).toEqual(['We use WebP everywhere']);
  });

  it('refuses pushes that change collab/, except an owner repairing it', () => {
    const { h, call, alice, bob, post, head } = hub();
    post(alice, { content: 'genuine' });
    const sp = h.db.project.fullName.find(PROJECT)!;
    const forge = (base: string) => {
      const built = editFiles({ head: base, changes: { [LOG_PATH]: encoder.encode('{"seq":1,"id":"x","author":"alice","content":"forged"}\n'), 'README.md': encoder.encode('hi') }, author: 'bob', now: 1, message: 'forge', read: oid => readObject(h.db as any, sp.id, oid) });
      call(bob, mod.putObjects, { project: PROJECT, objects: built.objects });
      return built.commit;
    };
    const before = head();
    const forged = forge(before);
    expect(() => call(bob, mod.updateRef, { project: PROJECT, name: 'refs/heads/main', oldOid: before, newOid: forged, force: false })).toThrow(/collab\/ is the project chat/);
    expect(() => call(bob, mod.updateRef, { project: PROJECT, name: 'refs/heads/main', oldOid: before, newOid: forged, force: true })).toThrow(/collab\/ is the project chat/);
    // Other branches may hold anything; other files on main still push.
    call(bob, mod.updateRef, { project: PROJECT, name: 'refs/heads/scratch', oldOid: '', newOid: forged, force: false });
    const ok = editFiles({ head: before, changes: { 'README.md': encoder.encode('hello') }, author: 'bob', now: 2, message: 'readme', read: oid => readObject(h.db as any, sp.id, oid) });
    call(bob, mod.putObjects, { project: PROJECT, objects: ok.objects });
    call(bob, mod.updateRef, { project: PROJECT, name: 'refs/heads/main', oldOid: before, newOid: ok.commit, force: false });
    // An owner may force a repair.
    call(alice, mod.updateRef, { project: PROJECT, name: 'refs/heads/main', oldOid: ok.commit, newOid: forged, force: true });
  });

  it('moves a big log to the archive and starts a new one, keeping the count', () => {
    const { bob, post, read, state, log } = hub();
    const text = 'x'.repeat(3500);
    const n = Math.ceil(ROTATE_BYTES / 3600) + 2;
    for (let i = 0; i < n; i++) post(bob, { content: `${i} ${text}` });
    const s = state();
    expect(s.seq).toBe(n);
    expect(s.archived.length).toBe(1);
    expect(log()[0].seq).toBe(s.first_seq);
    const archived = parseLog(read(s.archived[0])!);
    expect(archived[0].seq).toBe(1);
    expect(archived.length + log().length).toBe(n);
  });

  it('takes messages from the app on collab/chat.json as posts', () => {
    const { call, bob, log } = hub();
    call(bob, mod.appendChat, { project: PROJECT, conversation: CHAT_PATH, turns: [{ id: 'app-1', role: 'user', content: 'from the browser', links: [] }] });
    expect(log().map(l => [l.author, l.content])).toEqual([['bob', 'from the browser']]);
    expect(() => call(bob, mod.appendChat, { project: PROJECT, conversation: CHAT_PATH, turns: [{ id: 'app-2', role: 'assistant', content: 'fake', links: [] }] })).toThrow(/own messages/);
    expect(() => call(bob, mod.appendChat, { project: PROJECT, conversation: 'collab/other.json', turns: [{ id: 'app-3', role: 'user', content: 'x', links: [] }] })).toThrow(/Only collab\/chat.json/);
  });

  it('needs a first commit', () => {
    const { call, alice } = hub();
    expect(() => call(alice, mod.collabPost, { project: 'acme/private-plans', id: 'a', kind: 'message', content: 'hi', to: [], replyTo: '', task: '', taskTitle: '', taskStatus: '', taskOwner: '', meta: '' })).toThrow(/no commits/);
  });
});
