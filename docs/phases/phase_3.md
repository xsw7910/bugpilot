# 阶段 3 —— MCP 完整入口

**状态**：完成（含 review 修复；一项验收待真实客户端确认）· 2026-09-04
**计划**：[adapter_design.md](../adapter_design.md) §5.2 / §9 阶段 3
**过程**：[implementation_log.md](../implementation_log.md) 阶段 3
**使用说明**：[mcp_setup.md](../mcp_setup.md)
**测试**：481 passed（阶段 2 收尾 429，本阶段新增 52）

**这一阶段的一句话结果**：agent 可以直接驱动 BugPilot 了。R2 兑现——方向从
「BugPilot 拉起 agent」翻转为「agent 调用 BugPilot」。

## 提交

```text
4204a52  Fix eight review findings from phase 3
aa4517f  Wrap up phase 3: sync the design doc and record the phase result
4c62e19  Phase 3: MCP entry point with seven tools and a deterministic prompt
```

## 1. 交付物

| 文件 | 内容 | 测试 |
| --- | --- | --- |
| `bugpilot/mcp_server.py` | 7 工具 + `fix_bug` prompt + repo 绑定 + 边界校验 + 写锁 | `tests/test_mcp_server.py`（52） |
| `bugpilot/core/workflow.py` | 新增 `refine_investigation()` | 同上 |
| `pyproject.toml` | `[mcp]` optional extra、`bugpilot-mcp` 入口点 | — |
| `docs/mcp_setup.md` | 两种客户端配置、工具表、不暴露清单、`CLAUDE.md` 片段、排障表 | — |

## 2. 下游可依赖的公开契约

### 工具面（7 个，固定）

| 工具 | 作用 |
| --- | --- |
| `prepare_jira_bug` | 抓 Jira issue 并构建代码上下文 |
| `prepare_bug_description` | 同上，从散文描述构建，不碰 Jira |
| `refine_investigation` | 按新线索重查；**不重新联系 Jira** |
| `check_results` | 哪些结果文件还没写 |
| `summarize_results` | 汇总为可评审的摘要 |
| `search_memory` | 检索相似历史调查 |
| `get_status` | 哪些准备步骤跑过了 |

外加 prompt `fix_bug`（Claude Code 里表现为 `/mcp__bugpilot__fix_bug`）。

**不暴露**：Jira 评论、邮件、commit、push、`clean`、`setup`，以及 **retry**。
前四项是对外/破坏性动作（R5）；后两项不该由模型驱动；retry 的输入是开发者写的
反馈，做成工具等于让模型自己判定失败并重来。

### Python 接口

```python
from bugpilot.mcp_server import build_server, resolve_repo_root
build_server(repo_root=None) -> MCPServer   # None 时走 BUGPILOT_MCP_REPO_ROOT / cwd

from bugpilot.core.workflow import refine_investigation
refine_investigation(repo_root, work_item_id, options=None, plan=None, progress=None) -> WorkflowResult
```

### 六条硬保证（均有守护测试）

1. **工具集恰好这 7 个**，且与禁止清单无交集。
2. **没有任何工具接受 `repo_root`**。根在启动时绑定。
3. **每个模型提供的 id 都过 `validate_work_item_id`**，穿越形态（`../..`、`..`、`.ai`）
   一律拒绝。这条是 review 补上的 —— 原实现只有 `prepare_jira_bug` 间接受保护。
4. **每个工具都要求 work item 已存在**，不会因一个看似合理的 id 而新建幽灵目录。
5. **MCP 从不删除产物**：所有 prepare 走 `fresh=False`，二次调用不会清掉 agent 写的
   `fix_summary.md` 或开发者的 hint。
6. **MCP 路径不触达 `post_jira_comment`**，`summarize_results` 的 schema 里也没有
   `jira_comment` 参数。

## 3. 与计划的净偏差

| # | 计划 | 实际 | 设计文档 |
| --- | --- | --- | --- |
| 1 | 用 `FastMCP` | mcp 2.x 已改名 `MCPServer`，字段改 snake_case。选 2.x 而非 `pin mcp<2` | ✅ 已同步 |
| 2 | 未提异常类型 | 必须抛 **SDK 的** `ToolError`，否则提示信息全丢 | ✅ 已同步 |
| 3 | 未提 | `refine_investigation` 不走 `run_investigation`（否则每次重抓 Jira） | ✅ 已同步 |
| 4 | 计划把 `refine` 只放 MCP | 实现放在 core，CLI 暂无对应子命令 | 无需同步 |
| 5 | §5.2 要求 "tool result sanitize" | **撤销**：`sanitize_comment_text` 会腐蚀代码摘要，且模型本可直接读同一文件 | ✅ 已同步 |

## 4. 验收对照（§9 阶段 3）

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 7 个工具 + 1 个 deterministic prompt | ✅ | `test_exactly_the_seven_planned_tools` |
| repo-bound server，不让模型传 `repo_root` | ✅ | `test_no_tool_takes_a_repo_root` · `test_artifacts_land_in_the_bound_repo_only` |
| tool result sanitize | ⚠️ 已撤销 | 见 §3 偏差 5 与 §5 教训四 |
| `CLAUDE.md` 推荐片段写进文档，且不作依赖 | ✅ | `mcp_setup.md`；全部测试在无该文件的 `tmp_path` 下通过，即 R9 |
| 从 Jira 或自然语言描述进入 workflow | ✅ | 两个 prepare 工具各有测试 |
| `refine_investigation` 按新 hint 重跑 | ✅ | `test_refine_reuses_the_prepared_work_item` |
| MCP 调用不修改 source tree | ✅ | 工具集不含写源码操作（不变量 6 是评审规则，由清单保证） |
| **真实 Claude Code 客户端连通** | ⏳ **未验证** | 只在进程内调过 `call_tool`，未走真实 stdio 协议 |

最后一项是阶段 0A 本应验证的核心假设——**模型会不会优先调用工具而不是自己 grep**。
需要在真实客户端里配 `.mcp.json` 实测。它不阻塞阶段 4/5（那两阶段依赖的是阶段 2 的
CLI 契约），但**应在 Internal Beta 之前完成**。

## 5. 给后续阶段与 review 的要点

### 教训一：SDK 的异常类型是契约的一部分

我定义了一个本地 `ToolError`，名字对、意图对、**完全无效**——SDK 只认自己那个，
其余一律当崩溃。结果模型收到的是 `Error executing tool get_status`，
而我在每个工具里精心写的「下一步该怎么做」全部丢失。

**接入任何 SDK 的错误通道前，先确认它靠什么识别「预期失败」**：异常基类、
返回值约定、还是错误码。名字相同不等于类型相同。

测试里断言 `not isinstance(exc, UnexpectedToolError)`，把这条钉死。

### 教训二：前置闭包对增量场景是错的

阶段 1 引入 `STEP_PREREQUISITES` 传递闭包，解决的是「部分 plan 会崩溃」。
但它对**增量重查**是错的：`refine` 只想重跑检索，闭包却因 `parse` 依赖 `fetch`
而把 Jira 抓取拉回来——每次 refine 都要联网。

`refine_investigation` 因此从 `keywords` 起跑，绕过闭包。
**一个依赖模型服务「从零构建」时正确，不代表它服务「增量更新」时也正确。**

### 教训三：守护测试比正常路径测试更值钱

阶段 2 的教训是「新增的输出路径会绕过既有保障」。这轮据此写测试：
禁止清单求交集、遍历 schema 查 `repo_root`、monkeypatch `post_jira_comment`
使其抛异常。这些测试**平时什么也不证明**，但将来任何人手滑加一个 `commit` 工具、
或给工具加个 `repo_root` 参数，会立刻红。

阶段 4/5 引入 TypeScript 后同样适用：扩展是第三条输出路径。

### 教训四：脱敏用错了地方会破坏数据

§5.2 要求「MCP 工具的返回值也要过一遍脱敏」，我照做了。Review 实测发现
`sanitize_comment_text`（为 Jira 评论设计）会把
`def load(key, secret_path)` 变成 `def load(key, <redacted>`、
`token = compute_token()` 变成 `token = <redacted>` ——
**模型读到的是不存在的函数签名**。

而且它保护不了什么：agent 对同一个仓库有文件读权限，能直接打开那份文件。
脱敏的正确位置是**离开本机的文本**（Jira 评论、邮件），`jira.py` 和
`email_notify.py` 已经在那里做了。

**判断一个防护措施该放哪里，要看威胁模型，不能看"多一层总没错"。**

### 教训五：一个保证只写在文档里就等于没有

module docstring 和这份文档的初版都声称「根在启动时绑定，模型填错也只会写进
绑定的仓库」。实际上**只有 `prepare_jira_bug` 间接受保护**（`fresh=True` 会调
`validate_issue_key`），其余四个工具的 id 直接进 `issue_dir()`。
Review 实测用 `summarize_results` 往仓库外写了 4 个文件。

写下一条保证时，同时问：**哪一行代码在执行它？有没有测试会在它失效时变红？**
现在两者都有了。

### 其他易错点

- `search_memory` 既是工具名也是 core 函数名；装饰后的局部函数会遮蔽模块级导入，
  必须在 import 时取别名。
- `MCPServer.call_tool()` 对预期失败是**抛** `ToolError`，不是返回
  `is_error=True`（后者是协议层的行为）。写进程内测试时注意。
- mcp 2.x 的 `Tool` 字段是 `input_schema`，不是 `inputSchema`。

## 6. 已知遗留

| 项 | 说明 | 归属 |
| --- | --- | --- |
| 真实客户端连通未验证 | 见 §4 最后一行 | Internal Beta 前 |
| CLI 无 `refine` 子命令 | `refine_investigation` 目前只有 MCP 在用 | 按需 |
| `core` 仍有 4 处 `print` | **已确认生产调用方为 0**，全在 deprecated shim 里，不影响 MCP 的 stdout | 阶段 7 删除 |
