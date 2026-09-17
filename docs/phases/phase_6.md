# 阶段 6 —— Internal Beta hardening

**状态**：可自动化的部分完成；**四项人工验收未做** · 2026-09-04
**计划**：[adapter_design.md](../adapter_design.md) §9 阶段 6
**过程**：[implementation_log.md](../implementation_log.md) 阶段 6
**人工清单**：[beta_checklist.md](../beta_checklist.md)、[manual_qa_phase5.md](../manual_qa_phase5.md)
**测试**：Python 485 passed；TypeScript 261 passed；集成 8 passed；打包守卫通过

**这一阶段的一句话结果**：扩展第一次被打成 `.vsix`，而「真 Python 进程 ↔
TypeScript 客户端」这条从未被测过的缝现在有 8 条测试守着。

## 提交

```text
0f73ad8  Phase 6.1-6.2: package the extension, and test the client against the real CLI
a33118d  Phase 6.3-6.4: make the running bugpilot identifiable, and write the beta checklist
d05eebc  Phase 6.5: record the phase and sync the design doc
```

## 1. 交付物

| 交付 | 内容 | 验证方式 |
| --- | --- | --- |
| `extension/.vscodeignore` | 打包**允许**清单：68 文件/180KB → **28 文件/70KB** | `npm run package` |
| `extension/scripts/check-package.mjs` | 用 `vsce ls` 三向校验：必需文件在、allowlist 之外一个都不在、构建产物不比源码旧 | 三个方向都做过变异检验 |
| `extension/README.md` | 扩展页面 + 5 分钟上手 + 排障表 | 也是 §9 的 onboarding 文档 |
| `extension/test-integration/` | 真 CLI 端到端契约测试 8 条 | `npm run integration`（11 秒） |
| `bugpilot/core/doctor.py` | 报告首字段 `version` | `tests/test_cli_json.py` |
| `bugpilot/cli.py` | `python -m bugpilot.cli` 不再静默无输出 | 同上（两个入口都验） |
| 扩展版本显示 | 面板底部 `bugpilot 0.1.0 · <路径>` | `infrastructure.test.ts` / `page.test.ts` |
| `docs/beta_checklist.md` | 安装矩阵、版本不匹配、onboarding、MCP 连通性 | 待人工执行 |
| `.vscode/launch.json` / `tasks.json` | F5 先构建 | — |
| 根 `README.md` | 「三种用法」表 + 真实状态 | — |

## 2. 下游可依赖的新契约

```text
doctor --json  →  report.version   （字符串；较旧但兼容的版本可能没有这个字段）
Verdict.ready  →  version?: string
Readiness.ready → version?: string  → 面板底部显示
```

新增脚本：

```powershell
npm test          # 261 条，密闭，秒级
npm run smoke     # 加载构建产物、真的 activate()、注册集合与生命周期监听器
npm run integration  # 8 条，跑真 CLI，需要 Python，约 11 秒
npm run package   # 构建 → 校验包内容 → 产出 .vsix
```

## 3. 与计划的净偏差

| 计划项 | 实际 | 原因 |
| --- | --- | --- |
| upgrade / version mismatch 提示 | 只做**版本可见性**，不做最低版本号强制 | `schema_version` 已经在管协议兼容；再加 semver 门槛只会与它漂移 |
| MCP 测试、Extension TS 测试 | 本来就在阶段 3/4/5 交付（52 + 261 条） | 阶段 6 补的是两者之间那条缝：真 CLI ↔ TS 客户端 |
| pipx / exe / editable 三种安装的兼容测试 | 只有 pipx 一行有实测结果（`incompatible`，由集成测试每次报告） | 另两种需要在这台机器上真的装一遍，属于人工清单 |
| Linux best effort | **未做任何 Linux 验证** | 集成测试写了 `python3` 分支，但没跑过就不能说支持 |

## 4. 验收对照（§9 阶段 6）

| 要求 | 状态 |
| --- | --- |
| VSIX 打包与安装说明 | 打包完成并有内容守卫；**安装说明未被人验证过** |
| pipx / exe / editable 兼容测试 | 1/3 有实测；其余在 [beta_checklist.md](../beta_checklist.md) §1 |
| 新机器 onboarding 测试 | **未做**（清单 §3，要求找一个没参与过的人掐表） |
| upgrade / version mismatch 提示 | 契约层已实现；四种场景的人工验证在清单 §2 |
| CLI JSON / JSONL compatibility 测试 | **完成**（集成 8 条） |
| MCP 测试、Extension TS 测试 | 完成（52 + 261） |
| Windows 优先 / Linux best effort | Windows 上全部通过；Linux 未验 |
| **V1 验收：陌生程序员 5–10 分钟完成第一次调查** | **未做**，且这是本阶段唯一真正的验收标准 |

## 5. 已知遗留

- **四项人工验收一项都没做**：安装矩阵（2/3）、新机器 onboarding、
  界面手测（阶段 5 遗留）、MCP 客户端连通性。前三项是「可能发现问题」，
  第四项是**硬阻塞**：阶段 0A 的假设「模型会去调工具而不是自己 grep」
  至今没在真实 stdio 上验证过。
- **`.vsix` 已在隔离 profile 里装过一次**（review 阶段 6/7 时补的），
  第一次装就发现包里混进了 `test-integration/`——黑名单式 `.vscodeignore`
  的必然结果，已改为 allowlist。**仍未在真实 profile 里装过、也没 reload 看过
  活动栏图标。**
- **`agent-check` / `clean` / `retry-prompt` 仍无 `--json`**（阶段 5 遗留）。
- **`--same-session` 仍不存在**（§11 待决 #5）。
- **发布身份未定**：`publisher` 还是公司 id、`license: UNLICENSED`、
  `repository` 指向一个占位 URL。真要分发得先定这三样。
- **`keytar` 装 vsce 时带进来一个 native 依赖警告**。它只在发布时用到，
  `--no-dependencies` 打包不受影响，但如果以后 CI 要跑 `vsce`，这条会再冒出来。

## 6. 给阶段 7 与后续 review 的要点

1. **改了 CLI 的机器可读输出，先跑 `npm run integration`。** 那 8 条是唯一
   会用真 Python 进程验证契约的测试；密闭测试不会告诉你 argparse 改了行为。
2. **`--flag=value` 的理由被一条集成测试钉住了**（分开写仍然报废）。
   如果哪天 argparse 变了，那条测试会红——那时才是重新考虑写法的时候。
3. **打包守卫要跟着 manifest 走。** 新增 `media/` 资源或改 `main`，
   要同步 `check-package.mjs` 的必需清单；它读 manifest 的 `main` 与图标路径，
   但页面资源是硬编码的两条。
4. **`doctor` 报告是三方共享的**（CLI 信封 / MCP / 人类输出）。往里加字段
   会同时改变这三处的输出，加之前先想清楚。
5. **不要为「版本太旧」加 semver 门槛。** 协议兼容由 `schema_version` 负责，
   两套判断会漂移。版本号只用来回答「我跑的是哪一个」。
6. **人工清单是交付物。** [beta_checklist.md](../beta_checklist.md) 里每条
   不通过的项，连同复现步骤写回本文件的「已知遗留」——不要只在对话里说。
