import { claimSession, sweepClaims } from "./claims.js";
import { listMembers } from "./members.js";
import { buildRestorePlan } from "./plan.js";
import { preflight } from "./preflight.js";
import { openTab } from "./spawn.js";
import { workspacePaths } from "./paths.js";
import { currentBootId } from "./liveness.js";
import { waitForMembers } from "./verify.js";

const STATE_LABEL = {
	live: "运行中",
	claimed: "启动占用中",
	"missing-cwd": "工作目录缺失",
	"missing-file": "会话文件缺失",
	duplicate: "重复条目",
	restorable: "待恢复",
};

export function label(state) {
	return STATE_LABEL[state] ?? state;
}

/** 只读：列出全部成员与状态（list / dry-run 共用）。 */
export function inspect({ paths = workspacePaths() } = {}) {
	const members = listMembers(paths);
	const plan = buildRestorePlan({
		members,
		paths,
		claimFn: () => false,
		bootId: currentBootId(),
	});
	return { members, plan };
}

/**
 * 恢复编排：预检 → 计划 → 声明启动占用 → 逐个开标签页 → 等待登记确认。
 * 结果如实区分：requested（WezTerm 接受请求）与 verified（Pi 已启动并登记）。
 */
export async function runRestore({
	env = process.env,
	paths = workspacePaths(env),
	dryRun = false,
	noWait = false,
	waitTimeoutMs = 15_000,
	spawner,
	prober,
	piProber,
} = {}) {
	const pre = preflight({ env, prober, piProber });
	if (!pre.ok) {
		return { ok: false, stage: "preflight", checks: pre.checks };
	}
	sweepClaims(paths);
	const { plan } = inspect({ paths });
	if (dryRun) {
		return { ok: true, stage: "dry-run", plan };
	}
	const baseline = Date.now();
	const results = [];
	for (const item of plan.restorable) {
		const claim = claimSession(item.entry.sessionId, process.pid, paths);
		if (!claim.claimed) {
			results.push({ ...item, state: "claimed" });
			continue;
		}
		const spawnResult = await openTab({
			wezterm: pre.wezterm,
			distro: pre.distro,
			piBin: pre.piBin,
			env,
			cwd: item.entry.cwd,
			sessionFile: item.sessionFile,
			spawner,
		});
		results.push({
			...item,
			requested: spawnResult.ok,
			requestError: spawnResult.ok ? undefined : spawnResult.error,
		});
	}
	const requestedIds = results.filter((r) => r.requested).map((r) => r.entry.sessionId);
	const verification = noWait || requestedIds.length === 0
		? null
		: await waitForMembers(requestedIds, { paths, timeoutMs: waitTimeoutMs, baseline });
	const ok = results.every((r) => r.requested);
	return { ok, stage: "done", plan, results, verification };
}

/** 生成给人看的中文报告行。 */
export function summarize(result) {
	const lines = [];
	if (result.stage === "preflight") {
		lines.push("环境预检未通过，未打开任何标签页：");
		for (const check of result.checks.filter((c) => !c.ok)) {
			lines.push(`  ✖ ${check.name}：${check.detail}`);
			if (check.hint) lines.push(`    → ${check.hint}`);
		}
		return lines;
	}
	const counts = {};
	for (const item of result.plan.items) counts[item.state] = (counts[item.state] ?? 0) + 1;
	const skipped = Object.entries(counts)
		.filter(([state]) => state !== "restorable")
		.map(([state, n]) => `${label(state)} ${n}`)
		.join(" · ");
	if (result.stage === "dry-run") {
		lines.push(`[dry-run] 待恢复 ${result.plan.restorable.length} 个${skipped ? `；跳过：${skipped}` : ""}`);
		for (const item of result.plan.restorable) {
			lines.push(`  → ${item.entry.name || item.entry.sessionId} | ${item.entry.cwd}`);
		}
		return lines;
	}
	for (const r of result.results) {
		const title = r.entry.name || r.entry.sessionId;
		if (r.state === "claimed") {
			lines.push(`  ⏭ ${title}：其他恢复进程正在启动，跳过`);
		} else if (!r.requested) {
			lines.push(`  ✖ ${title}：WezTerm 请求失败 — ${r.requestError}`);
		} else if (result.verification?.verified.includes(r.entry.sessionId)) {
			lines.push(`  ✔ ${title}：已启动并确认（${r.entry.cwd}）`);
		} else {
			lines.push(`  ⚠ ${title}：已创建标签页，超时未确认 pi 启动（${r.entry.cwd}）`);
		}
	}
	const skippedText = skipped ? `；跳过：${skipped}` : "";
	if (!result.results.length) {
		lines.push(`没有待恢复的会话${skippedText}`);
	} else {
		lines.push(`已处理 ${result.results.length} 个${skippedText}`);
	}
	return lines;
}
