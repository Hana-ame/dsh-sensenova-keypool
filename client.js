/**
 * dsh-sensenova-keypool — browser half.
 *
 * Adds one top-level Settings section ("SenseNova Key Pool") where the key
 * list can be entered, replaced and removed. Secrets travel only from this
 * form to the loopback admin route; GET /config returns aliases and masked
 * values, never the key itself.
 *
 * Hand-written ModuleLoader bundle: React is supplied by the shell, and there
 * is no build step.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sensenova-keypool',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect } = React

    const NS = 'settings.sensenovaKeyPool'
    const API = '/api/sensenova-keypool/admin'
    const inject = ['slots', 'locale']

    const DICT = {
      zh: {
        nav: 'SenseNova 密钥池',
        title: 'SenseNova 密钥池',
        subtitle: '在这里填入一个或多个 SenseNova API Key。每个 session 固定使用一个 key；保存后右下角的模型选择器会刷新。',
        modelSection: '模型与上下文',
        modelHint: '当前模型清单：逐项编辑模型 id、名称、上下文窗口、最大输出和文字/图片能力。保存只写这份清单，不会自动同步或切换模型。',
        defaultModel: '默认模型',
        modelId: '模型 id',
        modelName: '名称',
        contextWindow: '上下文窗口',
        maxOutput: '最大输出',
        modalityText: '文字',
        modalityImage: '图片',
        addModel: '添加模型',
        saveModels: '保存模型与上下文',
        saveAll: '保存全部设置',
        saveAllHint: '保存会写入当前 key、模型与上下文、重试配置；不会自动同步上游。',
        modelEmpty: '还没有模型行。',
        modelInvalid: '至少需要保留一个模型。',
        defaultModelInvalid: '默认模型必须存在于模型列表中。',
        keys: 'API Key',
        keysHint: '带“留空保留”的条目不会改掉已有 key；新增条目填别名和 key 即可。',
        alias: '别名',
        key: '密钥',
        masked: '当前',
        existingPlaceholder: '留空保留现有 key',
        newPlaceholder: 'sk-...',
        add: '添加一个 key',
        remove: '移除',
        enable: '启用',
        disable: '禁用',
        disabled: '已禁用',
        mode: '分配方式',
        modeAuto: '自动轮转（每个新 session 顺延）',
        modeManual: '手动默认（新 session 用下面的 key）',
        defaultKey: '默认 key',
        save: '保存',
        saving: '保存中…',
        saved: '已保存。右下角模型选择器稍后会自动刷新。',
        loadFailed: '读取配置失败',
        saveFailed: '保存失败',
        retry: '重试',
        loading: '正在读取…',
        pool: '当前池子',
        poolSize: '可用 key 数',
        empty: '还没有配置 key。添加一个后保存。',
        noSelection: '保存后到右下角的模型选择器里选 SenseNova · Key Pool。模型列表不再展开 key 别名；key 由 session 固定分配，手动默认在“分配方式”里设置。',
        retrySection: '重试',
        retryHint: '只对勾选的错误码重试；始终复用当前 session 已经固定的 key，不会切换到池子里的其他 key。',
        maxRetries: '最大重试次数',
        retryBaseDelayMs: '初始退避 (ms)',
        retryMaxDelayMs: '最大退避 (ms)',
        retryCodes: '重试范围',
        retryCodesHint: '429 的 RATE_LIMIT 默认勾选；包括 tpm exhausted / quota_exceeded_error。',
        retryCodesRequired: '至少选择一个重试错误码。',
        codeRateLimit: 'RATE_LIMIT — 429 限流 / TPM 用尽',
        codeTimeout: 'TIMEOUT — 408 / 504 / 请求超时',
        codeServer: 'SERVER — 5xx 上游错误',
        codeTransport: 'TRANSPORT — 网络 / 连接失败',
        route: '路由',
        settingsPath: '配置文件',
      },
      en: {
        nav: 'SenseNova Key Pool',
        title: 'SenseNova Key Pool',
        subtitle: 'Enter one or more SenseNova API keys. Each session is pinned to one key; saving refreshes the model picker at the bottom-right.',
        modelSection: 'Models & context',
        modelHint: 'Current model list: edit each id, name, context window, max output and text/image capability. Save only writes this list; it never syncs upstream or switches the model.',
        defaultModel: 'Default model',
        modelId: 'Model id',
        modelName: 'Name',
        contextWindow: 'Context window',
        maxOutput: 'Max output',
        modalityText: 'Text',
        modalityImage: 'Image',
        addModel: 'Add a model',
        saveModels: 'Save models & context',
        saveAll: 'Save all settings',
        saveAllHint: 'Saves the current keys, model/context list and retry policy; it never syncs upstream.',
        modelEmpty: 'No model rows yet.',
        modelInvalid: 'Keep at least one model.',
        defaultModelInvalid: 'The default model must exist in the model list.',
        keys: 'API keys',
        keysHint: 'Rows with “leave blank to keep” preserve the existing secret. Add an alias and a key for a new entry.',
        alias: 'Alias',
        key: 'Secret',
        masked: 'Current',
        existingPlaceholder: 'Leave blank to keep the current key',
        newPlaceholder: 'sk-...',
        add: 'Add a key',
        remove: 'Remove',
        enable: 'Enable',
        disable: 'Disable',
        disabled: 'Disabled',
        mode: 'Assignment',
        modeAuto: 'Automatic round-robin (new session takes the next key)',
        modeManual: 'Manual default (new sessions use the key below)',
        defaultKey: 'Default key',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved. The model picker at the bottom-right will refresh shortly.',
        loadFailed: 'Could not load the configuration',
        saveFailed: 'Could not save',
        retry: 'Retry',
        loading: 'Loading…',
        pool: 'Current pool',
        poolSize: 'Available keys',
        empty: 'No keys configured yet. Add one and save.',
        noSelection: 'After saving, open the model picker at the bottom-right and choose SenseNova · Key Pool. Key aliases are no longer expanded into model rows; the session store assigns one key, with manual default set above.',
        retrySection: 'Retry',
        retryHint: 'Only the checked failure codes are retried. Every retry reuses the key already pinned to this session and never consumes another pool key.',
        maxRetries: 'Maximum retries',
        retryBaseDelayMs: 'Initial backoff (ms)',
        retryMaxDelayMs: 'Maximum backoff (ms)',
        retryCodes: 'Retry scope',
        retryCodesHint: 'RATE_LIMIT is checked by default and covers 429 tpm exhausted / quota_exceeded_error.',
        retryCodesRequired: 'Select at least one retry code.',
        codeRateLimit: 'RATE_LIMIT — 429 rate limit / TPM exhausted',
        codeTimeout: 'TIMEOUT — 408 / 504 / request timeout',
        codeServer: 'SERVER — 5xx upstream failure',
        codeTransport: 'TRANSPORT — network / connection failure',
        route: 'Route',
        settingsPath: 'Settings file',
      },
    }

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        maxWidth: '860px',
        fontSize: '13px',
        lineHeight: '1.55',
        color: 'var(--dsw-alias-label-primary, #e8e8e8)',
      },
      hero: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '18px 20px',
        border: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
        borderRadius: '16px',
        background: 'var(--dsw-alias-bg-layer-3, #242424)',
      },
      h2: { margin: 0, fontSize: '20px', fontWeight: 700, letterSpacing: '-0.3px' },
      subtitle: { margin: 0, color: 'var(--dsw-alias-label-secondary, #a8a8a8)' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '16px',
        border: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
        borderRadius: '14px',
        background: 'var(--dsw-alias-bg-layer-3, #242424)',
      },
      sectionTitle: { margin: 0, fontSize: '14px', fontWeight: 650 },
      hint: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)' },
      row: {
        display: 'grid',
        gridTemplateColumns: '110px minmax(150px, 1fr) auto auto',
        gap: '8px',
        alignItems: 'center',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
        background: 'var(--dsw-alias-bg-layer-1, #1a1a1a)',
        color: 'var(--dsw-alias-label-primary, #e8e8e8)',
        font: 'inherit',
      },
      button: {
        padding: '7px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
        background: 'var(--dsw-alias-bg-layer-2, #2e2e2e)',
        color: 'var(--dsw-alias-label-primary, #e8e8e8)',
        font: 'inherit',
        cursor: 'pointer',
      },
      primary: {
        padding: '8px 16px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-state-business-primary, #4f8cff)',
        background: 'var(--dsw-alias-state-business-primary, #4f8cff)',
        color: '#fff',
        font: 'inherit',
        fontWeight: 600,
        cursor: 'pointer',
      },
      danger: {
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, #333)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary, #ff6b6b)',
        font: 'inherit',
        cursor: 'pointer',
      },
      meta: { display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)' },
      error: { color: 'var(--dsw-alias-state-error-primary, #ff6b6b)', margin: 0 },
      notice: { color: 'var(--dsw-alias-state-success-primary, #57c785)', margin: 0 },
      footer: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' },
      retryGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      codeGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px' },
      modelItem: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '9px 0',
        borderTop: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
      },
      modelRow: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr) auto',
        gap: '8px',
        alignItems: 'end',
      },
      modelRow2: {
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        gap: '8px',
        alignItems: 'end',
      },
      modelField: {
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        minWidth: 0,
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #a8a8a8)',
      },
      check: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #a8a8a8)' },
      masked: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #888)' },
      select: {
        width: '100%',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
        background: 'var(--dsw-alias-bg-layer-1, #1a1a1a)',
        color: 'var(--dsw-alias-label-primary, #e8e8e8)',
        font: 'inherit',
      },
    }

    function nextAlias(rows) {
      const used = new Set(rows.map(row => row.alias))
      for (let i = 1; i < 1000; i += 1) {
        if (!used.has(`k${i}`)) return `k${i}`
      }
      return `k${rows.length + 1}`
    }

    function normalizeRows(config) {
      return (config?.keys ?? []).map(key => ({
        alias: String(key.alias ?? ''),
        originalAlias: String(key.alias ?? ''),
        masked: String(key.masked ?? ''),
        key: '',
        existing: true,
        enabled: key.enabled !== false,
      }))
    }

    function Page(props) {
      const t = props.t ?? (x => x)
      const [config, setConfig] = useState(null)
      const [rows, setRows] = useState([])
      const [mode, setMode] = useState('auto')
      const [defaultKey, setDefaultKey] = useState('k1')
      const [defaultModel, setDefaultModel] = useState('')
      const [models, setModels] = useState([])
      const [maxRetries, setMaxRetries] = useState(3000)
      const [retryBaseDelayMs, setRetryBaseDelayMs] = useState(1000)
      const [retryMaxDelayMs, setRetryMaxDelayMs] = useState(6000)
      const [retryableCodes, setRetryableCodes] = useState([])
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')

      const applyConfig = payload => {
        setConfig(payload)
        setRows(normalizeRows(payload))
        setMode(payload.mode === 'manual' ? 'manual' : 'auto')
        setDefaultKey(String(payload.defaultKey ?? payload.keys?.[0]?.alias ?? 'k1'))
        setDefaultModel(String(payload.defaultModel ?? payload.models?.[0]?.id ?? ''))
        setModels((Array.isArray(payload.models) ? payload.models : []).map(model => ({
          id: String(model.id ?? ''),
          name: String(model.name ?? ''),
          description: String(model.description ?? ''),
          contextWindow: Number(model.contextWindow) || 1048576,
          maxOutput: Number(model.maxOutput) || 384000,
          reasoning: model.reasoning !== false,
          inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities : ['text'],
        })))
        setMaxRetries(Number.isInteger(payload.maxRetries) ? payload.maxRetries : 3000)
        setRetryBaseDelayMs(Number.isInteger(payload.retryBaseDelayMs) ? payload.retryBaseDelayMs : 1000)
        setRetryMaxDelayMs(Number.isInteger(payload.retryMaxDelayMs) ? payload.retryMaxDelayMs : 6000)
        setRetryableCodes(Array.isArray(payload.retryableCodes) && payload.retryableCodes.length > 0
          ? payload.retryableCodes
          : ['RATE_LIMIT', 'TIMEOUT', 'SERVER', 'TRANSPORT'])
      }

      const load = async () => {
        setError('')
        try {
          const response = await fetch(`${API}/config`, { headers: { accept: 'application/json' } })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
          applyConfig(payload)
        } catch (loadError) {
          setError(String(loadError?.message ?? loadError))
        }
      }

      useEffect(() => { void load() }, [])

      const updateRow = (index, patch) => {
        setRows(current => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
      }

      const addRow = () => {
        setRows(current => [...current, { alias: nextAlias(current), originalAlias: '', masked: '', key: '', existing: false, enabled: true }])
      }

      const removeRow = index => {
        setRows(current => current.filter((_, i) => i !== index))
      }

      const toggleRow = index => {
        setRows(current => current.map((row, i) => (i === index ? { ...row, enabled: row.enabled === false } : row)))
      }

      const updateModel = (index, patch) => {
        setModels(current => current.map((model, i) => (i === index ? { ...model, ...patch } : model)))
      }

      const addModel = () => {
        setModels(current => [...current, {
          id: '',
          name: '',
          description: '',
          contextWindow: 1048576,
          maxOutput: 384000,
          reasoning: true,
          inputModalities: ['text'],
        }])
      }

      const removeModel = index => {
        setModels(current => current.filter((_, i) => i !== index))
      }

      const toggleModelModality = (index, modality) => {
        setModels(current => current.map((model, i) => {
          if (i !== index) return model
          const inputModalities = model.inputModalities.includes(modality)
            ? model.inputModalities.filter(entry => entry !== modality)
            : [...model.inputModalities, modality]
          return { ...model, inputModalities: inputModalities.includes('text') ? inputModalities : ['text', ...inputModalities] }
        }))
      }

      const save = async () => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          if (retryableCodes.length === 0) throw new Error(t('retryCodesRequired'))
          const modelRows = models
            .map(model => ({
              id: String(model.id ?? '').trim(),
              name: String(model.name ?? '').trim(),
              description: String(model.description ?? ''),
              contextWindow: Number(model.contextWindow),
              maxOutput: Number(model.maxOutput),
              reasoning: model.reasoning !== false,
              inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities : ['text'],
            }))
            .filter(model => model.id !== '')
          if (modelRows.length === 0) throw new Error(t('modelInvalid'))
          if (!modelRows.some(model => model.id === defaultModel)) throw new Error(t('defaultModelInvalid'))
          const keys = rows
            .map(row => ({
              alias: String(row.alias ?? '').trim(),
              originalAlias: String(row.originalAlias ?? '').trim(),
              key: String(row.key ?? '').trim(),
              enabled: row.enabled !== false,
            }))
            .filter(row => row.alias !== '' || row.key !== '')
          const response = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              keys,
              mode,
              defaultKey,
              defaultModel,
              models: modelRows,
              maxRetries: Number(maxRetries),
              retryBaseDelayMs: Number(retryBaseDelayMs),
              retryMaxDelayMs: Number(retryMaxDelayMs),
              retryableCodes,
            }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
          applyConfig(payload)
          setNotice(t('saved'))
        } catch (saveError) {
          setError(String(saveError?.message ?? saveError))
        } finally {
          setBusy(false)
        }
      }

      const toggleCode = code => {
        setRetryableCodes(current => current.includes(code)
          ? current.filter(entry => entry !== code)
          : [...current, code])
      }

      const aliases = rows.filter(row => row.enabled !== false).map(row => row.alias).filter(Boolean)
      const retryCodes = [
        ['RATE_LIMIT', 'codeRateLimit'],
        ['TIMEOUT', 'codeTimeout'],
        ['SERVER', 'codeServer'],
        ['TRANSPORT', 'codeTransport'],
      ]

      return h('div', { style: styles.root },
        h('div', { style: styles.hero },
          h('h2', { style: styles.h2 }, t('title')),
          h('p', { style: styles.subtitle }, t('subtitle')),
          h('div', { style: styles.footer },
            h('button', { type: 'button', style: styles.primary, disabled: busy, onClick: save }, busy ? t('saving') : t('saveAll')),
          ),
        ),
        error !== '' && h('p', { style: styles.error }, error),
        notice !== '' && h('p', { style: styles.notice }, notice),
        config !== null && h('div', { style: styles.meta },
          h('span', null, `${t('route')}: ${config.route ?? 'sensenova-pool'}`),
          h('span', null, `${t('poolSize')}: ${config.poolSize ?? 0}`),
        ),
        h('div', { style: styles.card },
          h('h3', { style: styles.sectionTitle }, t('keys')),
          h('p', { style: styles.hint }, t('keysHint')),
          rows.length === 0
            ? h('p', { style: styles.hint }, t('empty'))
            : rows.map((row, index) => h('div', { key: index, style: { ...styles.row, opacity: row.enabled === false ? 0.55 : 1 } },
                h('input', {
                  style: styles.input,
                  value: row.alias,
                  placeholder: t('alias'),
                  'aria-label': t('alias'),
                  onChange: event => updateRow(index, { alias: event.target.value }),
                }),
                h('div', null,
                  h('input', {
                    style: styles.input,
                    type: 'password',
                    value: row.key,
                    placeholder: row.existing ? t('existingPlaceholder') : t('newPlaceholder'),
                    'aria-label': t('key'),
                    autoComplete: 'new-password',
                    onChange: event => updateRow(index, { key: event.target.value }),
                  }),
                  row.masked !== '' && h('div', { style: styles.masked }, `${t('masked')}: ${row.masked}`),
                ),
                h('button', { type: 'button', style: styles.button, disabled: busy, onClick: () => toggleRow(index) }, row.enabled === false ? t('enable') : t('disable')),
                h('button', { type: 'button', style: styles.danger, disabled: busy, onClick: () => removeRow(index) }, t('remove')),
              )),
          h('div', { style: styles.footer },
            h('button', { type: 'button', style: styles.button, disabled: busy, onClick: addRow }, t('add')),
          ),
        ),
        h('div', { style: styles.card },
          h('h3', { style: styles.sectionTitle }, t('mode')),
          h('select', {
            style: styles.select,
            value: mode,
            'aria-label': t('mode'),
            onChange: event => setMode(event.target.value),
          },
            h('option', { value: 'auto' }, t('modeAuto')),
            h('option', { value: 'manual' }, t('modeManual')),
          ),
          h('label', { style: styles.hint }, t('defaultKey')),
          h('select', {
            style: styles.select,
            value: defaultKey,
            'aria-label': t('defaultKey'),
            onChange: event => setDefaultKey(event.target.value),
          },
            (aliases.length > 0 ? aliases : ['k1']).map(alias => h('option', { key: alias, value: alias }, alias)),
          ),
          h('div', { style: styles.footer },
            h('button', { type: 'button', style: styles.primary, disabled: busy, onClick: save }, busy ? t('saving') : t('save')),
            h('button', { type: 'button', style: styles.button, disabled: busy, onClick: load }, t('retry')),
          ),
          h('p', { style: styles.hint }, t('noSelection')),
        ),
        h('div', { style: styles.card },
          h('h3', { style: styles.sectionTitle }, t('modelSection')),
          h('p', { style: styles.hint }, t('modelHint')),
          h('label', { style: styles.field },
            h('span', { style: styles.hint }, t('defaultModel')),
            h('select', {
              style: styles.select,
              value: defaultModel,
              'aria-label': t('defaultModel'),
              onChange: event => setDefaultModel(event.target.value),
            },
              models.map(model => h('option', { key: model.id, value: model.id }, model.id || '(empty)')),
            ),
          ),
          models.length === 0
            ? h('p', { style: styles.hint }, t('modelEmpty'))
            : models.map((model, index) => h('div', { key: `${model.id || 'model'}-${index}`, style: styles.modelItem },
                h('div', { style: styles.modelRow },
                  h('label', { style: styles.modelField },
                    h('span', null, t('modelId')),
                    h('input', {
                      style: styles.input,
                      value: model.id,
                      placeholder: t('modelId'),
                      onChange: event => updateModel(index, { id: event.target.value }),
                    }),
                  ),
                  h('label', { style: styles.modelField },
                    h('span', null, t('modelName')),
                    h('input', {
                      style: styles.input,
                      value: model.name,
                      placeholder: t('modelName'),
                      onChange: event => updateModel(index, { name: event.target.value }),
                    }),
                  ),
                  h('button', { type: 'button', style: styles.danger, disabled: busy, onClick: () => removeModel(index) }, t('remove')),
                ),
                h('div', { style: styles.modelRow2 },
                  h('label', { style: styles.modelField },
                    h('span', null, t('contextWindow')),
                    h('input', {
                      style: styles.input,
                      type: 'number',
                      min: 1,
                      value: model.contextWindow,
                      onChange: event => updateModel(index, { contextWindow: Number(event.target.value) }),
                    }),
                  ),
                  h('label', { style: styles.modelField },
                    h('span', null, t('maxOutput')),
                    h('input', {
                      style: styles.input,
                      type: 'number',
                      min: 1,
                      value: model.maxOutput,
                      onChange: event => updateModel(index, { maxOutput: Number(event.target.value) }),
                    }),
                  ),
                  h('label', { style: styles.check },
                    h('input', {
                      type: 'checkbox',
                      checked: model.inputModalities.includes('text'),
                      onChange: () => toggleModelModality(index, 'text'),
                    }),
                    t('modalityText'),
                  ),
                  h('label', { style: styles.check },
                    h('input', {
                      type: 'checkbox',
                      checked: model.inputModalities.includes('image'),
                      onChange: () => toggleModelModality(index, 'image'),
                    }),
                    t('modalityImage'),
                  ),
                ),
              )),
          h('div', { style: styles.footer },
            h('button', { type: 'button', style: styles.button, disabled: busy, onClick: addModel }, t('addModel')),
            h('button', { type: 'button', style: styles.primary, disabled: busy, onClick: save }, busy ? t('saving') : t('saveModels')),
          ),
        ),
        h('div', { style: styles.card },
          h('h3', { style: styles.sectionTitle }, t('retrySection')),
          h('p', { style: styles.hint }, t('retryHint')),
          h('div', { style: styles.retryGrid },
            h('label', { style: styles.field },
              h('span', { style: styles.hint }, t('maxRetries')),
              h('input', {
                style: styles.input,
                type: 'number',
                min: 0,
                step: 1,
                value: maxRetries,
                onChange: event => setMaxRetries(Number(event.target.value)),
              }),
            ),
            h('label', { style: styles.field },
              h('span', { style: styles.hint }, t('retryBaseDelayMs')),
              h('input', {
                style: styles.input,
                type: 'number',
                min: 1,
                step: 1,
                value: retryBaseDelayMs,
                onChange: event => setRetryBaseDelayMs(Number(event.target.value)),
              }),
            ),
            h('label', { style: styles.field },
              h('span', { style: styles.hint }, t('retryMaxDelayMs')),
              h('input', {
                style: styles.input,
                type: 'number',
                min: 1,
                step: 1,
                value: retryMaxDelayMs,
                onChange: event => setRetryMaxDelayMs(Number(event.target.value)),
              }),
            ),
          ),
          h('span', { style: styles.hint }, t('retryCodes')),
          h('div', { style: styles.codeGrid },
            retryCodes.map(([code, label]) => h('label', { key: code, style: styles.check },
              h('input', {
                type: 'checkbox',
                checked: retryableCodes.includes(code),
                onChange: () => toggleCode(code),
              }),
              t(label),
            )),
          ),
          h('p', { style: styles.hint }, t('retryCodesHint')),
        ),
        h('div', { style: styles.footer },
          h('button', { type: 'button', style: styles.primary, disabled: busy, onClick: save }, busy ? t('saving') : t('saveAll')),
        ),
        h('p', { style: styles.hint }, t('saveAllHint')),
        config?.settingsPath !== undefined && h('p', { style: styles.masked }, `${t('settingsPath')}: ${config.settingsPath}`),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'sensenova-keypool: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'sensenova-keypool',
        order: 36,
        label: () => t('nav'),
        locale: NS,
      }, props => h(Page, { ...props, t: props.t ?? t })))
    }

    exports.name = 'sensenova-keypool'
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
