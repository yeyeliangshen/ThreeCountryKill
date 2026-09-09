import { isRed } from '@sgs/protocol';
import type { Card, CardType } from '@sgs/protocol';
import type { HookRegistration } from './timing';

// —— 武将定义 ——
// 首期 3 个：关羽（武圣·转化技）、张飞（咆哮·被动修改器）、平民（无技能基线）
export interface Hero {
  id: string;
  name: string;
  faction: 'shu' | 'wei' | 'wu' | 'qun' | 'neutral';
  maxHp: number;
  /**
   * 转化技：能否把 card 当 type 使用/打出。
   * 关羽·武圣：红色牌当【杀】。
   */
  canUseAs?: (card: Card, type: CardType) => boolean;
  /**
   * 被动修改器：本回合最多可出杀数。默认 1。
   * 张飞·咆哮：无限。
   */
  shaLimit?: () => number;
  /** 触发技钩子（首期 2 武将不挂，系统已就位） */
  hooks?: HookRegistration[];
  /** UI 展示用技能描述 */
  skills: { name: string; desc: string }[];
}

const GUANYU: Hero = {
  id: 'guanyu',
  name: '关羽',
  faction: 'shu',
  maxHp: 4,
  // 武圣：红色牌可当【杀】使用或打出
  canUseAs: (card, type) => type === 'sha' && isRed(card),
  skills: [{ name: '武圣', desc: '你可以将一张红色牌当【杀】使用或打出。' }],
};

const ZHANGFEI: Hero = {
  id: 'zhangfei',
  name: '张飞',
  faction: 'shu',
  maxHp: 4,
  // 咆哮：出牌阶段可不限次数使用【杀】
  shaLimit: () => Infinity,
  skills: [{ name: '咆哮', desc: '出牌阶段，你可以使用任意数量的【杀】。' }],
};

const VANILLA: Hero = {
  id: 'vanilla',
  name: '平民',
  faction: 'neutral',
  maxHp: 4,
  skills: [],
};

export const HEROES: Hero[] = [GUANYU, ZHANGFEI, VANILLA];

const HERO_MAP: Record<string, Hero> = Object.fromEntries(HEROES.map((h) => [h.id, h]));

export function getHero(id: string | null | undefined): Hero | undefined {
  if (id == null) return undefined;
  return HERO_MAP[id];
}

/** 取武将每回合杀数上限，缺省 1 */
export function heroShaLimit(hero: Hero): number {
  return hero.shaLimit?.() ?? 1;
}

/** 取武将可否把 card 当 type 用 */
export function heroCanUseAs(hero: Hero, card: Card, type: CardType): boolean {
  return hero.canUseAs?.(card, type) ?? false;
}
