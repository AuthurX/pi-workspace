import { spawn } from "node:child_process";

import { launchSetup, shellQuote } from "./launch.js";
export { shellQuote } from "./launch.js";

/** 登录 shell 初始化后恢复调用方 PATH 和 agent 目录，再启动已预检的 Pi。 */
export function buildTabScript({ cwd, sessionFile, piBin, env = process.env }) {
	return [
		launchSetup(env, piBin),
		`cd -- ${shellQuote(cwd)} && exec ${piBin ? shellQuote(piBin) : "pi"} --session ${shellQuote(sessionFile)}`,
	].join("; ");
}

function defaultSpawner(program, args) {
	return new Promise((resolve) => {
		try {
			const child = spawn(program, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (d) => (stdout += d));
			child.stderr?.on("data", (d) => (stderr += d));
			const fail = (error) => resolve({ ok: false, error: String(error) });
			child.on("error", (error) => fail(error));
			child.on("close", (code) => {
				if (code === 0) resolve({ ok: true, stdout: stdout.trim() });
				else resolve({ ok: false, error: stderr.trim() || `wezterm cli 退出码 ${code}` });
			});
		} catch (error) {
			resolve({ ok: false, error: String(error) });
		}
	});
}

/**
 * 请求 WezTerm 打开一个标签页。返回 ok 只代表“请求被 WezTerm 接受”，
 * 不代表 pi 已成功启动——后者由 verify 阶段确认。
 */
export async function openTab({ wezterm, distro, cwd, sessionFile, piBin, env = process.env, spawner } = {}) {
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
	const run = spawner ?? defaultSpawner;
	return run(wezterm, args);
}
