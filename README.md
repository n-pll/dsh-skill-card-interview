# dsh-skill-card-interview

> DSH 插件：让**访谈 / 决策类 skill** 一律用 `ask_user_question` **卡片**提问，而不是在正文里写 ❓➡️ 列表。

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的静态插件。默认覆盖中文技能包
`@vinvcn/dsh-mattpocock-skills-zh` 里 14 个访谈/决策类 skill（`/zh-grill-with-docs`、`/zh-grilling`、`/zh-wayfinder` 等）。

## 解决什么问题

上游 Matt Pocock 的技能是**跨 harness** 的纯文本访谈，正文规定用 ❓/➡️ 文本列表提问：

```
❓ **Q1** - **<标题>**：<正文>
➡️ <推荐答案>
```

到了 DSH Web 里就有两个麻烦：**要打字**，而且**要把答案和问题编号对齐**。`ask_user_question` 卡片
本来更合适——选项点一下就行、可以加备注、一张卡按顺序翻页。

但「让模型改用卡片」这件事没法靠一句全局提示稳定做到：技能正文里写死的格式，比系统提示里的一句叮嘱硬。
这个插件的做法是**在技能加载的那一刻，把要求追加成技能正文的一部分**。

## 效果

| | 做法 | 会不会被上游更新覆盖 |
|---|---|---|
| 常规做法 | 直接改 `node_modules` 里的 SKILL.md | **会**，`dsh plugin add/update` 一跑就没了 |
| 软提示 | 往 `AGENTS.md` / `CLAUDE.md` 写一句「提问请用卡片」 | 不会，但跨技能的全局叮嘱，容易被技能正文里的硬格式压过去 |
| 副本 | 把 SKILL.md 复制到 `~/.dsh/skills/` 覆盖同名 | 不会，但正文成了副本，上游更新不再跟随 |
| **本插件** | 注册包装型 provider，每次加载**现读上游正文再拼接** | 不会，且上游更新自动跟随 |

## 安装

```sh
dsh plugin --profile web add github:n-pll/dsh-skill-card-interview
```

开发时用本地目录：

```sh
dsh plugin --profile web add link:/path/to/dsh-skill-card-interview
```

确认已进组合层（在线 profile 会就地重组，无需重启）：

```sh
dsh --profile web --dump-config | grep 'id: skill-card-interview'
```

卸载：

```sh
dsh plugin --profile web remove dsh-skill-card-interview
```

## 工作原理

插件向 `ctx.skills` 注册一个 provider：

- `list()` 为配置里的每个 skill 返回一个候选项，`rank = 590`；
- `get()` 每次加载时**现读**上游 `SKILL.md`，返回「上游正文 + 覆盖层」，并保留 `resourceBase`
  指向上游 skill 目录（技能里的相对引用照常解析）。

注册表按 rank 升序去重，rank 越小越优先：

| rank | 来源 | 说明 |
|---|---|---|
| 100 / 200 | project-dsh / project-agents | 项目级覆盖，仍然优先 |
| 300 | custom | 仍然优先 |
| 400 / 500 | user-dsh / user-agents | 仍然优先 |
| **590** | **本插件** | 只压过下面这一行 |
| 600 | bundled | `@vinvcn/dsh-mattpocock-skills-zh` 的随包来源 |

也就是说：**它只覆盖随包 skill**。你把同名 skill 放进项目或用户目录，仍然可以压过它。
上游改名单（新增/删除 skill）时正文照常更新；插件只在 skill 缺失时安静跳过，不影响其他 provider。

## 配置

`config.json`（改完下次加载生效，无需重启）：

```json
{
  "rank": 590,
  "source": "custom",
  "sources": [
    {
      "package": "@vinvcn/dsh-mattpocock-skills-zh",
      "skills": ["grilling", "wayfinder"]
    }
  ]
}
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `sources[].package` | — | 从 `<profiles>/*/node_modules/<包名>/skills` 解析技能根目录 |
| `sources[].root` | — | 直接指定技能根目录（可写相对本插件目录的路径）；与 `package` 二选一 |
| `sources[].skills` | 该目录下全部 | **上游技能目录名**（`<根>/<目录>/SKILL.md`）；返回的候选名取 frontmatter 里的 `name`（本包带 `zh-` 前缀） |
| `sources[].overlay` | — | 该源专用的覆盖层文本 |
| `overlay` / `overlayFile` | `lib/overlay-zh.md` | 全局覆盖层：内联文本，或指向某个文件 |
| `rank` | `590` | 候选优先级 |
| `overrideDescription` | — | 强制改写技能描述（默认沿用上游） |

想扩到别的技能包，再加一条 `sources` 即可。

## 注入的覆盖层

`lib/overlay-zh.md` 会被原样追加到每个被覆盖 skill 的正文末尾（完整内容见该文件，要点）：

1. **一轮一次调用**——本轮所有问题放进同一次 `ask_user_question` 调用，卡片自带「上一题 / 下一题」翻页器；不在正文里再列一遍编号问答。
2. **每题必有 `options`**——推荐答案放第一个并标 `(Recommended)`，其余选项各配一句取舍说明；关键背景写进选项描述，不要只留在聊天里。
3. **识别 timed 模式**——本机 `timeout≈1s`，调用后会返回 `{ "pending": true, "callId": … }`，这是正常的：卡片已常驻，用户作答后答案作为下一条消息回来。收到 pending 不要重问、不要改回正文、不要替用户假设答案。
4. **例外**——只有确实无法用选项表达的问题（真正需要自由文本，或你查不到的私有信息）才允许在正文里问，并说明原因。
5. **事实类问题不问用户**——能自己查的（读文件、跑命令、派 subagent）按技能原有要求去查；卡片只承载用户的决策。

## 已知边界

- **它保证的是「正确指令一定随技能正文注入」，不是「模型一定照做」。** 没有任何插件能强制模型调用工具；
  能做到的最硬程度，就是让要求成为技能正文的一部分、在加载的同一刻出现。
- 点击 `/zh-xxx` 打开的 SKILL.md 预览是**上游原文**（不含覆盖层），因为 `path` 指向上游文件；
  实际注入给模型的是拼接后的正文。
- 只覆盖 `config.json` 列出的 skill；其余（如 `zh-tdd`、`zh-code-review`）一字不动。
- 与上游包解耦：升级 `@vinvcn/dsh-mattpocock-skills-zh` 不影响本插件，本插件也不改动上游文件。

## 结构

```
lib/index.js          host 半：解析配置 → 注册包装型 skill provider（list / get）
lib/overlay-zh.md     追加到技能正文末尾的覆盖层
config.json           覆盖名单与全局覆盖层配置
cordis.patch.yml      bundle patch：把本插件挂进 profile 组合层
test/provider.test.mjs  7 个单测（frontmatter 解析、rank/source、拼接顺序、正文热读、调用策略、容错）
```

## 开发

```sh
node --test
```

单测覆盖：frontmatter 标量/引号/折叠标量解析、只收录名单内技能、rank 与 provider 归属、
`get()` 返回「正文 + 覆盖层」且顺序正确、**上游改写正文后重新读取即生效**、
`disable-model-invocation` 映射、根目录缺失时安静返回空列表。

## License

MIT

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
