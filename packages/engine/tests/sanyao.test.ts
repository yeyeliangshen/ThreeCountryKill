/**
 * **散谣 / 挑衅**（用户 2026-09-26 裁定 §5.247 之 09/10 的落地）。
 *
 * - 散谣（马谡·君临天下·变，2013 印刷版已核）：文本「一名**体力值最大的角色**」**没有「其他」**
 *   ⇒ 按仓库统一口径（§5.209：能否选自己由文本决定）⇒ **可以选自己**——旧实现排除自己，
 *   违反自家口径，本轮修正。
 * - 挑衅（姜维）：官方通行文本带「**其他**」⇒ 排除自己（实现本来就对），本轮只把文案与
 *   报错信息补上「其他」二字。
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
const sha = (id: string) => mk(id, 'sha', 'spade', 7);

interface Seat {
  seatId: string;
  name: string;
  heroId: string;
  faction?: Faction;
  hand?: Card[];
  hp?: number;
}
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
    p.hp = s.hp ?? 4;
  }
  const idx = state.seatOrder.indexOf(turnSeat);
  state.turn = { seatIndex: idx < 0 ? 0 : idx, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[state.turn.seatIndex]! };
  state.log = [];
  return state;
}

describe('散谣：文本无「其他」⇒ 可以选自己（体力最大之一时）', () => {
  it('马谡自己是体力最大之一 ⇒ 把自己选为目标成立（对自己造成 1 点伤害）', () => {
    const state = gz([
      { seatId: 's0', name: '马谡', heroId: 'masu', faction: 'shu', hand: [sha('a1')], hp: 4 },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei', hp: 4 },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun', hp: 2 },
    ]);
    ok(
      act(state, 's0', { type: 'useSkill', skillId: 'sanyao', cardIds: ['a1'], targetIds: ['s0'] }),
      '选自己',
    );
    expect(at(state, 's0').hp, '对自己造成了 1 点').toBe(3);
    expect(state.log.some((e) => e.message.includes('散谣'))).toBe(true);
  });

  it('自己不是体力最大 ⇒ 仍不能选自己（条件不满足，不是「其他」限制）', () => {
    const state = gz([
      { seatId: 's0', name: '马谡', heroId: 'masu', faction: 'shu', hand: [sha('a1')], hp: 2 },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei', hp: 4 },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
    ]);
    const r = act(state, 's0', {
      type: 'useSkill',
      skillId: 'sanyao',
      cardIds: ['a1'],
      targetIds: ['s0'],
    });
    expect(r.ok).toBe(false);
    expect(String(r.error ?? '')).toContain('体力值最大');
  });

  it('选体力最大的别人照常（对照组）', () => {
    const state = gz([
      { seatId: 's0', name: '马谡', heroId: 'masu', faction: 'shu', hand: [sha('a1')], hp: 2 },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei', hp: 4 },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
    ]);
    ok(act(state, 's0', { type: 'useSkill', skillId: 'sanyao', cardIds: ['a1'], targetIds: ['s1'] }));
    expect(at(state, 's1').hp).toBe(3);
  });
});

describe('挑衅：官方文本带「其他」⇒ 排除自己（文案已补齐）', () => {
  it('文案含「其他」、选自己仍被拒', () => {
    const desc = getHeroForMode('jiangwei', 'guozhan')!.skills.find((s) => s.name === '挑衅')!.desc ?? '';
    expect(desc).toContain('其他角色');
    const state = gz([
      { seatId: 's0', name: '姜维', heroId: 'jiangwei', faction: 'shu', hand: [] },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
    ]);
    const r = act(state, 's0', { type: 'useSkill', skillId: 'tiaoxin', targetIds: ['s0'] });
    expect(r.ok).toBe(false);
    // 中央校验（onUseSkill 的 selfTarget 统一拦）在技能自己的检查之前就拒了——都算对
    expect(String(r.error ?? '')).toMatch(/不能以自己为目标|不能选择自己/);
  });
});
