import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { workspacePaths } from '../src/paths.js';
import { currentBootId, isLive, processStart } from '../src/liveness.js';
import { clearWorkspace, deleteMember, listMembers, readMember, writeMember } from '../src/members.js';
import { acquireRestoreLock, claimSession, readClaim, releaseClaim, sweepClaims } from '../src/claims.js';
import { buildRestorePlan, resolveSessionFile } from '../src/plan.js';
import { buildTabScript, shellQuote } from '../src/spawn.js';
import { preflight } from '../src/preflight.js';
import { binfmtStatus, PERSIST_HINT } from '../src/binfmt.js';
import { inspect, runRestore, summarize } from '../src/restore.js';

function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'pi-ws-core-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, WSL_DISTRO_NAME: 'Arch' };
  const paths = workspacePaths(env);
  fs.mkdirSync(paths.sessions, { recursive: true });
  return { home, env, paths };
}

function boot() { return currentBootId() ?? 'boot-x'; }

/** 构造一个真实存在过、但已死亡的进程身份（模拟被动死亡）。 */
function deadIdentity() {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const start = processStart(child.pid);
  child.kill('SIGKILL');
  return { pid: child.pid, processStart: start, bootId: boot() };
}

function liveEntry(paths, id, overrides = {}) {
  const sessionFile = join(paths.sessions, 'proj', `20260101T000000_${id}.jsonl`);
  fs.mkdirSync(join(paths.sessions, 'proj'), { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id, cwd: paths.agent }) + '\n');
  return { sessionId: id, cwd: paths.agent, sessionFile, name: id, ts: Date.now(),
    pid: process.pid, processStart: processStart(process.pid), bootId: boot(), ...overrides };
}

test('member lifecycle: quit removes, passive death keeps, restore skips live', (t) => {
  const f = fixture(t);
  const quit = liveEntry(f.paths, 'quit-id');
  const passive = { ...liveEntry(f.paths, 'passive-id'), ...deadIdentity() };
  const running = liveEntry(f.paths, 'running-id');
  for (const e of [quit, passive, running]) writeMember(e, f.paths);
  deleteMember('quit-id', f.paths); // 主动退出 → 排除
  assert.equal(readMember('quit-id', f.paths), undefined);
  const { plan } = inspect({ paths: f.paths });
  const byId = Object.fromEntries(plan.items.map((i) => [i.entry.sessionId, i.state]));
  assert.equal(byId['quit-id'], undefined, 'gracefully quit session must be excluded');
  assert.equal(byId['running-id'], 'live');
  assert.equal(byId['passive-id'], 'restorable');
});

test('reboot invalidates liveness instead of misreading stale pids', (t) => {
  const f = fixture(t);
  const entry = liveEntry(f.paths, 'old-boot');
  assert.equal(isLive(entry, { bootId: () => 'other-boot' }), false);
  assert.equal(isLive({ ...entry, pid: undefined }), false);
  assert.equal(isLive({ ...entry, processStart: '999' }), false);
});

test('claims are exclusive while holder is alive, and stale claims are reclaimable', (t) => {
  const f = fixture(t);
  const first = claimSession('s1', process.pid, f.paths);
  assert.equal(first.claimed, true);
  const otherAlive = claimSession('s1', process.pid + 1, f.paths, Date.now());
  assert.equal(otherAlive.claimed, false, 'fresh claim of a live holder blocks others');
  const stale = claimSession('s1', process.pid + 1, f.paths, Date.now() + 61_000);
  assert.equal(stale.claimed, true, 'expired claim is reclaimable');
  releaseClaim('s1', f.paths);
  assert.equal(readClaim('s1', f.paths), undefined);
  sweepClaims(f.paths, Date.now());
});

test('plan reports missing file/cwd and dedupes path aliases by realpath', (t) => {
  const f = fixture(t);
  const good = liveEntry(f.paths, 'good');
  good.pid = undefined; // 被动死亡
  const ghost = { sessionId: 'ghost', cwd: f.paths.agent, ts: 1 };
  const noDir = { sessionId: 'noDir', cwd: join(f.home, 'gone'), sessionFile: join(f.paths.sessions, 'x.jsonl'), ts: 2 };
  fs.writeFileSync(noDir.sessionFile, '{}\n');
  const aliasSource = liveEntry(f.paths, 'alias-src', { pid: undefined });
  const alias = { ...aliasSource, sessionId: 'alias-dup', ts: 3 };
  writeMember(good, f.paths);
  writeMember(ghost, f.paths);
  writeMember(noDir, f.paths);
  writeMember(alias, f.paths);
  const linkDir = join(f.home, 'link');
  fs.mkdirSync(linkDir);
  fs.symlinkSync(aliasSource.sessionFile, join(linkDir, 'alias.jsonl'));
  writeMember({ ...aliasSource, sessionId: 'alias-link', sessionFile: join(linkDir, 'alias.jsonl'), ts: 4 }, f.paths);
  const { plan } = inspect({ paths: f.paths });
  const byId = Object.fromEntries(plan.items.map((i) => [i.entry.sessionId, i.state]));
  assert.equal(byId['good'], 'restorable');
  assert.equal(byId['ghost'], 'missing-file');
  assert.equal(byId['noDir'], 'missing-cwd');
  assert.equal(byId['alias-dup'], 'restorable');
  assert.equal(byId['alias-link'], 'duplicate', 'symlink alias of the same session file must dedupe');
  assert.equal(plan.count('restorable'), 2);
});

test('resolveSessionFile falls back to scanning by session id', (t) => {
  const f = fixture(t);
  const entry = { sessionId: 'scan-me', cwd: f.paths.agent };
  assert.equal(resolveSessionFile(entry, f.paths), undefined);
  const file = liveEntry(f.paths, 'scan-me').sessionFile;
  assert.equal(resolveSessionFile(entry, f.paths), file);
});

test('tab script survives quotes, dollars and spaces in cold shells', (t) => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  const cwd = "/tmp/pro 'ject' $HOME `x`";
  const script = buildTabScript({ cwd, sessionFile: '/tmp/saved session.jsonl' });
  const shim = join(import.meta.dirname, 'fixtures', 'pi-shim.mjs');
  fs.mkdirSync(cwd, { recursive: true });
  const result = spawnSync('bash', ['-lc', script.replace('exec pi ', `exec node ${JSON.stringify(shim)} `)], {
    env: { HOME: '/nonexistent-home-for-test', PATH: '/usr/bin:/bin' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [cwd, '--session', '/tmp/saved session.jsonl']);
});

test('preflight fails closed without spawning when interop is broken', (t) => {
  const f = fixture(t);
  const fakeWez = join(f.home, 'wezterm.exe');
  fs.writeFileSync(fakeWez, 'MZ');
  const result = preflight({
    env: f.env,
    wezterm: fakeWez,
    prober: () => ({ status: null, error: { code: 'ENOEXEC' } }),
    piProber: () => ({ status: 0, stdout: '/usr/bin/pi\n' }),
  });
  assert.equal(result.ok, false);
  const failed = result.checks.find((c) => !c.ok);
  assert.match(failed.hint, /WSLInterop/);
  assert.match(failed.hint, /sudo tee/);
  const missingDistro = preflight({ env: { HOME: f.home }, wezterm: fakeWez, prober: () => ({ status: 0 }), piProber: () => ({ status: 0, stdout: 'pi' }) });
  assert.equal(missingDistro.ok, false);
});

test('runRestore reports requested vs verified honestly and claims before spawning', async (t) => {
  const f = fixture(t);
  const spawned = [];
  const entry = { ...liveEntry(f.paths, 'to-restore'), ...deadIdentity() };
  writeMember(entry, f.paths);
  fs.writeFileSync(join(f.home, 'wez.exe'), 'MZ');
  const result = await runRestore({
    env: { ...f.env, PI_WORKSPACE_WEZTERM: join(f.home, 'wez.exe') },
    paths: f.paths,
    noWait: true,
    prober: () => ({ status: 0, stdout: 'wezterm 1.0' }),
    piProber: () => ({ status: 0, stdout: 'pi' }),
    spawner: async (program, args) => {
      spawned.push({ program, args, claim: readClaim('to-restore', f.paths) });
      return { ok: true, stdout: 'pane-1' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].claim, 'claim must exist while spawning');
  assert.equal(result.verification, null);
  assert.match(summarize(result).join('\n'), /未确认 pi 启动/);
  assert.equal(spawned[0].args.includes('Arch'), true);
  assert.equal(spawned[0].args.includes('-d'), true);
});

test('runRestore aborts after 3 consecutive spawn failures and releases the lock', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(join(f.home, 'wez.exe'), 'MZ');
  const ids = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'];
  ids.forEach((id, i) => {
    writeMember({ ...liveEntry(f.paths, id), ...deadIdentity(), ts: 1000 + i }, f.paths);
  });
  const order = [];
  const result = await runRestore({
    env: { ...f.env, PI_WORKSPACE_WEZTERM: join(f.home, 'wez.exe') },
    paths: f.paths,
    noWait: true,
    prober: () => ({ status: 0, stdout: 'w' }),
    piProber: () => ({ status: 0, stdout: 'pi' }),
    spawner: async (_program, args) => {
      const id = /_([0-9a-z]+)\.jsonl/.exec(args.at(-1))?.[1];
      order.push(id);
      if (id === 'c3' || id === 'd4' || id === 'e5') return { ok: false, error: '模拟超时' };
      return { ok: true };
    },
  });
  assert.deepEqual(order, ['a1', 'b2', 'c3', 'd4', 'e5'], 'f6 必须在连续 3 次失败后停止尝试');
  assert.equal(result.aborted, true);
  assert.equal(result.ok, false);
  const byId = Object.fromEntries(result.results.map((r) => [r.entry.sessionId, r]));
  assert.equal(byId.a1.requested, true);
  assert.equal(byId.c3.requested, false);
  assert.equal(byId.f6.aborted, true);
  assert.match(summarize(result).join('\n'), /未尝试/);
  assert.ok(!fs.existsSync(join(f.paths.workspace, 'restore.lock')), '恢复结束后必须释放锁');
});

test('runRestore refuses to run while a live holder owns the restore lock', async (t) => {
  const f = fixture(t);
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { try { holder.kill('SIGKILL'); } catch {} });
  acquireRestoreLock(f.paths, holder.pid);
  writeMember({ ...liveEntry(f.paths, 'locked'), ...deadIdentity() }, f.paths);
  fs.writeFileSync(join(f.home, 'wez.exe'), 'MZ');
  let spawned = 0;
  const opts = {
    env: { ...f.env, PI_WORKSPACE_WEZTERM: join(f.home, 'wez.exe') },
    paths: f.paths,
    noWait: true,
    prober: () => ({ status: 0, stdout: 'w' }),
    piProber: () => ({ status: 0, stdout: 'pi' }),
    spawner: async () => { spawned++; return { ok: true }; },
  };
  const blocked = await runRestore(opts);
  assert.equal(blocked.stage, 'locked');
  assert.equal(blocked.ok, false);
  assert.equal(spawned, 0, '持锁期间不得开标签页');
  assert.match(summarize(blocked).join('\n'), /另一个恢复进程/);
  // 跨启动周期的锁（bootId 不一致）即使持有者存活也可接管，防止重启后 PID 重用误判
  fs.writeFileSync(join(f.paths.workspace, 'restore.lock'), JSON.stringify({ pid: holder.pid, ts: Date.now(), bootId: 'other-boot' }));
  const rebooted = await runRestore(opts);
  assert.equal(rebooted.stage, 'done', 'bootId 不一致时不得误判为持锁');
  assert.equal(spawned, 1);
  holder.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 50));
  const again = await runRestore(opts);
  assert.equal(again.stage, 'done', '持有者已死时可接管过期锁');
  assert.equal(spawned, 2);
});

test('runRestore refuses to spawn on failed preflight', async (t) => {
  const f = fixture(t);
  writeMember(liveEntry(f.paths, 'x', { pid: undefined, processStart: undefined, bootId: undefined }), f.paths);
  const result = await runRestore({
    env: { HOME: f.home, WSL_DISTRO_NAME: 'Arch', PI_WORKSPACE_WEZTERM: join(f.home, 'missing.exe') },
    paths: f.paths,
    piProber: () => ({ status: 0, stdout: 'pi' }),
  });
  assert.equal(result.stage, 'preflight');
  assert.match(summarize(result).join('\n'), /指定的文件不存在/);
});

test('verification marks sessions whose member record was refreshed', async (t) => {
  const { waitForMembers } = await import('../src/verify.js');
  const f = fixture(t);
  const entry = liveEntry(f.paths, 'verify-me', { pid: undefined, processStart: undefined, bootId: undefined });
  writeMember(entry, f.paths);
  const baseline = Date.now() - 5;
  const pending = waitForMembers(['verify-me', 'never'], { paths: f.paths, timeoutMs: 300, pollMs: 50, baseline });
  await new Promise((r) => setTimeout(r, 80));
  writeMember({ ...entry, ts: Date.now(), pid: 1, processStart: '1', bootId: boot() }, f.paths);
  const done = await pending;
  assert.deepEqual(done.verified, ['verify-me']);
  assert.deepEqual(done.unverified, ['never']);
});

test('binfmt advisory appears only when registration exists without persistence', (t) => {
  const f = fixture(t);
  const registeredNoConf = binfmtStatus({ exists: (p) => p === '/proc/sys/fs/binfmt_misc/WSLInterop', readdir: () => [], readFile: () => '' });
  assert.deepEqual(registeredNoConf, { registered: true, persistent: false });
  assert.match(PERSIST_HINT, /systemctl restart systemd-binfmt/);
  const persistent = binfmtStatus({ exists: (p) => p === '/proc/sys/fs/binfmt_misc/WSLInterop' || p === '/usr/lib/binfmt.d', readdir: () => ['WSLInterop.conf'], readFile: () => ':WSLInterop:M::MZ::/init:PF' });
  assert.equal(persistent.persistent, true);
  const unregistered = binfmtStatus({ exists: () => false, readdir: () => { throw new Error('no'); } });
  assert.equal(unregistered.registered, false);
});

test('clear removes workspace records but leaves legacy files untouched', (t) => {
  const f = fixture(t);
  writeMember(liveEntry(f.paths, 'a'), f.paths);
  claimSession('a', process.pid, f.paths);
  fs.writeFileSync(f.paths.legacyRegistry, '{}');
  fs.mkdirSync(f.paths.legacyRecords, { recursive: true });
  fs.writeFileSync(join(f.paths.legacyRecords, 'x.json'), '{}');
  const removed = clearWorkspace(f.paths);
  assert.ok(removed >= 2);
  assert.equal(listMembers(f.paths).length, 0);
  assert.equal(fs.existsSync(f.paths.legacyRegistry), true);
  assert.equal(fs.existsSync(join(f.paths.legacyRecords, 'x.json')), true);
});
