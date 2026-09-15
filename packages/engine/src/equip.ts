// 装备牌特效 —— 与 engine 分离的纯查询/判定辅助，便于单测
import { isRed, type Card } from '@sgs/protocol';
import { getPlayer, type AttackContext, type GameState, type Player } from './model';

/** 攻击方武器是否无视目标防具（青釭剑） */
export function ignoresArmor(source: Player | undefined): boolean {
  return source?.equipment.weapon?.equipName === 'qinggang';
}

/**
 * 防具是否令此【杀】对目标完全无效。
 * 返回防具名（用于日志）表示无效，返回 null 表示正常结算。
 * 青釭剑无视防具 → 一律返回 null。
 */
export function armorNullifiesSha(
  state: GameState,
  attack: AttackContext,
): string | null {
  const source = getPlayer(state, attack.sourceId);
  const target = getPlayer(state, attack.targetId);
  if (!target) return null;
  const armor = target.equipment.armor?.equipName;
  if (!armor || ignoresArmor(source)) return null;
  // 仁王盾：黑色的【杀】对你无效
  if (armor === 'renwang' && !attack.cardRed) return '仁王盾';
  // 藤甲：普通【杀】对你无效（火杀/雷杀为属性杀，仍然生效）
  if (armor === 'tengjia' && !attack.attribute) return '藤甲';
  return null;
}

/**
 * 八卦阵：当你需要使用或打出【闪】时，你可以进行判定：
 * 若结果为红色，视为你使用或打出了一张【闪】。
 * 简化：自动判定，红色则自动闪避。返回 true 表示成功闪避。
 * 青釭剑无视防具 → 不触发。
 */
export function tryBaguaDodge(
  state: GameState,
  attack: AttackContext,
): boolean {
  const source = getPlayer(state, attack.sourceId);
  const target = getPlayer(state, attack.targetId);
  if (target?.equipment.armor?.equipName !== 'bagua') return false;
  if (ignoresArmor(source)) return false;
  const judge = state.deck.pop();
  if (!judge) return false;
  state.discard.push(judge);
  const red = isRed(judge);
  return red;
}

/**
 * 伤害加成（在扣血前累加）。
 *   古锭刀：杀造成伤害时，若目标没有手牌，此伤害 +1
 *   藤甲：受到火焰伤害时，此伤害 +1（青釭剑无视防具时不加）
 */
export function damageBonus(state: GameState, attack: AttackContext): number {
  const source = getPlayer(state, attack.sourceId);
  const target = getPlayer(state, attack.targetId);
  if (!target) return 0;
  let bonus = 0;
  if (source?.equipment.weapon?.equipName === 'guding' && target.hand.length === 0) {
    bonus += 1;
  }
  if (
    target.equipment.armor?.equipName === 'tengjia' &&
    attack.attribute === 'fire' &&
    !ignoresArmor(source)
  ) {
    bonus += 1;
  }
  return bonus;
}

/**
 * 藤甲是否令群攻锦囊（南蛮入侵/万箭齐发）对该玩家无效。
 * 这两张锦囊均为无属性伤害，藤甲一律免疫。
 */
export function tengjiaNullifiesAoe(
  state: GameState,
  seatId: string,
  trickType: string,
): boolean {
  if (trickType !== 'nanman' && trickType !== 'wanjian') return false;
  const p = getPlayer(state, seatId);
  return p?.equipment.armor?.equipName === 'tengjia';
}

/** 七星宝刀：进入装备区时，弃置你判定区和装备区里所有其他牌 */
export function applyQixingSweep(
  state: GameState,
  player: Player,
  equipped: Card,
): Card[] {
  if (equipped.equipName !== 'qixing') return [];
  const swept: Card[] = [];
  for (const c of player.judgment) swept.push(c);
  player.judgment = [];
  const eq = player.equipment;
  for (const slot of ['weapon', 'armor', 'plusMount', 'minusMount'] as const) {
    const c = eq[slot];
    // 七星宝刀自身所在槽位保留
    if (c && c.id !== equipped.id) {
      swept.push(c);
      eq[slot] = null;
    }
  }
  for (const c of swept) state.discard.push(c);
  return swept;
}
