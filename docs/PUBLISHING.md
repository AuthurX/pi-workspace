# 发布到 npm 与 Pi 目录

## 结论

Pi 没有要求把源码上传到单独的 Pi 注册中心。分发有两条路径：

1. **Git 分发**：推送仓库后，别人用 `pi install git:github.com/AuthurX/pi-workspace` 安装；不需要先发布 npm。正式分享建议固定已推送的 tag 或 commit。
2. **npm 分发 / Pi 目录发现**：发布公开 npm 包，包含 `keywords: ["pi-package"]` 和 `pi.extensions`。官方说明关键词让包具备被 [Pi package gallery](https://pi.dev/packages) 发现的资格；没有承诺即时收录或固定同步时限。

当前 package 已包含扩展 manifest、CLI bin、host peerDependencies、公开发布配置与发布前测试。源码 TypeScript 由 Pi 加载，无需单独构建。

## 发布前必须确认

- **包名**：已确定为 `@ellieyujin/pi-reopen`，使用 npm 账户 `ellieyujin` 发布。无 scope 的 `pi-workspace` 属于其他作者，不是本项目。CLI 命令为 `pi-reopen`，与他人的 `pi-workspace` CLI 不冲突。
- **许可证**：已选择 [MIT](../LICENSE)，版权人为 `ellieyujin`；`package.json.license` 已声明为 `MIT`，发布包须包含完整 LICENSE。
- **版本**：`0.2.0` 正式版（2026-11-13 验收后发布），`publishConfig.tag` 为 `latest`；开发预览版用 `--preid=dev` 发布到 `next`。已发布的同名同版本不能重复发布。
- **功能验收**：仍需真实 WezTerm 多窗口关闭/重开验收；启动声明不是跨进程原子锁，不能宣称并发恢复绝无重复。先作为预览分享，不把打包成功当成完整功能验收。
- **工作树**：核对所有未提交修改（含原有修改），不要把未审查内容一起提交。本文不自动提交、推送或发布。

## 本地检查

在 WSL 仓库根目录运行：

```bash
npm test
python test/pty-shutdown.py
npm pack --dry-run
```

PTY 测试需要已安装 Pi；它只用临时配置测试信号退出与主动退出，不调用模型、不打开 WezTerm 标签页。检查 tarball 列表应包含 `extensions/`、`src/`、`bin/`、README、LICENSE、发布文档，不包含认证、个人会话、`.env`、测试临时文件或 `node_modules`。

打包实物也应在临时目录解压后测试 CLI 和 Pi 扩展，且不设置 `PI_WORKSPACE_SRC`，避免本机源码兜底掩盖漏打包。

## 首次 npm 发布

以下命令在仓库根目录由维护者确认后手动运行。已登录时无需重复登录；`whoami` 应输出 `ellieyujin`：

```bash
npm login --registry=https://registry.npmjs.org/ --auth-type=web --browser=false
# 保持终端运行，手动打开本次生成的链接，完成授权并等待登录成功。
npm whoami --registry=https://registry.npmjs.org/
npm pkg get name license version publishConfig
npm view @ellieyujin/pi-reopen --registry=https://registry.npmjs.org/
```

`npm view` 返回现有包时需核对所有者权限；404 只说明查询时没找到，最终是否允许该名称仍由 registry 判断。不要把 token、密码或 2FA 验证码写入仓库或聊天。

直接发布需要 npm 账户开启 2FA，或使用有发布权限且允许 bypass 2FA 的 granular access token。手动首次发布推荐浏览器登录与 2FA；后续 CI 可研究 npm trusted publishing，不要复制旧的长期 token 教程。

```bash
npm test
npm pack --dry-run
npm publish --dry-run --access public --tag next
# 确认名称、许可、版本、文件清单和测试结果后，才执行真正发布：
npm publish --access public --tag next
```

`prepublishOnly` 会再次运行测试。`--dry-run` 不上传包，也不能证明账户具备真实发布权限。

## 发布后的安装验证

```bash
npm view @ellieyujin/pi-reopen@next name version repository dist-tags --registry=https://registry.npmjs.org/
pi install npm:@ellieyujin/pi-reopen@next
npm install -g @ellieyujin/pi-reopen@next --omit=peer
pi-reopen doctor
```

- `pi install` 管理扩展资源；外部 CLI 用 npm 全局安装，并确认全局 bin 在 PATH。
- 使用 `--omit=peer` 避免 CLI 安装额外的 Pi 宿主副本；扩展运行时由 Pi 提供声明的 peer 包。
- 在新 Pi 会话中检查 `/all` 命令和登记；已有会话需要 `/reload` 或重启。
- 仅保留一个扩展加载入口，不要把旧手工符号链接、Git 安装和 npm 安装同时启用。
- Pi 目录未立即出现时先确认公开包、关键词、manifest 和实际安装是否正常。目录索引与 npm 安装是两件事。

## 后续更新

```bash
# 维护者：使用新的版本号；此命令不会自动创建 Git commit/tag。
npm version prerelease --preid=dev --no-git-tag-version
npm publish --access public --tag next

# 使用者：Pi 扩展和 CLI 分别更新。
pi update npm:@ellieyujin/pi-reopen@next
npm install -g @ellieyujin/pi-reopen@next --omit=peer
```

完成验收并决定发布稳定版后，设置非 prerelease 版本，并把 `publishConfig.tag` 改为 `latest`，发布时也显式指定 `--tag latest`。不要直接沿用开发版的 `next` 配置。固定版本/tag/commit 的 Pi 安装不会自动跟随其他版本，需要改用新的来源版本。

卸载扩展使用 `pi remove <原安装来源>`，卸载 CLI 使用 `npm uninstall -g @ellieyujin/pi-reopen`；不要顺带删除 Pi 认证、会话或整个 agent 目录。

## 官方依据

- [Pi Packages：来源、manifest、关键词与 host peers](https://pi.dev/docs/latest/packages)
- [Pi Command Line：安装和更新命令](https://pi.dev/docs/latest/cli)
- [npm：发布 scoped public packages 与 2FA](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages)
- [npm：trusted publishers](https://docs.npmjs.com/trusted-publishers)
- [名称冲突核验：pi-workspace registry metadata](https://registry.npmjs.org/pi-workspace/latest)
