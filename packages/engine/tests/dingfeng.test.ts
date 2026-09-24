/**
 * **丁奉·【奋迅】**（用户 2026-09-26 口径：现行文本）。
 *
 * 现行：「**出牌阶段开始时**，你可以选择一名其他角色：本回合你计算与其的距离视为 1。」
 * 旧版（仓库原状）：「出牌阶段限一次，你可以**弃置一张牌**并选择一名其他角色，
 * 然后本回合你计算与其的距离视为 1。」——两条差别：时机（主动技 → 阶段开始触发）、
 * 代价（要弃一张牌 → **不弃牌**）。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, distance, emptyFlags, getHeroForMode, type GameState } from '../src';
import type { Card, Faction } from '@sgs/protocol';

const ok = (r: { ok: boolean; error?: string }, tag = ''): void => {
  if (!r.ok) throw new Error(`${tag} 意图被拒：${r.error}`);
};
const act = (s: GameState, seat: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(s, seat, i);
const at = (s: GameState, seat: string) => s.players.find((p) => p.seatId === seat)!;
const mk = (id: string, type: Card['type'], suit: Card['suit'], rank = 1): Card => ({
  id,
  type,
  suit,
  rank,
});

interface Seat {
  seatId: string;
  name: string;
  heroId: string;
  faction?: Faction;
  hand?: Card[];
}
function gz(seats: Seat[], turnSeat: string): GameState {
  const state = createGame(
    seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  for (const s of seats) {
    const p = at(state, s.seatId);
    p.heroId = s.heroId;
    p.deputyHeroId = null;
    p.faction = s.faction ?? getHeroForMode(s.heroId, 'guozhan')?.faction ?? 'qun';
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.hand = (s.hand ?? []).slice();
    p.flags = emptyFlags();
    p.maxHp = 4;
    p.hp = 4;
  }
  const idx = state.seatOrder.indexOf(turnSeat);
  state.turn = { seatIndex: idx < 0 ? 0 : idx, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[state.turn.seatIndex]! };
  state.log = [];
  return state;
}
/** 4 人环：甲(丁奉) → 乙 → 丙(距离 2) → 丁；先手给乙，用于把回合交出去 */
function table(): GameState {
  return gz(
    [
      { seatId: 's0', name: '甲', heroId: 'dingfeng', faction: 'wu', hand: [mk('a1', 'sha', 'spade', 7), mk('a2', 'shan', 'heart', 2)] },
      { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu' },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      { seatId: 's3', name: '丁', heroId: 'lvmeng', faction: 'wu' },
    ],
    's1',
  );
}
/** 把回合一路交给甲（甲＝丁奉）：座次是 s1→s2→s3→s0，所以要连收三个回合 */
function handTurnToDingfeng(state: GameState): void {
  let guard = 0;
  while (state.pending?.kind !== 'choice' || (state.pending as { seatId?: string }).seatId !== 's0') {
    if (guard++ > 40) throw new Error('回合没能交到丁奉手上');
    const p = state.pending;
    if (!p) throw new Error('没有 pending');
    if (p.kind === 'play') {
      ok(act(state, (p as { seatId: string }).seatId, { type: 'endPhase' }), '结束出牌阶段');
    } else if (p.kind === 'discard') {
      ok(act(state, (p as { seatId: string }).seatId, { type: 'discard', cardIds: [] }), '弃牌');
    } else {
      throw new Error(`没料到的一格：${p.kind}`);
    }
  }
}

describe('【奋迅】：出牌阶段开始时问一次，选了就拉近距离，**不弃牌**', () => {
  it('出牌阶段开始时自动询问（不再是主动技）', () => {
    const state = table();
    expect(act(state, 's0', { type: 'useSkill', skillId: 'fenxun', targetIds: ['s2'] }).ok, '不再是主动技').toBe(false);
    handTurnToDingfeng(state);
    // 甲的出牌阶段开始 ⇒ 先问是否发动
    const p = state.pending;
    expect(p?.kind, '出牌阶段开始时的那一问').toBe('choice');
    if (p?.kind === 'choice') {
      expect(p.seatId).toBe('s0');
      expect(p.title).toContain('奋迅');
    }
  });

  it('发动并选距离 2 的人 ⇒ 距离变 1，且**一张牌都没弃**', () => {
    const state = table();
    handTurnToDingfeng(state);
    const handBefore = at(state, 's0').hand.map((c) => c.id).sort();
    expect(distance(state, 's0', 's2'), '选之前是距离 2').toBe(2);
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }), '发动');
    expect(state.pending?.kind, '在牌桌上点目标').toBe('pickSeats');
    if (state.pending?.kind === 'pickSeats') {
      expect(state.pending.candidates).toEqual(['s1', 's2', 's3']);
    }
    ok(act(state, 's0', { type: 'pickSeats', seatIds: ['s2'] }), '选丙');
    expect(at(state, 's0').flags.distanceToOneThisTurn).toBe('s2');
    expect(distance(state, 's0', 's2'), '距离视为 1').toBe(1);
    expect(distance(state, 's0', 's1'), '对别人的距离不受影响').toBe(1);
    expect(at(state, 's0').hand.map((c) => c.id).sort(), '不弃牌').toEqual(handBefore);
    expect(state.log.some((e) => e.message.includes('发动【奋迅】'))).toBe(true);
  });

  it('不发动 ⇒ 什么都不发生（对照组）', () => {
    const state = table();
    handTurnToDingfeng(state);
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'no' }));
    expect(at(state, 's0').flags.distanceToOneThisTurn).toBeNull();
    expect(distance(state, 's0', 's2')).toBe(2);
  });

  it('距离效果随回合结束清掉（「本回合」）', () => {
    const state = table();
    handTurnToDingfeng(state);
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, 's0', { type: 'pickSeats', seatIds: ['s2'] }));
    expect(distance(state, 's0', 's2')).toBe(1);
    ok(act(state, 's0', { type: 'endPhase' }), '甲结束出牌阶段');
    while (state.pending?.kind === 'discard') ok(act(state, 's0', { type: 'discard', cardIds: [] }));
    expect(at(state, 's0').flags.distanceToOneThisTurn, '回合结束清掉').toBeNull();
    expect(distance(state, 's0', 's2')).toBe(2);
  });

  it('文本是现行口径（出牌阶段开始时 / 不弃牌）', () => {
    const desc = getHeroForMode('dingfeng', 'guozhan')!.skills.find((s) => s.name === '奋迅')!.desc ?? '';
    expect(desc).toContain('出牌阶段开始时');
    expect(desc).not.toContain('弃置一张牌');
    expect(desc).not.toContain('限一次');
  });
});
