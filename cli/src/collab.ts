// spacehub collab: the project chat (module/src/collab.ts) for people in a
// terminal and for agents. Posts go through the collab_post reducer, so the
// hub attributes and orders them; reads come straight from the default
// branch on the hub, so every reader sees the same log and state whatever
// its clone has pulled. `watch` follows the default branch and prints each
// new post once, resuming from a sequence number after a reconnect.
import crypto from 'node:crypto';
import { LOG_PATH, STATE_PATH, parseLog, parseState, type CollabLine, type CollabState, type PostIn } from '../../module/src/collab.ts';

export { formatLine, POST_KINDS, TASK_STATUSES, type CollabLine, type CollabState } from '../../module/src/collab.ts';

const decoder = new TextDecoder('utf-8');

/** Reads git objects of one project: from the hub (hubObjects in conn.ts), or a map in tests. */
export type ObjectReader = (oid: string) => Promise<{ kind: string; data: Uint8Array } | null>;

function treeEntries(data: Uint8Array) {
  const entries: { mode: string; name: string; oid: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0) break;
    const oid = [...data.subarray(nul + 1, nul + 21)].map(b => b.toString(16).padStart(2, '0')).join('');
    entries.push({ mode: decoder.decode(data.subarray(i, sp)), name: decoder.decode(data.subarray(sp + 1, nul)), oid });
    i = nul + 21;
  }
  return entries;
}

/** A file's text at a commit, or null when it is not there. */
export async function readFileAtCommit(read: ObjectReader, commit: string, path: string): Promise<string | null> {
  const head = await read(commit);
  if (!head || head.kind !== 'commit') return null;
  let oid = /^tree ([0-9a-f]{40})$/m.exec(decoder.decode(head.data))?.[1] ?? '';
  for (const part of path.split('/')) {
    const tree = oid ? await read(oid) : null;
    if (!tree || tree.kind !== 'tree') return null;
    oid = treeEntries(tree.data).find(e => e.name === part)?.oid ?? '';
    if (!oid) return null;
  }
  const blob = await read(oid);
  return blob?.kind === 'blob' ? decoder.decode(blob.data) : null;
}

export interface Chat {
  commit: string;
  state: CollabState;
  /** Lines of collab/chat.log.jsonl (from state.first_seq). */
  lines: CollabLine[];
}

export async function readChat(read: ObjectReader, commit: string): Promise<Chat> {
  const [state, log] = await Promise.all([readFileAtCommit(read, commit, STATE_PATH), readFileAtCommit(read, commit, LOG_PATH)]);
  return { commit, state: parseState(state), lines: parseLog(log ?? '') };
}

/** Lines after `since`, from the archive too when the log was moved aside since then. */
export async function linesSince(read: ObjectReader, chat: Chat, since: number): Promise<CollabLine[]> {
  const older: CollabLine[] = [];
  if (since + 1 < chat.state.first_seq) {
    for (const path of chat.state.archived) {
      const range = /chat\.(\d+)-(\d+)\.log\.jsonl$/.exec(path);
      if (range && Number(range[2]) <= since) continue;
      older.push(...parseLog((await readFileAtCommit(read, chat.commit, path)) ?? ''));
    }
  }
  const seen = new Set<number>();
  return [...older, ...chat.lines].filter(line => line.seq > since && !seen.has(line.seq) && seen.add(line.seq)).sort((a, b) => a.seq - b.seq);
}

export function newPost(fields: Partial<PostIn>): PostIn {
  return { id: crypto.randomUUID(), kind: 'message', content: '', to: [], replyTo: '', task: '', taskTitle: '', taskStatus: '', taskOwner: '', meta: '', ...fields };
}

/** The state as a short report: the goal, decisions, findings, tasks, and who said what last. */
export function formatState(state: CollabState) {
  const out: string[] = [];
  out.push(`goal       ${state.goal ? `${state.goal.content}  (${state.goal.by}, #${state.goal.seq})` : 'none yet (spacehub collab post --type goal <text>)'}`);
  const tasks = Object.values(state.tasks).sort((a, b) => a.created_seq - b.created_seq);
  out.push('', `tasks      ${tasks.length ? '' : 'none'}`);
  for (const t of tasks) out.push(`  ${t.id.padEnd(14)} ${t.status.padEnd(11)} ${(t.owner || 'unowned').padEnd(14)} ${t.title}`);
  for (const [label, notes] of [['decisions', state.decisions], ['findings', state.findings]] as const) {
    out.push('', `${label.padEnd(10)} ${notes.length ? '' : 'none'}`);
    for (const n of notes.slice(-10)) out.push(`  #${n.seq} ${n.by}: ${n.content.split('\n')[0]}`);
  }
  const people = Object.entries(state.participants).sort((a, b) => b[1].last_seq - a[1].last_seq);
  out.push('', `people     ${people.length ? '' : 'nobody has posted yet'}`);
  for (const [name, p] of people) out.push(`  ${name.padEnd(14)} ${p.kind === 'agent' ? `agent of ${p.user}` : 'builder'}  last #${p.last_seq}${p.status ? `  status: ${p.status}` : ''}`);
  out.push('', `log        ${state.seq} posts${state.archived.length ? `, ${state.archived.length} archived parts` : ''}`);
  return out.join('\n');
}
