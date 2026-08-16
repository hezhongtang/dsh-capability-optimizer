window.__ModuleLoader__.load({ id: "dsh-capability-optimizer", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-capability-optimizer client.
 *
 * One seat: a Settings section ("Expert Consult") managing the consultation
 * settings — CLI path, default + fallback models (omp-style one-hop model
 * fallback), timeouts, and the role roster workspace (add / edit / toggle /
 * delete, omp-style enabled flag that parks a role without dropping it).
 * Saves hot-apply on the host: the agent tools re-register immediately, no
 * dsh restart. Includes an end-to-end test call that really consults Claude
 * once (spends quota) to verify CLI + auth + proxy.
 *
 * Hand-authored CJS bundle (no build step); the only external is `react`.
 */

const React = require('react')
const h = React.createElement
const { useState, useEffect, useCallback, useId } = React

const NS = 'dsh-capability-optimizer'

const zh = {
  nav: '专家咨询',
  subtitle: '以角色人设 headless 调用 Claude Code，回复作为参考答案',
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
  fallbackModel: '回退模型（fallback）',
  effort: '推理等级（thinking effort）',
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
  extraArgsPh: '空格分隔，如 --settings ./x.json',
  rolesTitle: '角色',
  rolesHint: '停用的角色保留在册但不出现在工具枚举中（omp 风格）',
  addRole: '新增角色',
  editRole: '编辑角色',
  roleName: '名称（slug）',
  roleLabel: '显示名（可选）',
  roleDesc: '用途说明（何时选它）',
  rolePrompt: '角色提示词（systemPrompt）',
  roleModel: '专属模型（可选）',
  roleFallback: '专属回退模型（可选）',
  roleEffort: '专属推理等级（可选）',
  enabled: '启用',
  disabled: '已停用',
  roleModelPill: '模型',
  roleFallbackPill: '回退',
  builtin: '内置',
  custom: '自定义',
  delete: '删除',
  confirmDelete: '删除该角色？',
  cancel: '取消',
  save: '保存并生效',
  saving: '保存中…',
  saved: '已保存并热生效',
  saveFail: '保存失败',
  dirtyHint: '有未保存的修改',
  reset: '恢复默认',
  confirmReset: '放弃全部设置，恢复内置默认？',
  resetDone: '已恢复默认',
  testTitle: '连通性测试',
  testHint: '将真实调用一次 Claude（消耗订阅额度）',
  testRole: '角色',
  testQuestion: '测试问题',
  testRun: '运行测试',
  testing: '测试中…',
  testOk: '成功',
  testFail: '失败',
  testAnswer: '回复',
  testMeta: '模型 {model} · {ms}ms · {turns} 轮 · ${cost}',
  usedFallback: '已触发模型回退',
  requiredPrompt: '启用状态的角色提示词不能为空',
  nameRequired: '名称不能为空',
  tabPlanned: '规划中',
  reservedTitle: '工作区已预留',
  reservedBody: '该 harness 的运行器就绪后，其配置将在此展开；角色体系与咨询工具保持共用。',
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
  extraArgsPh: 'space-separated, e.g. --settings ./x.json',
  rolesTitle: 'Roles',
  rolesHint: 'A disabled role stays in the roster but leaves the tools\' enum (omp-style)',
  addRole: 'Add role',
  editRole: 'Edit role',
  roleName: 'Name (slug)',
  roleLabel: 'Display label (optional)',
  roleDesc: 'Description (when to pick it)',
  rolePrompt: 'Role system prompt',
  roleModel: 'Dedicated model (optional)',
  roleFallback: 'Dedicated fallback model (optional)',
  roleEffort: 'Dedicated thinking effort (optional)',
  enabled: 'Enabled',
  disabled: 'Disabled',
  roleModelPill: 'model',
  roleFallbackPill: 'fallback',
  builtin: 'built-in',
  custom: 'custom',
  delete: 'Delete',
  confirmDelete: 'Delete this role?',
  cancel: 'Cancel',
  save: 'Save & apply',
  saving: 'Saving…',
  saved: 'Saved and hot-applied',
  saveFail: 'Save failed',
  dirtyHint: 'Unsaved changes',
  reset: 'Reset to defaults',
  confirmReset: 'Discard all settings and restore built-in defaults?',
  resetDone: 'Reset to defaults',
  testTitle: 'Connectivity test',
  testHint: 'Runs one real Claude consultation (spends subscription quota)',
  testRole: 'Role',
  testQuestion: 'Test question',
  testRun: 'Run test',
  testing: 'Testing…',
  testOk: 'OK',
  testFail: 'Failed',
  testAnswer: 'Answer',
  testMeta: 'model {model} · {ms}ms · {turns} turns · ${cost}',
  usedFallback: 'model fallback used',
  requiredPrompt: 'An enabled role needs a system prompt',
  nameRequired: 'Name is required',
  tabPlanned: 'planned',
  reservedTitle: 'Workspace reserved',
  reservedBody: 'Once this harness\'s runner lands, its configuration unfolds here; the role roster and consultation tools stay shared.',
  cliCommandLabel: 'CLI command',
}

const BUILTIN_NAMES = new Set(['advisor', 'reviewer', 'designer'])

const CSS = [
  '.dco-section{display:flex;flex-direction:column;gap:18px;max-width:760px}',
  '.dco-sub{margin:2px 0 0;font-size:12px;opacity:.65}',
  '.dco-card{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:12px}',
  '.dco-card h3{margin:0;font-size:13px;font-weight:600}',
  '.dco-hint{font-size:12px;opacity:.6}',
  '.dco-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px 16px}',
  '.dco-field{display:flex;flex-direction:column;gap:4px;font-size:12px}',
  '.dco-field>label{opacity:.75}',
  '.dco-input,select.dco-input,textarea.dco-input{background:var(--dsw-alias-bg-input,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:7px;color:inherit;font:inherit;font-size:12.5px;padding:6px 9px;outline:none;width:100%;box-sizing:border-box}',
  '.dco-input:focus{border-color:var(--dsw-alias-accent,#5b4cf0)}',
  'textarea.dco-input{resize:vertical;min-height:110px;font-family:var(--dsw-alias-font-mono,monospace);line-height:1.5}',
  '.dco-row{display:flex;align-items:center;gap:8px}',
  '.dco-roles{display:flex;flex-direction:column;gap:8px}',
  '.dco-role{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:9px;padding:9px 12px;display:flex;flex-direction:column;gap:5px}',
  '.dco-role-top{display:flex;align-items:center;gap:8px}',
  '.dco-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-success,#2ea44f)}',
  '.dco-dot.off{background:var(--dsw-alias-danger,rgba(200,60,60,.8));opacity:.5}',
  '.dco-role-name{font-family:var(--dsw-alias-font-mono,monospace);font-size:12.5px;font-weight:600}',
  '.dco-pill{font-size:10.5px;padding:1px 7px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));opacity:.8;white-space:nowrap}',
  '.dco-pill.tag{background:var(--dsw-alias-accent-soft,rgba(91,76,240,.14));border-color:transparent}',
  '.dco-role-desc{font-size:12px;opacity:.7;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
  '.dco-btn{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:transparent;color:inherit;font:inherit;font-size:12px;border-radius:7px;padding:5px 12px;cursor:pointer;white-space:nowrap}',
  '.dco-btn:hover{background:rgba(127,127,127,.12)}',
  '.dco-btn:disabled{opacity:.45;cursor:not-allowed}',
  '.dco-btn.primary{background:var(--dsw-alias-accent,#5b4cf0);border-color:transparent;color:#fff}',
  '.dco-btn.primary:hover{filter:brightness(1.08);background:var(--dsw-alias-accent,#5b4cf0)}',
  '.dco-btn.danger:hover{border-color:var(--dsw-alias-danger,rgba(200,60,60,.8));color:var(--dsw-alias-danger,rgba(200,60,60,.9))}',
  '.dco-status{font-size:12px}',
  '.dco-status.ok{color:var(--dsw-alias-success,#2ea44f)}',
  '.dco-status.err{color:var(--dsw-alias-danger,rgba(200,60,60,.9))}',
  '.dco-test-out{border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));padding-top:10px;display:flex;flex-direction:column;gap:6px;font-size:12px}',
  '.dco-test-answer{background:var(--dsw-alias-bg-input,rgba(127,127,127,.12));border-radius:7px;padding:8px 10px;white-space:pre-wrap;max-height:160px;overflow:auto}',
  '.dco-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:100}',
  '.dco-modal{background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);width:min(560px,92vw);max-height:84vh;display:flex;flex-direction:column;outline:none}',
  '.dco-modal-head{display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25))}',
  '.dco-modal-head h3{margin:0;font-size:14px}',
  '.dco-modal-x{margin-left:auto;border:none;background:transparent;color:inherit;cursor:pointer;font-size:13px;opacity:.6;padding:4px 6px;border-radius:6px}',
  '.dco-modal-x:hover{opacity:1;background:rgba(127,127,127,.15)}',
  '.dco-modal-body{padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:10px}',
  '.dco-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25))}',
  '.dco-switch{position:relative;width:30px;height:17px;border-radius:99px;background:rgba(127,127,127,.4);border:none;cursor:pointer;flex:none;transition:background .15s}',
  '.dco-switch.on{background:var(--dsw-alias-accent,#5b4cf0)}',
  '.dco-switch::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:left .15s}',
  '.dco-switch.on::after{left:15px}',
  '.dco-empty{font-size:12px;opacity:.55}',
  '.dco-tabs{display:flex;flex-wrap:wrap;gap:6px}',
  '.dco-tab{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:transparent;color:inherit;font:inherit;font-size:12px;border-radius:99px;padding:4px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}',
  '.dco-tab:hover{background:rgba(127,127,127,.12)}',
  '.dco-tab.active{background:var(--dsw-alias-accent,#5b4cf0);border-color:transparent;color:#fff}',
  '.dco-tab.reserved{opacity:.6}',
  '.dco-tab .dco-tab-note{font-size:9.5px;padding:0 6px;border-radius:99px;background:rgba(127,127,127,.18)}',
  '.dco-tab.active .dco-tab-note{background:rgba(255,255,255,.25)}',
  '.dco-workspace{display:flex;flex-direction:column;gap:18px}',
  '.dco-reserved{border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-radius:10px;padding:28px 20px;display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center}',
  '.dsh-reserved-name{font-size:14px;font-weight:600}',
  '.dco-reserved .dco-hint{max-width:420px}',
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

async function api(path, options) {
  const res = await fetch(path, { cache: 'no-store', ...options })
  const data = await res.json().catch(() => ({}))
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
      style: mono ? { fontFamily: 'var(--dsw-alias-font-mono,monospace)' } : undefined,
      value, placeholder, onChange: (e) => onChange(e.target.value),
    }))
}

function NumberField({ label, value, onChange, max }) {
  return h('div', { className: 'dco-field' },
    h('label', null, label),
    h('input', {
      className: 'dco-input', type: 'number', min: 1, max, value: String(value),
      onChange: (e) => onChange(e.target.value),
    }))
}

/**
 * Grouped model select over the host-served catalog: an explicit
 * follow-CLI-default option, latest aliases, and versioned full ids. A
 * stored value outside the catalog (set by an older release or by hand)
 * still renders through a passthrough option instead of vanishing.
 */
function ModelField({ label, value, t, models, onChange }) {
  const catalog = models ?? { aliases: [], versioned: [] }
  const known = new Set(['', ...catalog.aliases, ...catalog.versioned])
  const extra = value !== '' && !known.has(value)
  const opt = (v, label, group) => h('option', { key: `g${group}:${v}`, value: v }, label)
  return h('div', { className: 'dco-field' },
    h('label', null, label),
    h('select', {
      className: 'dco-input',
      style: { fontFamily: 'var(--dsw-alias-font-mono,monospace)' },
      value,
      onChange: (e) => onChange(e.target.value),
    },
      opt('', t('modelDefault'), 'd'),
      extra ? opt(value, `${t('modelCurrent')}: ${value}`, 'x') : null,
      catalog.aliases.length > 0 ? h('optgroup', { key: 'ga', label: t('modelGroupLatest') },
        catalog.aliases.map((m) => opt(m, m, 'a'))) : null,
      catalog.versioned.length > 0 ? h('optgroup', { key: 'gv', label: t('modelGroupVersioned') },
        catalog.versioned.map((m) => opt(m, m, 'v'))) : null))
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

function RoleEditor({ role, isNew, t, models, onSave, onClose }) {
  const [draft, setDraft] = useState(role)
  const [problem, setProblem] = useState('')
  // Functional updates throughout: rapid batched input events must each build
  // on the latest state, never on a render-time snapshot.
  const set = (key) => (value) => setDraft((prev) => ({ ...prev, [key]: value }))

  const save = () => {
    const name = String(draft.name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    if (name.length === 0) { setProblem(t('nameRequired')); return }
    if (draft.enabled !== false && String(draft.systemPrompt ?? '').trim().length === 0) { setProblem(t('requiredPrompt')); return }
    onSave({ ...draft, name })
  }

  return h('div', { className: 'dco-modal-bg', onClick: onClose },
    h('div', { className: 'dco-modal', onClick: (e) => e.stopPropagation() },
      h('div', { className: 'dco-modal-head' },
        h('h3', null, isNew ? t('addRole') : `${t('editRole')} · ${draft.name}`),
        h('button', { className: 'dco-modal-x', onClick: onClose, 'aria-label': 'close' }, '✕')),
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
          h(ModelField, { label: t('roleModel'), value: draft.model ?? '', t, models, onChange: set('model') }),
          h(ModelField, { label: t('roleFallback'), value: draft.fallbackModel ?? '', t, models, onChange: set('fallbackModel') }),
          h(EffortField, { label: t('effort'), value: draft.effort ?? '', t, onChange: set('effort') })),
        problem ? h('div', { className: 'dco-status err' }, problem) : null),
      h('div', { className: 'dco-modal-foot' },
        h('button', { className: 'dco-btn', onClick: onClose }, t('cancel')),
        h('button', { className: 'dco-btn primary', onClick: save }, t('save')))))
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

  const metaBits = []
  if (result?.meta) {
    if (Number.isFinite(result.meta.numTurns)) metaBits.push(`${result.meta.numTurns}`)
    if (Number.isFinite(result.meta.durationMs)) metaBits.push(`${result.meta.durationMs}ms`)
    if (Number.isFinite(result.meta.costUsd)) metaBits.push(`$${result.meta.costUsd.toFixed(4)}`)
  }

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
        `${result.ok ? `✓ ${t('testOk')}` : `✗ ${t('testFail')}`}${metaBits.length > 0 ? ` · ${metaBits.join(' · ')}` : ''}${result.meta?.usedFallback ? ` · ${t('usedFallback')}` : ''}`),
      result.ok
        ? h('div', { className: 'dco-test-answer' }, result.answer ?? '')
        : h('div', { className: 'dco-test-answer' }, result.error ?? '')))
}

function ReservedWorkspace({ t, backend }) {
  return h('div', { className: 'dco-reserved' },
    h('h3', { style: { margin: 0, fontSize: '14px' } }, backend.label),
    h('span', { className: 'dco-pill tag' }, t('tabPlanned')),
    h('p', { className: 'dco-hint', style: { margin: 0 } }, backend.note || t('reservedBody')),
    h('p', { className: 'dco-hint', style: { margin: 0 } },
      `${t('cliCommandLabel')}: `,
      h('code', { style: { fontFamily: 'var(--dsw-alias-font-mono,monospace)' } }, backend.cli)))
}

function Section({ t }) {
  const [activeBackend, setActiveBackend] = useState('claude-code')
  const [loaded, setLoaded] = useState(null)   // { effective, fileError, ... }
  const [draft, setDraft] = useState(null)     // editable copy
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
  const num = (key, fallback) => (value) => {
    const n = Number(value)
    const next = Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
    setDraft((prev) => ({ ...prev, [key]: next }))
  }
  const field = (key) => (value) => setDraft((prev) => ({ ...prev, [key]: value }))

  const save = async () => {
    setBusy(true); setStatus(null)
    try {
      const fileBackends = (loaded.fileSettings && loaded.fileSettings.backends) || {}
      const payload = { version: 2, backends: { ...fileBackends, 'claude-code': draft } }
      const data = await api('/dsh-capability-optimizer/settings-save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      setLoaded({ ...loaded, effective: data.effective })
      setDraft(JSON.parse(JSON.stringify(data.effective)))
      setStatus({ kind: 'ok', text: t('saved') })
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
      setLoaded({ ...loaded, effective: data.effective })
      setDraft(JSON.parse(JSON.stringify(data.effective)))
      setStatus({ kind: 'ok', text: t('resetDone') })
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
      loaded.fileError ? h('p', { className: 'dco-status err' }, t('fileError')) : null),

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
        h(NumberField, { label: t('timeoutMs'), value: draft.timeoutMs, max: 3600000, onChange: num('timeoutMs', 300000) }),
        h(NumberField, { label: t('maxTurns'), value: draft.maxTurns, max: 200, onChange: num('maxTurns', 8) }),
        h(NumberField, { label: t('maxPanelRoles'), value: draft.maxPanelRoles, max: 32, onChange: num('maxPanelRoles', 4) }),
        h(TextField, { label: t('extraArgs'), value: (draft.extraArgs ?? []).join(' '), placeholder: t('extraArgsPh'), onChange: (v) => setDraft((prev) => ({ ...prev, extraArgs: v.split(/\s+/).filter((x) => x.length > 0) })), mono: true }))),

    h('div', { className: 'dco-card' },
      h('div', { className: 'dco-row' },
        h('h3', { style: { margin: 0 } }, t('rolesTitle')),
        h('span', { className: 'dco-hint' }, t('rolesHint')),
        h('span', { style: { marginLeft: 'auto' } },
          h('button', { className: 'dco-btn', onClick: () => setEditing({ role: { name: '', label: '', description: '', systemPrompt: '', model: '', fallbackModel: '', enabled: true }, isNew: true }) }, `+ ${t('addRole')}`))),
      h('div', { className: 'dco-roles' },
        draft.roles.map((role, index) => h('div', { className: 'dco-role', key: role.name || index },
          h('div', { className: 'dco-role-top' },
            h('span', { className: `dco-dot${role.enabled === false ? ' off' : ''}` }),
            h('span', { className: 'dco-role-name' }, role.name),
            role.label ? h('span', { style: { fontSize: '12px', opacity: .7 } }, role.label) : null,
            BUILTIN_NAMES.has(role.name) ? h('span', { className: 'dco-pill tag' }, t('builtin')) : h('span', { className: 'dco-pill' }, t('custom')),
            role.model ? h('span', { className: 'dco-pill' }, `${t('roleModelPill')}: ${role.model}`) : null,
            role.fallbackModel ? h('span', { className: 'dco-pill' }, `${t('roleFallbackPill')}: ${role.fallbackModel}`) : null,
            role.effort ? h('span', { className: 'dco-pill tag' }, `${t('effort')}: ${role.effort}`) : null,
            h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' } },
              h(Switch, { on: role.enabled !== false, title: t('enabled'), onToggle: () => setRole(index, { enabled: role.enabled === false }) }),
              h('button', { className: 'dco-btn', onClick: () => setEditing({ role, isNew: false }) }, t('editRole')),
              h('button', { className: 'dco-btn danger', onClick: () => { if (window.confirm(t('confirmDelete'))) setDraft((prev) => ({ ...prev, roles: prev.roles.filter((_, i) => i !== index) })) } }, t('delete')))),
          h('div', { className: 'dco-role-desc' }, role.description ?? ''))))),

    h(TestPanel, { t, roles: draft.roles }),

    h('div', { className: 'dco-row' },
      h('button', { className: 'dco-btn primary', disabled: !dirty || busy, onClick: save }, busy ? t('saving') : t('save')),
      h('button', { className: 'dco-btn danger', disabled: busy, onClick: reset }, t('reset')),
      dirty && !busy ? h('span', { className: 'dco-hint' }, `· ${t('dirtyHint')}`) : null,
      status ? h('span', { className: `dco-status ${status.kind}` }, status.text) : null),

    editing !== null && h(RoleEditor, {
      role: editing.role, isNew: editing.isNew, t, models: loaded.models,
      onClose: () => setEditing(null),
      onSave: (role) => {
        const index = editing.isNew ? draft.roles.length : draft.roles.indexOf(editing.role)
        const roles = [...draft.roles]
        roles[editing.isNew ? roles.length : Math.max(0, index)] = role
        setDraft((prev) => ({ ...prev, roles }))
        setEditing(null)
      },
    })))
}

exports.name = 'dsh-capability-optimizer'
// 'slots' and 'locale' are safe to require: ui-layout (mandatory in every web
// composition) already hard-depends on them.
exports.inject = ['slots', 'locale']
exports.apply = function apply(ctx) {
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
}

return module.exports
}})
