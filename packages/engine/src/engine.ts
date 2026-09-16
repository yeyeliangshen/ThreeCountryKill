import type { Card, CardType, Faction, GameMode, Intent, RoleId, TrickType } from '@sgs/protocol';
import {
  CARD_TYPE_NAME,
  EQUIP_NAME,
  cardLabel,
  isDelayedTrick,
  isEquipCard,
  isInstantTrick,
  isBasicCard,
  isRecastable,
  isRed,
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
import { canTarget, distance } from './distance';
import {
  applyQixingSweep,
  armorNullifiesSha,
  damageBonus,
  tengjiaNullifiesAoe,
  tryBaguaDodge,
} from './equip';
import { buildDeck, drawOne, shuffle } from './deck';
import { addMarker, consumeMarker, markerActiveSkills, markerCount } from './markers';
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
  heroIgnoresTrickDistance,
  heroShaLimit,
  EQUIP_SLOTS,
  isMalePlayer,
  skillNameForField,
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
export function askChoice(
  state: GameState,
  seatId: string,
  title: string,
  options: { id: string; label: string }[],
  resolve: (state: GameState, player: Player, optionId: string) => void,
  returnTo?: string,
): void {
  state.pending = { kind: 'choice', seatId, title, options, resolve, returnTo };
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
  state.pending = {
    kind: 'pickCards',
    seatId,
    title,
    cards,
    min,
    max,
    resolve,
    returnTo: opts?.returnTo,
    secret: opts?.secret,
  };
}

/**
 * 手牌上限：默认 = 当前体力；技能可以覆盖（周瑜·英姿 = 体力上限）。
 * 多个武将给出上限时取最宽松的那个，最后再加上本回合的标记加成（阴阳鱼）。
 */
function handLimit(state: GameState, player: Player): number {
  const heroes = revealedHeroes(state.mode, player);
  const base =
    heroes.length === 0
      ? Math.max(0, player.hp)
      : Math.max(0, ...heroes.map((h) => (h.handLimit ? h.handLimit(state, player) : player.hp)));
  return base + player.flags.handLimitBonus;
}

function removeCard(hand: import('@sgs/protocol').Card[], id: string) {
  const i = hand.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const [c] = hand.splice(i, 1);
  return c ?? null;
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
  const factions = new Set(alive.map((p) => p.faction).filter((f) => f && f !== 'ambitionist'));
  return factions.size === 2;
}

/**
 * 国战：每张武将牌「明置」之后的一次性结算。
 *
 * 必须在亮将的两条路径上显式调用（主动亮将 onRevealHero、被动亮将 passiveReveal）。
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

/** 国战被动亮将：成为目标或濒死前自动亮将（使技能生效） */
function passiveReveal(state: GameState, player: Player): void {
  if (state.mode !== 'guozhan') return;
  let revealed = false;
  if (!player.heroRevealed && player.heroId) {
    player.heroRevealed = true;
    revealed = true;
    const hero = getHero(player.heroId);
    if (hero) pushLog(state, 'reveal', `${player.name} 被动亮将：${hero.name}。`);
  }
  if (!player.deputyRevealed && player.deputyHeroId) {
    player.deputyRevealed = true;
    revealed = true;
    const hero = getHero(player.deputyHeroId);
    if (hero) pushLog(state, 'reveal', `${player.name} 被动亮将：${hero.name}。`);
  }
  if (revealed) onHeroRevealed(state, player);
}

/** 检查玩家是否可将 card 当 type 使用（含鏖战桃当杀） */
export function canUseAsCard(
  state: GameState,
  player: Player,
  card: Card,
  type: CardType,
): boolean {
  const heroes = activeHeroes(state, player);
  if (heroes.some((h) => heroCanUseAs(h, card, type))) return true;
  if (isAoyu(state) && type === 'sha' && card.type === 'tao') return true;
  return false;
}

/**
 * 登记「本回合受到过伤害的角色」（董昭·劝进要用）。
 *
 * 放在钩子分发的入口上，而不是每个伤害点——伤害点有七八处，逐处加必然漏。
 * ⚠️ 两个入口都要调：runHooks 与 runHooksFrom（可挂起的那条路）——
 *    伤害路径大多走后者，只挂在前面会漏掉绝大多数伤害。
 */
function markDamaged(state: GameState, timing: Timing, player: Player, payload?: unknown): void {
  if (timing !== 'afterDamage') return;
  const dmg = (payload as { damage?: number } | undefined)?.damage ?? 0;
  if (dmg > 0 && !state.damagedThisTurn.includes(player.seatId)) {
    state.damagedThisTurn.push(player.seatId);
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
  player.flags.usedCardsInPlayPhase.push({
    suit: card.suit,
    color: isRed(card) ? 'red' : 'black',
    kind,
  });
}

// 在某时机运行玩家已激活武将的触发钩子。返回 false 表示被取消。
function runHooks(state: GameState, timing: Timing, player: Player, payload?: unknown): boolean {
  markDamaged(state, timing, player, payload);
  markCardUsed(state, timing, player, payload);
  const heroes = activeHeroes(state, player);
  const hooks = heroes.flatMap((hero) => hero.hooks?.filter((h) => h.timing === timing) ?? []);
  hooks.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const ctx: HookContext = { state, player, timing, payload, api: makeSkillApi(state) };
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
// 已转换的时机（新增时记得同步这里和 docs/guozhan-roster.md）：
//   afterDamage / afterDamageDealt / becomeTarget
// 尚未转换：turnStart / judgePhase / beforeJudge / drawPhase / turnEnd / useCard / nearDeath

/** 把「被询问打断的后续」压进队列；等 pending 空了由 drainResume 执行 */
function pushResume(state: GameState, fn: () => void): void {
  state.resumeQueue.push(fn);
}

/**
 * 排空续接队列。只在**每个 intent 处理完之后**调用一处，别散着调——
 * 它是「询问 → 续接」这条控制流的唯一收口。
 *
 * 循环条件带 `pending === null`：续接里如果又产生了新流程（濒死、下一次判定），
 * 就停下等那串流程走完，之后回到这里继续。
 */
function drainResume(state: GameState): void {
  // 兜底：续接互相触发形成死循环时别把进程挂死
  let guard = 0;
  while (state.pending === null && state.resumeQueue.length > 0 && !state.gameOver) {
    if (++guard > 100) {
      pushLog(state, 'system', '续接队列超过 100 次，可能存在死循环，已中止。');
      state.resumeQueue.length = 0;
      break;
    }
    const fn = state.resumeQueue.shift()!;
    fn();
  }
}

/**
 * 回复体力 + 触发「回复体力后」的技能（甘夫人·淑慎）。
 *
 * **所有**回复体力的地方都要走这里（含技能里的 `api.heal`），否则淑慎会漏触发。
 * 只有实回量 > 0 才跑钩子：满体力时「回复」没发生，就不该触发。
 */
function healAndTrigger(state: GameState, player: Player, amount: number): number {
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
  const heroes = activeHeroes(state, player);
  const hooks = heroes.flatMap((hero) => hero.hooks?.filter((h) => h.timing === timing) ?? []);
  hooks.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  // 钩子发起的询问会**覆盖**掉当时的环境 pending（比如出牌阶段的 {kind:'play'}）。
  // 记下它：等整条钩子链跑完，如果调用方没有产生新的 pending，就把它还回去——
  // 否则出牌阶段的牌一打完（例如装装备触发枭姬）pending 就成了 null，玩家卡死。
  const ambient = state.pending;
  runHooksFrom(
    state,
    player,
    timing,
    payload,
    hooks,
    0,
    (cancelled) => {
      onDone(cancelled);
      if (state.pending === null && ambient && !state.gameOver) {
        state.pending = ambient;
      }
    },
    attackBox,
  );
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
): void {
  markDamaged(state, timing, player, payload);
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
    if (state.pending?.kind === 'choice' || state.pending?.kind === 'pickCards') {
      pushResume(state, () =>
        runHooksFrom(state, player, timing, payload, hooks, k + 1, onDone, attackBox),
      );
      return;
    }
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
  runHooksPausable(state, 'afterDamageDealt', src, { attack, damage }, after);
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
  // 整条回合流程都用可挂起钩子串起来：准备阶段的洛神/观星、判定阶段的鬼才
  // 都可能发起询问，问到一半不能把后面的阶段丢了。
  runHooksPausable(state, 'turnStart', player, undefined, () => {
    startJudgmentPhase(state, player);
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
    processJudgmentPhase(state, player);
  });
}

/** 判定阶段结束：闪电伤害可能导致濒死，否则继续到摸牌阶段 */
function afterJudgmentPhase(state: GameState, player: Player): void {
  if (player.hp <= 0) {
    enterNearDeath(state, {
      sourceId: player.seatId,
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
    const extra = heroes.length ? Math.max(0, ...heroes.map((h) => h.extraDraw ?? 0)) : 0;
    // 阶段钩子可以改张数（裸衣/突袭的「少摸一张」= drawCountDelta -1）
    const count = Math.max(0, 2 + extra + player.flags.drawCountDelta);
    for (let i = 0; i < count; i++) {
      const c = drawOne(state);
      if (c) player.hand.push(c);
    }
    pushLog(state, 'draw', `${player.name} 摸了 ${count} 张牌。`);
  } else {
    pushLog(state, 'draw', `${player.name} 被【兵粮寸断】影响，跳过摸牌阶段。`);
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
    runHooksPausable(state, 'playPhase', player, undefined, () => {
      state.pending = { kind: 'play', seatId: player.seatId };
    });
  } else {
    pushLog(state, 'lebu', `${player.name} 被【乐不思蜀】影响，跳过出牌阶段。`);
    goToDiscardPhase(state, player);
  }
}

/** 进入弃牌阶段：检查手牌上限 */
function goToDiscardPhase(state: GameState, player: Player): void {
  state.turn.phase = 'discard';
  runHooks(state, 'discardPhase', player);
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
    state.pending = { kind: 'discard', seatId: player.seatId, count: over };
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
function runDiscardPhaseEnd(state: GameState, player: Player): void {
  runHooksPausable(state, 'discardPhaseEnd', player, {}, () => endTurn(state));
}

/** 判定阶段：逐张处理判定区延时锦囊 */
function processJudgmentPhase(state: GameState, player: Player): void {
  const judgments = player.judgment.slice();
  player.judgment = [];
  judgmentStep(state, player, judgments, 0);
}

/** 逐张判定。beforeJudge 里可能挂起询问（鬼才/鬼道），所以用下标往下递 */
function judgmentStep(state: GameState, player: Player, judgments: Card[], index: number): void {
  if (index >= judgments.length) {
    afterJudgmentPhase(state, player);
    return;
  }
  const trick = judgments[index]!;
  const judgeCard = drawOne(state);
  if (!judgeCard) {
    // 牌堆耗尽：剩下的判定牌直接进弃牌堆，判定阶段就此结束
    for (let k = index; k < judgments.length; k++) toDiscard(state, judgments[k]!);
    afterJudgmentPhase(state, player);
    return;
  }
  pushLog(
    state,
    'judge',
    `${player.name} 判定：${cardLabel(judgeCard)}（${CARD_TYPE_NAME[trick.type]}）。`,
  );
  askBeforeJudge(state, trick, judgeCard, player.seatId, (finalCard, gainer) => {
    resolveJudgment(state, player, trick, finalCard, gainer);
    judgmentStep(state, player, judgments, index + 1);
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
  trick: Card,
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
  judgeHookStep(state, list, 0, trick, judgeCard, judgedId, undefined, onDone);
}
/**
 * 判定过程中钩子可以写入的决定。
 * 同步返还的用 HookResult（replaceCard / gainJudgeCard）；
 * 需要先询问再决定的走这里——钩子在询问的回调里写，引擎接着读。
 */
interface JudgeBox {
  replacement?: Card;
  gainer?: Player;
}

/** 成为【杀】目标时钩子可以写入的决定（流离那类改目标） */
interface AttackBox {
  redirectTo?: string;
}

function judgeHookStep(
  state: GameState,
  list: { player: Player; hook: HookRegistration }[],
  k: number,
  trick: Card,
  cur: Card,
  judgedId: string,
  gainer: Player | undefined,
  onDone: (finalCard: Card, gainer: Player | undefined) => void,
): void {
  if (k >= list.length) {
    onDone(cur, gainer);
    return;
  }
  const { player, hook } = list[k]!;
  const box: JudgeBox = {};
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
    judgeHookStep(state, list, k + 1, trick, next, judgedId, nextGainer, onDone);
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
): void {
  switch (trick.type) {
    case 'lebu':
      // 乐不思蜀：非红桃 → 跳过出牌阶段
      if (judgeCard.suit !== 'heart') {
        player.flags.skipPlay = true;
        pushLog(state, 'lebu', `${player.name} 被【乐不思蜀】影响，将跳过出牌阶段。`);
      } else {
        pushLog(state, 'lebu', `${player.name} 的【乐不思蜀】判定为红桃，无效。`);
      }
      toDiscard(state, trick);
      break;
    case 'bingliang':
      // 兵粮寸断：非梅花 → 跳过摸牌阶段
      if (judgeCard.suit !== 'club') {
        player.flags.skipDraw = true;
        pushLog(state, 'bingliang', `${player.name} 被【兵粮寸断】影响，将跳过摸牌阶段。`);
      } else {
        pushLog(state, 'bingliang', `${player.name} 的【兵粮寸断】判定为梅花，无效。`);
      }
      toDiscard(state, trick);
      break;
    case 'shandian': {
      // 闪电：黑桃2-9 → 3点雷电伤害+弃闪电；否则 → 移到下家判定区
      if (judgeCard.suit === 'spade' && judgeCard.rank >= 2 && judgeCard.rank <= 9) {
        pushLog(
          state,
          'shandian',
          `${player.name} 的【闪电】判定为黑桃${judgeCard.rank}，受到3点雷电伤害！`,
        );
        toDiscard(state, trick);
        player.hp -= 3;
        // 自伤：来源就是自己，所以没有 afterDamageDealt。
        // 这里的 afterDamage 不支持挂起（闪电伤害无来源，触发不了会询问的技能）。
        runHooks(state, 'damageDealt', player, { damage: 3, attribute: 'thunder' });
        runHooks(state, 'afterDamage', player, { damage: 3, attribute: 'thunder' });
        pushLog(
          state,
          'damage',
          `${player.name} 受到 3 点雷电伤害，剩余 ${Math.max(0, player.hp)} 体力。`,
        );
      } else {
        // 不触发 → 移到下家判定区
        const nextIdx = nextAliveSeat(state, state.seatOrder.indexOf(player.seatId));
        const nextPlayer = getPlayer(state, state.seatOrder[nextIdx]!);
        if (nextPlayer && nextPlayer.seatId !== player.seatId) {
          nextPlayer.judgment.push(trick);
          pushLog(
            state,
            'shandian',
            `${player.name} 的【闪电】判定不触发，【闪电】移到 ${nextPlayer.name} 的判定区。`,
          );
        } else {
          toDiscard(state, trick);
        }
      }
      break;
    }
    default:
      toDiscard(state, trick);
      break;
  }
  // 天妒：判定牌被某个技能收走了，就不进弃牌堆
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
  // 「非锁定技失效直到回合结束」：回合真的结束了就统一清掉
  for (const p of state.players) p.flags.nonLockedSkillsDisabled = false;
  // 额外回合（刘禅·放权、挟天子以令诸侯）
  while (state.extraTurns.length > 0 && !state.gameOver) {
    const seatId = state.extraTurns.shift()!;
    const idx = state.seatOrder.indexOf(seatId);
    const p = idx >= 0 ? getPlayer(state, seatId) : undefined;
    if (!p || !p.alive) continue; // 该角色已经不在了，跳过
    pushLog(state, 'turn', `${p.name} 进行额外的一个回合。`);
    startTurn(state, idx);
    return;
  }
  const next = nextAliveSeat(state, state.turn.seatIndex);
  if (next === state.turn.seatIndex) {
    // 兜底：仅剩 1 人 → 判胜负
    checkWin(state);
    if (!state.gameOver) {
      state.gameOver = true;
      state.pending = null;
      state.turn.phase = 'gameOver';
      pushLog(state, 'gameover', '游戏结束。');
    }
    return;
  }
  startTurn(state, next);
}

/** 回到某玩家的出牌阶段（伤害结算后恢复来源回合） */
function resumePlay(state: GameState, sourceId: string): void {
  if (state.gameOver) return;
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
  state.pending = { kind: 'play', seatId: sourceId };
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
): ApplyResult {
  const heroes = activeHeroes(state, source);
  // 诸葛连弩：本回合可出无限杀
  const hasZhuge = source.equipment.weapon?.equipName === 'zhuge';
  const maxSha = hasZhuge ? Infinity : Math.max(1, ...heroes.map(heroShaLimit));
  if (source.flags.shaCountThisTurn >= maxSha) return err('本回合出杀数已达上限');
  if (targetIds.length !== 1) return err('杀需指定 1 名目标');
  const targetId = targetIds[0]!;
  if (targetId === source.seatId) return err('不能对自己使用杀');
  const target = getPlayer(state, targetId);
  if (!target || !target.alive) return err('目标无效');
  // 锁定技（空城等）：不能成为此牌的目标
  if (heroBlocksBeingTarget(state, target, card, source)) return err('该角色不能成为此牌的目标');
  // 距离校验：攻击范围 ≥ 距离（天义拼点赢则本回合无视距离）
  if (!source.flags.ignoreShaDistanceThisTurn && !canTarget(state, source.seatId, targetId))
    return err('目标超出攻击范围');

  startAttack(state, source, card, targetId, asType);
  return { ok: true };
}

/**
 * 从「目标已校验、准备出牌」开始走一遍【杀】的结算。
 *
 * playSha 校验完调它；青龙偃月刀继续出杀也复用它——那条路不校验距离与次数。
 */
function startAttack(
  state: GameState,
  source: Player,
  card: import('@sgs/protocol').Card,
  targetId: string,
  asType: import('@sgs/protocol').CardType,
  opts?: { countTowardLimit?: boolean },
): void {
  const target = getPlayerOrThrow(state, targetId);
  removeCard(source.hand, card.id);
  toDiscard(state, card);
  // 青龙偃月刀追加的【杀】不计入本回合出杀次数
  if (opts?.countTowardLimit !== false) source.flags.shaCountThisTurn++;

  // 酒 buff：本回合下一张杀伤害 +1
  let damage = 1;
  if (source.flags.jiuActive) {
    damage = 2;
    source.flags.jiuActive = false;
  }

  const attack: AttackContext = {
    sourceId: source.seatId,
    cardId: card.id,
    asType,
    targetId,
    damage,
    dodged: false,
    attribute: card.attribute,
    cardRed: isRed(card),
    requiredShan: 1,
  };
  pushLog(state, 'sha', `${source.name} 对 ${target.name} 使用了【杀】。`, {
    seat: source.seatId,
    action: card.attribute ? `sha-${card.attribute}` : 'sha',
  });
  runHooks(state, 'useCard', source, { attack, card });
  // 国战被动亮将：成为目标前自动亮将
  passiveReveal(state, target);
  becomeTargetFor(state, target, attack);
}

/**
 * 「成为【杀】目标」的结算入口。
 *
 * 可以被流离那类技能改目标——改了就对**新目标**重新走一遍这一步
 * （被动亮将、新目标的 becomeTarget 钩子、防具、八卦、等出闪）。
 */
function becomeTargetFor(state: GameState, target: Player, attack: AttackContext): void {
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
        if (newTarget && newTarget.alive) {
          attack.targetId = newTarget.seatId;
          attack.redirected = true;
          pushLog(state, 'skill', `此【杀】的目标改为 ${newTarget.name}。`);
          passiveReveal(state, newTarget);
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

  // 不可闪避（马超·铁骑/黄忠·烈弓判定为红色或满足条件）
  if (attack.requiredShan === Infinity) {
    finishAttack(state, attack);
    return;
  }

  // 八卦阵：需要出闪时自动判定，红色则视为出闪
  if (tryBaguaDodge(state, attack)) {
    pushLog(state, 'resolve', `${target.name} 的【八卦阵】判定为红色，视为出【闪】。`);
    attack.dodged = true;
    finishAttack(state, attack);
    return;
  }

  // 暂停：等待目标响应（出闪或弃权）
  state.pending = { kind: 'respondSha', responderId: targetId, attack };
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

/** 失去装备区的一张牌之后（枭姬）。可挂起：它挂在装备变动路径上，和伤害链一样要能被询问打断 */
function fireEquipLost(state: GameState, owner: Player, card: Card, after: () => void): void {
  runHooksPausable(state, 'equipLost', owner, { card }, after);
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
  runHooks(state, 'damageDealt', p, { attack: chainAttack, damage: c.damage });
  p.hp -= c.damage;
  pushLog(
    state,
    'damage',
    `${p.name} 因【铁索连环】受到 ${c.damage} 点伤害，剩余 ${Math.max(0, p.hp)} 体力。`,
  );
  const next = (): void => {
    c.index++;
    chainStep(state, c, after);
  };
  runHooksPausable(state, 'afterDamage', p, { attack: chainAttack, damage: c.damage }, () => {
    runDamageDealtHooksP(state, chainAttack, c.damage, () => {
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
    const afterDodge = (): void => {
      runHooks(state, 'afterResolve', target, { attack });
      resumePlay(state, state.seatOrder[state.turn.seatIndex]!);
    };
    // 被闪避后还能翻盘的武器：青龙偃月刀（继续出杀）/ 贯石斧（弃两张牌仍造成伤害）
    if (tryDodgeWeapon(state, attack, afterDodge)) return;
    afterDodge();
    return;
  }

  resolveAttackHit(state, attack);
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
          startAttack(st2, p2, card, target.seatId, 'sha', { countTowardLimit: false });
        },
      );
    },
  );
  return true;
}

/** 一张牌从玩家身上（手牌或装备区）进弃牌堆；失去装备会触发 equipLost */
function discardOwnCard(state: GameState, p: Player, card: Card, after: () => void): void {
  const eq = p.equipment;
  for (const slot of ['weapon', 'armor', 'plusMount', 'minusMount'] as const) {
    if (eq[slot]?.id === card.id) {
      eq[slot] = null;
      toDiscard(state, card);
      fireEquipLost(state, p, card, after);
      return;
    }
  }
  const c = removeCard(p.hand, card.id);
  if (c) toDiscard(state, c);
  after();
}

/** 逐张弃置（中间可能被失去装备的询问打断），全部处理完再调 after */
function discardOwnCards(
  state: GameState,
  p: Player,
  cards: Card[],
  after: () => void,
  i = 0,
): void {
  if (i >= cards.length) {
    after();
    return;
  }
  discardOwnCard(state, p, cards[i]!, () => discardOwnCards(state, p, cards, after, i + 1));
}

/** 自己身上可以被弃掉的牌：手牌 + 装备区（可选排除某件武器） */
function ownDiscardableCards(p: Player, excludeEquipName?: string): Card[] {
  const out = [...p.hand];
  const eq = p.equipment;
  for (const slot of ['weapon', 'armor', 'plusMount', 'minusMount'] as const) {
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

  // 命中：造成伤害
  runHooks(state, 'beforeResolve', target, { attack });
  // 装备加成：古锭刀（目标无手牌+1）/ 藤甲（火焰伤害+1）
  const equipBonus = damageBonus(state, attack);
  // 技能加成：裸衣这类「你造成的伤害 +N」
  const skillBonus = dealtDamageBonus(state, attack);
  const total = attack.damage + equipBonus + skillBonus;
  if (equipBonus > 0) {
    pushLog(state, 'damage', `${target.name} 受到的伤害 +${equipBonus}（装备特效）。`);
  }
  if (skillBonus > 0) {
    pushLog(state, 'damage', `${target.name} 受到的伤害 +${skillBonus}（技能）。`);
  }
  runHooks(state, 'damageDealt', target, { attack, damage: total });
  target.hp -= total;
  pushLog(
    state,
    'damage',
    `${target.name} 受到 ${total} 点伤害，剩余 ${Math.max(0, target.hp)} 体力。`,
  );
  // afterDamage（派给受伤者）与 afterDamageDealt（派给来源）都可能挂起询问，
  // 所以串起来跑，最后才接上收尾。收尾里会进濒死或回到出牌阶段。
  const tail = (): void => {
    runHooks(state, 'afterResolve', target, { attack });
    // 铁索连环：先记账（重置横置目标 + 记下要蔓延给谁），再决定控制流
    queueChainSpread(state, attack, total);
    if (target.hp <= 0) {
      // 目标自己濒死：蔓延的待办留在 ongoingChain 里，濒死结算完由 resumePlay 接着跑
      enterNearDeath(state, attack);
      return;
    }
    runChainSpread(state, () => {
      resumePlay(state, state.seatOrder[state.turn.seatIndex]!);
    });
  };
  runHooksPausable(state, 'afterDamage', target, { attack, damage: total }, () => {
    runDamageDealtHooksP(state, attack, total, tail);
  });
}

// ——————————————————————————————————————————
// 濒死 / 死亡
// ——————————————————————————————————————————

function enterNearDeath(state: GameState, attack: AttackContext): void {
  const dying = getPlayerOrThrow(state, attack.targetId);
  // 国战被动亮将：濒死时自动亮将
  passiveReveal(state, dying);
  // nearDeath 可挂起：涅槃这类技能要在濒死时询问，然后把人救回来
  runHooksPausable(state, 'nearDeath', dying, { attack }, () => {
    if (dying.hp > 0) {
      // 被技能救回来了（涅槃）：不建濒死队列，把控制权还回去
      pushLog(state, 'nearDeath', `${dying.name} 脱离了濒死状态。`);
      resumePlay(state, state.seatOrder[state.turn.seatIndex]!);
      return;
    }
    enterDeathQueue(state, dying, attack.sourceId);
  });
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
  state.pending = {
    kind: 'respondDeath',
    dyingId: dying.seatId,
    askQueue: queue,
    askIndex: 0,
    // 记住是谁打的——阵亡后要用它触发「杀死角色后」的技能（行殇）
    killerId,
  };
  pushLog(state, 'nearDeath', `${dying.name} 濒死，等待出桃救援。`);
}

/** 设定胜方并写日志，返回 true 表示游戏结束 */
function setWinner(state: GameState, winner: string): true {
  state.gameOver = true;
  state.pending = null;
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
    // 统计存活阵营
    const factionCounts = new Map<string, number>();
    for (const p of alive) {
      const f = p.faction ?? 'neutral';
      factionCounts.set(f, (factionCounts.get(f) ?? 0) + 1);
    }
    // 某非野心家阵营存活数 > 半数 → 该阵营胜
    const half = Math.floor(alive.length / 2);
    for (const [f, count] of factionCounts) {
      if (f !== 'ambitionist' && f !== 'neutral' && count > half) {
        return setWinner(state, f);
      }
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

function doDeath(state: GameState, dyingId: string, killerId?: string): void {
  const dying = getPlayerOrThrow(state, dyingId);
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
    const factionText = dying.faction ? `（${FACTION_NAME[dying.faction]}）` : '';
    pushLog(state, 'death', `${dying.name} 阵亡${roleText}${factionText}。`);
    runHooks(state, 'death', dying, {});
    // 清牌：行殇没拿走的才进弃牌堆
    for (const c of dying.hand) toDiscard(state, c);
    dying.hand = [];
    const eq = dying.equipment;
    for (const c of [eq.weapon, eq.armor, eq.plusMount, eq.minusMount]) {
      if (c) toDiscard(state, c);
    }
    dying.equipment = emptyEquipment();
    for (const c of dying.judgment) toDiscard(state, c);
    dying.judgment = [];

    if (checkWin(state)) return;
    // 回到当前回合玩家（伤害来源）的出牌阶段
    resumePlay(state, state.seatOrder[state.turn.seatIndex]!);
  };

  const killer = killerId && killerId !== dyingId ? getPlayer(state, killerId) : undefined;
  if (killer?.alive) {
    runHooksPausable(state, 'kill', killer, { victimId: dyingId }, afterKill);
    return;
  }
  afterKill();
}

// ——————————————————————————————————————————
// 意图分发
// ——————————————————————————————————————————

export function applyIntent(state: GameState, seatId: string, intent: Intent): ApplyResult {
  // 手牌清空检测要在任何变更之前取快照，否则拿不到「原来是几张」
  const handBefore = state.players.map((p) => p.hand.length);
  const result = applyIntentInner(state, seatId, intent);
  if (result.ok) {
    // 询问结束后接着跑被打断的流程。控制流的唯一收口，别在别处再调 drainResume。
    drainResume(state);
    // 手牌清空检测放最后：续接都跑完了才是这一手意图的真正终态
    checkHandEmptied(state, handBefore);
  }
  return result;
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
      runHooksPausable(state, 'handEmptied', p, undefined, () => {});
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
      state.pending = null;
      state.log.push({
        id: state.logSeq++,
        kind: 'skill',
        message: `${player.name} 选择了「${picked.label}」。`,
      });
      pending.resolve(state, player, picked.id);
      // 选完若没有产生新的流程（濒死、下一张判定等），把控制权还给发起者
      if (state.pending === null && pending.returnTo) {
        resumePlay(state, pending.returnTo);
      }
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
    case 'ack': {
      const p = state.pending;
      if (!p || p.kind !== 'viewCards') return err('当前没有需要确认的信息');
      if (p.seatId !== seatId) return err('不是你在看这张牌');
      state.pending = null;
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
  state.pending = null;
  pushLog(
    state,
    'skill',
    pending.secret
      ? `${player.name} 选择了 ${picked.length} 张牌。`
      : `${player.name} 选择了 ${picked.map((c) => `【${cardLabel(c)}】`).join('、') || '（无）'}。`,
  );
  pending.resolve(state, player, picked);
  // 选完若没有产生新的流程（濒死等），把控制权还给发起者
  if (state.pending === null && pending.returnTo) {
    resumePlay(state, pending.returnTo);
  }
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
  const card = player.hand.find((c) => c.id === intent.cardId);
  if (!card) return err('你没有这张牌');

  const as = intent.as ?? card.type;
  // 转化合法性（武圣：红牌当杀；鏖战：桃当杀）
  if (intent.as && intent.as !== card.type) {
    if (!canUseAsCard(state, player, card, intent.as!)) return err('不能将该牌转化为该类型');
  }

  if (as === 'sha') return playSha(state, player, card, intent.targetIds, as);
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
  removeCard(player.hand, card.id);
  toDiscard(state, card);
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
  removeCard(player.hand, card.id);
  toDiscard(state, card);
  const healed = healAndTrigger(state, player, 1);
  pushLog(state, 'tao', `${player.name} 使用了【桃】，回复 ${healed} 点体力。`, {
    seat: player.seatId,
    action: 'tao',
  });
  runHooks(state, 'useCard', player, { card });
  return { ok: true };
}

function playJiu(
  state: GameState,
  player: Player,
  card: import('@sgs/protocol').Card,
): ApplyResult {
  removeCard(player.hand, card.id);
  toDiscard(state, card);
  player.flags.jiuActive = true;
  pushLog(state, 'jiu', `${player.name} 使用了【酒】，下一张杀伤害+1。`, {
    seat: player.seatId,
    action: 'jiu',
  });
  runHooks(state, 'useCard', player, { card });
  return { ok: true };
}

/** 装备牌：放入对应槽位，旧装备进弃牌堆 */
function playEquip(
  state: GameState,
  player: Player,
  card: import('@sgs/protocol').Card,
): ApplyResult {
  removeCard(player.hand, card.id);
  const slot = card.type as 'weapon' | 'armor' | 'plusMount' | 'minusMount';
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
    runHooks(state, 'useCard', player, { card });
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
    removeCard(player.hand, card.id);
    player.judgment.push(card);
    pushLog(state, 'shandian', `${player.name} 将【闪电】置于自己的判定区。`, {
      seat: player.seatId,
      action: 'shandian',
    });
    runHooks(state, 'useCard', player, { card });
    return { ok: true };
  }
  // 乐不思蜀 / 兵粮寸断：目标为其他存活玩家，距离≤1
  if (targetIds.length !== 1) return err('需指定 1 名目标');
  const targetId = targetIds[0]!;
  if (targetId === player.seatId) return err('不能以自己为目标');
  const target = getPlayer(state, targetId);
  if (!target || !target.alive) return err('目标无效');
  if (heroBlocksBeingTarget(state, target, card, player)) return err('该角色不能成为此牌的目标');
  // 奇才：使用锦囊牌无距离限制
  if (
    !heroIgnoresTrickDistance(activeHeroes(state, player)) &&
    distance(state, player.seatId, targetId) > 1
  )
    return err('目标超出距离1');
  if (target.judgment.some((t) => t.type === type)) return err('目标判定区已有同类延时锦囊');
  removeCard(player.hand, card.id);
  target.judgment.push(card);
  pushLog(
    state,
    type,
    `${player.name} 将【${CARD_TYPE_NAME[type]}】置于 ${target.name} 的判定区。`,
    { seat: player.seatId, action: type },
  );
  runHooks(state, 'useCard', player, { card });
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
  // 无懈可击不能主动使用
  if (card.type === 'wuxie') return err('【无懈可击】不能主动使用');

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
      !heroIgnoresTrickDistance(activeHeroes(state, player)) &&
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
    if (!player.faction || t.faction === player.faction)
      return err('【远交近攻】只能指定与你势力不同的角色');
    if (heroBlocksBeingTarget(state, t, card, player)) return err('该角色不能成为此牌的目标');
  } else if (type === 'zhibi') {
    if (intent.targetIds.length !== 1) return err('【知己知彼】需指定 1 名目标');
    const tid = intent.targetIds[0]!;
    if (tid === player.seatId) return err('不能以自己为目标');
    const t = getPlayer(state, tid);
    if (!t || !t.alive) return err('目标无效');
    if (heroBlocksBeingTarget(state, t, card, player)) return err('该角色不能成为此牌的目标');
  }
  // 以逸待劳 / 五谷丰登：目标是规则定的（同势力 / 全体），无需指定

  // 出牌
  removeCard(player.hand, card.id);
  toDiscard(state, card);
  pushLog(state, 'trick', `${player.name} 使用了【${CARD_TYPE_NAME[type]}】。`, {
    seat: player.seatId,
    action: type,
  });
  runHooks(state, 'useCard', player, { card });

  startTrickResolution(state, player, card, intent.targetIds, intent.targetCardId);
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
  }
  // 单目标响应锦囊：responders = [target]
  if (type === 'juedou' || type === 'huogong' || type === 'jiedao') {
    ctx.responders = [targetIds[0]!];
    if (type === 'juedou') ctx.duelTurn = 'target';
  }

  // 无懈可击询问轮
  const sourceIdx = state.seatOrder.indexOf(player.seatId);
  const wuxieQueue = aliveSeatsFrom(
    state,
    state.seatOrder[nextAliveSeat(state, sourceIdx)]!,
  ).filter((s) => s !== player.seatId);
  if (wuxieQueue.length > 0) {
    state.pending = { kind: 'wuxieQueue', ctx, askQueue: wuxieQueue, askIndex: 0 };
  } else {
    resolveTrick(state, ctx);
  }
}

/** 无懈可击询问结束后的锦囊结算 */
function resolveTrick(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId);
  if (!source || !source.alive) {
    endTurn(state);
    return;
  }
  const type = ctx.card.type as TrickType;
  switch (type) {
    case 'wuzhong': {
      for (let i = 0; i < 2; i++) {
        const c = drawOne(state);
        if (c) source.hand.push(c);
      }
      pushLog(state, 'trick', `${source.name} 摸了 2 张牌。`);
      resumePlay(state, ctx.sourceId);
      return;
    }
    case 'taoyuan': {
      for (const p of alivePlayers(state)) {
        if (p.hp < p.maxHp) {
          const healed = healAndTrigger(state, p, 1);
          pushLog(state, 'tao', `${p.name} 回复 ${healed} 点体力。`);
        }
      }
      resumePlay(state, ctx.sourceId);
      return;
    }
    case 'guohe':
      resolveGuohe(state, ctx);
      return;
    case 'shunshou':
      resolveShunshou(state, ctx);
      return;
    case 'juedou':
      resolveJuedou(state, ctx);
      return;
    case 'huogong':
      resolveHuogong(state, ctx);
      return;
    case 'jiedao':
      resolveJiedao(state, ctx);
      return;
    case 'tiesuo':
      resolveTiesuo(state, ctx);
      return;
    case 'yuanjiao':
      resolveYuanjiao(state, ctx);
      return;
    case 'yiyi':
      resolveYiyi(state, ctx);
      return;
    case 'wugu':
      resolveWugu(state, ctx);
      return;
    case 'zhibi':
      resolveZhibi(state, ctx);
      return;
    case 'nanman':
    case 'wanjian':
      // AOE：从第一个响应者开始
      if (ctx.responders.length === 0) {
        resumePlay(state, ctx.sourceId);
        return;
      }
      enterTrickResponse(state, ctx);
      return;
    default:
      resumePlay(state, ctx.sourceId);
  }
}

/** 过河拆桥：弃目标 1 张牌 */
function resolveGuohe(state: GameState, ctx: TrickContext): void {
  const target = getPlayer(state, ctx.targetId!);
  if (!target || !target.alive) {
    resumePlay(state, ctx.sourceId);
    return;
  }
  const got = pickTargetCard(state, target, ctx.targetCardId);
  if (got) {
    toDiscard(state, got.card);
    pushLog(
      state,
      'trick',
      `${getPlayer(state, ctx.sourceId)!.name} 拆了 ${target.name} 的【${cardLabel(got.card)}】。`,
    );
    // 拆掉的是装备 → 目标失去装备区的一张牌（枭姬）
    if (got.fromEquip) {
      fireEquipLost(state, target, got.card, () => resumePlay(state, ctx.sourceId));
      return;
    }
  } else {
    pushLog(state, 'trick', `${target.name} 没有牌可拆。`);
  }
  resumePlay(state, ctx.sourceId);
}

/** 顺手牵羊：获得目标 1 张牌 */
function resolveShunshou(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  const target = getPlayer(state, ctx.targetId!);
  if (!target || !target.alive) {
    resumePlay(state, ctx.sourceId);
    return;
  }
  const got = pickTargetCard(state, target, ctx.targetCardId);
  if (got) {
    source.hand.push(got.card);
    pushLog(
      state,
      'trick',
      `${source.name} 从 ${target.name} 处获得了【${cardLabel(got.card)}】。`,
    );
    if (got.fromEquip) {
      fireEquipLost(state, target, got.card, () => resumePlay(state, ctx.sourceId));
      return;
    }
  } else {
    pushLog(state, 'trick', `${target.name} 没有牌可偷。`);
  }
  resumePlay(state, ctx.sourceId);
}

/** 从目标的牌中选取一张（优先指定明牌区，否则随机手牌，再否则随机装备/判定） */
function pickTargetCard(
  state: GameState,
  target: Player,
  targetCardId: string | undefined,
): { card: import('@sgs/protocol').Card; fromEquip: boolean } | null {
  // 指定的明牌区牌（装备/判定）
  if (targetCardId) {
    const eq = target.equipment;
    for (const slot of ['weapon', 'armor', 'plusMount', 'minusMount'] as const) {
      const c = eq[slot];
      if (c?.id === targetCardId) {
        eq[slot] = null;
        return { card: c, fromEquip: true };
      }
    }
    const ji = target.judgment.findIndex((c) => c.id === targetCardId);
    if (ji >= 0) {
      const [c] = target.judgment.splice(ji, 1);
      return c ? { card: c, fromEquip: false } : null;
    }
  }
  // 随机手牌
  if (target.hand.length > 0) {
    const idx = Math.floor(Math.random() * target.hand.length);
    const [c] = target.hand.splice(idx, 1);
    return c ? { card: c, fromEquip: false } : null;
  }
  // 随机装备/判定
  const eq = target.equipment;
  const visible: import('@sgs/protocol').Card[] = [
    eq.weapon,
    eq.armor,
    eq.plusMount,
    eq.minusMount,
    ...target.judgment,
  ].filter((c): c is import('@sgs/protocol').Card => c !== null);
  if (visible.length === 0) return null;
  const pick = visible[Math.floor(Math.random() * visible.length)]!;
  let fromEquip = true;
  if (pick.type === 'weapon') eq.weapon = null;
  else if (pick.type === 'armor') eq.armor = null;
  else if (pick.type === 'plusMount') eq.plusMount = null;
  else if (pick.type === 'minusMount') eq.minusMount = null;
  else {
    fromEquip = false;
    const ji = target.judgment.findIndex((c) => c.id === pick.id);
    if (ji >= 0) target.judgment.splice(ji, 1);
  }
  return { card: pick, fromEquip };
}

/** 决斗：目标先出杀，交替进行 */
function resolveJuedou(state: GameState, ctx: TrickContext): void {
  const targetId = ctx.responders[0]!;
  const target = getPlayer(state, targetId);
  if (!target || !target.alive) {
    resumePlay(state, ctx.sourceId);
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
  state.pending = {
    kind: 'respondTrick',
    responderId: targetId,
    ctx: { ...ctx, duelTurn: 'target', duelShaCount: 0 },
  };
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
    resumePlay(state, ctx.sourceId);
    return;
  }
  if (target.hand.length === 0) {
    pushLog(state, 'trick', `${target.name} 没有手牌，【火攻】无效。`);
    resumePlay(state, ctx.sourceId);
    return;
  }
  pushLog(state, 'trick', `${target.name} 需展示一张手牌。`);
  state.pending = { kind: 'respondTrick', responderId: targetId, ctx };
}

/** 借刀杀人：武器持有者选择出杀或交出武器 */
function resolveJiedao(state: GameState, ctx: TrickContext): void {
  const holderId = ctx.responders[0]!;
  const holder = getPlayer(state, holderId);
  if (!holder || !holder.alive || !holder.equipment.weapon) {
    pushLog(state, 'trick', `目标无武器，【借刀杀人】无效。`);
    resumePlay(state, ctx.sourceId);
    return;
  }
  pushLog(state, 'trick', `${holder.name} 需打出【杀】或交出武器。`);
  state.pending = { kind: 'respondTrick', responderId: holderId, ctx };
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
    t.chained = !t.chained;
    parts.push(`${t.name}${t.chained ? '横置' : '重置'}`);
  }
  if (parts.length > 0) {
    pushLog(state, 'chained', `${source.name} 对 ${parts.join('、')}（【铁索连环】）。`, {
      seat: source.seatId,
      action: 'tiesuo',
    });
  }
  resumePlay(state, ctx.sourceId);
}

/** 【远交近攻】：目标摸一张，然后你摸三张 */
function resolveYuanjiao(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  const target = getPlayer(state, ctx.targetIds?.[0] ?? '');
  if (!target || !target.alive) {
    pushLog(state, 'trick', `【远交近攻】的目标已不在场。`);
    resumePlay(state, ctx.sourceId);
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
  resumePlay(state, ctx.sourceId);
}

/**
 * 【以逸待劳】：你与同势力角色**依次**各摸两张牌，然后弃置两张牌。
 * 逐人处理——每个人摸完就立刻弃，不然「先摸后弃」的调整空间就没了。
 */
function resolveYiyi(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  const queue = source.faction
    ? aliveSeatsFrom(state, source.seatId).filter(
        (sid) => getPlayer(state, sid)?.faction === source.faction,
      )
    : [source.seatId];
  pushLog(
    state,
    'trick',
    `${source.name} 使用了【以逸待劳】，${queue.length} 名同势力角色依次摸两张牌后弃两张牌。`,
    { seat: source.seatId, action: 'yiyi' },
  );
  yiyiStep(state, ctx.sourceId, queue, 0);
}

function yiyiStep(state: GameState, sourceId: string, queue: string[], index: number): void {
  if (index >= queue.length) {
    resumePlay(state, sourceId);
    return;
  }
  const t = getPlayer(state, queue[index]!);
  if (!t || !t.alive) {
    yiyiStep(state, sourceId, queue, index + 1);
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
    yiyiStep(state, sourceId, queue, index + 1);
    return;
  }
  state.pending = {
    kind: 'pickCards',
    seatId: t.seatId,
    title: `【以逸待劳】：摸 ${drew} 张牌后需弃置 ${count} 张`,
    cards: t.hand.slice(),
    min: count,
    max: count,
    resolve: (st, player, picked) => {
      for (const c of picked) {
        removeCard(player.hand, c.id);
        toDiscard(st, c);
      }
      pushLog(st, 'trick', `${player.name} 因【以逸待劳】弃置了 ${picked.length} 张牌。`);
      yiyiStep(st, sourceId, queue, index + 1);
    },
  };
}

/**
 * 【五谷丰登】：亮出牌堆顶「存活角色数」张牌，然后所有角色按座次依次各拿一张，
 * 没人要的进弃牌堆。亮出来的牌在结算期间**不属于任何人**，所以池子由本函数
 * 自己持有，选中的牌要手动塞进手牌。
 */
function resolveWugu(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  const pickers = aliveSeatsFrom(state, source.seatId);
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
  wuguStep(state, ctx.sourceId, pool, pickers, 0);
}

function wuguStep(
  state: GameState,
  sourceId: string,
  remaining: import('@sgs/protocol').Card[],
  pickers: string[],
  index: number,
): void {
  if (index >= pickers.length || remaining.length === 0) {
    if (remaining.length > 0) {
      pushLog(state, 'trick', `【五谷丰登】余下的 ${remaining.length} 张牌进了弃牌堆。`);
      toDiscard(state, ...remaining.slice());
      remaining.length = 0;
    }
    resumePlay(state, sourceId);
    return;
  }
  const p = getPlayer(state, pickers[index]!);
  if (!p || !p.alive) {
    wuguStep(state, sourceId, remaining, pickers, index + 1);
    return;
  }
  state.pending = {
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
      wuguStep(st, sourceId, remaining, pickers, index + 1);
    },
  };
}

/**
 * 【知己知彼】：观看目标的手牌，或观看其一张暗置的武将牌。
 * 内容只下发给发起者（`viewCards` 提示按座位构建），日志里不出现牌名/武将名。
 */
function resolveZhibi(state: GameState, ctx: TrickContext): void {
  const source = getPlayer(state, ctx.sourceId)!;
  const target = getPlayer(state, ctx.targetIds?.[0] ?? '');
  if (!target || !target.alive) {
    pushLog(state, 'trick', `【知己知彼】的目标已不在场。`);
    resumePlay(state, ctx.sourceId);
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
    if (state.pending === null) resumePlay(state, ctx.sourceId);
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
        st.pending = {
          kind: 'viewCards',
          seatId: player.seatId,
          title: `${t.name} 的手牌（${t.hand.length} 张）`,
          cards: t.hand.slice(),
          returnTo: ctx.sourceId,
        };
        return;
      }
      const heroId = optionId.slice('hero:'.length);
      const heroName = hidden.find((h) => h.id === heroId)?.name ?? '暗置武将牌';
      pushLog(st, 'trick', `${player.name} 观看了一张暗置的武将牌。`, {
        seat: player.seatId,
        action: 'zhibi',
      });
      st.pending = {
        kind: 'viewCards',
        seatId: player.seatId,
        title: '你观看的暗置武将牌',
        cards: [],
        note: heroName,
        returnTo: ctx.sourceId,
      };
    },
    ctx.sourceId,
  );
}

/** AOE：进入第一个响应者的 respondTrick */
function enterTrickResponse(state: GameState, ctx: TrickContext): void {
  // 跳过已阵亡的响应者，以及被【藤甲】免疫的南蛮/万箭目标
  while (ctx.responderIndex < ctx.responders.length) {
    const seat = ctx.responders[ctx.responderIndex]!;
    const r = getPlayer(state, seat);
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
    resumePlay(state, ctx.sourceId);
    return;
  }
  const rId = ctx.responders[ctx.responderIndex]!;
  const r = getPlayerOrThrow(state, rId);
  pushLog(
    state,
    'trick',
    `轮到 ${r.name} 响应【${CARD_TYPE_NAME[ctx.card.type as import('@sgs/protocol').CardType]}】。`,
  );
  state.pending = { kind: 'respondTrick', responderId: rId, ctx };
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

// —— 决斗 ——

function respondDuelSha(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
  ctx: TrickContext,
): ApplyResult {
  const responder = getPlayerOrThrow(state, seatId);
  const card = responder.hand.find((c) => c.id === intent.cardId);
  if (!card) return err('你没有这张牌');
  // 接受【杀】，或武将可转化的牌（关羽·武圣：红牌当杀）
  if (card.type !== 'sha' && !canUseAsCard(state, responder, card, 'sha'))
    return err('决斗需打出【杀】');
  removeCard(responder.hand, card.id);
  toDiscard(state, card);
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
    state.pending = {
      kind: 'respondTrick',
      responderId,
      ctx: { ...ctx, duelShaCount: played },
    };
    return;
  }

  // 切换出杀方
  const newTurn = ctx.duelTurn === 'target' ? 'source' : 'target';
  const newResponderId = newTurn === 'source' ? ctx.sourceId : ctx.responders[0]!;
  const newResponder = getPlayer(state, newResponderId);
  if (!newResponder || !newResponder.alive) {
    // 对方已死 → 本方胜，无伤害
    resumePlay(state, ctx.sourceId);
    return;
  }
  pushLog(state, 'trick', `轮到 ${newResponder.name} 打出【杀】或受 1 点伤害。`);
  state.pending = {
    kind: 'respondTrick',
    responderId: newResponderId,
    ctx: { ...ctx, duelTurn: newTurn, duelShaCount: 0 },
  };
}

function passDuel(state: GameState, seatId: string, ctx: TrickContext): ApplyResult {
  const victim = getPlayerOrThrow(state, seatId);
  const attack: AttackContext = {
    sourceId: ctx.sourceId,
    cardId: ctx.card.id,
    asType: ctx.card.type,
    targetId: victim.seatId,
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
  runHooks(state, 'damageDealt', victim, { damage: total, attack });
  victim.hp -= total;
  pushLog(
    state,
    'damage',
    `${victim.name} 受到 ${total} 点伤害，剩余 ${Math.max(0, victim.hp)} 体力。`,
  );
  const tail = (): void => {
    if (victim.hp <= 0) {
      enterNearDeath(state, attack);
    } else {
      resumePlay(state, ctx.sourceId);
    }
  };
  runHooksPausable(state, 'afterDamage', victim, { damage: total, attack }, () => {
    runDamageDealtHooksP(state, attack, total, tail);
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
    pushLog(state, 'trick', `${responder.name} 展示了【${cardLabel(card)}】。`);
    state.pending = {
      kind: 'respondTrick',
      responderId: ctx.sourceId,
      ctx: { ...ctx, revealedSuit: card.suit },
    };
    return { ok: true };
  }

  // 阶段二：来源弃同花色牌 → 造成 1 点火属性伤害
  if (card.suit !== ctx.revealedSuit) return err('花色不符');
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
    damage: 1,
    dodged: false,
    attribute: 'fire',
  };
  runHooks(state, 'damageDealt', target, { damage: 1, attack });
  target.hp -= 1;
  pushLog(
    state,
    'damage',
    `${target.name} 受到 1 点火属性伤害，剩余 ${Math.max(0, target.hp)} 体力。`,
  );
  const tail = (): void => {
    if (target.hp <= 0) {
      enterNearDeath(state, attack);
    } else {
      resumePlay(state, ctx.sourceId);
    }
  };
  runHooksPausable(state, 'afterDamage', target, { damage: 1, attack }, () => {
    runDamageDealtHooksP(state, attack, 1, tail);
  });
  return { ok: true };
}

function passHuogong(state: GameState, seatId: string, ctx: TrickContext): ApplyResult {
  if (!ctx.revealedSuit) {
    // 目标拒绝展示 → 火攻无效（无伤害）
    pushLog(state, 'trick', `${getPlayer(state, seatId)!.name} 拒绝展示，【火攻】无效。`);
    resumePlay(state, ctx.sourceId);
    return { ok: true };
  }
  // 来源拒绝弃牌 → 无伤害
  pushLog(state, 'trick', `${getPlayer(state, seatId)!.name} 拒绝弃牌，【火攻】无效。`);
  resumePlay(state, ctx.sourceId);
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
  const card = holder.hand.find((c) => c.id === intent.cardId);
  if (!card) return err('你没有这张牌');
  if (card.type !== 'sha') return err('需打出【杀】');
  const shaTargetId = ctx.shaTargetId!;
  const shaTarget = getPlayer(state, shaTargetId);
  if (!shaTarget || !shaTarget.alive) return err('出杀目标无效');
  removeCard(holder.hand, card.id);
  toDiscard(state, card);
  resolvePlayedSha(state, holder, shaTargetId, card, 'sha', {
    kind: 'trick',
    text: `${holder.name} 对 ${shaTarget.name} 使用了【杀】。`,
  });
  return { ok: true };
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
): void {
  const target = getPlayer(state, targetId);
  if (!target || !target.alive) {
    resumePlay(state, state.seatOrder[state.turn.seatIndex]!);
    return;
  }
  const attack: AttackContext = {
    sourceId: source.seatId,
    cardId: card.id,
    asType,
    targetId,
    damage: 1,
    dodged: false,
    attribute: card.attribute,
    cardRed: isRed(card),
    requiredShan: 1,
  };
  pushLog(state, log.kind, log.text);
  runHooks(state, 'useCard', source, { attack, card });
  passiveReveal(state, target);
  becomeTargetFor(state, target, attack);
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
  fireEquipLost(state, holder, weapon, () => resumePlay(state, ctx.sourceId));
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
  const card = responder.hand.find((c) => c.id === intent.cardId);
  if (!card) return err('你没有这张牌');
  if (card.type !== 'sha' && !canUseAsCard(state, responder, card, 'sha'))
    return err('需打出【杀】');
  const shaTargetId = ctx.shaTargetId!;
  const shaTarget = getPlayer(state, shaTargetId);
  if (!shaTarget || !shaTarget.alive) return err('出杀目标无效');
  removeCard(responder.hand, card.id);
  toDiscard(state, card);
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
    damage: 1,
    dodged: false,
  };
  runHooks(state, 'damageDealt', victim, { damage: 1, attack });
  victim.hp -= 1;
  pushLog(state, 'damage', `${victim.name} 受到 1 点伤害，剩余 ${Math.max(0, victim.hp)} 体力。`);
  const tail = (): void => {
    if (victim.hp <= 0) {
      enterNearDeath(state, attack);
    } else {
      resumePlay(state, ctx.sourceId);
    }
  };
  runHooksPausable(state, 'afterDamage', victim, { damage: 1, attack }, () => {
    runDamageDealtHooksP(state, attack, 1, tail);
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
  const card = responder.hand.find((c) => c.id === intent.cardId);
  if (!card) return err('你没有这张牌');
  if (card.type !== 'sha' && !canUseAsCard(state, responder, card, 'sha'))
    return err('南蛮入侵需打出【杀】');
  removeCard(responder.hand, card.id);
  toDiscard(state, card);
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
  const card = responder.hand.find((c) => c.id === intent.cardId);
  if (!card) return err('你没有这张牌');
  if (card.type !== 'shan' && !canUseAsCard(state, responder, card, 'shan'))
    return err('万箭齐发需打出【闪】');
  removeCard(responder.hand, card.id);
  toDiscard(state, card);
  pushLog(state, 'trick', `${responder.name} 打出了【闪】。`, {
    seat: responder.seatId,
    action: 'shan',
  });
  advanceTrick(state, ctx);
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
    damage: 1,
    dodged: false,
  };
  runHooks(state, 'damageDealt', victim, { damage: 1, attack });
  victim.hp -= 1;
  pushLog(state, 'damage', `${victim.name} 受到 1 点伤害，剩余 ${Math.max(0, victim.hp)} 体力。`);
  const tail = (): void => {
    if (victim.hp <= 0) {
      // 濒死中断：暂存 trick 上下文，救人/死亡后恢复
      state.ongoingTrick = ctx;
      enterNearDeath(state, attack);
    } else {
      advanceTrick(state, ctx);
    }
  };
  runHooksPausable(state, 'afterDamage', victim, { damage: 1, attack }, () => {
    runDamageDealtHooksP(state, attack, 1, tail);
  });
  return { ok: true };
}

// —— 无懈可击 ——

function onRespondWuxie(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
  pending: Extract<Pending, { kind: 'wuxieQueue' }>,
): ApplyResult {
  const asked = pending.askQueue[pending.askIndex];
  if (asked !== seatId) return err('当前不是你响应');
  const responder = getPlayerOrThrow(state, seatId);
  const card = responder.hand.find((c) => c.id === intent.cardId);
  if (!card) return err('你没有这张牌');
  const responders = activeHeroes(state, responder);
  // 接受【无懈可击】，或武将可转化的牌（卧龙诸葛亮·看破：黑色手牌当无懈）
  if (card.type !== 'wuxie' && !responders.some((h) => heroCanUseAs(h, card, 'wuxie')))
    return err('只能使用【无懈可击】');
  removeCard(responder.hand, card.id);
  toDiscard(state, card);
  pushLog(
    state,
    'trick',
    `${responder.name} 使用了【无懈可击】，取消了【${CARD_TYPE_NAME[pending.ctx.card.type as import('@sgs/protocol').CardType]}】。`,
    { seat: responder.seatId, action: 'wuxie' },
  );
  // 锦囊被取消 → 回到来源出牌阶段
  resumePlay(state, pending.ctx.sourceId);
  return { ok: true };
}

function onPassWuxie(
  state: GameState,
  pending: Extract<Pending, { kind: 'wuxieQueue' }>,
): ApplyResult {
  pending.askIndex++;
  if (pending.askIndex >= pending.askQueue.length) {
    // 无人打出无懈 → 锦囊生效
    resolveTrick(state, pending.ctx);
  }
  return { ok: true };
}

function onRespondCard(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'respondCard' }>,
): ApplyResult {
  const pending = state.pending!;
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
  const card = responder.hand.find((c) => c.id === intent.cardId);
  if (!card) return err('你没有这张牌');
  const heroes = activeHeroes(state, responder);
  // 接受【闪】，或武将可转化的牌（赵云·龙胆：杀当闪；甄姬·倾国：黑牌当闪）
  if (card.type !== 'shan' && !heroes.some((h) => heroCanUseAs(h, card, 'shan')))
    return err('只能用【闪】响应');
  removeCard(responder.hand, card.id);
  toDiscard(state, card);
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
  // 吕布·无双：需出 2 张闪，出 1 张后减 1，>1 则继续等
  const required = attack.requiredShan ?? 1;
  if (required > 1) {
    attack.requiredShan = required - 1;
    pushLog(state, 'shan', `${who.name} 还需出 ${required - 1} 张【闪】。`);
    state.pending = { kind: 'respondSha', responderId: attack.targetId, attack };
    return;
  }
  attack.dodged = true;
  finishAttack(state, attack);
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
          if (t) api.dealDamage(t, 1, executorSeatId);
          after();
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
      api.loseHp(executor, 1);
      after();
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
        const slots = ['weapon', 'armor', 'plusMount', 'minusMount'] as const;
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
    state.pending = { kind: 'respondSha', responderId: seatId, attack: scene.attack };
    return;
  }
  state.pending = { kind: 'respondTrick', responderId: seatId, ctx: scene.ctx };
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

  state.pending = {
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
  };
  return { ok: true };
}

/** 能替 caller 代打 needType 的同势力角色（按座次，排除自己） */
export function factionHelpers(state: GameState, caller: Player, needType: CardType): string[] {
  if (!caller.faction) return [];
  return state.players
    .filter(
      (p) =>
        p.alive &&
        p.seatId !== caller.seatId &&
        p.faction === caller.faction &&
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
  const card = helper.hand.find((c) => c.id === intent.cardId);
  if (!card) return err('你没有这张牌');
  if (card.type !== pending.needType && !canUseAsCard(state, helper, card, pending.needType))
    return err(`只能打出【${CARD_TYPE_NAME[pending.needType]}】`);
  removeCard(helper.hand, card.id);
  toDiscard(state, card);
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
  const card = saver.hand.find((c) => c.id === intent.cardId);
  if (!card) return err('你没有这张牌');
  const heroes = activeHeroes(state, saver);
  // 接受【桃】/【酒】，或武将可转化的红牌（华佗·急救：红牌当桃）
  if (
    card.type !== 'tao' &&
    card.type !== 'jiu' &&
    !heroes.some((h) => heroCanUseAs(h, card, 'tao'))
  )
    return err('只能用【桃】（或【酒】当桃）救人');
  // 酒当桃救人：限1次/回合
  if (card.type === 'jiu' && saver.flags.taoSaveCountThisTurn > 0) return err('本回合已用过酒救人');
  removeCard(saver.hand, card.id);
  toDiscard(state, card);
  if (card.type === 'jiu') saver.flags.taoSaveCountThisTurn++;
  const dying = getPlayerOrThrow(state, pending.dyingId);
  // 救援：同势力的**其他**角色对你使用【桃】时额外回复（孙权·救援）
  let heal = 1;
  if (card.type === 'tao' && saver.seatId !== pending.dyingId && dying.faction) {
    const sameFaction = saver.faction === dying.faction;
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
  runHooksPausable(state, 'afterHeal', dying, { amount: heal }, () => {});
  // 救活，回到伤害来源出牌阶段
  resumePlay(state, state.seatOrder[state.turn.seatIndex]!);
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
  for (const id of intent.cardIds) {
    const c = removeCard(player.hand, id);
    if (c) toDiscard(state, c);
  }
  pushLog(state, 'discard', `${player.name} 弃了 ${intent.cardIds.length} 张牌。`);
  runDiscardPhaseEnd(state, player);
  return { ok: true };
}

/** 国战：出牌阶段主动亮将 */
function onRevealHero(state: GameState, seatId: string, intent: Intent): ApplyResult {
  if (intent.type !== 'revealHero') return err('亮将：请指定要亮的武将');
  if (state.mode !== 'guozhan') return err('非国战模式不能亮将');
  const pending = state.pending;
  if (!pending || pending.kind !== 'play' || pending.seatId !== seatId)
    return err('只能在你的出牌阶段亮将');
  const player = getPlayerOrThrow(state, seatId);
  if (intent.heroId !== player.heroId && intent.heroId !== player.deputyHeroId)
    return err('该武将不是你的武将');

  const mainHero = getHero(player.heroId);
  const deputyHero = getHero(player.deputyHeroId);
  // 君主将：亮将时主副将同时亮出
  const isLordPair = !!mainHero?.isLord || !!deputyHero?.isLord;
  if (isLordPair) {
    if (player.heroRevealed && player.deputyRevealed) return err('你的武将已经全部亮出');
    player.heroRevealed = true;
    player.deputyRevealed = true;
    const names = [mainHero?.name, deputyHero?.name].filter(Boolean).join('、');
    pushLog(state, 'reveal', `${player.name} 亮将（君主）：${names}。`);
  } else if (intent.heroId === player.heroId) {
    if (player.heroRevealed) return err('主将已亮');
    player.heroRevealed = true;
    pushLog(state, 'reveal', `${player.name} 亮将：${mainHero?.name ?? '未知'}。`);
  } else {
    if (player.deputyRevealed) return err('副将已亮');
    player.deputyRevealed = true;
    pushLog(state, 'reveal', `${player.name} 亮将：${deputyHero?.name ?? '未知'}。`);
  }
  onHeroRevealed(state, player);
  return { ok: true };
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
  opts?: { resumeTo?: string; actor?: string; judgeBox?: JudgeBox; attackBox?: AttackBox },
): SkillApi {
  const resumeTo = opts?.resumeTo;
  const judgeBox = opts?.judgeBox;
  const attackBox = opts?.attackBox;
  return {
    askChoice,
    askPickCards,
    replaceJudgeCard: (card) => {
      // 没有 judgeBox 说明不在判定流程里，静默忽略
      if (judgeBox) judgeBox.replacement = card;
    },
    redirectAttack: (newTargetSeatId) => {
      if (attackBox) attackBox.redirectTo = newTargetSeatId;
    },
    discardCard: (ownerSeatId, card, after) => {
      const owner = getPlayer(state, ownerSeatId);
      const done = after ?? (() => {});
      if (!owner) {
        done();
        return;
      }
      discardOwnCard(state, owner, card, done);
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
              let winner: string | null = null;
              if (c1.rank > c2.rank) winner = initiatorId;
              else if (c2.rank > c1.rank) winner = targetId;
              pushLog(
                st2,
                'skill',
                winner
                  ? `【拼点】${winner === initiatorId ? init.name : tgt.name} 赢。`
                  : '【拼点】平点，无人获胜。',
              );
              onResult(st2, winner);
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
      };
      resolvePlayedSha(state, source, targetId, card, 'sha', {
        kind: opts?.logKind ?? 'skill',
        text: `${source.name} 视为对 ${target.name} 使用了一张【杀】。`,
      });
    },
    armyOrder: (initiatorSeatId, executorSeatId, onDone) => {
      const initiator = getPlayer(state, initiatorSeatId);
      const executor = getPlayer(state, executorSeatId);
      // 整条链走完的收口：先让技能结算自己的收益，再把控制权还回去。
      // 技能在出牌阶段发起时 resumeTo 就是技能使用者——不还的话 pending 会停在
      // null，出牌方再也动不了（和 pindian 是同一个坑）。
      const finish = (st: GameState, executed: boolean): void => {
        onDone(st, executed);
        if (st.pending === null && resumeTo) resumePlay(st, resumeTo);
      };
      if (!initiator || !executor) {
        finish(state, false);
        return;
      }
      // 发起者从随机两张军令里挑一张交给执行者
      const two = shuffle([...ARMY_ORDERS]).slice(0, 2);
      askChoice(
        state,
        initiatorSeatId,
        `【军令】：从两张里挑一张交给 ${executor.name}`,
        two.map((o) => ({ id: o.id, label: o.label })),
        (st, _p, tokenId) => {
          const token = ARMY_ORDERS.find((o) => o.id === tokenId);
          if (!token) {
            finish(st, false);
            return;
          }
          askChoice(
            st,
            executorSeatId,
            `【军令】${initiator.name} 令你执行：${token.label}。是否执行？`,
            [
              { id: 'yes', label: '执行军令' },
              { id: 'no', label: '不执行' },
            ],
            (st2, p2, picked) => {
              if (picked !== 'yes') {
                pushLog(st2, 'skill', `${p2.name} 拒绝执行军令。`);
                finish(st2, false);
                return;
              }
              pushLog(st2, 'skill', `${p2.name} 执行军令：${token.label}。`);
              applyArmyOrder(st2, token.id, initiatorSeatId, executorSeatId, () =>
                finish(st2, true),
              );
            },
          );
        },
      );
    },
    grantSkill: (heroId, skillName) => {
      const actor = opts?.actor ? getPlayer(state, opts.actor) : undefined;
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
      runHooks(state, 'useCard', source, { card });
      startTrickResolution(state, source, card, targetIds ?? [], undefined);
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
      if (replaced) toDiscard(state, replaced);
      target.equipment[equipSlot] = card;
      pushLog(
        state,
        'skill',
        `【${EQUIP_NAME[card.equipName ?? ''] ?? cardLabel(card)}】从 ${from.name} 的装备区移到了 ${target.name} 的装备区。`,
      );
      // 原主失去装备区的牌 → 枭姬那类技能
      fireEquipLost(state, from, card, () => after?.());
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
      for (const slot of ['weapon', 'armor', 'plusMount', 'minusMount'] as const) {
        if (eq[slot]?.id === card.id) {
          eq[slot] = null;
          to.hand.push(card);
          // 失去装备要触发枭姬那类技能，所以不能直接 splice
          fireEquipLost(state, from, card, done);
          return;
        }
      }
      removeCard(from.hand, card.id);
      to.hand.push(card);
      done();
    },
    dealDamage: (target, damage, sourceId, attribute) => {
      const attack: AttackContext = {
        sourceId,
        cardId: '',
        asType: 'sha',
        targetId: target.seatId,
        damage,
        dodged: false,
        attribute,
      };
      runHooks(state, 'damageDealt', target, { damage, attack });
      target.hp -= damage;
      pushLog(
        state,
        'damage',
        `${target.name} 受到 ${damage} 点伤害，剩余 ${Math.max(0, target.hp)} 体力。`,
      );
      runHooksPausable(state, 'afterDamage', target, { damage, attack }, () => {
        runDamageDealtHooksP(state, attack, damage, () => {
          if (target.hp <= 0) {
            enterNearDeath(state, attack);
          } else if (resumeTo) {
            resumePlay(state, resumeTo);
          }
        });
      });
    },
    heal: (target, amount) => healAndTrigger(state, target, amount),
    loseHp: (target, amount) => {
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
  const heroes = activeHeroes(state, player);
  // 查找技能：先找武将主动技，再找标记带来的技能（标记不属于任何武将）
  let skill: ActiveSkill | undefined;
  for (const hero of heroes) {
    skill = hero.activeSkills?.find((s) => s.id === intent.skillId);
    if (skill) break;
  }
  if (!skill) skill = markerActiveSkills(state, player).find((s) => s.id === intent.skillId);
  if (!skill) return err('你没有这个技能');
  // 检查可用性
  if (!skill.canUse(state, player)) return err('该技能当前不可使用');
  // 限 1 次/回合
  if (skill.oncePerTurn && player.flags.skillUsedThisTurn[skill.id])
    return err('该技能本回合已使用');
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
  if (skill.oncePerGame) player.usedOncePerGame[skill.id] = true;
  // 注入引擎内部 API（避免 heroes→engine 循环依赖）
  const api = makeSkillApi(state, { resumeTo: player.seatId, actor: player.seatId });
  // 执行
  const result = skill.execute(state, player, intent, api);
  if (typeof result === 'string') {
    // 执行失败：回滚标记
    if (skill.oncePerTurn) player.flags.skillUsedThisTurn[skill.id] = false;
    if (skill.oncePerGame) player.usedOncePerGame[skill.id] = false;
    return err(result);
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
     * 测试用：选将阶段不限发将，每个人都能看到全部武将。
     * 实现上就是把 deals 填成整个武将池——发将校验、国战的
     * 「两名同阵营」等规则都照旧走，所以测出来的行为与真实一致。
     */
    freePick?: boolean;
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
    const roles = shuffle([...roleTable]);
    players.forEach((p, i) => {
      p.role = roles[i]!;
    });
  }

  // 随机发将：武将池洗牌一次后按座次不重叠发牌，
  // 避免多个玩家拿到同一名武将。池子发完则重洗剩余部分兜底。
  // 池子先按模式筛（国战专属武将不带进军争/混战），国战再排除中立武将；
  // 每人需拿到 ≥2 名同阵营武将才能选将，k=7 时按鸽巢原理在 ≤4 个阵营中必有 ≥2 同阵营，恒可满足。
  const poolHeroes = poolForMode(mode).filter((h) => !isGuozhan || h.faction !== 'neutral');
  const allIds = poolHeroes.map((h) => h.id);
  const deals: Record<string, string[]> = {};
  if (opts?.freePick) {
    // 测试用：每人拿到的「可选项」就是整个池子，想选谁选谁
    for (const s of seats) deals[s.seatId] = allIds.slice();
  } else {
    const heroIds = shuffle(allIds);
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
    deck: shuffle(buildDeck(mode)),
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
    discardThisTurn: [],
    xianquSeat: null,
    resumeQueue: [],
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
  const options = draft.deals[seatId];
  if (!options || !options.includes(intent.heroId)) return err('该武将不在你发到的将中');
  const player = getPlayerOrThrow(state, seatId);

  if (state.mode === 'guozhan') {
    const deputyId = intent.deputyHeroId;
    if (!deputyId) return err('国战需选 2 位武将（主将 + 副将）');
    if (!options.includes(deputyId)) return err('副将不在你发到的将中');
    if (deputyId === intent.heroId) return err('主将与副将不能相同');
    const mainHero = getHero(intent.heroId);
    const deputyHero = getHero(deputyId);
    if (!mainHero || !deputyHero) return err('武将不存在');
    if (mainHero.faction !== deputyHero.faction) return err('国战需选 2 位同阵营武将');
    // 君主将只能作主将
    if (deputyHero.isLord) return err('君主将只能作为主将');
    player.heroId = intent.heroId;
    player.deputyHeroId = deputyId;
    player.faction = mainHero.faction;
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
        p.maxHp = Math.floor((main.maxHp + deputy.maxHp) / 2);
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
  // 野心家分配：某阵营人数 > 总人数/2 → 多余者变为野心家
  if (state.mode === 'guozhan') {
    const total = state.players.length;
    const factionPlayers = new Map<string, Player[]>();
    for (const p of state.players) {
      const f = p.faction ?? 'neutral';
      if (!factionPlayers.has(f)) factionPlayers.set(f, []);
      factionPlayers.get(f)!.push(p);
    }
    for (const [f, players] of factionPlayers) {
      if (f !== 'ambitionist' && f !== 'neutral' && players.length > Math.ceil(total / 2)) {
        const excess = players.length - Math.ceil(total / 2);
        // 按座位顺序从后往前，把最后加入该阵营的玩家变为野心家。
        // 君主不会成为野心家，所以跳过（见 heroes.ts 的 isLord）。
        let remaining = excess;
        for (let i = players.length - 1; i >= 0 && remaining > 0; i--) {
          const cand = players[i]!;
          if (getHero(cand.heroId)?.isLord) continue;
          cand.faction = 'ambitionist';
          pushLog(state, 'faction', `${cand.name} 因阵营人数过多，变为野心家。`);
          remaining--;
        }
      }
    }
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
