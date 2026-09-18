// 装备牌特效 —— 与 engine 分离的纯查询/判定辅助，便于单测
import { isRed, type Card } from '@sgs/protocol';
import { getPlayer, pushLog, type AttackContext, type GameState, type Player } from './model';
import {
  EQUIP_SLOTS,
  cardAsSeenBy,
  effectiveHeroes,
  hasYuxi,
  type ActiveSkill,
  type SkillApi,
} from './heroes';

/** 攻击方武器是否无视目标防具（青釭剑） */
export function ignoresArmor(source: Player | undefined): boolean {
  return source?.equipment.weapon?.equipName === 'qinggang';
}

/**
 * 防具是否令此【杀】对目标完全无效。
 * 返回防具名（用于日志）表示无效，返回 null 表示正常结算。
 * 青釭剑无视防具 → 一律返回 null。
 */
export function armorNullifiesSha(state: GameState, attack: AttackContext): string | null {
  const source = getPlayer(state, attack.sourceId);
  const target = getPlayer(state, attack.targetId);
  if (!target) return null;
  const armor = target.equipment.armor?.equipName;
  if (!armor || ignoresArmor(source)) return null;
  // 仁王盾：**黑色**的【杀】对你无效——注意是无色杀（丈八蛇矛一红一黑）不受影响
  if (armor === 'renwang' && attack.cardColor === 'black') return '仁王盾';
  // 藤甲：普通【杀】对你无效（火杀/雷杀为属性杀，仍然生效）
  if (armor === 'tengjia' && !attack.attribute) return '藤甲';
  // 明光铠：火焰伤害的【杀】对它无效（对应移动版把范围扩到「属性为火焰的杀」）
  if (armor === 'mingguang' && attack.attribute === 'fire') return '明光铠';
  return null;
}

/**
 * 八卦阵：当你需要使用或打出【闪】时，你可以进行判定：
 * 若结果为红色，视为你使用或打出了一张【闪】。
 * 简化：自动判定，红色则自动闪避。返回 true 表示成功闪避。
 * 青釭剑无视防具 → 不触发。
 */
export function tryBaguaDodge(state: GameState, attack: AttackContext): boolean {
  const source = getPlayer(state, attack.sourceId);
  const target = getPlayer(state, attack.targetId);
  if (!target) return false;
  // 八卦阵：要么真装了，要么是卧龙诸葛亮的【八阵】（装备区没防具时视为装备八卦阵）
  const hasBagua =
    target.equipment.armor?.equipName === 'bagua' ||
    (!target.equipment.armor &&
      effectiveHeroes(state, target).some((h) => h.hasBaguaAlways === true));
  if (!hasBagua) return false;
  if (ignoresArmor(source)) return false;
  const judge = state.deck.pop();
  if (!judge) return false;
  state.discard.push(judge);
  // 判定是**八卦阵持有者**做的（「谁判定，判定牌就属于谁」）——
  // 小乔的黑桃判定牌视为红桃，所以她的八卦阵必定成功。
  const red = isRed(cardAsSeenBy(state, target, judge));
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
 * 装备给出的**额外摸牌数**（玉玺）。
 *
 * 【玉玺】锁定技，摸牌阶段，若你有处于**明置**状态的武将牌，额定摸牌数 +1。
 * 暗置的武将牌不算（这也是这条的官方条件）——所以国战里没明置时玉玺不生效。
 * OL 2026 版把原第①条「你所属势力成为唯一的大势力」移除了，这里按两条款实现。
 */
export function equipExtraDraw(state: GameState, player: Player): number {
  // 「装备着玉玺」也包含袁术·庸肆给的**虚拟**玉玺（判定收在 heroes.hasYuxi 里）
  if (!hasYuxi(state, player)) return 0;
  if (state.mode === 'guozhan' && !player.heroRevealed && !player.deputyRevealed) return 0;
  return 1;
}

/**
 * 白银狮子（锁定技）：受到的伤害大于 1 点时，防止多余的伤害。
 *
 * 在**所有加成算完之后**夹取（古锭刀/藤甲/裸衣加上去的部分也在被防止之列）——
 * 规则说的是「此伤害大于 1 点则防止多余」，看的是最终伤害值。
 * 青釭剑无视防具，所以被青釭剑打时白银狮子不生效。
 */
export function capDamageByBailong(
  state: GameState,
  target: Player,
  damage: number,
  source: Player | undefined,
): number {
  if (damage <= 1) return damage;
  if (target.equipment.armor?.equipName !== 'bailong') return damage;
  if (ignoresArmor(source)) return damage;
  pushLog(state, 'resolve', `${target.name} 的【白银狮子】防止了多余的伤害。`, {
    seat: target.seatId,
    action: 'shield',
  });
  return 1;
}

/**
 * 藤甲是否令群攻锦囊（南蛮入侵/万箭齐发）对该玩家无效。
 * 这两张锦囊均为无属性伤害，藤甲一律免疫。
 */
export function tengjiaNullifiesAoe(state: GameState, seatId: string, trickType: string): boolean {
  if (trickType !== 'nanman' && trickType !== 'wanjian') return false;
  const p = getPlayer(state, seatId);
  return p?.equipment.armor?.equipName === 'tengjia';
}

/** 七星宝刀：进入装备区时，弃置你判定区和装备区里所有其他牌 */
export function applyQixingSweep(state: GameState, player: Player, equipped: Card): Card[] {
  if (equipped.equipName !== 'qixing') return [];
  const swept: Card[] = [];
  for (const c of player.judgment) swept.push(c);
  player.judgment = [];
  const eq = player.equipment;
  for (const slot of EQUIP_SLOTS) {
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

/**
 * 【木牛流马】（宝物）在出牌阶段给出的主动技。
 *
 * 原牌面：出牌阶段限一次，你可以将一张手牌扣置于你装备区里的【木牛流马】下，
 * 若如此做，你可以将此装备移动到一名其他角色的装备区里；
 * 你可以将此装备牌下的牌如手牌般使用或打出。
 *
 * 「如手牌般使用或打出」这一半在引擎的使用/打出各条路上（usableCardsOf /
 * takeUsableCard）；这里只做「扣置 + 可选移动」这两步。
 * 官方 OL 2.112 版把牌面简化成「扣置，至多五张」，去掉了移动那一段——
 * 本实现按**原牌面（含移动）**做，另见 docs/guozhan-roster.md。
 */
const MUNIU_MAX_CARGO = 5;

export const MUNIU_SKILL: ActiveSkill = {
  id: 'muniu',
  name: '木牛流马',
  oncePerTurn: true,
  minTargets: 0,
  maxTargets: 0,
  canUse: (state, player) => {
    if (state.mode !== 'guozhan') return false;
    const equip = player.equipment.treasure;
    if (equip?.equipName !== 'muniu') return false;
    if (player.hand.length === 0) return false;
    return (equip.cargo?.length ?? 0) < MUNIU_MAX_CARGO;
  },
  execute: (state, player, _intent, api) => {
    const equip = player.equipment.treasure;
    if (equip?.equipName !== 'muniu') return '你没有装备【木牛流马】';
    if (player.hand.length === 0) return '你没有可以扣置的手牌';
    if ((equip.cargo?.length ?? 0) >= MUNIU_MAX_CARGO)
      return `【木牛流马】下已有 ${MUNIU_MAX_CARGO} 张牌`;
    const cargo: Card[] = equip.cargo ?? [];
    api.askPickCards(
      state,
      player.seatId,
      '【木牛流马】：选择一张手牌扣置于装备牌下',
      player.hand.slice(),
      1,
      1,
      (st, p, picked) => {
        const card = picked[0];
        const eq = p.equipment.treasure;
        if (!card || eq?.equipName !== 'muniu') return;
        const at = p.hand.findIndex((c) => c.id === card.id);
        if (at < 0) return;
        p.hand.splice(at, 1);
        const box = eq.cargo ?? (eq.cargo = []);
        box.push(card);
        pushLog(
          st,
          'equip',
          `${p.name} 将一张手牌扣置于【木牛流马】下（现有 ${box.length} 张）。`,
          { seat: p.seatId, action: 'equip' },
        );
        // 可选：把【木牛流马】（连辎一起）移动到一名其他角色的装备区
        const others = st.players.filter((x) => x.alive && x.seatId !== p.seatId);
        if (others.length === 0) return;
        api.askChoice(
          st,
          p.seatId,
          '【木牛流马】：是否将此装备移动到一名其他角色的装备区？',
          [
            { id: 'move', label: '移动' },
            { id: 'keep', label: '不移走' },
          ],
          (st2, p2, picked2) => {
            if (picked2 !== 'move') return;
            const eq2 = p2.equipment.treasure;
            if (eq2?.equipName !== 'muniu') return;
            api.askChoice(
              st2,
              p2.seatId,
              '【木牛流马】：移动到谁的装备区？',
              st2.players
                .filter((x) => x.alive && x.seatId !== p2.seatId)
                .map((x) => ({ id: x.seatId, label: x.name })),
              (_st3, _p3, targetSeatId) => {
                // moveFieldCard 会把装备牌对象整个搬过去，辎跟着牌一起走。
                // 外层捕获的 api 就够用——它闭包住的是**同一个** GameState 对象，
                // 再套一层回调也只是时间推后，状态还是那一个。
                api.moveFieldCard(eq2, targetSeatId);
              },
              // 这里**必须**再传一次 returnTo：技能 execute 里的询问每多一层，
              // 选完之后的 pending 就没人接管了（少了它整局会卡死）。
              p2.seatId,
            );
          },
          p.seatId,
        );
      },
      { returnTo: player.seatId },
    );
    return undefined;
  },
};

/** 装备牌带来的出牌阶段主动技（目前只有【木牛流马】） */
export function equipActiveSkills(state: GameState, player: Player): ActiveSkill[] {
  if (state.mode !== 'guozhan') return [];
  if (player.equipment.treasure?.equipName !== 'muniu') return [];
  return [MUNIU_SKILL];
}
