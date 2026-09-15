# @sgs/ui — 浏览器端应用

界面、样式、背景音乐与音效、客户端状态都收在这个包里。**改动引擎 / 服务端 / 协议时不需要进这个包**，反过来也一样：改界面和音乐不用碰 `packages/engine`、`packages/server`。

## 包内结构

```
src/
  index.ts            出口：App / useStore / audio
  App.tsx             顶层：按 screen 切页面 + 挂声音开关
  store.ts            客户端状态：WebSocket 收发、断线重连、zustand store
  styles.css          全部样式
  pages/
    JoinPage.tsx      填服务器地址 / 房间号 / 昵称
    Lobby.tsx         选模式、落座、房主开局
    Game.tsx          对局主界面（选将、手牌、装备区、判定区、提示交互）
  audio/              音乐音效
    bgm.ts            背景音乐：场景切换、音量、静音
    sfx.ts            音效：全部 Web Audio 合成，无音频文件
    logSfx.ts         引擎日志 kind → 音效 的映射表
    pickNewSfx.ts     从日志增量里挑该播的音效（纯函数，带单测）
    useGameAudio.ts   把 store 接到音频层（切场景、按新日志发声）
    SoundToggle.tsx   右上角声音开关 + 音量
assets/
  bgm/                放真实音乐文件的地方（见该目录下的 README）
```

`packages/client` 只是 Vite 构建外壳（`index.html` + `vite.config.ts` + 十行的 `main.tsx`），不含界面逻辑。

## 怎么改

**换/加背景音乐**：见 `assets/bgm/README.md`。优先级是 `menu.*` / `battle.*` 专用文件 > `default.*` 兜底文件 > 内置合成音。当前放的是 `default.mp4`（三国杀开局音乐），菜单和对局共用。

**加音效**：在 `sfx.ts` 的 `play()` 里加一个 `case`，在 `logSfx.ts` 里把引擎的日志 `kind` 映射过去。引擎日志 kind 的取值见 `packages/engine/src/engine.ts` 中的 `pushLog(...)` 调用。

**BGM 场景**：目前只有 `'menu'`（进房前）和 `'battle'`（对局中），在 `App.tsx` 的 `useGameAudio()` 里按 `screen` 切换。要加场景，改 `bgm.ts` 的 `BgmScene` 与 `TRACKS`。

**样式**：全部在 `src/styles.css`，没有 CSS Modules / 预处理器。主题色是文件开头的 CSS 变量。

## 测试与调试

```bash
pnpm --filter @sgs/ui test        # 音频判定逻辑的单测
pnpm --filter @sgs/ui typecheck
```

音频相关的东西听不出来，所以在 dev 模式下把音频对象挂到了 `window.__sgsAudio`（生产构建不挂），

浏览器控制台里可以查：

```js
__sgsAudio.bgm.getState()
// { scene: 'battle', source: 'synth', contextState: 'running', muted: false, volume: 0.5, blocked: false }
__sgsAudio.bgm.setMuted(true)
__sgsAudio.sfx.play('damage')     // 单独试听某个音效
```

`contextState` 为 `'running'` 才代表真的在出声；`'suspended'` 是浏览器还没拿到播放许可（用户还没交互过），此时界面右上角会提示「点击页面开启音乐」。

`source` 为 `'file'` 表示用的是 `assets/bgm` 里的音乐文件，`'synth'` 表示内置合成音；`fileDuration` 有值说明文件确实被取到并解码成功。

## 两个容易踩的点

- **新事件的判定要按日志 `id`，不能按日志长度。** 快照只下发最近 50 条（`packages/engine/src/snapshot.ts`），引擎日志本身也在 200 条封顶，长度会停止增长。所以引擎给每条日志发了自增 `id`，判定逻辑抽在 `audio/pickNewSfx.ts` 并带了单测。
- **卡牌按钮用 `aria-disabled` 而不是 `disabled`。** 浏览器不会给 `disabled` 的元素派发鼠标事件，那样当前回合用不了的牌就悬停不出效果提示了——恰好是最想查效果的时候。点击行为由 `onClick` 里的 `cardDisabled` 守卫拦住。
