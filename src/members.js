import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "./paths.js";

/**
 * 成员记录语义（已确认规则）：
 * - Pi 打开（session_start）→ 写入/刷新记录（含 pid、processStart、bootId）
 * - Pi 内主动退出 / 切换会话（session_shutdown: quit|new|resume|fork）→ 删除记录（不恢复）
 * - 被动死亡（关窗、崩溃、WSL 关机）→ 无清理，记录自然残留 → 恢复
 */
function writeAtomic(file, data) {
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, data, { mode: 0o600 });
	renameSync(temp, file);
}

export function writeMember(entry, paths = workspacePaths()) {
	mkdirSync(paths.members, { recursive: true });
	writeAtomic(join(paths.members, `${entry.sessionId}.json`), JSON.stringify(entry, null, 2));
}

export function readMember(sessionId, paths = workspacePaths()) {
	try {
		return JSON.parse(readFileSync(join(paths.members, `${sessionId}.json`), "utf8"));
	} catch {
		return undefined;
	}
}

export function deleteMember(sessionId, paths = workspacePaths()) {
	try {
		unlinkSync(join(paths.members, `${sessionId}.json`));
	} catch {
		/* 不存在即目标状态 */
	}
}

export function listMembers(paths = workspacePaths()) {
	const out = [];
	let files;
	try {
		files = readdirSync(paths.members);
	} catch {
		return out;
	}
	for (const file of files.filter((f) => f.endsWith(".json"))) {
		try {
			const entry = JSON.parse(readFileSync(join(paths.members, file), "utf8"));
			if (entry?.sessionId) out.push(entry);
		} catch {
			/* 跳过损坏记录，恢复时宁可少报不可错报 */
		}
	}
	return out.sort((a, b) => a.ts - b.ts);
}

/** 清空登记与启动占用；不触碰旧格式文件与对话文件。 */
export function clearWorkspace(paths = workspacePaths()) {
	let removed = 0;
	for (const dir of [paths.members, paths.claims]) {
		let files;
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of files.filter((f) => f.endsWith(".json"))) {
			try {
				unlinkSync(join(dir, file));
				removed++;
			} catch {
				/* 忽略 */
			}
		}
	}
	return removed;
}
