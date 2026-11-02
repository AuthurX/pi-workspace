import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { discoverWezterm } from '../src/discover.js';
import { preflight } from '../src/preflight.js';
import { buildTabScript } from '../src/spawn.js';
import { runRestore } from '../src/restore.js';
import { workspacePaths } from '../src/paths.js';
import { writeMember } from '../src/members.js';

const project = join(import.meta.dirname, '..');
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'pi-ws-portable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "custom bin's $tools");
  fs.mkdirSync(bin);
  const pi = join(bin, 'custom-pi');
  fs.writeFileSync(pi, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$PI_CODING_AGENT_DIR" "$@"\n', { mode: 0o755 });
  const wezterm = join(root, 'wezterm.exe');
  fs.writeFileSync(wezterm, 'MZ');
  const env = { HOME: root, PATH: `${bin}:/usr/bin:/bin`, WSL_DISTRO_NAME: 'Test',
    PI_CODING_AGENT_DIR: join(root, "agent's $data"), PI_WORKSPACE_PI_BIN: pi,
    PI_WORKSPACE_WEZTERM: wezterm };
  return { root, bin, pi, wezterm, env };
}

test('preflight and tab use the same explicit Pi executable and agent directory', (t) => {
  const f = fixture(t);
  const pre = preflight({ env: f.env, prober: () => ({ status: 0 }) });
  assert.equal(pre.checks.find(c => c.name === 'pi 命令').ok, true);
  assert.equal(pre.piBin, f.pi);
  const sessionFile = join(f.root, "session's $file.jsonl");
  const script = buildTabScript({ cwd: f.root, sessionFile, piBin: pre.piBin, env: f.env });
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
    env: { HOME: f.root, PATH: '/usr/bin:/bin' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [f.root, f.env.PI_CODING_AGENT_DIR, '--session', sessionFile]);
});

test('preflight discovers Pi from a custom inherited PATH without npm prefix assumptions', (t) => {
  const f = fixture(t);
  fs.renameSync(f.pi, join(f.bin, 'pi'));
  delete f.env.PI_WORKSPACE_PI_BIN;
  const pre = preflight({ env: f.env, prober: () => ({ status: 0 }) });
  assert.equal(pre.piBin, join(f.bin, 'pi'));
  assert.equal(pre.checks.find(c => c.name === 'pi 命令').ok, true);
});

test('invalid explicit Pi paths fail closed without falling back to PATH', (t) => {
  const f = fixture(t);
  for (const value of [join(f.root, 'missing'), f.root, 'pi', `${f.pi} --flag`]) {
    const pre = preflight({ env: { ...f.env, PI_WORKSPACE_PI_BIN: value }, prober: () => ({ status: 0 }) });
    const check = pre.checks.find(c => c.name === 'pi 命令');
    assert.equal(check.ok, false, value);
    assert.match(check.hint, /PI_WORKSPACE_PI_BIN/);
  }
  fs.chmodSync(f.pi, 0o644);
  const pre = preflight({ env: f.env, prober: () => ({ status: 0 }) });
  assert.equal(pre.checks.find(c => c.name === 'pi 命令').ok, false);
});

test('restore uses the supplied environment for records and forwards resolved Pi to tabs', async (t) => {
  if (!fs.existsSync('/run/WSL')) return t.skip('restore requires WSL');
  const f = fixture(t);
  const originalAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(f.root, 'other-agent');
  t.after(() => {
    if (originalAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgent;
  });
  const paths = workspacePaths(f.env);
  const file = join(f.root, 'session.jsonl');
  fs.writeFileSync(file, '{}\n');
  writeMember({ sessionId: 'portable', cwd: f.root, sessionFile: file, ts: 1 }, paths);
  let script;
  const result = await runRestore({ env: f.env, noWait: true, prober: () => ({ status: 0 }),
    spawner: async (_program, args) => { script = args.at(-1); return { ok: true }; } });
  assert.equal(result.stage, 'done');
  assert.equal(result.results.length, 1);
  const executed = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(executed.status, 0, executed.stderr);
  assert.deepEqual(executed.stdout.trim().split('\n'), [f.root, f.env.PI_CODING_AGENT_DIR, '--session', file]);
});

test('WezTerm discovery checks PATH and converts every where.exe result with wslpath', () => {
  const calls = [];
  const deps = {
    readdir: () => [],
    isFile: p => p === '/custom/wezterm.exe',
    execFile: (program, args) => {
      calls.push([program, args]);
      if (program.endsWith('where.exe')) return 'C:\\missing\\wezterm.exe\r\nE:\\Apps\\wezterm.exe\r\n';
      assert.equal(program, 'wslpath');
      return args.at(-1).startsWith('E:') ? '/custom/wezterm.exe\n' : '/missing/wezterm.exe\n';
    },
  };
  assert.equal(discoverWezterm({ PATH: '/custom' }, deps), '/custom/wezterm.exe');
  assert.equal(calls.length, 0);
  assert.equal(discoverWezterm({ PATH: '' }, deps), '/custom/wezterm.exe');
  assert.equal(calls.filter(c => c[0] === 'wslpath').length, 2);
});

test('relocated package loads without PI_WORKSPACE_SRC or a personal fallback', async (t) => {
  const f = fixture(t);
  const saved = process.env.PI_WORKSPACE_SRC;
  delete process.env.PI_WORKSPACE_SRC;
  t.after(() => {
    if (saved === undefined) delete process.env.PI_WORKSPACE_SRC;
    else process.env.PI_WORKSPACE_SRC = saved;
  });
  const root = join(f.root, 'package');
  fs.cpSync(join(project, 'src'), join(root, 'src'), { recursive: true });
  fs.mkdirSync(join(root, 'extensions'));
  fs.writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const raw = fs.readFileSync(join(project, 'extensions/open-all.ts'), 'utf8');
  assert.doesNotMatch(raw, /FALLBACK_SRC|\/home\/ellie\//);
  const source = stripTypeScriptTypes(raw).replace('import { Key } from "@earendil-works/pi-tui";',
    'const Key = { ctrlShift: k => `ctrl+shift+${k}` };');
  const entry = join(root, 'extensions', 'open-all.mjs');
  fs.writeFileSync(entry, source);
  const mod = await import(pathToFileURL(entry).href);
  const commands = [];
  await mod.default({ on() {}, registerShortcut() {}, registerCommand: name => commands.push(name) });
  assert.deepEqual(commands, ['all']);
});
