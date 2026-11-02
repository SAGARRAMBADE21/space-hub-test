import { MAX_MESSAGE_LENGTH, type DemoMessage } from "./demo-chat";

/** A chat turn saved on the hub: one JSON object per line of `<conversation>.log.jsonl`. */
/** `xo`: the line came through `spacehub cowork xo`, which says who wrote it in XO Space (owner, agent or note). */
export type ChatTurn = DemoMessage & { author?: string; time?: string; detail?: string; note?: boolean; xo?: { kind: "owner" | "agent" | "note"; who: string; project: string }; seq?: number; thread?: string };

const COWORK_NOTES: Record<string, string> = { connect: "connected", disconnect: "disconnected", status: "status" };

/**
 * A cowork chat line (collab/cowork.chat.log.jsonl) is signed by the person who
 * owns the cowork, but the cowork wrote it: show it under the cowork's name, and
 * show joining and leaving as notes rather than messages.
 */
function coworkTurn(value: Record<string, unknown>): Partial<ChatTurn> | undefined {
  if (typeof value.seq !== "number" || typeof value.cowork !== "string" || !value.cowork) return;
  const name = typeof value.agent === "string" && value.agent ? `${value.cowork}:${value.agent}` : value.cowork;
  const type = typeof value.type === "string" ? value.type : "message";
  const content = typeof value.content === "string" ? value.content.trim() : "";
  if (COWORK_NOTES[type]) return { note: true, author: name, role: "assistant", content: `${name} ${COWORK_NOTES[type]}${content ? ": " + content : ""}` };
  const parts = [typeof value.user === "string" && value.user ? `cowork of ${value.user}` : "cowork"];
  if (type !== "message") parts.push(type);
  return { author: name, role: "assistant", detail: parts.join(" · ") };
}

/** A project chat line (collab/chat.log.jsonl) says more: whom an agent works for, the kind of post, the task it moves. */
function collabDetail(value: Record<string, unknown>): string | undefined {
  if (typeof value.seq !== "number") return;
  const parts: string[] = [];
  if (typeof value.agent === "string" && typeof value.user === "string" && value.user) parts.push(`agent of ${value.user}`);
  if (typeof value.type === "string" && value.type !== "message") parts.push(value.type);
  const task = object(value.task) ? value.task : undefined;
  if (task && typeof task.id === "string") parts.push(["task " + task.id, typeof task.status === "string" ? task.status.replace("_", " ") : "", typeof task.owner === "string" ? "→ " + task.owner : ""].filter(Boolean).join(" "));
  if (Array.isArray(value.to) && value.to.length) parts.push("to " + value.to.filter(name => typeof name === "string").join(", "));
  return parts.length ? parts.join(" · ") : undefined;
}

/** A line `spacehub cowork xo` posted: signed by you on the hub, but the coordinator's words are the coordinator's. */
function xoTurn(value: Record<string, unknown>): Partial<ChatTurn> | undefined {
  const meta = object(value.meta) ? value.meta : undefined;
  const xo = meta && object(meta.xo) ? meta.xo : undefined;
  if (!xo || (xo.kind !== "owner" && xo.kind !== "agent" && xo.kind !== "note")) return;
  const project = typeof xo.project === "string" ? xo.project : "";
  const who = typeof xo.who === "string" ? xo.who : "";
  const tag = { xo: { kind: xo.kind, who, project }, ...(object(meta!.thread) && typeof meta!.thread.id === "string" ? { thread: meta!.thread.id } : {}) } as const;
  if (xo.kind === "note") return { ...tag, note: true };
  if (xo.kind === "owner") return tag;
  const author = !who || who === "project-coordinator" ? `${project} coordinator`.trim() : who;
  return { ...tag, role: "assistant", author };
}

export const MAX_TURNS_PER_REQUEST = 2;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const ID = /^[A-Za-z0-9-]{1,64}$/;

/** `Chat/index.json` keeps its new turns beside it in `Chat/index.log.jsonl`. */
export function chatLogPath(conversationPath: string): string | undefined {
  return /\.json$/i.test(conversationPath) ? conversationPath.replace(/\.json$/i, ".log.jsonl") : undefined;
}

function links(value: unknown): DemoMessage["links"] | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) return null;
  const valid = value.every(link => object(link) && typeof link.label === "string" && typeof link.path === "string" && link.label.length <= 200 && link.path.length <= 1024);
  return valid ? value.map(link => ({ label: link.label as string, path: link.path as string })) : null;
}

/** Validate a turn sent by the browser; anything else is refused rather than repaired. */
export function parseTurn(value: unknown): Omit<ChatTurn, "author" | "time"> | undefined {
  if (!object(value) || typeof value.id !== "string" || !ID.test(value.id)) return;
  if (value.role !== "user" && value.role !== "assistant") return;
  if (typeof value.content !== "string" || !value.content.trim() || value.content.length > MAX_MESSAGE_LENGTH) return;
  const parsed = links(value.links);
  if (parsed === null) return;
  return { id: value.id, role: value.role, content: value.content, ...(parsed ? { links: parsed } : {}) };
}

/** Turns from a log written by open-chat, people or agents; lines that are not turns are skipped. */
export function parseChatLog(content: string): ChatTurn[] {
  const turns: ChatTurn[] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { return; }
    if (!object(value) || (value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string") return;
    const parsed = links(value.links);
    turns.push({
      id: typeof value.id === "string" && value.id ? value.id : `line-${index + 1}`,
      role: value.role,
      content: value.content.slice(0, MAX_MESSAGE_LENGTH),
      ...(parsed ? { links: parsed } : {}),
      ...(typeof value.author === "string" ? { author: value.author } : {}),
      ...(typeof value.time === "string" ? { time: value.time } : {}),
      ...(collabDetail(value) ? { detail: collabDetail(value) } : {}),
      ...(typeof value.seq === "number" ? { seq: value.seq } : {}),
      ...coworkTurn(value),
      ...xoTurn(value),
    });
  });
  return turns;
}

export function chatLogLine(turn: ChatTurn): string {
  const { id, role, author, content, links, time } = turn;
  return JSON.stringify({ id, role, ...(author ? { author } : {}), content, ...(links?.length ? { links } : {}), ...(time ? { time } : {}) }) + "\n";
}
