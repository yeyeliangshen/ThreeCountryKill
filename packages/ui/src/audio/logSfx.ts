// 引擎日志 kind → 音效。没列出来的 kind 不发声。
//
// kind 的取值见 packages/engine/src/engine.ts 里的 pushLog 调用。
// 刻意不映射 draw/discard 这类高频事件，否则每回合都在响。
import type { SfxName } from './sfx';

export const LOG_SFX: Record<string, SfxName> = {
  // 出牌类
  sha: 'card',
  trick: 'card',
  equip: 'card',
  skill: 'card',
  jiu: 'card',
  // 判定与结算
  judge: 'judge',
  damage: 'damage',
  shandian: 'damage',
  tao: 'heal',
  death: 'death',
  // 开局
  start: 'turn',
};
