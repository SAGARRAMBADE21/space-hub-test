// The project chat: one conversation per project that every collaborator,
// and every agent they bring, reads and writes. It lives in the project's
// default branch, so each clone (and each running agent) has it on disk:
//
//   collab/chat.json             the conversation file the app opens with a message box
//   collab/chat.log.jsonl        one line per post, in order (`seq`), attributed by the hub
//   collab/state.json            what the posts add up to: the goal, decisions, findings,
//                                tasks with their owners, and each participant's last word
//   collab/archive/*.log.jsonl   earlier parts of the log, moved aside as it grows
//
// Only the collab_post reducer writes collab/ (update_ref refuses pushes
// that change it), one post per transaction, so posts never race, the log
// is append-only and every line names who really sent it. state.json is the
// log folded by applyPost: agents read it to catch up without replaying
// the whole history, and the log stays the record.
//
// Pure functions, shared by the module (which writes), the CLI and the app.

export const COLLAB_DIR = 'collab';
export const CHAT_PATH = 'collab/chat.json';
export const LOG_PATH = 'collab/chat.log.jsonl';
export const STATE_PATH = 'collab/state.json';
export const ARCHIVE_DIR = 'collab/archive';

export const POST_KINDS = ['message', 'goal', 'decision', 'finding', 'status', 'task', 'handoff', 'join'] as const;
export type PostKind = (typeof POST_KINDS)[number];
export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const MAX_CONTENT = 4000;
const MAX_META = 2000;
const MAX_TO = 10;
const MAX_OPEN_TASKS = 200;
// Decisions, findings and closed tasks state.json keeps; older ones stay in the log.
const KEEP = 30;
// Post ids remembered for spotting a resent post.
const RECENT_IDS = 100;
// Every post rewrites the log's blob, so the log is moved to the archive
// (the same blob, nothing copied) once it passes this size.
export const ROTATE_BYTES = 64 * 1024;

const ID = /^[A-Za-z0-9-]{1,64}$/;
const TASK_ID = /^[A-Za-z0-9._-]{1,64}$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

export class CollabError extends Error {}

/** A post as a participant sends it; the hub adds who, when and the sequence number. */
export interface PostIn {
  id: string;
  kind: string;
  content: string;
  to: string[];
  replyTo: string;
  task: string;
  taskTitle: string;
  taskStatus: string;
  taskOwner: string;
  /** A JSON object as text, or "". */
  meta: string;
}

/** Who posts, as the hub knows them: a builder, or an agent and the builder (or org) it works for. */
export interface Author {
  name: string;
  kind: 'builder' | 'agent';
  user: string;
}

export interface TaskRef {
  id: string;
  title?: string;
  status?: string;
  owner?: string;
  from?: string;
}

/** One line of collab/chat.log.jsonl. `role` and `author` keep it an open-chat chat log. */
export interface CollabLine {
  seq: number;
  id: string;
  type: PostKind;
  role: 'user' | 'assistant';
  author: string;
  user: string;
  agent?: string;
  content: string;
  to?: string[];
  reply_to?: string;
  task?: TaskRef;
  meta?: Record<string, unknown>;
  time: string;
}

export interface Note {
  seq: number;
  id: string;
  by: string;
  content: string;
  time: string;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  owner: string;
  created_by: string;
  updated_by: string;
  created_seq: number;
  updated_seq: number;
  updated_at: string;
  note: string;
}

export interface Participant {
  kind: 'builder' | 'agent';
  user: string;
  last_seq: number;
  last_time: string;
  status: string;
}

export interface CollabState {
  schema: 1;
  seq: number;
  /** The first seq in collab/chat.log.jsonl; earlier ones are in `archived`. */
  first_seq: number;
  updated_at: string;
  goal: Note | null;
  decisions: Note[];
  findings: Note[];
  tasks: Record<string, Task>;
  participants: Record<string, Participant>;
  archived: string[];
  recent_ids: string[];
}

export function emptyState(): CollabState {
  return { schema: 1, seq: 0, first_seq: 1, updated_at: '', goal: null, decisions: [], findings: [], tasks: {}, participants: {}, archived: [], recent_ids: [] };
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** state.json as written by applyPost; anything else starts over from an empty state. */
export function parseState(text: string | null | undefined): CollabState {
  if (!text) return emptyState();
  try {
    const value = JSON.parse(text) as unknown;
    if (object(value) && value.schema === 1 && typeof value.seq === 'number') return { ...emptyState(), ...(value as Partial<CollabState>) } as CollabState;
  } catch {
    // fall through
  }
  return emptyState();
}

/** The lines of a log; lines that are not posts (or are cut short) are skipped. */
export function parseLog(text: string): CollabLine[] {
  const lines: CollabLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw) as unknown;
      if (object(value) && typeof value.seq === 'number' && typeof value.id === 'string' && typeof value.content === 'string') lines.push(value as unknown as CollabLine);
    } catch {
      // skip
    }
  }
  return lines;
}

export interface ApplyContext {
  /** ISO time of the post. */
  time: string;
  /** The poster owns the project's space: may change any task. */
  admin: boolean;
  /** Whether `name` may take part in the project (and so own a task). */
  isParticipant: (name: string) => boolean;
}

function keep<T>(list: T[], item: T, n = KEEP) {
  return [...list, item].slice(-n);
}

function check(post: PostIn) {
  if (!ID.test(post.id)) throw new CollabError('A post needs an id of 1 to 64 letters, digits and hyphens.');
  if (!(POST_KINDS as readonly string[]).includes(post.kind)) throw new CollabError(`A post is one of: ${POST_KINDS.join(', ')}.`);
  if (post.content.length > MAX_CONTENT) throw new CollabError(`A post has at most ${MAX_CONTENT} characters.`);
  if (!post.content.trim() && post.kind !== 'join' && post.kind !== 'task') throw new CollabError(`A ${post.kind} needs some text.`);
  if (post.to.length > MAX_TO || post.to.some(name => !NAME.test(name))) throw new CollabError(`"to" names up to ${MAX_TO} builders or agents.`);
  if (post.replyTo && !ID.test(post.replyTo)) throw new CollabError('reply_to is the id of another post.');
  if (post.task && !TASK_ID.test(post.task)) throw new CollabError('A task id is 1 to 64 letters, digits, dots, hyphens or underscores.');
  if (post.taskTitle.length > 200) throw new CollabError('A task title has at most 200 characters.');
  if (post.taskStatus && !(TASK_STATUSES as readonly string[]).includes(post.taskStatus)) throw new CollabError(`A task is ${TASK_STATUSES.join(', ')}.`);
  if (post.taskOwner && !NAME.test(post.taskOwner)) throw new CollabError('A task owner is a builder or an agent.');
  if (post.meta.length > MAX_META) throw new CollabError(`meta has at most ${MAX_META} characters.`);
}

function parseMeta(meta: string): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(meta);
  } catch {
    throw new CollabError('meta is a JSON object.');
  }
  if (!object(value)) throw new CollabError('meta is a JSON object.');
  return value;
}

/**
 * Fold one post into the state and make its log line. Returns null for a
 * post already applied (the same id sent again, say after a reconnect), so
 * resending is safe. Throws CollabError when the post breaks a rule.
 */
export function applyPost(before: CollabState, post: PostIn, author: Author, at: ApplyContext): { state: CollabState; line: CollabLine } | null {
  check(post);
  if (before.recent_ids.includes(post.id)) return null;
  const meta = parseMeta(post.meta);
  const seq = before.seq + 1;
  const state: CollabState = { ...before, seq, updated_at: at.time, tasks: { ...before.tasks }, participants: { ...before.participants }, recent_ids: keep(before.recent_ids, post.id, RECENT_IDS) };
  const kind = post.kind as PostKind;
  const content = post.content.trim();
  const note: Note = { seq, id: post.id, by: author.name, content, time: at.time };
  let task: TaskRef | undefined;

  if (kind === 'goal') state.goal = note;
  if (kind === 'decision') state.decisions = keep(before.decisions, note);
  if (kind === 'finding') state.findings = keep(before.findings, note);
  if (kind === 'task' || kind === 'handoff') task = applyTask(state, post, author, at, seq, content);
  else if (post.task) {
    if (!state.tasks[post.task]) throw new CollabError(`There is no open task "${post.task}".`);
    task = { id: post.task };
  }

  const previous = before.participants[author.name];
  state.participants[author.name] = {
    kind: author.kind,
    user: author.user,
    last_seq: seq,
    last_time: at.time,
    status: kind === 'status' ? content.slice(0, 300) : previous?.status ?? '',
  };

  const line: CollabLine = {
    seq,
    id: post.id,
    type: kind,
    role: author.kind === 'agent' ? 'assistant' : 'user',
    author: author.name,
    user: author.user,
    ...(author.kind === 'agent' ? { agent: author.name } : {}),
    content,
    ...(post.to.length ? { to: [...new Set(post.to)] } : {}),
    ...(post.replyTo ? { reply_to: post.replyTo } : {}),
    ...(task ? { task } : {}),
    ...(meta ? { meta } : {}),
    time: at.time,
  };
  return { state, line };
}

// A task is opened by anyone taking part. Its owner, whoever opened it and
// the project's owners change it; anyone may claim one nobody owns.
function applyTask(state: CollabState, post: PostIn, author: Author, at: ApplyContext, seq: number, content: string): TaskRef {
  if (!post.task) throw new CollabError(`A ${post.kind} names its task.`);
  const existing = state.tasks[post.task];
  const owner = post.taskOwner;
  if (owner && !at.isParticipant(owner)) throw new CollabError(`${owner} does not take part in this project, so cannot own a task in it.`);

  if (!existing) {
    if (post.kind === 'handoff') throw new CollabError(`There is no task "${post.task}" to hand off.`);
    const open = Object.values(state.tasks).filter(t => t.status !== 'done' && t.status !== 'cancelled').length;
    if (open >= MAX_OPEN_TASKS) throw new CollabError(`This project has ${MAX_OPEN_TASKS} open tasks; close some first.`);
    const title = (post.taskTitle || content.split('\n')[0]).trim().slice(0, 200);
    if (!title) throw new CollabError('A new task needs a title.');
    const created: Task = {
      id: post.task,
      title,
      status: (post.taskStatus || 'open') as TaskStatus,
      owner,
      created_by: author.name,
      updated_by: author.name,
      created_seq: seq,
      updated_seq: seq,
      updated_at: at.time,
      note: content.slice(0, 500),
    };
    state.tasks[post.task] = created;
    return { id: created.id, title: created.title, status: created.status, ...(owner ? { owner } : {}) };
  }

  const claim = !existing.owner && owner === author.name && post.kind === 'task';
  const allowed = at.admin || author.name === existing.owner || author.name === existing.created_by || claim;
  if (!allowed) {
    const who = [existing.owner && `${existing.owner} (its owner)`, `${existing.created_by} (who opened it)`, "the project's owners"].filter(Boolean).join(', ');
    throw new CollabError(`Only ${who} change task "${existing.id}".`);
  }
  if (post.kind === 'handoff' && (!owner || owner === existing.owner)) throw new CollabError('A handoff names the new owner.');
  const next: Task = {
    ...existing,
    title: post.taskTitle.trim() || existing.title,
    status: (post.taskStatus || (post.kind === 'handoff' ? 'open' : existing.status)) as TaskStatus,
    owner: owner || existing.owner,
    updated_by: author.name,
    updated_seq: seq,
    updated_at: at.time,
    note: content ? content.slice(0, 500) : existing.note,
  };
  state.tasks[existing.id] = next;
  // Closed tasks beyond the last few leave the state; the log keeps them.
  const closed = Object.values(state.tasks).filter(t => t.status === 'done' || t.status === 'cancelled').sort((a, b) => a.updated_seq - b.updated_seq);
  for (const t of closed.slice(0, Math.max(0, closed.length - KEEP))) delete state.tasks[t.id];
  return {
    id: next.id,
    ...(next.title !== existing.title ? { title: next.title } : {}),
    status: next.status,
    ...(next.owner ? { owner: next.owner } : {}),
    ...(post.kind === 'handoff' && existing.owner ? { from: existing.owner } : {}),
  };
}

export function lineText(line: CollabLine) {
  return JSON.stringify(line) + '\n';
}

export function archivePath(firstSeq: number, lastSeq: number) {
  const pad = (n: number) => String(n).padStart(6, '0');
  return `${ARCHIVE_DIR}/chat.${pad(firstSeq)}-${pad(lastSeq)}.log.jsonl`;
}

/**
 * The files one post writes, given the log as it is: the log with the new
 * line (moved to the archive first once it is big), and the state, which
 * is returned too since moving the log changes it.
 */
export function postFiles(log: string, before: CollabState, applied: { state: CollabState; line: CollabLine }): { files: Record<string, string>; state: CollabState; moved: { from: string; to: string } | null } {
  const state = { ...applied.state };
  let current = log && !log.endsWith('\n') ? log + '\n' : log;
  let moved: { from: string; to: string } | null = null;
  if (current && current.length >= ROTATE_BYTES) {
    const to = archivePath(before.first_seq, before.seq);
    moved = { from: LOG_PATH, to };
    state.archived = [...before.archived, to].slice(-100);
    state.first_seq = applied.line.seq;
    current = '';
  }
  return { files: { [LOG_PATH]: current + lineText(applied.line), [STATE_PATH]: JSON.stringify(state, null, 2) + '\n' }, state, moved };
}

export const CHAT_FILE = JSON.stringify({ type: 'conversation', title: 'Project chat', messages: [] }, null, 2) + '\n';

/** A short, readable form of one line, for terminals and agents' prompts. */
export function formatLine(line: CollabLine) {
  const who = line.agent ? `${line.agent} (for ${line.user})` : line.author;
  const to = line.to?.length ? ` → ${line.to.join(', ')}` : '';
  const task = line.task ? ` [task ${line.task.id}${line.task.status ? ` ${line.task.status}` : ''}${line.task.owner ? ` @${line.task.owner}` : ''}]` : '';
  const kind = line.type === 'message' ? '' : ` ${line.type}`;
  return `#${line.seq} ${line.time.slice(0, 19).replace('T', ' ')} ${who}${kind}${to}${task}: ${line.content || line.task?.title || ''}`.trimEnd();
}
