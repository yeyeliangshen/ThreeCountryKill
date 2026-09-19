// 装备牌特效 —— 与 engine 分离的纯查询/判定辅助，便于单测
import { isRed, type Card } from '@sgs/protocol';
import { getPlayer, pushLog, type AttackContext, type GameState, type Player } from './model';
import { addMarker, consumeMarker, markerCount } from './markers';
import { drawOne } from './deck';
import {
  EQUIP_SLOTS,
  cardAsSeenBy,
  effectiveHeroes,
  hasYuxi,
  type ActiveSkill,
  type SkillApi,
} from './heroes';

/**
 * 询问原语由引擎注入（见 `setEquipAskHooks`）——equip 是纯查询/判定模块，
 * 反向 import engine 会形成循环依赖，所以用注入。
 */
let askChoiceForEquip: (
  state: GameState,
  seatId: string,
  title: string,
  options: { id: string; label: string }[],
  resolve: (state: GameState, player: Player, picked: string) => void,
  returnTo?: string,
) => void = () => {};

let askPickCardsForEquip: (
  state: GameState,
  seatId: string,
  title: string,
  cards: Card[],
  min: number,
  max: number,
  resolve: (state: GameState, player: Player, picked: Card[]) => void,
  opts?: { returnTo?: string; secret?: boolean },
) => void = () => {};

/**
 * 「让某人弃掉自己的一批牌」——【盟军大纛】要用（弃的两张里可能有装备，得触发失去装备那类技能）。
 * 同样靠注入避开循环依赖。
 */
let discardCardsForEquip: (
  state: GameState,
  owner: Player,
  cards: Card[],
  after: () => void,
) => void = (_s, _o, _c, after) => after();

/** 引擎启动时把 askChoice / askPickCards / discardCards 注进来（engine.ts 顶层调用一次） */
export function setEquipAskHooks(h: {
  askChoice: typeof askChoiceForEquip;
  askPickCards: typeof askPickCardsForEquip;
  discardCards: typeof discardCardsForEquip;
}): void {
  askChoiceForEquip = h.askChoice;
  askPickCardsForEquip = h.askPickCards;
  discardCardsForEquip = h.discardCards;
}

/**
 * 这一次【杀】结算是否**无视目标防具**。
 *   青釭剑：装备者的所有【杀】都无视；
 *   徐庶·诛害的强化分支：只作用于**那一次**使用（`attack.ignoreArmor`，不永久关掉防具）。
 */
export function ignoresArmor(source: Player | undefined, attack?: AttackContext): boolean {
  if (attack?.ignoreArmor) return true;
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
  if (!armor || ignoresArmor(source, attack)) return null;
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
  if (ignoresArmor(source, attack)) return false;
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
    !ignoresArmor(source, attack)
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
  attack?: AttackContext,
): number {
  if (damage <= 1) return damage;
  if (target.equipment.armor?.equipName !== 'bailong') return damage;
  if (ignoresArmor(source, attack)) return damage;
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

/**
 * 【定澜夜明珠】（君主专属宝物）——
 * 「锁定技，你每回合首次弃置牌后，摸一张牌。当此牌离开你的装备区时，销毁之。」
 *
 * 口径：
 * - 触发时机＝**你的牌因弃置进入弃牌堆**（引擎的 `cardDiscarded`：弃牌阶段、技能/牌的代价、
 *   过河拆桥那类都算；「使用牌进弃牌堆、拼点亮牌、阵亡清牌」不算——与礼让同一口径）。
 *   ⚠️ 已知缺口：技能里那些「直接 toDiscard 的代价」（例如【君威】弃的那一张）没走
 *   `fireCardDiscarded`，所以不会触发它（本仓库的代价弃置一直是这样，见 §5.61 待核对）。
 * - 锁定技：不问、直接摸；「每回合」＝持有者自己的一回合（与【飞龙夺凤】同一口径，
 *   由 `flags.dinglanDoneThisTurn` 记账、在持有者的回合开始重置）。
 * - 它不是英雄技能，所以和【飞龙夺凤】【盟军大纛】一样由 engine 显式派发。
 */
export function dinglanAfterDiscard(state: GameState, owner: Player, after: () => void): void {
  if (owner.equipment.treasure?.equipName !== 'dinglan' || owner.flags.dinglanDoneThisTurn) {
    after();
    return;
  }
  owner.flags.dinglanDoneThisTurn = true;
  const card = drawOne(state);
  if (card) owner.hand.push(card);
  pushLog(
    state,
    'skill',
    `【定澜夜明珠】：${owner.name} 本回合首次弃牌${card ? '后摸一张牌' : '，但牌堆已空'}。`,
    { seat: owner.seatId },
  );
  after();
}

/**
 * 【盟军大纛】（君主专属宝物）——
 * 「当你受到伤害时，你可以弃置两张牌（弃置的其中一张牌可以是盟军大纛），然后你防止此伤害。
 *   当此牌离开装备区时，销毁之。」（用户核对后提供的牌面文本）
 *
 * 口径：
 * - 「受到伤害时」＝ 扣血之前（`damageStep` 的 damageDealt 时机）。防止走的是同一条通道：
 *   设 `holder.flags.damagePrevented = true`，引擎在钩子跑完之后读到就整条伤害作废
 *   （不扣血、不跑伤害后钩子、不进濒死）——与小乔·天香、护心镜一致。
 * - 弃的两张牌取自**持有者自己的**手牌＋装备区；其中一张可以是这张防具本身
 *   （于是它离开装备区 → `destroyOnLeave` 把它移出游戏）。手牌＋装备区一共不足两张时发不了。
 * - 它不是英雄技能，所以和【飞龙夺凤】一样由 engine 在伤害结算里显式派发。
 * - ⚠️ 待核对：同一时机可能有多个「受到伤害时」技能（天香等），本引擎固定让宝物先问；
 *   官方是按当前回合角色的选择决定结算顺序的（本仓库对同时机一律用固定顺序，见 roster）。
 */
export function mengjunDajun(state: GameState, holder: Player, after: () => void): void {
  // ⚠️ 它在**防具**槽（用户核对的牌面：装备牌·防具 红桃3），不是宝物槽
  if (holder.equipment.armor?.equipName !== 'mengjun') {
    after();
    return;
  }
  const pool: Card[] = [
    ...holder.hand,
    ...(EQUIP_SLOTS.map((s) => holder.equipment[s]).filter(Boolean) as Card[]),
  ];
  if (pool.length < 2) {
    after();
    return;
  }
  askChoiceForEquip(
    state,
    holder.seatId,
    '【盟军大纛】：是否弃置两张牌，以防止此伤害？',
    [
      { id: 'yes', label: '发动（弃两张牌，防止此伤害）' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') {
        after();
        return;
      }
      const cards = [...p.hand, ...(EQUIP_SLOTS.map((s) => p.equipment[s]).filter(Boolean) as Card[])];
      if (cards.length < 2) {
        // 期间牌被弄走了（理论上轮不到，兜底）
        after();
        return;
      }
      askPickCardsForEquip(
        st,
        p.seatId,
        '【盟军大纛】：选择要弃置的两张牌（其中一张可以是本宝物）',
        cards,
        2,
        2,
        (st2, p2, chosen) => {
          if (chosen.length < 2) {
            after();
            return;
          }
          pushLog(
            st2,
            'skill',
            `${p2.name} 发动【盟军大纛】：弃置两张牌，防止此伤害。`,
            { seat: p2.seatId },
          );
          discardCardsForEquip(st2, p2, chosen, () => {
            p2.flags.damagePrevented = true;
            after();
          });
        },
      );
    },
  );
}

/**
 * 【飞龙夺凤】（君主专属宝物）——
 * 「当你每回合首次使用【杀】对目标角色造成伤害后，你可以获得其一枚阴阳鱼标记或者一张手牌。
 *   当此牌离开装备区后，销毁之。」（移动版 WIKI 原文）
 *
 * 口径：
 * - 「使用【杀】造成伤害」＝ 这次伤害的生效牌是【杀】（`asType === 'sha'`，转化来的、丈八凑出来的
 *   虚拟杀都算）。⚠️ 还得要求**真有那么一张牌**（`cardId !== ''`）——技能直接造成的「虚拟伤害」
 *   （`api.dealDamage` 造的攻击上下文 `asType` 也是 'sha'，比如君曹操·雄驰）并没有使用任何【杀】，
 *   不加这个条件会被它骗出一次「每回合首次」；
 * - 「每回合首次」＝ 本回合没触发过（`flags.feilongDoneThisTurn`，回合开始时重置）；
 * - 「获得其一张手牌」由**持有者挑**：官方写「获得其一张牌」的，本引擎一律让获得者挑
 *   （与反馈/刚烈同一口径，见 docs/guozhan-roster.md）；
 * - 触发过就算数（选择「不发动」也消耗掉本回合的这次机会），官方是「首次…后，你可以」的一次性时机。
 * - 「离开装备区即销毁」由 `Card.destroyOnLeave` + `model.toDiscard` 统一处理。
 */
export function feilongAfterShaDamage(
  state: GameState,
  attacker: Player,
  victim: Player,
  attack: AttackContext,
  after: () => void,
): void {
  if (
    attacker.equipment.treasure?.equipName !== 'feilong' ||
    attack.asType !== 'sha' ||
    attack.cardId === '' // 技能造成的虚拟伤害没有使用任何【杀】
  ) {
    after();
    return;
  }
  if (attacker.flags.feilongDoneThisTurn) {
    after();
    return;
  }
  const hasMarker = markerCount(victim, 'yinyangyu') > 0;
  const hasHand = victim.hand.length > 0;
  if (!hasMarker && !hasHand) {
    after();
    return;
  }
  const options: { id: string; label: string }[] = [];
  if (hasMarker) options.push({ id: 'marker', label: `获得 ${victim.name} 的一枚【阴阳鱼】标记` });
  if (hasHand) options.push({ id: 'hand', label: `获得 ${victim.name} 的一张手牌` });
  options.push({ id: 'no', label: '不发动' });
  askChoiceForEquip(state, attacker.seatId, '【飞龙夺凤】：获得其标记或手牌？', options, (st, p, picked) => {
    p.flags.feilongDoneThisTurn = true;
    if (picked === 'marker') {
      consumeMarker(victim, 'yinyangyu');
      addMarker(p, 'yinyangyu');
      pushLog(st, 'skill', `${p.name} 因【飞龙夺凤】获得 ${victim.name} 的一枚【阴阳鱼】标记。`);
      after();
      return;
    }
    if (picked !== 'hand') {
      after();
      return;
    }
    askPickCardsForEquip(
      st,
      p.seatId,
      `【飞龙夺凤】：获得 ${victim.name} 的一张手牌`,
      victim.hand.slice(),
      1,
      1,
      (st2, p2, chosen) => {
        const c = chosen[0];
        if (c) {
          const idx = victim.hand.findIndex((x) => x.id === c.id);
          if (idx >= 0) victim.hand.splice(idx, 1);
          p2.hand.push(c);
          pushLog(st2, 'skill', `${p2.name} 因【飞龙夺凤】获得 ${victim.name} 的一张手牌。`);
        }
        after();
      },
    );
  });
}
