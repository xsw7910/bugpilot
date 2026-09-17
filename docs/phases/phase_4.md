# 阶段 4 —— VS Code Extension 基础设施

**状态**：完成（含 review 修复）· 2026-09-04
**计划**：[adapter_design.md](../adapter_design.md) §5.3 / §9 阶段 4
**过程**：[implementation_log.md](../implementation_log.md) 阶段 4
**测试**：TypeScript 82 passed（本阶段从 0 建起）；Python 483 passed（未受影响）

**这一阶段的一句话结果**：扩展需要的所有非 UI 能力都在了，而且**一行 `vscode`
import 都没有**——因此全部可以用 `node --test` 直接测。阶段 5 的 activation 层
是唯一该 import `vscode` 的地方。

## 提交

```text
a4c498b  Phase 4.1: extension scaffold, protocol client, error mapping
c7d0dd9  Phase 4.2: executable discovery, process runner, workspace and secrets
fa178cd  Fix nine review findings from phase 4 and record the phase result
```

## 1. 交付物

| 文件 | 内容 | 测试 |
| --- | --- | --- |
| `extension/package.json` / `tsconfig.json` | ESM、Node 原生类型剥离、`erasableSyntaxOnly`、`engines.node >= 22.18` | — |
| `extension/src/protocol.ts` | 信封解析 + `EventStreamReader`（JSONL）+ `ProtocolError` | `protocol.test.ts`（21） |
| `extension/src/errors.ts` | 16 个 `error.code` → 用户提示 + `retryable` | `errors.test.ts`（7，含跨语言守卫） |
| `extension/src/runner.ts` | 子进程运行、Stop/timeout、进程树 kill、argv 守卫接线 | `runner.test.ts`（18） |
| `extension/src/executable.ts` | 五态裁决 + `doctor --json` 握手 | `infrastructure.test.ts`（36） |
| `extension/src/workspace.ts` | repo root 选择 + `isWithin` 归属判断 | 同上 |
| `extension/src/secrets.ts` | SecretStorage 凭据（单 key、原子写）+ argv 守卫 | 同上 |

**零运行时依赖**，devDependencies 只有 `typescript` 与 `@types/node`。

## 2. 下游可依赖的公开契约

```typescript
// 运行
new Runner(executable, spawn?, platform?)
  .run(args, options)                    -> { code, stdout, stderr, aborted }
  .runJson(args, options)                -> Envelope           // 自动追加 --json
  .runStreaming(args, options, onEvent)  -> { result, terminated, events, foreignVersion? }

// 协议
parseEnvelope(stdout, stderr) -> Envelope        // 违反契约则抛 ProtocolError
new EventStreamReader().push(chunk) -> StreamEvent[]
                       .end() -> { events, terminated, foreignVersion? }

// 诊断
diagnose(code, message) -> { summary, action?, retryable, unknownCode }
discoverExecutable({ cwd, configured?, spawn?, platform?, timeoutMs? }) -> Verdict
describeVerdict(verdict) -> { summary, action }

// 工作区与凭据
chooseRepoRoot(folders, probe) -> RepoChoice     // single | ambiguous | none
isWithin(root, candidate, platform?) -> boolean
new CredentialStore(secretStore).save/clear/status/environment()
assertNoSecretsInArgs(args, environment)
```

`Verdict` 是**五态**，不是布尔：`ready` / `not-found` / `incompatible` /
`unresponsive` / `unhealthy`。每一态对应**不同的建议**，这是它存在的全部理由：

| 裁决 | 含义 | 该说的话 |
| --- | --- | --- |
| `ready` | 握手成功，附 doctor 报告 | 无 |
| `not-found` | 不在 PATH，或配置的路径不存在/不可执行 | 装一个 / 配 `bugpilot.executablePath` |
| `incompatible` | 能跑但不认 `--json`——几乎总是版本太旧 | 升级 bugpilot |
| `unresponsive` | 握手超时。**对版本不作任何断言** | 再试一次（冷启动/杀毒扫描） |
| `unhealthy` | 会说契约，但 `doctor` 自己失败了 | 交给 `diagnose()` 码表 |

`terminated === false` 是「进程死在中途」的信号；`foreignVersion` 有值则是
「契约升版了，升级扩展」——两者同形但结论相反，所以必须分开返回。

## 3. 与计划的净偏差

| 偏差 | 原因 | 设计文档 |
| --- | --- | --- |
| 用 Node 24 原生类型剥离，不引 ts-node/tsx/jest/vitest | 少一层构建就少一处版本地狱；代价是不能写会生成代码的 TS 语法 | 已同步 §8 |
| `erasableSyntaxOnly: true` | 让上面这条**编译期报错**而不是运行期报错（parameter properties、enum、namespace 都会被拒） | 已同步 §8 |
| `Verdict` 由三态扩到五态 | review 发现 `unhealthy` 与 `unresponsive` 被误判为 `incompatible`，会建议用户升级一个完好的 bugpilot | 已同步 §5.3 |
| 凭据存**一个** key（JSON），不是 email/token 两个 | 两次顺序写不原子：第二次失败会留下新 email 配旧 token | 已同步 §5.3 |
| `SecretStore` 接口用 `PromiseLike` 而非 `Thenable` | 同样的结构，且不必依赖 `@types/vscode` | — |

## 4. 已知遗留

- **没有 `extension.ts`，没有 `contributes`**——阶段 4 按计划是 UI-free 的。
  在真实 VS Code 里从未加载过（阶段 5 才有可加载的扩展）。
- `runStreaming` 的 `foreignVersion` 目前没有消费方；阶段 5 必须把它渲染成
  「升级扩展」，否则又变回「看起来像崩了」。
- `--json-lines` 只有 `bug` 命令支持（阶段 2 的范围），阶段 5 的 UI 不能假设
  别的命令也能流式。

## 5. 给阶段 5 与后续 review 的要点

1. **凭据只走环境变量。** `Runner.#start` 里的 `assertNoSecretsInArgs` 是唯一
   同时持有 argv 和密钥环境的地方，守卫必须留在那里。它现在按**形态**匹配
   （整个参数 / `--flag=` 的值那一半）并对长度 >= 8 的密钥做全文匹配——不要把它
   改回裸子串匹配，`"doctor".includes("t")` 会拦住每一次正常运行。
2. **每个 EventEmitter 都要有 `'error'` 监听。** 管道或 `taskkill` 上一个未监听的
   `'error'` 是未捕获异常，**杀掉整个 extension host**。三条相关测试用
   `assert.doesNotThrow(...)` 守着，去掉监听就会红。
3. **kill 是请求，不是保证。** 升级 + 兜底结算必须保留，否则 `timeoutMs` 到点后
   promise 永远悬挂。测试用 `t.mock.timers`，并且对时间常量做过变异检验。
4. **`isWithin` 必须先 resolve。** 字符串前缀比较会被 `..` 直接绕过。
5. **`errors.ts` 的码表由跨语言测试守着**——它读 `bugpilot/core/errors.py`
   的源码比对。Python 侧加码而 TS 侧不加，测试会红。这是故意的。
6. **UI 文案不要绕开 `diagnose()` 另写一套。** 同一个 `error.code` 出现两种解释，
   比没有解释更糟。
