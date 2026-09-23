/**
 * **【调虎离山】不能把游戏弄结束**（用户 2026-09-25 报的缺陷）。
 *
 * 牌面：「出牌阶段，对一至两名其他角色使用。直到回合结束为止，目标角色**不计入距离和座次的计算**，
 * 不能使用任何牌且不能成为任何牌的目标。」
 *
 * 「不计入座次」在本引擎里由 `flags.removedFromSeating` 承担（`nextAliveSeat` / `aliveSeatsFrom` /
 * `baseDistance` 三个收口）。缺陷出在**回合交接**：`afterTurnEnd` 里用
 * `nextAliveSeat(自己) === 自己` 当作「**场上只剩一个人**」⇒ 判胜负并结束游戏 ✗。
 * 可 3 人局把另外两家都调走时，下家当然算回自己 ✗ —— 他们只是**本回合不计入座次**，**人还在**，
 * 游戏绝不该结束（用户的原话：「调虎离山会导致游戏结束，我怀疑是导致场上只剩一个势力导致的」）。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, getHeroForMode, toSnapshot, type GameState } from '../src';
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
const tiaohu = (id: string) => mk(id, 'tiaohu', 'heart', 2);

interface Seat {
  seatId: string;
  name: string;
  heroId: string;
  faction?: Faction;
  hand?: Card[];
}
function gz(seats: Seat[], turnSeat = 's0'): GameState {
  const state = createGame(
    seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
    'TEST',
    { mode: 'guozhan', packs: { shibei: true } },
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

describe('【调虎离山】不会把游戏弄结束', () => {
  it('3 人局把另外两家都调走 ⇒ 绝不「游戏结束」，回合正常交接', () => {
    const state = gz([
      { seatId: 's0', name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [tiaohu('a1')] },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
    ]);
    ok(
      act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1', 's2'] }),
      '调走另外两家',
    );
    expect(at(state, 's1').flags.removedFromSeating, '乙已被移出座次').toBe(true);
    expect(at(state, 's2').flags.removedFromSeating).toBe(true);
    // 结束甲的回合：这才是原缺陷的现场（下家算回自己 ⇒ 误判「只剩 1 人」）
    ok(act(state, 's0', { type: 'endPhase' }), '结束出牌阶段');
    while (state.pending?.kind === 'discard') {
      ok(act(state, 's0', { type: 'discard', cardIds: [] }));
    }
    expect(state.gameOver, '游戏绝不能结束').toBe(false);
    expect(state.winner, '没有胜方').toBe(null);
    expect(state.log.some((e) => e.message.includes('游戏结束')), '没有「游戏结束」日志').toBe(
      false,
    );
    // 回合正常交给下一位（乙）；标记也在回合结束时清了
    expect(at(state, 's1').flags.removedFromSeating, '「直到回合结束」⇒ 已清').toBe(false);
    expect(state.seatOrder[state.turn.seatIndex], '回合交给了乙').toBe('s1');
  });

  it('4 人局调走一个人 ⇒ 不结束，且回合交接仍然跳过被移出座次的那位', () => {
    const state = gz([
      { seatId: 's0', name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [tiaohu('a1')] },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      { seatId: 's3', name: '丁', heroId: 'lvmeng', faction: 'wu' },
    ]);
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }), '调走乙');
    ok(act(state, 's0', { type: 'endPhase' }), '结束出牌阶段');
    while (state.pending?.kind === 'discard') {
      ok(act(state, 's0', { type: 'discard', cardIds: [] }));
    }
    expect(state.gameOver).toBe(false);
    // 座次口径不变：被移出的乙在本回合的座次计算里被跳过（docs 记录的既有口径）
    expect(state.seatOrder[state.turn.seatIndex], '跳过乙，轮到丙').toBe('s2');
  });

  it('2 人局把唯一对手调走 ⇒ 也不结束（人还在，只是这一回合不算座次）', () => {
    const state = gz([
      { seatId: 's0', name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [tiaohu('a1')] },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
    ]);
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }), '调走乙');
    ok(act(state, 's0', { type: 'endPhase' }), '结束出牌阶段');
    while (state.pending?.kind === 'discard') {
      ok(act(state, 's0', { type: 'discard', cardIds: [] }));
    }
    expect(state.gameOver, '不能因为对手被调走就判甲胜').toBe(false);
    expect(state.seatOrder[state.turn.seatIndex], '轮到乙').toBe('s1');
  });

  it('真的只剩一人时**仍然照常结束**（别把兜底判胜一起修没了）', () => {
    const state = gz([
      { seatId: 's0', name: '甲', heroId: 'zhangfei', faction: 'shu' },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
    ]);
    at(state, 's1').alive = false; // 乙阵亡（模拟）
    ok(act(state, 's0', { type: 'endPhase' }), '结束出牌阶段');
    while (state.pending?.kind === 'discard') {
      ok(act(state, 's0', { type: 'discard', cardIds: [] }));
    }
    expect(state.gameOver, '只剩一个活人 ⇒ 该结束就结束').toBe(true);
  });

  it('快照把「移出座次」作为**公开状态**下发（界面据此画标记）', () => {
    const state = gz([
      { seatId: 's0', name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [tiaohu('a1')] },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
    ]);
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }), '调走乙');
    // 三个人的视角都看得到（公开信息：牌面文本就写着、日志也点名了）
    for (const viewer of ['s0', 's1', 's2']) {
      const snap = toSnapshot(state, viewer);
      expect(snap.players.find((p) => p.seatId === 's1')!.removedFromSeating, `${viewer} 也能看到`).toBe(
        true,
      );
      expect(snap.players.find((p) => p.seatId === 's0')!.removedFromSeating).toBeUndefined();
    }
  });

  it('被移出座次的人**仍然算势力存活数**（胜负与鏖战都不该因此变化）', () => {
    const state = gz([
      { seatId: 's0', name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [tiaohu('a1')] },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      { seatId: 's3', name: '丁', heroId: 'lvmeng', faction: 'wu' },
    ]);
    const before = toSnapshot(state, 's0').players.map((p) => `${p.seatId}:${p.faction}`).join(',');
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }), '调走乙');
    const after = toSnapshot(state, 's0').players.map((p) => `${p.seatId}:${p.faction}`).join(',');
    expect(after, '势力快照一字不变').toBe(before);
  });
});
