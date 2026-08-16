# dsh-capability-optimizer

[![License: MIT](https://img.shields.io/badge/license-MIT-0B7285?style=flat-square)](LICENSE)
[![DSH core](https://img.shields.io/badge/DSH-%3E%3D%200.1.0--rc.6-5B4CF0?style=flat-square)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![Zero build](https://img.shields.io/badge/zero--build-no%20bundler-2EA44F?style=flat-square)](lib)
[![GitHub stars](https://img.shields.io/github/stars/hezhongtang/dsh-capability-optimizer?style=flat-square&logo=github)](https://github.com/hezhongtang/dsh-capability-optimizer/stargazers)

**[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 的外部专家咨询：agent 以无头（headless）方式调用 Claude Code CLI，按角色人设（advisor / reviewer / designer，可自定义）获得订阅模型的回复，作为参考答案供 agent 权衡。**

<p align="center">
  <img src="assets/screenshot-zh.png" width="640" alt="专家咨询设置工作区：每个 harness CLI 一个标签（Claude Code 已可用，六个已预留），含模型 / 推理等级 / 回退的通用默认、角色列表与真实连通性测试。" />
</p>

[English](README.md) | 中文

## 为什么需要它

单一 harness 只有一种视角。当 DSH agent 遇到决策点、完成高风险改动、或要动重要代码时，来自*另一个*模型（Claude，走你现有的 Claude Code 订阅）的第二意见既便宜又能实打实提升质量。本插件把它变成一次正经的工具调用，而不是来回复制粘贴：agent 发起咨询，Claude 按角色回答，回复被框定为**供权衡的建议，而非必须服从的指令**（与 Oh My Pi 的 advisor 契约一致）。

第一期只对接 Claude Code CLI；多后端设置 schema（v2，每 harness 一个工作区）、UI 标签目录与 runner 接缝均已就位——`codex`、`zcode`、`kimi-code`、`pi`、`opencode`、`omp` 后续各自以运行器形式接入同一组工具。

## 功能

| | |
|---|---|
| 🎭 **角色人设** | 内置 advisor / reviewer / designer，或自定义（名称、提示词、专属模型、专属回退、专属推理等级）。omp 风格 `enabled` 开关停用角色而不删除 |
| 🧠 **推理等级** | 原生 `--effort`（low / medium / high / xhigh / max）三级优先：调用参数 > 角色 > 全局默认 |
| 🔄 **模型回退** | 模型级错误（`unrecognized_model`、模型不存在等）单跳重试，运行元数据记录 `usedFallback` |
| 🤖 **Agent 工具** | `consult_expert`（单角色单问题）· `consult_panel`（多角色并行、一次等待）· `consult_roles`（实时角色目录） |
| 🎛 **自动咨询** | 输入条开关（权限控件同行）按会话勾选角色；政策随系统提示下发，写入/收尾锚点自动催办，按角色按会话限额 |
| 🖥 **设置工作区** | 每个 harness CLI 一个标签；保存即热生效——角色修改直达 agent 下一步，无需重启 dsh |
| 🔬 **连通性测试** | 真实跑通一次完整咨询（CLI + 登录 + 代理），显示轮数、时长、费用与回退标记 |
| 🛡 **默认安全** | 永不传绕过权限的标志；headless 会话内只读工具可用、特权操作自动拒绝 |
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

agent 选择角色、把材料打包进 context，调用 `consult_expert`。Claude 的回复以参考答案返回，附运行元数据（会话、轮数、时长、费用）——供 agent 权衡的建议，而非服从的命令。

| 工具 | 读写 | 用途 |
|---|---|---|
| `consult_expert` | 只读* | 单角色单问题，可选 `context` 材料与 `model` / `effort` 覆盖 |
| `consult_panel` | 只读* | 多角色同题并行——一次等待收回全部视角 |
| `consult_roles` | 只读 | 实时角色目录（含角色级模型/推理等级）与全局默认 |

\* 对你的工作区只读；每次调用消耗 Claude 订阅额度——工具描述本身就告知模型打包材料、避免连发。

## 自动咨询

聊天输入条（权限控件那一行）带有专家咨询开关：按会话勾选角色，host 主动把它们纳入工作流——不用提示、不用反复交代。

- **政策区块**：每次模型请求都携带简短的政策块，点名已勾选角色及各自适用时机（advisor 决策点、reviewer 宣称完成前、designer 本轮首次写文件之后的下一步）。自动咨询模式为 `off | remind | required`（默认 `remind`）。
- **生命周期催办**：一轮内的首次文件写入触发 designer 锚点（催办随该轮下一步注入）；改动过文件、即将收尾却未经 reviewer 把关的一轮，会被续跑一步先去咨询。
- **预算**：`capPerRole`（默认 3）按角色按会话统计真实 `consult_*` 调用——催办与模型自主调用共用额度；触顶后政策撤回承诺、锚点静默。
- **软约束（有意为之）**：催办保证指令送达，不保证工具调用——dsh 没有强制调用 API；模型若拒绝须一行说明理由。
- 浮层实时显示各角色的用量（`已用/上限`）；上次的选择按浏览器记忆。**设置 → 专家咨询 → 自动咨询** 编辑默认勾选集与预算（行配置键 `autoConsult`）——tui/headless 直接消费同一层。

## 设置界面

**设置 → 专家咨询** 按 harness CLI 组织为独立工作区——顶部标签栏来自 harness 目录（`claude-code` 可用；`codex`、`zcode`、`kimi-code`、`pi`、`opencode`、`omp` 均已预留工作区，运行器就绪前不存任何设置）。Claude Code 工作区运行时管理一切：

- **通用** —— CLI 路径、默认模型（完整目录：跟随 CLI 默认、最新别名、带版本全名如 `claude-opus-5`——直接取自 CLI 本体）、推理等级（`--effort`：低/中/高/超高/最大）、回退模型、单次超时、CLI 内最大轮数、并行会诊上限、附加 CLI 参数。
- **角色工作区** —— 新增 / 编辑 / 删除角色，每个角色含名称、显示名、用途说明、提示词、专属模型、专属回退与专属推理等级。角色开关为 omp 风格停用：保留在册但离开工具枚举，重新启用即恢复。
- **自动咨询** —— 默认勾选集与每角色每会话调用上限；输入条开关按会话覆盖。
- **连通性测试** —— 真实跑通一次完整咨询（CLI + 登录 + 代理），显示轮数、时长、费用与"已触发回退"标记。
- **保存并生效** 持久化到 `~/.dsh/dsh-capability-optimizer/settings.json`（原子写、0600 权限）并热生效：agent 工具立即重注册。**恢复默认** 删除该文件回到默认值。

角色专属 `model` 与 `effort` 优先于全局默认；调用参数里的 `effort` 优先级最高。`fallbackModel`（角色级或全局级）在 Claude 报模型级错误（`unrecognized_model`、模型不存在等）时重试一次，运行元数据会记录 `usedFallback`。

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
| `autoConsult` | `{ enabled: [], capPerRole: 3, mode: 'remind' }` | 默认勾选集（角色键如 `claude-code:reviewer`）、每角色每会话预算，以及触发模式（`off \| remind \| required`）。 |

示例——安全向自定义角色：

```yaml
- id: dsh-capability-optimizer
  name: 'dsh-capability-optimizer'
  config:
    model: sonnet
    roles:
      - name: security
        description: 聚焦威胁建模的评审者，覆盖认证、加密与注入面。
        systemPrompt: |-
          Role: security reviewer.
          Threat-model the material: authentication, authorization, injection,
          secrets handling, and unsafe parsing. Rate each finding by exploitability.
```

## 一次咨询如何运行

- 每次咨询一个 `claude -p` 进程；问题（及可选材料）经 **stdin** 送入，角色人设经 `--append-system-prompt` 注入，回复以单个 JSON 文档返回。
- 当已安装的 CLI 声明了 `--tools` 时，headless 会话被限制为 Read/Grep/Glob。会扩大权限的 `extraArgs` 到不了 argv。调用方取消（`AbortSignal`）与墙钟超时分开回报。
- 墙钟超时（默认 5 分钟）SIGTERM → SIGKILL 递进；`--max-turns`（默认 8）限制 CLI 内部的代理轮数。
- 每次回复都带有给 Claude 的共同框架——*这是另一个 agent 将要权衡的参考答案*——自定义角色同样继承“建议而非命令”的契约。

## 安全与数据流

**插件保证的部分：**

- 绝不传 `--dangerously-skip-permissions` 等绕过权限的标志。`extraArgs` 是允许清单，不是原样透传。当已安装的 CLI 声明了 `--tools` 时，咨询被限制为 Read、Grep、Glob。
- 提示词只经 argv/stdin 到达本地 CLI——插件自身不引入第三方服务、无遥测、不存凭据。路由强制同源（same-origin）；设置文件 0600 权限原子写入；子进程输出有大小上限，超时必定回收。
- Claude 的回复以工具结果**数据**的形式返回给 DSH agent，并被框定为供权衡的参考答案（"建议而非命令"），不构成指令通道。

**你需要知道的部分（任何 agent 咨询 agent 架构所固有）：**

- **你的材料会离开本机、到达你自己的 Claude 账户。** 问题及作为上下文传入的代码/diff/方案，都由你登录的 Claude Code CLI 处理——与你手动运行 `claude -p` 的数据流完全相同。不要粘贴你不会直接发给 Claude 的机密内容。
- **Prompt injection 可能发生，未被消除。** 若被咨询的材料（例如 Claude 从工作区读到的恶意文件）操纵了它的回复，该回复会以文本形式到达 DSH agent。参考答案框架与“权衡而非盲从”契约是缓解手段，但请以对待网络搜索结果的审慎态度对待专家回复——这是所有双模型工作流共同的残余风险类别。

## 限制

- 第一期仅支持 Claude Code；多后端设置 schema（v2，每 harness 一个工作区）与 codex / zcode / kimi-code / pi / opencode / omp 的标签页均已就位，各自以运行器形式接入同一组工具。
- 每次咨询消耗 Claude 订阅额度；工具描述已告知模型打包材料、避免连发。
- 无流式——每次调用一个 JSON 结果。

## 参与贡献

欢迎 issue 与 PR：[hezhongtang/dsh-capability-optimizer](https://github.com/hezhongtang/dsh-capability-optimizer)。代码库刻意保持小而零依赖——host 侧纯 ESM、浏览器侧手写 CJS bundle、无构建步骤。接入新 harness = 一个 runner 模块（参考 `lib/claude.js`）+ 在 `lib/backends.js` 打开 `available`。

## 许可

[MIT](LICENSE) © 2026 hezhongtang
