# 阶段 7 —— 迁移清理

**状态**：三项计划项全部处理（其中一项是「**决定不做**」）+ 阶段 6/7 联合 review 修复 8 项 · 2026-09-04
**计划**：[adapter_design.md](../adapter_design.md) §5.5 / §9 阶段 7
**过程**：[implementation_log.md](../implementation_log.md) 阶段 7
**Skill 安装与对照**：[skill_setup.md](../skill_setup.md)
**测试**：Python 500 passed；TypeScript 262 passed；集成 8 passed；打包守卫三向

**这一阶段的一句话结果**：交接文案从四份变成一份，Skill 落地，
`agent_runner` 标记 deprecated。三个入口的架构到此收口。

## 提交

```text
e58f8af  Phase 7.1-7.3: one source for the handoff, the Claude Code skill, and a deprecation
c19aaa5  Phase 7.4: record the phase and close the input-adapter question
```

## 1. 交付物

| 交付 | 内容 | 测试 |
| --- | --- | --- |
| `bugpilot/core/handoff.py` | 交接指令的**唯一来源**：步骤、禁止动作、触发描述、四种渲染 | `tests/test_handoff.py`（11） |
| `skills/bugpilot-investigate/SKILL.md` | Claude Code Skill：CLI 之上的触发垫片，零 Python 依赖 | 同上（步骤逐条比对） |
| `docs/skill_setup.md` | 安装、与 MCP 的取舍、**触发率对照方法** | — |
| `bugpilot/core/agent_runner.py` | 标记 deprecated + stderr 提示，功能不变 | `tests/test_agent_runner.py`（11） |
| `bugpilot/mcp_server.py` | `fix_bug` 改为渲染 `handoff.mcp_prompt`，输出**逐字节不变** | `test_handoff.py` 钉住原文 |
| 扩展的 Copy handoff 兜底 | 跨语言守卫：TS 测试读 `handoff.py` 源码比对 | `controller.test.ts` |

## 2. 下游可依赖的契约

```python
from bugpilot.core import handoff

handoff.handoff_prompt(issue_key)          # CLI 启动 prompt（R1 锁定，逐字节）
handoff.retry_handoff_prompt(prompt_file)  # 同上，第二次尝试
handoff.mcp_prompt(tool, argument)         # MCP fix_bug 的展开形式
handoff.skill_steps(command=...)           # SKILL.md 的四个编号步骤
handoff.REQUIRED_READS                     # ("agent_task.md", "bug_context.md")
handoff.FORBIDDEN_ACTIONS                  # ("commit", "push", "post to Jira")
handoff.TRIGGER_DESCRIPTION / TRIGGER_TOKENS
```

**改这个模块会同时改变四处对模型说的话。** 所以两条锁：
`test_mcp_prompt_is_byte_for_byte_what_it_was` 钉住已发布的原文，
`test_every_step_appears_in_the_skill` 钉住 SKILL.md 不落后。

## 3. 与计划的净偏差

| 计划项 | 实际 | 原因 |
| --- | --- | --- |
| `agent_runner.py` 标记 deprecated，Beta 反馈后删除 | 已标记（模块文档 + stderr 提示），**未删** | 计划就是这样：V1 保留可用 |
| 落地 Claude Code Skill，与 MCP prompt 共用文案来源 | 完成，且共用范围从「两处」扩到**四处**（多了扩展的 Copy handoff） | 动手时才发现 TS 侧也有一份同样的句子 |
| 做完后对比两条路径的实际触发率 | **未做**，方法写成了清单 | 需要人在真实客户端里跑，且依赖 MCP 连通性（至今未验） |
| 根据实际使用决定是否扩展 input adapter | **决定不做**，并写下触发条件 | manual 模式已能吃任何粘贴文本；新 adapter 的唯一增量是「自动取回」，目前无证据。已同步 §1.2 |

## 4. 一个被自己抓到的问题

`test_the_skill_and_the_mcp_tools_describe_the_same_trigger` 这条测试
**名字承诺了它没做的事**——它只检查了 skill 一侧的 frontmatter。
改成从**构建出的 server** 读真实工具描述，两侧都查共享的 trigger tokens。

没有改成「共用同一句话」是有意的：MCP 的工具描述**故意更具体**
（阶段 3 靠写清「大写前缀 + 短横 + 数字」修掉过一次误路由），
强制统一措辞会让其中一边变差。必须相等的是「听的是不是同一批词」——
因为 §9 阶段 7 要对比两条路的触发率，而如果它们在等不同的词，
那个对比本身就没意义。

顺带修掉一处：把禁止动作朴素 join 会产出
`Do not commit, push, post to Jira`（列表倾倒，不是英语）。
现在 join 会补 `or`，而这也正好等于 MCP 早已发布的那句原文。

## 5. 已知遗留

- **触发率对照未做**（[skill_setup.md](../skill_setup.md) 末节给了方法）。
  这是阶段 0A 假设的直接验证，且两条路成本差一个数量级。
- **`agent_runner` 未删**。删除条件：Internal Beta 反馈显示没人依赖自动拉起。
- **Skill 未在真实 Claude Code 里触发过一次**。文件写完了，
  `tests/test_handoff.py` 保证它与 `handoff.py` 一致，但「模型会不会用它」
  和 MCP 那条一样属于未验证。
- **Skill 只对 Claude Code 有效**。其他宿主的 skill 格式不通用，
  这正是 MCP 留在 V1 的理由之一（§5.5 的三点）。
- 阶段 5/6 的遗留全部仍在：界面手测、安装矩阵 2/3、新机器 onboarding、
  MCP 客户端连通性、`.vsix` 从未被安装过、发布身份未定。

## 5b. 阶段 6/7 联合 review（8 项，全部修完）

完整清单见 [implementation_log.md](../implementation_log.md) 的
「阶段 6 / 7 review」。这一轮的做法是**先真的装一次 `.vsix`**，第一项就是这么找到的：

1. **包里混进了 `test-integration/`**——`.vscodeignore` 与打包守卫都是黑名单，
   而那个目录是后加的，两条都匹配不上。两边改成 allowlist，新目录默认不进包。
2. **守卫的注释承诺了「检查构建产物是否最新」，代码只数了个数**——
   这是本项目同一模式的第三次（建了守卫不接线 / 承诺核对却没核对 / 承诺查新旧却只计数）。
   现在真的比 mtime。
3. **扩展 README 从没说过怎么装这个扩展**（它不在 Marketplace，只能手工装 `.vsix`），
   而这正卡在阶段 6 唯一的验收标准上。
4. `TRIGGER_TOKENS` 里的 `"before"` 近乎无效，换成 `"before searching"`。
5. **Skill 的 frontmatter 从来没被解析过**——格式错会被静默忽略，
   现在做结构校验 + `name` 必须等于目录名 + `description` 必须短于 500 字符。
6. 集成测试的 `--json-lines` 过滤会静默腐烂，过滤前先断言。
7. `beta_checklist.md` 写死的测试数去掉（活指令不该带会过期的数字）。
8. `skill_steps(command=...)` 的死参数删掉。

## 6. 给后续 review 的要点

1. **改 `handoff.py` 之前先想清楚**：它同时改变 CLI 启动 prompt、MCP prompt、
   扩展的 Copy handoff 兜底、以及 Skill 的四个步骤。两条测试会拦住不一致，
   但拦不住「四处一起变错」。
2. **`agent_runner` 是 deprecated，不要往里加功能。** 要扩展交接方式，
   加在渲染层（`handoff.py`）或入口层，不要加在这个即将删除的模块里。
3. **Skill 与 MCP 的工具描述可以措辞不同，但必须听同一批词**
   （`handoff.TRIGGER_TOKENS`）。改任一侧的触发条件都要同时改另一侧，
   否则触发率对照失去意义。
4. **新 input adapter 的门槛是「有重复劳动的证据」**，不是「能做」。
   §1.2 里逐条写了触发条件。
5. **打包清单是 allowlist，不要改回黑名单。** 黑名单会在下一次加目录时腐烂——
   已经腐烂过一次（`test-integration/` 混进了包）。
6. **注释里写「这里会检查 X」时，下一步就问「代码真的检查了吗」。**
   这个模式在本项目出现过三次，三次都是注释比代码走得远。
