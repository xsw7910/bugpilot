# 阶段 5 手测清单（VS Code 扩展）

设计文档 §5.4 的验收项里，有一部分**无法自动化**——主题渲染、宽度、纯键盘操作、
重启后恢复。这份清单就是那一部分，逐条可执行、有明确期望结果。

自动化已经覆盖的部分不在这里重复（颜色字面量、固定宽度、label 齐备、CSP、
无远程资源、页面不赋值 HTML、命令与视图与 manifest 双向一致等，见
`extension/test/panel.test.ts` 与 `manifest.test.ts`，以及 `npm run smoke`）。

## 0. 准备

```powershell
cd <your checkout>\extension
npm run typecheck
npm test          # 应为 213 passed
npm run smoke     # 应输出 activated, registered 19 commands and 3 views
```

然后在 VS Code 里按 F5（Extension Development Host）。首次需要一个
`.vscode/launch.json`：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run BugPilot Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}/extension"],
      "preLaunchTask": "npm: build"
    }
  ]
}
```

> `preLaunchTask` 必须跑 `npm run build`：扩展宿主加载的是 `out/extension.js`，
> 不是 `.ts` 源码。改完代码没重新 build 就 F5，看到的是上一版。

## 1. 功能主线（§9 阶段 5 功能验收）

**验收标准**：不打开终端即可完成完整调查流程，并明确知道下一步如何交给 agent。

| # | 操作 | 期望 |
| --- | --- | --- |
| 1.1 | 打开一个 git 仓库，点活动栏 BugPilot 图标 | 面板出现；短暂显示 "Checking bugpilot…"，随后消失 |
| 1.2 | 首次打开、未跑过 | 六行工作流都在，状态图标全是空心圈；右上角 "Ready to run"；Advanced settings 是折叠的 |
| 1.3 | 选 Bug description，填一段描述，按 **Ctrl+Enter**（不碰鼠标） | 开始运行；右上角变 "Running n/6…"；当前行图标旋转 |
| 1.4 | 运行结束 | 右上角 "Context ready"；每跑过的行有 ✓ 与耗时；Build context 行右侧出现三个图标；Artifacts 树按分组列出产物 |
| 1.5 | 点 Build context 行的第一个图标（↗） | 在编辑器打开 `bug_context.md`（非预览模式） |
| 1.6 | 点第二个图标（⧉），粘贴到任意编辑器 | 得到交接指令文本 |
| 1.7 | 点第三个图标（🗀） | 资源管理器定位到 `.ai/<work item>/` |
| 1.8 | 命令面板 → BugPilot: Open Panel in Editor | 编辑器区打开同一面板，两处内容一致 |
| 1.9 | 取消勾选 Build context | 下面四项（含 Fix with AI）立即变灰并取消勾选，出现解释文字；重新勾上后**原来的选择回来** |
| 1.10 | 用一个 Jira key 跑一次（需要凭据） | Fetching the Jira issue 活动文字出现；结束后 History 树里出现该 key |
| 1.11 | History 树点一条旧记录 | 面板切到该 work item，状态从 `workflow_status.json` 恢复（**无耗时**，这是预期）；图标仍然可用（它们跟着文件走） |

### 1c. History（新增，2026-09-08）

| # | 操作 | 期望 |
| --- | --- | --- |
| 1c.1 | 看 History 列表 | 每行图标反映结局，**不是清一色 bug**；未跑完/失败/等你写反馈/已备好重试/已修完各自不同 |
| 1c.2 | 悬停一行 | 四到五行：`<id> · Jira issue`、标题、`Last changed …`、结局一句话、`Click to reopen…`；**不知道的行不出现** |
| 1c.3 | 右键一行 | 菜单五项：Open agent_task.md / Copy Handoff Prompt / Open Artifacts Folder / Retry / Clean；Clean 与其他分组隔开 |
| 1c.4 | 右键**另一条**（不是当前面板显示的那条）→ Open agent_task.md | 面板先切到那条，再打开它的文件（**不能**打开原来那条的） |
| 1c.5 | 运行中右键一条旧记录 → Clean | 提示「运行中」，**什么都不删** |
| 1c.6 | 右键 → Clean → 确认 | 仍然弹模态确认（右键不跳过它）；删完 History 与 Artifacts 都刷新 |
| 1c.7 | 右键占位行（"No work items yet…"） | **没有菜单** |

### 1b. Fix with AI（新增，2026-09-07）

| # | 操作 | 期望 |
| --- | --- | --- |
| 1b.1 | 不勾 Fix with AI，跑一次 | **不开任何终端**；右上角 "Context ready" |
| 1b.2 | 勾上 Fix with AI，跑一次（机器上有 `claude`） | 运行结束后自动开终端、在**仓库根**跑 `claude "…"`；该行 ✓ 且写 "Handed to Claude Code in a terminal."；右上角 "AI fix started" |
| 1b.3 | 勾上 Fix with AI，但机器上没有 agent | **不开终端**；交接语进剪贴板；该行是 skipped 并写明原因 |
| 1b.4 | Advanced settings → AI agent 选 Custom command，留空后跑 | 该行写 "No custom agent command is set…"，指向 Advanced settings |
| 1b.5 | Custom command 填 `my-agent --prompt {prompt}`（一个不存在的命令） | 不开终端，写明 `my-agent is not on PATH.` |
| 1b.6 | 让运行失败（断网跑 Jira key），Fix with AI 勾着 | **不交接**；该行写 "The run did not finish…" |

## 2. 四主题（§5.4 验收 1）

依次切换：Light+ / Dark+ / High Contrast Dark / High Contrast Light
（`Ctrl+K Ctrl+T`）。每种主题下检查：

- [ ] 无不可读文本（前景/背景对比足够）
- [ ] 输入框、按钮、卡片**边框可见**（高对比主题下尤其）
- [ ] 六行状态可区分：不只靠颜色——状态图标（转圈/实心圆勾/✕/斜杠圈）都能看清
- [ ] 状态图标在**行的右端**，与左端的复选框不会看混（尤其别再是两个勾）
- [ ] 未开始的步骤右端**什么都不显示**
- [ ] 图标**不是方框豆腐**（字体没打进包时就会这样）
- [ ] 焦点环可见（Tab 到每个控件）
- [ ] 主按钮 Run 与次按钮 Stop 有明显区别

## 3. 三档宽度（§5.4 验收 2）

把侧边栏拖到约 200px / 300px / 500px：

- [ ] 无横向滚动条
- [ ] 标签不截断（展开 Advanced settings 后 "Max search lines" 完整可见）
- [ ] 长路径与长错误文案换行，不溢出
- [ ] 工作流行里的耗时/图标不与标签重叠；200px 下 Build context 行的三个图标 + 耗时 + 状态仍在同一行
- [ ] "Always runs" 贴右，不换到独立一行

## 4. 纯键盘走完一遍（§5.4 验收 3）

**不碰鼠标**，从面板获得焦点开始：

- [ ] Tab 顺序与视觉顺序一致（输入源 → 字段 → Run →〔Stop/Retry，同一行〕→ 六行工作流 → Advanced settings）
- [ ] 单选/复选可用空格与方向键切换
- [ ] 在任意输入框按 **Ctrl+Enter** 触发 Run（单按 Enter **不**触发——描述框要用它换行）
- [ ] Advanced settings 折叠区可用 Enter 展开
- [ ] Build context 行的三个图标能 Tab 到，且读屏能读出各自的名字
- [ ] 运行中 Tab 到 Stop 并回车可停止（Stop 只在运行中出现，与 Run 同一行）
- [ ] 空闲时 Run 旁边**没有**灰掉的按钮
- [ ] 200px 宽度下 Run + Stop 仍在同一行，不换行、不出横向滚动条
- [ ] 屏幕阅读器（Windows Narrator，`Ctrl+Win+Enter`）能读出每行状态词
      （"Code search: running"）

## 5. 三态齐备（§5.4 验收 4）

| 视图 | 空 | 加载/运行中 | 错误 | 怎么造出错误态 |
| --- | --- | --- | --- | --- |
| 主输入面板 | [ ] 六行皆空心圈 + "Ready to run" | [ ] Run 禁用 + 当前步骤文字 | [ ] 字段旁就地红字（在 Advanced 里的字段会自动展开该区） | 填 `not a key` 后 Run；再试 Max files 填 `x` |
| 工作流 | [ ] "Ready to run" | [ ] "Running n/6…" + 转圈图标 | [ ] 失败行标红 + 原因卡片 + "Run failed" | 断网后跑一个 Jira key |
| Artifact 树 | [ ] "No artifacts yet…" | [ ] "Scanning .ai/ …" | [ ] "could not be read" | 把 `.ai/<id>/` 设为不可读（Windows: 移除当前用户读权限） |
| History | [ ] "No work items yet." | — | [ ] 降级为空列表而非报错 | 删掉 `.ai/` 或造一个坏目录 |
| CLI 未安装 | [ ] 安装向导三按钮 | [ ] "Checking bugpilot…" | [ ] 具体原因（不在 PATH / 版本太旧 / 超时 / doctor 失败） | 把 `bugpilot.executablePath` 设成 `C:\nope\bugpilot.exe` |

五种裁决各自的文案要不同（§5.3 表），尤其：

- [ ] 配置了一个坏路径 → 说的是"配置的路径不存在"，不是"不在 PATH"
- [ ] 装了旧版（不认 `--json`）→ 说"升级 bugpilot"，不是"装一个"
- [ ] `doctor` 因缺 Jira 凭据失败 → 说的是凭据，且给 Run Doctor 按钮

## 6. 状态保持（§5.4 验收 5）

- [ ] 填半个表单 → 切到别的侧边栏视图 → 切回来：内容仍在
- [ ] 填半个表单 → 关闭窗口重开：内容仍在（workspaceState）
- [ ] 跑完一次 → 重启 VS Code：checklist 从 `workflow_status.json` 恢复，
      Artifacts 树仍列出该 work item 的产物
- [ ] 运行中把面板隐藏再显示：进度继续，不重置

## 7. 安全边界（§5.4 验收 6）

- [ ] 配好 Jira 凭据后，在 Webview 上右键 → Inspect（开发者工具）→
      Network 面板：**无任何外部请求**
- [ ] 开发者工具 Console 里执行 `document.body.innerText.includes("ATATT")`
      → `false`（token 不在页面里）
- [ ] Application → Local Storage：只有表单内容，无 token
- [ ] 尝试在 Console 里 `acquireVsCodeApi` 已被占用（页面已调用一次），
      无法再取；即便伪造消息，`{type:"command", id:"workbench.action.quit"}`
      也不会执行（宿主只接受语义动作与自己下发的命令 id）

## 8. Retry 循环（§5.6）

- [ ] 跑完一次后按 Retry：打开 `user_feedback.md`，并提示"写完再按一次"
- [ ] **不要**填内容直接再按 Retry：仍然只是提示（CLI 认为模板已存在，
      于是给出 `agent_retry_prompt.md` 就绪）
- [ ] 填写反馈后按 Retry：提示交接 `agent_retry_prompt.md`
- [ ] 全程**没有**任何 agent 在终端被自动拉起

## 9. 破坏性操作

- [ ] 勾选 "Delete previous artifacts first" 后 Run：**先弹模态确认**，
      取消则什么都不发生
- [ ] 命令面板 → BugPilot: Clean Work Item Artifacts：先问 work item，再模态确认
- [ ] 命令面板 → BugPilot: Clear Jira Credentials：清除后面板底部状态变为
      "No Jira credentials stored."

## 10. 会话续接（§5.6，标记为脆弱）

- [ ] workspace root **正好是** agent 运行目录时：
      BugPilot: Resume Agent Session in Terminal → 新终端跑
      `claude --resume <id>`
- [ ] 打开父目录时：提示"没找到会话，只有 workspace root 是 agent 运行目录时才可见"
      —— **不是**报错，也不是显示一个坏掉的入口

## 记录结果

每轮手测把不通过的项连同截图记到 `docs/phases/phase_5.md` 的「已知遗留」，
不要只在对话里说。
