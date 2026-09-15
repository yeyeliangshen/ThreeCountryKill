// 音频层出口。界面代码只从这里 import。
import { bgm } from './bgm';
import { sfx } from './sfx';

export { bgm, type BgmScene, type BgmState } from './bgm';
export { sfx, type SfxName } from './sfx';
export { LOG_SFX } from './logSfx';
export { useGameAudio } from './useGameAudio';
export { SoundToggle } from './SoundToggle';

// 开发期方便在浏览器控制台里查音频状态：
//   __sgsAudio.bgm.getState()   → { scene, source, contextState, blocked, ... }
//   __sgsAudio.bgm.setMuted(true)
//   __sgsAudio.sfx.play('damage')
// 生产构建里不会挂上去。
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__sgsAudio = { bgm, sfx };
}
