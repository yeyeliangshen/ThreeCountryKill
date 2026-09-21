// 装备区的一个槽位：**花色 + 点数 + 牌名**（用户 2026-09-21：「装备栏显示得再大一点儿，
// 要把装备的花色和点数显示出来」）。
//
// 为什么花色点数要显示：装备牌的花色点数**是明面上的信息**——【八卦阵】的判定、反间/火攻
// 一类要看花色，铁索/火杀那种要看属性；以前只写「八卦阵」三个字，等于把这半张牌藏起来了。
//
// 自己的面板与对手面板**共用这一个组件**，免得两边各写一套（口径/字号不一致的坑）。
import {
  cardDescription,
  cardShortName,
  rankLabel,
  SUIT_NAME,
  SUIT_SYMBOL,
  type Card,
  type GameMode,
} from '@sgs/protocol';

/** 提示绑定器（`useHoverTip` 的 `bind`）：桌面悬停 / 手机长按都能看说明 */
export type TipBind = (title: string, desc: string) => Record<string, unknown>;

export function EquipChip({
  card,
  mode,
  bind,
}: {
  card: Card;
  mode: GameMode;
  bind: TipBind;
}) {
  const red = card.suit === 'heart' || card.suit === 'diamond';
  return (
    <span
      className={`equip-icon equip-${card.type} ${red ? 'suit-red' : 'suit-black'}`}
      {...bind(
        // 提示标题用中文花色的全称（与手牌一致），牌面上用符号，省地方
        card.suit !== undefined
          ? `${SUIT_NAME[card.suit]}${rankLabel(card.rank)} · ${cardShortName(card)}`
          : cardShortName(card),
        `${cardDescription(card, mode)}${card.cargoCount ? `（下有扣置的牌 ${card.cargoCount} 张）` : ''}`,
      )}
    >
      {card.suit && (
        <span className="e-rank">
          {SUIT_SYMBOL[card.suit]}
          {rankLabel(card.rank)}
        </span>
      )}
      <span className="e-name">{cardShortName(card)}</span>
      {card.cargoCount ? <span className="e-name">·辎{card.cargoCount}</span> : null}
    </span>
  );
}
