import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const project = dirname(dirname(fileURLToPath(import.meta.url)));

// 用真实 Node（原生 TS 类型剥离）加载扩展模块，配合假 Pi API 验证接线与生命周期。
async function loadExtension(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'pi-ws-ext-'));
  const originalSignals = new Map(['SIGHUP', 'SIGTERM'].map(s => [s, process.listeners(s)]));
  t.after(() => {
    for (const [signal, original] of originalSignals) {
      for (const listener of process.listeners(signal)) {
        if (!original.includes(listener)) process.off(signal, listener);
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of ['PI_CODING_AGENT_DIR', 'PI_WORKSPACE_HOOKS', 'PI_WORKSPACE_SRC', 'PI_WORKSPACE_WEZTERM']) delete process.env[key];
  });
  process.env.PI_CODING_AGENT_DIR = join(home, '.pi', 'agent');
  process.env.PI_WORKSPACE_SRC = join(project, 'src');
  process.env.PI_WORKSPACE_WEZTERM = join(home, 'wez.exe');
  fs.writeFileSync(join(home, 'wez.exe'), 'MZ');
  process.env.PI_WORKSPACE_HOOKS = join(project, 'test', 'fixtures', 'test-hooks.mjs');

  const raw = fs.readFileSync(join(project, 'extensions/open-all.ts'), 'utf8');
  const source = stripTypeScriptTypes(raw)
    // 测试环境没有宿主提供的 pi-tui；替换为等价最小实现
    .replace('import { Key } from "@earendil-works/pi-tui";', 'const Key = { ctrlShift: (k) => `ctrl+shift+${k}` };');
  const tempFile = join(home, 'open-all.test.mjs');
  fs.writeFileSync(tempFile, source);
  const mod = await import(pathToFileURL(tempFile).href);

  const events = {}, commands = {}, notices = [];
  await mod.default({
    on: (name, handler) => { events[name] = handler; },
    registerCommand: (name, command) => { commands[name] = command; },
    registerShortcut() {},
  });
  const agentDir = join(home, '.pi', 'agent');
  const membersDir = join(agentDir, 'pi-workspace', 'members');
  const memberCount = () => { try { return fs.readdirSync(membersDir).length; } catch { return 0; } };
  const context = {
    mode: 'tui', cwd: home,
    sessionManager: { getSessionId: () => 'current', getSessionFile: () => join(home, 'current.jsonl'), getSessionName: () => 'current' },
    ui: { notify: (message) => notices.push(message), input: async () => undefined, confirm: async () => false },
  };
  return { home, agentDir, membersDir, memberCount, events, commands, notices, context,
    hooks: (await import(pathToFileURL(join(project, 'test', 'fixtures', 'test-hooks.mjs')))) };
}

test('extension registers command/shortcut; only tui mode records members', async (t) => {
  const f = await loadExtension(t);
  assert.ok(f.commands.all, '/all must be registered');
  f.events.session_start({}, { ...f.context, mode: 'print' });
  assert.equal(fs.existsSync(f.membersDir), false, 'print mode must not register members');
  f.events.session_start({}, f.context);
  assert.equal(f.memberCount(), 1, 'tui mode registers the live member');
  const member = JSON.parse(fs.readFileSync(join(f.membersDir, 'current.json'), 'utf8'));
  assert.equal(member.sessionId, 'current');
  assert.equal(member.cwd, f.home);
  assert.ok(member.pid > 0 && member.bootId, 'live identity recorded');
});

test('new sessions register lazily after the first user message persists a file', async (t) => {
  const f = await loadExtension(t);
  let file;
  const ctx = { ...f.context, sessionManager: { ...f.context.sessionManager, getSessionFile: () => file } };
  f.events.session_start({}, ctx);
  assert.equal(f.memberCount(), 0, 'brand-new window without file must not register yet');
  file = join(f.home, 'new-session.jsonl');
  fs.writeFileSync(file, '{}\n');
  f.events.message_end({ message: { role: 'assistant' } }, ctx);
  assert.equal(f.memberCount(), 0, 'only user messages trigger lazy registration');
  f.events.message_end({ message: { role: 'user' } }, ctx);
  assert.equal(f.memberCount(), 1, 'first persisted user message registers the session');
  const member = JSON.parse(fs.readFileSync(join(f.membersDir, 'current.json'), 'utf8'));
  assert.equal(member.sessionFile, file);
  await f.events.session_shutdown({ reason: 'quit' }, ctx);
  assert.equal(f.memberCount(), 0, 'graceful quit still excludes lazily registered sessions');
});

test('shutdown: quit excludes, switch excludes, reload keeps', async (t) => {
  const f = await loadExtension(t);
  f.events.session_start({}, f.context);
  await f.events.session_shutdown({ reason: 'reload' }, f.context);
  assert.equal(f.memberCount(), 1, 'reload keeps the member');
  f.events.session_start({}, f.context); // Pi starts a new runtime after reload.
  await f.events.session_shutdown({ reason: 'quit' }, f.context);
  assert.equal(f.memberCount(), 0, 'graceful quit excludes the member');
  await f.events.session_shutdown({ reason: 'quit' }, f.context); // 幂等
  f.events.session_start({}, f.context);
  await f.events.session_shutdown({ reason: 'resume' }, f.context);
  assert.equal(f.memberCount(), 0, 'switching away lets the new session take over');
});

for (const signal of ['SIGHUP', 'SIGTERM']) {
  test(`${signal} followed by Pi quit cleanup preserves the member, even with host listener first`, async (t) => {
    const f = await loadExtension(t);
    f.events.session_start({}, f.context);
    let shutdown;
    const host = () => { shutdown = f.events.session_shutdown({ reason: 'quit' }, f.context); };
    process.prependListener(signal, host);
    t.after(() => process.off(signal, host));
    // Dispatch only our fixture's listeners; never signal the test runner itself.
    for (const listener of [...process.listeners(signal)]) listener();
    await shutdown;
    assert.equal(f.memberCount(), 1, 'terminal shutdown must not delete the restore member');
  });
}

test('reload cleans up signal listeners without accumulating duplicates', async (t) => {
  const f = await loadExtension(t);
  const before = process.listenerCount('SIGHUP');
  f.events.session_start({}, f.context);
  assert.equal(process.listenerCount('SIGHUP'), before + 1);
  await f.events.session_shutdown({ reason: 'reload' }, f.context);
  assert.equal(process.listenerCount('SIGHUP'), before);
  f.events.session_start({}, f.context);
  assert.equal(process.listenerCount('SIGHUP'), before + 1);
});

test('/all delegates to shared core: spawns only non-live members, reports via notify', async (t) => {
  const f = await loadExtension(t);
  f.events.session_start({}, f.context);
  const sessions = join(f.agentDir, 'sessions', 'proj');
  fs.mkdirSync(sessions, { recursive: true });
  const sessionFile = join(sessions, 't_dead.jsonl');
  fs.writeFileSync(sessionFile, '{}\n');
  fs.writeFileSync(join(f.membersDir, 'dead.json'), JSON.stringify({
    sessionId: 'dead', cwd: f.home, sessionFile, name: 'dead', ts: Date.now() - 1000,
  }));
  await f.commands.all.handler('', f.context);
  assert.equal(f.hooks.calls.length, 1, 'only the passive-dead member is spawned');
  const { program, args } = f.hooks.calls[0];
  assert.equal(program, join(f.home, 'wez.exe'));
  assert.equal(args.includes('Arch'), true);
  assert.equal(args.includes('-d'), true);
  assert.ok(args.at(-1).includes(sessionFile), 'restores by absolute session file');
  assert.equal(args.at(-1).includes('exec pi --session'), true);
  assert.match(f.notices.join('\n'), /已创建标签页，超时未确认 pi 启动/);
  assert.equal(fs.readdirSync(f.membersDir).length, 2, 'own live member untouched, no duplicates');
});

test('/all clear empties member records', async (t) => {
  const f = await loadExtension(t);
  f.events.session_start({}, f.context);
  assert.equal(fs.readdirSync(f.membersDir).length, 1);
  await f.commands.all.handler('clear', f.context);
  assert.equal(f.memberCount(), 0);
  assert.match(f.notices.join('\n'), /已清空/);
});

test('extension refuses unknown argument without spawning', async (t) => {
  const f = await loadExtension(t);
  f.events.session_start({}, f.context);
  f.hooks.calls.length = 0; // 共享记录数组，先清空
  await f.commands.all.handler('bogus', f.context);
  assert.match(f.notices.join('\n'), /用法/);
  assert.equal(f.hooks.calls.length, 0);
});
