import type {
  Card,
  CardType,
  DamageAttribute,
  Faction,
  GameMode,
  Intent,
  RoleId,
  TrickType,
} from '@sgs/protocol';
import type { GuozhanExtensions, GuozhanRoomConfig } from './config';
import { applyDeckExtensions, applyPoolExtensions } from './extensions';
import { determineDualFaction, wenjiMarked } from './heroes';

import {
  CARD_TYPE_NAME,
  DAMAGE_CARD_TYPES,
  EQUIP_NAME,
  cardLabel,
  cardShortName,
  isDelayedTrick,
  isEquipCard,
  isInstantTrick,
  cardColor as cardColorOf,
  isBasicCard,
  isRecastable,
  isRed,
  isWuxieLike,
  zhangbaShaColor,
} from '@sgs/protocol';
import {
  alivePlayers,
  aliveSeatsFrom,
  emptyEquipment,
  emptyFlags,
  emptyMarkers,
  getPlayer,
  getPlayerOrThrow,
  heartCardsInDiscardThisTurn,
  healPlayer,
  nextAliveSeat,
  pushLog,
  toDiscard,
  type AttackContext,
  type ChainPending,
  type GameState,
  type Pending,
  type Player,
  type TrickContext,
} from './model';
import { attackRange, canTarget, distance } from './distance';
import {
  applyQixingSweep,
  armorNullifiesSha,
  capDamageByBailong,
  damageBonus,
  dinglanAfterDiscard,
  equipActiveSkills,
  equipExtraDraw,
  feilongAfterShaDamage,
  mengjunDajun,
  setEquipAskHooks,
  tengjiaNullifiesAoe,
  tryBaguaDodge,
} from './equip';
import { buildDeck, drawOne, shuffle } from './deck';
import {
  addMarker,
  consumeMarker,
  markerActiveSkills,
  markerCount,
  noteMarkerUsed,
} from './markers';
import {
  FACTION_NAME,
  getHero,
  getHeroForMode,
  hasCombo,
  poolForMode,
  effectiveHeroes,
  revealedHeroes,
  heroBlocksBeingTarget,
  heroCanUseAs,
  heroDuelShaRequired,
  fangyuanHandLimitDelta,
  heroIgnoresTrickDistance,
  heroShaLimit,
  EQUIP_SLOTS,
  armorCancelsFireTrick,
  bigFactions,
  immuneToChaining,
  isBigFaction,
  isMalePlayer,
  isSmallFaction,
  isSmallFactionCharacter,
  effectiveFaction,
  factionAliveCount,
  skillNameForField,
  unrevealedHeroes,
  cardAsSeenBy,
  suitSeenAs,
  colorSeenAs,
  huangtianFor,
  xuanhuoFor,
  hasYuxi,
  draftAllowsHero,
  factionGrantedActiveSkills,
  heroCanonicalId,
  knownFactionCount,
  sameHeroBody,

  sameKnownFaction,
  skillOnField,
  fengyangBlocksEquip,
  zhidaoTargetsBlocked,
  ROLE_NAME,
  type ActiveSkill,
  type Hero,
  type SkillApi,
} from './heroes';
import type { HookContext, HookRegistration, Timing } from './timing';

// —— 对外 API ——
export interface SeatSetup {
  seatId: string;
  name: string;
  // 新流程下不再传入：武将改为开局后随机发、各自选 1
  heroId?: string;
}

export type ApplyResult = { ok: true } | { ok: false; error: string };

const err = (message: string): ApplyResult => ({ ok: false, error: message });

/**
 * 让某个角色在若干选项里选一个（通用「选择一项」）。
 * 用法：askChoice(state, target, '选择一项', [{id:'a',label:'…'},{id:'b',label:'…'}],
 *   (st, p, picked) => { …按 picked 继续结算… });
 * 选完由 chooseOption 意图调用 resolve；若这次选择是某个技能在出牌阶段发起的，
 * 一定要传 returnTo（通常是发起技能的玩家），否则选完之后 pending 会停在
 * null，出牌方再也动不了——整局就卡死了。
 */
/**
 * 「输入槽」（`state.pending`）的**所有权围栏**——解决 lost update / ABA。
 *
 * 问题：收尾代码带着「我结束后应该回到出牌阶段」这个**旧世界的假设**去写 pending，
 * 但它执行期间钩子可能已经创建了一条**更新、更高优先级**的询问；收尾用旧假设覆盖它，
 * 那条询问就永远没人回答（四条 skip 的共同根因，见 docs §5.118/§5.124）。
 *
 * 规则（一句话）：
 * **收尾只能抢走「自己开始之前就存在、且期间从未被碰过」的 pending；
 *   一旦收尾执行期间产生了新的询问，那条询问拥有输入槽，收尾只能排队等它答完。**
 *
 * 判据 = `requestId`（是哪一次询问）**加上** `slotVersion`（从我拍快照后槽有没有被碰过）。
 * 只有 requestId 会栽在 ABA 上（旧 A → 被覆盖 → 又复原成同一个 A），所以要带版本号。
 */
export interface PendingCheckpoint {
  requestId: number | null;
  slotVersion: number;
}

/** 给**文档/测试**用的稳定 id：按对象身份发号，不改变 pending 的既有形状 */
const pendingIds = new WeakMap<object, number>();
let pendingIdSeq = 0;
function pendingIdOf(pending: object): number {
  let id = pendingIds.get(pending);
  if (id === undefined) {
    id = ++pendingIdSeq;
    pendingIds.set(pending, id);
  }
  return id;
}

/** 进入收尾前拍一张快照 */
export function capturePendingCheckpoint(state: GameState): PendingCheckpoint {
  const cur = state.pending;
  return {
    requestId: cur ? pendingIdOf(cur) : null,
    slotVersion: state.pendingSeq,
  };
}

/** 槽被任何人写过（set / clear / replace / answer / restore）时调用——版本号是围栏的另一半 */
export function notePendingSlotWrite(state: GameState): void {
  state.pendingSeq++;
}

/**
 * 收尾能不能占用输入槽：
 * - 槽是空的 → 可以；
 * - 槽里还是**我拍快照时那一份**、且版本号没变 → 可以（陈旧的旧 pending 允许抢回）；
 * - 否则（期间产生了新询问 / 被覆盖过又复原）→ **不可以**，收尾必须排队。
 */
export function canTakeOverPending(
  state: GameState,
  checkpoint: PendingCheckpoint,
): boolean {
  const cur = state.pending;
  if (!cur) return true;
  return (
    checkpoint.requestId !== null &&
    pendingIdOf(cur) === checkpoint.requestId &&
    state.pendingSeq === checkpoint.slotVersion
  );
}

/** 收尾收口的用法：`takeOverPendingIfUnchanged` 返回 false 时，调用方应把续接排进队列等它答完 */
export function takeOverPendingIfUnchanged(
  state: GameState,
  checkpoint: PendingCheckpoint,
  next: Pending,
): boolean {
  if (!canTakeOverPending(state, checkpoint)) return false;
  setPending(state, next);
  notePendingSlotWrite(state);
  return true;
}

/** 唤醒被围栏挡住、且所等的询问刚被回答的那些收尾待办（订阅式，不靠轮询） */
function runPendingWaiters(state: GameState): void {
  const waiters = state.pendingWaiters;
  if (waiters.length === 0) return;
  state.pendingWaiters = [];
  for (const run of waiters) runResume(run);
}

/**
 * **写输入槽的唯一入口**：赋值 + 推进版本号（`pendingSeq`）。
 *
 * 以后不要直接 `state.pending = ...`——版本号是「收尾所有权围栏」的另一半
 * （见 capturePendingCheckpoint / canTakeOverPending 与 docs §5.124），
 * 直接写会让围栏误判成「这个槽没人碰过」。
 */
export function setPending(state: GameState, next: GameState['pending']): void {
  state.pending = next;
  state.pendingSeq++;
}

export function askChoice(
  state: GameState,
  seatId: string,
  title: string,
  options: { id: string; label: string }[],
  resolve: (state: GameState, player: Player, optionId: string) => void,
  returnTo?: string,
): void {
  setPending(state, { kind: 'choice', seatId, title, options, resolve, returnTo });
}

/**
 * 让某个角色从给定的牌里选若干张（选牌原语）。
 *
 * 用法：`askPickCards(state, 郭嘉, '选择要交给别人的牌', 手牌, 0, 2, (st, p, picked) => {...})`
 *
 * `cards` 是引擎侧的真实牌对象——注意这些牌此刻可能还在某人的手牌里或牌堆顶，
 * **resolve 里要自己把它们搬走**（本函数不动任何牌）。
 * resolve 收到的是被选中的牌对象，省得再按 id 去查。
 *
 * 秘密选牌（观星看牌堆顶）传 `secret: true`，日志只记张数不记牌名。
 */
export function askPickCards(
  state: GameState,
  seatId: string,
  title: string,
  cards: Card[],
  min: number,
  max: number,
  resolve: (state: GameState, player: Player, picked: Card[]) => void,
  opts?: { returnTo?: string; secret?: boolean },
): void {
  setPending(state, {
    kind: 'pickCards',
    seatId,
    title,
    cards,
    // ⚠️ 兜底：池子比 min 少时按池子来。询问是**跨步**的——发起时算好的「能选几张」
    //    到回答时可能已经不成立（手牌被拿走、亮出的池子被分完），而 min 大于池子长度
    //    是**答不上来**的：fuzz 里出现过一局 20000 步纹丝不动（【恩怨】要求交一张手牌、
    //    池子却是空的）。真该做的是各处在发起前检查付得起——这条只是别把整局卡死。
    min: Math.min(min, cards.length),
    max,
    resolve,
    returnTo: opts?.returnTo,
    secret: opts?.secret,
  });
}

/**
 * 手牌上限：默认 = 当前体力；技能可以覆盖（周瑜·英姿 = 体力上限）。
 * 多个武将给出上限时取最宽松的那个，最后再加上本回合的标记加成（阴阳鱼）。
 */
function handLimit(state: GameState, player: Player): number {
  // ⚠️ 用 `effectiveHeroes`（唯一入口）而不是 `revealedHeroes`：断肠点名/借来的技能也要算
  const heroes = effectiveHeroes(state, player);
  // 曹节·约俭的「手牌上限视为体力上限」目前仍走 handLimitBonus（见 §5.100 的已知偏差说明），
  // 这一支保留给将来的覆盖语义实现：`handLimitSetToMaxHp` 打开时上限直接等于体力上限。
  if (player.flags.handLimitSetToMaxHp) return Math.max(0, player.maxHp);
  const base =
    heroes.length === 0
      ? Math.max(0, player.hp)
      : Math.max(0, ...heroes.map((h) => (h.handLimit ? h.handLimit(state, player) : player.hp)));
  // 阵法技（朱灵·方圆）：与方圆拥有者同一围攻关系的围攻者 +1、被围攻者 -1
  return base + player.flags.handLimitBonus + fangyuanHandLimitDelta(state, player);
}

function removeCard(hand: import('@sgs/protocol').Card[], id: string) {
  const i = hand.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const [c] = hand.splice(i, 1);
  return c ?? null;
}

/**
 * 【木牛流马】下面扣置的牌（「辎」）。
 * 持有者可以把它们**如手牌般使用或打出**，所以在「使用/打出」的每条路上，
 * 候选牌都应该是 `usableCardsOf` 的结果而不是 `player.hand`。
 *
 * 反过来说，**弃置**类的用法（重铸、火攻弃牌、连横、流离/天香那类）
 * 仍然只看手牌，见 docs/guozhan-roster.md 里的 FAQ 摘录。
 */
export function muniuCargoOf(player: Player): Card[] {
  const cargo = player.equipment.treasure?.cargo;
  return cargo && cargo.length > 0 ? cargo : [];
}

/** 可以「如手牌般使用或打出」的牌：手牌 + 木牛流马的扣置牌 */
export function usableCardsOf(player: Player): Card[] {
  // 手牌 + 木牛流马扣置的牌 + 武将牌上的「田」（邓艾·急袭把田当顺手牵羊用）
  return [...player.hand, ...muniuCargoOf(player), ...player.tian];
}

/**
 * 这张牌是不是武将牌上的「田」（邓艾·屯田）。
 *
 * 「田」**不是手牌**：它只有两个去处——① 通过【急袭】（主将技）当【顺手牵羊】使用；
 * ② 被【资粮】（副将技）交给同势力角色。所以它**不能当它本身那张牌使用或打出**
 * （不能拿一张「田」里的【闪】去响应【杀】、不能拿「田」里的【桃】救人），也**不能重铸**。
 * 凡是「像手牌一样用」的判定都要先把它挡掉。
 */
export function isTianCard(card: Card): boolean {
  return card.tian === true;
}

/** 「田」不能这样用时的报错文案（能用时返回 null） */
function tianBlocked(card: Card): string | null {
  return isTianCard(card)
    ? '「田」不能当手牌使用或打出（只能通过【急袭】当【顺手牵羊】）'
    : null;
}

/** 在「可使用/可打出」的范围里找一张牌（手牌优先，其次扣置区） */
export function findUsableCard(player: Player, cardId: string): Card | undefined {
  return (
    player.hand.find((c) => c.id === cardId) ??
    muniuCargoOf(player).find((c) => c.id === cardId) ??
    // 邓艾·急袭：武将牌上的「田」也可以当作牌使用
    player.tian.find((c) => c.id === cardId)
  );
}

/**
 * 从「可使用/可打出」的范围里取走一张牌。
 * 使用/打出扣置的牌 = 那张牌离开木牛流马（之后照常进弃牌堆/装备区）。
 */
function takeUsableCard(player: Player, cardId: string): Card | null {
  const inHand = removeCard(player.hand, cardId);
  if (inHand) return inHand;
  // 「田」（邓艾·急袭）：从武将牌上取走，取走后就不再是「田」了
  {
    const i = player.tian.findIndex((c) => c.id === cardId);
    if (i >= 0) {
      const [c] = player.tian.splice(i, 1);
      if (c) c.tian = false;
      return c ?? null;
    }
  }
  const cargo = player.equipment.treasure?.cargo;
  if (!cargo) return null;
  const i = cargo.findIndex((c) => c.id === cardId);
  if (i < 0) return null;
  const [c] = cargo.splice(i, 1);
  return c ?? null;
}

/**
 * 【丈八蛇矛】：两张手牌**当**【杀】。
 *
 * 造一张虚拟牌（`virtual: true`）：
 * - **颜色**按两张牌算——两红为红、两黑为黑、**一红一黑为无色**（`zhangbaShaColor`）。
 *   仁王盾只挡黑杀，所以一红一黑那两张凑出来的杀反而能破仁王盾，这条不能省。
 * - **无属性**（不是火杀/雷杀），所以藤甲的「普通杀无效」对它照常生效、铁索也不蔓延。
 * - 点数按规则是两张之和，但本引擎里没有读虚拟杀点数的地方（拼点用的是实体牌），
 *   所以只留 0；花色同理，`color` 才是可信的那一项。
 * - `materials` 记住两张**实体牌**：计价（`consumeCard`）与界面显示都要用。
 */
export function virtualShaFrom(cards: Card[], state?: GameState, owner?: Player): Card {
  return {
    id: `virtual-sha-${cards.map((c) => c.id).join('-')}`,
    type: 'sha',
    suit: 'spade',
    rank: 0,
    virtual: true,
    // 颜色按**使用者**的口径算：小乔·红颜时她的两张黑桃凑出来的是红杀（不是黑杀）
    color: zhangbaShaColor(cards.map((c) => cardAsSeenBy(state, owner, c))),
    materials: cards.slice(),
  };
}

/**
 * 「把这次用的/打出的那张牌从原处取走、放进弃牌堆」，取不到就返回 false（**别弃**）。
 *
 * ⚠️ 用牌和「收代价」之间隔着询问（无懈窗口、目标响应…），这期间牌可能已经离开原处
 *    （实测 seed=425：出的牌还没结算完，牌主先阵亡、手牌被清进了弃牌堆）。取不到还硬推，
 *    同一张牌就会在弃牌堆里出现两份。调用方拿到 false 应当就此作罢，别再把它放到别的地方。
 */
function takeAndDiscard(state: GameState, player: Player, card: Card): boolean {
  if (!takeUsableCard(player, card.id)) return false;
  toDiscard(state, card);
  return true;
}

/** 取一张「要放到场上（装备区/判定区）」的牌；取不到就报错，别把它再放到别处去 */
function takeForField(state: GameState, player: Player, card: Card): string | null {
  return takeUsableCard(player, card.id) ? null : '这张牌已经不在你手上了';
}

/**
 * 支付一张（可能是虚拟的）牌的代价：把它的实体牌从手牌/扣置区取走并置入弃牌堆。
 *
 * 普通牌就是收它自己；虚拟牌（丈八蛇矛的杀）收的是 `materials` 里的两张手牌——
 * 两张**同时**进弃牌堆（规则原文如此，也影响「本回合进入弃牌堆的红桃数」那类账本）。
 */
function consumeCard(state: GameState, player: Player, card: Card): void {
  const cards = card.materials && card.materials.length > 0 ? card.materials : [card];
  // ⚠️ 取不到的**不能再推一次**。用牌和「收代价」之间隔着询问（无懈窗口、目标响应…），
  //    这期间那张牌可能已经离开原处了——实测（seed=425）：出的牌还没结算完，牌主先阵亡、
  //    手牌被清空进弃牌堆，随后结算继续走这里，把已经在弃牌堆里的那张又推了一遍，
  //    同一张牌于是在弃牌堆里出现两份。
  const moved: Card[] = [];
  for (const c of cards) {
    if (takeUsableCard(player, c.id)) moved.push(c);
  }
  if (moved.length > 0) toDiscard(state, ...moved);
}

/**
 * 把「这次要用/打出哪张牌」解析成**实际生效的牌**。
 *
 * 平时就是 `intent.cardId` 那一张；带 `extraCardIds` 时是【丈八蛇矛】：
 * 一起使用两张手牌，生效的是一张虚拟【杀】。
 * 失败返回 `{ error }`（而不是 err()，方便调用方原样返回）。
 */
function resolveUsedCard(
  state: GameState,
  player: Player,
  intent: { cardId: string; extraCardIds?: string[] },
): { card: Card } | { error: string } {
  const extra = intent.extraCardIds ?? [];
  if (extra.length === 0) {
    const card = findUsableCard(player, intent.cardId);
    if (!card) return { error: '你没有这张牌' };
    return { card };
  }
  if (player.equipment.weapon?.equipName !== 'zhangba')
    return { error: '没有【丈八蛇矛】，不能把两张手牌当【杀】使用或打出' };
  const materials: Card[] = [];
  for (const id of [intent.cardId, ...extra]) {
    if (materials.some((c) => c.id === id)) return { error: '两张牌不能是同一张' };
    const c = findUsableCard(player, id);
    if (!c) return { error: '你没有这张牌' };
    // 「田」不是手牌，凑不进【丈八蛇矛】的两张里
    const tianErr = tianBlocked(c);
    if (tianErr) return { error: tianErr };
    materials.push(c);
  }
  // 官方文本是「**两张**手牌」，多一张少一张都不行
  if (materials.length !== 2) return { error: '【丈八蛇矛】需要正好两张手牌' };
  return { card: virtualShaFrom(materials, state, player) };
}

/**
 * 国战：返回已亮将的武将列表（暗将不返回）；非国战：返回主将（单元素数组）。
 *
 * 用 getHeroForMode 而不是 getHero——国战和军争的同名技能不一样。
 * 这里是引擎所有技能判定的唯一取将入口（canUseAs / shaLimit / hooks /
 * activeSkills 都从 activeHeroes 拿 Hero），所以按模式取一次就够了。
 */
export function activeHeroes(state: GameState, player: Player): Hero[] {
  return effectiveHeroes(state, player);
}

/** 鏖战：国战残局仅 2 个非野心家阵营存活时，桃可当杀使用 */
export function isAoyu(state: GameState): boolean {
  if (state.mode !== 'guozhan') return false;
  const alive = alivePlayers(state);
  // 用**真实**势力：鏖战是客观的残局条件（场上还剩几个势力），不是互相认同。
  // 暗置只是别人不知道，牌上的势力仍然在，所以暗置角色照样数进来。
  const factions = new Set(alive.map((p) => p.faction).filter((f) => f && f !== 'ambitionist'));
  return factions.size === 2;
  // 注：这里数的是「还剩几个阵营」，与 bigFactions 的「谁是大势力」不是一回事
}

/**
 * 国战：每张武将牌「明置」之后的一次性结算。
 *
 * 所有明文置的路径都要显式调用（见 revealHeroCard：主动明置 / 发动技能时 / 用转化技时）。
 * **不要**改成从 heroRevealed 标志推导——doDeath 阵亡时也会把两张牌置为已亮，
 * 那时不该发任何标记。
 *
 * - 先驱：全场第一个明置武将的玩家，只亮一张就发
 * - 阴阳鱼：双将首次同时明置，且两将体力之和为奇数（余半个阴阳鱼）
 * - 珠联璧合：双将首次同时明置，且构成官方组合
 */
function onHeroRevealed(state: GameState, player: Player): void {
  if (state.mode !== 'guozhan') return;

  if (state.xianquSeat === null) {
    state.xianquSeat = player.seatId;
    addMarker(player, 'xianqu');
    pushLog(state, 'marker', `${player.name} 是首个明置武将的角色，获得【先驱】。`);
  }

  // 阴阳鱼与珠联璧合都要等两张牌都亮出来
  if (!player.heroRevealed || !player.deputyRevealed) return;
  if (player.flags.revealRewarded) return;
  player.flags.revealRewarded = true;

  const main = getHero(player.heroId);
  const deputy = getHero(player.deputyHeroId);
  if (!main || !deputy) return;

  // 双将体力之和不是偶数就有「余下的半个阴阳鱼」。
  // 注意不能写 `% 2 === 1`——有武将的体力是半格（董昭 1.5），
  // 1.5+4=5.5，模 2 得 1.5 而不是 1。
  if ((main.maxHp + deputy.maxHp) % 2 !== 0) {
    addMarker(player, 'yinyangyu');
    pushLog(state, 'marker', `${player.name} 的双将体力之和为奇数，获得【阴阳鱼】。`);
  }
  if (hasCombo(main, deputy) || main.isLord || deputy.isLord) {
    const byLord = main.isLord || deputy.isLord;
    addMarker(player, 'zhulian');
    pushLog(
      state,
      'marker',
      byLord
        ? `${player.name} 的君主将与同势力武将珠联璧合，获得【珠联璧合】。`
        : `${player.name} 触发珠联璧合，获得【珠联璧合】。`,
    );
  }
}

/** 检查玩家是否可将 card 当 type 使用（含鏖战桃当杀） */
/**
 * 这张牌现在能不能被打出/使用（考虑「本回合不能使用或打出」的两条限制）。
 * 马岱·潜袭是按**颜色**限制手牌的，所以要看牌的颜色。
 */
export function blockedForPlay(player: Player, card: Card): string | null {
  if (player.flags.cannotPlayCardsThisTurn) return '你本回合不能使用或打出手牌';
  if (player.flags.cannotPlayColor && cardColorOf(card) === player.flags.cannotPlayColor) {
    return `你本回合不能使用或打出${player.flags.cannotPlayColor === 'red' ? '红' : '黑'}色手牌`;
  }
  return null;
}

/**
 * 转化技现在能不能用：它如果是**主将技/副将技**，那张武将牌得在对应位置上
 * （邓艾的【急袭】是主将技——邓艾当副将时，「田」就当不了【顺手牵羊】了）。
 * 与钩子那边的口径一致（那边在 collectTimingHooks 里按技能过滤）。
 */
function conversionAvailable(state: GameState, player: Player, hero: Hero): boolean {
  if (state.mode !== 'guozhan') return true;
  // 一个武将可能有**多个**提供转化能力的技能（卧龙诸葛亮：火计 / 看破），
  // 这里逐个看：只要有哪个转化技是主将技/副将技、而那张武将牌不在对应位置上，就不给用。
  // ⚠️ 已知口径：同一个人「一个转化技是主将技、另一个不是」的情况目前不存在
  //    （真出现时要按**牌→类型**分开判，那时得给技能也补一份「提供哪个类型转化」的信息）。
  const names = Object.entries(hero.skillFields ?? {})
    .filter(([, fields]) => fields.includes('canUseAs'))
    .map(([name]) => name);
  if (names.length === 0) return true;
  const blocked = names.some((name) => {
    if (hero.mainSlotSkills?.includes(name)) return player.heroId !== hero.id;
    if (hero.deputySlotSkills?.includes(name)) return player.deputyHeroId !== hero.id;
    return false;
  });
  return !blocked;
}

export function canUseAsCard(
  state: GameState,
  player: Player,
  card: Card,
  type: CardType,
): boolean {
  const heroes = activeHeroes(state, player);
  if (
    heroes.some(
      (h) => conversionAvailable(state, player, h) && heroCanUseAs(h, card, type, state, player),
    )
  ) {
    return true;
  }
  // 国战暗置：**预亮过**的转化技可以先用（真正打出去时由 revealForConversion 明置，
  // 见「发动技能时必须明置该武将」）。没预亮就当作不会——暗置武将没有技能。
  if (
    unrevealedHeroes(state.mode, player).some(
      (h) => conversionAvailable(state, player, h) && heroCanUseAs(h, card, type, state, player),
    )
  ) {
    const skillName = conversionSkillName(
      unrevealedHeroes(state.mode, player).find(
        (h) => conversionAvailable(state, player, h) && heroCanUseAs(h, card, type, state, player),
      )!,
    );
    // 用转化技必须先明置那张武将牌，所以被祸水封锁时这条也用不了
    if (skillName && player.prelitSkills.includes(skillName) && canRevealNow(state, player)) {
      return true;
    }
  }
  if (isAoyu(state) && type === 'sha' && card.type === 'tao') return true;
  return false;
}

/** 这个武将的转化能力（canUseAs）是哪个技能给的（读 skillFields 反查） */
function conversionSkillName(hero: Hero): string | null {
  for (const [name, fields] of Object.entries(hero.skillFields ?? {})) {
    if (fields.includes('canUseAs')) return name;
  }
  return null;
}

/**
 * 用转化技时必须明置提供该转化的武将。
 *
 * 在**牌真正被打出去**的路径上调用（出牌 / 打出响应）。暗置 + 已预亮的转化技
 * 到这里就明置；没预亮的变化本来就不会通过 canUseAsCard 的校验。
 */
function revealForConversion(state: GameState, player: Player, card: Card, as: CardType): void {
  if (state.mode !== 'guozhan') return;
  for (const hero of unrevealedHeroes(state.mode, player)) {
    if (!hero.canUseAs?.(card, as)) continue;
    const skillName = conversionSkillName(hero);
    if (!skillName || !player.prelitSkills.includes(skillName)) continue;
    revealHeroCard(state, player, hero);
  }
}

/**
 * 登记「本回合受到过伤害的角色」（董昭·劝进要用）。
 *
 * 放在钩子分发的入口上，而不是每个伤害点——伤害点有七八处，逐处加必然漏。
 * ⚠️ 两个入口都要调：runHooks 与 runHooksFrom（可挂起的那条路）——
 *    伤害路径大多走后者，只挂在前面会漏掉绝大多数伤害。
 */
function markDamaged(state: GameState, timing: Timing, player: Player, payload?: unknown): void {
  // 「你于本回合内造成过伤害吗」（蒋琬费祎·生息）：afterDamageDealt 是派给**来源**的，
  // 正好就是「谁造成的」那个视角。自伤不派发这个时机，所以自伤不算（已在注释里说明）。
  if (timing === 'afterDamageDealt') {
    player.flags.dealtDamageThisTurn = true;
    // 徐庶·诛害的强化条件：「该角色本回合有没有伤害过与徐庶**势力相同**的角色」。
    // 记「伤害发生那一刻」目标的已确定势力（effectiveFaction）——暗将之后亮出来不追溯。
    const ledgerAttack = (payload as { attack?: AttackContext } | undefined)?.attack;
    if (ledgerAttack?.targetId) {
      const victim = getPlayer(state, ledgerAttack.targetId);
      state.damageLedgerThisTurn.push({
        sourceId: player.seatId,
        targetId: ledgerAttack.targetId,
        targetFaction: victim ? effectiveFaction(state, victim) : null,
      });
    }
    // 本轮伤害账本（君主·励众）：按**来源**累加，一轮走完清空（见 afterTurnEnd 的回合交替处）
    const dmg = (payload as { damage?: number } | undefined)?.damage ?? 0;
    if (dmg > 0) {
      state.damageThisRound[player.seatId] = (state.damageThisRound[player.seatId] ?? 0) + dmg;
    }
    return;
  }
  // 「你于本回合内杀死过角色吗」（何太后·戚乱）
  if (timing === 'kill') {
    if (!state.killedThisTurn.includes(player.seatId)) state.killedThisTurn.push(player.seatId);
    return;
  }
  if (timing !== 'afterDamage') return;
  const dmg = (payload as { damage?: number } | undefined)?.damage ?? 0;
  if (dmg > 0 && !state.damagedThisTurn.includes(player.seatId)) {
    state.damagedThisTurn.push(player.seatId);
  }
  // 「本**阶段**受过伤的角色」（董昭·劝进）：伤被防止（dmg 0）不算
  if (dmg > 0 && !state.damagedThisPhase.includes(player.seatId)) {
    state.damagedThisPhase.push(player.seatId);
  }
}

/**
 * 登记「本回合出牌阶段用过的牌」（吕蒙·克己 / 谋断）。
 *
 * 借 useCard 钩子这一个公共入口登记，而不是在每条出牌路径上分别加代码——
 * 后者迟早会漏掉一两条路径，克己就会算错。
 *
 * 只记**自己的回合**且**出牌阶段**：借刀杀人逼别人打出的杀、夏侯渊在准备阶段
 * 用神速打出的虚拟杀，都不算「你于出牌阶段内使用过的牌」。
 */
function markCardUsed(state: GameState, timing: Timing, player: Player, payload?: unknown): void {
  // 刘琦·屯江要问的是「本回合出牌阶段有没有指定过其他角色」——就登记在这个统一入口里
  if (timing !== 'useCard') return;
  if (state.turn.phase !== 'play') return;
  if (state.seatOrder[state.turn.seatIndex] !== player.seatId) return;
  const card = (payload as { card?: Card } | undefined)?.card;
  if (!card) return;
  const kind: 'basic' | 'trick' | 'equip' = isEquipCard(card)
    ? 'equip'
    : isBasicCard(card)
      ? 'basic'
      : 'trick';
  const targets = (payload as { targetIds?: string[]; attack?: AttackContext } | undefined)
    ?.targetIds ??
    ((payload as { attack?: AttackContext } | undefined)?.attack
      ? [(payload as { attack?: AttackContext }).attack!.targetId]
      : []);
  // 【授锋】的「首张伤害牌」（君袁绍）就在这里登记：此刻正是「使用」的那一刻，
  // 而且上面几条过滤（自己回合 + 出牌阶段 + 使用者）正好就是「于其出牌阶段使用」。
  // ⚠️ 不能等结算结束再数——青龙偃月刀那种「第一张【杀】还没结算完又用出第二张」的情况下，
  //    第二张的结算会先结束，按结算顺序数会把第二张当首张（见 GameState.firstDamageCard）。
  if (state.firstDamageCard === null && DAMAGE_CARD_TYPES.has(card.type)) {
    // 「伤害牌」是**牌的类别**，不是「这次结算有没有真的造成伤害」——所以被【闪】掉的杀、
    // 被【无懈】掉的决斗照样算，登记在这里（使用时）而不是伤害发生后。
    // 同时把这次使用对应的**实体牌**记下来：丈八两张牌凑的虚拟【杀】对应那两张，
    // 纯「视为使用」的虚拟牌则没有实体牌（`materials` 为空且自己不是实体牌）。
    const physical = card.materials?.length ? card.materials.map((c) => c.id) : [card.id];
    state.firstDamageCard = {
      seatId: player.seatId,
      cardId: card.id,
      cardIds: physical,
      resolved: false,
    };
  }
  if (targets.length > 0) {
    const mine = effectiveFaction(state, player);
    const bad = targets.some((tid) => {
      const t = getPlayer(state, tid);
      if (!t || !t.alive) return false;
      const tf = effectiveFaction(state, t);
      return !mine || !tf || tf !== mine; // 未确定势力也算「其他势力」
    });
    if (bad) player.flags.targetedOtherFactionThisTurn = true;
  }
  // 刘琦·屯江：指定过**其他角色**（不看势力）。
  // ⚠️ AOE 那类目标由规则定死的牌（南蛮/万箭/桃园/五谷…）在 intent 里根本没有 targetIds，
  //    所以它们的目标在 startTrickResolution 里按「真正会影响谁」补登记；这里只管有明确目标的。
  if (targets.some((tid) => tid !== player.seatId)) player.flags.targetedOtherThisTurn = true;
  player.flags.usedCardsInPlayPhase.push({
    // 红颜：小乔用掉的黑桃要按红桃记账，否则克己（颜色不同）与谋断（四种花色）会算错
    suit: suitSeenAs(state, player, card),
    color: colorSeenAs(state, player, card) === 'red' ? 'red' : 'black',
    kind,
  });
}

// —— 钩子收集 ——

/**
 * 收集某个时机要跑的钩子：已明置武将的 + 暗置武将里**已预亮**的技能。
 *
 * 国战规则：暗置的武将牌没有任何技能，要发动必须先明置。线上用「预亮」把这两件事
 * 拆开——暗置时先声明「这个技能我想发动」，时机到了才询问（确认即明置并发动）。
 * 所以**没预亮的暗置技能不会进这个列表**，也就不会产生任何询问。
 *
 * `sync = true` 表示这条时机是同步派发的（runHooks），挂不起询问：
 * 这时预亮就直接当作「已经决定要发动」，明置并执行，不弹询问。
 */
function collectTimingHooks(
  state: GameState,
  player: Player,
  timing: Timing,
  sync: boolean,
): HookRegistration[] {
  const heroes = activeHeroes(state, player);
  const hooks = heroes.flatMap((hero) => {
    // 主将技 / 副将技：只有那张武将牌在对应位置时，这些**技能**才生效
    // （同一武将的其它技能不受影响；非国战没有副将位，所以主将技恒生效）
    const mainOk =
      state.mode !== 'guozhan' || player.heroId === hero.id || !hero.mainSlotSkills;
    const deputyOk =
      state.mode !== 'guozhan' || player.deputyHeroId === hero.id || !hero.deputySlotSkills;
    return (
      hero.hooks?.filter((h) => {
        if (h.timing !== timing) return false;
        if (h.skillId && hero.mainSlotSkills?.includes(h.skillId) && !mainOk) return false;
        if (h.skillId && hero.deputySlotSkills?.includes(h.skillId) && !deputyOk) return false;
        return true;
      }) ?? []
    );
  });
  hooks.push(...prelitHooks(state, player, timing, sync));
  hooks.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return hooks;
}

/** 暗置武将里预亮了 `timing` 这个时机技能的钩子 */
function prelitHooks(
  state: GameState,
  player: Player,
  timing: Timing,
  sync: boolean,
): HookRegistration[] {
  if (state.mode !== 'guozhan' || player.prelitSkills.length === 0) return [];
  const out: HookRegistration[] = [];
  for (const hero of unrevealedHeroes(state.mode, player)) {
    for (const h of hero.hooks ?? []) {
      if (h.timing !== timing) continue;
      if (!h.skillId || !player.prelitSkills.includes(h.skillId)) continue;
      // 锁定技没有「询问是否发动」这回事，自然也不能预亮
      if (h.locked) continue;
      out.push(
        sync ? autoRevealHook(state, player, hero, h) : askRevealHook(state, player, hero, h),
      );
    }
  }
  return out;
}

/** 可挂起时机：先问「是否明置并发动」，确认后明置再执行原钩子 */
function askRevealHook(
  state: GameState,
  player: Player,
  hero: Hero,
  h: HookRegistration,
): HookRegistration {
  return {
    ...h,
    handler: (ctx) => {
      // 注意：这里丢弃了原钩子的 `{cancel}` 返回值——询问已经把控制流交出去了，
      // 同步的取消语义传不回去。目前没有「会取消 + 需要预亮」的技能，先这样。
      ctx.api.askChoice(
        ctx.state,
        player.seatId,
        `【${h.skillId}】（已预亮）：是否明置【${hero.name}】并发动？`,
        [
          { id: 'yes', label: `明置【${hero.name}】并发动` },
          { id: 'no', label: '不发动' },
        ],
        (st, p, picked) => {
          if (picked !== 'yes') return;
          revealHeroCard(st, p, hero);
          h.handler(ctx);
        },
      );
    },
  };
}

/** 同步时机：挂不起询问，预亮即视为决定发动 */
function autoRevealHook(
  state: GameState,
  player: Player,
  hero: Hero,
  h: HookRegistration,
): HookRegistration {
  return {
    ...h,
    handler: (ctx) => {
      revealHeroCard(ctx.state, player, hero);
      return h.handler(ctx);
    },
  };
}

// 在某时机运行玩家已激活武将的触发钩子。返回 false 表示被取消。
function runHooks(state: GameState, timing: Timing, player: Player, payload?: unknown): boolean {
  markDamaged(state, timing, player, payload);
  markCardUsed(state, timing, player, payload);
  const hooks = collectTimingHooks(state, player, timing, true);
  // ⚠️ actor 必须给：`api.judge` / `api.grantSkill` 这类「默认作用于技能使用者」的接口
  //    靠它认人（useCard / beforeResolve 这些时机走的是这条同步分发）。
  const ctx: HookContext = {
    state,
    player,
    timing,
    payload,
    api: makeSkillApi(state, { actor: player.seatId }),
  };
  for (const h of hooks) {
    const res = h.handler(ctx);
    if (res && res.cancel) return false;
  }
  return true;
}

// —— 可挂起的钩子 ——
//
// 与 runHooks 的区别：允许钩子在中间发起「选择一项」（ctx.api.askChoice）。
//
// 不支持挂起的时机上，钩子若发起询问会被后续代码静默覆盖掉——这正是「刚烈/反馈
// 只能做简化版」的原因。想用钩子内询问的技能，必须挂在**转换过**的时机上。
//
// 已转换（runHooksPausable）：turnStart / playPhase / discardPhase / discardPhaseEnd /
//   turnEnd / othersTurnEnd / drawPhase / drawPhaseEnd / judgePhase / becomeTarget /
//   damageDealt / afterDamage / afterDamageDealt / afterHeal / equipLost / handEmptied /
//   nearDeath / kill / factionDetermined
// 仍是同步（runHooks）：useCard / beforeResolve / afterResolve / death
//   —— 预亮技能落在这些时机上时无法询问，只能「预亮即发动」（见 autoRevealHook）。

/**
 * 把「被询问打断的后续」压进队列；等 pending 空了由 drainResume 执行。
 *
 * ⚠️ 入队位置分两种，这是这套续接队列唯一容易弄错的地方（踩过：
 *   「恪守判定拿回判定牌 + 判红摸牌」被推迟了三个回合才执行）：
 *
 * - 从**主流程**入队（一个 intent 的同步执行里，且不在任何续接 / 询问回调里）：排到队尾。
 *   同一次同步执行里先挂起的是更内层的，要先醒；后来挂起的外层排它后面。
 *   （例：判定里问鬼才 → 判定续接排前面，伤害结算的续接排后面。）
 * - 从**续接内部**入队（正在跑某条续接，或正在跑某个询问的回答回调）：插到**队首**。
 *   它是比队里所有等待者都更内层的一层，必须紧接着醒。否则外层（例如伤害结算）会先跑完
 *   并把 pending 挂回去，队列就再也等不到「pending 为空」的时机——内层续接被永久搁置，
 *   那张牌一直攥在闭包里（模糊测试的牌张守恒检查就是这么报出来的：实测屯田/悲歌的判定牌
 *   被搁置 27-28 步，跨了好几个回合才归位）。
 */
function pushResume(state: GameState, fn: () => void): void {
  if (resumeDepth > 0) state.resumeQueue.unshift(fn);
  else state.resumeQueue.push(fn);
}

/** 当前「正在续接」的层数：>0 表示入队来自某条续接 / 询问回调内部（要插队首） */
let resumeDepth = 0;

/** 跑一段「续接」：队列里的条目、或某个询问的回答回调。期间入队的一律插队首 */
function runResume(fn: () => void): void {
  resumeDepth++;
  try {
    fn();
  } finally {
    resumeDepth--;
  }
}

/**
 * 这个 pending 算不算「场上没人被问话」（＝续接队列可以接着排）。
 *
 * `null` 与**弃牌阶段的占位空位**算；其余（choice / pickCards / respondSha …
 * 以及各种等待队列）都是「某个流程正在等回答」，必须等它答完。
 *
 * ⚠️ **出牌阶段的占位不算**，虽然它也是「等你动手」的空位：出牌阶段正是回合交替
 * 可能正在发生的窗口，那种时刻排队列会让回合交界处的流程执行两遍——试过放开，测试立刻
 * 抓到【双刃】没赢之后交出去的出牌阶段又被还回来、【戚乱】摸两次三张。
 * 弃牌阶段没有这个窗口（回合还没结束），放开它是安全的。
 */
function isIdlePending(pending: GameState['pending']): boolean {
  if (pending === null) return true;
  return pending.kind === 'discard';
}

/**
 * 排空续接队列。只在**每个 intent 处理完之后**调用一处，别散着调——
 * 它是「询问 → 续接」这条控制流的唯一收口。
 *
 * 循环条件带 `pending === null`：续接里如果又产生了新流程（濒死、下一次判定），
 * 就停下等那串流程走完，之后回到这里继续。队首永远是「最内层的等待者」，
 * 所以它被 pending 挡住是对的：那条 pending 正是它（或它的内层）发问的。
 */
function drainResume(state: GameState): void {
  // 兜底：续接互相触发形成死循环时别把进程挂死
  let guard = 0;
  // 被濒死打断的多步链（军令的逐个问、决绝的逐个结算、钩子链里打出的濒死）：
  // 它可能**没有**经过 resumePlay（例如钩子链里的伤害没有 resumeTo），所以这里也认一次——
  // 两处都从同一个队列里 shift，谁先到谁跑，不会跑两遍。
  while (isIdlePending(state.pending) && state.ongoingSkillChain.length > 0 && !state.gameOver) {
    if (++guard > 100) {
      pushLog(state, 'system', '续接队列超过 100 次，可能存在死循环，已中止。');
      state.ongoingSkillChain.length = 0;
      break;
    }
    runResume(state.ongoingSkillChain.shift()!);
  }
  // ⚠️ 「没人被问话」不只是 `pending === null`：出牌/弃牌阶段的 pending 只是**占位空位**
  //    （技能在阶段里发问靠的就是覆盖它接管控制权，见 askChoice 那段注释）。
  //    只认 null 的话，绝大多数意图结束时都留着占位空位，队列整步整步地被跳过——
  //    实测陈旧续接因此拖到十几步之后才醒（牌一直攥在闭包里，`seed=314` / `seed=1067`）。
  //    真正该拦住队列的是「有流程在等回答」（choice / pickCards / respondXxx …）。
  while (isIdlePending(state.pending) && state.resumeQueue.length > 0 && !state.gameOver) {
    if (++guard > 100) {
      pushLog(state, 'system', '续接队列超过 100 次，可能存在死循环，已中止。');
      state.resumeQueue.length = 0;
      break;
    }
    const fn = state.resumeQueue.shift()!;
    runResume(fn);
  }
}

/**
 * 回复体力 + 触发「回复体力后」的技能（甘夫人·淑慎）。
 *
 * **所有**回复体力的地方都要走这里（含技能里的 `api.heal`），否则淑慎会漏触发。
 * 只有实回量 > 0 才跑钩子：满体力时「回复」没发生，就不该触发。
 */
function healAndTrigger(state: GameState, player: Player, amount: number): number {
  // 军令·翻面（`cannotHealThisTurn`）：「本回合不能回复体力」。
  // ⚠️ 这个标记以前只被写、没被读——和同批另外两条军令条件一样（见 afterTurnEnd 的注释），
  //    顺手把它补上，军令才算四条都真的生效。濒死求桃**不走这里**（respondDeathSave 直接
  //    改 hp）：也就是「不能回复体力」挡不住救命的【桃】，这是本引擎的口径，等有明确
  //    FAQ 再改。
  if (player.flags.cannotHealThisTurn) {
    pushLog(state, 'skill', `${player.name} 本回合不能回复体力。`);
    return 0;
  }
  const healed = healPlayer(player, amount);
  if (healed > 0) {
    runHooksPausable(state, 'afterHeal', player, { amount: healed }, () => {});
  }
  return healed;
}

/**
 * 依次跑钩子，允许钩子在中间挂起询问。
 *
 * 钩子调用了 askChoice 时：① 后面的钩子先不跑，否则会覆盖掉这个 pending；
 * ② 把「跑剩下的钩子 + onDone」压进续接队列，等询问结束再继续。
 *
 * onDone(cancelled) 替代了 runHooks 的布尔返回值：cancel 时传 true。
 */
function runHooksPausable(
  state: GameState,
  timing: Timing,
  player: Player,
  payload: unknown,
  onDone: (cancelled: boolean) => void,
  attackBox?: AttackBox,
): void {
  const hooks = collectTimingHooks(state, player, timing, false);
  // 钩子发起的询问会**覆盖**掉当时的环境 pending（比如出牌阶段的 {kind:'play'}）。
  // 记下它：等整条钩子链跑完，如果调用方没有产生新的 pending，就把它还回去——
  // 否则出牌阶段的牌一打完（例如装装备触发枭姬）pending 就成了 null，玩家卡死。
  const ambient = state.pending;
  // 这条链的令牌：跑完就置死，用来拦住「排到很后面才醒」的陈旧续接（见 runHooksFrom 的注释）
  const token: ChainToken = { alive: true };
  runHooksFrom(
    state,
    player,
    timing,
    payload,
    hooks,
    0,
    (cancelled) => {
      token.alive = false;
      onDone(cancelled);
      if (state.pending === null && ambient && !state.gameOver) {
        setPending(state, ambient);
      }
    },
    attackBox,
    token,
  );
}

/**
 * 一条钩子链的「还在跑吗」令牌（见 `runHooksFrom` 的 ⚠️ 注释）。
 * 建链时 alive=true；链跑完（要调 onDone 之前）置 false。
 */
export interface ChainToken {
  alive: boolean;
}

function runHooksFrom(
  state: GameState,
  player: Player,
  timing: Timing,
  payload: unknown,
  hooks: HookRegistration[],
  from: number,
  onDone: (cancelled: boolean) => void,
  attackBox?: AttackBox,
  token?: ChainToken,
): void {
  // ⚠️ 这条链可能**已经跑完**：它被询问打断、续接排到了很后面，中途棋局翻篇
  //    （回合结束、角色阵亡…），等续接终于排到，链其实早就走完了。
  //    这时什么也别做——尤其**别调 onDone**：那等于把调用方的后续再执行一遍。
  //    实测（seed=425）：【杀】的 cardActionStarted 钩子链的 onDone 被第二次调用，
  //    `onPlayCard` 里「真正打出这张牌」的回调于是跑了两次 —— 同一张牌用了两次、
  //    进了两次弃牌堆，日志里已经阵亡的 P3 还又出了一张牌。
  if (token && !token.alive) return;
  markDamaged(state, timing, player, payload);
  // 「本回合出牌阶段用过的牌」（克己/谋断）与「指定过其他势力」（约俭）也在这里登记——
  // ⚠️ 只在**链条第一次**进入时记（from === 0）：这是个可挂起的时机，续接时会再进本函数，
  //    重复登记会让账本里同一张牌出现多次。
  if (from === 0) markCardUsed(state, timing, player, payload);
  for (let k = from; k < hooks.length; k++) {
    const res = hooks[k]!.handler({
      state,
      player,
      timing,
      payload,
      api: makeSkillApi(state, { attackBox, actor: player.seatId }),
    });
    if (res && res.cancel) {
      onDone(true);
      return;
    }
    // ⚠️ viewCards 也算「被问住了」：钩子里的「观看某人的暗置武将牌」是信息展示，
    //    没有 returnTo 可还（钩子链条得自己接着跑）。不认它的话，观看结束后 pending 会被
    //    置空、而链条那头以为没人打断继续往下走——玩家看完牌就卡在「谁的回合都不是」的状态里，
    //    或者被 returnTo 塞进某个人的出牌阶段（君刘备·章武「视为使用【先驱】」踩到过）。
    if (
      state.pending?.kind === 'choice' ||
      state.pending?.kind === 'pickCards' ||
      state.pending?.kind === 'viewCards'
    ) {
      pushResume(state, () =>
        runHooksFrom(state, player, timing, payload, hooks, k + 1, onDone, attackBox, token),
      );
      return;
    }
    // ⚠️ 已知缺口（本轮没修，见 docs §5.111）：钩子**间接**把某人打进**濒死**时
    //    （pending 变成 respondDeath 求桃队列）这里仍然直接接着跑，后面的流程
    //    （回合交接、下一张牌）会把求桃询问顶掉：被顶的人停在 0 体力却永远不死。
    //    试过在这里认 respondDeath 并把续接挂到 ongoingSkillChain——冒烟/模糊测试里
    //    大量对局卡在 4000 步不结束（钩子链的续接与濒死收口的次序纠缠在一起），
    //    所以先如实留在这里，等单独一轮把「钩子链 ↔ 濒死」的收口理清再修。
  }
  onDone(false);
}

/**
 * 伤害结算收尾：把 afterDamageDealt 派发给**伤害来源**。
 *
 * 狂骨这类「你造成的伤害」技能不能挂 afterDamage —— 那是派给受伤者的
 * （反馈/刚烈/奸雄在那边）。所以伤害落地后要额外给来源发一次。
 * 自伤（来源就是受伤者）不派发。
 *
 * 可挂起版本：after 是「伤害结算的后续」，走续接队列。
 */
function runDamageDealtHooksP(
  state: GameState,
  attack: AttackContext,
  damage: number,
  after: () => void,
): void {
  if (!attack.sourceId || attack.sourceId === attack.targetId) {
    after();
    return;
  }
  const src = getPlayer(state, attack.sourceId);
  if (!src || !src.alive) {
    after();
    return;
  }
  // 君主专属装备【飞龙夺凤】：「每回合首次使用【杀】造成伤害后…」是**装备牌**的效果，
  // 不走英雄钩子，所以在这里单独派发；它可能发问（选标记还是手牌），走续接。
  const victim = getPlayer(state, attack.targetId);
  const rest = (): void =>
    runHooksPausable(state, 'afterDamageDealt', src, { attack, damage }, after);
  if (victim) {
    feilongAfterShaDamage(state, src, victim, attack, rest);
    return;
  }
  rest();
}

// ——————————————————————————————————————————
// 回合流程
// ——————————————————————————————————————————

function startTurn(state: GameState, seatIndex: number): void {
  state.turn = { seatIndex, phase: 'judgment' };
  const player = getPlayerOrThrow(state, state.seatOrder[seatIndex]!);
  // 回合开始重置本回合标记
  player.flags = emptyFlags();
  // 「本回合受到过伤害的角色」也随回合清空
  state.damagedThisTurn = [];
  // 【雄驰】的「每回合第一次」同样按**每个回合**重算（不是只有自己的回合）
  state.xiongchiDoneSeats = [];
  // 【授锋】的「本回合出牌阶段的首张伤害牌」也是按回合算的
  state.firstDamageCard = null;
  // 「本回合用过哪些国战标记」（章武）
  state.markerUsesThisTurn = [];
  // 「本回合杀死过角色的人」同理（戚乱是在每个回合结束时检查的）
  state.killedThisTurn = [];
  // 「本回合从牌堆摸到过的牌」也只在**本回合**内有效（袁术·伪帝）
  state.gainedFromDeckThisTurn = [];
  state.deckGainOwner = {};
  // 寄篱「这张牌已经重跑过」同样只在**本回合**内有效（严白虎）
  state.extraResolvedCards = [];
  // 伤害事件账本（诛害的强化条件）也是「本回合」口径
  state.damageLedgerThisTurn = [];
  // 「本回合弃置账本」（苏飞·联翩）：**回合**口径——在回合开始时清，
  // 这样结束阶段读到的就是这一整个回合的弃置（含判定/摸牌/出牌/弃牌各阶段）
  state.turnDiscards = [];
  state.useDamages = [];
  state.xisheKilledSeat = null;
  state.lastDamageSourceId = '';
  state.lastDamageGeneratedBy = null;
  state.duwuWatchSeat = null;
  state.duwuRescued = false;
  state.liangfanHanIds = [];
  state.midaoUsedSeats = [];
  // 「本回合进入弃牌堆的牌」同样只在**本回合**内有效（孟获·再起）
  state.discardThisTurn = [];
  // 武将牌翻面朝上：跳过这一个回合，翻回正面（据守/放逐的代价）
  if (player.flipped) {
    player.flipped = false;
    pushLog(state, 'flip', `${player.name} 的武将牌翻回正面，跳过本回合。`);
    // ⚠️ 这里**不能**走 endTurn：那条路会跑结束阶段钩子，于是曹仁·据守会在被跳过的
    // 回合里再触发一次（又摸三张又翻面），翻面就来回循环了。
    // 跳过的回合没有阶段，直接交给下家。
    afterTurnEnd(state);
    return;
  }
  // 国战：**准备阶段开始时是唯一能主动明置武将牌的时机**（其余时候只能在「发动技能」
  // 时顺带明置）。先问这一句，再走准备阶段的其他钩子。
  askRevealAtTurnStart(state, player, () =>
    // 「其他角色的准备阶段」（士燮·礼下）：派给非回合玩家，payload 带正在开始回合的人。
    // 插在明置询问之后、准备阶段其余钩子之前——拆装备属于准备阶段的事。
    runOthersTurnStart(state, player.seatId, () =>
      askLordBanner(state, player, () => {
    // 整条回合流程都用可挂起钩子串起来：准备阶段的洛神/观星、判定阶段的鬼才
    // 都可能发起询问，问到一半不能把后面的阶段丢了。
        runHooksPausable(state, 'turnStart', player, undefined, () => {
          startJudgmentPhase(state, player);
        });
      }),
    ),
  );

  // 君主旗的授予在**君主自己的回合开始**时到期清掉（另见 clearLordGrants）
  clearLordGrants(state, player.seatId);
}

/**
 * 准备阶段开始时的明置询问（国战里**唯一**的主动明置时机）。
 *
 * 只在国战、且还有暗置武将牌时问。选项按当前能亮的牌拼：主将 / 副将 / 全部 / 暂不。
 *
 * 为什么这个询问不能省：常驻字段技（马超·马术、张飞·咆哮、小乔·红颜…）暗置时不生效，
 * 也没有「询问是否发动」这一步——**它们唯一的出场方式就是这个时机亮将**。
 *
 * ⚠️ 这里**不传 returnTo**：选完之后要接着跑的是「准备阶段剩下的流程」，
 * 而 returnTo 走的是 `resumePlay`（直接跳到出牌阶段），会把判定/摸牌阶段整个跳掉。
 * 所以由 resolve 自己调 `after()` 接回去。
 */
/**
 * 君主技发的「技能库」里能换的那几个（君曹操·建安 → 五子良将纛）。
 * 官方口径（用户核对后提供）：张辽·突袭 / 徐晃·断粮 / 张郃·巧变 / 乐进·骁果 / 于禁·节钺，
 * **不能选择场上已经存在的同名技能**。
 */
const LORD_BANNER_SKILLS: { heroId: string; name: string }[] = [
  { heroId: 'zhangliao', name: '突袭' },
  { heroId: 'xuhuang', name: '断粮' },
  { heroId: 'zhanghe', name: '巧变' },
  { heroId: 'lejin', name: '骁果' },
  { heroId: 'yujin', name: '节钺' },
];

/** 场上有没有活着的、已明置的、带某个势力「旗」（Hero.lordBanner）的武将——返回持有者 */
function bannerLordOf(state: GameState, faction: Faction): Player | null {
  for (const p of state.players) {
    if (!p.alive) continue;
    for (const h of activeHeroes(state, p)) {
      if (h.lordBanner === faction) return p;
    }
  }
  return null;
}

/** 这张武将牌是不是被「暂时不能明置」封着（君主旗的代价） */
function revealBlocked(state: GameState, player: Player, heroId: string): boolean {
  const g = player.lordGrant;
  if (!g) return false;
  if (g.blockedHeroId !== heroId) return false;
  const lord = getPlayer(state, g.lordSeatId);
  return !!lord?.alive; // 君主没了，封锁也该跟着解（在下一次准备阶段清理）
}

/**
 * 准备阶段：同势力君主的「旗」（君曹操·【建安】→ 五子良将纛）让本势力角色换一个技能。
 *
 * 官方口径（用户提供）：魏势力角色在自己的准备阶段，可以弃置一张牌，并令自己的一张暗置
 * 武将牌**暂时不能明置**，来获得「五子良将」中的一个技能，持续到君曹操的下个回合开始；
 * 不能选择场上已经存在的同名技能。
 *
 * 本引擎口径：同一时间只留一次换取（`Player.lordGrant` 一个槽）；换取之后技能进 `grantedSkills`
 * （永久授予那条路），由君主的回合开始清掉（见 startTurn）。
 */
function askLordBanner(state: GameState, player: Player, after: () => void): void {
  const mine = effectiveFaction(state, player);
  if (!mine || player.lordGrant) {
    after();
    return;
  }
  const lord = bannerLordOf(state, mine);
  if (!lord || lord.seatId === player.seatId) {
    after();
    return;
  }
  const hidden = unrevealedHeroes(state.mode, player);
  if (hidden.length === 0 || player.hand.length === 0) {
    after();
    return;
  }
  const avail = LORD_BANNER_SKILLS.filter((sk) => !skillOnField(state, sk.name));
  if (avail.length === 0) {
    after();
    return;
  }
  askChoice(
    state,
    player.seatId,
    `【建安】${lord.name} 的五子良将纛：是否换取一个技能？`,
    [
      { id: 'yes', label: '发动（弃一张牌；一张暗置武将牌暂时不能明置）' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') {
        after();
        return;
      }
      askPickCards(
        st,
        p.seatId,
        '【建安】：弃置一张牌',
        p.hand.slice(),
        1,
        1,
        (st2, p2, chosen) => {
          const cost = chosen[0];
          if (!cost) {
            after();
            return;
          }
          removeCard(p2.hand, cost.id);
          toDiscard(st2, cost);
          askChoice(
            st2,
            p2.seatId,
            '【建安】：哪张暗置武将牌暂时不能明置？',
            hidden.map((h) => ({ id: h.id, label: h.name })),
            (st3, p3, hid) => {
              const blocked = hidden.find((h) => h.id === hid) ?? hidden[0]!;
              askChoice(
                st3,
                p3.seatId,
                `【建安】：获得哪一个技能？（${blocked.name} 暂时不能明置）`,
                avail.map((sk) => ({ id: sk.heroId, label: sk.name })),
                (st4, p4, pickHeroId) => {
                  const pick = avail.find((sk) => sk.heroId === pickHeroId) ?? avail[0]!;
                  p4.grantedSkills.push({ heroId: pick.heroId, skillName: pick.name });
                  p4.lordGrant = {
                    skillHeroId: pick.heroId,
                    skillName: pick.name,
                    blockedHeroId: blocked.id,
                    lordSeatId: lord.seatId,
                  };
                  pushLog(
                    st4,
                    'skill',
                    `${p4.name} 借【建安】的五子良将纛获得【${pick.name}】；【${blocked.name}】暂时不能明置（直到 ${lord.name} 下个回合开始）。`,
                    { seat: p4.seatId, action: 'skill' },
                  );
                  after();
                },
              );
            },
          );
        },
      );
    },
  );
}

/** 清理某个君主发出的「五子良将纛」授予（君主的下个回合开始时调用） */
function clearLordGrants(state: GameState, lordSeatId: string): void {
  for (const p of state.players) {
    const g = p.lordGrant;
    if (!g || g.lordSeatId !== lordSeatId) continue;
    p.grantedSkills = p.grantedSkills.filter(
      (x) => !(x.heroId === g.skillHeroId && x.skillName === g.skillName),
    );
    const hero = getHeroForMode(g.blockedHeroId, state.mode) ?? getHero(g.blockedHeroId);
    pushLog(
      state,
      'skill',
      `【建安】：${hero?.name ?? '那张暗置武将牌'} 的封锁解除，${p.name} 失去【${g.skillName}】。`,
      { seat: p.seatId },
    );
    p.lordGrant = null;
  }
}

function askRevealAtTurnStart(state: GameState, player: Player, after: () => void): void {
  if (unrevealedHeroes(state.mode, player).length === 0) {
    after();
    return;
  }
  const mainHero = getHero(player.heroId);
  const deputyHero = getHero(player.deputyHeroId);
  // 君主将：亮一张就必须两张一起亮，所以只给「全部明置」
  const isLordPair = !!mainHero?.isLord || !!deputyHero?.isLord;
  const options: { id: string; label: string }[] = [];
  // 被君主旗「暂时不能明置」封着的武将牌不给选项（君曹操·建安 → 五子良将纛的代价）
  if (!isLordPair) {
    if (!player.heroRevealed && mainHero && !revealBlocked(state, player, mainHero.id))
      options.push({ id: 'main', label: `明置主将【${mainHero.name}】` });
    if (!player.deputyRevealed && deputyHero && !revealBlocked(state, player, deputyHero.id))
      options.push({ id: 'deputy', label: `明置副将【${deputyHero.name}】` });
  }
  options.push({ id: 'all', label: '全部明置' });
  options.push({ id: 'none', label: '暂不明置' });
  askChoice(state, player.seatId, '准备阶段：是否明置武将牌？', options, (st, p, picked) => {
    if (picked === 'main' && mainHero) revealHeroCard(st, p, mainHero);
    else if (picked === 'deputy' && deputyHero) revealHeroCard(st, p, deputyHero);
    else if (picked === 'all') {
      for (const hero of unrevealedHeroes(st.mode, p)) revealHeroCard(st, p, hero);
    }
    after();
  });
}

/** 判定阶段开始 */
function startJudgmentPhase(state: GameState, player: Player): void {
  state.turn.phase = 'judgment';
  // 跳过判定阶段（夏侯渊·神速）：整个阶段不处理，判定区的延时锦囊原样留着
  if (player.flags.skipJudgment) {
    pushLog(state, 'judge', `${player.name} 跳过判定阶段。`);
    afterJudgmentPhase(state, player);
    return;
  }
  runHooksPausable(state, 'judgePhase', player, undefined, () => {
    // 张郃·巧变是在**判定阶段一开始**才决定跳过的（标记在钩子里设），
    // 所以这个检查必须放在钩子之后——startJudgmentPhase 开头那次只看兵粮那类事先设好的。
    if (player.flags.skipJudgment) {
      pushLog(state, 'judge', `${player.name} 跳过判定阶段。`);
      afterJudgmentPhase(state, player);
      return;
    }
    processJudgmentPhase(state, player);
  });
}

/**
 * 判定阶段结束：继续到摸牌阶段。
 *
 * ⚠️ 这里以前还要补一次「hp<=0 → 进濒死」，因为闪电的伤害是就地扣血的；
 *    现在闪电走统一伤害层，濒死由那条链自己处理，这个补偿留着会**重复求桃**
 *    （除非死亡流程已经建好了队列——`pending` 非空就是那种情况）。
 */
function afterJudgmentPhase(state: GameState, player: Player): void {
  if (player.hp <= 0 && state.pending === null) {
    enterNearDeath(state, {
      sourceId: '', // 闪电无来源（同上）
      cardId: '',
      asType: 'shandian',
      targetId: player.seatId,
      damage: 3,
      dodged: false,
      attribute: 'thunder',
    });
    return;
  }
  continueTurnAfterJudgment(state, player);
}

/** 判定阶段后继续：摸牌 → 出牌（处理 skipDraw/skipPlay） */
function continueTurnAfterJudgment(state: GameState, player: Player): void {
  // 摸牌阶段：摸 2 张（兵粮寸断可跳过；英姿等技能可加量）
  state.turn.phase = 'draw';
  runHooksPausable(state, 'drawPhase', player, undefined, () => {
    doDrawPhase(state, player);
  });
}

/** 真正摸牌（drawPhase 钩子已经在前面跑完，可以读它们设的改量） */
function doDrawPhase(state: GameState, player: Player): void {
  if (!player.flags.skipDraw) {
    const heroes = revealedHeroes(state.mode, player);
    const heroExtra = heroes.length ? Math.max(0, ...heroes.map((h) => h.extraDraw ?? 0)) : 0;
    // 有条件的摸牌数修正（潘濬·聪察②）：与 extraDraw 一样按「取最大」参与叠加。
    // 摸牌阶段被跳过时根本走不到这里，所以不需要额外判跳过。
    const condExtra = heroes.length
      ? Math.max(0, ...heroes.map((h) => h.drawCountDelta?.(state, player) ?? 0))
      : 0;
    // 装备也能给（玉玺）——两者相加，不是取大
    const extra = heroExtra + condExtra + equipExtraDraw(state, player);
    // 阶段钩子可以改张数（裸衣/突袭的「少摸一张」= drawCountDelta -1）
    const count = Math.max(0, 2 + extra + player.flags.drawCountDelta);
    for (let i = 0; i < count; i++) {
      const c = drawOne(state);
      if (c) player.hand.push(c);
    }
    pushLog(state, 'draw', `${player.name} 摸了 ${count} 张牌。`);
  } else {
    // 原因由设 flag 的一方自己记（兵粮寸断在判定阶段已经记过），这里只记结果——
    // 否则夏侯渊·神速、颜良文丑·双雄跳过摸牌时会被误记成「被兵粮寸断影响」。
    pushLog(state, 'draw', `${player.name} 跳过摸牌阶段。`);
  }

  // 摸牌阶段结束时（裸衣在这个时机弃牌加伤害）
  runHooksPausable(state, 'drawPhaseEnd', player, undefined, () => {
    enterPlayPhase(state, player);
  });
}

/** 进入出牌阶段（乐不思蜀可跳过，直接进弃牌） */
function enterPlayPhase(state: GameState, player: Player): void {
  if (!player.flags.skipPlay) {
    state.turn.phase = 'play';
    // 新的一轮出牌阶段：清空「本阶段受过伤的人」（董昭·劝进的候选池）
    state.damagedThisPhase = [];
    state.suzhiTriggers = 0;
    state.discardPhaseCountsThisTurn = {};
    state.handDiscardedInDiscardPhase = [];
    state.juejueArmed = false;
    // 「每个出牌阶段限 N 次」的额度：新出牌阶段（含额外出牌阶段）重新发放
    player.flags.skillUsesThisPhase = {};
    runHooksPausable(state, 'playPhase', player, undefined, () => {
      // 张郃·巧变可能在出牌阶段一开始就跳过它（标记在钩子里设）——同样要在这之后判
      if (player.flags.skipPlay) {
        pushLog(state, 'trick', `${player.name} 跳过出牌阶段。`);
        goToDiscardPhase(state, player);
        return;
      }
      // 「**其他角色**的出牌阶段开始时」（何太后·鸩毒）：派给除他以外的所有人。
      // 放在玉玺与出牌 pending 之前——那是这个阶段的开场动作。
      runAllPlayersHooks(
        state,
        'othersPlayPhase',
        { turnSeatId: player.seatId },
        () => {
          // 玉玺（锁定技）：出牌阶段开始时，视为使用一张【知己知彼】。
          // 放在**设置出牌 pending 之前**——它是这个阶段的开场动作，结算完才轮到玩家正常出牌。
          askYuxiZhibi(state, player, () => {
            setPending(state, { kind: 'play', seatId: player.seatId });
          });
        },
        player.seatId,
      );
    });
  } else {
    pushLog(state, 'lebu', `${player.name} 被【乐不思蜀】影响，跳过出牌阶段。`);
    goToDiscardPhase(state, player);
  }
}

/** 进入弃牌阶段：检查手牌上限 */
function goToDiscardPhase(state: GameState, player: Player): void {
  // 「出牌阶段结束时」（董卓·暴凌）：只有这个阶段**真的发生过**才发——
  // 被乐不思蜀或巧变整个跳过的不算（那时 skipPlay 是 true）。
  if (state.turn.phase === 'play' && !player.flags.skipPlay) {
    const rest = (): void => {
      // 出牌阶段结束：所有人的「本阶段失去牌」计数清零（吕范·典财用）
      for (const pl of state.players) pl.flags.lostCardsThisPhase = 0;
      beginDiscardPhasePart(state, player);
    };
    runHooksPausable(state, 'playPhaseEnd', player, undefined, () => {
      // 「**其他角色**的出牌阶段结束时」（吕范·典财）：派给全场（技能自己排掉回合玩家）
      runAllPlayersHooks(
        state,
        'othersPlayPhaseEnd',
        { turnSeatId: player.seatId },
        rest,
      );
    });
    return;
  }
  beginDiscardPhasePart(state, player);
}

/** 弃牌阶段的实体部分（出牌阶段结束的钩子跑完之后进这里） */
function beginDiscardPhasePart(state: GameState, player: Player): void {
  state.turn.phase = 'discard';
  // 「与你势力相同的角色的弃牌阶段开始时」（卞夫人·约俭）：派给全场，技能自己按势力过滤
  runAllPlayersHooks(
    state,
    'othersDiscardPhase',
    { turnSeatId: player.seatId },
    () => {},
  );
  // 走可挂起版本：张郃·巧变要在这里问「是否弃一张牌跳过弃牌阶段」
  runHooksPausable(state, 'discardPhase', player, undefined, () => {
    if (player.flags.skipDiscard) {
      pushLog(state, 'discard', `${player.name} 跳过弃牌阶段。`);
      runDiscardPhaseEnd(state, player);
      return;
    }
    afterDiscardPhaseHooks(state, player);
  });
}

/** 弃牌阶段钩子跑完之后的正常流程（阴阳鱼 → 建弃牌 pending） */
function afterDiscardPhaseHooks(state: GameState, player: Player): void {
  // 阴阳鱼可以在弃牌阶段弃置，令本回合手牌上限 +2。
  // 只在这一阶段确实要弃牌时才问，否则等于白白消耗掉一个标记。
  if (
    state.mode === 'guozhan' &&
    markerCount(player, 'yinyangyu') > 0 &&
    player.hand.length - handLimit(state, player) > 0
  ) {
    askChoice(
      state,
      player.seatId,
      '是否弃置【阴阳鱼】标记，令本回合手牌上限 +2？',
      [
        { id: 'yes', label: '弃置阴阳鱼（本回合手牌上限 +2）' },
        { id: 'no', label: '不弃置' },
      ],
      (st, p, picked) => {
        if (picked === 'yes') {
          consumeMarker(p, 'yinyangyu');
          p.flags.handLimitBonus += 2;
          // 这一步也是「用掉了一枚国战标记」，一样要给章武记账——而且要记**这一条用法**
          // （弃牌阶段 = 手牌上限 +2，与出牌阶段的「摸一张」在章武那里是两个不同选项）
          noteMarkerUsed(st, p.seatId, 'yinyangyu', 'handLimit');
          pushLog(st, 'marker', `${p.name} 弃置【阴阳鱼】，本回合手牌上限 +2。`);
        }
        beginDiscard(st, p);
      },
      // 故意不传 returnTo：控制权不该回到出牌阶段，而是继续走弃牌流程
    );
    return;
  }
  beginDiscard(state, player);
}

/** 建立弃牌 pending；手牌没超上限就直接结束回合 */
function beginDiscard(state: GameState, player: Player): void {
  const over = player.hand.length - handLimit(state, player);
  if (over > 0) {
    setPending(state, { kind: 'discard', seatId: player.seatId, count: over });
  } else {
    runDiscardPhaseEnd(state, player);
  }
}

/**
 * 弃牌阶段结束：跑 `discardPhaseEnd` 钩子（孟获·再起），然后结束回合。
 *
 * 钩子是可挂起的——再起要连问好几个人，所以得等整条链跑完才能 `endTurn`，
 * 否则会在询问还没答完时就把回合交出去。
 */
function runDiscardPhaseEnd(state: GameState, player: Player, discarded: Card[] = []): void {
  runHooksPausable(state, 'discardPhaseEnd', player, {}, () => {
    // 「其他角色的弃牌阶段结束时」（张昭张纮·固政）：带上他这阶段弃掉的牌
    runAllPlayersHooks(
      state,
      'othersDiscardPhaseEnd',
      { discardingSeatId: player.seatId, cards: discarded },
      () => endTurn(state),
      player.seatId,
    );
  });
}

/** 判定阶段：逐张处理判定区延时锦囊 */
function processJudgmentPhase(state: GameState, player: Player): void {
  const judgments = player.judgment.slice();
  player.judgment = [];
  // 台账：这叠牌此刻不在任何区域（见 GameState.judgmentInFlight）。死了也要有人管它们。
  state.judgmentInFlight = { seatId: player.seatId, cards: judgments.slice() };
  judgmentStep(state, player, judgments, 0);
}

/** 逐张判定。beforeJudge 里可能挂起询问（鬼才/鬼道），所以用下标往下递 */
function judgmentStep(state: GameState, player: Player, judgments: Card[], index: number): void {
  if (index >= judgments.length) {
    state.judgmentInFlight = null;
    afterJudgmentPhase(state, player);
    return;
  }
  const trick = judgments[index]!;
  const judgeCard = drawOne(state);
  if (!judgeCard) {
    // 牌堆耗尽：剩下的判定牌直接进弃牌堆，判定阶段就此结束
    for (let k = index; k < judgments.length; k++) toDiscard(state, judgments[k]!);
    state.judgmentInFlight = null;
    afterJudgmentPhase(state, player);
    return;
  }
  pushLog(
    state,
    'judge',
    `${player.name} 判定：${cardLabel(judgeCard)}（${CARD_TYPE_NAME[trick.type]}）。`,
  );
  askBeforeJudge(state, trick, judgeCard, player.seatId, (finalCard, gainer) => {
    // 「继续下一张判定」交给 resolveJudgment 在**结算完之后**调：闪电的伤害是可挂起的
    // （小乔·天香就在那里发问），同步往下跑会把询问的 pending 覆盖掉。
    resolveJudgment(state, player, trick, finalCard, gainer, () =>
      judgmentStep(state, player, judgments, index + 1),
    );
  });
}

/**
 * 依次询问所有存活玩家是否替判（beforeJudge）。
 *
 * 原来的写法是两层 for 循环，但鬼才/鬼道要「选一张手牌替换」——那是询问，
 * 会把循环打断，所以摊成一条续接链：每个钩子跑完接着下一个，
 * 挂起时把「剩下的钩子」压进续接队列。
 *
 * 顺序与原来一致：按座次遍历玩家，同一玩家内按 priority 降序。
 *
 * onDone 除了最终判定牌，还给出「谁把判定牌收走了」（天妒）；
 * 没人收走则为 undefined，判定牌照旧进弃牌堆。
 */
function askBeforeJudge(
  state: GameState,
  // 技能判定（api.judge）没有对应的延时锦囊，payload.trick 就是 undefined
  trick: Card | undefined,
  judgeCard: Card,
  judgedId: string,
  onDone: (finalCard: Card, gainer: Player | undefined) => void,
): void {
  const list: { player: Player; hook: HookRegistration }[] = [];
  for (const p of state.players) {
    if (!p.alive) continue;
    const hooks = activeHeroes(state, p)
      .flatMap((h) => h.hooks?.filter((hk) => hk.timing === 'beforeJudge') ?? [])
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    for (const hk of hooks) list.push({ player: p, hook: hk });
  }
  judgeHookStep(state, list, 0, trick, judgeCard, judgedId, undefined, onDone, {
    dead: false,
  });
}
/**
 * 判定过程中钩子可以写入的决定。
 * 同步返还的用 HookResult（replaceCard / gainJudgeCard）；
 * 需要先询问再决定的走这里——钩子在询问的回调里写，引擎接着读。
 */
interface JudgeBox {
  replacement?: Card;
  gainer?: Player;
  /**
   * 这条判定链还活着吗（`askBeforeJudge` 建、链跑完时置 dead）。
   *
   * 为什么要它：钩子「先问玩家再决定」是**跨步**的，等玩家的回答回来时，这条判定链
   * 有可能已经结束了（例如那一步棋局已经翻篇、或者链被另一条询问挤掉）。
   * 这时钩子打出的那张手牌**无家可归**——以前它就这么没了（模糊测试的缺席守望器抓到：
   * 一张牌离开手牌后永远没回到任何区域）。有家才写盒子，没家就进弃牌堆。
   */
  chain?: { dead: boolean };
}

/**
 * 拼点过程中钩子可以写入的决定（鹰扬改点数）。
 * 与 JudgeBox 同理：钩子要先问玩家才知道改几，所以写盒子、由引擎的链读。
 */
interface PindianBox {
  rank?: number;
}

/** 成为【杀】目标时钩子可以写入的决定（流离那类改目标） */
interface AttackBox {
  redirectTo?: string;
}

function judgeHookStep(
  state: GameState,
  list: { player: Player; hook: HookRegistration }[],
  k: number,
  trick: Card | undefined,
  cur: Card,
  judgedId: string,
  gainer: Player | undefined,
  onDone: (finalCard: Card, gainer: Player | undefined) => void,
  chain: { dead: boolean },
): void {
  // ⚠️ 同 runHooksFrom：这条判定链可能早就跑完了，陈旧的续接醒来时别再跑一遍钩子
  //    （否则【鬼才】会对一个早已结算完的判定再问一次、甚至再打出一张牌）
  if (chain.dead) return;
  if (k >= list.length) {
    // 这条判定链到此为止：之后钩子再往盒子里写替换牌就「无家可归」了（见 JudgeBox.chain）
    chain.dead = true;
    onDone(cur, gainer);
    return;
  }
  const { player, hook } = list[k]!;
  const box: JudgeBox = { chain };
  const res = hook.handler({
    state,
    player,
    timing: 'beforeJudge',
    // judgedId：这是**谁的**判定。天妒这类技能只认自己的判定牌
    payload: { trick, judgeCard: cur, judgedId },
    api: makeSkillApi(state, { judgeBox: box }),
  });

  /** 把这个钩子的决定应用掉，然后跑下一个钩子 */
  const finish = (): void => {
    let next = cur;
    let nextGainer = gainer;
    // 同步返回的 replaceCard 与稍后才写进 box 的等价，后者用于「问了才知道」
    const replacement = res?.replaceCard ?? box.replacement;
    if (replacement) {
      toDiscard(state, next);
      next = replacement;
      pushLog(state, 'judge', `${player.name} 将判定牌替换为${cardLabel(next)}。`);
    }
    if (res?.gainJudgeCard || box.gainer) nextGainer = box.gainer ?? player;
    judgeHookStep(state, list, k + 1, trick, next, judgedId, nextGainer, onDone, chain);
  };

  // 钩子挂起了询问（鬼才挑牌）：等它选完再应用决定
  if (state.pending?.kind === 'choice' || state.pending?.kind === 'pickCards') {
    pushResume(state, finish);
    return;
  }
  finish();
}

/** 单张判定牌的结算（乐不思蜀 / 兵粮寸断 / 闪电） */
function resolveJudgment(
  state: GameState,
  player: Player,
  trick: Card,
  judgeCard: Card,
  gainer: Player | undefined,
  after: () => void,
): void {
  // 判定牌**属于判定者**（官方：「谁判定，判定牌就属于谁」），所以花色按对他的口径看——
  // 小乔·红颜：她的黑桃判定牌视为红桃（闪电劈不中她、乐不思蜀判黑桃也不中）。
  // 鬼才/鬼道换上来的牌同样算她的（改判者只是提供了牌，判定还是她做的）。
  const seen = cardAsSeenBy(state, player, judgeCard);
  switch (trick.type) {
    case 'lebu':
      // 乐不思蜀：非红桃 → 跳过出牌阶段
      if (seen.suit !== 'heart') {
        player.flags.skipPlay = true;
        pushLog(state, 'lebu', `${player.name} 被【乐不思蜀】影响，将跳过出牌阶段。`);
      } else {
        pushLog(state, 'lebu', `${player.name} 的【乐不思蜀】判定为红桃，无效。`);
      }
      untrackJudgmentCard(state, trick);
      toDiscard(state, trick);
      break;
    case 'bingliang':
      // 兵粮寸断：非梅花 → 跳过摸牌阶段
      if (seen.suit !== 'club') {
        player.flags.skipDraw = true;
        pushLog(state, 'bingliang', `${player.name} 被【兵粮寸断】影响，将跳过摸牌阶段。`);
      } else {
        pushLog(state, 'bingliang', `${player.name} 的【兵粮寸断】判定为梅花，无效。`);
      }
      untrackJudgmentCard(state, trick);
      toDiscard(state, trick);
      break;
    case 'shandian': {
      // 闪电：黑桃2-9 → 3点雷电伤害+弃闪电；否则 → 移到下家判定区
      // 小乔·红颜：她的黑桃判定牌视为红桃 → 永远劈不中（官方 FAQ 明确过这一条）
      if (seen.suit === 'spade' && judgeCard.rank >= 2 && judgeCard.rank <= 9) {
        pushLog(
          state,
          'shandian',
          `${player.name} 的【闪电】判定为黑桃${judgeCard.rank}，受到3点雷电伤害！`,
        );
        untrackJudgmentCard(state, trick);
        toDiscard(state, trick);
        // 判定牌先归位（天妒/进弃牌堆）**再**结算伤害：伤害那一层是可挂起的
        // （小乔·天香就在这儿发问），挂起后本函数剩下的代码不会再执行，
        // 归位留在后面就会把这张牌弄丢。
        disposeJudgeCard(state, judgeCard, gainer);
        // 闪电的伤害**无来源**（自伤），但照样走统一伤害层：天香、名士、
        // 白银狮子、护心镜、伤害后钩子都按同一条规则处理。
        const shandianAttack: AttackContext = {
          // ⚠️ 官方的闪电伤害**没有来源**——这里以前填了被劈者自己的座位，于是
          // 「伤害来源」被人为造了出来：刚烈/名士/从谏①、以及潘濬·【公清】都会把它
          // 当成一次有来源的伤害去读「来源的攻击范围」（雷电伤害被错误地改成 1 点）。
          // 空串＝无来源（引擎各处都按 `attack.sourceId ?` 判空）。
          sourceId: '',
          cardId: trick.id,
          asType: 'shandian',
          targetId: player.seatId,
          damage: 3,
          dodged: false,
          attribute: 'thunder',
        };
        damageStep(state, player, shandianAttack, 3, (dmg, prevented) => {
          if (prevented) {
            // 伤害被防止（天香）→ 人没事，判定阶段照常往下走
            after();
            return;
          }
          pushLog(
            state,
            'damage',
            `${player.name} 受到 ${dmg} 点雷电伤害，剩余 ${Math.max(0, player.hp)} 体力。`,
          );
          runDamagedHooks(state, player, shandianAttack, dmg, () => {
            // 濒死/阵亡由死亡流程接管，判定阶段不再继续（原实现也是这样分流的：
            // 人没了就不该再摸牌出牌，回合交给死亡流程收尾）
            if (player.hp <= 0) {
              enterNearDeath(state, shandianAttack);
              return;
            }
            after();
          });
        });
        return; // 判定牌已归位，剩下的判定由 after 接着跑
      } else {
        // 不触发 → 移到下家判定区
        const nextIdx = nextAliveSeat(state, state.seatOrder.indexOf(player.seatId));
        const nextPlayer = getPlayer(state, state.seatOrder[nextIdx]!);
        if (nextPlayer && nextPlayer.seatId !== player.seatId) {
          untrackJudgmentCard(state, trick);
          nextPlayer.judgment.push(trick);
          pushLog(
            state,
            'shandian',
            `${player.name} 的【闪电】判定不触发，【闪电】移到 ${nextPlayer.name} 的判定区。`,
          );
        } else {
          untrackJudgmentCard(state, trick);
          toDiscard(state, trick);
        }
      }
      break;
    }
    default:
      untrackJudgmentCard(state, trick);
      toDiscard(state, trick);
      break;
  }
  // 天妒：判定牌被某个技能收走了，就不进弃牌堆
  disposeJudgeCard(state, judgeCard, gainer);
  after();
}

/**
 * 把一张判定阶段的延时锦囊从台账里划掉（它已经归位：进弃牌堆 / 移到下家判定区 / 被收走）。
 * 归位点必须逐处调用——漏了就会在死亡清场时被当成「还在飞」而重复弃置（踩过：闪电那一支）。
 */
function untrackJudgmentCard(state: GameState, trick: Card): void {
  const ledger = state.judgmentInFlight;
  if (ledger) ledger.cards = ledger.cards.filter((c) => c.id !== trick.id);
}

/** 判定牌归位：天妒（被收走）或进弃牌堆。哨兵值是「已经归位过了」 */
const DISPOSED: Card = { id: '__disposed', type: 'sha', suit: 'spade', rank: 0 };

function disposeJudgeCard(state: GameState, judgeCard: Card, gainer: Player | undefined): void {
  if (judgeCard === DISPOSED) return;
  if (gainer) {
    gainer.hand.push(judgeCard);
    pushLog(state, 'skill', `${gainer.name} 获得了判定牌【${cardLabel(judgeCard)}】。`);
  } else {
    toDiscard(state, judgeCard);
  }
}

function endTurn(state: GameState): void {
  if (state.gameOver) return;
  const cur = getPlayerOrThrow(state, state.seatOrder[state.turn.seatIndex]!);
  // 结束阶段的钩子也可能挂起（闭月的「可以」）
  runHooksPausable(state, 'turnEnd', cur, undefined, () => {
    // 「其他角色的结束阶段」（乐进·骁果）：依次问其余存活玩家
    runOthersTurnEnd(state, cur.seatId, () => afterTurnEnd(state));
  });
}

/** 依次给「非回合玩家」派发 othersTurnEnd——每个人都可能发起询问 */
function runOthersTurnEnd(state: GameState, turnSeatId: string, after: () => void, i = 0): void {
  const others = state.players.filter((p) => p.alive && p.seatId !== turnSeatId);
  if (i >= others.length) {
    after();
    return;
  }
  const p = others[i]!;
  runHooksPausable(state, 'othersTurnEnd', p, { turnSeatId }, () =>
    runOthersTurnEnd(state, turnSeatId, after, i + 1),
  );
}

/** 结束阶段之后：先结算排队的额外回合，否则把回合交给下一个存活者（或判胜负） */
function afterTurnEnd(state: GameState): void {
  if (state.gameOver) return;
  /**
   * 「直到回合结束」的三项一起清：非锁定技失效、调虎离山的移出座次与不可被指定。
   *
   * ⚠️ 必须在**算完下家之后**才清：调虎离山正好要用「不在座次里」把这个人从环里跳过，
   * 先清掉再算下家就等于这一条没生效。所以这里只声明清理动作，实际调用见下面两处出口。
   * 也不能指望 emptyFlags()——它只清回合玩家，而这些标记可能挂在别人身上。
   */
  const clearTurnScoped = (): void => {
    for (const p of state.players) {
      p.flags.nonLockedSkillsDisabled = false;
      p.flags.removedFromSeating = false;
      p.flags.cannotBeTargetThisTurn = false;
      // 军令（董昭）的两条也是「本回合」语义。以前它们既没被读取、也没被清掉，
      // 所以「本回合不能使用或打出手牌」实际上是永久生效的——顺手一起修了。
      p.flags.cannotPlayCardsThisTurn = false;
      p.flags.cannotPlayColor = null;
      // 「直到回合结束」的临时技能（孙策·魂殇 / 法正·眩惑）
      p.tempGrantedSkills = [];
      p.flags.cannotHealThisTurn = false;
      // 奋迅的「你至其距离视为 1」＋严白虎·雉盗的「只能指定他与你」
      p.flags.distanceToOneThisTurn = null;
      p.flags.cardTargetOnlySeat = null;
    }
  };
  // 挟天子以令诸侯：本回合结束前若在弃牌阶段弃过牌，追加一个额外回合。
  // （读的是**回合玩家**的 flags；它们要等下一个 startTurn 才会被 emptyFlags 清掉，所以这里读得到。）
  const endingPlayer = getPlayer(state, state.seatOrder[state.turn.seatIndex]!);
  if (endingPlayer?.flags.xietianziPending && endingPlayer.flags.discardedInDiscardPhase) {
    pushLog(state, 'turn', `【挟天子以令诸侯】生效：${endingPlayer.name} 追加一个回合。`, {
      seat: endingPlayer.seatId,
      action: 'turn',
    });
    state.extraTurns.push(endingPlayer.seatId);
  }
  // 额外回合（刘禅·放权、挟天子以令诸侯）
  while (state.extraTurns.length > 0 && !state.gameOver) {
    const seatId = state.extraTurns.shift()!;
    const idx = state.seatOrder.indexOf(seatId);
    const p = idx >= 0 ? getPlayer(state, seatId) : undefined;
    if (!p || !p.alive) continue; // 该角色已经不在了，跳过
    pushLog(state, 'turn', `${p.name} 进行额外的一个回合。`);
    clearTurnScoped();
    startTurn(state, idx);
    return;
  }
  const next = nextAliveSeat(state, state.turn.seatIndex);
  clearTurnScoped(); // 下家算完了，本回合的临时标记可以清了
  if (next === state.turn.seatIndex) {
    // 兜底：仅剩 1 人 → 判胜负
    checkWin(state);
    if (!state.gameOver) {
      state.gameOver = true;
      setPending(state, null);
      state.turn.phase = 'gameOver';
      pushLog(state, 'gameover', '游戏结束。');
    }
    return;
  }
  // 「一轮」走完的标志：下一个回合的座次比当前**靠前**（正常推进只会往后跳，
  // 跳过已阵亡者也是往后；绕回首位才会变小）。君主·励众在「每轮结束时」结算，
  // 所以在这里先派发 roundEnd，再清账本、开新回合。
  if (next < state.turn.seatIndex) {
    dispatchRoundEnd(state, () => {
      // 新一轮：轮号先 +1，再派发「每轮开始时」（徐庶·荐才的获知挂在它上面），
      // 都走完才开这一轮的第一个回合。
      state.round += 1;
      state.damageThisRound = {};
      // 「每轮开始时」同样是**有钩子才走**：多一层可挂起嵌套会改变续接先后（教训见 beforeDamageApply）
      const needsRoundStart = state.players.some(
        (p) => p.alive && collectTimingHooks(state, p, 'roundStart', true).length > 0,
      );
      if (needsRoundStart) {
        dispatchRoundStart(state, () => startTurn(state, next));
      } else {
        startTurn(state, next);
      }
    });
    return;
  }
  startTurn(state, next);
}

/**
 * 派发「其他角色的准备阶段」（依次问每个**非**回合玩家，允许钩子挂起）。
 * 只被 `startTurn` 调用一次；payload 里的 turnSeatId 是正在开始回合的那个人。
 */
function runOthersTurnStart(state: GameState, turnSeatId: string, after: () => void, i = 0): void {
  const others = state.players.filter((p) => p.alive && p.seatId !== turnSeatId);
  if (i >= others.length) {
    after();
    return;
  }
  const p = others[i]!;
  runHooksPausable(state, 'othersTurnStart', p, { turnSeatId }, () =>
    runOthersTurnStart(state, turnSeatId, after, i + 1),
  );
}

/**
 * 派发「一轮开始」的钩子（依次问每个存活角色，允许钩子挂起）。
 * 只在这里被调用：回合交替检测到座次绕回首位、轮号 +1 之后（见 afterTurnEnd）。
 */
function dispatchRoundStart(state: GameState, after: () => void): void {
  const players = state.players.filter((p) => p.alive);
  const step = (i: number): void => {
    const p = players[i];
    if (!p) {
      after();
      return;
    }
    runHooksPausable(state, 'roundStart', p, {}, () => step(i + 1));
  };
  step(0);
}

/**
 * 派发「一轮结束」的钩子（依次问每个存活角色，允许钩子挂起）。
 * 只在这里被调用：回合交替检测到座次绕回首位时（见 afterTurnEnd）。
 */
function dispatchRoundEnd(state: GameState, after: () => void): void {
  const players = state.players.filter((p) => p.alive);
  const step = (i: number): void => {
    const p = players[i];
    if (!p) {
      after();
      return;
    }
    runHooksPausable(state, 'roundEnd', p, {}, () => step(i + 1));
  };
  step(0);
}

/** 回到某玩家的出牌阶段（伤害结算后恢复来源回合） */
function resumePlay(
  state: GameState,
  sourceId: string,
  /**
   * 收尾开始前的输入槽快照（可选）。给了就按围栏判：槽里若已经是**收尾期间新产生**的询问，
   * 这次就不抢槽、把「回出牌阶段」**排进续接队列**等它答完（docs §5.124 的规则）。
   */
  since?: PendingCheckpoint,
): void {
  if (state.gameOver) return;
  // 被濒死打断的多步链（军令逐个问、决绝逐个结算、钩子链里打出的濒死…）：先接着跑它们，
  // 别急着把出牌阶段占位 pending 摆回去（摆回去这些链就再也醒不过来了）。
  // 按**挂上的先后**醒（先挂的是更外层的等待者，它跑完自己会再调 resumePlay）。
  if (state.ongoingSkillChain.length > 0) {
    const run = state.ongoingSkillChain.shift()!;
    run();
    return;
  }
  // 铁索连环蔓延被濒死打断 → 先把剩下的人打完
  if (state.ongoingChain) {
    runChainSpread(state, () => resumePlay(state, sourceId));
    return;
  }
  // AOE 锦囊被濒死中断后，恢复时继续推进锦囊
  if (state.ongoingTrick) {
    const ctx = state.ongoingTrick;
    state.ongoingTrick = null;
    const source = getPlayer(state, ctx.sourceId);
    if (!source || !source.alive) {
      endTurn(state);
      return;
    }
    // 火烧连营是**伤害链**（不是响应队列），接着往下打
    if (ctx.skillId === 'huoshao') {
      huoShaoStep(state, ctx);
      return;
    }
    // 敕令是「依次做选择」的链，接着问下一个人
    if (ctx.skillId === 'chiling') {
      chilingStep(state, ctx);
      return;
    }
    advanceTrick(state, ctx);
    return;
  }
  const source = getPlayer(state, sourceId);
  if (!source || !source.alive) {
    endTurn(state);
    return;
  }
  // 判定阶段濒死恢复 → 继续到摸牌阶段
  if (state.turn.phase === 'judgment') {
    continueTurnAfterJudgment(state, source);
    return;
  }
  state.turn.phase = 'play';
  // ⚠️ 围栏判断**第五次尝试仍然暂不启用**：订阅式唤醒（runPendingWaiters）已经接好、
  //    唤醒点也确认会跑，但启用后冒烟依旧挂同样的 6 条（4 条固定种子判不出胜负 + 牌张守恒不变式）。
  //    说明问题不只在「什么时候醒」——**某些流程确实依赖收尾立刻把控制权抢回来**（不只是晚一点），
  //    单纯「不覆盖、延后」会改变它们的行为。⇒ 下一刀必须先**测量**：给被挡住的场合打日志/计数，
  //    看清到底是哪些收尾被挡、挡住后流程走向哪里，再决定是给它豁免（例如伤害/濒死/回合交接
  //    这三类白名单）还是改流程。别再盲改。
  void since;
  setPending(state, { kind: 'play', seatId: sourceId });
}

// ——————————————————————————————————————————
// 杀的结算
// ——————————————————————————————————————————

function playSha(
  state: GameState,
  source: Player,
  card: import('@sgs/protocol').Card,
  targetIds: string[],
  asType: import('@sgs/protocol').CardType,
  asAttribute?: DamageAttribute,
): ApplyResult {
  // 朱雀羽扇：可以把一张**普通**【杀】当具火焰伤害的【杀】使用。
  // 只认普通杀（火杀/雷杀不能被它改属性），且必须真的装备着这把扇子。
  if (asAttribute) {
    if (card.attribute) return err('只有普通【杀】能借【朱雀羽扇】改成火焰伤害');
    if (source.equipment.weapon?.equipName !== 'zhuque')
      return err('没有【朱雀羽扇】，不能把【杀】改成火属性');
  }
  const heroes = activeHeroes(state, source);
  // 诸葛连弩：本回合可出无限杀。另外加上「本回合次数 +N」（陆抗·筑围给当前回合角色）
  const hasZhuge = source.equipment.weapon?.equipName === 'zhuge';
  const maxSha = hasZhuge
    ? Infinity
    : Math.max(1, ...heroes.map(heroShaLimit)) + source.flags.shaLimitBonus;
  // 崔琰毛玠·征辟①：本回合对那名角色「使用牌无距离和次数限制」——
  // 目标里有他就跳过次数限制（距离那层由 distance() 放行）
  const limitless =
    !!source.flags.distanceLimitlessToSeat &&
    targetIds.includes(source.flags.distanceLimitlessToSeat) &&
    (() => {
      const t = getPlayer(state, source.flags.distanceLimitlessToSeat!);
      return !!t && unrevealedHeroes(state.mode, t).length > 0;
    })();
  // 刘琦·问计：被标记的那张**实体牌**「无使用次数限制」——既不受上限约束，也不计入次数
  const wenji = wenjiMarked(source, card.id);
  // 夏侯霸·豹烈②（接口是通用的「目标级豁免」）：**这批目标全都满足条件**才允许突破次数上限
  const bypassLimit = activeHeroes(state, source).some(
    (h) => h.shaBypassLimit?.(state, source, targetIds) === true,
  );
  if (!limitless && !wenji && !bypassLimit && source.flags.shaCountThisTurn >= maxSha)
    return err('本回合出杀数已达上限');
  // 目标数规则：方天画戟（同名两模式两套）+ 丁奉·短兵（额外一名距离 1 的）
  const rule = shaTargetRule(state, source, card);
  if (targetIds.length === 0) return err('杀需指定至少 1 名目标');
  if (targetIds.length > (rule?.max ?? 1)) {
    if (!rule) return err('杀需指定 1 名目标');
    return err(
      rule.max === 3
        ? '【方天画戟】至多额外指定两个目标（共 3 名）'
        : '目标数量超出限制（【方天画戟】/【短兵】决定了上限）',
    );
  }
  const seenTargets = new Set<string>();
  const usedFactions = new Set<string>();
  for (const [index, targetId] of targetIds.entries()) {
    if (targetId === source.seatId) return err('不能对自己使用杀');
    if (seenTargets.has(targetId)) return err('目标不能重复');
    seenTargets.add(targetId);
    const target = getPlayer(state, targetId);
    if (!target || !target.alive) return err('目标无效');
    // 锁定技（空城等）：不能成为此牌的目标
    if (heroBlocksBeingTarget(state, target, card, source)) return err('该角色不能成为此牌的目标');
    // 距离校验：攻击范围 ≥ 距离（天义拼点赢则本回合无视距离）
    // 夏侯霸·豹烈②：**目标级**的无距离限制（只对满足条件的目标放行，其余照常判距离）
    const noDistanceToTarget = activeHeroes(state, source).some(
      (h) => h.ignoreShaDistanceTo?.(state, source, targetId) === true,
    );
    if (
      !source.flags.ignoreShaDistanceThisTurn &&
      !wenji &&
      !noDistanceToTarget &&
      !canTarget(state, source.seatId, targetId)
    )
      return err('目标超出攻击范围');
    // 短兵多出来的那一名必须是**距离 1** 的角色（方天画戟给的名额不受这条约束）
    if (rule && rule.extraAtRange1 > 0 && index >= rule.baseMax) {
      const d = distance(state, source.seatId, targetId);
      if (d !== 1) return err('【短兵】额外指定的目标必须距离为 1');
    }
    // 国战版才有「势力各不相同」的约束：暗置（未确定势力）的角色不受限，明置的势力不能重复
    if (rule?.distinctFactions) {
      const f = effectiveFaction(state, target);
      if (f !== null) {
        if (usedFactions.has(f)) return err('【方天画戟】指定的目标势力必须各不相同');
        usedFactions.add(f);
      }
    }
  }

  startAttack(state, source, card, targetIds, asType, {
    asAttribute,
    abortOnDodge: rule?.abortOnDodge,
  });
  return { ok: true };
}

/**
 * 把一串目标按**座次顺序**排好（从使用者的下家起绕一圈）。
 * 只保留在场上的目标——传进来的都是校验过的，这里是防御性的。
 */
function sortTargetsBySeat(state: GameState, sourceSeatId: string, targetIds: string[]): string[] {
  const order = aliveSeatsFrom(state, nextSeatAfter(state, sourceSeatId));
  const sorted = order.filter((sid) => targetIds.includes(sid));
  // 万一有目标不在存活座次里（理论上不会），按原顺序补在后面，别把它弄丢
  for (const sid of targetIds) if (!sorted.includes(sid)) sorted.push(sid);
  return sorted;
}

/**
 * 【杀】能指定几个目标、以及有什么附加约束。
 *
 * 两处来源合在一起算：
 * - **【方天画戟】**（同名两张牌、两个模式两套效果，见 fangtianRule）；
 * - **丁奉·短兵**：额外给一个名额，但那个名额必须指定**距离 1** 的角色
 *   （`extraAtRange1`，由 playSha 校验；方天画戟给的名额不受这条约束）。
 *
 * 返回 null 表示只能指定 1 名目标。
 */
function shaTargetRule(
  state: GameState,
  source: Player,
  card: Card,
): {
  max: number;
  baseMax: number;
  extraAtRange1: number;
  distinctFactions: boolean;
  abortOnDodge: boolean;
} | null {
  const base = fangtianRule(state, source, card);
  const extra = activeHeroes(state, source).some((h) => h.shaExtraTargetAtRange1) ? 1 : 0;
  if (!base && extra === 0) return null;
  const baseMax = base?.max ?? 1;
  return {
    max: baseMax + extra,
    baseMax,
    extraAtRange1: extra,
    distinctFactions: base?.distinctFactions ?? false,
    abortOnDodge: base?.abortOnDodge ?? false,
  };
}

/**
 * 【方天画戟】的规则——**同名两张牌，两个模式两套效果**，只按模式区分：
 *
 * - **国战版**（势备篇）：可以指定**任意名势力各不相同**的角色，以及任意名未确定势力
 *   （暗置）的角色；当此【杀】被一名目标出【闪】抵消时，**对其他目标全部无效**
 *   （`abortOnDodge`——所以它是逐个结算、一有人闪就停）。
 * - **军争版**（身份局）：只有当这张【杀】是**你最后的手牌**时，才可以**额外**指定至多
 *   两个目标（共 3 名）；每个目标各自独立结算，谁闪谁不闪互不影响。
 *
 * 返回 `null` 表示这张牌没有方天画戟的加成（只能指定 1 名目标）。
 */
function fangtianRule(
  state: GameState,
  source: Player,
  card: Card,
): { max: number; distinctFactions: boolean; abortOnDodge: boolean } | null {
  if (source.equipment.weapon?.equipName !== 'fangtian') return null;
  if (state.mode === 'guozhan') {
    return { max: Number.POSITIVE_INFINITY, distinctFactions: true, abortOnDodge: true };
  }
  // 军争版：「若是你最后的手牌」看的是**使用的那一刻**——手上只有这一张杀。
  // 注意木牛流马扣置的牌不算手牌（它只是「如手牌般使用」），所以这里只数 player.hand。
  const isLastHandCard = source.hand.length === 1 && source.hand[0]!.id === card.id;
  if (!isLastHandCard) return null;
  return { max: 3, distinctFactions: false, abortOnDodge: false };
}

/**
 * 从「目标已校验、准备出牌」开始走一遍【杀】的结算。
 *
 * playSha 校验完调它；青龙偃月刀继续出杀也复用它——那条路不校验距离与次数。
 * `targetIds` 超过一个只可能来自【方天画戟】：第一个目标先结算，其余留在
 * `attack.fangtianQueue` 里逐个接着打（见 afterAttackSettled）。
 */
function startAttack(
  state: GameState,
  source: Player,
  card: import('@sgs/protocol').Card,
  targetIds: string[],
  asType: import('@sgs/protocol').CardType,
  opts?: { countTowardLimit?: boolean; asAttribute?: DamageAttribute; abortOnDodge?: boolean },
): void {
  // 多目标按**座次顺序**结算：官方规则里目标是同时确定的，效果从使用者的下家起
  // 按座次依次生效。不排一下的话，国战版「一人闪则其余无效」就变成谁点得快谁占便宜。
  const ordered = sortTargetsBySeat(state, source.seatId, targetIds);
  const targetId = ordered[0]!;
  const target = getPlayerOrThrow(state, targetId);
  // 【丈八蛇矛】的虚拟杀在这里收的是两张 material 手牌（见 consumeCard）
  consumeCard(state, source, card);
  // 青龙偃月刀追加的【杀】不计入本回合出杀次数；刘琦·问计标记的那张也不计
  // （「无使用次数限制」= 用它不消耗本回合的出杀数，否则等于只是「白送一次」）
  if (opts?.countTowardLimit !== false && !wenjiMarked(source, card.id))
    source.flags.shaCountThisTurn++;

  // 酒 buff：本回合下一张杀伤害 +1
  let damage = 1;
  if (source.flags.jiuActive) {
    damage = 2;
    source.flags.jiuActive = false;
  }

  const attack: AttackContext = {
    sourceId: source.seatId,
    cardId: card.id,
    // 技能新造的虚拟牌（寄篱）把来源标记带进来：技能侧靠它防止「再生的牌又触发自己」
    ...(card.generatedBy ? { generatedBy: card.generatedBy } : {}),
    asType,
    targetId,
    damage,
    dodged: false,
    // 朱雀羽扇改的是属性，不是牌面本身
    attribute: opts?.asAttribute ?? card.attribute,
    // 颜色按**使用者**的口径看：小乔·红颜把她的黑桃【杀】变成红桃，
    // 于是她的黑桃杀能破【仁王盾】（官方 FAQ：仁王盾是否生效看杀属于谁）
    cardColor: colorSeenAs(state, source, card),
    // 刘琦·问计：被标记的那张实体牌「不能被其他角色响应」→ 走「不可闪避」那条通道
    // （与铁骑/烈弓同一处判定：跳过出闪询问，八卦阵/护驾那类代打也一并跳过）
    requiredShan: wenjiMarked(source, card.id) ? Infinity : 1,
    // 本次【杀】一共指定了几个目标（严白虎·寄篱只认「唯一目标」）
    totalTargets: ordered.length,
    // 这次使用指定的**全部**目标名单（界钟会·权计要「唯一目标就是挨打的那位」）
    declaredTargets: ordered.slice(),
    // 本次「使用牌」的编号（许攸·成略要把伤害绑回这一次使用）
    cardUseId: ++state.cardUseSeq,
    // 【方天画戟】：其余目标排在这里，逐个结算
    fangtianQueue: ordered.slice(1),
    // 国战版「一人闪则其余无效」；军争版各目标独立结算
    fangtianAbortOnDodge: opts?.abortOnDodge === true,
  };
  const attr = opts?.asAttribute ?? card.attribute;
  const who =
    ordered.length > 1
      ? ordered.map((id) => getPlayerOrThrow(state, id).name).join('、')
      : target.name;
  // 【丈八蛇矛】：把「用哪两张牌凑的」写进日志，不然牌数对不上会让人以为是 bug
  const viaZhangba =
    card.materials && card.materials.length > 0
      ? `（【丈八蛇矛】${card.materials.map((c) => `【${cardLabel(c)}】`).join(' + ')}）`
      : '';
  pushLog(
    state,
    'sha',
    `${source.name} 对 ${who} 使用了${opts?.asAttribute ? '火' : ''}【杀】${viaZhangba}。`,
    { seat: source.seatId, action: attr ? `sha-${attr}` : 'sha' },
  );
  // useCard 是**可挂起**的时机：钩子可能发问（孙策·激昂那次「是否摸一张」、马超·铁骑的
  // 技能判定现在也会经过「判定牌生效前」让鬼才发问），所以后续步骤必须放进回调里，
  // 否则询问会被紧随其后的成为目标/结算覆盖掉（本引擎的老坑）。
  // 「**其他**角色使用牌时」：`useCard` 只派给使用者本人（旁观者技能如张鲁·米道收不到），
  // 所以这里单独派一圈给其他玩家。⚠️ 必须在 `useCard` 链**外面**先派：嵌在链内部的话，
  // 旁观的询问会被续接队列的嵌套顺序挤掉（与 beforeDamageApply 踩过的是同一个坑）。
  runOthersUseCard(state, source.seatId, { attack, card }, () =>
    runHooksPausable(state, 'useCard', source, { attack, card }, () => {
      // 成为【杀】目标**不会**自动亮将（国战规则里没有这个时机）。暗置的玩家要用
      // 【倾国】【龙胆】这类转化技，得事先预亮——用出去的那一刻才明置（revealForConversion）。
      becomeTargetFor(state, target, attack);
    }),
  );
}

/**
 * 「成为【杀】目标」的结算入口。
 *
 * 可以被流离那类技能改目标——改了就对**新目标**重新走一遍这一步
 * （被动亮将、新目标的 becomeTarget 钩子、防具、八卦、等出闪）。
 */
function becomeTargetFor(state: GameState, target: Player, attack: AttackContext): void {
  // 先派发「一名角色成为【杀】目标后」给全场（徐盛·疑城那类「别人的事」），
  // 再走目标自己的 becomeTarget（改目标/防具/八卦/出闪）。
  runAllPlayersHooks(
    state,
    'othersBecomeTarget',
    { targetId: target.seatId, attack },
    () => becomeTargetSelf(state, target, attack),
  );
}

/** 目标自己的「成为目标后」：becometarget 钩子 → 雌雄/享乐/防具/八卦/出闪 */
function becomeTargetSelf(state: GameState, target: Player, attack: AttackContext): void {
  const box: AttackBox = {};
  runHooksPausable(
    state,
    'becomeTarget',
    target,
    { attack },
    (cancelled) => {
      if (cancelled) {
        // becomeTarget 被取消 → 自动闪避（如八卦阵/被动闪避技）
        attack.dodged = true;
        finishAttack(state, attack);
        return;
      }
      // 流离那类：目标被改掉了，对新目标重新走一遍。
      // 只允许改一次——否则两个都会改目标的技能能让这张杀来回弹、死循环。
      if (box.redirectTo && box.redirectTo !== target.seatId && !attack.redirected) {
        const newTarget = getPlayer(state, box.redirectTo);
        // 严白虎·雉盗：本回合他「只能指定自己与锁定角色」——**改目标也要守**。
        // 2026 官方社区规则题明确过：他锁定大乔后，大乔不能把这张【杀】流离给第三人。
        // 来源（这张杀的使用者）身上挂着限制时，新目标必须仍在合法范围内。
        const src = getPlayer(state, attack.sourceId);
        const blocked =
          !!src &&
          src.flags.cardTargetOnlySeat !== null &&
          newTarget !== undefined &&
          newTarget.seatId !== src.seatId &&
          newTarget.seatId !== src.flags.cardTargetOnlySeat;
        if (newTarget && newTarget.alive && !blocked) {
          attack.targetId = newTarget.seatId;
          attack.redirected = true;
          pushLog(state, 'skill', `此【杀】的目标改为 ${newTarget.name}。`);
          // 新目标同样不会被自动亮将（见 startAttack 处的说明）
          becomeTargetFor(state, newTarget, attack);
          return;
        }
      }
      afterShaBecomeTarget(state, target, target.seatId, attack);
    },
    box,
  );
}

/** 成为【杀】目标之后：先结算武器特效，再走防具 / 不可闪避 / 八卦阵 */
function afterShaBecomeTarget(
  state: GameState,
  target: Player,
  targetId: string,
  attack: AttackContext,
): void {
  // 雌雄双股剑：指定异性目标后，由目标选择一项
  if (tryCixiongSwords(state, target, attack)) return;
  afterShaTargetResolve(state, target, targetId, attack);
}

/** 雌雄双股剑结算完之后的部分（防具 / 不可闪避 / 八卦阵 / 等出闪） */
function afterShaTargetResolve(
  state: GameState,
  target: Player,
  targetId: string,
  attack: AttackContext,
): void {
  // 刘禅·享乐：使用者先决定弃不弃一张基本牌（不弃则此【杀】对刘禅无效）
  if (tryXingle(state, target, attack)) return;

  // 防具令此杀无效（仁王盾：黑杀；藤甲：普通杀）
  const nullified = armorNullifiesSha(state, attack);
  if (nullified) {
    pushLog(state, 'resolve', `${target.name} 的【${nullified}】令此【杀】无效。`, {
      seat: target.seatId,
      action: 'shield',
    });
    attack.dodged = true;
    finishAttack(state, attack);
    return;
  }

  // 不可闪避（马超·铁骑/黄忠·烈弓判定为红色或满足条件）；
  // 以及彭羕·嚣逆那种**按玩家**的「该目标不能响应此牌」
  if (attack.requiredShan === Infinity || attack.unrespondableTargets?.includes(target.seatId)) {
    finishAttack(state, attack);
    return;
  }

  // 八卦阵：需要出闪时自动判定，红色则视为出闪
  if (tryBaguaDodge(state, attack)) {
    pushLog(state, 'resolve', `${target.name} 的【八卦阵】判定为红色，视为出【闪】。`);
    // 「视为使用【闪】」同样触发「你使用或打出【闪】」的时机（张角·雷击）
    runHooksPausable(state, 'shanUsed', target, { attack }, () => {
      attack.dodged = true;
      finishAttack(state, attack);
    });
    return;
  }

  // 暂停：等待目标响应（出闪或弃权）
  setPending(state, { kind: 'respondSha', responderId: targetId, attack });
}

/**
 * 刘禅·享乐（锁定技）：当你成为一名角色使用【杀】的目标后，除非其弃置一张基本牌，
 * 否则令此【杀】对你无效。
 *
 * 三处细节：
 * - 是**锁定技**，所以刘禅这边没有「发不发动」的询问；要选的是**使用者**那边。
 * - 使用者没有基本牌 → 没什么可弃的，直接判无效（不弹空询问）。
 * - 弃完要继续走「防具 / 八卦 / 等出闪」那一段，所以在这里打个 `xingleChecked` 记号，
 *   否则回到本函数时会再问一次。
 *
 * 位置：在雌雄双股剑之后、防具之前（都在「成为目标后」这个时机里）。
 * 返回 true 表示这次调用已经接管了后续（挂起了询问，或者已经判了无效）。
 */
function tryXingle(state: GameState, target: Player, attack: AttackContext): boolean {
  if (attack.xingleChecked || attack.dodged) return false;
  if (!activeHeroes(state, target).some((h) => h.xingleBasicDiscard === true)) return false;
  const source = attack.sourceId ? getPlayer(state, attack.sourceId) : undefined;
  if (!source || !source.alive || source.seatId === target.seatId) return false;
  attack.xingleChecked = true;
  const nullify = (): void => {
    pushLog(state, 'resolve', `${target.name} 的【享乐】令此【杀】无效。`, {
      seat: target.seatId,
      action: 'shield',
    });
    attack.dodged = true;
    finishAttack(state, attack);
  };
  const basics = source.hand.filter((c) => isBasicCard(c));
  if (basics.length === 0) {
    nullify();
    return true;
  }
  askChoice(
    state,
    source.seatId,
    `【享乐】：弃置一张基本牌，否则此【杀】对 ${target.name} 无效`,
    [
      { id: 'discard', label: '弃置一张基本牌' },
      { id: 'no', label: '不弃置（此【杀】无效）' },
    ],
    (st, p, picked) => {
      if (picked !== 'discard') {
        nullify();
        return;
      }
      askPickCards(
        st,
        p.seatId,
        '【享乐】：弃置一张基本牌',
        p.hand.filter((c) => isBasicCard(c)),
        1,
        1,
        (st2, p2, chosen) => {
          const card = chosen[0];
          if (!card) {
            nullify();
            return;
          }
          discardOwnCard(st2, p2, card, () =>
            afterShaTargetResolve(st2, target, target.seatId, attack),
          );
        },
      );
    },
  );
  return true;
}

/**
 * 雌雄双股剑：使用【杀】指定**异性**角色为目标后，令其选择一项——
 * 弃置一张手牌，或让使用者摸一张牌。
 *
 * 返回 true 表示挂起了询问（调用方不要再改 pending）。
 */
function tryCixiongSwords(state: GameState, target: Player, attack: AttackContext): boolean {
  const source = attack.sourceId ? getPlayer(state, attack.sourceId) : undefined;
  if (!source || !source.alive) return false;
  if (source.equipment.weapon?.equipName !== 'cixiong') return false;
  // 只对异性目标生效（双方性别相同就没事）
  if (isMalePlayer(state, source) === isMalePlayer(state, target)) return false;

  const after = (st: GameState): void => {
    afterShaTargetResolve(st, target, target.seatId, attack);
  };
  // 目标没手牌时「弃置一张手牌」做不到，就不摆这个选项了
  const options: { id: string; label: string }[] = [
    { id: 'draw', label: `令 ${source.name} 摸一张牌` },
  ];
  if (target.hand.length > 0) {
    options.unshift({ id: 'discard', label: '弃置一张手牌' });
  }
  askChoice(
    state,
    target.seatId,
    `${source.name} 的【雌雄双股剑】：请选择一项`,
    options,
    (st, p, picked) => {
      if (picked === 'draw') {
        const c = drawOne(st);
        if (c) source.hand.push(c);
        pushLog(st, 'equip', `${p.name} 令 ${source.name} 摸一张牌（雌雄双股剑）。`);
        after(st);
        return;
      }
      askPickCards(
        st,
        p.seatId,
        '【雌雄双股剑】：选择要弃置的一张手牌',
        p.hand.slice(),
        1,
        1,
        (st2, p2, chosen) => {
          for (const c of chosen) {
            removeCard(p2.hand, c.id);
            toDiscard(st2, c);
          }
          pushLog(st2, 'equip', `${p2.name} 弃置 ${chosen.length} 张手牌（雌雄双股剑）。`);
          after(st2);
        },
      );
    },
  );
  return true;
}

/** 失去装备区的一张牌之后（枭姬 / 白银狮子回血）。可挂起：它挂在装备变动路径上，和伤害链一样要能被询问打断 */
function fireEquipLost(
  state: GameState,
  owner: Player,
  card: Card,
  after: () => void,
  event?: { id: number; cards: Card[] },
): void {
  const isBailong = card.equipName === 'bailong';
  const payload = {
    card,
    cards: event?.cards ?? [card],
    eventId: event?.id ?? ++state.equipLossSeq,
  };
  runHooksPausable(state, 'equipLost', owner, payload, () => {
    // 白银狮子（锁定技）：离开装备区时你回复 1 点体力。
    // 放在触发技之后跑——「失去装备区牌」是它离开这件事本身，先结算钩子再结算它。
    if (!isBailong || !owner.alive) {
      after();
      return;
    }
    const healed = healAndTrigger(state, owner, 1);
    pushLog(state, 'tao', `${owner.name} 的【白银狮子】离开装备区，回复 ${healed} 点体力。`, {
      seat: owner.seatId,
      action: 'tao',
    });
    after();
  });
}

/**
 * 一个动作失去**多张**装备：逐张派发（每张都可能触发枭姬那类「每张都算」的技能），
 * 但整批**共用一个 eventId** ——凌统·旋略的官方口径是「一次失去只触发一次」，
 * 它按 eventId 去重就能只问一遍（见 heroes 里旋略的钩子）。
 */
function fireEquipLostMany(
  state: GameState,
  owner: Player,
  cards: Card[],
  after: () => void,
): void {
  if (cards.length === 0) {
    after();
    return;
  }
  const id = ++state.equipLossSeq;
  const step = (i: number): void => {
    const card = cards[i];
    if (!card) {
      after();
      return;
    }
    fireEquipLost(state, owner, card, () => step(i + 1), { id, cards });
  };
  step(0);
}

/**
 * 「拼点的牌亮出后」的派发（孙策·鹰扬）：按「发起者 → 目标」依次问，钩子可以改写点数，
 * 全部问完回调最终点数。
 *
 * 为什么自己摊一条链而不是用 runHooksPausable：那个拿不到「把点数写回来」的盒子
 * （判定那条路也是同样的原因自己摊了一条，见 judgeHookStep）。
 * 双方都可能有鹰扬，官方没规定同一时机的先后，这里定为发起者先问。
 */
function askPindianRevealed(
  state: GameState,
  participants: { player: Player; card: Card; isInitiator: boolean }[],
  done: (ranks: number[]) => void,
): void {
  const ranks = participants.map((x) => x.card.rank);
  const step = (i: number): void => {
    const cur = participants[i];
    if (!cur) {
      done(ranks);
      return;
    }
    const hooks = collectTimingHooks(state, cur.player, 'pindianRevealed', false);
    if (hooks.length === 0) {
      step(i + 1);
      return;
    }
    const box: PindianBox = {};
    const opponent = participants.find((x) => x.player.seatId !== cur.player.seatId);
    const runOne = (k: number): void => {
      const hk = hooks[k];
      if (!hk) {
        if (box.rank !== undefined) ranks[i] = box.rank;
        step(i + 1);
        return;
      }
      hk.handler({
        state,
        player: cur.player,
        timing: 'pindianRevealed',
        payload: {
          card: cur.card,
          opponentCard: opponent?.card,
          isInitiator: cur.isInitiator,
        },
        // ⚠️ resumeTo 必须给：鹰扬的询问会**挂起**，而拼点自己的「回到出牌阶段」是靠最后那次
        // 扣牌询问的 returnTo 兜的——一旦中间挂起，那条兜底就不生效了（不传就停在 pending=null，
        // 出牌方卡死，是这个引擎反复踩过的坑）。口径与拼点自己的询问一致：还给当前回合玩家。
        api: makeSkillApi(state, {
          pindianBox: box,
          actor: cur.player.seatId,
          resumeTo: state.seatOrder[state.turn.seatIndex],
        }),
      });
      // 钩子挂起了询问（鹰扬的「+3 还是 -3」）：等它选完再跑下一个
      if (state.pending?.kind === 'choice' || state.pending?.kind === 'pickCards') {
        pushResume(state, () => runOne(k + 1));
        return;
      }
      runOne(k + 1);
    };
    runOne(0);
  };
  step(0);
}

/**
 * 与牌型无关的伤害修正（张绣·从谏）：**来源**与**目标**双方的武将都会被问到。
 *
 * 与 dealtDamageBonus 的分工见 Hero.damageDelta 的注释：那个只在【杀】/【决斗】处读，
 * 这个在 damageStep 里读，所以【南蛮入侵】【万箭齐发】【闪电】那类伤害也吃得到。
 * 日志里的技能名走 skillNameForField 反查（别把名字硬编码进引擎）。
 */
function damageDeltaFor(
  state: GameState,
  target: Player,
  attack: AttackContext,
): { delta: number; label: string } {
  const src = attack.sourceId ? getPlayer(state, attack.sourceId) : undefined;
  let delta = 0;
  let label = '';
  const ask = (p: Player | undefined): void => {
    if (!p) return;
    for (const h of activeHeroes(state, p)) {
      const d =
        h.damageDelta?.(state, p, { sourceId: attack.sourceId, targetId: target.seatId }) ?? 0;
      if (d === 0) continue;
      delta += d;
      label = skillNameForField([h], 'damageDelta') ?? label;
    }
  };
  ask(src);
  if (target.seatId !== src?.seatId) ask(target);
  return { delta, label };
}

/**
 * 伤害来源的技能给出的伤害加成（裸衣）。
 * 只在【杀】与【决斗】的结算处调用——那正是裸衣的加成范围。
 */
function dealtDamageBonus(state: GameState, attack: AttackContext): number {
  if (!attack.sourceId) return 0;
  const src = getPlayer(state, attack.sourceId);
  if (!src) return 0;
  return activeHeroes(state, src).reduce(
    (sum, h) => sum + (h.dealtDamageBonus?.(state, src) ?? 0),
    0,
  );
}

/**
 * 属性伤害是否该沿横置角色蔓延；该蔓延就把待办记进 `state.ongoingChain`。
 * **本函数不动控制流**——真正跑蔓延是 runChainSpread，由调用方或 resumePlay 触发。
 *
 * 写成「先记账、后跑」是因为蔓延可能被人打进濒死：那时控制权要交给濒死流程，
 * 剩下的等 resumePlay 再继续（与 AOE 用 ongoingTrick 是同一个套路）。
 * ⚠️ 注意不能用「pending 非空」来判断是否被打断——结算过程中 pending 一直是旧值。
 */
function queueChainSpread(state: GameState, attack: AttackContext, damage: number): void {
  if (!attack.attribute) return;
  const first = getPlayer(state, attack.targetId);
  if (!first || !first.chained) return;
  first.chained = false;
  pushLog(state, 'chained', `${first.name} 因受到属性伤害而重置。`);
  const rest = state.players.filter((p) => p.alive && p.chained).map((p) => p.seatId);
  if (rest.length === 0) return;
  state.ongoingChain = { attack, damage, rest, index: 0 };
}

/** 跑完横置蔓延再调 after；中途被打断就留在 ongoingChain 里等 resumePlay */
function runChainSpread(state: GameState, after: () => void): void {
  const c = state.ongoingChain;
  if (!c) {
    after();
    return;
  }
  chainStep(state, c, after);
}

function chainStep(state: GameState, c: ChainPending, after: () => void): void {
  if (c.index >= c.rest.length) {
    state.ongoingChain = null;
    after();
    return;
  }
  const p = getPlayer(state, c.rest[c.index]!);
  if (!p || !p.alive || !p.chained) {
    c.index++;
    chainStep(state, c, after);
    return;
  }
  p.chained = false;
  const chainAttack: AttackContext = { ...c.attack, targetId: p.seatId, dodged: false };
  damageStep(state, p, chainAttack, c.damage, (dmg, prevented) => {
    if (!prevented) {
      pushLog(
        state,
        'damage',
        `${p.name} 因【铁索连环】受到 ${dmg} 点伤害，剩余 ${Math.max(0, p.hp)} 体力。`,
      );
    }
    const next = (): void => {
      c.index++;
      chainStep(state, c, after);
    };
    // 伤害被护心镜防止了 → 没有伤害后钩子、没有濒死判断，直接接着蔓延下一个人
    if (prevented) {
      next();
      return;
    }
    runDamagedHooks(state, p, chainAttack, dmg, () => {
      if (p.hp <= 0) {
        // 濒死流程接管；ongoingChain 留着，等 resumePlay 把剩下的人接着打完
        enterNearDeath(state, chainAttack);
        return;
      }
      next();
    });
  });
}

/** 杀结算（目标已出闪或已弃权） */
function finishAttack(state: GameState, attack: AttackContext): void {
  const target = getPlayerOrThrow(state, attack.targetId);

  if (attack.dodged) {
    pushLog(state, 'resolve', `【杀】被闪避。`);
    // 方天画戟（**国战版**）：一人闪则此【杀】对**其余目标全部无效**（已经结算完的人不受影响）。
    // 把队列清空，收尾就会直接回到出牌阶段。
    // 军争版没有这一条：谁闪谁不闪互不影响，所以照样往下打。
    if (attack.fangtianAbortOnDodge && attack.fangtianQueue && attack.fangtianQueue.length > 0) {
      pushLog(
        state,
        'resolve',
        `【方天画戟】的【杀】被 【闪】抵消，对其余 ${attack.fangtianQueue.length} 名目标无效。`,
      );
      attack.fangtianQueue = [];
    }
    const afterDodge = (): void => {
      runHooks(state, 'afterResolve', target, { attack });
      afterAttackSettled(state, attack);
    };
    const dodgeWeapon = (): void => {
      // 被闪避后还能翻盘的武器：青龙偃月刀（继续出杀）/ 贯石斧（弃两张牌仍造成伤害）
      if (tryDodgeWeapon(state, attack, afterDodge)) return;
      afterDodge();
    };
    // 「【杀】被【闪】抵消」的时机派给**来源**（庞德·猛进挂这里）。
    // 可挂起：这一问可能发起询问，问到一半不能把后面的收尾丢了。
    const src = attack.sourceId ? getPlayer(state, attack.sourceId) : undefined;
    if (src && src.alive) {
      runHooksPausable(state, 'shaDodged', src, { attack }, dodgeWeapon);
      return;
    }
    dodgeWeapon();
    return;
  }

  resolveAttackHit(state, attack);
}

/**
 * 这张【杀】对**当前目标**结算完了之后的收尾。
 *
 * 普通情况就是回到出牌阶段；【方天画戟】还有剩余目标的话接着对下一个目标走一遍
 * 「成为目标 → 防具/八卦 → 等出闪」。每个新目标都用一份新的上下文（闪避标记与
 * 需闪数要重置），但**共用同一个剩余队列**，所以队列里的 shift 对两边都可见。
 */
function afterAttackSettled(state: GameState, attack: AttackContext): void {
  const rest = attack.fangtianQueue;
  const source = getPlayer(state, attack.sourceId);
  if (rest && rest.length > 0 && source && source.alive) {
    const nextId = rest.shift()!;
    const next = getPlayer(state, nextId);
    if (!next || !next.alive) {
      afterAttackSettled(state, attack);
      return;
    }
    pushLog(state, 'sha', `【杀】继续结算 ${next.name}。`);
    becomeTargetFor(state, next, {
      ...attack,
      targetId: nextId,
      dodged: false,
      requiredShan: 1,
      redirected: false,
    });
    return;
  }
  // 「你的【杀】结算完之后」（糜夫人给别人的【勇决】）：派给使用者，
  // 钩子跑完才继续（技能驱动的连环出杀排在它后面）。
  // 「这次使用整张牌结算结束」派给**全场**（许攸·成略：旁观的同势力角色要听）——
  // 放在 attackSettled（派给使用者）**之后**，收尾之前
  const afterEnded = (): void => {
    const useId = attack.cardUseId;
    const needed =
      !!useId &&
      state.players.some(
        (p) => p.alive && collectTimingHooks(state, p, 'cardUseEnded', false).length > 0,
      );
    if (!needed) {
      afterAttackSettledTail(state, attack);
      return;
    }
    runAllPlayersHooks(
      state,
      'cardUseEnded',
      {
        useId,
        sourceId: attack.sourceId,
        targetIds: attack.declaredTargets ?? [attack.targetId],
      },
      () => afterAttackSettledTail(state, attack),
    );
  };
  const settleSource = getPlayer(state, attack.sourceId);
  if (settleSource && settleSource.alive) {
    runHooksPausable(state, 'attackSettled', settleSource, { attack }, afterEnded);
    return;
  }
  afterEnded();
}

/** 【杀】结算的真正收尾（attackSettled 钩子之后） */
function afterAttackSettledTail(state: GameState, attack: AttackContext): void {
  // 严白虎·寄篱：「成为红色【杀】的唯一目标 → 此牌结算结束后，其使用者对你再使用一次
  // 相同牌名的牌」。注意这不是「把这份 attack 重跑一遍」（那是君孙权·据江的口径）：
  // 这里造一张**无实体虚拟【杀】**并让使用者**重新使用**它——严白虎照样能出【闪】，
  // 新的 attack 从头走一遍（成为目标 → 响应 → 伤害 → 收尾）。
  if (attack.jiliUse) {
    attack.jiliUse = false;
    const source = getPlayer(state, attack.sourceId);
    const jiliTarget = getPlayer(state, attack.targetId);
    if (source && source.alive && jiliTarget && jiliTarget.alive) {
      // 牌名看这次使用的是「什么杀」（武圣红牌当杀 → 牌名仍是【杀】，属性按原牌）：
      // 实体牌还在弃牌堆时取它（属性/牌名最准），丈八那种虚拟杀取不到就按 attack 合成一份
      // ——合成出来的对象只用于牌名与属性，永远不进任何区域。
      const found =
        state.discard.find((c) => c.id === attack.cardId) ??
        state.deck.find((c) => c.id === attack.cardId);
      const original: Card = {
        id: attack.cardId,
        type: attack.asType,
        suit: 'spade',
        rank: 1,
        ...(found?.attribute ? { attribute: found.attribute } : {}),
      };
      useVirtualSameNameCard(state, source, original, jiliTarget, (card) => {
        // countTowardLimit: false —— 这张牌是技能逼出来的，不占「本回合已使用的【杀】」
        startAttack(state, source, card, [jiliTarget.seatId], 'sha', { countTowardLimit: false });
      });
      return;
    }
  }
  // 【授锋】的「这张【杀】整个结算结束」也在这个出口（reason：这里才是真收尾，
  // 寄篱重跑与青龙偃月刀那类连环出杀都排在它前面）。账本里是别的牌就不打扰。
  const first = state.firstDamageCard;
  if (first && !first.resolved && attack.cardId !== '' && first.cardId === attack.cardId) {
    first.resolved = true;
    // ⚠️ 找不到实体牌也要派发：丈八两张牌凑出来的【杀】是**虚拟**牌，在任何区域里都找不到它，
    //    但它照样算「用过首张伤害牌」（用户口径）；「获得此伤害牌」照 cardIds 那张实体牌清单走。
    //    这里合成的对象只用于显示牌名。
    const card =
      state.discard.find((c) => c.id === attack.cardId) ??
      state.deck.find((c) => c.id === attack.cardId) ?? {
        id: attack.cardId,
        type: attack.asType,
        suit: 'spade' as const,
        rank: 1,
      };
    runAllPlayersHooks(
      state,
      'cardResolved',
      { card, cardIds: first.cardIds, userSeatId: attack.sourceId },
      () => resumePlay(state, state.seatOrder[state.turn.seatIndex]!),
    );
    return;
  }
  // 技能驱动的连环出杀（贾诩·乱武）在这里接着往下走；普通出杀回到出牌阶段
  if (attack.afterSettled) {
    const after = attack.afterSettled;
    attack.afterSettled = undefined;
    after();
    return;
  }
  resumePlay(state, state.seatOrder[state.turn.seatIndex]!);
}

/**
 * 【杀】被闪避之后，持有特定武器的来源可以再争取一次。
 * 返回 true 表示挂起了询问（调用方不要再改 pending）。
 */
function tryDodgeWeapon(state: GameState, attack: AttackContext, onDecline: () => void): boolean {
  const source = attack.sourceId ? getPlayer(state, attack.sourceId) : undefined;
  if (!source || !source.alive) return false;
  const name = source.equipment.weapon?.equipName;
  if (name === 'guanshi') return tryGuanshiAxe(state, source, attack, onDecline);
  if (name === 'qinglong') return tryQinglongBlade(state, source, attack, onDecline);
  return false;
}

/** 青龙偃月刀：使用的【杀】被【闪】抵消时，可以对其继续使用一张【杀】 */
function tryQinglongBlade(
  state: GameState,
  source: Player,
  attack: AttackContext,
  onDecline: () => void,
): boolean {
  const target = attack.targetId ? getPlayer(state, attack.targetId) : undefined;
  if (!target || !target.alive) return false;
  if (source.hand.filter((c) => c.type === 'sha').length === 0) return false;
  askChoice(
    state,
    source.seatId,
    `是否发动【青龙偃月刀】，继续对 ${target.name} 使用一张【杀】？`,
    [
      { id: 'yes', label: '发动（再使用一张【杀】）' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      // 挑牌时重新算一遍：前面的结算可能动过手牌
      const shas = p.hand.filter((c) => c.type === 'sha');
      if (picked !== 'yes' || shas.length === 0) {
        onDecline();
        return;
      }
      askPickCards(
        st,
        p.seatId,
        '【青龙偃月刀】：选择要使用的【杀】',
        shas,
        1,
        1,
        (st2, p2, chosen) => {
          const card = chosen[0];
          if (!card) {
            onDecline();
            return;
          }
          pushLog(
            st2,
            'equip',
            `${p2.name} 发动【青龙偃月刀】，继续对 ${target.name} 使用【杀】。`,
          );
          startAttack(st2, p2, card, [target.seatId], 'sha', { countTowardLimit: false });
        },
      );
    },
  );
  return true;
}

/** 一张牌从玩家身上（手牌或装备区）进弃牌堆；失去装备会触发 equipLost */
function discardOwnCard(
  state: GameState,
  p: Player,
  card: Card,
  after: () => void,
  batchEventId?: number,
  actorSeatId?: string,
): void {
  const finish = (): void => fireCardDiscarded(state, p, [card], after, actorSeatId);
  const eq = p.equipment;
  for (const slot of EQUIP_SLOTS) {
    if (eq[slot]?.id === card.id) {
      eq[slot] = null;
      toDiscard(state, card);
      // batchEventId 存在＝这是「一次弃多张」里的其中一张，整批算一次失去
      fireEquipLost(state, p, card, finish, {
        id: batchEventId ?? ++state.equipLossSeq,
        cards: [card],
      });
      return;
    }
  }
  const c = removeCard(p.hand, card.id);
  if (c) toDiscard(state, c);
  finish();
}

/**
 * 「某人的牌**因弃置**而进入弃牌堆」→ 派给牌的拥有者（孔融·礼让）。
 *
 * 只该在**弃置**时调：使用牌进弃牌堆、拼点亮牌、阵亡清牌都不算。
 * 可挂起——礼让要问「要不要转交给别人」，所以用可挂起版本，
 * 调用方把「弃置之后的收尾」放在 after 里。
 */
function fireCardDiscarded(
  state: GameState,
  owner: Player,
  cards: Card[],
  after: () => void,
  /** **执行弃置动作**的人（不填＝牌主自己）。「A 弃 B 的牌」要传 A——见 turnDiscards 的说明 */
  actorSeatId?: string,
): void {
  if (cards.length === 0 || !owner.alive) {
    after();
    return;
  }
  // 本回合的「谁弃了谁的牌」账本（苏飞·【联翩】按**执行者**统计；朱灵·决绝那种
  // 「置入弃牌堆」不走这里，所以天然不计入）
  state.turnDiscards.push({
    actorId: actorSeatId ?? owner.seatId,
    ownerId: owner.seatId,
    cardIds: cards.map((c) => c.id),
  });
  // 宝物【定澜夜明珠】（君主专属）：「你每回合首次弃置牌后摸一张牌」。
  // 装备牌的效果不走英雄钩子，所以和【飞龙夺凤】【盟军大纛】一样在这里显式派发；
  // 排在英雄钩子（礼让）前面——同时机固定顺序，见 roster 的说明。
  // 刘巴·【统度】：只数**弃牌阶段**里**该角色自己**弃置的牌（按张）。
  // ⚠️ 这里用「牌主＝当前回合角色」近似「弃置者＝该角色」——在**他自己的弃牌阶段**里，
  //    别人的效果弃他的牌（如过河拆桥）不可能发生，所以这个近似是安全的。
  if (state.turn.phase === 'discard' && state.seatOrder[state.turn.seatIndex] === owner.seatId) {
    state.discardPhaseCountsThisTurn[owner.seatId] =
      (state.discardPhaseCountsThisTurn[owner.seatId] ?? 0) + cards.length;
  }
  /** 「其他角色的牌因弃置进弃牌堆」派给全场（夙智③）；随后才继续原来的收尾 */
  const afterOwnerHooks = (): void => {
    const seen = state.players.some(
      (p) =>
        p.alive &&
        p.seatId !== owner.seatId &&
        collectTimingHooks(state, p, 'anyCardDiscarded', false).length > 0,
    );
    if (!seen) {
      after();
      return;
    }
    runAllPlayersHooks(
      state,
      'anyCardDiscarded',
      { cards, ownerSeatId: owner.seatId },
      () => after(),
      owner.seatId,
    );
  };
  dinglanAfterDiscard(state, owner, () =>
    runHooksPausable(state, 'cardDiscarded', owner, { cards }, afterOwnerHooks),
  );
}

/**
 * 逐张弃置（中间可能被失去装备的询问打断），全部处理完再调 after。
 *
 * 「一次弃多张」（贯石斧、悲歌梅花那类）是**一个动作**：里面如果有装备牌，它们属于同一次
 * 「失去装备」事件——所以这里先记一个 eventId，交给 discardOwnCard 一路带下去。
 */
function discardOwnCards(
  state: GameState,
  p: Player,
  cards: Card[],
  after: () => void,
  actorSeatId?: string,
): void {
  const eventId = cards.length > 1 ? ++state.equipLossSeq : undefined;
  const step = (i: number): void => {
    const card = cards[i];
    if (!card) {
      after();
      return;
    }
    discardOwnCard(state, p, card, () => step(i + 1), eventId, actorSeatId);
  };
  step(0);
}

/** 自己身上可以被弃掉的牌：手牌 + 装备区（可选排除某件武器） */
function ownDiscardableCards(p: Player, excludeEquipName?: string): Card[] {
  const out = [...p.hand];
  const eq = p.equipment;
  for (const slot of EQUIP_SLOTS) {
    const c = eq[slot];
    if (c && c.equipName !== excludeEquipName) out.push(c);
  }
  return out;
}

/** 贯石斧：弃置两张牌，令被闪避的【杀】依然造成伤害 */
function tryGuanshiAxe(
  state: GameState,
  source: Player,
  attack: AttackContext,
  onDecline: () => void,
): boolean {
  const candidates = ownDiscardableCards(source, 'guanshi');
  if (candidates.length < 2) return false;
  askChoice(
    state,
    source.seatId,
    '是否发动【贯石斧】弃置两张牌，令此【杀】依然造成伤害？',
    [
      { id: 'yes', label: '发动（弃置两张牌）' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') {
        onDecline();
        return;
      }
      askPickCards(
        st,
        p.seatId,
        '【贯石斧】：选择要弃置的两张牌',
        ownDiscardableCards(p, 'guanshi'),
        2,
        2,
        (st2, p2, chosen) => {
          discardOwnCards(st2, p2, chosen, () => {
            pushLog(
              st2,
              'equip',
              `${p2.name} 发动【贯石斧】，弃置 ${chosen.length} 张牌，此【杀】依然造成伤害。`,
            );
            attack.dodged = false;
            resolveAttackHit(st2, attack);
          });
        },
      );
    },
  );
  return true;
}

/** 【杀】命中的结算（防具与闪避都已经处理完） */
function resolveAttackHit(state: GameState, attack: AttackContext): void {
  const target = getPlayerOrThrow(state, attack.targetId);
  const source = getPlayer(state, attack.sourceId);

  // 命中：造成伤害
  runHooks(state, 'beforeResolve', target, { attack });
  // 装备加成：古锭刀（目标无手牌+1）/ 藤甲（火焰伤害+1）
  const equipBonus = damageBonus(state, attack);
  // 技能加成：裸衣这类「你造成的伤害 +N」
  const skillBonus = dealtDamageBonus(state, attack);
  let total = attack.damage + equipBonus + skillBonus;
  if (equipBonus > 0) {
    pushLog(state, 'damage', `${target.name} 受到的伤害 +${equipBonus}（装备特效）。`);
  }
  if (skillBonus > 0) {
    pushLog(state, 'damage', `${target.name} 受到的伤害 +${skillBonus}（技能）。`);
  }
  // 伤害数值的最后一道修正（孔融·名士 -1 / 白银狮子防止多余）交给 damageStep 里的
  // finalizeDamage 统一做，这里不再单独夹一次（否则白银狮子会被夹两次）。
  // ⚠️ 「受到伤害时」的钩子也**只在 damageStep 里派发一次**——这里以前还多发了一次，
  //    同步钩子看不出问题，改成可挂起之后就会问两遍（小乔·天香）。

  /** 真正扣血 + 收尾（afterDamage / 铁索蔓延 / 濒死） */
  const applyDamage = (dmg: number, prevented: boolean): void => {
    if (!prevented) {
      pushLog(
        state,
        'damage',
        `${target.name} 受到 ${dmg} 点伤害，剩余 ${Math.max(0, target.hp)} 体力。`,
      );
    }
    // afterDamage（派给受伤者）与 afterDamageDealt（派给来源）都可能挂起询问，
    // 所以串起来跑，最后才接上收尾。收尾里会进濒死或回到出牌阶段。
    const tail = (): void => {
      runHooks(state, 'afterResolve', target, { attack });
      // 三尖两刃刀：造成伤害后（目标还活着才有效）
      askSanjian(state, attack, () => {
        // 铁索连环：先记账（重置横置目标 + 记下要蔓延给谁），再决定控制流
        queueChainSpread(state, attack, dmg);
        if (target.hp <= 0) {
          // 目标自己濒死：蔓延的待办留在 ongoingChain 里，濒死结算完由 resumePlay 接着跑
          enterNearDeath(state, attack);
          return;
        }
        runChainSpread(state, () => {
          afterAttackSettled(state, attack);
        });
      });
    };
    // 伤害被护心镜防止了 → 没有伤害后钩子、也没有铁索蔓延，直接收尾
    if (prevented) {
      afterAttackSettled(state, attack);
      return;
    }
    runDamagedHooks(state, target, attack, dmg, tail);
  };

  // 伤害时的武器特效（寒冰剑 / 麒麟弓）——都可能要问，所以串着来
  askDamageWeaponEffects(state, attack, target, source, () => {
    damageStep(state, target, attack, total, applyDamage);
  });
}

/**
 * 一次伤害的**公共前置**：算减伤 → damageDealt → 护心镜（可能问）→ 扣血。
 *
 * `apply(dmg, prevented)` 是「扣血之后」的收尾：调用方在里面写自己的伤害日志、
 * 跑受伤后钩子、决定濒死/铁索/推进。**扣血由这里统一做**，所以减伤只在这一处生效。
 *
 * 为什么要收口：伤害点本来有 8 处各抄一遍「damageDealt → 护心镜 → hp -= 」，
 * 于是任何一处要按规则改伤害数值（孔融·名士）或加「任何人受伤后」的时机（蔡文姬·悲歌）
 * 都得改 8 遍、必漏。顺带修掉一个老漏判：**白银狮子以前只挂在【杀】那条路径上**，
 * 现在所有伤害都过它。
 */
function damageStep(
  state: GameState,
  target: Player,
  attack: AttackContext,
  rawDamage: number,
  apply: (dmg: number, prevented: boolean) => void,
): void {
  // 与牌型无关的伤害修正（张绣·从谏）：来源与目标双方的武将都会被问到。
  // 放在 finalizeDamage **之前**：那是目标侧的锁定技修正（名士 -1 / 白银狮子防止多余），
  // 而这种「伤害值本身」的加减先算才对。
  const { delta, label } = damageDeltaFor(state, target, attack);
  if (delta !== 0) {
    pushLog(
      state,
      'damage',
      `${target.name} 受到的伤害 ${delta > 0 ? '+' : ''}${delta}（技能${label ? `【${label}】` : ''}）。`,
    );
  }
  const dmg = finalizeDamage(state, target, attack, Math.max(0, rawDamage + delta));
  // 「当你受到伤害时」可挂起：小乔·天香要在这时弃牌、选人、二选一。
  // 取消通道是 `flags.damagePrevented`（钩子没有返回值）——派发前清、派发后读，
  // 读到就整条伤害作废：不扣血、不跑伤害后钩子、不进濒死。护心镜那层照旧在其后。
  // 减伤通道是 `flags.damageReduce`（陆抗·恪守那种「可选的 -1」），同样派发前清、派发后读；
  // 减到 0 也按「没造成伤害」处理（不扣血、不跑伤害后钩子、不进铁索蔓延）。
  target.flags.damagePrevented = false;
  target.flags.damageReduce = 0;
  const finishDamage = (): void => {
    // 「伤害将要落地」先派给**全场**（徐庶·荐才那类旁观者要防止别人受到的致命伤害）。
    // 放在最前面：此时 dmg 已定、flag 刚清，置 damagePrevented 即整笔作废。
    // 「伤害将要落地」派给**全场**（徐庶·荐才那类**旁观者**要防止别人受到的致命伤害）。
    // ⚠️ 它比原来的链条多一层可挂起嵌套，会改变续接队列的先后（实测踩过：多这一层就把
    //    【恪守】判定牌的清理续接挤掉了，判定牌凭空消失）——所以**场上真有人挂这个时机**
    //    才走这一层，其余情况原样走旧路径。
    const needsPreDamage = state.players.some(
      (p) => p.alive && collectTimingHooks(state, p, 'beforeDamageApply', true).length > 0,
    );
    // 宝物【盟军大纛】（君主专属）：**受到伤害时**弃两张牌防止此伤害。它是装备牌的效果，
    // 不走英雄钩子，所以和【飞龙夺凤】一样在这里显式派发；装备持有者自己决定要不要弃。
    const afterPreDamage = (dmgNow: number): void =>
    mengjunDajun(state, target, () =>
      runHooksPausable(state, 'damageDealt', target, { damage: dmgNow, attack }, () => {
      const prevented = target.flags.damagePrevented;
      const reduced = target.flags.damageReduce;
      target.flags.damagePrevented = false;
      target.flags.damageReduce = 0;
      if (prevented) {
        apply(dmgNow, true);
        return;
      }
      const finalDmg = Math.max(0, dmgNow - reduced);
      if (finalDmg <= 0) {
        // 减到 0：等于没造成伤害（官方：伤害值变为 0 则不造成伤害）
        if (reduced > 0) {
          pushLog(state, 'damage', `${target.name} 受到的伤害被减少到 0。`);
        }
        apply(0, true);
        return;
      }
        withHuxinjing(state, attack, finalDmg, (hxPrevented) => {
          if (!hxPrevented) {
            target.hp -= finalDmg;
            // 「这一次使用实际伤害过谁」的账本（许攸·成略）：只记真扣了血的
            // 「最近一次伤害」的生成者/来源（黄祖·袭射要判断「是不是被袭射的杀打死的」）
            state.lastDamageSourceId = attack.sourceId;
            state.lastDamageGeneratedBy = attack.generatedBy ?? null;
            if (attack.cardUseId) {
              state.useDamages.push({
                useId: attack.cardUseId,
                targetId: target.seatId,
                amount: finalDmg,
              });
            }
          }
          apply(finalDmg, hxPrevented);
        });
      }),
    );
    if (needsPreDamage) {
      // ⚠️ 这个 payload 是**可写**的：钩子可以在这一层改伤害值（潘濬·公清把「攻击范围 < 3」
      //    的伤害**调整为 1**——是「设为 1」不是「-1」，5 点也变 1 点）。改完以它为准往下走。
      //    这一层在伤害值确定的**最后**（减伤/名士/白银狮子都算完了），正好对应官方细则里
      //    「<3 改为 1」比「>3 加伤」更晚的那一步；「>3 加伤」走的是更早的 `damageDelta`。
      const pre = { targetId: target.seatId, damage: dmg, attack };
      runBeforeDamageApply(state, pre, () => {
        const adjusted = Math.max(0, pre.damage);
        if (adjusted !== dmg) {
          pushLog(state, 'damage', `${target.name} 受到的伤害被调整为 ${adjusted} 点。`);
        }
        afterPreDamage(adjusted);
      });
    } else {
      afterPreDamage(dmg);
    }
  };
  // 先给**来源**一个机会（张任·穿心那种「防止自己造成的伤害」），再走目标那边
  const dmgSource =
    attack.sourceId && attack.sourceId !== target.seatId
      ? getPlayer(state, attack.sourceId)
      : undefined;
  if (dmgSource && dmgSource.alive) {
    runHooksPausable(state, 'damageCaused', dmgSource, { attack, damage: dmg }, finishDamage);
    return;
  }
  finishDamage();
}

/**
 * 「伤害将要落地」派给全场（可挂起）。**旁观者**的技能（徐庶·荐才）靠它入手；
 * 目标自己的「受到伤害时」还是走 `damageDealt`（那条链路在它之后）。
 */
function runBeforeDamageApply(
  state: GameState,
  payload: { targetId: string; damage: number; attack: AttackContext },
  after: () => void,
  i = 0,
): void {
  const list = state.players.filter((p) => p.alive);
  const step = (k: number): void => {
    const p = list[k];
    if (!p) {
      after();
      return;
    }
    runHooksPausable(state, 'beforeDamageApply', p, payload, () => step(k + 1));
  };
  step(i);
}

/**
 * 伤害数值的**统一修正**（在扣血之前算）。目前两处：
 *
 * - **孔融·名士**（锁定技）：当你受到伤害时，若伤害来源**有暗置的武将牌**，此伤害 -1。
 * - **白银狮子**（锁定技）：伤害大于 1 时防止多余的伤害（青釭剑无视防具）。
 *
 * ⚠️ 顺序：先名士再白银狮子。两者都是「变成多少」而不是「免不免」，
 * 免不免那层是护心镜（withHuxinjing）。
 */
function finalizeDamage(
  state: GameState,
  target: Player,
  attack: AttackContext,
  damage: number,
): number {
  let d = damage;
  const source = attack.sourceId ? getPlayer(state, attack.sourceId) : undefined;
  // 名士：来源有暗置的武将牌（国战语义：暗置的武将牌没有技能、也没明置）
  if (
    activeHeroes(state, target).some((h) => h.reduceDamageFromHiddenSource) &&
    source &&
    source.seatId !== target.seatId &&
    unrevealedHeroes(state.mode, source).length > 0
  ) {
    d = Math.max(0, d - 1);
    pushLog(state, 'resolve', `${target.name} 的【名士】令此伤害 -1。`, {
      seat: target.seatId,
      action: 'shield',
    });
  }
  return capDamageByBailong(state, target, d, source, attack);
}

/**
 * 「受到伤害后」的统一派发：受伤者的 `afterDamage` → 旁观者的 `anyDamaged`
 * （蔡文姬·悲歌那种「当**一名角色**受到伤害后」）→ 来源的 `afterDamageDealt` → `after`。
 *
 * `anyDamaged` 派给**所有存活角色**（含受伤者自己与来源）——技能自己按 payload
 * 判断要不要发动，引擎不做过滤。
 */
function runDamagedHooks(
  state: GameState,
  victim: Player,
  attack: AttackContext,
  damage: number,
  after: () => void,
): void {
  // 「本阶段内受到过几次伤害」的账本（严白虎·寄篱要判「第 2 次」）。
  // 键 = 「当前回合座位:阶段」，键一变就当这是本阶段的第 1 次——比给每个阶段转换点
  // 都写一段重置代码可靠（阶段转换散在好几处）。记在**扣血之后**这一次伤害上。
  const key = `${state.seatOrder[state.turn.seatIndex] ?? ''}:${state.turn.phase}`;
  if (victim.flags.damageCountKey !== key) {
    victim.flags.damageCountKey = key;
    victim.flags.damageCount = 1;
  } else {
    victim.flags.damageCount += 1;
  }
  runHooksPausable(state, 'afterDamage', victim, { attack, damage }, () => {
    runAnyDamagedHooks(state, victim, attack, damage, () => {
      runDamageDealtHooksP(state, attack, damage, after);
    });
  });
}

/** 把「一名角色受到伤害后」派发给所有存活角色（逐个跑，每个都可能挂起） */
function runAnyDamagedHooks(
  state: GameState,
  victim: Player,
  attack: AttackContext,
  damage: number,
  after: () => void,
): void {
  runAllPlayersHooks(state, 'anyDamaged', { attack, damage, victimId: victim.seatId }, after);
}

/**
 * 把某个时机派发给**所有存活角色**（逐个跑，每个都可能挂起）。
 *
 * 「当**某名角色**××时」这类技能（悲歌 / 随势 / 固政）收不到引擎只发给当事人的时机
 * （anyDamaged / otherNearDeath / othersDiscardPhaseEnd），统一走这里补发。
 * `exceptSeatId` 用来排除当事人本人（随势不算濒死者自己）。
 */
function runAllPlayersHooks(
  state: GameState,
  timing: Timing,
  payload: unknown,
  after: () => void,
  exceptSeatId?: string,
): void {
  const list = alivePlayers(state)
    .map((p) => p.seatId)
    .filter((sid) => sid !== exceptSeatId);
  const step = (i: number): void => {
    if (i >= list.length) {
      after();
      return;
    }
    const p = getPlayer(state, list[i]!);
    if (!p) {
      step(i + 1);
      return;
    }
    runHooksPausable(state, timing, p, payload, () => step(i + 1));
  };
  step(0);
}

/**
 * 伤害的**防止层**（护心镜）。
 *
 * 规则：「当你受到伤害时，若伤害值**大于或等于你的体力值**，你可以将【护心镜】
 * 置入弃牌堆，然后防止此伤害。」
 *
 * ⚠️ 它必须包住「扣血 → 记日志 → 后续钩子（濒死/铁索蔓延/推进）」**整段**：
 * 伤害被防止了就没有濒死、也不该触发铁索，所以调用方把整段放进 `apply(prevented)`，
 * 别只包住 `hp -= `。`prevented` 为 true 时调用方要跳过扣血与伤害日志。
 *
 * 已知不覆盖：**闪电**的雷电伤害（那条路径在判定流程里是同步的，没有可挂起的位置）。
 */
function withHuxinjing(
  state: GameState,
  attack: AttackContext,
  damage: number,
  apply: (prevented: boolean) => void,
): void {
  const target = getPlayer(state, attack.targetId);
  if (
    !target ||
    !target.alive ||
    target.equipment.armor?.equipName !== 'huxinjing' ||
    damage < target.hp
  ) {
    apply(false);
    return;
  }
  askChoice(
    state,
    target.seatId,
    `是否弃置【护心镜】防止这 ${damage} 点伤害？（你只有 ${target.hp} 点体力）`,
    [
      { id: 'yes', label: '弃置护心镜，防止此伤害' },
      { id: 'no', label: '不弃置（照常受伤）' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes' || p.equipment.armor?.equipName !== 'huxinjing') {
        apply(false);
        return;
      }
      const card = p.equipment.armor;
      p.equipment.armor = null;
      toDiscard(st, card);
      pushLog(st, 'equip', `${p.name} 弃置【护心镜】，防止了这次伤害。`, {
        seat: p.seatId,
        action: 'shield',
      });
      fireEquipLost(st, p, card, () => apply(true));
    },
  );
}

/**
 * 【杀】造成伤害**时**的武器特效（都需要询问，按顺序串起来）：
 * ① 寒冰剑：可以防止此伤害，改为依次弃置目标两张牌——防止了就没有后续伤害；
 * ② 麒麟弓：可以弃置目标装备区里的一张坐骑牌（不改变伤害）。
 *
 * `after` 在所有询问都结束后调用（此时该扣血了）。
 */
function askDamageWeaponEffects(
  state: GameState,
  attack: AttackContext,
  target: Player,
  source: Player | undefined,
  after: () => void,
): void {
  const weapon = source?.equipment.weapon?.equipName;
  /** ② 麒麟弓：弃置目标装备区的一张坐骑牌（不改变伤害） */
  const thenQilin = (): void => {
    if (weapon !== 'qilin') {
      after();
      return;
    }
    const nowMounts = [target.equipment.plusMount, target.equipment.minusMount].filter(
      Boolean,
    ) as Card[];
    if (nowMounts.length === 0) {
      after();
      return;
    }
    askChoice(
      state,
      source!.seatId,
      `是否发动【麒麟弓】，弃置 ${target.name} 的一张坐骑牌？`,
      [
        ...nowMounts.map((c) => ({ id: c.id, label: `弃置【${cardLabel(c)}】` })),
        { id: 'no', label: '不发动' },
      ],
      (st, _p, picked) => {
        const card = nowMounts.find((c) => c.id === picked);
        if (card) {
          // 跨步询问：回答时这张坐骑可能已经不在（被搬走/弃掉）→ 按 id 重新定位，
          // 别去动**另一张**坐骑（此前会置空错的槽、还可能把旧牌再推一次弃牌堆）
          const slot = (['plusMount', 'minusMount'] as const).find(
            (sl) => target.equipment[sl]?.id === card.id,
          );
          if (!slot) return;
          // 吴景·风扬：异势力角色不能弃置同队列成员装备区里的牌
          if (fengyangBlocksEquip(st, source!.seatId, target, card)) {
            pushLog(st, 'resolve', `${target.name} 的【${cardLabel(card)}】受【风扬】保护，未被弃置。`, {
              seat: target.seatId,
              action: 'shield',
            });
            return;
          }
          target.equipment[slot] = null;
          toDiscard(st, card);
          pushLog(
            st,
            'equip',
            `${source!.name} 的【麒麟弓】弃置了 ${target.name} 的【${cardLabel(card)}】。`,
            { seat: source!.seatId, action: 'equip' },
          );
          // 失去坐骑也可能触发「失去装备区牌」的技能（枭姬那类）
          fireEquipLost(st, target, card, () => after());
          return;
        }
        after();
      },
    );
  };

  // ① 寒冰剑：只有「拿的是寒冰剑」且「目标有牌」才问
  if (weapon !== 'hanbing' || targetCardCount(target) === 0) {
    thenQilin();
    return;
  }
  askChoice(
    state,
    source!.seatId,
    `是否发动【寒冰剑】，防止对 ${target.name} 的伤害，改为弃置其两张牌？`,
    [
      { id: 'yes', label: '发动（防止伤害，弃其两张牌）' },
      { id: 'no', label: '不发动（照常造成伤害）' },
    ],
    (st, _p, picked) => {
      if (picked !== 'yes') {
        thenQilin();
        return;
      }
      pushLog(
        st,
        'equip',
        `${source!.name} 的【寒冰剑】防止了伤害，改为弃置 ${target.name} 的牌。`,
        { seat: source!.seatId, action: 'equip' },
      );
      // 依次弃置两张：有手牌先弃手牌，不够再弃装备/判定（由玩家选，这里自动取前两张）
      const victims = targetDiscardableCards(target).slice(0, 2);
      for (const c of victims) {
        removeTargetCard(target, c);
        toDiscard(st, c);
        pushLog(st, 'discard', `${target.name} 的【${cardLabel(c)}】被弃置。`);
      }
      // 伤害被防止 → 没有伤害结算（铁索不蔓延、不进濒死）
      const finishPrevented = (): void => resumePlay(st, st.seatOrder[st.turn.seatIndex]!);
      const lostEquips = victims.filter((c) => isEquipCard(c));
      // 一次动作同时失去多张装备 → **共用同一个 eventId**（旋略只问一次、兴棹只算一批）
      const batchId = lostEquips.length > 1 ? ++st.equipLossSeq : undefined;
      const step = (i: number): void => {
        if (i >= lostEquips.length) {
          finishPrevented();
          return;
        }
        const eq = lostEquips[i]!;
        fireEquipLost(st, target, eq, () => step(i + 1), batchId ? { id: batchId, cards: [eq] } : undefined);
      };
      step(0);
    },
  );
}

/** 目标手上+装备区+判定区里可被弃置的牌（手牌优先） */
function targetDiscardableCards(target: Player): Card[] {
  return [
    ...target.hand,
    ...(EQUIP_SLOTS.map((s) => target.equipment[s]).filter(Boolean) as Card[]),
    ...target.judgment,
  ];
}

function targetCardCount(target: Player): number {
  return targetDiscardableCards(target).length;
}

/** 从目标的任意区域移除一张牌（手牌/装备/判定），供装备特效弃牌用 */
function removeTargetCard(target: Player, card: Card): void {
  const eq = target.equipment;
  for (const slot of EQUIP_SLOTS) {
    if (eq[slot]?.id === card.id) {
      eq[slot] = null;
      return;
    }
  }
  if (target.judgment.some((c) => c.id === card.id)) {
    target.judgment = target.judgment.filter((c) => c.id !== card.id);
    return;
  }
  removeCard(target.hand, card.id);
}

/**
 * 三尖两刃刀：你使用【杀】对目标角色造成伤害**后**，可以弃置一张手牌，
 * 然后对该角色距离 1 的另一名角色造成 1 点伤害。
 *
 * 目标已阵亡就不发动（官方 FAQ：伤害后目标已死，死亡角色不再参与距离计算）。
 */
function askSanjian(state: GameState, attack: AttackContext, after: () => void): void {
  const source = getPlayer(state, attack.sourceId);
  const target = getPlayer(state, attack.targetId);
  if (attack.asType !== 'sha') {
    after();
    return;
  }
  if (!source || source.equipment.weapon?.equipName !== 'sanjian') {
    after();
    return;
  }
  if (!target || !target.alive || target.seatId === source.seatId) {
    after();
    return;
  }
  if (source.hand.length === 0) {
    after();
    return;
  }
  const others = state.players.filter(
    (p) => p.alive && p.seatId !== target.seatId && distance(state, target.seatId, p.seatId) <= 1,
  );
  if (others.length === 0) {
    after();
    return;
  }
  askChoice(
    state,
    source.seatId,
    `是否发动【三尖两刃刀】？（弃一张手牌，对 ${target.name} 距离 1 的角色造成 1 点伤害）`,
    [
      { id: 'yes', label: '发动' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') {
        after();
        return;
      }
      askPickCards(
        st,
        p.seatId,
        '【三尖两刃刀】：弃置一张手牌',
        p.hand.slice(),
        1,
        1,
        (st2, p2, cards) => {
          const c = cards[0];
          if (c) {
            removeCard(p2.hand, c.id);
            toDiscard(st2, c);
            pushLog(st2, 'skill', `${p2.name} 弃置【${cardLabel(c)}】发动【三尖两刃刀】。`);
          }
          const aliveOthers = st2.players.filter(
            (x) =>
              x.alive && x.seatId !== target.seatId && distance(st2, target.seatId, x.seatId) <= 1,
          );
          if (aliveOthers.length === 0) {
            after();
            return;
          }
          askChoice(
            st2,
            p2.seatId,
            '【三尖两刃刀】：选择受到 1 点伤害的角色',
            aliveOthers.map((x) => ({ id: x.seatId, label: x.name })),
            (st3, _p3, seatId) => {
              const victim = getPlayer(st3, seatId);
              if (!victim) {
                after();
                return;
              }
              const extra: AttackContext = {
                sourceId: p2.seatId,
                cardId: attack.cardId,
                asType: 'sha',
                targetId: victim.seatId,
                damage: 1,
                dodged: false,
              };
              damageStep(st3, victim, extra, 1, (dmg, prevented) => {
                if (!prevented) {
                  pushLog(
                    st3,
                    'damage',
                    `${victim.name} 被【三尖两刃刀】造成 ${dmg} 点伤害，剩余 ${Math.max(0, victim.hp)} 体力。`,
                    { seat: victim.seatId, action: 'damage' },
                  );
                }
                if (prevented) {
                  after();
                  return;
                }
                runDamagedHooks(st3, victim, extra, dmg, () => {
                  if (victim.hp <= 0) {
                    enterNearDeath(st3, extra);
                    return;
                  }
                  after();
                });
              });
            },
          );
        },
        // 钩子外（出牌阶段内的装备结算）发起，问完要把控制权还给发动者
        { returnTo: p.seatId },
      );
    },
  );
}

// ——————————————————————————————————————————
// 濒死 / 死亡
// ——————————————————————————————————————————

function enterNearDeath(state: GameState, attack: AttackContext): void {
  const dying = getPlayerOrThrow(state, attack.targetId);
  // nearDeath 可挂起：涅槃这类技能要在濒死时询问，然后把人救回来
  runHooksPausable(state, 'nearDeath', dying, { attack }, () => {
    // 别人也想知道「有人进濒死了」（田丰·随势）：派给除濒死者外的所有人
    runAllPlayersHooks(
      state,
      'otherNearDeath',
      { attack, dyingId: dying.seatId },
      () => afterNearDeath(state, attack, dying),
      dying.seatId,
    );
  });
}

/** nearDeath（本人）+ otherNearDeath（旁人）都跑完了，接着走原来的濒死处理 */
function afterNearDeath(state: GameState, attack: AttackContext, dying: Player): void {
  if (dying.hp > 0) {
    // 被技能救回来了（涅槃/不屈）：不建濒死队列，把控制权还回去
    pushLog(state, 'nearDeath', `${dying.name} 脱离了濒死状态。`);
    // 诸葛恪·黩武：「结算期间有人**进入濒死并被救回**」——这里正好是「被技能救回」的出口
    if (state.duwuWatchSeat) state.duwuRescued = true;
    dispatchNearDeathResolved(state, dying.seatId, true, attack.sourceId, () => {
      resumePlay(state, state.seatOrder[state.turn.seatIndex]!);
    });
    return;
  }
  enterDeathQueue(state, dying, attack.sourceId);
}

/**
 * 「濒死结算结束后」的统一派发（左慈·汲魂、吴国太·补益）。
 *
 * payload：`{ dyingSeatId, alive, sourceId }`——`alive` 是结算完还活着没有，
 * `sourceId` 是**本次伤害来源**（没有来源的伤害、或来源已不在场上时可能是 undefined）。
 *
 * ⚠️ 这个时机原来只有声明和消费方、**没有派发点**，所以汲魂的后半句从来没生效过
 *    （它的测试只覆盖了「受伤后补魂」那一半，正好没撞上）。现在三个出口都派发：
 *    被技能救回、被【桃】救回、以及真的阵亡。
 */
function dispatchNearDeathResolved(
  state: GameState,
  dyingSeatId: string,
  alive: boolean,
  sourceId: string | undefined,
  after: () => void,
): void {
  runAllPlayersHooks(
    state,
    'nearDeathResolved',
    { dyingSeatId, alive, sourceId },
    after,
  );
}

/** 建立濒死求桃队列（完杀在这里生效）。killerId 供阵亡后的「杀死角色后」技能用 */
function enterDeathQueue(state: GameState, dying: Player, killerId?: string): void {
  // 从濒死者起、按座次轮询每个存活玩家能否出桃
  let queue = aliveSeatsFrom(state, dying.seatId);
  // 完杀（贾诩）：其回合内，只有濒死者本人与完杀持有者能使用【桃】救援
  const turnSeatId = state.seatOrder[state.turn.seatIndex];
  const turnPlayer = turnSeatId ? getPlayer(state, turnSeatId) : undefined;
  const wanshaActive =
    !!turnPlayer && activeHeroes(state, turnPlayer).some((h) => h.blocksExternalSaves === true);
  if (wanshaActive && turnSeatId) {
    const allowed = new Set<string>([dying.seatId, turnSeatId]);
    const filtered = queue.filter((s) => allowed.has(s));
    if (filtered.length !== queue.length) {
      pushLog(
        state,
        'skill',
        `【完杀】生效：只有 ${dying.name} 与 ${turnPlayer!.name} 能使用【桃】。`,
      );
    }
    queue = filtered;
  }
  if (queue.length === 0) {
    doDeath(state, dying.seatId, killerId);
    return;
  }
  setPending(state, {
    kind: 'respondDeath',
    dyingId: dying.seatId,
    askQueue: queue,
    askIndex: 0,
    // 记住是谁打的——阵亡后要用它触发「杀死角色后」的技能（行殇）
    killerId,
  });
  pushLog(state, 'nearDeath', `${dying.name} 濒死，等待出桃救援。`);
}

/** 设定胜方并写日志，返回 true 表示游戏结束 */
function setWinner(state: GameState, winner: string): true {
  state.gameOver = true;
  setPending(state, null);
  state.turn.phase = 'gameOver';
  state.winner = winner || null;
  let msg: string;
  if (state.mode === 'junzheng') {
    msg =
      winner === 'rebel'
        ? '游戏结束，反贼胜利。'
        : winner === 'lord'
          ? '游戏结束，主忠方胜利。'
          : winner === 'renegade'
            ? '游戏结束，内奸胜利。'
            : '游戏结束。';
  } else if (state.mode === '2v2') {
    msg =
      winner === 'team0'
        ? '游戏结束，队伍1（座位1/3）胜利。'
        : winner === 'team1'
          ? '游戏结束，队伍2（座位2/4）胜利。'
          : '游戏结束。';
  } else if (state.mode === 'guozhan') {
    const fname = (winner && FACTION_NAME[winner as Faction]) || '';
    msg = fname ? `游戏结束，${fname}势力胜利。` : '游戏结束。';
  } else {
    const wp = getPlayer(state, winner);
    msg = wp ? `游戏结束，${wp.name} 获胜。` : '游戏结束。';
  }
  pushLog(state, 'gameover', msg);
  return true;
}

/** 死亡后检查胜负：返回 true 表示游戏已结束 */
function checkWin(state: GameState): boolean {
  const alive = alivePlayers(state);

  if (state.mode === '2v2') {
    const team0Alive = alive.some((p) => p.team === 0);
    const team1Alive = alive.some((p) => p.team === 1);
    if (!team0Alive) return setWinner(state, 'team1');
    if (!team1Alive) return setWinner(state, 'team0');
    return false;
  }

  if (state.mode === 'junzheng') {
    // 仅剩 1 人：根据存活者身份判定
    if (alive.length === 1) {
      const sole = alive[0]!;
      if (sole.role === 'renegade') return setWinner(state, 'renegade');
      if (sole.role === 'lord' || sole.role === 'loyal') return setWinner(state, 'lord');
      if (sole.role === 'rebel') return setWinner(state, 'rebel');
      return setWinner(state, '');
    }
    // 主公阵亡 → 反贼胜
    const lord = alive.find((p) => p.role === 'lord');
    if (!lord) return setWinner(state, 'rebel');
    // 反贼与内奸全灭 → 主忠胜
    const rebelsAlive = alive.some((p) => p.role === 'rebel');
    const renegadesAlive = alive.some((p) => p.role === 'renegade');
    if (!rebelsAlive && !renegadesAlive) return setWinner(state, 'lord');
    return false;
  }

  if (state.mode === 'guozhan') {
    if (alive.length === 0) return false;
    if (alive.length === 1) return setWinner(state, alive[0]!.faction ?? alive[0]!.seatId);
    // 统计存活阵营（统一走 factionAliveCount，别再手写一份 Map）
    const factionCounts = new Map<string, number>();
    for (const p of alive) {
      const f = p.faction ?? 'neutral';
      factionCounts.set(f, (factionCounts.get(f) ?? 0) + 1);
    }
    // 某非野心家阵营存活数 > 半数 → 该阵营胜
    const half = Math.floor(alive.length / 2);
    for (const f of factionCounts.keys()) {
      if (f === 'ambitionist' || f === 'neutral') continue;
      if (factionAliveCount(state, f as Faction) > half) return setWinner(state, f);
    }
    // 到这里说明没有任何阵营过半，且场上还有 ≥2 名存活者。
    // 「只剩 1 个非野心家阵营」的情况不必单独判——那时它的存活数等于存活总数，
    // 必然满足上面的过半条件（上面已把野心家/中立排除在计数之外）。
    return false;
  }

  // melee：最后存活者胜
  if (alive.length <= 1) {
    if (alive.length === 1) return setWinner(state, alive[0]!.seatId);
    return setWinner(state, '');
  }
  return false;
}

/**
 * 君主阵亡的连带效果：**与你势力相同的其他角色各失去 1 点体力**。
 *
 * 见 docs/guozhan-reference.md §3（官方君主将固定特性）。实现要点：
 * - 「同势力」按**阵亡那一刻**的势力算（阵亡会把双将亮出，所以君主一定是明置的）；
 * - 失去体力不是伤害，所以不派发伤害类钩子（只记日志 + 走濒死）；
 * - 逐个结算：中途有人被打进濒死（会挂起）就把剩下的压进续接队列，
 *   等那串濒死走完再继续，最后调 `after`（死者自己的收尾）。
 */
function lordDeathLoss(
  state: GameState,
  dying: Player,
  index: number,
  after: () => void,
): void {
  const victims =
    index === 0
      ? state.players.filter((p) => p.alive && p.seatId !== dying.seatId && sameKnownFaction(state, dying, p))
      : lordVictimsOf(state, dying);
  if (index >= victims.length) {
    after();
    return;
  }
  const v = victims[index]!;
  if (v.alive) {
    v.hp -= 1;
    pushLog(
      state,
      'damage',
      `${dying.name}（君主）阵亡：${v.name} 失去 1 点体力，剩余 ${Math.max(0, v.hp)} 体力。`,
    );
    if (v.hp <= 0) {
      pushResume(state, () => lordDeathLoss(state, dying, index + 1, after));
      enterNearDeath(state, {
        sourceId: v.seatId,
        cardId: '',
        asType: 'sha',
        targetId: v.seatId,
        damage: 1,
        dodged: false,
      });
      return;
    }
  }
  lordDeathLoss(state, dying, index + 1, after);
}

/** 续接时重算「同势力存活者」（中途可能有人死了，位置会变） */
function lordVictimsOf(state: GameState, dying: Player): Player[] {
  return state.players.filter(
    (p) => p.alive && p.seatId !== dying.seatId && sameKnownFaction(state, dying, p),
  );
}

function doDeath(state: GameState, dyingId: string, killerId?: string): void {
  const dying = getPlayerOrThrow(state, dyingId);
  // ⚠️ 必须在下面那几行之前问：阵亡会把「明置」标志翻成 false→true（国战亮双将），
  //    而【会盟】要的是「他**生前**在不在明置计数里」。
  const wasDetermined = dying.heroRevealed || dying.deputyRevealed;
  // ⚠️ 「阵亡令同势力各失去 1 点体力」是**君主将**的固定特性（官方公告：君主将阵亡时…），
  //    不是国战的通用阵亡规则。以前这里对所有阵亡都调 lordDeathLoss，等于每死一个人
  //    同势力就全体掉 1 血（连坐）。在翻明置标志前按武将牌判一次，只对君主生效。
  const wasLord = [dying.heroId, dying.deputyHeroId].some(
    (id) => !!id && getHero(id)?.isLord === true,
  );
  dying.alive = false;
  dying.hp = 0;
  // 国战：阵亡时亮双将
  if (state.mode === 'guozhan') {
    dying.heroRevealed = true;
    dying.deputyRevealed = true;
  }

  /**
   * 收尾：跑「死亡」钩子 → 把死者的牌清进弃牌堆 → 判胜负 → 回到出牌阶段。
   *
   * 之所以要拆出来：`kill`（杀死角色后）钩子可能发起询问（曹丕·行殇要问是否获得
   * 死者的全部牌），那时得先把控制权交给询问，等它完了再接着清牌——
   * **行殇必须在牌被清掉之前拿到它们**。
   */
  const afterKill = (): void => {
    const roleText = dying.role ? `（${ROLE_NAME[dying.role]}）` : '';
    // 会盟/暗将口径读「已确定势力」（双势力确定后 faction 可能已不同）
    const dyingFaction = dying.determinedFaction ?? dying.faction;
    const factionText = dyingFaction ? `（${FACTION_NAME[dyingFaction]}）` : '';
    pushLog(state, 'death', `${dying.name} 阵亡${roleText}${factionText}。`);
    // 走可挂起版本：蔡文姬·断肠要在死亡时问「让凶手失去哪张武将牌的技能」
    runHooksPausable(state, 'death', dying, { killerId }, () => {
      // 【会盟】：这个人的势力（已明置口径）是不是正好**一个都不剩**了。
      // to 是此刻的数，from 加上他自己就是死前的数（thus 两个方向都能如实报出来）。
      const to = knownFactionCount(state, dyingFaction);
      const from = to + (wasDetermined ? 1 : 0);
      const afterDeath = (): void => {
        // 「濒死结算结束后」的第三个出口：这回是真的没了（alive=false）。
        // 补益/汲魂都要求「存活」所以这里不会真的发动，但时机本身要派发出去。
        dispatchNearDeathResolved(state, dying.seatId, false, killerId, () => {
          // 清牌：行殇没拿走的才进弃牌堆
          const cleanup = (): void => {
            for (const c of dying.hand) toDiscard(state, c);
            dying.hand = [];
            const eq = dying.equipment;
            for (const c of EQUIP_SLOTS.map((s) => eq[s])) {
              if (c) toDiscard(state, c);
            }
            dying.equipment = emptyEquipment();
            for (const c of dying.judgment) toDiscard(state, c);
            dying.judgment = [];
            // 判定阶段手里还攥着的那叠（典型：自己的【闪电】把自己劈死）：也归他，一并弃置。
            // 不处理的话它们谁都不在、再也回不来（见 GameState.judgmentInFlight）
            const ledger = state.judgmentInFlight;
            if (ledger && ledger.seatId === dying.seatId) {
              for (const c of ledger.cards) toDiscard(state, c);
              state.judgmentInFlight = null;
            }

            if (checkWin(state)) return;
            // 回到当前回合玩家（伤害来源）的出牌阶段
            resumePlay(state, state.seatOrder[state.turn.seatIndex]!);
          };
          // 君主阵亡：**与你势力相同的角色各失去 1 点体力**（官方君主将的固定特性之一，
          // 只有君主将阵亡才触发——判定见上面的 wasLord）。
          // 失去体力可能把人打进濒死，所以逐个来：谁进了濒死就把「剩下的」压进续接队列，
          // 等那串濒死结算完了接着掉（同一次同步执行里连开两串濒死会把 pending 覆盖掉）。
          if (wasLord) lordDeathLoss(state, dying, 0, cleanup);
          else cleanup();
        });
      };
      if (from > 0 && to === 0) {
        runAllPlayersHooks(
          state,
          'factionCountChanged',
          { faction: dyingFaction, from, to },
          afterDeath,
        );
        return;
      }
      afterDeath();
    });
  };

  const killer = killerId && killerId !== dyingId ? getPlayer(state, killerId) : undefined;
  if (killer?.alive) {
    // 「有人死亡时」派给**全场**（孙綝·嗜戮那类旁观者技能）——只有场上真有人挂这个时机才走这一层，
    // 否则与原路径完全等价（多一层可挂起嵌套会改变续接顺序，这是踩过的坑）。
    runHooksPausable(state, 'kill', killer, { victimId: dyingId }, () => {
      const needsAny = state.players.some(
        (p) => p.alive && collectTimingHooks(state, p, 'playerDied', true).length > 0,
      );
      if (!needsAny) {
        afterKill();
        return;
      }
      const list = state.players.filter((p) => p.alive);
      const step = (i: number): void => {
        const p = list[i];
        if (!p) {
          afterKill();
          return;
        }
        runHooksPausable(state, 'playerDied', p, { victimId: dyingId, killerId }, () =>
          step(i + 1),
        );
      };
      step(0);
    });
    return;
  }
  afterKill();
}

// ——————————————————————————————————————————
// 意图分发
// ——————————————————————————————————————————

// 装备特效（equip.ts）需要发问，但那边不能反向 import 本文件（循环依赖）→ 注入进去。
// askChoice / askPickCards 是函数声明（会提升），放在模块顶层调用即可。
setEquipAskHooks({
  askChoice,
  askPickCards,
  // 【盟军大纛】弃两张牌要走这条：里面可能有装备，得触发失去装备那类技能
  discardCards: discardOwnCards,
});

export function applyIntent(state: GameState, seatId: string, intent: Intent): ApplyResult {
  // 手牌清空检测要在任何变更之前取快照，否则拿不到「原来是几张」
  const handBefore = state.players.map((p) => p.hand.length);
  // 「失去牌」也走快照比对：把每个人「手牌 + 装备区」的牌 id 记下来，意图跑完再看少了谁
  // ——比在二十多处移牌的地方逐处挂钩子可靠得多（与 checkHandEmptied 同一套思路）。
  const ownedBefore = state.players.map((p) => ownedCardIds(p));
  const turnSeatBefore = state.turn.seatIndex;
  const result = applyIntentInner(state, seatId, intent);
  if (result.ok) {
    // 询问结束后接着跑被打断的流程。控制流的唯一收口，别在别处再调 drainResume。
    drainResume(state);
    // 「这张牌是谁从牌堆摸到的」（袁术·伪帝）：要跟 ownedBefore 比，才能区分「自己摸的」和
    // 「别人摸出来、被顺手牵羊拿走的」——所以和失去牌的检测放在一起。
    attributeDeckGains(state, ownedBefore);
    // 兜底：续接排空之后如果**什么都不挂起**，而回合还没交出去，就把「该谁动手」还给玩家。
    //
    // 为什么要这一道：技能自己的链条（例如吕范·调度「按座次依次问同势力角色」）里，某一步
    // 「移动装备」会**嵌套**触发别人的钩子（枭姬那类会发问），实测那次嵌套询问结束之后
    // **整条外层链的续接都没有跑**（探针都没触发）——结果是 `pending` 停在 null、玩家再也
    // 动不了、整局静默卡死。这类「问到一半把控制权弄丢」是这套引擎最贵的一类 bug，所以
    // 在这里放一道兜底，把「卡死」降级成「控制权还给该动的人」。
    //
    // ① 回合座次没变（变了说明这个意图正常结束了回合，别乱塞 pending）；
    // ② 只补**出牌/弃牌**这两个「等玩家动手」的阶段——判定/摸牌阶段各有自己的推进函数，
    //    不该由这里插手。
    //    弃牌阶段那一支是后来补的：`seed=1999` 里弃牌阶段的占位被【屯田】的问话覆盖之后，
    //    整条流程的收尾没回来，pending 停在 null（兜底当时只认出牌阶段）→ 整局卡死。
    //    `beginDiscard` 是按**当前**手牌重算的，已经弃过就不会再来一次（幂等）。
    if (state.pending === null && !state.gameOver && state.turn.seatIndex === turnSeatBefore) {
      const turnSeat = state.seatOrder[state.turn.seatIndex]!;
      if (state.turn.phase === 'play') {
        setPending(state, { kind: 'play', seatId: turnSeat });
      } else if (state.turn.phase === 'discard') {
        const cur = getPlayer(state, turnSeat);
        if (cur) beginDiscard(state, cur);
      }
    }
    // 手牌清空检测放最后：续接都跑完了才是这一手意图的真正终态
    checkHandEmptied(state, handBefore);
    checkCardsLost(state, ownedBefore);
  }
  return result;
}

/** 某人「手牌 + 装备区」里的牌 id（失去牌的快照用） */
function ownedCardIds(p: Player): string[] {
  const out = p.hand.map((c) => c.id);
  for (const slot of EQUIP_SLOTS) {
    const c = p.equipment[slot];
    if (c) out.push(c.id);
  }
  return out;
}

/**
 * 把本回合抽到的牌**归因到人**（袁术·伪帝：「本回合从牌堆获得过牌的角色」）。
 *
 * 判定依据：某张牌在这一手意图里**第一次**出现在某人的手牌/装备区，且它在本次抽牌账本
 * （`gainedFromDeckThisTurn`，drawOne 里登记）里，且还没归给别人 → 就算这个人摸的。
 * 这样「A 摸到的牌被 B 顺手牵羊拿走」不会把 B 也算成摸牌的人（只看牌 id 列表做不到）。
 */
function attributeDeckGains(state: GameState, ownedBefore: string[][]): void {
  const drawn = state.gainedFromDeckThisTurn;
  if (drawn.length === 0) return;
  state.players.forEach((p, i) => {
    if (!p.alive) return;
    const before = new Set(ownedBefore[i] ?? []);
    for (const id of ownedCardIds(p)) {
      if (before.has(id)) continue; // 本来就在他手里
      if (!drawn.includes(id)) continue; // 不是本回合从牌堆抽出来的
      if (state.deckGainOwner[id]) continue; // 已经归过人了
      state.deckGainOwner[id] = p.seatId;
    }
  });
}

/**
 * 「你于**回合外**失去牌后」（邓艾·屯田）：比对意图前后的「手牌 + 装备区」，
 * 少掉的牌就是这一手失去的。只派人**自己的回合之外**的那一条（官方条件），
 * 交给技能自己判断要不要发动。
 */
function checkCardsLost(state: GameState, ownedBefore: string[][]): void {
  const turnSeat = state.seatOrder[state.turn.seatIndex];
  state.players.forEach((p, i) => {
    if (!p.alive) return;
    const before = ownedBefore[i];
    if (!before) return;
    const now = new Set(ownedCardIds(p));
    const lost = before.filter((id) => !now.has(id));
    if (lost.length === 0) return;
    // 「你于此阶段失去了几张牌」（吕范·典财）：不管是不是自己的回合都累加
    p.flags.lostCardsThisPhase += lost.length;
    if (p.seatId === turnSeat) return; // 屯田那种「回合外失去牌」才派发
    runHooksPausable(state, 'cardsLost', p, { cardIds: lost }, () => {});
  });
}

/**
 * 检测「失去最后一张手牌」（陆逊·连营）。
 *
 * 用比对而不是在每处 removeCard 后面挂钩子：手牌减少的路径有二十多处
 * （出牌、响应、弃牌、被拆被顺、技能弃牌、阵亡…），逐处挂必然漏。
 *
 * ⚠️ 已知局限：比对的是「这一手意图开始前 vs 结束后」，所以**同一段结算里
 *    先清空、又摸回来**的情况（例如用最后一张【无中生有】）检测不到。
 *    要精确覆盖得把触发点下沉到每一处移牌，代价是改二十多个调用点。
 */
function checkHandEmptied(state: GameState, handBefore: number[]): void {
  state.players.forEach((p, i) => {
    if ((handBefore[i] ?? 0) > 0 && p.hand.length === 0 && p.alive) {
      runHooksPausable(state, 'handEmptied', p, undefined, () => {
        // 「**其他角色**失去所有手牌后」（蒋琬费祎·守成）：连营那种只发给本人的
        // 时机观察不到别人的手牌清空，所以这里再派一轮给旁人
        runAllPlayersHooks(
          state,
          'othersHandEmptied',
          { emptiedSeatId: p.seatId },
          () => {},
          p.seatId,
        );
      });
    }
  });
}

function applyIntentInner(state: GameState, seatId: string, intent: Intent): ApplyResult {
  if (state.gameOver) return err('游戏已结束');
  // 选将阶段优先处理（并发：所有未选将的座位同时可行动）
  if (state.draft) return onPickHero(state, seatId, intent);
  const pending = state.pending;
  if (!pending) return err('当前无需行动');

  switch (intent.type) {
    case 'playCard':
      return onPlayCard(state, seatId, intent);
    case 'chooseOption': {
      const pending = state.pending;
      if (!pending || pending.kind !== 'choice') return err('当前没有需要选择的选项');
      if (pending.seatId !== seatId) return err('不是你在选择');
      const picked = pending.options.find((o) => o.id === intent.optionId);
      if (!picked) return err('选项无效');
      const player = getPlayerOrThrow(state, seatId);
      setPending(state, null);
      state.log.push({
        id: state.logSeq++,
        kind: 'skill',
        message: `${player.name} 选择了「${picked.label}」。`,
      });
      // 回答回调算「续接」：它里面再入队的续接要插队首（见 pushResume）
      runResume(() => pending.resolve(state, player, picked.id));
      // 选完若没有产生新的流程（濒死、下一张判定等），把控制权还给发起者
      if (state.pending === null && pending.returnTo) {
        resumePlay(state, pending.returnTo);
      }
            // 输入槽空了 → 先唤醒「等这条询问」的收尾待办（订阅式），再排空续接队列
      runPendingWaiters(state);
      drainResume(state);
      return { ok: true };
    }

    case 'respondCard':
      return onRespondCard(state, seatId, intent);
    case 'pass':
      return onPass(state, seatId);
    case 'endPhase':
      return onEndPhase(state, seatId);
    case 'discard':
      return onDiscard(state, seatId, intent);
    case 'revealHero':
      return onRevealHero(state, seatId, intent);
    case 'useSkill':
      return onUseSkill(state, seatId, intent);
    case 'pickCards':
      return onPickCards(state, seatId, intent);
    case 'factionCall':
      return onFactionCall(state, seatId, intent);
    case 'recast':
      return onRecast(state, seatId, intent);
    case 'prelightSkill':
      return onPrelightSkill(state, seatId, intent);
    case 'lianheng':
      return onLianheng(state, seatId, intent);
    case 'ack': {
      const p = state.pending;
      if (!p || p.kind !== 'viewCards') return err('当前没有需要确认的信息');
      if (p.seatId !== seatId) return err('不是你在看这张牌');
      setPending(state, null);
      // 技能发起的查看：接着跑技能的下一步
      if (p.after) {
        const after = p.after;
        after();
              // 输入槽空了 → 先唤醒「等这条询问」的收尾待办（订阅式），再排空续接队列
      runPendingWaiters(state);
      drainResume(state);
      return { ok: true };
      }
      if (p.returnTo) resumePlay(state, p.returnTo);
      return { ok: true };
    }
    default:
      return err('未知意图');
  }
}

/** 处理「从一组牌里选」的回应 */
function onPickCards(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'pickCards' }>,
): ApplyResult {
  const pending = state.pending;
  if (!pending || pending.kind !== 'pickCards') return err('当前没有需要选牌的地方');
  if (pending.seatId !== seatId) return err('不是你在选牌');
  const player = getPlayerOrThrow(state, seatId);
  const ids = intent.cardIds ?? [];
  if (ids.length < pending.min || ids.length > pending.max)
    return err(`需选择 ${pending.min}-${pending.max} 张牌`);
  const picked: Card[] = [];
  for (const id of ids) {
    const c = pending.cards.find((x) => x.id === id);
    if (!c) return err('选的牌不在候选里');
    picked.push(c);
  }
  setPending(state, null);
  pushLog(
    state,
    'skill',
    pending.secret
      ? `${player.name} 选择了 ${picked.length} 张牌。`
      : `${player.name} 选择了 ${picked.map((c) => `【${cardLabel(c)}】`).join('、') || '（无）'}。`,
  );
  runResume(() => pending.resolve(state, player, picked));
  // 选完若没有产生新的流程（濒死等），把控制权还给发起者
  if (state.pending === null && pending.returnTo) {
    resumePlay(state, pending.returnTo);
  }
        // 输入槽空了 → 先唤醒「等这条询问」的收尾待办（订阅式），再排空续接队列
      runPendingWaiters(state);
      drainResume(state);
      return { ok: true };
}

function onPlayCard(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'playCard' }>,
): ApplyResult {
  const pending = state.pending!;
  if (pending.kind !== 'play' || pending.seatId !== seatId) return err('不是你的出牌阶段');
  const player = getPlayerOrThrow(state, seatId);
  // 【木牛流马】扣置的牌可以「如手牌般使用」，所以候选范围是 usableCardsOf；
  // 带 extraCardIds 时这里是【丈八蛇矛】凑出来的虚拟【杀】（见 resolveUsedCard）
  const resolved = resolveUsedCard(state, player, intent);
  if ('error' in resolved) return err(resolved.error);
  const card = resolved.card;
  // 「田」不是手牌：只能用【急袭】当【顺手牵羊】（转化合法性由下面那道 canUseAsCard 检查）
  if (isTianCard(card) && intent.as !== 'shunshou') {
    return err('「田」只能通过【急袭】当【顺手牵羊】使用');
  }
  // 「本回合不能使用或打出手牌」（军令 seal / 势备篇调虎离山）+ 马岱·潜袭的颜色限制
  {
    // 严白虎·雉盗：本回合只能指定「你与他」（含 AOE 那类不指定目标却会打到别人的牌）
    if (zhidaoTargetsBlocked(state, player, card, intent.targetIds)) {
      return err('【雉盗】：本回合只能指定你与你锁定的那名角色');
    }
    const blocked = blockedForPlay(player, card);
    if (blocked) return err(blocked);
  }

  const as = intent.as ?? card.type;
  // 转化合法性（武圣：红牌当杀；鏖战：桃当杀）。
  // 丈八凑出来的虚拟【杀】本身就是杀，不需要再过转化技那一关。
  if (!card.virtual && intent.as && intent.as !== card.type) {
    if (!canUseAsCard(state, player, card, intent.as!)) return err('不能将该牌转化为该类型');
    // 真的要用转化技了 → 明置提供它的那张武将牌（暗置+已预亮的情况）
    revealForConversion(state, player, card, intent.as);
  }

  // 沙摩柯·蒺藜：记下「这是本回合第几张使用/打出的牌」以及**牌生效前**的攻击范围。
  // 放在这里＝所有校验都过了、牌马上要生效之前（武器装上会改范围，所以必须取快照）。
  // 沙摩柯·蒺藜：记下「这是本回合第几张使用/打出的牌」以及**牌生效前**的攻击范围。
  // 放在这里＝所有校验都过了、牌马上要生效之前（武器装上会改范围，所以必须取快照）。
  player.flags.cardsUsedOrPlayed += 1;
  player.flags.actionRangeSnapshot = attackRange(state, player);
  const doPlay = (): ApplyResult => {
    // ⚠️ 这里**不要**再派发一次 cardActionStarted：外面那个 runHooksPausable 已经派发过了。
    //    以前这里多留了一句，于是每打一张牌钩子会跑两遍——对蒺藜那种「只读计数」的技能看不出问题
    //    （计数本身只加一次），但对有副作用的技能（黄月英·集智会摸牌）就会多摸一张。已删除。
    if (as === 'sha') return playSha(state, player, card, intent.targetIds, as, intent.asAttribute);
    if (as === 'tao') return playTao(state, player, card);
    if (as === 'jiu') return playJiu(state, player, card);
    if (canRecastCard(state, player, card)) return playMaybeRecast(state, player, card, as, intent);
    // 转化锦囊（甘宁·奇袭：黑色牌当过河拆桥）
    if (as !== card.type && isInstantTrick({ ...card, type: as }))
      return playTrick(state, player, { ...card, type: as }, intent);
    // 转化的延时锦囊（大乔·国色：方块牌当【乐不思蜀】）
    if (as !== card.type && isDelayedTrick({ ...card, type: as }))
      return playDelayedTrick(state, player, { ...card, type: as }, intent.targetIds);
    if (isEquipCard(card)) return playEquip(state, player, card);
    if (isDelayedTrick(card)) return playDelayedTrick(state, player, card, intent.targetIds);
    if (isInstantTrick(card)) return playTrick(state, player, card, intent);
    return err('该牌不能在出牌阶段主动使用');
  };
  // 「你使用或打出了本回合第 N 张牌」（沙摩柯·蒺藜）：在计数的同一处派发。
  // ⚠️ 必须把「真正出牌」放进回调里：钩子如果发问（蒺藜就问），询问会被紧随其后的
  //    playSha/playTrick 覆盖掉（与判定阶段那个坑同一类）。
  let result: ApplyResult = { ok: true };
  runHooksPausable(state, 'cardActionStarted', player, { card }, () => {
    result = doPlay();
  });
  return result;
}

/**
 * 这张牌此刻能不能重铸。
 *
 * 两种情况：①牌本身就是可重铸的（【铁索连环】【知己知彼】）；
 * ②武将有转化技把它变成可重铸的牌型——庞统·连环：梅花手牌当【铁索连环】使用**或重铸**。
 */
function canRecastCard(
  state: GameState,
  player: Player,
  card: import('@sgs/protocol').Card,
): boolean {
  // 「田」不能重铸（它只有急袭 / 资粮两个去处，见 isTianCard）
  if (isTianCard(card)) return false;
  if (isRecastable(card)) return true;
  return canUseAsCard(state, player, card, 'tiesuo') || canUseAsCard(state, player, card, 'zhibi');
}

/** 重铸一张牌：置入弃牌堆 → 摸一张。**不算使用**，所以不走 useCard 钩子。 */
function doRecast(
  state: GameState,
  player: Player,
  card: import('@sgs/protocol').Card,
  displayType: CardType,
): void {
  // ⚠️ 用 `takeUsableCard` 而不是 `removeCard(player.hand, …)`：可重铸的牌可能躺在
  //    邓艾的「田」或木牛流马的扣置区里——只从手牌删会**删不掉**，却照样把牌推进弃牌堆，
  //    于是同一张牌同时存在于两个区域（模糊测试抓到的重复牌就是这么来的）。
  const taken = takeUsableCard(player, card.id);
  if (!taken) return; // 牌已经不在他身上了（被移走/被拿走）→ 什么也不做
  toDiscard(state, taken);
  const drawn = drawOne(state);
  if (drawn) player.hand.push(drawn);
  pushLog(
    state,
    'recast',
    `${player.name} 重铸了【${CARD_TYPE_NAME[displayType]}】，摸了一张牌。`,
    { seat: player.seatId, action: 'recast' },
  );
}

/**
 * 【铁索连环】/【知己知彼】这类**可重铸**牌：不指定目标就是重铸，
 * 指定了目标才当锦囊用。这两条路径都必须在 playTrick 之前分流——
 * 否则重铸会被当成一次「使用牌」。
 */
function playMaybeRecast(
  state: GameState,
  player: Player,
  card: import('@sgs/protocol').Card,
  as: CardType,
  intent: Extract<Intent, { type: 'playCard' }>,
): ApplyResult {
  if (intent.targetIds.length === 0) {
    doRecast(state, player, card, as);
    return { ok: true };
  }
  // 有目标 → 当锦囊用（庞统用梅花牌时牌型要换成【铁索连环】）
  return playTrick(state, player, { ...card, type: as }, intent);
}

/**
 * 重铸意图：与「不指定目标地使用一张可重铸牌」等价。
 * 单独开一个意图是为了让界面有个不经过出牌选择流程的入口。
 */
function onRecast(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'recast' }>,
): ApplyResult {
  const pending = state.pending;
  if (!pending || pending.kind !== 'play' || pending.seatId !== seatId)
    return err('不是你的出牌阶段');
  const player = getPlayerOrThrow(state, seatId);
  {
    const card0 = player.hand.find((c) => c.id === intent.cardId);
    const blocked = card0 ? blockedForPlay(player, card0) : null;
    if (blocked) return err(blocked);
  }
  const card = player.hand.find((c) => c.id === intent.cardId);
  if (!card) return err('你没有这张牌');
  if (!canRecastCard(state, player, card)) return err('这张牌不能重铸');
  // 通过转化技重铸时，日志里要报转化后的牌名（庞统的梅花【杀】→【铁索连环】）
  const displayType: CardType = isRecastable(card) ? card.type : 'tiesuo';
  doRecast(state, player, card, displayType);
  return { ok: true };
}

function playTao(
  state: GameState,
  player: Player,
  card: import('@sgs/protocol').Card,
): ApplyResult {
  if (player.hp >= player.maxHp) return err('体力已满，不能使用桃');
  takeAndDiscard(state, player, card);
  const healed = healAndTrigger(state, player, 1);
  pushLog(state, 'tao', `${player.name} 使用了【桃】，回复 ${healed} 点体力。`, {
    seat: player.seatId,
    action: 'tao',
  });
  runHooksPausable(state, 'useCard', player, { card }, () => {});
  // 严白虎·寄篱：自己对自己用的**红色**基本牌也是「唯一目标」→ 此牌结算两次
  // （自己出牌阶段用【桃】回 2 点；【酒】那种靠标记生效的牌，重跑一次不叠加，
  //   见 Hero 注释里记的已知简化）
  jiliResolveSelfBasic(state, player, card);
  return { ok: true };
}

/**
 * 严白虎·寄篱：红色基本牌对**自己**也是「唯一目标」→ 使用者（＝他自己）再使用一张
 * **虚拟同名牌**。只在出牌阶段主动使用这条路上补（濒死求桃那条在 respondDeathSave 里）。
 *
 * 只处理【桃】：【桃】没有指定目标、也没有响应窗口，所以第二张的效果就是再回复 1 点体力。
 * ⚠️ 这里不套 `playTao` 的「体力已满不能使用【桃】」判定——那是**主动使用**的限制，
 *    寄篱这条是锁定技逼出来的「再使用一次」，不该被它挡掉（本引擎的口径，已记文档）。
 * 【酒】按 `flags.jiuActive` 布尔标记生效，第二张不会让伤害再 +1——同上，已记已知简化。
 */
function jiliResolveSelfBasic(state: GameState, player: Player, card: Card): void {
  if (card.virtual || card.generatedBy) return; // 虚拟牌不再生虚拟牌（防自环）
  if (cardColorOf(card) !== 'red') return;
  if (card.type !== 'tao') return;
  if (!effectiveHeroes(state, player).some((h) => h.jili === true)) return;
  useVirtualSameNameCard(state, player, card, player, (vcard) => {
    const healed = healAndTrigger(state, player, 1);
    pushLog(state, 'tao', `【${cardShortName(vcard)}】回复 ${healed} 点体力。`, {
      seat: player.seatId,
      action: 'tao',
    });
  });
}

function playJiu(
  state: GameState,
  player: Player,
  card: import('@sgs/protocol').Card,
): ApplyResult {
  takeAndDiscard(state, player, card);
  player.flags.jiuActive = true;
  pushLog(state, 'jiu', `${player.name} 使用了【酒】，下一张杀伤害+1。`, {
    seat: player.seatId,
    action: 'jiu',
  });
  runHooksPausable(state, 'useCard', player, { card }, () => {});
  return { ok: true };
}

/** 装备牌：放入对应槽位，旧装备进弃牌堆 */
function playEquip(
  state: GameState,
  player: Player,
  card: import('@sgs/protocol').Card,
): ApplyResult {
  {
    const gone = takeForField(state, player, card);
    if (gone) return err(gone);
  }
  const slot = card.type as (typeof EQUIP_SLOTS)[number];
  const old = player.equipment[slot];
  player.equipment[slot] = card;
  const name = card.equipName ? EQUIP_NAME[card.equipName] : CARD_TYPE_NAME[card.type];
  pushLog(state, 'equip', `${player.name} 装备了【${name}】。`, {
    seat: player.seatId,
    action: 'equip',
  });
  const afterEquip = (): void => {
    // 七星宝刀：置入装备区时弃置判定区与装备区其他所有牌
    const swept = applyQixingSweep(state, player, card);
    if (swept.length > 0) {
      pushLog(
        state,
        'equip',
        `${player.name} 的【七星宝刀】弃置了装备区与判定区其他 ${swept.length} 张牌。`,
      );
    }
    runHooksPausable(state, 'useCard', player, { card }, () => {});
  };
  // 旧装备被顶掉 = 失去装备区的一张牌（枭姬）
  if (old) {
    toDiscard(state, old);
    fireEquipLost(state, player, old, afterEquip);
  } else {
    afterEquip();
  }
  return { ok: true };
}

/** 延时锦囊：放入目标判定区
 *  闪电→置于自己判定区；乐不思蜀/兵粮寸断→目标为他人且距离≤1
 *  判定区同类延时锦囊上限1张 */
function playDelayedTrick(
  state: GameState,
  player: Player,
  card: import('@sgs/protocol').Card,
  targetIds: string[],
): ApplyResult {
  const type = card.type as 'lebu' | 'shandian' | 'bingliang';
  if (type === 'shandian') {
    // 闪电：置于自己判定区
    if (player.judgment.some((t) => t.type === 'shandian')) return err('你的判定区已有【闪电】');
    {
      const gone = takeForField(state, player, card);
      if (gone) return err(gone);
    }
    player.judgment.push(card);
    pushLog(state, 'shandian', `${player.name} 将【闪电】置于自己的判定区。`, {
      seat: player.seatId,
      action: 'shandian',
    });
    runHooksPausable(state, 'useCard', player, { card }, () => {});
    return { ok: true };
  }
  // 乐不思蜀 / 兵粮寸断：目标为其他存活玩家，距离≤1
  if (targetIds.length !== 1) return err('需指定 1 名目标');
  const targetId = targetIds[0]!;
  if (targetId === player.seatId) return err('不能以自己为目标');
  const target = getPlayer(state, targetId);
  if (!target || !target.alive) return err('目标无效');
  if (heroBlocksBeingTarget(state, target, card, player)) return err('该角色不能成为此牌的目标');
  // 奇才：使用锦囊牌无距离限制；刘琦·问计标记的那张实体牌同样无距离限制
  if (
    !heroIgnoresTrickDistance(activeHeroes(state, player), player) &&
    !wenjiMarked(player, card.id) &&
    distance(state, player.seatId, targetId) > 1
  )
    return err('目标超出距离1');
  if (target.judgment.some((t) => t.type === type)) return err('目标判定区已有同类延时锦囊');
  {
    const gone = takeForField(state, player, card);
    if (gone) return err(gone);
  }
  target.judgment.push(card);
  pushLog(
    state,
    type,
    `${player.name} 将【${CARD_TYPE_NAME[type]}】置于 ${target.name} 的判定区。`,
    { seat: player.seatId, action: type },
  );
  runHooksPausable(state, 'useCard', player, { card }, () => {});
  return { ok: true };
}

// ——————————————————————————————————————————
// 即时锦囊
// ——————————————————————————————————————————

/** 即时锦囊入口：校验目标 → 出牌 → 无懈询问 → 结算 */
function playTrick(
  state: GameState,
  player: Player,
  card: import('@sgs/protocol').Card,
  intent: Extract<Intent, { type: 'playCard' }>,
): ApplyResult {
  // 无懈可击（含国战版）不能主动使用
  if (isWuxieLike(card)) return err('【无懈可击】不能主动使用');

  const type = card.type as TrickType;

  // 校验目标数与距离
  if (type === 'wuzhong' || type === 'taoyuan') {
    // 自身/全体：无需指定目标
  } else if (type === 'guohe' || type === 'shunshou' || type === 'juedou' || type === 'huogong') {
    if (intent.targetIds.length !== 1) return err('需指定 1 名目标');
    const tid = intent.targetIds[0]!;
    if (tid === player.seatId) return err('不能以自己为目标');
    const t = getPlayer(state, tid);
    if (!t || !t.alive) return err('目标无效');
    // 锁定技（帷幕/谦逊等）：不能成为此牌的目标
    if (heroBlocksBeingTarget(state, t, card, player)) return err('该角色不能成为此牌的目标');
    // 奇才：使用锦囊牌无距离限制
    if (
      type === 'shunshou' &&
      !heroIgnoresTrickDistance(activeHeroes(state, player), player) &&
      !wenjiMarked(player, card.id) &&
      distance(state, player.seatId, tid) > 1
    )
      return err('顺手牵羊目标超出距离 1');
  } else if (type === 'jiedao') {
    if (intent.targetIds.length !== 2)
      return err('借刀杀人需指定 2 名目标（武器持有者 + 出杀目标）');
    const [holderId, shaTargetId] = intent.targetIds;
    const holder = getPlayer(state, holderId!);
    if (!holder || !holder.alive) return err('武器持有者无效');
    if (!holder.equipment.weapon) return err('目标没有武器');
    const shaTarget = getPlayer(state, shaTargetId!);
    if (!shaTarget || !shaTarget.alive) return err('出杀目标无效');
    if (shaTargetId === holderId) return err('不能指定武器持有者自身为出杀目标');
    if (!canTarget(state, holderId!, shaTargetId!)) return err('出杀目标超出武器持有者攻击范围');
  } else if (type === 'nanman' || type === 'wanjian') {
    // AOE：无需指定目标
  } else if (type === 'tiesuo') {
    // 铁索连环：一至两名角色（**可以含自己**），无距离限制
    if (intent.targetIds.length < 1 || intent.targetIds.length > 2)
      return err('【铁索连环】需指定 1 至 2 名目标');
    if (new Set(intent.targetIds).size !== intent.targetIds.length) return err('目标不能重复');
    for (const tid of intent.targetIds) {
      const t = getPlayer(state, tid);
      if (!t || !t.alive) return err('目标无效');
      if (heroBlocksBeingTarget(state, t, card, player)) return err('该角色不能成为此牌的目标');
    }
  } else if (type === 'yuanjiao') {
    // 远交近攻：一名与你势力不同、且已明置武将牌的其他角色
    if (intent.targetIds.length !== 1) return err('【远交近攻】需指定 1 名目标');
    const tid = intent.targetIds[0]!;
    if (tid === player.seatId) return err('不能以自己为目标');
    const t = getPlayer(state, tid);
    if (!t || !t.alive) return err('目标无效');
    if (!t.heroRevealed && !t.deputyRevealed)
      return err('目标尚未明置武将牌，不能成为【远交近攻】的目标');
    // 暗置的角色没有势力（暗将之间互视为不同势力）；目标必须已明置才谈得上「势力不同」
    if (effectiveFaction(state, player) === effectiveFaction(state, t))
      return err('【远交近攻】只能指定与你势力不同的角色');
    if (heroBlocksBeingTarget(state, t, card, player)) return err('该角色不能成为此牌的目标');
  } else if (type === 'xietianzi') {
    // 挟天子以令诸侯：只有大势力角色能对自己使用
    if (intent.targetIds.length !== 0) return err('【挟天子以令诸侯】只能对自己使用');
    if (!isBigFaction(state, effectiveFaction(state, player)))
      return err('只有大势力角色能使用【挟天子以令诸侯】');
  } else if (type === 'lutong') {
    // 勠力同心的目标是「所有大势力 / 所有小势力角色」——场上没有大势力就没有合法目标
    if (bigFactions(state).length === 0) return err('场上没有大势力，【勠力同心】没有目标');
  } else if (type === 'tiaohu') {
    // 调虎离山：一至两名**其他**角色，无距离限制
    if (intent.targetIds.length < 1 || intent.targetIds.length > 2)
      return err('【调虎离山】需指定 1 至 2 名目标');
    if (new Set(intent.targetIds).size !== intent.targetIds.length) return err('目标不能重复');
    for (const tid of intent.targetIds) {
      if (tid === player.seatId) return err('不能以自己为目标');
      const t = getPlayer(state, tid);
      if (!t || !t.alive) return err('目标无效');
      if (heroBlocksBeingTarget(state, t, card, player)) return err('该角色不能成为此牌的目标');
    }
  } else if (type === 'shuiyan') {
    // 水淹七军：一名**装备区里有牌**的其他角色
    if (intent.targetIds.length !== 1) return err('【水淹七军】需指定 1 名目标');
    const tid = intent.targetIds[0]!;
    if (tid === player.seatId) return err('不能以自己为目标');
    const t = getPlayer(state, tid);
    if (!t || !t.alive) return err('目标无效');
    if (heroBlocksBeingTarget(state, t, card, player)) return err('该角色不能成为此牌的目标');
    if (EQUIP_SLOTS.every((s) => !t.equipment[s]))
      return err('目标装备区里没有牌，不能成为【水淹七军】的目标');
  } else if (type === 'zhibi') {
    if (intent.targetIds.length !== 1) return err('【知己知彼】需指定 1 名目标');
    const tid = intent.targetIds[0]!;
    if (tid === player.seatId) return err('不能以自己为目标');
    const t = getPlayer(state, tid);
    if (!t || !t.alive) return err('目标无效');
    if (heroBlocksBeingTarget(state, t, card, player)) return err('该角色不能成为此牌的目标');
  } else if (type === 'chiling') {
    // 敕令：目标是规则算出来的（所有**没有势力**的角色），无需玩家指定
    if (intent.targetIds.length !== 0) return err('【敕令】的目标由规则决定，无需指定');
    if (chilingTargets(state).length === 0) return err('场上没有未确定势力的角色');
  } else if (type === 'lianjun') {
    // 联军盛宴：选一个**其他势力**（用 targetIds[0] 传势力的代表角色），
    // 实际目标是「你 + 该势力的所有角色」——所以至少要有一个别的势力
    if (intent.targetIds.length !== 1) return err('【联军盛宴】需指定 1 个其他势力');
    const rep = getPlayer(state, intent.targetIds[0]!);
    if (!rep || !rep.alive) return err('目标势力无效');
    if (!lianjunFactionOk(state, player, rep))
      return err('【联军盛宴】只能选择一个与你不同、且已明置武将牌的势力');
  }
  // 以逸待劳 / 五谷丰登：目标是规则定的（同势力 / 全体），无需指定

  // 出牌
  takeAndDiscard(state, player, card);
  pushLog(state, 'trick', `${player.name} 使用了【${CARD_TYPE_NAME[type]}】。`, {
    seat: player.seatId,
    action: type,
  });
  // 载荷带上目标：卞夫人·约俭要判断「本回合有没有指定过其他势力的角色」
  runHooksPausable(state, 'useCard', player, { card, targetIds: intent.targetIds }, () => {
    startTrickResolution(state, player, card, intent.targetIds, intent.targetCardId);
  });
  return { ok: true };
}

/**
 * 从「牌已经打出去了」开始走一遍即时锦囊的结算：构建上下文 → 无懈询问 → 结算。
 *
 * 抽出来是为了让**虚拟锦囊**复用（乱击的两张牌当【万箭齐发】、荀攸·奇策那类）——
 * 它们没有实体牌，但结算流程完全一样。牌的校验与「进弃牌堆」由调用方负责。
 */
function startTrickResolution(
  state: GameState,
  player: Player,
  card: Card,
  targetIds: string[],
  targetCardId: string | undefined,
): void {
  const type = card.type as TrickType;

  // 构建 TrickContext
  const ctx: TrickContext = {
    sourceId: player.seatId,
    card,
    // 本次「使用牌」的编号（许攸·成略要把它造成的伤害绑回这一次使用）
    cardUseId: ++state.cardUseSeq,
    // 结算开始时的输入槽快照（收尾想抢回出牌阶段时按它判所有权）
    pendingFence: capturePendingCheckpoint(state),
    responders: [],
    responderIndex: 0,
    targetIds: targetIds.slice(),
    targetId:
      type === 'guohe' || type === 'shunshou' || type === 'juedou' || type === 'huogong'
        ? targetIds[0]
        : undefined,
    targetCardId,
    shaTargetId: type === 'jiedao' ? targetIds[1] : undefined,
  };

  // AOE：所有其他存活玩家按座次依次响应
  if (type === 'nanman' || type === 'wanjian') {
    const sourceIdx = state.seatOrder.indexOf(player.seatId);
    ctx.responders = aliveSeatsFrom(
      state,
      state.seatOrder[nextAliveSeat(state, sourceIdx)]!,
    ).filter((s) => s !== player.seatId);
    // 锁定技（帷幕等）：不能被这张牌指定的角色直接排除在响应队列外。
    // 南蛮入侵还要再排除「对你无效」的（祝融·巨象 / 孟获·祸起）。
    ctx.responders = ctx.responders.filter((s) => {
      const t = getPlayer(state, s);
      if (!t) return false;
      if (heroBlocksBeingTarget(state, t, card, player)) return false;
      if (type === 'nanman' && activeHeroes(state, t).some((h) => h.immuneToNanman === true)) {
        const skillName = skillNameForField(activeHeroes(state, t), 'immuneToNanman');
        pushLog(state, 'resolve', `${t.name} 的【${skillName ?? '锁定技'}】令【南蛮入侵】无效。`, {
          seat: t.seatId,
          action: 'shield',
        });
        return false;
      }
      return true;
    });
    // ⚠️ 群体锦囊也要把「本次使用指定的目标」**冻结**下来（用户点名的 P0 技术债）：
    //    没有这份名单时，界钟会·权计/许攸·成略这类「按**这一次使用**的目标数判断」的技能
    //    只能保守地「不认」；而规则上「只指定了一个目标的南蛮」是满足「仅指定一个目标」的。
    //    名单就是响应队列（已被不能被指定的角色过滤掉，与「最终确定的目标」一致）。
    ctx.targetIds = ctx.responders.slice();
  }
  // 单目标响应锦囊：responders = [target]
  if (type === 'juedou' || type === 'huogong' || type === 'jiedao') {
    ctx.responders = [targetIds[0]!];
    if (type === 'juedou') ctx.duelTurn = 'target';
  }

  // 时机一之前：「一名角色成为**非装备牌的唯一目标**时」（于吉·千幻）。
  // 单人目标的锦囊要在这里派一环，让技能有机会取消它；多人目标不算「唯一目标」。
  // （锦囊牌本身不可能是装备牌，所以这里不用排装备，只排「目标数不等于 1」）
  const singleTargetId = targetIds.length === 1 ? targetIds[0]! : null;
  // 「这张锦囊的目标定下来了」——派给所有存活角色（payload 带完整目标列表）。
  // 君孙权·据江挂这里：它要「与你势力相同的角色**指定你为目标**的非伤害牌额外结算一次」，
  // 而多目标的锦囊（五谷/桃园/联军）不经过上面那条「唯一目标」的分支，得单独开一个时机。
  // 排在千幻那一步**之后**：牌被取消掉就不该再谈额外结算。
  // ⚠️ 目标列表用 `wuxieScopeCandidates`（「这张牌真正会影响谁」的既有算法）算，
  //    不能用 intent 里那串：无中生有/桃园/五谷这类目标由规则定死的锦囊，intent 常常是空的
  //    （出牌阶段 UI 也不需要玩家点目标），而据江要判的正是「有没有指定我」。
  // 刘琦·屯江：「本回合出牌阶段有没有指定过其他角色为目标」。
  // AOE 那类牌的目标由规则定死、intent 里没有目标 → 这里按「这张牌真正会影响谁」
  // （wuxieScopeCandidates，与据江同一套算法）登记；只看影响到谁，不写死牌名。
  if (
    state.seatOrder[state.turn.seatIndex] === player.seatId &&
    state.turn.phase === 'play' &&
    wuxieScopeCandidates(state, ctx).some((sid) => sid !== player.seatId)
  ) {
    player.flags.targetedOtherThisTurn = true;
  }
  // 刘琦·问计：被标记的那张实体牌不能被**其他角色**响应（无懈窗口与各类响应一起拦）
  if (wenjiMarked(player, card.id)) ctx.unrespondable = true;
  const afterTargets = (): void =>
    runAllPlayersHooks(
      state,
      'trickTargeted',
      { card, targetIds: wuxieScopeCandidates(state, ctx), trickCtx: ctx },
      () => openWuxieWindow(state, ctx, () => resolveTrick(state, ctx)),
    );
  if (singleTargetId) {
    runAllPlayersHooks(
      state,
      'othersBecomeTarget',
      // 把 trickCtx 一并给出去：技能取消这张锦囊时要用它记「抵消」（见于吉·千幻）
      { targetId: singleTargetId, card, trickCtx: ctx },
      afterTargets,
    );
    return;
  }
  afterTargets();
}

/**
 * 有人手里可能打出无懈可击吗？
 *
 * 「手里没有无懈就不去问他」是**纯 UX 优化、不改规则结果**：没有无懈的人在那个时机
 * 只能弃权。同时也不泄露信息——每个人只会在自己持有无懈时才收到询问，
 * 别人「有没有被问」他看不到；日志里也不记弃权。
 * 群体锦囊现在每个目标前都要问一次，不做这一步会变成刷屏式点击。
 */
function canUseWuxie(state: GameState, player: Player): boolean {
  return usableCardsOf(player).some(
    (c) => isWuxieLike(c) || canUseAsCard(state, player, c, 'wuxie'),
  );
}

/**
 * 开一次无懈可击的询问窗口。
 *
 * `onDone` 是这一轮问完（没人再打无懈）之后接着做的事。窗口**永远只问持有无懈的人**，
 * 一个都没有就当场 `onDone`（等于没有窗口，也不留 pending）。
 *
 * 时机顺序用「锦囊使用者的下家起、按座次」——与座次顺序一致，玩家好预期。
 * 使用者自己不在这一轮的队列里（开一轮新窗口时他不会想抵消自己的锦囊）；
 * 但打出无懈之后的**抵消轮**里会把他加回来（那时他需要能保住自己的锦囊，见 onRespondWuxie）。
 */
function openWuxieWindow(state: GameState, ctx: TrickContext, onDone: () => void): void {
  // 刘琦·问计：这张牌不能被其他角色响应 → 连无懈窗口都不开
  if (ctx.unrespondable) {
    onDone();
    return;
  }
  const source = getPlayer(state, ctx.sourceId);
  const start = source ? nextSeatAfter(state, source.seatId) : state.seatOrder[0]!;
  const queue = aliveSeatsFrom(state, start).filter(
    (sid) => sid !== ctx.sourceId && canUseWuxie(state, getPlayerOrThrow(state, sid)),
  );
  if (queue.length === 0) {
    onDone();
    return;
  }
  setPending(state, { kind: 'wuxieQueue', ctx, askQueue: queue, askIndex: 0, onDone });
}

/**
 * 抵消轮（某人刚打出无懈之后）的询问队列：从他下家起，**他自己除外**。
 * 与 `openWuxieWindow` 的区别是这里**包含锦囊使用者**——他可以用无懈保住自己的锦囊。
 */
function wuxieCounterQueue(state: GameState, responderSeatId: string): string[] {
  return aliveSeatsFrom(state, nextSeatAfter(state, responderSeatId)).filter(
    (sid) => sid !== responderSeatId && canUseWuxie(state, getPlayerOrThrow(state, sid)),
  );
}

/**
 * 被【无懈可击·国】抵消掉效果的单目标锦囊：整张牌对该目标不生效。
 *
 * 单目标的锦囊被抵消一个人的效果就等于整张牌没了效果，所以直接回到出牌阶段；
 * 多目标的（铁索连环/调虎离山）在各自己的结算里逐目标过滤。
 */
function trickFullyNegatedForSingleTarget(state: GameState, ctx: TrickContext): boolean {
  const target = ctx.targetIds?.[0] ?? ctx.targetId;
  if (!target) return false;
  if (!negatedByWuxie(ctx, target)) return false;
  pushLog(
    state,
    'trick',
    `【${CARD_TYPE_NAME[ctx.card.type as CardType]}】对 ${getPlayer(state, target)?.name ?? '?'} 的效果已被【无懈可击·国】抵消。`,
  );
  return true;
}

/**
 * 严白虎·寄篱：「此牌的使用者对你再使用一次**相同牌名的牌**」——造出那**第二张牌**。
 *
 * 口径（用户核对，见 docs/guozhan-roster.md §5.87）：
 * - 牌名/类别与第一张**相同**（普通杀→虚拟普通杀、火杀→虚拟火杀、雷杀→虚拟雷杀，
 *   属性一起带过来；【桃】【过河拆桥】等同理）；
 * - **没有对应实体牌**：`materials: []`、不继承花色与点数（`suit/rank` 只是协议层的
 *   占位写法），不给 `color` → `cardColor()` 得到 null＝**无色**。于是【仁王盾】那类
 *   看颜色看花色的效果按「无色」处理，**寄篱自己也不会被这张无色牌再触发一次**；
 * - 标 `generatedBy: 'jili'`：任何「把它当实体牌」的逻辑（进弃牌堆、被【奸雄】获得、
 *   被计成某张实体牌）都凭它认出这不是牌堆里的牌。
 *
 * 它带来的是**一次全新的使用**：重新经历 使用 → 指定目标 → 成为目标 → 响应窗口
 * （【闪】/【无懈可击】）→ 牌效果 → 伤害 → 结算结束。
 */
export function virtualSameNameCard(original: Card, seq: number): Card {
  return {
    id: `jili-${original.id}-${seq}`,
    type: original.type,
    suit: 'spade',
    rank: 0,
    ...(original.attribute ? { attribute: original.attribute } : {}),
    virtual: true,
    generatedBy: 'jili',
    materials: [],
  };
}

/**
 * 严白虎·寄篱的机制入口：让 `source` **用一张虚拟同名牌**指定 `target`（全新的一次使用）。
 *
 * ⚠️ 与 `repeatCardResolution`（据江的「此牌额外结算一次」）是**两套机制**，刻意不共用：
 *    据江 = 同一张牌、不新建使用，追加一遍结算；寄篱 = 新造一张无实体同名牌、走完整的
 *    使用流程。两者的差别（有无实体牌、有无新的响应窗口、能不能被再次指定）都由此而来。
 */
function useVirtualSameNameCard(
  state: GameState,
  source: Player,
  original: Card,
  target: Player,
  apply: (card: Card) => void,
): void {
  const card = virtualSameNameCard(original, state.jiliVirtualSeq++);
  pushLog(
    state,
    'skill',
    `【寄篱】：${source.name} 对 ${target.name} 再使用一张【${cardShortName(card)}】。`,
    { seat: target.seatId },
  );
  apply(card);
}

/** 无懈可击询问结束后的锦囊结算 */
/**
 * 单目标锦囊「结算完成」的收口（原来是直接 resumePlay）。两条「再走一遍」的路在这里分流：
 *
 * ① 君孙权·据江：`ctx.extraResolve` → **同一张牌追加一遍结算**（不新建使用，`rerunSkill`
 *    只是日志里的技能名）。防递归靠本 ctx 的 `extraResolveDone` + 按牌 id 的账本
 *    `state.extraResolvedCards`（追加的那一遍里钩子会再次看到这张牌）。
 * ② 严白虎·寄篱：`ctx.jiliUse` → **使用一张虚拟同名锦囊**（全新的一次使用，重新开无懈窗口；
 *    `targetCardId` 不沿用，因为过河拆桥/顺手牵羊第二遍时原来那张明牌已经被拿走了）。
 *    它自己不用防递归：虚拟牌是无色的，寄篱的钩子只认红色牌。
 */
function endTrickResolution(state: GameState, ctx: TrickContext): void {
  if (ctx.extraResolve && !ctx.extraResolveDone) {
    ctx.extraResolveDone = true;
    const source = getPlayer(state, ctx.sourceId);
    if (source && source.alive) {
      const targetName =
        (ctx.targetIds ?? []).map((id) => getPlayer(state, id)?.name ?? '').filter(Boolean).join('、') ||
        '目标';
      pushLog(state, 'skill', `【${ctx.rerunSkill ?? '据江'}】：此牌对 ${targetName} 再结算一次。`);
      startTrickResolution(state, source, ctx.card, ctx.targetIds ?? [], undefined);
      return;
    }
  }
  if (ctx.jiliUse) {
    ctx.jiliUse = false;
    const source = getPlayer(state, ctx.sourceId);
    const target = getPlayer(state, ctx.jiliTargetId ?? '');
    if (source && source.alive && target && target.alive) {
      useVirtualSameNameCard(state, source, ctx.card, target, (card) => {
        startTrickResolution(state, source, card, [target.seatId], undefined);
      });
      return;
    }
  }
  // 「这张牌整个结算结束」的出口（锦囊侧）。两张牌都用这个出口：
  // ①【授锋】的 cardResolved（只看账本里那张首张伤害牌）；②【调虎离山】的 afterUse。
  // ⚠️ 这里必须是 resumePlay：本函数自己就是它的替代品，调自己会无限递归
  // ⚠️ 已知缺口（两种修法都试过、都回退，见 docs §5.118）：这里会把收口里旁观技能刚发起的询问
  //    冲掉（夙智③）。① 在 resumePlay 里加 null 保护 → 冒烟大面积卡死；② 只把 guard 收在本处
  //    → 冒烟里 yuanshu/dongzhuo/dengai 等对局直接判不出胜负。说明这些收尾**确实需要**抢回
  //    pending（不是可有可无），正确修法必须能**区分**「本次收尾自己刚产生的询问」与「更早的
  //    陈旧 pending」（版本号 / 对象身份），并且**优先在发问方**（弃置收口）解决。
  const finish = (): void => {
    // 「这张牌整个结算结束」也派给**全场**（许攸·成略：旁观的同势力角色要听）；
    // 与【杀】那条一样用 cardUseEnded + 本次使用的编号
    const useId = ctx.cardUseId;
    const needed =
      !!useId &&
      state.players.some(
        (p) => p.alive && collectTimingHooks(state, p, 'cardUseEnded', false).length > 0,
      );
    if (!needed) {
      resumePlay(state, ctx.sourceId);
      return;
    }
    runAllPlayersHooks(
      state,
      'cardUseEnded',
      {
        useId,
        sourceId: ctx.sourceId,
        targetIds: ctx.targetIds ?? (ctx.targetId ? [ctx.targetId] : []),
      },
      () => resumePlay(state, ctx.sourceId),
    );
  };
  const first = state.firstDamageCard;
  if (first && !first.resolved && first.cardId === ctx.card.id) {
    // 首张伤害牌只派发一次（账本留着他那张的 id，同一回合的第二张不算首张）
    first.resolved = true;
    runAllPlayersHooks(
      state,
      'cardResolved',
      { card: ctx.card, cardIds: first.cardIds, userSeatId: ctx.sourceId },
      finish,
    );
    return;
  }
  finish();
}

function resolveTrick(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId);
  if (!source || !source.alive) {
    endTurn(state);
    return;
  }
  const type = ctx.card.type as TrickType;
  switch (type) {
    case 'wuzhong': {
      // 【无懈可击·国】抵消的是「来源」这一个目标
      if (negatedByWuxie(ctx, ctx.sourceId)) {
        pushLog(state, 'trick', `【无中生有】已被【无懈可击·国】抵消。`);
        endTrickResolution(state, ctx);
        return;
      }
      for (let i = 0; i < 2; i++) {
        const c = drawOne(state);
        if (c) source.hand.push(c);
      }
      pushLog(state, 'trick', `${source.name} 摸了 2 张牌。`);
      endTrickResolution(state, ctx);
      return;
    }
    case 'taoyuan': {
      for (const p of alivePlayers(state)) {
        if (negatedByWuxie(ctx, p.seatId)) continue;
        if (p.hp < p.maxHp) {
          const healed = healAndTrigger(state, p, 1);
          pushLog(state, 'tao', `${p.name} 回复 ${healed} 点体力。`);
        }
      }
      endTrickResolution(state, ctx);
      return;
    }
    case 'guohe':
      if (trickFullyNegatedForSingleTarget(state, ctx)) {
        endTrickResolution(state, ctx);
        return;
      }
      resolveGuohe(state, ctx);
      return;
    case 'shunshou':
      if (trickFullyNegatedForSingleTarget(state, ctx)) {
        endTrickResolution(state, ctx);
        return;
      }
      resolveShunshou(state, ctx);
      return;
    case 'juedou':
      if (trickFullyNegatedForSingleTarget(state, ctx)) {
        endTrickResolution(state, ctx);
        return;
      }
      resolveJuedou(state, ctx);
      return;
    case 'huogong':
      if (trickFullyNegatedForSingleTarget(state, ctx)) {
        endTrickResolution(state, ctx);
        return;
      }
      resolveHuogong(state, ctx);
      return;
    case 'jiedao':
      if (trickFullyNegatedForSingleTarget(state, ctx)) {
        endTrickResolution(state, ctx);
        return;
      }
      resolveJiedao(state, ctx);
      return;
    case 'tiesuo':
      resolveTiesuo(state, ctx);
      return;
    case 'yuanjiao':
      if (trickFullyNegatedForSingleTarget(state, ctx)) {
        endTrickResolution(state, ctx);
        return;
      }
      resolveYuanjiao(state, ctx);
      return;
    case 'yiyi':
      resolveYiyi(state, ctx);
      return;
    case 'wugu':
      resolveWugu(state, ctx);
      return;
    case 'zhibi':
      if (trickFullyNegatedForSingleTarget(state, ctx)) {
        endTrickResolution(state, ctx);
        return;
      }
      resolveZhibi(state, ctx);
      return;
    case 'tiaohu':
      resolveTiaoHu(state, ctx);
      return;
    case 'shuiyan':
      if (trickFullyNegatedForSingleTarget(state, ctx)) {
        endTrickResolution(state, ctx);
        return;
      }
      resolveShuiYan(state, ctx);
      return;
    case 'lutong':
      resolveLutong(state, ctx);
      return;
    case 'xietianzi':
      resolveXietianzi(state, ctx);
      return;
    case 'huoshao':
      resolveHuoShao(state, ctx);
      return;
    case 'chiling':
      resolveChiling(state, ctx);
      return;
    case 'lianjun':
      resolveLianjun(state, ctx);
      return;
    case 'nanman':
    case 'wanjian':
      // AOE：从第一个响应者开始
      if (ctx.responders.length === 0) {
        // 没有响应者（全都不受影响，例如只剩祝融且她免疫）也算「结算结束」——
        // 巨象照样要拿到这张牌
        giveResolvedNanman(state, ctx);
        endTrickResolution(state, ctx);
        return;
      }
      enterTrickResponse(state, ctx);
      return;
    default:
      endTrickResolution(state, ctx);
  }
}

/** 过河拆桥：弃目标 1 张牌 */
function resolveGuohe(state: GameState, ctx: TrickContext): void {
  const target = getPlayer(state, ctx.targetId!);
  if (!target || !target.alive) {
    endTrickResolution(state, ctx);
    return;
  }
  const got = pickTargetCard(state, ctx.sourceId, target, ctx.targetCardId);
  if (got) {
    toDiscard(state, got.card);
    pushLog(
      state,
      'trick',
      `${getPlayer(state, ctx.sourceId)!.name} 拆了 ${target.name} 的【${cardLabel(got.card)}】。`,
    );
    // 拆掉的是装备 → 目标失去装备区的一张牌（枭姬）；之后还要补上「因弃置」的收口
    // ⚠️ 以前这一支直接 endTrickResolution，装备被拆**不进**弃置收口：礼让听不到、
    //    夙智③那种「其他角色因弃置进弃牌堆」的旁观技能也听不到（测试抓到的）。
    if (got.fromEquip) {
      fireEquipLost(state, target, got.card, () =>
        fireCardDiscarded(state, target, [got.card], () => endTrickResolution(state, ctx), ctx.sourceId),
      );
      return;
    }
    // ⚠️ 「因弃置」那套要派发（孔的礼让），而且**执行弃置动作的是使用者**——
    //    两个维度分开记（见 state.turnDiscards）：牌主是 target，执行者是 ctx.sourceId。
    fireCardDiscarded(state, target, [got.card], () => endTrickResolution(state, ctx), ctx.sourceId);
    return;
  }
  pushLog(state, 'trick', `${target.name} 没有牌可拆。`);
  endTrickResolution(state, ctx);
}

/** 顺手牵羊：获得目标 1 张牌 */
function resolveShunshou(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  const target = getPlayer(state, ctx.targetId!);
  if (!target || !target.alive) {
    endTrickResolution(state, ctx);
    return;
  }
  const got = pickTargetCard(state, ctx.sourceId, target, ctx.targetCardId);
  if (got) {
    source.hand.push(got.card);
    pushLog(
      state,
      'trick',
      `${source.name} 从 ${target.name} 处获得了【${cardLabel(got.card)}】。`,
    );
    if (got.fromEquip) {
      fireEquipLost(state, target, got.card, () => endTrickResolution(state, ctx));
      return;
    }
  } else {
    pushLog(state, 'trick', `${target.name} 没有牌可偷。`);
  }
  endTrickResolution(state, ctx);
}

/** 从目标的牌中选取一张（优先指定明牌区，否则随机手牌，再否则随机装备/判定） */
function pickTargetCard(
  state: GameState,
  actorSeatId: string,
  target: Player,
  targetCardId: string | undefined,
): { card: import('@sgs/protocol').Card; fromEquip: boolean } | null {
  // 指定的明牌区牌（装备/判定）
  if (targetCardId) {
    const eq = target.equipment;
    for (const slot of EQUIP_SLOTS) {
      const c = eq[slot];
      if (c?.id === targetCardId) {
        // 吴景·风扬：异势力角色不能弃置/获得同队列吴景队友的装备牌 → 这张不能选
        if (fengyangBlocksEquip(state, actorSeatId, target, c)) return null;
        eq[slot] = null;
        return { card: c, fromEquip: true };
      }
    }
    const ji = target.judgment.findIndex((c) => c.id === targetCardId);
    if (ji >= 0) {
      const [c] = target.judgment.splice(ji, 1);
      return c ? { card: c, fromEquip: false } : null;
    }
    // 指定的是**手牌**里的一张（卞夫人·挽危让目标自己挑）→ 精确取那张
    const hi = target.hand.findIndex((c) => c.id === targetCardId);
    if (hi >= 0) {
      const [c] = target.hand.splice(hi, 1);
      return c ? { card: c, fromEquip: false } : null;
    }
  }
  // 随机手牌
  if (target.hand.length > 0) {
    const idx = Math.floor(state.rng() * target.hand.length);
    const [c] = target.hand.splice(idx, 1);
    return c ? { card: c, fromEquip: false } : null;
  }
  // 随机装备/判定（被风扬保护住的装备不进候选——连随机都不该选中它）
  const eq = target.equipment;
  const visible: import('@sgs/protocol').Card[] = [
    ...(EQUIP_SLOTS.map((s) => eq[s]).filter(
      (c): c is Card => !!c && !fengyangBlocksEquip(state, actorSeatId, target, c),
    ) as import('@sgs/protocol').Card[]),
    ...target.judgment,
  ];
  if (visible.length === 0) return null;
  const pick = visible[Math.floor(state.rng() * visible.length)]!;
  // 装备牌按**自己的 type** 找槽位（不是一串 else if——那样加槽位会静默漏掉）
  const slot = EQUIP_SLOTS.find((s) => s === pick.type);
  if (slot) {
    eq[slot] = null;
    return { card: pick, fromEquip: true };
  }
  const ji = target.judgment.findIndex((c) => c.id === pick.id);
  if (ji >= 0) target.judgment.splice(ji, 1);
  return { card: pick, fromEquip: false };
}

/** 决斗：目标先出杀，交替进行 */
function resolveJuedou(state: GameState, ctx: TrickContext): void {
  const targetId = ctx.responders[0]!;
  const target = getPlayer(state, targetId);
  if (!target || !target.alive) {
    endTrickResolution(state, ctx);
    return;
  }
  // 刘琦·问计：其他角色不能响应 → 决斗的目标打不出【杀】，直接按弃权结算。
  // （决斗轮到**使用者本人**时不受影响——他不是「其他角色」）
  if (
    (ctx.unrespondable && targetId !== ctx.sourceId) ||
    ctx.unrespondableTargets?.includes(targetId)
  ) {
    pushLog(state, 'resolve', `${target.name} 不能响应【决斗】，直接结算。`);
    passDuel(state, targetId, ctx);
    return;
  }
  const need = duelShaRequired(state, ctx, targetId);
  pushLog(
    state,
    'trick',
    need > 1
      ? `${target.name} 需打出 ${need} 张【杀】或受 1 点伤害。`
      : `${target.name} 需打出【杀】或受 1 点伤害。`,
  );
  setPending(state, {
    kind: 'respondTrick',
    responderId: targetId,
    ctx: { ...ctx, duelTurn: 'target', duelShaCount: 0 },
  });
}

/**
 * 决斗中，当前响应方**这一次**需打出几张【杀】。
 * 吕布·无双：对手每次要连出两张（官方无双的【决斗】那一半）。
 */
export function duelShaRequired(state: GameState, ctx: TrickContext, responderId: string): number {
  const otherId = responderId === ctx.sourceId ? ctx.responders[0]! : ctx.sourceId;
  const other = getPlayer(state, otherId);
  if (!other) return 1;
  const heroes = activeHeroes(state, other);
  return heroes.length ? Math.max(1, ...heroes.map(heroDuelShaRequired)) : 1;
}

/** 火攻：目标展示一张手牌 */
function resolveHuogong(state: GameState, ctx: TrickContext): void {
  const targetId = ctx.responders[0]!;
  const target = getPlayer(state, targetId);
  if (!target || !target.alive) {
    endTrickResolution(state, ctx);
    return;
  }
  if (target.hand.length === 0) {
    pushLog(state, 'trick', `${target.name} 没有手牌，【火攻】无效。`);
    endTrickResolution(state, ctx);
    return;
  }
  pushLog(state, 'trick', `${target.name} 需展示一张手牌。`);
  setPending(state, { kind: 'respondTrick', responderId: targetId, ctx });
}

/** 借刀杀人：武器持有者选择出杀或交出武器 */
function resolveJiedao(state: GameState, ctx: TrickContext): void {
  const holderId = ctx.responders[0]!;
  const holder = getPlayer(state, holderId);
  if (!holder || !holder.alive || !holder.equipment.weapon) {
    pushLog(state, 'trick', `目标无武器，【借刀杀人】无效。`);
    endTrickResolution(state, ctx);
    return;
  }
  // 刘琦·问计：其他角色不能响应 → 武器持有者打不出【杀】，直接交出武器
  if (
    (ctx.unrespondable && holderId !== ctx.sourceId) ||
    ctx.unrespondableTargets?.includes(holderId)
  ) {
    pushLog(state, 'resolve', `${holder.name} 不能响应【借刀杀人】，直接交出武器。`);
    passJiedao(state, holderId, ctx);
    return;
  }
  pushLog(state, 'trick', `${holder.name} 需打出【杀】或交出武器。`);
  setPending(state, { kind: 'respondTrick', responderId: holderId, ctx });
}

/**
 * 【铁索连环】：对一至两名角色「横置或重置」。
 *
 * 规则上每个目标可以分别选择横置还是重置；这里直接**取反**——
 * 未横置的横置、已横置的重置。取反与官方规则在所有有意义的场景下等价：
 * 对未横置的角色选「重置」、对已横置的角色选「横置」都是空操作，
 * 没有任何策略价值，所以不为此多弹一次询问。
 */
function resolveTiesuo(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  const parts: string[] = [];
  for (const sid of ctx.targetIds ?? []) {
    const t = getPlayer(state, sid);
    if (!t || !t.alive) continue;
    // 【无懈可击·国】抵消掉的角色不受影响
    if (negatedByWuxie(ctx, sid)) continue;
    // 明光铠：小势力角色不会被横置（横置那边跳过，重置照常）
    if (!t.chained && immuneToChaining(state, t)) continue;
    t.chained = !t.chained;
    parts.push(`${t.name}${t.chained ? '横置' : '重置'}`);
  }
  if (parts.length > 0) {
    pushLog(state, 'chained', `${source.name} 对 ${parts.join('、')}（【铁索连环】）。`, {
      seat: source.seatId,
      action: 'tiesuo',
    });
  }
  endTrickResolution(state, ctx);
}

/** 【远交近攻】：目标摸一张，然后你摸三张 */
function resolveYuanjiao(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  const target = getPlayer(state, ctx.targetIds?.[0] ?? '');
  if (!target || !target.alive) {
    pushLog(state, 'trick', `【远交近攻】的目标已不在场。`);
    endTrickResolution(state, ctx);
    return;
  }
  const first = drawOne(state);
  if (first) target.hand.push(first);
  let mine = 0;
  for (let i = 0; i < 3; i++) {
    const c = drawOne(state);
    if (!c) break;
    source.hand.push(c);
    mine++;
  }
  pushLog(
    state,
    'trick',
    `${source.name} 使用了【远交近攻】：${target.name} 摸 1 张牌，${source.name} 摸 ${mine} 张牌。`,
    { seat: source.seatId, action: 'yuanjiao' },
  );
  endTrickResolution(state, ctx);
}

/**
 * 【以逸待劳】：你与同势力角色**依次**各摸两张牌，然后弃置两张牌。
 * 逐人处理——每个人摸完就立刻弃，不然「先摸后弃」的调整空间就没了。
 */
function resolveYiyi(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  // 暗置角色没有势力（暗将之间互视为不同势力），所以只有明置的同势力才算得上
  const sourceFaction = effectiveFaction(state, source);
  const queue = (
    sourceFaction
      ? aliveSeatsFrom(state, source.seatId).filter((sid) => {
          const p = getPlayer(state, sid);
          return p ? effectiveFaction(state, p) === sourceFaction : false;
        })
      : [source.seatId]
  ).filter((sid) => !negatedByWuxie(ctx, sid));
  // 队列放进 ctx：无懈的候选要能算出「还没结算的人」（wuxieScopeCandidates 读 responders）
  ctx.responders = queue;
  ctx.responderIndex = 0;
  pushLog(
    state,
    'trick',
    `${source.name} 使用了【以逸待劳】，${queue.length} 名同势力角色依次摸两张牌后弃两张牌。`,
    { seat: source.seatId, action: 'yiyi' },
  );
  yiyiStep(state, ctx);
}

/**
 * 推进到队列里的下一个人；**每人摸牌之前**先给他开一次无懈窗口
 * （官方时机是「目标锦囊牌生效前」，群体锦囊是逐个角色各一次）。
 */
function yiyiStep(state: GameState, ctx: TrickContext): void {
  if (ctx.responderIndex >= ctx.responders.length) {
    endTrickResolution(state, ctx);
    return;
  }
  const t = getPlayer(state, ctx.responders[ctx.responderIndex]!);
  if (!t || !t.alive) {
    ctx.responderIndex++;
    yiyiStep(state, ctx);
    return;
  }
  openWuxieWindow(state, ctx, () => yiyiResolveCurrent(state, ctx));
}

/** 窗口关掉之后真正结算这一个角色（可能刚被抵消，那就跳过） */
function yiyiResolveCurrent(state: GameState, ctx: TrickContext): void {
  const t = getPlayer(state, ctx.responders[ctx.responderIndex]!);
  if (!t || !t.alive || negatedByWuxie(ctx, t.seatId)) {
    ctx.responderIndex++;
    yiyiStep(state, ctx);
    return;
  }
  let drew = 0;
  for (let i = 0; i < 2; i++) {
    const c = drawOne(state);
    if (!c) break;
    t.hand.push(c);
    drew++;
  }
  const count = Math.min(2, t.hand.length);
  if (count === 0) {
    pushLog(state, 'trick', `${t.name} 因【以逸待劳】摸了 ${drew} 张牌，无牌可弃。`);
    ctx.responderIndex++;
    yiyiStep(state, ctx);
    return;
  }
  setPending(state, {
    kind: 'pickCards',
    seatId: t.seatId,
    title: `【以逸待劳】：摸 ${drew} 张牌后需弃置 ${count} 张`,
    cards: t.hand.slice(),
    min: count,
    max: count,
    resolve: (st, player, picked) => {
      for (const c of picked) {
        // ⚠️ 池子是**当时手牌的快照**：等这张牌被选出来，它可能已经不在手里了——
        //    问话挂起期间别的流程把它拿走过（实测：别人【屯田】判定时这张牌被【鬼才】
        //    打出去替判、进了弃牌堆）。以前 `removeCard` 不看返回值、`toDiscard` 无条件推，
        //    同一张牌于是在弃牌堆里出现两份（模糊测试的重复牌检查在 1500 局里报出来的）。
        const taken = removeCard(player.hand, c.id);
        if (taken) toDiscard(st, taken);
      }
      pushLog(st, 'trick', `${player.name} 因【以逸待劳】弃置了 ${picked.length} 张牌。`);
      ctx.responderIndex++;
      yiyiStep(st, ctx);
    },
  });
}

/**
 * 【五谷丰登】：亮出牌堆顶「存活角色数」张牌，然后所有角色按座次依次各拿一张，
 * 没人要的进弃牌堆。亮出来的牌在结算期间**不属于任何人**，所以池子由本函数
 * 自己持有，选中的牌要手动塞进手牌。
 */
function resolveWugu(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  const pickers = aliveSeatsFrom(state, source.seatId).filter((sid) => !negatedByWuxie(ctx, sid));
  // 队列放进 ctx：无懈的候选要能算出「还没拿牌的人」
  ctx.responders = pickers;
  ctx.responderIndex = 0;
  const pool: import('@sgs/protocol').Card[] = [];
  for (let i = 0; i < pickers.length; i++) {
    const c = drawOne(state);
    if (c) pool.push(c);
  }
  pushLog(
    state,
    'trick',
    `${source.name} 使用了【五谷丰登】，亮出 ${pool.length} 张牌，由 ${source.name} 起依次选取。`,
    { seat: source.seatId, action: 'wugu' },
  );
  wuguStep(state, ctx, pool);
}

function wuguStep(
  state: GameState,
  ctx: TrickContext,
  remaining: import('@sgs/protocol').Card[],
): void {
  if (ctx.responderIndex >= ctx.responders.length || remaining.length === 0) {
    if (remaining.length > 0) {
      pushLog(state, 'trick', `【五谷丰登】余下的 ${remaining.length} 张牌进了弃牌堆。`);
      toDiscard(state, ...remaining.slice());
      remaining.length = 0;
    }
    endTrickResolution(state, ctx);
    return;
  }
  const p = getPlayer(state, ctx.responders[ctx.responderIndex]!);
  if (!p || !p.alive) {
    ctx.responderIndex++;
    wuguStep(state, ctx, remaining);
    return;
  }
  // 每人拿牌之前先给他开一次无懈窗口（后面的选牌能看到前面拿了什么，
  // 所以这个时机是真的有意义——「等看清池子里还剩什么再决定无懈谁」）
  openWuxieWindow(state, ctx, () => wuguResolveCurrent(state, ctx, remaining));
}

/** 窗口关掉之后真正让这一个角色拿牌（可能刚被抵消，那就跳过） */
function wuguResolveCurrent(
  state: GameState,
  ctx: TrickContext,
  remaining: import('@sgs/protocol').Card[],
): void {
  const p = getPlayer(state, ctx.responders[ctx.responderIndex]!);
  if (!p || !p.alive || negatedByWuxie(ctx, p.seatId)) {
    ctx.responderIndex++;
    wuguStep(state, ctx, remaining);
    return;
  }
  setPending(state, {
    kind: 'pickCards',
    seatId: p.seatId,
    title: '【五谷丰登】：从亮出的牌里获得一张',
    cards: remaining.slice(),
    min: 1,
    max: 1,
    resolve: (st, player, picked) => {
      const card = picked[0]!;
      const at = remaining.indexOf(card);
      if (at >= 0) remaining.splice(at, 1);
      player.hand.push(card);
      pushLog(st, 'trick', `${player.name} 因【五谷丰登】获得了【${cardLabel(card)}】。`, {
        seat: player.seatId,
      });
      ctx.responderIndex++;
      wuguStep(st, ctx, remaining);
    },
  });
}

/**
 * 【知己知彼】：观看目标的手牌，或观看其一张暗置的武将牌。
 * 内容只下发给发起者（`viewCards` 提示按座位构建），日志里不出现牌名/武将名。
 */
/** 同一队列（火烧连营）：从 fromSeatId 起、**连续的相同势力**角色（不含 from 自己）
 *
 * 「连续」看的是座次环上相邻的存活角色；暗置（未确定势力）的人**不是任何势力**，
 * 所以队列在他那里断开——这与「暗将之间互视为不同势力」是同一条规则。
 */
function sameQueue(state: GameState, sourceSeatId: string): string[] {
  const order = aliveSeatsFrom(state, sourceSeatId);
  const startIdx = order.indexOf(sourceSeatId);
  if (startIdx < 0) return [];
  const rest = order.slice(startIdx + 1); // 从「下家」开始，不含自己
  const first = getPlayer(state, rest[0] ?? '');
  if (!first) return [];
  const faction = effectiveFaction(state, first);
  const out: string[] = [first.seatId];
  if (!faction) return out; // 下家暗置 → 队列只有他一个
  for (const sid of rest.slice(1)) {
    const p = getPlayer(state, sid);
    if (!p || effectiveFaction(state, p) !== faction) break;
    out.push(sid);
  }
  return out;
}

/**
 * 【火烧连营】：对**下家和与其处于同一队列**的所有角色各造成 1 点火焰伤害。
 *
 * 多人依次受伤，每个人都会触发护心镜与铁索蔓延、也可能进濒死——所以复用了 AOE 那套
 * `ongoingTrick`：被打进濒死就把剩下的队列留在 ctx 里，等濒死结算完由 resumePlay
 * 接着打（用 `ctx.skillId = 'huoshao'` 与响应队列区分开）。
 */
function resolveHuoShao(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  // 明光铠：火焰类锦囊对它无效（取消目标）
  const queue = sameQueue(state, source.seatId).filter((sid) => {
    const t = getPlayer(state, sid);
    if (!t || negatedByWuxie(ctx, sid)) return false; // 已被【无懈可击·国】抵消
    return !armorCancelsFireTrick(state, t, ctx.card);
  });
  pushLog(
    state,
    'trick',
    `【火烧连营】烧向${queue.length > 0 ? queue.map((s) => getPlayer(state, s)!.name).join('、') : '（无人）'}。`,
    { seat: source.seatId, action: 'huoshao' },
  );
  ctx.skillId = 'huoshao'; // 标记：这条链是伤害链，不是响应队列
  ctx.responders = queue;
  ctx.responderIndex = 0;
  huoShaoStep(state, ctx);
}

function huoShaoStep(state: GameState, ctx: TrickContext): void {
  const idx = ctx.responderIndex;
  if (idx >= ctx.responders.length) {
    endTrickResolution(state, ctx);
    return;
  }
  const target = getPlayer(state, ctx.responders[idx]!);
  if (!target || !target.alive) {
    ctx.responderIndex++;
    huoShaoStep(state, ctx);
    return;
  }
  // 每人挨烧之前先给他开一次无懈窗口；被打进濒死时剩下的队列留在 ctx 里，
  // 濒死结算完由 resumePlay 回到这里，会再开一次窗口（对还没结算的人是对的）
  openWuxieWindow(state, ctx, () => huoShaoResolveCurrent(state, ctx));
}

/** 窗口关掉之后真正结算这一个目标（可能刚被抵消，那就跳过） */
function huoShaoResolveCurrent(state: GameState, ctx: TrickContext): void {
  const target = getPlayer(state, ctx.responders[ctx.responderIndex]!);
  if (!target || !target.alive || negatedByWuxie(ctx, target.seatId)) {
    ctx.responderIndex++;
    huoShaoStep(state, ctx);
    return;
  }
  const attack: AttackContext = {
    sourceId: ctx.sourceId,
    cardId: ctx.card.id,
    asType: 'huoshao',
    targetId: target.seatId,
    cardUseId: ctx.cardUseId,
    declaredTargets: declaredTargetsOf(ctx),
    damage: 1,
    dodged: false,
    attribute: 'fire',
  };
  damageStep(state, target, attack, 1, (dmg, prevented) => {
    if (!prevented) {
      pushLog(
        state,
        'damage',
        `${target.name} 因【火烧连营】受到 ${dmg} 点火焰伤害，剩余 ${Math.max(0, target.hp)} 体力。`,
      );
    }
    if (prevented) {
      ctx.responderIndex++;
      huoShaoStep(state, ctx);
      return;
    }
    // 受伤后钩子（反馈/刚烈/悲歌…）在铁索蔓延之前跑
    runDamagedHooks(state, target, attack, dmg, () => {
      queueChainSpread(state, attack, dmg);
      const next = (): void => {
        ctx.responderIndex++;
        huoShaoStep(state, ctx);
      };
      if (target.hp <= 0) {
        // 濒死打断：把剩下的队列留在 ctx 里，濒死结算完由 resumePlay 接着打
        state.ongoingTrick = ctx;
        enterNearDeath(state, attack);
        return;
      }
      runChainSpread(state, next);
    });
  });
}

/**
 * 【敕令】的目标：所有**没有势力**的存活角色。
 *
 * 「没有势力」= 一张武将牌都没明置（未确定势力）。所以**使用者自己也可能在里面**
 * ——只要他自己也没亮将。这与「暗将之间互视为不同势力」是同一条暗置语义。
 */
export function chilingTargets(state: GameState): Player[] {
  return state.players.filter((p) => p.alive && effectiveFaction(state, p) === null);
}

/**
 * 【敕令】：对所有没有势力的角色使用。每名目标三选一——
 * 1. 明置一张武将牌，摸一张牌；2. 弃置一张装备牌；3. 失去 1 点体力。
 *
 * 多人依次做选择，所以复用 AOE 那套 `ongoingTrick`：谁被打进濒死就把剩下的队列
 * 留在 ctx 里，等濒死结算完由 resumePlay 接着问（用 `ctx.skillId = 'chiling'` 区分）。
 * 「弃置装备牌」这一项只在该目标装备区里有牌时才给。
 */
function resolveChiling(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  const queue = chilingTargets(state)
    .filter((p) => !heroBlocksBeingTarget(state, p, ctx.card, source))
    .filter((p) => !negatedByWuxie(ctx, p.seatId))
    .map((p) => p.seatId);
  pushLog(
    state,
    'trick',
    `【敕令】对${queue.length > 0 ? queue.map((s) => getPlayer(state, s)!.name).join('、') : '（无人）'}生效。`,
    { seat: source.seatId, action: 'chiling' },
  );
  ctx.skillId = 'chiling'; // 标记：这条链是「依次做选择」，不是响应队列
  ctx.responders = queue;
  ctx.responderIndex = 0;
  chilingStep(state, ctx);
}

/** 推进到下一个做选择的目标 */
function chilingNext(state: GameState, ctx: TrickContext): void {
  ctx.responderIndex++;
  chilingStep(state, ctx);
}

function chilingStep(state: GameState, ctx: TrickContext): void {
  const idx = ctx.responderIndex;
  if (idx >= ctx.responders.length) {
    endTrickResolution(state, ctx);
    return;
  }
  const target = getPlayer(state, ctx.responders[idx]!);
  if (!target || !target.alive) {
    chilingNext(state, ctx);
    return;
  }
  // 每个人做选择之前先给他开一次无懈窗口（先做选择的人会明置武将牌等，
  // 后面的人看在眼里，所以这个时机有意义）
  openWuxieWindow(state, ctx, () => chilingAskCurrent(state, ctx));
}

/** 窗口关掉之后真正让这一个角色做三选一（可能刚被抵消，那就跳过） */
function chilingAskCurrent(state: GameState, ctx: TrickContext): void {
  const target = getPlayer(state, ctx.responders[ctx.responderIndex]!);
  if (!target || !target.alive || negatedByWuxie(ctx, target.seatId)) {
    chilingNext(state, ctx);
    return;
  }
  const source = getPlayer(state, ctx.sourceId);
  const hidden = unrevealedHeroes(state.mode, target);
  const equip = EQUIP_SLOTS.map((s) => target.equipment[s]).filter(Boolean) as Card[];
  const options: { id: string; label: string }[] = [];
  if (hidden.length > 0) options.push({ id: 'reveal', label: '明置一张武将牌，摸一张牌' });
  if (equip.length > 0) options.push({ id: 'discard', label: '弃置一张装备牌' });
  options.push({ id: 'hp', label: '失去 1 点体力' }); // 这一项永远有
  askChoice(
    state,
    target.seatId,
    `【敕令】：${source?.name ?? '?'} 对你使用——选择一项`,
    options,
    (st, p, picked) => {
      if (picked === 'reveal') {
        const heroes = unrevealedHeroes(st.mode, p);
        if (heroes.length === 0) {
          chilingNext(st, ctx); // 前面结算动过武将牌 → 这一项已经做不了了
          return;
        }
        askChoice(
          st,
          p.seatId,
          '【敕令】：明置哪一张武将牌？',
          heroes.map((h) => ({ id: h.id, label: h.name })),
          (st2, p2, heroId) => {
            const hero = unrevealedHeroes(st2.mode, p2).find((h) => h.id === heroId);
            if (hero) {
              revealHeroCard(st2, p2, hero);
              const drawn = drawOne(st2);
              if (drawn) p2.hand.push(drawn);
              pushLog(st2, 'trick', `${p2.name} 因【敕令】明置了【${hero.name}】并摸了一张牌。`, {
                seat: p2.seatId,
              });
            }
            chilingNext(st2, ctx);
          },
        );
        return;
      }
      if (picked === 'discard') {
        const eq = EQUIP_SLOTS.map((s) => p.equipment[s]).filter(Boolean) as Card[];
        if (eq.length === 0) {
          chilingNext(st, ctx);
          return;
        }
        askPickCards(st, p.seatId, '【敕令】：弃置一张装备牌', eq, 1, 1, (st2, p2, chosen) => {
          const card = chosen[0];
          if (card) {
            const slot = EQUIP_SLOTS.find((s) => p2.equipment[s]?.id === card.id);
            if (slot) {
              // 弃的是**装备区**里的牌 → 走「失去装备」通道（枭姬/旋略/白银狮子/兴棹都要响）
              p2.equipment[slot] = null;
              fireEquipLost(st2, p2, card, () => {});
            }
            toDiscard(st2, card);
            pushLog(st2, 'discard', `${p2.name} 因【敕令】弃置【${cardLabel(card)}】。`);
            fireCardDiscarded(st2, p2, [card], () => chilingNext(st2, ctx));
            return;
          }
          chilingNext(st2, ctx);
        });
        return;
      }
      // 失去 1 点体力：**不是伤害**——不触发伤害钩子、不走铁索、也不触发护心镜
      p.hp -= 1;
      pushLog(st, 'damage', `${p.name} 因【敕令】失去 1 点体力，剩余 ${Math.max(0, p.hp)} 体力。`, {
        seat: p.seatId,
      });
      if (p.hp <= 0) {
        st.ongoingTrick = ctx; // 剩下的目标留在 ctx 里，濒死结算完接着问
        enterNearDeath(st, {
          sourceId: p.seatId, // 失去体力没有来源（与军令的「失去 1 点体力」一致）
          cardId: ctx.card.id,
          asType: 'chiling',
          targetId: p.seatId,
          cardUseId: ctx.cardUseId,
          damage: 1,
          dodged: false,
        });
        return;
      }
      chilingNext(st, ctx);
    },
  );
}

/**
 * 【联军盛宴】里「该势力的其他目标角色各摸一张牌且重置其武将牌」那一段。
 * 使用者自己（`sourceSeatId`）走的是上面那条收益，这里跳过。
 */
function lianjunMemberPart(
  state: GameState,
  ctx: TrickContext,
  members: Player[],
  sourceSeatId: string,
): void {
  const names: string[] = [];
  for (const m of members) {
    if (m.seatId === sourceSeatId) continue;
    if (!m.alive) continue;
    const c = drawOne(state);
    if (c) m.hand.push(c);
    m.chained = false; // 「重置武将牌」= 解除横置（本引擎没有翻面）
    names.push(m.name);
  }
  if (names.length > 0) {
    pushLog(state, 'trick', `${names.join('、')} 因【联军盛宴】各摸一张牌并重置武将牌。`);
  }
  endTrickResolution(state, ctx);
}

/**
 * 【联军盛宴】指定的「其他势力」是否合法：该角色**已明置**、且势力与使用者不同。
 * 使用者自己暗置（未确定势力）时，任何已确定的势力都算「其他势力」。
 */
export function lianjunFactionOk(state: GameState, player: Player, rep: Player): boolean {
  const f = effectiveFaction(state, rep);
  if (f === null) return false;
  const mine = effectiveFaction(state, player);
  return mine === null || mine !== f;
}

/**
 * 【联军盛宴】：你选择一个**其他势力**，对你和该势力的所有角色使用。
 * 你选择一项：1. 回复 X 点体力；2. 摸 X 张牌（X 为该势力的存活角色数）。
 * 然后该势力的**其他**目标角色各摸一张牌且重置其武将牌。
 *
 * ⚠️ 这张牌有三套流传的文本（2014 旧版 / 2019 移动版 / 2022 版），差别很大。
 * 本版本按**最新的 2022 版**实现（见 docs/guozhan-roster.md §5.19），
 * 另两版的口径也记在那里，改回去只需改这一处。
 */
function resolveLianjun(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  // 目标势力：调用方传进来的是「该势力的一个代表角色」
  const rep = getPlayer(state, ctx.targetIds?.[0] ?? '');
  const faction = rep ? effectiveFaction(state, rep) : null;
  if (!rep || !rep.alive || !faction) {
    pushLog(state, 'trick', `【联军盛宴】的目标势力已不存在，此牌无效。`);
    endTrickResolution(state, ctx);
    return;
  }
  const members = state.players.filter(
    (p) => p.alive && effectiveFaction(state, p) === faction && !negatedByWuxie(ctx, p.seatId),
  );
  const x = members.length;
  pushLog(
    state,
    'trick',
    `${source.name} 对【${FACTION_NAME[faction] ?? faction}】势力使用【联军盛宴】（该势力存活 ${x} 名）。`,
    { seat: source.seatId, action: 'lianjun' },
  );
  // 无懈·国 直接抵消了使用者自己那一份 → 他不拿收益，该势力照样摸牌+重置
  if (negatedByWuxie(ctx, source.seatId)) {
    pushLog(state, 'trick', `【联军盛宴】对 ${source.name} 的效果已被【无懈可击·国】抵消。`);
    lianjunMemberPart(state, ctx, members, source.seatId);
    return;
  }
  askChoice(
    state,
    source.seatId,
    `【联军盛宴】：${FACTION_NAME[faction] ?? faction}势力存活 ${x} 名——你选择一项`,
    [
      { id: 'heal', label: `回复 ${x} 点体力` },
      { id: 'draw', label: `摸 ${x} 张牌` },
    ],
    (st, p, picked) => {
      if (picked === 'heal') {
        const healed = healAndTrigger(st, p, x);
        pushLog(st, 'trick', `${p.name} 因【联军盛宴】回复了 ${healed} 点体力。`, {
          seat: p.seatId,
        });
      } else {
        for (let i = 0; i < x; i++) {
          const c = drawOne(st);
          if (c) p.hand.push(c);
        }
        pushLog(st, 'trick', `${p.name} 因【联军盛宴】摸了 ${x} 张牌。`, { seat: p.seatId });
      }
      lianjunMemberPart(st, ctx, members, p.seatId);
    },
  );
}

/**
 * 【挟天子以令诸侯】：大势力角色对自己使用——**结束出牌阶段**，
 * 然后若他在弃牌阶段真弃了一张牌，本回合结束后追加一个额外回合。
 *
 * 额外回合用现成的 extraTurns；两个标记（待办 + 弃牌阶段弃过牌）都在 PlayerFlags 上，
 * 由 afterTurnEnd 读——注意读的时机必须在「回合玩家的 flags 被清」之前（emptyFlags 在 startTurn）。
 */
function resolveXietianzi(state: GameState, ctx: TrickContext): void {
  const player = getPlayer(state, ctx.sourceId)!;
  // 被无懈可击抵消：他这一个回合什么也没发生（牌已经用掉了）
  if (negatedByWuxie(ctx, player.seatId)) {
    pushLog(state, 'trick', `【挟天子以令诸侯】对 ${player.name} 的效果已被【无懈可击】抵消。`);
    endTrickResolution(state, ctx);
    return;
  }
  player.flags.xietianziPending = true;
  pushLog(
    state,
    'trick',
    `${player.name} 使用【挟天子以令诸侯】，结束出牌阶段；若弃牌阶段弃了牌，将追加一个回合。`,
    { seat: player.seatId, action: 'xietianzi' },
  );
  goToDiscardPhase(state, player);
}

/**
 * 【勠力同心】：对所有**大势力**角色或所有**小势力**角色使用——
 * 没横置的横置，已横置的摸一张牌。
 *
 * 用之前先问一次「大势力还是小势力」（这是使用这张牌时就要定的目标范围）；
 * 没有任何符合的角色时这张牌不该能打出来（legal 那边也判了）。
 * 明光铠的小势力角色不会被横置，也就不满足「横置」那一支，什么也不发生。
 */
function resolveLutong(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  const bigs = bigFactions(state);
  const options: { id: string; label: string }[] = [];
  if (bigs.length > 0) options.push({ id: 'big', label: '所有大势力角色' });
  if (bigs.length > 0) options.push({ id: 'small', label: '所有小势力角色' });
  if (options.length === 0) {
    // 谁都没到 2 人 → 既没有大势力也没有小势力，这张牌无从结算
    pushLog(state, 'trick', `场上没有大势力，【勠力同心】无效。`);
    endTrickResolution(state, ctx);
    return;
  }
  askChoice(state, source.seatId, '【勠力同心】：对哪一类角色使用？', options, (st, _p, picked) => {
    const wantBig = picked === 'big';
    const targets = st.players.filter((p) => {
      if (!p.alive) return false;
      if (negatedByWuxie(ctx, p.seatId)) return false; // 已被【无懈可击·国】抵消
      const f = effectiveFaction(st, p);
      // 大势力：只有已确定势力者才可能是大势力角色；
      // 小势力：「除大势力角色外的**所有**角色」——**未确定势力（暗置）的也算**（用户口径）
      return wantBig ? f !== null && isBigFaction(st, f) : isSmallFactionCharacter(st, p);
    });
    const chainedNames: string[] = [];
    const drawnNames: string[] = [];
    for (const t of targets) {
      if (!t.chained) {
        // 明光铠：小势力角色不会被横置 → 这一支对他无效
        if (immuneToChaining(st, t)) continue;
        t.chained = true;
        chainedNames.push(t.name);
      } else {
        const drawn = drawOne(st);
        if (drawn) t.hand.push(drawn);
        drawnNames.push(t.name);
      }
    }
    const parts: string[] = [];
    if (chainedNames.length > 0) parts.push(`${chainedNames.join('、')} 被横置`);
    if (drawnNames.length > 0) parts.push(`${drawnNames.join('、')} 各摸一张牌`);
    pushLog(
      st,
      'chained',
      `【勠力同心】对${wantBig ? '大' : '小'}势力：${parts.join('，') || '没有角色受影响'}。`,
      { seat: source.seatId, action: 'lutong' },
    );
    endTrickResolution(st, ctx);
  });
}

/**
 * 【调虎离山】：一至两名角色「移出」——本回合不计入距离与座次、不能使用牌、不能成为目标。
 *
 * 三个标记由 afterTurnEnd 统一清（「直到回合结束」），**注意标记挂在别人身上**：
 * 它就是 afterTurnEnd 里那份「清理要遍历全体玩家」的设计的最好例子。
 * 使用后自己摸一张牌。
 */
function resolveTiaoHu(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  const names: string[] = [];
  for (const sid of ctx.targetIds ?? []) {
    const t = getPlayer(state, sid);
    if (!t || !t.alive) continue;
    if (negatedByWuxie(ctx, sid)) continue; // 已被【无懈可击·国】抵消
    t.flags.removedFromSeating = true;
    t.flags.cannotPlayCardsThisTurn = true;
    t.flags.cannotBeTargetThisTurn = true;
    names.push(t.name);
  }
  if (names.length > 0) {
    pushLog(
      state,
      'trick',
      `${names.join('、')} 被【调虎离山】移出：本回合不计入距离与座次、不能使用牌、也不能成为目标。`,
      { seat: source.seatId, action: 'tiaohu' },
    );
  }
  // 你使用此牌后摸一张牌
  const drawn = drawOne(state);
  if (drawn) source.hand.push(drawn);
  pushLog(state, 'trick', `${source.name} 因【调虎离山】摸了一张牌。`, {
    seat: source.seatId,
    action: 'draw',
  });
  // 「这张牌结算完成」的时机（吴景·调归要在这时看「我的势力是否**因此**形成队列」）。
  // ⚠️ 目前只在【调虎离山】这条路上派发——它是 afterUse 唯一的用户，所以先只开这一处；
  //    将来若有别的技能需要「牌结算完之后」，再把它推广到 resolveTrick 的所有出口
  //    （那里有 49 处 resumePlay，一次性改动静太大）。
  runHooksPausable(state, 'afterUse', source, { card: ctx.card, trickCtx: ctx }, () =>
    endTrickResolution(state, ctx),
  );
}

/**
 * 【水淹七军】：目标二选一——弃置装备区所有牌，或受到使用者造成的 1 点雷电伤害。
 * 雷电是**属性伤害**，所以走铁索蔓延；伤害也过护心镜那道防止层。
 */
function resolveShuiYan(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  const target = getPlayer(state, ctx.targetIds?.[0] ?? '');
  if (!target || !target.alive) {
    endTrickResolution(state, ctx);
    return;
  }
  const eqCards = EQUIP_SLOTS.map((s) => target.equipment[s]).filter(Boolean) as Card[];
  if (eqCards.length === 0) {
    pushLog(state, 'trick', `${target.name} 的装备区已经没有牌了。`);
    endTrickResolution(state, ctx);
    return;
  }
  askChoice(
    state,
    target.seatId,
    `【水淹七军】：${source.name} 对你使用——弃置装备区的 ${eqCards.length} 张牌，还是受到 1 点雷电伤害？`,
    [
      { id: 'discard', label: `弃置装备区里的 ${eqCards.length} 张牌` },
      { id: 'damage', label: '受到 1 点雷电伤害' },
    ],
    (st, p, picked) => {
      if (picked === 'discard') {
        // 「弃置装备区里的所有牌」是**一个动作**：逐张派发但共用同一个 eventId
        // （枭姬那种每张都算，旋略那种只算一次）
        const eventId = ++st.equipLossSeq;
        let i = 0;
        const step = (): void => {
          if (i >= eqCards.length) {
            endTrickResolution(st, ctx);
            return;
          }
          const card = eqCards[i++]!;
          const slot = EQUIP_SLOTS.find((s) => p.equipment[s]?.id === card.id);
          if (!slot) {
            step(); // 这张已经不在了（被前面的触发结算动过）
            return;
          }
          p.equipment[slot] = null;
          toDiscard(st, card);
          pushLog(st, 'discard', `${p.name} 因【水淹七军】弃置【${cardLabel(card)}】。`);
          fireEquipLost(st, p, card, step, { id: eventId, cards: eqCards });
        };
        step();
        return;
      }
      // 受到使用者造成的 1 点雷电伤害
      const attack: AttackContext = {
        sourceId: source.seatId,
        cardId: ctx.card.id,
        asType: 'shuiyan',
        targetId: p.seatId,
        cardUseId: ctx.cardUseId,
        declaredTargets: declaredTargetsOf(ctx),
        damage: 1,
        dodged: false,
        attribute: 'thunder',
      };
      pushLog(st, 'damage', `${p.name} 选择受到 1 点雷电伤害。`);
      damageStep(st, p, attack, 1, (dmg, prevented) => {
        if (!prevented) {
          pushLog(
            st,
            'damage',
            `${p.name} 受到 ${dmg} 点雷电伤害，剩余 ${Math.max(0, p.hp)} 体力。`,
          );
        }
        if (prevented) {
          endTrickResolution(st, ctx);
          return;
        }
        runDamagedHooks(st, p, attack, dmg, () => {
          queueChainSpread(st, attack, dmg);
          if (p.hp <= 0) {
            enterNearDeath(st, attack);
            return;
          }
          runChainSpread(st, () => endTrickResolution(st, ctx));
        });
      });
    },
  );
}

/**
 * 玉玺（锁定技）：出牌阶段开始时，若你有**明置**的武将牌，视为使用一张【知己知彼】。
 *
 * 「视为使用」= 走完整的锦囊流程（可被【无懈可击】抵消），只是没有实体牌。
 * 目标仍要自己选（一至多名目标时问一次）；没有合法目标就跳过。
 */
function askYuxiZhibi(state: GameState, player: Player, after: () => void): void {
  if (state.mode !== 'guozhan') {
    after();
    return;
  }
  // 「装备着玉玺」也包含袁术·庸肆给的虚拟玉玺（判定收在 heroes.hasYuxi 里）
  if (!hasYuxi(state, player)) {
    after();
    return;
  }
  // 官方条件：有处于明置状态的武将牌
  if (!player.heroRevealed && !player.deputyRevealed) {
    after();
    return;
  }
  // 没有实体牌：id 用日志序号保证唯一（与 castVirtualTrick 同一套做法）
  const virtualCard: Card = {
    id: `virtual-${state.logSeq}-zhibi`,
    type: 'zhibi',
    suit: 'spade',
    rank: 5,
  };
  const targets = state.players.filter(
    (p) =>
      p.alive &&
      p.seatId !== player.seatId &&
      !heroBlocksBeingTarget(state, p, virtualCard, player),
  );
  if (targets.length === 0) {
    after();
    return;
  }
  const begin = (targetSeatId: string): void => {
    pushLog(state, 'trick', `${player.name} 的【玉玺】视为使用了【知己知彼】。`, {
      seat: player.seatId,
      action: 'zhibi',
    });
    startTrickResolution(state, player, virtualCard, [targetSeatId], undefined);
  };
  if (targets.length === 1) {
    begin(targets[0]!.seatId);
    return;
  }
  askChoice(
    state,
    player.seatId,
    '【玉玺】：视为使用【知己知彼】，选择观看谁',
    targets.map((t) => ({ id: t.seatId, label: t.name })),
    (_st, _p, seatId) => begin(seatId),
    // 结算完要回到出牌阶段（由 resolveZhibi 的 resumePlay 负责），这里不用 returnTo
  );
}

function resolveZhibi(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  const target = getPlayer(state, ctx.targetIds?.[0] ?? '');
  if (!target || !target.alive) {
    pushLog(state, 'trick', `【知己知彼】的目标已不在场。`);
    endTrickResolution(state, ctx);
    return;
  }
  const hidden: { id: string; name: string }[] = [];
  if (state.mode === 'guozhan') {
    const main = getHeroForMode(target.heroId, state.mode);
    if (main && !target.heroRevealed) hidden.push({ id: target.heroId!, name: main.name });
    const deputy = getHeroForMode(target.deputyHeroId, state.mode);
    if (deputy && !target.deputyRevealed)
      hidden.push({ id: target.deputyHeroId!, name: deputy.name });
  }
  const options = [{ id: 'hand', label: `观看 ${target.name} 的手牌（${target.hand.length} 张）` }];
  for (const h of hidden) options.push({ id: `hero:${h.id}`, label: `观看武将牌「${h.name}」` });
  const finish = (): void => {
    if (state.pending === null) endTrickResolution(state, ctx);
  };
  askChoice(
    state,
    source.seatId,
    `【知己知彼】：观看 ${target.name} 的什么？`,
    options,
    (st, player, optionId) => {
      const t = getPlayer(st, target.seatId);
      if (!t) {
        finish();
        return;
      }
      if (optionId === 'hand') {
        pushLog(st, 'trick', `${player.name} 观看了 ${t.name} 的所有手牌。`, {
          seat: player.seatId,
          action: 'zhibi',
        });
        setPending(st, {
          kind: 'viewCards',
          seatId: player.seatId,
          title: `${t.name} 的手牌（${t.hand.length} 张）`,
          cards: t.hand.slice(),
          returnTo: ctx.sourceId,
        });
        return;
      }
      const heroId = optionId.slice('hero:'.length);
      const heroName = hidden.find((h) => h.id === heroId)?.name ?? '暗置武将牌';
      pushLog(st, 'trick', `${player.name} 观看了一张暗置的武将牌。`, {
        seat: player.seatId,
        action: 'zhibi',
      });
      setPending(st, {
        kind: 'viewCards',
        seatId: player.seatId,
        title: '你观看的暗置武将牌',
        cards: [],
        note: heroName,
        returnTo: ctx.sourceId,
      });
    },
    ctx.sourceId,
  );
}

/** AOE：进入第一个响应者的 respondTrick */
/**
 * 祝融·巨象（锁定技）的后半句：**其他角色**使用的【南蛮入侵】结算结束后，你获得之。
 *
 * 判定口径：这张牌得是「用来当南蛮」并且结算完还躺在弃牌堆里。官方 FAQ 举的反例是
 * 曹操·奸雄把它收走了、或者于吉把别的牌蛊惑成了南蛮（牌面不是南蛮）——前者由
 * 「还在不在弃牌堆」自然挡掉，后者根本不会走到这里（虚拟牌没有实体牌）。
 */
function giveResolvedNanman(state: GameState, ctx: TrickContext): void {
  if (ctx.card.type !== 'nanman') return;
  for (const p of state.players) {
    if (!p.alive || p.seatId === ctx.sourceId) continue; // 自己用的不拿回来
    if (!activeHeroes(state, p).some((h) => h.gainsUsedNanman === true)) continue;
    const i = state.discard.findIndex((c) => c.id === ctx.card.id);
    if (i < 0) continue; // 已经被别人收走了（奸雄之类）
    const [card] = state.discard.splice(i, 1);
    if (!card) continue;
    p.hand.push(card);
    pushLog(state, 'skill', `${p.name} 的【巨象】获得了【南蛮入侵】。`, {
      seat: p.seatId,
      action: 'gain',
    });
  }
}

function enterTrickResponse(state: GameState, ctx: TrickContext): void {
  // 跳过已阵亡的响应者，以及被【藤甲】免疫的南蛮/万箭目标
  while (ctx.responderIndex < ctx.responders.length) {
    const seat = ctx.responders[ctx.responderIndex]!;
    const r = getPlayer(state, seat);
    // 【无懈可击·国】抵消掉的角色直接从队列里跳过
    if (r && negatedByWuxie(ctx, seat)) {
      pushLog(state, 'resolve', `${r.name} 已被【无懈可击·国】抵消，不再响应。`);
      ctx.responderIndex++;
      continue;
    }
    if (r && r.alive) {
      if (tengjiaNullifiesAoe(state, seat, ctx.card.type)) {
        pushLog(
          state,
          'resolve',
          `${r.name} 的【藤甲】令【${CARD_TYPE_NAME[ctx.card.type as import('@sgs/protocol').CardType]}】无效。`,
          {
            seat: r.seatId,
            action: 'shield',
          },
        );
        ctx.responderIndex++;
        continue;
      }
      break;
    }
    ctx.responderIndex++;
  }
  if (ctx.responderIndex >= ctx.responders.length) {
    // 群体锦囊整个结算完了：祝融·巨象在这个时机把【南蛮入侵】捞走
    giveResolvedNanman(state, ctx);
    endTrickResolution(state, ctx);
    return;
  }
  const rId = ctx.responders[ctx.responderIndex]!;
  // 时机二：**这名角色生效前**再开一次无懈窗口。
  // 群体锦囊是逐个角色各问一次的——所以「甲先化解了，轮到我时再抵消我」这种打法成立。
  openWuxieWindow(state, ctx, () => respondForCurrent(state, ctx, rId));
}

/**
 * 无懈窗口关掉之后，让当前这名响应者真正开始响应。
 *
 * 这里要**重新判一次**是否已被抵消：窗口里可能刚有人把他抵消掉了（那就跳过他去下一个），
 * 也可能有人抵消了那张无懈（那就照常响应）。
 */
function respondForCurrent(state: GameState, ctx: TrickContext, rId: string): void {
  const r = getPlayer(state, rId);
  if (!r || !r.alive) {
    advanceTrick(state, ctx);
    return;
  }
  if (negatedByWuxie(ctx, rId)) {
    pushLog(state, 'resolve', `${r.name} 已被【无懈可击】抵消，不再响应。`);
    advanceTrick(state, ctx);
    return;
  }
  // 刘琦·问计：不能被响应的是**其他角色**（使用者自己照常响应）→ 直接按「弃权」结算
  if (
    (ctx.unrespondable && rId !== ctx.sourceId) ||
    ctx.unrespondableTargets?.includes(rId)
  ) {
    pushLog(
      state,
      'resolve',
      `${r.name} 不能对【${CARD_TYPE_NAME[ctx.card.type as import('@sgs/protocol').CardType]}】作出响应，直接结算。`,
    );
    passAoeTrick(state, rId, ctx);
    return;
  }
  pushLog(
    state,
    'trick',
    `轮到 ${r.name} 响应【${CARD_TYPE_NAME[ctx.card.type as import('@sgs/protocol').CardType]}】。`,
  );
  setPending(state, { kind: 'respondTrick', responderId: rId, ctx });
}

/** AOE：推进到下一个响应者 */
function advanceTrick(state: GameState, ctx: TrickContext): void {
  ctx.responderIndex++;
  enterTrickResponse(state, ctx);
}

/** respondTrick → 按 trick 类型分发 */
function onRespondTrick(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
  ctx: TrickContext,
): ApplyResult {
  // 离间虚拟锦囊
  if (ctx.skillId === 'lilian') return respondLilianSha(state, seatId, intent, ctx);
  const type = ctx.card.type as TrickType;
  switch (type) {
    case 'juedou':
      return respondDuelSha(state, seatId, intent, ctx);
    case 'huogong':
      return respondHuogongCard(state, seatId, intent, ctx);
    case 'jiedao':
      return respondJiedaoSha(state, seatId, intent, ctx);
    case 'nanman':
      return respondNanmanSha(state, seatId, intent, ctx);
    case 'wanjian':
      return respondWanjianShan(state, seatId, intent, ctx);
    default:
      return err('该锦囊无需响应');
  }
}

/** passTrick → 按 trick 类型分发 */
function onPassTrick(state: GameState, seatId: string, ctx: TrickContext): ApplyResult {
  // 离间虚拟锦囊
  if (ctx.skillId === 'lilian') return passLilian(state, seatId, ctx);
  const type = ctx.card.type as TrickType;
  switch (type) {
    case 'juedou':
      return passDuel(state, seatId, ctx);
    case 'huogong':
      return passHuogong(state, seatId, ctx);
    case 'jiedao':
      return passJiedao(state, seatId, ctx);
    case 'nanman':
      return passAoeTrick(state, seatId, ctx);
    case 'wanjian':
      return passAoeTrick(state, seatId, ctx);
    default:
      return err('该锦囊无需响应');
  }
}

/**
 * 响应里「打出一张【杀】」的统一校验 + 计价。
 *
 * 支持【丈八蛇矛】的两张手牌当【杀】——那时生效的是一张虚拟【杀】，
 * 两张 material 手牌在这里一起进弃牌堆。
 * 成功返回实际生效的牌；失败返回错误消息（调用方原样 err 出去）。
 */
function takeRespondedSha(
  state: GameState,
  responder: Player,
  intent: { cardId: string; extraCardIds?: string[] },
): Card | string {
  const resolved = resolveUsedCard(state, responder, intent);
  if ('error' in resolved) return resolved.error;
  const card = resolved.card;
  if (card.type !== 'sha' && !canUseAsCard(state, responder, card, 'sha')) return '需打出【杀】';
  // 用转化技就得明置提供它的武将。这条以前只在「被【杀】指定后出闪」那条路上做了，
  // 于是南蛮/决斗/借刀/离间里用武圣、龙胆打出的【杀】不会亮将。
  revealForConversion(state, responder, card, 'sha');
  consumeCard(state, responder, card);
  return card;
}

// —— 决斗 ——

function respondDuelSha(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
  ctx: TrickContext,
): ApplyResult {
  const responder = getPlayerOrThrow(state, seatId);
  // 接受【杀】、武将可转化的牌（关羽·武圣：红牌当杀）、【丈八蛇矛】的两张手牌
  const card = takeRespondedSha(state, responder, intent);
  if (typeof card === 'string')
    return err(`决斗${card === '需打出【杀】' ? '需打出【杀】' : card}`);
  pushLog(state, 'trick', `${responder.name} 打出了【杀】。`);
  afterDuelShaPlayed(state, seatId, ctx);
  return { ok: true };
}

/** 决斗里某方打出了一张【杀】之后的后续（激将代打也走这里） */
function afterDuelShaPlayed(state: GameState, responderId: string, ctx: TrickContext): void {
  // 无双：对手每次要连出两张【杀】，凑满才换手
  const need = duelShaRequired(state, ctx, responderId);
  const played = (ctx.duelShaCount ?? 0) + 1;
  if (played < need) {
    pushLog(state, 'trick', `还需打出 ${need - played} 张【杀】。`);
    setPending(state, {
      kind: 'respondTrick',
      responderId,
      ctx: { ...ctx, duelShaCount: played },
    });
    return;
  }

  // 切换出杀方
  const newTurn = ctx.duelTurn === 'target' ? 'source' : 'target';
  const newResponderId = newTurn === 'source' ? ctx.sourceId : ctx.responders[0]!;
  const newResponder = getPlayer(state, newResponderId);
  if (!newResponder || !newResponder.alive) {
    // 对方已死 → 本方胜，无伤害
    endTrickResolution(state, ctx);
    return;
  }
  pushLog(state, 'trick', `轮到 ${newResponder.name} 打出【杀】或受 1 点伤害。`);
  setPending(state, {
    kind: 'respondTrick',
    responderId: newResponderId,
    ctx: { ...ctx, duelTurn: newTurn, duelShaCount: 0 },
  });
}

function passDuel(state: GameState, seatId: string, ctx: TrickContext): ApplyResult {
  const victim = getPlayerOrThrow(state, seatId);
  const attack: AttackContext = {
    sourceId: ctx.sourceId,
    cardId: ctx.card.id,
    asType: ctx.card.type,
    targetId: victim.seatId,
    cardUseId: ctx.cardUseId,
    declaredTargets: declaredTargetsOf(ctx),
    damage: 1,
    dodged: false,
  };
  // 技能加成：裸衣对【决斗】也生效
  const bonus = dealtDamageBonus(state, attack);
  const total = 1 + bonus;
  attack.damage = total;
  pushLog(state, 'trick', `${victim.name} 弃权，受到 ${total} 点伤害。`);
  if (bonus > 0) {
    pushLog(state, 'damage', `${victim.name} 受到的伤害 +${bonus}（技能）。`);
  }
  // 护心镜：这一步可能要问，所以整段（扣血 + 日志 + 收尾）都放进回调
  damageStep(state, victim, attack, total, (dmg, prevented) => {
    if (!prevented) {
      pushLog(
        state,
        'damage',
        `${victim.name} 受到 ${dmg} 点伤害，剩余 ${Math.max(0, victim.hp)} 体力。`,
      );
    }
    const tail = (): void => {
      if (victim.hp <= 0) {
        enterNearDeath(state, attack);
      } else {
        endTrickResolution(state, ctx);
      }
    };
    runDamagedHooks(state, victim, attack, dmg, tail);
  });
  return { ok: true };
}

// —— 火攻 ——

function respondHuogongCard(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
  ctx: TrickContext,
): ApplyResult {
  const responder = getPlayerOrThrow(state, seatId);
  const card = responder.hand.find((c) => c.id === intent.cardId);
  if (!card) return err('你没有这张牌');

  if (!ctx.revealedSuit) {
    // 阶段一：目标展示手牌（牌不弃，留在手中）
    // 展示的是**他的**牌，所以花色按他的口径（小乔·红颜：黑桃算红桃）——
    // 官方 FAQ：对小乔火攻，她亮黑桃，发动者要弃的是红桃。
    pushLog(state, 'trick', `${responder.name} 展示了【${cardLabel(card)}】。`);
    setPending(state, {
      kind: 'respondTrick',
      responderId: ctx.sourceId,
      ctx: { ...ctx, revealedSuit: suitSeenAs(state, responder, card) },
    });
    return { ok: true };
  }

  // 阶段二：来源弃同花色牌 → 造成 1 点火属性伤害
  // 这里弃的是**来源的**牌，同样按他的口径（反过来：小乔手里没有黑桃，
  // 别人亮黑桃时她永远配不上——官方 FAQ 明确过）
  if (suitSeenAs(state, responder, card) !== ctx.revealedSuit) return err('花色不符');
  removeCard(responder.hand, card.id);
  toDiscard(state, card);
  pushLog(state, 'trick', `${responder.name} 弃置了【${cardLabel(card)}】。`);
  const target = getPlayerOrThrow(state, ctx.responders[0]!);
  pushLog(state, 'trick', `${target.name} 受到 1 点火属性伤害。`);
  const attack: AttackContext = {
    sourceId: ctx.sourceId,
    cardId: ctx.card.id,
    asType: ctx.card.type,
    targetId: target.seatId,
    cardUseId: ctx.cardUseId,
    declaredTargets: declaredTargetsOf(ctx),
    damage: 1,
    dodged: false,
    attribute: 'fire',
  };
  damageStep(state, target, attack, 1, (dmg, prevented) => {
    if (!prevented) {
      pushLog(
        state,
        'damage',
        `${target.name} 受到 ${dmg} 点火属性伤害，剩余 ${Math.max(0, target.hp)} 体力。`,
      );
    }
    const tail = (): void => {
      if (target.hp <= 0) {
        enterNearDeath(state, attack);
      } else {
        endTrickResolution(state, ctx);
      }
    };
    if (prevented) {
      endTrickResolution(state, ctx);
      return;
    }
    runDamagedHooks(state, target, attack, dmg, tail);
  });
  return { ok: true };
}

function passHuogong(state: GameState, seatId: string, ctx: TrickContext): ApplyResult {
  if (!ctx.revealedSuit) {
    // 目标拒绝展示 → 火攻无效（无伤害）
    pushLog(state, 'trick', `${getPlayer(state, seatId)!.name} 拒绝展示，【火攻】无效。`);
    endTrickResolution(state, ctx);
    return { ok: true };
  }
  // 来源拒绝弃牌 → 无伤害
  pushLog(state, 'trick', `${getPlayer(state, seatId)!.name} 拒绝弃牌，【火攻】无效。`);
  endTrickResolution(state, ctx);
  return { ok: true };
}

// —— 借刀杀人 ——

function respondJiedaoSha(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
  ctx: TrickContext,
): ApplyResult {
  const holder = getPlayerOrThrow(state, seatId);
  // 借刀杀人只要「一张【杀】」——**不含转化技**（武圣那类不行，规则如此）。
  // 但【丈八蛇矛】的两张手牌当【杀】是装备的用法，照常可以。
  const resolved = resolveUsedCard(state, holder, intent);
  if ('error' in resolved) return err(resolved.error);
  const card = resolved.card;
  if (card.type !== 'sha') return err('需打出【杀】');
  const shaTargetId = ctx.shaTargetId!;
  const shaTarget = getPlayer(state, shaTargetId);
  if (!shaTarget || !shaTarget.alive) return err('出杀目标无效');
  consumeCard(state, holder, card);
  resolvePlayedSha(state, holder, shaTargetId, card, 'sha', {
    kind: 'trick',
    text: `${holder.name} 对 ${shaTarget.name} 使用了【杀】。`,
  });
  return { ok: true };
}

/**
 * 这次牌的使用**指定的目标名单**（界钟会·【权计】的「唯一目标」判据要用）。
 *
 * 拿不到就返回 undefined —— 调用方（伤害上下文）会因此**不认**这一次「使用牌造成伤害」，
 * 这是安全的默认：宁可漏判，也别把多目标/无目标的东西算成单目标。
 */
function declaredTargetsOf(ctx: TrickContext): string[] | undefined {
  if (ctx.targetIds && ctx.targetIds.length > 0) return ctx.targetIds.slice();
  if (ctx.targetId) return [ctx.targetId];
  return undefined;
}

/**
 * 一张**已经打出**的【杀】进入结算（借刀杀人 / 离间的强制出杀、以及势力技代打）。
 *
 * 与 startAttack 的区别：牌不是从 source 手里拿的（可能由别人代打），也不计入出杀次数。
 *
 * 这几条路以前只跑了 becomeTarget + 不可闪避，**漏了防具与八卦阵**；
 * 现在统一走 becomeTargetFor → afterShaBecomeTarget，顺带修掉那个漏判
 * （也让大乔·流离能对借刀/离间的杀生效）。
 */
function resolvePlayedSha(
  state: GameState,
  source: Player,
  targetId: string,
  card: Card,
  asType: CardType,
  log: { kind: string; text: string },
  after?: () => void,
  opts?: {
    ignoreArmor?: boolean;
    skillId?: string;
    /** 目标级「不能响应」判定（真则把该目标写进 unrespondableTargets） */
    unrespondableTo?: (st: GameState, target: Player) => boolean;
  },
): void {
  const target = getPlayer(state, targetId);
  if (!target || !target.alive) {
    if (after) after();
    else resumePlay(state, state.seatOrder[state.turn.seatIndex]!);
    return;
  }
  const attack: AttackContext = {
    sourceId: source.seatId,
    cardId: card.id,
    asType,
    targetId,
    // 这条路（借刀/离间/视为使用一张杀）每次只结算一个目标
    declaredTargets: [targetId],
    ...(card.generatedBy ? { generatedBy: card.generatedBy } : {}),
    ...(opts?.unrespondableTo?.(state, target) ? { unrespondableTargets: [targetId] } : {}),
    damage: 1,
    dodged: false,
    attribute: card.attribute,
    cardColor: colorSeenAs(state, source, card),
    requiredShan: 1,
    // 技能发起的这一次结算：无视防具（诛害强化）与来源技能标记（认领这一次使用）
    ...(opts?.ignoreArmor ? { ignoreArmor: true } : {}),
    ...(opts?.skillId ? { skillId: opts.skillId } : {}),
    afterSettled: after,
  };
  pushLog(state, log.kind, log.text);
  // 同 startAttack：旁观者的「其他角色使用牌时」要在链外先派（嵌套会挤掉询问）
  runOthersUseCard(state, source.seatId, { attack, card }, () =>
    runHooksPausable(state, 'useCard', source, { attack, card }, () => {
      becomeTargetFor(state, target, attack);
    }),
  );
}

/** 「其他角色使用牌时」依次问每个非使用者（可挂起） */
function runOthersUseCard(
  state: GameState,
  sourceSeatId: string,
  payload: { attack: AttackContext; card: Card },
  after: () => void,
  i = 0,
): void {
  const others = state.players.filter((p) => p.alive && p.seatId !== sourceSeatId);
  const step = (k: number): void => {
    const p = others[k];
    if (!p) {
      after();
      return;
    }
    runHooksPausable(state, 'othersUseCard', p, payload, () => step(k + 1));
  };
  step(i);
}

function passJiedao(state: GameState, seatId: string, ctx: TrickContext): ApplyResult {
  const holder = getPlayerOrThrow(state, seatId);
  // 交出武器
  const weapon = holder.equipment.weapon;
  if (!weapon) return err('你没有武器');
  holder.equipment.weapon = null;
  const source = getPlayer(state, ctx.sourceId);
  if (source) {
    source.hand.push(weapon);
    pushLog(
      state,
      'trick',
      `${holder.name} 将【${EQUIP_NAME[weapon.equipName!] ?? '武器'}】交给 ${source.name}。`,
    );
  } else {
    toDiscard(state, weapon);
  }
  // 交出武器 = 失去装备区的一张牌（枭姬）
  fireEquipLost(state, holder, weapon, () => endTrickResolution(state, ctx));
  return { ok: true };
}

// —— 离间（貂蝉主动技能：虚拟锦囊）——

/** 离间响应：A 对 B 出杀 */
function respondLilianSha(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
  ctx: TrickContext,
): ApplyResult {
  const responder = getPlayerOrThrow(state, seatId);
  const card = takeRespondedSha(state, responder, intent);
  if (typeof card === 'string') return err(card);
  const shaTargetId = ctx.shaTargetId!;
  const shaTarget = getPlayer(state, shaTargetId);
  if (!shaTarget || !shaTarget.alive) return err('出杀目标无效');
  resolvePlayedSha(state, responder, shaTargetId, card, 'sha', {
    kind: 'skill',
    text: `${responder.name} 对 ${shaTarget.name} 使用了【杀】。`,
  });
  return { ok: true };
}

/** 离间弃权：A 不出杀 → 受 1 点伤害 */
function passLilian(state: GameState, seatId: string, ctx: TrickContext): ApplyResult {
  const victim = getPlayerOrThrow(state, seatId);
  pushLog(state, 'skill', `${victim.name} 弃权，受到 1 点伤害。`);
  const attack: AttackContext = {
    sourceId: ctx.sourceId,
    cardId: ctx.card.id,
    asType: 'sha',
    targetId: victim.seatId,
    cardUseId: ctx.cardUseId,
    declaredTargets: declaredTargetsOf(ctx),
    damage: 1,
    dodged: false,
  };
  damageStep(state, victim, attack, 1, (dmg, prevented) => {
    if (!prevented) {
      pushLog(
        state,
        'damage',
        `${victim.name} 受到 ${dmg} 点伤害，剩余 ${Math.max(0, victim.hp)} 体力。`,
      );
    }
    const tail = (): void => {
      if (victim.hp <= 0) {
        enterNearDeath(state, attack);
      } else {
        endTrickResolution(state, ctx);
      }
    };
    if (prevented) {
      endTrickResolution(state, ctx);
      return;
    }
    runDamagedHooks(state, victim, attack, dmg, tail);
  });
  return { ok: true };
}

// —— 南蛮入侵 / 万箭齐发 ——

function respondNanmanSha(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
  ctx: TrickContext,
): ApplyResult {
  const responder = getPlayerOrThrow(state, seatId);
  const card = takeRespondedSha(state, responder, intent);
  if (typeof card === 'string') return err(card === '需打出【杀】' ? '南蛮入侵需打出【杀】' : card);
  pushLog(state, 'trick', `${responder.name} 打出了【杀】。`);
  advanceTrick(state, ctx);
  return { ok: true };
}

function respondWanjianShan(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
  ctx: TrickContext,
): ApplyResult {
  const responder = getPlayerOrThrow(state, seatId);
  const card = findUsableCard(responder, intent.cardId);
  if (!card) return err('你没有这张牌');
  {
    // 「田」不是手牌（只能用【急袭】当【顺手牵羊】、或被【资粮】交出去）
    const tianErr = tianBlocked(card);
    if (tianErr) return err(tianErr);
  }
  if (card.type !== 'shan' && !canUseAsCard(state, responder, card, 'shan'))
    return err('万箭齐发需打出【闪】');
  // 靠转化技出的这张【闪】要明置（甄姬·倾国 / 赵云·龙胆）
  revealForConversion(state, responder, card, 'shan');
  takeAndDiscard(state, responder, card);
  pushLog(state, 'trick', `${responder.name} 打出了【闪】。`, {
    seat: responder.seatId,
    action: 'shan',
  });
  // 也是「打出【闪】」（张角·雷击）
  runHooksPausable(state, 'shanUsed', responder, { attack: undefined }, () =>
    advanceTrick(state, ctx),
  );
  return { ok: true };
}

/**
 * 【南蛮入侵】造成伤害的来源：孟获·祸首让持有者「代替使用者成为伤害的来源」。
 *
 * 只对南蛮生效（万箭齐发共用同一条结算路径，但不受祸首影响）。
 * 没有祸首持有者时返回 null，调用方就沿用原本的使用者。
 */
function nanmanDamageSource(state: GameState, ctx: TrickContext): string | null {
  if (ctx.card.type !== 'nanman') return null;
  const holder = state.players.find(
    (p) => p.alive && activeHeroes(state, p).some((h) => h.nanmanDamageSource === true),
  );
  return holder ? holder.seatId : null;
}

/** AOE 弃权：受 1 点伤害，可能触发濒死中断 */
function passAoeTrick(state: GameState, seatId: string, ctx: TrickContext): ApplyResult {
  const victim = getPlayerOrThrow(state, seatId);
  pushLog(state, 'trick', `${victim.name} 弃权，受到 1 点伤害。`);
  const attack: AttackContext = {
    sourceId: nanmanDamageSource(state, ctx) ?? ctx.sourceId,
    cardId: ctx.card.id,
    asType: ctx.card.type,
    targetId: victim.seatId,
    cardUseId: ctx.cardUseId,
    declaredTargets: declaredTargetsOf(ctx),
    damage: 1,
    dodged: false,
  };
  damageStep(state, victim, attack, 1, (dmg, prevented) => {
    if (!prevented) {
      pushLog(
        state,
        'damage',
        `${victim.name} 受到 ${dmg} 点伤害，剩余 ${Math.max(0, victim.hp)} 体力。`,
      );
    }
    const tail = (): void => {
      if (victim.hp <= 0) {
        // 濒死中断：暂存 trick 上下文，救人/死亡后恢复
        state.ongoingTrick = ctx;
        enterNearDeath(state, attack);
      } else {
        advanceTrick(state, ctx);
      }
    };
    if (prevented) {
      advanceTrick(state, ctx);
      return;
    }
    runDamagedHooks(state, victim, attack, dmg, tail);
  });
  return { ok: true };
}

// —— 无懈可击 ——

/**
 * 此刻**被无懈可击抵消掉效果**的角色。
 *
 * 抵消链里奇数张生效：第 1 张抵消、第 2 张抵消第 1 张（于是恢复）、第 3 张再抵消……。
 */
export function negatedSeats(ctx: TrickContext): string[] {
  const chain = ctx.wuxieChain;
  if (!chain || chain.count % 2 === 0) return [];
  return chain.scope;
}

/** 这张锦囊是否已被无懈可击抵消掉对某个角色的效果 */
function negatedByWuxie(ctx: TrickContext, seatId: string): boolean {
  return negatedSeats(ctx).includes(seatId);
}

/**
 * 一张无懈可击能抵消**谁**的效果（候选范围）。
 *
 * 只看**尚未结算完毕**的角色（已经结算过的无法追溯抵消）：
 * - AOE/火烧连营这类有响应队列的 → 剩下的队列成员；
 * - 多目标锦囊 → ctx.targetIds；
 * - 单目标 → ctx.targetId；
 * - 规则决定目标的（桃园/五谷/以逸待劳/勠力同心/敕令…）→ 所有存活角色。
 */
function wuxieScopeCandidates(state: GameState, ctx: TrickContext): string[] {
  if (ctx.responders.length > 0) return ctx.responders.slice(ctx.responderIndex);
  // 目标是规则定死的那些锦囊：列出**真正会受影响的人**，别把全场都列成选项
  // （否则会出现「抵消【无中生有】对乙的效果」这种什么也不会发生的选项）
  const source = getPlayer(state, ctx.sourceId);
  const t = ctx.card.type as TrickType;
  switch (t) {
    case 'wuzhong':
    case 'xietianzi':
      return source ? [source.seatId] : [];
    case 'taoyuan':
    case 'wugu':
      return alivePlayers(state).map((p) => p.seatId);
    case 'yiyi': {
      if (!source) return [];
      const f = effectiveFaction(state, source);
      if (f === null) return [source.seatId]; // 暗置：只有自己
      return alivePlayers(state)
        .filter((p) => effectiveFaction(state, p) === f)
        .map((p) => p.seatId);
    }
    case 'huoshao':
      return source ? sameQueue(state, source.seatId) : [];
    case 'chiling':
      return chilingTargets(state).map((p) => p.seatId);
    case 'lianjun': {
      // 目标是「你 + 那个势力」；targetIds 里存的只是**势力的代表**
      const ids = source ? [source.seatId] : [];
      const rep = getPlayer(state, ctx.targetIds?.[0] ?? '');
      const f = rep ? effectiveFaction(state, rep) : null;
      if (f !== null) {
        ids.push(
          ...alivePlayers(state)
            .filter((p) => effectiveFaction(state, p) === f)
            .map((p) => p.seatId),
        );
      }
      return [...new Set(ids)];
    }
    case 'lutong':
      // 大势力或小势力全体（使用时要先选哪一类，所以两边都算候选）
      return alivePlayers(state)
        .filter((p) => {
          const f = effectiveFaction(state, p);
          return (f !== null && isBigFaction(state, f)) || isSmallFactionCharacter(state, p);
        })
        .map((p) => p.seatId);
    default:
      break;
  }
  const ids: string[] = [];
  if (ctx.targetIds && ctx.targetIds.length > 0) ids.push(...ctx.targetIds);
  else if (ctx.targetId) ids.push(ctx.targetId);
  return [...new Set(ids)];
}

/**
 * 落地一张无懈可击。
 *
 * - `guo === false`（普通【无懈可击】）：scope = 这一个角色；
 * - `guo === true`（【无懈可击·国】）：scope = 这个角色 + 与其势力相同的、
 *   所有尚未结算完毕的角色。
 *
 * 链上已经有前一环时，这一张是在**抵消上一张**——所以只把计数 +1（翻转），
 * scope 不变：奇数张抵消、偶数张恢复。
 *
 * 规则里的那条 FAQ 也照做：**无懈·国的基准角色尚未确定势力时不生效**
 * （牌照样用掉，只是什么也没抵消，也不占链）——暗置的人不属于任何势力。
 */
function applyWuxie(state: GameState, ctx: TrickContext, seatId: string, guo: boolean): void {
  const player = getPlayer(state, seatId);
  if (!player) return;
  const trickName = CARD_TYPE_NAME[ctx.card.type as CardType];
  const chain = ctx.wuxieChain;
  // 链上已有前一环 → 这一张抵消的是**上一张无懈**，翻转即可
  if (chain && chain.count > 0) {
    chain.count++;
    const names = chain.scope.map((s) => getPlayer(state, s)?.name ?? '?').join('、');
    pushLog(
      state,
      'trick',
      `${player.name} 使用了【${guo ? '无懈可击·国' : '无懈可击'}】，抵消了上一张【无懈可击】——` +
        `【${trickName}】对 ${names} 的效果${chain.count % 2 === 1 ? '再次被抵消' : '恢复'}。`,
      { seat: player.seatId, action: 'wuxie' },
    );
    return;
  }
  let scope: string[] = [seatId];
  if (guo) {
    const faction = effectiveFaction(state, player);
    if (faction === null) {
      pushLog(state, 'trick', `${player.name} 尚未确定势力，【无懈可击·国】未能抵消任何效果。`, {
        seat: player.seatId,
        action: 'wuxie',
      });
      return;
    }
    const hit = wuxieScopeCandidates(state, ctx).filter((sid) => {
      const p = getPlayer(state, sid);
      return !!p && effectiveFaction(state, p) === faction;
    });
    if (hit.length === 0) hit.push(seatId);
    scope = hit;
  }
  ctx.wuxieChain = { scope, count: 1 };
  const names = scope.map((s) => getPlayer(state, s)?.name ?? '?').join('、');
  pushLog(
    state,
    'trick',
    `${player.name} 使用了【${guo ? '无懈可击·国' : '无懈可击'}】，抵消了【${trickName}】对 ${names} 的效果${
      guo ? '（同一势力尚未结算的角色一并抵消）' : ''
    }。`,
    { seat: player.seatId, action: 'wuxie' },
  );
}

function onRespondWuxie(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
  pending: Extract<Pending, { kind: 'wuxieQueue' }>,
): ApplyResult {
  const asked = pending.askQueue[pending.askIndex];
  if (asked !== seatId) return err('当前不是你响应');
  const responder = getPlayerOrThrow(state, seatId);
  const card = findUsableCard(responder, intent.cardId);
  if (!card) return err('你没有这张牌');
  {
    // 「田」不是手牌（只能用【急袭】当【顺手牵羊】、或被【资粮】交出去）
    const tianErr = tianBlocked(card);
    if (tianErr) return err(tianErr);
  }
  // 接受【无懈可击】/【无懈可击·国】，或武将可转化的牌（卧龙诸葛亮·看破：黑色手牌当无懈）
  if (!isWuxieLike(card) && !canUseAsCard(state, responder, card, 'wuxie'))
    return err('只能使用【无懈可击】');
  revealForConversion(state, responder, card, 'wuxie');
  takeAndDiscard(state, responder, card);
  const ctx = pending.ctx;
  const isGuo = card.type === 'wuxieguo';
  /**
   * 这一张落地之后接着问下一轮。
   *
   * **不回到出牌阶段**：一张无懈只抵消了「对某些角色」的效果，锦囊对其他角色照样要结算；
   * 而且别人还能再打一张无懈来抵消这一张（抵消链）。所以重开一轮询问——从刚打牌的人的下家
   * 开始，**这一轮连锦囊的使用者也问**（他可以用无懈保住自己的锦囊）。
   * 每张无懈都要弃一张牌，所以这个循环必然收敛。
   */
  const after = (): void => {
    const queue = wuxieCounterQueue(state, responder.seatId);
    if (queue.length === 0) {
      finishWuxieWindow(state, pending);
      return;
    }
    pending.askQueue = queue;
    pending.askIndex = 0;
    setPending(state, pending);
  };
  const name = isGuo ? '无懈可击·国' : '无懈可击';
  // 链上已经有前一环 → 这一张是在**抵消上一张无懈**，它不选抵消谁（翻转即可），
  // 所以既不用问目标，也不受「没有候选目标」的限制。
  if (ctx.wuxieChain && ctx.wuxieChain.count > 0) {
    applyWuxie(state, ctx, responder.seatId, isGuo);
    after();
    return { ok: true };
  }
  const candidates = wuxieScopeCandidates(state, ctx);
  if (candidates.length === 0) {
    // 对谁都没有可抵消的效果（例如目标已全部结算完）：牌照样用掉
    pushLog(state, 'trick', `${responder.name} 使用了【${name}】，但没有可抵消的目标。`, {
      seat: responder.seatId,
      action: 'wuxie',
    });
    after();
    return { ok: true };
  }
  // 只有一个候选（单目标锦囊的常见情况）就别多问一次，直接落地
  if (candidates.length === 1) {
    applyWuxie(state, ctx, candidates[0]!, isGuo);
    after();
    return { ok: true };
  }
  askChoice(
    state,
    responder.seatId,
    `【${name}】：抵消【${CARD_TYPE_NAME[ctx.card.type as CardType]}】对谁的效果${
      isGuo ? '（与其势力相同的尚未结算的角色一并抵消）' : ''
    }？`,
    candidates.map((sid) => {
      const p = getPlayerOrThrow(state, sid);
      const f = effectiveFaction(state, p);
      return {
        id: sid,
        label: f ? `${p.name}（【${FACTION_NAME[f] ?? f}】）` : `${p.name}（未确定势力）`,
      };
    }),
    (st, _p, picked) => {
      applyWuxie(st, ctx, picked, isGuo);
      after();
    },
  );
  return { ok: true };
}

/** 某个座位之后的下一个存活座位 */
function nextSeatAfter(state: GameState, seatId: string): string {
  const idx = state.seatOrder.indexOf(seatId);
  if (idx < 0) return state.seatOrder[0]!;
  return state.seatOrder[nextAliveSeat(state, idx)]!;
}

function onPassWuxie(
  state: GameState,
  pending: Extract<Pending, { kind: 'wuxieQueue' }>,
): ApplyResult {
  pending.askIndex++;
  if (pending.askIndex >= pending.askQueue.length) finishWuxieWindow(state, pending);
  return { ok: true };
}

/**
 * 一轮无懈问完了（没人再打）→ 按当前的抵消链继续。
 *
 * `onDone` 就是「继续」的内容：锦囊开始前那一轮是「结算锦囊」，
 * 逐目标的那些窗口是「继续结算这个目标」。没有 onDone 时按结算锦囊处理。
 */
function finishWuxieWindow(
  state: GameState,
  pending: Extract<Pending, { kind: 'wuxieQueue' }>,
): void {
  const next = pending.onDone;
  if (next) next();
  else resolveTrick(state, pending.ctx);
}

function onRespondCard(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
): ApplyResult {
  const result = onRespondCardInner(state, seatId, intent);
  if (result.ok) {
    // 沙摩柯·蒺藜：打出的牌同样计入「本回合使用或打出的牌数」，并派发「打出后」的时机
    const p = getPlayer(state, seatId);
    if (p) {
      p.flags.cardsUsedOrPlayed += 1;
      p.flags.actionRangeSnapshot = attackRange(state, p);
      runHooksPausable(state, 'cardActionStarted', p, { card: intent.cardId }, () => {});
    }
  }
  return result;
}

/** 响应打出的实体（外面那层负责计数与派发） */
function onRespondCardInner(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
): ApplyResult {
  const pending = state.pending!;
  // 「本回合不能使用或打出手牌」：响应类打出同样受限（潜袭的颜色限制也在这里）
  {
    const p0 = getPlayerOrThrow(state, seatId);
    const card0 = p0.hand.find((c) => c.id === intent.cardId);
    const blocked = card0 ? blockedForPlay(p0, card0) : null;
    if (blocked) return err(blocked);
  }
  if (pending.kind === 'respondSha' && pending.responderId === seatId) {
    return respondSha(state, seatId, intent);
  }
  if (pending.kind === 'respondDeath' && pending.askQueue[pending.askIndex] === seatId) {
    return respondDeathSave(state, seatId, intent, pending);
  }
  if (pending.kind === 'respondTrick' && pending.responderId === seatId) {
    return onRespondTrick(state, seatId, intent, pending.ctx);
  }
  if (pending.kind === 'wuxieQueue' && pending.askQueue[pending.askIndex] === seatId) {
    return onRespondWuxie(state, seatId, intent, pending);
  }
  if (pending.kind === 'factionCall' && pending.askQueue[pending.askIndex] === seatId) {
    return onRespondFactionCall(state, seatId, intent, pending);
  }
  return err('当前你不能响应');
}

function respondSha(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
): ApplyResult {
  const pending = state.pending!;
  if (pending.kind !== 'respondSha') return err('内部错误');
  const responder = getPlayerOrThrow(state, seatId);
  const card = findUsableCard(responder, intent.cardId);
  if (!card) return err('你没有这张牌');
  {
    // 「田」不是手牌（只能用【急袭】当【顺手牵羊】、或被【资粮】交出去）
    const tianErr = tianBlocked(card);
    if (tianErr) return err(tianErr);
  }
  // 接受【闪】，或武将可转化的牌（赵云·龙胆：杀当闪；甄姬·倾国：黑牌当闪）
  // 暗置武将要预亮过对应的转化技才能这么出，出了就明置（canUseAsCard 已含这层判断）
  if (card.type !== 'shan' && !canUseAsCard(state, responder, card, 'shan'))
    return err('只能用【闪】响应');
  revealForConversion(state, responder, card, 'shan');
  takeAndDiscard(state, responder, card);
  pushLog(state, 'shan', `${responder.name} 使用了【闪】。`, {
    seat: responder.seatId,
    action: 'shan',
  });
  afterShanPlayed(state, responder, pending.attack);
  return { ok: true };
}

/**
 * 目标出了一张【闪】之后的收尾。
 * 护驾（同势力代打）也走这里——代打的那张闪同样算发起者的。
 */
function afterShanPlayed(state: GameState, who: Player, attack: AttackContext): void {
  // 「**任何**角色使用/打出【闪】之后」先派给全场（徐庶·诛害的「每用一张【闪】须弃一张牌」
  // 是旁观者的技能，只派给 responder 的 shanUsed 收不到）。无双那种连出多张时，每张各派一次。
  // ⚠️ 同 beforeDamageApply：多这一层可挂起嵌套会改变续接先后，**场上有人挂这个时机**才走它。
  const needsAnyShan = state.players.some(
    (p) => p.alive && collectTimingHooks(state, p, 'anyShanUsed', true).length > 0,
  );
  const afterAnyShan = (): void =>
  // 「你使用或打出【闪】」的时机（张角·雷击）。可挂起：雷击要问目标、还要判定。
  runHooksPausable(state, 'shanUsed', who, { attack }, () => {
    // 吕布·无双：需出 2 张闪，出 1 张后减 1，>1 则继续等
    const required = attack.requiredShan ?? 1;
    if (required > 1) {
      attack.requiredShan = required - 1;
      pushLog(state, 'shan', `${who.name} 还需出 ${required - 1} 张【闪】。`);
      setPending(state, { kind: 'respondSha', responderId: attack.targetId, attack });
      return;
    }
    attack.dodged = true;
    finishAttack(state, attack);
  });
  if (needsAnyShan) {
    runAnyShanUsed(state, { attack, responderId: who.seatId }, afterAnyShan);
  } else {
    afterAnyShan();
  }
}

/** 「任何角色使用/打出【闪】后」派给全场（可挂起）——诛害的「闪后弃牌」挂它 */
function runAnyShanUsed(
  state: GameState,
  payload: { attack: AttackContext; responderId: string },
  after: () => void,
  i = 0,
): void {
  const list = state.players.filter((p) => p.alive);
  const step = (k: number): void => {
    const p = list[k];
    if (!p) {
      after();
      return;
    }
    runHooksPausable(state, 'anyShanUsed', p, payload, () => step(k + 1));
  };
  step(i);
}

/**
 * 六条军令（国战·不臣篇）。
 *
 * 不做成实体牌：军令只是一个「从六条里抽两条、选一条交给对方」的挑选项，
 * 所以直接放成数据表最省事（见 api.armyOrder）。描述以官方为准。
 */
export const ARMY_ORDERS: { id: string; label: string }[] = [
  { id: 'damage', label: '对你指定的一名角色造成 1 点伤害' },
  { id: 'draw_give', label: '摸一张牌，然后依次交给军令发起者两张牌' },
  { id: 'lose_hp', label: '失去 1 点体力' },
  { id: 'seal', label: '本回合不能使用或打出手牌，且所有非锁定技失效' },
  { id: 'flip', label: '将武将牌叠置（翻面），且本回合不能回复体力' },
  { id: 'keep', label: '保留一张手牌和一张装备区里的牌，然后弃置其余的牌' },
];

/**
 * 军令的「伤害 / 失去体力」结算完之后继续往下走（王平·将略那边是逐个问下一个执行者）。
 *
 * ⚠️ 这两条效果**可能把人打进濒死**：那时 pending 被求桃队列占着（respondDeath），
 * 这时**不能**接着同步问下一个人——`askChoice` 会把求桃询问直接顶掉，被顶的人停在 0 体力
 * 却永远不死。把后续挂到 `state.ongoingSkillChain`，等濒死/阵亡那串走完、`resumePlay`
 * 接管时再继续。没进濒死（pending 是空的）就照旧同步往下走，整条链仍然是同步完成的。
 */
function afterArmyOrderInterrupt(state: GameState, after: () => void): void {
  if (state.pending) state.ongoingSkillChain.push(after);
  else after();
}

/**
 * 结算一条军令。
 *
 * `after` 在整条军令结算完（可能经过好几次询问）之后调用。
 * 第 2 条要用到发起者，所以两个座次都得传进来。
 */
function applyArmyOrder(
  state: GameState,
  tokenId: string,
  initiatorSeatId: string,
  executorSeatId: string,
  after: () => void,
): void {
  const executor = getPlayer(state, executorSeatId);
  const initiator = getPlayer(state, initiatorSeatId);
  if (!executor || !initiator) {
    after();
    return;
  }
  const api = makeSkillApi(state, { actor: executorSeatId });
  switch (tokenId) {
    case 'damage': {
      const others = state.players.filter((p) => p.alive && p.seatId !== executorSeatId);
      if (others.length === 0) {
        after();
        return;
      }
      api.askChoice(
        state,
        executorSeatId,
        '【军令】：选择要造成 1 点伤害的角色',
        others.map((p) => ({ id: p.seatId, label: p.name })),
        (st, _p, tid) => {
          const t = getPlayer(st, tid);
          if (!t) {
            after();
            return;
          }
          api.dealDamage(t, 1, executorSeatId, undefined, () =>
            afterArmyOrderInterrupt(state, after),
          );
        },
      );
      return;
    }
    case 'draw_give': {
      const c = drawOne(state);
      if (c) executor.hand.push(c);
      pushLog(state, 'skill', `${executor.name} 摸了一张牌。`);
      const hand = executor.hand.slice();
      if (hand.length === 0) {
        after();
        return;
      }
      const need = Math.min(2, hand.length);
      api.askPickCards(
        state,
        executorSeatId,
        `【军令】：依次交给 ${initiator.name} ${need} 张牌`,
        hand,
        need,
        need,
        (st, p, chosen) => {
          for (const card of chosen) {
            removeCard(p.hand, card.id);
            initiator.hand.push(card);
          }
          pushLog(st, 'skill', `${p.name} 交给 ${initiator.name} ${chosen.length} 张牌。`);
          after();
        },
      );
      return;
    }
    case 'lose_hp':
      // 同上：失去体力也可能进濒死
      api.loseHp(executor, 1, () => afterArmyOrderInterrupt(state, after));
      return;
    case 'seal':
      executor.flags.cannotPlayCardsThisTurn = true;
      executor.flags.nonLockedSkillsDisabled = true;
      pushLog(state, 'skill', `${executor.name} 本回合不能使用或打出手牌，且非锁定技失效。`);
      after();
      return;
    case 'flip':
      executor.flipped = true;
      executor.flags.cannotHealThisTurn = true;
      pushLog(state, 'skill', `${executor.name} 被翻面，且本回合不能回复体力。`);
      after();
      return;
    case 'keep': {
      // 保留一张手牌 + 一张装备区里的牌，其余弃置
      const keepHandThen = (): void => {
        const hand = executor.hand.slice();
        if (hand.length <= 1) {
          keepEquipThen();
          return;
        }
        const handApi = makeSkillApi(state, { actor: executorSeatId });
        handApi.askPickCards(
          state,
          executorSeatId,
          '【军令】：保留一张手牌（其余弃置）',
          hand,
          1,
          1,
          (st, p, chosen) => {
            const keep = chosen[0];
            for (const card of p.hand.slice()) {
              if (card.id === keep?.id) continue;
              removeCard(p.hand, card.id);
              toDiscard(st, card);
            }
            keepEquipThen();
          },
        );
      };
      const keepEquipThen = (): void => {
        const slots = EQUIP_SLOTS;
        const filled = slots.filter((sl) => executor.equipment[sl]);
        if (filled.length <= 1) {
          after();
          return;
        }
        const equipApi = makeSkillApi(state, { actor: executorSeatId });
        equipApi.askChoice(
          state,
          executorSeatId,
          '【军令】：保留一张装备牌（其余弃置）',
          filled.map((sl) => ({
            id: sl,
            label:
              EQUIP_NAME[executor.equipment[sl]!.equipName ?? ''] ?? EQUIP_NAME.weapon ?? '装备',
          })),
          (st, p, keepSlot) => {
            const drop = filled
              .filter((sl) => sl !== keepSlot)
              .map((sl) => p.equipment[sl])
              .filter((x): x is Card => !!x);
            let i = 0;
            const step = (): void => {
              if (i >= drop.length) {
                after();
                return;
              }
              const card = drop[i++]!;
              // 走 discardCard：弃装备要触发枭姬那类技能
              makeSkillApi(st, { actor: executorSeatId }).discardCard(p.seatId, card, step);
            };
            step();
          },
        );
      };
      keepHandThen();
      return;
    }
    default:
      after();
      return;
  }
}

/**
 * **军令的公共流程——`api.armyOrder` 与 `api.armyOrderMulti` 的唯一实现。**
 *
 * 官方流程只有一条：**发起者**从随机两张军令里挑一张交给执行者，执行者各自决定要不要执行，
 * 执行的人才结算那一条；整条链走完（中间可能挂起好几次询问）再回调 `done`。
 * 「一个执行者」和「一队执行者」的区别**只有名单长度**，所以两边都别再各写一份——
 * 这里以前就是两份拷贝，改一处漏一处（`armyOrderMulti` 的多余一次 shuffle、死人跳过之类）。
 *
 * `done(st, executedSeatIds)`：`executedSeatIds` 是**真正执行了**的人（拒绝的、中途阵亡的、
 * 名单里本来就没有的都不在里面）。单人的 `api.armyOrder` 用 `includes` 折成 boolean。
 */
function runArmyOrder(
  state: GameState,
  opts: {
    initiatorSeatId: string;
    executorSeatIds: string[];
    resumeTo?: string;
    /**
     * 「拒绝执行」时的额外结算（诸葛恪·黩武：拒绝 → 受到 1 点普通伤害 → 发起者摸 1）。
     * 不填＝按公共规则什么都不发生（劝进/节钺/将略都是这种）。
     */
    onRefuse?: (st: GameState, executorSeatId: string, next: () => void) => void;
  },
  done: (st: GameState, executedSeatIds: string[]) => void,
): void {
  const { initiatorSeatId, executorSeatIds, resumeTo } = opts;
  const initiator = getPlayer(state, initiatorSeatId);
  const named = executorSeatIds
    .map((id) => getPlayer(state, id))
    .filter((p): p is Player => !!p);
  // 整条链走完的收口：先让技能结算自己的收益，再把控制权还回去。
  // 技能在出牌阶段发起时 resumeTo 就是技能使用者——不还的话 pending 会停在 null，
  // 出牌方再也动不了（和 pindian 是同一个坑）。
  const finish = (st: GameState, executed: string[]): void => {
    done(st, executed);
    if (st.pending === null && resumeTo) resumePlay(st, resumeTo);
  };
  if (!initiator || named.length === 0) {
    finish(state, []);
    return;
  }
  // 发起者从随机两张军令里挑一张交给执行者（随机源必须是 state.rng，见 fuzz ⑦）
  const two = shuffle([...ARMY_ORDERS], state.rng).slice(0, 2);
  const only = named.length === 1 ? named[0]! : undefined;
  askChoice(
    state,
    initiatorSeatId,
    only ? `【军令】：从两张里挑一张交给 ${only.name}` : '【军令】：从两张里挑一条',
    two.map((o) => ({ id: o.id, label: o.label })),
    (st, _p, tokenId) => {
      const token = ARMY_ORDERS.find((o) => o.id === tokenId);
      if (!token) {
        finish(st, []);
        return;
      }
      const executed: string[] = [];
      // 一个人一个人地问：军令效果本身会挂起（伤害→濒死、弃牌要挑牌），
      // 所以下一步必须等 applyArmyOrder 的 after 回调，不能写在循环里。
      const step = (st2: GameState, i: number): void => {
        const executor = named[i];
        if (!executor) {
          finish(st2, executed);
          return;
        }
        // 中途阵亡的人跳过（军令可能把前一个人打死，也可能有人被移除）
        if (!executor.alive) {
          step(st2, i + 1);
          return;
        }
        askChoice(
          st2,
          executor.seatId,
          `【军令】${initiator.name} 令你执行：${token.label}。是否执行？`,
          [
            { id: 'yes', label: '执行军令' },
            { id: 'no', label: '不执行' },
          ],
          (st3, p3, picked) => {
            if (picked !== 'yes') {
              pushLog(st3, 'skill', `${p3.name} 拒绝执行军令。`);
              if (opts.onRefuse) opts.onRefuse(st3, executor.seatId, () => step(st3, i + 1));
              else step(st3, i + 1);
              return;
            }
            pushLog(st3, 'skill', `${p3.name} 执行军令：${token.label}。`);
            executed.push(executor.seatId);
            applyArmyOrder(st3, token.id, initiatorSeatId, executor.seatId, () =>
              step(st3, i + 1),
            );
          },
        );
      };
      step(st, 0);
    },
  );
}

/**
 * 当前 pending 处于哪种「需要打出某张牌」的场景。
 * 势力技（护驾/激将）据此判断能不能发动，以及代打的牌打出去之后接哪条链。
 */
type FactionScene =
  | { kind: 'sha-response'; needType: CardType; attack: AttackContext }
  | { kind: 'wanjian'; needType: CardType; ctx: TrickContext }
  | { kind: 'juedou'; needType: CardType; ctx: TrickContext }
  | { kind: 'nanman'; needType: CardType; ctx: TrickContext }
  | { kind: 'forced-sha'; needType: CardType; ctx: TrickContext; logKind: string };

function factionCallScene(seatId: string, pending: Pending): FactionScene | null {
  if (pending.kind === 'respondSha' && pending.responderId === seatId) {
    return { kind: 'sha-response', needType: 'shan', attack: pending.attack };
  }
  if (pending.kind !== 'respondTrick' || pending.responderId !== seatId) return null;
  const ctx = pending.ctx;
  // 离间是技能造的虚拟锦囊，也要一张【杀】
  if (ctx.skillId === 'lilian') {
    return { kind: 'forced-sha', needType: 'sha', ctx, logKind: 'skill' };
  }
  switch (ctx.card.type) {
    case 'wanjian':
      return { kind: 'wanjian', needType: 'shan', ctx };
    case 'juedou':
      return { kind: 'juedou', needType: 'sha', ctx };
    case 'nanman':
      return { kind: 'nanman', needType: 'sha', ctx };
    case 'jiedao':
      // 借刀杀人也是「打出【杀】」，而且是强制对指定目标出杀
      return { kind: 'forced-sha', needType: 'sha', ctx, logKind: 'trick' };
    default:
      return null;
  }
}

/** 代打的那张牌打出去之后，接回该场景原本的后续 */
function resolveFactionCard(
  state: GameState,
  caller: Player,
  scene: FactionScene,
  card: Card,
): void {
  switch (scene.kind) {
    case 'sha-response':
      afterShanPlayed(state, caller, scene.attack);
      return;
    case 'wanjian':
    case 'nanman':
      advanceTrick(state, scene.ctx);
      return;
    case 'juedou':
      afterDuelShaPlayed(state, caller.seatId, scene.ctx);
      return;
    case 'forced-sha': {
      const target = getPlayer(state, scene.ctx.shaTargetId ?? '');
      if (!target || !target.alive) {
        resumePlay(state, scene.ctx.sourceId);
        return;
      }
      resolvePlayedSha(state, caller, target.seatId, card, 'sha', {
        kind: scene.logKind,
        text: `${caller.name} 对 ${target.name} 使用了【杀】。`,
      });
      return;
    }
  }
}

/** 没人代打：还原成发起者自己响应的那个提示 */
function restoreFactionScene(state: GameState, seatId: string, scene: FactionScene): void {
  if (scene.kind === 'sha-response') {
    setPending(state, { kind: 'respondSha', responderId: seatId, attack: scene.attack });
    return;
  }
  setPending(state, { kind: 'respondTrick', responderId: seatId, ctx: scene.ctx });
}

/**
 * 势力技（曹操·护驾 / 刘备·激将）：需要打出一张牌时，令同势力角色代打。
 *
 * 覆盖的场景见 factionCallScene：需要【闪】的被杀指定与万箭齐发、
 * 需要【杀】的决斗/南蛮/借刀/离间。
 */
function onFactionCall(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'factionCall' }>,
): ApplyResult {
  const pending = state.pending;
  if (!pending) return err('当前不能发动势力技');
  const player = getPlayerOrThrow(state, seatId);
  const fc = activeHeroes(state, player)
    .map((h) => h.factionCall)
    .find((f) => f?.id === intent.skillId);
  if (!fc) return err('你没有这个势力技');
  const scene = factionCallScene(seatId, pending);
  if (!scene) return err('当前不能发动势力技');
  if (scene.needType !== fc.needType) return err(`【${fc.name}】在当前场景用不了`);
  const helpers = factionHelpers(state, player, fc.needType);
  if (helpers.length === 0) return err('没有可以代打的同势力角色');

  setPending(state, {
    kind: 'factionCall',
    callerId: seatId,
    needType: fc.needType,
    title: `${player.name} 发动【${fc.name}】，请同势力角色代打一张【${CARD_TYPE_NAME[fc.needType]}】`,
    askQueue: helpers,
    askIndex: 0,
    onCard: (st, helper, card) => {
      pushLog(st, 'skill', `${helper.name} 替 ${player.name} 打出了【${cardLabel(card)}】。`);
      resolveFactionCard(st, player, scene, card);
    },
    onNone: (st) => {
      pushLog(st, 'skill', `没有同势力角色代打，${player.name} 需自行响应。`);
      restoreFactionScene(st, seatId, scene);
    },
  });
  return { ok: true };
}

/** 能替 caller 代打 needType 的同势力角色（按座次，排除自己） */
export function factionHelpers(state: GameState, caller: Player, needType: CardType): string[] {
  const callerFaction = effectiveFaction(state, caller);
  if (!callerFaction) return [];
  return state.players
    .filter(
      (p) =>
        p.alive &&
        p.seatId !== caller.seatId &&
        effectiveFaction(state, p) === callerFaction &&
        p.hand.some((c) => c.type === needType || canUseAsCard(state, p, c, needType)),
    )
    .map((p) => p.seatId);
}

/** 势力技：同势力角色回应「代打一张牌」 */
function onRespondFactionCall(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
  pending: Extract<Pending, { kind: 'factionCall' }>,
): ApplyResult {
  const asked = pending.askQueue[pending.askIndex];
  if (asked !== seatId) return err('当前不是你响应');
  const helper = getPlayerOrThrow(state, seatId);
  // 代打【杀】时同样接受【丈八蛇矛】的两张手牌（needType 是 sha 才可能成立）
  const resolved = resolveUsedCard(state, helper, intent);
  if ('error' in resolved) return err(resolved.error);
  const card = resolved.card;
  if (card.type !== pending.needType && !canUseAsCard(state, helper, card, pending.needType))
    return err(`只能打出【${CARD_TYPE_NAME[pending.needType]}】`);
  revealForConversion(state, helper, card, pending.needType);
  consumeCard(state, helper, card);
  pending.onCard(state, helper, card);
  return { ok: true };
}

/** 势力技：某个同势力角色拒绝代打 */
function onPassFactionCall(
  state: GameState,
  seatId: string,
  pending: Extract<Pending, { kind: 'factionCall' }>,
): ApplyResult {
  const asked = pending.askQueue[pending.askIndex];
  if (asked !== seatId) return err('当前不是你响应');
  pending.askIndex++;
  if (pending.askIndex >= pending.askQueue.length) {
    pending.onNone(state);
  }
  return { ok: true };
}

function respondDeathSave(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
  pending: Extract<Pending, { kind: 'respondDeath' }>,
): ApplyResult {
  const saver = getPlayerOrThrow(state, seatId);
  const card = findUsableCard(saver, intent.cardId);
  if (!card) return err('你没有这张牌');
  {
    // 「田」不是手牌（只能用【急袭】当【顺手牵羊】、或被【资粮】交出去）
    const tianErr = tianBlocked(card);
    if (tianErr) return err(tianErr);
  }
  // 接受【桃】/【酒】，或武将可转化的红牌（华佗·急救：红牌当桃）
  if (card.type !== 'tao' && card.type !== 'jiu' && !canUseAsCard(state, saver, card, 'tao'))
    return err('只能用【桃】（或【酒】当桃）救人');
  if (card.type !== 'tao') revealForConversion(state, saver, card, 'tao');
  // 酒当桃救人：限1次/回合
  if (card.type === 'jiu' && saver.flags.taoSaveCountThisTurn > 0) return err('本回合已用过酒救人');
  takeAndDiscard(state, saver, card);
  if (card.type === 'jiu') saver.flags.taoSaveCountThisTurn++;
  const dying = getPlayerOrThrow(state, pending.dyingId);
  // 救援：同势力的**其他**角色对你使用【桃】时额外回复（孙权·救援）
  let heal = 1;
  const dyingFaction = effectiveFaction(state, dying);
  if (card.type === 'tao' && saver.seatId !== pending.dyingId && dyingFaction) {
    // 暗置的救援者没有势力 → 拿不到【救援】的加成
    const sameFaction = effectiveFaction(state, saver) === dyingFaction;
    const extra = sameFaction
      ? activeHeroes(state, dying).reduce((sum, h) => sum + (h.rescueHealBonusFromFaction ?? 0), 0)
      : 0;
    if (extra > 0) {
      heal += extra;
      pushLog(state, 'skill', `${dying.name} 的【救援】生效，额外回复 ${extra} 点体力。`);
    }
  }
  dying.hp = Math.max(dying.hp, 0) + heal;
  pushLog(
    state,
    'tao',
    `${saver.name} 使用了【${card.type === 'tao' ? '桃' : '酒'}】，${dying.name} 回复 1 点体力。`,
  );
  // 濒死被救回也算「回复体力」（甘夫人·淑慎）。这里刻意不走 healAndTrigger：
  // 濒死时体力 ≤0，回复量不该被体力上限夹取（原来就是 Math.max(hp,0) + heal）。
  // taoSaverId 给法正·恩怨①用（「其他角色对你使用【桃】时，其摸一张牌」）。
  // 与【救援】同一口径：只认**实体【桃】**，转化出来的桃（急救那种红牌当桃）与酒当桃不算。
  runHooksPausable(
    state,
    'afterHeal',
    dying,
    { amount: heal, taoSaverId: card.type === 'tao' && saver.seatId !== dying.seatId ? saver.seatId : undefined },
    () => {},
  );
  // 严白虎·寄篱：别人（或他自己）用**红色**【桃】把他从濒死救回来 → 再用一张虚拟【桃】
  // （第二张就是再回复 1 点；它无色，寄篱的钩子不会再认它，所以天然不会自环）
  if (
    card.type === 'tao' &&
    !card.virtual &&
    !card.generatedBy &&
    cardColorOf(card) === 'red' &&
    effectiveHeroes(state, dying).some((h) => h.jili === true)
  ) {
    useVirtualSameNameCard(state, saver, card, dying, (vcard) => {
      const more = healAndTrigger(state, dying, 1);
      pushLog(state, 'tao', `【${cardShortName(vcard)}】回复 ${more} 点体力。`, {
        seat: dying.seatId,
        action: 'tao',
      });
    });
  }
  // 救活：先派发「濒死结算结束后」（左慈·汲魂 / 吴国太·补益），再把控制权还回去
  // 同上：被【桃】救回（黩武的第二个「被救回」出口）
  if (state.duwuWatchSeat) state.duwuRescued = true;
  dispatchNearDeathResolved(state, dying.seatId, true, pending.killerId, () => {
    resumePlay(state, state.seatOrder[state.turn.seatIndex]!);
  });
  return { ok: true };
}

function onPass(state: GameState, seatId: string): ApplyResult {
  const pending = state.pending!;
  if (pending.kind === 'respondSha' && pending.responderId === seatId) {
    // 弃权 → 杀命中结算
    finishAttack(state, pending.attack);
    return { ok: true };
  }
  if (pending.kind === 'respondDeath') {
    const asked = pending.askQueue[pending.askIndex];
    if (asked !== seatId) return err('当前不是你响应');
    pending.askIndex++;
    if (pending.askIndex >= pending.askQueue.length) {
      doDeath(state, pending.dyingId, pending.killerId);
    }
    return { ok: true };
  }
  if (pending.kind === 'respondTrick' && pending.responderId === seatId) {
    return onPassTrick(state, seatId, pending.ctx);
  }
  if (pending.kind === 'wuxieQueue') {
    const asked = pending.askQueue[pending.askIndex];
    if (asked !== seatId) return err('当前不是你响应');
    return onPassWuxie(state, pending);
  }
  if (pending.kind === 'factionCall') {
    return onPassFactionCall(state, seatId, pending);
  }
  return err('当前不能弃权');
}

function onEndPhase(state: GameState, seatId: string): ApplyResult {
  const pending = state.pending!;
  if (pending.kind !== 'play' || pending.seatId !== seatId) return err('不是你的出牌阶段');
  const player = getPlayerOrThrow(state, seatId);
  goToDiscardPhase(state, player);
  return { ok: true };
}

function onDiscard(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'discard' }>,
): ApplyResult {
  const pending = state.pending!;
  if (pending.kind !== 'discard' || pending.seatId !== seatId) return err('不是你的弃牌阶段');
  const player = getPlayerOrThrow(state, seatId);
  if (intent.cardIds.length !== pending.count) return err(`需弃 ${pending.count} 张牌`);
  for (const id of intent.cardIds) {
    if (!player.hand.some((c) => c.id === id)) return err('弃的牌不在手中');
  }
  const thrown: Card[] = [];
  for (const id of intent.cardIds) {
    const c = removeCard(player.hand, id);
    if (c) {
      toDiscard(state, c);
      thrown.push(c);
    }
  }
  // 朱灵·决绝的门槛：本阶段**弃置过手牌**（这条强制弃牌路径本来就是从手牌里弃）
  if (thrown.length > 0 && !state.handDiscardedInDiscardPhase.includes(player.seatId)) {
    state.handDiscardedInDiscardPhase.push(player.seatId);
  }
  // 挟天子以令诸侯要看「弃牌阶段是否真弃过牌」
  if (intent.cardIds.length > 0) player.flags.discardedInDiscardPhase = true;
  pushLog(state, 'discard', `${player.name} 弃了 ${intent.cardIds.length} 张牌。`);
  // 礼让这类「你的牌因弃置而进弃牌堆」的时机；之后再推进弃牌阶段结束
  fireCardDiscarded(state, player, thrown, () => runDiscardPhaseEnd(state, player, thrown));
  return { ok: true };
}

/** 国战：出牌阶段主动亮将 */
function onRevealHero(state: GameState, seatId: string, intent: Intent): ApplyResult {
  if (intent.type !== 'revealHero') return err('亮将：请指定要亮的武将');
  if (state.mode !== 'guozhan') return err('非国战模式不能亮将');
  const pending = state.pending;
  if (!pending) return err('当前不能亮将');
  const player = getPlayerOrThrow(state, seatId);
  // 主动亮将**只有准备阶段开始时**这一个时机（出牌阶段不算——那时只能靠「发动技能」
  // 顺带明置）。准备阶段的询问会正常给「明置主将/副将/全部」，这个意图是同一时机内的
  // 补充入口（选过「暂不明置」之后又改主意）。引擎里准备阶段与判定阶段同属 'judgment'。
  const isMyTurn = state.seatOrder[state.turn.seatIndex] === seatId;
  if (intent.heroId !== player.heroId && intent.heroId !== player.deputyHeroId)
    return err('该武将不是你的武将');
  // 按模式取将：国战的小乔多一句「出牌阶段，你可明置此武将牌」（身份局没有暗置这回事）
  const mainHero = getHeroForMode(player.heroId, state.mode);
  const deputyHero = getHeroForMode(player.deputyHeroId, state.mode);
  const target = intent.heroId === player.heroId ? mainHero : deputyHero;
  if (!target) return err('找不到该武将');
  // 通常只有**准备阶段**能主动明置（出牌阶段只能靠发动技能顺带明置）；例外写在
  // **那张武将牌本身**的文本里——「出牌阶段，你可明置此武将牌」
  // （小乔·红颜、邹氏·祸水），所以按要亮的那张牌判，而不是按「你有没有这样的牌」。
  const playPhaseReveal = state.turn.phase === 'play' && target.canRevealInPlayPhase === true;
  if (!isMyTurn || (state.turn.phase !== 'judgment' && !playPhaseReveal))
    return err('只能在你的准备阶段明置武将牌（其余时机要发动技能才能明置）');
  // 被君主旗「暂时不能明置」封着（君曹操·建安 → 五子良将纛的代价）
  if (revealBlocked(state, player, target.id))
    return err(`【${target.name}】被【建安】封着，暂时不能明置`);
  if (!revealHeroCard(state, player, target)) return err('该武将已经亮出');
  return { ok: true };
}

/**
 * 明置某张武将牌（国战）。返回是否真的亮了。
 *
 * 两条路径都用它：主动亮将（onRevealHero）、以及**发动技能时**必须明置
 * （预亮确认后 / 主动技点击后 / 用转化技时）。君主将亮一张等于两张。
 *
 * 亮将后要跑 `onHeroRevealed`（先驱 / 阴阳鱼 / 珠联璧合的发放都挂在那里），
 * 所以**不要**直接改 heroRevealed 字段。
 */
/**
 * 此刻这个人能不能明置武将牌。
 *
 * 唯一的封锁来自**邹氏·祸水**：「你的回合内，其他角色不能明置其武将牌」。
 * 所以明置的两条路都要问它：
 * - `revealHeroCard` —— 真的去明置（主动亮将、准备阶段询问、发动技能顺带明置）；
 * - `canUseAsCard` 的暗置分支 —— 暗置的人想用转化技就得先明置，被封锁时就用不了。
 */
function canRevealNow(state: GameState, player: Player): boolean {
  const turnSeatId = state.seatOrder[state.turn.seatIndex];
  if (!turnSeatId || turnSeatId === player.seatId) return true;
  const turnPlayer = getPlayer(state, turnSeatId);
  if (!turnPlayer || !turnPlayer.alive) return true;
  return !activeHeroes(state, turnPlayer).some((h) => h.blocksOthersReveal);
}

function revealHeroCard(state: GameState, player: Player, hero: Hero): boolean {
  if (state.mode !== 'guozhan') return false;
  // 君主旗「暂时不能明置」（君曹操·建安 → 五子良将纛的代价）：连「发动技能顺带明置」这条路
  // 也一并挡住——那张牌此刻就是不能翻。
  if (revealBlocked(state, player, hero.id)) {
    pushLog(state, 'reveal', `【${hero.name}】被【建安】封着，暂时不能明置。`, {
      seat: player.seatId,
    });
    return false;
  }
  // 邹氏·祸水：**她的回合内，其他角色不能明置武将牌**
  if (!canRevealNow(state, player)) {
    pushLog(state, 'reveal', `【祸水】生效：当前回合内，其他角色不能明置武将牌。`, {
      seat: player.seatId,
    });
    return false;
  }
  // 这一翻之前他有没有确定的势力（会盟要看「某个势力的角色数是不是从 0 变成了别的数」），
  // 以及主将牌是不是**这一翻**第一次明置（「野心家」标记跟着主将走）
  const wasDetermined = player.heroRevealed || player.deputyRevealed;
  const wasMainRevealed = player.heroRevealed;
  const mainHero = getHero(player.heroId);
  const deputyHero = getHero(player.deputyHeroId);
  const isLordPair = !!mainHero?.isLord || !!deputyHero?.isLord;
  let changed = false;
  if (isLordPair) {
    if (player.heroRevealed && player.deputyRevealed) return false;
    player.heroRevealed = true;
    player.deputyRevealed = true;
    changed = true;
    const names = [mainHero?.name, deputyHero?.name].filter(Boolean).join('、');
    pushLog(state, 'reveal', `${player.name} 亮将（君主）：${names}。`);
  } else if (hero.id === player.heroId) {
    if (player.heroRevealed) return false;
    player.heroRevealed = true;
    changed = true;
    pushLog(state, 'reveal', `${player.name} 亮将：${mainHero?.name ?? '未知'}。`);
  } else if (hero.id === player.deputyHeroId) {
    if (player.deputyRevealed) return false;
    player.deputyRevealed = true;
    changed = true;
    pushLog(state, 'reveal', `${player.name} 亮将：${deputyHero?.name ?? '未知'}。`);
  } else {
    return false;
  }
  if (changed) {
    // ㈠ 野心家**身份**（因人数超限转化）：明置、确定势力的那一刻，如果加入该势力会让它
    //     **超过全场人数的一半**，就不加入、改为野心家（用户核对后的官方口径）。
    //
    // ⚠️ 这**不是**「野心家武将」那套：不臣篇的野心家武将（主将本身是野势力）有独立的
    //    「暴露野心 → 建立新势力」流程（在胜利判定前截断处理，2023 改版后所有存活玩家都可
    //    选择加入、不加入者补手牌至 4 并回 1 体力）。两者只是名字撞车，转化来的野心家**没有**
    //    这套流程。本仓库还没有野心家武将（不臣篇未做），所以那段流程还没实装——口径与坑
    //    记在 docs/guozhan-roster.md §5.74。
    //     ⚠️ 是「超过一半」不是「达到一半」：8 人局 4 个魏没问题、第 5 个才野；6 人局 3 个可以、
    //        第 4 个才野；5 人局只允许 2 个（3 就超了）。
    //     ⚠️ 按**明置先后**逐个人判（谁先亮谁留下），不是开局按座次预先指定。
    //     君主将不会成为野心家（2026 君主规则），所以 `isLordPair` 直接跳过。
    // ⚠️ 双势力武将：按**已确定势力**判超编/派发会盟（faction 是后台主将势力，可能已不同）
    const joinFaction = player.determinedFaction ?? player.faction;
    if (state.mode === 'guozhan' && !wasDetermined && !isLordPair && joinFaction) {
      const total = state.players.length;
      if (knownFactionCount(state, joinFaction) > total / 2) {
        const from = joinFaction;
        player.faction = 'ambitionist';
        pushLog(
          state,
          'faction',
          `${player.name} 明置时【${FACTION_NAME[from] ?? from}】已有 ${knownFactionCount(state, from)} 人（超过全场 ${total} 人的一半），他不加入该势力、成为野心家。`,
          { seat: player.seatId },
        );
      }
    }
    onHeroRevealed(state, player);
    // ㈡ 「野心家」**标记**：首次明置**主将**牌后获得一枚，可以当作【阴阳鱼】【珠联璧合】
    //     【先驱】中任意一种使用（用户核对后的当前规则：这枚标记**不等于**野心家身份，
    //     不是野心家的人照样能拿到）。
    //     例外：主将因人数超限而转成野心家**身份**的人不发（那是名字撞车的另一个东西）。
    if (!wasMainRevealed && player.heroRevealed && player.faction !== 'ambitionist') {
      addMarker(player, 'ambitionist');
      pushLog(
        state,
        'marker',
        `${player.name} 首次明置主将，获得【野心家】标记（可当作阴阳鱼 / 珠联璧合 / 先驱使用）。`,
        { seat: player.seatId },
      );
    }
    // 「当你明置此武将牌后」（糜夫人·闺秀）：把 payload 交给钩子，技能自己判断是不是自己那张
    runHooksPausable(state, 'heroRevealed', player, { heroId: hero.id }, () => {
      // 「**首次确定势力**」（潘濬·聪察要的正是这件事，不是「亮了一张将」）：只有从「未确定」
      // 真正进入某个确定势力的这一翻才算——第二张牌翻过来时势力早就定了，`wasDetermined` 挡住。
      if (!wasDetermined) runFactionDetermined(state, player);
      // 【会盟】：他这一翻让某个势力**首次出现在场上**（0 → 1）时派发。
      // 只有「本来没有确定势力」的人翻牌才可能发生这件事——第二张牌翻过来时势力早就定了。
      if (wasDetermined) return;
      const to = knownFactionCount(state, joinFaction);
      if (to === 1) {
        runAllPlayersHooks(
          state,
          'factionCountChanged',
          { faction: player.faction, from: 0, to },
          () => {},
        );
      }
    });
  }
  return changed;
}

/**
 * 「**首次确定势力**」的派发点（潘濬·【聪察】）。
 *
 * 为什么单独立一个事件、而不是复用 `heroRevealed`：技能关心的不是「亮了一张将」，
 * 而是「这个人**第一次**有了确定的势力」——单势力明置、双势力确定最终势力、野心家身份转化
 * 在底层都可能发生这件事，而只有第一次才算（之后势力再变不再触发）。
 *
 * 本仓库口径下「确定势力」＝已明置（`effectiveFaction` 非空）：双势力的最终势力虽然在选将时
 * 就算出来了，但要等明置才**对外确定**，所以派发点落在明置这一处、且每人只派一次。
 *
 * payload `{ playerId, faction, isFirstDetermination }`，派给**全场**（观察者是旁观者）。
 * ⚠️ 与其它新派发点一样：场上真有人挂这个时机才走这一层（多一层可挂起嵌套会改变续接先后）。
 */
function runFactionDetermined(state: GameState, player: Player): void {
  const needed = state.players.some(
    (p) => p.alive && collectTimingHooks(state, p, 'factionDetermined', false).length > 0,
  );
  if (!needed) return;
  const faction = effectiveFaction(state, player);
  if (!faction) return;
  runAllPlayersHooks(
    state,
    'factionDetermined',
    { playerId: player.seatId, faction, isFirstDetermination: true },
    () => {},
  );
}

/**
 * 国战「预亮」：暗置时声明某个技能的发动意图（再发一次就是取消）。
 *
 * 只接受**自己暗置武将牌上的非锁定技**：
 * - 已明置武将的技能不需要预亮（它们本来就生效）；
 * - 锁定技没有「询问是否发动」这回事，预亮没有意义，直接拒绝。
 *
 * 这个意图不推进流程，也不产生询问——它只是把意图记在 `Player.prelitSkills` 上，
 * 等对应时机到来时由 `prelitHooks` 读它。
 */
function onPrelightSkill(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'prelightSkill' }>,
): ApplyResult {
  if (state.mode !== 'guozhan') return err('只有国战有预亮');
  const player = getPlayerOrThrow(state, seatId);
  const name = intent.skillName;
  const idx = player.prelitSkills.indexOf(name);
  if (idx >= 0) {
    player.prelitSkills.splice(idx, 1);
    return { ok: true };
  }
  const offered = prelitableSkills(state, player);
  if (!offered.some((s) => s.name === name)) return err('该技能不能预亮');
  player.prelitSkills.push(name);
  return { ok: true };
}

/**
 * 「连横」可以交给谁（势备篇）。
 *
 * 规则：交给一名「与你势力不同**或**未确定势力」的角色。两句合起来就是——
 * - 你是**已确定势力**：任何**非**同势力角色都能收（包括未确定势力的）；
 * - 你是**未确定势力**：只能给**同样未确定势力**的角色
 *   （官方 FAQ：未确定势力的角色无法把带连横标记的牌交给已确定势力的角色）。
 *
 * 摸牌只发生在「对方是已确定势力且与你不同」时；给未确定势力的角色不摸牌。
 */
export function lianhengTargets(state: GameState, player: Player): string[] {
  const mine = effectiveFaction(state, player);
  return state.players
    .filter((p) => {
      if (!p.alive || p.seatId === player.seatId) return false;
      const theirs = effectiveFaction(state, p);
      if (!mine) return theirs === null; // 自己没势力 → 只能给没势力的
      return theirs !== mine; // 自己有势力 → 给不同的（含未确定）
    })
    .map((p) => p.seatId);
}

/** 连横：把手牌交给别人，可能摸一张。**不是使用牌**，所以不走 useCard 钩子。 */
function onLianheng(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'lianheng' }>,
): ApplyResult {
  if (state.mode !== 'guozhan') return err('连横只存在于国战（势备篇）');
  const pending = state.pending;
  if (!pending || pending.kind !== 'play' || pending.seatId !== seatId)
    return err('不是你的出牌阶段');
  const player = getPlayerOrThrow(state, seatId);
  const card = player.hand.find((c) => c.id === intent.cardId);
  if (!card) return err('你没有这张牌');
  if (!card.lianheng) return err('这张牌没有连横标记');
  const target = getPlayer(state, intent.targetSeatId);
  if (!target || !target.alive) return err('目标无效');
  if (!lianhengTargets(state, player).includes(target.seatId))
    return err('只能连横给势力不同或未确定势力的角色');

  removeCard(player.hand, card.id);
  target.hand.push(card);
  const theirs = effectiveFaction(state, target);
  pushLog(state, 'lianheng', `${player.name} 将【${cardLabel(card)}】连横给 ${target.name}。`, {
    seat: player.seatId,
    action: 'lianheng',
  });
  // 交给**已确定势力**且不同的角色 → 摸一张；交给未确定势力的不摸
  if (theirs !== null) {
    const drawn = drawOne(state);
    if (drawn) player.hand.push(drawn);
    pushLog(state, 'lianheng', `${player.name} 因连横摸了一张牌。`, {
      seat: player.seatId,
      action: 'draw',
    });
  }
  return { ok: true };
}

/**
 * 这名玩家现在可以预亮的技能：**暗置**武将牌上的
 * ①触发技（有钩子、非锁定）②转化技（skillFields 里带 canUseAs）。
 *
 * 被排除的两类各有理由：
 * - 主动技：不用预亮，出牌阶段点一下就明置并发动；
 * - 锁定技与常驻字段技（马术、咆哮、红颜这类）：它们没有「询问是否发动」这一步，
 *   要生效只能主动明置武将牌——线上也是「这些将必须回合开始时亮将」。
 */
export function prelitableSkills(
  state: GameState,
  player: Player,
): { name: string; desc: string }[] {
  const out: { name: string; desc: string }[] = [];
  for (const hero of unrevealedHeroes(state.mode, player)) {
    const activeNames = new Set((hero.activeSkills ?? []).map((s) => s.name));
    const lockedNames = new Set(
      (hero.hooks ?? []).filter((h) => h.locked).map((h) => h.skillId ?? ''),
    );
    const hookedNames = new Set((hero.hooks ?? []).map((h) => h.skillId ?? ''));
    for (const s of hero.skills) {
      if (activeNames.has(s.name)) continue; // 主动技：点击即明置发动
      if (lockedNames.has(s.name)) continue; // 锁定技：没有「是否发动」
      const isHookSkill = hookedNames.has(s.name);
      const isConversion = (hero.skillFields?.[s.name] ?? []).includes('canUseAs');
      if (!isHookSkill && !isConversion) continue; // 常驻字段技（马术/咆哮）
      out.push({ name: s.name, desc: s.desc });
    }
  }
  return out;
}

/**
 * 构造注入给技能与钩子的引擎内部 API。
 *
 * `resumeTo`：伤害结算完之后把控制权还给谁。
 * - 技能在出牌阶段造成的伤害 → 传技能使用者，结算完回到他的出牌阶段
 * - 钩子里造成的伤害 → 不传。被打断的流程由续接队列负责接回来，
 *   再自己 resumePlay 一次反而会和它抢 pending
 *
 * `actor`：这次调用是**谁**在行动（钩子里就是钩子所属玩家）。
 * 「获得技能」这类需要知道受益者的接口靠它。技能路径那边由 resumeTo 兼职。
 *
 * `judgeBox` / `attackBox`：判定与「成为杀目标」时，钩子用来回传「问了才知道」的决定。
 */
function makeSkillApi(
  state: GameState,
  opts?: {
    resumeTo?: string;
    actor?: string;
    judgeBox?: JudgeBox;
    attackBox?: AttackBox;
    pindianBox?: PindianBox;
  },
): SkillApi {
  const resumeTo = opts?.resumeTo;
  const judgeBox = opts?.judgeBox;
  const attackBox = opts?.attackBox;
  const pindianBox = opts?.pindianBox;
  return {
    askChoice,
    askPickCards,
    replaceJudgeCard: (card) => {
      // 没有 judgeBox 说明不在判定流程里，静默忽略
      if (judgeBox) {
        // 判定链已经跑完了（回答来得太晚）：这张牌没有判定可以替换了，但它**不能消失**——
        // 按「打出的牌」进弃牌堆（模糊测试报过：它以前就这么没了）
        if (judgeBox.chain?.dead) {
          toDiscard(state, card);
          pushLog(
            state,
            'judge',
            `判定已经结算完，打出的【${cardLabel(card)}】置入弃牌堆。`,
          );
          return;
        }
        judgeBox.replacement = card;
      }
    },
    judge: (skillName, onDone, judgeOpts) => {
      const judgeSeat = judgeOpts?.judgeSeatId ?? opts?.actor;
      const judge = judgeSeat ? getPlayer(state, judgeSeat) : undefined;
      if (!judge || !judge.alive) {
        onDone(null, false);
        return;
      }
      const raw = drawOne(state);
      if (!raw) {
        onDone(null, false);
        return;
      }
      pushLog(state, 'judge', `${judge.name} 的【${skillName}】判定：${cardLabel(raw)}。`);
      // 判定牌**属于判定者**，所以鬼才/鬼道换上来的牌也算他的；天妒能把它收走
      // （judgedId＝判定者）。keepCard 时把牌留给调用方安置（屯田收「田」），
      // 其余情况统一由 disposeJudgeCard 处理（天妒拿走 / 进弃牌堆）。
      askBeforeJudge(state, undefined, raw, judge.seatId, (finalCard, gainer) => {
        if (!judgeOpts?.keepCard) {
          disposeJudgeCard(state, finalCard, gainer);
          onDone(finalCard, false);
          return;
        }
        // keepCard：调用方要把这张牌派别的用场（收「田」），所以这里别替它决定去哪。
        // ⚠️ 但**天妒抢走了的**必须由这里交给天妒：调用方只收到 canTake=false，
        //    它手上没有这张牌的去处（「已被【天妒】取走」就到此为止）——以前这条分支
        //    就只是告诉调用方「你不能拿」，结果这张牌谁也不管，直接消失（模糊测试的
        //    缺席守望器报出来的：判定牌连续几十个稳定步不在任何区域）。
        if (gainer) disposeJudgeCard(state, finalCard, gainer);
        onDone(finalCard, !gainer);
      });
    },
    setPindianRank: (rank) => {
      // 没有 pindianBox 说明不在拼点流程里，静默忽略
      if (pindianBox) pindianBox.rank = rank;
    },
    redirectAttack: (newTargetSeatId) => {
      if (attackBox) attackBox.redirectTo = newTargetSeatId;
    },
    giveEquipTo: (card, toSeatId, after) => {
      const target = getPlayer(state, toSeatId);
      const slot = card.type as (typeof EQUIP_SLOTS)[number];
      if (!target || !target.alive || !EQUIP_SLOTS.includes(slot)) {
        after?.();
        return;
      }
      const old = target.equipment[slot];
      target.equipment[slot] = card;
      const done = (): void => after?.();
      // 旧装备被顶掉 = 目标失去装备区的一张牌（枭姬那类）
      if (old) toDiscard(state, old);
      if (old) fireEquipLost(state, target, old, done);
      else done();
    },
    changeDeputyHero: (seatId, opts) => {
      const owner = getPlayer(state, seatId);
      if (!owner || !owner.deputyHeroId) return;
      const mainHero = getHeroForMode(owner.heroId, state.mode);
      if (!mainHero) return;
      // 官方：从**未加入游戏的武将牌堆**里连续亮将，直到亮出与主将势力相同者。
      // `opts.preferred`（徐庶·荐才）：势力不是全场唯一大势力时，可以先从**已获知**的那批里挑
      // ——同样得是「尚未登场 + 与主将势力相同」的牌，只是把顺序提前，不是凭空造牌。
      const preferred = (opts?.preferred ?? []).filter((id) => state.heroPool.includes(id));
      // 「与主将势力相同」按**已确定势力**判断（`effectiveFaction`）——双势力主将确定下来之后
      // 要找的是那个势力的牌，而不是印面上的第一个势力。暗置时退回主将的印刷势力。
      const wantFaction = effectiveFaction(state, owner) ?? mainHero.faction;
      let picked: string | null = null;
      const revealed: string[] = [];
      for (const id of preferred) {
        const hero = getHeroForMode(id, state.mode);
        if (hero && hero.faction === wantFaction) {
          state.heroPool.splice(state.heroPool.indexOf(id), 1);
          picked = id;
          break;
        }
      }
      while (!picked && state.heroPool.length > 0) {
        const id = state.heroPool.shift()!;
        const hero = getHeroForMode(id, state.mode);
        revealed.push(hero?.name ?? id);
        if (hero && hero.faction === wantFaction) {
          picked = id;
          break;
        }
      }
      pushLog(
        state,
        'skill',
        `${owner.name} 变更副将：连续亮出 ${revealed.join('、')}。`,
        { seat: owner.seatId, action: 'skill' },
      );
      if (!picked) {
        pushLog(state, 'skill', `武将牌堆已空，${owner.name} 的副将维持不变。`);
        return;
      }
      const oldId = owner.deputyHeroId;
      owner.deputyHeroId = picked;
      // 新副将入场是**暗置**的（要重新明置）
      owner.deputyRevealed = false;
      // ⚠️ **不重算体力上限**——官方「变更」规则：变更副将不会重新改变角色已经确定的体力上限。
      //    （原来这里按新副将重算，而且漏了 `deputySlotHalfYang`：严白虎/徐庶那种副将技的
      //     -1 阴阳鱼会在变更后凭空长回来——两个问题一起修掉。变更的新副将也不重走开局组合计算。）
      pushLog(
        state,
        'skill',
        `${owner.name} 的副将变更为【${getHeroForMode(picked, state.mode)?.name ?? picked}】（暗置），原副将【${getHeroForMode(oldId, state.mode)?.name ?? oldId}】离场。`,
        { seat: owner.seatId },
      );
    },
    removeHeroCard: (seatId, heroId) => {
      const owner = getPlayer(state, seatId);
      const hero = owner ? getHeroForMode(heroId, state.mode) : undefined;
      if (!owner || !hero) return;
      if (owner.removedHeroIds.includes(heroId)) return;
      owner.removedHeroIds.push(heroId);
      pushLog(state, 'skill', `${owner.name} 移除了武将牌【${hero.name}】（用士兵牌顶替）。`, {
        seat: owner.seatId,
        action: 'skill',
      });
      // 闺秀那种「移除此武将牌后回复 1 点体力」：由移除这个动作直接结算
      // （牌已经离场，它的技能不可能再作为钩子被收集到）
      if (hero.healOwnerOnRemoval) {
        const healed = healAndTrigger(state, owner, 1);
        pushLog(state, 'skill', `${owner.name} 因【闺秀】回复 ${healed} 点体力。`);
      }
    },
    privateView: (viewerSeatId, title, content, opts) => {
      const viewer = getPlayer(state, viewerSeatId);
      if (!viewer) {
        opts?.after?.();
        return;
      }
      // 内容按座位裁剪（snapshot 只把 viewCards 发给这个座位），日志里不出现内容
      setPending(state, {
        kind: 'viewCards',
        seatId: viewerSeatId,
        title,
        cards: content.cards ? content.cards.slice() : [],
        note: content.note,
        after: opts?.after,
        returnTo: opts?.after ? undefined : opts?.returnTo,
      });
    },
    useShaOn: (sourceSeatId, targetId, card, opts) => {
      const src = getPlayer(state, sourceSeatId);
      const tgt = getPlayer(state, targetId);
      if (!src || !src.alive || !tgt || !tgt.alive) {
        opts?.after?.();
        return;
      }
      // 【丈八蛇矛】式用法：再有 extraCardIds 时，生效的是一张**虚拟**【杀】，
      // 几张材料牌一起进弃牌堆（口径同丈八：颜色按材料算、属性无）。
      const effective =
        opts?.extraCardIds && opts.extraCardIds.length > 0
          ? virtualShaFrom(
              [card, ...opts.extraCardIds.map((id) => src.hand.find((c) => c.id === id)).filter((c): c is Card => !!c)],
              state,
              src,
            )
          : card;
      consumeCard(state, src, effective);
      resolvePlayedSha(
        state,
        src,
        targetId,
        effective,
        'sha',
        {
          kind: opts?.logKind ?? 'skill',
          text: `${src.name} 对 ${tgt.name} 使用了【杀】。`,
        },
        opts?.after,
        { ignoreArmor: opts?.ignoreArmor, skillId: opts?.skillId },
      );
    },
    discardTargetCard: (targetSeatId, cardId, after) => {
      const target = getPlayer(state, targetSeatId);
      const done = after ?? (() => {});
      if (!target) {
        done();
        return;
      }
      // 指定了**手牌**里的某一张就精确弃那张（蒋钦·尚义已经看过对方手牌，
      // 说弃哪张就弃哪张）；否则交给 pickTargetCard：明牌按 id、手牌随机。
      if (cardId && target.hand.some((c) => c.id === cardId)) {
        const c = removeCard(target.hand, cardId);
        if (c) {
          toDiscard(state, c);
          pushLog(state, 'skill', `弃置了 ${target.name} 的【${cardLabel(c)}】。`, {
            seat: target.seatId,
            action: 'discard',
          });
          fireCardDiscarded(state, target, [c], done, opts?.actor ?? targetSeatId);
          return;
        }
      }
      const got = pickTargetCard(state, opts?.actor ?? targetSeatId, target, cardId);
      if (!got) {
        pushLog(state, 'skill', `${target.name} 没有牌可以被弃置。`);
        done();
        return;
      }
      toDiscard(state, got.card);
      pushLog(state, 'skill', `弃置了 ${target.name} 的【${cardLabel(got.card)}】。`, {
        seat: target.seatId,
        action: 'discard',
      });
      if (got.fromEquip) {
        fireEquipLost(state, target, got.card, done);
        return;
      }
      fireCardDiscarded(state, target, [got.card], done, opts?.actor ?? targetSeatId);
    },
    discardCard: (ownerSeatId, card, after, actorSeatId) => {
      const owner = getPlayer(state, ownerSeatId);
      const done = after ?? (() => {});
      if (!owner) {
        done();
        return;
      }
      discardOwnCard(state, owner, card, done, undefined, actorSeatId);
    },
    discardCards: (ownerSeatId, cards, after, actorSeatId) => {
      const owner = getPlayer(state, ownerSeatId);
      const done = after ?? (() => {});
      if (!owner) {
        done();
        return;
      }
      // 「一次弃多张」＝一个动作（里面的装备牌算同一次失去事件）
      discardOwnCards(state, owner, cards, done, actorSeatId);
    },
    swapEquipAreas: (seatA, seatB, after) => {
      const a = getPlayer(state, seatA);
      const b = getPlayer(state, seatB);
      const done = after ?? (() => {});
      if (!a || !b || a.seatId === b.seatId) {
        done();
        return;
      }
      // 先把双方装备区的牌**都收下来**（各自触发「失去装备区里的牌」：枭姬、白银狮子回血…），
      // 再互换着放进对应栏位。不能一张一张地互相塞——那样目标栏位原有的牌会先被顶进弃牌堆，
      // 而那些牌本来是要换过去的。
      const aCards = EQUIP_SLOTS.map((s) => a.equipment[s]).filter((c): c is Card => !!c);
      const bCards = EQUIP_SLOTS.map((s) => b.equipment[s]).filter((c): c is Card => !!c);
      a.equipment = emptyEquipment();
      b.equipment = emptyEquipment();
      // 每一次「失去」是一个事件（旋略那种「一次失去只触发一次」靠它去重）
      fireEquipLostMany(state, a, aCards, () => {
        fireEquipLostMany(state, b, bCards, () => {
          // 互换：A 的牌进 B 的对应栏位，反之亦然（装备牌的 type 就是槽位）
          for (const c of aCards) {
            const slot = EQUIP_SLOTS.find((s) => s === c.type);
            if (slot) b.equipment[slot] = c;
          }
          for (const c of bCards) {
            const slot = EQUIP_SLOTS.find((s) => s === c.type);
            if (slot) a.equipment[slot] = c;
          }
          pushLog(
            state,
            'skill',
            `${a.name} 与 ${b.name} 交换了装备区里的牌。`,
          );
          done();
        });
      });
    },
    /**
     * 拼点。两步选牌都在 makeSkillApi 里串起来——不需要新的 pending 类型，
     * 复用 askPickCards 就够（两边都扣好才亮牌，所以中途用 secret 不公布牌名）。
     */
    pindian: (initiatorId, targetId, onResult) => {
      const init = getPlayer(state, initiatorId);
      const tgt = getPlayer(state, targetId);
      if (!init || !tgt || init.hand.length === 0 || tgt.hand.length === 0) {
        onResult(state, null);
        return;
      }
      askPickCards(
        state,
        initiatorId,
        '【拼点】：选择一张手牌扣置',
        init.hand.slice(),
        1,
        1,
        (st, _p1, first) => {
          const c1 = first[0];
          if (!c1) {
            onResult(st, null);
            return;
          }
          askPickCards(
            st,
            targetId,
            '【拼点】：选择一张手牌扣置',
            tgt.hand.slice(),
            1,
            1,
            (st2, _p2, second) => {
              const c2 = second[0];
              if (!c2) {
                onResult(st2, null);
                return;
              }
              removeCard(init.hand, c1.id);
              removeCard(tgt.hand, c2.id);
              toDiscard(st2, c1, c2);
              pushLog(
                st2,
                'skill',
                `【拼点】：${init.name} 亮出【${cardLabel(c1)}】，${tgt.name} 亮出【${cardLabel(c2)}】。`,
              );
              // 亮牌之后、比大小之前：鹰扬可以改自己的点数
              askPindianRevealed(
                st2,
                [
                  { player: init, card: c1, isInitiator: true },
                  { player: tgt, card: c2, isInitiator: false },
                ],
                ([r1, r2]) => {
                  let winner: string | null = null;
                  if (r1! > r2!) winner = initiatorId;
                  else if (r2! > r1!) winner = targetId;
                  pushLog(
                    st2,
                    'skill',
                    winner
                      ? `【拼点】${winner === initiatorId ? init.name : tgt.name} 赢。`
                      : '【拼点】平点，无人获胜。',
                  );
                  onResult(st2, winner);
                  // 拼点自己的「回到出牌阶段」原来靠最后一次扣牌询问的 returnTo 兜底，
                  // 但鹰扬的 ±3 询问会把这条链**挂起**——一挂起那条兜底就不再生效，
                  // 整条链跑完 pending 会是 null（出牌方卡死）。这里显式补一次。
                  if (st2.pending === null && !st2.gameOver) {
                    resumePlay(st2, st2.seatOrder[st2.turn.seatIndex]!);
                  }
                },
              );
            },
            // 最后一次选完要把控制权还回来，否则 pending 停在 null、出牌方卡死。
            // 拼点都发生在出牌阶段，所以还给当前回合玩家。
            { secret: true, returnTo: st.seatOrder[st.turn.seatIndex] },
          );
        },
        { secret: true },
      );
    },
    castVirtualSha: (sourceSeatId, targetId, opts) => {
      const source = getPlayer(state, sourceSeatId);
      const target = getPlayer(state, targetId);
      if (!source || !source.alive || !target || !target.alive) return;
      // 虚拟牌没有实体，id 用序号保证唯一（不会进任何牌堆）
      const card: Card = {
        id: `virtual-sha-${state.logSeq}`,
        type: 'sha',
        suit: 'spade',
        rank: 0,
        ...(opts?.attribute ? { attribute: opts.attribute } : {}),
        ...(opts?.generatedBy ? { generatedBy: opts.generatedBy } : {}),
      };
      resolvePlayedSha(state, source, targetId, card, 'sha', {
        kind: opts?.logKind ?? 'skill',
        text: `${source.name} 视为对 ${target.name} 使用了一张【杀】。`,
      }, undefined, {
        // 目标级的「不能响应」判定（黄祖·袭射：目标体力值小于黄祖时不能出闪）
        unrespondableTo: opts?.unrespondableTo,
      });
    },
    // 军令：两条入口共用上面那一个 `runArmyOrder`，这里只做「单人 / 名单」的适配
    armyOrder: (initiatorSeatId, executorSeatId, onDone) => {
      runArmyOrder(
        state,
        { initiatorSeatId, executorSeatIds: [executorSeatId], resumeTo },
        (st, executed) => onDone(st, executed.includes(executorSeatId)),
      );
    },
    armyOrderMulti: (initiatorSeatId, executorSeatIds, onDone, opts2) => {
      runArmyOrder(
        state,
        { initiatorSeatId, executorSeatIds, resumeTo, onRefuse: opts2?.onRefuse },
        onDone,
      );
    },
    grantTempSkill: (heroId, skillName, toSeatId) => {
      const target = toSeatId
        ? getPlayer(state, toSeatId)
        : opts?.actor
          ? getPlayer(state, opts.actor)
          : undefined;
      if (!target) return;
      if (
        target.tempGrantedSkills.some((g) => g.heroId === heroId && g.skillName === skillName)
      ) {
        return;
      }
      target.tempGrantedSkills.push({ heroId, skillName });
      pushLog(state, 'skill', `${target.name} 本回合获得了技能【${skillName}】。`, {
        seat: target.seatId,
      });
    },
    grantSkill: (heroId, skillName, toSeatId) => {
      // 默认给技能使用者（姜维·志继给自己）；传了 toSeatId 就给那个人（糜夫人·存嗣给目标）
      const actor = toSeatId
        ? getPlayer(state, toSeatId)
        : opts?.actor
          ? getPlayer(state, opts.actor)
          : undefined;
      if (!actor) return;
      if (actor.grantedSkills.some((g) => g.heroId === heroId && g.skillName === skillName)) {
        return; // 已经有了，别重复挂
      }
      actor.grantedSkills.push({ heroId, skillName });
      pushLog(state, 'skill', `${actor.name} 获得了技能【${skillName}】。`, {
        seat: actor.seatId,
      });
    },
    nullifyNonLockedSkills: (targetSeatId) => {
      const p = getPlayer(state, targetSeatId);
      if (!p) return;
      p.flags.nonLockedSkillsDisabled = true;
      pushLog(state, 'skill', `${p.name} 的非锁定技失效，直到本回合结束。`);
    },
    castVirtualTrick: (sourceSeatId, spec, targetIds) => {
      const source = getPlayer(state, sourceSeatId);
      if (!source || !source.alive) return;
      // 虚拟牌没有实体，id 用序号保证唯一（它不会进任何牌堆）
      const card: Card = {
        id: `virtual-${state.logSeq}-${spec.type}`,
        type: spec.type,
        suit: spec.suit,
        rank: spec.rank ?? 0,
      };
      pushLog(state, 'trick', `${source.name} 视为使用了【${CARD_TYPE_NAME[spec.type]}】。`, {
        seat: source.seatId,
        action: spec.type,
      });
      runHooksPausable(state, 'useCard', source, { card }, () => {
        startTrickResolution(state, source, card, targetIds ?? [], undefined);
      });
    },
    moveFieldCard: (card, toSeatId, after) => {
      const target = getPlayer(state, toSeatId);
      // 找到这张牌此刻在谁的区域里（装备区 4 槽或判定区）
      let owner: Player | null = null;
      let slot: (typeof EQUIP_SLOTS)[number] | 'judge' | null = null;
      for (const p of state.players) {
        for (const s of EQUIP_SLOTS) {
          if (p.equipment[s]?.id === card.id) {
            owner = p;
            slot = s;
          }
        }
        if (p.judgment.some((c) => c.id === card.id)) {
          owner = p;
          slot = 'judge';
        }
      }
      // 牌已经不在场上了：什么也不做
      if (!owner || !slot || !target || !target.alive) {
        after?.();
        return;
      }
      const from: Player = owner;
      if (slot === 'judge') {
        from.judgment = from.judgment.filter((c) => c.id !== card.id);
        target.judgment.push(card);
        pushLog(
          state,
          'skill',
          `${from.name} 判定区的【${cardLabel(card)}】被移到了 ${target.name} 的判定区。`,
        );
        after?.();
        return;
      }
      const equipSlot: (typeof EQUIP_SLOTS)[number] = slot;
      from.equipment[equipSlot] = null;
      // 目标对应栏位已有牌 → 那张进弃牌堆（移动的常规语义）
      const replaced = target.equipment[equipSlot];
      if (replaced) {
        // 与 giveEquipTo 统一：被顶掉的旧装备同样算「失去装备区的牌」
        fireEquipLost(state, target, replaced, () => {});
        toDiscard(state, replaced);
      }
      target.equipment[equipSlot] = card;
      pushLog(
        state,
        'skill',
        `【${EQUIP_NAME[card.equipName ?? ''] ?? cardLabel(card)}】从 ${from.name} 的装备区移到了 ${target.name} 的装备区。`,
      );
      // 原主失去装备区的牌 → 枭姬那类技能
      fireEquipLost(state, from, card, () => after?.());
    },
    endPlayPhase: (seatId) => {
      const p = getPlayer(state, seatId);
      if (!p) return;
      goToDiscardPhase(state, p);
    },
    returnPlayPhase: (seatId) => {
      // 只在**没有询问在挂起**时生效：有询问说明流程还没走完，控制权不该被抢
      if (state.pending !== null || state.gameOver) return;
      resumePlay(state, seatId);
    },
    giveDiscardedTo: (cards, targetSeatId, skillName) => {
      const target = getPlayer(state, targetSeatId);
      if (!target) return;
      const got: string[] = [];
      for (const c of cards) {
        const i = state.discard.findIndex((x) => x.id === c.id);
        if (i < 0) continue;
        state.discard.splice(i, 1);
        target.hand.push(c);
        got.push(cardLabel(c));
      }
      if (got.length > 0) {
        pushLog(state, 'skill', `${target.name} 因【${skillName ?? '礼让'}】获得了 ${got.join('、')}。`, {
          seat: target.seatId,
          action: 'gain',
        });
      }
    },
    swapHands: (seatA, seatB) => {
      const a = getPlayer(state, seatA);
      const b = getPlayer(state, seatB);
      if (!a || !b) return;
      const na = b.hand.slice();
      b.hand = a.hand.slice();
      a.hand = na;
      pushLog(state, 'skill', `${a.name} 与 ${b.name} 交换了所有手牌（【缔盟】）。`);
    },
    chainPlayers: (seatIds, chained) => {
      const changed: string[] = [];
      for (const sid of seatIds) {
        const p = getPlayer(state, sid);
        if (!p || !p.alive || p.chained === chained) continue;
        // 明光铠：小势力角色不会被横置（重置不受影响）
        if (chained && immuneToChaining(state, p)) continue;
        p.chained = chained;
        changed.push(p.name);
      }
      if (changed.length > 0) {
        pushLog(state, 'chained', `${changed.join('、')} ${chained ? '被横置' : '被重置'}。`);
      }
    },
    transferCard: (fromSeatId, card, toSeatId, after) => {
      const from = getPlayer(state, fromSeatId);
      const to = getPlayer(state, toSeatId);
      const done = after ?? (() => {});
      if (!from || !to) {
        done();
        return;
      }
      const eq = from.equipment;
      for (const slot of EQUIP_SLOTS) {
        if (eq[slot]?.id === card.id) {
          // 吴景·风扬：异势力角色不能**获得**同队列吴景队友的装备牌
          if (fengyangBlocksEquip(state, opts?.actor ?? toSeatId, from, card)) {
            done();
            return;
          }
          eq[slot] = null;
          to.hand.push(card);
          // 失去装备要触发枭姬那类技能，所以不能直接 splice
          fireEquipLost(state, from, card, done);
          return;
        }
      }
      // 判定区（延时锦囊）：也要从原处**摘掉**再放手里。
      // ⚠️ 以前这里没有这一支，于是「获得其装备/判定区一张牌」那类技能（马谡·制蛮、
      //    反馈…）拿走判定区的【闪电】之后，牌**同时在**新主人手里和原主人的判定区
      //    ——模糊测试抓到的重复牌就是这么来的（一张牌同时存在于两个区域）。
      const ji = from.judgment.findIndex((c) => c.id === card.id);
      if (ji >= 0) {
        from.judgment.splice(ji, 1);
        to.hand.push(card);
        pushLog(state, 'skill', `${from.name} 判定区的【${cardLabel(card)}】被 ${to.name} 获得。`, {
          seat: to.seatId,
          action: 'gain',
        });
        done();
        return;
      }
      // ⚠️ 询问是**跨步**的：选牌时这张牌还在，回答时可能已被别的效果搬走/弃掉。
      //    取不到就不能往目标手里再推一份（否则同一张牌同时在两个区域——模糊测试抓过这类）。
      //    这里是所有「获得他人一张牌」技能的公共落点（反馈/恩怨/授锋/制蛮/伪帝/附敌/问计/眩惑…）。
      if (!removeCard(from.hand, card.id)) {
        done();
        return;
      }
      to.hand.push(card);
      done();
    },
    dealDamage: (target, damage, sourceId, attribute, after) => {
      const attack: AttackContext = {
        sourceId,
        cardId: '',
        asType: 'sha',
        targetId: target.seatId,
        damage,
        dodged: false,
        attribute,
      };
      damageStep(state, target, attack, damage, (dmg, prevented) => {
        if (!prevented) {
          pushLog(
            state,
            'damage',
            `${target.name} 受到 ${dmg} 点伤害，剩余 ${Math.max(0, target.hp)} 体力。`,
          );
        }
        if (prevented) {
          after?.();
          if (resumeTo) resumePlay(state, resumeTo);
          return;
        }
        runDamagedHooks(state, target, attack, dmg, () => {
          // after 跑完之后：只有**没留下 pending** 才把出牌阶段还回去。
          // 否则 after 里的询问会被 resumePlay 直接覆盖掉（凶算就是这样：
          // 它要在伤害结算后问「重置哪个限定技」）。
          const tail = (): void => {
            after?.();
            if (state.pending === null && resumeTo) resumePlay(state, resumeTo);
          };
          if (target.hp <= 0) {
            enterNearDeath(state, attack);
            // 进濒死也要接后续（天香就是「先伤害、后摸牌」）：濒死求桃走的是
            // 续接队列，after 里的步骤会排在它后面。
            after?.();
            return;
          }
          tail();
        });
      });
    },
    heal: (target, amount) => healAndTrigger(state, target, amount),
    handLimit: (seatId) => {
      const p = getPlayer(state, seatId);
      return p ? handLimit(state, p) : 0;
    },
    kill: (seatId, reason) => {
      const victim = getPlayer(state, seatId);
      if (!victim || !victim.alive) return;
      pushLog(state, 'skill', `${victim.name} 因【${reason ?? '技能'}】死亡。`, {
        seat: seatId,
      });
      doDeath(state, seatId);
    },
    loseEquip: (seatId, card, after) => {
      const owner = getPlayer(state, seatId);
      const done = after ?? (() => {});
      const slot = EQUIP_SLOTS.find((sl) => owner?.equipment[sl]?.id === card.id);
      if (!owner || !slot) {
        done();
        return;
      }
      owner.equipment[slot] = null;
      fireEquipLost(state, owner, card, done);
    },
    loseHp: (target, amount, after) => {
      // 失去体力不是伤害 → 清掉「最近一次伤害」的记录，免得陈旧值被当成致死原因
      state.lastDamageSourceId = '';
      state.lastDamageGeneratedBy = null;
      target.hp -= amount;
      pushLog(
        state,
        'damage',
        `${target.name} 失去 ${amount} 点体力，剩余 ${Math.max(0, target.hp)} 体力。`,
      );
      if (target.hp <= 0) {
        enterNearDeath(state, {
          sourceId: target.seatId,
          cardId: '',
          asType: 'sha',
          targetId: target.seatId,
          damage: amount,
          dodged: false,
        });
      }
      after?.();
    },
    changeMaxHp: (target, delta) => {
      const before = target.maxHp;
      target.maxHp = Math.max(0, target.maxHp + delta);
      // 上限变小 → 当前体力夹到新上限
      if (target.hp > target.maxHp) target.hp = target.maxHp;
      pushLog(
        state,
        'skill',
        `${target.name} 的体力上限 ${delta >= 0 ? '+' : ''}${target.maxHp - before}（现为 ${target.maxHp}）。`,
      );
      if (target.hp <= 0 && target.alive) {
        enterNearDeath(state, {
          sourceId: target.seatId,
          cardId: '',
          asType: 'sha',
          targetId: target.seatId,
          damage: 0,
          dodged: false,
        });
      }
    },
  };
}

/** 主动技能：出牌阶段使用武将主动技能 */
function onUseSkill(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'useSkill' }>,
): ApplyResult {
  const pending = state.pending!;
  if (pending.kind !== 'play' || pending.seatId !== seatId) return err('不是你的出牌阶段');
  const player = getPlayerOrThrow(state, seatId);
  // 查找顺序：已明置武将的主动技 → 暗置武将的主动技（点了就等于明置+发动）
  //            → 标记带来的技能（标记不属于任何武将）
  let skill: ActiveSkill | undefined;
  for (const hero of activeHeroes(state, player)) {
    skill = hero.activeSkills?.find((s) => s.id === intent.skillId);
    if (skill) break;
  }
  // 暗置武将的主动技：国战规则「发动技能时必须明置该武将」，所以点了就直接明置，
  // 不再多问一次（点击本身就是玩家的决定）。
  if (!skill) {
    for (const hero of unrevealedHeroes(state.mode, player)) {
      const found = hero.activeSkills?.find((s) => s.id === intent.skillId);
      if (!found) continue;
      skill = found;
      revealHeroCard(state, player, hero);
      break;
    }
  }
  if (!skill) skill = markerActiveSkills(state, player).find((s) => s.id === intent.skillId);
  // 「同势力君主授予的技能」（君孙权·督授）：和标记技能一样，不属于使用者自己的武将牌
  if (!skill) {
    skill = factionGrantedActiveSkills(state, player).find((s) => s.id === intent.skillId);
  }
  // 装备牌带来的主动技（【木牛流马】）
  if (!skill) skill = equipActiveSkills(state, player).find((s) => s.id === intent.skillId);
  // 别人的势力技（黄天：群势力角色把【闪】/【闪电】交给明置的张角）
  if (!skill) skill = huangtianFor(state, player).find((s) => s.id === intent.skillId);
  // 别人的反向技（眩惑：同势力角色交给明置的法正一张手牌，换一个临时技能）
  if (!skill) skill = xuanhuoFor(state, player).find((s) => s.id === intent.skillId);
  if (!skill) return err('你没有这个技能');
  // 检查可用性
  if (!skill.canUse(state, player)) return err('该技能当前不可使用');
  // 限 1 次/回合
  if (skill.oncePerTurn && player.flags.skillUsedThisTurn[skill.id])
    return err('该技能本回合已使用');
  // 「每个出牌阶段限 N 次」（界钟会·排异）
  if (skill.perPhaseLimit && (player.flags.skillUsesThisPhase[skill.id] ?? 0) >= skill.perPhaseLimit)
    return err(`该技能本阶段已使用 ${skill.perPhaseLimit} 次`);
  if (skill.oncePerGame && player.usedOncePerGame[skill.id]) return err('该限定技本局已使用');
  // 目标数校验
  if (intent.targetIds.length < skill.minTargets || intent.targetIds.length > skill.maxTargets)
    return err(`目标数量不符（需 ${skill.minTargets}-${skill.maxTargets}）`);
  // 弃牌校验
  if (skill.needsCards) {
    if (!intent.cardIds || intent.cardIds.length === 0) return err('该技能需要弃牌');
    for (const id of intent.cardIds) {
      if (!player.hand.some((c) => c.id === id)) return err('弃的牌不在手中');
    }
  }
  // 标记已使用（执行前标记，防重入）
  if (skill.oncePerTurn) player.flags.skillUsedThisTurn[skill.id] = true;
  if (skill.perPhaseLimit)
    player.flags.skillUsesThisPhase[skill.id] = (player.flags.skillUsesThisPhase[skill.id] ?? 0) + 1;
  if (skill.oncePerGame) player.usedOncePerGame[skill.id] = true;
  // 注入引擎内部 API（避免 heroes→engine 循环依赖）
  const api = makeSkillApi(state, { resumeTo: player.seatId, actor: player.seatId });
  // 执行
  const result = skill.execute(state, player, intent, api);
  if (typeof result === 'string') {
    // 执行失败：回滚标记
    if (skill.oncePerTurn) player.flags.skillUsedThisTurn[skill.id] = false;
    if (skill.perPhaseLimit)
      player.flags.skillUsesThisPhase[skill.id] = Math.max(
        0,
        (player.flags.skillUsesThisPhase[skill.id] ?? 1) - 1,
      );
    if (skill.oncePerGame) player.usedOncePerGame[skill.id] = false;
    return err(result);
  }
  // 兜底：技能跑完如果什么 pending 都没留下（比如「这一项做不到，就此结束」那种分支），
  // 就把出牌阶段还给他——不然 pending 会一直是 null，界面直接卡住。
  // 正常情况（留下询问、或询问里传了 returnTo）这里不会触发。
  if (state.pending === null && !state.gameOver) {
    setPending(state, { kind: 'play', seatId: player.seatId });
  }
  return { ok: true };
}

// ——————————————————————————————————————————
// 建局
// ——————————————————————————————————————————

const DEFAULT_HERO_DEAL_COUNT = 3;

// 军争标准身份表（5-8 人）
const JUNZHENG_ROLES: Record<number, RoleId[]> = {
  5: ['lord', 'loyal', 'rebel', 'rebel', 'renegade'],
  6: ['lord', 'loyal', 'rebel', 'rebel', 'rebel', 'renegade'],
  7: ['lord', 'loyal', 'loyal', 'rebel', 'rebel', 'rebel', 'renegade'],
  8: ['lord', 'loyal', 'loyal', 'rebel', 'rebel', 'rebel', 'rebel', 'renegade'],
};

export function createGame(
  seats: SeatSetup[],
  roomCode: string,
  opts?: {
    mode?: GameMode;
    heroDealCount?: number;
    /**
     * 国战扩展开关（见 `config.ts` 与 docs/guozhan-roster.md §5.77）。
     *
     * 不传时按「**全开**」处理（`shibei: 'current'` / `buchen: 'current'` /
     * `junlintianxia: '2026'`），也就是历史行为不变——**「默认标准国战」是房间层的默认值**
     * （`DEFAULT_GUOZHAN_PRESET`，由服务端建房时传进来），引擎自己不替产品定默认，
     * 这样既有的测试与随机测试的覆盖面也不会因为加开关而缩水。
     */
    config?: GuozhanRoomConfig;
    /**
     * @deprecated 旧的布尔写法（势备篇开/关）。保留兼容：等价于
     * `config.extensions.shibei = 'current' | 'off'`。新代码请用 `config`。
     */
    shibei?: boolean;
    /**
     * 测试用：选将阶段不限发将，每个人都能看到全部武将。
     * 实现上就是把 deals 填成整个武将池——发将校验、国战的
     * 「两名同阵营」等规则都照旧走，所以测出来的行为与真实一致。
     */
    freePick?: boolean;
    /**
     * 洗牌用的随机源（缺省 `Math.random`）。
     *
     * 测试要**可复现**就必须传它——否则只有「玩家决策」是固定种子的，
     * 牌序仍然随运行顺序变，同一颗种子会跑出不同结果（随机冒烟测试踩过这个坑）。
     */
    rng?: () => number;
  },
): GameState {
  const mode: GameMode = opts?.mode ?? 'melee';
  const isGuozhan = mode === 'guozhan';
  const k = isGuozhan
    ? 7
    : Math.max(1, Math.min(5, opts?.heroDealCount ?? DEFAULT_HERO_DEAL_COUNT));
  const n = seats.length;

  const players: Player[] = seats.map((s) => ({
    seatId: s.seatId,
    name: s.name,
    heroId: null, // 选将阶段未定
    deputyHeroId: null, // 副将（国战），非国战为 null
    hp: 0,
    maxHp: 0,
    hand: [],
    equipment: emptyEquipment(),
    judgment: [],
    alive: true,
    flags: emptyFlags(),
    role: null,
    team: null,
    heroRevealed: !isGuozhan, // 非国战恒 true，国战开局暗置
    deputyRevealed: !isGuozhan,
    faction: null,
    markers: emptyMarkers(),
    flipped: false,
    chained: false,
    usedOncePerGame: {},
    prelitSkills: [],
    knownHeroIds: [],
    removedHeroIds: [],
    tempGrantedSkills: [],
    tian: [],
    qianhuan: [],
    hun: [],
    han: [],
    yi: [],
    lu: [],
    quan: [],
    congchaWatchedBy: [],
    nullifiedHeroId: null,
    wounds: [],
    grantedSkills: [],
  }));
  const seatOrder = seats.map((s) => s.seatId);

  // 按模式分配身份/队伍
  if (mode === '2v2') {
    // A B A B 座次：1,3→team0；2,4→team1
    players.forEach((p, i) => {
      p.team = i % 2 === 0 ? 0 : 1;
    });
  } else if (mode === 'junzheng') {
    const roleTable = JUNZHENG_ROLES[n];
    if (!roleTable) throw new Error(`军争模式需 5-8 人，当前 ${n} 人`);
    const roles = shuffle([...roleTable], opts?.rng);
    players.forEach((p, i) => {
      p.role = roles[i]!;
    });
  }

  // 随机发将：武将池洗牌一次后按座次不重叠发牌，
  // 避免多个玩家拿到同一名武将。池子发完则重洗剩余部分兜底。
  // 池子先按模式筛（国战专属武将不带进军争/混战），国战再排除中立武将；
  // 每人需拿到 ≥2 名同阵营武将才能选将，k=7 时按鸽巢原理在 ≤4 个阵营中必有 ≥2 同阵营，恒可满足。
  // 扩展开关的归一化：没传 config 时全开（历史行为）；旧的 `shibei: boolean` 兼容
  const ext: GuozhanExtensions = isGuozhan
    ? {
        shibei: opts?.config?.extensions.shibei ?? (opts?.shibei ? 'current' : opts?.shibei === false ? 'off' : 'current'),
        buchen: opts?.config?.extensions.buchen ?? 'current',
        junlintianxia: opts?.config?.extensions.junlintianxia ?? '2026',
        zhen: opts?.config?.extensions.zhen ?? 'current',
        shi: opts?.config?.extensions.shi ?? 'current',
        bian: opts?.config?.extensions.bian ?? 'current',
        quan: opts?.config?.extensions.quan ?? 'current',
      }
    : { shibei: 'off', buchen: 'off', junlintianxia: 'off', zhen: 'off', shi: 'off', bian: 'off', quan: 'off' };
  // 选将池：先按模式筛，再交给各扩展模块调整（君主将进不进池由君临天下扩展决定）
  // 见 extensions.ts——**不要在引擎里撒 `if (ext.xxx)`**（用户给定的架构）
  const poolHeroes = applyPoolExtensions(
    poolForMode(mode).filter((h) => !isGuozhan || h.faction !== 'neutral'),
    ext,
  );
  const allIds = poolHeroes.map((h) => h.id);
  const deals: Record<string, string[]> = {};
  if (opts?.freePick) {
    // 测试用：每人拿到的「可选项」就是整个池子，想选谁选谁
    for (const s of seats) deals[s.seatId] = allIds.slice();
  } else {
    const heroIds = shuffle(allIds, opts?.rng);
    let cursor = 0;
    for (const s of seats) {
      if (cursor + k > heroIds.length) {
        cursor = 0; // 池子不足（人太多）→ 从头复用，仅此时才可能出现重复
      }
      deals[s.seatId] = heroIds.slice(cursor, cursor + k);
      cursor += k;
    }
  }

  const state: GameState = {
    roomCode,
    mode,
    players,
    seatOrder,
    // 牌堆：基础堆（按模式）→ 各扩展模块追加自己的牌（势备篇 +52）
    deck: shuffle(applyDeckExtensions(buildDeck(mode), ext), opts?.rng),
    discard: [],
    turn: { seatIndex: 0, phase: 'draft' },
    pending: null,
    draft: { deals, pendingSeats: seatOrder.slice() },
    started: true,
    gameOver: false,
    winner: null,
    log: [],
    logSeq: 0,
    ongoingTrick: null,
    ongoingChain: null,
    damagedThisTurn: [],
    killedThisTurn: [],
    gainedFromDeckThisTurn: [],
    deckGainOwner: {},
    extraResolvedCards: [],
    jiliVirtualSeq: 0,
    round: 1,
    damageLedgerThisTurn: [],
    liangfanHanIds: [],
    midaoUsedSeats: [],
    damagedThisPhase: [],
    suzhiTriggers: 0,
    xiongnue: null,
    xiongnueDefense: false,
    discardPhaseCountsThisTurn: {},
    turnDiscards: [],
    xisheKilledSeat: null,
    lastDamageSourceId: '',
    lastDamageGeneratedBy: null,
    duwuWatchSeat: null,
    duwuRescued: false,
    pendingSeq: 0,
    pendingWaiters: [],
    cardUseSeq: 0,
    useDamages: [],
    handDiscardedInDiscardPhase: [],
    juejueArmed: false,
    ongoingSkillChain: [],
    equipLossSeq: 0,
    rng: opts?.rng ?? Math.random,
    heroPool: [],
    discardThisTurn: [],
    xianquSeat: null,
    resumeQueue: [],
    judgmentInFlight: null,
    damageThisRound: {},
    xiongchiDoneSeats: [],
    lordEquipSeq: 0,
    firstDamageCard: null,
    markerUsesThisTurn: [],
    extraTurns: [],
  };
  pushLog(state, 'start', '游戏开始，随机发将。');
  return state;
}

// ——————————————————————————————————————————
// 选将阶段
// ——————————————————————————————————————————

function onPickHero(state: GameState, seatId: string, intent: Intent): ApplyResult {
  if (intent.type !== 'pickHero') return err('选将阶段：请选择武将');
  const draft = state.draft;
  if (!draft) return err('当前不在选将阶段');
  if (!draft.pendingSeats.includes(seatId)) return err('你已经选过将了');
  // 「发到了曹操就等于也拿到了君曹操，反之亦然」——但只在**那张牌没发到别人手里**时成立，
  // 否则同一张武将牌会落到两个人身上（见 heroes.ts 的 draftOptionsFor）
  if (!draft.deals[seatId]) return err('当前不在选将阶段');
  if (!draftAllowsHero(state, seatId, intent.heroId)) return err('该武将不在你发到的将中');
  const player = getPlayerOrThrow(state, seatId);

  if (state.mode === 'guozhan') {
    const deputyId = intent.deputyHeroId;
    if (!deputyId) return err('国战需选 2 位武将（主将 + 副将）');
    if (!draftAllowsHero(state, seatId, deputyId)) return err('副将不在你发到的将中');
    if (deputyId === intent.heroId) return err('主将与副将不能相同');
    // 同一武将的两个版本也不能同场（曹操 + 君曹操、将来的界曹操 + 曹操…）——用户给定口径：
    // 它们共享同一个武将本体，记在 Hero.canonicalId 上，不按名字硬编码
    if (sameHeroBody(intent.heroId, deputyId)) {
      return err('主将与副将不能是同一个武将的不同版本');
    }
    // ⚠️ 待核对：君主版与它的标准版能不能同时当主副将（【君曹操】+【曹操】）——官方没写明，
    //    本仓库**不猜**，因此不拦（原先我按「君主替换同名标准武将」推了一条禁令，发现既没有
    //    出处又挡掉了几条既有用例，已撤）。只守住有依据的那条：一张武将牌不能落到两个人手里。
    const mainHero = getHero(intent.heroId);
    const deputyHero = getHero(deputyId);
    if (!mainHero || !deputyHero) return err('武将不存在');
    // 同阵营校验：双势力武将牌有两面，只要**有共同势力**就算同阵营（2023 口径）
    const pairOk = [mainHero.faction, mainHero.secondFaction]
      .filter(Boolean)
      .some((f) => f === deputyHero.faction || f === deputyHero.secondFaction);
    if (!pairOk) return err('国战需选 2 位同阵营武将');
    if (deputyHero.faction === 'ambitionist') return err('野心家武将只能作为主将');
    // 君主将只能作主将
    if (deputyHero.isLord) return err('君主将只能作为主将');
    player.heroId = intent.heroId;
    player.deputyHeroId = deputyId;
    player.faction = mainHero.faction;

    // 双势力：按 2023 规则确定势力（唯一共同势力自动确定；要玩家选的组合见下面直接拒绝）
    const dual = determineDualFaction(mainHero, deputyHero, state.mode);
    if (dual?.kind === 'auto') {
      player.determinedFaction = dual.faction;
      pushLog(
        state,
        'faction',
        `${player.name} 的双势力武将确定为${FACTION_NAME[dual.faction] ?? dual.faction}。`,
        { seat: player.seatId },
      );
    } else if (dual?.kind === 'choice') {
      // 「两个共同势力」或「与野心家武将组合」要玩家自己选势力，选势力界面还没做。
      // 用户口径：不要拿旧规则补空白 —— 所以直接**拒绝这组搭配**并说明原因。
      return err(
        `【${mainHero.name}】与【${deputyHero.name}】有两个可选势力、需要玩家自己确定，` +
          '选势力界面尚未实现；请换一组搭配',
      );
    }
  } else {
    player.heroId = intent.heroId;
  }

  draft.pendingSeats = draft.pendingSeats.filter((s) => s !== seatId);
  pushLog(state, 'pickHero', `${player.name} 已选定武将。`);
  if (draft.pendingSeats.length === 0) finishDraft(state);
  return { ok: true };
}

/** 全员选完：设定武将体力、发初始手牌、进入第一回合 */
function finishDraft(state: GameState): void {
  for (const p of state.players) {
    if (state.mode === 'guozhan') {
      const main = getHero(p.heroId);
      const deputy = getHero(p.deputyHeroId);
      if (main && deputy) {
        // 官方规则：体力上限 = 两将体力之和 ÷ 2，向下取整。
        // 珠联璧合不再直接加体力上限——它改为在双将首次明置时发一个标记，
        // 见 onHeroRevealed。
        // 主将技若写着「此武将牌减少半个阴阳鱼」（邓艾·急袭、董卓·暴凌），
        // 那张牌贡献的阴阳鱼少 0.5 ——本引擎的体力是阴阳鱼×2 的口径，所以是 -1。
        const mainHp = main.maxHp - (main.mainSlotHalfYang ? 1 : 0);
        // 副将技写着「减少半个阴阳鱼」的（孙策·魂殇）同理，减在副将那半
        const deputyHp = deputy.maxHp - (deputy.deputySlotHalfYang ? 1 : 0);
        p.maxHp = Math.floor((mainHp + deputyHp) / 2);
      } else {
        p.maxHp = main?.maxHp ?? 4;
      }
    } else {
      const hero = getHero(p.heroId) ?? getHero('vanilla')!;
      p.maxHp = hero.maxHp;
      // 军争：主公体力上限 +1
      if (state.mode === 'junzheng' && p.role === 'lord') {
        p.maxHp = hero.maxHp + 1;
      }
    }
    p.hp = p.maxHp;
  }
  // 野心家身份**不在这里判**：官方是「明置武将、确定势力的那一刻」逐个人判定的
  // （谁先亮谁留在势力里，超编的那个是**后亮**的），见 revealHeroCard 里的判定。
  // 旧实现在这里是按座次从后往前把「超编」的人一律判成野心家——既换错了人，
  // 阈值也差一个（用 ceil 而不是「超过一半」）。
  // 变包的「变更副将」要从未加入游戏的武将牌堆里连续亮将——在这里先把剩下的存下来
  {
    const dealt = new Set<string>();
    const deals = state.draft?.deals ?? {};
    for (const list of Object.values(deals)) for (const id of list as string[]) dealt.add(id);
    state.heroPool = poolForMode('guozhan')
      .map((h) => h.id)
      .filter((id) => !dealt.has(id));
  }
  state.draft = null;
  // 初始手牌：每人 4 张（首回合玩家随后再摸 2，见 startTurn）
  for (const p of state.players) {
    for (let i = 0; i < 4; i++) {
      const c = drawOne(state);
      if (c) p.hand.push(c);
    }
  }
  pushLog(state, 'deal', '选将结束，发放初始手牌。');
  // 军争：主公先手；其余模式：座次 0 先手
  let firstSeat = 0;
  if (state.mode === 'junzheng') {
    const lord = state.players.find((p) => p.role === 'lord');
    if (lord) firstSeat = state.seatOrder.indexOf(lord.seatId);
  }
  startTurn(state, firstSeat);
}
