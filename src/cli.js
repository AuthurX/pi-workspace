import { readFileSync } from "node:fs";
import { join } from "node:path";
import { binfmtStatus, PERSIST_HINT } from "./binfmt.js";
import { workspacePaths } from "./paths.js";
import { currentBootId, isLive } from "./liveness.js";
import { clearWorkspace } from "./members.js";
import { inspect, label, runRestore, summarize } from "./restore.js";
import { preflight } from "./preflight.js";

const USAGE = `pi-reopen — 恢复上次的 Pi 终端组合

用法：
  pi-reopen                       # 补开上次关闭时仍打开的 Pi（已运行的跳过）
  pi-reopen restore --dry-run     # 只看计划，不开标签页
  pi-reopen list                  # 查看登记成员与状态
  pi-reopen doctor                # 环境检查（WezTerm / WSL 互操作 / pi）
  pi-reopen clear                 # 清空登记（不删除对话文件）

每个 wezterm cli spawn 请求超过 15s 无响应会终止并报失败，连续 3 次请求失败提前停止；
默认在全部请求发出后等待各 pi 启动并登记再报告，--no-wait 跳过该等待。`;

function listLines({ plan }) {
	if (!plan.items.length) return ["没有登记成员。关闭 WezTerm 时仍打开的 Pi 会在下次启动后自动登记。"];
	const lines = [];
	for (const item of plan.items) {
		const title = item.entry.name || item.entry.sessionId;
		const when = new Date(item.entry.ts).toLocaleString();
		lines.push(`${label(item.state).padEnd(8)} ${title} | ${item.entry.cwd} | ${when}`);
	}
	return lines;
}

export async function run(argv = [], { stdout = process.stdout, env = process.env } = {}) {
	const [command, ...flags] = argv;
	const hasFlag = (name) => flags.includes(name);
	const write = (line) => stdout.write(`${line}\n`);

	switch (command ?? "restore") {
		case "restore": {
			const result = await runRestore({ env, dryRun: hasFlag("--dry-run"), noWait: hasFlag("--no-wait") });
			for (const line of summarize(result)) write(line);
			if (!result.ok) return result.stage === "preflight" ? 2 : 1;
			return 0;
		}
		case "list": {
			for (const line of listLines(inspect({ paths: workspacePaths(env) }))) write(line);
			return 0;
		}
		case "doctor": {
			const pre = preflight({ env });
			for (const check of pre.checks) {
				write(`${check.ok ? "✔" : "✖"} ${check.name}：${check.detail}`);
				if (check.hint) write(`  → ${check.hint}`);
			}
			const binfmt = binfmtStatus();
			if (binfmt.registered && !binfmt.persistent) {
				write("⚠ WSLInterop 已注册但未持久化：");
				for (const line of PERSIST_HINT.split("\n")) write(`  ${line}`);
			}
			write(pre.ok ? "环境就绪。" : "存在未通过项，恢复前需先解决。");
			return pre.ok ? 0 : 2;
		}
		case "clear": {
			const removed = clearWorkspace(workspacePaths(env));
			write(`已清空 ${removed} 条登记与启动占用；对话文件与旧格式记录未删除。`);
			return 0;
		}
		default:
			write(USAGE);
			return 1;
	}
}
