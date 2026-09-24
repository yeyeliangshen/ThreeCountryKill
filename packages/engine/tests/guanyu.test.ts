/**
 * **关羽·【武圣】**（用户 2026-09-26 口径：现行移动版文本有两句）。
 *
 * - ①「你可以将一张**红色牌**当【杀】使用或打出」——仓库本来就有（`canUseAs` + `isRed`）；
 * - ②「**你使用方块【杀】无距离限制**」——本轮补上（原来只做了①）。
 *
 * 判据取的是**这张牌（对关羽而言）的花色**：
 * - 天然的【杀】花色是 ♦ ⇒ 放行；
 * - 武圣把一张 ♦ 牌（例如 ♦闪/♦桃）**转化成**【杀】用出去 ⇒ 牌面花色仍是 ♦ ⇒ 也放行
 *   （看的是那张牌本身，不是「打出去之后变成了什么」）；
 * - 虚拟牌没有实体花色（【丈八蛇矛】两张凑的、严白虎·寄篱造的）⇒ 不算方块 ⇒ 照常判距离。
 *
 * ⚠️ 只放宽**距离**：出杀次数、目标数上限都不受影响。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, getHeroForMode, type GameState } from '../src';
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
const sha = (id: string, suit: Card['suit']) => mk(id, 'sha', suit, 7);

interface Seat {
  seatId: string;
  name: string;
  heroId: string;
  faction?: Faction;
  hand?: Card[];
}
/** 4 人环形：甲(s0) 与 s1/s3 相邻（距离 1），与 s2 距离 2 */
function gz(seats: Seat[], turnSeat = 's0'): GameState {
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
/** 四家陪坐：甲＝被测的那位（关羽或对照组） */
function table(me: { heroId: string; hand: Card[] }): GameState {
  return gz([
    { seatId: 's0', name: '甲', heroId: me.heroId, faction: 'shu', hand: me.hand },
    { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
    { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' }, // 距离 2
    { seatId: 's3', name: '丁', heroId: 'lvmeng', faction: 'wu' },
  ]);
}

describe('【武圣】②：方块【杀】无距离限制', () => {
  it('方块【杀】可以打到距离 2 的人；♥【杀】不行（对照组）', () => {
    const state = table({ heroId: 'guanyu', hand: [sha('a1', 'diamond')] });
    ok(
      act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s2'] }),
      '♦杀打距离 2',
    );
    expect(state.pending?.kind, '照常进【闪】响应').toBe('respondSha');

    const heart = table({ heroId: 'guanyu', hand: [sha('a2', 'heart')] });
    const r = act(heart, 's0', { type: 'playCard', cardId: 'a2', targetIds: ['s2'] });
    expect(r.ok, '♥杀没有这条豁免').toBe(false);
    expect(String(r.error ?? '')).toContain('攻击范围');
  });

  it('不是关羽的人拿♦杀打距离 2 ⇒ 照常被拒（豁免只属于武圣）', () => {
    const state = table({ heroId: 'zhangfei', hand: [sha('a1', 'diamond')] });
    const r = act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s2'] });
    expect(r.ok).toBe(false);
  });

  it('武圣把一张 ♦ 牌**转化成**【杀】用出去 ⇒ 同样无距离限制（看的是那张牌的花色）', () => {
    // 一张 ♦闪，按【杀】使用（武圣：红牌当【杀】）——花色仍是 ♦
    const state = table({ heroId: 'guanyu', hand: [mk('a1', 'shan', 'diamond', 8)] });
    ok(
      act(state, 's0', {
        type: 'playCard',
        cardId: 'a1',
        as: 'sha',
        targetIds: ['s2'],
      }),
      '♦闪当杀打距离 2',
    );
    expect(state.pending?.kind).toBe('respondSha');
  });

  it('武圣把一张 ♥ 牌转化成【杀】⇒ 没有豁免（只有方块那一条）', () => {
    const state = table({ heroId: 'guanyu', hand: [mk('a2', 'tao', 'heart', 3)] });
    const r = act(state, 's0', {
      type: 'playCard',
      cardId: 'a2',
      as: 'sha',
      targetIds: ['s2'],
    });
    expect(r.ok, '♥桃当杀 ⇒ 照常判距离').toBe(false);
  });

  it('距离 1 的♦杀照常（豁免不改变近处的行为）', () => {
    const state = table({ heroId: 'guanyu', hand: [sha('a1', 'diamond')] });
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }), '打邻居');
  });

  it('只放宽**距离**：出杀次数照常计数（♦杀也是杀）', () => {
    const state = table({
      heroId: 'guanyu',
      hand: [sha('a1', 'diamond'), sha('a2', 'diamond')],
    });
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s2'] }), '第一张');
    ok(act(state, 's2', { type: 'pass' }), '丙不出闪');
    const second = act(state, 's0', { type: 'playCard', cardId: 'a2', targetIds: ['s2'] });
    expect(second.ok, '本回合第二张杀 ⇒ 次数上限照拦').toBe(false);
    expect(String(second.error ?? '')).toContain('上限');
  });

  it('技能文本是现行口径（两句都在）', () => {
    const desc = getHeroForMode('guanyu', 'guozhan')!.skills[0]!.desc ?? '';
    expect(desc).toContain('当【杀】使用或打出');
    expect(desc).toContain('你使用方块【杀】无距离限制');
  });
});
