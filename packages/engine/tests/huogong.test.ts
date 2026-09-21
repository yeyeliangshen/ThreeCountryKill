/**
 * 【火攻】的目标必须**有手牌**（用户 2026-09-22 报的缺陷）：
 * 火攻要目标「展示一张手牌」，没手牌的人根本没法结算 —— 既不该进可点目标列表，
 * 也不能被任何交互路径强行指定。
 *
 * 这一条钉的是**引擎侧的校验**（界面的过滤是另一半：见 Game.tsx 的 `selectedTargetNeedsHand`，
 * 两边必须同一口径）。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, type GameState } from '../src';
import type { Card } from '@sgs/protocol';

const A = 's0';
const B = 's1';
const C = 's2';
const mk = (id: string, type: Card['type'], suit: Card['suit'], rank = 1): Card => ({
  id,
  type,
  suit,
  rank,
});
const huogong = (id: string) => mk(id, 'huogong', 'heart', 2);

function gz(handB: Card[]): GameState {
  const state = createGame(
    [
      { seatId: A, name: '甲', heroId: 'guanyu' },
      { seatId: B, name: '乙', heroId: 'zhangfei' },
      { seatId: C, name: '丙', heroId: 'caocao' },
    ],
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  for (const p of state.players) {
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.maxHp = 4;
    p.hp = 4;
    p.hand = [];
    p.flags = emptyFlags();
  }
  const a = state.players.find((p) => p.seatId === A)!;
  const b = state.players.find((p) => p.seatId === B)!;
  a.hand = [huogong('h1')];
  b.hand = handB.slice();
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: A };
  state.log = [];
  return state;
}

describe('火攻：目标必须有手牌（用户 2026-09-22）', () => {
  it('目标没手牌 → 引擎拒绝，且牌没打出去', () => {
    const state = gz([]);
    const res = applyIntent(state, A, { type: 'playCard', cardId: 'h1', targetIds: [B] });
    expect(res.ok, '不能对没手牌的角色用【火攻】').toBe(false);
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand.map((c) => c.id)).toEqual(['h1']); // 牌还在手里
    expect(state.pending).toEqual({ kind: 'play', seatId: A }); // 控制权也没动
  });

  it('目标有手牌 → 照常结算（火攻要的是「展示一张手牌」）', () => {
    const state = gz([mk('b1', 'sha', 'spade', 5)]);
    const res = applyIntent(state, A, { type: 'playCard', cardId: 'h1', targetIds: [B] });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    // 火攻开局是「目标展示一张手牌」的响应窗口
    expect(['respondTrick', 'wuxieQueue']).toContain(state.pending?.kind);
  });

  it('另一个没手牌的旁观者不受影响（只有被指定的那个会被拦）', () => {
    const state = gz([mk('b1', 'sha', 'spade', 5)]);
    const c = state.players.find((p) => p.seatId === C)!;
    c.hand = [];
    expect(applyIntent(state, A, { type: 'playCard', cardId: 'h1', targetIds: [B] }).ok).toBe(true);
    expect(c.hand).toHaveLength(0);
  });
});
