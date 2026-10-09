import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import plugin, { buildPlugin, loadState, parseCommand } from '../plugin/index.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
class Bus {
  queue = [];
  waiting = [];
  closed = false;
  send(event) {
    const next = this.waiting.shift();
    if (next) next({ value: event, done: false });
    else this.queue.push(event);
  }
  subscribe({ signal }) {
    const bus = this;
    signal.addEventListener('abort', () => {
      bus.closed = true;
      for (const resolve of bus.waiting.splice(0)) resolve({ done: true });
    }, { once: true });
    return { [Symbol.asyncIterator]() { return this; }, next() {
      if (bus.queue.length) return Promise.resolve({ value: bus.queue.shift(), done: false });
      if (bus.closed) return Promise.resolve({ done: true });
      return new Promise(resolve => bus.waiting.push(resolve));
    }};
  }
}

async function harness(existingRoot) {
  const root = existingRoot || await mkdtemp(join(tmpdir(), 'v3-goal-test-'));
  process.env.OPENCODE_GOAL_STATE_DIR = root;
  const hooks = new Map();
  const tools = new Map();
  const bus = new Bus();
  const prompts = [];
  const context = { tool: { transform: async fn => fn({ add: definition => {
    tools.set(definition.name, definition);
  }}) },
    session: {
      hook: async (name, fn) => { hooks.set(name, fn); },
      prompt: async prompt => {
        prompts.push({ ...prompt });
        const event = { sessionID: prompt.sessionID, prompt: { ...prompt } };
        await hooks.get('prompt')(event);
        return event;
      },
    }, event: { subscribe: opts => bus.subscribe(opts) },
  };
  const dispose = await buildPlugin().setup(context);
  const file = await readFile(resolve('commands/goal.md'), 'utf8');
  const template = file.split(/\n---\n/).slice(1).join('\n---\n').trim();
  const invoke = async (command, id='session1') => {
    const event = { sessionID: id, prompt: { text: template.replace('$ARGUMENTS', command) } };
    await hooks.get('prompt')(event);
    return event.prompt.text;
  };
  const emit = (type, id='session1') => bus.send({ type, data: { sessionID: id } });
  const wait = async check => {
    for (let i=0;i<1500;i++) { if (await check()) return; await tick(); }
    throw new Error('Condition not satisfied by the test event flow');
  };
  const success = async (id='session1') => {
    const before = (await loadState(id))?.turns || 0;
    emit('session.execution.started', id);
    emit('session.execution.succeeded', id);
    await wait(async () => (await loadState(id))?.turns === before + 1 && prompts.filter(x => x.sessionID === id).length >= before + 1);
  };
  const close = async () => {
    await dispose();
    delete process.env.OPENCODE_GOAL_STATE_DIR;
    if (!existingRoot) await rm(root, { recursive:true, force:true });
  };
  return { root, tools, hooks, prompts, invoke, emit, wait, success, close };
}

test('V2 structural plugin with setup', () => {
  assert.equal(plugin.id, 'local.goal-autopilot-v3');
});
test('slash command is a discoverable Markdown command', async () => {
  const file = await readFile('commands/goal.md', 'utf8');
  assert.match(file, /^---\ndescription:.*\n---\n/);
});
test('input parser has no turn or time budgets', () => {
  assert.deepEqual(parseCommand('fix this bug --turns=55'), { kind: 'start', objective:'fix this bug --turns=55' });
});
test('parser accepts a multiline objective much larger than 16,000 characters', () => {
  const objective = 'Heading\n' + 'Task and verification details\n'.repeat(8_000);
  assert.deepEqual(parseCommand(objective), { kind: 'start', objective: objective.trim() });
});
test('parser supports file-backed goals without quoting restrictions', () => {
  assert.deepEqual(parseCommand('--file "a long spec.md"'), {kind:'file',path:'a long spec.md'});
});
test('registers real goal tool definitions via tool.transform', async () => {
  const t = await harness();
  try { assert.deepEqual([...t.tools.keys()], ['goal_read','goal_complete','goal_blocked']); }
  finally { await t.close(); }
});
test('goal starts and queues a second actual model prompt on execution success', async () => {
  const t = await harness();
  try {
    assert.match(await t.invoke('fix everything'), /BEGIN GOAL EXECUTION/);
    await t.success();
    assert.equal(t.prompts.length, 1);
  } finally { await t.close(); }
});
test('continuation is treated as internal, not user interruption', async () => {
  const t = await harness();
  try {
    await t.invoke('fix everything');
    await t.success();
    assert.equal((await loadState('session1')).status, 'active');
  } finally { await t.close(); }
});
test('more than 100 successful model turns cause more than 100 reruns without caps', async () => {
  const t = await harness();
  try {
    await t.invoke('long objective');
    for (let i=0;i<105;i++) await t.success();
    assert.equal(t.prompts.length, 105);
  } finally { await t.close(); }
});
test('goal_complete tool requires evidence and marks achieved', async () => {
  const t = await harness();
  try {
    await t.invoke('fix bug');
    const result = await t.tools.get('goal_complete').execute({summary:'Fixed it',evidence:'test: passed'}, {sessionID:'session1'});
    assert.match(result.content, /marked complete/);
    assert.equal((await loadState('session1')).status, 'complete');
  } finally {await t.close();}
});
test('goal_complete without evidence does not stop', async () => {
  const t = await harness();
  try {
    await t.invoke('fix bug');
    const result = await t.tools.get('goal_complete').execute({summary:'done',evidence:''}, {sessionID:'session1'});
    assert.match(result.content, /Rejected/);
    assert.equal((await loadState('session1')).status, 'active');
  } finally { await t.close(); }
});
test('completion prevents any further rerun after current execution', async () => {
  const t = await harness();
  try {
    await t.invoke('fix bug');
    await t.tools.get('goal_complete').execute({summary:'Done',evidence:'tested OK'}, {sessionID:'session1'});
    t.emit('session.execution.started'); t.emit('session.execution.succeeded');
    await t.wait(async () => (await loadState('session1')).status === 'complete');
    assert.equal(t.prompts.length, 0);
  } finally { await t.close(); }
});
test('explicit goal_blocked tool stops loop', async () => {
  const t = await harness();
  try {
    await t.invoke('fix bug');
    await t.tools.get('goal_blocked').execute({reason:'need restricted access'}, {sessionID:'session1'});
    assert.equal((await loadState('session1')).status, 'blocked');
  } finally { await t.close(); }
});
test('manual pause is persisted and suppresses continuation', async () => {
  const t = await harness();
  try {
    await t.invoke('fix bug');
    assert.match(await t.invoke('pause'), /Status: paused/);
    t.emit('session.execution.started'); t.emit('session.execution.succeeded');
    assert.equal((await loadState('session1')).status, 'paused');
  } finally { await t.close(); }
});
test('new user prompt pauses an active goal', async () => {
  const t = await harness();
  try {
    await t.invoke('fix bug');
    await t.hooks.get('prompt')({ sessionID:'session1', prompt:{text:'hello'} });
    assert.equal((await loadState('session1')).status, 'paused');
  } finally { await t.close(); }
});
test('control-only status never changes an active goal', async () => {
  const t = await harness();
  try {
    await t.invoke('fix bug');
    assert.match(await t.invoke('status'), /Status: active/);
    assert.equal((await loadState('session1')).status, 'active');
  } finally { await t.close(); }
});
test('interruption pauses and does not retry', async () => {
  const t = await harness();
  try {
    await t.invoke('fix bug');
    t.emit('session.execution.interrupted');
    await t.wait(async () => (await loadState('session1')).status === 'paused');
    assert.equal(t.prompts.length, 0);
  } finally { await t.close(); }
});
test('resume reactivates a paused goal and preserves execution count', async () => {
  const t = await harness();
  try {
    await t.invoke('fix bug');
    await t.success();
    await t.invoke('pause');
    assert.match(await t.invoke('resume'), /RESUME GOAL EXECUTION/);
    assert.equal((await loadState('session1')).turns, 1);
  } finally { await t.close(); }
});
test('compaction reinjects the active objective', async () => {
  const t = await harness();
  try {
    await t.invoke('repair network sync');
    const e = {sessionID:'session1',system:[]};
    await t.hooks.get('compaction')(e);
    assert.match(e.system[0].text,/repair network sync/);
  } finally { await t.close(); }
});
test('large inline goal is saved exactly and uses a file reference for continuation and compaction', async () => {
  const t = await harness();
  try {
    const objective = 'requirements\n' + 'A unique line of complex work.\n'.repeat(9_000) + 'END-OF-OBJECTIVE';
    const initial = await t.invoke(objective);
    const state = await loadState('session1');
    assert.equal(state.objective, objective);
    assert.equal(await readFile(state.objectivePath, 'utf8'), objective);
    assert.match(initial, /READ THE ENTIRE objective through goal_read/);
    assert.doesNotMatch(initial, /END-OF-OBJECTIVE/);
    await t.success();
    const context = {sessionID: 'session1', system: []};
    await t.hooks.get('compaction')(context);
    assert.match(context.system[0].text, /READ THE ENTIRE objective through goal_read/);
    assert.equal((await loadState('session1')).objective, objective);
  } finally { await t.close(); }
});
test('file-backed goal takes a complete snapshot and does not follow later file edits', async () => {
  const t = await harness();
  const source = join(t.root,'objective with spaces.md');
  const text = '# Objective\n' + 'Check every acceptance criterion\n'.repeat(7_000);
  try {
    await writeFile(source, text);
    const prompt = await t.invoke(`--file "${source}"`);
    assert.match(prompt, /READ THE ENTIRE objective through goal_read/);
    await writeFile(source, 'modified after starting');
    const saved = await loadState('session1');
    assert.equal(await readFile(saved.objectivePath,'utf8'), text);
    assert.equal(saved.objective, text);
  } finally { await t.close(); }
});
test('goal_read reconstructs every character of an oversized objective in multiple pages', async () => {
  const t = await harness();
  try {
    const objective = ('A big detailed goal 🛠️ with UTF-8 text.\n').repeat(6_000) + 'END';
    await t.invoke(objective);
    const read = t.tools.get('goal_read');
    let recovered = '';
    let offset = 0;
    while (offset < objective.length) {
      const page = JSON.parse((await read.execute({offset,limit:10001},{sessionID:'session1'})).content);
      recovered += page.text;
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    }
    assert.equal(recovered, objective);
  } finally {await t.close();}
});
test('goal_read cannot expose the saved objective of another session', async () => {
  const t = await harness();
  try {
    await t.invoke('private requirements', 'A');
    const output = await t.tools.get('goal_read').execute({}, {sessionID:'B'});
    assert.equal(output.content, 'No saved goal in this session.');
  } finally { await t.close(); }
});
test('medium pasted objective is present on the first turn and compact on later turns', async () => {
  const t = await harness();
  try {
    const objective = 'Detailed checklist ' + 'a'.repeat(25_000);
    const initial = await t.invoke(objective);
    assert.ok(initial.includes(objective));
    const event = {sessionID:'session1',system:[]};
    await t.hooks.get('context')(event);
    assert.ok(!event.system[0].text.includes(objective));
  } finally { await t.close(); }
});
test('invalid file input reports error without destroying the current goal', async () => {
  const t = await harness();
  try {
    await t.invoke('keep existing goal');
    assert.match(await t.invoke('--file /nonexistent/goal-file.md'), /Goal file error/);
    assert.equal((await loadState('session1')).objective, 'keep existing goal');
  } finally { await t.close(); }
});
test('clearing a goal deletes its private objective file', async () => {
  const t = await harness();
  try {
    await t.invoke('fix this');
    const old = (await loadState('session1')).objectivePath;
    await t.invoke('clear');
    await assert.rejects(stat(old), {code:'ENOENT'});
  } finally { await t.close(); }
});
test('replacement of a goal does not leave its previous snapshot', async () => {
  const t = await harness();
  try {
    await t.invoke('first goal');
    const old = (await loadState('session1')).objectivePath;
    await t.invoke('second goal');
    await assert.rejects(stat(old), {code:'ENOENT'});
  } finally { await t.close(); }
});
test('status summarizes very long goals without echoing the whole text', async () => {
  const t = await harness();
  try {
    await t.invoke('task '.repeat(30_000));
    const status = await t.invoke('status');
    assert.ok(status.length < 1300);
  } finally { await t.close(); }
});
test('stored goal can be resumed after a plugin restart', async () => {
  const dir = await mkdtemp(join(tmpdir(),'v3-restart-'));
  try {
    const first = await harness(dir);
    await first.invoke('keep working');
    await first.close();
    const second = await harness(dir);
    try {
      assert.match(await second.invoke('status'), /keep working/);
      assert.match(await second.invoke('resume'),/RESUME GOAL EXECUTION/);
      assert.equal((await loadState('session1')).status,'active');
    } finally {await second.close();}
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('clear removes durable session state', async () => {
  const t = await harness();
  try {
    await t.invoke('fix bug');
    await t.invoke('clear');
    assert.equal(await loadState('session1'), undefined);
  } finally { await t.close(); }
});
test('goals in different sessions remain independent', async () => {
  const t = await harness();
  try {
    await t.invoke('fix A', 'A');
    await t.invoke('fix B', 'B');
    await t.tools.get('goal_complete').execute({summary:'fixed A',evidence:'test A passed'}, {sessionID:'A'});
    assert.equal((await loadState('B')).status, 'active');
  } finally { await t.close(); }
});
test('tool cannot complete an unrelated inactive session', async () => {
  const t = await harness();
  try {
    await t.invoke('fix A', 'A');
    const answer=await t.tools.get('goal_complete').execute({summary:'fixed',evidence:'passed'}, {sessionID:'B'});
    assert.match(answer.content,/No active goal/);
  } finally { await t.close(); }
});
