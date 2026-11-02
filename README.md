# @ellieyujin/pi-reopen

npm 包名：`@ellieyujin/pi-reopen`；CLI 命令：`pi-workspace`。采用 [MIT 许可证](LICENSE)，Copyright (c) 2026 ellieyujin。

一个 Pi package：**在 Pi 外一条命令，恢复关闭 WezTerm 时仍打开的 Pi 组合**（进入原目录、加载原对话、等待你输入）。

- [需求基线（14 条已确认规则）](docs/REQUIREMENTS.md)
- [实现状态与审查记录](docs/STATUS.md)
- [发布到 npm 与 Pi 目录](docs/PUBLISHING.md)

**目标环境：WSL + Windows 版 WezTerm，Node ≥ 22.19，已安装 Pi。当前为开发预览版，尚未完成真实多窗口恢复验收。**

## 目录

```text
extensions/open-all.ts   Pi 扩展（薄适配层）：登记存活 Pi、提供 /all
src/                     共享核心（纯 JS ESM，扩展与 CLI 共用）
  paths/liveness/members/claims/plan/preflight/discover/launch/spawn/verify/restore/cli
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

## 安装

### 从源码安装（npm 发布前可用）

以下命令在 WSL 内运行，安装的是当前检出的源码：

```bash
git clone https://github.com/bridge-01/pi-workspace.git
cd pi-workspace
pi install .
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/bin/pi-workspace.js" "$HOME/.local/bin/pi-workspace"
export PATH="$HOME/.local/bin:$PATH"
pi-workspace doctor
```

将 PATH 配置保存到 Shell 启动文件以便后续使用。若 CLI 链接已存在，先检查其目标，不要盲目覆盖。

只需要扩展时，也可直接安装已推送的 Git 版本：

```bash
pi install git:github.com/bridge-01/pi-workspace
```

### 从 npm 安装（维护者发布后）

**npm 上无 scope 的 `pi-workspace` 已属于其他作者，不是本项目，请勿安装错包。** 本项目包名为 `@ellieyujin/pi-reopen`，预览版使用 `next` 标签：

```bash
pi install npm:@ellieyujin/pi-reopen@next
npm install -g @ellieyujin/pi-reopen@next --omit=peer
pi-workspace doctor
```

`pi install` 注册并加载扩展，但不保证 CLI 出现在普通 Shell 的 PATH 中；`npm install -g` 安装外部 CLI，npm 全局 bin 目录也需在 PATH 中。CLI 不依赖 Pi 的 peer 包，故使用 `--omit=peer` 避免额外安装宿主。两份安装需要分别更新，并保持版本一致。

**登记必须启用扩展**：仅装 CLI 无法记录会话。安装后在每个已打开的 Pi 中运行 `/reload` 或重启；新安装无法精准找回此前未登记的窗口。不要同时加载旧的 `open-all.ts` 副本/符号链接与 package；迁移前先检查 `pi list` 和个人扩展目录，仅停用旧入口，不删除会话或认证文件。

## 可选配置

| 环境变量 | 用途 |
| --- | --- |
| `PI_WORKSPACE_WEZTERM` | Windows WezTerm 在 WSL 中的绝对路径，例如 `/mnt/c/Program Files/WezTerm/wezterm.exe` |
| `PI_WORKSPACE_PI_BIN` | WSL 内 Pi 可执行文件的绝对路径，不含参数；不支持别名或 Shell 函数 |
| `PI_CODING_AGENT_DIR` | 使用其他 Pi 配置/登记目录；CLI 与扩展需保持一致 |
| `PI_WORKSPACE_SRC` | 仅供开发：覆盖共享 `src/` 目录，正常 package 安装无需设置 |

例如 Pi 通过 nvm、pnpm 或自定义 npm prefix 安装时，可显式指定：

```bash
export PI_WORKSPACE_PI_BIN="$(type -P pi)"
export PI_WORKSPACE_WEZTERM="/mnt/c/Program Files/WezTerm/wezterm.exe"
pi-workspace doctor
```

默认从调用方 PATH 和 Bash 登录环境查找 Pi，不再猜测 npm 安装目录。恢复标签页使用预检得到的 Pi 路径，并显式传递调用方 PATH 与 agent 目录；不会把整个环境或认证信息拼入命令行。WezTerm 自动发现依次检查 PATH、常见安装位置和 `where.exe`（经 `wslpath` 转换）。自定义盘符挂载点等未覆盖布局请设置显式路径。修改环境变量后需重启 Pi 进程，`/reload` 不会读取父 Shell 的新环境。

恢复目前使用目标 WSL 发行版的默认用户；请以该用户运行本工具。多用户、自定义 Shell 启动逻辑需另行验证。

## 工作原理

- **登记**：每个 Pi 启动时把 `{会话文件绝对路径, cwd, pid, processStart, bootId}` 实时写入 `~/.pi/agent/pi-workspace/members/`（每会话独立文件、原子替换）。
- **关闭判定**：Pi 的信号退出也会发出 `quit` 清理事件，不能仅按事件名判断。扩展在 TUI 生命周期内记录 SIGHUP/SIGTERM：信号退出保留记录；无信号的主动 `/quit` 或切换会话删除记录；reload 保留记录并清理监听器。强杀无法执行清理时记录残留。断电时最多恢复已持久化的记录，不保证未落盘的最新变化。
- **去重**：恢复前检查进程存活（pid + 启动时刻 + bootId，重启后失效 PID 不误判），并用启动声明（60s TTL + 持有者存活检测）减少重复请求。当前声明不是跨进程原子锁，不能保证并发或快速连续恢复绝不重复，请勿同时发起多次恢复。
- **安全**：预检（发行版 / 互操作套接字 / WezTerm 存在且可执行 / pi 可用）未通过绝不批量启动；绝不自动 sudo；ENOEXEC 给出修复指引；"已创建标签页"与"已确认 pi 启动"分开报告。

## 环境支持

- **WSL（Windows）**：restore 的唯一目标环境，依赖 Bash、Linux `/proc`、Windows WezTerm 与 `wsl.exe` 互操作。恢复前需启动 WezTerm，使其 CLI 能连接到运行实例；不保证自动创建新 GUI 或还原窗口布局。
- **Linux（非 WSL）/ macOS / Windows 原生**：不支持恢复，通常会被预检拒绝；其他功能未在这些平台验收。非 Linux 平台无 `/proc`，`list` 的存活状态也不可靠。
- Node ≥ 22.19；扩展 TS 由 pi 加载，测试用 Node 原生类型剥离。

## 测试

```bash
# 仓库根目录
npm test
npm pack --dry-run
```

测试覆盖核心恢复、信号处理顺序、reload 清理、`/all recent` 补选、非标准 Pi 安装路径、Shell 转义及 package 移动后的加载。测试通过临时目录和模拟启动器隔离；测试钩子 `PI_WORKSPACE_HOOKS` 不应在正常使用时设置。

可选真实 Pi PTY 测试：`python test/pty-shutdown.py`。使用临时配置和会话，验证 SIGHUP/SIGTERM 退出保留成员、主动 `/quit` 删除成员；不调用模型、不打开可见标签页。这不是 WezTerm 全流程验收。

## 尚待真实环境验收

模拟测试不等于端到端验收。待你配合完成：**开多个 Pi + 普通终端 → 关闭 WezTerm → `pi-workspace restore` 验证恢复集合正确**（含提前 `/exit` 一个的场景）。通过前请视为可用但未验收。
