import { readMember } from "./members.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等待被恢复的 Pi 完成登记（成员记录被新进程以新时间戳覆盖）。
 * 只确认“pi 已启动并登记”，超时未确认的如实报告为未确认。
 */
export async function waitForMembers(sessionIds, { paths, timeoutMs = 15_000, pollMs = 500, baseline = Date.now(), sleeper = sleep } = {}) {
	const pending = new Set(sessionIds);
	const verified = new Set();
	const deadline = Date.now() + timeoutMs;
	while (pending.size > 0 && Date.now() < deadline) {
		for (const id of [...pending]) {
			const member = readMember(id, paths);
			if (member && member.ts > baseline) {
				verified.add(id);
				pending.delete(id);
			}
		}
		if (pending.size > 0) await sleeper(pollMs);
	}
	return { verified: [...verified], unverified: [...pending] };
}
