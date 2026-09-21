/**
 * **拼点区**（牌桌中央那块独立 UI 的数据侧）——用户 2026-09-23 的规格：
 *
 * > 拼点开始时…初始状态下显示双方各自的一张空牌位；任意一方完成选择后，对应牌位应**先以牌背**
 * > 朝上的形式展示，**不能提前暴露牌面**；只有当双方都完成选择后，才**同时翻开**两张牌，
 * > 展示具体牌面与点数…（胜负/平点都要明确展示）
 *
 * 这一版把「不能提前暴露」放在**服务端**：`PindianView.sides[].card` 在双方都扣好之前
 * **连字段都不写**（与盲选同一条规矩——不发，比「发了让界面别显示」可靠得多）。
 * 界面那一半（牌背入场 / 翻牌 / 胜负展示）在 `packages/ui` 的 PindianTable 里。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, toSnapshot, type GameState } from '../src';
import type { Card, PindianView } from '@sgs/protocol';

const A = 's0';
const B = 's1';
const C = 's2';

const mk = (id: string, type: Card['type'], suit: Card['suit'], rank: number): Card => ({
  id,
  type,
  suit,
  rank,
});

/**
 * 甲=太史慈（天义：与一名其他角色拼点），乙=被拼的一方。
 * 两张拼点牌刻意用**不同花色点数**，并且点数大小由用例决定（甲 13 / 乙 5 ⇒ 甲赢）。
 */
function gz(aRank: number, bRank: number): GameState {
  const state = createGame(
    [
      { seatId: A, name: '甲', heroId: 'taishici' },
      { seatId: B, name: '乙', heroId: 'vanilla' },
      { seatId: C, name: '丙', heroId: 'vanilla' },
    ],
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  const HERO: Record<string, string> = { [A]: 'taishici', [B]: 'vanilla', [C]: 'vanilla' };
  for (const p of state.players) {
    p.heroId = HERO[p.seatId]!;
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.maxHp = 4;
    p.hp = 4;
    p.hand = [];
    p.flags = emptyFlags();
  }
  const a = state.players.find((p) => p.seatId === A)!;
  const b = state.players.find((p) => p.seatId === B)!;
  a.hand = [mk('a1', 'sha', 'heart', aRank), mk('a2', 'sha', 'club', 3)];
  b.hand = [mk('b1', 'tao', 'spade', bRank)];
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: A };
  state.log = [];
  return state;
}

const act = (state: GameState, seatId: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(state, seatId, i);
const ok = (r: ReturnType<typeof applyIntent>) => {
  if (!r.ok) throw new Error(`预期成功但失败：${r.error}`);
};
const pindianOf = (state: GameState, seat: string): PindianView | null | undefined =>
  toSnapshot(state, seat).pindian;
const sideOf = (v: PindianView | null | undefined, seatId: string) =>
  v?.sides.find((s) => s.seatId === seatId);

describe('拼点区：先空位 → 牌背 → 双方扣好才翻牌', () => {
  it('开局两个空牌位：谁都没扣好，且**没有任何牌面**下发', () => {
    const state = gz(13, 5);
    ok(act(state, A, { type: 'useSkill', skillId: 'tianyi', targetIds: [B] }));
    // 天义先问「目标有没有手牌」→ 直接进第一张扣牌询问，此时拼点区已建好
    const v = pindianOf(state, A)!;
    expect(v).toBeTruthy();
    expect(v.revealed).toBe(false);
    expect(v.sides.map((s) => s.seatId)).toEqual([A, B]);
    expect(v.sides.map((s) => s.chosen)).toEqual([false, false]);
    expect(v.sides[0]!.isInitiator).toBe(true);
    // ⭐ 核心断言：还没人扣牌 ⇒ 两个牌位都没有 card/point，且整份快照里不含牌面信息
    expect(v.sides.every((s) => s.card === undefined && s.point === undefined)).toBe(true);
    const raw = JSON.stringify(v);
    expect(raw).not.toContain('"heart"');
    expect(raw).not.toContain('"spade"');
    expect(raw).not.toContain('13');
    expect(raw).not.toContain('5');
  });

  it('甲扣好后：他那格 chosen=true（界面画**牌背**），仍然没有牌面；乙那格还是空位', () => {
    const state = gz(13, 5);
    ok(act(state, A, { type: 'useSkill', skillId: 'tianyi', targetIds: [B] }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    const v = pindianOf(state, B)!; // 对手（乙）看到的同一块区域
    expect(v.sides.map((s) => s.chosen)).toEqual([true, false]);
    expect(sideOf(v, A)!.card, '甲扣好但还没翻牌 ⇒ 不给牌面').toBeUndefined();
    expect(sideOf(v, A)!.point).toBeUndefined();
    const raw = JSON.stringify(v);
    expect(raw).not.toContain('"heart"');
    expect(raw).not.toContain('13');
  });

  it('双方扣好 → 同时翻开：牌面 + 点数 + 赢家；两边看到的完全一致', () => {
    const state = gz(13, 5);
    ok(act(state, A, { type: 'useSkill', skillId: 'tianyi', targetIds: [B] }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    const vA = pindianOf(state, A)!;
    const vB = pindianOf(state, B)!;
    expect(vA).toEqual(vB); // 公开信息：两边一模一样
    expect(vA.revealed).toBe(true);
    expect(sideOf(vA, A)!.card?.id).toBe('a1');
    expect(sideOf(vA, B)!.card?.id).toBe('b1');
    expect(sideOf(vA, A)!.point).toBe(13);
    expect(sideOf(vA, B)!.point).toBe(5);
    expect(vA.winnerSeatId).toBe(A);
    expect(vA.tie).toBe(false);
  });

  it('平点：两张点数相同 → winnerSeatId 为 null 且 tie=true（界面要显示平局）', () => {
    const state = gz(9, 9);
    ok(act(state, A, { type: 'useSkill', skillId: 'tianyi', targetIds: [B] }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    const v = pindianOf(state, C)!; // 旁观者也看得到（公开信息）
    expect(v.revealed).toBe(true);
    expect(v.winnerSeatId).toBeNull();
    expect(v.tie).toBe(true);
    expect(sideOf(v, A)!.point).toBe(9);
    expect(sideOf(v, B)!.point).toBe(9);
  });

  it('结果留到下一次行动：没人动就一直挂着，谁一动手就收起', () => {
    const state = gz(13, 5);
    ok(act(state, A, { type: 'useSkill', skillId: 'tianyi', targetIds: [B] }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    expect(pindianOf(state, A)?.revealed).toBe(true);
    // 甲再动一手（打出另一张牌）→ 拼点区收起，牌桌中央让位
    ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [B] }));
    expect(pindianOf(state, A) ?? null).toBeNull();
  });

  it('拼点没法开始（目标没手牌）时不留空壳', () => {
    const state = gz(13, 5);
    const b = state.players.find((p) => p.seatId === B)!;
    b.hand = [];
    const r = act(state, A, { type: 'useSkill', skillId: 'tianyi', targetIds: [B] });
    expect(r.ok, '天义要求目标有手牌').toBe(false);
    expect(pindianOf(state, A) ?? null).toBeNull();
    expect(JSON.stringify(state.log)).not.toContain('拼点');
  });
});
