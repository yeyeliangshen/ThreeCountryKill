import type { Intent } from '@sgs/protocol';
import {
  alivePlayers,
  aliveSeatsFrom,
  getPlayer,
  getPlayerOrThrow,
  nextAliveSeat,
  pushLog,
  type AttackContext,
  type GameState,
  type Pending,
  type Player,
} from './model';
import { buildDeck, drawOne, shuffle } from './deck';
import { HEROES, getHero, heroCanUseAs, heroShaLimit } from './heroes';
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

// 在某时机运行玩家自身武将的触发钩子。返回 false 表示被取消。
function runHooks(
  state: GameState,
  timing: Timing,
  player: Player,
  payload?: unknown,
): boolean {
  const hero = getHero(player.heroId);
  const hooks = hero?.hooks?.filter((h) => h.timing === timing) ?? [];
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
  state.turn = { seatIndex, phase: 'draw' };
  const player = getPlayerOrThrow(state, state.seatOrder[seatIndex]!);
  // 回合开始重置本回合标记
  player.flags = { shaCountThisTurn: 0, jiuActive: false };
  runHooks(state, 'turnStart', player);

  // 摸牌阶段：摸 2 张
  state.turn.phase = 'draw';
  runHooks(state, 'drawPhase', player);
  for (let i = 0; i < 2; i++) {
    const c = drawOne(state);
    if (c) player.hand.push(c);
  }
  pushLog(state, 'draw', `${player.name} 摸了 2 张牌。`);

  // 出牌阶段
  state.turn.phase = 'play';
  runHooks(state, 'playPhase', player);
  state.pending = { kind: 'play', seatId: player.seatId };
}

function endTurn(state: GameState): void {
  if (state.gameOver) return;
  const cur = getPlayerOrThrow(state, state.seatOrder[state.turn.seatIndex]!);
  runHooks(state, 'turnEnd', cur);
  const next = nextAliveSeat(state, state.turn.seatIndex);
  if (next === state.turn.seatIndex) {
    state.gameOver = true;
    state.pending = null;
    state.turn.phase = 'gameOver';
    return;
  }
  startTurn(state, next);
}

/** 回到某玩家的出牌阶段（伤害结算后恢复来源回合） */
function resumePlay(state: GameState, sourceId: string): void {
  if (state.gameOver) return;
  const source = getPlayer(state, sourceId);
  if (!source || !source.alive) {
    endTurn(state);
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
  const hero = getHero(source.heroId)!;
  if (source.flags.shaCountThisTurn >= heroShaLimit(hero))
    return err('本回合出杀数已达上限');
  if (targetIds.length !== 1) return err('杀需指定 1 名目标');
  const targetId = targetIds[0]!;
  if (targetId === source.seatId) return err('不能对自己使用杀');
  const target = getPlayer(state, targetId);
  if (!target || !target.alive) return err('目标无效');

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
  };
  pushLog(state, 'sha', `${source.name} 对 ${target.name} 使用了【杀】。`);
  runHooks(state, 'useCard', source, { attack });
  runHooks(state, 'becomeTarget', target, { attack });

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
    resumePlay(state, attack.sourceId);
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
    resumePlay(state, attack.sourceId);
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

function doDeath(state: GameState, dyingId: string): void {
  const dying = getPlayerOrThrow(state, dyingId);
  dying.alive = false;
  dying.hp = 0;
  // 阵亡：手牌 / 装备 / 判定区全部进弃牌堆
  for (const c of dying.hand) state.discard.push(c);
  dying.hand = [];
  for (const c of dying.equipment) state.discard.push(c);
  dying.equipment = [];
  for (const c of dying.judgment) state.discard.push(c);
  dying.judgment = [];
  pushLog(state, 'death', `${dying.name} 阵亡。`);
  runHooks(state, 'death', dying, {});

  const alive = alivePlayers(state);
  if (alive.length <= 1) {
    state.gameOver = true;
    state.pending = null;
    state.turn.phase = 'gameOver';
    if (alive.length === 1) {
      pushLog(state, 'gameover', `游戏结束，${alive[0]!.name} 获胜。`);
    } else {
      pushLog(state, 'gameover', '游戏结束。');
    }
    return;
  }
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
    const hero = getHero(player.heroId)!;
    if (!heroCanUseAs(hero, card, intent.as)) return err('不能将该牌转化为该类型');
  }

  if (as === 'sha') return playSha(state, player, card, intent.targetIds, as);
  if (as === 'tao') return playTao(state, player, card);
  if (as === 'jiu') return playJiu(state, player, card);
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
  if (card.type !== 'shan') return err('只能用【闪】响应');
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
  if (card.type !== 'tao' && card.type !== 'jiu')
    return err('只能用【桃】（或【酒】当桃）救人');
  removeCard(saver.hand, card.id);
  state.discard.push(card);
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
  return err('当前不能弃权');
}

function onEndPhase(state: GameState, seatId: string): ApplyResult {
  const pending = state.pending!;
  if (pending.kind !== 'play' || pending.seatId !== seatId)
    return err('不是你的出牌阶段');
  const player = getPlayerOrThrow(state, seatId);
  // 进入弃牌阶段
  state.turn.phase = 'discard';
  runHooks(state, 'discardPhase', player);
  const over = player.hand.length - handLimit(player);
  if (over > 0) {
    state.pending = { kind: 'discard', seatId, count: over };
  } else {
    endTurn(state);
  }
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

// ——————————————————————————————————————————
// 建局
// ——————————————————————————————————————————

const DEFAULT_HERO_DEAL_COUNT = 3;

export function createGame(
  seats: SeatSetup[],
  roomCode: string,
  heroDealCount?: number,
): GameState {
  // 发将数 K，钳制在 [1, 5]
  const k = Math.max(1, Math.min(5, heroDealCount ?? DEFAULT_HERO_DEAL_COUNT));
  const players: Player[] = seats.map((s) => ({
    seatId: s.seatId,
    name: s.name,
    heroId: null, // 选将阶段未定
    hp: 0,
    maxHp: 0,
    hand: [],
    equipment: [],
    judgment: [],
    alive: true,
    flags: { shaCountThisTurn: 0, jiuActive: false },
  }));
  const seatOrder = seats.map((s) => s.seatId);

  // 随机发将：把武将池重复到足够张数，洗牌后每人发 k 张
  // （首期池仅 3 个，允许跨玩家重复，待武将库扩充后再做全局唯一）
  const poolNeeded = seats.length * k;
  const heroPool: string[] = [];
  while (heroPool.length < poolNeeded) {
    for (const h of HEROES) heroPool.push(h.id);
  }
  const shuffledPool = shuffle(heroPool).slice(0, poolNeeded);
  const deals: Record<string, string[]> = {};
  for (const s of seats) {
    deals[s.seatId] = shuffledPool.splice(0, k);
  }

  const state: GameState = {
    roomCode,
    players,
    seatOrder,
    deck: shuffle(buildDeck()),
    discard: [],
    turn: { seatIndex: 0, phase: 'draft' },
    pending: null,
    draft: { deals, pendingSeats: seatOrder.slice() },
    started: true,
    gameOver: false,
    log: [],
  };
  pushLog(state, 'start', '游戏开始，随机发将。');
  return state;
}

// ——————————————————————————————————————————
// 选将阶段
// ——————————————————————————————————————————

function onPickHero(state: GameState, seatId: string, intent: Intent): ApplyResult {
  if (intent.type !== 'pickHero') return err('选将阶段：请选择 1 位武将');
  const draft = state.draft;
  if (!draft) return err('当前不在选将阶段');
  if (!draft.pendingSeats.includes(seatId)) return err('你已经选过将了');
  const options = draft.deals[seatId];
  if (!options || !options.includes(intent.heroId)) return err('该武将不在你发到的将中');
  const player = getPlayerOrThrow(state, seatId);
  player.heroId = intent.heroId;
  draft.pendingSeats = draft.pendingSeats.filter((s) => s !== seatId);
  pushLog(state, 'pickHero', `${player.name} 已选定武将。`);
  if (draft.pendingSeats.length === 0) finishDraft(state);
  return { ok: true };
}

/** 全员选完：设定武将体力、发初始手牌、进入第一回合 */
function finishDraft(state: GameState): void {
  for (const p of state.players) {
    const hero = getHero(p.heroId) ?? getHero('vanilla')!;
    p.maxHp = hero.maxHp;
    p.hp = hero.maxHp;
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
  startTurn(state, 0);
}
