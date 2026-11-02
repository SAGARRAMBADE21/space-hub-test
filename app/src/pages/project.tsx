import { Bot, Boxes, Download, FolderGit2, GitBranch, HardDrive } from "lucide-react";
import { placeUrl, size, type Place, type ProjectMeta, type View } from "@/api";
import { hashOf, onLink, type Route } from "@/router";
import { Ago, Avatar, AvatarStack, CommandTabs, ErrorNote, Popover, Skeleton } from "@/ui/primitives";
import { ActivityList, HereNow, PageHeader, People, Tabs } from "./common";
import { BranchesTab, CodeTab, CommitTab, CommitsTab } from "./code";
import { DepsTab } from "./deps";
import { FilesTab, isChannel } from "./files";
import { PathBar } from "@/shell/path-bar";
import { GoalChip, GoalPanel } from "./goal";
import { ManageCollaborators } from "./collaborators";

type ProjectRoute = Extract<Route, { page: "project" }>;

export function ProjectPage({ route, view, error, me, signIn, refresh }: { route: ProjectRoute; view: View<ProjectMeta> | undefined; error: string; me: string | null; signIn: string; refresh: () => void }) {
  const { place } = route;
  const meta = view?.meta;
  const base = placeUrl(place);
  const tab = route.tab === "commit" ? "commits" : route.tab;
  const people = meta ? new Set([...meta.owners, ...meta.members, ...meta.collaborators, ...meta.agents]).size : undefined;
  const path = route.tab === "files" ? route.path : "";
  if (!meta && error) return <div className="page"><PathBar place={place} path={path} /><PageHeader title={place.project} /><ErrorNote message={error} retry={refresh} /></div>;
  const chatty = route.tab === "files" && view && (view.snapshot.file?.format === "json" || (!view.snapshot.file && route.as !== "folder" && isChannel(view.snapshot)));
  return <div className={`page${chatty ? " page-chat" : ""}`}>
    <PathBar place={place} path={path} />
    <PageHeader
      leading={<span className="project-mark"><FolderGit2 size={22} /></span>}
      title={place.project}
      subtitle={meta ? meta.description || undefined : <Skeleton width={220} />}
      actions={meta ? <Popover label="Clone" icon={<Download size={15} />}><CloneProject place={place} /></Popover> : undefined}>
      {meta ? <ProjectStrip place={place} meta={meta} /> : <div className="meta-strip"><Skeleton width={360} height={14} /></div>}
    </PageHeader>
    <Tabs active={tab} tabs={[
      { key: "files", label: "Files", href: base + "#" + hashOf("files") },
      ...(meta?.deps || route.tab === "deps" ? [{ key: "deps", label: "Dependencies", href: base + "#" + hashOf("deps"), count: meta?.deps || undefined }] : []),
      { key: "code", label: "Code", href: base + "#" + hashOf("code") },
      { key: "commits", label: "Commits", href: base + "#" + hashOf("commits") },
      { key: "branches", label: "Branches", href: base + "#" + hashOf("branches") },
      { key: "activity", label: "Activity", href: base + "#" + hashOf("activity") },
      { key: "people", label: "People", href: base + "#" + hashOf("people"), count: people },
    ]} />
    {meta?.goal && route.tab === "files" && !path && !chatty && <GoalPanel place={place} goal={meta.goal} canWrite={meta.canWrite} />}
    {route.tab === "files" && <FilesTab place={place} path={route.path} as={route.as} view={view} error={error} me={me} signIn={signIn} refresh={refresh} />}
    {meta && route.tab === "code" && <CodeTab place={place} ref={route.ref} path={route.path} defaultBranch={meta.defaultBranch} />}
    {meta && route.tab === "commits" && <CommitsTab place={place} ref={route.ref} path={route.path} num={route.num} defaultBranch={meta.defaultBranch} />}
    {route.tab === "commit" && <CommitTab place={place} oid={route.oid} />}
    {route.tab === "deps" && <DepsTab place={place} />}
    {route.tab === "branches" && <BranchesTab place={place} />}
    {meta && route.tab === "activity" && <ActivityList items={meta.activity} />}
    {meta && route.tab === "people" && <>
      <ManageCollaborators place={place} meta={meta} me={me} refresh={refresh} />
      {meta.here.length > 0 && <><h2 className="section-title">Here now</h2><HereNow here={meta.here} /></>}
      <People here={meta.here} agents={meta.agents} groups={[
        { title: "Owners", names: meta.owners, note: `They manage ${place.space}.` },
        { title: "Members", names: meta.members, note: `They push to every project of ${place.space}.` },
        { title: "Agents", names: meta.agents, note: "Agents connected to the space, or collaborating on this project, push here too." },
        { title: "Collaborators", names: meta.collaborators, note: "They push to this project." },
      ]} />
    </>}
  </div>;
}

const MODES: Record<string, string> = { watch: "watching", sync: "syncing", autosync: "editing", agent: "running", app: "in the app" };

/** The project's facts in one line under its name: branch, size, last change, people, who is here. */
function ProjectStrip({ place, meta }: { place: Place; meta: ProjectMeta }) {
  const people = [...new Set([...meta.owners, ...meta.members, ...meta.collaborators])];
  const here = [...new Set(meta.here.map(who => who.agent))];
  return <div className="meta-strip">
    {meta.goal && <GoalChip place={place} goal={meta.goal} />}
    <a href={placeUrl(place, hashOf("branches"))} onClick={onLink} title="Default branch"><GitBranch size={14} />{meta.defaultBranch}</a>
    <span title="Stored on the hub"><HardDrive size={14} />{size(meta.bytes)}</span>
    {meta.deps > 0 && <a href={placeUrl(place, hashOf("deps"))} onClick={onLink} title="Repositories pinned by DEPS"><Boxes size={14} />{meta.deps} pinned {meta.deps === 1 ? "repo" : "repos"}</a>}
    {meta.head ? <a href={placeUrl(place, hashOf("commit", { oid: meta.head.oid }))} onClick={onLink} title={meta.head.subject}><Avatar name={meta.head.author} size={18} /><span>Updated <Ago iso={meta.head.time} /> by {meta.head.author}</span></a> : <span>Nothing pushed yet</span>}
    {people.length > 0 && <a href={placeUrl(place, hashOf("people"))} onClick={onLink} title={people.join(", ")}><AvatarStack names={people} max={5} size={20} /><span>{people.length} {people.length === 1 ? "person" : "people"}</span></a>}
    {meta.agents.length > 0 && <a href={placeUrl(place, hashOf("people"))} onClick={onLink} title={meta.agents.join(", ")}><Bot size={14} />{meta.agents.length} {meta.agents.length === 1 ? "agent" : "agents"}</a>}
    {here.length > 0 && <span className="strip-here" title={meta.here.map(who => `${who.agent} · ${MODES[who.mode] ?? who.mode}`).join("\n")}><i className="online-dot" />{here.length} here now</span>}
  </div>;
}

/** How to get the project onto a machine: spacehub or plain git. */
function CloneProject({ place }: { place: Place }) {
  const name = `${place.space}/${place.project}`;
  return <>
    <div className="popover-title">Clone {name}</div>
    <CommandTabs tabs={[
      { label: "spacehub", lines: [`spacehub project clone ${name}`] },
      { label: "git", lines: [`git clone -o quirq quirq://${location.host}/${name}`] },
    ]} note={<>Then keep it in step as you and others edit: <code>spacehub project sync --watch --auto</code></>} />
  </>;
}
