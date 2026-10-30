// 测试钩子：拦截 WezTerm 调用，记录请求并恒返回成功；测试通过 PI_WORKSPACE_HOOKS 指向本文件。
export const calls = [];
export default async () => ({
	noWait: true,
	prober: () => ({ status: 0, stdout: 'wezterm-test' }),
	piProber: () => ({ status: 0, stdout: '/test/pi' }),
	spawner: async (program, args) => {
		calls.push({ program, args });
		return { ok: true, stdout: 'pane-1' };
	},
});
