import { spawn } from "node:child_process";

import { launchSetup, shellQuote } from "./launch.js";
export { shellQuote } from "./launch.js";

/** wezterm cli spawn 无响应时的上限；WezTerm 卡死时避免永久阻塞。 */
export const SPAWN_TIMEOUT_MS = 15_000;

/** 登录 shell 初始化后恢复调用方 PATH 和 agent 目录，再启动已预检的 Pi。 */
export function buildTabScript({ cwd, sessionFile, piBin, env = process.env }) {
	return [
		launchSetup(env, piBin),
		`cd -- ${shellQuote(cwd)} && exec ${piBin ? shellQuote(piBin) : "pi"} --session ${shellQuote(sessionFile)}`,
	].join("; ");
}

function defaultSpawner(program, args, timeoutMs = SPAWN_TIMEOUT_MS) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(program, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ ok: false, error: String(error) });
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			settle({ ok: false, error: `wezterm cli 超过 ${timeoutMs}ms 无响应（WezTerm 可能已卡死），已终止该请求` });
			try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
		}, timeoutMs);
		const settle = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		child.stdout?.on("data", (d) => (stdout += d));
		child.stderr?.on("data", (d) => (stderr += d));
		child.on("error", (error) => settle({ ok: false, error: String(error) }));
		child.on("close", (code) => {
			if (code === 0) settle({ ok: true, stdout: stdout.trim() });
			else settle({ ok: false, error: stderr.trim() || `wezterm cli 退出码 ${code}` });
		});
	});
}

/**
 * 请求 WezTerm 打开一个标签页。返回 ok 只代表“请求被 WezTerm 接受”，
 * 不代表 pi 已成功启动——后者由 verify 阶段确认。
 * spawnTimeoutMs 限制 wezterm cli 的响应时间，防止 WezTerm 卡死时永久阻塞。
 */
export async function openTab({ wezterm, distro, cwd, sessionFile, piBin, env = process.env, spawner, spawnTimeoutMs } = {}) {
	const script = buildTabScript({ cwd, sessionFile, piBin, env });
	const args = [
		"cli",
		"spawn",
		"--",
		"wsl.exe",
		...(distro ? ["-d", distro] : []),
		"-e",
		"bash",
		"-lc",
		script,
	];
	const run = spawner ?? ((program, a) => defaultSpawner(program, a, spawnTimeoutMs));
	return run(wezterm, args);
}
