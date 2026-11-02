#!/usr/bin/env node
// Plug your own Cowork into a project: connect it to the cowork chat, follow
// what reaches it, and hand each envelope to your local agent runtime.
//
//   node scripts/cowork-bridge.mjs <space>/<project> <cowork-id> [--agents claude_code,codex]
//        [--workdir <clone>] [--auto-accept] [--delegators project|owners|<builder,...>]
//
// The bridge is the only piece that knows both sides, and it talks to each
// through a narrow door: to the hub through `spacehub cowork` (so other
// coworks only ever see envelopes), and to your runtime through one command,
// COWORK_AGENT_CMD, which reads a prompt on stdin and prints its answer
// (default: `claude -p`; point it at xo-space or anything else). Your tools,
// keys and memory stay in your runtime.
//
// - request / message to you      → the runtime answers it, threaded under it
// - delegate to you               → offered to you; with --auto-accept the
//                                   runtime works on it in --workdir on your
//                                   cowork branch, then the bridge commits,
//                                   pushes, reports done and announces a sync
// - sync from another cowork      → git fetch in --workdir, so their branch is local
//
// Run it logged in as yourself (spacehub auth login). SPACEHUB_CLI picks the
// CLI (default: this checkout's cli/dist/cli.mjs).
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = process.env.SPACEHUB_CLI || path.resolve(here, '../cli/dist/cli.mjs');
const AGENT_CMD = process.env.COWORK_AGENT_CMD || 'claude -p --output-format text';

const cli = (args, cwd) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Ask the local runtime; the prompt goes on stdin so its size never hits argv limits.
function runAgent(prompt, cwd) {
  try {
    return execFileSync('sh', ['-c', AGENT_CMD], { input: prompt, encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30 * 60_000 }).trim();
  } catch (error) {
    console.error(`cowork-bridge: the agent failed: ${error.message}`);
    return '';
  }
}

async function handle() {
  const post = JSON.parse(process.env.SPACEHUB_COWORK_POST || '{}');
  const project = process.env.SPACEHUB_COWORK_PROJECT;
  const me = process.env.SPACEHUB_COWORK;
  const workdir = process.env.COWORK_BRIDGE_WORKDIR || '';
  const autoAccept = process.env.COWORK_BRIDGE_AUTO_ACCEPT === '1';
  const p = ['-p', project];
  const brief = () => {
    try {
      return cli(['cowork', 'context', ...p], workdir || undefined);
    } catch {
      return '(the shared context is not available right now)';
    }
  };

  if (post.cowork === me) return; // our own envelopes
  const owner = process.env.COWORK_BRIDGE_OWNER || '';
  const forMe = (post.to ?? []).some(to => to === '*' || to === `@${owner}` || to.split(':')[0] === me) || post.delegation?.to?.split(':')[0] === me;

  if (post.type === 'sync' && workdir) {
    try {
      git(workdir, 'fetch', '--quiet', 'quirq');
      console.log(`cowork-bridge: fetched ${post.sync?.branch} from ${post.cowork}`);
    } catch (error) {
      console.error(`cowork-bridge: fetch failed: ${error.message}`);
    }
    return;
  }

  if (!forMe) return;
  // Agents' chat is not answered by agents, so two bridges never talk in a loop;
  // agents that need something from each other send a request.
  if (post.type === 'message' && post.role === 'assistant') return;

  if (post.type === 'request' || post.type === 'message') {
    const prompt = [
      brief(),
      '',
      `## Envelope #${post.seq} (${post.type}) from ${post.from}`,
      post.content,
      '',
      'Answer it for your cowork, briefly. If it needs work you cannot do from here, say what you would need.',
    ].join('\n');
    const reply = runAgent(prompt, workdir || undefined);
    if (!reply) return;
    if (post.type === 'request') cli(['cowork', 'answer', ...p, post.id, reply]);
    else cli(['cowork', 'say', ...p, '--reply-to', post.id, '--to', post.cowork ? post.from : `@${post.user}`, reply]);
    console.log(`cowork-bridge: answered #${post.seq} from ${post.from}`);
    return;
  }

  if (post.type === 'delegate' && post.delegation?.status === 'offered') {
    const id = post.delegation.id;
    if (!autoAccept) {
      console.log(`cowork-bridge: ${post.from} offers "${id}": ${post.delegation.title}. Accept with: spacehub cowork accept -p ${project} ${id}`);
      return;
    }
    if (!workdir) {
      cli(['cowork', 'decline', ...p, id, 'This cowork runs without a working copy (--workdir), so it cannot take work.']);
      return;
    }
    cli(['cowork', 'accept', ...p, id, 'On it.']);
    const status = JSON.parse(cli(['cowork', 'status', ...p, '--json']));
    const branch = status.coworks?.[me]?.branch || `cowork/${me}`;
    try {
      git(workdir, 'fetch', '--quiet', 'quirq');
      git(workdir, 'checkout', '-B', branch);
    } catch (error) {
      cli(['cowork', 'done', ...p, id, '--failed', `Could not check out ${branch}: ${error.message}`]);
      return;
    }
    const summary = runAgent([brief(), '', `## Delegated to you: ${id}`, post.delegation.title, '', post.content, '', `Do this work in the current directory (branch ${branch}). Do not touch collab/. When you finish, reply with a short summary of what you changed.`].join('\n'), workdir);
    if (!summary) {
      cli(['cowork', 'done', ...p, id, '--failed', 'The agent stopped without a result.']);
      return;
    }
    try {
      git(workdir, 'add', '-A', '--', '.', ':!collab');
      if (git(workdir, 'status', '--porcelain', '--', '.', ':!collab')) git(workdir, 'commit', '-q', '-m', `${id}: ${post.delegation.title}`);
      git(workdir, 'push', '--quiet', 'quirq', `HEAD:refs/heads/${branch}`);
      const commit = git(workdir, 'rev-parse', 'HEAD');
      cli(['cowork', 'done', ...p, id, '--commit', commit, '--branch', branch, summary.slice(0, 3900)], workdir);
      cli(['cowork', 'sync', ...p, `${id}: ${post.delegation.title}`], workdir);
      console.log(`cowork-bridge: finished "${id}" at ${commit.slice(0, 10)}`);
    } catch (error) {
      cli(['cowork', 'done', ...p, id, '--failed', `Could not push the work: ${error.message}`]);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const flag = name => {
    const at = args.indexOf(name);
    return at >= 0 ? args.splice(at, 2)[1] : undefined;
  };
  const autoAccept = args.includes('--auto-accept') ? (args.splice(args.indexOf('--auto-accept'), 1), true) : false;
  const agents = flag('--agents') ?? 'claude_code';
  const workdirArg = flag('--workdir');
  const workdir = workdirArg ? path.resolve(workdirArg) : '';
  const delegators = flag('--delegators');
  const [project, cowork] = args;
  if (!project?.includes('/') || !cowork) {
    console.error('usage: node scripts/cowork-bridge.mjs <space>/<project> <cowork-id> [--agents a,b] [--workdir <clone>] [--auto-accept] [--delegators ...]');
    process.exit(2);
  }
  const connect = ['cowork', 'connect', '-p', project, cowork, '--agents', agents, '--client', 'cowork-bridge'];
  if (workdir) connect.push('--branch', `cowork/${cowork}`);
  if (delegators) connect.push('--delegators', delegators);
  if (!workdir) connect.push('--accepts', 'request');
  console.log(cli(connect).trim());

  const owner = JSON.parse(cli(['cowork', 'status', '-p', project, '--json'])).coworks?.[cowork]?.owner ?? '';
  // Every envelope, not just --mine: other coworks' syncs name no recipient.
  const watch = ['cowork', 'watch', '-p', project, '--cowork', cowork, '--exec', `"${process.execPath}" "${fileURLToPath(import.meta.url)}" --handle`];
  console.log(`cowork-bridge: ${cowork} is listening in ${project}${autoAccept ? ' and takes delegated work' : ''}`);
  const child = spawn(process.execPath, [CLI, ...watch], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, COWORK_BRIDGE_WORKDIR: workdir, COWORK_BRIDGE_AUTO_ACCEPT: autoAccept ? '1' : '', COWORK_BRIDGE_OWNER: owner },
  });
  const stop = () => {
    try {
      cli(['cowork', 'disconnect', '-p', project, cowork, 'bridge stopped']);
    } catch {
      /* The hub may be gone; the record says offline once it hears from us again. */
    }
    child.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', code => process.exit(code ?? 1));
}

if (process.argv[2] === '--handle') await handle();
else main();
