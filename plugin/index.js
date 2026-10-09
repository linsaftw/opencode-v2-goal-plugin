// OpenCode 2 persistent goal runner. Only the host's execution stream drives reruns.
// No timer, iteration, context-token, tool-call, or no-progress limit is imposed.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const ID = 'local.goal-autopilot-v3';
const COMMAND = /^<opencode-goal-control v="3">\n([\s\S]*?)\n<\/opencode-goal-control>\s*$/;
const CONTINUE = /^<opencode-goal-continuation v="3" token="([a-f0-9-]+)">\n([\s\S]*)$/;
const ROOT = () => process.env.OPENCODE_GOAL_STATE_DIR || join(homedir(), '.local', 'state', 'opencode-goal-autopilot-v3');
const fileFor = id => join(ROOT(), createHash('sha256').update(id).digest('hex') + '.json');
const objectiveFor = (id, goalID) => join(ROOT(), createHash('sha256').update(id).digest('hex') + '-' + goalID + '.md');
const errText = error => error instanceof Error ? error.message : String(error);
// This is a prompt-size optimization, NOT an objective size restriction.
const INLINE_THRESHOLD = 12_000;
const INITIAL_INLINE_THRESHOLD = 96_000;

export function parseCommand(input) {
  const value = String(input ?? '').trim();
  if (!value || value.toLowerCase() === 'status') return { kind: 'status' };
  if (/^(pause|resume|clear|help)$/i.test(value)) return { kind: value.toLowerCase() };
  if (/^--file(?:\s|$)/i.test(value)) {
    const raw = value.slice(6).trim();
    if (!raw) return { kind: 'error', message: 'Usage: /goal --file /path/to/objective.md' };
    const path = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1) : raw;
    if (!path.trim()) return { kind: 'error', message: 'Objective file path cannot be empty.' };
    return { kind: 'file', path };
  }
  return { kind: 'start', objective: value };
}

export async function loadState(sessionID) {
  try {
    const parsed = JSON.parse(await fs.readFile(fileFor(sessionID), 'utf8'));
    if (parsed?.version !== 3 || parsed.sessionID !== sessionID ||
        typeof parsed.objective !== 'string' || typeof parsed.status !== 'string') {
      throw new Error('Goal state is incompatible or corrupt. File: ' + fileFor(sessionID));
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function saveState(state) {
  const root = ROOT();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const target = fileFor(state.sessionID);
  const temp = target + '.' + process.pid + '.' + randomUUID() + '.tmp';
  state.updatedAt = Date.now();
  try {
    await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

// Snapshot an objective into its own private, immutable-per-goal file. A later
// edit to the source --file does not silently change the active requirements.
export async function saveObjective(sessionID, goalID, objective) {
  const target = objectiveFor(sessionID, goalID);
  await fs.mkdir(ROOT(), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, objective, { mode: 0o600, flag: 'wx' });
  return target;
}

export async function eraseState(sessionID) {
  const state = await loadState(sessionID);
  await fs.rm(fileFor(sessionID), { force: true });
  if (state?.goalID) await fs.rm(objectiveFor(sessionID, state.goalID), { force: true });
}

function instruction(state, { initial = false } = {}) {
  const inline = state.source !== 'file' &&
    (state.objective.length <= INLINE_THRESHOLD || (initial && state.objective.length <= INITIAL_INLINE_THRESHOLD));
  const source = inline
    ? ['<objective>', state.objective, '</objective>'].join('\n')
    : [
      'The COMPLETE objective is stored privately and available through the goal_read tool.',
      'Call goal_read({offset:0}) and follow nextOffset until the entire objective has been read.',
      'It may take multiple calls. Do not assume the first page contains every requirement.',
      `Optional on-disk snapshot: ${state.objectivePath}`,
      `Objective SHA-256: ${createHash('sha256').update(state.objective).digest('hex')}`,
      'Before implementation or completion review, READ THE ENTIRE objective through goal_read.',
      'Treat every requirement in that file as binding; do not rely on a shortened summary.',
    ].join('\n');
  return [
    'ACTIVE AUTONOMOUS GOAL. Treat this objective as binding until it is complete or explicitly stopped:',
    source,
    'A persistent runner will re-submit a turn whenever execution succeeds while this goal remains active.',
    'There is NO time limit, turn count limit, or inactivity cutoff. Do not declare success to end a turn.',
    'Perform real engineering work. Read actual source, trace defects, implement, run relevant tests, inspect results, and fix failures.',
    'Each time you think you are done, re-audit EVERY requirement against CURRENT evidence (tests, artifacts, actual behavior).',
    'Call goal_complete({summary, evidence}) ONLY if every requirement has been verified with concrete evidence.',
    'The evidence must describe the checked artifacts/tests and their real outcomes; never invent test results.',
    'Call goal_blocked({reason}) ONLY when further authorized progress genuinely needs external input or permissions.',
    'If work remains, do the next concrete action rather than producing a final status reply.',
    'Do not bypass host permissions, security checks, or user instructions.',
  ].join('\n');
}

function describe(state) {
  if (!state) return 'No saved goal for this session.';
  // Status must remain usable for goals that are many megabytes long.
  return [`Objective: ${state.objective.length <= 400 ? state.objective : state.objective.slice(0, 400) + '…'}`,
    `Objective characters: ${state.objective.length}`,
    state.objectivePath ? `Full objective file: ${state.objectivePath}` : '',
    `Status: ${state.status}`, `Agent executions: ${state.turns}`,
    `Started: ${new Date(state.createdAt).toISOString()}`,
    state.reason ? `Reason: ${state.reason}` : '',
    state.evidence ? `Completion evidence: ${state.evidence}` : '',
  ].filter(Boolean).join('\n');
}

const stringProperty = { type: 'string', minLength: 1 };
const completionSchema = {
  type: 'object', properties: { summary: stringProperty, evidence: stringProperty },
  required: ['summary', 'evidence'], additionalProperties: false,
};
const blockerSchema = {
  type: 'object', properties: { reason: stringProperty }, required: ['reason'], additionalProperties: false,
};
const readSchema = {
  type: 'object',
  properties: {
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 20_000 },
  },
  additionalProperties: false,
};

// Use the OpenCode 2 ToolEditor.add({name, input, execute}) API directly.
export function buildPlugin() {
  return {
    id: ID,
    async setup(ctx) {
      const states = new Map();
      const expected = new Map();
      const controls = new Set();
      const executions = new Map();
      let closed = false;
      const abort = new AbortController();

      async function getState(sessionID) {
        if (states.has(sessionID)) return states.get(sessionID);
        const found = await loadState(sessionID);
        if (found) states.set(sessionID, found);
        return found;
      }

      async function stop(state, status, reason, evidence = '') {
        state.status = status;
        state.reason = reason;
        state.evidence = evidence;
        state.inFlight = false;
        state.started = false;
        expected.delete(state.sessionID);
        await saveState(state);
      }

      async function createGoal(id, objective, source) {
        if (!objective.trim()) throw new Error('The objective file is empty.');
        const goalID = randomUUID();
        const objectivePath = await saveObjective(id, goalID, objective);
        const old = await getState(id);
        const created = {
          version: 3, sessionID: id, goalID, objectivePath, objective, source, status: 'active',
          turns: 0, createdAt: Date.now(), updatedAt: Date.now(), reason: '', evidence: '',
          started: false, inFlight: true,
        };
        try { await saveState(created); }
        catch (error) { await fs.rm(objectivePath, { force: true }); throw error; }
        states.set(id, created);
        if (old?.goalID) await fs.rm(objectiveFor(id, old.goalID), { force: true }).catch(() => {});
        expected.delete(id);
        return created;
      }

      function unlinkStaleMentions(event) {
        // Prompt text is replaced; attached files still resolve, but offsets
        // into the old text no longer identify a valid mention.
        for (const file of event.prompt.files ?? []) {
          if (file && typeof file === 'object') delete file.mention;
        }
      }

      // The explicit model-facing tools are state transitions, not language tokens.
      await ctx.tool.transform(tools => {
        tools.add({
          name: 'goal_read',
          description: 'Read the current session goal verbatim in pages. Follow nextOffset until end to inspect every requirement; no external directory permission is required.',
          input: readSchema,
          execute: async ({ offset = 0, limit = 12_000 }, executionContext) => {
            const state = await getState(executionContext.sessionID);
            if (!state) return { content: 'No saved goal in this session.' };
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20_000) {
              return { content: 'Invalid offset or limit. offset must be nonnegative; limit must be 1..20000.' };
            }
            const nextOffset = Math.min(offset + limit, state.objective.length);
            return { content: JSON.stringify({
              offset, nextOffset, totalCharacters: state.objective.length,
              text: state.objective.slice(offset, nextOffset),
            }) };
          },
          options: { codemode: false },
        });
        tools.add({
          name: 'goal_complete',
          description: 'Finish the active /goal only after inspecting real test and implementation evidence for every requirement.',
          input: completionSchema,
          execute: async ({ summary, evidence }, executionContext) => {
            const state = await getState(executionContext.sessionID);
            if (!state || state.status !== 'active') return { content: 'No active goal; completion was not recorded.' };
            if (typeof summary !== 'string' || !summary.trim() || typeof evidence !== 'string' || !evidence.trim()) {
              return { content: 'Rejected: summary and concrete verification evidence are required.' };
            }
            await stop(state, 'complete', summary.trim(), evidence.trim());
            return { content: 'Goal marked complete. Report the concrete evidence and stop working.' };
          },
          options: { codemode: false },
        });
        tools.add({
          name: 'goal_blocked',
          description: 'End the active /goal only when progress requires missing permission/input or has a genuine external blocker.',
          input: blockerSchema,
          execute: async ({ reason }, executionContext) => {
            const state = await getState(executionContext.sessionID);
            if (!state || state.status !== 'active') return { content: 'No active goal; blocker was not recorded.' };
            if (typeof reason !== 'string' || !reason.trim()) return { content: 'Rejected: explain the concrete blocker.' };
            await stop(state, 'blocked', reason.trim());
            return { content: 'Goal blocked. Explain the blocker to the user.' };
          },
          options: { codemode: false },
        });
      });

      await ctx.session.hook('prompt', async event => {
        const id = event?.sessionID;
        if (closed || typeof id !== 'string' || !id) return;
        const text = typeof event.prompt?.text === 'string' ? event.prompt.text : '';
        const next = CONTINUE.exec(text);
        if (next && expected.get(id) === next[1]) {
          expected.delete(id);
          event.prompt.text = next[2];
          return;
        }
        const match = COMMAND.exec(text);
        if (!match) {
          const active = await getState(id);
          if (active?.status === 'active') await stop(active, 'paused',
            next ? 'Unexpected goal continuation token; possible stale or duplicate prompt' :
              'User sent another message during the goal');
          return;
        }
        const parsed = parseCommand(match[1]);
        // Control requests always create one ordinary chat turn. They must not launch another continuation.
        if (parsed.kind !== 'start' && parsed.kind !== 'file' && parsed.kind !== 'resume') controls.add(id);
        else controls.delete(id);
        const state = await getState(id);
        if (parsed.kind === 'start' || parsed.kind === 'file') {
          let objective = parsed.objective;
          if (parsed.kind === 'file') {
            try {
              const path = parsed.path.startsWith('~/') ? join(homedir(), parsed.path.slice(2))
                : isAbsolute(parsed.path) ? parsed.path : resolve(ctx.location?.directory ?? process.cwd(), parsed.path);
              const info = await fs.stat(path);
              if (!info.isFile()) throw new Error('Not a regular file: ' + path);
              objective = await fs.readFile(path, 'utf8');
            } catch (error) {
              controls.add(id);
              event.prompt.text = 'Goal file error: ' + errText(error) + '. Do not modify files.';
              unlinkStaleMentions(event);
              return;
            }
          }
          let created;
          try { created = await createGoal(id, objective, parsed.kind); }
          catch (error) {
            controls.add(id);
            event.prompt.text = 'Goal creation error: ' + errText(error) + '. Do not modify files.';
            unlinkStaleMentions(event);
            return;
          }
          event.prompt.text = 'BEGIN GOAL EXECUTION.\n' + instruction(created, { initial: true }) + '\nStart implementing now.';
          unlinkStaleMentions(event);
          return;
        }
        if (parsed.kind === 'help') {
          event.prompt.text = 'Commands: /goal <objective>, /goal --file <path>, /goal status, /goal pause, /goal resume, /goal clear. No time or turn caps. Report only; do not use tools.';
          return;
        }
        if (parsed.kind === 'error') {
          event.prompt.text = `Goal command error: ${parsed.message} Do not modify files.`;
          return;
        }
        if (parsed.kind === 'clear') {
          if (state) { states.delete(id); expected.delete(id); await eraseState(id); }
          event.prompt.text = 'Goal cleared. Do not modify files in this turn.';
          return;
        }
        if (!state) {
          event.prompt.text = 'No saved goal. Run /goal <objective>. Do not modify files.';
          return;
        }
        if (parsed.kind === 'status') {
          event.prompt.text = describe(state) + '\nReport status only. Do not use tools.';
          return;
        }
        if (parsed.kind === 'pause') {
          await stop(state, 'paused', 'Paused by user');
          event.prompt.text = describe(state) + '\nDo not modify files.';
          return;
        }
        if (parsed.kind === 'resume') {
          if (state.status === 'complete') {
            event.prompt.text = describe(state) + '\nThis objective has been completed. Start a new goal to reopen work.';
            controls.add(id);
            return;
          }
          state.status = 'active';
          state.reason = '';
          state.evidence = '';
          state.started = false;
          state.inFlight = true;
          await saveState(state);
          event.prompt.text = 'RESUME GOAL EXECUTION.\n' + instruction(state) + '\nInspect current state and continue.';
        }
      });

      await ctx.session.hook('context', async event => {
        if (!Array.isArray(event?.system) || typeof event.sessionID !== 'string') return;
        if (controls.has(event.sessionID)) {
          event.system.push({ type: 'text', text: 'GOAL CONTROL TURN: Only report status. Do not call tools or modify files.' });
          return;
        }
        const state = await getState(event.sessionID);
        if (state?.status === 'active') event.system.push({ type: 'text', text: instruction(state) });
      });

      await ctx.session.hook('compaction', async event => {
        if (!Array.isArray(event?.system) || typeof event.sessionID !== 'string') return;
        const state = await getState(event.sessionID);
        if (state?.status === 'active') event.system.push({ type: 'text', text: instruction(state) });
      });

      async function resubmit(state) {
        if (closed || state.status !== 'active' || state.inFlight) return;
        state.inFlight = true;
        state.started = false;
        const token = randomUUID();
        expected.set(state.sessionID, token);
        await saveState(state);
        try {
          await ctx.session.prompt({
            sessionID: state.sessionID,
            delivery: 'queue',
            text: `<opencode-goal-continuation v="3" token="${token}">\n` +
              `CONTINUE THE ACTIVE GOAL.\n${instruction(state)}\n` +
              'Check the outstanding requirements against current source and test evidence. ' +
              'Proceed with actual actions. If fully verified call goal_complete, or if genuinely blocked call goal_blocked. ' +
              'Otherwise do not conclude; make the next concrete change.',
          });
        } catch (error) {
          await stop(state, 'paused', 'Failed to enqueue continuation: ' + errText(error));
          console.error(`[${ID}] continuation enqueue failed:`, error);
        }
      }

      async function onExecution(event) {
        const id = event?.data?.sessionID;
        if (closed || typeof id !== 'string' || !id) return;
        const type = event.type;
        if (type === 'session.execution.started') {
          if (controls.has(id)) return;
          const state = await getState(id);
          if (state?.status === 'active' && state.inFlight) state.started = true;
          return;
        }
        if (!/^session\.execution\.(succeeded|failed|interrupted)$/.test(type)) return;
        if (controls.delete(id)) return;
        const state = await getState(id);
        if (state?.status !== 'active') return;
        if (type !== 'session.execution.succeeded') {
          await stop(state, 'paused', `Execution ${type.split('.').pop()} — inspect the session and /goal resume`);
          return;
        }
        if (!state.inFlight || !state.started) return;
        state.turns += 1;
        state.inFlight = false;
        state.started = false;
        await saveState(state);
        await resubmit(state);
      }

      // Event stream must never be awaited by setup. Serialize per-session events.
      const subscribe = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
            if (closed) break;
            if (!event?.type?.startsWith('session.execution.')) continue;
            const id = event?.data?.sessionID;
            if (typeof id !== 'string') continue;
            const prev = executions.get(id) || Promise.resolve();
            const next = prev.catch(() => {}).then(() => onExecution(event)).catch(error => {
              console.error(`[${ID}] execution event failed for ${id}:`, error);
            });
            executions.set(id, next);
            void next.finally(() => { if (executions.get(id) === next) executions.delete(id); });
          }
        } catch (error) {
          if (!closed) console.error(`[${ID}] event stream failed:`, error);
        }
      })();

      return async () => {
        closed = true;
        abort.abort();
        expected.clear();
        controls.clear();
        await subscribe;
        await Promise.allSettled([...executions.values()]);
      };
    },
  };
}

export default buildPlugin();
export const testHelpers = { instruction, describe, fileFor };
