# DSH for VS Code

**项目地址：https://github.com/zwb8926/deepseek-harness-vscode**

在 VS Code 中使用 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)。

本扩展**自行启动并管理 `dsh web` 服务**，并把 GUI **拆成两块**嵌入 VS Code

本次更新（版本 2026.10.10）：

- **Linux 上的断连/不稳定（两处修复）**：内置的 dsh 树过去只带 Windows 原生依赖（`node-pty` / `sharp` / `ripgrep`），但选树的逻辑**不看平台**、只挑「最新的一份」，于是在 Linux 上照样用了这份 Windows 构建 —— `node-pty` 的原生模块加载失败，服务起来又断、反复重连。
  - 打包时补齐 `linux-x64` 的原生依赖（`node-pty/prebuilds/linux-x64/pty.node`、`@img/sharp-linux-x64`、`@img/sharp-libvips-linux-x64`、`@vscode/ripgrep-linux-x64`，约 +24 MB），内置树在 **win32-x64 与 linux-x64** 上都能直接启动，离线安装同样可用。新增脚本 `scripts/fetch-platform-deps.mjs`（按 `package-lock.json` 的 `resolved` + `integrity` 取包，已挂在 `vscode:prepublish` 上）。
  - 运行平台不在内置树的覆盖范围时（macOS / arm64 等），扩展会**跳过内置树**并在输出面板写明原因，改用 PATH / 全局安装的那份 dsh，而不是硬拿一份装不起来的东西去起服。
- **设置写入被拒时自动恢复（Windows 上「改设置没反应」）**：dsh 在 profile 布局下会拒掉设置写入（`settings/rejected: profile reload requires the root Include entry`，详见「已知问题」）。以前扩展只看得见**自己**发出的写入，GUI 里点的设置它完全看不到。现在扩展通过自己的 GUI 代理只读地窥探 `POST /api/settings/update`（响应原样透传给页面，不改变页面行为），发现被拒就：
  1. 用同一 `DSH_HOME` 起一个临时兄弟进程重放这次写入：成功 ⇒ 只是当前服务进程启坏了，而写入已经落盘；
  2. 于是**自动重启服务**并提示「设置写入被上游 dsh 拒绝，扩展已代为落盘，正在重启服务使其生效…」，改动当场生效。
  兄弟进程**同样被拒** ⇒ 问题在 home/CLI 侧，扩展如实提示需要手动落 `cordis.patch.yml`，不再假装成功。
- **验证**：`npm run verify` 新增离线套件 `platform`（内置树的平台判定真值表 + 各平台原生依赖确实在包里 + `.vscodeignore` 不会把它们排除掉），`settings-flow` 新增第 0 层（拒绝报文识别、`{ns, patch}` 反解、代理只窥探设置端点且字节级原样透传、一次拒绝恰好上报一次）；另有 WSL Ubuntu-22.04 实机验证：内置树在 Linux 下 `node-pty` / `sharp` / `ripgrep` 全部可加载，`dsh web` 正常起服并持续存活（不是起来就断）。

## 已知问题 / 排查

**「预览版说明 / 内测声明」弹窗点了没反应、GUI 里改设置不生效** —— 同一个根因：**GUI 的设置写入被 dsh 拒绝**，而声明只能靠写入来确认。

- 症状：打开就弹「预览版说明」（0.1.7 叫「内测声明」），点「继续」只出现「暂时无法保存确认状态，请重试」；同时设置面板里的任何改动都不落盘。
- 服务端返回：`settings/update` → `ok=false`，`settings/rejected: "dsh: profile reload requires the root Include entry"`。
- 根因：dsh 0.1.7 把根级 `settings.yaml` 迁移成 `profiles/web/` 这套 profile 布局（旧文件被改名为 `settings.yaml.imported`），服务没能注册新布局需要的 root Include entry，于是**设置写入被拒**（能读不能写）。
- **扩展已直接屏蔽该声明**：适配器识别 `预览版说明 / Preview Notice / 内测声明`（按 aria-label 或正文开头，中英双语）后把它隐藏，并顺带点击一次「继续」以便正常部署记录确认；用 MutationObserver + 轮询兜底，重新渲染也会再隐藏。只认这一个对话框 —— 设置弹窗等真实对话框不受影响（`npm run verify -- --only notice` 会同时验证"声明被隐藏"和"设置弹窗照常打开"）。
- 想在服务端也记下确认（可选）：把下面这条写进 `~/.dsh/profiles/web/cordis.patch.yml` 再重启服务。**注意版本号必须与 dsh 期望的一致**（0.2.0 期望 `2026-09-28.1`，0.1.7 是 `2026-08-13.1`；升级 dsh 后旧值会失效、声明会再次出现）。
- 处理：**先重启一次 dsh 服务**（重载 VS Code 窗口，或状态栏/命令里的「重启服务」）。多数情况下新进程会正常注册，之后设置可写、声明点一次即关。
- 若重启后仍被拒：扩展会自己给出判定并在**必要时自动收拾**（2026.10.10 起，GUI 里点的设置也算 —— 页面发出的写入会经过扩展的代理，同样会被看到）。输出面板里出现 `settings: the running server REJECTS settings writes` 与 `settings-probe: a FRESH sibling …` 时：兄弟进程**接受**同一写入 ⇒ 是那个进程启坏了，而写入已落盘，扩展会**自动重启服务**让改动生效（无需手动操作）；兄弟进程**也拒绝** ⇒ 问题在 home/CLI 侧，而不是某个进程的状态，扩展会提示，此时按下面的方式手动落设置。
- 手动落设置（**推荐的兜底**）：把要改的项写成 `~/.dsh/profiles/web/cordis.patch.yml` 里的一条补丁，然后重启服务即生效。文件本身是一行 `[]`（空数组）时，用这个整份内容替换：
  ```yaml
  # 一条补丁 = id 指向某个插件，config 覆盖它的设置命名空间
  - id: ui-theme
    name: "@deepseek-ai/dsh-client-ui-theme"
    config:
      preference: dark          # light | dark | system —— 就是设置面板里的主题
  - id: ui-settings-general
    name: "@deepseek-ai/dsh-client-ui-settings-general"
    config:
      welcomeNoticeVersion: 2026-09-28.1   # dsh 0.2.0 期望的值；让「预览版说明」不再出现
  ```
  - `id` / `name` 用插件 id 与其包名。已核实的两个：`ui-theme` → `@deepseek-ai/dsh-client-ui-theme`、`ui-settings-general` → `@deepseek-ai/dsh-client-ui-settings-general`；`config` 下的键就是设置面板里的字段名。
  - **全部 id ↔ 包名对照**可从随包发布的 `node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml` 里查到（每条 `- id: … / name: …`）；现成的命名空间与字段可从 `~/.dsh/settings.yaml.imported` 看到（0.1.7 迁移前的旧设置文件，结构就是 `命名空间: { 字段: 值 }`）。
  - 改完记得**重启服务**（补丁在启动时读取）。
  - 值不要加引号也可以；中文/特殊字符请使用引号。
- 上游问题：这条链路在 dsh 侧（profile reload 状态），本仓库已整理了一份最小复现报告，见 [docs/upstream-profile-reload.md](docs/upstream-profile-reload.md)。
- 附带说明：这个确认字段的命名空间与版本号都随 dsh 版本变过（`ui-onboarding` → `ui-settings-general`；`2026-08-13.1` → `2026-09-28.1`），所以**每次升级 dsh 后声明都可能再弹一次**，这属于正常现象（点一次即可，或交给上面的屏蔽）。
- 与分栏适配无关：不带 `?dshPanel` 参数的原生 GUI 表现完全相同（`npm run verify -- --only notice` 会跑这条链路的对照与验收）。

## 降级说明

若 dsh 安装在扩展无法写入的位置（或前端结构在后续版本再次变化、补丁探测不到稳定挂点），扩展会：

1. 状态栏与侧栏保持可用（侧栏是原生列表，不依赖 GUI 分栏）；
2. 编辑器标签页改为**嵌入完整 GUI**（不传 `?dshPanel`），GUI 自带侧栏在窄于 1024px 时会自动收成图标栏；
3. 「Open in Browser」随时可用。
