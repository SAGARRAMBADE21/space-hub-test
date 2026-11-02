#!/usr/bin/env node
// Give an agent a voice in a project chat: follow the chat, and when a post
// names the agent (or is sent --to it), ask Claude Code for a reply and post
// it as the agent, threaded under the post.
//
//   node scripts/agent-chat.mjs <agent> <space>/<project> [--since <seq>]
//
// Run it logged in (spacehub auth login) as one of the agent's owners: it
// reads the agent's token with `agent token` and posts with it. It remembers
// the last post it handled in ~/.spacehub/agent-chat/, so a restart neither
// misses posts nor answers twice. Needs `claude` (Claude Code) on the PATH.
// SPACEHUB_CLI picks the CLI (default: this checkout's cli/dist/cli.mjs);
// AGENT_CHAT_MODEL picks the Claude model (default: Claude Code's).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = process.env.SPACEHUB_CLI || path.resolve(here, '../cli/dist/cli.mjs');
const cli = (args, env = {}) =>
  execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });

function stateFile(agent, project) {
  const dir = path.join(os.homedir(), '.spacehub', 'agent-chat');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${agent}__${project.replace('/', '__')}.seq`);
}

// One post, handed over by `collab watch --exec` in SPACEHUB_COLLAB_POST.
async function handle() {
  const agent = process.env.AGENT_CHAT_AGENT;
  const project = process.env.AGENT_CHAT_PROJECT;
  const token = process.env.AGENT_CHAT_TOKEN;
  const post = JSON.parse(process.env.SPACEHUB_COLLAB_POST || '{}');
  fs.writeFileSync(stateFile(agent, project), String(post.seq ?? ''));

  if (post.author === agent || post.agent === agent || post.type === 'join') return;
  const text = String(post.content ?? '');
  const named = new RegExp(`(^|[^a-z0-9-])@?${agent.replace(/[-]/g, '\\-')}([^a-z0-9-]|$)`, 'i').test(text);
  const sentTo = Array.isArray(post.to) && post.to.includes(agent);
  if (!named && !sentTo) return;

  let state = '';
  try {
    state = cli(['collab', 'state', '-p', project]);
  } catch {
    /* Reply without the summary rather than not at all. */
  }
  const prompt = [
    `You are "${agent}", an AI agent working on the project ${project}, chatting with its people in the project chat.`,
    `Reply to the message below in plain, short chat style (a few sentences, Markdown allowed). Do not use tools; just answer.`,
    `If you are asked to do work you cannot do from the chat, say what you would need.`,
    '',
    `The chat so far (summary):`,
    state.trim() || '(not available)',
    '',
    `Message #${post.seq} from ${post.author}:`,
    text,
  ].join('\n');

  const args = ['-p', prompt, '--output-format', 'text'];
  if (process.env.AGENT_CHAT_MODEL) args.push('--model', process.env.AGENT_CHAT_MODEL);
  let reply = '';
  try {
    reply = execFileSync('claude', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, cwd: os.tmpdir() }).trim();
  } catch (error) {
    console.error(`agent-chat: claude failed on #${post.seq}: ${error.message}`);
    reply = `Sorry ${post.author}, I could not think of a reply just now. Try again in a moment.`;
  }
  if (!reply) return;
  cli(['collab', 'post', '-p', project, '--reply-to', String(post.id), '--to', String(post.author), reply], { SPACEHUB_TOKEN: token });
  console.log(`agent-chat: replied to #${post.seq} from ${post.author}`);
}

function main() {
  const args = process.argv.slice(2);
  const sinceAt = args.indexOf('--since');
  const sinceArg = sinceAt >= 0 ? args.splice(sinceAt, 2)[1] : undefined;
  const [agent, project] = args;
  if (!agent || !project || !project.includes('/')) {
    console.error('usage: node scripts/agent-chat.mjs <agent> <space>/<project> [--since <seq>]');
    process.exit(2);
  }
  const token = cli(['agent', 'token', agent]).match(/eyJ[A-Za-z0-9_.-]+/)?.[0];
  if (!token) {
    console.error(`agent-chat: could not read the token of ${agent}; log in as one of its owners`);
    process.exit(1);
  }
  let since = sinceArg;
  if (since === undefined) {
    try {
      since = fs.readFileSync(stateFile(agent, project), 'utf8').trim() || undefined;
    } catch {
      /* First run: only posts from now on. */
    }
  }
  const watch = ['collab', 'watch', '-p', project, '--exec', `"${process.execPath}" "${fileURLToPath(import.meta.url)}" --handle`];
  if (since !== undefined) watch.push('--since', since);
  console.log(`agent-chat: ${agent} is listening in ${project}${since !== undefined ? ` after #${since}` : ''}`);
  const child = spawn(process.execPath, [CLI, ...watch], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, AGENT_CHAT_AGENT: agent, AGENT_CHAT_PROJECT: project, AGENT_CHAT_TOKEN: token },
  });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', code => process.exit(code ?? 1));
}

if (process.argv[2] === '--handle') await handle();
else main();
