import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { discoverWezterm } from "./discover.js";
import { launchSetup, shellQuote } from "./launch.js";

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
	add("WSL 发行版", !!distro, distro || "未设置", distro ? undefined : "恢复仅支持 WSL + Windows WezTerm；缺少 WSL_DISTRO_NAME，无法定向启动标签页");

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

	const explicitPi = env.PI_WORKSPACE_PI_BIN;
	const candidate = explicitPi ? shellQuote(explicitPi) : '"$pi_bin"';
	const probeScript = [
		launchSetup(env, explicitPi),
		...(explicitPi ? [] : ['pi_bin=$(type -P pi) || exit 1']),
		`[[ ${candidate} = /* && -f ${candidate} && -x ${candidate} ]] || exit 1`,
		`printf '%s\\n' ${candidate}`,
	].join("; ");
	const piProbe = piProber
		? piProber()
		: spawnSync("bash", ["-lc", probeScript], { env, timeout: 5000, encoding: "utf8" });
	const piPath = String(piProbe.stdout ?? "").trim().split(/\r?\n/).at(-1);
	const piOk = piProbe.status === 0 && !!piPath;
	add(
		"pi 命令",
		piOk,
		piOk ? piPath : explicitPi || "未找到",
		piOk ? undefined : "请先安装 pi 并加入 PATH，或设置 PI_WORKSPACE_PI_BIN 为 WSL 内可执行文件的绝对路径（不含参数、别名或 Shell 函数）",
	);

	return { ok: checks.every((c) => c.ok), wezterm: found, checks, distro, piBin: piOk ? piPath : undefined };
}
