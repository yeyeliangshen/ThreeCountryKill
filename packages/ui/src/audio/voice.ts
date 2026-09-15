// 卡牌语音。
//
// 文件放在 packages/ui/assets/voice/ 下，命名 <动作>-<性别>.mp3，
// 例如 sha-m.mp3（男声「杀」）、sha-fire-f.mp3（女声「火杀」）、wuxie-m.mp3。
// 动作标识来自引擎日志的 action 字段。
//
// 性别取自该座次武将的 hero.gender（见 packages/engine/src/heroes.ts）。
// 没有对应语音文件时静默跳过——不报错、也不拿别的语音凑数。
import { lastPlayed } from './debug';

const VOICE = import.meta.glob('../../assets/voice/*.{mp3,ogg,m4a,wav}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const BY_NAME: Record<string, string> = {};
for (const [path, url] of Object.entries(VOICE)) {
  const name = path.split('/').pop()?.replace(/\.[^.]+$/, '');
  if (name) BY_NAME[name] = url;
}

/** 有语音的动作（其余动作不出语音） */
const VOICED = new Set([
  'sha',
  'sha-fire',
  'sha-thunder',
  'shan',
  'tao',
  'jiu',
  'juedou',
  'nanman',
  'wanjian',
  'jiedao',
  'guohe',
  'shunshou',
  'wuzhong',
  'wuxie',
  'huogong',
  'taoyuan',
  'lebu',
  'bingliang',
  'shandian',
]);

export function hasVoice(action: string): boolean {
  return VOICED.has(action);
}

/**
 * 播一条卡牌语音。
 * @param action 语义动作（日志的 action）
 * @param gender 出牌角色的性别；未知则不出声
 */
export function playVoice(action: string, gender: 'male' | 'female' | undefined): boolean {
  if (!gender || !VOICED.has(action)) return false;
  const name = `${action}-${gender === 'male' ? 'm' : 'f'}`;
  const url = BY_NAME[name];
  if (!url) return false;
  lastPlayed.voice = name;
  const el = new Audio(url);
  el.volume = 0.85;
  void el.play().catch(() => {
    // 自动播放被拦或解码失败：静默跳过，别打断游戏
  });
  return true;
}
