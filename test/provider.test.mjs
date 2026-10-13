import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

import { createProvider, resolveConfig, splitFrontmatter } from '../lib/index.js'

const fixtureRoot = mkdtempSync(join(tmpdir(), 'card-interview-'))
after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

/**
 * Create one fixture skill whose body may be re-read after the fact.
 * @param name - Skill directory and frontmatter name.
 * @param body - Markdown body after the frontmatter.
 * @param extra - Extra frontmatter lines.
 * @returns Absolute path of the SKILL.md.
 */
function fixture(name, body, extra = []) {
  const dir = join(fixtureRoot, name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, ['---', 'name: ' + name, 'description: 测试用技能', ...extra, '---', '', body, ''].join('\n'))
  return file
}

const overlay = '## 卡片提问（测试覆盖层）'

test('splitFrontmatter 读取标量、引号与折叠标量', () => {
  const parsed = splitFrontmatter(['---', 'name: x', 'description: >', '  第一段', '  第二段', 'disable-model-invocation: true', '---', '', '正文'].join('\n'))
  assert.equal(parsed.data.name, 'x')
  assert.equal(parsed.data.description, '第一段 第二段')
  assert.equal(parsed.data['disable-model-invocation'], 'true')
  assert.equal(parsed.body, '正文')
})

test('list() 只在配置的名单内返回候选，且带上覆盖层', async () => {
  fixture('zh-grilling', '原始正文')
  fixture('zh-grill-with-docs', '运行一次 /zh-grilling。')
  fixture('zh-not-listed', '不该出现')
  const provider = createProvider({
    rank: 590,
    source: 'custom',
    overlay,
    sources: [{ root: fixtureRoot, skills: ['zh-grilling', 'zh-grill-with-docs', 'zh-missing'] }],
  })
  const candidates = await provider.list()
  assert.deepEqual(candidates.map((candidate) => candidate.name).sort(), ['zh-grill-with-docs', 'zh-grilling'])
  assert.equal(candidates[0].rank, 590)
  assert.equal(candidates[0].provider, 'skill-card-interview')
  assert.equal(candidates[0].source, 'custom')
})

test('get() 返回上游正文加覆盖层，并保留 resourceBase', async () => {
  fixture('zh-grilling', '原始正文')
  const provider = createProvider({
    rank: 590,
    overlay,
    sources: [{ root: fixtureRoot, skills: ['zh-grilling'] }],
  })
  const [candidate] = await provider.list()
  const skill = await provider.get(candidate)
  assert.equal(skill.name, 'zh-grilling')
  assert.ok(skill.content.includes('原始正文'))
  assert.ok(skill.content.includes(overlay))
  assert.ok(skill.content.indexOf('原始正文') < skill.content.indexOf(overlay))
  assert.deepEqual(skill.resourceBase, { kind: 'directory', path: join(fixtureRoot, 'zh-grilling') })
})

test('get() 每次重新读取上游正文——上游更新后无需失效缓存', async () => {
  const file = fixture('zh-grill-me', '第一版')
  const provider = createProvider({ rank: 590, overlay, sources: [{ root: fixtureRoot, skills: ['zh-grill-me'] }] })
  const [candidate] = await provider.list()
  assert.ok((await provider.get(candidate)).content.includes('第一版'))
  writeFileSync(file, ['---', 'name: zh-grill-me', 'description: 测试用技能', '---', '', '第二版', ''].join('\n'))
  assert.ok((await provider.get(candidate)).content.includes('第二版'))
})

test('调用策略随上游 frontmatter 走', async () => {
  fixture('zh-wait-what', '正文', ['disable-model-invocation: true'])
  const provider = createProvider({ rank: 590, overlay, sources: [{ root: fixtureRoot, skills: ['zh-wait-what'] }] })
  const [candidate] = await provider.list()
  assert.equal(candidate.invocation.modelInvocable, false)
  assert.equal((await provider.get(candidate)).invocation.modelInvocable, false)
})

test('根目录不存在时安静返回空列表，不抛错', async () => {
  const provider = createProvider({ rank: 590, overlay, sources: [{ root: join(fixtureRoot, 'does-not-exist'), skills: ['zh-grilling'] }] })
  assert.deepEqual(await provider.list(), [])
})

test('resolveConfig 在源缺失时给出空 resolved', async () => {
  const config = await resolveConfig({ sources: [{ root: join(fixtureRoot, 'nope') }] })
  assert.deepEqual(config.resolved, [])
  assert.equal(config.rank, 590)
})
