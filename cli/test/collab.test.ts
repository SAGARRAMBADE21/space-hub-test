// Reading the project chat back out of git objects (npm test): the files
// collab_post writes, committed to a plain git repository, read the way
// `spacehub collab read` and `watch` read them from the hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linesSince, newPost, readChat, readFileAtCommit, type ObjectReader } from '../src/collab.ts';
import { applyPost, emptyState, postFiles, CHAT_PATH, ROTATE_BYTES, type CollabState } from '../../module/src/collab.ts';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-'));
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
  // Write what one post changes and commit it, as the reducer does.
  let state: CollabState = emptyState();
  let log = '';
  const post = (author: string, content: string, extra: Record<string, string> = {}) => {
    const applied = applyPost(state, newPost({ content, ...extra }), { name: author, kind: author.endsWith('bot') ? 'agent' : 'builder', user: 'bob' }, { time: '2026-10-30T00:00:00.000Z', admin: false, isParticipant: () => true });
    assert.ok(applied);
    const { files, moved, state: next } = postFiles(log, state, applied);
    if (moved) {
      fs.mkdirSync(path.join(dir, path.dirname(moved.to)), { recursive: true });
      fs.renameSync(path.join(dir, moved.from), path.join(dir, moved.to));
    }
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    state = next;
    log = files['collab/chat.log.jsonl'];
    git('add', '-A');
    git('commit', '-q', '-m', `post ${applied.line.seq}`);
    return git('rev-parse', 'HEAD').toString().trim();
  };
  return { dir, read, post };
}

test('reads the log and state at a commit', async () => {
  const { read, post } = repo();
  post('alice', 'Ship Friday', { kind: 'goal' });
  const head = post('scoutbot', 'Hero image is 4 MB', { kind: 'finding' });
  const chat = await readChat(read, head);
  assert.equal(chat.state.seq, 2);
  assert.equal(chat.state.goal?.content, 'Ship Friday');
  assert.deepEqual(chat.lines.map(l => [l.seq, l.author, l.role, l.type]), [[1, 'alice', 'user', 'goal'], [2, 'scoutbot', 'assistant', 'finding']]);
  assert.equal(await readFileAtCommit(read, head, CHAT_PATH), null);
  assert.deepEqual((await linesSince(read, chat, 1)).map(l => l.seq), [2]);
});

test('reads across the archive after the log was moved aside', async () => {
  const { read, post } = repo();
  const text = 'y'.repeat(3000);
  const n = Math.ceil(ROTATE_BYTES / 3100) + 3;
  let head = '';
  for (let i = 1; i <= n; i++) head = post('bob', `${i} ${text}`);
  const chat = await readChat(read, head);
  assert.equal(chat.state.archived.length, 1);
  assert.ok(chat.state.first_seq > 1);
  const all = await linesSince(read, chat, 0);
  assert.deepEqual(all.map(l => l.seq), Array.from({ length: n }, (_, i) => i + 1));
  // A reader that saw part of the archive gets only what it missed.
  const missed = await linesSince(read, chat, 3);
  assert.equal(missed[0].seq, 4);
  assert.equal(missed.length, n - 3);
});
