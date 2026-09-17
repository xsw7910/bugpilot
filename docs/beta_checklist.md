# Internal Beta 检查单（阶段 6）

阶段 6 的验收里有一部分**我无法在这台机器上代跑**：三种安装方式的兼容、
新机器 onboarding、真实 VS Code 里的界面表现、以及 MCP 客户端连通性。
这份清单把它们写成可执行的动作，每条都有明确的期望结果。

已经自动化的部分不在这里重复：

| 已自动化 | 命令 | 覆盖什么 |
| --- | --- | --- |
| 单元与页面测试 | `cd extension && npm test` | 模型、控制器、消息边界、页面脚本（DOM 桩）、manifest 一致性 |
| 激活验证 | `npm run smoke` | 加载**构建产物**、真的 `activate()`、注册集合、真的构建一次面板 HTML、两个生命周期监听器 |
| 真 CLI 契约 | `npm run integration` | 8 条：`doctor --json` 信封、完整流式运行、`--flag=value` 的 argparse 陷阱、失败码、Jira 失败终止流、`list --json` → history、PATH 上 bugpilot 的分类 |
| 打包内容 | `npm run package` | `.vsix` 里该有的都在、**allowlist 之外的一个都不许在**、构建产物不比源码旧（`vsce ls` + mtime 实测） |

---

## 1. 安装矩阵（阶段 6 计划：pipx / exe / editable）

对每一种安装方式，做同一组三步。**关键点不是「能不能跑」，而是「判断对不对」**——
把一个真实存在的安装说成「没装」，会把人送去装第二个。

**`pipx` 可能不在 PowerShell 的 PATH 上**（本机就是这样，而它装的
`~/.local/bin/bugpilot.exe` 却在）。用 `python -m pipx` 代替。

```powershell
# 步骤 A：CLI 自己能不能说契约
bugpilot doctor --json          # 或者被测的那个可执行文件的完整路径

# 步骤 B：扩展怎么看它
# VS Code 里：BugPilot: Check Environment，然后看面板顶部与底部
# 步骤 C：跑一次手写 bug（不需要 Jira 凭据）
```

| 安装方式 | 怎么装 | 期望的扩展裁决 | 本机实测 |
| --- | --- | --- | --- |
| editable（开发用） | `python -m pip install -e .` | `ready`，底部显示 `bugpilot <版本> · <仓库路径>` | 未测（本机用 `python -m bugpilot` 跑通，集成测试覆盖） |
| pipx | `python -m pipx install --force .` | `ready`；若 pipx 里是旧版则 `incompatible` | **两种都实测过**。旧副本 → `incompatible`（文案说「升级」而非「装一个」，正确）；2026-09-07 用 `python -m pipx install --force .` 换成当前源码后 → **`ready`**，`bugpilot doctor --json` 正常，`bugpilot-mcp` 也随之上了 PATH。集成测试每次都会打印这一行 |
| 单文件 exe（PyInstaller） | `install.cmd` 产出 | `ready`；冷启动可能触发 `unresponsive`（超时 20s） | 未测。**注意**：`doctor` 报告的 `version` 字段是阶段 6 新加的，它走 `from .. import __version__`，冻结打包后要确认这个导入没被 PyInstaller 漏掉 |
| 完全没装 | — | `not-found`，且安装向导三个按钮可点 | 未测（单元测试覆盖分类，未在真 VS Code 里点过） |

**同一台机器上有多个 bugpilot 是常态**（本机就有 pipx 副本 + 源码 + 可能的 exe）。
所以要额外确认：

- [ ] 面板底部显示的**版本号与路径**，与你以为在跑的那个一致
- [ ] `BugPilot: Choose Executable` 指向另一个安装后，底部立刻变化
- [ ] 改了 `bugpilot.executablePath` 设置**不需要**手动 Check Environment
      （有配置监听器）

## 2. 版本 / 升级不匹配

| 场景 | 怎么造 | 期望 |
| --- | --- | --- |
| CLI 太旧，不认 `--json` | 把 `executablePath` 指向旧 pipx 副本 | `incompatible`，文案说「升级 bugpilot」而不是「装一个」；`detail` 里带 argparse 的 `unrecognized arguments` |
| CLI 比扩展新（契约升版） | 手工把 `cli_json.SCHEMA_VERSION` 改成 2 跑一次 | 单次命令：「bugpilot speaks contract v2; this extension understands v1. Update the extension.」；流式：面板显示「Update the BugPilot extension」而**不是**「跑到一半崩了」 |
| CLI 环境有问题（缺 ripgrep / 缺凭据） | 临时改名 `rg`，或清掉凭据后跑 `doctor` | `unhealthy`：说的是**环境**问题并给 Run Doctor 按钮，不建议重装 |
| 冷启动超时 | 用 exe 首次运行，或人为把 `timeoutMs` 调小 | `unresponsive`：「再试一次」，**不**建议升级 |

改完 `SCHEMA_VERSION` 记得改回来，并重跑 `npm run integration`。

## 3. 新机器 onboarding（§9 阶段 6 的 V1 验收标准）

**验收标准**：一个没参与 BugPilot 开发的程序员，看 README 花 5–10 分钟能在目标 repo
中完成第一次调查，并成功打开 `agent_task.md` 交给 agent。

执行方式（**找一个真的没参与过的人，别自己走一遍**）：

1. 给他两样东西：仓库地址、[extension/README.md](../extension/README.md)。**不要口头补充**。
2. 计时开始。
3. 全程记录：他在哪一步停下来、问了什么、读了哪一段文档才继续。
4. 计时结束的判据是：编辑器里打开了 `agent_task.md`，并且他能说出下一步要做什么。

- [ ] 总时长 ≤ 10 分钟
- [ ] 中途**没有**需要口头补充的信息
- [ ] 卡住的地方逐条记录，并回写进 README 或错误文案

失败的常见原因（提前想到的，不代表都会发生）：Python 没装、`pip install -e .`
之后 `bugpilot` 不在 PATH、PATH 上有旧副本、没有 Jira 凭据却先试了 Jira 模式。
前三个都应该由扩展的裁决文案直接说清楚——**如果他需要问人，那就是文案的缺陷，
不是他的问题**。

## 4. 界面手测

见 [manual_qa_phase5.md](manual_qa_phase5.md)（四主题、三档宽度、纯键盘、
三态、状态保持、安全边界）。这份清单仍未执行过。

## 5. MCP：传输层已验证，**假设本身仍未验证**

两件事要分开：

- **传输层（能不能连上）**：已验证。`tests/test_mcp_stdio.py` 用真管道跑
  `initialize` / `tools/list` / `prompts/list` / `tools/call`——7 个工具、
  `fix_bug` prompt、失败带可读文案、产物写进服务器启动时绑定的目录。
  仓库根也已备好 `.mcp.json`，照它启动过一次，确认能握手。
- **阶段 0A 的假设（模型会不会用它）**：**仍未验证**，这才是硬阻塞，
  也只有你能做。

配置已经在仓库根的 `.mcp.json` 里了。在**这个仓库**开一个新的 Claude Code
会话（配置在启动时读取），说一句「please fix JR-12345」，然后确认：

- [x] **它调用了 `prepare_jira_bug`，而不是自己开始 grep** ← 阶段 0A 的假设，
      2026-09-04 用真实 Claude Code + 真实 Jira issue 验证**通过**
- [x] `.ai/JR-12345/` 真的被创建（23 个产物，真实 Jira 数据）
- [x] 它**没有**尝试调用不存在的工具
- [x] **它真的读了产物并照规矩执行**：读了 `search_quality.json`，发现置信度低，
      按 workflow 的规则写了 no-op 分析而不是乱改代码
- [ ] 工具失败文案（本次未触发失败；`tests/test_mcp_stdio.py` 覆盖了这条）

**那次运行同时暴露了三个缺陷**（详见 implementation_log 的「阶段 0A」）：
头条 `Score: 90/100` 与 `confidence: low` 自相矛盾（已修，同输入下现在是 69）、
Closed/Won't Do 的 issue 照样出完整修复包且没人指出（已修，加了 `## Caution`）、
关键词排序把 `seismic`/`well tie`/`HRS` 这类领域词丢进了 dropped（**未修**，见下）。

### 待收集：关键词排序是不是稳定地丢领域词

一个样本不足以调排序器。**再跑 5–10 个真实 issue**，每次记三列：

| issue | 高价值关键词 | 被丢弃的词里有没有真正的领域名词 | 匹配到的文件对不对 |
| --- | --- | --- | --- |
| JR-12345（Task） | preHRS12, Calculate, Correlation, frequency, determine | **有**：seismic / Well tie / HRS / Factor / Quality 全在 dropped | 不对：全是 bugpilot 自身源码与文档 |

**注意在本仓库自测会自我污染**：第二次跑同一个 issue 时，置信度从 `low` 变成
`high`，因为上一轮写的测试 fixture 逐字引用了该 issue 的原文（构成 exact phrase
match）。这条已修（测试路径封顶 medium），但也说明**要在真实的目标仓库里跑**，
而不是在 bugpilot 自己的仓库里跑——后者会不断累积关于它处理过的 issue 的文本。

如果「领域名词被丢弃」是稳定模式，再动 `bugpilot/core/keywords.py` 的排序
（当前是 identifier 分数 + 频次，而散文里重复的恰恰是通用词）。

详见 [mcp_setup.md](mcp_setup.md)。

## 6. 打包与分发

- [x] `cd extension && npm run package` 产出 `bugpilot-<版本>.vsix`
- [x] **安装本身已验证过一次**：`code --extensions-dir <临时> --user-data-dir <临时>
      --install-extension bugpilot-0.1.0.vsix` 成功，且装出来的目录只有
      `out/ media/ package.json readme.md`。第一次这么做就发现包里混进了
      `test-integration/`——`.vscodeignore` 当时是黑名单，而那个目录是后加的。
- [x] **在真实 profile 里装过**（2026-09-07，`code --install-extension bugpilot-0.1.0.vsix`
      成功）。注意 `vsce package` 会警告缺少 LICENSE 文件并要求确认——发布身份那三项
      定下来时一并解决。
- [ ] reload 后确认活动栏图标出现、面板能打开
- [ ] 装完后：活动栏有图标、面板能打开、Doctor 能跑
- [ ] 卸载后 `.ai/` 与凭据的处置符合预期（凭据留在 SecretStorage，
      需要时用 `BugPilot: Clear Jira Credentials` 清）

## 记录结果

不通过的项连同复现步骤写进 [phases/phase_6.md](phases/phase_6.md) 的「已知遗留」。
**不要只在对话里说。**
