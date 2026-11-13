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
  pi-reopen list [--wide]         # 查看登记成员与状态（长内容默认按终端宽度截断，--wide 不截断）
  pi-reopen doctor                # 环境检查（WezTerm / WSL 互操作 / pi）
  pi-reopen clear                 # 清空登记（不删除对话文件）

每个 wezterm cli spawn 请求超过 15s 无响应会终止并报失败，连续 3 次请求失败提前停止；
默认在全部请求发出后等待各 pi 启动并登记再报告，--no-wait 跳过该等待。`;

/** 单字符显示宽度：CJK/全角记 2，其余记 1（东亚宽度简化表）。 */
function charWidth(cp) {
	if (
		(cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) ||
		(cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
		(cp >= 0x20000 && cp <= 0x2fffd) || (cp >= 0x30000 && cp <= 0x3fffd)
	) return 2;
	return 1;
}

export function displayWidth(str) {
	let w = 0;
	for (const ch of str) w += charWidth(ch.codePointAt(0));
	return w;
}

function padTo(str, width) {
	const gap = width - displayWidth(str);
	return gap > 0 ? `${str}${" ".repeat(gap)}` : str;
}

/** 按显示宽度截断，超出尾部加省略号。 */
function truncateTo(str, width) {
	if (displayWidth(str) <= width) return str;
	if (width <= 1) return "…";
	let out = "";
	let w = 0;
	for (const ch of str) {
		const cw = charWidth(ch.codePointAt(0));
		if (w + cw > width - 1) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

const SEP = " | ";

/** 对齐表格：状态/会话/路径/时间；超宽时截断会话名/路径；终端过窄放不下表格时退回未对齐的简单行。 */
function listLines({ plan }, { termWidth = 80 } = {}) {
	if (!plan.items.length) return ["没有登记成员。关闭 WezTerm 时仍打开的 Pi 会在下次启动后自动登记。"];
	const rows = plan.items.map((item) => [
		label(item.state),
		item.entry.name || item.entry.sessionId,
		item.entry.cwd ?? "",
		new Date(item.entry.ts).toLocaleString(),
	]);
	const stateW = Math.max(8, ...rows.map((r) => displayWidth(r[0])));
	const whenW = Math.max(4, ...rows.map((r) => displayWidth(r[3])));
	let titleW = Math.max(1, ...rows.map((r) => displayWidth(r[1])));
	let cwdW = Math.max(1, ...rows.map((r) => displayWidth(r[2])));
	const avail = termWidth - stateW - whenW - SEP.length * 3;
	if (Number.isFinite(avail) && avail < 8) return rows.map((r) => r.join(SEP));
	if (Number.isFinite(avail) && titleW + cwdW > avail) {
		const total = titleW + cwdW;
		titleW = Math.min(Math.max(4, Math.floor((avail * titleW) / total)), avail - 4);
		cwdW = avail - titleW;
	}
	const widths = [stateW, titleW, cwdW, whenW];
	const render = (cells) => cells.map((c, i) => padTo(truncateTo(c, widths[i]), widths[i])).join(SEP);
	return [render(["状态", "会话", "路径", "时间"]), ...rows.map(render)];
}

export async function run(argv = [], { stdout = process.stdout, env = process.env } = {}) {
	const [command, ...flags] = argv;
	const hasFlag = (name) => flags.includes(name);
	const write = (line) => {
		try {
			stdout.write(`${line}\n`);
		} catch (err) {
			if (err?.code !== "EPIPE") throw err;
			process.exit(0); // 管道提前关闭（如 | head），正常退出
		}
	};
	stdout.on?.("error", (err) => {
		if (err?.code === "EPIPE") process.exit(0); // 管道提前关闭（如 | head），正常退出
		throw err;
	});

	switch (command ?? "restore") {
		case "restore": {
			const result = await runRestore({ env, dryRun: hasFlag("--dry-run"), noWait: hasFlag("--no-wait") });
			for (const line of summarize(result)) write(line);
			if (!result.ok) return result.stage === "preflight" ? 2 : 1;
			return 0;
		}
		case "list": {
			const wide = hasFlag("--wide");
			let columns = Number(stdout?.columns);
			if (!Number.isFinite(columns) || columns <= 0) columns = Number(env.COLUMNS);
			if (!Number.isFinite(columns) || columns <= 0) columns = 80;
			const lines = listLines(inspect({ paths: workspacePaths(env) }), {
				termWidth: wide ? Number.POSITIVE_INFINITY : columns,
			});
			for (const line of lines) write(line);
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
