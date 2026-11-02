// spacehub cowork xo (npm test): which messages cross between the hub's
// cowork chat and XO Space, how they are labelled, and that nothing comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hubToXo, loadXoLink, saveXoLink, splitContent, xoToHub, type XoLink } from '../src/coworkxo.ts';
import type { CoworkLine } from '../../module/src/cowork.ts';

const me = 'sagar';
const empty = (): XoLink => ({ hubSeq: 0, xoSeq: 0, hubIds: [], xoIds: [] });
const line = (fields: Partial<CoworkLine>): CoworkLine => ({ seq: 1, id: 'e1', type: 'message', role: 'user', author: 'sagar', user: 'sagar', from: 'sagar', content: 'hello', time: '2026-11-02T00:00:00Z', ...fields });

test('your own message on the hub goes to XO Space as it is', () => {
  assert.equal(hubToXo(line({}), me, empty()), 'hello');
});

test('someone else, or another cowork, is named', () => {
  assert.equal(hubToXo(line({ author: 'bob', user: 'bob', from: 'bob' }), me, empty()), '**bob** on spacehub:\n\nhello');
  assert.equal(hubToXo(line({ author: 'bob', user: 'bob', cowork: 'bob-box', from: 'bob-box' }), me, empty()), '**bob-box (cowork of bob)** on spacehub:\n\nhello');
});

test('what this link wrote, and non-chat envelopes, stay on the hub', () => {
  assert.equal(hubToXo(line({ id: 'mine' }), me, { ...empty(), hubIds: ['mine'] }), null);
  assert.equal(hubToXo(line({ type: 'connect', content: '' }), me, empty()), null);
  assert.equal(hubToXo(line({ type: 'sync', content: 'moved' }), me, empty()), null);
});

test('XO Space: the text goes as it is, and meta says who wrote it there', () => {
  const message = { id: 'm1', seq: 3, author_kind: 'owner', author_id: 'owner', text: 'hi' };
  assert.deepEqual(xoToHub(message, empty(), 'site'), { content: 'hi', meta: { xo: { kind: 'owner', who: 'owner', project: 'site' } } });
  assert.deepEqual(xoToHub({ ...message, author_kind: 'agent', author_id: 'project-coordinator' }, empty(), 'site')?.meta, { xo: { kind: 'agent', who: 'project-coordinator', project: 'site' } });
  assert.equal(xoToHub(message, { ...empty(), xoIds: ['m1'] }, 'site'), null);
});

test('long replies are split at line breaks within the hub limit', () => {
  const text = Array.from({ length: 60 }, (_, i) => `line ${i} ` + 'x'.repeat(90)).join('\n');
  const parts = splitContent(text, 1000);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => part.length <= 1000));
  assert.equal(parts.join('\n'), text);
  assert.deepEqual(splitContent('short'), ['short']);
});

test('where each side was read is kept per project and XO Space project', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xo-link-'));
  const before = process.env.SPACEHUB_HOME;
  process.env.SPACEHUB_HOME = home;
  try {
    assert.equal(loadXoLink('a/b', 'b').hubSeq, null);
    saveXoLink('a/b', 'b', { hubSeq: 4, xoSeq: 9, hubIds: ['x'], xoIds: ['y'] });
    assert.deepEqual(loadXoLink('a/b', 'b'), { hubSeq: 4, xoSeq: 9, hubIds: ['x'], xoIds: ['y'] });
    assert.equal(loadXoLink('a/b', 'other').xoSeq, null);
  } finally {
    if (before === undefined) delete process.env.SPACEHUB_HOME;
    else process.env.SPACEHUB_HOME = before;
  }
});
