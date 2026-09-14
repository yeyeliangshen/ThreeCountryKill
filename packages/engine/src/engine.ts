import type { Faction, GameMode, Intent, RoleId } from '@sgs/protocol';
import { CARD_TYPE_NAME, EQUIP_NAME, isEquipCard } from '@sgs/protocol';
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
} from './model';
import { canTarget } from './distance';
import { buildDeck, drawOne, shuffle } from './deck';
import {
  HEROES,
  FACTION_NAME,
  getHero,
  heroCanUseAs,
  heroShaLimit,
  ROLE_NAME,
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
  state.turn = { seatIndex, phase: 'draw' };
  const player = getPlayerOrThrow(state, state.seatOrder[seatIndex]!);
  // 回合开始重置本回合标记
  player.flags = emptyFlags();
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
