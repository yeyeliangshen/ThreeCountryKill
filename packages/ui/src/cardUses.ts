/**
 * 「这张牌怎么用？」的**用法列表与点了之后该做什么**（从 Game.tsx 搬出来的纯逻辑）。
 *
 * ⚠️ 为什么值得单独一个文件：连横（势备篇）的用法以前**列出来了、却没接上动作**——
 * 点「连横（交给一名势力不同或未确定势力的角色）」掉进了 `beginPlay(card, u.as)`
 * 那一支（`u.as` 是 undefined ⇒ 按牌面使用），于是：
 *   · 大势力角色点它 → 把【挟天子以令诸侯】当成「使用」打出去了；
 *   · 非大势力角色点它 → 引擎回一句「只有大势力角色能使用」。
 * 两条路都不是「连横」，而 `lianhengCard` 这个状态**全仓没有任何写入点**（连横模式进不去）。
 * 所以这里把「用法 → 动作」做成**纯函数**并单测：四种用法各有各的去处，
 * 谁要是再漏一条分支，用例当场红。
 */
import {
  CARD_TYPE_NAME,
  cardShortName,
  isDelayedTrick,
  isEquipCard,
  isInstantTrick,
  isRecastable,
  isRed,
  isWuxieLike,
  type Card,
  type CardType,
  type DamageAttribute,
} from '@sgs/protocol';
import { heroCanUseAs, type Hero } from '@sgs/engine';

/** 这张牌能否在出牌阶段直接使用（无需转化） */
export function isDirectlyPlayable(card: Card): boolean {
  if (card.type === 'sha' || card.type === 'tao' || card.type === 'jiu') return true;
  if (isEquipCard(card)) return true;
  if (isDelayedTrick(card)) return true;
  // 无懈可击（含国战版）只能在响应时打出，出牌阶段点不动
  if (isInstantTrick(card) && !isWuxieLike(card)) return true;
  return false;
}

/** 转化技可能出现的所有目标类型，顺序即优先级 */
const CONVERSION_TYPES: CardType[] = [
  'sha',
  'guohe',
  'tao',
  'shan',
  'lebu',
  'bingliang',
  'huogong',
  'tiesuo',
];

/** 能靠转化技把别的牌变成可重铸牌型的技能目标（庞统·连环 →【铁索连环】） */
const RECAST_VIA_TYPES: CardType[] = ['tiesuo', 'zhibi'];

/** 一种用法：`as` 为空表示「按牌面本身使用」 */
export interface CardUse {
  as?: CardType;
  /** 转化后的伤害属性（朱雀羽扇：普通【杀】当火【杀】） */
  asAttribute?: DamageAttribute;
  /** 重铸：不指定目标，把牌弃掉再摸一张（不是「使用」） */
  recast?: boolean;
  /** 连横（势备篇）：把手牌交给一名势力不同或未确定势力的角色 */
  lianheng?: boolean;
  /** 【丈八蛇矛】：这张牌当【杀】的**第一张**，还要再点一张手牌凑成两张 */
  zhangba?: boolean;
  label: string;
}

/**
 * 列出这张牌在出牌阶段有哪几种用法。
 *
 * 以前这里只返回**一个**转化类型，而且**牌面能直接用就不给转化**——
 * 于是徐晃拿黑色【杀】时没法选择「当兵粮寸断用」（甘宁·奇袭、大乔·国色同样受影响）。
 * 现在把「牌面本身」和各种转化都列出来，多于一种时由玩家选。
 */
export function cardUses(
  card: Card,
  heroes: Hero[],
  aoyu: boolean,
  hasZhuque: boolean,
  lianhengTargets: string[],
  zhangbaOk: boolean,
  shuangxiongColor: 'red' | 'black' | null,
): CardUse[] {
  const uses: CardUse[] = [];
  if (isDirectlyPlayable(card)) {
    uses.push({ label: `按【${cardShortName(card)}】使用` });
  }
  for (const type of CONVERSION_TYPES) {
    if (heroes.some((h) => heroCanUseAs(h, card, type))) {
      uses.push({ as: type, label: `当【${CARD_TYPE_NAME[type]}】使用` });
    }
  }
  if (aoyu && card.type === 'tao' && !uses.some((u) => u.as === 'sha')) {
    uses.push({ as: 'sha', label: '当【杀】使用（鏖战）' });
  }
  // 连横（势备篇）：带标记的手牌可以交出去——「交给谁」的合法性由服务端算好
  if (card.lianheng && lianhengTargets.length > 0) {
    uses.push({ lianheng: true, label: '连横（交给一名势力不同或未确定势力的角色）' });
  }
  // 朱雀羽扇：普通【杀】可以当火【杀】使用（同一张牌换属性，不是换牌型）
  if (hasZhuque && card.type === 'sha' && !card.attribute) {
    uses.push({ asAttribute: 'fire', label: '当火【杀】使用（朱雀羽扇）' });
  }
  // 颜良文丑·双雄：本回合可以把与判定牌**颜色不同**的手牌当【决斗】使用
  if (shuangxiongColor && (isRed(card) ? 'red' : 'black') !== shuangxiongColor) {
    uses.push({ as: 'juedou', label: '当【决斗】使用（双雄）' });
  }
  // 【丈八蛇矛】：两张手牌当【杀】。这里只是「第一张」，点完还要再选一张
  if (zhangbaOk && !uses.some((u) => u.zhangba)) {
    uses.push({ zhangba: true, label: '两张手牌当【杀】使用（丈八蛇矛）' });
  }
  // 可重铸的牌（铁索连环 / 知己知彼）多一条「重铸」用法；
  // 庞统·连环那种「梅花牌当【铁索连环】使用**或重铸**」也要给这一条
  if (
    isRecastable(card) ||
    RECAST_VIA_TYPES.some((t) => card.type !== t && heroes.some((h) => heroCanUseAs(h, card, t)))
  ) {
    uses.push({ recast: true, label: '重铸（弃置此牌，摸一张）' });
  }
  return uses;
}

/** 点了某条用法之后该走哪条路（四种互斥，**每种都必须落到实处**） */
export type UseAction = 'recast' | 'zhangba' | 'lianheng' | 'play';

export function useActionOf(u: CardUse): UseAction {
  if (u.recast) return 'recast';
  if (u.zhangba) return 'zhangba';
  // ⚠️ 连横必须排在最后那支（`play`）**之前**：它没有 `as`，掉进 play 就会被当成「按牌面使用」
  if (u.lianheng) return 'lianheng';
  return 'play';
}
