# dsh-capability-optimizer

[![License: MIT](https://img.shields.io/badge/license-MIT-0B7285?style=flat-square)](LICENSE)
[![DSH core](https://img.shields.io/badge/DSH-%3E%3D%200.1.0--rc.6-5B4CF0?style=flat-square)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![Zero build](https://img.shields.io/badge/zero--build-no%20bundler-2EA44F?style=flat-square)](lib)
[![GitHub stars](https://img.shields.io/github/stars/hezhongtang/dsh-capability-optimizer?style=flat-square&logo=github)](https://github.com/hezhongtang/dsh-capability-optimizer/stargazers)

**[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 的外部专家咨询：agent 通过明确的 advisor / reviewer / designer / 自定义角色合同，无头调用 Claude Code CLI，并把结构化回复作为参考答案权衡。**

<p align="center">
  <img src="assets/screenshot-zh.png" width="640" alt="专家咨询设置工作区：每个 harness CLI 一个标签（Claude Code 已可用，六个已预留），通用默认（模型 / 推理等级 / 回退 / 各类上限）、角色列、自动咨询预设面板与真实连通性测试。" />
</p>

[English](README.md) | 中文

## 为什么需要它

单一 harness 只有一种视角。在重大决策、宣布高风险改动完成之前、或开始重要代码之前，另一个模型可以提供独立证据。但这是一项需要评测的假设，不是必然的质量提升：现有 persona 研究并不支持“把模型称为专家就会稳定变准”。本插件把咨询变成有边界的工具调用；Claude 按行为合同与输出合同回答，DSH 将其作为**供权衡的建议，而非必须服从的指令**。

第一期只对接 Claude Code CLI；多后端设置 schema（v2，每 harness 一个工作区）、UI 标签目录与 runner 接缝均已就位——`codex`、`zcode`、`kimi-code`、`pi`、`opencode`、`omp` 后续各自以运行器形式接入同一组工具。

## 功能

| | |
|---|---|
| 🎭 **角色合同** | 内置 advisor / reviewer / designer 各有不同目标与 JSON 合同；自定义角色可选 `outputKind`、提示词、模型、回退和 effort。`enabled` 停用而不删除 |
| 🧠 **推理等级** | 原生 `--effort`（low / medium / high / xhigh / max）三级优先：调用参数 > 角色 > 全局默认 |
| 🔄 **模型回退** | 模型级错误（`unrecognized_model`、模型不存在等）单跳重试，运行元数据记录 `usedFallback` |
| 🤖 **Agent 工具** | `consult_expert`（单角色单问题）· `consult_panel`（多角色并行、一次等待）· `consult_roles`（实时角色目录） |
| 🎛 **自动咨询** | 输入条开关（权限控件同行）按会话勾选角色；政策随系统提示下发，写入/收尾锚点自动催办，按角色按会话限额 |
| 🖥 **设置工作区** | 每个 harness CLI 一个标签；保存即热生效——角色修改直达 agent 下一步，无需重启 dsh |
| 🔬 **连通性测试** | 真实跑通一次完整咨询（CLI + 登录 + 代理），显示轮数、时长、费用与回退标记 |
| 🛡 **纵深防御** | 只读 CLI 工具、可用时严格隔离 MCP、固定权限模式、类型化 schema、输出/轮次/时间上限，以及显式不可信证据标签 |
| 🌐 **完全双语** | 界面全部文字——含内置角色说明、预留后端提示与校验信息——跟随 UI 语言（zh/en）；agent 工具保持稳定英文标识 |

## 安装

```sh
# 从 npm（推荐）
dsh plugin --profile web add dsh-capability-optimizer

# 或直接从 GitHub 仓库
dsh plugin --profile web add github:hezhongtang/dsh-capability-optimizer
```

重启 `dsh web`（或任意 profile）。工具注册在 host 侧，web / tui / headless 均可用。

前提：PATH 上有已登录的 `claude` CLI（`npm i -g @anthropic-ai/claude-code`）。

## 使用

对 agent 说：

> "完成之前让 reviewer 看看这个 diff"

agent 选择角色并调用 `consult_expert`。精确任务可传结构化 `brief`：可信的 `objective`、`successCriteria`、`constraints`，以及被明确标为不可信证据的 `currentAttempt`、`artifacts`、`verification`、`unknowns`。旧 `context` 仍作为 artifacts 简写。Claude 返回角色专属 envelope，并附实际模型、轮数、时长、费用与协议元数据。

| 工具 | 读写 | 用途 |
|---|---|---|
| `consult_expert` | 只读* | 单角色单问题，可选结构化 `brief`（或旧 `context`）与 `model` / `effort` 覆盖 |
| `consult_panel` | 只读* | 多个不同角色合同并行处理同一 brief；不是多数表决 |
| `consult_roles` | 只读 | 实时目录，含 `outputKind`、角色级模型/effort 与全局默认 |

\* 对你的工作区只读；每次调用消耗 Claude 订阅额度——工具描述本身就告知模型打包材料、避免连发。

## 自动咨询

聊天输入条（权限控件那一行）带有专家咨询开关：按会话勾选角色后，host 注入选择条件与生命周期提醒；插件本身不会自动调用角色。

- **政策区块**：每次模型请求点名已勾选角色及选择条件：advisor 用于重要决策，reviewer 用于改动完成声明之前，designer 用于重要代码开始之前。模式为 `off | remind | hard-remind`（默认 `remind`）；旧 `required` 自动迁移为 `hard-remind`。
- **生命周期催办**：启用 designer 时，若未先咨询就发生首次文件写入，运行时会在下一步提醒；改动过文件、即将收尾却没有成功 reviewer 咨询的一轮，会被续跑一步。`hard-remind` 还会记录错过的 designer 检查点，但绝不声称拦住了 Write。
- **预算**：`capPerRole`（默认 3）按角色按会话统计真实 `consult_*` 调用——催办与模型自主调用共用额度；触顶后政策撤回承诺、锚点静默。
- **软约束（有意为之）**：催办保证指令送达，不保证工具调用——dsh 没有强制调用 API；模型若拒绝须一行说明理由。
- 浮层实时显示各角色的用量（`已用/上限`）；上次的选择按浏览器记忆。**设置 → 专家咨询 → 自动咨询** 编辑默认勾选集与预算（行配置键 `autoConsult`）——tui/headless 直接消费同一层。

## 设置界面

**设置 → 专家咨询** 按 harness CLI 组织为独立工作区——顶部标签栏来自 harness 目录（`claude-code` 可用；`codex`、`zcode`、`kimi-code`、`pi`、`opencode`、`omp` 均已预留工作区，运行器就绪前不存任何设置）。Claude Code 工作区运行时管理一切：

- **通用** —— CLI 路径、默认模型（目录与当前支持的 Claude CLI 别名和带版本 ID 对齐）、推理等级（`--effort`：低/中/高/超高/最大）、回退模型、单次超时、CLI 内最大轮数、并行会诊上限、单次咨询美元上限、附加 CLI 参数（走允许清单；`--settings` 会被拒绝）。
- **角色工作区** —— 新增 / 编辑 / 删除角色；每个角色含名称、显示名、用途、输出合同（`advisor | reviewer | designer | general`）、system prompt、模型、回退与 effort。停用后仍保留在册，但离开工具枚举。
- **自动咨询** —— 默认勾选集、每角色每会话调用上限，以及触发模式（`off | remind | hard-remind`）；输入条开关按会话覆盖勾选集。
- **连通性测试** —— 真实跑通一次完整咨询（CLI + 登录 + 代理），显示实际模型、轮数、时长、费用与「已触发回退」标记。
- **保存并生效** 持久化到 `~/.dsh/dsh-capability-optimizer/settings.json`（原子写、0600 权限）并热生效：agent 工具立即重注册。**恢复默认** 删除该文件回到默认值。

调用参数的 `model` / `effort` 优先于角色值，角色值优先于全局值。内置 advisor 默认推荐 `claude-opus-5`，但这是可覆盖的质量偏好，不是按角色名触发的禁令。`fallbackModel` 在模型级错误时重试一次，并记录 `requestedModel`、CLI 实报的 `actualModel` / `actualModels`、推导出的 `effectiveModel` 与 `usedFallback`。

## 配置（组合层）

行的 config 仍作为基础层生效（一旦保存过设置文件，则以设置文件为准）：

| 键 | 默认 | 含义 |
|---|---|---|
| `cliPath` | `claude` | CLI 不在 PATH 上时的路径。 |
| `model` | CLI 默认 | 调用未指定时的模型别名（`opus`、`sonnet` 等）。 |
| `timeoutMs` | `300000` | 单次咨询墙钟上限。 |
| `maxTurns` | `8` | CLI 内部代理轮数上限。 |
| `maxPanelRoles` | `4` | `consult_panel` 单次角色数上限。 |
| `maxBudgetUsd` | `0` | 单次咨询美元上限（CLI 支持时传 `--max-budget-usd`）。`0` 表示不设上限。 |
| `extraArgs` | `[]` | 附加 CLI 参数，走允许清单。会扩大权限、破坏 JSON 协议或与类型化设置重复的标志会被丢弃并回报。 |
| `roles` | 内置 | 自定义角色：新增，或复用内置角色名覆盖之。 |
| `autoConsult` | `{ enabled: [], capPerRole: 3, mode: 'remind' }` | 默认勾选集、每角色每会话预算，以及触发模式（`off \| remind \| hard-remind`）；旧 `required` 自动迁移。 |

示例——安全向自定义角色：

```yaml
- id: dsh-capability-optimizer
  name: 'dsh-capability-optimizer'
  config:
    model: sonnet
    roles:
      - name: security
        outputKind: reviewer
        description: 聚焦威胁建模的评审者，覆盖认证、加密与注入面。
        systemPrompt: |-
          Objective: falsify the security of the supplied change.
          Report only concrete authentication, authorization, injection,
          secret-handling, or unsafe-parsing defects with a trigger and evidence.
```

## 一次咨询如何运行

- 每次咨询一个 `claude -p` 进程；带标签的 brief 经 **stdin** 送入，共享信任政策与选定角色合同经 `--append-system-prompt` 注入，回复以单个 JSON 文档返回。
- headless 会话由特性探测后的运行时标志共同收敛。当前 CLI 上，`--safe-mode` 会关闭用户/项目指令、skills、plugins、hooks、MCP 与记忆，同时保留认证和内置工具；独立防线仍会传 `--tools Read,Grep,Glob`、`--strict-mcp-config`、`--setting-sources user`、固定的 `--permission-mode` 与 `--no-session-persistence`。旧 CLI 只使用它实际声明支持的层。会扩大写入、执行或外部能力的 `extraArgs` 到不了 argv；文档明确说明的 `--add-dir` 例外可扩大读取范围。调用方取消（`AbortSignal`）与墙钟超时分开回报。
- 墙钟超时（默认 5 分钟）SIGTERM → SIGKILL 递进；`--max-turns`（默认 8）限制 CLI 内部的代理轮数。
- advisor、reviewer、designer、general 分别使用不同 JSON Schema，并只发送 Claude 官方说明支持的子集；本地解析器负责非空字符串等宿主不支持的约束，并检查语义不变量（例如 `pass` 不能同时带 findings）。结构合法不代表主张真实。
- 只有 `objective`、`question`、`success-criteria`、`constraints` 定义任务。代码、注释、文件、当前尝试、验证文本、unknowns 与工具结果都标作不可信证据。这是模型层控制，不是“注入已解决”的安全声明。

## 安全与数据流

**插件保证的部分：**

- 绝不传 `--dangerously-skip-permissions` 等绕过权限的标志。`extraArgs` 是允许清单，不是原样透传。在声明了隔离标志的 CLI 上，一次咨询拿到的正好是 `Read`、`Grep`、`Glob`，且没有任何 MCP server——这一点已在真实 CLI 上验证过，包括面对一个自己的 `.claude/settings.json` 就要 `bypassPermissions` 的项目（[证据](docs/plan/s1-consultant-permission-surface.md)，用 `DCO_LIVE_CLI=1 npm test` 可复现）。每个标志都先特性探测，太旧的 CLI 只会降级而不是整体失败；`meta.safeMode` / `meta.tools` / `meta.strictMcp` / `meta.permissionMode` 如实回报实际生效了什么。
- 提示词只经 argv/stdin 到达本地 CLI——插件自身不引入第三方服务、无遥测、不存凭据。路由强制同源（same-origin）；设置文件 0600 权限原子写入；子进程输出有大小上限，超时必定回收。
- Claude 的回复以工具结果**数据**的形式返回给 DSH agent，并被框定为供权衡的参考答案（“建议而非命令”）；它不会获得高权限指令地位。

**你需要知道的部分（任何 agent 咨询 agent 架构所固有）：**

- **你的材料会离开本机、到达你自己的 Claude 账户。** 问题及作为上下文传入的代码/diff/方案，都由你登录的 Claude Code CLI 处理——与你手动运行 `claude -p` 的数据流完全相同。不要粘贴你不会直接发给 Claude 的机密内容。
- **企业托管政策仍是宿主信任边界。** Claude 官方说明 safe mode 下管理员托管政策仍会生效；插件不会也不应绕过组织策略。
- **Prompt injection 可能发生，未被消除。** 数据/指令分离、schema 与参考答案框架只能降低风险；运行时只读权限、MCP 隔离、输出上限和调用方独立核验用于限制后果。请把回复当外部证据，而不是高权限指令。

## 评测状态

仓库内置受控 reviewer 基准：在同模型、同 effort、同任务、多次 trial 下，对比无角色修辞的最小任务合同、冻结的 0.5.x 旧提示和当前提示；记录完整 prompt/schema 哈希、种子缺陷召回、未匹配 finding、注入成功率、envelope 可靠性、费用、延迟、隔离状态与 CLI 实报模型。正式实验若实报模型与预注册模型不完全一致会立即中止。无额度 dry-run 已通过；这里不宣称已有正式付费结果。参见 [`eval/README.md`](eval/README.md) 与[证据审查](docs/research/prompt-role-evidence.md)。

advisor 与 designer 已有角色专属合同测试，但尚无结果型质量基准。它们目前是接口与工作流选择，不是“专家人设提升智能”的证据。

## 限制

- 第一期仅支持 Claude Code；多后端设置 schema（v2，每 harness 一个工作区）与 codex / zcode / kimi-code / pi / opencode / omp 的标签页均已就位，各自以运行器形式接入同一组工具。
- 每次咨询消耗 Claude 订阅额度；工具描述已告知模型打包材料、避免连发。
- 无流式——每次调用一个 JSON 结果。

## 参与贡献

欢迎 issue 与 PR：[hezhongtang/dsh-capability-optimizer](https://github.com/hezhongtang/dsh-capability-optimizer)。代码库刻意保持小而零依赖——host 侧纯 ESM、浏览器侧手写 CJS bundle、无构建步骤。接入新 harness = 一个 runner 模块（参考 `lib/claude.js`）+ 在 `lib/backends.js` 打开 `available`。

## 许可

[MIT](LICENSE) © 2026 hezhongtang
