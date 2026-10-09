import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const unixOnly = { skip: process.platform === 'win32' ? 'requires bash and POSIX paths' : false };
const exec = (name, env) => spawnSync('bash', [name], { encoding: 'utf8', env });

const testRoot = () => mkdtemp(join(tmpdir(), 'opencode-goal-installer-'));

test('installer creates the plugin and slash command, then uninstaller removes only them', unixOnly, async () => {
  const root = await testRoot();
  const config = join(root, 'config');
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: config, OPENCODE_VERSION:'2.0.16' };
  try {
    const install = exec('install.sh',env);
    assert.equal(install.status, 0, install.stderr);
    const installed = await readFile(join(config,'opencode/plugins/goal-autopilot-v3/index.js'),'utf8');
    assert.match(installed,/local.goal-autopilot-v3/);
    const command = await readFile(join(config,'opencode/commands/goal.md'),'utf8');
    assert.match(command, /\$ARGUMENTS/);
    const uninstall = exec('uninstall.sh', env);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    await assert.rejects(stat(join(config,'opencode/commands/goal.md')),{code:'ENOENT'});
    await assert.rejects(stat(join(config,'opencode/plugins/goal-autopilot-v3')),{code:'ENOENT'});
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('installer never changes user configuration for OpenCode 1',unixOnly,async () => {
  const root = await testRoot();
  const config = join(root, 'config');
  try {
    const result = exec('install.sh',{ ...process.env, HOME:root, XDG_CONFIG_HOME:config, OPENCODE_VERSION:'1.1.0' });
    assert.notEqual(result.status,0);
    await assert.rejects(stat(join(config,'opencode')), {code:'ENOENT'});
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('installer backs up another goal command before replacement', unixOnly, async () => {
  const root = await testRoot();
  const config = join(root, 'config/opencode');
  const env = { ...process.env, HOME:root, XDG_CONFIG_HOME:join(root,'config'),OPENCODE_VERSION:'2.0.16' };
  try {
    await mkdir(join(config,'commands'),{recursive:true});
    await writeFile(join(config,'commands/goal.md'),'custom original command');
    const install = exec('install.sh', env);
    assert.equal(install.status,0,install.stderr);
    const names = await readdir(join(config,'goal-autopilot-backups'));
    assert.equal(names.filter(x => /^goal-.*\.md$/.test(x)).length, 1);
    assert.equal(await readFile(join(config,'goal-autopilot-backups',names.find(x => x.endsWith('.md'))),'utf8'),'custom original command');
  } finally { await rm(root,{recursive:true,force:true}); }
});
