# Claude Code Skill 安装与对照

`skills/bugpilot-investigate/SKILL.md` 是一层**触发垫片**：它告诉宿主 agent
「什么时候该跑 `bugpilot`、跑完读哪些产物」，实际执行用宿主自己的 Bash 工具。
它不是第四个入口（§5.5），CLI 才是那个入口。

## 安装

Skill 要放进**目标仓库**（你修 bug 的那个仓库），因为 `bugpilot` 也是在那里跑的：

```powershell
# 在目标仓库根目录
mkdir .claude\skills -Force
Copy-Item -Recurse <bugpilot 仓库>\skills\bugpilot-investigate .claude\skills\
```

```bash
# POSIX
mkdir -p .claude/skills
cp -r <bugpilot-repo>/skills/bugpilot-investigate .claude/skills/
```

想对所有仓库生效就放 `~/.claude/skills/` 而不是项目里。

装完在 Claude Code 里问一句「有哪些 skill」，或者直接说
「please fix JR-12345」，看它是否引用了这个 skill。

## 和 MCP 该用哪个

两条路给模型的是同一份交接指令（都从 `bugpilot/core/handoff.py` 渲染，
`tests/test_handoff.py` 守着不漂移），区别在**怎么执行**：

| | Skill | MCP server |
| --- | --- | --- |
| 装什么 | 复制一个目录 | `pip install -e ".[mcp]"` + 配 `.mcp.json` |
| 靠什么执行 | 宿主的 Bash（**必须有 shell 权限**） | 自带实现，不需要 shell |
| 模型拿到什么 | 人类可读的 stdout，要自己解析 | 结构化返回：`generated_files`、`error.code` |
| 上下文成本 | frontmatter 常驻，正文按需读 | 7 个工具的 schema 每轮常驻 |
| 跨客户端 | 只有 Claude Code | 任何 MCP 客户端（含 Copilot Chat） |

**建议**：只用 Claude Code 且不介意它跑 shell 命令，先装 Skill——五分钟就能试。
需要跨客户端、或者需要模型拿到结构化结果与错误码，用 MCP。
两者可以同时装，指令一致不会冲突；真正的问题是**它们会不会都不触发**，
所以下面这件事才是阶段 7 留下的动作。

## 待做：对照两条路的触发率（§9 阶段 7）

阶段 0A 的假设至今没验证过：**模型会不会优先调 BugPilot，而不是自己 grep**。
Skill 与 MCP 都是为这个假设服务的，且成本差一个数量级，所以值得实测对照。

方法（同一个仓库、同一批话术，各跑 5 次）：

| 话术 | Skill 装着（MCP 关掉） | MCP 装着（Skill 移走） |
| --- | --- | --- |
| `please fix JR-12345` | | |
| `JR-12345 有个崩溃，看一下` | | |
| `保存记录时 KeyError，帮我修` | | |
| `看看 src/record.py 为什么崩` | | |
| `修一下这个 bug`（无 key、无描述） | | |

每格记三件事：

1. 它**有没有**用 BugPilot（还是直接开始 grep / read 文件）？
2. 如果用了，走的是 Jira 路还是 description 路？**选对了吗**？
3. 拿到产物之后，它有没有真的去读 `agent_task.md`，还是又自己搜了一遍？

第 3 点最容易被忽略：触发了但不读产物，等于白跑。

结论有三种可能，对应三种处置：

- **两条都可靠** → 保留 MCP 作为 V1 入口（R2 + R4 要的是结构化与跨客户端），
  Skill 作为轻量可选项写进文档。
- **Skill 明显更可靠** → 说明 MCP 的工具描述有问题（这是可以修的，
  阶段 3 就修过一次误路由），而不是 MCP 这条路不行。
- **两条都不可靠** → 那阶段 0A 的假设本身不成立，需要重新考虑
  「让模型自己决定」之外的触发方式（比如扩展里的显式按钮，已经能用）。

把结果写进 [phases/phase_7.md](phases/phase_7.md) 的「已知遗留」。
