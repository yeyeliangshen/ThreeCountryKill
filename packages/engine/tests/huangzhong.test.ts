/**
 * **黄忠·【烈弓】**（用户 2026-09-26 口径：现行文本多了一条 **【乘势】**）。
 *
 * 现行：发动【烈弓】（令目标不能使用【闪】响应此【杀】）之后，**此【杀】对该目标伤害 +1**。
 * 仓库旧实现只做了「不可闪避」，没有这条加伤。
 *
 * 身份版条件：目标手牌数 ≥ 你 或 目标体力 ≤ 你；
 * 国战版条件：目标手牌数 ≥ 你的体力值 或 ≤ 你的攻击范围（两版都补了乘势）。
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

describe('【烈弓】+【乘势】：发动后此【杀】对该目标伤害 +1', () => {
  it('国战版条件命中（目标手牌数 ≥ 你的体力值）⇒ 不可闪避 **且伤害 2**', () => {
    // 黄忠 4 体力、1 张手牌；目标 4 张手牌 ⇒ 4 ≥ 4 ✓ 条件命中
    const state = gz([
      { seatId: 's0', name: '黄忠', heroId: 'huangzhong', faction: 'shu', hand: [sha('a1')] },
      {
        seatId: 's1',
        name: '乙',
        heroId: 'xuchu',
        faction: 'wei',
        hand: [mk('b1', 'shan', 'heart', 2), mk('b2', 'shan', 'heart', 3), mk('b3', 'shan', 'heart', 4), mk('b4', 'shan', 'heart', 5)],
      },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
    ]);
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }), '出杀');
    expect(state.log.some((e) => e.message.includes('不可闪避，且对其伤害 +1'))).toBe(true);
    if (state.pending?.kind === 'respondSha') {
      expect(state.pending.attack.requiredShan, '不可闪避').toBe(Infinity);
      ok(act(state, 's1', { type: 'pass' }), '出不了闪');
    }
    // **伤害 2**：这是【乘势】那条（旧实现只掉 1 点 ⇒ 这条用例是判别性的）
    expect(at(state, 's1').hp).toBe(2);
  });

  it('条件不命中 ⇒ 既不加伤也不禁闪（对照组）', () => {
    // 黄忠 4 体力、3 张手牌；目标 1 张手牌、攻击范围 1 ⇒ 1 ≥ 4 ✗、1 ≤ 1 ✓ ——
    // 国战条件是「或」，所以这里要让两条都不成立：目标手牌 2 张（≥4 ✗、≤1 ✗）
    const state = gz([
      {
        seatId: 's0',
        name: '黄忠',
        heroId: 'huangzhong',
        faction: 'shu',
        hand: [sha('a1'), mk('a2', 'shan', 'heart', 2), mk('a3', 'shan', 'heart', 3)],
      },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei', hand: [mk('b1', 'shan', 'heart', 2), mk('b2', 'shan', 'heart', 3)] },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
    ]);
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }), '出杀');
    expect(state.log.some((e) => e.message.includes('烈弓')), '没发动').toBe(false);
    if (state.pending?.kind === 'respondSha') {
      expect(state.pending.attack.requiredShan ?? 1, '照常可以闪').toBe(1);
      ok(act(state, 's1', { type: 'pass' }));
    }
    expect(at(state, 's1').hp, '伤害 1').toBe(3);
  });

  it('身份版（军争）同样有【乘势】', () => {
    const state = createGame(
      [
        { seatId: 's0', name: '黄忠', heroId: 'huangzhong' },
        { seatId: 's1', name: '乙', heroId: 'xuchu' },
        { seatId: 's2', name: '丙', heroId: 'lvbu' },
      ],
      'TEST',
      { mode: 'identity' },
    );
    state.draft = null;
    for (const p of state.players) {
      // ⚠️ 跳过选将阶段时 `createGame` 不会落 heroId（两个模式都一样）——夹具要自己指派
      p.heroId = p.seatId === 's0' ? 'huangzhong' : p.seatId === 's1' ? 'xuchu' : 'lvbu';
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.flags = emptyFlags();
      p.maxHp = 4;
      p.hp = 4;
    }
    at(state, 's0').hand = [sha('a1')];
    at(state, 's1').hand = [mk('b1', 'shan', 'heart', 2), mk('b2', 'shan', 'heart', 3)]; // 例：2 ≥ 1 ✓
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: 's0' };
    state.log = [];
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }), '出杀');
    if (state.pending?.kind === 'respondSha') ok(act(state, 's1', { type: 'pass' }));
    expect(at(state, 's1').hp, '身份版也是 2 点').toBe(2);
  });

  it('两版文本都写了【乘势】', () => {
    const idDesc = getHeroForMode('huangzhong', 'identity')!.skills.find((s) => s.name === '烈弓')!.desc ?? '';
    const gzDesc = getHeroForMode('huangzhong', 'guozhan')!.skills.find((s) => s.name === '烈弓')!.desc ?? '';
    expect(idDesc).toContain('乘势');
    expect(gzDesc).toContain('乘势');
    expect(gzDesc).toContain('伤害 +1');
  });
});
