// The cowork chat: each collaborator's own Cowork connects to a project and
// its agents talk, delegate and announce syncs through cowork_post, beside
// the project chat in collab/. Run in SpacetimeDB's in-process module
// harness (no server needed): npm test.
import { describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';
import { Sha1, objectHeader } from '../src/sha1';
import { readObject } from '../src/store';
import { readFileAt } from '../src/chat';
import { CHAT_PATH, LOG_PATH, STATE_PATH, parseLog } from '../src/collab';
import { COWORK_CHAT_PATH, COWORK_LOG_PATH, COWORK_STATE_PATH, addressedTo, parseAddress, parseCoworkLog, parseCoworkState } from '../src/cowork';

let nextConnection = 5000n;
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
const WORK = object('commit', `tree ${TREE.oid}\nparent ${FIRST.oid}\nauthor b <b@x> 0 +0000\ncommitter b <b@x> 0 +0000\n\nwork\n`);
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
  call(alice, mod.putObjects, { project: PROJECT, objects: [TREE, FIRST] });
  call(alice, mod.updateRef, { project: PROJECT, name: 'refs/heads/main', oldOid: '', newOid: FIRST.oid, force: false });
  call(alice, mod.addProjectMember, { project: PROJECT, agent: 'bob' });

  const head = () => [...h.db.gitRef.iter()].find(r => r.name === 'refs/heads/main' && r.projectId === h.db.project.fullName.find(PROJECT)!.id)!.oid;
  const read = (path: string) => {
    const sp = h.db.project.fullName.find(PROJECT)!;
    return readFileAt(head(), path, oid => readObject(h.db as any, sp.id, oid))?.text ?? null;
  };
  const send = (auth: TestAuth, fields: Record<string, unknown>) =>
    call(auth, mod.coworkPost, { project: PROJECT, id: crypto.randomUUID(), kind: 'message', cowork: '', agent: '', content: '', to: [], replyTo: '', delegation: '', title: '', status: '', key: '', meta: '', ...fields });
  const connect = (auth: TestAuth, cowork: string, meta: object = { agents: ['claude_code', 'codex'] }) => send(auth, { kind: 'connect', cowork, meta: JSON.stringify(meta) });
  const log = () => parseCoworkLog(read(COWORK_LOG_PATH) ?? '');
  const state = () => parseCoworkState(read(COWORK_STATE_PATH));
  return { h, call, alice, bob, carol, head, read, send, connect, log, state };
}

describe('cowork chat', () => {
  it('lives beside the project chat in collab/ and leaves it alone', () => {
    const { alice, bob, call, send, connect, read, log, state } = hub();
    call(alice, mod.collabPost, { project: PROJECT, id: 'p1', kind: 'goal', content: 'Ship the API', to: [], replyTo: '', task: '', taskTitle: '', taskStatus: '', taskOwner: '', meta: '' });
    const projectLog = read(LOG_PATH);
    const projectState = read(STATE_PATH);

    connect(alice, 'alice-laptop');
    connect(bob, 'bob-box', { agents: [{ name: 'claude_code', role: 'backend', skills: ['openapi'] }] });
    send(bob, { cowork: 'bob-box', agent: 'claude_code', content: 'Hello from the backend', to: ['alice-laptop'] });

    expect(read(LOG_PATH)).toBe(projectLog);
    expect(read(STATE_PATH)).toBe(projectState);
    expect(parseLog(read(LOG_PATH)!).map(l => l.content)).toEqual(['Ship the API']);
    expect(JSON.parse(read(CHAT_PATH)!).title).toBe('Project chat');
    expect(JSON.parse(read(COWORK_CHAT_PATH)!).title).toBe('Cowork chat');

    expect(log().map(l => [l.seq, l.type, l.from, l.author, l.user, l.role])).toEqual([
      [1, 'connect', 'alice-laptop', 'alice', 'alice', 'user'],
      [2, 'connect', 'bob-box', 'bob', 'bob', 'user'],
      [3, 'message', 'bob-box:claude_code', 'bob', 'bob', 'assistant'],
    ]);
    const s = state();
    expect(Object.keys(s.coworks).sort()).toEqual(['alice-laptop', 'bob-box']);
    expect(s.coworks['bob-box']).toMatchObject({ owner: 'bob', connected: true, branch: 'cowork/bob-box', accepts: ['request', 'delegate'], delegators: 'project' });
    expect(s.coworks['bob-box'].agents).toEqual([{ name: 'claude_code', role: 'backend', skills: ['openapi'] }]);
  });

  it('keeps each cowork to its owner: nobody speaks as someone else', () => {
    const { alice, bob, carol, send, connect } = hub();
    connect(bob, 'bob-box');
    expect(() => connect(alice, 'bob-box')).toThrow(/belongs to bob/);
    expect(() => send(alice, { cowork: 'bob-box', content: 'pretending' })).toThrow(/belongs to bob/);
    expect(() => send(bob, { cowork: 'bob-box', agent: 'gemini', content: 'hi' })).toThrow(/no agent "gemini"/);
    expect(() => send(bob, { cowork: 'nobody', content: 'hi' })).toThrow(/connect it first/);
    expect(() => connect(carol, 'carol-pc')).toThrow(/permission denied/);
  });

  it('takes the same envelope once, so resending is safe', () => {
    const { bob, send, connect, log } = hub();
    connect(bob, 'bob-box');
    send(bob, { id: 'same', cowork: 'bob-box', content: 'once' });
    send(bob, { id: 'same', cowork: 'bob-box', content: 'once' });
    expect(log().filter(l => l.id === 'same')).toHaveLength(1);
  });

  it('runs a delegation from offer to result; only the target answers it', () => {
    const { alice, bob, send, connect, state, log, call } = hub();
    connect(alice, 'alice-laptop');
    connect(bob, 'bob-box');
    send(alice, { kind: 'delegate', cowork: 'alice-laptop', agent: 'claude_code', delegation: 'openapi', to: ['bob-box:claude_code'], title: 'Write api/openapi.yaml', meta: JSON.stringify({ collab_task: 'spec' }) });
    expect(state().delegations.openapi).toMatchObject({ status: 'offered', from: 'alice-laptop:claude_code', from_user: 'alice', cowork: 'bob-box', collab_task: 'spec' });

    expect(() => send(alice, { kind: 'accept', cowork: 'alice-laptop', delegation: 'openapi' })).toThrow(/Only the cowork "bob-box"/);
    expect(() => send(bob, { kind: 'progress', cowork: 'bob-box', delegation: 'openapi', content: 'starting' })).toThrow(/Accept/);
    send(bob, { kind: 'accept', cowork: 'bob-box', agent: 'claude_code', delegation: 'openapi' });
    send(bob, { kind: 'progress', cowork: 'bob-box', agent: 'claude_code', delegation: 'openapi', content: 'Shared components done' });

    expect(() => send(bob, { kind: 'result', cowork: 'bob-box', delegation: 'openapi', content: 'done', meta: JSON.stringify({ commit: WORK.oid }) })).toThrow(/pushed to the hub/);
    call(bob, mod.putObjects, { project: PROJECT, objects: [WORK] });
    send(bob, { kind: 'result', cowork: 'bob-box', agent: 'claude_code', delegation: 'openapi', content: 'Spec is up', meta: JSON.stringify({ commit: WORK.oid, branch: 'cowork/bob-box', paths: ['api/openapi.yaml'] }) });

    expect(state().delegations.openapi).toMatchObject({ status: 'done', result: { commit: WORK.oid, branch: 'cowork/bob-box', paths: ['api/openapi.yaml'] } });
    expect(log().filter(l => l.delegation).map(l => [l.type, l.delegation!.status])).toEqual([
      ['delegate', 'offered'],
      ['accept', 'accepted'],
      ['progress', 'in_progress'],
      ['result', 'done'],
    ]);
    expect(() => send(alice, { kind: 'cancel', delegation: 'openapi' })).toThrow(/already done/);
  });

  it('respects each cowork\'s policy on who may hand it work', () => {
    const { alice, bob, send, connect } = hub();
    connect(alice, 'alice-laptop', { agents: ['claude_code'], accepts: ['request'] });
    expect(() => send(bob, { kind: 'delegate', delegation: 'd1', to: ['alice-laptop'], title: 'x' })).toThrow(/does not take delegated work/);
    connect(bob, 'bob-box', { agents: ['claude_code'], delegators: ['bob'] });
    // alice owns the project's space, so she may still delegate; carol could not.
    send(alice, { kind: 'delegate', delegation: 'd2', to: ['bob-box'], title: 'Review the spec' });
    connect(alice, 'alice-laptop', { accepts: [] });
    expect(() => send(bob, { kind: 'request', to: ['alice-laptop'], content: 'Which limit?' })).toThrow(/does not take requests/);
  });

  it('lets the offerer cancel, and the project\'s owners disconnect any cowork', () => {
    const { alice, bob, send, connect, state } = hub();
    connect(alice, 'alice-laptop');
    connect(bob, 'bob-box');
    send(bob, { kind: 'delegate', cowork: 'bob-box', delegation: 'd1', to: ['alice-laptop'], title: 'Proxy /api through Vite' });
    send(bob, { kind: 'cancel', delegation: 'd1', content: 'Not needed' });
    expect(state().delegations.d1.status).toBe('cancelled');

    expect(() => send(bob, { kind: 'disconnect', cowork: 'alice-laptop' })).toThrow(/Only alice/);
    send(alice, { kind: 'disconnect', cowork: 'bob-box' });
    expect(state().coworks['bob-box'].connected).toBe(false);
    expect(() => send(bob, { cowork: 'bob-box', content: 'still here?' })).toThrow(/disconnected/);
    expect(() => send(alice, { kind: 'delegate', delegation: 'd2', to: ['bob-box'], title: 'x' })).toThrow(/disconnected/);
    connect(bob, 'bob-box');
    expect(state().coworks['bob-box'].connected).toBe(true);
  });

  it('announces syncs only for commits on the hub, and keeps each cowork\'s head', () => {
    const { bob, call, send, connect, state, log } = hub();
    connect(bob, 'bob-box');
    expect(() => send(bob, { kind: 'sync', cowork: 'bob-box', meta: JSON.stringify({ commit: WORK.oid }) })).toThrow(/push it before/);
    call(bob, mod.putObjects, { project: PROJECT, objects: [WORK] });
    send(bob, { kind: 'sync', cowork: 'bob-box', content: 'Error schema and pagination params', meta: JSON.stringify({ commit: WORK.oid, paths: ['api/openapi.yaml'] }) });
    const s = state();
    expect(s.coworks['bob-box'].head).toMatchObject({ branch: 'cowork/bob-box', commit: WORK.oid, summary: 'Error schema and pagination params' });
    expect(s.syncs.map(x => x.cowork)).toEqual(['bob-box']);
    expect(log().slice(-1)[0].meta).toMatchObject({ paths: ['api/openapi.yaml'] });
  });

  it('keeps shared context by key', () => {
    const { alice, bob, send, connect, state } = hub();
    connect(bob, 'bob-box');
    send(bob, { kind: 'context', cowork: 'bob-box', agent: 'claude_code', key: 'api/conventions', content: 'snake_case, ISO 8601 UTC with Z, string ids' });
    expect(state().context['api/conventions']).toMatchObject({ by: 'bob-box:claude_code', content: 'snake_case, ISO 8601 UTC with Z, string ids' });
    send(alice, { kind: 'context', key: 'api/conventions', content: '' });
    expect(state().context['api/conventions']).toBeUndefined();
  });

  it('takes messages from the app on collab/cowork.chat.json', () => {
    const { bob, call, log } = hub();
    call(bob, mod.appendChat, { project: PROJECT, conversation: COWORK_CHAT_PATH, turns: [{ id: 'm1', role: 'user', content: 'Agents: the goal is up', links: [] }] });
    expect(log().map(l => [l.from, l.type, l.content])).toEqual([['bob', 'message', 'Agents: the goal is up']]);
    expect(() => call(bob, mod.appendChat, { project: PROJECT, conversation: 'collab/other.json', turns: [{ id: 'm2', role: 'user', content: 'x', links: [] }] })).toThrow(/cowork\.chat\.json/);
  });

  it('refuses pushes that change the cowork files', () => {
    const { bob, call, head } = hub();
    call(bob, mod.coworkPost, { project: PROJECT, id: 'c1', kind: 'connect', cowork: 'bob-box', agent: '', content: '', to: [], replyTo: '', delegation: '', title: '', status: '', key: '', meta: '' });
    const forged = object('commit', `tree ${TREE.oid}\nparent ${head()}\nauthor b <b@x> 0 +0000\ncommitter b <b@x> 0 +0000\n\nwipe collab\n`);
    call(bob, mod.putObjects, { project: PROJECT, objects: [forged] });
    expect(() => call(bob, mod.updateRef, { project: PROJECT, name: 'refs/heads/main', oldOid: head(), newOid: forged.oid, force: false })).toThrow(/spacehub cowork/);
  });
});

describe('addresses', () => {
  it('parses cowork addresses and finds what is meant for a cowork', () => {
    expect(parseAddress('bob-box:claude_code')).toEqual({ cowork: 'bob-box', agent: 'claude_code' });
    expect(parseAddress('bob-box')).toEqual({ cowork: 'bob-box', agent: '' });
    expect(parseAddress('Bob:x:y')).toBeNull();
    const base = { seq: 1, id: 'x', type: 'message' as const, role: 'user' as const, author: 'alice', user: 'alice', from: 'alice', content: '', time: '' };
    expect(addressedTo({ ...base, to: ['bob-box:codex'] }, 'bob-box', 'bob')).toBe(true);
    expect(addressedTo({ ...base, to: ['@bob'] }, 'bob-box', 'bob')).toBe(true);
    expect(addressedTo({ ...base, to: ['*'] }, 'bob-box', 'bob')).toBe(true);
    expect(addressedTo({ ...base, to: ['alice-laptop'] }, 'bob-box', 'bob')).toBe(false);
    expect(addressedTo({ ...base, cowork: 'bob-box', to: ['*'] }, 'bob-box', 'bob')).toBe(false);
  });
});
