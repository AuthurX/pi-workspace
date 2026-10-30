# pi-workspace

一个 Pi package：**在 Pi 外一条命令，恢复关闭 WezTerm 时仍打开的 Pi 组合**（进入原目录、加载原对话、等待你输入）。

- [需求基线（14 条已确认规则）](docs/REQUIREMENTS.md)
- [实现状态与审查记录](docs/STATUS.md)

## 目录

```text
extensions/open-all.ts   Pi 扩展（薄适配层）：登记存活 Pi、提供 /all
src/                     共享核心（纯 JS ESM，扩展与 CLI 共用）
  paths/liveness/members/claims/plan/preflight/discover/spawn/verify/restore/cli
bin/pi-workspace.js      CLI 入口（node 直接运行，免编译）
test/                    Node 内置测试（隔离目录 + 注入式模拟，无真实终端调用）
docs/                    需求与状态
```

## 使用

```bash
pi-workspace restore            # 补开上次关闭时仍打开的 Pi（已运行的跳过）
pi-workspace restore --dry-run  # 只看计划，不开标签页
pi-workspace list               # 查看登记成员与状态
pi-workspace doctor             # 环境检查（WezTerm / WSL 互操作 / pi）
pi-workspace clear              # 清空登记（不删对话文件）
```

Pi 内等价入口：`/all`（恢复）、`/all clear`、`Ctrl+Shift+O`。

## 安装（本机已完成）

```bash
# 扩展：~/.pi/agent/extensions/open-all.ts → 项目源码符号链接（pi 通过 /reload 加载）
pi install /home/ellie/work/MY/code/pi-workspcace   # 其他环境可选
# CLI：
ln -s <项目>/bin/pi-workspace.js ~/.local/bin/pi-workspace
```

注意：`pi install` 只加载扩展，不会把 CLI 放进 PATH；两者可独立使用。

## 工作原理

- **登记**：每个 Pi 启动时把 `{会话文件绝对路径, cwd, pid, processStart, bootId}` 实时写入 `~/.pi/agent/pi-workspace/members/`（每会话独立文件、原子替换）。
- **关闭判定**：Pi 的信号退出也会发出 `quit` 清理事件，不能仅按事件名判断。扩展在 TUI 生命周期内记录 SIGHUP/SIGTERM：信号退出保留记录；无信号的主动 `/quit` 或切换会话删除记录；reload 保留记录并清理监听器。强杀无法执行清理时记录残留。断电时最多恢复已持久化的记录，不保证未落盘的最新变化。
- **去重**：恢复前检查进程存活（pid + 启动时刻 + bootId，重启后失效 PID 不误判），并用启动声明（60s TTL + 持有者存活检测）防止并发恢复重复开标签页。
- **安全**：预检（发行版 / 互操作套接字 / WezTerm 存在且可执行 / pi 可用）未通过绝不批量启动；绝不自动 sudo；ENOEXEC 给出修复指引；"已创建标签页"与"已确认 pi 启动"分开报告。

## 测试

```bash
cd ~/work/MY/code/pi-workspcace && npm test
```

当前 21 项通过，包括信号处理顺序和 reload 监听器清理。测试通过 `PI_CODING_AGENT_DIR` / `PI_WORKSPACE_HOOKS` 隔离。

可选真实 Pi PTY 测试：`python test/pty-shutdown.py`。使用临时配置和会话，验证 SIGHUP/SIGTERM 退出保留成员、主动 `/quit` 删除成员；不调用模型、不打开可见标签页。这不是 WezTerm 全流程验收。

## 尚待真实环境验收

模拟测试不等于端到端验收。待你配合完成：**开多个 Pi + 普通终端 → 关闭 WezTerm → `pi-workspace restore` 验证恢复集合正确**（含提前 `/exit` 一个的场景）。通过前请视为可用但未验收。
