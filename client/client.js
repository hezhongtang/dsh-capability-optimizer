window.__ModuleLoader__.load({ id: "dsh-capability-optimizer", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-capability-optimizer client.
 *
 * Two seats:
 *  - a Settings section ("Expert Consult") managing the consultation
 *    settings — CLI path, default + fallback models (omp-style one-hop model
 *    fallback), timeouts, the role roster workspace (add / edit / toggle /
 *    delete, omp-style enabled flag that parks a role without dropping it),
 *    and the auto-consult defaults (checked set + per-role session cap);
 *  - a composer-seat toggle in the conversation input toolbar: check roles
 *    per session and the host proactively consults them (policy section +
 *    lifecycle nudges; see lib/autoconsult.js), with live usage counts.
 *
 * Saves hot-apply on the host: the agent tools re-register immediately, no
 * dsh restart. Includes an end-to-end test call that really consults Claude
 * once (spends quota) to verify CLI + auth + proxy.
 *
 * Hand-authored CJS bundle (no build step); the only external is `react`.
 */

const React = require('react')
const h = React.createElement
const { useState, useEffect, useCallback, useRef } = React

const NS = 'dsh-capability-optimizer'

const zh = {
  nav: '专家咨询',
  subtitle: '以角色人设无头（headless）调用 Claude Code，回复作为参考答案',
  loading: '加载中…',
  loadFail: '加载失败',
  retry: '重试',
  fileError: '设置文件读取异常（已回退到组合配置）',
  generalTitle: '通用',
  cliPath: 'claude CLI 路径',
  modelDefault: '跟随 CLI 默认',
  modelGroupLatest: '最新别名',
  modelGroupVersioned: '带版本',
  modelCurrent: '当前值',
  cliPathPh: '留空 = 使用 PATH 上的 claude',
  defaultModel: '默认模型',
  fallbackModel: '回退模型',
  effort: '推理等级（--effort）',
  effortDefault: '跟随默认',
  effortLow: '低（low）',
  effortMedium: '中（medium）',
  effortHigh: '高（high）',
  effortXhigh: '超高（xhigh）',
  effortMax: '最大（max）',
  timeoutMs: '单次超时（毫秒）',
  maxTurns: 'CLI 内最大轮数',
  maxPanelRoles: '并行会诊角色上限',
  extraArgs: '附加 CLI 参数',
  extraArgsPh: '空格分隔，如 --safe-mode 或 --add-dir /path',
  rejectedArgsNote: '已忽略不安全参数：{args}',
  validationProblems: '设置文件未通过校验（已回退到组合配置）：{problems}',
  repairsNote: '顾问模型已自动对齐顶级模型：{repairs}',
  savedNotApplied: '已写入磁盘，但咨询工具没有重注册（没有 tools 服务或名册为空）',
  resetNotApplied: '已恢复默认文件，但咨询工具没有重注册',
  errAdvisorFallback: 'Advisor 回退模型也必须是顶级模型（claude-opus-5）',
  autoHintOff: '当前模式为关闭：勾选不会写入政策，也不会催办。',
  acDropped: '未生效：{keys}',
  testUsedRole: '实际角色 {role}',
  applyDraft: '应用到草稿',
  maxBudgetUsd: '单次咨询美元上限（0 = 不设上限）',
  autoMode: '触发模式',
  autoModeOff: '关闭',
  autoModeRemind: '提醒（默认）',
  autoModeRequired: '加强提醒',
  autoModeHint: 'required 会写更硬的政策，并在写文件时打日志。主机没有拦截写工具的 API，并不能真正拦住 Write。',
  rolesTitle: '角色',
  rolesHint: '停用的角色保留在册但不出现在工具枚举中（omp 风格）',
  addRole: '新增角色',
  editRole: '编辑角色',
  roleName: '名称（slug）',
  roleLabel: '显示名（可选）',
  roleDesc: '用途说明（何时选它）',
  rolePrompt: '角色提示词（systemPrompt）',
  roleModel: '专属模型（可选）',
  roleModelAdvisor: '顾问模型（须强于 DSH 主模型）',
  roleModelAdvisorHint: 'Advisor 是高智能角色。请来的模型必须比干活的 DSH 主模型更强，否则咨询没有意义。请钉死 claude-opus-5。',
  errAdvisorModel: 'Advisor 必须使用顶级模型（claude-opus-5）',
  roleTopTierPill: '顶级模型',
  roleFallback: '专属回退模型（可选）',
  roleEffort: '专属推理等级（可选）',
  enabled: '启用',
  disabled: '已停用',
  roleModelPill: '模型',
  roleFallbackPill: '回退',
  roleEffortPill: '推理等级',
  builtin: '内置',
  custom: '自定义',
  builtinDescAdvisor: '务实的高级工程师参谋：权衡、风险与下一步动作。方向与决策点选它。',
  builtinDescReviewer: '苛刻的代码 / diff / 方案评审：bug、边界情况、安全、测试缺失。宣布完成前选它。',
  builtinDescDesigner: '结构与接口的架构师：模块边界、API 形态、数据流、备选方案与权衡。动重要代码前选它。',
  delete: '删除',
  confirmDelete: '删除该角色？',
  cancel: '取消',
  close: '关闭',
  save: '保存并生效',
  saving: '保存中…',
  saved: '已保存并热生效',
  saveFail: '保存失败',
  dirtyHint: '有未保存的修改',
  reset: '恢复默认',
  confirmReset: '放弃全部设置，恢复内置默认？',
  resetDone: '已恢复默认',
  testTitle: '连通性测试',
  testHint: '对已保存的设置真实调用一次 Claude（消耗额度）。未保存的草稿不会参与。探测上限为 2 轮 / 180 秒。',
  testRole: '角色',
  testQuestion: '测试问题',
  testRun: '运行测试',
  testing: '测试中…',
  testOk: '成功',
  testFail: '失败',
  testAnswer: '回复',
  testMeta: '模型 {model} · {ms}ms · {turns} 轮 · {cost}',
  usedFallback: '已触发模型回退',
  requiredPrompt: '启用状态的角色提示词不能为空',
  nameRequired: '名称不能为空',
  errDupRole: '角色名称重复',
  errNoRoles: '至少保留一个角色',
  errAllDisabled: '至少启用一个角色',
  errNumberRange: '数值超出允许范围',
  autoTitle: '自动咨询',
  autoHint: '在提醒 / 加强提醒模式下，勾选的角色会写入政策并在关键节点催办。关闭模式不会催办。每次调用消耗 Claude 订阅额度。Advisor 只会请顶级模型（claude-opus-5）。',
  autoCap: '每角色每会话调用上限',
  autoDefaultsHint: '这里是默认勾选集；聊天框开关可按会话临时覆盖',
  acTooltip: '专家咨询 · 自动',
  acEmpty: '没有可用的角色',
  acFollowDefaults: '跟随默认配置',
  acOverrideOn: '本会话已覆盖默认',
  acAttempted: '已发起',
  acAnswered: '已回答',
  acFailed: '失败',
  acCancelled: '已取消',
  acNotJson: '自动咨询接口未返回 JSON。更新插件后请重启 dsh web。',
  tabPlanned: '规划中',
  reservedTitle: '工作区已预留',
  reservedBody: '该 harness 的运行器就绪后，其配置将在此展开；角色体系与咨询工具保持共用。',
  noteCodex: '已预留：以同一角色体系接入 exec / proto 模式。',
  noteZcode: '已预留：待 ZCode 提供无头入口。',
  noteKimiCode: '已预留：待 Kimi Code CLI 就绪。',
  notePi: '已预留：以 Pi agent-core 会话作为咨询后端。',
  noteOpencode: '已预留：以同一组工具接入 OpenCode run / agent 模式。',
  noteOmp: '已预留：与 Oh My Pi 的 advisor 角色体系互通。',
  cliCommandLabel: 'CLI 命令',
}

const en = {
  nav: 'Expert Consult',
  subtitle: 'Headless Claude Code consultations with role personas; replies land as reference answers',
  loading: 'Loading…',
  loadFail: 'Failed to load',
  retry: 'Retry',
  fileError: 'Settings file unreadable (fell back to composition config)',
  generalTitle: 'General',
  cliPath: 'claude CLI path',
  modelDefault: 'Follow CLI default',
  modelGroupLatest: 'Latest aliases',
  modelGroupVersioned: 'Versioned',
  modelCurrent: 'Current value',
  cliPathPh: 'empty = claude from PATH',
  defaultModel: 'Default model',
  fallbackModel: 'Fallback model',
  effort: 'Thinking effort',
  effortDefault: 'Default',
  effortLow: 'Low',
  effortMedium: 'Medium',
  effortHigh: 'High',
  effortXhigh: 'XHigh',
  effortMax: 'Max',
  timeoutMs: 'Per-call timeout (ms)',
  maxTurns: 'Max turns inside CLI',
  maxPanelRoles: 'Max panel roles',
  extraArgs: 'Extra CLI args',
  extraArgsPh: 'space-separated, e.g. --safe-mode or --add-dir /path',
  rejectedArgsNote: 'Ignored unsafe args: {args}',
  validationProblems: 'Settings file failed validation (fell back to composition config): {problems}',
  repairsNote: 'Advisor model was aligned to the top-tier pin: {repairs}',
  savedNotApplied: 'Saved to disk, but consultation tools did not re-register (no tools service or empty roster)',
  resetNotApplied: 'Defaults restored on disk, but consultation tools did not re-register',
  errAdvisorFallback: 'Advisor fallback must also be a top-tier model (claude-opus-5)',
  autoHintOff: 'Mode is off: checking roles does not write policy and does not nudge.',
  acDropped: 'Not in force: {keys}',
  testUsedRole: 'actual role {role}',
  applyDraft: 'Apply to draft',
  maxBudgetUsd: 'Per-consult dollar cap (0 = no cap)',
  autoMode: 'Trigger mode',
  autoModeOff: 'Off',
  autoModeRemind: 'Remind (default)',
  autoModeRequired: 'Harder reminder',
  autoModeHint: 'required writes a harder policy and logs on write tools. The host has no pre-execute hook, so Write is not actually blocked.',
  rolesTitle: 'Roles',
  rolesHint: 'A disabled role stays in the roster but leaves the tools\' enum (omp-style)',
  addRole: 'Add role',
  editRole: 'Edit role',
  roleName: 'Name (slug)',
  roleLabel: 'Display label (optional)',
  roleDesc: 'Description (when to pick it)',
  rolePrompt: 'Role system prompt',
  roleModel: 'Dedicated model (optional)',
  roleModelAdvisor: 'Advisor model (must outrank the DSH manager)',
  roleModelAdvisorHint: 'Advisor is a high-intelligence role. The advice-giver must be a stronger coding model than the DSH agent doing the work, or the consult is not worth running. Pin claude-opus-5.',
  errAdvisorModel: 'Advisor needs a top-tier model (claude-opus-5)',
  roleTopTierPill: 'top-tier model',
  roleFallback: 'Dedicated fallback model (optional)',
  roleEffort: 'Dedicated thinking effort (optional)',
  enabled: 'Enabled',
  disabled: 'Disabled',
  roleModelPill: 'model',
  roleFallbackPill: 'fallback',
  roleEffortPill: 'effort',
  builtin: 'built-in',
  custom: 'custom',
  builtinDescAdvisor: 'Pragmatic senior-engineer counsel: trade-offs, risks, and what to do next. Pick for direction and decision points.',
  builtinDescReviewer: 'Critical reviewer of code, diffs, or plans: bugs, edge cases, security, missing tests. Pick before declaring work done.',
  builtinDescDesigner: 'Architect for structure and interfaces: module boundaries, API shape, data flow, alternatives with trade-offs. Pick before significant new code.',
  delete: 'Delete',
  confirmDelete: 'Delete this role?',
  cancel: 'Cancel',
  close: 'Close',
  save: 'Save & apply',
  saving: 'Saving…',
  saved: 'Saved and hot-applied',
  saveFail: 'Save failed',
  dirtyHint: 'Unsaved changes',
  reset: 'Reset to defaults',
  confirmReset: 'Discard all settings and restore built-in defaults?',
  resetDone: 'Reset to defaults',
  testTitle: 'Connectivity test',
  testHint: 'Runs one real Claude consultation against last-saved settings (spends quota). Unsaved draft changes are not used. The ping is capped at 2 turns / 180s.',
  testRole: 'Role',
  testQuestion: 'Test question',
  testRun: 'Run test',
  testing: 'Testing…',
  testOk: 'OK',
  testFail: 'Failed',
  testAnswer: 'Answer',
  testMeta: 'model {model} · {ms}ms · {turns} turns · {cost}',
  usedFallback: 'model fallback used',
  requiredPrompt: 'An enabled role needs a system prompt',
  nameRequired: 'Name is required',
  errDupRole: 'Duplicate role name',
  errNoRoles: 'Keep at least one role',
  errAllDisabled: 'At least one role must stay enabled',
  errNumberRange: 'Value out of range',
  autoTitle: 'Auto consult',
  autoHint: 'In remind / harder-reminder mode, checked roles ride the policy and get nudged at key points. Off mode does not nudge. Each call spends Claude subscription quota. Advisor only consults a top-tier model (claude-opus-5).',
  autoCap: 'Per-role calls per session',
  autoDefaultsHint: 'This is the default checked set; the composer toggle overrides it per session',
  acTooltip: 'Expert consult · auto',
  acEmpty: 'No roles available',
  acFollowDefaults: 'Follow defaults',
  acOverrideOn: 'defaults overridden this session',
  acAttempted: 'attempted',
  acAnswered: 'answered',
  acFailed: 'failed',
  acCancelled: 'cancelled',
  acNotJson: 'Auto-consult API did not return JSON. Restart dsh web after updating the plugin.',
  tabPlanned: 'planned',
  reservedTitle: 'Workspace reserved',
  reservedBody: 'Once this harness\'s runner lands, its configuration unfolds here; the role roster and consultation tools stay shared.',
  noteCodex: 'Reserved: exec / proto modes behind the same role roster.',
  noteZcode: 'Reserved: workspace pending the ZCode headless entry point.',
  noteKimiCode: 'Reserved: workspace pending the Kimi Code CLI.',
  notePi: 'Reserved: Pi agent-core sessions as a consultation backend.',
  noteOpencode: 'Reserved: OpenCode run/agent modes behind the same tools.',
  noteOmp: 'Reserved: Oh My Pi advisor roster interop.',
  cliCommandLabel: 'CLI command',
}

// Built-in roster membership plus the pristine-description test. The agent
// consumes role descriptions in English (lib/roles.js); the roster card shows
// the dictionary translation only while the stored description still equals
// the built-in text, so a user edit always wins over the gloss.
const BUILTIN_DESC_EN = {
  advisor: 'Pragmatic senior-engineer counsel: trade-offs, risks, and what to do next. Pick for direction and decision points.',
  reviewer: 'Critical reviewer of code, diffs, or plans: bugs, edge cases, security, missing tests. Pick before declaring work done.',
  designer: 'Architect for structure and interfaces: module boundaries, API shape, data flow, alternatives with trade-offs. Pick before significant new code.',
}
const BUILTIN_DESC_KEYS = {
  advisor: 'builtinDescAdvisor',
  reviewer: 'builtinDescReviewer',
  designer: 'builtinDescDesigner',
}

/** Fallback only — GET /settings publishes the live lists from lib/consultant-model.js. */
const TOP_TIER_CONSULTANT_MODELS = ['claude-opus-5']
const HIGH_INTELLECT_ROLES = new Set(['advisor'])

function topTierModels(loaded) {
  const list = loaded?.topTierConsultantModels
  return Array.isArray(list) && list.length > 0 ? list : TOP_TIER_CONSULTANT_MODELS
}

function highIntellectRoles(loaded) {
  const list = loaded?.highIntellectRoles
  return new Set(Array.isArray(list) && list.length > 0 ? list : [...HIGH_INTELLECT_ROLES])
}

function roleSlug(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function isHighIntellectRoleName(name, loaded) {
  return highIntellectRoles(loaded).has(roleSlug(name))
}
// Reserved-backend notes are UI copy, so they live in the dictionaries (the
// host catalog carries no locale); the host note stays as a fallback for ids
// without a key. New backends should add a note<Id> key to both dictionaries.
const BACKEND_NOTE_KEYS = {
  codex: 'noteCodex',
  zcode: 'noteZcode',
  'kimi-code': 'noteKimiCode',
  pi: 'notePi',
  opencode: 'noteOpencode',
  omp: 'noteOmp',
}

const CSS = [
  '.dco-section{display:flex;flex-direction:column;gap:18px;max-width:760px}',
  '.dco-sub{margin:2px 0 0;font-size:12px;opacity:.65}',
  '.dco-card{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:12px}',
  '.dco-card h3{margin:0;font-size:13px;font-weight:600}',
  '.dco-hint{font-size:12px;opacity:.6}',
  '.dco-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px 16px}',
  '.dco-field{display:flex;flex-direction:column;gap:4px;font-size:12px}',
  '.dco-field>label{opacity:.75}',
  '.dco-input,select.dco-input,textarea.dco-input{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:8px;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;padding:7px 10px;outline:none;width:100%;box-sizing:border-box;height:34px}',
  '.dco-input:focus{border-color:var(--dsw-alias-brand-primary,#508cff)}',
  'textarea.dco-input{resize:vertical;min-height:110px;height:auto;font-family:var(--ds-font-family-code);line-height:1.5}',
  '.dco-row{display:flex;align-items:center;gap:8px}',
  '.dco-roles{display:flex;flex-direction:column;gap:8px}',
  '.dco-role{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:9px;padding:9px 12px;display:flex;flex-direction:column;gap:5px}',
  '.dco-role-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.dco-role-meta{display:flex;flex-wrap:wrap;gap:6px}',
  '.dco-role-top+.dco-role-meta{margin-top:-2px}',
  '.dco-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary,#2ea44f)}',
  '.dco-dot.off{background:var(--dsw-alias-label-tertiary,rgba(127,127,127,.55));opacity:.5}',
  '.dco-role-name{font-family:var(--ds-font-family-code);font-size:12.5px;font-weight:600}',
  '.dco-pill{font-size:11px;padding:1px 8px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));opacity:.8;white-space:nowrap}',
  '.dco-pill.tag{background:var(--dsw-alias-state-business-tertiary,rgba(80,140,255,.14));border-color:transparent}',
  '.dco-role-desc{font-size:12px;opacity:.7;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
  '.dco-btn{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:transparent;color:inherit;font:inherit;font-size:13px;border-radius:8px;padding:6px 14px;cursor:pointer;white-space:nowrap}',
  '.dco-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
  '.dco-btn:disabled{opacity:.45;cursor:not-allowed}',
  '.dco-btn.primary{background:var(--dsw-alias-brand-primary,#508cff);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}',
  '.dco-btn.primary:hover{filter:brightness(1.1);background:var(--dsw-alias-brand-primary,#508cff)}',
  '.dco-btn.danger:hover{border-color:var(--dsw-alias-state-error-primary,#d25050);color:var(--dsw-alias-state-error-primary,#d25050)}',
  '.dco-status{font-size:12px}',
  '.dco-status.ok{color:var(--dsw-alias-state-success-primary,#2ea44f)}',
  '.dco-status.err{color:var(--dsw-alias-state-error-primary,#d25050)}',
  '.dco-test-out{border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));padding-top:10px;display:flex;flex-direction:column;gap:6px;font-size:12px}',
  '.dco-test-answer{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12));border-radius:7px;padding:8px 10px;white-space:pre-wrap;max-height:160px;overflow:auto}',
  '.dco-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:100}',
  '.dco-modal{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);width:min(560px,92vw);max-height:84vh;display:flex;flex-direction:column;outline:none}',
  '.dco-modal-head{display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25))}',
  '.dco-modal-head h3{margin:0;font-size:14px}',
  '.dco-modal-x{margin-left:auto;border:none;background:transparent;color:inherit;cursor:pointer;font-size:13px;opacity:.6;padding:4px 6px;border-radius:6px}',
  '.dco-modal-x:hover{opacity:1;background:rgba(127,127,127,.15)}',
  '.dco-modal-body{padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:10px}',
  '.dco-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25))}',
  '.dco-switch{position:relative;width:30px;height:17px;border-radius:99px;background:var(--dsw-alias-label-tertiary,rgba(127,127,127,.4));border:none;cursor:pointer;flex:none;transition:background .15s}',
  '.dco-switch.on{background:var(--dsw-alias-brand-primary,#508cff)}',
  '.dco-switch::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:left .15s}',
  '.dco-switch.on::after{left:15px}',
  '.dco-empty{font-size:12px;opacity:.55}',
  '.dco-tabs{display:flex;flex-wrap:wrap;gap:6px}',
  '.dco-tab{height:32px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:13px;border-radius:8px;padding:0 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}',
  '.dco-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
  '.dco-tab.active{background:var(--dsw-specific-sidebar-nav-item-active,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit);font-weight:500}',
  '.dco-tab.reserved{opacity:.6}',
  '.dco-tab .dco-tab-note{font-size:9.5px;padding:0 6px;border-radius:99px;background:rgba(127,127,127,.18)}',
  '.dco-tab.active .dco-tab-note{background:var(--dsw-alias-state-business-tertiary,rgba(80,140,255,.18))}',
  '.dco-workspace{display:flex;flex-direction:column;gap:18px}',
  '.dco-reserved{border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-radius:10px;padding:28px 20px;display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center}',
  '.dsh-reserved-name{font-size:14px;font-weight:600}',
  '.dco-reserved .dco-hint{max-width:420px}',
  '.dco-ac{display:flex;align-items:center;flex:none}',
  '.dco-ac-btn{height:28px;border-radius:999px;border:none;background:transparent;color:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:0 11px;font:inherit;font-size:12px;font-weight:500;white-space:nowrap}',
  '.dco-ac-btn:hover{background:rgba(127,127,127,.14)}',
  '.dco-ac-btn.on{background:var(--dsw-alias-state-business-tertiary,rgba(80,140,255,.14))}',
  '.dco-ac-count{min-width:16px;height:16px;padding:0 4px;border-radius:99px;background:var(--dsw-alias-brand-primary,#508cff);color:#fff;font-size:10px;font-weight:600;display:grid;place-items:center;flex:none}',
  '.dco-ac-pop{position:fixed;width:264px;transform:translateY(-100%);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);padding:12px;display:flex;flex-direction:column;gap:8px;z-index:95}',
  '.dco-ac-pop h4{margin:0;font-size:12.5px;font-weight:600}',
  '.dco-ac-note{font-size:10.5px;opacity:.6;line-height:1.45}',
  '.dco-ac-list{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto}',
  '.dco-ac-item{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:7px;cursor:pointer;font-size:12px}',
  '.dco-ac-item:hover{background:rgba(127,127,127,.1)}',
  '.dco-ac-item.dis{opacity:.45;cursor:not-allowed}',
  '.dco-ac-item input{accent-color:var(--dsw-alias-brand-primary,#508cff);margin:0;flex:none}',
  '.dco-ac-name{font-family:var(--ds-font-family-code);font-weight:600}',
  '.dco-ac-label{opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dco-ac-usage{margin-left:auto;font-size:10.5px;opacity:.55;flex:none;font-variant-numeric:tabular-nums}',
  '.dco-ac-usage.warn{opacity:.9}',
  '.dco-ac-fail{margin-left:4px;color:var(--dsw-alias-state-error-primary,#d25050)}',
  '.dco-ac-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));padding-top:8px}',
  '.dco-ac-ovr{font-size:10px;opacity:.55}',
  '.dco-ac-link{border:none;background:none;color:var(--dsw-alias-brand-primary,#508cff);font:inherit;font-size:11px;cursor:pointer;padding:0}',
  '.dco-check{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:7px;cursor:pointer;font-size:12px}',
  '.dco-check:hover{background:rgba(127,127,127,.1)}',
  '.dco-check input{accent-color:var(--dsw-alias-brand-primary,#508cff);margin:0;flex:none}',
].join('\n')

let stylesMounted = false
function ensureStyles() {
  if (stylesMounted || typeof document === 'undefined') return
  const style = document.createElement('style')
  style.setAttribute('data-dco', '')
  style.textContent = CSS
  document.head.appendChild(style)
  stylesMounted = true
}

/**
 * Parse a fetch body. The host SPA answers unregistered paths with HTML 200,
 * so `res.ok` is not enough — a missing plugin route used to become `{}`
 * and crash the composer slot on `session.enabled`.
 */
function readApiJson(res, raw) {
  const ct = typeof res.headers?.get === 'function' ? (res.headers.get('content-type') ?? '') : ''
  if (!ct.includes('application/json')) throw new Error('expected JSON')
  try {
    return raw.length === 0 ? {} : JSON.parse(raw)
  } catch {
    throw new Error('invalid JSON')
  }
}

function isAutoConsultState(data) {
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    && data.defaults !== null && typeof data.defaults === 'object'
    && data.session !== null && typeof data.session === 'object'
    && Array.isArray(data.session.enabled)
    && Array.isArray(data.roles)
}

async function api(path, options) {
  const res = await fetch(path, { cache: 'no-store', ...options })
  const raw = await res.text()
  let data
  try {
    data = readApiJson(res, raw)
  } catch (error) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    throw error
  }
  if (!res.ok) {
    const detail = Array.isArray(data.problems) ? data.problems.join('; ') : (data.error ?? `HTTP ${res.status}`)
    throw new Error(detail)
  }
  return data
}

function TextField({ label, value, placeholder, onChange, mono }) {
  return h('div', { className: 'dco-field' },
    h('label', null, label),
    h('input', {
      className: 'dco-input',
      style: mono ? { fontFamily: 'var(--ds-font-family-code)' } : undefined,
      value, placeholder, onChange: (e) => onChange(e.target.value),
    }))
}

function NumberField({ label, value, onChange, max, min = 1, step }) {
  return h('div', { className: 'dco-field' },
    h('label', null, label),
    h('input', {
      className: 'dco-input', type: 'number', min, max, step, value: String(value),
      onChange: (e) => onChange(e.target.value),
    }))
}

/**
 * Grouped model select over the host-served catalog: an explicit
 * follow-CLI-default option, latest aliases, and versioned full ids. A
 * stored value outside the catalog (set by an older release or by hand)
 * still renders through a passthrough option instead of vanishing.
 */
function ModelField({ label, value, t, models, onChange, allowed, required }) {
  const catalog = models ?? { aliases: [], versioned: [] }
  const allow = Array.isArray(allowed) ? new Set(allowed) : null
  const aliases = allow ? catalog.aliases.filter((m) => allow.has(m)) : catalog.aliases
  const versioned = allow ? catalog.versioned.filter((m) => allow.has(m)) : catalog.versioned
  const known = new Set([...(required ? [] : ['']), ...aliases, ...versioned, ...(allow ? [...allow] : [])])
  const extra = value !== '' && !known.has(value)
  const opt = (v, optionLabel, group) => h('option', { key: `g${group}:${v}`, value: v }, optionLabel)
  const selectValue = required && (value === '' || value == null) && allow && allow.size > 0
    ? [...allow][0]
    : value
  return h('div', { className: 'dco-field' },
    h('label', null, label),
    h('select', {
      className: 'dco-input',
      style: { fontFamily: 'var(--ds-font-family-code)' },
      value: selectValue,
      onChange: (e) => onChange(e.target.value),
    },
      required ? null : opt('', t('modelDefault'), 'd'),
      extra ? opt(value, `${t('modelCurrent')}: ${value}`, 'x') : null,
      aliases.length > 0 ? h('optgroup', { key: 'ga', label: t('modelGroupLatest') },
        aliases.map((m) => opt(m, m, 'a'))) : null,
      versioned.length > 0 ? h('optgroup', { key: 'gv', label: t('modelGroupVersioned') },
        versioned.map((m) => opt(m, m, 'v'))) : null,
      allow && versioned.length === 0 && aliases.length === 0
        ? [...allow].map((m) => opt(m, m, 't'))
        : null))
}

const EFFORT_OPTIONS = [
  ['', 'effortDefault'],
  ['low', 'effortLow'],
  ['medium', 'effortMedium'],
  ['high', 'effortHigh'],
  ['xhigh', 'effortXhigh'],
  ['max', 'effortMax'],
]

function EffortField({ label, value, t, onChange }) {
  return h('div', { className: 'dco-field' },
    h('label', null, label),
    h('select', { className: 'dco-input', value: value ?? '', onChange: (e) => onChange(e.target.value) },
      EFFORT_OPTIONS.map(([v, key]) => h('option', { key: v || 'default', value: v }, t(key)))))
}

function Switch({ on, onToggle, title }) {
  return h('button', {
    className: `dco-switch${on ? ' on' : ''}`, title, type: 'button',
    onClick: onToggle, role: 'switch', 'aria-checked': on,
  })
}

function RoleEditor({ role, isNew, t, models, names, onSave, onClose, topTier = TOP_TIER_CONSULTANT_MODELS }) {
  const [draft, setDraft] = useState(role)
  const [problem, setProblem] = useState('')
  // Functional updates throughout: rapid batched input events must each build
  // on the latest state, never on a render-time snapshot.
  const set = (key) => (value) => setDraft((prev) => ({ ...prev, [key]: value }))

  const save = () => {
    const name = String(draft.name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    if (name.length === 0) { setProblem(t('nameRequired')); return }
    if (names.has(name)) { setProblem(`${t('errDupRole')}: ${name}`); return }
    if (draft.enabled !== false && String(draft.systemPrompt ?? '').trim().length === 0) { setProblem(t('requiredPrompt')); return }
    const model = isHighIntellectRoleName(name)
      ? (String(draft.model ?? '').trim() || topTier[0])
      : draft.model
    if (isHighIntellectRoleName(name) && draft.enabled !== false && !topTier.includes(model)) {
      setProblem(t('errAdvisorModel'))
      return
    }
    const fallbackModel = isHighIntellectRoleName(name)
      ? (topTier.includes(String(draft.fallbackModel ?? '').trim()) ? draft.fallbackModel : '')
      : draft.fallbackModel
    onSave({ ...draft, name, model, fallbackModel })
  }

  return h('div', { className: 'dco-modal-bg', onClick: onClose },
    h('div', { className: 'dco-modal', onClick: (e) => e.stopPropagation() },
      h('div', { className: 'dco-modal-head' },
        h('h3', null, isNew ? t('addRole') : `${t('editRole')} · ${draft.name}`),
        h('button', { className: 'dco-modal-x', onClick: onClose, 'aria-label': t('close') }, '✕')),
      h('div', { className: 'dco-modal-body' },
        h(TextField, { label: t('roleName'), value: draft.name ?? '', onChange: set('name'), mono: true }),
        h(TextField, { label: t('roleLabel'), value: draft.label ?? '', onChange: set('label') }),
        h(TextField, { label: t('roleDesc'), value: draft.description ?? '', onChange: set('description') }),
        h('div', { className: 'dco-field' },
          h('label', null, t('rolePrompt')),
          h('textarea', {
            className: 'dco-input', value: draft.systemPrompt ?? '',
            onChange: (e) => set('systemPrompt')(e.target.value),
          })),
        h('div', { className: 'dco-grid' },
          isHighIntellectRoleName(draft.name)
            ? h(ModelField, {
              label: t('roleModelAdvisor'),
              value: draft.model || topTier[0],
              t, models, allowed: topTier, required: true,
              onChange: set('model'),
            })
            : h(ModelField, { label: t('roleModel'), value: draft.model ?? '', t, models, onChange: set('model') }),
          h(ModelField, {
            label: t('roleFallback'),
            value: draft.fallbackModel ?? '',
            t, models,
            allowed: isHighIntellectRoleName(draft.name) ? topTier : undefined,
            onChange: set('fallbackModel'),
          }),
          h(EffortField, { label: t('roleEffort'), value: draft.effort ?? '', t, onChange: set('effort') })),
        isHighIntellectRoleName(draft.name)
          ? h('p', { className: 'dco-hint' }, t('roleModelAdvisorHint'))
          : null,
        problem ? h('div', { className: 'dco-status err' }, problem) : null),
      h('div', { className: 'dco-modal-foot' },
        h('button', { className: 'dco-btn', onClick: onClose }, t('cancel')),
        h('button', { className: 'dco-btn primary', onClick: save }, t('applyDraft')))))
}

function TestPanel({ t, roles }) {
  const enabled = roles.filter((r) => r.enabled !== false)
  const [role, setRole] = useState(enabled[0]?.name ?? '')
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const run = async () => {
    setBusy(true); setResult(null)
    try {
      const data = await api('/dsh-capability-optimizer/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role, question }),
      })
      setResult(data)
    } catch (error) {
      setResult({ ok: false, error: error.message })
    } finally {
      setBusy(false)
    }
  }

  const model = result?.effectiveModel || result?.meta?.effectiveModel || ''
  const ms = result?.meta?.durationMs
  const turns = result?.meta?.numTurns
  const cost = result?.meta?.costUsd
  const metaLine = result === null ? '' : t('testMeta')
    .replace('{model}', model || '—')
    .replace('{ms}', Number.isFinite(ms) ? String(ms) : '—')
    .replace('{turns}', Number.isFinite(turns) ? String(turns) : '—')
    .replace('{cost}', Number.isFinite(cost) ? `$${cost.toFixed(4)}` : '—')

  return h('div', { className: 'dco-card' },
    h('h3', null, t('testTitle')),
    h('div', { className: 'dco-hint' }, t('testHint')),
    h('div', { className: 'dco-row' },
      h('select', { className: 'dco-input', style: { width: 'auto', flex: 'none' }, value: role, onChange: (e) => setRole(e.target.value) },
        enabled.map((r) => h('option', { key: r.name, value: r.name }, r.name))),
      h('input', { className: 'dco-input', placeholder: 'PONG', value: question, onChange: (e) => setQuestion(e.target.value), style: { flex: 1 } }),
      h('button', { className: 'dco-btn primary', disabled: busy || role === '', onClick: run }, busy ? t('testing') : t('testRun'))),
    result !== null && h('div', { className: 'dco-test-out' },
      h('div', { className: `dco-status ${result.ok ? 'ok' : 'err'}` },
        `${result.ok ? `✓ ${t('testOk')}` : `✗ ${t('testFail')}`}${result.role ? ` · ${t('testUsedRole').replace('{role}', result.role)}` : ''} · ${metaLine}${result.usedFallback || result.meta?.usedFallback ? ` · ${t('usedFallback')}` : ''}`),
      result.ok
        ? h('div', { className: 'dco-test-answer' }, result.answer ?? '')
        : h('div', { className: 'dco-test-answer' }, result.error ?? '')))
}

const AUTO_LAST_KEY = 'dsh-capability-optimizer:auto-consult:last'

function readAutoLast() {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(AUTO_LAST_KEY)
    const parsed = raw === null ? null : JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

function writeAutoLast(list) {
  if (typeof window === 'undefined') return
  try {
    if (list === null) window.localStorage.removeItem(AUTO_LAST_KEY)
    else window.localStorage.setItem(AUTO_LAST_KEY, JSON.stringify(list))
  } catch { /* storage unavailable */ }
}

/**
 * Per-role budget badge in the roster popover.
 *
 * `attempts/cap` is the budget line, but a role that burned its whole budget on
 * failed consultations used to read exactly like one that spent it on answers.
 * Failures therefore get their own marker, and the title carries the full
 * ledger breakdown. Note `attempts` already excludes cancellations: the ledger
 * refunds an aborted consult, so it is shown for honesty, not arithmetic.
 *
 * @param {(key: string) => string} t
 * @param {{attempts: number, succeeded: number, failed: number, aborted: number}} [tally]
 * @param {number} attempts - the flat count the popover has always shown.
 * @param {number} cap
 */
function usageBadge(t, tally, attempts, cap) {
  const failed = tally?.failed ?? 0
  const title = [
    `${t('acAttempted')} ${attempts}`,
    `${t('acAnswered')} ${tally?.succeeded ?? 0}`,
    `${t('acFailed')} ${failed}`,
    `${t('acCancelled')} ${tally?.aborted ?? 0}`,
  ].join(' · ')
  return h('span', { className: `dco-ac-usage${failed > 0 ? ' warn' : ''}`, title },
    `${attempts}/${cap}`,
    failed > 0 ? h('span', { className: 'dco-ac-fail' }, `✗${failed}`) : null)
}

/**
 * Composer-seat toggle: a rounded text pill opening a roster popover. Every
 * change pushes the session's override to the host (auto-consult runtime);
 * the last selection is remembered locally and re-applied to sessions that
 * still follow the defaults. The popover is position:fixed against the
 * button's measured rect (composer containers may clip absolutely-positioned
 * children), and it always opens — data not yet loaded shows a loading/retry
 * shell, so a press is never silently dead. Usage counts refresh while open.
 */
function AutoConsultControl({ sessionId, t }) {
  const [state, setState] = useState(null)   // { defaults, session, roles }
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState(null) // { left, top } measured at open
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState(null)
  const root = useRef(null)
  const btn = useRef(null)

  const adopt = useCallback((data) => {
    if (!isAutoConsultState(data)) throw new Error(t('acNotJson'))
    setState(data)
    setFail(null)
    return data
  }, [t])

  const pull = useCallback(async () => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    try {
      let data = await api(`/dsh-capability-optimizer/autoconsult?session=${encodeURIComponent(sessionId)}`)
      // Session still on defaults: seed it with the remembered selection.
      if (isAutoConsultState(data) && data.session.override === null) {
        const last = readAutoLast()
        if (last !== null) {
          data = await api('/dsh-capability-optimizer/autoconsult-save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: sessionId, enabled: last }),
          })
        }
      }
      adopt(data)
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      setFail(/json/i.test(raw) ? t('acNotJson') : raw)
    }
  }, [sessionId, adopt, t])

  useEffect(() => { setState(null); setFail(null); pull() }, [pull])

  // Keep usage counts fresh while the popover is open.
  useEffect(() => {
    if (!open || typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const timer = setInterval(() => {
      api(`/dsh-capability-optimizer/autoconsult?session=${encodeURIComponent(sessionId)}`)
        .then((data) => { if (isAutoConsultState(data)) { setState(data); setFail(null) } })
        .catch(() => { /* transient */ })
    }, 8000)
    return () => { clearInterval(timer) }
  }, [open, sessionId])

  // Close on an outside press.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (root.current !== null && !root.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [open])

  const toggleOpen = () => {
    if (!open && btn.current !== null && typeof window !== 'undefined') {
      const rect = btn.current.getBoundingClientRect()
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 272))
      setAnchor({ left, top: rect.top - 8 })
    }
    setOpen(!open)
  }

  const push = async (enabled) => {
    setBusy(true)
    try {
      const data = await api('/dsh-capability-optimizer/autoconsult-save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: sessionId, enabled }),
      })
      adopt(data)
      writeAutoLast(enabled)
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      setFail(/json/i.test(raw) ? t('acNotJson') : raw)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (name) => {
    if (state === null || busy) return
    const next = new Set(state.session.enabled)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    const list = [...next]
    setState({ ...state, session: { ...state.session, enabled: list } })
    push(list)
  }

  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  const enabledCount = Array.isArray(state?.session?.enabled) ? state.session.enabled.length : 0
  const overrideOn = state !== null && state.session?.override !== null
  const cap = Number.isFinite(state?.defaults?.capPerRole) ? state.defaults.capPerRole : 0

  return h('div', { className: 'dco-ac', ref: root },
    h('button', {
      className: `dco-ac-btn${enabledCount > 0 ? ' on' : ''}`,
      type: 'button',
      title: t('acTooltip'),
      onClick: toggleOpen,
      'aria-haspopup': 'true',
      'aria-expanded': open,
      ref: btn,
    }, t('autoTitle'),
      enabledCount > 0 ? h('span', { className: 'dco-ac-count' }, String(enabledCount)) : null),
    open && h('div', {
      className: 'dco-ac-pop',
      style: anchor === null ? { left: '8px', bottom: '48px' } : { left: `${anchor.left}px`, top: `${anchor.top}px` },
    },
      state === null
        ? h('div', { className: 'dco-ac-note' }, `${fail ?? t('loading')} `,
            h('button', { className: 'dco-ac-link', type: 'button', onClick: pull }, t('retry')))
        : h(React.Fragment, null,
          h('h4', null, t('autoTitle')),
          h('div', { className: 'dco-ac-note' }, state.defaults?.mode === 'off' ? t('autoHintOff') : t('autoHint')),
          fail ? h('div', { className: 'dco-ac-note' }, fail) : null,
          Array.isArray(state.dropped ?? state.session.overrideDropped) && (state.dropped ?? state.session.overrideDropped).length > 0
            ? h('div', { className: 'dco-ac-note' }, t('acDropped').replace('{keys}', (state.dropped ?? state.session.overrideDropped).map((entry) => entry.key).join(', ')))
            : null,
          h('div', { className: 'dco-ac-list' },
            state.roles.length === 0
              ? h('div', { className: 'dco-ac-note' }, t('acEmpty'))
              : state.roles.map((role) => h('label', { key: role.name, className: `dco-ac-item${role.enabled ? '' : ' dis'}` },
                h('input', {
                  type: 'checkbox',
                  checked: state.session.enabled.includes(role.name),
                  disabled: !role.enabled || busy,
                  onChange: () => { toggle(role.name) },
                }),
                h('span', { className: 'dco-ac-name' }, role.name),
                role.label ? h('span', { className: 'dco-ac-label' }, role.label) : null,
                usageBadge(t, state.session.usage?.[role.name], state.session.counts?.[role.name] ?? 0, cap))),
          h('div', { className: 'dco-ac-foot' },
            h('span', { className: 'dco-ac-ovr' }, overrideOn ? t('acOverrideOn') : null),
            overrideOn
              ? h('button', { className: 'dco-ac-link', type: 'button', disabled: busy, onClick: () => { push(null) } }, t('acFollowDefaults'))
              : null)))))
}

function ReservedWorkspace({ t, backend }) {
  const noteKey = BACKEND_NOTE_KEYS[backend.id]
  const note = (noteKey ? t(noteKey) : '') || backend.note || t('reservedBody')
  return h('div', { className: 'dco-reserved' },
    h('h3', { style: { margin: 0, fontSize: '14px' } }, backend.label),
    h('span', { className: 'dco-pill tag' }, t('tabPlanned')),
    h('p', { className: 'dco-hint', style: { margin: 0 } }, note),
    h('p', { className: 'dco-hint', style: { margin: 0 } },
      `${t('cliCommandLabel')}: `,
      h('code', { style: { fontFamily: 'var(--ds-font-family-code)' } }, backend.cli)))
}

function Section({ t }) {
  const [activeBackend, setActiveBackend] = useState('claude-code')
  const [loaded, setLoaded] = useState(null)   // { effective, autoConsult, fileError, ... }
  const [draft, setDraft] = useState(null)     // editable copy
  const [auto, setAuto] = useState(null)       // auto-consult defaults draft
  const [status, setStatus] = useState(null)   // { kind: 'ok'|'err', text }
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(null) // { role, isNew }

  useEffect(() => { ensureStyles() }, [])

  const load = useCallback(async () => {
    setLoaded(null); setStatus(null)
    try {
      const data = await api('/dsh-capability-optimizer/settings')
      setLoaded(data)
      setDraft(JSON.parse(JSON.stringify(data.effective)))
      setAuto(JSON.parse(JSON.stringify(data.autoConsult ?? { enabled: [], capPerRole: 3, mode: 'remind' })))
    } catch (error) {
      setStatus({ kind: 'err', text: `${t('loadFail')}: ${error.message}` })
    }
  }, [t])

  useEffect(() => { load() }, [load])

  if (draft === null) {
    return h('div', { className: 'dco-section' },
      h('h2', null, t('nav')),
      status
        ? h('div', { className: 'dco-status err' }, status.text, ' ', h('button', { className: 'dco-btn', onClick: load }, t('retry')))
        : h('div', { className: 'dco-empty' }, t('loading')))
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(loaded.effective)
    || JSON.stringify(auto) !== JSON.stringify(loaded.autoConsult)
  const num = (key, fallback, max) => (value) => {
    const n = Number(value)
    let next = Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
    if (max !== undefined && next > max) next = max
    setDraft((prev) => ({ ...prev, [key]: next }))
  }
  const field = (key) => (value) => setDraft((prev) => ({ ...prev, [key]: value }))

  const save = async () => {
    // Reject every state the UI can reach before the POST, so the server's
    // English validation strings never surface in a localized interface.
    const problems = []
    if (draft.roles.length === 0) {
      problems.push(t('errNoRoles'))
    } else {
      if (draft.roles.every((r) => r.enabled === false)) problems.push(t('errAllDisabled'))
      for (const r of draft.roles) {
        if (r.enabled !== false && String(r.systemPrompt ?? '').trim().length === 0) problems.push(`${t('requiredPrompt')}: ${r.name}`)
        if (r.enabled !== false && isHighIntellectRoleName(r.name, loaded)
          && !topTierModels(loaded).includes(r.model || topTierModels(loaded)[0])) {
          problems.push(`${t('errAdvisorModel')}: ${r.name}`)
        }
        if (r.enabled !== false && isHighIntellectRoleName(r.name, loaded)
          && String(r.fallbackModel ?? '').trim().length > 0
          && !topTierModels(loaded).includes(String(r.fallbackModel).trim())) {
          problems.push(`${t('errAdvisorFallback')}: ${r.name}`)
        }
      }
    }
    for (const [key, max] of [['timeoutMs', 3600000], ['maxTurns', 3600000], ['maxPanelRoles', 32]]) {
      const v = Number(draft[key])
      if (!(Number.isFinite(v) && v > 0 && v <= max)) problems.push(`${t(key)}: ${t('errNumberRange')}`)
    }
    if (problems.length > 0) {
      setStatus({ kind: 'err', text: problems.join(' · ') })
      return
    }
    setBusy(true); setStatus(null)
    try {
      const fileBackends = (loaded.fileSettings && loaded.fileSettings.backends) || {}
      const payload = { version: 2, backends: { ...fileBackends, 'claude-code': draft }, autoConsult: auto }
      const data = await api('/dsh-capability-optimizer/settings-save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      setLoaded({
        ...loaded,
        effective: data.effective,
        autoConsult: data.autoConsult,
        repairs: data.repairs ?? [],
        validationProblems: data.validationProblems ?? [],
        rejectedArgs: data.rejectedArgs ?? [],
        fileError: data.fileError ?? null,
        fileSettings: data.fileSettings ?? null,
        fileExists: data.fileExists !== false,
      })
      setDraft(JSON.parse(JSON.stringify(data.effective)))
      setAuto(JSON.parse(JSON.stringify(data.autoConsult)))
      const notes = [data.applied === false ? t('savedNotApplied') : t('saved')]
      if (Array.isArray(data.rejectedArgs) && data.rejectedArgs.length > 0) {
        notes.push(t('rejectedArgsNote').replace('{args}', data.rejectedArgs.map((entry) => entry.arg).join(' ')))
      }
      setStatus({ kind: data.applied === false ? 'err' : 'ok', text: notes.join(' · ') })
    } catch (error) {
      setStatus({ kind: 'err', text: `${t('saveFail')}: ${error.message}` })
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    if (typeof window !== 'undefined' && !window.confirm(t('confirmReset'))) return
    setBusy(true); setStatus(null)
    try {
      const data = await api('/dsh-capability-optimizer/settings/reset', { method: 'POST' })
      setLoaded({
        ...loaded,
        effective: data.effective,
        autoConsult: data.autoConsult,
        repairs: [],
        validationProblems: [],
        rejectedArgs: [],
        fileError: null,
        fileSettings: null,
        fileExists: false,
      })
      setDraft(JSON.parse(JSON.stringify(data.effective)))
      setAuto(JSON.parse(JSON.stringify(data.autoConsult)))
      setStatus({
        kind: data.applied === false ? 'err' : 'ok',
        text: data.applied === false ? t('resetNotApplied') : t('resetDone'),
      })
    } catch (error) {
      setStatus({ kind: 'err', text: error.message })
    } finally {
      setBusy(false)
    }
  }

  const setRole = (index, patch) => {
    const roles = draft.roles.map((role, i) => (i === index ? { ...role, ...patch } : role))
    setDraft((prev) => ({ ...prev, roles }))
  }

  return h('div', { className: 'dco-section' },
    h('div', null,
      h('h2', { style: { margin: 0, fontSize: '15px' } }, t('nav')),
      h('p', { className: 'dco-sub' }, t('subtitle')),
      loaded.fileError ? h('p', { className: 'dco-status err' }, t('fileError')) : null,
      Array.isArray(loaded.validationProblems) && loaded.validationProblems.length > 0
        ? h('p', { className: 'dco-status err' }, t('validationProblems').replace('{problems}', loaded.validationProblems.join('; ')))
        : null,
      Array.isArray(loaded.repairs) && loaded.repairs.length > 0
        ? h('p', { className: 'dco-status' }, t('repairsNote').replace('{repairs}', loaded.repairs.map((item) => `${item.from || '∅'} → ${item.to}`).join(', ')))
        : null,
      Array.isArray(loaded.rejectedArgs) && loaded.rejectedArgs.length > 0
        ? h('p', { className: 'dco-status' }, t('rejectedArgsNote').replace('{args}', loaded.rejectedArgs.map((entry) => entry.arg).join(' ')))
        : null),

    h('div', { className: 'dco-tabs', role: 'tablist' },
      (loaded.backends ?? []).map((b) => h('button', {
        key: b.id,
        type: 'button',
        role: 'tab',
        'aria-selected': b.id === activeBackend,
        className: `dco-tab${b.id === activeBackend ? ' active' : ''}${b.available ? '' : ' reserved'}`,
        onClick: () => setActiveBackend(b.id),
      }, b.label, b.available ? null : h('span', { className: 'dco-tab-note' }, t('tabPlanned'))))),

    (loaded.backends ?? []).every((b) => !b.available || b.id !== activeBackend)
      ? h(ReservedWorkspace, { t, backend: (loaded.backends ?? []).find((b) => b.id === activeBackend) ?? { label: activeBackend, cli: '', note: '' } })
      : h('div', { className: 'dco-workspace' },
    h('div', { className: 'dco-card' },
      h('h3', null, t('generalTitle')),
      h('div', { className: 'dco-grid' },
        h(TextField, { label: t('cliPath'), value: draft.cliPath ?? '', placeholder: t('cliPathPh'), onChange: field('cliPath'), mono: true }),
        h(ModelField, { label: t('defaultModel'), value: draft.model ?? '', t, models: loaded.models, onChange: field('model') }),
        h(EffortField, { label: t('effort'), value: draft.effort ?? '', t, onChange: field('effort') }),
        h(ModelField, { label: t('fallbackModel'), value: draft.fallbackModel ?? '', t, models: loaded.models, onChange: field('fallbackModel') }),
        h(NumberField, { label: t('timeoutMs'), value: draft.timeoutMs, max: 3600000, onChange: num('timeoutMs', 300000, 3600000) }),
        h(NumberField, { label: t('maxTurns'), value: draft.maxTurns, max: 200, onChange: num('maxTurns', 8, 200) }),
        h(NumberField, { label: t('maxPanelRoles'), value: draft.maxPanelRoles, max: 32, onChange: num('maxPanelRoles', 4, 32) }),
        h(NumberField, {
          label: t('maxBudgetUsd'), value: draft.maxBudgetUsd ?? 0, min: 0, max: 100000, step: '0.01',
          onChange: (value) => {
            const n = Number(value)
            setDraft((prev) => ({ ...prev, maxBudgetUsd: Number.isFinite(n) && n >= 0 ? n : 0 }))
          },
        }),
        h(TextField, { label: t('extraArgs'), value: (draft.extraArgs ?? []).join(' '), placeholder: t('extraArgsPh'), onChange: (v) => setDraft((prev) => ({ ...prev, extraArgs: v.split(/\s+/).filter((x) => x.length > 0) })), mono: true }))),

    h('div', { className: 'dco-card' },
      h('div', { className: 'dco-row' },
        h('h3', { style: { margin: 0 } }, t('rolesTitle')),
        h('span', { className: 'dco-hint' }, t('rolesHint')),
        h('span', { style: { marginLeft: 'auto' } },
          h('button', { className: 'dco-btn', onClick: () => setEditing({ role: { name: '', label: '', description: '', systemPrompt: '', model: '', fallbackModel: '', enabled: true }, isNew: true }) }, `+ ${t('addRole')}`))),
      h('div', { className: 'dco-roles' },
        draft.roles.map((role, index) => {
          const meta = []
          if (role.model) meta.push(h('span', { key: 'm', className: 'dco-pill' }, `${t('roleModelPill')}: ${role.model}`))
          if (isHighIntellectRoleName(role.name, loaded) && topTierModels(loaded).includes(role.model)) {
            meta.push(h('span', { key: 'tt', className: 'dco-pill tag' }, t('roleTopTierPill')))
          }
          if (role.fallbackModel) meta.push(h('span', { key: 'f', className: 'dco-pill' }, `${t('roleFallbackPill')}: ${role.fallbackModel}`))
          if (role.effort) meta.push(h('span', { key: 'e', className: 'dco-pill' }, `${t('roleEffortPill')}: ${role.effort}`))
          const descKey = BUILTIN_DESC_KEYS[role.name]
          const desc = descKey && role.description === BUILTIN_DESC_EN[role.name] ? t(descKey) : (role.description ?? '')
          return h('div', { className: 'dco-role', key: role.name || index },
            h('div', { className: 'dco-role-top' },
              h('span', { className: `dco-dot${role.enabled === false ? ' off' : ''}` }),
              h('span', { className: 'dco-role-name' }, role.name),
              role.label ? h('span', { style: { fontSize: '12px', opacity: .7 } }, role.label) : null,
              role.name in BUILTIN_DESC_EN ? h('span', { className: 'dco-pill tag' }, t('builtin')) : h('span', { className: 'dco-pill' }, t('custom')),
              h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' } },
                h(Switch, { on: role.enabled !== false, title: t('enabled'), onToggle: () => setRole(index, { enabled: role.enabled === false }) }),
                h('button', { className: 'dco-btn', onClick: () => setEditing({ role, isNew: false }) }, t('editRole')),
                h('button', { className: 'dco-btn danger', onClick: () => { if (window.confirm(t('confirmDelete'))) setDraft((prev) => ({ ...prev, roles: prev.roles.filter((_, i) => i !== index) })) } }, t('delete')))),
            meta.length > 0 ? h('div', { className: 'dco-role-meta' }, meta) : null,
            h('div', { className: 'dco-role-desc' }, desc))
        })))),

    h('div', { className: 'dco-card' },
      h('div', { className: 'dco-row' },
        h('h3', { style: { margin: 0 } }, t('autoTitle')),
        h('span', { className: 'dco-hint' }, t('autoDefaultsHint'))),
      h('div', { className: 'dco-hint' }, t('autoHint')),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
        draft.roles.filter((role) => role.enabled !== false).map((role) => h('label', { key: role.name, className: 'dco-check' },
          h('input', {
            type: 'checkbox',
            checked: auto.enabled.includes(`claude-code:${role.name}`),
            onChange: (e) => setAuto((prev) => {
              const key = `claude-code:${role.name}`
              const set = new Set(prev.enabled)
              if (e.target.checked) set.add(key)
              else set.delete(key)
              return { ...prev, enabled: [...set] }
            }),
          }),
          h('span', { className: 'dco-role-name' }, role.name),
          role.label ? h('span', { style: { fontSize: '12px', opacity: .7 } }, role.label) : null))),
      h('div', { className: 'dco-grid' },
        h(NumberField, { label: t('autoCap'), value: auto.capPerRole, max: 50, onChange: (v) => {
          const n = Number(v)
          setAuto((prev) => ({ ...prev, capPerRole: Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50) : 3 }))
        } }),
        h('div', { className: 'dco-field' },
          h('label', null, t('autoMode')),
          h('select', {
            className: 'dco-input',
            value: auto.mode === 'off' || auto.mode === 'required' ? auto.mode : 'remind',
            onChange: (e) => setAuto((prev) => ({ ...prev, mode: e.target.value })),
          },
            h('option', { value: 'off' }, t('autoModeOff')),
            h('option', { value: 'remind' }, t('autoModeRemind')),
            h('option', { value: 'required' }, t('autoModeRequired'))))),
      h('p', { className: 'dco-hint' }, t('autoModeHint'))),

    h(TestPanel, { t, roles: loaded.effective?.roles ?? draft.roles }),

    h('div', { className: 'dco-row' },
      h('button', { className: 'dco-btn primary', disabled: !dirty || busy, onClick: save }, busy ? t('saving') : t('save')),
      h('button', { className: 'dco-btn danger', disabled: busy, onClick: reset }, t('reset')),
      dirty && !busy ? h('span', { className: 'dco-hint' }, `· ${t('dirtyHint')}`) : null,
      status ? h('span', { className: `dco-status ${status.kind}` }, status.text) : null),

    editing !== null && h(RoleEditor, {
      role: editing.role, isNew: editing.isNew, t, models: loaded.models,
      topTier: topTierModels(loaded),
      names: new Set(draft.roles.filter((r) => r !== editing.role).map((r) => r.name)),
      onClose: () => setEditing(null),
      onSave: (role) => {
        const index = editing.isNew ? draft.roles.length : draft.roles.indexOf(editing.role)
        const roles = [...draft.roles]
        roles[editing.isNew ? roles.length : Math.max(0, index)] = role
        setDraft((prev) => ({ ...prev, roles }))
        setEditing(null)
      },
    }))
}

exports.name = 'dsh-capability-optimizer'
// 'slots' and 'locale' are safe to require: ui-layout (mandatory in every web
// composition) already hard-depends on them.
exports.inject = ['slots', 'locale']
exports.isAutoConsultState = isAutoConsultState
exports.readApiJson = readApiJson

exports.apply = function apply(ctx) {
  // Chat seat never mounts the Settings section, so styles cannot wait for it.
  ensureStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-capability-optimizer: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'capability-optimizer',
    order: 42,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t }),
  }, () => h(Section, { t })))

  // Composer-seat toggle in the conversation input toolbar (the permissions
  // control's row). Session-scoped: the framework hands the component the
  // live sessionId as a standard prop; declaring `locale` provides `t`.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'capability-optimizer',
    order: 30,
    locale: NS,
  }, AutoConsultControl))
}

return module.exports
}})
