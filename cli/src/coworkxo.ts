// spacehub cowork xo: one conversation in two places. A project's cowork chat
// on the hub and the same project's chat in XO Space (the local Cowork app)
// carry each other's messages, and the XO Space project coordinator answers.
// Everything it posts on the hub is posted as you: no cowork is connected.
//
// Only a project that exists on the hub can be linked: the cowork chat lives
// in its collab/ folder.
//
// What stays on this machine: how far each side has been read, and the ids
// this machine wrote on each side (so nothing is copied back to where it came
// from), in ~/.spacehub/cowork/xo-links.json.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_CONTENT, type CoworkLine } from '../../module/src/cowork.ts';

export const DEFAULT_XO_URL = 'http://127.0.0.1:5002';
const KEEP_IDS = 500;
// Envelopes that are conversation; connect, sync, delegations and the rest are about the coworks.
const CHAT_KINDS = new Set(['message', 'request', 'response']);

export interface XoChat { id: string; kind: string; project?: string | null; retired_at?: string | null }
export interface XoMessage { id: string; seq: number; author_kind: string; author_id: string; text: string }
/** A thread in XO Space: `ts` is the id of the message it grew from. */
export interface XoThread { ts: string; title?: string | null; state?: string | null; status_md?: string | null; outputs?: { name?: string; path?: string }[] | null }

export interface XoLink {
  /** The last cowork envelope handled; null until the first run sets it to "now". */
  hubSeq: number | null;
  /** The last XO Space message handled; null until the first run sets it to "now". */
  xoSeq: number | null;
  hubIds: string[];
  xoIds: string[];
  /** The last message handled in each thread, by thread id. */
  threadSeq: Record<string, number>;
}

function linksFile() {
  return path.join(process.env.SPACEHUB_HOME || path.join(os.homedir(), '.spacehub'), 'cowork', 'xo-links.json');
}

function loadLinks(): Record<string, XoLink> {
  try {
    return JSON.parse(fs.readFileSync(linksFile(), 'utf8'));
  } catch {
    return {};
  }
}

export function loadXoLink(project: string, xoProject: string): XoLink {
  const saved: Partial<XoLink> | undefined = loadLinks()[`${project} ${xoProject}`];
  return { hubSeq: null, xoSeq: null, hubIds: [], xoIds: [], threadSeq: {}, ...saved };
}

export function saveXoLink(project: string, xoProject: string, link: XoLink | null) {
  const all = loadLinks();
  const key = `${project} ${xoProject}`;
  if (link) all[key] = { ...link, hubIds: link.hubIds.slice(-KEEP_IDS), xoIds: link.xoIds.slice(-KEEP_IDS) };
  else delete all[key];
  fs.mkdirSync(path.dirname(linksFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(linksFile(), JSON.stringify(all, null, 1) + '\n', { mode: 0o600 });
}

/** A cowork envelope as an XO Space message, or null when it stays on the hub. */
export function hubToXo(line: CoworkLine, me: string, link: XoLink): string | null {
  if (link.hubIds.includes(line.id)) return null;
  if (!CHAT_KINDS.has(line.type) || !line.content.trim()) return null;
  // Your own words need no label in your own XO Space; anyone else is named.
  if (!line.cowork && line.author === me) return line.content;
  const who = line.cowork ? `${line.from} (cowork of ${line.user})` : line.author;
  return `**${who}** on spacehub:\n\n${line.content}`;
}

/**
 * What an XO Space message says about itself on the hub, in the envelope's meta:
 * the hub signs everything this link posts as you, so the app reads `xo` to show
 * the coordinator's words as the coordinator's (kind owner | agent | note).
 */
export interface XoMeta {
  xo: { kind: 'owner' | 'agent' | 'note'; who?: string; project: string };
  /** Set on a thread's messages; the hub keeps one object per thread in cowork.chat.json. */
  thread?: { id: string; title: string; state: string; status: string; outputs: string[] };
}

/** Threads to follow: the ones that grew from this conversation since it was linked (their first message went through the link). */
export function linkedThreads(threads: XoThread[], link: XoLink): XoThread[] {
  // Once followed, a thread stays followed (threadSeq), however long ago its first message was.
  return threads.filter(thread => thread.ts in link.threadSeq || link.xoIds.includes(thread.ts));
}

/** What the hub keeps about a thread. */
export function threadInfo(thread: XoThread): NonNullable<XoMeta['thread']> {
  return {
    id: thread.ts,
    title: (thread.title ?? '').slice(0, 200),
    state: (thread.state ?? '').slice(0, 40),
    status: (thread.status_md ?? '').slice(0, 2000),
    outputs: (thread.outputs ?? []).map(output => output.name || output.path || '').filter(Boolean).slice(0, 20),
  };
}

/** XO Space links a thread as `[title](#<message id>)`, which means nothing on the hub: keep the title, in bold. */
export function hubText(text: string): string {
  return text.replace(/\[([^\]]+)\]\(#cmsg_[A-Za-z0-9]+\)/g, '**$1**');
}

/** An XO Space message as hub text, posted as you, with who wrote it in XO Space. */
export function xoToHub(message: XoMessage, link: XoLink, project: string): { content: string; meta: XoMeta } | null {
  if (link.xoIds.includes(message.id) || !message.text?.trim()) return null;
  const kind = message.author_kind === 'owner' ? 'owner' : 'agent';
  return { content: hubText(message.text), meta: { xo: { kind, who: message.author_id, project } } };
}

/** The hub takes at most MAX_CONTENT characters an envelope, so a long reply goes in parts, cut at line breaks. */
export function splitContent(text: string, max = MAX_CONTENT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** The XO Space chat API (the local Cowork app's server). */
export function xoSpace(base: string) {
  const url = base.replace(/\/$/, '');
  async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url + route, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error(`XO Space is not answering at ${url}; start it (./cowork-api.sh start in xo-space) or pass --xo-url`);
    }
    if (!response.ok) throw new Error(`XO Space ${method} ${route}: ${response.status} ${(await response.text()).slice(0, 300)}`);
    return response.json() as Promise<T>;
  }
  return {
    url,
    projectChats: async () => ((await call<{ chats: XoChat[] }>('GET', '/api/chat/chats')).chats ?? []).filter(chat => chat.kind === 'project' && chat.project && !chat.retired_at),
    latestSeq: async (chat: string) => (await call<{ messages: XoMessage[] }>('GET', `/api/chat/chats/${chat}/messages?before_seq=999999999&limit=1`)).messages?.at(-1)?.seq ?? 0,
    messagesAfter: async (chat: string, seq: number) => (await call<{ messages: XoMessage[] }>('GET', `/api/chat/chats/${chat}/messages?after_seq=${seq}&limit=100`)).messages ?? [],
    threads: async (chat: string) => (await call<{ threads: XoThread[] }>('GET', `/api/chat/chats/${chat}/threads`)).threads ?? [],
    threadMessagesAfter: async (chat: string, thread: string, seq: number) =>
      (await call<{ messages: XoMessage[] }>('GET', `/api/chat/chats/${chat}/messages?thread=${encodeURIComponent(thread)}&after_seq=${seq}&limit=100`)).messages ?? [],
    post: (chat: string, text: string) => call<XoMessage>('POST', `/api/chat/chats/${chat}/messages`, { client_id: crypto.randomUUID(), text }),
  };
}
