import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const project = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * /all recent 补选路径：用 src 副本替换 preflight/spawn 为可观察 stub，
 * 验证候选发现、输入校验、确认流程、成功登记与失败回收。
 */
async function loadRecent(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'pi-ws-recent-'));
  const originalSignals = new Map(['SIGHUP', 'SIGTERM'].map((s) => [s, process.listeners(s)]));
  t.after(() => {
    for (const [signal, original] of originalSignals) {
      for (const listener of process.listeners(signal)) {
        if (!original.includes(listener)) process.off(signal, listener);
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of ['PI_CODING_AGENT_DIR', 'PI_WORKSPACE_HOOKS', 'PI_WORKSPACE_SRC', 'PI_WORKSPACE_WEZTERM', 'PI_WORKSPACE_TEST_CALLS', 'WSL_DISTRO_NAME']) delete process.env[key];
  });

  const srcCopy = join(home, 'src');
  fs.cpSync(join(project, 'src'), srcCopy, { recursive: true });
  const calls = join(home, 'open-tab-calls.jsonl');
  fs.writeFileSync(join(srcCopy, 'spawn.js'), [
    'import { appendFileSync } from "node:fs";',
    'export async function openTab(args) {',
    '  appendFileSync(process.env.PI_WORKSPACE_TEST_CALLS, JSON.stringify(args) + "\\n");',
    '  if (String(args.cwd).includes("FAIL")) return { ok: false, error: "stub failure" };',
    '  return { ok: true, stdout: "pane" };',
    '}',
  ].join('\n'));
  fs.writeFileSync(join(srcCopy, 'preflight.js'), [
    'export function preflight() {',
    '  return { ok: true, wezterm: process.env.PI_WORKSPACE_WEZTERM, distro: process.env.WSL_DISTRO_NAME, piBin: "/custom/pi", checks: [] };',
    '}',
  ].join('\n'));

  const agentDir = join(home, '.pi', 'agent');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_WORKSPACE_SRC = srcCopy;
  process.env.PI_WORKSPACE_WEZTERM = join(home, 'wez.exe');
  process.env.WSL_DISTRO_NAME = 'Arch';
  process.env.PI_WORKSPACE_TEST_CALLS = calls;
  fs.writeFileSync(join(home, 'wez.exe'), 'MZ');

  const raw = fs.readFileSync(join(project, 'extensions/open-all.ts'), 'utf8');
  const source = stripTypeScriptTypes(raw)
    .replace('import { Key } from "@earendil-works/pi-tui";', 'const Key = { ctrlShift: (k) => `ctrl+shift+${k}` };');
  const tempFile = join(home, 'open-all.recent.mjs');
  fs.writeFileSync(tempFile, source);
  const mod = await import(pathToFileURL(tempFile).href);

  const events = {}, commands = {}, notices = [];
  await mod.default({
    on: (name, handler) => { events[name] = handler; },
    registerCommand: (name, command) => { commands[name] = command; },
    registerShortcut() {},
  });
  const membersDir = join(agentDir, 'pi-workspace', 'members');
  const context = {
    mode: 'tui', cwd: home,
    sessionManager: { getSessionId: () => 'current', getSessionFile: () => join(home, 'current.jsonl'), getSessionName: () => 'current' },
    ui: { notify: (m) => notices.push(m), input: async () => undefined, confirm: async () => true },
  };
  // 候选会话：24 小时内、非当前会话、非存活
  function addCandidate(id, cwd) {
    const dir = join(agentDir, 'sessions', 'proj');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ id, cwd }) + '\n');
    return file;
  }
  const readCalls = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { home, agentDir, membersDir, events, commands, notices, context, addCandidate, readCalls };
}

test('/all recent: candidate discovery, confirm, spawn, and member registration', async (t) => {
  const f = await loadRecent(t);
  await f.events.session_start({}, f.context);
  const file = f.addCandidate('cand', join(f.home, 'cand-cwd'));
  f.context.ui.input = async () => '1';
  await f.commands.all.handler('recent', f.context);
  const calls = f.readCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].wezterm, join(f.home, 'wez.exe'));
  assert.equal(calls[0].distro, 'Arch');
  assert.equal(calls[0].piBin, '/custom/pi');
  assert.equal(calls[0].cwd, join(f.home, 'cand-cwd'));
  assert.equal(calls[0].sessionFile, file);
  const member = JSON.parse(fs.readFileSync(join(f.membersDir, 'cand.json'), 'utf8'));
  assert.equal(member.sessionId, 'cand');
  assert.equal(member.sessionFile, file);
  assert.ok(fs.existsSync(join(f.membersDir, '..', 'starting', 'cand.json')), '成功后保留启动声明直至新 Pi 登记');
  assert.match(f.notices.join('\n'), /已请求打开 1 个 pi 终端/);
});

test('/all recent: out-of-range and non-numeric input opens nothing', async (t) => {
  const f = await loadRecent(t);
  await f.events.session_start({}, f.context);
  f.addCandidate('cand', join(f.home, 'cand-cwd'));
  f.context.ui.input = async () => '99,0,abc';
  await f.commands.all.handler('recent', f.context);
  assert.equal(f.readCalls().length, 0);
  assert.match(f.notices.join('\n'), /序号无效/);
});

test('/all recent: declining confirmation opens nothing', async (t) => {
  const f = await loadRecent(t);
  await f.events.session_start({}, f.context);
  f.addCandidate('cand', join(f.home, 'cand-cwd'));
  f.context.ui.input = async () => '1';
  f.context.ui.confirm = async () => false;
  await f.commands.all.handler('recent', f.context);
  assert.equal(f.readCalls().length, 0);
  assert.equal(fs.existsSync(join(f.membersDir, 'cand.json')), false, '未打开不登记成员');
});

test('/all recent: no candidates in 24h window reports and stops', async (t) => {
  const f = await loadRecent(t);
  await f.events.session_start({}, f.context);
  await f.commands.all.handler('recent', f.context);
  assert.equal(f.readCalls().length, 0);
  assert.match(f.notices.join('\n'), /近 24 小时没有可补选的对话/);
});

test('/all recent: spawn failure releases claim, registers no member, reports error', async (t) => {
  const f = await loadRecent(t);
  await f.events.session_start({}, f.context);
  f.addCandidate('bad', join(f.home, 'FAIL-cwd'));
  f.context.ui.input = async () => '1';
  await f.commands.all.handler('recent', f.context);
  assert.equal(f.readCalls().length, 1, '请求仍发出');
  assert.equal(fs.existsSync(join(f.membersDir, 'bad.json')), false, '失败不登记成员');
  assert.equal(fs.existsSync(join(f.agentDir, 'pi-workspace', 'starting', 'bad.json')), false, '失败回收启动声明');
  assert.match(f.notices.join('\n'), /WezTerm 请求失败 — stub failure/);
  assert.match(f.notices.join('\n'), /没有打开任何标签页/);
});

test('/all recent: live and own sessions are excluded from candidates', async (t) => {
  const f = await loadRecent(t);
  await f.events.session_start({}, f.context);
  const { processStart, currentBootId } = await import('../src/liveness.js');
  // own 会话文件出现在 sessions 目录 → 按 sessionId 排除
  f.addCandidate('current', join(f.home, 'own-cwd'));
  // 存活会话 → 按 liveness 排除
  const liveFile = f.addCandidate('live', join(f.home, 'live-cwd'));
  fs.writeFileSync(join(f.membersDir, 'live.json'), JSON.stringify({
    sessionId: 'live', cwd: join(f.home, 'live-cwd'), sessionFile: liveFile, ts: Date.now(),
    pid: process.pid, processStart: processStart(process.pid), bootId: currentBootId(),
  }));
  f.context.ui.input = async () => '1';
  await f.commands.all.handler('recent', f.context);
  assert.equal(f.readCalls().length, 0, 'own 与 live 会话均被排除');
  assert.match(f.notices.join('\n'), /近 24 小时没有可补选的对话/);
});
