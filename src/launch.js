import { dirname } from "node:path";
import { agentDir } from "./paths.js";

export function shellQuote(value) {
	return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** 仅传递启动所需配置，不把认证等整个环境写进命令行。 */
export function launchSetup(env = process.env, piBin) {
	const path = [piBin?.startsWith("/") ? dirname(piBin) : undefined, env.PATH].filter(Boolean).join(":");
	return [
		...(path ? [`export PATH=${shellQuote(path)}:"$PATH"`] : []),
		`export PI_CODING_AGENT_DIR=${shellQuote(agentDir(env))}`,
	].join("; ");
}
