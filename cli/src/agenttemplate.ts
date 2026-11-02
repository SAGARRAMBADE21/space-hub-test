// The starter definition `spacehub agent create` puts in an agent's home
// project, in the xo-agent-template layout. Owners rewrite it; the agent
// keeps MEMORY.md and memory/ current as it works (autosync pushes them).
export function agentTemplate(name: string, description: string): Record<string, string> {
  const role = description.trim() || 'What it does, in one line.';
  return {
    'README.md': `# ${name}

The definition of the agent **${name}**: who it is, how it works, and what it
remembers. \`spacehub agent run ${name}\` checks this project out next to the
spaces ${name} is connected to and keeps them all in sync.

| File | Holds |
| --- | --- |
| \`IDENTITY.md\` | name and role |
| \`SOUL.md\` | voice and values |
| \`AGENTS.md\` | how it works: routine, rules, where things are |
| \`USER.md\` | who it works for |
| \`TOOLS.md\` | the tools and accounts it may use |
| \`MEMORY.md\`, \`memory/\` | what it learned and keeps |
| \`skills/\` | its skills |
`,
    'IDENTITY.md': `# Identity

## Name

${name}

## Role

${role}
`,
    'SOUL.md': `# Soul

Who ${name} is: its voice, its values, how it talks and decides.
`,
    'AGENTS.md': `# AGENTS.md

How ${name} works.

- Its workspace is the folder \`spacehub agent run\` made: \`${name}/home\` (this
  project) and one folder per connected space, each holding that space's
  projects.
- Files it edits are committed and pushed every few seconds; others' pushes
  arrive the same way. When a conflict pauses a project, resolve it there
  (git status) before going on.
- Keep what is worth remembering in MEMORY.md and memory/.

## Working with others: the project chat

Every project you work in has one conversation, shared by its people and
the agents they brought: \`collab/\` in the project.

- **Catch up first.** Before working in a project, read its \`SPACE.md\` (the
  goal, outcomes and rules it is for), then \`collab/state.json\`
  (the goal, decisions, findings, open tasks and their owners, and each
  participant's latest status), then the end of \`collab/chat.log.jsonl\`.
  Work toward the latest goal and decisions, not what you assumed earlier.
- **Never edit \`collab/\` yourself**; the hub refuses such pushes. Post with
  \`spacehub collab post "<text>"\` from inside the project's folder:
  \`--type finding\` for something others should know, \`--type decision\` once
  agreed, \`--type status\` for what you are doing now, \`--to <name>\` to address
  someone. Each post is attributed to you and to the person you work for.
- **Tasks.** \`spacehub collab task <id> --claim\` to take one nobody owns;
  \`--status in_progress|blocked|done\` as it moves; \`spacehub collab handoff
  <id> <name> "<what is done, what is left>"\` to pass it on. Only take tasks
  you are given or that nobody owns.
- **Stay current.** \`spacehub collab watch --json --since <last seq you read>\`
  prints each new post as it lands; after a restart, carry on from the last
  \`seq\` you saw. Posts with the same \`--id\` count once, so resending is safe.
- Keep private notes in this home project, not in the chat.
`,
    'USER.md': `# User

Who ${name} works for, and how they like to work.
`,
    'TOOLS.md': `# Tools

The tools and accounts ${name} may use.
`,
    'MEMORY.md': `# Memory

What ${name} has learned and wants to keep.
`,
    'memory/.gitkeep': '',
    'skills/.gitkeep': '',
  };
}
