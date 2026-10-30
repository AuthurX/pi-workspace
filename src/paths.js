import { homedir } from "node:os";
import { join } from "node:path";

/** Pi agent 目录，尊重 PI_CODING_AGENT_DIR（与 pi 本体一致）。 */
export function agentDir(env = process.env) {
	return env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent");
}

/** pi-workspace 全部持久化路径。 */
export function workspacePaths(env = process.env) {
	const agent = agentDir(env);
	return {
		agent,
		workspace: join(agent, "pi-workspace"),
		members: join(agent, "pi-workspace", "members"),
		claims: join(agent, "pi-workspace", "starting"),
		sessions: join(agent, "sessions"),
		legacyRegistry: join(agent, "pi-terminals.json"),
		legacyRecords: join(agent, "pi-terminal-records"),
	};
}
