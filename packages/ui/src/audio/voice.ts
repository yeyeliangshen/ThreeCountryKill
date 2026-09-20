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

// —— 武将语音（技能 + 阵亡）——
//
// 文件放在 packages/ui/assets/voice/hero/<武将 id>/<技能名>.mp3（同技能的多个变体带数字后缀：
// 制衡1.mp3 / 制衡2.mp3，播放时随机挑一条）。阵亡语音固定叫 <...>/阵亡.mp3。
// 导入脚本：`npx tsx scripts/import-hero-voices.ts`（映射表见 docs/hero-voice-map.md）。
// 同样「没有文件就静默跳过」——源资源包并不覆盖全部武将。
const HERO_VOICE = import.meta.glob('../../assets/voice/hero/*/*.{mp3,ogg,m4a,wav}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** heroId → 技能名 → 该技能的语音文件（同一技能的多个变体按顺序放） */
const BY_HERO: Record<string, Record<string, string[]>> = {};
for (const [path, url] of Object.entries(HERO_VOICE)) {
  const parts = path.split('/');
  const heroId = parts[parts.length - 2];
  const file = parts[parts.length - 1]?.replace(/\.[^.]+$/, '');
  if (!heroId || !file) continue;
  // 技能名去掉结尾的数字变体号：制衡1 → 制衡
  const skill = file.replace(/\d+$/, '');
  const bySkill = (BY_HERO[heroId] ??= {});
  (bySkill[skill] ??= []).push(url);
}

/** 这位武将有没有这条语音（技能名或 `阵亡`）——界面可据此决定要不要提示/测试用 */
export function hasHeroVoice(heroId: string | null | undefined, skill: string): boolean {
  return !!heroId && (BY_HERO[heroId]?.[skill]?.length ?? 0) > 0;
}

/**
 * 播一条**武将语音**（技能或阵亡）。同一技能有多条变体时随机挑一条。
 * @returns 是否真的播了（没有文件返回 false，调用方不必管）
 */
export function playHeroVoice(heroId: string | null | undefined, skill: string): boolean {
  const urls = heroId ? BY_HERO[heroId]?.[skill] : undefined;
  if (!urls || urls.length === 0) return false;
  const url = urls[Math.floor(Math.random() * urls.length)]!;
  lastPlayed.heroVoice = `${heroId}/${skill}`;
  const el = new Audio(url);
  el.volume = 0.85;
  void el.play().catch(() => {
    // 自动播放被拦 / 解码失败：静默跳过，别打断游戏
  });
  return true;
}
