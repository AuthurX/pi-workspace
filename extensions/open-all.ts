/**
 * pi-workspace 扩展：登记存活 Pi、区分主动退出与被动死亡、提供 Pi 内恢复入口。
 * 核心逻辑在项目 src/*.js（CLI 共用）；本文件只做 Pi 侧适配。
 */
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

// 本机开发布局兜底；一般环境靠 realpath 或 PI_WORKSPACE_SRC 定位
const FALLBACK_SRC = "/home/ellie/work/MY/code/pi-workspcace/src";

function resolveSrcDir(): string {
	const candidates: string[] = [];
	if (process.env.PI_WORKSPACE_SRC) candidates.push(process.env.PI_WORKSPACE_SRC);
	try {
		candidates.push(join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "src"));
	} catch {
		/* import.meta.url 不可用时忽略 */
	}
	candidates.push(FALLBACK_SRC);
	for (const dir of candidates) {
		try {
			realpathSync(join(dir, "restore.js"));
			return dir;
		} catch {
			/* 尝试下一个候选 */
		}
	}
	throw new Error("无法定位 pi-workspace 源码目录；可设置 PI_WORKSPACE_SRC");
}

const ENTRY_WINDOW_MS = 24 * 3_600_000;

export default async function (pi: ExtensionAPI) {
	const srcDir = resolveSrcDir();
	const load = async (name: string) => await import(pathToFileURL(join(srcDir, name)).href);
	const { workspacePaths } = await load("paths.js");
	const members = await load("members.js");
	const liveness = await load("liveness.js");
	const claims = await load("claims.js");
	const restore = await load("restore.js");
	const spawn = await load("spawn.js");
	const preflightMod = await load("preflight.js");
	const fs = await import("node:fs");
	const paths = workspacePaths();

	let currentSessionId: string | undefined;
	let signalExit = false;
	const signals = process.platform === "win32" ? ["SIGTERM"] as const : ["SIGHUP", "SIGTERM"] as const;
	const markSignalExit = () => { signalExit = true; };
	function detachSignals(): void {
		for (const signal of signals) process.off(signal, markSignalExit);
	}

	// 测试钩子：仅在设置 PI_WORKSPACE_HOOKS 时生效，返回 runRestore 的注入参数
	async function loadHooks(): Promise<any> {
		const file = process.env.PI_WORKSPACE_HOOKS;
		if (!file) return {};
		try {
			const mod = await import(pathToFileURL(file).href);
			return typeof mod.default === "function" ? await mod.default() : mod;
		} catch {
			return {};
		}
	}

	pi.on("session_start", (_event: unknown, ctx: any) => {
		detachSignals();
		signalExit = false;
		if (ctx.mode === "tui") {
			for (const signal of signals) process.on(signal, markSignalExit);
		}
		register(ctx);
	});

	// 全新会话启动时文件尚未落盘；首条用户消息后补登记，此后每次发消息刷新时间戳
	pi.on("message_end", (event: any, ctx: any) => {
		if (event?.message?.role === "user") register(ctx);
	});

	function register(ctx: any): void {
		if (ctx.mode !== "tui") return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return; // 仍未落盘的空窗口，不登记（恢复时跳过）
		currentSessionId = ctx.sessionManager.getSessionId();
		members.writeMember({
			sessionId: currentSessionId,
			cwd: ctx.cwd,
			sessionFile,
			name: ctx.sessionManager.getSessionName(),
			ts: Date.now(),
			pid: process.pid,
			processStart: liveness.processStart(process.pid),
			bootId: liveness.currentBootId(),
		});
		claims.releaseClaim(currentSessionId, paths);
	}

	pi.on("session_shutdown", async (event: any) => {
		// Pi also emits quit for SIGHUP/SIGTERM. Let all signal listeners run first.
		if (event.reason === "quit") await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			if (!currentSessionId || event.reason === "reload") return;
			if (event.reason === "quit" && signalExit) return;
			if (["quit", "new", "resume", "fork"].includes(event.reason)) {
				members.deleteMember(currentSessionId, paths);
			}
		} finally {
			detachSignals();
			currentSessionId = undefined;
		}
	});

	async function restoreAndReport(ctx: any, dryRun = false): Promise<void> {
		const result = await restore.runRestore({ dryRun, ...(await loadHooks()) });
		for (const line of restore.summarize(result)) ctx.ui.notify(line, result.ok ? "info" : "warning");
	}

	async function openRecent(ctx: any): Promise<void> {
		const now = Date.now();
		const candidates: any[] = [];
		try {
			for (const dir of fs.readdirSync(paths.sessions)) {
				const p = join(paths.sessions, dir);
				let files: string[];
				try {
					files = fs.readdirSync(p).filter((f: string) => f.endsWith(".jsonl"));
				} catch {
					continue;
				}
				for (const file of files) {
					const full = join(p, file);
					try {
						const mtime = fs.statSync(full).mtimeMs;
						if (now - mtime > ENTRY_WINDOW_MS) continue;
						const header = JSON.parse(fs.readFileSync(full, "utf8").split("\n")[0]);
						if (header.id && header.cwd) {
							candidates.push({ sessionId: header.id, cwd: header.cwd, sessionFile: full, ts: mtime });
						}
					} catch {
						/* 跳过损坏文件 */
					}
				}
			}
		} catch {
			/* 无会话目录 */
		}
		const live = new Set(members.listMembers(paths).filter((m: any) => liveness.isLive(m)).map((m: any) => m.sessionId));
		const own = currentSessionId;
		const todo = candidates
			.filter((c) => c.sessionId !== own && !live.has(c.sessionId))
			.sort((a, b) => b.ts - a.ts);
		if (!todo.length) {
			ctx.ui.notify("近 24 小时没有可补选的对话", "info");
			return;
		}
		const list = todo
			.map((e, i) => `${i + 1}. ${new Date(e.ts).toLocaleString()} | ${e.cwd} | ${e.name ?? e.sessionId}`)
			.join("\n");
		const input = await ctx.ui.input(`近期候选（不代表原先打开的窗口）\n${list}\n输入序号，多个用逗号分隔；取消则不打开`);
		if (!input?.trim()) return;
		const parts = input.trim().split(/[\s,，]+/);
		if (parts.some((p: string) => !/^\d+$/.test(p) || Number(p) < 1 || Number(p) > todo.length)) {
			ctx.ui.notify("序号无效，未打开标签页", "warning");
			return;
		}
		const selected = [...new Set(parts.map(Number))].map((n: number) => todo[n - 1]);
		if (!(await ctx.ui.confirm("恢复选中的 Pi 对话？", selected.map((e: any) => `${e.cwd} | ${e.name ?? e.sessionId}`).join("\n")))) return;
		const pre = preflightMod.preflight();
		if (!pre.ok) {
			for (const line of restore.summarize({ ok: false, stage: "preflight", checks: pre.checks })) {
				ctx.ui.notify(line, "warning");
			}
			return;
		}
		let opened = 0;
		for (const entry of selected) {
			const claim = claims.claimSession(entry.sessionId, process.pid, paths);
			if (!claim.claimed) continue;
			const result = await spawn.openTab({
				wezterm: pre.wezterm,
				distro: pre.distro,
				cwd: entry.cwd,
				sessionFile: entry.sessionFile,
			});
			if (result.ok) {
				members.writeMember({ ...entry, pid: undefined, processStart: undefined, bootId: undefined, ts: Date.now() });
				opened++;
			} else {
				claims.releaseClaim(entry.sessionId, paths);
				ctx.ui.notify(`${entry.cwd}：WezTerm 请求失败 — ${result.error}`, "warning");
			}
		}
		ctx.ui.notify(opened ? `已请求打开 ${opened} 个 pi 终端` : "没有打开任何标签页", opened ? "info" : "warning");
	}

	pi.registerCommand("all", {
		description: "恢复已登记的 pi 终端（/all recent 补选历史；/all clear 清空登记）",
		handler: async (args: string, ctx: any) => {
			const arg = (args ?? "").trim();
			if (arg === "clear") {
				const removed = members.clearWorkspace(paths);
				ctx.ui.notify(`已清空 ${removed} 条登记；对话文件未删除`, "info");
				return;
			}
			if (arg === "recent") return openRecent(ctx);
			if (arg) {
				ctx.ui.notify("用法：/all | /all recent | /all clear", "warning");
				return;
			}
			await restoreAndReport(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlShift("o"), {
		description: "一键恢复上次所有 pi 终端",
		handler: async (ctx: any) => {
			await restoreAndReport(ctx);
		},
	});
}
