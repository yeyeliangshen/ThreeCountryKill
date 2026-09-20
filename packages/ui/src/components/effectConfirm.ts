import {
  CARD_TYPE_NAME,
  cardDescription,
  cardLabel,
  cardShortName,
  isEquipCard,
  type Card,
  type CardType,
  type GameMode,
} from '@sgs/protocol';

/**
 * 「主动发起的效果」在**生效之前**要先确认一句，并把效果简单描述出来（用户 2026-09-18 要求）。
 *
 * 点名的是四类：**【杀】、【酒】、装装备、武将主动技能**——它们点一下就直接生效，
 * 而牌面说明平时只有**悬停**才看得到（触屏上根本没有悬停），于是很容易误点
 * （装装备尤其疼：点错就把手里的装备丢进装备区，还顶掉原来那件）。
 *
 * 这里只负责「**要不要确认**」与「**确认框里写什么**」这两件可单测的事；
 * 渲染与点击在 `pages/Game.tsx`（武将技能那边直接用 `ActiveSkill.desc`，见那个面板）。
 */

/** 这个用法要不要「生效前确认」——【杀】【酒】、装装备属于用户点名的那几类 */
export function needsEffectConfirm(card: Card, as?: CardType): boolean {
  const type = as ?? card.type;
  return type === 'sha' || type === 'jiu' || isEquipCard(card);
}

export interface EffectConfirm {
  /** 一句话说清这次要干什么，如「对 甲、乙 使用【杀】」「装上【青釭剑】」 */
  title: string;
  /** 效果简述：牌面原文（转化牌给的是**转化后**那张牌的效果） */
  desc: string;
}

/**
 * 生成确认框文案。
 *
 * @param as      转化后的类型（武圣把红牌当【杀】：说明要给【杀】的，不是那张红牌的）
 * @param targets 已经点选的目标名字（没选目标时省略）
 */
export function effectConfirmFor(
  card: Card,
  as: CardType | undefined,
  mode: GameMode | undefined,
  targets: string[] = [],
): EffectConfirm {
  const type = as ?? card.type;
  const converted = !!as && type !== card.type;
  const name = converted ? CARD_TYPE_NAME[type] : cardShortName(card);
  const equip = !converted && isEquipCard(card);
  const title = equip
    ? `装上 ${cardLabel(card)}`
    : targets.length > 0
      ? `对 ${targets.join('、')} 使用【${name}】`
      : `使用【${name}】`;
  // 转化牌：按**转化后**的类型取说明（`cardDescription` 只看 type/equipName）
  const desc = converted ? cardDescription({ ...card, type }, mode) : cardDescription(card, mode);
  return { title, desc };
}
