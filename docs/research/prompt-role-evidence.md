# AI 角色 / 系统提示词 / Agent 工具提示的外部证据基线

> 调研截止：2026-08-18（Asia/Shanghai）
>
> 范围：只核查外部一手资料，不评价本仓库当前实现。资料优先级为官方规范与文档、政府标准、原始论文；不采用二手博客。
>
> 用法：供后续审查具体角色和提示词时作判据。每节明确区分“文献事实”和“审查推断”，避免把供应商建议误写成跨模型定律。

## 结论先行

一套“科学”的角色或系统提示词，不是写得像专家、篇幅很长或规则很多，而是同时满足以下条件：

1. **角色是职责接口，不是能力证明。** 角色可以聚焦行为、语气、观察角度和交付物；现有实证并不支持仅靠“你是世界级专家”稳定提高事实准确率。
2. **把目标、成功标准、输入、边界和输出合同写清楚。** 模糊人格描述不能代替可执行的任务定义。
3. **使用宿主真正的指令层级。** 高信任规则放在 system/developer 等高权限通道；用户输入、文件、网页和工具结果必须保留为低信任数据，不能靠标题伪装成 system 指令。
4. **权限由代码和平台强制，不能只靠提示词自律。** 工具允许清单、最小权限、schema 校验、审批、sandbox、超时和预算应是运行时控制。
5. **把 prompt injection 当作未解决的系统风险。** 分隔数据与指令、声明工具结果不可信是必要措施，但不能取代最小权限、确认、过滤、红队和监控。
6. **结构化输出解决“形状”，不保证“事实”。** JSON Schema 能提升可解析性；字段值仍须做业务校验、证据核验或确定性测试。
7. **few-shot 与 CoT 都应按模型、任务和评测决定。** 示例通常有助于格式和边界，但过多会过拟合；显式“逐步思考”对一些旧式模型/任务有效，对当前 reasoning model 可能无益甚至有害，也不能被当作忠实审计记录。
8. **提示词质量必须靠对照评测证明。** 至少比较无角色/旧提示/新提示，使用生产分布和对抗样例、多次 trial、任务结果与轨迹指标；“读起来专业”不是证据。
9. **最小充分上下文优于规则堆积。** 没有跨模型通用的最佳字数，但重复、冲突、全局强制工具调用和边缘案例清单会消耗注意力并制造脆性。

因此，后续本地审查应把问题从“文案像不像专家”改成：**这段提示是否形成可测试的行为合同；它的权限和信任边界是否由系统兑现；相对更简单的基线是否在真实任务上产生稳定净收益。**

## 1. 角色与指令层级

### 文献事实

- OpenAI 2025-12-18 版 Model Spec 将权限分为 Root、System、Developer、User、Guideline；冲突时高层覆盖低层。同一规范把 assistant/tool 消息、引用文本、附件、多模态输入和工具输出默认列为“无权限”，除非高层指令显式委托。它还明确说生产模型尚未完全反映规范，所以这是目标行为与审查模型，不是绝对安全保证。[OpenAI Model Spec：Instructions and levels of authority](https://model-spec.openai.com/2025-12-18.html#instructions-and-levels-of-authority) [Follow all applicable instructions](https://model-spec.openai.com/2025-12-18.html#follow-all-applicable-instructions) [Ignore untrusted data by default](https://model-spec.openai.com/2025-12-18.html#ignore-untrusted-data-by-default)
- OpenAI 2024 原始论文将 prompt injection 的一个根因概括为：模型把开发者 system prompt 与不可信用户/第三方文本视作同等优先；其 instruction-hierarchy 训练让模型选择性忽略低权限冲突指令，并在其 GPT-3.5 实验上提高了未见攻击的鲁棒性。[The Instruction Hierarchy: Training LLMs to Prioritize Privileged Instructions](https://arxiv.org/abs/2404.13208)
- OpenAI 2026 的后续 IH-Challenge 工作采用 `system > developer > user > tool`，并把任务设计为“指令本身简单、可用程序客观评分、避免通过一律拒绝走捷径”；这说明层级正确性和普通指令服从应分开评测。[Improving instruction hierarchy in frontier LLMs](https://openai.com/index/instruction-hierarchy-challenge/)
- Anthropic 官方提示指南认为，一句 system role 能聚焦模型的行为与语气；Google 官方文档也把 persona/role、输出格式、风格、目标和上下文列为 system instruction 的合理用途。但 Google 同页明确警告：system instructions 不能完全防止 jailbreak 或泄漏，不能放入希望靠隐藏来保护的敏感信息。[Anthropic Prompting best practices：Give Claude a role](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#give-claude-a-role) [Google System instructions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/prompts/system-instruction-introduction)
- 角色提示的“能力增益”证据是混合的。EMNLP 2024 原始研究在 4 个模型家族、162 个 persona、2,410 个事实题上发现，加入 persona 整体没有优于无 persona 基线，具体角色的影响常呈随机性。[When “A Helpful Assistant” Is Not Really Helpful](https://aclanthology.org/2024.findings-emnlp.888/) 2025 年另一项覆盖 9 个模型、27 个任务的研究发现，专家 persona 通常是正向或不显著，但对无关 persona 细节很敏感，最大性能下降接近 30 个百分点，教育、专业化与领域匹配的效应经常不一致或可忽略。[Principled Personas](https://aclanthology.org/2025.emnlp-main.1364/)

### 审查推断

- 角色应优先回答四件事：**负责什么、采用什么视角、无权做什么、交付什么**。例如“只做证据审查；不修改代码；发现未知项要列出；输出 verdict + findings”，比“你是一位世界顶尖、严谨、有洞察力的专家”更可执行。
- “资深/首席/世界级”只能视为语气或视角提示，不能作为正确性依据。若保留，应通过无角色对照实验证明净收益；否则删除无关履历、性别、性格修辞，降低随机 persona 效应。
- 必须用宿主 API/运行时真实支持的 system、developer、user、tool 通道表达信任层级。把字符串写成 `<system>`、`SYSTEM:` 或 Markdown 标题，不会自动获得系统权限。
- 高层提示不应复制低层用户任务全文；可变、不可信内容应留在低权限消息或专用 data/tool-result 容器，并由高层提示规定如何处理。
- 不要写彼此争夺优先级的多个角色（如同时“无条件执行者”“独立审计员”“用户好友”）。需要多职责时，应明确主目标、次目标和冲突处理规则，或拆成不同 agent/workflow。

## 2. 清晰性、成功标准与自治边界

### 文献事实

- Anthropic 要求在 prompt engineering 之前先定义成功标准、建立经验评测方法、准备首版提示；不是每个失败都应靠改提示修复，有时换模型更直接。[Prompt engineering overview](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview)
- Anthropic 的通用指南要求指令清晰、明确，具体说明输出格式和约束；其经验法则是让一个缺少背景的同事阅读，如果人会困惑，模型也会困惑。补充规则背后的上下文/目的，有助于模型对未枚举情形作正确泛化。[Prompting best practices：Be clear and direct](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#be-clear-and-direct)
- Google 将 prompt engineering 定义为测试驱动、迭代的过程；内容必须包含完成任务所需的信息，结构可借助排序、标签和分隔符。其 Gemini 指南建议目标直接、参数明确、结构一致，并把关键约束、persona 和输出格式放在 system instruction 或用户提示开头。[Google Prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies) [Google Overview of prompting strategies](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/prompts/prompt-design-strategies)
- OpenAI Model Spec 的自治范围包含：允许追求的子目标、可接受的时间/费用/数据/访问副作用，以及何时暂停请求澄清或批准；建议用半结构化字段记录 allowed tools、时限、成本上限和工具约束。[Act within an agreed-upon scope of autonomy](https://model-spec.openai.com/2025-12-18.html#act-within-an-agreed-upon-scope-of-autonomy)

### 审查推断

角色提示至少应能明确回答：

1. **Objective**：本角色要改善什么结果，而非泛泛“提供高质量帮助”。
2. **Inputs**：会收到哪些材料；哪些是事实、用户声明、不可信数据或缺失信息。
3. **In scope / out of scope**：可分析、可建议、可执行的边界分别是什么。
4. **Decision policy**：什么时候直接做、什么时候查证、什么时候调用工具、什么时候暂停或升级。
5. **Success criteria**：什么可观察结果算完成；需要哪些证据或测试。
6. **Failure behavior**：信息不足、工具失败、冲突指令、超预算或超时如何处理。
7. **Output contract**：输出字段、严重度、证据、未知项及面向的下游消费者。

- 把不可检验的形容词改成行为规则：例如将“严谨”改为“重要主张给出处；事实与推断分开；没有证据时标记 unknown”；将“高效”改为“先使用最专门的只读工具；同一失败不重复超过 N 次”。
- 只在顺序或完整性必须固定时写逐步流程；探索型任务应给原则、终止条件和检查点，而不是把所有路径硬编码成 if/else 文案。

## 3. 工具使用、权限与副作用

### 文献事实

- Anthropic 把工具调用定义为应用与模型之间的合同：应用声明可用操作和输入/输出形状，模型选择何时、如何调用，真正执行发生在应用代码或服务端，不是模型自己执行。[How tool use works](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works)
- Anthropic 要求工具描述详细说明“做什么、何时用/何时不用、每个参数含义、限制”，并建议清晰命名、减少选择歧义、返回高信号结果。`strict: true` 可以保证工具名和参数符合受支持的 JSON Schema；它保证类型/形状，不替代授权或业务校验。[Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) [Strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use)
- Anthropic 的工具工程经验强调先建立真实任务 eval，再迭代工具；输入参数应无歧义并用严格数据模型约束。该文同时提醒评测不要过度指定或过拟合单一策略，因为完成任务可能有多条有效路径。[Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Google MCP 安全文档要求 agent identity 遵循最小权限，并区分 human-in-the-middle 与 agent-only；后者完全依赖程序控制，暴露于 prompt injection、危险工具链和错误处理风险。[Google Cloud MCP AI security and safety](https://docs.cloud.google.com/mcp/ai-security-safety)
- OpenAI Agent Builder 安全指南要求高风险 MCP 操作保留工具审批，并建议用结构化输出来限制节点间数据流、用 guardrails 检查输入、用 trace grader/evals 检查决策和工具调用；官方同时承认这些缓解不能使 agent 完美。[Safety in building agents](https://developers.openai.com/api/docs/guides/agent-builder-safety)

### 审查推断

- 工具提示应说明**选择条件**，而非全局“有疑问就调用”。每个工具至少要有：适用场景、禁用场景、参数语义、信任/新鲜度、是否有副作用、失败/空结果语义、替代工具。
- 提示词只能引导，以下必须在运行时强制：工具允许清单、read/write 分离、schema、路径/域名/租户范围、并发、超时、调用/费用预算、审批、撤销/回滚、sandbox、秘密隔离和审计日志。
- 高风险动作应由“影响 × 可逆性 × 用户授权”决定审批，而不是按模型的自信程度决定。发送消息、发布、付款、删除、覆盖、生产写入和向第三方传数据通常需要显式确认或预先约定的窄权限。
- 工具描述之间若重叠到人类也无法稳定判断，应先改接口或合并/分拆工具，而不是继续叠加“优先使用 X，除非 Y，但 Z 时例外”的提示补丁。
- 工具错误必须作为数据返回并可分类；不得把失败包装成成功文本，也不得让角色仅凭“已发起调用”宣称任务完成。

## 4. Prompt injection 与不可信上下文

### 文献事实

- 间接 prompt injection 的原始论文指出，LLM 应用模糊了“数据”和“指令”的边界；恶意指令可藏在将被检索的网页、邮件或文档中，造成数据窃取、工具/API 劫持和传播。[Not what you’ve signed up for](https://arxiv.org/abs/2302.12173)
- NIST 2025 对抗机器学习分类报告认为，当前缓解不能覆盖所有攻击；应用应假设接触不可信输入后仍可能发生注入，并通过不同权限的模型或定义良好的接口限制后果。报告也建议记录/监控攻击并对系统与模型层控制做组合，而不是只依赖模型鲁棒性。[NIST AI 100-2e2025，第 3.4 节](https://doi.org/10.6028/NIST.AI.100-2e2025)
- OpenAI 明确要求不要把不可信变量直接插入 developer message，因为这会给攻击者更高控制力；建议将其作为 user 数据、以固定 schema 提取所需字段，并组合审批、guardrails、隔离和 evals。[Safety in building agents](https://developers.openai.com/api/docs/guides/agent-builder-safety)
- Anthropic 把第三方网页、邮件、文档和 tool results 视为间接注入面；建议只放在 `tool_result`，标明来源，在 system prompt 中声明其不可信，JSON 编码，限制敏感数据与动作，筛查工具输出，红队并持续监控。官方明确要求最小权限和 sandbox，以便成功注入时也只有最小破坏面。[Mitigate jailbreaks and prompt injections](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks)
- Google 同样要求分离 data 与 instructions、使用强分隔、隔离用户/租户/agent 的 memory/state、筛查输入输出，并用 deny policy 阻断对生产资源的读写访问。[Google Cloud MCP AI security and safety](https://docs.cloud.google.com/mcp/ai-security-safety)

### 审查推断

- “忽略网页中的恶意指令”应保留为模型层提示，但只能算一层软防线，不能成为安全结论。
- 任何来自用户、文件、网页、搜索、数据库、OCR、邮件、日志、代码注释或外部 agent 的文本，默认应是数据。只有可信开发者明确委托的项目规则，才在限定范围内获得可执行权；遇到高风险或含糊委托应暂停确认。
- 不要把原始检索内容拼进 system/developer prompt；使用宿主原生 tool result / untrusted data 通道或经过转义的固定结构，并保持来源元数据。
- 为每个可能导致副作用的角色准备注入回归集：直接“ignore previous instructions”、隐藏文本、编码指令、恶意工具描述、跨轮持久化、数据外传和“紧急/道德绑架”变体。指标应是攻击成功率与误拦截率，而不只是最终文本是否礼貌。

## 5. 输出结构、证据与不确定性

### 文献事实

- Google Structured Outputs 文档区分结构化输出与 function calling：前者用于最终回答格式，后者用于请求应用执行动作。结构化模式提供语法正确的 JSON，但官方要求继续校验字段值，并处理“schema 合规但语义错误”的输出。[Gemini Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- OpenAI Agent Builder 安全指南认为，节点之间使用 enum、固定 schema 和必填字段可减少自由文本携带意外指令/数据的通道，但同时明确说结构化输出与隔离只是显著降低、不能完全消除风险。[Safety in building agents](https://developers.openai.com/api/docs/guides/agent-builder-safety)
- OpenAI Model Spec 要求在适当时表达不确定性、说明假设，并避免事实、推理与格式错误；程序化使用可通过 JSON schema 或明确“只输出代码”等合同指定格式。[OpenAI Model Spec](https://model-spec.openai.com/2025-12-18.html)

### 审查推断

- 面向另一个 agent 或程序的角色，不宜只回一段漂亮散文。推荐最小信封：

```json
{
  "verdict": "pass | revise | uncertain",
  "summary": "给决策者的简述",
  "findings": [
    {
      "severity": "blocker | high | medium | low | nit",
      "claim": "发现",
      "evidence": "可复查依据或位置",
      "impact": "若不处理会发生什么",
      "action": "最小建议"
    }
  ],
  "checked_scope": [],
  "unknowns": []
}
```

- `confidence` 若使用，应先定义口径并做校准；否则“0.92”只是装饰性精度。比主观概率更重要的是 evidence、location、复现步骤和 checked scope。
- schema 校验失败、字段缺失、证据不可定位或工具失败，应显式返回 error/uncertain，绝不能默认补成 `pass`。
- 结构化 verdict 是下游接口，不是事实裁决。高风险 finding 仍需测试、确定性规则、原始材料或独立复核。

## 6. Few-shot、角色示例与 Chain-of-Thought

### 文献事实

- GPT-3 原始论文证明，随模型规模扩大，以文本示例提供任务的 few-shot 能在多类 NLP 任务取得很强表现，但论文也明确记录了失败数据集与方法局限；这不是“所有现代模型都必须 few-shot”的定律。[Language Models are Few-Shot Learners](https://arxiv.org/abs/2005.14165)
- Google 当前指南建议用具体、多样、格式一致的 few-shot 示例来约束格式、措辞和范围，同时警告示例太多可能让响应过拟合；最佳数量需要实验。[Google Prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies)
- Anthropic 当前指南认为少量精心设计的相关、多样、结构化示例能提升准确性和一致性；其 context-engineering 文章反对把所有边缘案例堆成“洗衣清单”，建议只保留多样、典型示例。[Anthropic Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#use-examples-effectively) [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- 原始 CoT 论文在算术、常识和符号推理任务上证明，给足够大模型 few-shot 推理链可显著提高表现。[Chain-of-Thought Prompting Elicits Reasoning](https://arxiv.org/abs/2201.11903) 但 OpenAI 当前 reasoning-model 指南要求提示保持简单直接，称“think step by step”可能无帮助甚至妨碍，并建议先 zero-shot、必要时再 few-shot。[OpenAI Reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices)
- Anthropic 当前模型指南建议有原生 thinking 时优先给一般性目标而非手写的逐步推理计划，manual CoT 只作为 thinking 关闭时的后备。[Anthropic Prompting best practices：Thinking](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#leverage-thinking-interleaved-thinking-capabilities)
- 可见 CoT 不是可靠的真实因果解释。2023 原始研究发现，偏置特征可改变答案，而模型常生成貌似合理却不提偏置来源的解释；2025 Anthropic reasoning-model 实验中，多数设定的 hint 使用披露率经常低于 20%。[Language Models Don’t Always Say What They Think](https://arxiv.org/abs/2305.04388) [Reasoning Models Don’t Always Say What They Think](https://www.anthropic.com/research/reasoning-models-dont-say-think)

### 审查推断

- 示例适合表达难以用规则写清的**边界、格式与取舍**，不应只是重复正文。每个示例应与指令一致，覆盖正常、边缘、拒绝/升级等不同情形，并避免泄露生产敏感数据。
- 不设跨模型固定的“必须 3 个示例”或“必须 zero-shot”。对目标模型分别比较 0/少量示例，保留能稳定提高指标且不过拟合的最小集合。
- 不要普遍要求输出完整思维链，也不要用它证明模型诚实。若需要可审计性，要求**简洁依据、引用、假设、工具记录、验证步骤和结果**；内部 reasoning 是否展示由模型/API能力与政策决定。
- “先计划再执行再验证”只在任务确有多步依赖、且轨迹评测显示有效时使用。简单任务强制长计划会增加延迟、token 和表演性推理。

## 7. 评测、可观测性与版本管理

### 文献事实

- OpenAI 官方 eval 指南要求 eval-driven development、任务特定测试、全量记录开发数据、尽可能自动评分、持续评测，并用人工反馈校准自动评分；它把“感觉能用”列为反模式。[OpenAI Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
- Anthropic 2026 agent eval 指南区分 task、trial、grader、transcript/trace、outcome、eval harness 与 agent harness。由于输出有随机性，应对同一任务运行多次 trial；agent 声称“已完成”不等于环境中的真实 outcome 已成立。[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- NIST AI 600-1 建议将生成式 AI 输出与已知 ground truth 比较，并组合人工监督、自动评测和内容输入审查；还要求定期对抗测试、持续跟踪人机配置结果。[NIST AI 600-1](https://doi.org/10.6028/NIST.AI.600-1)
- Google Gen AI Evaluation 支持 pointwise 评分、与基线进行 pairwise 比较、基于 ground truth 的计算指标；judge-model 指标需要明确 criteria/rubric，且应与人工评价校准。[Google：Define your evaluation metrics](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/eval-python-sdk/determine-eval) [Evaluate a judge model](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/evaluate-judge-model)
- OpenAI Agents SDK tracing 可记录 model turns、generations、function tools、guardrails、handoffs 等；LLM/tool 输入输出可能含敏感信息，必须配置是否采集、脱敏与保留策略。[OpenAI Agents SDK Tracing](https://openai.github.io/openai-agents-python/tracing/)

### 审查推断

一个角色/提示词改动的最小实验：

1. 冻结模型版本、effort/temperature、工具集合、预算和 harness。
2. 构造生产分布任务、已知失败回归、边缘情形、冲突指令和注入样例；留出不参与改 prompt 的测试集。
3. 比较 `无角色/最小提示`、`当前提示`、`候选提示`；随机化顺序或盲化人工评审，避免新版本偏好。
4. 每个非确定性任务运行多次 trial，报告均值、分布和失败类型，而非单个成功案例。
5. 同时看最终 outcome 与轨迹；模型自述成功不作完成证据。
6. 只有主要指标提升、关键安全 guardrail 不退化、成本/延迟可接受时发布；此后持续跑回归集。

建议指标按角色选择：

| 维度 | 可操作指标 |
|---|---|
| 任务结果 | 单元/集成测试通过率、ground-truth 准确率、隐藏验收通过率、人工盲评 |
| 指令服从 | 必须项召回、禁做项违规率、冲突时高权限规则遵从率 |
| 评审质量 | finding precision/recall、证据可复现率、严重度校准、重复率、误报率 |
| 工具行为 | 正确工具选择率、不应调用时的误触发率、参数 schema/业务有效率、失败恢复率 |
| 安全 | 直接/间接注入成功率、越权率、错误审批率、敏感数据暴露率、误拒率 |
| 输出合同 | schema 有效率、必填字段覆盖率、unknown/uncertain 正确使用率 |
| 资源 | 输入/输出/reasoning token、工具调用数、费用、p50/p95 延迟、超时率 |

最少记录：prompt/role 版本与哈希、模型快照、采样/effort 设置、消息角色、工具 schema 与权限、每次工具调用/结果/错误/审批、token/费用/延迟、最终环境 outcome、grader 版本。含敏感输入输出时只记录必要字段，并定义脱敏、访问与保留期限。

## 8. 过度约束、冗长提示与上下文污染

### 文献事实

- Anthropic 将 context 视为有限且边际收益递减的资源；其经验目标是“能完整描述期望行为的最小信息集”，并特别说明 minimal 不等于一味短。官方反对两端：把复杂、脆弱逻辑硬编码进 prompt，以及过于笼统、假定共享背景。[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- 同文建议从最小 prompt 开始，根据 eval 暴露的失败增加清晰指令/示例；它把重叠、臃肿工具集和边缘案例清单列为常见问题。[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic 当前模型指南警告 blanket tool defaults（如“有疑问就用工具”）会造成过度触发，建议改成针对性条件；复杂大 system prompt 也可能诱发不必要 thinking、token 和延迟。[Prompting best practices：Overthinking and excessive thoroughness](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#overthinking-and-excessive-thoroughness)
- Google Gemini 3 指南要求目标清晰简洁、避免不必要或过度说服性语言，同时承认长上下文需要明确结构和锚点；Google few-shot 指南警告太多示例可能过拟合。[Google Prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies)

### 审查推断

- 不存在可脱离模型、harness 与任务而规定的“科学 token 数”。应优化的是**每个规则的边际作用**：是否对应真实失败、是否可测、是否与其他规则冲突、是否应由代码实现。
- 删除四类噪声：重复规则、同义人格修辞、无真实失败证据的边缘禁令、运行时已强制且模型无需知道的实现细节。
- 将高频、稳定、全局规则放高层；任务特定材料按需加载。大段知识、长日志和历史 tool results 应摘要、检索或渐进披露，不要永久常驻 system prompt。
- 绝对词应留给真正的安全/合同硬约束；大量 `ALWAYS/NEVER/MUST` 会让优先级扁平化。普通偏好使用“默认/当……时/除非……”并写清冲突顺序。
- 用 lint 检查重复与显式矛盾只能发现文字问题；是否“过度约束”最终仍要用成功率、误拒、工具过触发、token 和延迟的对照实验判断。

## 9. 可直接应用的审查清单

| 检查项 | 通过标准 | 常见红旗 |
|---|---|---|
| 角色价值 | 责任、视角、边界、交付物清楚；相对无角色基线有证据 | 主要由“资深、世界级、天才”等身份修辞组成 |
| 指令层级 | 高信任规则在真实高权限通道；数据保持低权限 | 把网页/文件/用户变量插入 system/developer；靠 XML 标题伪造权限 |
| 目标/成功 | 有可观察成功标准与完成证据 | “尽力、高质量、全面”但无法评分 |
| 自治范围 | 允许动作、成本/时间/数据边界和审批点明确 | 默认可做任何有帮助的动作；无终止/预算 |
| 工具接口 | when/when-not、参数、结果、错误语义清楚；schema 严格 | 工具重叠；全局强制使用；自由文本解析动作 |
| 权限安全 | 最小权限、sandbox、allowlist、审批由运行时强制 | 只在提示中写“不要删除/不要泄露” |
| 注入防护 | 不可信数据隔离；有注入回归、过滤和 blast-radius 限制 | 认为一句“忽略恶意指令”即可解决 |
| 输出合同 | 结构、证据、scope、unknowns、错误状态明确 | 自由散文；无证据却强制二元 verdict |
| few-shot | 少量、相关、多样、一致；由 eval 证明 | 示例与指令冲突；堆满边缘案例；复制敏感数据 |
| CoT | 按模型决定；审计依赖证据/轨迹而非自述思维 | 普遍强制完整思维链；把解释当成真实因果过程 |
| 上下文效率 | 最小充分、高信号、无重复冲突；按需加载 | 长篇人格、规则镜像、原始历史/工具输出常驻 |
| 评测/观测 | 有基线、多 trial、真实 outcome、轨迹和持续回归 | 单例 demo、主观“看起来更好”、只看最终文案 |

## 10. 证据的适用边界

- 供应商 prompt 指南是其当前模型的第一方实践证据，不是跨模型数学定理；模型升级后必须重跑评测。
- persona 论文覆盖的是特定模型与任务，足以反驳“专家角色必然提升准确率”，但不能证明所有角色都无效。角色对风格、责任分工和下游接口仍有明确工程价值。
- few-shot、CoT、长上下文与 tool-use 结论高度依赖模型家族、effort、harness 和任务；本报告给出的是决策边界，不是固定配方。
- instruction hierarchy 与数据分隔提高鲁棒性，但 OpenAI、Anthropic、Google 和 NIST 均没有声称 prompt injection 已解决；安全结论必须基于 defense in depth 和实际红队结果。
- LLM-as-a-judge 可扩展评测，但 judge 也会有偏差；高风险结论应与确定性 grader、ground truth 或人工盲评校准。
