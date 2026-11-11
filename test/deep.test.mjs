import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { workspacePaths } from '../src/paths.js';
import { isLive, processStart } from '../src/liveness.js';
import { listMembers, writeMember } from '../src/members.js';
import { CLAIM_TTL_MS, claimSession, readClaim, sweepClaims } from '../src/claims.js';
import { buildRestorePlan, resolveSessionFile } from '../src/plan.js';
import { openTab, shellQuote } from '../src/spawn.js';
import { preflight } from '../src/preflight.js';
import { runRestore, summarize } from '../src/restore.js';
import { run as cliRun } from '../src/cli.js';

function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'pi-ws-deep-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, WSL_DISTRO_NAME: 'Arch' };
  const paths = workspacePaths(env);
  fs.mkdirSync(paths.sessions, { recursive: true });
  return { home, env, paths };
}

function liveEntry(paths, id, overrides = {}) {
  const sessionFile = join(paths.sessions, 'proj', `20260101T000000_${id}.jsonl`);
  fs.mkdirSync(join(paths.sessions, 'proj'), { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id, cwd: paths.agent }) + '\n');
  return { sessionId: id, cwd: paths.agent, sessionFile, name: id, ts: Date.now(),
    pid: process.pid, processStart: processStart(process.pid), bootId: 'boot-x', ...overrides };
}

/** 真实存在过但已死亡的进程身份（被动死亡）。 */
function deadIdentity() {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const start = processStart(child.pid);
  child.kill('SIGKILL');
  return { pid: child.pid, processStart: start, bootId: 'boot-x' };
}

test('processStart parses comm with spaces/parens, treats zombies and missing procs as dead', () => {
  // /proc/pid/stat 字段 22（starttime）位于 comm 之后的第 19 位（0 起）
  const fields = 'S 1 1 1 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 12345 0 0 1 0 0';
  const line = (name) => `1234 (${name}) ${fields}`;
  assert.equal(processStart(1, () => line('my proc')), '12345');
  assert.equal(processStart(1, () => line('weird)name(')), '12345', 'comm 可含括号/空格，按最后一个右括号切分');
  assert.equal(processStart(1, () => line('zombie').replace(') S ', ') Z ')), undefined, '僵尸进程视为不存活');
  assert.equal(processStart(999999, () => { throw new Error('ENOENT'); }), undefined);
});

test('isLive accepts bootId as value or function and requires matching start time', () => {
  const entry = { pid: 42, processStart: '999', bootId: 'boot-1' };
  assert.equal(isLive(entry, { bootId: 'boot-1', processStart: () => '999' }), true);
  assert.equal(isLive(entry, { bootId: () => 'boot-1', processStart: () => '999' }), true);
  assert.equal(isLive(entry, { bootId: 'boot-1', processStart: () => '1000' }), false, 'PID 重用（启动时刻不同）判死');
  assert.equal(isLive({ ...entry, bootId: undefined }), false);
});

test('claimSession: same owner reclaims; dead holder within TTL is reclaimable', async (t) => {
  const f = fixture(t);
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { try { holder.kill('SIGKILL'); } catch {} });
  assert.equal(claimSession('s1', process.pid, f.paths).claimed, true);
  assert.equal(claimSession('s1', process.pid, f.paths).claimed, true, '同一持有者可重复声明');
  claimSession('s2', holder.pid, f.paths);
  holder.kill('SIGKILL');
  await new Promise((r) => holder.once('exit', r));
  assert.equal(claimSession('s2', process.pid, f.paths).claimed, true, '持有者已死时即使未过期也可接管');
});

test('sweepClaims removes expired and dead-holder claims, keeps fresh live and corrupt ones', async (t) => {
  const f = fixture(t);
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
  const dead = spawn('sleep', ['30'], { stdio: 'ignore' });
  dead.kill('SIGKILL');
  await new Promise((r) => dead.once('exit', r));
  t.after(() => { try { holder.kill('SIGKILL'); } catch {} });
  const now = Date.now();
  claimSession('fresh', holder.pid, f.paths, now);
  claimSession('expired', holder.pid, f.paths, now - CLAIM_TTL_MS - 1);
  claimSession('deadholder', dead.pid, f.paths, now);
  fs.writeFileSync(join(f.paths.claims, 'corrupt.json'), '{oops');
  sweepClaims(f.paths, now);
  assert.ok(readClaim('fresh', f.paths), '新鲜且持有者存活 → 保留');
  assert.equal(readClaim('expired', f.paths), undefined, '过期 → 删除');
  assert.equal(readClaim('deadholder', f.paths), undefined, '持有者已死 → 删除');
  assert.ok(fs.existsSync(join(f.paths.claims, 'corrupt.json')), '损坏声明保留，待 TTL 后接管');
});

test('plan marks sessions claimed by another restore as claimed', (t) => {
  const f = fixture(t);
  const entry = { ...liveEntry(f.paths, 'cl'), ...deadIdentity() };
  const plan = buildRestorePlan({
    members: [entry],
    paths: f.paths,
    liveFn: () => false,
    claimFn: (id) => id === 'cl',
  });
  assert.equal(plan.items[0].state, 'claimed');
  assert.equal(plan.count('claimed'), 1);
  assert.equal(plan.restorable.length, 0);
});

test('resolveSessionFile prefers an existing recorded path, falls back to scan', (t) => {
  const f = fixture(t);
  const direct = join(f.home, 'direct.jsonl');
  fs.writeFileSync(direct, '{}\n');
  const scanned = liveEntry(f.paths, 'pref').sessionFile;
  assert.equal(resolveSessionFile({ sessionId: 'pref', cwd: f.paths.agent, sessionFile: direct }, f.paths), direct);
  assert.equal(
    resolveSessionFile({ sessionId: 'pref', cwd: f.paths.agent, sessionFile: join(f.home, 'gone.jsonl') }, f.paths),
    scanned,
  );
});

test('preflight passes when all dependencies are present (WSL only)', (t) => {
  if (!fs.existsSync('/run/WSL')) { t.skip('非 WSL 环境，/run/WSL 不存在，无法全项通过'); return; }
  const f = fixture(t);
  const fakeWez = join(f.home, 'wezterm.exe');
  fs.writeFileSync(fakeWez, 'MZ');
  const result = preflight({
    env: f.env,
    wezterm: fakeWez,
    prober: () => ({ status: 0, stdout: 'wezterm 20260101\n' }),
    piProber: () => ({ status: 0, stdout: '/usr/bin/pi\n' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.wezterm, fakeWez);
  assert.equal(result.distro, 'Arch');
  assert.ok(result.checks.every((c) => c.ok));
});

test('preflight fails with actionable hint when pi is missing', (t) => {
  const f = fixture(t);
  const fakeWez = join(f.home, 'wezterm.exe');
  fs.writeFileSync(fakeWez, 'MZ');
  const result = preflight({
    env: f.env,
    wezterm: fakeWez,
    prober: () => ({ status: 0 }),
    piProber: () => ({ status: 1, stdout: '' }),
  });
  assert.equal(result.ok, false);
  const pi = result.checks.find((c) => c.name === 'pi 命令');
  assert.equal(pi.ok, false);
  assert.match(pi.hint, /安装 pi/);
});

test('openTab omits -d when distro is unknown and passes session file as last arg', async () => {
  let args;
  const result = await openTab({
    wezterm: '/x/wezterm.exe',
    distro: undefined,
    cwd: '/tmp/proj',
    sessionFile: '/s/s.jsonl',
    spawner: async (program, a) => { args = a; return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(args.slice(0, 4), ['cli', 'spawn', '--', 'wsl.exe']);
  assert.equal(args.includes('-d'), false);
  assert.match(args.at(-1), /exec pi --session '\/s\/s\.jsonl'/);
});

test('default spawner (openTab without injection) reports success, failure stderr, and spawn errors', async (t) => {
  const f = fixture(t);
  const ok = join(f.home, 'wez-ok.sh');
  fs.writeFileSync(ok, '#!/bin/sh\necho out\n');
  fs.chmodSync(ok, 0o755);
  assert.deepEqual(await openTab({ wezterm: ok, cwd: '/tmp', sessionFile: '/s.jsonl' }), { ok: true, stdout: 'out' });
  const bad = join(f.home, 'wez-bad.sh');
  fs.writeFileSync(bad, '#!/bin/sh\necho err >&2\nexit 3\n');
  fs.chmodSync(bad, 0o755);
  const failed = await openTab({ wezterm: bad, cwd: '/tmp', sessionFile: '/s.jsonl' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /err/);
  const missing = await openTab({ wezterm: '/nonexistent/binary-xyz', cwd: '/tmp', sessionFile: '/s.jsonl' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /ENOENT/);
});

test('default spawner times out when wezterm cli hangs', async (t) => {
  const f = fixture(t);
  const hang = join(f.home, 'wez-hang.sh');
  fs.writeFileSync(hang, '#!/bin/sh\nsleep 30\n');
  fs.chmodSync(hang, 0o755);
  const started = Date.now();
  const result = await openTab({ wezterm: hang, cwd: '/tmp', sessionFile: '/s.jsonl', spawnTimeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.match(result.error, /无响应/);
  assert.ok(Date.now() - started < 5000, '超时必须实际触发而不是永久等待');
});

test('shellQuote round-trips quotes, backticks, dollars, and backslashes through bash', () => {
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote('a"b'), "'a\"b'");
  const tricky = "it's `cmd` $HOME \"q\" \\ end";
  const out = spawnSync('bash', ['-c', `printf %s ${shellQuote(tricky)}`], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, tricky);
});

test('listMembers sorts by ts, skips corrupt records, tolerates missing ts and non-json files', (t) => {
  const f = fixture(t);
  writeMember({ sessionId: 'late', ts: 200 }, f.paths);
  writeMember({ sessionId: 'early', ts: 100 }, f.paths);
  fs.writeFileSync(join(f.paths.members, 'no-ts.json'), JSON.stringify({ sessionId: 'no-ts' }));
  fs.writeFileSync(join(f.paths.members, 'bad.json'), '{nope');
  fs.writeFileSync(join(f.paths.members, 'not-json.txt'), 'x');
  const ids = listMembers(f.paths).map((e) => e.sessionId);
  assert.deepEqual(ids.slice(0, 2), ['early', 'late']);
  assert.ok(ids.includes('no-ts'), '缺失 ts 不崩溃');
  assert.equal(ids.includes('bad'), false, '损坏记录跳过');
});

test('writeMember creates member files with 0600 mode', (t) => {
  const f = fixture(t);
  writeMember({ sessionId: 'mode', ts: 1 }, f.paths);
  const mode = fs.statSync(join(f.paths.members, 'mode.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('runRestore reports failure without spawning when every restorable is claimed elsewhere', async (t) => {
  const f = fixture(t);
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { try { holder.kill('SIGKILL'); } catch {} });
  writeMember({ ...liveEntry(f.paths, 'cl'), ...deadIdentity() }, f.paths);
  claimSession('cl', holder.pid, f.paths);
  fs.writeFileSync(join(f.home, 'wez.exe'), 'MZ');
  let spawned = 0;
  const result = await runRestore({
    env: { ...f.env, PI_WORKSPACE_WEZTERM: join(f.home, 'wez.exe') },
    paths: f.paths,
    noWait: true,
    prober: () => ({ status: 0, stdout: 'w' }),
    piProber: () => ({ status: 0, stdout: 'pi' }),
    spawner: async () => { spawned++; return { ok: true }; },
  });
  assert.equal(spawned, 0, '被占用时不得开标签页');
  assert.equal(result.ok, false);
  assert.equal(result.results[0].state, 'claimed');
  assert.match(summarize(result).join('\n'), /其他恢复进程正在启动，跳过/);
});

test('summarize handles empty restore results', () => {
  const result = { ok: true, stage: 'done', plan: { items: [], restorable: [], count: () => 0 }, results: [], verification: null };
  assert.match(summarize(result).join('\n'), /没有待恢复的会话/);
});

test('cli.run: no args prints usage with exit 0, unknown command exits 1', async () => {
  let out = '';
  const code = await cliRun([], { stdout: { write: (l) => (out += l) } });
  assert.equal(code, 0);
  assert.match(out, /pi-workspace —/);
  assert.match(out, /--dry-run/);
  assert.equal(await cliRun(['bogus'], { stdout: { write: () => {} } }), 1);
});

test('cli list reads the isolated agent dir', async (t) => {
  const f = fixture(t);
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.paths.agent;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  writeMember(liveEntry(f.paths, 'cli-list', { pid: undefined, processStart: undefined, bootId: undefined }), f.paths);
  let out = '';
  const code = await cliRun(['list'], { stdout: { write: (l) => (out += l) }, env: f.env });
  assert.equal(code, 0);
  assert.match(out, /cli-list/);
  assert.match(out, /待恢复/);
});

test('cli clear empties the isolated workspace and keeps session files', async (t) => {
  const f = fixture(t);
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.paths.agent;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  writeMember(liveEntry(f.paths, 'to-clear'), f.paths);
  let out = '';
  const code = await cliRun(['clear'], { stdout: { write: (l) => (out += l) }, env: f.env });
  assert.equal(code, 0);
  assert.match(out, /已清空 1 条/);
  assert.equal(listMembers(f.paths).length, 0);
  assert.ok(fs.existsSync(liveEntry(f.paths, 'to-clear').sessionFile), '对话文件不受影响');
});
