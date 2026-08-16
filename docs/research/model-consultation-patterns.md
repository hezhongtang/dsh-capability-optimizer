# 模型咨询 / 评审 / 规划回传模式研究

> 调研截止：2026-08-16
>
> 范围：主模型仍拥有任务与最终决策权，另一个模型或 agent 作为顾问、评审者或规划者，把结果回传给主模型权衡。仅采用官方文档、规范、官方仓库源码/README 与论文原文。
>
> 本地审计对象：当前工作区的 `0.5.0` 快照（包含审计开始前已经存在的未提交改动）；本报告没有修改产品代码。

## 结论先行

`dsh-capability-optimizer` 的核心架构应保留：把 Claude Code 封装成 `consult_expert` / `consult_panel`，以一次性、隔离的 headless 会话产出“供主 DSH agent 权衡的参考答案”。它与 OpenAI Agents SDK 的 manager + agents-as-tools、Claude Code subagent 的结果回传属于同一种成熟模式；它不是 handoff，也不需要升级成常驻 agent team。

研究支持的是“把现有深模块做深”，而不是更换编排框架：

1. **P0：先修工具生命周期契约。** DSH 异步工具要求通过 `exec.signal` 协作取消，但三个咨询工具都忽略执行上下文，Claude 子进程只能等自身 timeout；应把调用方取消一路传到 runner，并在进程真正退出后结算。
2. **P0：封住真实的权限参数缺口。** 当前实现声称从不传绕过权限的参数，但 `extraArgs` 经字符串清洗后原样追加，因此用户配置仍可注入 `--dangerously-skip-permissions`、覆盖输出格式或改写其他关键语义；应改为显式允许清单，并默认给顾问只读工具集合和 `--no-session-persistence`。
3. **P0：让预算、角色与会话状态成为真实约束。** 现有计数只让自动 nudge 静默，工具仍可超预算调用；失败尝试也会提前满足本轮 reviewer/designer 锚点；`dropSession()` 未接入 `session/disposed`。应区分 attempt/success、在调度层执行硬上限、过滤失效角色并清理会话状态。
4. **P0：统一真实调用与连接测试。** `/test` 直接调用 CLI，没有走角色/global model、effort 和 fallback 的完整解析链；“测试成功”不等于真实咨询路径成功。应抽出共享 consultation service，工具和路由共用。
5. **P1：先建对照评估，再扩大自动咨询。** 多 agent 提升常与更多 token/调用混杂；应比较相同总推理预算下的“不咨询 / 单顾问 / 生命周期评审 / panel”，而不是只看主观体验。
6. **P1：给建议增加稳定的结构化信封。** 保留正文，但补充 `verdict`、`findings[]`、severity、confidence、evidence/location、checked scope、unknowns；主 agent 仍负责采纳或拒绝。
7. **P1：自动 reviewer 应默认收到变更范围、验收标准与测试结果。** 官方代码评审实现都强调 changed code、证据定位、置信度和二次验证；仅提示主模型“请传 context”不够可审计。
8. **P1：补足并发、去重、隐私与观测。** 在现有轮数、超时、费用元数据上，增加全局/每会话并发上限、重复请求指纹、可选美元预算、请求/上下文字节或 token、失败分类，以及建议最终被采纳/拒绝/忽略的结果事件。
9. **不建议：** 不采用已弃用的 MCP Sampling；不把普通咨询改成 handoff；不默认开启 panel、辩论或 agent team；不照搬 Oh My Pi 的常驻 watchdog；不让顾问直接修改代码。只有评估证明高风险场景确有净收益，才增加第二评审或验证轮。

## 1. 判定标准：什么才是“咨询回传”

本报告用控制权而不是 API 名称分类：

| 模式 | 任务/最终回答由谁拥有 | 辅助结果是否回到主模型 | 本报告判定 |
|---|---|---:|---|
| manager 调用 model-backed tool / subagent | 主模型 | 是 | **真正的咨询回传** |
| critic/evaluator 对草稿给反馈，再由主流程修订 | 主模型或显式编排器 | 是 | **真正的评审回传** |
| handoff / transfer | 被交接 agent | 通常不是回给原主模型继续权衡 | **完全交接，不是目标模式** |
| 普通确定性工具（搜索、读文件、计算） | 主模型 | 返回数据而非另一模型判断 | **普通工具调用** |
| agent team | lead 或共享任务系统 | 只有成员显式发消息/产物才回传 | **可实现咨询，但机制更重** |
| MCP Sampling | MCP server 请求 client 代为调用模型 | 结果先回 server | **模型调用边界，不天然等于咨询** |

OpenAI 官方明确把 manager + `Agent.as_tool()` 描述为“中心 agent 保持会话控制、调用专家并合成最终结果”，而 handoff 会把当前对话路由给专家；二者正好划定本报告边界。[OpenAI Agents SDK：Multi-agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)

## 2. 代表性机制

### 2.1 MCP：工具边界正确，Sampling 已弃用

**状态：已发布规范中的弃用能力；不是建议采用的新架构。** 当前 MCP 规范版本为 2026-07-28；`Sampling` 在该版本被正式标记为 deprecated，新实现不应采用，迁移方向是直接调用模型 provider API，最早移除时间为 2027-07-28 之后的规范版本。[MCP 2026-07-28 Sampling](https://modelcontextprotocol.io/specification/2026-07-28/client/sampling) [Deprecated Features](https://modelcontextprotocol.io/specification/2026-07-28/deprecated) [SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging)

Sampling 原机制是 server 发出 `sampling/createMessage`，client 保留模型选择、权限与人工审批；如开放工具，server 自己拥有多轮 tool loop，并应限制迭代次数。规范同时要求客户端可审阅/修改请求与结果、验证输入、限速并防止敏感数据泄露。[MCP Sampling](https://modelcontextprotocol.io/specification/2026-07-28/client/sampling)

弃用提案给出的原因包括采用率低、模型选择和人工审批复杂、工具安全负担，以及 prompt injection / data exfiltration 攻击面；因此“让 MCP server 借 client 的模型做顾问”不再是面向未来的建议。[SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging)

普通 MCP tools 仍是稳定边界：工具可以声明 `outputSchema` 并返回 `structuredContent`；执行失败应通过 `isError` 暴露给模型，使模型有机会纠正请求。客户端应实施超时、日志与结果校验，服务端应验证输入、限速并清理输出。[MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

**对本仓库的判断：** 当前通过 DSH tool 调用独立 Claude CLI、把结果作为工具结果交回主模型，比 MCP Sampling 更符合当前规范方向。将来若提供 MCP 接口，应暴露普通的 model-backed tool，而不是实现 Sampling。结构化返回和模型可见的细分错误值得借鉴。

### 2.2 Claude Code subagents 与 agent teams

**Subagents 状态：已发布能力，精确匹配咨询回传。** Claude Code subagent 可配置独立 system prompt、tools、model、effort、`maxTurns`、memory 与 isolation；每个 subagent 使用新上下文，不自动继承主会话或主 agent 已读内容，任务提示必须显式给足。完成后，其最终消息作为 Agent tool result 回给主 agent；前台调用串行阻塞，后台调用可并行并稍后汇报。[Claude Code Subagents](https://code.claude.com/docs/en/sub-agents) [Agent SDK Subagents](https://code.claude.com/docs/en/agent-sdk/subagents)

官方示例包含限制为只读工具的 code reviewer，证明“隔离评审者读取工作区、只返回建议、不直接修改”是一等用法。隔离也意味着顾问不能神奇地知道主 agent 的隐含上下文；这是本仓库 `question + context + workspace` 合同应继续明确的原因。[Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)

Claude CLI 已提供 `--max-turns`、`--max-budget-usd`、`--no-session-persistence` 与 `--json-schema`；结构化输出会按 JSON Schema 校验，不匹配时重试，超过重试限制则失败。[Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage) [Structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)

Claude Agent SDK 还可通过 OpenTelemetry 记录 interaction、LLM、tool 与 hook spans；`claude -p` 支持传入 W3C trace context，但该观测能力在官方文档中仍标有 beta，适合作为可选接入，不应成为核心依赖。[Claude Agent SDK Observability](https://code.claude.com/docs/en/agent-sdk/observability)

**Agent teams 状态：官方 research preview，只有部分匹配。** team 由 lead、多个独立 Claude Code session、共享 task list 和 mailbox 组成；队友不继承 lead 历史，必须主动向 lead 发消息才能交付结果，idle 通知本身不携带结果。官方建议团队规模约 3–5，适合可真正并行的研究/评审；对强依赖、共享上下文的工作协调开销高，队员也可能过早停止或失败。[Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)

官方成本文档估算 agent teams 在 plan mode 下大约消耗普通会话 7 倍 token，这不是一次轻量咨询的合理默认。[Claude Code Costs](https://code.claude.com/docs/en/costs)

**对本仓库的判断：** 现有“一调用一隔离 `claude -p`、最终文本回传”已经是轻量 subagent 语义。可增配结构化 schema、美元预算和无持久化；没有证据支持为三个固定角色引入 mailbox、共享任务表和常驻团队。

### 2.3 OpenAI Agents SDK：manager / agents-as-tools 与 handoff

**状态：已发布 SDK 能力。** Agents-as-tools 是嵌套 run：manager 保留对话和最终回答权，可并行或串行调用专家、组合结果，并集中施加 guardrails。Handoff 则把当前会话的下一阶段交给目标 agent，通常让目标看到历史，并可用 `input_filter` 修改传递内容。[Multi-agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/) [Handoffs](https://openai.github.io/openai-agents-python/handoffs/)

`Agent.as_tool()` 的子 run 默认不会自动继承父对话状态；可显式传 session。它支持 `max_turns`、hooks、approvals、条件启用、streaming，以及 `custom_output_extractor` 对专家最终结果进行抽取、校验或 fallback。[Agents as tools](https://openai.github.io/openai-agents-python/tools/)

SDK 的 run loop 在超过轮数时抛出 `MaxTurnsExceeded`，工具可配置 timeout，并能将找不到工具等错误交给模型恢复；usage 对每次请求和整次 run 统计输入、输出和总 token。[Running agents](https://openai.github.io/openai-agents-python/running_agents/) [Usage tracking](https://openai.github.io/openai-agents-python/usage/)

Tracing 会记录 generations、tools、handoffs、guardrails 等 spans；默认可能包含敏感输入输出，因此生产接入必须先定义脱敏和保留策略。[Tracing](https://openai.github.io/openai-agents-python/tracing/)

**对本仓库的判断：** `consult_expert` 就是 agents-as-tools / manager pattern；不要改成 handoff。最值得移植的是 output extractor 的思想：顾问可输出自然语言，但插件把 verdict、findings、元数据和错误包装成稳定结构。

### 2.4 Aider architect/editor

**状态：已发布产品模式；属于规划者到执行者的流水线，不是原主模型最终权衡。** Architect mode 先让 architect model 给出解决方案，再让 editor model 把方案转成文件编辑；一次用户请求通常需要两次模型调用，因此更慢、更贵。两者可以是同一模型，但职责提示不同。[Aider Modes](https://aider.chat/docs/usage/modes.html)

Aider 用 `editor-diff` / `editor-whole` 等专用编辑格式让 architect 只做问题求解、editor 只生成合法修改，说明把“思考质量”和“工具格式服从性”分开可以形成更深接口。[Aider Edit formats](https://aider.chat/docs/more/edit-formats.html)

Aider 官方 2024 benchmark 报告 architect/editor 组合在其代码编辑基准上的提升，例如 Sonnet/Sonnet 从 77.4% 到 80.5%、GPT-4o/GPT-4o 从 71.4% 到 75.2%，o1-preview 配 o1-mini 或 DeepSeek editor 达 85%；同文也指出双调用延迟和模型组合会显著影响实用性。该证据只覆盖当时的 Aider 编辑基准，不能外推为“所有任务都应双模型”。[Aider Architect benchmark](https://aider.chat/2024/09/26/architect.html)

**对本仓库的判断：** 可让 designer 输出更接近实施合同的模块/API/失败模式，但不应让 consultant 直接进入 editor 阶段。DSH 主 agent 已是实施者，继续保留“读、建议、回传；主模型决定并修改”的边界更安全。

### 2.5 Claude Code 官方插件中的评审编排

**状态：已发布官方仓库示例。** 官方 `code-review` 插件并行运行多个专门 reviewer，给 finding 打 0–100 confidence，过滤低于 80 的结果，并对候选 finding 再做独立验证后去重输出。[Code Review plugin README](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/README.md) [Code Review command](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/commands/code-review.md)

`pr-review-toolkit` 将评审拆为注释、测试、错误处理、类型、代码质量与简化等专家；可按依赖选择并行或串行，finding 包含文件/行号、原因、改进方式与 severity，并明确提醒不要无差别过度使用全套评审。[PR Review Toolkit](https://github.com/anthropics/claude-code/blob/main/plugins/pr-review-toolkit/README.md)

`security-guidance` 的 Stop 阶段会让模型检查 diff，只把高严重度问题送回主流程；其并行双评审说明称召回率仅增加几个百分点但 API 成本约翻倍，因此多数用户不需要。[Security Guidance](https://github.com/anthropics/claude-code/blob/main/plugins/security-guidance/README.md)

**对本仓库的判断：** panel 应继续 opt-in。高风险 reviewer 可选“候选 finding → 独立验证”两阶段，但默认单 reviewer 更符合成本证据。无论单人还是 panel，都应要求 changed code、location、severity、confidence 和 checked scope。

### 2.6 Oh My Pi Advisor Watchdog

**状态：开源仓库中的已实现机制；不是行业规范。** 已定位原始实现：Oh My Pi 可给主 session 挂一个或多个 advisor，持续读取主 transcript 的增量；advisor 在独立 `ToolSession` 中可用 read/grep/glob 检查工作区，建议经 XML 转义后以 `<advisory>` 注入，并明确标注应权衡而非盲从。[Advisor Watchdog 文档](https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md) [runtime.ts](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/advisor/runtime.ts) [system prompt](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/prompts/advisor/system.md)

它不是简单“后台再问一次模型”：实现包含 `nit/concern/blocker` 分级、仅 blocker 可中断正在进行的工作、默认三轮免打扰、规范化去重、过滤 advisor 自己的历史以防递归、compaction/switch/fork 后有界重放，以及最多 1/3/5 的异步 backlog。[Advisor Watchdog 文档](https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md) [emission guard](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/advisor/emission-guard.ts)

失败处理也很重：最多等待约 30 秒；可重试故障连续三次后丢弃该批并停止，quota 故障则暂停并保留批次，不安全输出进入 quarantine；`/advisor status` / dump 暴露模型、context、tokens、cost 和原始/压缩状态。[Advisor Watchdog 文档](https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md) [advise-tool.ts](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/advisor/advise-tool.ts)

**对本仓库的判断：** 现有 shared preamble 的“reference answer, weigh it”与 OMP 契约一致；可借鉴 severity、confidence、去重和可见状态。但常驻 transcript watcher 需要处理回放、递归、节流、隔离、失败积压和中断，复杂度远超当前写后 designer / 停止前 reviewer 两个锚点。除非 DSH 暴露稳定 delta/steer 接口且评估显示持续监听明显优于锚点，不应照搬。

### 2.7 AutoGen：reflection / nested agent

**状态：已发布开源框架模式；AutoGen 官方仓库当前处于维护模式。** AutoGen Core 的 reflection 示例用 coder 与 reviewer 循环，reviewer 返回结构化 `CodeReviewResult`（review、approved、feedback），直到批准或达到最大迭代；事件日志包含 token usage。[AutoGen Reflection](https://microsoft.github.io/autogen/0.5.5/user-guide/core-user-guide/design-patterns/reflection.html)

当前官方仓库 README 的 `AgentTool` 示例把多个专家包装为 manager 的工具，并通过 `max_tool_iterations` 限制工具循环；同一 README 明示 AutoGen 进入 maintenance mode，并推荐新项目关注 Microsoft Agent Framework。[Microsoft AutoGen repository](https://github.com/microsoft/autogen)

**对本仓库的判断：** 可借鉴“明确批准/返工 + 上限”的 evaluator loop，但无需引入框架。顾问自称 approved 不是正确性证明；只有测试、静态检查或独立验证能作为结束条件，主模型仍须判断。

### 2.8 LangGraph：evaluator-optimizer 与 orchestrator-worker

**状态：已发布开源框架模式。** LangGraph 官方工作流把 evaluator-optimizer 定义为 generator 生成、evaluator 给结构化 feedback、循环到 accepted；orchestrator-worker 使用 `Send` 动态创建带隔离 state 的 workers，结果写回共享聚合字段，独立任务可并行。[LangGraph Workflows and agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents)

LangChain 的当前多 agent 总览把常见机制明确分为 subagents、handoffs、skills、router 和 custom workflow：subagents 是“主 agent 把专家当工具并保持所有路由权”，skills 则只是在同一个 agent 中按需加载提示和知识。官方同时提醒，单 agent 配合合适的工具和动态 context 往往已足够；subagents 的额外调用换来集中控制和强上下文隔离，尤其适合大上下文、多领域并行任务。[LangChain Multi-agent](https://docs.langchain.com/oss/python/langchain/multi-agent)

并行分支按 superstep 提交；分支异常时该 superstep 的更新回滚。配置 checkpointer 后，成功分支可保留、只重试失败分支；另有 `RetryPolicy` 与 `max_concurrency` 控制失败和并发。[LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/use-graph-api)

LangSmith 官方建议同时评估图的端到端结果和中间 node，因为最终正确可能掩盖错误轨迹，中间过程正确也不保证最终答案正确。[Evaluating a graph](https://docs.langchain.com/langsmith/evaluate-graph)

**对本仓库的判断：** 当前正是轻量的 subagents-as-tools，而不是“skill 里再写几段角色提示”或 handoff；固定三个角色、一次工具回传不需要状态图。应借鉴的是：部分 panel 结果可保留、失败角色单独标记；同时评估咨询 finding 的质量和最终代码质量，不把“顾问有输出”当作成功。

### 2.9 Skills 与 Plugins：适合封装流程，不等于第二模型

**状态：已发布的提示/分发机制。** OpenAI Skills 把 instructions、references、assets 和 scripts 按需加载到当前 agent；它适合固化“何时咨询、怎样打包 context、如何验证建议”等工作流，但默认仍是同一个模型在执行，不提供独立视角。Plugins 则把 skills、MCP servers/connectors 与其他扩展打包分发；它决定能力如何安装和发现，不决定咨询质量。[OpenAI Skills](https://developers.openai.com/codex/skills) [OpenAI Plugins](https://developers.openai.com/codex/plugins)

因此应把几个层次分开：skill 是可复用的流程知识，plugin 是分发容器，MCP/tool 是能力边界，model-backed tool/subagent 才是“再请求一个模型给建议”的运行机制。Claude Code 官方 code-review / pr-review-toolkit 也说明 plugin 可以携带并行 reviewer 或命令编排，但真正产生独立意见的仍是内部 agent 调用，而不是 plugin 这个包装本身。

**对本仓库的判断：** 当前 DSH plugin + model-backed tools 的分层是对的。未来可附带一个很薄的 skill/系统策略来教主模型生成 consultation packet 和解释返回 schema，但不要把角色提示、预算和安全规则同时复制到 skill 与 JavaScript 两套来源；这些契约应由 consultation service 单点拥有。

## 3. 横向比较

| 机制 | 上下文隔离 | 串/并行 | 预算/终止 | 失败处理 | 返回结构与观测 | 主要局限 |
|---|---|---|---|---|---|---|
| 本仓库 | 每次新 `claude -p`；显式 context + 可读 workspace | 单专家串行；panel `Promise.all`，无跨调用 semaphore | timeout、`maxTurns`、仅自动锚点读取每角色计数 | model-level 一跳 fallback；panel 保留部分成功；未接 caller abort | 自由文本 + session/turn/duration/cost | 输出不可机器判断；预算非硬门；session 未清理；测试路径漂移；`extraArgs` 边界不安全 |
| MCP Sampling | client 控模型和权限；server 编排 loop | 由 server 决定 | 应设迭代/限速 | 协议错误 + 应用错误 | message，可带 tools | **已弃用**；审批、模型选择和安全复杂 |
| Claude subagent | 新上下文，不继承主历史 | 前台串行、后台并行 | max turns、美元预算 | tool result 报错；可 resume | 最终消息；可 JSON Schema / OTEL | 必须显式打包上下文；并行增加 token |
| Claude agent team | 每队员完整独立 session | 原生并行 + mailbox | lead/task list；高 token 成本 | 队员可能停止/失败，需协调 | 显式消息/任务状态 | research preview；咨询场景过重 |
| OpenAI agents-as-tools | nested run 默认不继承父 state | manager 决定，可并行 | max turns、timeouts、usage | exception/timeout/fallback extractor | 可自定义输出抽取、完整 trace | tracing 可能含敏感数据 |
| Aider architect/editor | 角色提示和输出格式隔离 | 两阶段串行 | 两调用；历史软限额 | editor 格式约束 | 计划 → 编辑 | 自动实施，不是原主模型最终权衡；慢/贵 |
| OMP watchdog | 独立 ToolSession + transcript delta | 异步 backlog | cooldown、backlog、重试/等待上限 | drop/halt、quota pause、quarantine | XML advisory、severity、status/tokens/cost | 持续监听状态机复杂 |
| AutoGen reflection | agent state 分离 | 典型串行循环 | max iteration | 框架事件/终止条件 | 结构化 approval/feedback + usage | approval 仍是模型判断；项目维护模式 |
| LangGraph evaluator | node/worker state 显式 | 图控制并行 | recursion/concurrency/retry | checkpoint + 分支重试 | typed state + node/end-to-end eval | 引入图运行时对本插件过重 |
| Skills / Plugins | skill 内容进入当前 agent；plugin 只是打包边界 | 由宿主工作流决定 | 由宿主决定 | 由宿主决定 | instructions/resources/tools 的分发 | 本身没有独立模型判断，不能替代 model-backed tool |

## 4. 对当前实现的审计映射

当前 `consult_expert` 明确把结果描述为 reference answer；`consult_panel` 对去重后的角色用 `Promise.all` 并行，单角色失败不会抹掉其他成功结果；模型级错误才做一次 fallback。这些选择与 manager/agents-as-tools、隔离 subagent 和部分结果保留相符。[lib/tools.js](../../lib/tools.js#L88-L123) [lib/tools.js](../../lib/tools.js#L128-L185)

每次咨询新建 `claude -p`，stdin 传问题，`--append-system-prompt` 传角色，超时后 SIGTERM/SIGKILL，输出上限 8 MiB，并解析 session、轮数、时长与成本；这是不错的隔离、资源和基本观测基线。[lib/claude.js](../../lib/claude.js#L1-L19) [lib/claude.js](../../lib/claude.js#L65-L168) [lib/claude.js](../../lib/claude.js#L175-L198)

角色提示已要求 ground claims、说明猜测；reviewer 要 verdict、按严重度、location、breakage、minimal fix 和 checked scope；designer 要模块/API/数据流/失败模式、替代方案和可逆接口。这与外部最佳实践高度一致，无需重写角色体系。[lib/roles.js](../../lib/roles.js#L17-L52)

自动咨询是软策略：首次写文件后提示 designer，修改后停止前提示 reviewer；代码注释也明确 nudge 不保证 tool call。每角色默认三次计数只会让 policy/anchor 静默，不会从 `consult_expert` 执行层拒绝超额调用。[lib/autoconsult.js](../../lib/autoconsult.js#L1-L20) [lib/autoconsult.js](../../lib/autoconsult.js#L116-L123) [lib/autoconsult.js](../../lib/autoconsult.js#L173-L225)

最重要的事实缺口是：README 写着“不传任何绕过权限的 flags”，但 `extraArgs` 仅过滤空字符串后保存，runner 又把每个值原样追加。因此当前保证并非由代码强制。[README.md](../../README.md#L122-L130) [lib/settings.js](../../lib/settings.js#L197-L199) [lib/claude.js](../../lib/claude.js#L79-L85)

本机审计所用 DSH / `@deepseek-ai/dsh-tools` 版本为 `0.1.0-rc.6`；其合同要求异步工具通过 `ToolRunContext.exec.signal` 协作停止。当前三个 `execute(args)` 都没有接收第二参数，`runClaudeConsult()` 也没有 `AbortSignal`。因此用户取消、agent 中止或 host timeout 到来时，外层调用可结束，但 `claude` 进程仍可能继续到插件自己的 wall-clock timeout。[lib/tools.js](../../lib/tools.js#L128-L185) [lib/claude.js](../../lib/claude.js#L65-L168)

自动预算当前不是硬上限：`budgetLeft()` 只用于 designer/reviewer 锚点；`policyText()` 即使某角色已用尽仍继续列出该角色；`consult_expert` / `consult_panel` 的执行路径完全不读取 session 预算。计数又发生在 `tool/call` 而非结果事件，所以失败、被取消或被拒绝的尝试既消耗计数，也会让本轮锚点认为已咨询。正确模型应至少区分 `attempted/succeeded/failed`：attempt 决定费用上限，只有 success 才满足质量 gate。[lib/autoconsult.js](../../lib/autoconsult.js#L116-L123) [lib/autoconsult.js](../../lib/autoconsult.js#L173-L193) [lib/autoconsult.js](../../lib/autoconsult.js#L239-L254) [lib/autoconsult.js](../../lib/autoconsult.js#L288-L307)

生命周期状态也有一个明确缺口：runtime 已实现 `dropSession()`，但 wiring 没监听 DSH 已提供的 `session/disposed`，因此已关闭 session 的 override、计数、pending 和 turn flags 会留在内存中。[lib/autoconsult.js](../../lib/autoconsult.js#L86-L129) [lib/autoconsult.js](../../lib/autoconsult.js#L269-L338)

连接测试没有复用生产调用语义。工具路径按 call override → role → global 解析 model/effort，并只在 model-level error 时尝试 fallback；`/test` 则直接运行 CLI，只采用请求体 model，不采用 role/global model、effort 或 fallback。UI 即使显示成功、失败或 `usedFallback`，也不能证明真实工具路径等价可用。[lib/tools.js](../../lib/tools.js#L88-L123) [lib/routes.js](../../lib/routes.js#L171-L206)

仓库当前没有 test script 或自动测试目录；现有静态语法检查不足以覆盖 abort race、预算原子性、fallback、settings hot-apply、session cleanup 和 panel 部分失败。这使以上 P0 契约没有回归护栏，也是本轮建议“先补契约测试、再增强自动咨询”的直接理由。[package.json](../../package.json)

还有三项次一级边界：panel 只限制单次角色数，没有跨调用或每 session 的 in-flight semaphore；问题/context 没有字节或 token 上限与重复指纹；designer 文案说“在重大新代码之前”，实际锚点只能在第一次写工具已经发生后于下一 step 提醒。这些都不要求换架构，但应分别通过并发上限、bounded context packet + dedupe，以及明确的 `off | remind | required` 触发语义解决。[lib/tools.js](../../lib/tools.js#L152-L185) [lib/autoconsult.js](../../lib/autoconsult.js#L195-L209) [lib/autoconsult.js](../../lib/autoconsult.js#L341-L345)

## 5. 分级优化建议

### P0：发布前应完成

#### 5.1 贯通 DSH 取消信号并约束进程并发

三个 tool definition 都应实现 `execute(args, exec)`，把 `exec.signal` 传入共享 consultation service 和 `runClaudeConsult()`。runner 在收到 abort 时先停止接收/写入、向子进程发送终止信号，必要时升级强杀，并且等子进程 `close` 后只结算一次。timeout 与调用方取消应分别返回 `timedOut` / `aborted`，不能混成普通 CLI error。

同时增加全局和每 session 的 in-flight semaphore；`consult_panel` 的 `maxPanelRoles` 只限制一次 tool call，不能阻止多个并发 tool call 启动无界数量的 CLI 进程。队列等待也必须响应同一个 abort signal。以上是 host 正确性与资源上限，不需要等质量实验。

#### 5.2 将 `extraArgs` 从原样透传改为安全接口

优先使用**允许清单**，只开放不会扩大权限、不会破坏 JSON 协议、不会覆盖插件已管理字段的参数。至少拒绝：

- `--dangerously-skip-permissions`、`--permission-mode` 及任何工具权限扩大项；
- `--allowedTools` / `--disallowedTools`、MCP 配置等会改变可用能力的项；
- `--system-prompt` / `--append-system-prompt`、`--output-format` / `--json-schema`；
- `--model`、`--effort`、`--max-turns`、`--max-budget-usd` 等应由类型化设置拥有的重复项。

这不是“增强功能”，而是让实现兑现现有安全承诺。MCP 对 model-backed tools 同样要求服务端验证输入、限速、清理输出，客户端实施审批与超时，支持这一边界判断。[MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

默认运行参数还应显式加入只读工具集合（例如当前 CLI 支持的 Read/Grep/Glob）和 `--no-session-persistence`。`--safe-mode` 会同时关闭 CLAUDE.md、plugins、hooks 和 MCP，可能损失有用的项目规则，适合作为更严格的可选隔离档而不是未经评估的唯一默认。

#### 5.3 对齐预算、成功语义、角色与会话生命周期

- 在调用真正启动前原子占用 attempt budget，工具层与 auto policy 共用同一个 per-session ledger；不能只靠提示文字约束模型。
- attempt 用于限制费用；只有拿到可用结果的 success 才满足 reviewer/designer gate。另记 failed/aborted，避免失败咨询被误认为质量检查完成。
- policy 只列出仍有预算且在实时 roster 中 enabled 的角色；composer override 中的未知、已禁用或其他 backend 角色要被过滤并向 UI 暴露原因。
- 监听 `session/disposed` 调用现有 `dropSession()`，同时取消该 session 排队中和运行中的咨询，防止状态泄漏或 stale override。
- 明确 cap 是“每 session 每角色的 attempts 上限”，panel 中每个实际启动的角色各计一次；fallback 是同一次 attempt 的内部重试还是第二次收费，也要在 UI 和 metadata 中固定语义。

#### 5.4 抽出唯一的 consultation service

把 role/model/effort 解析、fallback、budget、并发、安全参数、结构化解析和 metadata 统一放进一个 service。`consult_expert`、`consult_panel` 和 `/test` 只做输入适配并调用它；连接测试应返回 effective model/effort、是否 fallback、最终工具集合与失败分类，保证它测试的是生产路径而非一个相似的 CLI 命令。

### P1：有明确价值，完成 P0 后实施

#### 5.5 建立预算匹配的评估基线

至少构造四组：DSH 单独完成、一次 `advisor/reviewer`、生命周期自动 reviewer/designer、并行 panel。每组除原始运行外，再做“给单 agent 同等额外 token/时间”的 compute-matched control。

推荐指标：

- 任务级：测试/构建通过率、隐藏验收通过率、回归数、人工盲评；
- finding 级：seeded bug precision/recall、severity 校准、证据可复现率、重复率；
- 决策级：建议采纳/拒绝/忽略、采纳后是否修复、错误建议采纳率；
- 资源级：端到端延迟、输入/输出 token、调用数、费用、timeout/fallback 率。

Anthropic 的多 agent research 系统在其内部研究评估中比单 agent 高 90.2%，但同文称 token 使用解释约 80% 的性能差异、multi-agent 相对普通聊天可用约 15 倍 token，并指出 coding 往往缺少足够可并行子任务；所以不做预算匹配会把“更多计算”误判为“架构更好”。[Anthropic Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

#### 5.6 稳定结构化建议协议

建议返回：

```json
{
  "verdict": "pass | revise | uncertain",
  "summary": "供主 agent 权衡的建议",
  "findings": [
    {
      "severity": "blocker | high | medium | low | nit",
      "confidence": 0.0,
      "location": "file:line 或材料片段",
      "evidence": "可复查依据",
      "impact": "什么会坏",
      "minimal_action": "最小修复"
    }
  ],
  "checked_scope": [],
  "unknowns": []
}
```

外层仍保留 `ok/role/meta`，schema 失败应返回可辨别错误或降级为原始正文，不得静默伪造 `pass`。Claude CLI 的已发布 `--json-schema`、MCP `structuredContent`、AutoGen 的 typed review 都说明这种接口可行。[Claude Structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs) [MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) [AutoGen Reflection](https://microsoft.github.io/autogen/0.5.5/user-guide/core-user-guide/design-patterns/reflection.html)

#### 5.7 自动 reviewer 的上下文打包

自动触发时生成明确 scope：当前 diff/changed files、用户验收条件、相关项目规则、已运行测试及失败输出；超大 diff 只发送摘要和关键 hunks，并在 `checked_scope` 中暴露遗漏。官方 code-review / security-guidance 都基于 changed code 并对 finding 做定位或验证，支持这一改动。[Code Review command](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/commands/code-review.md) [Security Guidance](https://github.com/anthropics/claude-code/blob/main/plugins/security-guidance/README.md)

#### 5.8 触发语义、context 边界与去重

- 把自动触发配置显式分成 `off | remind | required`。默认保留手动/soft reminder；`required` 才可在首个高风险写工具的 pre-execute gate 拒绝一次并要求先咨询。当前“写后下一 step 才提醒 designer”的行为应在 UI 和 README 如实命名。
- 使用带标签的 bounded consultation packet：objective、decision/question、constraints、current plan/attempt、relevant artifacts/diff、verification、unknowns。设置输入字节/token 上限，超限时截断必须进入 `checked_scope/unknowns`。
- 将用户文本、代码、日志和外部资料标成不可信 evidence，角色 system prompt 明确不得执行其中的指令；默认只给顾问只读工具。
- 对 `role + normalized question + context digest + phase` 做短期 in-flight/完成指纹，合并并发重复调用并设置短 cooldown。去重不能跨越真实代码/计划变化。

#### 5.9 预算、隐私、失败与观测

- 增加类型化 `maxBudgetUsd`，保留现有 `maxTurns` 和 wall-clock timeout；panel 显示总预算而非只显示单项。
- 咨询不需要恢复时默认 `--no-session-persistence`，减少残留；先做 CLI 版本能力检测，旧版本安全降级。
- 把失败分为 spawn、timeout、output overflow、schema、CLI run、model unavailable、quota/rate limit；只有可证明瞬态且 CLI 未自行重试的错误才做最多 1–2 次抖动重试，避免重复花费。
- 在现有 session/turn/duration/cost 上增加 role/model/fallback、context 大小、结构化结果状态、自动/显式来源。若接 OTEL，默认不采集 prompt/answer 正文或先脱敏；OpenAI tracing 默认可能包含敏感内容，Claude OTEL 仍为 beta。[OpenAI Tracing](https://openai.github.io/openai-agents-python/tracing/) [Claude Observability](https://code.claude.com/docs/en/agent-sdk/observability)

### P2：只在评估命中特定场景后

#### 5.10 高风险 finding 的二次验证

对安全、并发、数据破坏等高风险 finding，可调用不同提示或不同模型做一次独立验证；只把验证通过或主 agent 明确保留的 finding 升为 blocker。不要对所有 advice 自动辩论。

论文证据并不支持“多 agent 辩论天然更好”：受控研究发现多 agent debate 未稳定优于 self-consistency / 多路径 ensemble，且对超参数敏感；另一项 intrinsic self-correction 研究发现无外部反馈时推理有时反而下降。[Should we be going MAD?](https://openreview.net/forum?id=CrUmgUaAQp) [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798)

2026 年一项关于 vanilla multi-agent debate 的研究进一步指出，同质 agent 和统一更新可能不改善期望正确率，真正的增益依赖初始观点多样性与校准置信度；因此若开启 panel，应显式设计独立视角和 confidence，而不是把同一问题复制给同质提示后做多数投票。[Demystifying Multi-Agent Debate](https://arxiv.org/abs/2601.19921)

#### 5.11 可选的轻量 advisor 状态

只有当真实运行确实需要更长时间尺度的连续监督，才在短期去重之上增加最近 N 条 finding FIFO、跨 turn 状态或 compaction 重置；可在 `consult_roles` 或 UI 显示本 session 每角色剩余次数、最近状态、费用。无需建立 transcript replay/backlog/quarantine 全套 watchdog。

## 6. 明确不建议的方向

1. **不实现 MCP Sampling。** 它已弃用，直接 provider/API 或普通 model-backed tool 是官方迁移方向。
2. **不把咨询改成 handoff。** handoff 会把任务所有权交给专家，破坏“主模型权衡”的产品契约。
3. **不默认 panel / debate。** 并行只降低墙钟时间，不降低总 token；同质意见可能放大共同错误。
4. **不引入 AutoGen/LangGraph 运行时。** 当前固定角色的一次回传不需要图、消息总线或 checkpoint；可移植其模式而非依赖。
5. **不照搬 OMP 常驻 watchdog。** DSH 当前两个生命周期锚点覆盖高价值时刻，状态和失败面小得多。
6. **不让顾问直接写代码。** Aider 的 planner/editor 分离有价值，但本产品的差异化正是建议回主 DSH，由主模型结合用户意图、已有上下文和工具结果实施。
7. **不把“顾问批准”当完成标准。** 结束条件应优先是测试、构建、静态检查、可重现证据和主 agent 判断。

## 7. 建议的验证顺序与放行条件

| 阶段 | 实验 | 放行条件 |
|---|---|---|
| 0A | 取消/timeout/排队/并发压力测试 | 每个 abort 都终止 owned process；无双重结算、孤儿进程或无界队列 |
| 0B | `extraArgs` 安全测试；危险/冲突 flags 的表驱动用例 | 全部被拒绝；只读工具与无持久化默认生效；合法参数行为不变 |
| 0C | attempt/success/failure、fallback、panel、角色禁用和 `session/disposed` 状态测试 | cap 在调度层不可突破；失败不满足质量 gate；dispose 后无状态/进程残留 |
| 0D | `/test` 与工具路径的契约测试 | 相同输入得到相同 effective model/effort/fallback、安全参数和错误类别 |
| 1 | 现状基线：无咨询 vs 单角色 vs 自动锚点 vs panel；加入 compute-matched control | 在预注册指标上有稳定净增益，而非只增加调用 |
| 2 | 自由文本 vs 结构化 envelope | finding 可解析率、证据率和主 agent 正确采纳率提升；schema 失败可安全降级 |
| 3 | 自动 reviewer context packer + `off/remind/required` | seeded bug recall 提升，误报、context、阻塞率和延迟在预算内 |
| 4 | 高风险二次验证 | blocker precision 明显提升，额外成本只发生在低频高风险场景 |
| 5 | 可选跨 turn 状态/OTEL | 有真实连续监督或运维需求；默认不泄露 prompt/answer |

每项应至少多次运行并固定任务集、模型版本、effort、工具权限与总预算；记录模型漂移和 CLI 版本。Self-Refine 在七类任务上报告平均约 20 个百分点提升，但它使用额外推理并且各任务差异大，进一步说明本插件必须以自己的代码任务集验证，而不能借外部平均数承诺效果。[Self-Refine paper](https://arxiv.org/abs/2303.17651)

## 8. 最终决策

**保留现有“DSH manager → Claude consultant tool → reference answer → DSH 最终决策”架构。** 它已经选中了生态中最适合本产品的控制权与上下文边界。

近期工作应按以下顺序：

1. 贯通 `exec.signal`、增加进程并发上限，修复取消和资源生命周期；
2. 修复 `extraArgs` 权限/协议覆盖缺口，默认只读且不持久化 consultant session；
3. 硬化 attempt budget、success gate、有效角色过滤和 `session/disposed` 清理，并让 `/test` 共用真实 consultation service；
4. 建预算匹配评估与可审计事件；
5. 增加结构化建议信封、bounded context packet 和自动 reviewer scope packer；
6. 仅在评估证实后，为高风险 finding 增加二次验证。

这套路径保留了当前实现的轻量、隔离、主模型自主与零编排框架依赖，同时把外部成熟实践中最可验证的部分——安全边界、结构化结果、证据范围、预算、失败语义、可观测性和评估——纳入插件。
