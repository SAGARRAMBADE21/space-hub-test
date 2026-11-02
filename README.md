# spacehub

Git hosting stored in SpacetimeDB, laid out like GitHub:

| GitHub | spacehub |
| --- | --- |
| user | **builder**: a person's login, with a personal space of the same name |
| organization | **org**: a collection of projects with owners and members |
| repository | **project**, at `/<space>/<project>` |
| org member | org member: pushes to every project in the org |
| repo collaborator | project collaborator: pushes to one project |
| (none) | **agent**: a space with an identity of its own, connected to the spaces it works in and launched anywhere |

Every top-level name (`/<name>`) is a **space**: a builder's personal space,
an org, or an agent. They all share one set of names, so any
GitHub user or organization can have the same name here. **Builders** also
means who made a project's code: GitHub accounts are credited for the
repositories imported from them.

Like GitHub, spacehub has two halves:

- **Server**: a SpacetimeDB instance running the spacehub module, which holds
  builders, spaces, projects, refs and git objects and enforces the push
  rules. It ships as a Docker image.
- **Client**: `spacehub`, a gh-style CLI, plus `git-remote-quirq`, which
  makes plain git understand `quirq://hub.quirq.dev/<space>/<project>`.

Its main job is to keep the git trees of different machines, sandboxes,
people and agents in sync.

```sh
gh auth login                          # once, on a hub without an OAuth App: the GitHub CLI
spacehub auth login                    # sign up with that GitHub account (wss://hub.quirq.dev; another with --server)
spacehub project create notes --source . --push
spacehub project clone <you>/notes
git push quirq / git pull quirq main     # plain git from here on
spacehub project sync --watch            # follow every push live
spacehub project sync --watch --auto     # edit together: commit, rebase and push every few seconds
```

## Sign up with GitHub

On a hub whose builders sign up with GitHub (the server image's default), a
builder is a GitHub account. `spacehub auth login` signs in one of two ways,
depending on the hub.

**With the hub's OAuth App** (`SPACEHUB_GITHUB_CLIENT_ID` and
`SPACEHUB_GITHUB_CLIENT_SECRET` set on the server):

1. The CLI asks the hub to start a sign-in (`POST /-/api/auth/github/device`).
   The hub starts GitHub's device flow for its app, with no scopes, and the
   CLI prints GitHub's code; you open github.com/login/device, type it and
   say yes.
2. The hub asks GitHub until you have said yes (the CLI waits on
   `POST /-/api/auth/github/device/poll`), and GitHub gives the token to the
   hub, never to the CLI. With no scopes it reads only your public profile:
   it cannot see or change your repositories.
3. The hub asks GitHub, as the app, whose token it is
   (`POST /applications/<client id>/token`). Only a user account is
   accepted; the token is not kept or logged. A GitHub token sent to the hub
   (`POST /-/api/auth/github`) is refused, so a token from anywhere else
   cannot sign in here.

A code signs in to whichever hub started it, and a hostile hub could pass
on another hub's code. So for a hub other than hub.quirq.dev the CLI asks at
a terminal before showing the code: approve on GitHub only an app you know
belongs to that hub.

**Without one**, the CLI uses the GitHub account logged in on that machine:
it reads that account's token with `gh auth token` (or from `GH_TOKEN` or
`GITHUB_TOKEN`) and sends it once to the hub, which asks GitHub whose it is
(`GET /user`). That token can usually read and write your repositories, so the
CLI sends it only over https (or to a hub on this machine), and to a hub other
than hub.quirq.dev only after you answer yes at a terminal.

Either way the web service takes at most 30 sign-ins a minute. The first
time, the hub makes the builder: its name, and its personal space, are the
GitHub login (lowercased), and its token is a new identity that the hub keeps
for that GitHub account (by account id, so a renamed login still signs in).
The CLI saves the token. Running `spacehub auth login` again on any machine,
with the same GitHub account, gets the same builder back.

To give a hub an OAuth App: on GitHub, Settings, Developer settings, OAuth
Apps, New OAuth App (or the same under an organization's settings). The
homepage URL and the required Authorization callback URL can both be the
hub's address; the device flow uses neither. Tick **Enable Device Flow**
(on that form, or on the app's page afterwards), register it, then generate
a client secret. Set both values on the server and restart it. The hub also
needs its admin token (the server image reads it), or there is no GitHub
sign-in at all.

```sh
gh auth login                  # only on a hub without an OAuth App, if gh is not logged in yet
spacehub auth login            # Signed up on wss://hub.quirq.dev ... as builder octocat
spacehub auth token            # to sign in on the website too
```

The name has to be free on the hub: if an org or an older builder
already has it, sign-up stops and says so. Registering a name without GitHub
(`spacehub auth login --builder <name>`, or the website's form) works only on
hubs with open sign-up (`SPACEHUB_ACCOUNTS=open`), such as a local
development server. Agents are unchanged: their owners make them.

## Spaces and projects

```sh
spacehub space create acme -d "our team"         # an org; you are its owner
spacehub space member add acme bob               # bob pushes to every acme project (--owner: manages it too)
spacehub project create acme/site --source . --push
spacehub project clone acme/site
spacehub space view acme                         # owners, members, projects
spacehub project member add suraj/notes carol    # carol may push to this one project
```

- **Owners** of a space manage it: members, edits, imports, builder credits,
  deleting projects and the space. A personal space's owner is its builder.
- **Members** push to every project of the space and create projects in it.
  A member can remove itself; an org keeps at least one owner.
- **Collaborators** push to one project.
- An org is deleted only when it has no projects left.

Older forms keep working: `space` commands given `space/name`, a bare name
that is not a space (it means your own project), or run inside a clone act
on that project as before, and `space create <name> --source ...` still makes
a project.

## Agents

An agent is a space with an identity of its own. Its definition is the
project `<agent>/home`, in the xo-agent-template layout (`SOUL.md`,
`IDENTITY.md`, `AGENTS.md`, `MEMORY.md`, `USER.md`, `TOOLS.md`, `memory/`,
`skills/`). Its owners are the owners of the space that owns it.

```sh
spacehub agent create scout -d "reads the web"   # owned by your personal space (--in <org> for an org's)
spacehub agent connect scout acme                # it may push to acme's projects (you own both)
spacehub agent run scout                         # run it here: ./scout/scout/home, ./scout/acme/<project>, ...
spacehub agent token scout                       # its token, for its owners (XO Swarm launches with it)
spacehub agent list | view | disconnect | delete
```

`--template <git url>` seeds the home from a template repository (its
`workspace/` folder if it has one, as xo-agent-template does).

**`agent run`** puts the agent's own space, every space it is connected
to and every project it collaborates on (only those projects of their
spaces) in one folder, each kept current by autosync, and pushes
as the agent: commits carry its name, and pushes are credited to it. It
follows spaces it is connected to or disconnected from while it runs. Each
followed space shows it as running (presence mode `agent`, with `--host`,
the machine's name by default), and so does the agent's page. It runs as the
agent when logged in with the agent's token (`SPACEHUB_TOKEN`), or as one of
its owners, who fetch the token from the hub.

**The token.** `agent create` makes a fresh identity for the agent and hands
its token to the hub, which keeps it in the private `agent_secret` table.
Only the agent's owners read it, through the `agent_token` procedure, whose
answer goes to the caller alone. Reducer arguments never reach other
clients. An agent identity cannot register as a builder, make orgs or
agents, or be connected anywhere without its owners.

**What XO Swarm needs** to launch an agent in a Coworker workspace:

1. git, Node 22+ and the spacehub CLI in the workspace image
   (`scripts/install-cli.sh`, or the client image).
2. `SPACEHUB_SERVER` (for example `wss://hub.quirq.dev`) and the agent's token
   as `SPACEHUB_TOKEN`, kept as a Swarm secret. An owner gets it with
   `spacehub agent token <agent>`; xo.quirq.dev can call `agent_token` as
   the user's builder, whose token it already keeps.
3. Start `spacehub agent run <agent> /workspace --host <workspace name>`, and
   restart it if it exits. Exit status 2 means every project is paused on a
   conflict and needs a person.
4. Point the runtime (Claude Code, Codex, OpenClaw) at
   `/workspace/<agent>/home` for its instructions and memory, and at
   `/workspace/<space>/<project>` to work in.

The workspace needs no persistent storage: the hub holds everything, and a
fresh workspace clones again.

## Goals and templates

A project says what it is for in a `SPACE.md` at its root, and the hub puts
that first: the project opens on its goal, how many outcomes are done, each
outcome and who answers for it, and its owners; the strip under its name and
its card on the space page show the goal and the outcomes done.

```markdown
# Q4 launch

## Goal
Launch quirq.ai to the first 100 teams by December 1.

## Due
2026-12-01

## Outcomes
- [x] Landing page live @dwivedi-ai
- [ ] 100 teams with an active space @suraj

## Owners
- suraj

## Rules
- Every piece of work serves an outcome above.

## Routines
- Every run: pull, reply, sort the inbox, regenerate outputs, push.
```

Outcomes are a task list; a trailing `@name` or `(@name)` names who answers
for one. Rules and routines are what people and agents here follow (the
**Rules** button lists them). Other sections are left to the file.

**Templates.** A new project can start from a template instead of empty: its
files become the project's first commit, with the goal you give and you as
owner. Every hub has the built-in **goal space** (`module/src/spacetemplate.ts`):
the shape quirq/quirq grew into, with `SPACE.md`, `CLAUDE.md` and
`CONTRIBUTING.md` for agents and people, `Chat/` channels (each an owner, an
input and one output) starting with `Chat/general`, whose output is the plan,
and the Vision, Library, Insights and Activity sections. Any project becomes
a template by adding a `## Template` section to its `SPACE.md` saying when to
use it; its page then shows **Use this template**, and its card is marked.

```sh
spacehub project create acme/launch --goal "Launch by December 1"        # the goal space
spacehub project create acme/q4 --template acme/playbook --goal "..."    # a template project
```

On the website, **New project** (`/-/new`) asks for the goal and what to
start from (`/-/new?template=<space>/<project>` picks one). Starting from a
template fills `{{space}}`, `{{project}}`, `{{goal}}`, `{{owner}}` and
`{{date}}` in its Markdown and JSON files, makes you the only owner, opens
every outcome again and drops the `## Template` section. It runs as one
reducer (`create_project_from_template`), so it is all or nothing; a template
holds at most 2,000 files and 16 MB. The module lists templates at
`/api?templates`.

## A whole space at once

```sh
spacehub space clone acme            # every project of acme, side by side, in ./acme
cd acme
spacehub space sync                  # fast-forward every project; clone new ones
spacehub space sync --watch --auto   # autosync in every project, with one connection
```

The folder has a clone of each project plus `.spacehub/space.json`, listing
the hub, the space and its projects (like quirq's `DEPS`). `space sync
--watch --auto` runs autosync in every project and clones projects that
appear while it runs. A conflict pauses only its project, with the same
instructions as autosync; the others keep syncing, and the command exits
(status 2) only when every project is paused. Inside one project's clone,
`space sync` still syncs just that project. Presence shows the process as
following the whole space ("all projects") on every project page.

## Mirroring GitHub

A space can mirror a GitHub user or organization: every public repository
becomes a project with the same name, so `github.com/acme/site` is
`hub/acme/site`. GitHub to hub only; pushing back to GitHub comes later.

```sh
spacehub space link acme https://github.com/acme   # owners only; syncs now
spacehub space link acme --sync                    # sync again now
spacehub space link acme --remove                  # stop; the projects stay
spacehub space view acme                           # what it mirrors, how the last sync went
```

The space page has the same, as a **GitHub** box with **Link**, **Sync now**
and **Unlink** for owners. The hub syncs every linked space every
`SPACEHUB_GITHUB_SYNC_MINUTES` (60) as well. New repositories become new
projects, credited to the GitHub account.

**Work done here is never overwritten.** For each branch and tag the sync
compares GitHub's value now, the hub's, and GitHub's value at the last sync:

| Case | What happens |
| --- | --- |
| Nobody changed it here | It follows GitHub, force pushes and deletions included |
| Changed here, and GitHub built on that | Fast-forward |
| Changed here, GitHub unchanged | Kept as it is here |
| Changed here, GitHub went another way | Kept as it is here, marked **diverged** on the refs page, in `project view` and in the activity feed |
| Deleted here | Stays deleted until GitHub moves it |

Every push carries a lease on the value the sync saw, so a push made during
a sync wins and the sync tries that ref again next time. Imports and **Sync
from GitHub** on a single project follow the same rules.

## Editing together

Several builders and agents can work in one project at the same time.

1. **Give them access.** Put the project in an org and add everyone
   as members, or add collaborators to one project.
2. **Run autosync in each clone.** `spacehub project sync --watch --auto
   [--interval <seconds>]` (default 3) keeps the clone and its branch on the
   hub the same. It commits every local change as an `autosync: <files>`
   commit, rebases onto each push to the branch the moment the hub reports
   it (`git pull --rebase`), and pushes. People editing different files never
   need to pull by hand.
3. **On a conflict autosync stops** with exit status 2. It leaves git's own
   conflict state: the rebase is paused with markers in the files it lists.
   Fix them, `git add` them and `git rebase --continue` (or `git rebase
   --abort` to keep your commits as they were), then start autosync again.
   It refuses to start while a rebase or merge is unfinished.
4. **See who is here.** `spacehub project who <project>` lists who is
   connected to a project now, with their mode (`watch`, `sync` or
   `autosync`) and branch; `spacehub space who <space>` covers a whole space.
   The project page shows the same as **Here now**, and the home page shows
   everyone across the hub.

Plain `project sync --watch` still only fast-forwards.

## The project chat

Each project has one conversation for everyone who works on it and the
agents they bring: `collab/` on the default branch, so every clone and every
running agent has it on disk, and the app shows it under **Files** with a
message box.

```sh
spacehub project member add acme/site bob         # alice (owner of acme) adds bob
spacehub project member add acme/site scribe      # bob brings his own agent, to this project only
spacehub collab post --type goal "Ship the new landing page by Friday"
spacehub collab task hero --title "Compress the hero image"
spacehub collab task hero --claim --status in_progress    # as scribe (an agent claims it)
spacehub collab post --type finding "The hero image is 4 MB; WebP gets it to 400 KB"
spacehub collab handoff hero bob "Resized; needs a WebP pass in the build"
spacehub collab state                              # goal, tasks and owners, decisions, findings, who said what
spacehub collab watch --json --since 12            # each new post as it lands, from #13 on
```

| File | Holds |
| --- | --- |
| `collab/chat.log.jsonl` | One line per post: `seq`, `id`, `type`, `author`, `user` (the builder, or whom an agent works for), `agent`, `role`, `content`, `to`, `reply_to`, `task`, `meta`, `time` |
| `collab/state.json` | The log folded: the goal, the last decisions and findings, open tasks with owners and status, each participant's last post and status |
| `collab/chat.json` | The conversation file the app opens |
| `collab/archive/` | Earlier parts of the log, moved aside every 64 KiB |

- **Who.** Anyone who may push to the project posts: its space's owners
  and members, its collaborators, and agents connected to its space or
  brought to the project. A collaborator brings an agent they own with
  `project member add`; the agent works in that project only, its posts
  name it and the person who brought it, and it leaves when they do. Its
  owners, whoever brought it and the space's owners can take it away.
- **One writer.** Posts go through the `collab_post` reducer, which appends
  the line, folds the state and commits both as the poster, in one
  transaction. Posts never race and need no locks; the hub sets `author`
  and `seq`, so nobody posts as someone else. `update_ref` refuses pushes
  that change `collab/` on the default branch (owners of the space may
  force-push a repair). The app's message box posts the same way.
- **Resending is safe.** A post's `id` (`--id`, a fresh UUID by default) is
  taken once, so an agent that lost its connection mid-post sends it again.
- **Tasks.** `type: task` opens one or changes it; `handoff` gives it to
  someone else on the project. Anyone may claim a task nobody owns; after
  that, its owner, whoever opened it and the space's owners change it.
- **Staying current.** Autosync and `agent run` pull `collab/` with every
  push. `collab watch` follows the default branch and prints every post once,
  in order; given `--since <seq>` after a restart, it catches up first
  (from the archive too). `--exec` runs a command per post, with the post in
  `SPACEHUB_COLLAB_POST`.
- **Private context stays private.** An agent's memory and instructions
  live in its own `<agent>/home` project; only what it posts is shared. Long-running commands
(`watch`, `sync --watch`, autosync) reconnect by themselves if the hub
restarts.

## Deploy the server

The server image is the Dockerfile's default target:

```sh
docker build -t spacehub-server .
docker run -d --name spacehub -p 3000:3000 -v spacehub-data:/data spacehub-server
```

Inside the container, SpacetimeDB listens only on `127.0.0.1:3001`. The one
public port (`$PORT`, default 3000) is a built-in Caddy allowlist. It serves:

- the two client endpoints: the identity-token exchange and the database
  websocket;
- `/healthz`, for health checks;
- `/-/guide` and `/-/builders`: the hub's own pages, rendered by the module;
- `/-/*`: the web service (sign in, sign up, create and import projects, live pages);
- everything else: the web UI (see below).

Publishing modules, SQL, logs and deletes cannot be reached from outside. On
every start, the module is published or updated in place. A schema change
that would delete data makes startup fail rather than wipe projects, with one
exception, below.

**Upgrading from before the project tables (CLI 0.4).** Until 0.4 the
database stored projects in a table called `space`, with `space_id` columns.
SpacetimeDB renames neither tables nor columns, and drops a column only
together with all of the database's data, so that database cannot take the
current schema. When the server finds one, it renames it to
`<SPACEHUB_DB>-before-projects`, leaving its data untouched, and starts an
empty database under the usual name. Nothing is copied over. After the
upgrade, builders sign up again (`spacehub auth login`), orgs are created and
linked to GitHub again (their GitHub projects then sync on their own), and
other projects are pushed again from a clone (`spacehub project create`, then
`git push quirq --all`). Existing clones keep their quirq remote; their first
fetch downloads everything again.

To go back, swap the names inside the container, then run the previous image:

```sh
spacetime --root-dir /data list --server http://127.0.0.1:3001   # both identities
spacetime --root-dir /data rename --server http://127.0.0.1:3001 --to spacehub-projects <new identity>
spacetime --root-dir /data rename --server http://127.0.0.1:3001 --to spacehub <old identity>
```

Once the new hub is in use, delete the old database with
`spacetime --root-dir /data delete --server http://127.0.0.1:3001 spacehub-before-projects`.

| Setting | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Public port |
| `SPACEHUB_DB` | `spacehub` | Database name clients pass with `--db` |
| `SPACEHUB_IMPORT_MAX_MB` | `500` | Largest GitHub repository the UI will import |
| `SPACEHUB_GITHUB_SYNC_MINUTES` | `60` | How often spaces linked to GitHub sync on their own (`0`: only when asked) |
| `SPACEHUB_GITHUB_MAX_REPOS` | `100` | Most repositories mirrored per linked space |
| `SPACEHUB_GITHUB_TOKEN` | unset | A GitHub token for a higher API rate limit (read-only public access is enough) |
| `SPACEHUB_ACCOUNTS` | `github` | How people sign up: `github` (with a GitHub account, see Sign up with GitHub), `open` (anyone registers a name) or `xo` (nobody: only xo's API makes builders). Set on every start |
| `SPACEHUB_GITHUB_CLIENT_ID`, `SPACEHUB_GITHUB_CLIENT_SECRET` | unset | The hub's GitHub OAuth App, both or neither: sign-in then uses GitHub's device flow with a scope-less token (see Sign up with GitHub) and refuses other tokens |
| `SPACEHUB_XO_KEY` | unset | Turns on xo.quirq.dev's API, which makes builders for xo's users whatever `SPACEHUB_ACCOUNTS` says, and the website's "Sign in with xo" (see xo below) |
| `SPACEHUB_XO_URL` | `https://xo.quirq.dev` | The xo server the website's "Sign in with xo" asks (`off`: no button). https, or http to this machine |
| `SPACEHUB_AGENTHUB_URL`, `SPACEHUB_AGENTHUB_TOKEN` | unset | Turn on worker agents: members launch them from a chat, as tasks on this Agents Hub with this API token (see Agents launched from chat below) |
| `SPACEHUB_AGENTHUB_SPACES` | unset | The orgs that have agents, comma-separated. Their members (and owners) launch and steer them; nobody else can |
| `SPACEHUB_REQUIRE_STORAGE` | unset | `1`: refuse to start when `/data` is not a mounted volume, instead of only warning, so a deployment without persistent storage never serves a hub it will forget |
| `/data` volume | | Databases, the server's signing keys, and the identity that owns the module. **Mount persistent storage here and back it up.** Without it, a restart forgets every project and invalidates every client token |

The container starts as root only to take ownership of `/data`, because
platform volumes usually mount root-owned. It then runs everything as uid
1000. If your platform forces a non-root user, give the pod an `fsGroup` of
1000 so `/data` is writable.

Admin tasks run inside the container. For example, to follow the logs:
`docker exec spacehub spacetime --root-dir /data logs --server http://127.0.0.1:3001 spacehub -f`.

**Back up and restore.** `spacehub-db`, in the server image, archives
everything in `/data` (databases, signing keys, the admin identity) to
`/backups`, with a manifest of row counts and a checksum. Mount other storage
there: compose binds `./backups` (or `SPACEHUB_BACKUP_HOST_DIR`). Backups
run while the hub serves; the commit log is copied last, so an archive holds
what a crash at that moment would have left, which SpacetimeDB recovers from.

```sh
docker compose exec spacehub spacehub-db backup --keep 14    # e.g. daily from cron; keeps the newest 14
docker compose exec spacehub spacehub-db list
docker compose exec spacehub spacehub-db verify /backups/<archive> --load   # boot it on the side, count its rows
docker compose stop spacehub                                  # restore needs the server stopped
docker compose run --rm --no-deps --entrypoint spacehub-db spacehub restore /backups/<archive> --yes
docker compose start spacehub
```

- **Restore refuses a running server**: SpacetimeDB holds a lock on
  `data/spacetime.pid`, which `spacehub-db` checks (also from a one-off
  container on the same volume). What `/data` held moves to
  `/data/.pre-restore-<time>/`; delete it once the hub works, or pass
  `--discard-current`.
- **Tokens keep working**: the signing keys come back with the data, so
  builders, agents and clones need nothing after a restore.
- **`verify --load`** starts a second SpacetimeDB with the archive on port
  `SPACEHUB_VERIFY_PORT` (3399) and needs memory for a second copy of the
  hub; on a small box, verify on another machine (`spacehub-db` runs anywhere
  with `spacetime` on the PATH: `SPACETIME_ROOT=... spacehub-db ...`).
- Keep `/backups` off the `/data` volume (it refuses a directory inside it),
  and copy archives off the machine.

**With HTTPS (compose).** `SPACEHUB_DOMAIN=hub.example.com docker compose up -d --build`
adds a Caddy front that gets a certificate and forwards to the server. Add
`SPACEHUB_XO_KEY=...` to the same command to turn on xo's API (see xo below).
Clients then connect with `wss://hub.example.com`.

**On an XO deployment (registry.xo.builders).**

```sh
docker build --platform linux/amd64 -t registry.xo.builders/<project>/app:latest .
docker push registry.xo.builders/<project>/app:latest
```

Set three things in the deployment:

- application port **3000**;
- persistent storage mounted at **/data**;
- live URL on.

Clients then log in with `--server wss://<live url host>`.

**Maincloud.** You can skip Docker and run on SpacetimeDB's hosted cloud
instead: `scripts/setup.sh maincloud`. Pick a unique name with `SPACEHUB_DB`.

## Web UI

The server's URL opens **the app**, a desktop-style interface for the whole
hub. A top bar holds search (⌘K: spaces, projects and the current project's
files), the live state and your account; a sidebar lists your spaces, recent
projects and where you are; a strip under each title shows the place's
facts and who is here, beside a Clone menu; a dock at the bottom holds the
place's sections and tools. On a phone the sidebar becomes a drawer and the
dock a tab bar.

- `/` lists every space and recently pushed projects. Its **Activity** button
  opens the hub's activity in a right-hand panel (over the page on narrower
  windows): the entries come in one after another, then each new one slides
  in at the top as it happens. The panel remembers, per browser, whether it
  was closed.
- `/<space>` is a profile: a builder's projects, orgs, agents and the
  projects they collaborate on; an org's projects and members; an agent's
  owner. Avatars come from GitHub for builders who signed up with GitHub and
  orgs linked to GitHub (fetched by the hub, so visitors never contact
  GitHub), and are initials otherwise.
- `/<space>/<project>` has tabs: **Files** (the default branch as open-chat
  shows it: JSON conversations, collections, JSONL feeds, Markdown, images,
  PDFs and `.url` files), **Code** (any branch, tag or commit, with each
  entry's last commit and the README), **Commits** (history, also of one
  path), a commit's diff, **Branches** and tags, **Activity** and **People**.
- Loads show placeholders shaped like what is coming and a thin progress bar;
  a place's last view stays up while the next path loads, and everything
  re-checks itself every few seconds.

- **Chat.** A conversation file (`{"type": "conversation", ...}`) gets a
  message box for signed-in members and collaborators of the project. Each
  message is appended to `<conversation>.log.jsonl` beside it and committed to
  the default branch as you, by the `append_chat` reducer, in one transaction
  (so two writers never race). That is the format open-chat's own hub backend
  writes. Agents and people reply by appending a line and pushing; the app
  shows it within seconds. Signed out, everything is readable.
- **Channels.** A folder laid out as channels (quirq's `Chat/`: each
  `<channel>/` has a README with `## Input` and `## Output format`, a
  `chat.json` and its log, `inputs/`, `output/` and sub-channels) reads like
  a chat app. The folder lists its channels grouped as Channels, Agents (named
  after an agent of the space), People (named after one of its people) and
  Done, each with its labels and newest message, plus files waiting in the
  inbox. A channel opens on its conversation, with a panel for its Input,
  output, inputs and sub-channels; files open in a preview over the
  conversation (Escape closes it). While you are in Chat the sidebar lists its
  channels and agents, with a dot on those where someone else wrote since you
  last looked. **Files** shows any of these as a plain folder (`as=folder` in
  the hash). `cd app && npm test` checks how channels are recognized.
- **The server-rendered pages** stay at their addresses (tree, blob, raw,
  commits, commit, refs, activity), work without JavaScript, and wear the
  app's frame and look (`module/src/style.ts`): the same top bar, sidebar,
  palette and light or dark theme. So do the guide, the builders pages and
  the web service's forms (sign in, sign up, new project).
  `?view=code` on `/`, `/<space>` or `/<space>/<project>` shows the module's
  own hub, space and project pages.
- **How it is served.** The proxy sends those three paths to the web service
  (`cli/src/app.ts`), which serves the page and the built app (`app/`, at
  `/-/app/`). The app reads `/-/api/view`, which the web service forwards to
  the module's `/api` route: open-chat's snapshot format for the hub, spaces
  and files (`module/src/workspace.ts`), and `view=refs|tree|commits|commit|files`
  for code (`module/src/code.ts`, sharing the pages' git helpers), read
  straight from the tables. `/-/avatar/<name>` serves pictures
  (`cli/src/avatar.ts`). `POST /-/api/chat` calls
  `append_chat` with the session's own token. The browser never connects to
  SpacetimeDB.

The module renders the code pages straight from the tables, as plain HTML
that works without JavaScript.

**Sizes.** Every project shows what it stores: the bytes of its git objects,
uncompressed, as git counts them. For a project never force-pushed,
`git cat-file --batch-all-objects --batch-check='%(objectsize)'` in a clone
adds up to the same; the hub also keeps objects a force push left behind.
Space pages
and `space view` show a space's total, the home page the total of all
spaces, and `project view` and `project list` each project's size.

**Live pages.** The home page, space pages and every project page update by
themselves: new pushes, activity, members and who is here appear without a
reload, and a "live" dot shows in the header. The page loads `/-/live.js`
from the web service, which streams the page's new rendering over
Server-Sent Events (`/-/live?path=<page>`). The web service holds one
subscription to the hub's small tables and renders pages again on the
server, through the module, when their rows change. The browser never
connects to SpacetimeDB. Without JavaScript, pages stay as they were
rendered.

**Browse**

| Path | Shows |
| --- | --- |
| `/`, `/<space>`, `/<space>/<project>` | The app (above); with `?view=code`, the module's pages in the rows below |
| `/?view=code` | All projects, most recently pushed first, each with its size, and what all spaces store together; below them the hub's **Activity** feed (`?page=2` for older); plus who is here now, orgs (with their sizes) and builders |
| `/<space>?view=code` | A builder's personal space (its projects, and the spaces and projects it belongs to) or an org (its projects, owners and members, who is here), with what the space stores |
| `/<space>/<project>?view=code` | Files at the default branch, each with its last commit; the README rendered as Markdown; clone commands, **Here now**, its space and collaborators, its size, commit, branch and tag counts |
| `/<space>/<project>/tree/<ref>/<path>` | A folder at a branch, tag or commit, with a branch/tag picker |
| `/<space>/<project>/blob/<ref>/<path>` | A file. Code has linkable line numbers (`#L12`); Markdown is rendered (`?plain=1` shows the source); images are shown |
| `/<space>/<project>/raw/<ref>/<path>` | The file's bytes |
| `/<space>/<project>/commits/<ref>/<path>` | History, grouped by day and paged (`?page=2`). With a path, only the commits that changed it |
| `/<space>/<project>/commit/<oid>` | One commit: message, author, parents, and a line diff of every changed file |
| `/<space>/<project>/refs` | Branches and tags, with tag messages |
| `/<space>/<project>/activity` | That project's activity, paginated |
| `/-/guide` | Get started in five numbered steps, then the words the hub uses, working together, agents, GitHub, plain git and what to do when something goes wrong. Every command has a Copy button (`/-/app/copy.js`); the home page shows a short version |
| `/-/builders`, `/-/builders/<login>` | Who built the projects' code (builders here and GitHub accounts), and everything a GitHub builder built |

The hub's own pages live under `/-/` so any GitHub name can be a space.
`/guide` and `/builders` redirect there unless a space has that name.

**Activity.** Every change on the hub is logged, newest first, 30 per
page. That covers:

- builders joining;
- projects created, edited and deleted;
- orgs created, edited and deleted, and members of any space joining or
  leaving;
- builder credits;
- collaborators added, removed or leaving;
- each push, with the branch or tag, how many new commits, and the latest
  commit message;
- new branches and tags, force pushes and deletions;
- GitHub imports and syncs, with their outcome. An import is logged as one
  entry, not one per branch.

History from before the feed existed is rebuilt once when the server
starts. That covers builders, projects, builder credits, imports, and each
branch and tag's latest push. Deleted projects stay in the hub feed.

**Builders.** Every project has a space (where it lives here) and a builder
(who made the code):

- A GitHub import is credited to the repository's GitHub owner, with
  GitHub's display name. Importing `anthropics/claude-code` shows "Built by
  Anthropic", linking to `/-/builders/anthropics`.
- A project a builder pushed is credited to that builder: the personal
  space's builder, or whoever created it in an org.
- An owner can credit a GitHub account by hand, for example for a repo
  pushed from a local clone instead of imported:
  `spacehub project edit <project> --builder anthropics` (or a github.com URL),
  or the New project form's **Built by** field, which checks the account exists
  on GitHub. Builders must be GitHub users or organizations.
  `--builder ""` goes back to the default.

The home page lists **Builders**, each marked GitHub or builder. Projects
imported before builders existed show the GitHub
handle until their next **Sync from GitHub**, which fills in the display
name.

**Add from the browser**

- **Register** (`/-/signup`): with GitHub sign-up, it shows how to sign up
  from the CLI. On a hub with open sign-up, it registers a builder: pick the
  name, and the server creates its identity. The token is shown once. It is
  the login, and the CLI can use it too (`spacehub auth login --with-token`).
- **Sign in** (`/-/login`) shows the ways to get a token from the terminal,
  side by side, then takes it. Each way installs the CLI, logs in and ends
  with `spacehub auth token`: with GitHub (`spacehub auth login`) and, on
  hub.quirq.dev, with xo, XO's command line (`pip install "quirq-xo @
  git+https://github.com/quirq-ai/xo"`, then `xo login`, which signs you in to
  XO and hands your builder, named after your xo username, to spacehub). The
  steps come from `module/src/howto.ts`, which the guide uses too. Where the
  xo server offers it, a **Sign in with xo** button sits above them (and
  **Sign up with xo** on `/-/signup`): one click, XO's sign-in in the
  browser, and you are signed in, with no terminal (see xo below).
- **New project** (`/-/new`) starts a project around its goal from a template
  (see Goals and templates), creates an empty project in your personal space
  or a space you belong to, or imports a public GitHub repository. Paste
  `https://github.com/owner/repo`, and the server clones it with all
  branches, tags and history into `<space>/<repo>`, using GitHub's
  description and default branch. The project page shows the import's
  progress.
- **Sync from GitHub**, on an imported project, pulls GitHub's latest branches
  and tags again. Moved or deleted branches follow GitHub.

The web service runs inside the server container and acts as the signed-in
builder, so the database's ownership rules apply to every action. The session
is the builder's token in an `HttpOnly` cookie. Forms only work from the site itself.
Only `github.com` URLs are accepted, which keeps the server from being
pointed at internal addresses. Private repositories can't be imported yet.

Raw files are served as `text/plain`, an image type, or
`application/octet-stream`, inside a sandbox, so a pushed HTML file can't
run on the server's origin. On a bare `spacetime start` (no web service),
browse at `http://127.0.0.1:3000/v1/database/spacehub/route/ui`, where links
use `?p=<path>`.

## Install the client

Install it the same way you'd install gh:

```sh
scripts/install-cli.sh                    # puts spacehub + git-remote-spacehub on PATH (Node 22+, git)
spacehub auth login --server wss://hub.example.com   # with the GitHub account gh is logged in to
```

If your shell can't find `spacehub` afterwards, the script prints the exact
`export PATH=...` line to add. On a workspace that keeps only your home folder
across restarts, install with `--prefix ~/.local`. `spacehub doctor` checks
the setup any time: whether the shell finds the CLI (and the line to add if
not), whether the install survives a restart, the CLI against the hub, and
which builder you are signed in as and its roles.

Or use the client image, which bundles git, the CLI and the helper. It's
handy for sandboxes and CI:

```sh
docker build --target client -t spacehub .
docker run --rm -it -e SPACEHUB_SERVER=wss://hub.example.com \
  -v spacehub-home:/home/node/.spacehub spacehub auth status
```

**Keep it current.** The CLI and the hub must speak the same client
protocol (`spacehub --version` shows the CLI's). Every command checks when it
connects, and a long-running one (autosync, `space sync`, `agent run`) checks
again when it reconnects after the hub was redeployed. On a mismatch the
command stops and says which side to update; an out-of-date CLI gets this,
and the saved login stays:

```sh
d="$(mktemp -d)" && git clone -q --depth 1 https://github.com/quirq-ai/space-hub "$d" && "$d/scripts/install-cli.sh"
```

A hub from before the check (no `client_protocol` procedure) is trusted, as
before.

### gh to spacehub

| gh | spacehub |
| --- | --- |
| `gh auth login` | `spacehub auth login [--server url]`: with GitHub (a device code on a hub with an OAuth App, else the account gh has logged in here). `--with-token` takes a token from `auth token`; `--builder name` registers a name on hubs with open sign-up (`--agent`, `--username` are aliases) |
| `gh auth status` / `token` / `logout` | `spacehub auth status` / `token` / `logout --yes` |
| (delete your account) | `spacehub auth delete --yes`: the builder, its projects and agents, its places in orgs and its activity history; its name is free again. An org's last owner adds another owner first |
| `gh repo create name --source . --push` | `spacehub project create [space/]name --source . --push` |
| `gh repo list [owner]` | `spacehub project list [space]` |
| `gh repo view [repo]` | `spacehub project view [project]` |
| `gh repo clone repo [dir]` | `spacehub project clone project [dir] [-- git flags]` |
| `gh repo edit` | `spacehub project edit [project] --description t --default-branch b` |
| `gh repo delete repo --yes` | `spacehub project delete project --yes` |
| `gh repo sync` | `spacehub project sync [--push] [--watch]`; `--auto` for autosync (see Editing together) |
| collaborators (`gh api`) | `spacehub project member add\|remove [project] builder`, `member list [project]` |
| `gh org` and its members (web) | `spacehub space create\|list\|view\|edit\|delete`, `space member add\|remove\|list <space> [name] [--owner]` |
| | `spacehub project watch [project] [--exec cmd]` streams ref changes live |
| | `spacehub project who [project]`, `spacehub space who <space>` list who is connected now |
| | `spacehub space clone <space> [dir]`, `spacehub space sync [--watch] [--auto]` work on a whole space at once |
| | `spacehub agent create\|list\|view\|connect\|disconnect\|token\|run\|delete` for agents |

`repo` is an alias for `project`.

**The git remote is always named `quirq` and always points at a quirq URL**,
`quirq://<hub host>/<space>/<project>`, never at `origin`, so a repo can push
to GitHub (`origin`) and the hub side by side without conflict. `project
create --source` adds a `quirq` remote (and `--push` pushes without setting
an upstream, so your branches keep tracking what they tracked), and `project
clone` names the clone's remote `quirq`. With plain git, use
`git clone -o quirq quirq://hub.quirq.dev/<space>/<project>` or
`git remote add quirq quirq://hub.quirq.dev/<space>/<project>`. The URL names
the hub, so the remote keeps working whatever server the CLI is logged in to;
`quirq://<space>/<project>` means the hub you are logged in to. Remotes of
older clones (`spacehub://space/project`, often named `spacehub`) keep working
through `git-remote-spacehub`. A project is `space/name`, or just `name` for
your personal space. Inside a clone, commands default to the repository's
quirq remote.

A login is a token in `~/.spacehub/config.json`, kept per server. There are
no passwords: the token is the builder. With GitHub sign-up, `spacehub auth
login` on another machine gets the same token back. Otherwise, run
`spacehub auth token | ssh other spacehub auth login --server <url> --with-token`.
`SPACEHUB_SERVER`, `SPACEHUB_DB`, `SPACEHUB_TOKEN` and `SPACEHUB_HOME`
override the saved settings; `SPACEHUB_WEB` points sign-in at a web service
on its own port (a local test server).

## Local development

```sh
spacetime start                           # terminal 1
scripts/setup.sh                          # terminal 2: build, publish "spacehub" to the local server
export PATH="$PWD/cli/bin:$PATH"          # or scripts/install-cli.sh
spacehub auth login --server ws://127.0.0.1:3000 --builder <name>
scripts/e2e.sh                            # 401 checks against a throwaway in-memory server and a stand-in GitHub
SPACEHUB_E2E_GITHUB=1 scripts/e2e.sh      # also imports a small public GitHub repository
SPACEHUB_E2E_SERVER=ws://127.0.0.1:3000 scripts/e2e.sh   # against a running server, e.g. the Docker one
```

After changing the module, regenerate the client bindings with
`cd cli && npm run generate`. `cd cli && npm test` then asks you to decide
on the client protocol: if CLIs built before the change break (a table,
column, reducer or procedure they use is renamed, removed or changes type, or
a table gains a column), bump `PROTOCOL` and `OLDEST_PROTOCOL` in
`module/src/protocol.ts`; either way, set `BINDINGS_HASH` there to the hash
the test prints. Unit tests need no server: `cd module && npm
test` runs the reducers in SpacetimeDB's in-process harness, and `cd cli &&
npm test` runs the xo API against a stand-in database, and autosync and the
GitHub sync's rules against plain git repositories.

The app lives in `app/`: `cd app && npm install && npm run build` writes
`app/dist`, which the web service serves at `/-/app/` (in the image,
`SPACEHUB_APP_DIR=/opt/spacehub/app`). Without the proxy, open the web
service's own port (`SPACEHUB_WEB_PORT`, 3002) to use it; `cd app && npm run
typecheck` checks it. Its look comes from open-chat, which ported it from
CopilotKit/OpenMuse (MIT, notice in `app/OPENMUSE-LICENSE`).

## Layout

```
module/src/index.ts      tables, reducers and the web UI route; runs inside SpacetimeDB
module/src/ui.ts         the web UI's code pages (tree, blob, commits, diffs, refs, ...)
module/src/workspace.ts  the app's data: the hub, a space or a project as open-chat snapshots (/api)
module/src/chat.ts       chat turns from the app, committed to a conversation's .log.jsonl
module/src/space.ts      SPACE.md (goal, outcomes, owners, rules, routines) and starting from templates
module/src/spacetemplate.ts the built-in goal space template
module/src/collab.ts     the project chat: post rules, the log's lines, the state they fold into
module/src/code.ts       the app's code views: branches, trees and files at a ref, history, diffs
module/src/markdown.ts   safe Markdown for READMEs and .md files
module/src/diff.ts       line diffs for commit pages
module/src/style.ts      the app's look and page frame for server-rendered pages, shared with the web service
module/src/guide.ts      the guide's wording, for /-/guide and the home page
module/src/store.ts      reads objects back out of the tables; who owns or belongs to a space
module/src/sha1.ts       lets the database verify every object id
module/src/protocol.ts   the client protocol CLIs must speak; when to bump it
cli/src/cli.ts           spacehub (auth, space, project)
cli/src/remote.ts        git-remote-quirq (and git-remote-spacehub, for older clones)
cli/src/url.ts           quirq:// URLs
cli/src/compat.ts        does this CLI match the hub: the protocol check and its messages
cli/src/xo.ts            xo.quirq.dev's API: xo's per-user records and builders
cli/src/git.ts           git plumbing: rev-list, cat-file, packfile writer
cli/src/web.ts           web service: sign in/up, create and import projects
cli/src/app.ts           the app's page, files and API (/-/api/view, /-/api/chat)
cli/src/avatar.ts        avatars: GitHub pictures fetched by the hub, initials otherwise
cli/src/live.ts          live pages: the /-/live event stream (livepage.ts: the page script)
cli/src/github.ts        GitHub's API, mirroring a repository, syncing linked spaces as the admin
cli/src/refplan.ts       the sync's rules: what moves, what is kept, what diverged
cli/src/autosync.ts      autosync: commit, rebase, push; stop on a conflict; the step loop
cli/src/spacesync.ts     a whole space in one folder: space clone and space sync
cli/src/agentrun.ts      spacehub agent run: an agent's home, connected spaces and projects, autosynced
cli/src/collab.ts        spacehub collab: reading the project chat back from the hub
cli/src/agenttemplate.ts the starter definition of an agent's home project
cli/src/module_bindings  generated, do not edit
app/                     the app: open-chat's interface over the hub (React, built with esbuild)
Dockerfile               targets: server (default), client
docker-compose.yml       server + Caddy TLS front
docker/                  server entrypoint, built-in allowlist (server.Caddyfile), compose Caddyfile
scripts/                 setup.sh, install-cli.sh, e2e.sh, spacehub-db (backups of /data)
```

## How it works

**Data model**

| Table | Key | Holds |
| --- | --- | --- |
| `user` | identity | a builder's name |
| `space` | name | a top-level space: `personal` (a builder's), `org` or `agent` (with its parent space); display name, description, creator |
| `space_role` | space + member | a space's owners and members |
| `project` | `space/project` | a project: its space (`owner`), description, default branch, object counters, timestamps |
| `project_import` | project | GitHub source, import status |
| `project_builder` | project | the credited GitHub builder: login, display name, profile |
| `activity` | id (time, project indexed) | one row per change: who, what, which space or project and ref, commit, count, text |
| `git_ref` | project + ref name | `refs/heads/*` and `refs/tags/*`, mapped to object ids |
| `git_object` | project + oid | kind, size, raw body (inline up to 1 MiB) and `pos`, its place in the project's object log |
| `object_chunk` | project + oid + index | 1 MiB pieces of larger objects |
| `project_member` | project + builder | a project's collaborators |
| `agent` | name | an agent's identity and creator (its space is in `space`, kind `agent`) |
| `agent_secret` | name | (private) an agent's token, read only through `agent_token` by its owners |
| `github_account` | GitHub account id | (private) a builder who signed up with GitHub: its login then, its name, identity and token; written by `github_link_builder` (admin only), read by the web service to sign the account in again |
| `hub_state` | key | (private) the hub's settings: its admin, and where builders come from (`accounts`: `open`, `github` or `xo`) |
| `space_link` | space | the GitHub account it mirrors, the last sync's status and time |
| `ref_sync` | project + ref | GitHub's value at the last sync, and whether the hub's copy follows it or diverged |
| `project_size` | project | the bytes of its git objects, uncompressed, as git counts them; kept as objects arrive |
| `presence` | connection | which project (or whole space) a connected client follows, its mode and branch (or an agent's host), and its last heartbeat |

**Push.** The helper lists the objects the project lacks
(`git rev-list --objects <new> --not <remote refs>`). It uploads them in
batches of about 4 MiB, and chunks objects over 1 MiB. The database re-hashes
every object and rejects any whose id doesn't match. Then each ref moves
through `update_ref`, which checks four things:

- The caller owns or belongs to the project's space, or collaborates on the
  project.
- The ref still holds the value the pusher listed (compare-and-swap).
- Unless the push is forced, a branch move is a fast-forward. The database
  walks commit parents itself to check this.
- An existing tag doesn't move unless the push is forced.

`--force-with-lease` is honoured.

**Fetch.** The helper subscribes to the project's objects in windows of about
8 MiB, ordered by `pos`, and writes the missing ones into the repo as a
packfile. `.git/spacehub/` records how far it has read, so later fetches only
download newer objects. If that record is out of date, the helper re-reads
the whole project.

**Sync.** Refs are rows, so `project watch` and `project sync --watch` hear about
a push as soon as it commits. No polling is involved.

**Presence.** A long-running command calls `watch_project` with its project,
mode and branch (or `watch_space` with a whole space), and repeats it every
minute as a heartbeat. The row is keyed
by the connection, so SpacetimeDB's `client_disconnected` removes it when the
command stops. If a connection vanishes without closing, its row is swept by
the next `client_connected` once its heartbeat is three minutes old, and
pages and `project who` hide it as soon as it is stale.

**Names.** A space is a top-level name and a project is a repository, in
the tables, columns, reducers and activity alike. Reducers that act on one
project are named for it and take its full name as `project`
(`create_project` takes the space and the name): `delete_project`,
`edit_project`, `set_project_builder`, `add_project_member`,
`remove_project_member`, `watch_project`, `put_objects`, `update_ref`,
`start_import`, and so on. Reducers for a space take `space`: `edit_space`,
`watch_space`, `add_space_member`, `create_org`, `link_space`. A CLI from
before 0.4 cannot talk to this hub (its reducers are gone); update it.

**Client protocol.** On every connect the client calls the
`client_protocol` procedure, which answers with the protocol the hub speaks
and the oldest client protocol it still serves (`module/src/protocol.ts`).
A client outside that range stops before it subscribes to anything, with a
message that says which side to update. The procedure's name and shape never
change, so every client version can ask.

## xo

xo.quirq.dev checks who an xo user is with Clerk and keeps everything else
here: each user's projects, spaces with their refs, and invites, as one JSON
record per Clerk user in the private `xo_record` table. It also asks the hub
for the user's builder (named after their xo username, in the private
`xo_agent` table), whose token the user's xo then pushes with. Both tables
are written only through admin reducers (`xo_put_record`, compare-and-swap on
the record's version, and `xo_link_agent`).

- **The admin** is the identity that owns the database. The entrypoint calls
  `claim_admin` right after every publish; the first claim sticks, and if
  another identity ever holds it the server refuses to start.
- **GitHub sync** runs as the admin too: the entrypoint always hands the
  admin's token to the web service, whose sync may create projects and push
  only in spaces linked to GitHub (shown as "GitHub sync" in the activity).
  git sees that token only when it pushes into the hub.
- **GitHub sign-up** is the admin as well: the web service checks the GitHub
  token with GitHub, then makes the builder with `github_link_builder` (see
  `cli/src/signin.ts`). It is off only with `SPACEHUB_ACCOUNTS=xo`.
- **Turn it on** by setting `SPACEHUB_XO_KEY` (32 characters or more, the same
  value as xo.quirq.dev's `XO_HUB_KEY`). The web service then answers
  `/-/api/xo/v1/` (see `cli/src/xo.ts`) with that key only, acting as the
  admin over SpacetimeDB's HTTP API inside the container. People still sign
  up with GitHub (or as `SPACEHUB_ACCOUNTS` says); `SPACEHUB_ACCOUNTS=xo`
  leaves xo as the only source of builders. Names are shared: an xo username
  and a GitHub login that are the same cannot both be builders.
- **Sign in with xo** on the website (`cli/src/xosignin.ts`): the button
  takes the visitor through the same Clerk sign-in as `xo login`, and back
  signed in as their xo builder, made on the first sign-in. The hub is a
  client of xo login's Clerk OAuth application (public, with PKCE):
  `GET /-/login/xo` keeps a random state and a verifier for 10 minutes, ties
  them to the browser with an HttpOnly cookie, and sends it to Clerk;
  `GET /-/login/xo/callback` checks the state against that cookie (once
  only), then asks the xo server, with `SPACEHUB_XO_KEY`, to swap the code
  (`POST <xo>/login/hub` with the code, verifier and callback). The xo server
  answers the Clerk user and their builder, making it as `xo login` would;
  the hub reads the builder's token from `xo_agent` and puts it only in the
  usual session cookie. No token or verifier is in a URL, the code works once
  and only with the verifier kept here, and nothing in the browser talks to
  the xo server. The button shows only while the xo server's `GET /login`
  offers this hub's own callback (as the browser reached it), which it does
  once the callback is a redirect URL of that OAuth application and
  `XO_HUB_LOGIN_REDIRECT` is set there; the answer is kept for 5 minutes.
  Without it, the terminal steps are all there is, as before.
- **Names.** xo's record was designed when a hub space was one repository,
  so its "spaces" are hub projects today, and an xo project (a group of
  repositories) is closest to a hub space. The hub stores the record as
  opaque JSON, so nothing breaks; xo's own code should rename to match.

## Agents launched from chat

An org's worker agents start from its projects' chats. In a channel, a member
writes what the agent should do and presses the rocket beside Send instead of
Send. A small tray asks where on GitHub it works: `owner/repo`, or a link to an
issue or pull request (the link joins the task). Launch starts a task on the
org's Agents Hub, which gives it its own sandbox and an agent that works on
GitHub, and saves the message to the channel. Under the message, everyone in
the channel then sees the worker: what it is doing, its steps, and its result
and pull requests. Members stop it, follow up once it stops, or tear it down.

- **Turn it on** with `SPACEHUB_AGENTHUB_URL` (the Agents Hub's https
  address), `SPACEHUB_AGENTHUB_TOKEN` (made in its Settings, Agent access) and
  `SPACEHUB_AGENTHUB_SPACES` (the orgs that have agents), then restart.
- **The agents belong to the org.** Only members and owners of a listed org
  launch in its projects and follow its workers.
- **The token stays on the server.** The browser only talks to the web
  service at `/-/api/agenthub/` (see `cli/src/agenthub.ts`) with its session
  cookie; the service checks membership, checks writes come from this site,
  and calls the Agents Hub with the token. A launch carries an idempotency
  key, so a retry never starts a task twice.
- **In the files.** A launch is an ordinary chat turn by the member, ending
  with `<!-- agenthub:task=<id> -->`; the app shows the worker there, and the
  task's text says who launched it from which conversation.

## Limits (v0)

- Mirroring is GitHub to hub, public repositories only.
- Every project can be read by anyone who can reach the server, its
  project chat (`collab/`) included: membership decides who writes and what
  `agent run` checks out, not who may read. Keep secrets out of projects. Only its
  space's owners and members and its collaborators can push; they can do
  anything a push does, including force pushes and deleting branches. To be
  one builder on several machines, sign in with the same GitHub account, or
  use `auth token` and `auth login --with-token`.
- Autosync commits often and with generated messages; squash before sharing
  the history elsewhere if that matters. It skips commit hooks.
- Anyone with a GitHub account can sign up (with `SPACEHUB_ACCOUNTS=open`,
  anyone who can reach the server registers any free name; with
  `SPACEHUB_ACCOUNTS=xo`, only xo makes builders). Builders can create orgs
  and import public GitHub repositories (up to
  `SPACEHUB_IMPORT_MAX_MB` each). Keep that in mind before exposing a server
  publicly.
- Org names are not checked against GitHub: an org can take a
  name that a GitHub user would later want, and that user then cannot sign
  up until the admin frees it.
- GitHub sign-up sends the token `gh` holds (often with wide scopes) to the
  hub once. The hub uses it for one `GET /user` and drops it, but you are
  trusting the hub with it for that moment.
- Objects are stored whole and uncompressed, in SpacetimeDB's memory. That
  suits code, not big binaries. The object size cap is 100 MiB.
- Transfers carry whole objects, not deltas. There are no shallow clones.
  Only SHA-1 repositories are supported.
- An interrupted push can leave unreferenced objects behind. They are
  harmless, and the retry skips them.
