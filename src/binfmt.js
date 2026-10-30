import { existsSync, readdirSync, readFileSync } from "node:fs";

const BINFMT_ENTRY = "/proc/sys/fs/binfmt_misc/WSLInterop";
const CONF_DIRS = ["/etc/binfmt.d", "/usr/lib/binfmt.d", "/run/binfmt.d", "/lib/binfmt.d"];
export const BINFMT_CONF_CONTENT = ":WSLInterop:M::MZ::/init:PF";

export const PERSIST_HINT =
	"WSLInterop 注册可能在 WSL 重启后再次丢失（未发现 binfmt.d 持久化配置）。\n" +
	"一次性持久化（需 sudo 密码，工具不会自动执行）：\n" +
	`printf '%s\\n' '${BINFMT_CONF_CONTENT}' | sudo tee /usr/lib/binfmt.d/WSLInterop.conf >/dev/null\n` +
	"echo -1 | sudo tee /proc/sys/fs/binfmt_misc/WSLInterop >/dev/null\n" +
	"sudo systemctl restart systemd-binfmt";

/**
 * WSLInterop 注册状态与持久化状态：
 * - registered：当前内核是否已注册（恢复可用性的前提）
 * - persistent：是否存在 binfmt.d 配置，使 systemd-binfmt 在启动时自动补注册
 */
export function binfmtStatus(deps = {}) {
	const exists = deps.exists ?? existsSync;
	const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
	const readdir = deps.readdir ?? readdirSync;
	const registered = exists(BINFMT_ENTRY);
	let persistent = false;
	for (const dir of CONF_DIRS) {
		if (!exists(dir)) continue;
		let files;
		try {
			files = readdir(dir);
		} catch {
			continue;
		}
		for (const file of files) {
			const path = `${dir}/${file}`;
			if (file.toLowerCase().includes("wslinterop")) {
				persistent = true;
				break;
			}
			try {
				if (readFile(path).includes(":WSLInterop:")) {
					persistent = true;
					break;
				}
			} catch {
				/* 不可读文件（目录等）忽略 */
			}
		}
		if (persistent) break;
	}
	return { registered, persistent };
}
