import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ArrowUp, Bot, FileText, Github, Link2, LogIn, Rocket, Square, UserRound, X } from "lucide-react";
import { MAX_MESSAGE_LENGTH } from "@/lib/demo-chat";
import { Markdown } from "@/components/content-view";
import { useChat } from "@/hooks/use-chat";
import { useLive } from "@/hooks/use-live";
import { WorkerCard } from "@/components/worker-card";
import { launchInput, launchOf, newKey, recentRepos, rememberRepo, repoName, send, type AgentHubStatus } from "@/lib/agenthub";
import { placeUrl, type Place } from "@/api";
import { hashOf, onLink } from "@/router";
import { Ago, Avatar, AvatarStack, ErrorNote } from "@/ui/primitives";

type Message = { id: string; role: string; author: string; content: string; links?: { label: string; path: string }[]; time?: string; detail?: string; saving?: boolean; xo?: { kind: string; who: string; project: string } };
type Conversation = { title?: unknown; subtitle?: unknown; messages: Record<string, unknown>[] };

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** A conversation file and its saved log, as a thread of people and agents, with a composer for members. */
export function ChatView({ place, path, data, repliesPath, logExists, me, canWrite, signIn, onSaved, onOpen, head = true, placeholder = "Write a message" }: {
  place: Place; path: string; data: Conversation; repliesPath: string | undefined; logExists: boolean; me: string | null; canWrite: boolean; signIn: string; onSaved: () => void; onOpen: (path: string) => void;
  /** A channel page shows its own header instead of the conversation's. */
  head?: boolean; placeholder?: string;
}) {
  const blocked = !me ? "signin" : !canWrite ? "member" : undefined;
  const chat = useChat(place, path, repliesPath, blocked ? "blocked" : undefined, logExists, onSaved, me ?? undefined);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const saved: Message[] = data.messages.map((message, index) => ({
    id: "file-" + index,
    role: text(message.role),
    author: text(message.author) || (message.role === "user" ? "" : message.role === "system" ? "note" : "quirqy"),
    content: text(message.content),
    links: Array.isArray(message.links) ? (message.links as Message["links"]) : undefined,
    time: text(message.time) || undefined,
  }));
  const added: Message[] = chat.messages.map(turn => ({ ...turn, role: turn.note ? "system" : turn.role, author: turn.author || (turn.role === "assistant" ? "quirqy" : "") }));
  const all = [...saved, ...added];
  const people = [...new Set(all.map(message => message.author).filter(name => name && name !== "note"))];
  // Members of an org with agents launch a worker with the message instead of only sending it.
  const agents = useLive<AgentHubStatus>(!blocked ? `/-/api/agenthub?space=${encodeURIComponent(place.space)}` : undefined, 0);
  const canLaunch = !!agents.data?.enabled && agents.data.allowed;
  const [launching, setLaunching] = useState(false);
  // The cowork chat is linked with XO Space (spacehub cowork xo), so it looks like XO Space's own chat.
  const xo = path.split("/").pop() === "cowork.chat.json";
  const xoProject = [...all].reverse().find(message => message.xo?.project)?.xo?.project || place.project;
  const now = useNow(xo ? 5000 : 0);
  const last = [...all].reverse().find(message => message.role !== "system");
  const lastAt = last?.time ? Date.parse(last.time) : NaN;
  // Your message is the last word and recent: the coordinator is on it (its reply comes back through the link).
  const replying = xo && !!last && isMine(last, me) && (!!last.saving || (now - lastAt >= -60_000 && now - lastAt < 3 * 60_000));

  useEffect(() => { end.current?.scrollIntoView({ block: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); }, [all.length, chat.pending, replying]);
  useEffect(() => {
    const box = input.current;
    if (box) { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, 160) + "px"; }
  }, [chat.draft]);

  return <div className={`chat${xo ? " chat-xo" : ""}`}>
    {head && <div className="chat-head">
      {xo ? <><span className="xo-tile big"><XoMark /></span><div><h2>{xoProject}</h2><p>Linked with XO Space · one conversation here and there</p></div></>
        : <><div><h2>{text(data.title) || path.split("/").pop()}</h2>{text(data.subtitle) && <p>{text(data.subtitle)}</p>}</div>
          {people.length > 0 && <AvatarStack names={people} />}</>}
    </div>}
    {xo ? <ol className="xo-msgs">
      {all.length === 0 && <li className="xo-empty">No messages yet. Tell the {xoProject} coordinator what you would like done.</li>}
      {all.map((message, index) => <XoRow key={message.id} message={message} cont={index > 0 && sameSpeaker(all[index - 1], message, me)} me={me} path={path} onOpen={onOpen} />)}
      {replying && <li className="xo-them"><span className="xo-tile"><XoMark /></span><div className="xo-body"><div className="xo-head"><b>{xoProject} coordinator</b></div><div className="xo-shimmer">The coordinator is replying…</div></div></li>}
      <div ref={end} />
    </ol>
    : <ol className="thread">
      {all.map((message, index) => {
        const previous = all[index - 1];
        const grouped = previous && previous.author === message.author && !message.time;
        if (message.role === "system") return <li key={message.id} className="thread-note">{message.content}</li>;
        return <li key={message.id} className={`message-row${grouped ? " grouped" : ""}${message.saving ? " saving" : ""}${me && message.author === me ? " mine" : ""}`}>
          <span className="message-avatar">{!grouped && (message.author ? <Avatar name={message.author} size={32} /> : <span className="avatar-anon"><UserRound size={18} /></span>)}</span>
          <div className="message-main">
            {!grouped && <div className="message-meta"><strong>{!message.author ? "User" : message.author === me ? `${message.author} (you)` : message.author}</strong>{message.detail && <span className="quiet">{message.detail}</span>}{message.saving ? <span className="quiet">Saving…</span> : message.time && (/^\d{4}-/.test(message.time) ? <Ago iso={message.time} /> : <span className="quiet">{message.time}</span>)}</div>}
            {(() => {
              const launch = launchOf(message.content);
              return <>
                <div className="message-text"><Markdown content={launch ? launch.text : message.content} filePath={path} navigate={onOpen} /></div>
                {launch && <WorkerCard id={launch.task} />}
              </>;
            })()}
            {message.links && message.links.length > 0 && <div className="message-links">{message.links.map((link, i) => <button key={i} type="button" onClick={() => onOpen(link.path)}><FileText size={14} />{link.label || link.path}</button>)}</div>}
          </div>
        </li>;
      })}
      {chat.pending && <li className="message-row"><span className="message-avatar"><Avatar name="quirqy" size={32} /></span><div className="message-main"><div className="message-meta"><strong>quirqy</strong></div><div className="typing" aria-label="Writing a reply"><i /><i /><i /></div></div></li>}
      <div ref={end} />
    </ol>}
    <div className="composer-wrap">
      {chat.sendError && <ErrorNote message={`Not saved. ${chat.sendError}`} />}
      {chat.error && chat.error !== "blocked" && <ErrorNote message={chat.error} retry={chat.refresh} />}
      {blocked === "signin" && <div className="composer-blocked"><span>Sign in to write in this conversation.</span><a className="button" href={signIn}><LogIn size={15} />Sign in</a></div>}
      {blocked === "member" && <div className="composer-blocked"><span>Only people working on {place.space}/{place.project} can write here: owners and members of {place.space}, its collaborators and their agents. You can read along.</span></div>}
      {!blocked && <>
        {launching && <LaunchTray place={place} path={path} draft={chat.draft} onClose={() => setLaunching(false)} onLaunched={() => { setLaunching(false); chat.setDraft(""); chat.refresh(); onSaved(); }} />}
        {!added.length && chat.suggestions.length > 0 && <div className="suggestions">{chat.suggestions.map(item => <button key={item.label} type="button" disabled={!chat.ready || chat.pending} onClick={() => chat.send(item.prompt)}>{item.label}</button>)}</div>}
        <form className={`composer${xo ? " xo-composer" : ""}`} onSubmit={event => { event.preventDefault(); chat.send(); }}>
          {!xo && <Avatar name={me!} size={28} />}
          <textarea ref={input} rows={1} maxLength={MAX_MESSAGE_LENGTH} aria-label={`Message ${place.space}/${place.project}`} placeholder={!chat.ready ? "Connecting…" : xo ? `Message ${xoProject}…` : placeholder} value={chat.draft}
            onChange={event => chat.setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          {xo && <span className="xo-target"><ArrowRight size={13} />To the <b>{xoProject}</b> coordinator</span>}
          {canLaunch && !chat.pending && <button type="button" className={`launch${launching ? " on" : ""}`} aria-label="Launch a worker with this message" title="Launch a worker with this message" aria-pressed={launching} onClick={() => setLaunching(value => !value)}><Rocket size={16} /></button>}
          {chat.pending ? <button type="button" className="send stop" aria-label="Stop the sample reply" onClick={chat.stop}><Square size={13} fill="currentColor" /></button>
            : <button type="submit" className="send" aria-label="Send" disabled={!chat.ready || !chat.draft.trim()}><ArrowUp size={17} /></button>}
        </form>
        {xo ? <p className="composer-note">Saved to {place.space}/{place.project} as {me} · Enter to send, Shift+Enter for a new line</p>
        : <p className="composer-note">Saved to {place.space}/{place.project} as {me}{chat.sampleReplies ? " · sample replies on" : ""} · Enter to send, Shift+Enter for a new line{canLaunch ? ` · Launch runs it as a worker of ${place.space}` : ""}{place.project && <> · <a href={placeUrl(place, hashOf("people"))} onClick={onLink}><Bot size={12} />Bring your agent</a></>}</p>}
      </>}
    </div>
  </div>;
}

const isMine = (message: Message, me: string | null) => !!me && message.author === me && message.role !== "assistant" && message.role !== "system";
const sameSpeaker = (a: Message, b: Message, me: string | null) => a.role !== "system" && b.role !== "system" && a.author === b.author && isMine(a, me) === isMine(b, me);

function useNow(every: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!every) return;
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

const when = (time: string | undefined) => !time ? null : /^\d{4}-/.test(time) ? <Ago iso={time} /> : <span>{time}</span>;

/** XO's mark: the two chevrons, the second in XO green. */
function XoMark() {
  return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6.5 9.5 12 4 17.5" stroke="currentColor" /><path d="M20 6.5 14.5 12l5.5 5.5" stroke="var(--xo-green)" />
  </svg>;
}

/**
 * One message in XO Space's style: yours a bubble on the right, the coordinator's
 * and everyone else's prose under their name, notes one quiet line.
 */
function XoRow({ message, cont, me, path, onOpen }: { message: Message; cont: boolean; me: string | null; path: string; onOpen: (path: string) => void }) {
  if (message.role === "system") return <li className="xo-ev"><span className="xo-ev-ic"><Link2 size={12} /></span><span className="xo-ev-t">{message.content}</span>{when(message.time)}</li>;
  const links = message.links && message.links.length > 0 && <div className="message-links">{message.links.map((link, i) => <button key={i} type="button" onClick={() => onOpen(link.path)}><FileText size={14} />{link.label || link.path}</button>)}</div>;
  if (isMine(message, me)) return <li className={`xo-you${cont ? " cont" : ""}${message.saving ? " is-pending" : ""}`}>
    <div className="xo-bubble">{message.content}</div>
    {links}
    <div className="xo-meta">{message.saving ? "Sending…" : when(message.time)}</div>
  </li>;
  const agent = message.role === "assistant";
  return <li className={`xo-them${cont ? " cont" : ""}`}>
    <span className="xo-tile">{cont ? null : agent ? <XoMark /> : <Avatar name={message.author} size={30} />}</span>
    <div className="xo-body">
      {!cont && <div className="xo-head"><b>{message.author || "User"}</b>{message.detail && <span>{message.detail}</span>}{when(message.time)}</div>}
      <div className="xo-prose"><Markdown content={message.content} filePath={path} navigate={onOpen} /></div>
      {links}
    </div>
  </li>;
}

/**
 * Above the composer: launch the message as a worker of the org, on a GitHub
 * repository, or on an issue or pull request (its link joins the task).
 */
function LaunchTray({ place, path, draft, onClose, onLaunched }: { place: Place; path: string; draft: string; onClose: () => void; onLaunched: () => void }) {
  const [github, setGithub] = useState(() => recentRepos()[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One key per launch: a retry of it starts one worker, an edited one is new.
  const key = useMemo(newKey, [draft, github]);
  const recent = recentRepos();
  const repo = repoName(github);
  const launch = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const input = launchInput(draft, github);
      const made = await send("POST", "/tasks", { space: place.space, project: place.project, conversation: path, ...input }, key) as { saved?: boolean };
      rememberRepo(repo);
      if (made?.saved === false) setError("The worker started, but the message was not saved to this chat.");
      else onLaunched();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The worker did not start.");
    } finally {
      setBusy(false);
    }
  };
  return <div className="launch-tray">
    <div className="launch-row">
      <Rocket size={15} className="launch-icon" />
      <span className="launch-title">Launch {draft.trim() ? "this message" : "a message"} as a worker of <strong>{place.space}</strong></span>
      <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={14} /></button>
    </div>
    <div className="launch-row">
      <label className="launch-github"><Github size={14} /><input value={github} placeholder="owner/repo, or a GitHub issue or pull request link" spellCheck={false} autoCapitalize="off" onChange={event => setGithub(event.target.value)} /></label>
      <button type="button" className="button primary small" disabled={!draft.trim() || busy || (!!github.trim() && !repo)} onClick={() => void launch()}>{busy ? "Launching…" : "Launch"}</button>
    </div>
    {recent.length > 0 && <div className="launch-recent">{recent.map(name => <button key={name} type="button" className={name === repo ? "on" : undefined} onClick={() => setGithub(name)}>{name}</button>)}</div>}
    {github.trim() && !repo && <p className="launch-note">Use owner/repo, or paste a github.com link.</p>}
    {!draft.trim() && <p className="launch-note">Write what the worker should do in the message box, then launch.</p>}
    {error && <p className="launch-note is-error">{error}</p>}
  </div>;
}
