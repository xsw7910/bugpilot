# BugPilot 多入口实施日志

按 [adapter_design.md](adapter_design.md) 的阶段计划逐步实施的**流水记录**。

每个阶段完成后，另有一份稳定的阶段性成果文档：[phases/](phases/)。
本文件是过程（每小步的偏差与钩子，会越来越长）；阶段文档是结果（交付了什么、
下游能依赖什么接口、留下什么坑）。开始新阶段前读阶段文档，做下一小步前读本文件
的上一条。

## 怎么用这份文件

**开始下一步工作前**，读两样东西：

1. [adapter_design.md](adapter_design.md) —— 总体计划。§9 是阶段划分，§11 是已决/待决。
2. 本文件里**上一步的条目** —— 它记录了实际实现成什么样、与计划的偏差、以及留给
   下一步的钩子。

**完成一步工作后**，在本文件追加一条，用下面的模板。重点写三件计划里没有的信息：
**实际实现与计划的差异**、**实施中才发现的约束**、**下一步能直接用的接口**。
不要复述计划已经写清楚的内容。

```markdown
## [阶段 N.M] 标题 — YYYY-MM-DD

**对应计划**：§X.Y / 阶段 N
**提交**：`<short-sha>`
**测试**：NNN passed（基线 MMM + 新增 K）

### 交付
- 新增/修改了什么

### 与计划的偏差
- 计划说 A，实际做成 B，因为 C。（设计文档已同步 / 未同步）

### 实施中发现的约束
- 计划阶段不知道的事实

### 留给下一步的接口
- 下一步可以直接调用/依赖的东西

### 未做
- 本步骤范围内明确没做的部分
```

---

## [阶段 1.1] work item identity 与领域模型 — 2026-09-03

**对应计划**：§3.3 领域模型、§3.4 work item identity、阶段 1 前两项
**测试**：268 passed（基线 236 + 新增 32）

### 交付

新增两个 core 模块，均为叶子模块（只依赖 `config`，不依赖其他 core 模块）：

| 文件 | 内容 |
| --- | --- |
| `bugpilot/core/identity.py` | `is_jira_issue_key` · `is_work_item_id` · `validate_work_item_id` · `new_local_work_item_id`；两个正则常量 |
| `bugpilot/core/models.py` | `BugSpec` · `InvestigationOptions` · `InvestigationPlan` · `InvestigationRequest`；plan → `WORKFLOW_STEPS` 展开 |
| `tests/test_identity_models.py` | 32 个测试 |

按 §3.4 的表改完了全部调用点：

- `cleanup.ISSUE_KEY_CLEAN_RE` 删除，`validate_issue_key` 变成 `validate_work_item_id` 的
  deprecated 别名（保留是为了不动现有调用方，新代码直接用后者）。
- `memory.ISSUE_KEY_RE` 与 `memory._looks_like_issue_key` 删除，`search_memory` 改用
  `is_work_item_id`。
- `workflow.looks_like_issue_key` 变成别名，`workflow` 不再从 `memory` 导入正则。

**修掉的实际 bug**：`memory search local_...` 以前会把本地 id 当自由文本查询
（旧 `ISSUE_KEY_RE` 只认 Jira 形态），现在能正确识别为 work item id。

### 与计划的偏差

**`WORK_ITEM_ID_RE` 收紧了。** 计划里写的是 `^[A-Za-z][A-Za-z0-9_-]*$`，实现改成
`^[A-Za-z][A-Za-z0-9_-]*[-_]\d+$`（尾部必须是数字后缀）。

原因：现有测试 `test_clean_rejects_invalid_issue_keys_without_deleting` 断言裸词 `HR`
会被 `clean` 拒绝。旧 `ISSUE_KEY_CLEAN_RE` 靠 `-\d+$` 隐含了这条性质，计划初稿把它
丢了。`JR-12345` 与 `local_20260901094133` 都满足新正则，保留不增加成本。
**设计文档 §3.4 已同步。**

**两个判定函数不做 `strip()`。** 计划没提。原测试还断言 `" JR-12345"`（带空格）会被
拒绝——这是对的，因为带空格是**不同的目录名**，而 `validate_work_item_id` 把关的正是
即将成为路径段的那个字符串。需要宽松匹配的调用方（`memory.search_memory`、
`workflow.looks_like_issue_key`）自己先 strip。**设计文档 §3.4 已同步。**

**错误信息措辞。** 为满足 R1（CLI 输出不变），`validate_work_item_id` 的信息以
"Invalid issue key or work item id..." 开头，保留了旧测试断言的 `Invalid issue key`
子串，同时把 local id 的例子加进去。没有改测试。

### 实施中发现的约束

- **`fetch` 不适用于 manual 输入**，但它不是「被跳过的能力」而是「不适用的步骤」。
  `InvestigationPlan.skipped_steps("manual")` 因此不把 `fetch` 算作 skipped——否则
  `workflow_status.json` 会把一个根本不存在的步骤标成 skipped，误导用户。
- **`keywords` 是 `code_search` 和 `similar_fixes` 的共同依赖**，`resolve_steps` 用集合
  去重保证只跑一次。关掉 `similar_fixes` 但留着 `code_search` 时 `keywords` 仍在
  resolved 里，不进 skipped。这条有测试固定。
- **`doctor` 不受 plan 控制**，永远运行（环境检查）。
- 步骤顺序由 `WORKFLOW_STEPS` 决定而非 capability 声明顺序，所以调用方无法通过
  重排 flag 改变流水线顺序。有测试固定。

### 留给下一步的接口

```python
from bugpilot.core.identity import is_jira_issue_key, is_work_item_id, new_local_work_item_id
from bugpilot.core.models import BugSpec, InvestigationOptions, InvestigationPlan, InvestigationRequest

request.work_item_id       # -> str，目录名
request.spec.can_write_back  # -> bool，Jira 回写闸门（§5.1 的 NO_JIRA_TARGET 判据）
request.resolved_steps()   # -> list[str]，按 WORKFLOW_STEPS 顺序
request.skipped_steps()    # -> list[str]，标 skipped 用
```

`InvestigationOptions.max_files` / `max_search_lines` 默认值等于 `search.py` 里现有的
`MAX_TOTAL_RELATED_FILES` / `MAX_TOTAL_CODE_SEARCH_LINES`，**但还没接线**——`search.py`
仍在用模块级常量。接线是阶段 1.3 的事。

### 未做

阶段 1 剩余部分，按建议顺序：

1. **1.2 输入 adapter** —— `JiraInputAdapter` / `ManualInputAdapter` 构造 `BugSpec`。
2. **1.3 workflow 接受 `InvestigationRequest`** —— 最重的一块，要动 25 个 step 函数的
   签名；`search.py` 的两个常量改读 `options`；`_mark_step` 用 `skipped_steps()` 标记。
3. **1.4 core stdout 清理** —— `copilot.py` 拆成 `collect_agent_status()` +
   `print_agent_status()`（照 `doctor.py` 的形状）。

`BugSpec` 目前**没有持久化**。`bugpilot list`（§5.1）需要从 `.ai/<work_item>/` 读回
title 和 source，所以 1.2 或 1.3 里要决定把 spec 写成 `.ai/<work_item>/bug_spec.json`。

---

## [阶段 1.2 + 1.4] 输入 adapter 与 core stdout 清理 — 2026-09-03

**对应计划**：§3.3 输入 adapter、§6 共享前置工作第 1/5 项、阶段 1 第 2/4 块
**测试**：290 passed（上一步 268 + 新增 22）

### 交付

| 文件 | 内容 |
| --- | --- |
| `bugpilot/core/input_adapters.py` | `bug_spec_from_jira` · `bug_spec_from_description` · `derive_title` · `save_bug_spec` / `load_bug_spec` · `spec_to_dict` / `spec_from_dict` |
| `tests/test_input_adapters.py` | 22 个测试 |
| `bugpilot/core/copilot.py` | 重写为 collect/render 两层 |
| `bugpilot/core/doctor.py` | 加 `doctor_report_lines()` |
| `bugpilot/cli.py` | 3 处改为在 CLI 层打印 |

**`BugSpec` 现在持久化到 `.ai/<work_item>/bug_spec.json`**（上一条日志留的待决点，按建议做了）。
理由不止 `bugpilot list`：manual 模式下 `notify` / `commit-plan` 的邮件正文没有
`jira_summary.md` 可读，§5.1 规定要降级用 `spec.title` / `spec.description`，
那份数据必须落盘才拿得到。

### 与计划的偏差

无。§3.3 定的 `BugSpec` 五字段原样实现。

### 实施中发现的约束

- **`bug_spec_from_jira` 收的是 `parse_issue` 的输出而非原始 issue dict。** 这样
  `input_adapters` 保持叶子模块（不 import `jira`），调用方本来就已经跑过
  `parse_issue`。代价是调用顺序有隐含要求，1.3 接线时要注意。
- **`load_bug_spec` 出错返回 `None` 而不是抛异常。** `bugpilot list` 要能在某个
  目录损坏时继续列出其余条目，不能因为一个坏文件整条命令失败。三种情况都返回
  `None`：文件不存在、JSON 解析失败、缺 `work_item_id`。
- **`spec_from_dict` 把空 `source_ref` 归一成 `None`。** 否则 `str("")` 会变成
  falsy 之外的东西、或 `str(None)` 变成 `"None"` 字符串，进而让
  `can_write_back` 误判为真——那会让一个 manual work item 通过 Jira 回写闸门。
  有测试固定这条。
- **JSON 用 `ensure_ascii=False` 写。** 中文标题要在文件里可读——这份产物和
  `.ai/` 下其余 Markdown 一样是给人看的。
- **`derive_title` 要剥 Markdown 标记**（`#`、`-`、`*`、`>`），因为粘贴来的 bug
  报告常以标题或列表开头，否则列表里会显示 `# Crash on open`。

### stdout 清理的实际结果

`grep -rn "print(" bugpilot/core/` 现在只剩 4 处，全部在**明确标注 deprecated 的
兼容 shim** 里（`copilot.print_copilot_check` / `print_auto_invocation_not_implemented`、
`doctor.print_doctor_report`）。CLI 已全部改用 `*_lines()` 版本，所以正常路径下
core 不再写 stdout，满足不变量 2。

输出保持逐字一致：`agent_status_lines` 和 `doctor_report_lines` 的字段顺序沿用
原来的 `print` 顺序（dict 保序），R1 未被破坏。

### 留给下一步的接口

```python
from bugpilot.core.input_adapters import (
    bug_spec_from_jira, bug_spec_from_description, save_bug_spec, load_bug_spec,
)
from bugpilot.core.copilot import collect_agent_status, agent_status_lines
from bugpilot.core.doctor import collect_doctor_report, doctor_report_lines
```

`load_bug_spec(repo_root, work_item_id)` 就是 `bugpilot list`（§5.1）和 manual 模式
邮件降级的数据源，1.3 之后即可直接用。

### 未做

- **1.3 workflow 接受 `InvestigationRequest`** —— 阶段 1 唯一剩下的一块，也是最重的：
  25 个 step 函数签名、`search.py` 的两个常量改读 `options`、`_mark_step` 用
  `skipped_steps()` 标记、`run_bug_workflow` 在准备开始时调 `save_bug_spec`。
- adapter 还**没有任何调用方**。`fetch_step` / `parse_step` 仍走旧路径，
  `bug_spec.json` 目前不会被任何命令写出来——1.3 接线后才生效。

---

## [阶段 1.3a] workflow 接受 InvestigationRequest — 2026-09-03

**对应计划**：阶段 1 第 3 块（前半）
**测试**：302 passed（上一步 290 + 新增 12）

### 交付

`workflow.py` 新增：

| 函数 | 作用 |
| --- | --- |
| `run_investigation(repo_root, request, ...)` | 实现主体，按 `request.plan` 决定跑哪些 step |
| `run_bug_workflow(...)` | 变成薄包装：构造 Jira request 后委派。**签名与行为完全不变** |
| `jira_request(issue_key, options=None)` | 构造 Jira 的 `InvestigationRequest` |
| `_parsed_issue(repo_root, work_item_id)` | 统一取数：Jira 读 `jira.json`，manual 从 spec 在内存里构造 |
| `_persist_resolved_spec(...)` | `parse_step` 之后用真实 title 重写 spec |

`input_adapters.manual_issue_payload(spec)` 新增；`tests/test_investigation.py` 12 个测试。

**manual bug 现在端到端可跑**：`run_investigation` 收一个 manual `BugSpec`，
不碰 Jira，生成 `bug_context.md` / `agent_task.md` 等全套产物。

### 与计划的偏差

**没有改 25 个 step 函数的签名。** 计划（阶段 1 第 3 项）预期要动所有 step 签名，
实际只需要一个 `_parsed_issue` 助手：四个读 `jira.json` 的 step
（`parse` / `keywords` / `context` / `memory_add`）改为调它，其余 step 本来就不碰 Jira。
step 签名保持 `(repo_root, issue_key)` 不变，所有既有调用方和测试零改动。

代价是**隐含依赖**：manual 模式下 `_parsed_issue` 要能读到 `bug_spec.json`，
所以 `run_investigation` 必须在任何 step 之前 `save_bug_spec`。这条写在代码注释里了。

### 实施中发现的约束

- **不为 manual 写假的 `jira.json`。** manual payload 只在内存里构造给 `parse_issue`，
  这样 `jira.json` 永远是真实抓取的数据，读者可以信任它。代价是多一个间接层。
- **`adf_to_markdown` 对纯字符串是透传的**（实测确认），所以手写描述不需要包成 ADF。
- **`workflow_status.json` 表达不了「不适用」与「被跳过的能力」的区别。**
  `_write_status` 把全部 24 个 `WORKFLOW_STEPS` 都写出来，缺席的一律填 `"skipped"`。
  所以 manual 模式下 `fetch: skipped` 只是「未运行」的通用渲染，和
  `commit_plan: skipped` 同性质。模型层的区分（`InvestigationPlan.skipped_steps`
  对 manual 不含 `fetch`）**不会传导到这个产物里**。
  **这条影响 §5.3 的扩展进度 checklist** —— 界面若想区分「跳过」和「不适用」，
  需要另找数据源（如 `bug_spec.json` 的 `source`），不能只读 status 文件。
  有测试固定当前行为并写明了原因。
- **Jira 的 title 要等到 `parse_step` 之后才知道**，所以 `jira_request()` 先建一个
  title 为空的 stub spec，`parse_step` 跑完再用 `_persist_resolved_spec` 重写。
- **spec 落盘失败不能中断准备流程**：`_persist_resolved_spec` 吞异常只记 `[WARN]`。
  它是给后续命令用的便利数据，不是任何 step 的输入（manual 的那份在更早写入）。

### 留给下一步的接口

```python
from bugpilot.core.workflow import run_investigation, jira_request

run_investigation(repo_root, request, agent_fix=..., fresh=..., allow_mock=...,
                  progress=..., hint=..., jira_comment=...) -> WorkflowResult
```

`progress` 回调仍在 10 个步骤点调用，是阶段 2 `--json-lines` 的挂点。
被 plan 关掉的 step 不会触发 `progress`，所以事件流天然只报实际运行的步骤。

### 未做

- **1.3b：`search.py` 读 options。** `MAX_TOTAL_RELATED_FILES` /
  `MAX_TOTAL_CODE_SEARCH_LINES` 仍是模块级常量，用在 4 处（`search.py:174, 324,
  526, 533`），分散在 `_related_files`、排序函数和 `_render_markdown` 里。
  需要给 `run_code_search` 和这三个辅助函数加参数，并从 `run_investigation`
  经 `code_search_step` 透传 `request.options`。
  `InvestigationOptions.max_files` / `max_search_lines` 目前**只是被携带，未生效**。
- `options.hint` / `focus_files` / `ignore_paths` 同样尚未接线（`hint` 目前仍走
  `run_investigation` 的独立 `hint=` 参数和 `developer_hint.md`）。

---

## [阶段 1 review 修复] — 2026-09-03

**触发**：对 `6e3d7e1..ae9c632` 做代码 review，10 项发现全部属实（严重的三项本地复现过）。
**测试**：332 passed（上一步 302 + 新增 30）

### 修了什么

**P0 —— 我在 1.1 引入的用户可见回归。** `memory search utf-8` 会创建 `.ai/utf-8/`
目录并跳过自由文本评分。`utf-8` / `log4j-2` / `python-3` / `opengl-4` 全部满足
`is_work_item_id`。

根因是**一个谓词服务了两个语义**。§3.4 的全部意义是把「是不是 Jira key」和
「是不是安全目录名」分开，但 `memory search` 需要的是**第三个问题**：
「用户输入的是 id 还是搜索词」。我用 `is_work_item_id` 回答了它——那是错的问题，
因为它必须宽松到接受任何我们可能创建的 id，所以天然不适合做分类器。

现在三个谓词各答一问：

| 谓词 | 问题 | 用在 |
| --- | --- | --- |
| `is_jira_issue_key` | 能否回写 Jira？ | `bug_spec_from_jira` 的闸门 |
| `is_work_item_id` | 能否作目录名？ | `validate_work_item_id` / cleanup containment |
| `is_known_work_item_id` | 用户输入的是 id 吗？ | `memory search`、`cli.py` |

**P1 —— 部分 plan 会崩溃。** `CAPABILITY_STEPS` 只记了「能力跑哪些 step」，
没记「step 需要哪些前置产物」。新增 `STEP_PREREQUISITES` 与传递闭包
`_close_over_prerequisites`：

- `context` → `keywords`, `parse`（`context_step` 总是读 `extracted_keywords.json`）
- `keywords` → `parse` → `fetch`（Jira 源；manual 过滤掉 `fetch`）

**前置步骤即使其所属能力被关掉也会被拉进来。** 跑前置严格优于中途崩溃，
这正是设计文档说的「core 负责解析依赖」——调用方拨的是能力，不是步骤。

`_remove_intermediate_files` 移进 `"context" in resolved` guard：没有 fold 就不能删
`memory_search.md` / `git_context.md`，它们是那种 plan 下唯一的产物。

**P2/P3**：`_issue_summary` 对 manual 读 spec（否则分支名退化成 `-jira-workflow`）；
`bug_spec_from_description(repo_root=...)` 可选去重（同秒两个 bug 会互删产物）；
`bug_spec_from_jira` 用 `is_jira_issue_key` 把关；`load_bug_spec` 补捕
`UnicodeDecodeError`；`options.hint` 接线（原先静默丢弃）。

### 这轮最该记住的教训

**12 个测试全绿，却漏掉了 7 个真实缺陷。** 原因是它们只验证了 `resolve_steps` 的
**集合运算**，没有一个真的关掉某个能力**跑一遍完整流程**。

现在补了参数化测试：五个能力逐个关闭，manual 与 Jira 两条源各跑一遍完整
`run_investigation`。这类「真的执行一遍」的测试是 plan 契约的最低保障，
1.3b 以及后续任何改 `CAPABILITY_STEPS` / `STEP_PREREQUISITES` 的改动都必须保持它们绿。

### 与计划的偏差

设计文档 §3.3 只描述了 `CAPABILITY_STEPS` 一张表。实际需要**两张**：
能力→贡献的步骤，以及步骤→依赖的步骤。**设计文档尚未同步**，1.3b 时补。

### 未做

1.3b 未动（`search.py` 仍用模块级常量；`options.max_files` / `max_search_lines` /
`focus_files` / `ignore_paths` 仍未生效）。

---

## [阶段 1.3b] search.py 读 InvestigationOptions — 2026-09-03

**对应计划**：§3.3 `InvestigationOptions`、阶段 1 最后一块
**测试**：348 passed（上一步 332 + 新增 16）

### 交付

`InvestigationOptions` 的四个字段全部生效，链路打通：

```
run_investigation → code_search_step(repo_root, issue_key, request.options)
                  → run_code_search(..., options)
```

| 字段 | 生效方式 |
| --- | --- |
| `max_files` | `_rank_related_files(max_files=)`，默认仍为 `MAX_TOTAL_RELATED_FILES` |
| `max_search_lines` | `_render_markdown(max_search_lines=)`，控制 Matched Lines 段的行预算 |
| `ignore_paths` | 排序前过滤掉命中，被忽略的文件不进任何视图 |
| `focus_files` | `_apply_focus_bonus` 加 `FOCUS_FILE_BONUS = 25` 分 |

新增 `tests/test_search_options.py`（15 个）+ 一个端到端 `ignore_paths` 测试。

### 与计划的偏差

**`focus_files` 做成加分而不是过滤。** 计划只写了字段名没定语义。选加分的理由：
过滤会把「猜错的 focus」变成「空搜索结果」，用户拿不到任何信号说明猜错了；
加分则只重排不隐藏。25 分足以压过关键词证据（phrase 12 / qualified 10 / high 6），
因为显式的 `--focus-file` 比任何自动排序启发式都更强。**设计文档尚未同步这条语义。**

### 实施中发现的约束

- **`MAX_TOTAL_RELATED_FILES` 原先被切了三次**：`_rank_related_files` 尾部截断后，
  `_related_files` 和 `_render_markdown` 又各自 `[:MAX_TOTAL_RELATED_FILES]` 重切
  一遍（对已截断的列表是 no-op）。删掉后两处，让**文件上限只有一个施加点** ——
  否则 `max_files` 会出现「一个视图里生效、另一个视图里忽略」的可能。
- **路径匹配必须做分隔符归一**：`rg` 输出正斜杠，而 Windows 用户会传
  `src\reader`。`_matches_any_path` 统一转正斜杠、小写、去 `./` 前缀和尾部 `/`。
  前缀匹配在路径边界处停止（`src/reader` 不匹配 `src/readerx/`）。
- **写测试时踩了 `\r` 的坑**：`"src\reader"` 在普通字符串里 `\r` 是回车，
  测试假失败。路径相关的测试字符串必须用 raw string。

### 留给下一步的接口

```python
run_code_search(repo_root, issue_key, keywords, options)   # options 可为 None
code_search_step(repo_root, issue_key, options=None)
```

阶段 2 加 `--max-files` / `--max-search-lines` / `--focus-file` / `--ignore-path`
时，只需在 CLI 构造 `InvestigationOptions` 传进 `run_investigation`，core 侧无需改动。

### 阶段 1 收尾状态

七块全部完成：领域模型、work item identity、输入 adapter、core stdout 清理、
workflow 接 request、review 十项修复、options 接线。

设计文档 §3.3 已补上 `STEP_PREREQUISITES` 第二张依赖表（review 时记的未同步项）。
唯一仍未同步的是 `focus_files` 的加分语义。

**阶段 1 验收对照**（计划 §9）：

1. 同一 workflow 可分别用 Jira issue 与纯 description 运行 —— 有测试。
2. 本地 id `local_<YYYYMMDDHHMMSS>`，`is_jira_issue_key` 对它为 False —— 有测试。
3. 全仓单一 Jira key 判定 + 单一 work item id 判定 —— 达成，且额外拆出
   `is_known_work_item_id` 回答第三个问题（见 review 修复条目）。
4. plan 关闭某项时对应 step 标 `skipped` 而非 `fail`，依赖自动补齐且只跑一次
   —— 有测试，并补了「每个能力逐个关闭真的跑一遍」的参数化测试。

下一步是**阶段 2 CLI Machine API**（`--json` / `--json-lines` / `bugpilot list` /
manual 输入参数 / 续接闭环）。

---

## [阶段 2.1] JSON 信封与错误码契约 — 2026-09-03

**对应计划**：§5.1 `--json`、阶段 2 前两项
**测试**：377 passed（阶段 1 收尾 348 + 新增 29）

### 交付

| 文件 | 内容 |
| --- | --- |
| `bugpilot/core/errors.py` | 稳定错误码常量 + `error_code_for(exc)` / `code_for_jira_error_type()` |
| `bugpilot/cli_json.py` | `success()` / `failure()` / `emit()` / `emit_failure()`，`SCHEMA_VERSION = 1` |
| `tests/test_cli_json.py` | 29 个测试 |

已接 `--json` 的命令（**只读的四个**）：`doctor` · `status` · `check-results` ·
`delivery-check`。

### 设计决定

- **`errors.py` 放 core，`cli_json.py` 放 CLI 层。** 错误码是三个入口共享的**契约**
  （MCP 之后也要用同一套词汇），而信封渲染是 adapter 的职责（不变量 3）。
- **错误码复用 `jira.ERROR_MESSAGES` 的 8 个既有键。** 那套分类已经稳定，映射是
  改名而非二次分类。有测试断言「除 `unknown_error` 外每个键都有专属码」——
  将来新增键若忘了映射会被测出来。
- **一个码说「出了什么错」，不说「在做什么」。** 命令名由 `command` 字段单独报告，
  所以 fetch 失败和 comment 失败共用 `JIRA_AUTH_FAILED`，不需要按操作各来一套码。
- **`error_code_for` 里的 import 是函数内的。** `errors.py` 要保持叶子；顶层
  import `jira` 会把网络栈拖进任何只想引用码名的模块。

### 实施中发现的约束

- **失败时 stdout 和 stderr 都要写。** `emit_failure` 同时输出 JSON 信封和
  `ERROR: ...` 到 stderr，退出码仍非零。三个通道是**叠加**不是互斥的 ——
  忽略 JSON 只看退出码的消费者必须照样看到失败。有测试固定。
- **`check-results` 的 `missing` 是仓库相对路径**（`.ai/JR-12345/fix_summary.md`），
  不是裸文件名。我的测试一开始断言错了。
- **`--json` 模式下 stdout 必须只有一个 JSON 对象。** 加了参数化测试对四个命令
  逐一 `json.loads` 整个 stdout —— 任何多余的 `print` 都会让它失败。
  这条是扩展能正常解析的前提。

### 留给下一步的接口

```python
from bugpilot import cli_json
from bugpilot.core import errors

cli_json.emit(cli_json.success("bug", work_item_id=..., issue_dir=..., generated_files=[...]))
cli_json.emit_failure("bug", errors.error_code_for(exc), str(exc), work_item_id=...)
```

`_add_json_flag(parser)` 给任意子命令加 `--json`（`dest="json_output"`）。

### 未做

阶段 2 剩余：

1. **2.2** —— 另外 5 个命令的 `--json`（`bug` / `fetch` / `search` / `context` /
   `summarize-results`）；manual 输入参数（`--description` / `--description-file`）；
   Options 与 Plan 参数；`bugpilot list`。
2. **2.3** —— `--json-lines` 事件流。
3. **2.4** —— manual 模式下 Jira 命令行为表（§5.1）。
4. **2.5** —— 续接闭环（§5.6 `bug --retry`）。

---

## [阶段 2.2] `bug` 命令接 manual 输入、Options、Plan 与 `--json` — 2026-09-03

**对应计划**：§5.1 `bug` 主入口、阶段 2 第 4/5 项
**测试**：389 passed（上一步 377 + 新增 12）

### 交付

`bugpilot bug` 现在三种输入等价可用：

```text
bugpilot bug JR-12345
bugpilot bug --description "3D view crashes after changing horizon"
bugpilot bug --description-file bug.txt
```

新参数：`--title` · `--keywords` · `--focus-file` · `--ignore-path` ·
`--max-files` · `--max-search-lines`（Options）；`--skip-code-search` ·
`--skip-git-history` · `--skip-similar-fixes` · `--only-issue-details`（Plan）；
`--json`。

CLI 侧新增 `_build_bug_request(repo_root, args)`，是三组参数汇聚成
`InvestigationRequest` 的唯一入口。`bug` 处理器改调 `run_investigation`。

### 实施中发现的约束

- **`issue_key` 改成 `nargs="?"`，二选一的校验放在 `_build_bug_request` 里手写。**
  argparse 的 mutually-exclusive group 对「位置参数 vs 选项」这种组合措辞很差，
  手写能给出可操作的提示（两种用法都举例）。
- **进度编号必须按实际会跑的步骤算。** 原来硬编码 `[N/9]`；manual 少了 `fetch`，
  部分 plan 更少。数到一个永远不会到达的总数，读起来像卡住了。现在从
  `resolved_steps` 推导，**默认 Jira 路径仍是 `[1/9]`–`[9/9]` 逐字不变**。
- **踩到一次 R1**：我把 `"Parsing Jira details..."` 改成 `"Parsing bug details..."`，
  既有测试 `test_bug_command_prints_progress_and_key_artifacts` 立刻失败。
  改成按 `source` 区分：Jira 保持原文案，manual 用新文案。既有测试未改。
- **`--json` 模式下不传 `progress`。** 进度是人类文案，走 stdout 会破坏
  「stdout 只有一个 JSON 对象」的契约。JSONL 事件流是 2.3 的事。
- **`bug_spec_from_description` 传了 `repo_root`**，启用同秒 id 去重（阶段 1
  review 修的那条）。CLI 是第一个真实用到它的调用方。

### 已知瑕疵（未修）

**manual 模式下仍会生成 `jira_parsed.md`。** 手写 bug 的产物目录里出现一个
Jira 命名的文件，读起来别扭。没改的原因：产物名是 §6 的对外契约，
`prompts.py` / `context.py` / 文档的产物表都引用它，改名要一起动且会破坏
既有 `.ai/` 目录的可读性。记在这里，等阶段 7 迁移清理时统一考虑。

### 留给下一步的接口

```python
_build_bug_request(repo_root, args) -> InvestigationRequest   # cli.py
_bug_progress_printer(work_item_id, resolved_steps, source)   # cli.py
```

2.3 的 `--json-lines` 可以直接复用 `_build_bug_request`，把 `progress` 换成
JSONL 发射器即可 —— `run_investigation` 的 `progress` 回调只在实际运行的步骤触发。

### 未做

- **2.3** `--json-lines` 事件流。
- **2.4** 另外 4 个命令的 `--json`（`fetch` / `search` / `context` /
  `summarize-results`）+ `bugpilot list`。
- **2.5** manual 模式下 Jira 命令行为表（§5.1）。
- **2.6** 续接闭环（§5.6 `bug --retry`）。

---

## [阶段 2.3 – 2.6] JSONL 事件流、list、Jira 闸门、续接闭环 — 2026-09-03

**对应计划**：§5.1 `--json-lines` / `bugpilot list` / manual 模式 Jira 行为表、§5.6 续接
**测试**：413 passed（上一步 389 + 新增 24）

### 交付

**2.3 `--json-lines`** —— `cli_json.JsonLinesEmitter`。事件：`started` · `phase` ·
`step_skipped` · `step_started` · `step_completed` · `artifact` · `completed`。

**2.4** —— `fetch` / `search` / `context` / `summarize-results` 加 `--json`；
新增 `bugpilot list`（`--json` 与人类两种输出）。

**2.5** —— `_refuse_for_manual` / `_refuse_without_jira_target` 两个闸门，
覆盖 `fetch` · `jira-validate`（`JIRA_ONLY_COMMAND`）与 `jira-comment-draft` ·
`jira-comment` · `summarize-results --jira-comment`（`NO_JIRA_TARGET`）。

**2.6** —— `bug <ID> --retry` 把三步手工操作合成一条；`check-results` 与
`delivery-check` 失败时打印 `bugpilot bug <ID> --retry`。

### 实施中发现的约束

- **`step_completed` 只能推断。** `run_investigation` 的 `progress` 回调在每步
  **开始前**触发，没有结束钩子。发射器用「下一个 `step_started` 关闭上一个，
  `finish()` 关闭最后一个」推断。好处是**抛异常的步骤永远不会被关闭** ——
  这正好成为消费者区分「崩了」和「跑完了」的信号。有测试断言
  `started == completed`。
- **`parse` 不是 Jira-only。** 它对两种源都成立（manual 从 spec 构造 payload），
  只有 `fetch` / `jira-validate` 才是。代码里加了注释说明，免得后来者顺手也给它
  加闸门。
- **`--retry` 需要不同的交接语。** `agent_runner.build_agent_command` / `run_agent`
  加了可选 `prompt` 参数，新增 `RETRY_HANDOFF_PROMPT`。有测试断言 agent 拿到的是
  retry prompt 而不是原始 `agent_task.md`。
- **两个测试桩的签名要跟着改。** `tests/test_workflow.py` 的 `stub_agent_launch`
  和 `tests/test_agent_runner.py` 的 `_spy_run_agent` 都硬编码了
  `run_agent` 的签名，加参数后 17 个测试一起红。这是测试桩耦合生产签名的
  常见代价，改桩不改生产代码。
- **`list` 对缺 spec 的目录降级而非报错**，返回 `source: null` / `prepared: false`。
  有测试用一个空目录固定这条。

### 留给下一步的接口

```python
cli_json.JsonLinesEmitter(work_item_id, source)  # .skipped() .progress() .finish() .fail()
_refuse_for_manual(repo_root, command, work_item_id, json_output) -> int | None
_refuse_without_jira_target(...) -> int | None
_list_work_items(repo_root, json_output) -> int
```

阶段 3 的 MCP 工具可直接复用两个闸门的判据（`spec.source` / `spec.can_write_back`），
但**不应复用这两个函数本身** —— 它们输出 CLI 文案，MCP 该抛结构化错误。

### 未做

- `notify` / `commit-plan` 的邮件正文在 manual 模式下仍读 `jira_summary.md`
  （§5.1 要求降级用 `spec.title` / `description`）。**这是阶段 2 唯一未完成项。**
- `--retry --same-session`（§5.6 的折中选项）未实现，待决问题 5 未定。

---

## [阶段 2 review 修复] — 2026-09-03

**触发**：对 `5bf37d5..HEAD` 做代码 review，11 项发现全部属实（严重的四项本地复现）。
**测试**：426 passed（上一步 413 + 新增 13）

### P0 —— 安全边界与契约

**1. `BUGPILOT_AUTO_JIRA_COMMENT=1` 绕过了 `NO_JIRA_TARGET` 闸门。** 我只在
`args.jira_comment` 为真时检查，环境变量那条路径直接跳过——手写 work item
会真的往 Jira 发评论。**这是 R5（对外动作必须显式）的破口**，也是这轮最严重的一条。
现在闸门覆盖 `_auto_jira_comment_enabled(args)` 的完整判据。

**教训**：加闸门时要问「所有到达这个动作的路径都过闸了吗」，而不是「我检查的那个
参数对吗」。这里有两条路径，我只守了一条。

**2. `--json` 在自动评论之前 `return`**，导致 `--jira-comment --json` 静默不发评论。
重排成「先执行动作、后输出信封」。

**3. `search --json` / `context --json` 让异常逃逸**：traceback 进 stderr，
stdout 一个字节都没有——彻底破坏「无论成败 stdout 恰好一个 JSON 对象」的契约。
更讽刺的是，我在 2.1 建的 `errors.error_code_for` **在生产代码里一个调用方都没有**，
只有测试在用。

现在 `main()` 拆成解析 + `_dispatch()`，机器模式下整体包一层 try/except，
用 `error_code_for` 分类后输出信封或关闭流。

**4. `--json-lines` 的前置失败什么都不输出。** 消费者等一个终止事件，等不到就
和「还在跑」无法区分。新增 `cli_json.emit_stream_failure`。

### P1 —— 行为不正确

- **`bug --json` 对 Jira item 永远报 `title: null`。** `request.spec` 是抓取前的
  stub，而 `BugSpec` 是 frozen，`_persist_resolved_spec` 改不了它。改成输出信封前
  `load_bug_spec` 重读。
- **`--only-issue-details` 跳过 `prompt` 步骤，但信封仍声称有 `agent_task`，
  且不带 `--prepare-only` 时会拉起 agent 指向不存在的文件。** 现在按文件是否真的
  生成来报告，没有就明确告知并停下。
- **`--retry` 第一次运行会创建占位 `user_feedback.md` 然后立刻拉起 agent** ——
  交给 agent 的是模板占位符，而开发者的反馈正是这个循环唯一存在的理由。
  现在首次生成后停下，提示填写后再运行。

### P2 —— 参数问题

- `--keywords` 是**彻底的 no-op**（写进 options，无人读取）。接进 `keywords_step`，
  排在 `high_value_keywords` 最前。
- `bug --description ... --jira-comment` 未拦截：manual item 会拿到 Jira 评论指令，
  而后续 `jira-comment` 又会拒绝。现在在 `_build_bug_request` 里拒绝。
- `--max-files 0` 清空结果、负数从尾部切片，都无声。现在拒绝 < 1。
- `--json` 隐式等于 `--prepare-only`，帮助文本没说。补了「Never launches an agent」。

### 这轮的共同模式

11 项里有 6 项属于**「新增的分支绕过了既有保障」**：环境变量绕过闸门、
JSON 分支绕过动作、机器模式绕过异常处理、跳过步骤后仍声称产物存在。
给一个命令加第二条输出路径时，必须逐条核对第一条路径上的每个保障在新路径上
是否仍然成立。

---

## [阶段 3] MCP 完整入口 — 2026-09-04

**对应计划**：§5.2、阶段 3
**测试**：451 passed（阶段 2 收尾 429 + 新增 22）

### 交付

| 文件 | 内容 |
| --- | --- |
| `bugpilot/mcp_server.py` | 7 个工具 + `fix_bug` prompt + repo 绑定 + 结果脱敏 |
| `bugpilot/core/workflow.py` | 新增 `refine_investigation()` |
| `pyproject.toml` | `[mcp]` optional extra、`bugpilot-mcp` 入口点 |
| `docs/mcp_setup.md` | 客户端配置、工具表、不暴露清单、`CLAUDE.md` 片段、排障 |
| `tests/test_mcp_server.py` | 22 个测试 |

### 与计划的重大偏差：SDK 是 mcp 2.x，`FastMCP` 已改名

设计文档 §5.2 写的是 `FastMCP`（v1 API）。实际装到的是 **mcp 2.1.1**，
`FastMCP` 已改名 `MCPServer`（`from mcp.server.mcpserver import MCPServer`），
且字段从 camelCase 改成 snake_case（`inputSchema` → `input_schema`）。

选择用 2.x 而不是 `pin mcp<2`：为了对齐一份文档而钉住一个已被取代的大版本，
代价更大。**设计文档尚未同步。**

### 实施中发现的约束

- **必须抛 SDK 自己的 `ToolError`。** 我最初定义了同名的本地异常类——SDK 不认，
  于是被当成崩溃包成 `UnexpectedToolError`，模型只看到
  `Error executing tool <name>`，**我精心写的可操作提示全部丢失**。
  改成 `from mcp.server.mcpserver.exceptions import ToolError`。
  测试里专门断言 `not isinstance(exc, UnexpectedToolError)`，
  避免以后又退化成崩溃路径。
- **`call_tool()` 对预期失败是「抛」而不是「返回 `is_error=True`」**（进程内 API；
  协议层才返回结果）。测试助手因此用 `pytest.raises(ToolError)`。
- **`refine_investigation` 不能走 `run_investigation`。** 后者的前置闭包会把
  `fetch` 拉回来（`parse` 依赖它），导致每次 refine 都重新抓 Jira——慢，且离线不可用。
  实现成 core 里独立的 step 序列，从 `keywords` 起跑，复用磁盘上已有的 issue 数据。
  有测试 monkeypatch `fetch_issue` 使其抛异常来固定这条。
- **`search_memory` 既是工具名也是 core 函数名。** 装饰后的局部函数会遮蔽模块级
  导入，所以导入时就取别名 `search_memory as search_memory_impl`。

### 阶段 2 教训的应用

阶段 2 的教训是「新增的输出路径会绕过既有保障」。MCP 正是又一条新路径，
所以这轮专门加了**守护性测试**而不是只测正常路径：

- `test_no_outward_or_destructive_tool_is_exposed` —— 拿一个禁止清单去交集，
  将来手滑加了 `commit` 工具会立刻红。
- `test_no_tool_takes_a_repo_root` —— 遍历所有工具的 input schema，
  防止哪天有人给工具加个 `repo_root` 参数。
- `test_summarize_results_never_posts_to_jira` —— monkeypatch `post_jira_comment`
  使其抛异常，确认 MCP 路径不触达它。
- `test_summarize_takes_no_jira_comment_argument` —— schema 里就不该有那个参数。
- `test_search_memory_does_not_treat_a_search_term_as_a_work_item` —— 阶段 1 的
  回归，从这条新入口再验一次。

### 留给下一步的接口

```python
from bugpilot.mcp_server import build_server, resolve_repo_root
build_server(repo_root=None) -> MCPServer      # repo_root=None 时走 env / cwd
workflow.refine_investigation(repo_root, work_item_id, options=None, plan=None, progress=None)
```

`refine_investigation` 目前只有 MCP 在用；阶段 4/5 若要在扩展里做「按新线索重查」，
直接调它即可（CLI 尚未暴露对应子命令）。

### 未做

- 设计文档 §5.2 仍写 `FastMCP`，需同步为 `MCPServer`。
- CLI 没有 `refine` 子命令（MCP 独有）。
- 未在真实 Claude Code 客户端里做过端到端连通测试（阶段 0A 的假设验证）。

---

## [阶段 4.1] 扩展骨架 + 协议消费 + 错误映射 — 2026-09-04

**对应计划**：阶段 4 第 3/6 项（JSON/JSONL client、`error.code` → 提示映射）
**测试**：Python 483 + TypeScript 26

### 交付

```text
extension/
  package.json        typecheck / test 脚本，devDep 仅 typescript + @types/node
  tsconfig.json       strict + noUncheckedIndexedAccess + erasableSyntaxOnly
  src/protocol.ts     parseEnvelope · EventStreamReader · ProtocolError
  src/errors.ts       diagnose(code, message) → summary/action/retryable
  test/*.test.ts      26 个测试
```

### 工具链决定：不引入测试框架

Node 24 能直接跑 `.ts`（类型剥离）且 `node --test` 支持 `.ts` 文件，所以
**不需要 ts-node / tsx / jest / vitest**。devDependencies 只有 `typescript`
（做 `tsc --noEmit`）和 `@types/node`。

代价是一条硬约束（见下）。收益是依赖面极小，和 Python 侧「零运行时依赖」一致。

### 实施中发现的约束

- **类型剥离模式不支持会生成代码的 TS 语法。** `constructor(readonly stdout: string)`
  这种参数属性直接运行时报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。enum、namespace、
  decorator 同理。已在 tsconfig 打开 **`erasableSyntaxOnly`**，让 `tsc` 在类型检查
  阶段就拦住，而不是留到运行时。
- **`node --test test/` 不会发现 `.ts` 文件**，必须给 glob：
  `node --test "test/*.test.ts"`。
- **JSONL 必须做跨 chunk 缓冲。** 子进程的 stdout 按任意边界分块，一行事件经常被
  切成两次 `push`。逐块独立解析会随机丢事件，看起来像 CLI 不稳定。
  `EventStreamReader` 缓冲尾部，有测试把一行对半切开验证。

### 设计决定

- **不 import `vscode`。** 这两个模块是纯逻辑，用普通 node 就能测——和 Python 侧
  `core` / `cli` 的分层同理。碰 vscode 的部分（workspace、SecretStorage）在 4.2
  用窄接口注入。
- **协议客户端强制契约而非假设它成立。** stdout 有杂物、缺 `schema_version`、
  失败信封没有 `error.code`、流没有终止事件——一律报明确错误。
  违约应该表现为一条清晰的错误，而不是三层之外的一个 undefined。
- **未来版本拒绝而非猜测。** `schema_version` 比本客户端新时直接报
  「请升级扩展」。新版 CLI 可能移动了本客户端要读的字段，自信地读错比明确拒绝更糟。
- **未知错误码回退到 CLI 自己的消息。** 错误码在 CLI 侧是 append-only，
  这张表必然会落后于新版 bugpilot。少一点帮助可以接受，**丢掉唯一的解释不行**。

### 最值钱的一条测试：跨语言守护

`test/errors.test.ts` 直接读 `bugpilot/core/errors.py` 的源码，提取全部错误码常量，
断言每一个在扩展的表里都有条目；反方向也测（表里没有 CLI 不存在的码）。

**往 Python 加一个错误码而不告知扩展，这条会立刻变红**，而不是等到用户看到
一句 fallback 消息。用读源码而非 import 的方式实现，测试不需要 Python 解释器。

这是阶段 2/3 教训（新增输出路径会绕过既有保障）在跨语言边界上的应用。

### 留给下一步的接口

```typescript
import { parseEnvelope, EventStreamReader, ProtocolError, SCHEMA_VERSION } from "./protocol.ts";
import { diagnose, knownCodes } from "./errors.ts";
```

### 未做（阶段 4 剩余）

- **4.2**：`executable.ts`（发现/选择/握手）、`runner.ts`（spawn/kill）、
  `workspace.ts`、`secrets.ts` —— 后两个用窄接口注入，不 import `vscode`。

---

## [阶段 4.2] executable / runner / workspace / secrets — 2026-09-04

**对应计划**：阶段 4 其余四项
**测试**：Python 483 + TypeScript 64（4.1 的 26 + 新增 38），`tsc --noEmit` 干净

### 交付

| 文件 | 内容 |
| --- | --- |
| `src/runner.ts` | `Runner.run` / `runJson` / `runStreaming`，取消与进程树 kill |
| `src/executable.ts` | `discoverExecutable` 三态裁决 + `describeVerdict` |
| `src/workspace.ts` | `chooseRepoRoot` 三态选择 + `isWithin` 容纳检查 |
| `src/secrets.ts` | `CredentialStore` + `assertNoSecretsInArgs` |

四个模块**都不 import `vscode`**：`SecretStorage` 和 workspace folders 以窄接口注入，
取消用标准 `AbortSignal`。所以全部能用普通 node 测。

### 两处必须做对的地方

**1. kill 必须杀进程树。** bugpilot 会派生 `rg` 和 `git`。Windows 上
`child.kill()` 只给直接子进程发信号，**开发者按了 Stop 之后 ripgrep 还在扫大仓库**。
实现：POSIX 用 `detached: true` 建进程组 + 负 pid 发 SIGTERM；Windows 用
`taskkill /pid <pid> /T /F`（`/T` 走树，`/F` 因为控制台子进程不理会礼貌请求）。
两条路径各有测试。

**2. 凭据只走环境变量，不进 argv。** 命令行对机器上任何进程列表都可见。
`CredentialStore.environment()` 是唯一会产出 token 的出口，且直接返回可用于 spawn
的环境块——没有顺手把它打进日志的便利路径。`status()` 供 UI 查询，**结构上无法泄漏
token**。另加 `assertNoSecretsInArgs` 作为 spawn 前的断言：token 若出现在 argv 里
直接抛错，宁可失败也不发布。

### 实施中发现的约束

- **`Thenable` 是 VS Code 的全局类型**，而我刻意不依赖 `@types/vscode`。改用标准库的
  `PromiseLike`——同样的结构，真实 `SecretStorage` 结构性满足它。
- **argparse 的 stderr 第一行信息量最低。** 旧版 bugpilot 遇到 `--json` 会先打
  usage 横幅、最后才是 `error: unrecognized arguments`。`firstLine` 选到了没用的那行，
  改成 `bestLine`：优先含 "error" 的行。测试先红后绿。

### 设计决定

- **握手用 `doctor --json` 而非存在性检查。** 「在 PATH 上」不等于「可用」——
  §3.2 记录了这台机器上同时存在 pipx 副本、editable 安装和 exe 的事实，旧版根本
  不认 `--json`。`doctor` 不需要 work item、不联网，且只有实现了阶段 2 信封才会成功。
- **三态裁决而非布尔。** `ready` / `not-found` / `incompatible` 分开，因为
  「装一个 bugpilot」对一个已经装了旧版的人是**错的建议**。
- **配置的路径即使坏了也不回退。** 静默换用另一个 bugpilot 会让故障无法诊断。
- **多个 git 目录是 ambiguous 而非取第一个。** 猜测会把 `.ai/` 写进恰好先被添加的
  那个目录。但**单个非 git 目录仍可用**——bugpilot 没有 git 也能降级运行（只是没有
  git context），拒绝运行比少点信息更糟。
- **失败信封 + 非零退出码是正常结果，不抛异常。** CLI 是故意两者都做的，调用方要
  的是 `error.code`。只有违反契约的输出才抛。

### 留给下一步的接口

```typescript
new Runner(executable, spawn?, platform?).run/runJson/runStreaming(args, options, onEvent?)
discoverExecutable({ cwd, configured?, spawn?, timeoutMs? }) -> Verdict
describeVerdict(verdict) -> { summary, action }
chooseRepoRoot(folders, probe) -> RepoChoice
isWithin(root, candidate) -> boolean
new CredentialStore(secretStore).save/clear/status/environment()
assertNoSecretsInArgs(args, environment)
```

阶段 5 的 activation 层负责把真实的 `vscode.workspace.workspaceFolders`、
`context.secrets`、`workspace.getConfiguration("bugpilot")` 接到这些接口上。
**那一层是唯一该 import `vscode` 的地方。**

### 未做

- 没有 `extension.ts` activation 入口、没有 `package.json` 的 `contributes`
  —— 阶段 4 按计划是 UI-free 的基础设施。
- 没在真实 VS Code 里加载过（阶段 5 才有可加载的扩展）。


## 阶段 4 review（9 项 + 1 项由修复本身引出）

**结论**：全部修完。TypeScript 64 → 82 tests，Python 483 保持不变，`tsc --noEmit` 通过。

三条最严重的都先复现再修，没有一条是「看代码觉得不对」：

| # | 问题 | 后果 | 修法 |
| --- | --- | --- | --- |
| 1 | `EventStreamReader` 静默丢弃陌生 `schema_version` 的事件 | 契约升版之后整条流为空且 `terminated=false`，**和「跑到一半崩了」完全同形** | `end()` 返回 `foreignVersion`，`runStreaming` 透传，调用方能说「升级扩展」 |
| 2 | `isWithin` 是字符串前缀比较 | `isWithin("/work/app", "/work/app/../other")` 返回 `true`——正是这个守卫存在的目的被绕过 | 先 resolve + normalize；`path.win32` / `path.posix` 分平台，大小写折叠只在 win32 |
| 3 | `assertNoSecretsInArgs` **生产调用方为零** | 建了守卫不接线——阶段 2 教训的原样重演 | 接到 `Runner.#start`，唯一同时持有 argv 和密钥环境的地方 |
| 4 | `child.stdout` / `child.stderr` 没有 `'error'` 监听 | 管道上一个未监听的 `'error'` 是**未捕获异常，杀掉整个 extension host**，不是杀掉这一次运行 | 两个流都挂空监听；运行本身仍由 child 的 `'error'`/`'close'` 结算 |
| 5 | `taskkill` 子进程没有 `'error'` 监听 | 同上。taskkill 在精简容器里可能不在 PATH | `killer.on("error", () => {})` |
| 6 | kill 不生效时 promise 永远悬挂 | `timeoutMs` 承诺放弃这次运行，而永不 resolve 的 promise 是放弃了调用方 | 升级一次（`KILL_ESCALATION_MS`）→ 兜底结算（`KILL_GIVE_UP_MS`） |
| 7 | `doctor` 的失败信封被判为 `incompatible` | 一个**格式正确的失败信封恰恰证明**二进制实现了契约；建议「升级 bugpilot」是错的 | 新增 `unhealthy` 裁决，说明交给共享的 `diagnose()` 码表，不再造第二套解释 |
| 8 | EACCES/EPERM 与 ENOENT 同判 `not-found`；握手超时判 `incompatible` | 「装一个 bugpilot」对权限问题是错的建议；对被杀毒软件拖慢冷启动的 exe 更是错的 | 拆出 `isNotExecutable`；新增 `unresponsive` 裁决 |
| 9 | email 与 token 存两个 key | 两次顺序写，第二次失败会留下**新 email 配旧 token**——`status()` 判为已配置、`environment()` 照样注入，产出一个指向错误原因的 JIRA_AUTH_FAILED | 一个 key 存一个 JSON，`save()` 原子；解析失败读作「未配置」而不是从每条命令里抛 |

附注：`engines.node` 收紧到 `>= 22.18`（原生类型剥离的最低版本）。

### 修复本身引出的第 10 项

接线 #3 之后，**已有的一条绿测试立刻变红**：它传 `JIRA_TOKEN: "t"`，而
`"doctor".includes("t")` 为真——守卫拦住了一次完全合法的运行。

这不是测试的问题，是守卫的问题：**一个会拦住每次正常运行的守卫会被删掉，不会被修好**。
改成两条规则叠加：

- 凭据真正会以的形态**永远拒绝**——整个参数就是密钥，或 `--flag=<密钥>` 的值那一半。
  这两种不可能误报。
- 「出现在参数任意位置」只对长度 >= 8 的密钥生效。真实 Atlassian token 远长于此。

### 这一轮的方法学

- **对时间相关的守卫做变异检验。** 把 `KILL_ESCALATION_MS` 从 2s 改成 90s、
  `KILL_GIVE_UP_MS` 改成 900s，跑测试——必须变红。红了才说明新测试测的是升级逻辑
  本身，而不是恰好通过。（用 `t.mock.timers` 而非真等 8 秒。）
- **「未监听的 error 会杀掉 host」这类断言要能被证伪。** 用
  `assert.doesNotThrow(() => child.stdout.emit("error", ...))`：去掉监听这行就会红。


## 阶段 5 —— Extension 完整 UX

### 步骤划分（开工前定，写下来是为了每一步都能独立提交且仓库始终自洽）

| 步骤 | 交付 | 为什么这个顺序 |
| --- | --- | --- |
| 5.1 | manifest + 打包构建 + 宿主接线 + 环境就绪（安装向导） | 先让扩展**能被 VS Code 加载**，哪怕只有 Doctor 一个命令。否则后面全是没跑过的代码 |
| 5.2 | 表单模型 + 校验 + argv 构建（纯逻辑） | 「表单 → `bug` 命令行」是整个扩展的心脏，且完全可测 |
| 5.3 | 进度模型（JSONL + `workflow_status.json` → checklist） | UI 展示的是 5 个能力，事件报的是实现步骤，中间需要映射 |
| 5.4 | 产物与 history 模型（`.ai/` 扫描，三态） | TreeView 的数据源，纯逻辑 |
| 5.5 | Webview 主面板（HTML/CSS/JS、CSP、主题变量、a11y、状态保持） | 依赖 5.2–5.4 的视图模型 |
| 5.6 | 命令闭环：Run/Stop/Retry、交接、诊断、会话续接 | 依赖面板与模型都在 |
| 5.7 | 逐条过 §5.4 验收 + 手测脚本 + `phase_5.md` | 界面验收无法自动化，必须给出可执行的手测清单 |

### 开工前查明的事实（不是猜的）

- **CLI 已有的机器可读面**：`doctor` / `status` / `delivery-check` / `search` /
  `context` / `summarize-results` / `fetch` / `list` / `check-results` / `bug`
  支持 `--json`；只有 `bug` 支持 `--json-lines`。
  **`agent-check`、`clean`、`retry-prompt`、`setup` 没有 `--json`** —— 扩展里这几个
  只能跑纯文本并把输出丢进 OutputChannel，不能假装有信封。
- `bug` 已有 `--retry`（阶段 2 交付），**没有 `--same-session`**（§11 待决 #5）。
  所以 5.6 的 Retry 按钮只接 `--retry`。
- `--json-lines` 的事件字段：`started{work_item_id,source}` / `phase{phase}` /
  `step_skipped{step,reason}` / `step_started{step}` / `step_completed{step}` /
  `artifact{path}` / `completed{ok,error?}`。**没有耗时字段** —— §5.4 要求
  「每步耗时」，所以耗时由扩展自己按事件到达时间计算。
- `workflow_status.json` 的 `steps` 是 `{step: pass|fail|skipped}`，粒度是**实现步骤**，
  不是能力。UI 必须自己把 20 个步骤折叠回 5 个能力。

### 5.1 之前先解决的工具链问题：扩展宿主不认原生类型剥离

阶段 4 的「零构建」只对**测试**成立。VS Code 扩展宿主用 `require()` 加载
`main` 指向的文件，且其 Node 版本远早于 22.18 的类型剥离——把 `.ts` 当
`main` 发出去不可能跑起来。

所以分成两套配置，各自解决一个问题：

| 配置 | 用途 | 关键项 |
| --- | --- | --- |
| `tsconfig.json` | 开发与测试：`node --test` 直接跑 `.ts` | ESM + NodeNext + `noEmit` |
| `tsconfig.build.json` | 打包 `.vsix`：产出扩展宿主能 `require` 的 JS | CommonJS 输出到 `out/`、`rewriteRelativeImportExtensions` 把 `.ts` 说明符改写为 `.js` |

依赖新增 `@types/vscode`（钉在 `1.90.0`，与 `engines.vscode` 的最低版本一致——
类型比引擎新会让人用上目标版本没有的 API）与 `typescript ^5.9`
（`rewriteRelativeImportExtensions` 需要 5.7+）。运行时依赖仍为零。

**规矩：只有 `src/extension.ts` 与 `src/host/**` 可以 import `vscode`。**
测试永远不 import 这两处——它们在 `node --test` 里必然 `ERR_MODULE_NOT_FOUND`。
这不是妥协，正是阶段 4 全部逻辑可测的原因，阶段 5 继续守住。


### 5.1 manifest、打包构建、宿主接线与环境就绪

**交付**：`package.json`（真正的扩展 manifest）、`tsconfig.build.json`、
`src/commands.ts`、`src/app/environment.ts`、`src/app/log.ts`、`src/host/host.ts`、
`src/extension.ts`、`scripts/smoke-activate.mjs`。测试 82 → 97。

现在这是一个**能被 VS Code 加载**的扩展：6 个命令（Check Environment /
Install Instructions / Choose Executable / Doctor / Agent Check / Show Log）、
一个配置项（`bugpilot.executablePath`），以及 §5.4 要求的「CLI 未安装」安装向导。

### 三个 manifest 是三份没有类型检查的契约，所以用测试守住

manifest、`registerCommand` 调用、按钮上的命令 id 必须三处一致，错一个的症状是
VS Code 那句毫无帮助的 `command 'x' not found`。做法照抄阶段 4 的跨语言码表守卫：

- `test/manifest.test.ts` **双向**比对 `COMMANDS` 与 `contributes.commands`
  —— 代码里有而 manifest 没有（面板里点不到），manifest 里有而代码没注册（点了就抛）。
- 同一个文件还钉住三件事：`main` 必须是 `out/*.js`（指向 `.ts` 的扩展根本无法激活）、
  设置项默认值必须是空串（默认写 `"bugpilot"` 会让「配置过」与「走 PATH」无法区分）、
  `engines.vscode` 必须等于 `@types/vscode` 的版本（类型比引擎新 = 用上了目标版本
  没有的 API，只在别人更老的编辑器上炸）。
- `npm run smoke` 加载**构建产物**并真的调一次 `activate()`：CJS 输出问题、
  未被改写的 `.ts` 说明符、声明了但没注册的命令，这三类错误全都能通过
  `node --test` 而只在激活时暴露。它现在断言注册出来的命令集合恰好等于声明集合。

### 决定

- **不在 `extension.ts` 里做判断。** 「该用哪个仓库」「bugpilot 能不能用」「不能用时
  提供什么按钮」全部在 `src/app/environment.ts` 里算成**数据**（`Environment` 联合类型
  + `actions: CommandAction[]`），宿主只负责渲染。这样安装向导的内容是可测的，
  而不是散在几个 `showErrorMessage` 调用里。
- **五态裁决对应五套按钮。** `unresponsive` 只给 Retry（版本没问题，装/换路径都是
  错的建议）；`unhealthy` 给 Run Doctor + Retry（bugpilot 没问题，环境有问题）。
  测试逐条钉住这个差异——否则五态就退化成「出错了」一种。
- **记住的仓库必须仍然开着才作数。** 一个来自已关闭目录的旧选择会把 `.ai/` 写进
  另一个 checkout。测试覆盖了这条。
- **`agent-check` 用纯文本输出，不假装有信封。** CLI 确实没给它 `--json`
  （开工前查过），所以扩展把 stdout/stderr 原样丢进 OutputChannel。

### 留给 5.2 的接口

```typescript
COMMANDS / SETTINGS                      // src/commands.ts，manifest 的单一真源
resolveEnvironment(input) -> Environment // ready | choose-folder | no-folder | unusable-cli
actionsFor(verdict) -> CommandAction[]
installInstructions() -> string[]
interface Log { info(m): void; error(m): void }   // src/app/log.ts，纯模块的日志出口
```

`extension.ts` 里的 `ensureEnvironment()` 是所有后续命令的前置：拿不到 ready
就已经向开发者解释过原因并给了按钮，调用方直接 return 即可。


### 5.2 / 5.3 / 5.4 三个视图模型（表单 → argv、进度、产物与 history）

**交付**：`src/app/form.ts`、`src/app/progress.ts`、`src/app/artifacts.ts`。
测试 97 → 150。三个文件都不 import `vscode`，因此 §5.4 要求的每一种状态
（空 / 运行中 / 错误）都是**值**，可以直接断言，而不是靠在真实编辑器里点。

### 先跑真 CLI，再写模型——三个假设当场被推翻

在临时 git 仓库里用 5.2 构建出的 argv 真跑了一次
（`bug --description ... --keywords ... --focus-file ... --skip-git-history --resume --prepare-only --json-lines`），
拿到真实事件流与 `workflow_status.json`。三个发现，没有一个能从设计文档推出来：

1. **不是每个步骤都有事件。** `memory_add` 在 `workflow_status.json` 里是
   `pass`，但整条流里**没有它的 `step_started`**。所以「没有事件」不等于「没干活」，
   `completed{ok:true}` 必须把仍然打开的行一并关闭——否则 Build context 会永远转圈。
   这条直接变成一条测试。
2. **产物文件名与设计文档不一致。** 文档写 `code_search_results.md`，CLI 实际写
   `code_search.md`。模型按**实跑结果**写，并且 `generated_files` 里还有一个
   `.ai_memory/bugs/<id>.md`——不在 work item 目录内。
3. **`--retry` 不认 `--json-lines`。** 只认 `--json`；两者都不给的话
   `_run_agent_after_prepare` 会**在终端拉起 agent**。如果 Retry 按钮照着 Run 的
   模式传 `--json-lines`，结果是：人类文本被事件读取器全部丢弃（看起来像崩了），
   同时背地里拉起了一个 agent。`buildRetryArgs` 因此固定用 `--json`，并有测试钉住。

### 决定

- **CLI 表达不了的 plan 就不要提供。** 没有 `--skip-build-context`：去掉 context
  只能用 `--only-issue-details`，而它会同时关掉搜索、历史、相似修复。所以表单
  把这个耦合**显式建模**（`effectivePlan`），面板上取消 Build context 时其余三项
  一起变灰。五个独立复选框会显示一个从未运行过的 plan。
- **默认 `--resume`，不是 CLI 的默认 `--fresh`。** 阶段 3 已经因为
  `fresh=True` 删掉过 agent 的 `fix_summary.md`。要删就必须显式勾选。
- **校验按字段返回，不返回一句话。** §5.4 要求「失败就地可读」，
  空输入框旁边的一句「需要 issue key」胜过盖住整个表单的通知。
- **长描述走文件，不走 argv。** Windows 命令行上限 32767 字符，粘贴一份 bug 报告
  就可能超。超过 4000 字符就写临时文件 + `--description-file`。
- **进度按 5 个能力显示，不按 20 个步骤。** `keywords` 同时属于 code_search 与
  similar_fixes，用它点亮任何一行都是在对另一行说谎——所以共享的前置步骤只进
  「当前活动」文字，不作为行的标记。跨语言测试读 `models.py` 的 `CAPABILITY_STEPS`
  双向核对，并断言「未被用作行标记的步骤必须是被多个能力共享的」。
- **耗时由扩展自己计时。** 事件流不带时间字段，而 §5.4 要求显示每步耗时。
  时钟是注入的，所以测试断言的是确切毫秒数，不是「大约」。
- **缺失的结果文件要显示出来。** `RESULT_FILES` 镜像 `workflow.py` 的
  `REQUIRED_COPILOT_RESULT_FILES`（跨语言测试守着），但只在 `agent_task.md`
  存在时才列——`--only-issue-details` 的运行本来就没有可交接的东西，
  列五个红条是噪音。

### 自己的两个 bug 是被自己的测试抓出来的

- **能力耗时只算到最后一步。** `step_started` 里我用「行状态不是 running 就重置
  计时」，但一个能力的每个步骤都会各自 completed，于是下一步开始时行是 done、
  计时被重置——issue_details 的 500ms 报成 100ms。改成以 `startedAt` 是否存在为准。
- **`diagnose()` 不该用来包装扩展自己的判断。** 「流没有终止事件」是**扩展的观察**，
  不是 CLI 的报告；传 `INTERNAL_ERROR` 进 `diagnose()` 会被码表的通用文案
  「bugpilot hit an unexpected error.」覆盖掉具体说明。这正是 `diagnose` 的既定行为
  （已知码以码表为准），所以这条路径自己构造 failure。

### 留给 5.5 的接口

```typescript
buildPrepareArgs(form, {root, descriptionFilePath?, platform?}) -> {ok, args, files} | {ok:false, problems}
buildRetryArgs(workItemId) -> string[]
effectivePlan(plan) / planFlags(plan)
new ProgressTracker(plan, now?).apply(event) / interrupted("stopped"|"crashed") / foreign(v) / view()
viewFromStatus(json) -> ProgressView          // 重启后恢复
buildArtifactList({names, expectResults?}) -> ArtifactList
historyFromPayload(listEnvelope, modifiedMs?) -> HistoryList
```


### 5.5 Webview 面板资源（文档骨架、样式、页面脚本、消息契约）

**交付**：`src/panel/messages.ts`、`src/panel/html.ts`、`media/panel.css`、
`media/panel.js`。测试 150 → 174。这一步只交付**资源与契约**，不接线——
面板在 5.6 才注册，避免中间提交里出现一个点了没反应的 Run 按钮。

### 没有 bundler 这件事决定了整个分工

Webview 是另一个 JS 上下文，**不能 import** `form.ts` / `progress.ts` /
`artifacts.ts`。硬要共享就得引 bundler（esbuild/webpack），那又回到阶段 5.1
刚摆脱的构建复杂度。所以定死一条：**宿主计算，页面渲染**。

页面只拥有一件东西：开发者已输入但尚未运行的表单。其余（校验结果、checklist 行、
产物分组）全部由宿主算好，通过一条 `state` 消息推过来。副产品是这些逻辑全都可测。

`revision` 字段是这个分工的必要条件：页面在开发者打字期间拥有表单，宿主只在
`revision` 变化时才替换它——否则每次状态推送都会覆盖掉半句输入。

### 消息边界是真的信任边界

页面能发的消息全部经 `parsePanelMessage` 校验，不是 cast：

- **`openArtifact` 的名字禁止路径分隔符与 `..`。** 产物名是 `.ai/<work_item>/`
  下的纯文件名；宿主拿到就会去打开它，这里不挡就是一条目录穿越。
- **页面不能指名编辑器命令。** 语义动作是固定集合
  （`openTask` / `copyHandoff` / `setCredentials`）。唯一会回传的命令 id 是宿主
  自己塞进 `readiness.actions` 的那些，且回来时仍要与 `COMMANDS` 核对——
  一个 webview 能请求 `workbench.action.*` 是它不该有的权限。
- **页面不能关掉 issue details。** `plan.issueDetails` 恒为 true。
- **超大粘贴 clamp 而不丢弃。** 丢掉整条消息看起来像面板卡死了；上限
  （描述 200k）远高于任何真实 bug 报告。
- 缺失的文本字段一律补成 `""`，不是 `undefined`——否则会一路漂到 argv 构建器
  里才炸，且离原因很远。

### §5.4 的界面要求改成机械可检的规则

界面质量没法自动截图验收，但**大部分要求可以转成对文件的断言**：

| §5.4 要求 | 变成什么测试 |
| --- | --- |
| 禁止硬编码颜色 | 正则扫 HTML 与 CSS 的 `#rgb` / `rgb()` / `hsl()`（**先剥注释**） |
| 200px 宽度可用 | CSS 里不得出现固定 `width: <n>px`（`max-width` 允许），且必须有 `box-sizing: border-box` 与 `overflow-wrap: anywhere` |
| 焦点环用 `--vscode-focusBorder` | 断言 `:focus-visible` 规则里出现该变量 |
| 每个输入有 label | 从 HTML 里抓出所有 `<input>/<textarea>` 的 id，逐个要求存在 `for=` 或包裹式 label |
| 状态不只靠颜色 | 每行带字形（✓ ● ○ – ✕）且 `aria-label` 含状态词；CSS 只做次要提示 |
| 不用 `retainContextWhenHidden` | 断言页面用 `getState`/`setState` 且文件里不出现该选项 |
| CSP 与无远程资源 | 断言 `default-src 'none'`、`script-src 'nonce-...'`、无 `unsafe-inline`、三个文件里都没有 `http(s)://` |
| 凭据不进 Webview | `PanelState` 只有 `jiraConfigured: boolean`，没有任何 token 字段 |

另外三条守卫是为了防「静默坏掉」：

- **页面绝不赋值 HTML。** 扫 `innerHTML` / `outerHTML` / `insertAdjacentHTML` /
  `document.write` / `eval(`。bug 标题来自 Jira、失败文案来自 stderr——
  把它们当 HTML 写进去，一份 bug 报告就变成了面板里的脚本。
- **页面引用的每个 id 必须存在于文档里。** webview 里改名是静默失败：
  `null.textContent` 在没人看的消息处理器里抛，表现就是面板不再更新。
- **页面发出的每种消息宿主都必须认识**，以及 `TEXT_FIELDS` 必须与文档字段一致、
  文档字段必须与 `FormState` 一致（双向）。

### 两个偏差（已同步设计文档）

- **Webview 里不用 Codicons，用文本字形。** Codicon 字体需要引
  `@vscode/codicons` 依赖并放宽 CSP 的 `font-src`。原生 TreeView（5.6）仍用
  `ThemeIcon`，即真 Codicon。§5.4「图标只用 Codicons」的本意是「不要引第三方图标集」，
  文本字形同样满足，且顺带满足「状态不只靠颜色」。
- **测试脚本先剥注释再 grep。** 这些文件会写清自己遵守的规则，裸 grep 会命中
  「说明这条禁令」的那句话。四条测试第一次跑全红，红的全是我自己的注释。
  剥注释后又做了变异检验（往 CSS 塞 `#ff0000` 和 `width: 300px`、往 JS 塞
  `innerHTML =`），三条如期变红。

### 留给 5.6 的接口

```typescript
panelHtml({nonce, cspSource, styleUri, scriptUri}) -> string
parsePanelMessage(raw) -> PanelMessage | undefined
PanelState { revision, readiness, form?, problems, progress, artifacts, jiraConfigured, canRetry, workItemId? }
PANEL_ACTIONS = ["openTask", "copyHandoff", "setCredentials"]
```

宿主侧还需要：`webview.postMessage({type:"state", state})`、`localResourceRoots`
限定到扩展目录、每次加载生成新 nonce。


### 5.6 接线：控制器、面板宿主、两个 TreeView、全部命令、会话续接

**交付**：`src/app/controller.ts`、`src/app/session.ts`、`src/panel/provider.ts`、
`src/views/trees.ts`、`src/host/ports.ts`，重写 `src/extension.ts`，
manifest 补齐 19 个命令 + 3 个视图 + 活动栏容器 + `media/bug.svg`。
测试 174 → 209，`npm run smoke` 现在还会断言视图集合并**真的构建一次面板 HTML**。

至此扩展功能闭环：不打开终端即可完成完整调查流程。

### 控制器是这一步的全部价值所在

`Controller` 通过四个窄端口（跑进程、碰文件、跟开发者说话、记日志）接触编辑器，
所以整条流程——取消、失败渲染、retry 循环、恢复历史 work item——都在
`node --test` 里跑得到，26 条测试。宿主侧文件全是一行一个 API 的适配器。

几条被测试钉住的行为：

- **凭据只走 env，且不进 panel、不进日志。** 一条测试把整份渲染过的
  `PanelState` 序列化后搜 token，另一条搜 argv，第三条搜日志。
- **Stop 是 stopped，不是 failed。** 给取消画红条会训练开发者忽略红条。
- **流没有终止事件 = failed 且 stderr 进日志**；`foreignVersion` = 「升级扩展」。
- **spawn 抛异常后面板仍可用**：状态回到 failed 且能再按一次 Run（测试真的按了第二次）。
- **运行中再按 Run 被忽略**，不会起第二个进程。
- **`--fresh` 必须先确认**，拒绝就什么都不跑。
- **手写 bug 的 work item id 只能从 `started` 事件里学到**（CLI 现铸的
  `local_<timestamp>`），否则事后打不开任何产物。
- **目录穿越在两处都挡**：消息解析器挡一次，`openArtifact` 真正开文件前再挡一次
  ——因为 TreeView 也会走到同一个方法。

### retry 不是第二次 Run（§5.6 的机制在 UI 上必须保留）

`bug --retry` 第一次只创建 `user_feedback.md` 然后停下。控制器照此行事：打开该文件，
提示「写完再按一次 Retry」，**不做交接**。把占位符模板交给 agent 等于喂一个空的修正,
而那正是这个循环唯一存在的理由。第二次按下才报告 `agent_retry_prompt.md` 就绪。

### 会话续接：明确标注脆弱，且优雅降级

`~/.claude/projects/<cwd-slug>/<session>.jsonl` 的 slug 规则是
「非字母数字全部换成 `-`」。这不是猜的——本机 `~/.claude/projects/` 下真实存在
`c--work-my-app`（来自 `c:\work\my-app`）与 `C--work-other-repo`
（大小写原样保留），测试直接用这两个真实样本。

但这是 Claude Code 的实现细节而非公开契约，所以每个函数在拿不到时返回
「不知道」而不是猜：没有会话就明确告诉开发者「只有 workspace root 正好是 agent
运行目录时才能看到」，不显示一个坏掉的入口。续接用终端 `claude --resume <id>`
（拿不到 id 时 `claude -c`）——**不是实时接管**，两个活进程写同一份 transcript 不安全。

### 新增的两条 manifest 守卫

- 视图 id 双向核对 `VIEWS`，且断言 panel 是 `webview` 而另两个不是
  （§5.3 定的分工：表单用 Webview，层级浏览用原生 TreeView）。
- **活动栏图标必须在磁盘上存在。** 图标缺失不会报错，容器只是渲染成空白。
- 只由 TreeView 传参调用的两个命令（`openArtifact` / `showWorkItem`）
  必须在 `commandPalette` 里 `when: "false"`——从命令面板调用它们会拿到
  `undefined` 然后静默什么都不做。

smoke 脚本现在在注册 WebviewViewProvider 时**真的 resolve 一次视图**，
于是资源路径错误或 HTML 模板错误会在这里暴露，而不是等开发者打开侧边栏。


### 5.7 收尾：逐条过 §5.4，补上四个不存在的格子

按 §5.4 的三态表**逐格核对**代码，而不是回忆一遍说「都做了」。结果是
**四格没有实现**，全部补齐：

| 缺口 | 症状 | 修法 |
| --- | --- | --- |
| Artifact 树的「错误」态不可达 | `listDirectory` 把所有异常吞成空列表——权限问题会显示成「这次运行什么都没产出」，把开发者送去查错的方向 | `DirectoryListing = ok / missing / unreadable`；`missing` 是首次运行前的正常态，`unreadable` 带原因显示 |
| Artifact 树的「扫描中」态不可达 | 没人设置过 `loading` | 读目录前先推一次 `loading`。本地几乎看不到，它是为网络共享和大仓库准备的 |
| 「检测中」被渲染成警告卡片 | `Readiness` 只有 ready / blocked，握手期间显示成一张「有问题」的卡 | 新增 `checking` 态：中性一行文字 + 表单禁用。三种状态对应三种反应——等 / 修 / 走 |
| 重启后进度**不会**恢复 | `viewFromStatus` 早就写好了，但重启后没人知道该读哪个 work item | `saveWorkItem` 存进 `workspaceState`，激活时 `refreshEnvironment()` 之后 `showWorkItem(last)` |

另外补了三态表要求的「主输入面板空状态：首次使用引导」——一张只在没有
work item 且未运行时显示的卡片。

### 手测清单是交付物，不是待办

§5.4 有四类验收（四主题、三档宽度、纯键盘、重启恢复）**无法自动化**。
写成 `docs/manual_qa_phase5.md`：10 节、逐条可执行、每条有明确期望，
并且给出了怎么**造出错误态**（把 executablePath 指向不存在的文件、
移除 `.ai/<id>/` 读权限、断网跑 Jira key）。

里面还记了一条最容易浪费时间的坑：**改完代码必须 `npm run build` 再 F5**，
因为扩展宿主加载的是 `out/extension.js` 而不是 `.ts` 源码。

### 这一阶段最诚实的一句话

213 条测试、smoke 会加载构建产物并真的 `activate()` 且 resolve 一次 webview
——但**它不是编辑器**。主题渲染、焦点顺序、拖到 200px 的样子、重启后的行为，
只有人在 Extension Development Host 里跑一遍才算验收。阶段文档里状态写的是
「代码完成，手测未做」，不是「完成」。


## 阶段 5 review（14 项）

**结论**：全部修完。TypeScript 213 → 248 tests（新增 `test/page.test.ts` 24 条），
Python 483 不变，`typecheck` / `smoke` 全绿。

最严重的两条都先在真实环境里复现，再动手：

| # | 问题 | 后果 | 修法 |
| --- | --- | --- | --- |
| 1 | `Controller.handle` 的 switch **没有 `command` 分支** | 安装向导那三个按钮（Install Instructions / Choose Executable / Retry）**全是死的**：消息解析了、校验了，然后被一个没有对应 case 的 switch 静默丢掉。而且 `messages.ts` 里承诺的「宿主会拿 `COMMANDS` 再核对一次」根本不存在 | 补 `command` 分支：先与 `COMMANDS` 核对再经 `UiPort.runCommand` 执行；不认识的 id 记日志拒绝 |
| 2 | 值型参数用「空格 + 下一个 token」传递 | `--keywords -Wall` 被 argparse 当成选项：**exit 2、usage 横幅、`--json-lines` 下零事件、无终止事件** —— 扩展只能显示「bugpilot 没说原因就停了」，而 `-Wall`/`-fPIC` 是完全合理的关键词。（argparse 放过含空格的值，所以「以 `-` 开头的描述」能活，单 token 关键词不能） | 全部改成 `--flag=value`；两条测试钉住，其中一条遍历所有值型参数，防止以后新增字段时漏掉 |

### 第一次给 `media/panel.js` 写行为测试，当场又抓出两个

它是整个扩展**唯一没有测试**的文件（330 行），因为它跑在 webview 里、`node --test`
没法 import。于是写了一个最小 DOM 桩（`test/page.test.ts`）：元素**从真实
`panelHtml()` 输出里抓 id 生成**，连 `checked` / `hidden` 的初始值都照 markup 来，
所以改名 id 会像在真实页面里一样失败，而不是静默返回 null。24 条测试，
立刻抓出两个此前完全不知道的 bug：

| # | 问题 | 后果 |
| --- | --- | --- |
| 3 | `render()` 里 `renderReadiness` 先跑，用的是**上一帧的 `running`** | 一次运行的第一帧里 **Run 按钮仍可点**。控制器会忽略第二次 Run（有测试），但按钮在对状态说谎 |
| 4 | HTML 里四个 plan 复选框**默认全未勾选**，而 `DEFAULT_FORM` 全为 true | 宿主推第一份 state 之前（或任何不带 form 的 state）页面显示「什么都不查」；此时按 Run 等于 `--only-issue-details`，一次什么都不搜的调查。加了一条测试拿 markup 默认值与模型默认值双向核对 |

### 其余 10 项

| # | 问题 | 修法 |
| --- | --- | --- |
| 5 | 每次 render 都 `focus()` 有问题的字段 | 只在问题集合**变化时**移动焦点。宿主每个事件都推 state，原来的写法会在开发者读完提示、点进别的字段后把光标一直拽回去 |
| 6 | 取消 Build context 会清掉其余三项，**重新勾选后不恢复** | 记下耦合前的选择并恢复。否则下一次运行静默跳过搜索/历史/相似修复——一个没人选过的 plan |
| 7 | `refreshArtifacts` 只推了 `loading`，没推结果 | 末尾补 `#push()`。它自己也是一个命令（Refresh），原来单独调用会让面板永远停在「Scanning .ai/ …」 |
| 8 | `refreshEnvironment` 每次都 bump `revision` | 不再 bump。bump 会让页面用宿主的副本重写所有字段（光标跳到末尾、丢掉 400ms 防抖内的输入），而凭据变更、executable 变更、每次 Run 都会走到它 |
| 9 | Stop 之后 `canRetry` 为真 | 改由「产物里是否有 `agent_task.md`」决定。`bug --retry` 读的是已准备好的包，对一个没产出包的运行提供 Retry 只会把人送进 `WORK_ITEM_NOT_FOUND` |
| 10 | 手写 bug 重跑时清掉了 work item，却留着上一个的产物列表 | 同时清空产物列表。否则树里列着一堆文件，点开却被 `openArtifact` 拒绝 |
| 11 | `formatDuration` 把 30ms 显示成 `0.001s` | 小于 50ms 显示 `<0.1s` |
| 12 | `viewFromStatus` 对含 `fail` 的状态文件报 `done` | 有失败行就报 `failed`——红条旁边写着「完成」是自相矛盾 |
| 13 | `openArtifact` 接受 `""` 与 `"."` | 名字必须匹配「字母数字开头的纯文件名」。`.` 指的是目录本身，而宿主会照着去打开 |
| 14 | 两个 TreeView 的 `EventEmitter` 从不 dispose；编辑器 tab 复用了侧边栏视图 id | 两个类实现 `Disposable` 并登记到 `subscriptions`；编辑器 tab 用独立的 `bugpilot.panelEditor` |

### 这一轮的方法学

- **「宿主会校验」写在注释里不等于有人校验。** 第 1 项是阶段 2、阶段 4 那条教训的
  第三次重演（建了守卫不接线），这次连按钮一起死了。现在有测试点一下按钮，
  断言命令真的被执行；另一条断言伪造的 `workbench.action.quit` 被拒绝。
- **对 CLI 的每个假设都值得真跑一次。** 第 2 项不是读代码能看出来的：
  要跑 `--keywords -Wall` 才知道 argparse 把它吃掉，也才知道
  `--json-lines` 下的表现是「一个事件都没有」。
- **没有测试的文件就是缺陷的藏身处。** `panel.js` 一写测试就掉出两个 bug，
  其中第 4 项（默认全不勾选）在真实使用里会安静地产出一次什么都不搜的调查。


## 阶段 5 第二轮 review（13 项，专攻 vscode 层与生命周期）

第一轮盯的是模型与页面。这一轮专挑 **smoke 之外没有测试覆盖的地方**：
`extension.ts`、`src/host/**`、`provider.ts`、`trees.ts`，以及跨切面的
生命周期与并发。结果：13 项，全部修完。测试 248 → 258。

### 生命周期：扩展对外部变化毫无反应

| # | 问题 | 后果 | 修法 |
| --- | --- | --- | --- |
| 1 | **没有 `onDidChangeConfiguration`** | 改了 `bugpilot.executablePath` 之后，扩展仍在跑旧的二进制、面板底部仍显示旧路径，直到手动跑一次 Check Environment | 监听该项配置变化 → `refreshEnvironment()` |
| 2 | **没有 `onDidChangeWorkspaceFolders`** | 在空窗口里打开一个文件夹之后，面板仍然写着「No folder is open」——而「先开空窗口再打开文件夹」是最常见的首次使用路径 | 监听 → `refreshEnvironment()` |
| 3 | `deactivate()` 什么都不做，注释还写着「运行中的进程由 Runner 拥有」 | 那不是一个「拆卸」故事：**没有任何东西去杀它**。关窗口 / 停用扩展会留下一个 bugpilot 和它的 ripgrep 继续跑（POSIX 上 Runner 还把它 detach 进了独立进程组） | `deactivate()` 调 `controller.stop()` |

smoke 现在断言这两个监听器**确实注册了**，并做了变异检验（删掉其中一个就变红）。
它还会真的调用几个不碰子进程的命令处理器（showLog / showInstallInstructions /
openPanelInEditor / stop / refreshViews）——这些处理器此前一条测试都没有。

### 一条安全项与一条权限收紧

| # | 问题 | 后果 | 修法 |
| --- | --- | --- | --- |
| 4 | CSP nonce 由 `Math.random()` 生成 | nonce 是**安全控制**：CSP 只允许携带该值的那个 script，注入进页面的东西只能靠猜。`Math.random()` 的种子是可预测的，本来就不是为对抗猜测设计的 | 拆出纯模块 `src/panel/nonce.ts`，用 `node:crypto` 的 `randomBytes`（24 字符 ≈ 143 bit）。有测试扫源码确认不再出现弱 RNG，并断言 200 次取值互不相同 |
| 5 | `command` 消息的白名单是**整张 `COMMANDS` 表** | 那张表里还有 `bugpilot.clean`、`bugpilot.clearCredentials`——页面从未被提供过、也没有理由请求 | 白名单收紧为「宿主此刻实际放进 `readiness.actions` 的那几个 id」。测试断言一个真实存在但未被提供的命令（`bugpilot.clean`）被拒 |

### 把「不知道发生了什么」变成「知道」

| # | 问题 | 后果 | 修法 |
| --- | --- | --- | --- |
| 6 | **15 分钟超时被报成「stopped」** | Runner 对「用户按 Stop」和「超时」都返回 `aborted: true`，控制器分不开——于是一次真正跑太久的运行会显示成「你点了停止」，既误导人又把真问题藏起来 | 控制器记住 abort 是不是自己发起的；超时走新的 `interrupted("timeout")`，报 `TIMEOUT` 失败并给出可执行的下一步（缩小搜索范围 / 降低 Max files）。三条测试分别钉住超时、Stop、以及「Stop 之后的下一次运行不再继承那个标记」 |
| 7 | `list --json` 返回**失败信封**时，History 显示「No work items yet. The first run creates one.」 | 失败信封不抛异常（CLI 是故意写信封 + 非零退出的），于是「读不出来」被显示成「还没有」 | 检查 `ok === false`，显示「读取失败」 |
| 8 | 运行中点 History 里的条目**静默无反应** | 看起来像树坏了 | 明确提示「运行进行中，等它结束或按 Stop」 |
| 9 | 产物树不说自己在显示**哪个** work item | 历史里有两个条目时无法分辨 | TreeView 的 `description` 设为当前 work item |
| 10 | 第二次按 Retry 打开的是 `user_feedback.md`，而提示语让你去交接 `agent_retry_prompt.md` | 让人去找一个从没打开过的文件 | 第一次开反馈模板，第二次开重试包——和提示语一致 |
| 11 | OutputChannel 的时间戳是 **UTC** | 与编辑器自身日志、开发者的表差 8 小时，对不上时间就没法排障 | 改本地时间 |

### 两处浪费

| # | 问题 | 修法 |
| --- | --- | --- |
| 12 | `Check Environment` **跑了两次 `doctor` 握手**：先 `environment()` 问一次（为了判断要不要弹目录选择），再 `refreshEnvironment()` 问一次。而这个命令同时是安装向导的 Retry 按钮 | 目录选择改用**不启动任何进程**的 `chooseRepoRoot`，然后只刷新一次 |
| 13 | 环境探测没有去重 | `refreshEnvironment()` 共享同一个在飞的 promise。激活、目录变化、配置变化、每次 Run 都可能在几毫秒内各要一次，而被杀毒软件拖慢的 exe 要好几秒才答——排成一队的同样进程既慢又没意义。测试并发调用三次只探测一次 |

### 两处是测试自己的问题（记下来，因为是同一个坑第二次）

- 第一轮写的「点按钮真的会执行命令」那条测试，在白名单收紧后**过时了**
  （它没有先把环境置为 blocked，于是 `#offered` 是空的）。改写成更严的版本，
  并在注释里说明它取代了哪一条。
- nonce 的源码扫描第一次**命中了自己的注释**（文件里解释「为什么不能用
  `Math.random`」）。和 CSS/页面脚本的扫描一样，先剥注释再 grep。
  这是同一个坑第二次踩，规则应当记住：**任何「文件里不得出现 X」的测试，
  都要先剥注释**。

### 这一轮的结论

第一轮修的是「功能不对」，这一轮修的多是「**状态会过期**」和「**说错了原因**」：
配置变了不知道、目录开了不知道、超时说成用户取消、读取失败说成还没有、
运行中点击毫无反应。这类缺陷不会让测试变红，也不会让 VS Code 报错——
只会让人对着一个自信地说错话的界面浪费时间。

`extension.ts` 与 `host/**` 仍然只有 smoke 覆盖（现在多了监听器断言与
几个安全命令的实际调用）。这是有意的取舍：那两处只该有适配器与注册，
一旦里面出现判断，就该搬进 `src/app/`。


## 阶段 6 —— Internal Beta hardening

### 步骤与状态

| 步骤 | 交付 | 状态 |
| --- | --- | --- |
| 6.1 | `.vscodeignore` + `vsce` 打包 + 打包内容守卫 | 完成，产出过真实 `.vsix` |
| 6.2 | 真 CLI 端到端契约测试（`npm run integration`） | 完成，8 条 / 11 秒 |
| 6.3 | 版本可见性（`doctor` 报 `version`）+ `python -m bugpilot.cli` 修复 | 完成 |
| 6.4 | Beta 检查单 + `.vscode/launch.json` / `tasks.json` + README 三入口 | 完成 |
| 6.5 | 阶段文档与设计同步 | 完成 |
| — | 安装矩阵实测、新机器 onboarding、界面手测、MCP 连通性 | **只能由人做**，已写成清单 |

测试：Python 483 → 485；TypeScript 258 → 261；新增集成 8 条；打包守卫 1 个脚本。

### 6.1 打包：这类错误只在安装之后才暴露

第一次 `vsce package` 打出来 **68 个文件 / 180KB**，把 `src/`、`test/`、
`tsconfig*.json`、`scripts/` 全打进去了。加 `.vscodeignore` 后是
**29 个文件 / 75KB**。

但真正的风险不是体积，而是**反方向**：少一个文件的后果是

- 少 `out/extension.js` → 扩展根本不激活；
- 少 `media/panel.js` → **一个空白面板，而且哪里都不报错**（CSP 什么都没拦，
  只是没有东西可加载）。

所以 `scripts/check-package.mjs` 用 `vsce ls` 拿**真实文件清单**双向断言：
必需文件（含 manifest 声明的图标路径、`main` 指向的文件）必须在，
`src/` `test/` `scripts/` `node_modules/` `tsconfig*` `*.vsix` 一个都不许在。
变异检验：把 `media/**` 加进 `.vscodeignore`，守卫如期报
`media/bug.svg is missing from the package`。

一个 Windows 细节：脚本里不能走 `npx vsce`——`npx.cmd` 是 shim，
不给 shell 就 spawn 失败。改成用当前 Node 直接跑
`require.resolve("@vscode/vsce/vsce")`。

### 6.2 这是阶段 5 两个缺陷的藏身之处，现在有测试了

`test/` 下全是密闭测试（CLI 是脚本化的假货）——这正是它们快且诚实地测扩展
自身逻辑的原因，但也意味着**「真 Python 进程吐出的字节」这条缝从未被测过**。
阶段 5 的两个缺陷恰好都在那儿：argparse 吃掉 `--keywords -Wall`、
产物文件名照抄设计文档（真实是 `code_search.md`）。

`test-integration/` 在临时 git 仓库里跑真的 CLI，并把输出喂给
`Runner` → `parseEnvelope` → `ProgressTracker` / `buildArtifactList` /
`historyFromPayload`。8 条，11 秒，`npm run integration` 显式触发（需要 Python，
不进 `npm test`）：

- `doctor --json` 只吐一个信封，且客户端自己的规则能接受它；
- 完整手写 bug 运行到底：每一行 checklist 都有结果、产物分组正是树要显示的、
  **运行留下的 `workflow_status.json` 重建出的 checklist 与流式产生的一致**；
- `--keywords=-Wall` 能跑；**分开写的 `--keywords -Wall` 仍然报废**
  （零事件、无终止事件），于是「为什么必须用 `=`」是被记录的事实而不是记忆；
- 找不到的 work item → 扩展码表认识的错误码 + stderr 行 + 非零退出（三通道）；
- **打不通的 Jira 仍然终止流**，且失败被归给在飞的那一行（`issue_details`）；
- `list --json` 喂出 history（连 title 一起）；
- PATH 上的 bugpilot 被**分类**而不是被误读。

最后一条就是缩小版的安装矩阵，而且它报出了这台机器的真实答案：
**PATH 上的 pipx 副本不认 `--json`，被正确判为 `incompatible` 而不是 `not-found`**
——这个区分决定了开发者会不会跑去装第二个 bugpilot。

Jira 那条测试把 `JIRA_BASE_URL` 指向一个关闭的本地端口，而环境变量优先于
`~/.bugpilot/config.toml`，所以**即使机器上配了真凭据也碰不到公司 Jira**。

### 6.3 「我现在跑的到底是哪个 bugpilot」

这台机器上同时有 pipx 副本、源码、可能还有 exe，而 `doctor` 报告里**没有版本**。
现在 `version` 是报告的第一个字段——放在报告里而不是只放信封里，是因为
`collect_doctor_report` 同时被 CLI 信封、MCP 与人类输出消费，一处改动全都拿到。
扩展把它显示在面板底部、紧挨解析出的路径。字段**可缺**：较旧但契约兼容的版本
不报版本号，缺失不得把一个可用的安装降级（有测试）。

顺手修掉一个静默失败：**`python -m bugpilot.cli` 过去什么都不打印、退出 0**
——读起来像「成功了」，而这恰恰是有人在排查 import 问题时会试的写法。
现在它和 `python -m bugpilot` 一样跑 `main()`，并有测试同时验两个入口。

### 6.4 无法自动化的部分，写成别人能执行的清单

阶段 6 计划里的四项——三种安装的兼容、新机器 onboarding、真实编辑器里的界面、
MCP 客户端连通性——**我在这台机器上都代跑不了**。写成
`docs/beta_checklist.md`：每行给出要跑的命令与期望的裁决，包括**怎么人为造出**
契约升版（改 `SCHEMA_VERSION` 跑一次）与冷启动超时。

新机器 onboarding 那节特意写成「**找一个没参与过的人，掐表，全程不口头补充**」。
因为验收标准的本意是「文档和错误文案能把人带过去」——如果他需要问人，
那是文案的缺陷，不是他的问题。

同时提交了 `.vscode/launch.json` 与 `tasks.json`：F5 会**先构建**。
这是最容易浪费半小时的坑（扩展宿主加载 `out/extension.js`，不是 `.ts`），
现在由 `preLaunchTask` 兜住，而不是靠记住。

### 与阶段 6 计划的差异

- **`upgrade / version mismatch 提示`**：契约层面早已实现（旧版 → `incompatible`，
  新契约 → `foreignVersion` / 拒绝解析）。这一阶段补的是**版本可见性**，
  没有做「最低版本号强制」——`schema_version` 已经在管协议兼容，
  再加一个 semver 门槛只会与它漂移。
- **`MCP 测试、Extension TS 测试`**：两者本来就在阶段 3 / 4 / 5 交付
  （52 + 261 条）。阶段 6 补的是它们之间那条缝：真 CLI ↔ TS 客户端。
- **Linux best effort**：未做任何 Linux 验证。集成测试用
  `process.platform === "win32" ? "python" : "python3"`，理论上可跑，
  但没跑过就不能说支持。


## 阶段 7 —— 迁移清理

三项计划项，其中一项的结论是「**决定不做**」。测试：Python 485 → 497；
TypeScript 261 → 262。

### 7.1 交接文案：四份 → 一份

设计文档 §5.5 早就点名了这个风险：「Skill 落地时应与 MCP prompt 共用同一份
文案来源，避免两处漂移」。动手时发现**不是两处，是四处**：

1. `agent_runner.HANDOFF_PROMPT`（CLI 拉起 agent 时的一句话）
2. `mcp_server.fix_bug` 的展开版（更长，因为模型还没跑任何东西，得先被告知调哪个工具）
3. **扩展的 Copy handoff 兜底**——`controller.ts` 里一句 TypeScript 字符串，
   和第 1 条措辞恰好一致，纯属巧合
4. 即将写的 `SKILL.md`

现在 `bugpilot/core/handoff.py` 是唯一来源，四处都从它渲染。第 3 条跨语言，
用的是阶段 4 建立的同一招：**TS 测试读 Python 源码比对**
（`errors.ts` ↔ `errors.py`、`form.ts` ↔ `identity.py` 已有先例）。

**重构必须逐字节等价**，因为其中两条会进到被拉起 agent 的命令行，受 R1 约束。
`test_mcp_prompt_is_byte_for_byte_what_it_was` 把已发布的原文整段钉住。
过程中确实差点改错：把禁止动作朴素 `", ".join(...)` 会产出
`Do not commit, push, post to Jira`——列表倾倒，不是英语；补上 `or` 之后
恰好等于原文。

### 7.2 Skill：CLI 之上的触发垫片

`skills/bugpilot-investigate/SKILL.md`。它**不是第四个入口**（§5.5 的定位不变）：
执行完全靠宿主自己的 Bash 工具，零 Python 依赖。四个编号步骤由
`handoff.skill_steps()` 渲染，测试逐条比对（忽略空白，因为文件要换行排版，
写成一行长句只会更难读）。

文件比设计文档里的草稿长，多了两块：

- **retry 循环**。agent 遇到「没修好」的默认反应是从头再来一遍，
  而 §5.6 的两段式（先生成 `user_feedback.md` 停下、人填完再跑）
  是这个循环存在的全部理由。所以 SKILL.md 明确写「**反馈是开发者的，不是你的，
  去问，不要自己填模板**」。
- **命令不存在时怎么办**：说出来并停下，**不要**退回自己 grep 仓库
  假装产物存在。这是这条路最可能的失败模式。

安装位置是**目标仓库**的 `.claude/skills/`（因为 `bugpilot` 也在那里跑），
[skill_setup.md](skill_setup.md) 给了两个平台的命令。

### 又一条名不副实的测试（这次是我自己刚写的）

`test_the_skill_and_the_mcp_tools_describe_the_same_trigger` ——
名字承诺两侧都查，实际只查了 skill 的 frontmatter。改成从**构建出的 server**
读真实工具描述（`server.list_tools()`），两侧都对 `TRIGGER_TOKENS` 断言。

**没有改成「共用同一句话」是有意的**：MCP 的工具描述故意更具体——
阶段 3 靠写清「大写前缀 + 短横 + 数字」修掉过一次误路由（`openvds-2` 被送进
Jira 工具）——强制统一措辞会让其中一边变差。必须相等的是**「听的是不是同一批词」**，
因为 §9 阶段 7 要对比两条路的触发率，而如果它们在等不同的词，对比本身没意义。

### 7.3 `agent_runner` deprecated

标记，不删（计划就是「V1 标记，Beta 反馈后删」）。做法：

- 模块文档说明**为什么**它是三个入口里的异类：MCP 是被 agent 调用的，
  扩展是人点一下交出去的——两者都把「决定让模型参与」与「准备上下文」分开，
  这就是 R5，也正是这条路要走而不是要扩展的原因。
- `run_agent()` 往 **stderr** 打两行提示，指明替代路径。
  用 stderr 而不是 `DeprecationWarning`：后者是库的做法，Python 默认不显示，
  而这里的读者是盯着终端的人。stdout 一个字节没动，R1 保持。

### 7.4 input adapter：决定不做，并写下触发条件

计划原文是「**根据实际使用决定**是否扩展 GitHub Issue / Azure DevOps /
clipboard / selected text」。结论是不做，理由不是成本高——`BugSpec` 与
`bug_spec_from_description` 已经把成本压到「解析 + 一个 `source` 值」——
而是**没有证据**：manual 模式已经能吃下任何粘贴进来的文本（含 stack trace
与日志片段），所以新 adapter 的唯一增量价值是「自动取回内容」。

触发条件逐条写进了 §1.2（有人实际在那些系统里报 bug、且出现了手工复制的
重复劳动；有人反馈粘贴是摩擦点；同一份 stack trace 被反复人工整理）。
在此之前，新增 adapter 会增加三个入口都要覆盖的表面积，换一个假想的便利。

### 这一阶段的结论

三个入口的架构到此收口：一个 core、三个入口、一份交接文案、一套错误码、
一个事件契约。**剩下的全部是「只有人能做」的验证**，不是代码：
Skill 与 MCP 的触发率对照、界面手测、安装矩阵、新机器 onboarding、
`.vsix` 的实际安装。这些在 [beta_checklist.md](beta_checklist.md) 与
[manual_qa_phase5.md](manual_qa_phase5.md) 里。


## 阶段 6 / 7 review（8 项）

前六轮 review 每轮都找出 8–14 个真缺陷，阶段 6/7 还没过 review，所以补上。
这一轮的方法有一个变化：**先真的装一次 `.vsix`**——阶段 6 留下的
「`.vsix` 从未被安装过」是我自己能关掉的缺口，而它第一次就出了东西。

测试：Python 497 → 500；TypeScript 262（未增，新增的是打包守卫的两条断言）。

### 第 1 项：包里混进了测试源码，装一次才看见

```
$ code --extensions-dir <临时> --install-extension bugpilot-0.1.0.vsix
Extension 'bugpilot-0.1.0.vsix' was successfully installed.
$ ls <临时>/<publisher>.bugpilot-0.1.0/
media  out  package.json  readme.md  test-integration     ← 这个不该在
```

原因是 `.vscodeignore` 与打包守卫**都是黑名单**：写的是 `test/**` 与 `/^test\//`，
而 `test-integration/` 是 6.2 才加的目录，两条都匹配不上。守卫绿着，
包里带着一份 `.ts` 测试源码发出去。

**黑名单会在下一次加目录时腐烂**，所以两边都倒过来写成 allowlist：

- `.vscodeignore`：`**` 全排除，再 `!package.json` / `!README.md` / `!out/**` /
  `!media/**` 加回来。新目录默认不进包。
- `check-package.mjs`：任何不在 allowlist 上的文件都失败，报错文案写明
  「加进 `.vscodeignore`，或者如果它该在就加到这里」。

变异检验：把 `!test-integration/**` 加回 `.vscodeignore`，守卫如期报
`test-integration/cli.integration.test.ts is packaged but not on the allowlist`。
重新打包后 29 → 28 个文件，重装确认目录里只剩 `media out package.json readme.md`。

### 第 2 项：又一处「注释承诺了一个不存在的守卫」

`check-package.mjs` 里写着

> A stale `out/` is the packaging mistake with the longest debugging time: the
> extension runs, and behaves like the version you had an hour ago.

紧跟着的代码只是 `assert.ok(outFiles.length >= 10)`——**数了个数**。
这是这个项目里同一个模式的**第三次**：阶段 2「建了守卫不接线」、
阶段 5「宿主会拿 COMMANDS 核对（其实没有）」、现在是「检查产物是否最新（其实没查）」。

现在真的查了：遍历 `src/**/*.ts`，每个都必须有对应的 `out/**/*.js`，
且 mtime 更新。变异检验：`touch src/app/form.ts` 之后守卫报
`edited since the last build: src/app/form.ts — run npm run build`。

### 第 3 项：扩展 README 从没说过怎么装这个扩展

它既是扩展页面（装完才看到）**又是**仓库读者的 onboarding 文档，
而 bugpilot 不在 Marketplace——只能手工装 `.vsix`。原来的第一节直接讲
「你需要 CLI」，跳过了「先把扩展装上」。这条直接卡在阶段 6 唯一的验收标准上
（陌生人照文档 5–10 分钟走完）。现在补了 `npm run package` +
`code --install-extension`，以及一条不碰正常 profile 的临时 profile 装法
（就是我刚刚验证过的那条命令）。

### 第 4 项：一个近乎无效的断言

`TRIGGER_TOKENS` 里有 `"before"`——几乎任何英文散文都包含它，
所以那一条断言对「两侧是否听同一批词」几乎没有约束力。
实测两侧都含 `"before searching"`（也正是那句行为指令：**先**用 bugpilot，
不要自己先搜），换成它。

### 第 5 项：Skill 的 frontmatter 从来没被解析过

原来的测试只做字符串包含。而**格式错误的 skill 会被 Claude Code 静默忽略**——
最坏的失败模式。依赖里没有 YAML 解析器，所以按文件实际使用的结构校验：
必须以 `---` 开头、扁平映射、一行一个键、无缩进、无制表符、
值里没有未加引号的 `": "`（YAML 会读成嵌套键）。另外两条：
`name` 必须等于目录名（Claude Code 按目录找 skill），
`description` 必须短于 500 字符——它是**常驻上下文**的那一行，
正文才是按需读取的，所以它得是触发器而不是手册。

### 第 6–8 项（较小）

| # | 问题 | 修法 |
| --- | --- | --- |
| 6 | 集成测试里 `built.args.filter(arg => arg !== "--json-lines")` 会静默腐烂：flag 改名后过滤变成空操作，argparse 又容忍重复的 store_true，测试照样绿——但测的已经不是原来那件事 | 过滤前先 `assert.ok(built.args.includes("--json-lines"))` |
| 7 | `beta_checklist.md` 把测试数写死成「261 条」 | 去掉数字。那是一份**活的操作指令**，每加一条测试就过期 |
| 8 | `handoff.skill_steps(command=...)` 的参数没有任何调用方用过非默认值 | 删掉。留着的「灵活性」只是让漂移守卫不再精确 |

顺带在检查单里补了一条给 exe 那一行的提醒：`doctor` 报告的 `version` 字段走
`from .. import __version__`，是阶段 6 新加的，**冻结打包后要确认
PyInstaller 没漏掉这个导入**——上一次打 exe 时这行代码还不存在。

### 这一轮的教训

**「装一次」和「跑一次」不是同一件事。** `vsce ls` 的输出里
`test-integration/cli.integration.test.ts` 一直都在，我在 6.1 也看过那份输出，
但守卫的黑名单让我以为它被排除了。真的装出来、`ls` 一下装出来的目录，
问题一秒钟就现形。这与阶段 6 自己的结论一致：**契约要用真进程验，
包要用真安装验。**

以及那个第三次出现的模式：**注释里写「这里会检查 X」的时候，
下一步就该问「代码真的检查了吗」。** 三次都是我自己写的注释，
三次都是注释比代码走得远。


## Python core 的 review（8 项：6 个既有缺陷 + 我修复时自己引入的 2 个）

前七轮 review 盯的都是适配器工作本身（阶段 1–7 的新代码）。这一轮盯的是
**从没被 review 过的旧 core**——那些在三入口之前就存在、现在被三个入口同时
调用的模块（`workflow.py` 1698 行、`jira.py` 930、`search.py` 606…）。

方法不是逐文件读，而是**按缺陷类别定向扫描**：缺 `encoding=` 的读写、
`subprocess` 的编码与超时、宽泛的 `except`、写入的原子性、
用户输入到外部命令的传递。测试：Python 500 → 510。

### 1. `_atomic_write_text` 有零个调用方（第四次「建了不接线」）

`workflow.py` 里定义了它，注释也解释了为什么需要它——然后
`workflow_status.json` 是**直接 `write_text`** 写的。

这在三入口之前无所谓（同进程顺序读写），现在不是：
**扩展从这个文件恢复 checklist、MCP 的 `get_status` 也读它，都在另一个进程里、
在运行进行中**。撕裂的读取解析成空，面板会把一次正在顺利进行的运行显示成
「没有进度」。

修复时还发现两件必须一起处理的事：

- **Windows 上 `os.replace` 到一个被别的进程打开着的文件会抛
  `PermissionError`**——而这个文件的读者恰恰就是那种进程。加了重试。
- 重试仍失败就**原地写**而不是抛异常。失败代价不对称：撕裂的读取最多是
  一次过期的 checklist，抛异常则毁掉整个步骤。

（这是「建了守卫不接线」的第四次：阶段 2/4 的 argv 守卫、阶段 5 的
`COMMANDS` 核对、阶段 6 的产物新旧检查，现在是原子写。）

### 2. ripgrep 把开头的 `-` 当成 flag——阶段 5 的修复正是让它走到这一层的原因

```
$ rg --line-number --no-heading --ignore-case --fixed-strings "-Wall" .
rg: unrecognized flag -W
```

`_rg_keyword` 直接 `args.append(keyword)`，没有 `--`。后果：返回码 2 →
关键词被丢进一条**没人会读的 warning**，搜索静默少一项。

而**编译标志、命令行开关、参数名恰恰是 bug 报告在讨论的词**。更讽刺的是：
阶段 5 review 我刚把 argparse 那层修好（`--keywords=-Wall`），
于是 `-Wall` 现在能顺利穿过 CLI，然后死在这一层。

修法是加 `--`。两条测试：一条断言 argv 形状（`--` 紧接关键词、路径仍在最后），
一条**跑真的 rg** 并断言真的匹配到（`.cpp` 而不是 `.c`——`INCLUDE_GLOBS`
是遗留 C++/Qt 的那套，第一次写成 `.c` 就没匹配到）。

### 3. 供给的关键词数量无上限

挖掘出来的关键词有 `keywords[:5]` 的上限，而**供给的关键词是在那个上限之后
前置进去的**，本身不限量。每个关键词是一次 rg 调用、各自 20 秒超时。
粘 60 个关键词 = 最坏 20 分钟，然后被扩展自己的 15 分钟超时放弃。

而三个入口**现在都让人手打这个列表**。所以在 core 里封顶（20 个），
并把丢掉的记进 `extracted_keywords.json` 的 `dropped_supplied_keywords`
与 `execution.log`——丢掉但不隐瞒。封在 core 而不是三个入口各封一遍，
是「core 负责解析规则，适配器不重复」的既有分工。

### 4–5. 人会手工编辑的文件，读法不一致

| 文件 | 读法 | 问题 |
| --- | --- | --- |
| `developer_hint.md` | 三处读，其中两处 `errors="replace"`，**一处没有** | 开发者手写的提示文件。用 cp1252 / GB2312 保存（比如写中文）→ 那一处直接 `UnicodeDecodeError`，整次运行挂掉 |
| `~/.bugpilot/config.toml` | 无 `errors=` | 手工可编辑，且**每条命令**都经 `load_config` 读它 → 解码错误会把 `bugpilot doctor` 也弄挂，而那正是唯一该解释「哪里出了问题」的命令 |

两处都改成 `errors="replace"`。hint 那条测试**驱动真的
`run_investigation`**，不是重新测一遍 Python 的解码器（第一版就写成了同义反复，
自己抓出来重写）。

### 6. 安全文档禁止 agent 提交 `.ai/`，但没人帮开发者避免

`docs/safety.md:27` 明确写着「agent 绝不能 commit `.ai/` 或 `.ai_memory/`」——
禁的是 agent。而**没有任何东西告诉开发者把这两个目录加进 `.gitignore`**，
也没有任何检查。第一次运行之后，目标仓库的 `git status` 里就是一堆自己没写的文件，
其中 `jira.json` 装着抓回来的 Jira 内容。

修法是**报告而不代劳**（改别人的 `.gitignore` 不是 bugpilot 该做的决定）：

- `doctor` 报告新增 `ai_artifacts_ignored`（true / false / null）。
- 两个 README 都写上那两行，并说明可以用 `doctor` 检查而不是靠记。
- **面板底部显示一行警告**——顺带用上了阶段 5 就接进控制器、之后一直没用的
  `doctor` 报告。`null`（没有 git）不警告：那种情况下这条建议根本不适用。

### 我自己在修第 6 项时引入的两个 bug（都是拿真仓库验出来的）

第一版实现是 `git check-ignore -q .ai .ai_memory`，然后我拿四个真实场景验了一遍：

```
own repo (gitignored) = False     ← 明明 .gitignore 里有这两行
fresh repo            = False
after adding two lines = False    ← 加了也还是 False
```

两个 bug：

1. **`git check-ignore -q` 只接受一个路径**：多给会
   `fatal: --quiet is only valid with a single pathname`，退出码 128，
   而我的 `code == 0` 把它读成「没被忽略」——对**所有仓库**都返回 False。
2. **`.gitignore` 里以 `/` 结尾的模式只匹配 git 已知是目录的路径**。
   问 `.ai` 在目录还不存在时答「没被忽略」——**而那正是这条建议最值得给的时刻：
   第一次运行之前**。改成问 `.ai/probe`（目录内的路径），与存在性无关。

四种情况现在都对：已忽略且目录存在 = True，已忽略但目录不存在 = True，
未忽略 = False，非 git 仓库 = None。这四条都进了测试，
其中「目录不存在」那条正是两次翻车的地方。

### 这一轮的教训

- **旧代码不会因为「一直没出问题」而正确**，只是没人从新的角度看它。
  `_atomic_write_text` 从写下那天起就没有调用方；
  ripgrep 的 `-` 问题在阶段 5 之前根本走不到那一层。
- **同一份用户输入穿过几层，每层都要各自防一遍。** `-Wall` 这个关键词
  在 argparse 层被吃掉（阶段 5 修）、在 ripgrep 层又被吃掉（这一轮修）。
  修好上游只是让问题往下游走一层。
- **拿真工具问，不要照文档猜。** `git check-ignore` 的两个行为
  （单路径限制、目录模式需要存在性）都不是从文档里想出来的，
  是四个真实仓库当场打出来的。


## 全仓库「定义了但没接线」扫描（第五次之后，把它变成守卫）

「建了守卫不接线」在这个项目里出现了**四次**：阶段 2/4 的 argv 凭据检查、
阶段 5 承诺的 `COMMANDS` 核对（连带整排安装向导按钮是死的）、
阶段 6 承诺的产物新旧检查（实际只数了个数）、以及 `_atomic_write_text`
（为扩展要读的那个文件而写，零调用方）。每一次都是**读起来像保护，实际什么都不保护**，
每一次都是几个月后有人读代码才发现。

所以这一轮不再靠读，写了个扫描器：用 `ast` 收集 `bugpilot/` 的顶层符号、
正则收集 `extension/src/` 的 export，然后**分别统计生产引用与测试引用**——
「只被自己的测试引用」正是那个缺陷的形状。

### 扫描结果与处置

| 符号 | 判断 | 处置 |
| --- | --- | --- |
| `print_copilot_check` / `print_auto_invocation_not_implemented` / `print_doctor_report` | 文档字符串写着「Deprecated: 保留给既有调用方」——**而既有调用方一个都没有**（CLI 早已改用 `*_lines`） | 删。并修掉两处文档：`architecture.md` 还在拿它们描述模块，`adapter_design.md` §3.1 拿 `print_doctor_report()` 当「数据/展示已分离」的证据，还写着「`copilot.py` 是唯一没分离的模块」——那也早就不成立了 |
| `_draft_status` / `_draft_summary` / `_search_quality_draft` / `_missing_information_draft` / `_missing_results_markdown` | 私有，零引用 | 删。删完又暴露出级联死函数 `_diff_indicates_changes`（原来只被它们调用），一并删，扫到收敛 |
| `SILENT_LOG`（TS） | 阶段 5 写的「给测试和没有宿主的路径用」，两者都没出现 | 删 |
| `secretStore`（TS） | `extension.ts` 直接用 `context.secrets` | 删 |
| `CommandId`（TS 类型） | 零引用 | **不删，改成真守卫**：`register(command: CommandId, ...)`。注册一个未声明的 id 现在是编译错误，而不是「命令存在但 manifest 没有」的运行时失败 |
| `bug_spec_from_jira` | **只被测试引用——但 core 自己重新实现了一遍它的字段映射** | 见下 |
| `run_bug_workflow` / `TRIGGER_DESCRIPTION` / `TRIGGER_TOKENS` / `skill_steps` | 合理：分别是文档化的库 API、以及「消费者是文件而不是代码」的三个（SKILL.md 与 MCP 描述由测试比对） | 进 allowlist，逐条写理由 |
| TS 的 `activate` / `knownCodes` / 四个 guard export | 合理：宿主调用的、跨语言比对用的 | 进 allowlist |

### 最有价值的一条：输入适配器被 core 绕过了

`bug_spec_from_jira` 是阶段 1 定的「Jira → BugSpec 唯一入口」，带两道校验
（`validate_work_item_id` + `is_jira_issue_key`，后者防止一个非 Jira id
拿到不存在的写回目标）。而 `_persist_resolved_spec` **在 core 里把
`summary`/`description` 的映射又写了一遍**，没有任何校验。

两份映射，Jira 哪天改字段名就会漂移，而且只有一份有校验——正是
§3.3「适配器构建 BugSpec，core 不碰 Jira」要防的事。现在 core 调适配器拿内容，
身份字段仍来自请求（那是 `parse_step` 之后才知道内容、身份早已确定的正确分工）。

### 删除时又掉出第五份交接文案

删 `print_*` 时看到 `copilot.py:43` 硬编码着
`f"Read .ai/{issue_key}/agent_task.md and complete the workflow."`——
**阶段 7 统一了四处，漏了这处**（还有 `workflow.py` 的一行日志，第六处）。
两处都改成渲染 `handoff.handoff_prompt()`。漏掉的原因很实在：
它们不像另外四处那样有名字，是嵌在一串输出行里的字面量。

### 把扫描变成守卫，而不是一次性清理

`tests/test_no_unwired_symbols.py` 与 `extension/test/unwired.test.ts`：
同样的扫描 + **带理由的 allowlist**。加一行是一个决定，不加就是红的。
另有一条「allowlist 自身也要诚实」的测试——某个条目后来有了调用方就该离开清单，
否则 allowlist 会变成过期豁免的堆积地，守卫悄悄失效（正是它要防的失败）。

写这两个守卫时**第三次踩到同一个坑**：注释里提到的名字会被计成引用。
`deactivate` 因为一句「Set at activation so `deactivate` can end a run」
就被算成有生产调用方。两边都改成**先剥注释**（Python 还要剥 docstring）——
剥完立刻又多抓出一个 `skill_steps`。这条已经在项目里出现三次
（颜色扫描、nonce 扫描、现在是引用扫描），规则应当记牢：
**任何基于文本扫描的守卫，第一步都是剥掉散文。**


## 阶段 0A 的假设：**成立**（第一次真实客户端验证）

设计文档第一天写下、七个阶段一直悬着的那个假设——**模型会不会优先调用 BugPilot，
而不是自己 grep**——2026-09-04 用真实 Claude Code 客户端、真实 Jira issue
（JR-12345，HampsonRussell 的一个 2020 年功能请求）验证了。

四条验收逐条对照：

| 验收项 | 结果 |
| --- | --- |
| **调工具而不是自己 grep** | **通过**。第一个动作就是 `prepare_jira_bug`，之前没有任何检索。原话：「I'll start with BugPilot to pull the issue context.」 |
| `.ai/JR-12345/` 被创建 | 通过。23 个产物 + `.ai_memory/bugs/JR-12345.md`，真实 Jira 数据（`Mock/demo Jira data: no`） |
| 没去试不存在的工具 | 通过。只用了 `prepare_jira_bug`，retry / commit / jira-comment 一次都没试 |
| 工具失败文案可读 | 本次未触发（没有失败）。由 `test_mcp_stdio.py` 覆盖 |

**还有一条我此前特意标记「最容易被忽略」的：它有没有真的读产物？** 也通过了，
而且是最有说服力的一条：它读了 `agent_task.md`、`related_files.json`、
`search_quality.json`，然后**照 workflow 的规矩执行了低置信度那条规则**
（「Do not modify code based only on low-confidence keyword matches」）——
写了 no-op 分析，一行代码没改。

结论：**MCP 作为 V1 的 agent 入口站得住**，§5.5「MCP 相比 Skill 多出来的三样」
那个论证的前提成立。Internal Beta 的硬阻塞解除。

### 但同一份日志暴露了三个真问题

真实数据一次就打出了三个测试套件从没发现的东西。前两个已修。

**1. 头条数字与它下面那一段自相矛盾。**

```
## Context Quality
Score: 90/100
- Related files found: 10
...
search_quality.json: {"confidence": "low", "high_confidence_files": []}
```

`_quality_score` 对「related_files 非空」一律 **+25**，完全不看搜索自己信不信。
于是一次「零个高置信度文件、十个全靠 `function` / `frequency` / `available`
这类通用词匹配到 bugpilot 自身源码」的搜索，头条报 **90/100**。

README 里写着「Code search includes a confidence assessment so low-confidence
false positives are visible before the agent edits anything」——评估是有的，
**头条数字把它无视了**。而头条数字是 agent 读到的第一样东西。这次那个 agent
足够谨慎，自己去读了 `search_quality.json` 并推翻了印象；不够谨慎的那个
会直接照着 90/100 开始改 `workflow.py`。

改成按置信度加权（high 25 / medium 12 / low 4），并把置信度**并进那一行信号**
（`Related files found: 10 (search confidence: low)`）——单独一个 10 读起来像好消息。
同样输入下：**90 → 69**（high 时仍是 90）。

**2. 对一个 Closed / Won't Do / Task 的 issue，照样准备了完整的修复包。**

分支名、修复流程、23 个文件，全套。三个决定性事实——状态 Closed、
resolution「Won't Do」、类型 Task 而非 Bug——**全都在包里，但没有一处指出来**。
更糟的是 `parse_issue` 根本没保留 `resolution`：它只出现在 jira_summary 的
markdown 里，而不在每个消费者都读的那个 dict 里。

补了 `resolution`，并在 `bug_context.md` 的 Issue 段之后加了一个**只在有话说时
才出现**的 `## Caution` 段：

```
## Caution

- This issue is already Closed (resolution: Won't Do). Preparing this package
  did not reopen it — check with the reporter before working it.
- Jira types this as Task, not a Bug. Expect a request rather than a failure:
  there may be no reproduction steps to follow and nothing broken to fix.
```

陈述事实然后停下——**要不要动一个已关闭的 issue 是开发者的决定**，不是 bugpilot 的。
不认识的工作流状态一律不说话（宁可沉默，也不要把一个活着的 issue 标成已了结）。

**3. 关键词排序把领域词丢了（只有一个样本，先记录不调）。**

JR-12345 的实际结果：

- 高价值：`preHRS12, Calculate, Correlation, frequency, determine`
- 普通：`Suggested, PETRONAS, Reservoir, Geophysics, attenuation, function, ...`
- **丢弃**：`seismic, Well, tie, Factor, Quality, HRS, process, ...`

`seismic`、`well tie`、`HRS` 这些真正的领域词进了 dropped，而 `Suggested`、
`according`、`available`、`traditional` 这些通用英语留在了 normal 层。
原因是排序里频次占了权重，而散文里重复出现的恰恰是通用词。

**没有动它。** 在一个样本上调排序器就是过拟合。记进 `beta_checklist.md`：
再跑 5–10 个真实 issue，如果领域名词被丢弃是稳定模式，再动 `keywords.py`。

### 这次验证的方法学

**一次真实运行打出了三个缺陷，而 517 条测试一个都没打出来。** 原因很具体：
三个都不是「行为错」，而是「**呈现错**」——数字与事实矛盾、决定性事实没被指出、
排序把好词丢了。这类东西只有喂真数据、并且有人（或有个足够谨慎的模型）
读完整份输出时才会现形。

这也印证了阶段 6 的那句结论，现在可以再补一句：
**契约用真进程验，包用真安装验，产物用真 issue 验。**


### 同一份日志里的第四个问题（回答「都修完了吗」时才发现）

用那次运行的**真实产物清单**去对扩展的分组表，发现 22 个文件里有 **9 个从没被分组**，
全部落进「Investigation」——和 `bug_context.md`（那一段真正存在的理由）挤在一起：

- 5 个 `copilot_*`（用 Claude 的开发者一个都不会打开）
- `jira.json`（抓回来的原始载荷，也正是安全规则点名「绝不能提交」的那个）
- `memory_entry.md`、`test_plan.md`、`review_prompt.md`

**为什么漏了**：阶段 5.4 的分组表是照着一次**手写 bug**的 12 个文件建的，
而 Jira 运行写 22 个。当时日志里写的是「文件名照实跑结果，不照设计文档」——
那句话是对的，但**只跑了一种运行**。

修法：新增 `copilot` 分组（排在 `context` 之后、`state` 之前——不藏起来，
但也不让它们挤占开发者真正要看的位置），`jira.json` / `memory_entry.md` 归 `state`，
`test_plan.md` / `review_prompt.md` 归 `handoff`。并把那份**真实 22 文件清单**
钉进测试：断言落入 `context` 的恰好只有七个调查类产物。

教训是对阶段 6 那条的补充：**一个真实样本胜过文档，但它仍然只是一个样本。**
手写 bug 与 Jira issue 是两条路径，产物差了将近一倍。


## 第二次真实 issue 运行：验证上次的修复，结果又抓出一个

拿**同一个** issue（JR-12345）重跑一次 `prepare_jira_bug`，目的是在真实数据上
验证上一轮那两个修复。两条都按设计工作：

```
## Caution

- This issue is already Closed (resolution: Won't Do). Preparing this package
  did not reopen it — check with the reporter before working it.
- Jira types this as Task, not a Bug. ...

## Context Quality
Score: 90/100
- Related files found: 10 (search confidence: high)
```

Caution 段出现了，置信度也并进了那一行。**但分数又是 90** ——
因为 `search confidence` 从上次的 `low` 变成了 `high`。

### 为什么会变：我上次写的测试污染了这次的搜索

```
high_confidence_files: ['tests/test_context_signals.py']
top match: docs/implementation_log.md  score=88  （13 个关键词）
```

上一轮我为那两个修复写了 `tests/test_context_signals.py`，fixture 里**逐字引用了
JR-12345 的 summary 与 description**（「PETRONAS Reservoir Geophysics」等）。
而逐字引用正是 `_rg_keyword` 的 phrase 层要检测的**最强单文件信号**
（`exact phrase match` → `strong_signal` → high）。于是：

1. 那一个文件拿到 per-file `high`；
2. `_overall_quality` 的规则是「只要有一个 high 文件，整体就是 high」，
   而且这条**明确压过 noise 标记**（`if noise_indicators: ... if not high_files`）；
3. 整体 high → 我上一轮的加权给了 +25 → 分数回到 90。

**我的修复按规格工作，喂给它的输入变错了。**

### 修了什么：测试路径是线索，不是实现

新增 `TEST_PATH_INDICATORS`，`_assign_confidence` 里对测试路径**封顶 medium**：

- 不是噪音——一个命名了故障行为的测试是最好的线索之一，要继续列出来；
- 但它不能是那个告诉读者「实现在这里」的文件。而 high 就是这个意思。

判定同时看目录（`tests/` `spec/` `testing/`）与文件名（`test_*` `*_test.*`），
并且不会把 `lib/latest/` 误判成测试（有测试钉住这条）。
应用源码里的同一个 phrase 信号仍然是 high——封的是测试路径，不是削弱信号。

### 没修但记下来：**在仓库里写一个 issue 的笔记，会污染以后对它的搜索**

`docs/implementation_log.md` 这次以 **score=88** 排第一，是第二名的 2.4 倍，
命中 13 个关键词——纯粹因为我在那里写了这个 issue 的分析。

置信度机制**挡住了**它（`docs/` 有 noise 标记 → low），这部分设计是对的。
但它仍然占掉了 10 个槽位里的第一个。要不要让「有 noise 标记的文件不能排第一」
是**排序策略**的改动，牵扯召回目标，一个样本不够——与关键词排序那条一样，
先记录证据，不动。

对真实目标仓库（遗留 C++/Qt 产品）的意义：这个现象**不是自测才有的怪癖**。
release notes、changelog、以及**引用了 ticket 文本的测试名**都会造成同一效果，
本仓库 `tests/test_workflow.py:873` 就有一行
`"Fix in HrsQtProcessWidgetInversion.cxx: ..."`。

### 顺带排除一个假警报

整套 Python 测试从 2 分 13 秒变成 8 分 40 秒，看起来像我引入了性能回归。
量了一下：**同一个测试、同一份代码，连跑三次是 10.5s → 2.1s → 1.7s**。
是改动文件后的冷缓存 / 杀毒重新扫描，不是代码问题。
（单测的 `call` 时间 1.83s vs 2.22s，差异全在收集/启动。）
**遇到时间异常先量，别猜——也别顺手「优化」一个不存在的问题。**

### 累计：两次真实运行，五个缺陷

| # | 缺陷 | 状态 |
| --- | --- | --- |
| 1 | 头条分数与 `confidence: low` 自相矛盾 | 已修（加权） |
| 2 | Closed / Won't Do 的 issue 照样出完整修复包，无人指出 | 已修（`## Caution`） |
| 3 | 关键词排序把 `seismic`/`well tie`/`HRS` 丢进 dropped | **未修**，待 5–10 个样本 |
| 4 | 扩展的产物分组表不认识 Jira 运行的 9 个文件 | 已修（新增 copilot 分组 + 真实清单钉进测试） |
| 5 | 测试路径能单独把整体置信度抬成 high | 已修（封顶 medium） |

**两次运行、五个缺陷；同期 527 条 Python 测试 + 271 条 TS 测试，零发现。**
这不是说测试没用——它们守住的是回归。但**「呈现是否诚实」这一类，
只有真数据 + 有人读完整份输出才会现形**。

## 「Run in Claude」按钮（2026-09-07）

需求原话：*「在 vs code extension 中有个按钮可以把 bug context 给 claude 来运行」*。
面板 Hand off 区块第一个按钮，`bugpilot.runInClaude`，命令面板里也有。

### 先查了能不能直接推进 Claude Code 的面板

装的是 `anthropic.claude-code` 2.1.263。读它自己的 manifest：
**贡献 26 个命令，没有一个接受 prompt 参数**。也就是说唯一的「直接推文字」
路径是猜一个未公开的参数形状——它下次升级就会静默失效，而且失效时看起来像
BugPilot 的 bug。所以走终端：可验证，而且 `resumeAgentSession` 已经在用同一个机制。

工作目录用**仓库根**，因为 `agent_task.md` 自己就要求在仓库根执行。

### 三级降级，每级一条测试

| 情况 | 行为 |
| --- | --- |
| `claude` 能起 | 终端里 `claude "<交接语>"` |
| 起不来，但 Claude Code 的视图在 | 复制交接语 + 唤起它的侧边栏 |
| 都没有 | 只复制，并说明去装什么 |

降级路径**绝不开终端**——一个只打印 "command not found" 的终端看起来是我们的错。

### 一个只有在真机上量才会发现的坑

`canRun` 原本是「`spawn --version`，ENOENT 就算没装」。在 Windows 上这是错的：
不带 shell 的 `spawn` 直接走 `CreateProcess`，**只补 `.exe`，不补 `.cmd`**。
npm 安装的 Claude Code 恰好就是 `claude.cmd`——终端跑得好好的，探测说没装。

顺手想「那就 spawn `claude.cmd`」——量了一下，**不行**：

```
claude:      exited 0
claude.cmd:  threw EINVAL      ← CVE-2024-27980 修复后 Node 拒绝这样起 .cmd
claude.exe:  exited 0
bugpilot:    exited 2          ← 非零退出仍证明存在，canRun 返回 true，符合预期
```

所以降级不是第二次 spawn，而是**沿 PATH 找文件名**：`launcherNames()`
按 `PATHEXT` 展开候选（无 PATHEXT 时用 Windows 保证的四个），
`existsOnPath()` 逐个 `stat`。函数最终回答的是调用方真正的问题——
**终端能不能找到它**，而不是「Node 能不能 spawn 它」。

**这条属于「先量再改」的第 N 次生效**：如果按第一直觉改成 spawn `.cmd`，
在作者机器上恰好也能过（因为这里有真的 `claude.exe`），
到只装了 npm 版的机器上才炸——而那正是这个降级要救的机器。

### 与 R5 的关系

不冲突。阶段 7 废弃的是 CLI **默认**自动拉起 agent；R5 要的是「决定让模型介入」
是一个独立的动作，而**一个人按下的按钮正是那个动作**。运行本身仍是 prepare-only，
argv 测试照旧断言这一点。

交接语与其他四处同源（`handoff.py`），有测试断言按钮传的与 Copy handoff
复制的是同一句——第五种措辞就是第五个会漂移的东西。

扩展测试 271 → 281，注册 20 个命令，`.vsix` 已重新打包安装。

## 面板重构：一条线，六步（2026-09-07）

需求：把面板简化成 *Jira issue / Bug description → Run → 调查步骤 → Build
context → Fix with AI* 一条线，不要分开的 Investigate / Progress / Handoff。

### 为什么这个重构值得做

原来同一次运行被描述在**三处**：Investigate 复选框组、Progress checklist
（重复同样五个标签）、结束后才出现的 Hand off 卡片。要知道「code search 跑没跑」
得看第二处，要知道「下一步怎么办」得等第三处出现。合并之后**一行一步**：
复选框（选不选）、状态图标（跑得怎样）、产物图标（拿到了什么）在同一行上。

### 保住了架构，没有推倒重来

关键约束没变：**没有打包器，页面 import 不了任何模型**。所以行是
**静态 markup**，由 host 每次 push 时填状态——复选框属于页面（表单状态），
状态属于 host（运行结果），静态行是让这两件事同时成立的唯一办法。
`app/workflow.ts` 是新的视图模型；`progress.ts`、`form.ts` 的既有逻辑一行没动。

### 三个「诚实」问题，都在模型里解决

1. **`fixWithAI` 不进 `form.plan`。** plan 里每一项都会变成 CLI flag，
   而这一项描述的是**进程退出之后**扩展做什么。有测试断言它一个参数都不产生
   （`assert.deepEqual(withFix, plain)`）——否则 `--prepare-only`
   就不再对面板发起的每次运行都成立。
2. **从不报 "Complete"。** 规格里给了这个状态，但 agent 跑在扩展并不拥有的
   终端里，「AI 修完了」在这里**不可知**。能诚实说的最后一句是 "AI fix started"。
   这是唯一一处没照规格实现的地方，理由写在 `overallStatus()` 的注释里。
3. **行上的图标跟着文件走，不跟着事件走。** 第一版按 `build_context` 步骤事件
   判断——测试立刻抓到：fixture 的事件流里没有 `context` 步骤，图标就不出现。
   真正的判据是**它要打开的那个文件在不在**。改完顺带修好了一个没人报的缺陷：
   从 History 恢复的 work item 现在也有图标（那里根本没有事件流）。

### 措辞与机制分开

UI 里没有一处写 Claude——有测试扫描 markup 断言这一点（agent 选择器里的那一项
除外）。机制在 `app/agents.ts`：加一个 provider 是加一行表。

表里**只有 `claude`**，因为只有它的调用方式是在真机上量过的。其余靠
**自定义命令**（`{prompt}` 占位）：谁在用 Codex/Gemini 就谁知道它的 flag，
一句模板胜过我们的猜测——这跟当初不去猜 Claude Code 未公开的命令参数是同一条理由。

顺带修了一个真实的 shell 缺陷：`agent_handoff.md` 可能是多行，
而**引号里的裸换行会被终端当成第二条命令提交**——交接语就变成了一次意外的
shell 调用。命令行里的那份先折成一行；剪贴板里的那份保留原格式。

### 图标：codicon 字体是打进包的

`$(go-to-file)` 这种写法只在 tree item / quick pick / 状态栏有效，**webview 里无效**，
而 VS Code 也不把图标字体暴露给 webview。所以 `@vscode/codicons` 的 ttf
连同一份只声明九个字形的 css 进了 `media/codicons/`，
`scripts/check-package.mjs` 的必需文件清单也加了它们——字体没打进包时
每个图标都会渲染成方框豆腐，那看起来像扩展坏了。

**许可证要注意**：图标是 **CC BY 4.0**（代码是 MIT），重新分发要署名，
`.vsix` 就是一次重新分发——所以有 `media/codicons/ATTRIBUTION.md`。

### 其他

- 输入区只剩「输入源 + 一个字段 + Run」。七个调优字段进了折叠的
  Advanced settings；折叠区里的字段报错时**自动展开**——看不见的报错等于没报错。
- `Ctrl+Enter` 在页面里处理（`keydown`），不走 manifest keybinding：
  webview 里那个不可靠。单按 Enter 不触发，描述框要用它换行。
- 命令 `bugpilot.runInClaude` → `bugpilot.fixWithAI`，新增
  `bugpilot.openArtifactsFolder`。

扩展测试 281 → 327，注册 21 个命令，`.vsix` 已重新打包安装。
