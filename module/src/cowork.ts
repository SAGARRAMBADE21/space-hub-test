// The cowork chat: where every collaborator's own Cowork (their local AI
// workspace: its agents, tools and settings) meets the others on one
// project. It sits beside the project chat in collab/ and leaves it as it is:
//
//   collab/chat.json, chat.log.jsonl, state.json   the project chat (collab.ts), unchanged
//   collab/cowork.chat.json                        the conversation file the app opens
//   collab/cowork.chat.log.jsonl                   one envelope per line, in order (`seq`)
//   collab/cowork.state.json                       the envelopes folded: connected coworks,
//                                                  their agents and heads, delegations,
//                                                  shared context, the last syncs
//   collab/archive/cowork.chat.*.log.jsonl         earlier parts of the log
//
// Coworks are never wired to each other. Each one only posts envelopes
// through the cowork_post reducer and reads this folder (from its clone or
// from the hub), so they stay independent: any Cowork that speaks these
// envelopes can join, leave or crash without the others noticing more than
// a status line. Nothing here runs anything; a delegation is an offer the
// target's owner accepts or declines in their own workspace.
//
// Identity: the hub signs every envelope with who sent it (a builder, or a
// hub agent and the builder it works for). A cowork id is claimed by the
// builder who first connects it, and only that builder (or agents working
// for them) can post as it; its local agents are the names it declared on
// connect. So the address `laptop:claude_code` means "the claude_code agent
// in the cowork `laptop`, which belongs to sagar", and nobody else can send
// as it.
//
// Pure functions, shared by the module (which writes), the CLI and scripts.

// No imports, so the CLI (run with node's type stripping) can load it as it is.
const COLLAB_DIR = 'collab'; // collab.ts's COLLAB_DIR
const ARCHIVE_DIR = 'collab/archive'; // collab.ts's ARCHIVE_DIR

export const COWORK_CHAT_PATH = `${COLLAB_DIR}/cowork.chat.json`;
export const COWORK_LOG_PATH = `${COLLAB_DIR}/cowork.chat.log.jsonl`;
export const COWORK_STATE_PATH = `${COLLAB_DIR}/cowork.state.json`;

export const COWORK_KINDS = [
  'connect', // join (or rejoin) with agents and a policy
  'disconnect', // leave; the record stays, marked offline
  'status', // what this cowork is doing now
  'message', // chat, people and agents alike
  'request', // ask someone for information; answered by a response
  'response', // an answer, replying to a request
  'delegate', // offer a piece of work to one cowork (or one of its agents)
  'accept', // the target takes it
  'decline', // the target refuses it
  'progress', // the target reports along the way
  'result', // the target finishes it: done or failed
  'cancel', // whoever offered it takes it back
  'sync', // "my branch moved": branch, commit, paths changed
  'context', // shared knowledge under a key, for every cowork
] as const;
export type CoworkKind = (typeof COWORK_KINDS)[number];

/** What a cowork can say it takes from others; messages always reach it. */
export const ACCEPTS = ['request', 'delegate'] as const;
export const DELEGATION_STATUSES = ['offered', 'accepted', 'in_progress', 'done', 'failed', 'declined', 'cancelled'] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];
const FINAL: readonly string[] = ['done', 'failed', 'declined', 'cancelled'];

export const MAX_CONTENT = 4000;
const MAX_META = 4000;
const MAX_TO = 10;
const MAX_COWORKS = 50;
const MAX_AGENTS = 16;
const MAX_OPEN_DELEGATIONS = 200;
const MAX_CONTEXT = 100;
const MAX_PATHS = 200;
const KEEP = 30;
const RECENT_IDS = 100;
export const ROTATE_BYTES = 64 * 1024;

const ID = /^[A-Za-z0-9-]{1,64}$/;
const WORK_ID = /^[A-Za-z0-9._-]{1,64}$/;
export const COWORK_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const AGENT_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;
const BUILDER = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const KEY = /^[a-z0-9][a-z0-9._/-]{0,79}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<!\/)$/;

export class CoworkError extends Error {}

/** An envelope as a cowork sends it; the hub adds who, when and the sequence number. */
export interface CoworkPostIn {
  id: string;
  kind: string;
  /** The sending cowork ("" for a person writing from the app or a terminal). */
  cowork: string;
  /** The sending agent inside that cowork ("" for the cowork itself or its person). */
  agent: string;
  content: string;
  /** Addresses: `<cowork>`, `<cowork>:<agent>`, `@<builder>` or `*`. */
  to: string[];
  replyTo: string;
  /** The delegation an envelope opens or moves. */
  delegation: string;
  title: string;
  /** progress: a short status; result: done or failed. */
  status: string;
  /** context: the key it writes. */
  key: string;
  /** A JSON object as text, or "". */
  meta: string;
}

/** Who sends, as the hub knows them (collab.ts's Author). */
export interface CoworkAuthor {
  name: string;
  kind: 'builder' | 'agent';
  /** The builder: themselves, or whom an agent works for. */
  user: string;
}

export interface CoworkAgent {
  name: string;
  role: string;
  skills: string[];
}

export interface Head {
  branch: string;
  commit: string;
  seq: number;
  time: string;
  summary: string;
}

export interface Cowork {
  id: string;
  /** The builder it belongs to: only they (and agents working for them) post as it. */
  owner: string;
  /** Who sent its last connect. */
  connected_by: string;
  connected: boolean;
  client: string;
  agents: CoworkAgent[];
  accepts: string[];
  /** Who may delegate to it: "project" (anyone on it), "owners" (the project's owners), or builders. */
  delegators: 'project' | 'owners' | string[];
  /** The branch its work lands on, so its in-flight changes never collide with anyone else's. */
  branch: string;
  status: string;
  head: Head | null;
  connected_seq: number;
  last_seq: number;
  last_time: string;
}

export interface Delegation {
  id: string;
  title: string;
  /** The address that offered it, and the builder behind it. */
  from: string;
  from_user: string;
  /** The address it went to: a cowork, or one agent in it. */
  to: string;
  cowork: string;
  status: DelegationStatus;
  /** A task in the project chat it works on, when there is one. */
  collab_task: string;
  created_seq: number;
  updated_seq: number;
  updated_at: string;
  note: string;
  result: { commit?: string; branch?: string; paths?: string[] } | null;
}

export interface ContextEntry {
  key: string;
  content: string;
  by: string;
  seq: number;
  time: string;
}

export interface CoworkState {
  schema: 1;
  seq: number;
  first_seq: number;
  updated_at: string;
  coworks: Record<string, Cowork>;
  delegations: Record<string, Delegation>;
  context: Record<string, ContextEntry>;
  syncs: (Head & { cowork: string })[];
  /** Everyone who has sent, by hub name: their last envelope. */
  participants: Record<string, { kind: 'builder' | 'agent'; user: string; last_seq: number; last_time: string }>;
  archived: string[];
  recent_ids: string[];
}

export function emptyCoworkState(): CoworkState {
  return { schema: 1, seq: 0, first_seq: 1, updated_at: '', coworks: {}, delegations: {}, context: {}, syncs: [], participants: {}, archived: [], recent_ids: [] };
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string');

export function parseCoworkState(text: string | null | undefined): CoworkState {
  if (!text) return emptyCoworkState();
  try {
    const value = JSON.parse(text) as unknown;
    if (object(value) && value.schema === 1 && typeof value.seq === 'number') return { ...emptyCoworkState(), ...(value as Partial<CoworkState>) } as CoworkState;
  } catch {
    // fall through
  }
  return emptyCoworkState();
}

/** A delegation as one log line carries it. */
export interface DelegationRef {
  id: string;
  title?: string;
  status: DelegationStatus;
  to?: string;
  collab_task?: string;
}

/** One line of collab/cowork.chat.log.jsonl. `role`, `author` and `content` keep it an open-chat log. */
export interface CoworkLine {
  seq: number;
  id: string;
  type: CoworkKind;
  role: 'user' | 'assistant';
  /** Who signed it on the hub. */
  author: string;
  user: string;
  cowork?: string;
  agent?: string;
  /** Its address: `<cowork>:<agent>`, `<cowork>`, or the person's name. */
  from: string;
  content: string;
  to?: string[];
  reply_to?: string;
  delegation?: DelegationRef;
  sync?: Head;
  key?: string;
  meta?: Record<string, unknown>;
  time: string;
}

export function parseCoworkLog(text: string): CoworkLine[] {
  const lines: CoworkLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw) as unknown;
      if (object(value) && typeof value.seq === 'number' && typeof value.id === 'string' && typeof value.from === 'string') lines.push(value as unknown as CoworkLine);
    } catch {
      // skip
    }
  }
  return lines;
}

/** `<cowork>:<agent>` → its parts; null when it is not a cowork address. */
export function parseAddress(address: string): { cowork: string; agent: string } | null {
  const [cowork, agent = '', extra] = address.split(':');
  if (extra !== undefined || !COWORK_ID.test(cowork) || (agent && !AGENT_NAME.test(agent))) return null;
  return { cowork, agent };
}

function validAddress(address: string) {
  return address === '*' || (address.startsWith('@') && BUILDER.test(address.slice(1))) || parseAddress(address) !== null;
}

export function addressOf(cowork: string, agent: string, fallback: string) {
  return cowork ? (agent ? `${cowork}:${agent}` : cowork) : fallback;
}

/** Whether a line is meant for a cowork (or one of its agents) owned by `user`. */
export function addressedTo(line: CoworkLine, cowork: string, user: string) {
  if (line.cowork === cowork) return false;
  if (line.delegation && parseAddress(line.delegation.to ?? '')?.cowork === cowork) return true;
  return (line.to ?? []).some(to => to === '*' || to === `@${user}` || parseAddress(to)?.cowork === cowork);
}

export interface CoworkContext {
  time: string;
  /** The sender owns the project's space. */
  admin: boolean;
  /** Whether a builder takes part in the project. */
  isParticipant: (name: string) => boolean;
  /** Whether a builder owns the project's space. */
  isOwner: (name: string) => boolean;
  /** Whether a commit is stored in the project, so others can fetch it. */
  hasCommit: (oid: string) => boolean;
}

function keep<T>(list: T[], item: T, n = KEEP) {
  return [...list, item].slice(-n);
}

function check(post: CoworkPostIn) {
  if (!ID.test(post.id)) throw new CoworkError('An envelope needs an id of 1 to 64 letters, digits and hyphens.');
  if (!(COWORK_KINDS as readonly string[]).includes(post.kind)) throw new CoworkError(`An envelope is one of: ${COWORK_KINDS.join(', ')}.`);
  if (post.cowork && !COWORK_ID.test(post.cowork)) throw new CoworkError('A cowork id is 1 to 40 lowercase letters, digits and hyphens.');
  if (post.agent && !AGENT_NAME.test(post.agent)) throw new CoworkError('An agent name is 1 to 40 lowercase letters, digits, hyphens and underscores.');
  if (post.agent && !post.cowork) throw new CoworkError('An agent speaks from its cowork: name the cowork too.');
  if (post.content.length > MAX_CONTENT) throw new CoworkError(`An envelope has at most ${MAX_CONTENT} characters.`);
  if (post.to.length > MAX_TO || post.to.some(to => !validAddress(to))) throw new CoworkError(`"to" names up to ${MAX_TO} addresses: <cowork>, <cowork>:<agent>, @<builder> or *.`);
  if (post.replyTo && !ID.test(post.replyTo)) throw new CoworkError('reply_to is the id of another envelope.');
  if (post.delegation && !WORK_ID.test(post.delegation)) throw new CoworkError('A delegation id is 1 to 64 letters, digits, dots, hyphens or underscores.');
  if (post.title.length > 200) throw new CoworkError('A title has at most 200 characters.');
  if (post.status.length > 300) throw new CoworkError('A status has at most 300 characters.');
  if (post.key && !KEY.test(post.key)) throw new CoworkError('A context key is 1 to 80 lowercase letters, digits, dots, slashes, hyphens and underscores.');
  if (post.meta.length > MAX_META) throw new CoworkError(`meta has at most ${MAX_META} characters.`);
}

function parseMeta(meta: string): Record<string, unknown> {
  if (!meta) return {};
  let value: unknown;
  try {
    value = JSON.parse(meta);
  } catch {
    throw new CoworkError('meta is a JSON object.');
  }
  if (!object(value)) throw new CoworkError('meta is a JSON object.');
  return value;
}

function parseAgents(value: unknown): CoworkAgent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_AGENTS) throw new CoworkError(`agents is a list of up to ${MAX_AGENTS} agents.`);
  const agents = value.map(item => {
    const agent = typeof item === 'string' ? { name: item } : item;
    if (!object(agent) || typeof agent.name !== 'string' || !AGENT_NAME.test(agent.name)) throw new CoworkError('Each agent has a name of lowercase letters, digits, hyphens and underscores.');
    const role = typeof agent.role === 'string' ? agent.role.slice(0, 200) : '';
    const skills = strings(agent.skills) ? agent.skills.slice(0, 20).map(s => s.slice(0, 60)) : [];
    return { name: agent.name, role, skills };
  });
  if (new Set(agents.map(a => a.name)).size !== agents.length) throw new CoworkError('Each agent is named once.');
  return agents;
}

function parseDelegators(value: unknown): Cowork['delegators'] {
  if (value === undefined || value === 'project') return 'project';
  if (value === 'owners') return 'owners';
  if (strings(value) && value.length <= 50 && value.every(name => BUILDER.test(name))) return [...new Set(value)];
  throw new CoworkError('delegators is "project", "owners" or a list of builders.');
}

function parsePaths(value: unknown) {
  if (value === undefined) return undefined;
  if (!strings(value)) throw new CoworkError('paths is a list of file paths.');
  return value.slice(0, MAX_PATHS).map(p => p.slice(0, 300));
}

// The cowork the sender speaks as: it exists, is online and is theirs.
function ownCowork(state: CoworkState, post: CoworkPostIn, author: CoworkAuthor): Cowork {
  const cowork = state.coworks[post.cowork];
  if (!cowork) throw new CoworkError(`There is no cowork "${post.cowork}" here; connect it first (spacehub cowork connect ${post.cowork}).`);
  if (cowork.owner !== author.user) throw new CoworkError(`The cowork "${cowork.id}" belongs to ${cowork.owner}; only they and their agents speak as it.`);
  if (!cowork.connected) throw new CoworkError(`The cowork "${cowork.id}" is disconnected; connect it again first.`);
  if (post.agent && !cowork.agents.some(a => a.name === post.agent)) throw new CoworkError(`"${cowork.id}" has no agent "${post.agent}"; list it when you connect.`);
  return cowork;
}

function mayDelegate(target: Cowork, user: string, at: CoworkContext) {
  if (user === target.owner || at.isOwner(user)) return true;
  if (target.delegators === 'project') return true;
  if (target.delegators === 'owners') return false;
  return target.delegators.includes(user);
}

/**
 * Fold one envelope into the state and make its log line. Returns null for
 * an envelope already applied (its id seen), so resending is safe. Throws
 * CoworkError when it breaks a rule.
 */
export function applyCoworkPost(before: CoworkState, post: CoworkPostIn, author: CoworkAuthor, at: CoworkContext): { state: CoworkState; line: CoworkLine } | null {
  check(post);
  if (before.recent_ids.includes(post.id)) return null;
  const meta = parseMeta(post.meta);
  const seq = before.seq + 1;
  const kind = post.kind as CoworkKind;
  const content = post.content.trim();
  const state: CoworkState = {
    ...before,
    seq,
    updated_at: at.time,
    coworks: { ...before.coworks },
    delegations: { ...before.delegations },
    context: { ...before.context },
    participants: { ...before.participants },
    recent_ids: keep(before.recent_ids, post.id, RECENT_IDS),
  };
  const from = addressOf(post.cowork, post.agent, author.name);
  const line: Partial<CoworkLine> = {};
  let lineMeta: Record<string, unknown> | undefined = Object.keys(meta).length ? meta : undefined;

  const needsCowork = !['message', 'request', 'response', 'delegate', 'cancel', 'context', 'disconnect'].includes(kind);
  if (needsCowork && !post.cowork) throw new CoworkError(`A ${kind} comes from a cowork: name it (--cowork).`);

  if (kind === 'connect') {
    const existing = before.coworks[post.cowork];
    if (existing && existing.owner !== author.user) throw new CoworkError(`The cowork id "${post.cowork}" belongs to ${existing.owner}; pick another.`);
    if (!existing && Object.keys(before.coworks).length >= MAX_COWORKS) {
      // Make room by forgetting the longest-offline cowork.
      const offline = Object.values(before.coworks).filter(c => !c.connected).sort((a, b) => a.last_seq - b.last_seq)[0];
      if (!offline) throw new CoworkError(`This project has ${MAX_COWORKS} coworks connected.`);
      delete state.coworks[offline.id];
    }
    const agents = meta.agents === undefined ? existing?.agents ?? [] : parseAgents(meta.agents);
    if (post.agent && !agents.some(a => a.name === post.agent)) throw new CoworkError(`"${post.agent}" is not one of the agents this connect lists.`);
    const accepts = meta.accepts === undefined ? existing?.accepts ?? [...ACCEPTS] : meta.accepts;
    if (!strings(accepts) || accepts.some(a => !(ACCEPTS as readonly string[]).includes(a))) throw new CoworkError(`accepts lists any of: ${ACCEPTS.join(', ')}.`);
    const branch = typeof meta.branch === 'string' ? meta.branch : existing?.branch ?? `cowork/${post.cowork}`;
    if (!BRANCH.test(branch)) throw new CoworkError('branch is a git branch name.');
    state.coworks[post.cowork] = {
      id: post.cowork,
      owner: author.user,
      connected_by: author.name,
      connected: true,
      client: typeof meta.client === 'string' ? meta.client.slice(0, 100) : existing?.client ?? '',
      agents,
      accepts: [...new Set(accepts)],
      delegators: meta.delegators === undefined ? existing?.delegators ?? 'project' : parseDelegators(meta.delegators),
      branch,
      status: content.slice(0, 300) || existing?.status || '',
      head: existing?.head ?? null,
      connected_seq: seq,
      last_seq: seq,
      last_time: at.time,
    };
  } else if (kind === 'disconnect') {
    const cowork = before.coworks[post.cowork];
    if (!cowork) throw new CoworkError(`There is no cowork "${post.cowork}" here.`);
    if (cowork.owner !== author.user && !at.admin) throw new CoworkError(`Only ${cowork.owner} or the project's owners disconnect "${cowork.id}".`);
    state.coworks[cowork.id] = { ...cowork, connected: false, status: content.slice(0, 300) || 'disconnected', last_seq: seq, last_time: at.time };
  } else {
    const me = post.cowork ? ownCowork(before, post, author) : null;
    if (me) state.coworks[me.id] = { ...me, last_seq: seq, last_time: at.time };

    if (kind === 'status') {
      if (!content) throw new CoworkError('A status needs some text.');
      state.coworks[me!.id] = { ...state.coworks[me!.id], status: content.slice(0, 300) };
    }
    if (kind === 'message' && !content) throw new CoworkError('A message needs some text.');
    if (kind === 'request') {
      if (!content) throw new CoworkError('A request needs a question.');
      if (!post.to.length) throw new CoworkError('A request names whom it asks (--to).');
      for (const to of post.to) {
        const target = parseAddress(to);
        const cowork = target && before.coworks[target.cowork];
        if (target && !cowork) throw new CoworkError(`There is no cowork "${target.cowork}" here.`);
        if (cowork && !cowork.accepts.includes('request')) throw new CoworkError(`"${cowork.id}" does not take requests.`);
      }
    }
    if (kind === 'response') {
      if (!post.replyTo) throw new CoworkError('A response replies to a request (reply_to).');
      if (!content) throw new CoworkError('A response needs an answer.');
    }
    if (kind === 'context') {
      if (!post.key) throw new CoworkError('A context entry has a key.');
      if (!content) delete state.context[post.key];
      else {
        if (!before.context[post.key] && Object.keys(before.context).length >= MAX_CONTEXT) throw new CoworkError(`The shared context holds ${MAX_CONTEXT} keys; clear one first.`);
        state.context[post.key] = { key: post.key, content, by: from, seq, time: at.time };
      }
      line.key = post.key;
    }
    if (kind === 'sync') {
      const branch = typeof meta.branch === 'string' ? meta.branch : me!.branch;
      const commit = typeof meta.commit === 'string' ? meta.commit : '';
      if (!BRANCH.test(branch)) throw new CoworkError('A sync names its branch.');
      if (!COMMIT.test(commit)) throw new CoworkError('A sync names its commit (40 hex digits).');
      if (!at.hasCommit(commit)) throw new CoworkError(`The commit ${commit.slice(0, 12)} is not on the hub; push it before announcing it.`);
      const paths = parsePaths(meta.paths);
      const head: Head = { branch, commit, seq, time: at.time, summary: content.slice(0, 300) };
      state.coworks[me!.id] = { ...state.coworks[me!.id], head };
      state.syncs = keep(before.syncs, { ...head, cowork: me!.id });
      line.sync = head;
      lineMeta = { ...meta, branch, commit, ...(paths ? { paths } : {}) };
    }
    if (['delegate', 'accept', 'decline', 'progress', 'result', 'cancel'].includes(kind)) {
      line.delegation = applyDelegation(state, before, post, author, at, { kind, content, from, meta, seq, me });
    }
  }

  state.participants[author.name] = { kind: author.kind, user: author.user, last_seq: seq, last_time: at.time };

  const full: CoworkLine = {
    seq,
    id: post.id,
    type: kind,
    role: author.kind === 'agent' || post.agent ? 'assistant' : 'user',
    author: author.name,
    user: author.user,
    ...(post.cowork ? { cowork: post.cowork } : {}),
    ...(post.agent ? { agent: post.agent } : {}),
    from,
    content,
    ...(post.to.length ? { to: [...new Set(post.to)] } : {}),
    ...(post.replyTo ? { reply_to: post.replyTo } : {}),
    ...line,
    ...(lineMeta ? { meta: lineMeta } : {}),
    time: at.time,
  };
  return { state, line: full };
}

function applyDelegation(
  state: CoworkState,
  before: CoworkState,
  post: CoworkPostIn,
  author: CoworkAuthor,
  at: CoworkContext,
  { kind, content, from, meta, seq, me }: { kind: CoworkKind; content: string; from: string; meta: Record<string, unknown>; seq: number; me: Cowork | null }
): DelegationRef {
  if (!post.delegation) throw new CoworkError(`A ${kind} names its delegation.`);
  const existing = before.delegations[post.delegation];

  if (kind === 'delegate') {
    if (existing) throw new CoworkError(`There already is a delegation "${post.delegation}"; pick another id.`);
    if (post.to.length !== 1) throw new CoworkError('A delegation goes to one cowork, or one agent in it (--to).');
    const target = parseAddress(post.to[0]);
    if (!target) throw new CoworkError('A delegation goes to <cowork> or <cowork>:<agent>.');
    const cowork = before.coworks[target.cowork];
    if (!cowork) throw new CoworkError(`There is no cowork "${target.cowork}" here.`);
    if (!cowork.connected) throw new CoworkError(`"${cowork.id}" is disconnected, so cannot take work now.`);
    if (target.agent && !cowork.agents.some(a => a.name === target.agent)) throw new CoworkError(`"${cowork.id}" has no agent "${target.agent}".`);
    if (!cowork.accepts.includes('delegate')) throw new CoworkError(`"${cowork.id}" does not take delegated work.`);
    if (!mayDelegate(cowork, author.user, at)) throw new CoworkError(`${cowork.owner} only takes work for "${cowork.id}" from ${cowork.delegators === 'owners' ? "the project's owners" : (cowork.delegators as string[]).join(', ')}.`);
    const open = Object.values(before.delegations).filter(d => !FINAL.includes(d.status)).length;
    if (open >= MAX_OPEN_DELEGATIONS) throw new CoworkError(`This project has ${MAX_OPEN_DELEGATIONS} open delegations; close some first.`);
    const title = (post.title || content.split('\n')[0]).trim().slice(0, 200);
    if (!title) throw new CoworkError('A delegation needs a title.');
    const collabTask = typeof meta.collab_task === 'string' && WORK_ID.test(meta.collab_task) ? meta.collab_task : '';
    state.delegations[post.delegation] = {
      id: post.delegation,
      title,
      from,
      from_user: author.user,
      to: post.to[0],
      cowork: cowork.id,
      status: 'offered',
      collab_task: collabTask,
      created_seq: seq,
      updated_seq: seq,
      updated_at: at.time,
      note: content.slice(0, 1000),
      result: null,
    };
    return { id: post.delegation, title, status: 'offered', to: post.to[0], ...(collabTask ? { collab_task: collabTask } : {}) };
  }

  if (!existing) throw new CoworkError(`There is no delegation "${post.delegation}".`);
  if (FINAL.includes(existing.status)) throw new CoworkError(`"${existing.id}" is already ${existing.status}.`);
  let status: DelegationStatus = existing.status;
  let result = existing.result;

  if (kind === 'cancel') {
    if (existing.from_user !== author.user && !at.admin) throw new CoworkError(`Only ${existing.from_user} (who offered it) or the project's owners cancel "${existing.id}".`);
    status = 'cancelled';
  } else {
    // accept, decline, progress and result come from the cowork it went to.
    if (!me || me.id !== existing.cowork) throw new CoworkError(`Only the cowork "${existing.cowork}" answers "${existing.id}" (--cowork ${existing.cowork}).`);
    if (kind === 'accept' || kind === 'decline') {
      if (existing.status !== 'offered') throw new CoworkError(`"${existing.id}" is ${existing.status}, not offered.`);
      status = kind === 'accept' ? 'accepted' : 'declined';
    }
    if (kind === 'progress') {
      if (existing.status === 'offered') throw new CoworkError(`Accept "${existing.id}" before reporting on it.`);
      status = 'in_progress';
    }
    if (kind === 'result') {
      const outcome = post.status || 'done';
      if (outcome !== 'done' && outcome !== 'failed') throw new CoworkError('A result is done or failed (--status).');
      if (!content) throw new CoworkError('A result says what came of it.');
      status = outcome;
      const commit = typeof meta.commit === 'string' ? meta.commit : undefined;
      if (commit !== undefined && (!COMMIT.test(commit) || !at.hasCommit(commit))) throw new CoworkError('A result\'s commit is a commit already pushed to the hub.');
      const branch = typeof meta.branch === 'string' ? meta.branch : undefined;
      if (branch !== undefined && !BRANCH.test(branch)) throw new CoworkError('A result\'s branch is a git branch name.');
      const paths = parsePaths(meta.paths);
      result = { ...(commit ? { commit } : {}), ...(branch ? { branch } : {}), ...(paths ? { paths } : {}) };
    }
  }

  state.delegations[existing.id] = { ...existing, status, result, updated_seq: seq, updated_at: at.time, note: content ? content.slice(0, 1000) : existing.note };
  // Closed delegations beyond the last few leave the state; the log keeps them.
  const closed = Object.values(state.delegations).filter(d => FINAL.includes(d.status)).sort((a, b) => a.updated_seq - b.updated_seq);
  for (const d of closed.slice(0, Math.max(0, closed.length - KEEP))) delete state.delegations[d.id];
  return { id: existing.id, status, to: existing.to };
}

export function coworkArchivePath(firstSeq: number, lastSeq: number) {
  const pad = (n: number) => String(n).padStart(6, '0');
  return `${ARCHIVE_DIR}/cowork.chat.${pad(firstSeq)}-${pad(lastSeq)}.log.jsonl`;
}

/** The files one envelope writes: the log (moved to the archive first once it is big) and the state. */
export function coworkPostFiles(log: string, before: CoworkState, applied: { state: CoworkState; line: CoworkLine }) {
  const state = { ...applied.state };
  let current = log && !log.endsWith('\n') ? log + '\n' : log;
  let moved: { from: string; to: string } | null = null;
  if (current && current.length >= ROTATE_BYTES) {
    const to = coworkArchivePath(before.first_seq, before.seq);
    moved = { from: COWORK_LOG_PATH, to };
    state.archived = [...before.archived, to].slice(-100);
    state.first_seq = applied.line.seq;
    current = '';
  }
  return { files: { [COWORK_LOG_PATH]: current + JSON.stringify(applied.line) + '\n', [COWORK_STATE_PATH]: JSON.stringify(state, null, 2) + '\n' }, state, moved };
}

export const COWORK_CHAT_FILE = JSON.stringify({ type: 'conversation', title: 'Cowork chat', messages: [] }, null, 2) + '\n';

// ---------------------------------------------------------------- threads
//
// A thread is a side conversation that grew out of the cowork chat (in XO
// Space, a thread its coordinator started). An envelope in one says so in
// meta.thread: {id, title?, state?, status?, outputs?}. The log keeps every
// envelope as before; cowork.chat.json also keeps one object per thread,
// under `threads`, with its title, state, checklist, outputs and messages,
// so each thread reads on its own.

export const MAX_THREADS = 50;
export const MAX_THREAD_MESSAGES = 200;
const THREAD_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

export interface CoworkThreadMeta { id: string; title: string; state: string; status: string; outputs: string[] | null }
export interface CoworkThreadMessage { seq: number; id: string; role: 'user' | 'assistant'; author: string; content: string; time: string; xo?: Record<string, unknown> }
export interface CoworkThread { id: string; title: string; state: string; status: string; outputs: string[]; first_seq: number; last_seq: number; updated: string; messages: CoworkThreadMessage[] }

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

/** The thread an envelope belongs to, from its meta, or null. */
export function threadMeta(meta: Record<string, unknown> | undefined): CoworkThreadMeta | null {
  const thread = meta && object(meta.thread) ? meta.thread : null;
  if (!thread || typeof thread.id !== 'string' || !THREAD_ID.test(thread.id)) return null;
  const outputs = Array.isArray(thread.outputs) ? thread.outputs.filter((o): o is string => typeof o === 'string').slice(0, 20).map(o => o.slice(0, 200)) : null;
  return { id: thread.id, title: text(thread.title, 200), state: text(thread.state, 40), status: text(thread.status, 2000), outputs };
}

/**
 * cowork.chat.json after `line`: the file itself when it is missing, and the
 * line's thread brought up to date when it has one. Null: nothing changes.
 * The most recent MAX_THREADS threads stay, each with its last MAX_THREAD_MESSAGES.
 */
export function coworkChatFile(current: string | null | undefined, line: CoworkLine): string | null {
  const thread = threadMeta(line.meta);
  if (current && !thread) return null;
  let chat: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = current ? JSON.parse(current) : null;
    if (object(parsed)) chat = parsed;
  } catch {
    /* A broken file is written fresh. */
  }
  chat ??= JSON.parse(COWORK_CHAT_FILE) as Record<string, unknown>;
  if (thread) {
    const threads: Record<string, CoworkThread> = object(chat.threads) ? (chat.threads as Record<string, CoworkThread>) : {};
    const old = object(threads[thread.id]) ? threads[thread.id] : undefined;
    const xo = line.meta && object(line.meta.xo) ? line.meta.xo : undefined;
    const message: CoworkThreadMessage = { seq: line.seq, id: line.id, role: line.role, author: line.author, content: line.content, time: line.time, ...(xo ? { xo } : {}) };
    threads[thread.id] = {
      id: thread.id,
      title: thread.title || old?.title || '',
      state: thread.state || old?.state || '',
      status: thread.status || old?.status || '',
      outputs: thread.outputs ?? old?.outputs ?? [],
      first_seq: old?.first_seq ?? line.seq,
      last_seq: line.seq,
      updated: line.time,
      messages: [...(Array.isArray(old?.messages) ? old.messages : []), message].slice(-MAX_THREAD_MESSAGES),
    };
    const kept = Object.values(threads).sort((a, b) => b.last_seq - a.last_seq).slice(0, MAX_THREADS);
    chat.threads = Object.fromEntries(kept.sort((a, b) => a.first_seq - b.first_seq).map(t => [t.id, t]));
  }
  return JSON.stringify(chat, null, 2) + '\n';
}

/** A short, readable form of one line, for terminals and agents' prompts. */
export function formatCoworkLine(line: CoworkLine) {
  const who = line.cowork ? `${line.from} (${line.user})` : line.from;
  const to = line.to?.length ? ` → ${line.to.join(', ')}` : '';
  const d = line.delegation ? ` [${line.delegation.id} ${line.delegation.status}${line.delegation.title ? `: ${line.delegation.title}` : ''}]` : '';
  const sync = line.sync ? ` [${line.sync.branch} @ ${line.sync.commit.slice(0, 10)}]` : '';
  const key = line.key ? ` [${line.key}]` : '';
  const kind = line.type === 'message' ? '' : ` ${line.type}`;
  return `#${line.seq} ${line.time.slice(0, 19).replace('T', ' ')} ${who}${kind}${to}${d}${sync}${key}: ${line.content}`.trimEnd();
}
