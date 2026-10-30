import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { isLive } from "./liveness.js";
import { workspacePaths } from "./paths.js";

/** 由记录定位会话文件：优先记录内绝对路径，否则按 sessionId 扫描会话目录。 */
export function resolveSessionFile(entry, paths = workspacePaths()) {
	if (entry.sessionFile && existsSync(entry.sessionFile)) return entry.sessionFile;
	try {
		for (const dir of readdirSync(paths.sessions)) {
			const p = join(paths.sessions, dir);
			if (!statSync(p).isDirectory()) continue;
			const file = readdirSync(p).find((f) => f.endsWith(`_${entry.sessionId}.jsonl`));
			if (file) return join(p, file);
		}
	} catch {
		/* 无会话目录 */
	}
	return undefined;
}

function dedupeKey(sessionFile) {
	try {
		return realpathSync(sessionFile);
	} catch {
		return sessionFile;
	}
}

/**
 * 生成恢复计划。状态语义：
 * live        进程仍存活，跳过（也自然排除了发起恢复的当前会话）
 * claimed     其他恢复进程正在启动它，跳过
 * missing-cwd 工作目录不存在，跳过并报告
 * missing-file 会话文件不存在（未落盘/已删除），跳过并报告
 * duplicate   与更早条目指向同一会话文件（含别名），跳过
 * restorable  待恢复
 */
export function buildRestorePlan({
	members,
	paths = workspacePaths(),
	liveFn = isLive,
	claimFn,
	bootId,
}) {
	const seen = new Set();
	const items = [];
	const sorted = [...members].sort((a, b) => a.ts - b.ts);
	for (const entry of sorted) {
		let state = "restorable";
		let sessionFile;
		let detail;
		if (liveFn(entry, { bootId })) {
			state = "live";
		} else if (claimFn?.(entry.sessionId)) {
			state = "claimed";
		} else if (!existsSync(entry.cwd)) {
			state = "missing-cwd";
		} else {
			sessionFile = resolveSessionFile(entry, paths);
			if (!sessionFile) {
				state = "missing-file";
			} else {
				const key = dedupeKey(sessionFile);
				if (seen.has(key)) {
					state = "duplicate";
				} else {
					seen.add(key);
				}
			}
		}
		items.push({ entry, sessionFile, state });
	}
	return {
		items,
		restorable: items.filter((i) => i.state === "restorable"),
		count: (state) => items.filter((i) => i.state === state).length,
	};
}
