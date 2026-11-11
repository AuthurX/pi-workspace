import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentBootId, processStart } from "./liveness.js";
import { workspacePaths } from "./paths.js";

export const CLAIM_TTL_MS = 60_000;
const RESTORE_LOCK_TTL_MS = 30 * 60_000;

function writeAtomic(file, data) {
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, data, { mode: 0o600 });
	renameSync(temp, file);
}

export function readClaim(sessionId, paths = workspacePaths()) {
	try {
		return JSON.parse(readFileSync(join(paths.claims, `${sessionId}.json`), "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * 声明“本会话正在被启动”，防止并发/连续恢复重复开标签页。
 * 已有声明在 TTL 内且持有者进程存活时视为占用；过期或持有者已死则接管。
 */
export function claimSession(sessionId, ownerPid, paths = workspacePaths(), now = Date.now()) {
	mkdirSync(paths.claims, { recursive: true });
	const existing = readClaim(sessionId, paths);
	if (
		existing &&
		existing.pid !== ownerPid &&
		now - existing.ts < CLAIM_TTL_MS &&
		processStart(existing.pid) !== undefined
	) {
		return { claimed: false, holder: existing };
	}
	writeAtomic(join(paths.claims, `${sessionId}.json`), JSON.stringify({ pid: ownerPid, ts: now }));
	return { claimed: true };
}

/** 新 Pi 完成登记时清除自己的启动声明。 */
export function releaseClaim(sessionId, paths = workspacePaths()) {
	try {
		unlinkSync(join(paths.claims, `${sessionId}.json`));
	} catch {
		/* 不存在即目标状态 */
	}
}

/** 清理过期或持有者已死的声明（恢复前调用）。 */
export function sweepClaims(paths = workspacePaths(), now = Date.now()) {
	let files;
	try {
		files = readdirSync(paths.claims);
	} catch {
		return;
	}
	for (const file of files.filter((f) => f.endsWith(".json"))) {
		try {
			const claim = JSON.parse(readFileSync(join(paths.claims, file), "utf8"));
			const dead = now - claim.ts >= CLAIM_TTL_MS || processStart(claim.pid) === undefined;
			if (dead) unlinkSync(join(paths.claims, file));
		} catch {
			/* 损坏声明留待 TTL 后接管 */
		}
	}
}

/**
 * 全局恢复锁：同一时间只允许一个恢复进程批量开标签页，
 * 防止并发恢复叠加成 WSL 标签页风暴（曾导致 WezTerm 卡死崩溃）。
 * 接管条件：无锁 / 锁记录损坏 / 跨启动周期（bootId 不一致，防止重启后 PID 重用误判）
 * / 持有者进程已死 / 超过 30 分钟 TTL。
 */
export function acquireRestoreLock(paths = workspacePaths(), pid = process.pid, now = Date.now(), bootId = currentBootId()) {
	const file = join(paths.workspace, "restore.lock");
	try {
		const existing = JSON.parse(readFileSync(file, "utf8"));
		if (
			existing?.pid !== pid &&
			bootId !== undefined &&
			existing.bootId === bootId &&
			now - existing.ts < RESTORE_LOCK_TTL_MS &&
			processStart(existing.pid) !== undefined
		) {
			return { locked: true, holder: existing };
		}
	} catch {
		/* 无锁或锁记录损坏：接管 */
	}
	mkdirSync(paths.workspace, { recursive: true });
	writeAtomic(file, JSON.stringify({ pid, ts: now, bootId }));
	return { locked: false };
}

/** 释放全局恢复锁（只释放自己的锁）。 */
export function releaseRestoreLock(paths = workspacePaths(), pid = process.pid) {
	const file = join(paths.workspace, "restore.lock");
	try {
		const lock = JSON.parse(readFileSync(file, "utf8"));
		if (lock?.pid === pid) unlinkSync(file);
	} catch {
		/* 无锁即目标状态 */
	}
}
