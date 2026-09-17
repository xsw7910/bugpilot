# BugPilot 多入口与多输入设计 — CLI / MCP / VS Code 扩展

本文记录把 BugPilot 从「单一 CLI + Jira issue 输入」扩展为「三个入口、多个 bug 输入源
共用一个内核」的需求、就绪度评估、目标架构和实施计划。第一版的目标是
Feature-rich Internal Beta，直接供其他程序员试用，而不是仅做技术验证。

- **面向读者**：要改 BugPilot 本身的开发者。
- **前置阅读**：[architecture.md](architecture.md)（现有分层与产物流水线）、
  [usage_guide.md](usage_guide.md)（命令语义）、[safety.md](safety.md)（安全边界）。
- **本文不重复** architecture.md 的内容；只描述**新增的领域模型与 adapter 层**，
  以及为此需要对现有代码做的改动。
- **状态**：设计草案，未开始实施。

---

## 1. 产品定位

长期定位不再是 "Jira bug helper"，而是：

> **BugPilot turns a bug report into focused code context for AI coding agents.**

### 1.1 三个入口的用户心智模型

这是正式产品原则，应同步写入 [architecture.md](architecture.md)：

```text
Automation        -> CLI
Agent-driven      -> MCP
Developer-driven  -> VS Code Extension
```

对外一句话解释：

> Use the VS Code Extension when you want to control the investigation.
> Use MCP when you want the AI agent to drive the investigation.
> Use the CLI for automation and scripted pipelines.

### 1.2 输入源可扩展

```text
Jira issue          -> BugSpec -> workflow
Manual description  -> BugSpec -> workflow
Future adapters     -> BugSpec -> workflow
```

未来可自然扩展 GitHub Issue、Azure DevOps、clipboard、selected text、log/stack trace，
而无需重写 core。这个定位是 §2.2 中 R7（Jira 不是核心依赖）的动机。

**阶段 7 的结论：暂不新增任何 adapter。** 理由不是成本高——`BugSpec` 与
`bug_spec_from_description` 已经把成本压到「解析 + 一个 `source` 值」——而是
**没有证据**。manual 模式已经能吃下任何粘贴进来的文本（包括 stack trace 与
日志片段），所以新 adapter 的唯一增量价值是「自动取回内容」。触发条件写在这里，
满足任一条再动手：

| 候选 adapter | 该做的信号 |
| --- | --- |
| GitHub Issue / Azure DevOps | 有人**实际**在这些系统里报 bug，且已经出现「手工复制 issue 正文」的重复劳动 |
| clipboard / selected text | 有人反馈「粘贴到面板」这一步是摩擦点（目前面板就是粘贴板，摩擦未被证实） |
| log / stack trace | 出现「同一份 stack trace 反复被人工整理成 description」的模式 |

在此之前，新增 adapter 会增加三个入口都要覆盖的表面积，换来一个假想的便利。

---

## 2. 需求

### 2.1 背景

当前 BugPilot 只有一个入口：`bugpilot <command>`，且只接受 Jira issue 输入。
这带来三类摩擦：

| 摩擦 | 表现 |
| --- | --- |
| 命令记忆负担 | 完整流程 9 条命令、25 个子命令，新人需要照着 usage_guide 敲。 |
| Agent 交接绕路 | `agent_runner.py` 起子进程拉起 `claude`/`copilot`，再塞一句 handoff prompt 让它去读 `agent_task.md` —— 方向是「工具启动 agent」。 |
| 产物不可见 | `.ai/<issue>/` 下 20 个产物文件只能靠手动打开，工作流进度只在 `workflow_status.json` 里。 |

### 2.2 需求条目

- **R1 — 保留 CLI 作为一等入口。** 现有命令的名称、参数、输出、退出码不得改变。
  终端用户零感知。这是硬约束，不是兼容性妥协。
- **R2 — Agent 可直接驱动流程。** 让 VS Code 里的 Claude Code / Copilot Chat 能
  把调查步骤当工具调用，而不是由 BugPilot 反向拉起 agent。
- **R3 — 非 CLI 用户可用。** 不熟悉终端的同事能在 VS Code 里完成完整调查：
  选择输入源、填写描述与 hint、选择调查范围、看到实时进度、浏览产物、交接给 agent。
- **R4 — 单一内核。** 三个入口共用 `bugpilot/core/`，不允许出现第二份工作流实现，
  也不允许步骤选择逻辑在三个 adapter 里各写一遍。
- **R5 — 安全边界不放宽。** 对外动作（Jira 评论、邮件、commit、push）在任何入口
  下都必须是显式、人工确认的。agent 不得能自主触发。
- **R6 — 凭据处理不退化。** 新入口不得引入比现状更弱的凭据存储方式。
- **R7 — Jira 不是核心依赖。** BugPilot 必须支持两类等价输入：Jira issue 与手工 bug
  描述；两者在进入 workflow 前统一归一化为 `BugSpec`，后续步骤不得依赖 Jira。
- **R8 — 第一版 VS Code 扩展就做完整且打磨过的 UI。** V1 既不做功能裁剪，也不做
  界面降级：界面须达到 §5.4 的质量标准（主题适配、窄宽度可用、键盘可达、
  三态齐备），而不只是「功能点都在」。V1 不做功能裁剪：输入源切换、hint、
  keywords、focus/ignore、调查范围选择、Run/Stop、实时进度、产物浏览、history、
  agent handoff、诊断全部做出来。范围风险已知并接受（见 §10）。
- **R9 — 不依赖目标仓库配置。** BugPilot 在目标仓库没有任何 BugPilot 专用配置
  （包括 `CLAUDE.md`）的情况下必须完整可用。仓库侧配置只能是可选增强。

### 2.3 非目标

- 不做 Web UI、不做服务端部署。
- 不改变 prepare-only 的产品定位：BugPilot 不自动提交/推送/开 PR。
- 不要求 bug 必须先存在于 Jira；手工描述、粘贴日志或 stack trace 可以直接作为输入。
- 不把全部 25 个子命令都暴露给 agent（见 §5.2）。
- 不支持除 VS Code 之外的编辑器（JetBrains 等）—— MCP 入口天然可移植，扩展入口不做。
- 不自造设计语言：界面必须看起来像 VS Code 原生的一部分，不引入自有品牌视觉。
  「打磨」的含义是主题一致、状态完备、可访问，不是视觉上出彩（见 §5.4）。

---

## 3. 就绪度评估与领域模型

### 3.1 已经满足的

| adapter 需要的能力 | 现状 | 位置 |
| --- | --- | --- |
| 可靠退出码 | 是。`main(argv) -> int`，21 条 `return 1` 路径 | `cli.py` |
| 错误不污染 stdout | 是。39 处 `file=sys.stderr` | `cli.py` |
| 结构化工作流状态 | 是。`workflow_status.json` 含 `steps` 状态机（24 阶段）+ `generated_files` | `workflow.py` |
| 数据/展示分离 | 是。`collect_doctor_report() -> dict` 与 `doctor_report_lines()` 已拆开 | `doctor.py` |
| 非交互 setup | 是。`run_setup(prompt=, prompt_secret=, out=)` 全部可注入 | `setup.py` |
| step 函数可独立调用 | 是。每个 `*_step(repo_root, issue_key, ...)` 都能单独跑 | `workflow.py` |
| **逐步进度回调** | 是。`run_bug_workflow(progress=Callable[[str], None])`，在 10 个步骤点已有调用 | `workflow.py:194` |
| 产物即接口 | 是。步骤间通过文件通信，不互相调用 | architecture.md §1 |
| 零运行时依赖 | 是。仅标准库 | `pyproject.toml` |

已有的 `progress` 回调是 §5.1 中 `--json-lines` 的天然挂点 —— 不需要新增 hook，
只需把 CLI 现在传进去的人类可读打印器换成 JSONL 发射器。

### 3.2 需要处理的

| 问题 | 细节 | 影响 |
| --- | --- | --- |
| **core 有 stdout 输出** | 12 处 `print`，集中在 `copilot.py`（10）和 `doctor.py`（2）。都是「打印报告」函数。MCP 走 stdio 时 stdout 是 JSON-RPC 通道，任何 `print` 都会破帧。 | MCP |
| **无机器可读输出** | 各命令正常输出是人类文本（`print(f"Generated: .ai/...")`）。 | 扩展 |
| **首个运行时依赖** | MCP server 需要 `mcp` 包，会打破「零依赖」契约。 | MCP |
| **多份安装并存** | 同一台机器上 pipx 副本（`~/.local/bin/bugpilot.exe`）与 editable 安装（仓库）并存，且 PATH 指向前者。扩展不能硬编码路径。 | 扩展 |
| **work item 身份混乱** | 三个正则、两份实现，语义未分离。详见 §3.4。 | 领域模型 |
| **步骤选择无 core 契约** | 现在只有 `WORKFLOW_STEPS`（24 个实现阶段）和各自的 `*_step` 函数，没有面向用户的逻辑调查范围概念。 | 三入口漂移风险 |

`copilot.py` 曾是唯一没做数据/展示分离的模块。**已拆开**：`collect_agent_status()`
返回 dict，`agent_status_lines()` / `auto_invocation_guidance()` 负责渲染。
旧的 `print_copilot_check()` 在无人调用后于阶段 7 的 review 中删除。

### 3.3 领域模型：InvestigationRequest

三个入口都构造同一个请求对象。它由三个正交部分组成，**不合并成一个不断膨胀的
`BugSpec`**：

```text
             INPUT

Jira ───────┐
Manual ─────┼──→ BugSpec           (bug identity / content)
GitHub ─────┘

                +

Hint / Keywords / Focus / Ignore ──→ InvestigationOptions  (retrieval config)
调查范围选择 ───────────────────────→ InvestigationPlan     (which capabilities)

                ↓

        InvestigationRequest
        ┌──────────────────┐
        │ spec:    BugSpec │
        │ options: Options │
        │ plan:    Plan    │
        └──────────────────┘
                ↓
           BugPilot Core
                ↓
        InvestigationResult
                ↓
      .ai/<work_item>/ 产物
```

#### BugSpec —— bug 的身份与内容

```python
@dataclass(frozen=True)
class BugSpec:
    work_item_id: str            # 目录与产物标识，见 §3.4
    source: str                  # jira | manual
    title: str
    description: str
    source_ref: str | None = None    # Jira 模式下的 issue key；manual 模式为 None
```

`work_item_id` 与 `source_ref` **是两个概念**。Jira 模式下两者恰好同值
（`JR-23477`），manual 模式下 `source_ref` 为 `None`。任何需要「回写到外部系统」
的代码只能读 `source_ref`，绝不能拿 `work_item_id` 当 Jira key 用。

#### InvestigationOptions —— 检索配置

```python
@dataclass
class InvestigationOptions:
    hint: str | None = None
    keywords: list[str] = field(default_factory=list)
    focus_files: list[str] = field(default_factory=list)
    ignore_paths: list[str] = field(default_factory=list)
    max_files: int = 10              # 现 search.MAX_TOTAL_RELATED_FILES
    max_search_lines: int = 300      # 现 search.MAX_TOTAL_CODE_SEARCH_LINES
```

将来新增的检索配置都进这里，不进 `BugSpec`。

`max_files` / `max_search_lines` 只是把 [search.py](../bugpilot/core/search.py) 里
已有的硬编码常量变成参数，成本极低。**必须成对暴露** —— 文件数不是唯一量纲，
片段总行数对 agent 上下文的影响更大；只给 `max_files` 会让用户以为能控制产物体积，
实际控制不了。

评审提出的另外三个候选字段**不进 V1**，理由记录在此以免重复讨论：

| 候选字段 | 现状 | 不进 V1 的理由 |
| --- | --- | --- |
| `search_scope` | 无（只有 `_is_included_path` 后缀白名单与 `NOISE_PATH_INDICATORS` 降权） | 与 `focus_files` / `ignore_paths` 语义重叠。「只搜某子树」几乎都能用 `ignore_paths` 反向表达；三个字段表达同一件事会让用户不知道该用哪个。等有真实场景证明不够再加。 |
| `dependency_depth` | 无。`search.py` 只做 ripgrep 关键词匹配 + 排序，无任何 include 图分析 | 这是**独立特性**而非参数：C++/Qt 仓库要解析 `#include`、区分 `<>` 与 `""`、处理 include 搜索路径与条件编译。不是加一个 int 就完事。 |
| `token_budget` | 无。只有按行数的段落截断（`_section_excerpt(max_lines=25/12)`） | 需要 token 计数基础设施（`tiktoken` 对 Claude 低估 15–20%，要么调 API 要么接受粗估）；且不如直接控 `max_files` / `max_search_lines` 有效且可解释。 |

**副作用要记**：`search_quality.json` 的置信度评估是按当前默认值调出来的。
用户把 `max_files` 调到 3 时质量分的含义会变（候选变少，「高置信」门槛实际被抬高）。
不影响正确性，但用户文档需提一句。

#### InvestigationPlan —— 逻辑调查范围（core 契约）

面向用户的开关是**逻辑能力**，不是实现步骤：

```python
@dataclass
class InvestigationPlan:
    issue_details: bool = True     # 拉取/规范化 bug 描述
    code_search: bool = True       # 代码检索
    git_history: bool = True       # git 上下文
    similar_fixes: bool = True     # 历史 bug 记忆检索
    build_context: bool = True     # 汇总 bug_context.md + agent_task.md
```

**core 负责把 plan 展开为 `WORKFLOW_STEPS` 并解析依赖**，adapter 不参与：

需要**两张表**，不是一张。第一张说「能力贡献哪些步骤」：

| 逻辑开关 | 贡献的 `WORKFLOW_STEPS` |
| --- | --- |
| `issue_details` | `fetch`（jira 源；manual 源自动排除）· `parse` |
| `code_search` | `keywords` · `code_search` |
| `git_history` | `git_context` |
| `similar_fixes` | `keywords` · `memory_search` |
| `build_context` | `context` · `prompt` · `memory_add` |

第二张说「步骤读哪些前置产物」（`STEP_PREREQUISITES`），由 core 做**传递闭包**：

| 步骤 | 依赖 | 原因 |
| --- | --- | --- |
| `parse` | `fetch` | 读 `jira.json`（manual 源在闭包后被排除） |
| `keywords` | `parse` | 需要已解析的 issue |
| `code_search` · `memory_search` | `keywords` | 读 `extracted_keywords.json` |
| `context` | `keywords` · `parse` | `context_step` **总是**读 `extracted_keywords.json` |
| `prompt` | `context` | 读 `bug_context.md` |
| `memory_add` | `parse` | 需要 summary |

**前置步骤即使其所属能力被关闭也会被拉进来。** 跑前置严格优于中途崩溃 ——
调用方拨的是能力，不是步骤，所以 core 有义务补齐这些能力要读的东西。
实施阶段验证过：初稿只有第一张表时，`InvestigationPlan(code_search=False,
similar_fixes=False)` 会因缺 `extracted_keywords.json` 直接 `FileNotFoundError`。

`_remove_intermediate_files`（把 `memory_search.md` / `git_context.md` 折进
`bug_context.md` 后删除它们）必须只在 `context` 实际运行后执行 —— 否则在
`build_context=False` 的 plan 下会删掉该次运行唯一的产物。

这一层是防漂移的关键：UI 里不出现 `☑ fetch ☑ parse ☑ keywords`，
CLI、MCP、扩展共用同一个 `InvestigationPlan`，依赖解析只有一份实现（不变量 7）。

### 3.4 work item identity：彻底分离，不迁就旧正则

上一版为了「零代码改动」让本地 ID 伪装成 Jira 风格 key（`LOCAL-<digits>`）。
**这个决定作废。** 理由：阶段 1 本来就要合并 key 校验并引入 `BugSpec`，
让新领域模型迁就旧正则会把技术债带进新架构；而且从语义上说，本地 ID 根本不是
issue key，让 `looks_like_issue_key("LOCAL-2609010949")` 返回 `True` 是错的。

现状（三个正则、两份实现、语义未分离）：

```text
cleanup.ISSUE_KEY_CLEAN_RE = ^[A-Za-z][A-Za-z0-9_-]*-\d+$    # 实际是「目录安全的 id」
memory.ISSUE_KEY_RE        = ^[A-Z][A-Z0-9]+-\d+$            # 实际是「Jira issue key」
workflow.looks_like_issue_key  ─┐  同一段逻辑
memory._looks_like_issue_key  ─┘  两份拷贝
```

目标：两个语义清晰、各有单一实现的判定函数。

```python
# 是否 Jira issue key —— 仅用于决定能否回写 Jira、能否走 Jira 输入 adapter
JIRA_ISSUE_KEY_RE = re.compile(r"^[A-Z][A-Z0-9]+-\d+$")
def is_jira_issue_key(value: str) -> bool: ...

# 是否合法 work item id —— 用于目录命名、cleanup containment、memory 查找
WORK_ITEM_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*[-_]\d+$")
def is_work_item_id(value: str) -> bool: ...
```

本地 ID 形态：`local_<YYYYMMDDHHMMSS>`（例如 `local_20260901094133`）。
下划线前缀使它**不可能**被 `JIRA_ISSUE_KEY_RE` 匹配，可读、可排序、目录安全、
不引入新依赖。若同秒冲突成为问题再换 ULID。

#### 不给本地 ID 加可读 slug

曾考虑把标题生成的后缀拼进目录名（`local_20260901094133_3dview-crashes-after-changing-horizon`），
以便 `ls .ai/` 时能分辨多个本地 item。**决定不做**，三条理由：

1. **ID 必须稳定，标题可改。** 用户在扩展表单里改个错别字，ID 要么跟着漂
   （产生孤儿目录），要么 slug 变成过时的误导信息。对比 `git_ops.branch_name()`
   ——那里用 slug 完全合理，因为分支名是一次性的人面向标识，不是稳定主键。
2. **现有 slug 实现对中文无效。** [git_ops.py](../bugpilot/core/git_ops.py) 的
   `summary_slug()` 第一步是 `re.sub(r"[^a-z0-9]+", "-", ...)`，非 ASCII 全部丢弃。
   实测：`三维视图切换层位后崩溃` → `''`（空）；`OpenVDS statistics 初始化失败`
   → `openvds-statistics`。若团队用中文写 bug 描述，可读性收益**时有时无**，
   比一律没有更糟 —— 用户会困惑为什么有的目录有名字有的没有。要做就得先改
   `summary_slug` 的非 ASCII 处理（保留 CJK 码点，或引入音译依赖破坏零依赖契约）。
3. **这是显示问题，不是标识问题。** `BugSpec.title` 已在产物里；扩展的
   History 与 TreeView 直接显示 title 即可，目录名保持短而稳定。

补上终端侧的可读性缺口：新增 `bugpilot list`（§5.1），列出 work item 的
id / source / title / 状态。扩展的 History 面板也消费它（走 `--json`），
不算额外成本。

`WORK_ITEM_ID_RE` 尾部的 `[-_]\d+` 是实施阶段补上的（初稿只要求「字母开头 + 安全字符」）。
现有测试 `test_clean_rejects_invalid_issue_keys_without_deleting` 揭示旧的
`ISSUE_KEY_CLEAN_RE` 还隐含一条性质：**id 必须以数字后缀结尾**，所以裸词 `HR` 不是
合法删除目标。`JR-12345` 与 `local_20260901094133` 都满足，保留这条性质不增加成本。

两个判定函数**都不做 `strip()`**：它们校验的是将要成为路径段的确切字符串，
`" JR-12345"` 与 `"JR-12345"` 是不同的目录。需要宽松匹配的调用方自己先 strip。

必须一起改的调用点：

| 位置 | 现状 | 改为 |
| --- | --- | --- |
| `cleanup.validate_issue_key` | `ISSUE_KEY_CLEAN_RE` | `validate_work_item_id` → `is_work_item_id` |
| `memory.ISSUE_KEY_RE` | Jira 形态正则 | 移到统一模块，改名 `JIRA_ISSUE_KEY_RE` |
| `workflow.looks_like_issue_key` | 拷贝 1 | 删除 |
| `memory._looks_like_issue_key` | 拷贝 2 | 删除 |
| `cli.py:395`（`memory search`） | `looks_like_issue_key(query)` | `is_work_item_id(query)` |
| `memory.py:43`（`search_memory`） | `_looks_like_issue_key(query)` | `is_work_item_id(query)` |
| `workflow._validate_comment_issue_key` | 比对 `issue_key` | 比对 `spec.source_ref`，且只在 `source == "jira"` 时可达 |

---

## 4. 目标架构

### 4.1 分层

在 architecture.md §3 的分层之上，新增一个 **adapter 层**。三个 adapter 构造同一个
`InvestigationRequest`，依赖方向严格单向。

```text
+-------------+------------------+---------------------+
|  CLI        |  MCP server      |  VS Code 扩展        |
|  cli.py     |  mcp_server.py   |  TypeScript          |
|  (已有)      |  (新增, import)   |  (新增, spawn CLI)   |
+------+------+--------+---------+----------+----------+
       |               |                    |
       | import        | import             | spawn `bugpilot --json[-lines]`
       v               v                    |
   +-------------------------------+        |
   |  InvestigationRequest         |<-------+
   |  = BugSpec + Options + Plan   |
   +-------------------------------+
                |
                v
   +-------------------------------+
   |   bugpilot/core/              |
   |   plan 展开 · workflow · 18 模块 |
   +-------------------------------+
                |
                v
   InvestigationResult  ->  .ai/<work_item>/  ·  .ai_memory/bugs/
```

两种接入方式的取舍：

- **MCP `import core`** —— 同进程，无序列化开销，能直接拿到 `InvestigationResult`
  这类 dataclass。代价是必须遵守 stdout 纪律。
- **扩展 `spawn CLI`** —— 进程隔离，扩展崩溃不影响流程，且天然复用 CLI 已经
  验证过的参数解析和退出码。代价是要解析 JSON 输出。

不让扩展直接 `import core` 是刻意的：那需要在扩展里嵌一个 Python 桥，
而 spawn CLI 让 R1（CLI 是一等入口）从「约定」变成结构性事实 ——
扩展坏了 CLI 照常工作，CLI 坏了扩展立刻暴露。

### 4.2 不变量

1. `core/` 不感知调用方。不得出现 `if running_under_mcp` 之类的分支。
2. `core/` 的任何函数不向 stdout 写。人类可读输出只在 `cli.py` 里发生。
3. 每个 `*_step` 返回结构化数据；渲染成文本是 adapter 的职责。
4. 对外动作一律带 `execute: bool = False`，默认不执行。
5. Jira 只存在于 input adapter / integration 层，workflow core 接收 `BugSpec`。
6. **评审规则（非运行时约束）**：MCP 暴露的工具集中不含任何写源码的操作，
   这由 §5.2 的工具清单保证，没有代码强制。新增 MCP 工具时必须确认其写入范围
   不超出 `.ai/` 与 `.ai_memory/`；`cleanup._ensure_child` 只守删除路径，不守写入。
7. **`InvestigationPlan` 到 `WORKFLOW_STEPS` 的展开与依赖解析只在 core 里有一份
   实现。** adapter 只传 plan，不自己决定跑哪些 step。
8. `work_item_id` 与 `source_ref` 不得互换使用（§3.4）。
9. BugPilot 不依赖目标仓库中的任何 BugPilot 专用配置（R9）。

---

## 5. 各入口规格

### 5.1 CLI（不变 + 两个加法）

25 个子命令、参数、输出、退出码全部不变。新增两项，都是纯加法。

#### `--json`：最终结果

需要 `--json` 的命令（扩展要消费的）：

```text
bug · fetch · search · context · status · list · check-results
summarize-results · delivery-check · doctor
```

`list` 是新增命令（§3.4）：列出 `.ai/` 下所有 work item，补上本地 ID 不带 slug
后终端侧的可读性缺口，同时作为扩展 History 面板的数据源。

```text
$ bugpilot list
JR-23477              jira    Amplitude Spectrum min/max not converted to dB   prepared
local_20260901094133  manual  三维视图切换层位后崩溃                             fixed
local_20260828171205  manual  OpenVDS statistics 初始化失败                     prepared
```

`bug` 主入口同时支持两种输入：

```text
bugpilot bug JR-12345
bugpilot bug --description "3D view crashes after changing horizon"
bugpilot bug --description-file bug.txt
```

`InvestigationOptions` 与 `InvestigationPlan` 的对应参数：

```text
--hint  --keywords  --focus-file  --ignore-path          # Options
--max-files  --max-search-lines                          # Options（成对，见 §3.3）
--skip-code-search  --skip-git-history                   # Plan
--skip-similar-fixes  --only-issue-details               # Plan
```

JSON 是 adapter API，第一版即带版本号。成功：

```json
{
  "schema_version": 1,
  "ok": true,
  "command": "bug",
  "work_item_id": "JR-12345",
  "source": "jira",
  "source_ref": "JR-12345",
  "issue_dir": ".ai/JR-12345",
  "generated_files": ["..."],
  "warnings": []
}
```

失败时 stdout 仍只输出一个 JSON 对象，stderr 保留人类可读错误：

```json
{
  "schema_version": 1,
  "ok": false,
  "command": "bug",
  "error": { "code": "JIRA_AUTH_FAILED", "message": "..." }
}
```

扩展不得解析错误文本，只能依赖稳定 `error.code`。

**`--json` 与 `--json-lines` 从不拉起 agent。** 机器模式的调用方要么自己处理交接，
要么走 §5.6 的续接路径；在这两种模式下启动一个交互式 agent 会把它的输出混进
本该只有结构化数据的 stdout。帮助文本里写明了这条。

**进度编号按实际会跑的步骤算**，不是固定的 `[N/9]`。manual 少一个 `fetch`，
部分 plan 更少；数到一个永远不会到达的总数读起来像卡住了。`parse` 的人类文案
按来源区分（Jira 保留原文案）以满足 R1。

#### `--json-lines`：实时事件流

`--json` 只在结束时给一个对象，进度得靠扩展去 watch `workflow_status.json`，
等于两条通信通道。`--json-lines` 把实时进度也变成 stdout 上的结构化事件：

```jsonl
{"schema_version":1,"type":"started","work_item_id":"JR-23477","source":"jira"}
{"schema_version":1,"type":"step_started","step":"fetch"}
{"schema_version":1,"type":"step_completed","step":"fetch"}
{"schema_version":1,"type":"step_started","step":"code_search"}
{"schema_version":1,"type":"artifact","path":".ai/JR-23477/code_search.md"}
{"schema_version":1,"type":"step_skipped","step":"memory_search","reason":"plan"}
{"schema_version":1,"type":"completed","ok":true}
```

职责因此划清：

```text
JSONL                 = live events（进程存活期间）
workflow_status.json  = persisted state / recovery（进程结束后仍可读）
```

实现代价很小：`run_bug_workflow` 已有 `progress: Callable[[str], None]` 回调，
在 10 个步骤点调用（`workflow.py:194`）。CLI 只需把现在传进去的人类可读打印器
换成 JSONL 发射器。`--json-lines` 放**阶段 2**，与 `--json` 同批交付。

#### manual 模式下 Jira 相关命令的行为

R7 把 Jira 降级为可选输入，Jira 相关的**出口**必须同步定义：

| 命令 | `source == "manual"` 时 |
| --- | --- |
| `fetch` · `jira-validate` · `parse` | 明确失败，`error.code = "JIRA_ONLY_COMMAND"`。 |
| `jira-comment-draft` | 明确失败，`error.code = "NO_JIRA_TARGET"`（`source_ref is None`）。 |
| `jira-comment --execute` | 同上。 |
| `summarize-results --jira-comment` | 拒绝该 flag（`NO_JIRA_TARGET`）；不带 flag 时正常生成 `result_summary.md`。 |
| `notify` · `commit-plan` 邮件 | 降级：正文改用 `spec.title` / `spec.description`，不读 `jira_summary.md`（manual 模式下不存在）。 |
| 其余命令 | 不变，只依赖 `InvestigationRequest` 与 repo。 |

`source` 的检查发生在 CLI dispatch 层（`cli.py`），不下推到 `core/`，以维持不变量 5。

### 5.2 MCP server

新增 `bugpilot/mcp_server.py`，用官方 Python SDK 的 `MCPServer`
（`from mcp.server.mcpserver import MCPServer`），stdio transport。

初稿写的是 `FastMCP`；那是 mcp 1.x 的名字，2.x 已改名 `MCPServer`，字段也从
camelCase 改成 snake_case（`inputSchema` → `input_schema`）。选用 2.x 而非
`pin mcp<2`：为对齐一份文档而钉住一个已被取代的大版本，代价更大。

**工具必须抛 SDK 自己的 `ToolError`**（`mcp.server.mcpserver.exceptions`）。
本地定义的同名异常类不被 SDK 识别，会被当成崩溃包成 `UnexpectedToolError`，
模型只看到 `Error executing tool <name>`，工具里写的可操作提示全部丢失。

**工具粒度是粗的**，且尽量表达**意图**而非实现步骤 —— 工具列表每轮都进模型上下文，
25 个工具会稀释判断力。暴露 7 个：

| 工具 | 包装 | 说明 |
| --- | --- | --- |
| `prepare_jira_bug` | Jira input → core | Jira 主入口。description 写明「用户给出 issue key 时用这个」。 |
| `prepare_bug_description` | Manual input → core | 无 Jira 主入口。description 写明「用户只给出自然语言描述、日志或 stack trace，且没有 issue key 时用这个」。 |
| `refine_investigation` | Options 更新 → 重跑相关 plan 部分 | **取代 `search_code`。** agent 拿到新线索时表达的是「按这个方向重新调查」，不是「跑一次 grep」。 |
| `check_results` | `check_result_files` | 返回缺失的结果文件列表。 |
| `summarize_results` | `summarize_results_step` | Jira comment 默认 false。 |
| `search_memory` | `search_memory` | 跨 Jira 与本地 work item 找相似历史 bug。 |
| `get_status` | 读 `workflow_status.json` | 只读。 |

`refine_investigation` 的形态：

```python
refine_investigation(
    work_item="JR-23477",
    hint="Focus on OpenVDS statistics initialization",
    keywords=["OpenVDS", "statistics", "initialize"],
)
```

BugPilot 自己决定重跑哪些环节（code search → git history → memory → context 再生成），
agent 不需要知道内部步骤。

实现上它**不走 `run_investigation`**，而是 core 里独立的 step 序列，从 `keywords` 起跑。
原因：§3.3 的前置闭包会因 `parse` 依赖 `fetch` 而把 Jira 抓取拉回来，
使每次 refine 都要联网。issue 数据已在磁盘上（`jira.json` 或 `bug_spec.json`），
增量重查不该重新获取它。**一个依赖模型服务「从零构建」时正确，
不代表它服务「增量更新」时也正确。**低层的 `bugpilot search --json` 仍在 CLI 上可用，
供脚本化场景使用 —— 只是不暴露给 agent。

两个 `prepare_*` 工具的 description 必须**互斥说明**，否则给了 Jira key 的时候
模型可能调错那个。

**不暴露**：`jira-comment --execute`、`notify --execute`、`commit`、`push`、
`clean`、`setup`。前四个是对外/破坏性动作（R5），后两个不该由模型触发。

MCP server 默认绑定启动时的 repo/workspace root，允许 server 配置覆盖，
tool 参数不让模型自由传 `repo_root`。

另外提供一个 MCP prompt（在 Claude Code 里表现为斜杠命令
`/mcp__bugpilot__fix_bug`），给不想赌模型判断的确定性路径。

**对 `agent_runner.py` 的影响**：V1 只标记 deprecated，不立即删除，作为内部 Beta
fallback。MCP 稳定并确认团队完成迁移后再移除。

**目标仓库 `CLAUDE.md`**：文档中提供推荐片段，提高 agent 调用 BugPilot 的概率，
但**架构不得依赖它**（R9 / 不变量 9）。推荐片段：

```markdown
When investigating a bug or Jira issue, use the BugPilot MCP tools to gather
focused engineering context before performing broad repository searches.
```

### 5.3 VS Code 扩展（V1 即完整功能）

按 R8，V1 既不做功能裁剪也不做界面降级。扩展仍是薄壳 —— 只负责 UI 和进程调度，
不含业务逻辑 —— 但界面须达到 §5.4 的质量标准。

**控件选型**：主输入面板用 **Webview**，产物浏览与 history 用**原生 TreeView**。
理由：主面板是一个 7 字段表单加 5 个范围勾选，VS Code 原生输入只有
`showInputBox` / `showQuickPick`（模态、顺序式），对这种表单是糟糕的交互；
而 TreeView 恰好适合层级只读浏览，用 Webview 反而更差。不要为了统一而全用
Webview 或全用原生。

| 分组 | 能力 | 实现 |
| --- | --- | --- |
| 输入 | 输入源切换（Jira Issue / Bug Description） | Sidebar 表单 |
| 输入 | Issue key · Title · Description | 表单字段 → `BugSpec` |
| 输入 | Hint · Keywords · Focus files · Ignore paths | 表单字段 → `InvestigationOptions` |
| 调查范围 | Issue details · Code search · Git history · Similar fixes · Build context | 勾选框 → `InvestigationPlan`。**不暴露 `fetch`/`parse`/`keywords` 等实现步骤**（§3.3） |
| 运行 | Run · Stop | spawn / kill CLI 子进程 |
| 运行 | 实时进度 checklist | 消费 `--json-lines` 事件流；`workflow_status.json` 作为重启后的恢复源 |
| 产物 | Artifact TreeView | 扫 `.ai/*` 列出 Jira 与本地 work item，展开显示产物，点击在编辑器打开 |
| 产物 | Markdown 预览 | VS Code 内置预览，不自造渲染器 |
| 历史 | Work item history | 最近条目列表，可重新打开、重跑、查看状态 |
| 交接 | Open `agent_task.md` · Copy handoff prompt | 一键操作 |
| 交接 | MCP status / Continue with Claude | 检测到 MCP 时提示 |
| 诊断 | Doctor · Agent Check · Clean | 命令面板项 → spawn CLI |
| 诊断 | 安装向导 | 未找到 CLI 时显示 Install Instructions / Choose Executable / Retry |
| 配置 | `bugpilot.executablePath` | 默认 `"bugpilot"`（走 PATH），支持选择 executable |
| 配置 | 凭据 | Jira token 存 VS Code `SecretStorage`，运行时以环境变量注入子进程；manual 模式不需要 Jira 凭据 |

V1 参考布局（信息层级示意，非视觉稿；实际样式由 §5.4 的主题变量决定）：

```text
BUGPILOT
─────────────────────────
Input
 ● Jira Issue   ○ Bug Description

Issue      [ JR-23477            ]
Hint       [ optional            ]
Keywords   [ optional            ]

Investigate
 ☑ Issue details    ☑ Code search
 ☑ Git history      ☑ Similar fixes
 ☑ Build context

        [ Prepare Bug ]  [ Stop ]

Progress
 ✓ Issue details
 ✓ Code search
 ● Git history
 ○ Similar fixes
 ○ Build context

        [ Open agent_task.md ]
```

**面板是一条线，不是三个区块**（2026-09-07 重构）。原来同一次运行被描述在三处：
Investigate 复选框组、Progress checklist（重复同样五个标签）、结束后出现的
Hand off 卡片。现在合成**一行一步**：复选框（选不选）与状态图标（跑得怎样）
在同一行上。

模型在 `app/workflow.ts`，由 host 每次 push 时算出来。**页面不自己造这些行**——
行是静态 markup，因为复选框属于页面（是表单状态），状态属于 host（是运行结果），
静态行是让这两件事同时成立的唯一办法。

三个不对称之处，都是有意的：

- **`fixWithAI` 不是 CLI 能力**，不进 `form.plan`。plan 里每一项都会变成一个 flag，
  而这一项描述的是**进程退出之后**扩展做什么。有测试断言它一个参数都不产生——
  否则 `--prepare-only` 就不再对面板发起的每次运行都成立。
- **它从不报 "Complete"。** agent 跑在扩展并不拥有的终端里，"AI 修完了"在这里
  不可知。能诚实说的最后一句是「已交接」，写在那一行的 `detail` 里。
- **行上的图标跟着文件走，不跟着事件走。** 图标出现是因为它要打开的那个文件在。
  按步骤事件来判断会给一个运行没来得及写的文件配上图标——而且会让从 History
  恢复的 work item 一个图标都没有（那里根本没有事件流）。

**「Fix with AI」是工作流的最后一步**。它开一个终端、在**仓库根**跑
`<agent> "<交接语>"`。四点说明：

- **不违反 R5。** deprecated 掉的是 CLI **默认**自动拉起 agent；一个人勾上的复选框
  正是 R5 要的那个「独立的决定」——所以它**默认不勾**。运行本身仍然是 prepare-only。
- **措辞与机制分开。** UI 里没有一处写 Claude（除了 agent 选择器里的那一项，
  有测试扫描 markup 断言这一点）。机制在 `app/agents.ts`：加一个 provider 是加
  一行表。表里只有 `claude`，因为只有它的调用方式是在真机上量过的；其余用
  **自定义命令**（`{prompt}` 占位）——谁在用 Codex/Gemini 就谁知道它的 flag，
  一句模板胜过我们的猜测。
- **不往 Claude Code 面板里推文字。** 实测那个扩展（`anthropic.claude-code`
  2.1.263）贡献 26 个命令，**没有一个接受 prompt** —— 唯一的入口是猜它未公开的
  参数形状，而那会在它下次升级时静默失效。终端是可验证的机制，
  也是 `resumeAgentSession` 已经在用的那个。
- **降级链**：`claude` 不在 PATH → 复制交接语 + 尝试唤起 Claude Code 的视图
  （`claude-vscode.sidebar.open`，同样读自它的 manifest）→ 都没有则只复制并说明。
  绝不开一个只会打印 "command not found" 的终端——那看起来像我们的 bug。

交接语与其他四处同源（`handoff.py`），有测试断言按钮传的与 Copy handoff
复制的**是同一句**。

**CLI 可用性是五态，不是布尔**（阶段 4 落地，`extension/src/executable.ts`）。
判断方式不是「在 PATH 上」而是一次 `doctor --json` 握手：它不需要 work item、不联网，
且只有实现了阶段 2 信封的版本才会成功。五态各自对应**不同的建议**，这是分开的全部理由：

| 裁决 | 含义 | 该说的话 |
| --- | --- | --- |
| `ready` | 握手成功 | 无 |
| `not-found` | 不在 PATH，或配置的路径不存在 / 不可执行 | 装一个，或配 `bugpilot.executablePath` |
| `incompatible` | 能跑但不认 `--json`——几乎总是版本太旧 | 升级 bugpilot |
| `unresponsive` | 握手超时。**对版本不作任何断言** | 再试一次（冷启动 / 杀毒扫描） |
| `unhealthy` | 会说契约，但 `doctor` 自己失败了 | 交给 `error.code` 映射表，不另写解释 |

把后两态归入 `incompatible` 会建议用户去升级一个完好的 bugpilot——一个格式正确的
失败信封恰恰**证明**了二进制实现了契约。

**凭据在 `SecretStorage` 里只占一个 key**（`bugpilot.jiraCredentials`，值为
`{email, token}` 的 JSON）。email 与 token 分两个 key 意味着两次顺序写，第二次失败
会留下新 email 配旧 token——这个状态会被判为「已配置」并照样注入，产出一个指向错误
原因的 `JIRA_AUTH_FAILED`。一个 key 让保存原子；解析失败读作「未配置」而不是从每条
命令里抛异常。

**扩展落地后确定的四件事**（阶段 5，代码为准）：

1. **没有 bundler，因此「宿主计算、页面渲染」。** Webview 是另一个 JS 上下文，
   无法 import `form.ts` / `progress.ts` / `artifacts.ts`。页面只拥有「已输入但
   未运行的表单」，其余全部由宿主算好推过去（一条 `state` 消息）。
   副产品是校验、进度、产物分组全都在 `node --test` 里可测。
2. **plan 的五个复选框有一处耦合，因为 CLI 表达不了解耦。** 没有
   `--skip-build-context`：关掉 Build context 只能用 `--only-issue-details`，
   而它会同时关掉搜索、历史、相似修复。面板据此把那三项变灰并说明原因——
   五个独立复选框会显示一个从未运行过的 plan。
3. **扩展默认 `--resume`，与 CLI 默认相反。** CLI 默认 `--fresh`（删除既有产物），
   而面板上要删必须显式勾选并通过模态确认。理由见阶段 3：`fresh=True` 删掉过
   agent 写的 `fix_summary.md`。
4. **Retry 用 `--json` 而非 `--json-lines`。** CLI 的 retry 分支只认 `--json`；
   两者都不给会**在终端拉起 agent**。照 Run 的模式传 `--json-lines` 的后果是：
   人类文本被事件读取器全部丢弃（看起来像崩了），同时背地里起了一个 agent。

**图标的偏差**：Webview 内用文本字形（✓ ● ○ – ✕）而非 Codicon 字体——后者要引
`@vscode/codicons` 依赖并放宽 CSP 的 `font-src`。原生 TreeView 仍用 `ThemeIcon`，
即真 Codicon。§5.4「图标只用 Codicons」的本意是不引第三方图标集，文本字形同样
满足，且顺带满足「状态不只靠颜色区分」。

**手测清单**：§5.4 里无法自动化的验收项（四主题、三档宽度、纯键盘、重启恢复、
安全边界）已落成可执行清单：[manual_qa_phase5.md](manual_qa_phase5.md)。

---

### 5.4 UI 质量标准（V1 验收项）

R8 要求第一版界面就打磨到位。「打磨」在这里有明确定义，每条都可验收 ——
否则界面工作没有边界。

#### 主题与视觉

- **只用 VS Code 主题 CSS 变量**（`--vscode-foreground`、`--vscode-input-background`、
  `--vscode-button-background`、`--vscode-focusBorder` 等）。**禁止硬编码任何颜色值。**
  验收：在 Light / Dark / High Contrast Dark / High Contrast Light 四种主题下
  逐一截图，无不可读文本、无失踪边框。
- **不使用 `@vscode/webview-ui-toolkit`** —— 该组件库已停止维护。用原生 HTML
  控件加主题变量，样式与 VS Code 表单一致即可。
- **图标只用 Codicons**，与编辑器其余部分同源；不引入第三方图标集。
- 不引入自有品牌色、渐变、圆角风格。界面应看起来像 VS Code 的一部分。

#### 布局

- **窄宽度可用**：侧边栏可被拖到约 200px，表单必须在该宽度下不出现横向滚动、
  标签不截断。验收：200px / 300px / 500px 三档宽度手测。
- **可在编辑器区打开**：宽布局下允许把主面板作为 editor tab 打开（`ViewColumn`），
  给多字段输入更多空间。侧边栏与编辑器区共用同一个 Webview 实现。

#### 状态完备（三态齐备）

每个视图都必须设计三种状态，不能只做 happy path：

| 视图 | 空状态 | 加载/运行中 | 错误状态 |
| --- | --- | --- | --- |
| 主输入面板 | 首次使用引导（选输入源） | Run 后按钮禁用 + 当前 step | `error.code` 映射后的可读提示 + 重试入口 |
| 进度 checklist | 尚未运行 | 逐步点亮，含每步耗时 | 失败步骤就地标红并展示原因 |
| Artifact TreeView | 该 work item 无产物 | 扫描中 | `.ai/` 不可读时的提示 |
| History | 无历史记录 | — | 目录损坏时降级为空列表而非报错 |
| CLI 未安装 | 安装向导（Install / Choose Executable / Retry） | 检测中 | 检测失败原因 |

- **失败必须就地可读**：把 `error.code` 映射为用户语言的说明与下一步动作，
  不把原始 stderr 甩给用户（映射表在阶段 4 交付）。

#### 可访问性

- 全部交互控件**键盘可达**，Tab 顺序符合视觉顺序，焦点环使用 `--vscode-focusBorder`。
- 每个输入有关联 `<label>`；纯图标按钮有 `aria-label`。
- 进度 checklist 的状态变化通过 `aria-live` 播报，不只靠颜色区分。
- 验收：仅用键盘完成一次完整调查流程（不碰鼠标）。

#### 状态保持

- 面板隐藏后重新显示，表单内容不丢失。优先用 `getState`/`setState` 持久化，
  **不要**依赖 `retainContextWhenHidden`（常驻内存代价高）。
- 扩展重启后，进度视图从 `workflow_status.json` 恢复（JSONL 只覆盖进程存活期间）。

#### Webview 安全边界

- Webview 设置严格 CSP，`localResourceRoots` 限定到扩展目录，禁用远程资源。
- **Jira token 绝不进入 Webview。** 凭据只在扩展宿主进程中从 `SecretStorage` 读取，
  以环境变量注入 CLI 子进程。Webview 通过 `postMessage` 只传非敏感表单字段。
- Webview 不直接 spawn 进程；所有执行经由扩展宿主，保持 §4.1 的边界。

### 5.5 Claude Code Skill（阶段 7 已落地）

**Skill 不是第四个入口。** 它是 CLI 入口之上的一层触发垫片 —— 一个 `SKILL.md`
告诉宿主 agent「什么时候该跑 `bugpilot`、跑完读哪些产物」，实际执行仍由宿主
自己的 Bash 工具完成。§1.1 的三入口心智模型不变。

#### 与 MCP 的关系

| | Skill | MCP server |
| --- | --- | --- |
| 本质 | 文件（`SKILL.md` + 可选参考文档） | 进程 + JSON-RPC（stdio） |
| 给模型什么 | 指令、流程、触发条件 | 可调用的 tools / prompts |
| 靠什么执行 | **宿主已有的 Bash / Read** | 自己带的实现与权限 |
| 上下文成本 | frontmatter 的 `description` 常驻，正文按需读取 | 7 个工具的 schema 每轮常驻 |
| 对 BugPilot 的改动量 | **零** —— 不需要 `--json`、不需要清理 core stdout、不需要 `mcp` 依赖 | §6 的全部共享前置工作 |
| 分发 | 放一个目录（`.claude/skills/<name>/`） | 装依赖 + 配 `.mcp.json` + 管进程 |
| 跨客户端 | 各家格式不通用 | 标准协议，任何 MCP 客户端可接 |

MCP 相比 Skill 真正多出来的三样，也正是保留 MCP 阶段的理由：

1. **在没有 shell 权限的客户端也能用** —— Skill 那条路完全依赖宿主有 Bash。
2. **结构化返回** —— agent 直接拿到 `generated_files` 列表和 `error.code`，
   不用去解析 `print` 出来的人类文本。
3. **跨客户端标准** —— Copilot Chat 与其他 MCP 客户端都能接。

#### 决策：延后，但保留在计划里

如果目标只是「Claude Code 里说 `please fix JR-12345` 能触发准备流程」，Skill 就够了，
成本是 MCP 的百分之几，且当天可测。但 V1 的目标包含跨客户端与结构化契约（R2 + R4），
这两条 Skill 给不了，所以 **MCP 仍是 V1 的 agent 入口，Skill 推到 V1 之后**。

延后的代价要记清：阶段 0A 本可以用一个 `SKILL.md` 零改动验证「模型会不会优先调用
BugPilot 而不是自己 grep」这个假设，改用 MCP 原型验证同一假设成本更高。
这是明知的取舍，不是遗漏。

**已落地**（阶段 7）：`skills/bugpilot-investigate/SKILL.md`，安装与对照方法见
[skill_setup.md](skill_setup.md)。交接文案的漂移问题按下面这段的要求解决了——
四处（CLI 启动 prompt、MCP `fix_bug`、扩展的 Copy handoff、Skill）现在都从
`bugpilot/core/handoff.py` 渲染，`tests/test_handoff.py` 双向守着，
其中扩展那一份由 TS 测试读 Python 源码比对。

落地时的形态（当时的草稿，实际文件更长，多了 retry 循环与「命令不存在时怎么办」）：

```markdown
---
name: bugpilot-investigate
description: Prepare focused code context for a bug before investigating.
  Use when the user references a Jira issue key (JR-12345) or describes a bug
  and asks to fix, investigate, or analyze it — before searching the codebase.
---

1. 运行 `bugpilot bug <ISSUE>`（或 `bugpilot bug --description "..."`）。
2. 读 `.ai/<ISSUE>/agent_task.md` 与 `bug_context.md`。
3. 按 `agent_task.md` 完成分析与修复，在 commit gate 停下。
4. 不要自行 commit、push 或发 Jira 评论。
```

注意它与 §5.2 的 MCP prompt（`/mcp__bugpilot__fix_bug`）内容高度重叠 ——
两者都是「交接指令」的载体。Skill 落地时应与 MCP prompt 共用同一份文案来源，
避免两处漂移。

### 5.6 未修复时的续接路径

`bugpilot bug` 跑完、agent 改了代码，但 bug 没修好 —— 这是最常见的真实路径，
三个入口都必须给出明确的下一步。

#### 现状：机制已存在，可发现性是缺口

`workflow.retry_prompt_step` 已经把续接做完了：

```text
bugpilot retry-prompt JR-12345
  → user_feedback.md          （模板，给开发者填「哪里没修好」）
  → agent_retry_prompt.md，内含：
       · 必读产物清单（只列实际存在的文件）
       · 开发者反馈（上限 3000 字符）
       · 上次尝试摘要（5 个结果文件各截 800 字符）
       · 重试指令（先解释为何失败、重查实现位置、禁止大范围重构）
       · delivery block + 必需输出文件 + 交接语
```

问题是**没人知道它存在**：`retry-prompt` 只出现在 README 的命令表和
usage_guide 的命令参考里，[usage_guide.md](usage_guide.md) 的
「Recommended Real Workflow」**一次都没提**（grep 计数 0）。
用户跑完发现没修好，流程就断在这里。

#### 关键前提：信息保留已经不是问题

因为 core 是 artifact-as-interface 的设计，所有状态都在 `.ai/<work_item>/` 的文件里，
不在 agent 的会话里。`_previous_attempt_summary` 把 5 个结果文件嵌进重试 prompt，
`user_feedback.md` 承载人的修正 —— **重启 agent 不丢任何东西**。

所以选择「重启」还是「留在会话」的标准**不是信息会不会丢，而是上下文对不对**。

#### 决策规则

| 情况 | 选择 | 理由 |
| --- | --- | --- |
| Agent 理解对了，执行不到位（漏改一处、测试没跑） | 留在当前会话 | 推理链还有用，重启是浪费 |
| `bug_context.md` 指错文件、关键词不准、误读了 bug 描述 | **重启 + retry-prompt** | 对话再多也修不好错的输入；失败尝试留在上下文里会**锚定**模型走回同一条错路 |
| 改了输入（新 hint / keywords / focus files） | **重启** | 输入变了就该重新准备产物 |

**默认重启。** 「没修好」最常见的原因就是上下文不准，而锚定效应会让留在会话里越聊越偏。
留在会话是显式选项，不是默认。

#### 各入口如何暴露

**CLI**（阶段 2）：

```text
bugpilot bug <ISSUE> --retry                  # 生成 retry prompt + user_feedback.md
                                              # 首次生成后停下等人填写；填好再跑才拉起 agent
bugpilot bug <ISSUE> --retry --same-session    # 折中：claude -c 保留推理历史 + 注入修正上下文
                                              # 锚定问题仍在，默认关闭
```

现在这是三步手工操作（跑 `retry-prompt` → 编辑反馈 → 复制 prompt 粘给 agent），
合成一条命令，复用 `agent_runner` 的既有拉起逻辑。

**首次生成 `user_feedback.md` 后必须停下。** 模板里是占位符，不是开发者对失败的
描述；直接交给 agent 等于喂一个空的修正 —— 而那正是这个循环唯一存在的理由。
填好反馈后再跑同一条命令才会拉起 agent。

同时补可发现性：`check-results` 与 `delivery-check` 失败时打印下一步命令 ——

```text
Missing result files: fix_summary.md, test_result.md
Not fixed yet? Run: bugpilot retry-prompt JR-12345
```

**Extension**（阶段 5）：Run 旁边一个 `Retry` 按钮 —— 在编辑器打开
`user_feedback.md`，保存后执行 `bug --retry`。进度 checklist 复用同一套 JSONL 事件。

**MCP**：**不暴露 retry 工具。** 理由是 retry 的输入是**人的反馈**，不是模型的判断 ——
agent 若自己发现没修好，本来就会在会话内继续干，不需要一个工具来「重试」。
把 retry 做成工具等于让模型自己决定「我失败了，重来」，与 R5 的人在环中相悖。

这也划清了与 `refine_investigation`（§5.2）的边界，两者属于不同循环：

```text
refine_investigation  → 准备阶段，改调查方向，重跑检索          （agent 可自主）
retry                 → 修复阶段，人给反馈后重来一次            （必须人触发）
```

#### VS Code 会话续接

bugpilot 拉起的 agent 跑在终端里（`run_agent` 用 `cwd=repo_root`）。这个会话能否
转到 VS Code 的 Claude 扩展，取决于 **cwd**：Claude Code 的会话按 cwd 的 slug 分目录存储，
终端与扩展读写同一位置。

```text
~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
```

- **VS Code workspace root == `repo_root`** → slug 相同，终端会话在扩展的历史里可见、可 resume。
- **workspace root 不同**（开的是父目录或子目录）→ slug 不同 → 看不到。

两个限制：**不是实时接管**（终端会话结束后再 resume；两个活进程写同一份 transcript
不安全）；终端侧等价操作是 `claude --resume` / `claude -c`。

可选增强：agent 退出后取 `~/.claude/projects/<slug>/` 下最新修改的 `.jsonl`，
把 session id 写进 `.ai/<work_item>/agent_session.json`，让 CLI 与扩展都能直接提供
「resume 上次的 agent 会话」。**标记为脆弱** —— slug 的推导规则是 Claude Code 的
实现细节而非公开契约，升级可能失效，所以必须能优雅降级（拿不到就不显示该入口）。

## 6. 共享前置工作

MCP、Extension 和无 Jira 输入都依赖这些共享改动，应先完成：

1. **引入领域模型** —— `BugSpec` / `InvestigationOptions` / `InvestigationPlan` /
   `InvestigationRequest` / `InvestigationResult`。
2. **plan 展开与依赖解析** —— 只在 core 里实现一份（不变量 7）。
3. **统一 work item identity** —— `is_jira_issue_key` / `is_work_item_id`，
   删除两份 `looks_like_issue_key`，改掉 §3.4 表中全部调用点。
4. **Jira / Manual input adapter** —— 两类输入归一为 `BugSpec`。
5. **拆分 `copilot.py`** —— `collect_agent_status() -> dict` + `print_agent_status()`。
   消除 core 里最后的 stdout 输出。
6. **加 `--json` 与 `--json-lines`** —— §5.1。纯加法，不改既有输出。
7. **声明 `mcp` 依赖** —— 放 optional extra
   （`[project.optional-dependencies] mcp = ["mcp"]`），保持 CLI 与 PyInstaller 零依赖。

---

## 7. 安全模型的延伸

[safety.md](safety.md) 的保证在三入口下逐条如何维持：

| 现有保证 | 新入口下的处理 |
| --- | --- |
| 从不 commit/push/开 PR | MCP 不暴露 `commit`/`push`；扩展的 commit 相关命令只打开 `commit_plan.md`，不执行 git |
| Jira 只写一条可选评论 | `jira-comment --execute` 不进 MCP 工具列表；扩展需要弹窗确认；manual 模式直接不可用（§5.1） |
| `cleanup` 不能删 `.ai`/`.ai_memory/bugs` 之外 | 不变（`_ensure_child` 在 core 里），校验函数改名为 `validate_work_item_id` |
| 出站文本经 `sanitize_comment_text` 脱敏 | 不变。**新增要求**：MCP 工具的返回值也要过一遍 —— 工具结果直接进模型上下文 |
| 凭据只从 `config.py` 进入 | 扩展通过环境变量注入，仍走 `config.py` 的 env 优先路径，不新增读取点 |

新增的攻击面：MCP 工具的返回值会进模型上下文。

**实施后撤销了「工具返回值过脱敏」这条要求。** `sanitize_comment_text` 是为
Jira 评论设计的，实测会把 `def load(key, secret_path)` 腐蚀成
`def load(key, <redacted>`，让模型读到不存在的签名；而它保护不了什么 ——
agent 对同一仓库有读权限，可以直接打开那份文件。脱敏的正确位置是**离开本机的
文本**（Jira 评论、邮件），那两处已经在做。

真正需要的边界是另外两条，都由 §5.2 的工具实现保证并有守护测试：
**每个模型提供的 work item id 必须过 `validate_work_item_id`**（否则
`../../elsewhere/evil-1` 会写到绑定仓库之外），以及**每个工具要求 work item
已存在**（否则一个看似合理的 id 会新建幽灵目录）。

---

## 8. 打包与分发影响

| 产物 | 现状 | 三入口后 |
| --- | --- | --- |
| wheel + pipx | `install.cmd` → `install.ps1` → pipx | 不变；`bugpilot-mcp` 入口点需要重装才生成 |
| `bugpilot.exe`（PyInstaller） | 单文件，自带 Python | 不变（`mcp` 走 optional extra，不进 exe） |
| VS Code 扩展 | 无 | 新增 `.vsix`。V1 不内置 exe（要求已有 CLI），扩展负责检测、选择 executable 与给出安装指引 |

**扩展工具链：零构建步骤**（阶段 4 落地）。用 Node 22.18+ 的原生 TypeScript
类型剥离直接跑 `.ts`，不引 ts-node / tsx / jest / vitest，测试用内置
`node --test`。少一层构建就少一处版本地狱，代价是不能写会生成代码的 TS 语法
（parameter properties、`enum`、`namespace`）——用 `erasableSyntaxOnly: true`
让这类写法在**编译期**报错，而不是等运行时 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
`engines.node` 因此收紧到 `>= 22.18`。打包 `.vsix` 时类型剥离由 VS Code 自带的
Node 承担，无需附加运行时依赖（扩展运行时依赖为零）。

**`.vsix` 的实际内容**（阶段 6 落地）：`vsce package --no-dependencies` +
`.vscodeignore`，产物 29 个文件 / 约 75KB——只有 `out/`（构建后的 CommonJS）、
`media/`（页面资源与活动栏图标）、`package.json` 与 `README.md`。
源码、测试、tsconfig 一概不进包。`scripts/check-package.mjs` 用 `vsce ls`
**双向**校验：扩展跑不起来就缺的文件必须在（`out/extension.js`、
`media/panel.{css,js}`、manifest 声明的图标），不该进的一个都不许在。
理由是这类错误在安装之后才暴露：少了 `media/panel.js` 就是一个空白面板，
而且哪里都不报错。

**扩展的 README 就是扩展页面**（`extension/README.md`），同时承担 §9 阶段 6
「5–10 分钟完成第一次调查」的 onboarding 文档职责。

**`doctor` 报告首字段是 `version`**（阶段 6 落地）。一台机器上同时存在 pipx 副本、
editable 安装和 exe 是常态（开发机上就是），所以「我现在跑的到底是哪一个」必须
可见：扩展把版本与解析出的路径一起显示在面板底部。字段可缺——较旧但契约兼容的
版本不报版本号，缺失不得把一个可用的安装降级。

**V1 支持平台**：Windows 10/11 + VS Code。Linux 为 best effort，等 workflow 与
adapter contract 稳定后再验证。理由：V1 已同时涉及 pipx、`.exe`、`.cmd` shim、
VS Code、Claude CLI、PATH、SecretStorage、MCP stdio，同步验证 Linux 会显著扩大
测试矩阵。

---

## 9. 分阶段计划

第一版目标是 **Feature-rich Internal Beta**。实施顺序保持
「spike → 领域模型 → machine API → MCP → 扩展基础设施 → 扩展 UI → hardening」，
即先稳定 contract 再做界面。

### 阶段 0 —— 两个 spike 验证

**0A MCP feasibility**：只做 `prepare_jira_bug` 一个工具（直接包现有
`run_bug_workflow`，不需要任何前置改动），验证 Claude Code 在有 BugPilot tool 时
会优先调用，而不是自己无约束 grep。`prepare_bug_description` 与
`refine_investigation` 依赖阶段 1 的领域模型，不放进 spike，否则形成循环依赖。

**0B VS Code UX / 设计 spike**：做一个只含主输入面板的 Webview 原型，验证
输入表单、调查范围勾选、进度 checklist 的交互与信息层级，并**当场跑一遍 §5.4 的
主题矩阵与窄宽度检查**。V1 功能集已由 R8 定下，0B 不决定做哪些功能，
但它决定布局、信息层级和组件清单 —— 这是把「界面尽量做好」变成有界工作的手段：
组件清单在 0B 冻结，阶段 5 只实现不再重新设计。

这两个 spike 不作为可交付 V1。

### 阶段 1 —— 领域模型与 core

- `BugSpec` / `InvestigationOptions` / `InvestigationPlan` / `InvestigationRequest` /
  `InvestigationResult`。
- plan → `WORKFLOW_STEPS` 展开与依赖解析（core 内单一实现）。
- work item identity 统一（§3.4 全部调用点）。
- Jira / Manual input adapter。
- 后续 workflow 去 Jira 耦合。
- core stdout 清理。
- step 返回结构化数据。
- MCP 写路径限制测试。

验收：

1. 同一个 workflow 可分别用 Jira issue 与纯 description 运行，并生成同类
   `.ai/<work_item>/` 产物。
2. 本地 work item id 形如 `local_20260901094133`，且 `is_jira_issue_key()` 对它
   返回 `False`、`is_work_item_id()` 返回 `True`。
3. 全仓只有一处 Jira key 判定和一处 work item id 判定；
   `looks_like_issue_key` / `_looks_like_issue_key` 已删除。
4. `InvestigationPlan` 关掉某项时，`workflow_status.json` 里对应 step 标记为
   `skipped` 而非 `fail`；依赖项（如 `keywords`）按表自动补齐且只跑一次。

### 阶段 2 —— CLI Machine API

- 现有 CLI 行为逐字兼容。
- 9 个关键命令加 `--json`。
- `--json-lines` 事件流（复用已有 `progress` 回调）。
- `schema_version = 1`；稳定 `error.code`。
- manual description / description-file 输入。
- Options 参数（hint / keywords / focus / ignore / max-files / max-search-lines）
  与 Plan 参数（skip-*）。
- 新增 `bugpilot list`（§3.4 / §5.1），同时提供 `--json`。
- manual 模式下 Jira 相关命令的行为（§5.1 表）。
- **续接闭环**（§5.6）：`bug --retry` 一条命令走完三步；`--retry --same-session`
  作为显式选项；`check-results` / `delivery-check` 失败时打印下一步命令。

验收：Extension 不解析人类文本；实时进度只依赖 JSONL，不依赖轮询文件；
未修复场景下用户能只靠 CLI 输出找到下一步（不必翻文档）。

### 阶段 3 —— MCP 完整入口

- `prepare_jira_bug`、`prepare_bug_description`、`refine_investigation`、
  `check_results`、`summarize_results`、`search_memory`、`get_status`。
- 1 个 deterministic fix-bug prompt。
- repo-bound server，不让模型自由传 `repo_root`。
- tool result sanitize。
- `CLAUDE.md` 推荐片段写进文档（可选增强，不作依赖）。

验收：Claude Code 能从 Jira 或自然语言 bug 描述进入 workflow；
`refine_investigation` 能按新 hint 重跑相关环节；MCP 调用不修改 source tree；
删掉目标仓库的 `CLAUDE.md` 后全部功能仍可用（R9）。

### 阶段 4 —— VS Code Extension 基础设施

- executable discovery / selection。
- process runner（含 Stop / kill）。
- JSON 与 JSONL protocol client。
- SecretStorage。
- workspace / repo root detection。
- diagnostics 与 `error.code` → 用户提示的映射。

### 阶段 5 —— Extension 完整 UX（V1）

§5.3 表中**全部**能力：输入源切换、title/description、hint、keywords、
focus/ignore、调查范围勾选、Run/Stop、实时 checklist、artifact TreeView、
Markdown 预览、history、Open `agent_task.md`、Copy handoff prompt、
MCP status 提示、Doctor/Agent Check/Clean、安装向导、executable 配置、SecretStorage。

加上 §5.4 的界面实现：Webview 主面板（主题变量、窄宽度、三态、a11y、状态保持、CSP）
与原生 TreeView（产物 / history）。

加上 §5.6 的续接 UI：Run 旁的 `Retry` 按钮（打开 `user_feedback.md`，保存后跑
`bug --retry`），以及会话续接入口（能取到 session id 时显示，取不到则隐藏）。

验收（功能）：不打开终端即可完成完整调查流程，并明确知道下一步如何交给 agent。

验收（界面，逐条过 §5.4）：

1. Light / Dark / High Contrast Dark / High Contrast Light 四主题下截图无问题；
   代码里 `grep` 不到硬编码颜色值。
2. 侧边栏 200px / 300px / 500px 三档宽度下无横向滚动、标签不截断。
3. 仅用键盘完成一次完整调查流程。
4. §5.4 三态表中每格都有对应实现（含 CLI 未安装的安装向导）。
5. 面板隐藏再显示后表单内容不丢；扩展重启后进度从 `workflow_status.json` 恢复。
6. Webview 中不出现任何凭据；CSP 与 `localResourceRoots` 已设置。

### 阶段 6 —— Internal Beta hardening

- VSIX 打包与安装说明。
- pipx / exe / editable 三种安装的兼容测试。
- 新机器 onboarding 测试。
- upgrade / version mismatch 提示。
- CLI JSON / JSONL compatibility 测试。
- MCP 测试、Extension TS 测试。
- Windows 10/11 优先；Linux best effort。

**V1 验收标准**：一个没参与 BugPilot 开发的程序员，看 README 花 5–10 分钟能在目标
repo 中完成第一次 Jira 或 manual bug 调查，并成功打开 `agent_task.md`
交给 Claude/Copilot。

### 阶段 7 —— 迁移清理

- `agent_runner.py` 在 V1 标记 deprecated，Beta 反馈后删除。
- **落地 Claude Code Skill（§5.5）**：一个 `SKILL.md`，零 Python 改动，
  为 Claude Code 提供比 MCP 更轻的触发路径。与 §5.2 的 MCP prompt 共用同一份
  交接文案。做完后对比两条路径的实际触发率，决定是否两者并存。
- 根据实际使用决定是否扩展 GitHub Issue / Azure DevOps / clipboard /
  selected text 等 input adapter。

---

## 10. 已知成本

诚实记录，避免事后才发现：

- **V1 扩展范围偏大（已知并接受）。** R8 要求第一版既做完整功能（阶段 5 共 18 项
  能力）又做打磨过的界面（§5.4 六组标准）。风险有两层：交付周期长；
  且在真实使用反馈到来前就固化了交互决策。
  缓解手段有三条 ——（a）阶段顺序不变，contract 先稳定；（b）**组件清单在 0B 冻结**，
  阶段 5 只实现不重新设计；（c）§5.4 是**清单式验收**而非「好看」这类主观目标，
  所以界面工作有明确终点。
- **Webview 带来独立的一套工程成本。** 主面板不再是原生控件，意味着要额外维护
  HTML/CSS、Webview ↔ 扩展宿主的 `postMessage` 协议、CSP 配置、状态序列化，
  以及主题矩阵和 a11y 的回归检查。这部分不能复用 CLI 的任何测试。
- **三层领域模型增加迁移成本。** 现有以 `issue_key` 为中心的函数签名、产物命名和
  测试需要逐步泛化为 `InvestigationRequest`；阶段 1 是一次集中改动，不宜分批。
- **每加一个 workflow step**，要决定它属于哪个 `InvestigationPlan` 开关、
  在三处是否暴露、怎么命名。
- **入口重叠**：已由 §1.1 的心智模型给出对外答案，但仍需在 README 里重复一次。
- **文档面扩大**：`docs/` 已有 13 个文件。
- **测试面扩大**：CLI 有 pytest 覆盖；plan 依赖解析、JSONL 事件、MCP 工具、
  扩展 TS 都需要新测试。
- **JSONL 与 `workflow_status.json` 双写**：两者必须语义一致，否则重启前后进度显示
  会不一致。需要一个测试固定这个约束。

---

## 11. 已决与待决问题

### 已决

1. **Extension V1 不内置 `bugpilot.exe`**，要求安装 CLI，扩展负责检测和选择路径。
2. **MCP 不让模型传 `repo_root`**，server 默认绑定启动 repo/workspace root，可配置覆盖。
3. **`--json` 第一版即带 `schema_version`**，且扩展只依赖 `error.code`，不解析错误文本。
4. **`agent_runner.py` V1 只 deprecated，不立即删除**。
5. **Jira 降级为 input adapter**，manual bug description 是 V1 一等输入。
6. **领域模型拆成三层**：`BugSpec`（身份/内容）+ `InvestigationOptions`（检索配置）
   + `InvestigationPlan`（逻辑范围）。不合并成单一膨胀的 `BugSpec`。
7. **work item identity 彻底分离**：`work_item_id` ≠ `source_ref`；本地 ID
   `local_<YYYYMMDDHHMMSS>` 不伪装成 Jira key；作废上一版的 `LOCAL-<digits>` 决定。
8. **`InvestigationPlan` 展开与依赖解析属于 core 契约**，adapter 不重复实现；
   UI 只呈现逻辑能力，不呈现实现步骤。
9. **阶段 2 交付 `--json-lines`**：JSONL 为 live events，`workflow_status.json`
   为 persisted state。
10. **MCP 用 `refine_investigation` 取代 `search_code`**，表达意图而非实现步骤；
    低层 `bugpilot search --json` 仍在 CLI 可用。
11. **V1 扩展做完整功能 + 打磨过的界面**（R8），不划 5a/5b，也不做界面降级；
    范围风险记入 §10。
11a. **控件选型混用**：主输入面板用 Webview，产物 / history 用原生 TreeView。
11b. **不用 `@vscode/webview-ui-toolkit`**（已停止维护）；用原生 HTML +
    VS Code 主题 CSS 变量，图标只用 Codicons。
11c. **「打磨」= §5.4 的清单式标准**（主题矩阵、窄宽度、键盘可达、三态齐备、
    状态保持、CSP），不是视觉出彩；不引入自有品牌视觉。
11d. **组件清单在阶段 0B 冻结**，阶段 5 只实现不重新设计。
11e. **凭据绝不进入 Webview**，只在扩展宿主从 `SecretStorage` 读取并注入子进程。
12. **`CLAUDE.md` 提供推荐片段但不作依赖**（R9 / 不变量 9）。
13. **V1 仅正式支持 Windows 10/11 + VS Code**，Linux best effort。
14. **阶段 0A 只做 `prepare_jira_bug`**，避免与阶段 1 循环依赖。
15. **Claude Code Skill 延后到 V1 之后（阶段 7）**，不进 V1，也不用于阶段 0A 的
    假设验证。理由：Skill 依赖宿主有 shell 权限、不提供结构化返回、格式不跨客户端，
    给不了 R2 + R4 要的 agent 契约；但它零改动、成本极低，值得在 V1 之后作为
    Claude Code 的轻量触发路径补上（§5.5）。
16. **Skill 不算第四个入口**，是 CLI 入口之上的触发垫片；§1.1 的三入口心智模型不变。
17. **续接默认重启，不默认留在会话**（§5.6）。信息保留由产物保证，不依赖 agent 会话；
    选择标准是上下文对不对，不是信息会不会丢。`--same-session` 是显式选项。
18. **MCP 不暴露 retry 工具**（§5.6）。retry 的输入是人的反馈，做成工具等于让模型
    自己决定「我失败了，重来」，与 R5 相悖。`refine_investigation`（准备阶段、
    agent 可自主）与 retry（修复阶段、必须人触发）是两个不同循环。
19. **会话续接是可选增强，必须能优雅降级**（§5.6）。依赖 Claude Code 的 cwd-slug
    存储布局，那是实现细节而非公开契约；取不到 session id 时隐藏该入口，不报错。
20. **`InvestigationOptions` V1 只加 `max_files` + `max_search_lines`**（§3.3），
    两者成对暴露（只给文件数控制不住产物体积）。`search_scope`（与
    `focus_files`/`ignore_paths` 语义重叠）、`dependency_depth`（是独立特性，
    需要 include 图分析）、`token_budget`（需要 token 计数基础设施，且不如直接
    控文件数/行数有效）都不进 V1，理由已记入 §3.3 表。
21. **本地 ID 不加可读 slug**（§3.4）。ID 须稳定而标题可改；现有 `summary_slug()`
    丢弃非 ASCII，中文标题产出空 slug，可读性收益时有时无。可读性改由 display 层
    解决：新增 `bugpilot list` 命令（§5.1），扩展 History 面板消费其 `--json`。

### 待决

1. `Continue with Claude` 在不同 agent 环境下用什么检测方式：MCP prompt、
   复制 handoff，还是检测 Claude Code CLI？
2. manual 模式下 `notify` / `commit-plan` 邮件降级后的正文模板由谁定？
   （§5.1 已定行为，未定模板）
3. `refine_investigation` 重跑的默认范围：固定为 code search + memory + context，
   还是根据传入的 options 差异自动推断？
4. `agent_session.json` 的 session id 抓取方式（§5.6）：取目录下最新 `.jsonl`
   是否足够可靠？多个 agent 并发跑同一 repo 时会抓错，需要确认是否值得做。
5. `--retry --same-session` 用什么实现：`claude -c`（最近一个会话）还是
   `claude --resume <id>`（需要先解决问题 4）？
