# 语音资源

两类语音，都按**文件名自动生效**（`import.meta.glob` 扫这个目录），不需要改代码：

## 1. 卡牌语音（`assets/voice/*.mp3`）

命名 **`<动作>-<性别>.mp3`**，动作取自引擎日志的 `action` 字段（见 `packages/ui/src/audio/logSfx.ts`），
性别取自该座次武将的 `gender`：

| 文件 | 什么时候播 |
| --- | --- |
| `sha-m.mp3` / `sha-f.mp3` | 男/女角色使用【杀】 |
| `sha-fire-m.mp3` | 火【杀】 |
| `shan-f.mp3` | 出【闪】 |
| `wuxie-m.mp3` | 【无懈可击】 |
| …（`tao` / `jiu` / `juedou` / `nanman` / `wanjian` / `guohe` / `shunshou` / `wuzhong` / `huogong` / `taoyuan` / `lebu` / `bingliang` / `shandian`） | 同名的牌 |

## 2. 武将语音（`assets/voice/hero/<武将 id>/<技能名>.mp3`）

- 目录名是**武将 id**（见 `packages/engine/src/heroes.ts`，如 `zhouyu`），文件名是**技能名**
  （如 `反间.mp3`）；同一技能有多个变体就带数字后缀（`制衡1.mp3` / `制衡2.mp3`，播放时随机挑一条）。
- `阵亡.mp3` 是阵亡语音。
- 触发：日志里出现「X 发动【技能名】」→ 播 X 的那位武将的技能语音；`death` 日志 → 播阵亡语音。
  判断逻辑在 `packages/ui/src/audio/pickNewVoices.ts`（纯函数，有单测）。
- **没有文件就静默跳过**——源资源包不覆盖全部武将（例如四位君主将、没有对应版本的那些技能）。

### 这批语音是怎么来的

用 `npx tsx scripts/import-hero-voices.ts` 从本地语音资源包导入（见 `docs/hero-voice-map.md` 的映射表：
哪位武将用了源里的哪一套、覆盖到哪些技能、缺哪些）。只导入**我们实现的那几个技能**，
每技能至多 2 条 + `阵亡`——所以目录不大（约 31 MB / 507 个文件）。想换掉某位武将的语音，
直接按上面的命名覆盖对应文件即可，或者改脚本里的版本偏好后重跑。
