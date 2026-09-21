import { canPairHeroes, type Hero } from '@sgs/engine';

/**
 * 国战选将：两个槽位（主将 / 副将）的状态。
 * `null` = 这个槽是空的。
 */
export interface GuozhanSlots {
  main: string | null;
  deputy: string | null;
}

/** 取武将牌的只读查找（注入进来，方便单测不给整张武将表） */
export type HeroLookup = (heroId: string) => Hero | undefined;

/**
 * 点一张武将牌之后，两个槽位怎么变——**纯函数**，便于单测。
 *
 * 规则（与引擎的 `pickHero` **同口径**，都是 `canPairHeroes`）：
 * 1. 点已在槽里的那张 → 取消它；
 * 2. 主将槽空 → 放主将；
 * 3. 副将槽空 → **能配对就放副将**；配不上就把这张当主将（清空副将）；
 * 4. 两个槽都满 → 这张当主将（清空副将）。
 *
 * ⚠️ 第 3 步以前用的是「只比 `faction` 是否相等」，于是**双势力牌配不出合法组合**：
 *    孟达(魏/蜀) + 关羽(蜀) 因为 魏 ≠ 蜀 永远落不到副将位，而引擎其实是收这个组合的
 *    （2026-09-21 用户给的双势力 2023 口径：有共同势力即可）。判定必须走同一个函数，
 *    否则「界面拼不出来、引擎却收」这类不一致会再出现。
 */
export function nextGuozhanSlots(
  slots: GuozhanSlots,
  clicked: string,
  heroOf: HeroLookup,
): GuozhanSlots {
  if (clicked === slots.main) return { main: null, deputy: slots.deputy };
  if (clicked === slots.deputy) return { main: slots.main, deputy: null };
  if (!slots.main) return { main: clicked, deputy: slots.deputy };
  if (!slots.deputy) {
    return canPairHeroes(heroOf(slots.main), heroOf(clicked))
      ? { main: slots.main, deputy: clicked }
      : { main: clicked, deputy: null };
  }
  return { main: clicked, deputy: null };
}
