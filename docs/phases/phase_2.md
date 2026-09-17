# 阶段 2 —— CLI Machine API

**状态**：完成 · 2026-09-04
**计划**：[adapter_design.md](../adapter_design.md) §5.1 / §5.6 / §9 阶段 2
**过程**：[implementation_log.md](../implementation_log.md) 阶段 2.1 – 2.6 及 review 修复
**测试**：429 passed（阶段 1 收尾 348，本阶段新增 81）

**这一阶段的一句话结果**：CLI 有了机器可读契约。扩展与 MCP 不再需要解析人类文本，
手写 bug 与 Jira issue 在命令行上完全等价。

## 提交

```text
eecae60  Fix eleven review findings from phase 2
081f1ed  Phase 2.3-2.6: JSONL stream, list, Jira gates, retry closure
0b90e18  Phase 2.2: bug command takes manual input, options, plan flags and --json
24fc940  Phase 2.1: JSON envelope and the error-code contract
```

## 1. 交付物

| 文件 | 内容 | 测试 |
| --- | --- | --- |
| `bugpilot/core/errors.py` | 稳定错误码 + `error_code_for()` / `code_for_jira_error_type()` | `tests/test_cli_json.py`（41） |
| `bugpilot/cli_json.py` | 信封构造与输出、`JsonLinesEmitter`、`emit_stream_failure` | 同上 |
| `bugpilot/cli.py` | 三组新参数、`list`、两个 Jira 闸门、`--retry`、`_dispatch` 拆分 | `tests/test_cli_phase2.py`（40） |

改动的既有模块：`workflow.py`（`keywords_step` 收 options）、
`agent_runner.py`（可选 `prompt`）、`email_notify.py`（manual 降级）。

### `--json` 覆盖的 10 个命令

```text
bug（另有 --json-lines） · fetch · search · context · status
list · check-results · summarize-results · delivery-check · doctor
```

### 新命令

`bugpilot list` —— 列出 `.ai/` 下的 work item（id / source / title / 状态）。
它是本地 id 故意不带可读 slug（§3.4）的终端侧补偿。

## 2. 下游可依赖的公开契约

### JSON 信封

```json
{ "schema_version": 1, "ok": true, "command": "bug",
  "work_item_id": "JR-12345", "source": "jira", "source_ref": "JR-12345",
  "issue_dir": ".ai/JR-12345", "generated_files": ["..."],
  "skipped_steps": [], "agent_task": ".ai/JR-12345/agent_task.md",
  "warnings": [] }

{ "schema_version": 1, "ok": false, "command": "bug",
  "error": { "code": "JIRA_AUTH_FAILED", "message": "..." } }
```

**三条硬保证**，均有测试固定：

1. `--json` 模式下 stdout **恰好一个 JSON 对象**，无论成败，包括未预期的异常。
2. 失败时**三个通道同时响**：stdout 信封、stderr 人类消息、非零退出码。
   只看退出码的消费者照样看到失败。
3. 消费者**只依赖 `error.code`**，永不解析 `error.message`。

### JSONL 事件流（`bug --json-lines`）

```text
started → [phase]* → [step_skipped]* → (step_started → step_completed)* → [artifact]* → completed
```

**`step_completed` 是推断出来的**：`run_investigation` 的 `progress` 回调只在每步
开始前触发。这带来一个有用的性质 —— **抛异常的步骤永远不会被关闭**，
消费者据此区分「崩了」与「跑完了」。前置失败也会输出一个 `completed ok:false`，
所以流总有终止事件。

### 错误码

| 组 | 码 |
| --- | --- |
| Jira | `JIRA_NOT_CONFIGURED` · `JIRA_AUTH_FAILED` · `JIRA_ISSUE_NOT_FOUND` · `JIRA_RATE_LIMITED` · `JIRA_TIMEOUT` · `JIRA_NETWORK_ERROR` · `JIRA_INVALID_RESPONSE` · `JIRA_ERROR` |
| 来源闸门 | `JIRA_ONLY_COMMAND` · `NO_JIRA_TARGET` |
| 本地状态 | `WORK_ITEM_NOT_FOUND` · `ARTIFACT_NOT_FOUND` · `MISSING_RESULTS` · `INVALID_INPUT` |
| 其他 | `EMAIL_SEND_FAILED` · `INTERNAL_ERROR` |

**一个码说「出了什么错」，不说「在做什么」** —— 命令名由 `command` 字段单独报告。
新增码只能追加，不能改名或改用途。

### CLI 参数

```text
输入   bug <ID> | bug --description TEXT | bug --description-file PATH  (+ --title)
Options --hint · --keywords · --focus-file · --ignore-path · --max-files · --max-search-lines
Plan    --skip-code-search · --skip-git-history · --skip-similar-fixes · --only-issue-details
续接    bug <ID> --retry
输出    --json · --json-lines
```

## 3. 与计划的净偏差

| # | 计划 | 实际 | 设计文档 |
| --- | --- | --- | --- |
| 1 | `--json` 覆盖 9 个命令 | 10 个（加了 `list`，本身就是计划新增的命令） | 无需同步 |
| 2 | 未提进度编号 | 编号按实际会跑的步骤算；`parse` 文案按来源区分以保 R1 | ❌ **未同步** |
| 3 | 未提 | `--json` / `--json-lines` **从不拉起 agent**（已写入帮助文本） | ❌ **未同步** |
| 4 | §5.6 只说 `--retry` 合成三步 | 首次生成 `user_feedback.md` 后**停下**，不拉起 agent | ❌ **未同步** |
| 5 | 未提 | `--max-files` / `--max-search-lines` 拒绝 < 1 | 无需同步 |

偏差 4 的理由：模板里是占位符，不是开发者对失败的描述。交给 agent 等于喂一个空的
修正——而那正是这个循环唯一存在的理由。

## 4. 验收对照（§9 阶段 2）

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 现有 CLI 行为逐字兼容 | ✅ | 348 个既有测试全绿，未修改任何一个；两次 R1 破口被既有测试当场拦下 |
| 9 个关键命令加 `--json` | ✅ | 实际 10 个 |
| `--json-lines` 事件流 | ✅ | `tests/test_cli_phase2.py` |
| `schema_version = 1`、稳定 `error.code` | ✅ | 有测试断言 `ERROR_MESSAGES` 每个键都有专属码 |
| manual description / description-file 输入 | ✅ | |
| Options 与 Plan 参数 | ✅ | 含 `--keywords`（review 时发现原是 no-op） |
| `bugpilot list` | ✅ | |
| manual 模式下 Jira 命令行为 | ✅ | 两个闸门 + 邮件降级 |
| 续接闭环 | ✅ | `--retry` + `check-results`/`delivery-check` 的下一步提示 |
| **Extension 不解析人类文本** | ✅ | 契约完备 |
| **未修复场景下用户能只靠 CLI 输出找到下一步** | ✅ | `Not fixed yet? Run: bugpilot bug <ID> --retry` |

## 5. 给后续阶段与 review 的要点

### 教训一：新增的输出路径会绕过既有保障

Review 的 11 项里有 **6 项**属于这一类：

| 绕过了什么 | 具体表现 |
| --- | --- |
| 闸门 | `BUGPILOT_AUTO_JIRA_COMMENT=1` 跳过 `NO_JIRA_TARGET`，手写 item 真的发了 Jira 评论（**R5 破口**） |
| 动作 | `--json` 在自动评论之前 `return`，`--jira-comment --json` 静默不发 |
| 异常处理 | `search --json` 让异常逃逸，stdout 零字节 |
| 产物存在性 | `--only-issue-details` 跳过 `prompt`，却仍声称有 `agent_task.md` 并拉起 agent 指向它 |

**给一个命令加第二条输出路径时，必须逐条核对第一条路径上的每个保障在新路径上
是否仍然成立。** 加闸门时要问「所有到达这个动作的路径都过闸了吗」，
而不是「我检查的那个参数对吗」。

**阶段 3（MCP）就是又一条新输出路径**，这条教训直接适用。

### 教训二：建了契约就要用

`errors.error_code_for` 在 2.1 建好，到 review 时**生产代码里一个调用方都没有**，
只有测试在用。写了分类器却没接进异常路径，等于没写。
新增契约后立刻找出它该被调用的每一处。

### 教训三：`frozen` dataclass 不能被下游改写

`bug --json` 对每个 Jira item 都报 `title: null`。`jira_request()` 建的是抓取前的
stub，`BugSpec` 是 frozen，`_persist_resolved_spec` 造了新对象但没有回传。
需要最新值的地方要重读 `load_bug_spec`，不能假设 `request.spec` 是最终态。

### 影响阶段 3（MCP）的两条

- **两个闸门的判据可复用，函数本身不可。** `_refuse_for_manual` /
  `_refuse_without_jira_target` 输出 CLI 文案。MCP 该用同样的判据
  （`spec.source` / `spec.can_write_back`）但抛结构化错误。
- **MCP 不应暴露 retry 工具**（§5.6 已决 18）。retry 的输入是人的反馈；
  阶段 2 的实现进一步印证了这一点 —— 首次生成模板后必须停下等人填写。

### 其他易错点

- 测试桩硬编码了 `run_agent` 的签名；加参数时 17 个测试一起红。
  改桩不改生产代码。
- `parse` **不是** Jira-only（对两种源都成立），只有 `fetch` / `jira-validate` 是。
  代码里有注释，别顺手也给它加闸门。
- `check-results` 的 `missing` 是仓库相对路径，不是裸文件名。

## 6. 已知遗留

| 项 | 说明 | 归属 |
| --- | --- | --- |
| manual 模式产物名仍含 `jira_parsed.md` | 产物名是 §6 对外契约，`prompts.py` / `context.py` / 文档产物表都引用它 | 阶段 7 |
| `--retry --same-session` 未实现 | §5.6 的折中选项；待决问题 5（用 `claude -c` 还是 `--resume <id>`）未定 | 待决 |
| 设计文档 3 处未同步 | 见 §3 偏差 2 / 3 / 4 | 阶段 3 前 |
| `core` 仍有 4 处 `print` | 全在明确标注 deprecated 的兼容 shim 里 | 阶段 3 前确认 |
