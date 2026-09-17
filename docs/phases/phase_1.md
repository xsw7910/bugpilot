# 阶段 1 —— 领域模型与 core

**状态**：完成 · 2026-09-03
**计划**：[adapter_design.md](../adapter_design.md) §3.3 / §3.4 / §9 阶段 1
**过程**：[implementation_log.md](../implementation_log.md) 阶段 1.1 – 1.3b
**测试**：348 passed（阶段 1 开始前基线 236，新增 112）

**这一阶段的一句话结果**：BugPilot 的内核不再以 Jira issue 为中心，而是接受一个
`InvestigationRequest`；手写 bug 描述与 Jira issue 是两条等价输入。

## 提交

```text
5bf37d5  Phase 1.3b: code search reads InvestigationOptions
7195a7d  Fix ten review findings from phase 1
ae9c632  Phase 1.3a: workflow accepts an InvestigationRequest
328a9d9  Phase 1.2 + 1.4: input adapters and core stdout cleanup
83cd8af  Phase 1.1: add work item identity and the investigation request model
```

## 1. 交付物

### 新增模块（均为叶子，只依赖 `config`）

| 模块 | 职责 | 测试 |
| --- | --- | --- |
| `bugpilot/core/identity.py` | work item 身份的唯一判定处 | `tests/test_identity_models.py`（44） |
| `bugpilot/core/models.py` | `InvestigationRequest` 三层领域模型 + plan 展开 | 同上 |
| `bugpilot/core/input_adapters.py` | Jira 边界；`BugSpec` 构造与持久化 | `tests/test_input_adapters.py`（26） |

另有 `tests/test_investigation.py`（27）覆盖 `run_investigation`，
`tests/test_search_options.py`（15）覆盖 options 生效。

### 改动的模块

| 模块 | 改动 |
| --- | --- |
| `workflow.py` | `run_investigation` 为实现主体；`run_bug_workflow` 降为薄包装；`_parsed_issue` / `_persist_resolved_spec` 新增 |
| `search.py` | `run_code_search` 收 options；文件上限只在 `_rank_related_files` 施加一次 |
| `copilot.py` · `doctor.py` | 拆成 collect / render 两层 |
| `memory.py` · `cleanup.py` | 改用 `identity` 的判定，删除各自的正则副本 |
| `cli.py` | 3 处改为在 CLI 层打印 |

### 新增产物

`.ai/<work_item>/bug_spec.json` —— 持久化的 `BugSpec`。UTF-8 无转义，中文标题可读。

## 2. 下游可依赖的公开契约

```python
# 身份 —— 三个谓词回答三个不同问题，不要互换
from bugpilot.core.identity import (
    is_jira_issue_key,      # 能否回写 Jira？（Jira 写入前的闸门）
    is_work_item_id,        # 能否作目录名？（containment 检查，故意宽松）
    is_known_work_item_id,  # 用户输入的是 id 还是搜索词？（分类器）
    validate_work_item_id,  # 同上，失败抛 ValueError
    new_local_work_item_id, # local_<YYYYMMDDHHMMSS>
)

# 领域模型
from bugpilot.core.models import (
    BugSpec,               # work_item_id · source · title · description · source_ref
    InvestigationOptions,  # hint · keywords · focus_files · ignore_paths · max_files · max_search_lines
    InvestigationPlan,     # issue_details · code_search · git_history · similar_fixes · build_context
    InvestigationRequest,  # spec + options + plan
    SOURCE_JIRA, SOURCE_MANUAL,
)

spec.can_write_back        # -> bool，§5.1 的 NO_JIRA_TARGET 判据
request.resolved_steps()   # -> list[str]，按 WORKFLOW_STEPS 顺序，依赖已闭包
request.skipped_steps()    # -> list[str]

# 输入 adapter 与持久化
from bugpilot.core.input_adapters import (
    bug_spec_from_jira,          # 收 parse_issue 的输出
    bug_spec_from_description,   # (description, title=None, now=None, repo_root=None)
    save_bug_spec, load_bug_spec,  # load 失败返回 None，不抛
)

# 执行
from bugpilot.core.workflow import run_investigation, jira_request
run_investigation(repo_root, request, agent_fix=..., fresh=..., include_memory=...,
                  allow_mock=..., progress=..., hint=..., jira_comment=...) -> WorkflowResult
```

**`progress` 回调**在每个实际运行的步骤点触发，被 plan 关掉的步骤不触发 ——
这是阶段 2 `--json-lines` 的挂点，事件流天然只报真正跑过的步骤。

## 3. 与计划的净偏差

| # | 计划 | 实际 | 设计文档 |
| --- | --- | --- | --- |
| 1 | `WORK_ITEM_ID_RE = ^[A-Za-z][A-Za-z0-9_-]*$` | 尾部追加 `[-_]\d+`。旧 `clean` 测试揭示旧正则隐含「必须有数字后缀」，裸词 `HR` 不是合法删除目标 | ✅ 已同步 |
| 2 | 未提 | 两个判定函数**不做 `strip()`**；`" JR-12345"` 是不同的目录名 | ✅ 已同步 |
| 3 | 只有 `CAPABILITY_STEPS` 一张表 | 需要**两张**：能力→步骤，步骤→前置产物（`STEP_PREREQUISITES`），core 做传递闭包 | ✅ 已同步 |
| 4 | 预期改 25 个 step 签名 | 只需 `_parsed_issue` 一个助手 —— 仅 4 个 step 读 `jira.json`。step 签名不变 | 无需同步 |
| 5 | `focus_files` 只给了字段名 | 做成**加分**（`FOCUS_FILE_BONUS = 25`）而非过滤 | ❌ **未同步** |

偏差 5 的理由：过滤会把「猜错的 focus」变成「空搜索结果」，用户拿不到猜错的信号；
加分只重排不隐藏。25 分足以压过关键词证据（phrase 12 / qualified 10 / high 6）。

## 4. 验收对照（§9 阶段 1）

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 同一 workflow 可分别用 Jira issue 与纯 description 运行，产出同类产物 | ✅ | `test_manual_investigation_runs_without_jira` 等 |
| 本地 id 形如 `local_20260901094133`，`is_jira_issue_key` 对它为 `False` | ✅ | `test_new_local_work_item_id_is_a_work_item_but_not_a_jira_key` |
| 全仓单一 Jira key 判定 + 单一 work item id 判定，旧副本已删 | ✅ | 实际拆出**三个**谓词（见 §5 教训一） |
| plan 关闭某项时对应 step 标 `skipped` 而非 `fail`；依赖自动补齐且只跑一次 | ✅ | `test_disabled_capability_is_marked_skipped_not_failed` + 参数化的完整跑通测试 |

## 5. 给后续阶段与 review 的要点

### 教训一：一个谓词不要服务两个语义

§3.4 的目的是把「是不是 Jira key」和「是不是安全目录名」分开。实施中发现
`memory search` 需要**第三个问题**：「用户输入的是 id 还是搜索词」。我最初用
`is_work_item_id` 回答它，导致 `memory search utf-8` 创建 `.ai/utf-8/` 目录并跳过
自由文本评分（`utf-8` / `log4j-2` / `python-3` 都满足那个正则）。

`is_work_item_id` 必须宽松到接受任何我们可能创建的 id，所以它**天生不能当分类器**。
新增判定时先问清楚：这是 containment 检查还是分类器？

### 教训二：只测集合运算等于没测

阶段 1.3a 的 12 个测试全绿，随后的 review 找出 7 个真实缺陷。原因是那些测试只验证
`resolve_steps` 的**集合运算**，没有一个真的关掉某个能力**跑一遍完整流程**。

现在有参数化测试：五个能力逐个关闭 × manual/Jira 两条源，各跑一遍完整
`run_investigation`。**任何改动 `CAPABILITY_STEPS` 或 `STEP_PREREQUISITES` 的
后续工作都必须保持这些测试绿** —— 它们是 plan 契约的最低保障线。

### 教训三：上限只能有一个施加点

`MAX_TOTAL_RELATED_FILES` 原先被切三次（排序尾部 + 两处重切）。删掉冗余的两处后，
`max_files` 才不可能出现「一个视图生效、另一个忽略」。加新上限时同理。

### 影响阶段 5（扩展 UI）的一条

**`workflow_status.json` 表达不了「不适用」与「被跳过的能力」的区别。**
`_write_status` 写出全部 24 个 `WORKFLOW_STEPS`，缺席的一律填 `"skipped"`，
所以 manual 模式下 `fetch: skipped` 与 `commit_plan: skipped` 是同一种渲染。
`InvestigationPlan.skipped_steps` 的模型层区分**不传导到这个产物**。

扩展的进度 checklist 若要区分这两种状态，必须另读 `bug_spec.json` 的 `source`。

### 其他易错点

- `bug_spec_from_jira` 收的是 `parse_issue` 的**输出**，不是原始 issue dict
  （为让 `input_adapters` 保持叶子，不 import `jira`）。
- manual 模式下 `_parsed_issue` 要读 `bug_spec.json`，所以 **spec 必须在任何 step
  之前落盘**。`run_investigation` 已保证，自行编排 step 的调用方需注意。
- manual 输入**不写** `jira.json`。payload 只在内存里构造给 `parse_issue`，
  这样 `jira.json` 永远是真实抓取的数据。
- 路径匹配的测试字符串必须用 raw string：`"src\reader"` 里 `\r` 是回车。

## 6. 已知遗留

| 项 | 说明 | 归属 |
| --- | --- | --- |
| `options.keywords` 未接线 | 字段存在，`keywords_step` 仍只从 issue 文本提取 | 阶段 2 |
| CLI 无 manual 入口 | `run_investigation` 可用，但没有 `bugpilot bug --description` | 阶段 2 |
| `bugpilot list` 未实现 | `load_bug_spec` 已就绪，命令本身没写 | 阶段 2 |
| manual 模式 Jira 命令行为 | §5.1 定了 `JIRA_ONLY_COMMAND` / `NO_JIRA_TARGET`，未实现 | 阶段 2 |
| `focus_files` 语义未回填设计文档 | 见 §3 偏差 5 | 随阶段 2 |
| `core` 仍有 4 处 `print` | 全在明确标注 deprecated 的兼容 shim 里，正常路径不触发 | 阶段 3 前确认 |
