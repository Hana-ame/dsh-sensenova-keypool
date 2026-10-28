/**
 * SenseNova model catalog and the key-alias grammar.
 *
 * The catalog is the built-in snapshot; the plugin's settings panel can
 * replace it (models written into `settings.json`, refreshed from upstream
 * `GET /v1/models`), so consumers always pass the settings-owned list through
 * `catalogRows(provider, models)` / `resolveModelInfo(provider, model, models)`.
 *
 * Context windows and output ceilings follow the profile-wide preference
 * (1M context / 384K output, kept consistent with the other key-pool routes).
 * `sensenova-6.8-flash-lite` is the only upstream model that declares image
 * input; its chat route answered `404 model route not found` on 2026-10-27
 * (still listed in /models), so image requests will fail until upstream
 * restores that route. `sensenova-6.7-flash-lite` is not in the upstream list.
 *
 * The `@k<N>` suffix is the manual key selector:
 *   sensenova-6.8-flash-lite@k2 → model sensenova-6.8-flash-lite, key k2
 *   sensenova-6.8-flash-lite    → model sensenova-6.8-flash-lite, session key
 *
 * @module src/catalog
 */

/** Provider route published by this plugin. */
export const ROUTE = 'sensenova-pool'

/** Display label used by the model picker. */
export const ROUTE_LABEL = 'SenseNova · Key Pool'

/** Default model when a caller omits one. */
export const DEFAULT_MODEL = 'deepseek-v4-flash'

/** Default context window for an unknown model id. */
export const DEFAULT_CONTEXT_WINDOW = 1_048_576

/** Default output ceiling for an unknown model id. */
export const DEFAULT_MAX_OUTPUT = 384_000

/**
 * Models advertised by the route when `settings.json` carries no `models`
 * list. Values follow the profile-wide 1M/384K preference.
 */
export const MODELS = Object.freeze([
  Object.freeze({
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash (SenseNova)',
    description: 'DeepSeek V4 Flash, 1M context / 384K output, tools + reasoning',
    contextWindow: 1_048_576,
    maxOutput: 384_000,
    reasoning: true,
    inputModalities: Object.freeze(['text']),
  }),
  Object.freeze({
    id: 'glm-5.2',
    name: 'GLM-5.2 (SenseNova)',
    description: 'GLM-5.2 flagship, 1M context / 384K output, tools + reasoning',
    contextWindow: 1_048_576,
    maxOutput: 384_000,
    reasoning: true,
    inputModalities: Object.freeze(['text']),
  }),
  Object.freeze({
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash (SenseNova)',
    description: 'DeepSeek V4.1 Flash, 1M context / 384K output, tools + reasoning',
    contextWindow: 1_048_576,
    maxOutput: 384_000,
    reasoning: true,
    inputModalities: Object.freeze(['text']),
  }),
  Object.freeze({
    id: 'deepseek-flash',
    name: 'DeepSeek Flash (SenseNova)',
    description: 'DeepSeek Flash, 1M context / 384K output, tools + reasoning',
    contextWindow: 1_048_576,
    maxOutput: 384_000,
    reasoning: true,
    inputModalities: Object.freeze(['text']),
  }),
  Object.freeze({
    id: 'kimi-k3',
    name: 'Kimi K3 (SenseNova)',
    description: 'Kimi K3, 1M context / 384K output, tools + reasoning',
    contextWindow: 1_048_576,
    maxOutput: 384_000,
    reasoning: true,
    inputModalities: Object.freeze(['text']),
  }),
  Object.freeze({
    id: 'sensenova-6.8-flash-lite',
    name: 'SenseNova 6.8 Flash Lite',
    description: 'SenseNova 6.8 Flash Lite, image-capable (chat route 404 as of 2026-10-27)',
    contextWindow: 1_048_576,
    maxOutput: 384_000,
    reasoning: true,
    inputModalities: Object.freeze(['text', 'image']),
  }),
])

/** Look up a catalog row by base model id. */
export function findModel(id, models = MODELS) {
  return models.find(row => row.id === id) ?? null
}

/**
 * Split a model id into its base id and optional key alias.
 *
 * The alias is everything after the last `@`. Empty or absent means "no
 * explicit key": the session's assigned key is used.
 *
 * @param {string} model
 * @returns {{modelId: string, alias: string | null}}
 */
export function parseModelId(model) {
  const text = String(model ?? '')
  const at = text.lastIndexOf('@')
  if (at < 0) return { modelId: text, alias: null }
  const modelId = text.slice(0, at)
  const alias = text.slice(at + 1)
  return { modelId, alias: alias === '' ? null : alias }
}

/** Whether a string looks like a key alias (`k1`, `work`, ...). */
export function isKeyAlias(value) {
  const text = String(value ?? '').trim()
  // Aliases are user-facing names (often Chinese, e.g. 主号/备用). Keep them
  // permissive: non-empty, <=64 chars, no `@` (the model-id key suffix
  // separator) and no control characters.
  return text.length > 0 && text.length <= 64 && !text.includes('@') && !/[\r\n\t]/.test(text)
}

/** Mask a secret for logs/status: first 4 and last 4 characters. */
export function maskKey(key) {
  const text = String(key ?? '')
  if (text === '') return '(empty)'
  if (text.length <= 10) return `${text.slice(0, 2)}…${text.slice(-2)}`
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}

/**
 * Build the picker catalog.
 *
 * Every model appears once. Key aliases are deliberately not expanded into
 * `model · key k2` rows: keys are managed on the Settings page and selected by
 * the session store, not by the model picker.
 *
 * @param {string} provider
 * @param {object[]} [models] - settings-owned model list; defaults to MODELS.
 * @returns {object[]}
 */
export function catalogRows(provider, models = MODELS) {
  return models.map(model => ({
    provider,
    id: model.id,
    name: model.name,
    description: model.description,
    inputModalities: [...(model.inputModalities ?? ['text'])],
  }))
}

/**
 * Resolve exact model metadata for one model id (alias included).
 *
 * Unknown ids still return a usable shape: the harness accepts unlisted model
 * ids and a user may know a newer SenseNova id before this catalog does.
 *
 * @param {string} provider
 * @param {string} model
 * @param {object[]} [models] - settings-owned model list; defaults to MODELS.
 * @returns {object}
 */
export function resolveModelInfo(provider, model, models = MODELS) {
  const { modelId, alias } = parseModelId(model)
  const known = findModel(modelId, models)
  const base = known ?? {
    id: modelId,
    name: modelId,
    description: 'unlisted SenseNova model id',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutput: DEFAULT_MAX_OUTPUT,
    reasoning: false,
    inputModalities: ['text'],
  }
  return {
    provider,
    id: model,
    name: alias === null ? base.name : `${base.name} · ${alias}`,
    description: base.description,
    inputModalities: [...(base.inputModalities ?? ['text'])],
    context: { contextWindow: base.contextWindow },
    defaultMaxTokens: base.maxOutput,
  }
}
