import { isRed } from '@sgs/protocol';
import type { Card, CardType, RoleId } from '@sgs/protocol';
import type { HookRegistration } from './timing';
import type { AttackContext } from './model';

// —— 武将定义 ——
// canUseAs：转化技（能否把 card 当 type 使用/打出）。
// shaLimit：被动修改器（本回合最多可出杀数，默认 1）。
// hooks：触发技钩子。
// skills：UI 展示用技能描述。

export interface Hero {
  id: string;
  name: string;
  faction: 'shu' | 'wei' | 'wu' | 'qun' | 'neutral';
  maxHp: number;
  /**
   * 转化技：能否把 card 当 type 使用/打出。
   * 关羽·武圣：红色牌当【杀】。
   * 赵云·龙胆：【杀】【闪】互转。
   * 甄姬·倾国：黑色牌当【闪】。
   * 华佗·急救：红色牌当【桃】（用于濒死救援）。
   */
  canUseAs?: (card: Card, type: CardType) => boolean;
  /**
   * 被动修改器：本回合最多可出杀数。默认 1。
   * 张飞·咆哮：无限。
   */
  shaLimit?: () => number;
  /** 触发技钩子 */
  hooks?: HookRegistration[];
  /** UI 展示用技能描述 */
  skills: { name: string; desc: string }[];
}

const GUANYU: Hero = {
  id: 'guanyu',
  name: '关羽',
  faction: 'shu',
  maxHp: 4,
  canUseAs: (card, type) => type === 'sha' && isRed(card),
  skills: [{ name: '武圣', desc: '你可以将一张红色牌当【杀】使用或打出。' }],
};

const ZHANGFEI: Hero = {
  id: 'zhangfei',
  name: '张飞',
  faction: 'shu',
  maxHp: 4,
  shaLimit: () => Infinity,
  skills: [{ name: '咆哮', desc: '出牌阶段，你可以使用任意数量的【杀】。' }],
};

const ZHAOYUN: Hero = {
  id: 'zhaoyun',
  name: '赵云',
  faction: 'shu',
  maxHp: 4,
  // 龙胆：杀↔闪互转
  canUseAs: (card, type) =>
    (type === 'sha' && card.type === 'shan') ||
    (type === 'shan' && card.type === 'sha'),
  skills: [{ name: '龙胆', desc: '你可以将【杀】当【闪】、【闪】当【杀】使用或打出。' }],
};

const MACHAO: Hero = {
  id: 'machao',
  name: '马超',
  faction: 'shu',
  maxHp: 4,
  skills: [{ name: '铁骑', desc: '（技能待复刻）' }],
};

const HUANGZHONG: Hero = {
  id: 'huangzhong',
  name: '黄忠',
  faction: 'shu',
  maxHp: 4,
  skills: [{ name: '烈弓', desc: '（技能待复刻）' }],
};

const LVBU: Hero = {
  id: 'lvbu',
  name: '吕布',
  faction: 'qun',
  maxHp: 4,
  skills: [{ name: '无双', desc: '（技能待复刻）' }],
};

const DIAOCHAN: Hero = {
  id: 'diaochan',
  name: '貂蝉',
  faction: 'qun',
  maxHp: 3,
  skills: [{ name: '离间', desc: '（技能待复刻）' }],
};

const ZHENJI: Hero = {
  id: 'zhenji',
  name: '甄姬',
  faction: 'wei',
  maxHp: 3,
  // 倾国：黑色牌当【闪】
  canUseAs: (card, type) => type === 'shan' && !isRed(card),
  skills: [{ name: '倾国', desc: '你可以将一张黑色牌当【闪】使用或打出。' }],
};

const SIMAYI: Hero = {
  id: 'simayi',
  name: '司马懿',
  faction: 'wei',
  maxHp: 3,
  skills: [{ name: '鬼才', desc: '（技能待复刻）' }],
};

const XIAHOUDUN: Hero = {
  id: 'xiahoudun',
  name: '夏侯惇',
  faction: 'wei',
  maxHp: 4,
  skills: [{ name: '刚烈', desc: '（技能待复刻）' }],
};

const XUCHU: Hero = {
  id: 'xuchu',
  name: '许褚',
  faction: 'wei',
  maxHp: 4,
  // 裸衣（简化）：你使用【杀】造成的伤害+1
  hooks: [
    {
      timing: 'useCard',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext } | undefined;
        if (payload?.attack?.asType === 'sha') {
          payload.attack.damage += 1;
        }
      },
    },
  ],
  skills: [{ name: '裸衣', desc: '你使用【杀】造成的伤害+1。（简化版）' }],
};

const HUATUO: Hero = {
  id: 'huatuo',
  name: '华佗',
  faction: 'qun',
  maxHp: 3,
  // 急救：红色牌当【桃】（用于濒死救援）
  canUseAs: (card, type) => type === 'tao' && isRed(card),
  skills: [{ name: '急救', desc: '你的回合外，可以将一张红色牌当【桃】使用。' }],
};

const VANILLA: Hero = {
  id: 'vanilla',
  name: '平民',
  faction: 'neutral',
  maxHp: 4,
  skills: [],
};

export const HEROES: Hero[] = [
  GUANYU,
  ZHANGFEI,
  ZHAOYUN,
  MACHAO,
  HUANGZHONG,
  LVBU,
  DIAOCHAN,
  ZHENJI,
  SIMAYI,
  XIAHOUDUN,
  XUCHU,
  HUATUO,
  VANILLA,
];

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

// —— 身份显示名（军争模式） ——
export const ROLE_NAME: Record<RoleId, string> = {
  lord: '主公',
  loyal: '忠臣',
  rebel: '反贼',
  renegade: '内奸',
};
