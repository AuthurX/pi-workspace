import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** WezTerm 发现：显式路径 → PATH → 常见安装位置 → where.exe + wslpath。 */
export function discoverWezterm(env = process.env, deps = {}) {
	const fileExists = deps.isFile ?? isFile;
	const readdir = deps.readdir ?? readdirSync;
	const execFile = deps.execFile ?? execFileSync;
	if (env.PI_WORKSPACE_WEZTERM) {
		return fileExists(env.PI_WORKSPACE_WEZTERM) ? env.PI_WORKSPACE_WEZTERM : undefined;
	}
	const candidates = (env.PATH ?? "").split(":").filter((p) => p.startsWith("/"))
		.map((dir) => join(dir, "wezterm.exe"));
	candidates.push("/mnt/c/Program Files/WezTerm/wezterm.exe");
	try {
		for (const drive of readdir("/mnt")) {
			candidates.push(join("/mnt", drive, "Program Files", "WezTerm", "wezterm.exe"));
			const users = join("/mnt", drive, "Users");
			let names;
			try {
				names = readdir(users);
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
		if (fileExists(candidate)) return candidate;
	}
	try {
		const options = { env, encoding: "utf8", timeout: 5000 };
		const where = (env.PATH ?? "").split(":").filter((p) => p.startsWith("/"))
			.map((dir) => join(dir, "where.exe")).find(fileExists)
			?? "/mnt/c/Windows/System32/where.exe";
		const out = execFile(where, ["wezterm.exe"], options);
		for (const line of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
			try {
				const path = execFile("wslpath", ["-u", line], options).trim();
				if (fileExists(path)) return path;
			} catch {
				/* 某个 Windows 路径不可转换时继续下一项 */
			}
		}
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
