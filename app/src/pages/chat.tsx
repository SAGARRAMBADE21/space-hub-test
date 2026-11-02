import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Bot, FileText, Github, LogIn, Rocket, Square, UserRound, X } from "lucide-react";
import { MAX_MESSAGE_LENGTH } from "@/lib/demo-chat";
import { Markdown } from "@/components/content-view";
import { useChat } from "@/hooks/use-chat";
import { useLive } from "@/hooks/use-live";
import { WorkerCard } from "@/components/worker-card";
import { launchInput, launchOf, newKey, recentRepos, rememberRepo, repoName, send, type AgentHubStatus } from "@/lib/agenthub";
import { placeUrl, type Place } from "@/api";
import { hashOf, onLink } from "@/router";
import { Ago, Avatar, AvatarStack, ErrorNote } from "@/ui/primitives";

type Message = { id: string; role: string; author: string; content: string; links?: { label: string; path: string }[]; time?: string; detail?: string; saving?: boolean };
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
  const added: Message[] = chat.messages.map(turn => ({ ...turn, author: turn.author || (turn.role === "assistant" ? "quirqy" : "") }));
  const all = [...saved, ...added];
  const people = [...new Set(all.map(message => message.author).filter(name => name && name !== "note"))];
  // Members of an org with agents launch a worker with the message instead of only sending it.
  const agents = useLive<AgentHubStatus>(!blocked ? `/-/api/agenthub?space=${encodeURIComponent(place.space)}` : undefined, 0);
  const canLaunch = !!agents.data?.enabled && agents.data.allowed;
  const [launching, setLaunching] = useState(false);

  useEffect(() => { end.current?.scrollIntoView({ block: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); }, [all.length, chat.pending]);
  useEffect(() => {
    const box = input.current;
    if (box) { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, 160) + "px"; }
  }, [chat.draft]);

  return <div className="chat">
    {head && <div className="chat-head">
      <div><h2>{text(data.title) || path.split("/").pop()}</h2>{text(data.subtitle) && <p>{text(data.subtitle)}</p>}</div>
      {people.length > 0 && <AvatarStack names={people} />}
    </div>}
    <ol className="thread">
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
    </ol>
    <div className="composer-wrap">
      {chat.sendError && <ErrorNote message={`Not saved. ${chat.sendError}`} />}
      {chat.error && chat.error !== "blocked" && <ErrorNote message={chat.error} retry={chat.refresh} />}
      {blocked === "signin" && <div className="composer-blocked"><span>Sign in to write in this conversation.</span><a className="button" href={signIn}><LogIn size={15} />Sign in</a></div>}
      {blocked === "member" && <div className="composer-blocked"><span>Only people working on {place.space}/{place.project} can write here: owners and members of {place.space}, its collaborators and their agents. You can read along.</span></div>}
      {!blocked && <>
        {launching && <LaunchTray place={place} path={path} draft={chat.draft} onClose={() => setLaunching(false)} onLaunched={() => { setLaunching(false); chat.setDraft(""); chat.refresh(); onSaved(); }} />}
        {!added.length && chat.suggestions.length > 0 && <div className="suggestions">{chat.suggestions.map(item => <button key={item.label} type="button" disabled={!chat.ready || chat.pending} onClick={() => chat.send(item.prompt)}>{item.label}</button>)}</div>}
        <form className="composer" onSubmit={event => { event.preventDefault(); chat.send(); }}>
          <Avatar name={me!} size={28} />
          <textarea ref={input} rows={1} maxLength={MAX_MESSAGE_LENGTH} aria-label={`Message ${place.space}/${place.project}`} placeholder={chat.ready ? placeholder : "Connecting…"} value={chat.draft}
            onChange={event => chat.setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          {canLaunch && !chat.pending && <button type="button" className={`launch${launching ? " on" : ""}`} aria-label="Launch a worker with this message" title="Launch a worker with this message" aria-pressed={launching} onClick={() => setLaunching(value => !value)}><Rocket size={16} /></button>}
          {chat.pending ? <button type="button" className="send stop" aria-label="Stop the sample reply" onClick={chat.stop}><Square size={13} fill="currentColor" /></button>
            : <button type="submit" className="send" aria-label="Send" disabled={!chat.ready || !chat.draft.trim()}><ArrowUp size={17} /></button>}
        </form>
        <p className="composer-note">Saved to {place.space}/{place.project} as {me}{chat.sampleReplies ? " · sample replies on" : ""} · Enter to send, Shift+Enter for a new line{canLaunch ? ` · Launch runs it as a worker of ${place.space}` : ""}{place.project && <> · <a href={placeUrl(place, hashOf("people"))} onClick={onLink}><Bot size={12} />Bring your agent</a></>}</p>
      </>}
    </div>
  </div>;
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
