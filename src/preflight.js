import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { discoverWezterm } from "./discover.js";

const BINFMT_FIX_HINT =
	"WSLInterop 未注册，Windows 程序无法从 WSL 启动。" +
	"请在普通 Shell 执行（需 sudo 密码，工具不会自动执行）：\n" +
	"printf '%s\\n' ':WSLInterop:M::MZ::/init:P' | sudo tee /proc/sys/fs/binfmt_misc/register >/dev/null";

function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** 启动前环境检查；任何一项不通过都不得批量开标签页。 */
export function preflight({ env = process.env, wezterm, prober, piProber } = {}) {
	const checks = [];
	const add = (name, ok, detail, hint) => checks.push({ name, ok, detail, hint });

	const distro = env.WSL_DISTRO_NAME;
	add("WSL 发行版", !!distro, distro || "未设置", distro ? undefined : "缺少 WSL_DISTRO_NAME，无法定向启动标签页");

	add("WSL 互操作套接字", existsSync("/run/WSL"), "/run/WSL", existsSync("/run/WSL") ? undefined : "未找到 /run/WSL，WSL 互操作未启用（检查 wsl.conf 的 interop 设置）");

	const explicit = wezterm ?? env.PI_WORKSPACE_WEZTERM;
	let found;
	if (explicit) {
		if (isFile(explicit)) {
			found = explicit;
			add("WezTerm 程序", true, found);
		} else {
			add(
				"WezTerm 程序",
				false,
				`指定的文件不存在：${explicit}`,
				"检查 PI_WORKSPACE_WEZTERM 环境变量或传入的路径",
			);
		}
	} else {
		found = discoverWezterm(env);
		add(
			"WezTerm 程序",
			!!found,
			found || "未找到",
			found ? undefined : "未找到 wezterm.exe；可用环境变量 PI_WORKSPACE_WEZTERM 指定完整路径",
		);
	}

	if (found) {
		const probe = prober
			? prober(found)
			: spawnSync(found, ["--version"], { timeout: 8000, encoding: "utf8" });
		if (probe.status === 0) {
			add("Windows 程序执行", true, String(probe.stdout ?? "").trim() || "ok");
		} else {
			const enoexec = probe.error?.code === "ENOEXEC";
			add(
				"Windows 程序执行",
				false,
				enoexec ? "Exec format error (ENOEXEC)" : String(probe.stderr ?? probe.error ?? "").trim(),
				enoexec ? BINFMT_FIX_HINT : "wezterm.exe 无法执行；确认安装完整且为 Windows 版本",
			);
		}
	}

	const piProbe = piProber
		? piProber()
		: spawnSync(
				"bash",
				[
					"-lc",
					'export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH"; command -v pi',
				],
				{ timeout: 5000, encoding: "utf8" },
			);
	const piPath = String(piProbe.stdout ?? "").trim();
	const piOk = piProbe.status === 0 && !!piPath;
	add(
		"pi 命令",
		piOk,
		piPath || "未找到",
		piOk ? undefined : "恢复的标签页内将执行 pi；请先安装 pi",
	);

	return { ok: checks.every((c) => c.ok), wezterm: found, checks, distro };
}
