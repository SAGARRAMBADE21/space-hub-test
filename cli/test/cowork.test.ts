// Reading the cowork chat back out of git objects (npm test): the files
// cowork_post writes, committed to a plain git repository beside the project
// chat, read the way `spacehub cowork read`, `context` and `watch` read them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { briefing, coworkLinesSince, formatCoworkState, loadProfile, newEnvelope, readCoworkChat, saveProfile } from '../src/cowork.ts';
import { newPost, type ObjectReader } from '../src/collab.ts';
import { applyCoworkPost, coworkPostFiles, emptyCoworkState, ROTATE_BYTES, type CoworkState } from '../../module/src/cowork.ts';
import { applyPost, emptyState, postFiles } from '../../module/src/collab.ts';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'buffer' });
  git('init', '-q', '-b', 'main');
  const read: ObjectReader = async oid => {
    try {
      const kind = git('cat-file', '-t', oid).toString().trim();
      return { kind, data: new Uint8Array(git('cat-file', kind, oid)) };
    } catch {
      return null;
    }
  };
  const write = (files: Record<string, string>, moved: { from: string; to: string } | null) => {
    if (moved) {
      fs.mkdirSync(path.join(dir, path.dirname(moved.to)), { recursive: true });
      fs.renameSync(path.join(dir, moved.from), path.join(dir, moved.to));
    }
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'post');
    return git('rev-parse', 'HEAD').toString().trim();
  };
  let state: CoworkState = emptyCoworkState();
  let log = '';
  const send = (user: string, fields: Parameters<typeof newEnvelope>[0]) => {
    const applied = applyCoworkPost(state, newEnvelope(fields), { name: user, kind: 'builder', user }, { time: '2026-11-02T00:00:00.000Z', admin: user === 'alice', isOwner: n => n === 'alice', isParticipant: () => true, hasCommit: () => true });
    assert.ok(applied);
    const out = coworkPostFiles(log, state, applied);
    state = out.state;
    log = out.files['collab/cowork.chat.log.jsonl'];
    return write(out.files, out.moved);
  };
  let projectState = emptyState();
  const post = (user: string, content: string, kind: string) => {
    const applied = applyPost(projectState, newPost({ content, kind }), { name: user, kind: 'builder', user }, { time: '2026-11-02T00:00:00.000Z', admin: true, isParticipant: () => true });
    assert.ok(applied);
    const out = postFiles('', projectState, applied);
    projectState = out.state;
    return write(out.files, null);
  };
  return { dir, read, send, post };
}

test('reads the cowork chat and the project chat together, and briefs an agent', async () => {
  const { read, send, post } = repo();
  post('alice', 'Ship the API by Friday', 'goal');
  post('alice', 'snake_case everywhere', 'decision');
  send('alice', { kind: 'connect', cowork: 'alice-laptop', meta: JSON.stringify({ agents: [{ name: 'claude_code', role: 'frontend' }] }) });
  send('bob', { kind: 'connect', cowork: 'bob-box', meta: JSON.stringify({ agents: ['claude_code'] }) });
  send('alice', { kind: 'delegate', cowork: 'alice-laptop', agent: 'claude_code', delegation: 'openapi', to: ['bob-box'], title: 'Write api/openapi.yaml', content: 'Shared components first' });
  send('bob', { kind: 'context', cowork: 'bob-box', key: 'api/limits', content: 'Default limit 20, max 100, clamped' });
  const head = send('bob', { kind: 'sync', cowork: 'bob-box', content: 'Spec skeleton', meta: JSON.stringify({ commit: 'a'.repeat(40), paths: ['api/openapi.yaml'] }) });

  const chat = await readCoworkChat(read, head);
  assert.equal(chat.state.seq, 5);
  assert.equal(chat.project.goal?.content, 'Ship the API by Friday');
  assert.deepEqual((await coworkLinesSince(read, chat, 3)).map(l => l.type), ['context', 'sync']);

  const brief = briefing('acme/site', chat, { cowork: 'bob-box', user: 'bob' }, chat.lines.slice(-3));
  assert.match(brief, /## Goal\nShip the API by Friday/);
  assert.match(brief, /snake_case everywhere/);
  assert.match(brief, /- alice-laptop: alice, agents claude_code \(frontend\)/);
  assert.match(brief, /## Waiting for you\n- openapi \[offered\] from alice-laptop:claude_code: Write api\/openapi.yaml\n {2}Shared components first/);
  assert.match(brief, /### api\/limits\nDefault limit 20/);
  assert.match(brief, /bob-box moved cowork\/bob-box to aaaaaaaaaa: Spec skeleton/);

  const report = formatCoworkState(chat.state);
  assert.match(report, /alice-laptop {5}online/);
  assert.match(report, /openapi {10}offered {5}alice-laptop:claude_code → bob-box/);
});

test('reads across the archive after the log was moved aside', async () => {
  const { read, send } = repo();
  send('bob', { kind: 'connect', cowork: 'bob-box' });
  const text = 'y'.repeat(3000);
  const n = Math.ceil(ROTATE_BYTES / 3200) + 3;
  let head = '';
  for (let i = 2; i <= n; i++) head = send('bob', { cowork: 'bob-box', content: `${i} ${text}` });
  const chat = await readCoworkChat(read, head);
  assert.equal(chat.state.archived.length, 1);
  assert.match(chat.state.archived[0], /collab\/archive\/cowork\.chat\.\d{6}-\d{6}\.log\.jsonl$/);
  assert.deepEqual((await coworkLinesSince(read, chat, 0)).map(l => l.seq), Array.from({ length: n }, (_, i) => i + 1));
});

test('remembers which cowork this machine speaks as, per project', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-home-'));
  const before = process.env.SPACEHUB_HOME;
  process.env.SPACEHUB_HOME = home;
  try {
    assert.equal(loadProfile('acme/site'), null);
    saveProfile('acme/site', { cowork: 'bob-box', agent: 'claude_code' });
    saveProfile('acme/site', { seen: 12 });
    assert.deepEqual(loadProfile('acme/site'), { cowork: 'bob-box', agent: 'claude_code', seen: 12 });
    assert.equal((fs.statSync(path.join(home, 'cowork', 'profiles.json')).mode & 0o777).toString(8), '600');
    saveProfile('acme/site', null);
    assert.equal(loadProfile('acme/site'), null);
  } finally {
    if (before === undefined) delete process.env.SPACEHUB_HOME;
    else process.env.SPACEHUB_HOME = before;
  }
});
