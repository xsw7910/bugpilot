# 阶段 5 —— Extension 完整 UX（V1）

**状态**：代码完成 + 两轮 review 修复（14 + 13 项），**手测未做** · 2026-09-04
**计划**：[adapter_design.md](../adapter_design.md) §5.3 / §5.4 / §5.6 / §9 阶段 5
**过程**：[implementation_log.md](../implementation_log.md) 阶段 5
**手测清单**：[manual_qa_phase5.md](../manual_qa_phase5.md)
**测试**：TypeScript 258 passed（阶段 4 收尾 82）；Python 483 passed（未改动）
**构建**：`npm run typecheck` / `npm test` / `npm run smoke` 全绿

**这一阶段的一句话结果**：不打开终端就能完成完整调查流程。R8 兑现——
V1 既没有功能裁剪，也没有界面降级。

**但请注意**：所有验收都是**在真实 VS Code 之外**完成的。`npm run smoke` 会加载
构建产物、真的 `activate()`、真的 resolve 一次 webview，但它不是编辑器。
§5.4 里主题、宽度、键盘、重启这四类验收必须由人在 Extension Development Host
里跑一遍，清单已备好。

## 提交

```text
7d95f4d  Phase 5.1: a loadable extension, its manifest, and the readiness wizard
3599405  Phase 5.2-5.4: the form, progress and artifact models
8f5d4df  Phase 5.5: the panel's document, styles, page script and message contract
bad541f  Phase 5.6: wire the panel, trees, commands and the retry loop
9b7cc55  Phase 5.7: close the last four gaps in the UI standard, and the QA script
```

## 1. 交付物

| 文件 | 内容 | 测试 |
| --- | --- | --- |
| `package.json` | 19 命令、3 视图、活动栏容器、1 配置项、打包构建脚本 | `manifest.test.ts`（9） |
| `src/commands.ts` | 命令 / 设置 / 视图 id 的单一真源 | 同上 |
| `src/app/environment.ts` | 仓库选择 + 五态裁决 + 安装向导（数据形式） | `environment.test.ts`（9） |
| `src/app/form.ts` | 表单模型、字段级校验、argv 构建（`--flag=value`）、plan 耦合 | `form.test.ts`（26） |
| `src/app/progress.ts` | 事件流 / `workflow_status.json` → 5 行 checklist + 耗时 | `progress.test.ts`（15） |
| `src/app/artifacts.ts` | 产物分组排序、缺失结果文件、history 列表 | `artifacts.test.ts`（14） |
| `src/app/controller.ts` | 状态机：Run / Stop / Retry / 打开产物 / 恢复历史 | `controller.test.ts`（43） |
| `src/app/session.ts` | Claude 会话目录推导（脆弱、可降级） | `session.test.ts`（6） |
| `src/panel/messages.ts` | Webview 消息契约 + **不可信输入校验** | `panel.test.ts`（26） |
| `src/panel/html.ts`、`src/panel/nonce.ts` | 面板文档骨架（CSP、label、ARIA）+ crypto 级 nonce | 同上、`nonce.test.ts`（2） |
| `src/panel/provider.ts` | 侧边栏视图 + 编辑器 tab，共用一份 HTML | `smoke` |
| `src/views/trees.ts` | 产物树 + history 树（含三态占位行） | `smoke` |
| `src/host/*.ts`、`src/extension.ts` | 唯一 import `vscode` 的地方；全是适配器与注册 | `smoke` |
| `media/panel.{css,js}`、`media/bug.svg` | 293 行样式 + 330 行页面脚本，零依赖 | `panel.test.ts`（26）+ `page.test.ts`（24，最小 DOM 桩） |

运行时依赖仍为零；devDependencies 只有 `typescript`、`@types/node`、`@types/vscode`。

## 2. 下游可依赖的公开契约

```typescript
// 面板 ↔ 宿主
PanelState { revision, readiness, form?, problems, progress, artifacts,
             jiraConfigured, canRetry, workItemId? }
Readiness = checking | ready | blocked          // 三种反应：等 / 修 / 走
parsePanelMessage(raw) -> PanelMessage | undefined
PANEL_ACTIONS = ["openTask", "copyHandoff", "setCredentials"]

// 控制器（四个窄端口：RunnerPort / FilesPort / UiPort / Log）
new Controller(ports, initialForm)
  .refreshEnvironment() / .run(form) / .stop() / .retry()
  .openArtifact(name) / .copyHandoff() / .refreshArtifacts() / .showWorkItem(id)
  .handle(panelMessage)

// 视图模型
buildPrepareArgs(form, {root, descriptionFilePath?}) -> {ok, args, files} | {ok:false, problems}
buildRetryArgs(id) -> ["bug", id, "--retry", "--prepare-only", "--json"]
// 值型参数一律 --flag=value：argparse 会把 `--keywords -Wall` 的值当成选项
new ProgressTracker(plan, now?) / viewFromStatus(json)
buildArtifactList({names}) / historyFromPayload(payload, modifiedMs?)
DirectoryListing = ok | missing | unreadable     // missing 不等于 unreadable
```

**规矩没变，而且是这一阶段能有 258 条测试的唯一原因**：只有
`src/extension.ts`、`src/host/**`、`src/panel/provider.ts`、`src/views/**`
可以 import `vscode`。测试永远不 import 这些。

## 3. 与计划的净偏差

| 偏差 | 原因 | 设计文档 |
| --- | --- | --- |
| 「零构建」只对测试成立；打包走 `tsconfig.build.json` 出 CommonJS | 扩展宿主用 `require()` 加载 `main`，其 Node 远早于 22.18 的类型剥离 | 已同步 §8 |
| 宿主计算、页面渲染 | 没有 bundler，Webview 无法 import 视图模型；引 bundler 又回到刚摆脱的构建复杂度 | 已同步 §5.3 |
| Build context 与其余三项耦合 | CLI 没有 `--skip-build-context`，关掉它只能 `--only-issue-details` | 已同步 §5.3 |
| 扩展默认 `--resume`（CLI 默认 `--fresh`） | 阶段 3 已因 `fresh=True` 删掉过 agent 的 `fix_summary.md` | 已同步 §5.3 |
| Retry 用 `--json` | CLI 的 retry 分支不认 `--json-lines`，且不给 json 标志会在终端拉起 agent | 已同步 §5.3 |
| Webview 内用文本字形而非 Codicon 字体 | 免去 `@vscode/codicons` 依赖与 `font-src` 放宽；原生视图仍用 `ThemeIcon` | 已同步 §5.4 |
| 进度 checklist 是 5 个能力而非 20 个步骤 | `keywords` 属于两个能力，用它点亮任一行都是说谎 | 已同步 §5.3 |

## 4. 验收对照（§9 阶段 5）

### 功能验收

| 要求 | 状态 |
| --- | --- |
| 不打开终端完成完整调查流程 | 代码完成（面板 Run → checklist → 产物树 → Open/Copy 交接）；**待手测 1.1–1.11** |
| 明确知道下一步如何交给 agent | Hand off 区块 + `agent_task.md` + Copy handoff prompt |
| §5.3 表中全部能力 | 全部实现：输入源切换、9 个字段、5 项调查范围、Run/Stop、实时 checklist、产物树、Markdown 预览（走 VS Code 内置）、history、Open/Copy、MCP status、Doctor/Agent Check/Clean、安装向导、executable 配置、SecretStorage |
| §5.6 续接 UI | Retry 按钮（先开 `user_feedback.md` 再 `--retry`）+ 会话续接命令 |

### 界面验收（§5.4 六条）

| # | 要求 | 自动化部分 | 待人工 |
| --- | --- | --- | --- |
| 1 | 四主题无问题、无硬编码颜色 | 颜色字面量扫描（HTML+CSS，剥注释后） | 四主题截图 |
| 2 | 200/300/500px 无横向滚动 | 无固定 `width: <n>px`、`border-box`、`overflow-wrap` | 三档宽度手测 |
| 3 | 纯键盘完成一次流程 | 每控件有 label、`:focus-visible` 用 `--vscode-focusBorder`、状态词进 `aria-label` | 纯键盘走一遍 + Narrator |
| 4 | 三态表每格都有实现 | 15 格全部有代码路径，其中 `loading` 与 `unreadable` 是 5.7 补的 | 造错误态验证 |
| 5 | 隐藏再显示不丢内容；重启恢复进度 | `getState/setState`、`workspaceState` 存表单与 work item、`viewFromStatus` 恢复 | 重启验证 |
| 6 | 无凭据进 Webview；CSP 与 localResourceRoots | `PanelState` 无 token 字段（测试搜整份序列化状态）、CSP 断言、`localResourceRoots` 限定 media/ | 开发者工具确认 |

## 5. 已知遗留

- **手测一次都没做。** 这是本阶段最大的未知，清单见
  [manual_qa_phase5.md](../manual_qa_phase5.md)。
- **`.vscode/launch.json` 未提交**（清单里给了内容）。仓库根的 `.vscode/`
  属于用户环境，等确认后再决定是否入库。
- **`.vsix` 从未打过包。** `vsce` 未安装，`.vscodeignore` 未写。属于阶段 6。
- **`--same-session`（§5.6）CLI 侧不存在**，因此扩展也没有这个入口。§11 待决 #5。
- **MCP 真实客户端连通性仍未验证**（阶段 0A 的假设），是 Internal Beta 前的硬阻塞。
- **`agent-check` / `clean` / `retry-prompt` 没有 `--json`**，扩展只能把纯文本
  丢进 OutputChannel。要在 UI 里结构化展示这几个，得先在 CLI 侧加信封。
- **产物树的 `loading` 态实际上很难看到**：本地目录读取太快。它存在是为了
  网络共享与大仓库，以及避免「空列表」被误读为「这次运行什么都没产出」。

## 5b. 两轮 review 修掉的 27 项（要点）

完整清单见 [implementation_log.md](../implementation_log.md) 的「阶段 5 review」。
两条最严重的：

1. **安装向导的按钮全是死的**——`Controller.handle` 的 switch 没有 `command`
   分支，消息解析完就被丢掉；`messages.ts` 承诺的「宿主再拿 `COMMANDS` 核对」
   也不存在。现在核对了，也真的执行了。
2. **值型参数必须用 `--flag=value`**——`--keywords -Wall` 会被 argparse 当成选项，
   `--json-lines` 下的表现是 exit 2、零事件、无终止事件，扩展只能显示
   「bugpilot 没说原因就停了」。

另有两条是**给 `media/panel.js` 补上第一批行为测试**时掉出来的：运行第一帧里
Run 按钮仍可点；HTML 的 plan 复选框默认全未勾选（与 `DEFAULT_FORM` 相反），
在宿主推第一份 state 之前按 Run 等于一次什么都不搜的调查。

**第二轮（13 项）专攻 smoke 之外没有测试的 vscode 层与生命周期**，修的多是
「状态会过期」与「说错了原因」：

- **扩展对外部变化毫无反应**：没有配置监听（改了 `executablePath` 仍跑旧二进制）、
  没有工作区监听（空窗口里打开文件夹后仍说「没有打开的文件夹」）、
  `deactivate()` 不杀在飞的运行（关窗口会留下 bugpilot 和 ripgrep）。
- **15 分钟超时被报成「你点了停止」**：Runner 对 Stop 与超时都返回 `aborted`，
  控制器分不开。现在超时是 `TIMEOUT` 失败并给出「缩小搜索范围」的下一步。
- **CSP nonce 来自 `Math.random()`**：nonce 是安全控制，改用 `node:crypto`。
- **`command` 白名单从整张 `COMMANDS` 表收紧为「此刻实际提供的那几个」**
  （原来连 `bugpilot.clean` 都会被接受）。
- 另有：`list` 失败显示成「还没有 work item」、运行中点 History 静默无反应、
  产物树不说在看哪个 work item、第二次 Retry 打开的文件与提示语不一致、
  日志时间戳是 UTC、`Check Environment` 跑了两次 `doctor` 握手、环境探测无去重。

## 6. 给阶段 6 与后续 review 的要点

1. **改了代码要 `npm run build` 再 F5。** 扩展宿主加载 `out/extension.js`，
   不是 `.ts`。这是最容易浪费半小时的坑。
2. **三条守卫必须保持绿**：manifest 双向一致（命令、视图、图标存在、
   面板命令隐藏）、`npm run smoke`（注册集合 + 真的构建 HTML）、
   页面文件扫描（无颜色、无固定宽度、不赋值 HTML、id 存在、字段一致）。
   它们守的都是**静默失败**：VS Code 不会因为这些报错，只会表现得不对。
3. **页面永远不要拿到编辑器命令 id 的自由。** 语义动作是固定集合；
   唯一回传的命令 id 是宿主自己下发的，且回来时仍要与 `COMMANDS` 核对。
4. **`openArtifact` 的两道校验都要留着。** 消息解析器挡一次，真正开文件前
   再挡一次——TreeView 会走到同一个方法。
5. **`diagnose()` 是唯一的错误文案出口**，不要在 UI 里另写一套；同一个
   `error.code` 出现两种解释比没有解释更糟。
6. **`missing` 与 `unreadable` 不要再合并回一个空列表。** 前者是首次运行前的
   正常状态，后者是开发者必须去修的问题；合并等于告诉他「这次运行什么都没产出」。
7. **Retry 的两段式不能简化。** 第一次只创建 `user_feedback.md` 并停下是
   §5.6 的核心机制，不是多余的一步。
8. **值型参数一律 `--flag=value`。** 新增字段时用空格形式，会为那一个字段
   重现 argparse 吃掉 `-Wall` 的 bug。有一条测试遍历所有值型参数。
9. **`media/panel.js` 现在有 DOM 桩测试，改页面逻辑时一起改。** 桩里的元素
   从真实 `panelHtml()` 抓 id 生成（含 `checked`/`hidden` 初值），所以 markup
   与页面脚本的任何不一致都会红。
10. **`extension.ts` 与 `host/**` 里只放适配器与注册。** 一旦出现判断，就搬进
    `src/app/`——那两处只有 smoke 覆盖，是整个扩展最容易藏「状态过期」类缺陷
    的地方（第二轮 13 项里有 3 项就在那儿）。
11. **任何「文件里不得出现 X」的测试，都要先剥注释。** 这个坑踩了两次
    （panel.css/panel.js 的颜色扫描，nonce 的弱 RNG 扫描）。
12. **`refreshEnvironment()` 会去重在飞的探测**，不要绕过它直接调
    `environment()`——那会多跑一次 `doctor` 握手。
