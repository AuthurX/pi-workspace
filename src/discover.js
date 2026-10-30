import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** WezTerm 可执行文件发现：环境变量 → 常见挂载路径 → where.exe。 */
export function discoverWezterm(env = process.env) {
	if (env.PI_WORKSPACE_WEZTERM && isFile(env.PI_WORKSPACE_WEZTERM)) {
		return env.PI_WORKSPACE_WEZTERM;
	}
	const candidates = [
		"/mnt/c/Program Files/WezTerm/wezterm.exe",
		"/mnt/d/Apps/WezTerm/wezterm.exe",
	];
	try {
		for (const drive of readdirSync("/mnt")) {
			const users = join("/mnt", drive, "Users");
			let names;
			try {
				names = readdirSync(users);
			} catch {
				continue;
			}
			for (const user of names) {
				candidates.push(
					join(users, user, "AppData", "Local", "Programs", "WezTerm", "wezterm.exe"),
					join(users, user, "scoop", "shims", "wezterm.exe"),
				);
			}
		}
	} catch {
		/* /mnt 不可枚举时忽略 */
	}
	for (const candidate of candidates) {
		if (isFile(candidate)) return candidate;
	}
	try {
		const out = execFileSync("/mnt/c/Windows/System32/where.exe", ["wezterm.exe"], {
			encoding: "utf8",
			timeout: 5000,
		});
		const first = out.split(/\r?\n/).find((line) => line.trim());
		if (first && isFile(first.trim())) return first.trim();
	} catch {
		/* interop 不可用时静默 */
	}
	return undefined;
}

function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
