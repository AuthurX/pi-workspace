import { readFileSync } from "node:fs";

/** 当前 Linux/WSL 启动 ID；重启后变化。 */
export function currentBootId(readFile = (p) => readFileSync(p, "utf8")) {
	try {
		return readFile("/proc/sys/kernel/random/boot_id").trim();
	} catch {
		return undefined;
	}
}

/** 进程启动时刻（/proc stat 字段 22）；进程不存在或为僵尸时 undefined。 */
export function processStart(pid, readFile = (p) => readFileSync(p, "utf8")) {
	try {
		const stat = readFile(`/proc/${pid}/stat`);
		const after = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
		if (after[0] === "Z") return undefined;
		return after[19];
	} catch {
		return undefined;
	}
}

/**
 * 记录所指向的 Pi 进程是否仍在同一启动周期内存活。
 * bootId 不一致（重启过）一律视为不存活——满足“重启后失效 PID 不误判”。
 */
export function isLive(entry, deps = {}) {
	if (!entry?.pid || !entry?.processStart || !entry?.bootId) return false;
	// bootId 允许传值或函数，便于调用方复用已读取的值
	const boot = typeof deps.bootId === "function" ? deps.bootId() : (deps.bootId ?? currentBootId());
	if (boot !== entry.bootId) return false;
	const start = deps.processStart
		? deps.processStart(entry.pid)
		: processStart(entry.pid);
	return start === entry.processStart;
}
