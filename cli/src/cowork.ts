// spacehub cowork: the cowork chat (module/src/cowork.ts) from a terminal,
// and the glue a Cowork (or any agent runtime) uses to join a project.
// Envelopes go through the cowork_post reducer; reads come from the default
// branch on the hub, so every cowork sees the same log and state.
//
// What stays on this machine: which cowork (and agent) you speak as for each
// project, and the last envelope your watcher handled, in
// ~/.spacehub/cowork/profiles.json. Nothing of a cowork's own setup (its
// tools, keys, memory or files outside the project) ever leaves it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COWORK_LOG_PATH, COWORK_STATE_PATH, parseCoworkLog, parseCoworkState, type CoworkLine, type CoworkPostIn, type CoworkState } from '../../module/src/cowork.ts';
import { STATE_PATH, parseState, type CollabState } from '../../module/src/collab.ts';
import { readFileAtCommit, type ObjectReader } from './collab.ts';

export { addressedTo, formatCoworkLine, COWORK_KINDS, type CoworkLine, type CoworkState } from '../../module/src/cowork.ts';

export interface CoworkChat {
  commit: string;
  state: CoworkState;
  lines: CoworkLine[];
  /** The project chat's state, for the shared goal, decisions and tasks. */
  project: CollabState;
}

export async function readCoworkChat(read: ObjectReader, commit: string): Promise<CoworkChat> {
  const [state, log, project] = await Promise.all([
    readFileAtCommit(read, commit, COWORK_STATE_PATH),
    readFileAtCommit(read, commit, COWORK_LOG_PATH),
    readFileAtCommit(read, commit, STATE_PATH),
  ]);
  return { commit, state: parseCoworkState(state), lines: parseCoworkLog(log ?? ''), project: parseState(project) };
}

/** Lines after `since`, from the archive too when the log was moved aside since then. */
export async function coworkLinesSince(read: ObjectReader, chat: CoworkChat, since: number): Promise<CoworkLine[]> {
  const older: CoworkLine[] = [];
  if (since + 1 < chat.state.first_seq) {
    for (const p of chat.state.archived) {
      const range = /cowork\.chat\.(\d+)-(\d+)\.log\.jsonl$/.exec(p);
      if (range && Number(range[2]) <= since) continue;
      older.push(...parseCoworkLog((await readFileAtCommit(read, chat.commit, p)) ?? ''));
    }
  }
  const seen = new Set<number>();
  return [...older, ...chat.lines].filter(line => line.seq > since && !seen.has(line.seq) && seen.add(line.seq)).sort((a, b) => a.seq - b.seq);
}

export function newEnvelope(fields: Partial<CoworkPostIn>): CoworkPostIn {
  return { id: crypto.randomUUID(), kind: 'message', cowork: '', agent: '', content: '', to: [], replyTo: '', delegation: '', title: '', status: '', key: '', meta: '', ...fields };
}

// ---------------------------------------------------------------- local profile

export interface Profile {
  cowork: string;
  agent: string;
  /** The last envelope this machine's watcher handled. */
  seen: number;
}

function profileFile() {
  const home = process.env.SPACEHUB_HOME ?? path.join(os.homedir(), '.spacehub');
  return path.join(home, 'cowork', 'profiles.json');
}

function loadProfiles(): Record<string, Profile> {
  try {
    const value = JSON.parse(fs.readFileSync(profileFile(), 'utf8')) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, Profile>) : {};
  } catch {
    return {};
  }
}

export function loadProfile(project: string): Profile | null {
  return loadProfiles()[project] ?? null;
}

export function saveProfile(project: string, profile: Partial<Profile> | null) {
  const all = loadProfiles();
  if (profile === null) delete all[project];
  else all[project] = { ...{ cowork: '', agent: '', seen: 0 }, ...all[project], ...profile };
  fs.mkdirSync(path.dirname(profileFile()), { recursive: true, mode: 0o700 });
  const tmp = `${profileFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, profileFile());
}

// ---------------------------------------------------------------- reports

const FINAL = ['done', 'failed', 'declined', 'cancelled'];

/** The state as a short report: coworks and their agents, delegations, syncs and context. */
export function formatCoworkState(state: CoworkState) {
  const out: string[] = [];
  const coworks = Object.values(state.coworks).sort((a, b) => Number(b.connected) - Number(a.connected) || a.id.localeCompare(b.id));
  out.push(`coworks    ${coworks.length ? '' : 'none connected yet (spacehub cowork connect <id>)'}`);
  for (const c of coworks) {
    out.push(`  ${c.id.padEnd(16)} ${(c.connected ? 'online' : 'offline').padEnd(8)} ${c.owner.padEnd(14)} ${c.branch}${c.head ? ` @ ${c.head.commit.slice(0, 10)}` : ''}${c.status ? `  status: ${c.status}` : ''}`);
    if (c.agents.length) out.push(`  ${''.padEnd(16)} agents: ${c.agents.map(a => (a.role ? `${a.name} (${a.role})` : a.name)).join(', ')}`);
  }
  const delegations = Object.values(state.delegations).sort((a, b) => a.created_seq - b.created_seq);
  const open = delegations.filter(d => !FINAL.includes(d.status));
  out.push('', `delegated  ${open.length ? '' : 'nothing open'}`);
  for (const d of open) out.push(`  ${d.id.padEnd(16)} ${d.status.padEnd(11)} ${d.from} → ${d.to}  ${d.title}`);
  out.push('', `syncs      ${state.syncs.length ? '' : 'none yet'}`);
  for (const s of state.syncs.slice(-5)) out.push(`  #${s.seq} ${s.cowork} ${s.branch} @ ${s.commit.slice(0, 10)}${s.summary ? `  ${s.summary}` : ''}`);
  const context = Object.values(state.context);
  out.push('', `context    ${context.length ? '' : 'nothing shared yet'}`);
  for (const c of context) out.push(`  ${c.key.padEnd(24)} ${c.by}: ${c.content.split('\n')[0].slice(0, 80)}`);
  out.push('', `log        ${state.seq} envelopes${state.archived.length ? `, ${state.archived.length} archived parts` : ''}`);
  return out.join('\n');
}

/**
 * One brief an agent reads before it acts: the project's goal, decisions
 * and tasks (from the project chat), who else is connected and with which
 * agents, what is waiting for this cowork, the shared context and the last
 * envelopes. Plain Markdown, so any runtime can put it in a prompt.
 */
export function briefing(project: string, chat: CoworkChat, me: { cowork: string; user: string }, recent: CoworkLine[]) {
  const { state, project: p } = chat;
  const out: string[] = [`# ${project}: shared context`, ''];
  out.push(`You are working in the cowork "${me.cowork}" of ${me.user}. Other collaborators' coworks are listed below; reach them through \`spacehub cowork\`, never by editing collab/.`, '');
  out.push('## Goal', p.goal ? `${p.goal.content} (set by ${p.goal.by})` : 'No goal posted yet.', '');
  if (p.decisions.length) out.push('## Decisions', ...p.decisions.slice(-15).map(d => `- ${d.content.split('\n')[0]} (${d.by}, #${d.seq})`), '');
  const tasks = Object.values(p.tasks).filter(t => t.status !== 'done' && t.status !== 'cancelled');
  if (tasks.length) out.push('## Project tasks', ...tasks.map(t => `- ${t.id} [${t.status}${t.owner ? `, ${t.owner}` : ''}] ${t.title}`), '');
  out.push('## Connected coworks');
  for (const c of Object.values(state.coworks).filter(c => c.connected)) {
    const agents = c.agents.map(a => (a.role ? `${a.name} (${a.role})` : a.name)).join(', ') || 'no agents listed';
    out.push(`- ${c.id}${c.id === me.cowork ? ' (you)' : ''}: ${c.owner}, agents ${agents}; works on ${c.branch}${c.head ? ` @ ${c.head.commit.slice(0, 10)}` : ''}${c.status ? `; now: ${c.status}` : ''}`);
  }
  out.push('');
  const mine = Object.values(state.delegations).filter(d => !FINAL.includes(d.status) && d.cowork === me.cowork);
  const theirs = Object.values(state.delegations).filter(d => !FINAL.includes(d.status) && d.from_user === me.user && d.cowork !== me.cowork);
  out.push('## Waiting for you', ...(mine.length ? mine.map(d => `- ${d.id} [${d.status}] from ${d.from}: ${d.title}${d.note && d.note !== d.title ? `\n  ${d.note.split('\n').join('\n  ')}` : ''}`) : ['Nothing.']), '');
  if (theirs.length) out.push('## You delegated', ...theirs.map(d => `- ${d.id} [${d.status}] to ${d.to}: ${d.title}`), '');
  const context = Object.values(state.context);
  if (context.length) out.push('## Shared context', ...context.map(c => `### ${c.key}\n${c.content}\n(by ${c.by}, #${c.seq})`), '');
  if (state.syncs.length) out.push('## Recent syncs', ...state.syncs.slice(-8).map(s => `- ${s.cowork} moved ${s.branch} to ${s.commit.slice(0, 10)}${s.summary ? `: ${s.summary}` : ''}`), '');
  if (recent.length) out.push('## Recent envelopes', ...recent.map(l => `- #${l.seq} ${l.from} ${l.type}${l.to?.length ? ` → ${l.to.join(', ')}` : ''}${l.delegation ? ` [${l.delegation.id} ${l.delegation.status}]` : ''}: ${l.content.split('\n')[0].slice(0, 200)}`), '');
  return out.join('\n');
}
