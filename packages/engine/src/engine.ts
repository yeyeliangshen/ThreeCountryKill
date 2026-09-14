import type { Faction, GameMode, Intent, RoleId, TrickType } from '@sgs/protocol';
import { CARD_TYPE_NAME, EQUIP_NAME, cardLabel, isDelayedTrick, isEquipCard, isInstantTrick } from '@sgs/protocol';
import {
  alivePlayers,
  aliveSeatsFrom,
  emptyEquipment,
  emptyFlags,
  getPlayer,
  getPlayerOrThrow,
  nextAliveSeat,
  pushLog,
  type AttackContext,
  type GameState,
  type Pending,
  type Player,
  type TrickContext,
} from './model';
import { canTarget, distance } from './distance';
import { buildDeck, drawOne, shuffle } from './deck';
import {
  HEROES,
  FACTION_NAME,
  getHero,
  heroCanUseAs,
  heroShaLimit,
  ROLE_NAME,
  type ActiveSkill,
  type Hero,
} from './heroes';
import type { HookContext, Timing } from './timing';

// —— 对外 API ——
export interface SeatSetup {
  seatId: string;
  name: string;
  // 新流程下不再传入：武将改为开局后随机发、各自选 1
  heroId?: string;
}

export type ApplyResult = { ok: true } | { ok: false; error: string };

const err = (message: string): ApplyResult => ({ ok: false, error: message });

// 手牌上限 = 当前体力
function handLimit(player: Player): number {
  return Math.max(0, player.hp);
}

function removeCard(hand: import('@sgs/protocol').Card[], id: string) {
  const i = hand.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const [c] = hand.splice(i, 1);
  return c ?? null;
}

/** 国战：返回已亮将的武将列表（暗将不返回）；非国战：返回主将（单元素数组） */
export function activeHeroes(state: GameState, player: Player): Hero[] {
  const heroes: Hero[] = [];
  if (player.heroId) {
    const h = getHero(player.heroId);
    if (h && (state.mode !== 'guozhan' || player.heroRevealed)) heroes.push(h);
  }
  if (player.deputyHeroId) {
    const h = getHero(player.deputyHeroId);
    if (h && (state.mode !== 'guozhan' || player.deputyRevealed)) heroes.push(h);
  }
  return heroes;
}

// 在某时机运行玩家已激活武将的触发钩子。返回 false 表示被取消。
function runHooks(
  state: GameState,
  timing: Timing,
  player: Player,
  payload?: unknown,
): boolean {
  const heroes = activeHeroes(state, player);
  const hooks = heroes.flatMap((hero) => hero.hooks?.filter((h) => h.timing === timing) ?? []);
  hooks.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const ctx: HookContext = { state, player, timing, payload };
  for (const h of hooks) {
    const res = h.handler(ctx);
    if (res && res.cancel) return false;
  }
  return true;
}

// ——————————————————————————————————————————
// 回合流程
// ——————————————————————————————————————————

function startTurn(state: GameState, seatIndex: number): void {
  state.turn = { seatIndex, phase: 'judgment' };
  const player = getPlayerOrThrow(state, state.seatOrder[seatIndex]!);
  // 回合开始重置本回合标记
  player.flags = emptyFlags();
  runHooks(state, 'turnStart', player);

  // 判定阶段：处理判定区延时锦囊
  state.turn.phase = 'judgment';
  runHooks(state, 'judgePhase', player);
  processJudgmentPhase(state, player);
  // 闪电伤害可能导致濒死
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
  // 摸牌阶段：摸 2 张（兵粮寸断可跳过）
  state.turn.phase = 'draw';
  runHooks(state, 'drawPhase', player);
  if (!player.flags.skipDraw) {
    for (let i = 0; i < 2; i++) {
      const c = drawOne(state);
      if (c) player.hand.push(c);
    }
    pushLog(state, 'draw', `${player.name} 摸了 2 张牌。`);
  } else {
    pushLog(state, 'draw', `${player.name} 被【兵粮寸断】影响，跳过摸牌阶段。`);
  }

  // 出牌阶段（乐不思蜀可跳过）
  if (!player.flags.skipPlay) {
    state.turn.phase = 'play';
    runHooks(state, 'playPhase', player);
    state.pending = { kind: 'play', seatId: player.seatId };
  } else {
    pushLog(state, 'lebu', `${player.name} 被【乐不思蜀】影响，跳过出牌阶段。`);
    goToDiscardPhase(state, player);
  }
}

/** 进入弃牌阶段：检查手牌上限 */
function goToDiscardPhase(state: GameState, player: Player): void {
  state.turn.phase = 'discard';
  runHooks(state, 'discardPhase', player);
  const over = player.hand.length - handLimit(player);
  if (over > 0) {
    state.pending = { kind: 'discard', seatId: player.seatId, count: over };
  } else {
    endTurn(state);
  }
}

/** 判定阶段：逐张处理判定区延时锦囊 */
function processJudgmentPhase(state: GameState, player: Player): void {
  const judgments = player.judgment.slice();
  player.judgment = [];
  for (const trick of judgments) {
    let judgeCard = drawOne(state);
    if (!judgeCard) break; // 牌堆耗尽
    pushLog(
      state,
      'judge',
      `${player.name} 判定：${cardLabel(judgeCard)}（${CARD_TYPE_NAME[trick.type]}）。`,
    );

    // beforeJudge：鬼才等技能可替换判定牌
    const judgeHeroes = activeHeroes(state, player);
    const judgeHooks = judgeHeroes.flatMap((h) => h.hooks?.filter((hk) => hk.timing === 'beforeJudge') ?? []);
    judgeHooks.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    for (const hk of judgeHooks) {
      const res = hk.handler({ state, player, timing: 'beforeJudge', payload: { trick, judgeCard } });
      if (res?.replaceCard) {
        state.discard.push(judgeCard);
        judgeCard = res.replaceCard;
        pushLog(state, 'judge', `${player.name} 将判定牌替换为${cardLabel(judgeCard)}。`);
      }
    }

    switch (trick.type) {
      case 'lebu':
        // 乐不思蜀：非红桃 → 跳过出牌阶段
        if (judgeCard.suit !== 'heart') {
          player.flags.skipPlay = true;
          pushLog(state, 'lebu', `${player.name} 被【乐不思蜀】影响，将跳过出牌阶段。`);
        } else {
          pushLog(state, 'lebu', `${player.name} 的【乐不思蜀】判定为红桃，无效。`);
        }
        state.discard.push(trick);
        break;
      case 'bingliang':
        // 兵粮寸断：非梅花 → 跳过摸牌阶段
        if (judgeCard.suit !== 'club') {
          player.flags.skipDraw = true;
          pushLog(state, 'bingliang', `${player.name} 被【兵粮寸断】影响，将跳过摸牌阶段。`);
        } else {
          pushLog(state, 'bingliang', `${player.name} 的【兵粮寸断】判定为梅花，无效。`);
        }
        state.discard.push(trick);
        break;
      case 'shandian': {
        // 闪电：黑桃2-9 → 3点雷电伤害+弃闪电；否则 → 移到下家判定区
        if (judgeCard.suit === 'spade' && judgeCard.rank >= 2 && judgeCard.rank <= 9) {
          pushLog(
            state,
            'shandian',
            `${player.name} 的【闪电】判定为黑桃${judgeCard.rank}，受到3点雷电伤害！`,
          );
          state.discard.push(trick);
          player.hp -= 3;
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
            state.discard.push(trick);
          }
        }
        break;
      }
      default:
        state.discard.push(trick);
        break;
    }
    state.discard.push(judgeCard);
  }
}

function endTurn(state: GameState): void {
  if (state.gameOver) return;
  const cur = getPlayerOrThrow(state, state.seatOrder[state.turn.seatIndex]!);
  runHooks(state, 'turnEnd', cur);
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
  if (source.flags.shaCountThisTurn >= maxSha)
    return err('本回合出杀数已达上限');
  if (targetIds.length !== 1) return err('杀需指定 1 名目标');
  const targetId = targetIds[0]!;
  if (targetId === source.seatId) return err('不能对自己使用杀');
  const target = getPlayer(state, targetId);
  if (!target || !target.alive) return err('目标无效');
  // 距离校验：攻击范围 ≥ 距离
  if (!canTarget(state, source.seatId, targetId))
    return err('目标超出攻击范围');

  removeCard(source.hand, card.id);
  state.discard.push(card);
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
    asType,
    targetId,
    damage,
    dodged: false,
    attribute: card.attribute,
    requiredShan: 1,
  };
  pushLog(state, 'sha', `${source.name} 对 ${target.name} 使用了【杀】。`);
  runHooks(state, 'useCard', source, { attack });
  if (!runHooks(state, 'becomeTarget', target, { attack })) {
    // becomeTarget 被取消 → 自动闪避（如八卦阵/被动闪避技）
    attack.dodged = true;
    finishAttack(state, attack);
    return { ok: true };
  }

  // 暂停：等待目标响应（出闪或弃权）
  state.pending = { kind: 'respondSha', responderId: targetId, attack };
  return { ok: true };
}

/** 杀结算（目标已出闪或已弃权） */
function finishAttack(state: GameState, attack: AttackContext): void {
  const target = getPlayerOrThrow(state, attack.targetId);

  if (attack.dodged) {
    pushLog(state, 'resolve', `【杀】被闪避。`);
    runHooks(state, 'afterResolve', target, { attack });
    resumePlay(state, state.seatOrder[state.turn.seatIndex]!);
    return;
  }

  // 命中：造成伤害
  runHooks(state, 'beforeResolve', target, { attack });
  runHooks(state, 'damageDealt', target, { attack, damage: attack.damage });
  target.hp -= attack.damage;
  pushLog(
    state,
    'damage',
    `${target.name} 受到 ${attack.damage} 点伤害，剩余 ${Math.max(0, target.hp)} 体力。`,
  );
  runHooks(state, 'afterDamage', target, { attack, damage: attack.damage });
  runHooks(state, 'afterResolve', target, { attack });

  if (target.hp <= 0) {
    enterNearDeath(state, attack);
  } else {
    resumePlay(state, state.seatOrder[state.turn.seatIndex]!);
  }
}

// ——————————————————————————————————————————
// 濒死 / 死亡
// ——————————————————————————————————————————

function enterNearDeath(state: GameState, attack: AttackContext): void {
  const dying = getPlayerOrThrow(state, attack.targetId);
  runHooks(state, 'nearDeath', dying, { attack });
  // 从濒死者起、按座次轮询每个存活玩家能否出桃
  const queue = aliveSeatsFrom(state, dying.seatId);
  if (queue.length === 0) {
    doDeath(state, dying.seatId);
    return;
  }
  state.pending = {
    kind: 'respondDeath',
    dyingId: dying.seatId,
    askQueue: queue,
    askIndex: 0,
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
    if (alive.length === 1)
      return setWinner(state, alive[0]!.faction ?? alive[0]!.seatId);
    const factions = new Set(alive.map((p) => p.faction));
    if (factions.size === 1 && !factions.has('ambitionist')) {
      return setWinner(state, [...factions][0]!);
    }
    return false;
  }

  // melee：最后存活者胜
  if (alive.length <= 1) {
    if (alive.length === 1) return setWinner(state, alive[0]!.seatId);
    return setWinner(state, '');
  }
  return false;
}

function doDeath(state: GameState, dyingId: string): void {
  const dying = getPlayerOrThrow(state, dyingId);
  dying.alive = false;
  dying.hp = 0;
  // 阵亡：手牌 / 装备 / 判定区全部进弃牌堆
  for (const c of dying.hand) state.discard.push(c);
  dying.hand = [];
  const eq = dying.equipment;
  for (const c of [eq.weapon, eq.armor, eq.plusMount, eq.minusMount]) {
    if (c) state.discard.push(c);
  }
  dying.equipment = emptyEquipment();
  for (const c of dying.judgment) state.discard.push(c);
  dying.judgment = [];
  // 国战：阵亡时亮双将
  if (state.mode === 'guozhan') {
    dying.heroRevealed = true;
    dying.deputyRevealed = true;
  }
  const roleText = dying.role ? `（${ROLE_NAME[dying.role]}）` : '';
  const factionText = dying.faction ? `（${FACTION_NAME[dying.faction]}）` : '';
  pushLog(state, 'death', `${dying.name} 阵亡${roleText}${factionText}。`);
  runHooks(state, 'death', dying, {});

  if (checkWin(state)) return;
  // 回到当前回合玩家（伤害来源）的出牌阶段
  resumePlay(state, state.seatOrder[state.turn.seatIndex]!);
}

// ——————————————————————————————————————————
// 意图分发
// ——————————————————————————————————————————

export function applyIntent(
  state: GameState,
  seatId: string,
  intent: Intent,
): ApplyResult {
  if (state.gameOver) return err('游戏已结束');
  // 选将阶段优先处理（并发：所有未选将的座位同时可行动）
  if (state.draft) return onPickHero(state, seatId, intent);
  const pending = state.pending;
  if (!pending) return err('当前无需行动');

  switch (intent.type) {
    case 'playCard':
      return onPlayCard(state, seatId, intent);
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
    default:
      return err('未知意图');
  }
}

function onPlayCard(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'playCard' }>,
): ApplyResult {
  const pending = state.pending!;
  if (pending.kind !== 'play' || pending.seatId !== seatId)
    return err('不是你的出牌阶段');
  const player = getPlayerOrThrow(state, seatId);
  const card = player.hand.find((c) => c.id === intent.cardId);
  if (!card) return err('你没有这张牌');

  const as = intent.as ?? card.type;
  // 转化合法性（武圣：红牌当杀）
  if (intent.as && intent.as !== card.type) {
    const heroes = activeHeroes(state, player);
    if (!heroes.some((h) => heroCanUseAs(h, card, intent.as!)))
      return err('不能将该牌转化为该类型');
  }

  if (as === 'sha') return playSha(state, player, card, intent.targetIds, as);
  if (as === 'tao') return playTao(state, player, card);
  if (as === 'jiu') return playJiu(state, player, card);
  if (isEquipCard(card)) return playEquip(state, player, card);
  if (isDelayedTrick(card)) return playDelayedTrick(state, player, card, intent.targetIds);
  if (isInstantTrick(card)) return playTrick(state, player, card, intent);
  return err('该牌不能在出牌阶段主动使用');
}

function playTao(
  state: GameState,
  player: Player,
  card: import('@sgs/protocol').Card,
): ApplyResult {
  if (player.hp >= player.maxHp) return err('体力已满，不能使用桃');
  removeCard(player.hand, card.id);
  state.discard.push(card);
  player.hp++;
  pushLog(state, 'tao', `${player.name} 使用了【桃】，回复 1 点体力。`);
  runHooks(state, 'useCard', player, { card });
  return { ok: true };
}

function playJiu(
  state: GameState,
  player: Player,
  card: import('@sgs/protocol').Card,
): ApplyResult {
  removeCard(player.hand, card.id);
  state.discard.push(card);
  player.flags.jiuActive = true;
  pushLog(state, 'jiu', `${player.name} 使用了【酒】，下一张杀伤害+1。`);
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
  if (old) state.discard.push(old);
  player.equipment[slot] = card;
  const name = card.equipName ? EQUIP_NAME[card.equipName] : CARD_TYPE_NAME[card.type];
  pushLog(state, 'equip', `${player.name} 装备了【${name}】。`);
  runHooks(state, 'useCard', player, { card });
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
    if (player.judgment.some((t) => t.type === 'shandian'))
      return err('你的判定区已有【闪电】');
    removeCard(player.hand, card.id);
    player.judgment.push(card);
    pushLog(state, 'shandian', `${player.name} 将【闪电】置于自己的判定区。`);
    runHooks(state, 'useCard', player, { card });
    return { ok: true };
  }
  // 乐不思蜀 / 兵粮寸断：目标为其他存活玩家，距离≤1
  if (targetIds.length !== 1) return err('需指定 1 名目标');
  const targetId = targetIds[0]!;
  if (targetId === player.seatId) return err('不能以自己为目标');
  const target = getPlayer(state, targetId);
  if (!target || !target.alive) return err('目标无效');
  if (distance(state, player.seatId, targetId) > 1)
    return err('目标超出距离1');
  if (target.judgment.some((t) => t.type === type))
    return err('目标判定区已有同类延时锦囊');
  removeCard(player.hand, card.id);
  target.judgment.push(card);
  pushLog(
    state,
    type,
    `${player.name} 将【${CARD_TYPE_NAME[type]}】置于 ${target.name} 的判定区。`,
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
    if (type === 'shunshou' && distance(state, player.seatId, tid) > 1)
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
    if (!canTarget(state, holderId!, shaTargetId!))
      return err('出杀目标超出武器持有者攻击范围');
  } else if (type === 'nanman' || type === 'wanjian') {
    // AOE：无需指定目标
  }

  // 出牌
  removeCard(player.hand, card.id);
  state.discard.push(card);
  pushLog(state, 'trick', `${player.name} 使用了【${CARD_TYPE_NAME[type]}】。`);
  runHooks(state, 'useCard', player, { card });

  // 构建 TrickContext
  const ctx: TrickContext = {
    sourceId: player.seatId,
    card,
    responders: [],
    responderIndex: 0,
    targetId: type === 'guohe' || type === 'shunshou' || type === 'juedou' || type === 'huogong'
      ? intent.targetIds[0]
      : undefined,
    targetCardId: intent.targetCardId,
    shaTargetId: type === 'jiedao' ? intent.targetIds[1] : undefined,
  };

  // AOE：所有其他存活玩家按座次依次响应
  if (type === 'nanman' || type === 'wanjian') {
    const sourceIdx = state.seatOrder.indexOf(player.seatId);
    ctx.responders = aliveSeatsFrom(
      state,
      state.seatOrder[nextAliveSeat(state, sourceIdx)]!,
    ).filter((s) => s !== player.seatId);
  }
  // 单目标响应锦囊：responders = [target]
  if (type === 'juedou' || type === 'huogong' || type === 'jiedao') {
    ctx.responders = [intent.targetIds[0]!];
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
  return { ok: true };
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
          p.hp++;
          pushLog(state, 'tao', `${p.name} 回复 1 点体力。`);
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
  const card = pickTargetCard(state, target, ctx.targetCardId);
  if (card) {
    state.discard.push(card);
    pushLog(
      state,
      'trick',
      `${getPlayer(state, ctx.sourceId)!.name} 拆了 ${target.name} 的【${cardLabel(card)}】。`,
    );
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
  const card = pickTargetCard(state, target, ctx.targetCardId);
  if (card) {
    source.hand.push(card);
    pushLog(
      state,
      'trick',
      `${source.name} 从 ${target.name} 处获得了【${cardLabel(card)}】。`,
    );
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
): import('@sgs/protocol').Card | null {
  // 指定的明牌区牌（装备/判定）
  if (targetCardId) {
    const eq = target.equipment;
    for (const slot of ['weapon', 'armor', 'plusMount', 'minusMount'] as const) {
      const c = eq[slot];
      if (c?.id === targetCardId) {
        eq[slot] = null;
        return c;
      }
    }
    const ji = target.judgment.findIndex((c) => c.id === targetCardId);
    if (ji >= 0) {
      const [c] = target.judgment.splice(ji, 1);
      return c ?? null;
    }
  }
  // 随机手牌
  if (target.hand.length > 0) {
    const idx = Math.floor(Math.random() * target.hand.length);
    const [c] = target.hand.splice(idx, 1);
    return c ?? null;
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
  if (pick.type === 'weapon') eq.weapon = null;
  else if (pick.type === 'armor') eq.armor = null;
  else if (pick.type === 'plusMount') eq.plusMount = null;
  else if (pick.type === 'minusMount') eq.minusMount = null;
  else {
    const ji = target.judgment.findIndex((c) => c.id === pick.id);
    if (ji >= 0) target.judgment.splice(ji, 1);
  }
  return pick;
}

/** 决斗：目标先出杀，交替进行 */
function resolveJuedou(state: GameState, ctx: TrickContext): void {
  const targetId = ctx.responders[0]!;
  const target = getPlayer(state, targetId);
  if (!target || !target.alive) {
    resumePlay(state, ctx.sourceId);
    return;
  }
  pushLog(state, 'trick', `${target.name} 需打出【杀】或受 1 点伤害。`);
  state.pending = { kind: 'respondTrick', responderId: targetId, ctx: { ...ctx, duelTurn: 'target' } };
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

/** AOE：进入第一个响应者的 respondTrick */
function enterTrickResponse(state: GameState, ctx: TrickContext): void {
  // 跳过已阵亡的响应者
  while (ctx.responderIndex < ctx.responders.length) {
    const r = getPlayer(state, ctx.responders[ctx.responderIndex]!);
    if (r && r.alive) break;
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
  if (card.type !== 'sha') return err('决斗需打出【杀】');
  removeCard(responder.hand, card.id);
  state.discard.push(card);
  pushLog(state, 'trick', `${responder.name} 打出了【杀】。`);
  // 切换出杀方
  const newTurn = ctx.duelTurn === 'target' ? 'source' : 'target';
  const newResponderId = newTurn === 'source' ? ctx.sourceId : ctx.responders[0]!;
  const newResponder = getPlayer(state, newResponderId);
  if (!newResponder || !newResponder.alive) {
    // 对方已死 → 本方胜，无伤害
    resumePlay(state, ctx.sourceId);
    return { ok: true };
  }
  pushLog(state, 'trick', `轮到 ${newResponder.name} 打出【杀】或受 1 点伤害。`);
  state.pending = { kind: 'respondTrick', responderId: newResponderId, ctx: { ...ctx, duelTurn: newTurn } };
  return { ok: true };
}

function passDuel(state: GameState, seatId: string, ctx: TrickContext): ApplyResult {
  const victim = getPlayerOrThrow(state, seatId);
  pushLog(state, 'trick', `${victim.name} 弃权，受到 1 点伤害。`);
  const attack: AttackContext = {
    sourceId: ctx.sourceId,
    cardId: ctx.card.id,
    asType: ctx.card.type,
    targetId: victim.seatId,
    damage: 1,
    dodged: false,
  };
  runHooks(state, 'damageDealt', victim, { damage: 1, attack });
  victim.hp -= 1;
  pushLog(state, 'damage', `${victim.name} 受到 1 点伤害，剩余 ${Math.max(0, victim.hp)} 体力。`);
  runHooks(state, 'afterDamage', victim, { damage: 1, attack });
  if (victim.hp <= 0) {
    enterNearDeath(state, attack);
  } else {
    resumePlay(state, ctx.sourceId);
  }
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
  state.discard.push(card);
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
  pushLog(state, 'damage', `${target.name} 受到 1 点火属性伤害，剩余 ${Math.max(0, target.hp)} 体力。`);
  runHooks(state, 'afterDamage', target, { damage: 1, attack });
  if (target.hp <= 0) {
    enterNearDeath(state, attack);
  } else {
    resumePlay(state, ctx.sourceId);
  }
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
  state.discard.push(card);
  pushLog(
    state,
    'trick',
    `${holder.name} 对 ${shaTarget.name} 使用了【杀】。`,
  );
  // 进入正常的杀响应流程
  const attack: AttackContext = {
    sourceId: holder.seatId,
    cardId: card.id,
    asType: 'sha',
    targetId: shaTargetId,
    damage: 1,
    dodged: false,
    requiredShan: 1,
  };
  runHooks(state, 'useCard', holder, { card });
  if (!runHooks(state, 'becomeTarget', shaTarget, { attack })) {
    attack.dodged = true;
    finishAttack(state, attack);
    return { ok: true };
  }
  state.pending = { kind: 'respondSha', responderId: shaTargetId, attack };
  return { ok: true };
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
    pushLog(state, 'trick', `${holder.name} 将【${EQUIP_NAME[weapon.equipName!] ?? '武器'}】交给 ${source.name}。`);
  } else {
    state.discard.push(weapon);
  }
  resumePlay(state, ctx.sourceId);
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
  if (card.type !== 'sha') return err('南蛮入侵需打出【杀】');
  removeCard(responder.hand, card.id);
  state.discard.push(card);
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
  if (card.type !== 'shan') return err('万箭齐发需打出【闪】');
  removeCard(responder.hand, card.id);
  state.discard.push(card);
  pushLog(state, 'trick', `${responder.name} 打出了【闪】。`);
  advanceTrick(state, ctx);
  return { ok: true };
}

/** AOE 弃权：受 1 点伤害，可能触发濒死中断 */
function passAoeTrick(state: GameState, seatId: string, ctx: TrickContext): ApplyResult {
  const victim = getPlayerOrThrow(state, seatId);
  pushLog(state, 'trick', `${victim.name} 弃权，受到 1 点伤害。`);
  const attack: AttackContext = {
    sourceId: ctx.sourceId,
    cardId: ctx.card.id,
    asType: ctx.card.type,
    targetId: victim.seatId,
    damage: 1,
    dodged: false,
  };
  runHooks(state, 'damageDealt', victim, { damage: 1, attack });
  victim.hp -= 1;
  pushLog(state, 'damage', `${victim.name} 受到 1 点伤害，剩余 ${Math.max(0, victim.hp)} 体力。`);
  runHooks(state, 'afterDamage', victim, { damage: 1, attack });
  if (victim.hp <= 0) {
    // 濒死中断：暂存 trick 上下文，救人/死亡后恢复
    state.ongoingTrick = ctx;
    enterNearDeath(state, attack);
  } else {
    advanceTrick(state, ctx);
  }
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
  if (card.type !== 'wuxie') return err('只能使用【无懈可击】');
  removeCard(responder.hand, card.id);
  state.discard.push(card);
  pushLog(
    state,
    'trick',
    `${responder.name} 使用了【无懈可击】，取消了【${CARD_TYPE_NAME[pending.ctx.card.type as import('@sgs/protocol').CardType]}】。`,
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
  state.discard.push(card);
  pending.attack.dodged = true;
  pushLog(state, 'shan', `${responder.name} 使用了【闪】。`);
  finishAttack(state, pending.attack);
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
  if (card.type !== 'tao' && card.type !== 'jiu' && !heroes.some((h) => heroCanUseAs(h, card, 'tao')))
    return err('只能用【桃】（或【酒】当桃）救人');
  // 酒当桃救人：限1次/回合
  if (card.type === 'jiu' && saver.flags.taoSaveCountThisTurn > 0)
    return err('本回合已用过酒救人');
  removeCard(saver.hand, card.id);
  state.discard.push(card);
  if (card.type === 'jiu') saver.flags.taoSaveCountThisTurn++;
  const dying = getPlayerOrThrow(state, pending.dyingId);
  dying.hp = Math.max(dying.hp, 0) + 1;
  pushLog(
    state,
    'tao',
    `${saver.name} 使用了【${card.type === 'tao' ? '桃' : '酒'}】，${dying.name} 回复 1 点体力。`,
  );
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
      doDeath(state, pending.dyingId);
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
  return err('当前不能弃权');
}

function onEndPhase(state: GameState, seatId: string): ApplyResult {
  const pending = state.pending!;
  if (pending.kind !== 'play' || pending.seatId !== seatId)
    return err('不是你的出牌阶段');
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
  if (pending.kind !== 'discard' || pending.seatId !== seatId)
    return err('不是你的弃牌阶段');
  const player = getPlayerOrThrow(state, seatId);
  if (intent.cardIds.length !== pending.count)
    return err(`需弃 ${pending.count} 张牌`);
  for (const id of intent.cardIds) {
    if (!player.hand.some((c) => c.id === id)) return err('弃的牌不在手中');
  }
  for (const id of intent.cardIds) {
    const c = removeCard(player.hand, id);
    if (c) state.discard.push(c);
  }
  pushLog(state, 'discard', `${player.name} 弃了 ${intent.cardIds.length} 张牌。`);
  endTurn(state);
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
  if (intent.heroId === player.heroId) {
    if (player.heroRevealed) return err('主将已亮');
    player.heroRevealed = true;
    const hero = getHero(player.heroId);
    pushLog(state, 'reveal', `${player.name} 亮将：${hero?.name ?? '未知'}。`);
  } else if (intent.heroId === player.deputyHeroId) {
    if (player.deputyRevealed) return err('副将已亮');
    player.deputyRevealed = true;
    const hero = getHero(player.deputyHeroId);
    pushLog(state, 'reveal', `${player.name} 亮将：${hero?.name ?? '未知'}。`);
  } else {
    return err('该武将不是你的武将');
  }
  return { ok: true };
}

/** 主动技能：出牌阶段使用武将主动技能 */
function onUseSkill(
  state: GameState,
  seatId: string,
  intent: Extract<Intent, { type: 'useSkill' }>,
): ApplyResult {
  const pending = state.pending!;
  if (pending.kind !== 'play' || pending.seatId !== seatId)
    return err('不是你的出牌阶段');
  const player = getPlayerOrThrow(state, seatId);
  const heroes = activeHeroes(state, player);
  // 查找技能
  let skill: ActiveSkill | undefined;
  for (const hero of heroes) {
    skill = hero.activeSkills?.find((s) => s.id === intent.skillId);
    if (skill) break;
  }
  if (!skill) return err('你没有这个技能');
  // 检查可用性
  if (!skill.canUse(state, player)) return err('该技能当前不可使用');
  // 限 1 次/回合
  if (skill.oncePerTurn && player.flags.skillUsedThisTurn[skill.id])
    return err('该技能本回合已使用');
  // 目标数校验
  if (
    intent.targetIds.length < skill.minTargets ||
    intent.targetIds.length > skill.maxTargets
  )
    return err(`目标数量不符（需 ${skill.minTargets}-${skill.maxTargets}）`);
  // 弃牌校验
  if (skill.needsCards) {
    if (!intent.cardIds || intent.cardIds.length === 0)
      return err('该技能需要弃牌');
    for (const id of intent.cardIds) {
      if (!player.hand.some((c) => c.id === id)) return err('弃的牌不在手中');
    }
  }
  // 标记已使用（执行前标记，防重入）
  if (skill.oncePerTurn) player.flags.skillUsedThisTurn[skill.id] = true;
  // 执行
  const result = skill.execute(state, player, intent);
  if (typeof result === 'string') {
    // 执行失败：回滚标记
    if (skill.oncePerTurn) player.flags.skillUsedThisTurn[skill.id] = false;
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
  opts?: { mode?: GameMode; heroDealCount?: number },
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

  // 随机发将：每人从洗牌后的武将池独立发 k 张，保证同一玩家不重复
  // 国战排除中立武将（阵营武将池 16 个）
  const poolHeroes = isGuozhan ? HEROES.filter((h) => h.faction !== 'neutral') : HEROES;
  const heroIds = poolHeroes.map((h) => h.id);
  const deals: Record<string, string[]> = {};
  for (const s of seats) {
    deals[s.seatId] = shuffle(heroIds).slice(0, k);
  }

  const state: GameState = {
    roomCode,
    mode,
    players,
    seatOrder,
    deck: shuffle(buildDeck()),
    discard: [],
    turn: { seatIndex: 0, phase: 'draft' },
    pending: null,
    draft: { deals, pendingSeats: seatOrder.slice() },
    started: true,
    gameOver: false,
    winner: null,
    log: [],
    ongoingTrick: null,
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
    if (mainHero.faction !== deputyHero.faction)
      return err('国战需选 2 位同阵营武将');
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
        p.maxHp = Math.ceil((main.maxHp + deputy.maxHp) / 2);
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
