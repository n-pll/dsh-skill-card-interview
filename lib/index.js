/**
 * dsh-skill-card-interview —— 让「访谈 / 决策」类 skill 一律用 ask_user_question 卡片提问。
 *
 * 形态：host 层 Cordis 插件，向 ctx.skills 注册一个**包装型** provider：
 *   - list() 为配置里的每个 skill 返回一个候选项，rank 默认 590
 *     （随包来源是 600、user-dsh 400、user-agents 500、custom 300、
 *      project-dsh 100、project-agents 200；rank 越小越优先，因此 590
 *      **只覆盖随包来源**，项目级与用户级覆盖仍然优先）。
 *   - get() 每次加载时现读上游 SKILL.md，把正文原样附上「卡片提问覆盖层」。
 *
 * 于是：不改上游包、不被上游更新覆盖（正文永远取自上游最新文件）、
 * 也不需要每次会话口头说明。
 *
 * 铁律：本插件的任何异常都不得影响别的 skill —— provider 抛错会被注册表整条跳过，
 * 所以 list()/get() 内部全部兜底，读不到就跳过该 skill，绝不抛。
 *
 * @module dsh-skill-card-interview
 */
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名（同时用作 provider 名）。 */
export const name = 'skill-card-interview'
/** 本插件只依赖 skills 注册表。 */
export const inject = ['skills']

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const CONFIG_PATH = join(PLUGIN_DIR, 'config.json')
const DEFAULT_OVERLAY_PATH = join(PLUGIN_DIR, 'lib', 'overlay-zh.md')
/** 只压过随包来源（600），保留 user 400/500、custom 300、project 100/200 的优先权。 */
const DEFAULT_RANK = 590
const PROVIDER_NAME = 'skill-card-interview'
const DEFAULT_SOURCE = 'custom'

/** 剥掉成对引号，与 DSH 的 frontmatter 读法保持一致。 */
function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * 解析 SKILL.md 的 YAML frontmatter：只认本插件需要的标量字段，
 * 支持折叠标量（`description: >` 加缩进续行），与上游 provider 的读法一致。
 * @param text - SKILL.md 全文。
 * @returns 元数据对象与正文；没有闭合 frontmatter 时返回 undefined。
 */
export function splitFrontmatter(text) {
  if (!text.startsWith('---')) return undefined
  const normalized = text.replace(/\r\n/g, '\n')
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return undefined
  const block = normalized.slice(3, end)
  const body = normalized.slice(end + 4).replace(/^\n+/, '')
  const data = {}
  let currentKey = null
  let folded = false
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd()
    if (/^[ \t]/.test(line) && currentKey !== null) {
      const value = line.trim()
      if (value) data[currentKey] = folded ? (data[currentKey] + ' ' + value).trim() : (data[currentKey] + '\n' + value).trim()
      continue
    }
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!match) {
      currentKey = null
      folded = false
      continue
    }
    let value = match[2].trim()
    folded = value === '>' || value === '>-' || value === '>+'
    if (folded) value = ''
    else value = unquote(value)
    data[match[1]] = value
    currentKey = folded ? match[1] : null
  }
  return { data, body }
}

/** 上游 `disable-model-invocation: true` / `user-invocable: false` 的调用策略映射。 */
function invocationFrom(data) {
  return {
    modelInvocable: data['disable-model-invocation'] !== 'true',
    userInvocable: data['user-invocable'] !== 'false',
  }
}

/** DSH_HOME（缺省 ~/.dsh）下 profiles 的 node_modules 候选目录：共享目录加各 profile。 */
async function profileNodeModulesDirs() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const profiles = join(home, 'profiles')
  const dirs = [join(profiles, 'node_modules')]
  try {
    for (const entry of await readdir(profiles, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(profiles, entry.name, 'node_modules'))
    }
  } catch {
    /* profiles 不存在时只用共享目录 */
  }
  return dirs
}

/** 扫描一个 skill 根目录，返回含 SKILL.md 的子目录名。 */
async function listSkillNames(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const names = []
    for (const entry of entries) {
      if (entry.isDirectory() && existsSync(join(root, entry.name, 'SKILL.md'))) names.push(entry.name)
    }
    return names.sort()
  } catch {
    return []
  }
}

/** 把一条 source 配置解析成 root / skills / overlay；找不到根目录时返回 undefined。 */
async function resolveSource(source, fallbackOverlay) {
  const overlay = typeof source.overlay === 'string' && source.overlay.length > 0 ? source.overlay : fallbackOverlay
  if (typeof source.root === 'string' && source.root.length > 0) {
    const root = isAbsolute(source.root) ? source.root : resolve(PLUGIN_DIR, source.root)
    if (!existsSync(root)) return undefined
    return { root, skills: source.skills ?? (await listSkillNames(root)), overlay }
  }
  if (typeof source.package === 'string' && source.package.length > 0) {
    for (const base of await profileNodeModulesDirs()) {
      const root = join(base, source.package, 'skills')
      if (existsSync(root)) return { root, skills: source.skills ?? (await listSkillNames(root)), overlay }
    }
  }
  return undefined
}

/** 读取覆盖层文本。 */
function readOverlayFile(file) {
  try {
    return readFileSync(file, 'utf8').trimEnd()
  } catch {
    return ''
  }
}

/**
 * 解析配置（config.json 加调用方覆盖），并把 sources 落到真实目录。
 * @param overrides - 覆盖 config.json 的字段。
 * @returns 归一化配置。
 */
export async function resolveConfig(overrides = {}) {
  let fileConfig = {}
  try {
    fileConfig = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
  } catch {
    fileConfig = {}
  }
  const config = { ...fileConfig, ...overrides }
  let fallbackOverlay = typeof config.overlay === 'string' ? config.overlay : ''
  if (fallbackOverlay === '') {
    const overlayFile = typeof config.overlayFile === 'string' && config.overlayFile.length > 0
      ? (isAbsolute(config.overlayFile) ? config.overlayFile : join(PLUGIN_DIR, config.overlayFile))
      : DEFAULT_OVERLAY_PATH
    fallbackOverlay = readOverlayFile(overlayFile)
  }
  const resolved = []
  for (const source of Array.isArray(config.sources) ? config.sources : []) {
    const hit = await resolveSource(source, fallbackOverlay)
    if (hit !== undefined && hit.skills.length > 0) resolved.push(hit)
  }
  return {
    rank: Number.isFinite(config.rank) ? config.rank : DEFAULT_RANK,
    source: typeof config.source === 'string' ? config.source : DEFAULT_SOURCE,
    overrideDescription: typeof config.overrideDescription === 'string' ? config.overrideDescription : undefined,
    resolved,
  }
}

/**
 * 建立包装型 provider。注册表每次加载都重新调用 get()，
 * 因此上游正文更新后无需失效缓存即可生效。
 * @param overrides - 测试或调用方对配置的覆盖。
 * @returns ctx.skills 的 provider。
 */
export function createProvider(overrides = {}) {
  let configPromise
  const loadConfig = () => (configPromise ??= resolveConfig(overrides))
  return {
    name: PROVIDER_NAME,
    async list() {
      const config = await loadConfig()
      const candidates = []
      for (const { root, skills, overlay } of config.resolved) {
        for (const skill of skills) {
          const dir = join(root, skill)
          const file = join(dir, 'SKILL.md')
          let parsed
          try {
            parsed = splitFrontmatter(await readFile(file, 'utf8'))
          } catch {
            continue
          }
          if (parsed === undefined) continue
          const description = config.overrideDescription ?? parsed.data.description
          if (typeof description !== 'string' || description.length === 0) continue
          candidates.push({
            name: parsed.data.name ?? skill,
            description,
            ...(parsed.data.whenToUse !== undefined ? { whenToUse: parsed.data.whenToUse } : {}),
            invocation: invocationFrom(parsed.data),
            source: config.source,
            provider: PROVIDER_NAME,
            rank: config.rank,
            locator: dir,
            path: file,
            overlay,
          })
        }
      }
      return candidates
    },
    async get(candidate) {
      let raw
      try {
        raw = await readFile(candidate.path, 'utf8')
      } catch {
        return undefined
      }
      const parsed = splitFrontmatter(raw)
      if (parsed === undefined) return undefined
      const config = await loadConfig()
      const overlay = typeof candidate.overlay === 'string' ? candidate.overlay : ''
      const body = parsed.body.trimEnd()
      return {
        name: parsed.data.name ?? candidate.name,
        description: config.overrideDescription ?? parsed.data.description,
        ...(parsed.data.whenToUse !== undefined ? { whenToUse: parsed.data.whenToUse } : {}),
        invocation: invocationFrom(parsed.data),
        source: config.source,
        provider: PROVIDER_NAME,
        resourceBase: { kind: 'directory', path: candidate.locator },
        path: candidate.path,
        content: overlay.length > 0 ? body + '\n\n---\n\n' + overlay + '\n' : body + '\n',
      }
    },
  }
}

/** 注册 provider；工厂是同步的，配置在首次 list/get 时惰性解析。 */
export function apply(ctx) {
  ctx.skills.registerProvider(() => createProvider())
}
