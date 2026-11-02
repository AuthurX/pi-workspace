# 本机实现审查

**当前结论：开发中，不能宣称第一版已完成。** 已修复关终端时误删成员的退出判定错误；当前 `npm test` 51/51 通过，隔离真实 Pi PTY 的 SIGHUP、SIGTERM、主动 /quit 三项通过。完整 WezTerm 多窗口恢复、并发启动互斥等仍需验收。下方旧轮次记录不代表当前完成状态。

## Package 可移植性与发布准备（2026-10-30）

- 删除扩展源码定位的个人路径兜底，保留 package 相对定位与开发覆盖变量。
- 增加 `PI_WORKSPACE_PI_BIN`，统一预检与恢复标签页的 Pi 路径、PATH 和 agent 目录；`runRestore({ env })` 的默认记录路径同步使用传入环境。
- WezTerm 发现不再依赖个人 D 盘位置；支持 PATH，并将 `where.exe` 返回值经 `wslpath` 转换。
- 补充仓库元信息、`next` 预览发布配置、发布前测试、通用安装和迁移说明。后续经维护者确认，包名为 `@ellieyujin/pi-reopen`，采用 MIT 许可证，版权人为 `ellieyujin`。
- npm registry 核验：无 scope 的 `pi-workspace` 已属于其他作者；manifest 及发布文档现已同步为 `@ellieyujin/pi-reopen`，完整许可证见根目录 `LICENSE`。这不代表已完成 npm 发布。
- 验证：51/51 自动化测试通过；真实 Pi PTY 3/3 通过；npm tarball 解压到临时位置后 CLI 和真实 Pi PTY 3/3 通过，未设置 `PI_WORKSPACE_SRC`。
- 没有执行 npm publish、Git 提交或推送，没有完成真实 WezTerm 多窗口恢复验收。并发锁等既有问题不在本轮修复范围。

## 深度测试轮（2026-10-30）

新增 24 项自动化测试（`test/deep.test.mjs` 18 项 + `test/recent.test.mjs` 6 项），共 45/45 通过；`python test/pty-shutdown.py` 3/3 通过。

**新覆盖**：processStart 解析鲁棒性（comm 含括号/空格、僵尸、缺失）；claim 同 PID 重取/死持有者接管；sweepClaims 保留/删除/损坏声明；plan 的 claimed 状态；resolveSessionFile 优先级与回退；preflight 全项通过（仅 WSL 上可测）与 pi 缺失提示；openTab 无 distro 分支；默认 spawner 成功/失败/ENOENT；shellQuote 回环；listMembers 损坏/缺 ts；成员文件 0600；runRestore 全部被占用时不启动且如实报告；summarize 空结果；CLI 用法/退出码/隔离目录 list+clear。**/all recent 补选路径首次纳入自动化测试**（stub 化 preflight/spawn 后验证候选发现、输入校验、确认、成功登记、失败回收、own/live 排除）。

**本轮修复两处问题**：

1. `src/cli.js`：`list`/`clear` 忽略传入的 `env`（与 `restore`/`doctor` 不一致），改用 `workspacePaths(env)`。bin 入口传 `process.env`，行为不变；仅影响测试与库调用方。
2. `extensions/open-all.ts` `openRecent`：原先 `readFileSync` 整个会话文件只为取首行（会话文件可达数 MB），改为只读首 64KB 切首行。

**已知限制（记录，未改）**：

- claims 存在 TOCTOU 竞态：两个恢复进程同一瞬间读写声明可能都判空，极端情况多开一个标签页；TTL 只防顺序重复。影响有限，概率极低。
- 全部待恢复项被其他恢复进程占用时，本次 `restore` 返回 exit 1（冲突视为未完成），语义待确认。
- 损坏的 claim 文件 `sweepClaims` 不清理，仅在该会话再次被声明或 `clear` 时移除。
- 非 Linux 平台（macOS/Windows 原生）无 /proc，存活判定退化为“全部判死”；restore 被预检拒绝，无实际危害，但 `list` 状态会误导。环境支持结论：restore 仅 WSL；其他平台仅登记/list/doctor 可用（预检安全拒绝）。
- 扩展个人路径兜底已在 package 可移植性轮删除。

## 最新修复：信号退出被误判为主动退出

源码证据：本机 Pi 的 `interactive-mode.js` 在 SIGHUP/SIGTERM 时调用 `runtimeHost.dispose()`，后者在 `agent-session-runtime.js` 中同样发出 `session_shutdown(reason: "quit")`。原扩展把 quit 一律当作用户退出，导致关闭前 list 有成员、关闭后成员被删除。

修复：TUI 生命周期内监听 SIGHUP/SIGTERM，只记录退出来源，不接管宿主退出流程；quit 清理延迟到本轮信号分发结束再判断。信号退出保留成员，无信号的主动 quit 删除成员；reload/切换时清理监听器。

验证：`npm test` 为 21/21；`python test/pty-shutdown.py` 在隔离配置下启动真实 Pi，SIGHUP 与 SIGTERM 退出后记录仍在且 CLI list 显示待恢复，主动 `/quit` 后记录删除。未调用模型、未打开可见标签页、未操作用户正在运行的 Pi。

此前“没有登记就是没重载”“新会话没有文件路径”的解释未充分验证，不能作为该问题的根因结论。已被旧逻辑删除的成员无法从当前清单精准重建，需要用户从历史对话选择。

## 需求确认更新

用户已确认：只恢复 Pi；恢复后等待用户输入，不自动继续执行；提前单独关闭的 Pi 不恢复。完整规则和验收场景见 `REQUIREMENTS.md` 的“已确认的恢复规则”。

后续用户对 6 条边界默认方案与 5 条交互/数据默认方案逐条确认（“没问题”），未提出修改。至此 **14 条规则的需求基线闭环**（核心 3 + 边界 6 + 交互/数据 5），需求环节完成，已全部写入 `REQUIREMENTS.md`。

当前原型不满足该规则：普通退出一律保留记录，不能区分主动退出与被动死亡。需求确认后仍未实现行为变化，未重新执行测试；下面的未完成结论不变。

## 迁移前实际文件

- 只有 `~/.pi/agent/extensions/open-all.ts`。
- 无独立 CLI、无 `bin` 安装入口、无已有项目/package 清单。
- 之前位于 `/tmp` 的临时回归测试已不存在，不能把此前口头测试结论当成当前可复现验收。
- 有旧共享注册表和逐会话记录目录；保留原处，不复制个人会话数据到项目。

## 已有原型能力（不等于已验收）

| 项目 | 状态 |
| --- | --- |
| Pi 内 `/all`、`/all recent`、`/all clear` | 有实现 |
| 会话文件绝对路径与存在性检查 | 有实现 |
| 启动命令补 PATH、Shell 单引号转义 | 有实现 |
| 同一 WSL 启动期间的 PID + 启动时间识别 | 有实现 |
| 分会话文件原子替换 | 有实现 |
| 退出时保留登记 | 有实现 |
| 近期历史补选并确认 | 有实现 |

## 实现记录（2026-10-30 第二轮）

按已确认规则重写为共享核心 + 双入口：

- `src/*.js`（纯 JS ESM）：paths / liveness（pid+启动时刻+bootId）/ members（每会话独立原子写）/ claims（启动占用，60s TTL+持有者存活）/ plan（六种状态+realpath 去重）/ preflight（含 ENOEXEC 诊断，不自动修复）/ spawn（转义+PATH 注入）/ verify（登记回执轮询）/ restore（编排+中文报告）/ cli（restore/list/doctor/clear）。
- `extensions/open-all.ts` 薄适配：realpath 解析项目源码（jiti 下符号链接路径≠真实路径，已实测）、退出语义（quit/new/resume/fork 删记录，reload 保留）、`/all` 与 `/all recent`。
- 关键设计：**主动退出/切换 → 删除记录；被动死亡 → 记录残留**，文件系统状态天然编码已确认的关闭判定规则；崩溃/断电无需额外保存。
- 测试 16/16 通过（核心 11 + 扩展接线 5），覆盖生命周期、重启失效、占用互斥/接管、缺失/重复/别名、冷 shell 转义（含引号/$/空格真实执行）、预检失败关断、诚实报告、迁移不清旧数据。
- 真机验证：`pi -p` 加载扩展无错误；`pi-workspace doctor` 全项通过（interop 已恢复）；`list`/`restore --dry-run` 正常；CLI 已链接到 `~/.local/bin/pi-workspace`。
- 旧格式记录（pi-terminals.json / pi-terminal-records/）按需求忽略不删。

### 仍待验收

- 真实六窗口关闭/重开端到端（需用户配合，含提前 `/exit` 场景）。
- ENOEXEC 真实场景未复现（已修复注册），诊断分支仅注入测试；若再现按 doctor 提示处理。
- `/all recent` 补选路径已纳入自动化测试（2026-10-30 深度测试轮，stub 化 preflight/spawn）；真实 WezTerm 开标签页的补选流程仍未端到端验收。

### 追加：新会话永不登记的缺陷（2026-10-30 晚）

用户实测发现：重启后的全新 Pi 窗口发过消息、关闭 WezTerm 后仍无法恢复。根因：全新会话在 session_start 时文件尚未落盘，登记被跳过后不再有触发点，导致新窗口永远不会进入恢复集合。修复：监听 message_end，首条用户消息落盘后补登记，后续用户消息刷新时间戳；“从未发消息的窗口不登记”规则保持不变。测试 18/18 通过（新增延迟登记用例）。此前已关闭的窗口因当时未登记，无法自动补录；可用 `/all recent` 手动补选（打开即登记）。

### 追加：interop 反复丢失与迁移期空登记（2026-10-30）

用户实测发现两个问题：

1. **WSLInterop 当天两次丢失**。根因：本机 systemd 启用但无任何 binfmt.d 配置，systemd-binfmt 跳过注册，WSL 自带注册被清后无人补。处理：`doctor` 新增持久化检查（`src/binfmt.js`，17/17 测试通过），给出一次性持久化命令（`/usr/lib/binfmt.d/WSLInterop.conf` + 重启 systemd-binfmt），不自动 sudo。用户执行前每次 WSL 重启后需手动重新注册才能恢复。
2. **旧进程未向新格式登记**。用户当时开着的 Pi 是在旧扩展代码下启动的，新登记目录为空，故 `/all` 与 CLI 均报“没有待恢复的会话”。这是一次性迁移成本：每个 Pi 窗口重启一次（或 `/reload`）后，登记开始；此前关闭的窗口无法补登记（对话文件仍在，可用后续 P1 的补选能力）。

## 原型阶段的阻塞问题（历史记录，不代表均已解决）

1. **无外部入口**：不能在普通 Shell 执行 `pi-workspace restore`。
2. **集合语义不符**：普通退出一律保留记录，主动 `/exit` 关闭的 Pi 仍会进入恢复集合，违反已确认的关闭判定规则（主动退出→排除，被动死亡→保留）；当前记录可能累计为历史集合。
3. **启动中无保护**：无原子启动占用/锁，连续或并发 `/all` 可在登记完成前重复创建。
4. **错误处理不足**：`spawn()` 同步异常可直接冒出；异步错误被忽略；无子进程退出检查和启动回执。ENOEXEC 仍是已知阻塞。
5. **环境硬编码**：WezTerm 固定 `/mnt/d/Apps/WezTerm/wezterm.exe`；Pi 搜索路径为个人配置；缺少系统/工具预检与发现配置。
6. **身份不完整**：只使用 PID + 启动 tick，没有 boot ID，跨重启不能做强保证；没有会话路径规范化去重。
7. **旧表迁移不完整**：旧共享表一直叠加读取，切换会话时仅删除新记录可能令旧项重新出现。
8. **测试缺口**：无真实关闭/重开端到端验收，无并发启动与失败注入验收。
9. **用户隔离**：恢复指定发行版但未明确用户；自定义 agent 目录未支持。

## 本次整理范围

- 原型源文件原样迁移，SHA-256：`df0f87f1f75446121cb078a1ed977a2068fa124beed3adba9ed74e0c03bd0d32`。
- 新增 Pi package 清单，版本 `0.1.0-prototype.0`，`private: true` 防误发布。
- 原安装位置改为项目源码符号链接；不再维护两份代码，也不额外注册一次 package。
- 新增 Node 内置测试：在隔离目录与模拟启动器内检查原型现有逻辑。
- 新增关键未完成项的 TODO 测试；TODO 不算通过验收。
- 不修改会话内容、认证文件、Pi settings、系统 WSL 配置。
- 不增加 CLI 假入口，不声称解决 ENOEXEC，不自动打开标签页。

## 验证边界

`npm test` 的测试使用 Node TypeScript 类型剥离和受控 VM，注入 Pi API / 子进程模拟器。能够验证源码逻辑，但**不是 Pi 的真实 jiti 加载、Windows 终端创建或任务恢复测试**。

本次 `npm test` 实测：16 项测试，8 项通过、0 项失败、8 项 TODO。TODO 不代表通过。真实环境功能仍未验收。当前未完成项清单见测试 TODO 与 `REQUIREMENTS.md`。

## 建议后续顺序

1. 需求已闭环。按已确认的关闭判定规则（主动退出→排除，被动死亡→保留）设计实现方案并验证其可靠性；补齐多窗口合并、崩溃、重启等生命周期测试。
2. 将记录、恢复计划、终端适配从扩展抽成共享模块。
3. 实现外部 CLI 和只读诊断；先修复并测试 ENOEXEC 的可读错误处理。
4. 增加跨进程锁、启动占用和成功回执。
5. 完成 package/CLI 安装与迁移流程。
6. 用户同意后做实际六窗口关闭/重开验收；通过前保持原型标记。
