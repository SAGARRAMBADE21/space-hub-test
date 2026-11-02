import { useEffect, useState, type FormEvent } from "react";
import { Bot, UserMinus, UserPlus } from "lucide-react";
import { viewUrl, type Place, type ProjectMeta, type SpaceMeta, type View } from "@/api";
import { Avatar } from "@/ui/primitives";

/** Ask the hub to add or remove a collaborator as the signed-in builder; the module checks who may. */
async function changeCollaborator(place: Place, action: "add" | "remove", name: string): Promise<void> {
  const response = await fetch("/-/api/collaborators", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ space: place.space, project: place.project, action, name }),
  });
  if (response.ok) return;
  const body = await response.json().catch(() => ({})) as { error?: string };
  throw new Error(body.error || `Could not ${action} ${name} (${response.status}).`);
}

/** The agents the signed-in builder owns (their personal space's agents). */
function useMyAgents(me: string | null): string[] {
  const [agents, setAgents] = useState<string[]>([]);
  useEffect(() => {
    if (!me) return setAgents([]);
    const controller = new AbortController();
    fetch(viewUrl({ space: me, project: "" }), { cache: "no-store", signal: controller.signal })
      .then(response => (response.ok ? response.json() as Promise<View<SpaceMeta>> : null))
      .then(view => setAgents(view?.meta.agentList?.filter(agent => agent.owned).map(agent => agent.name) ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, [me]);
  return agents;
}

/**
 * Manage who works on a project, from its People tab. The space's owners add
 * builders and remove collaborators; anyone who may push (owners, members,
 * collaborators) brings their own agents into the project and its chat; a
 * collaborator can leave. The module enforces all of it.
 */
export function ManageCollaborators({ place, meta, me, refresh }: { place: Place; meta: ProjectMeta; me: string | null; refresh: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const myAgents = useMyAgents(meta.canWrite ? me : null);
  if (!me || !meta.canWrite) return null;
  const owner = meta.owners.includes(me);
  const toBring = myAgents.filter(agent => !meta.agents.includes(agent));
  // Rows the viewer may remove, as the module allows: owners remove any
  // collaborator or brought agent; a collaborator leaves; whoever brought an
  // agent, or owns it, takes it away. Agents connected to the whole space
  // are managed on the space, not here.
  const broughtBy = new Map((meta.brought ?? []).map(row => [row.agent, row.by]));
  const rows = [
    ...meta.collaborators.filter(who => owner || who === me),
    ...[...broughtBy].filter(([agent, by]) => owner || by === me || myAgents.includes(agent)).map(([agent]) => agent),
  ];

  const run = async (action: "add" | "remove", who: string) => {
    setBusy(`${action}:${who}`);
    setNote(null);
    try {
      await changeCollaborator(place, action, who);
      const agent = myAgents.includes(who) || meta.agents.includes(who);
      setNote({
        text: action === "add"
          ? agent ? `${who} joined ${place.project} and its chat.` : `${who} can now push to ${place.project}.`
          : who === me ? `You left ${place.project}.` : `${who} was removed from ${place.project}.`,
        error: false,
      });
      if (action === "add" && who === name.trim().replace(/^@/, "").toLowerCase()) setName("");
      refresh();
    } catch (error) {
      setNote({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setBusy("");
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const who = name.trim().replace(/^@/, "").toLowerCase();
    if (who) void run("add", who);
  };

  return <section className="collab-manage" aria-label="Manage people and agents">
    {owner && <>
      <form className="collab-add" onSubmit={submit}>
        <label className="launch-github">
          <UserPlus size={14} />
          <input value={name} placeholder="Builder name (their GitHub login)" spellCheck={false} autoCapitalize="off" autoComplete="off" aria-label="Collaborator name" onChange={event => setName(event.target.value)} />
        </label>
        <button type="submit" className="button primary" disabled={!name.trim() || !!busy}>{busy === `add:${name.trim().replace(/^@/, "").toLowerCase()}` ? "Adding…" : "Add collaborator"}</button>
      </form>
      <p className="launch-note">Collaborators push to this project only and join its chat. They need to have signed in to the hub once.</p>
    </>}
    {toBring.length > 0 && <div className="collab-bring">
      <span className="collab-bring-title"><Bot size={14} />Bring your agent to this project and its chat</span>
      <div className="launch-recent">
        {toBring.map(agent => <button key={agent} type="button" disabled={!!busy} onClick={() => void run("add", agent)}>{busy === `add:${agent}` ? "Adding…" : `+ ${agent}`}</button>)}
      </div>
    </div>}
    {!owner && myAgents.length === 0 && <p className="launch-note">Create an agent in your space to bring it into this project's chat.</p>}
    {rows.length > 0 && <ul className="collab-list">
      {rows.map(who => {
        const agent = meta.agents.includes(who);
        return <li key={who}>
          <Avatar name={who} size={22} kind={agent ? "agent" : undefined} />
          <span className="collab-name">{who}{who === me ? <span className="quiet"> (you)</span> : agent ? <span className="quiet"> · agent{broughtBy.get(who) ? `, brought by ${broughtBy.get(who) === me ? "you" : broughtBy.get(who)}` : ""}</span> : null}</span>
          <button type="button" className="button ghost small" disabled={!!busy} onClick={() => void run("remove", who)}>
            <UserMinus size={13} />{busy === `remove:${who}` ? "Removing…" : who === me ? "Leave" : "Remove"}
          </button>
        </li>;
      })}
    </ul>}
    {note && <p className={`launch-note${note.error ? " is-error" : ""}`} role={note.error ? "alert" : "status"}>{note.text}</p>}
  </section>;
}
