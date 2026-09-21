/**
 * 「弃置一张**手牌**」与「弃置一张**牌**」必须严格区分（用户 2026-09-21 口径）：
 *
 * - 文本写「手牌」的技能 → 只能从手牌出（拿装备区凑数要被**拒**）；
 * - 文本写「一张牌 / 任意张牌 / 一张装备牌」的技能 → 手牌 **+ 自己装备区**都可以
 *   （取装备要先把槽清掉、并派「失去装备」那类钩子）；
 * - 主动技的代价**永远不含判定区**。
 *
 * 实现载体：`ActiveSkill.costFrom`（缺省 'hand'）+ `onUseSkill` 的区域校验 +
 * `api.discardCard/discardCards`（本来就认两个区、会派钩子）。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, getHero, toSnapshot, type GameState } from '../src';
import type { Card } from '@sgs/protocol';

const A = 's0';
const B = 's1';
const ok = (r: { ok: boolean; error?: string }, tag = ''): void => {
  if (!r.ok) throw new Error(`${tag} 意图被拒：${r.error}`);
};
const act = (s: GameState, seat: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(s, seat, i);
const mk = (id: string, type: Card['type'], suit: Card['suit'], rank = 1): Card => ({
  id,
  type,
  suit,
  rank,
});
const wpn = (id: string): Card => ({ ...mk(id, 'weapon', 'spade', 5), equipName: 'qinggang', range: 2 });
const armor = (id: string): Card => ({ ...mk(id, 'armor', 'club', 2), equipName: 'bagua' });
const sha = (id: string) => mk(id, 'sha', 'spade');

function gz(
  seats: { seatId: string; name: string; heroId: string; hand?: Card[]; equip?: Card[] }[],
): GameState {
  const state = createGame(
    seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  for (const s of seats) {
    const p = state.players.find((x) => x.seatId === s.seatId)!;
    const hero = getHero(s.heroId)!;
    p.heroId = s.heroId;
    p.faction = hero.faction;
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.maxHp = Math.max(1, Math.floor(hero.maxHp));
    p.hp = p.maxHp;
    p.hand = (s.hand ?? []).slice();
    for (const c of s.equip ?? []) {
      if (c.type === 'weapon') p.equipment.weapon = c;
      if (c.type === 'armor') p.equipment.armor = c;
    }
    p.flags = emptyFlags();
  }
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
  state.log = [];
  return state;
}
const equipOf = (state: GameState, seat: string, slot: 'weapon' | 'armor') =>
  state.players.find((p) => p.seatId === seat)!.equipment[slot];

describe('代价牌的区域：手牌 vs 牌（用户 2026-09-21 口径）', () => {
  it('「弃置任意张牌」的制衡：可以拿**已经装备**的牌当代价（槽清空 + 进弃牌堆 + 摸等量）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'sunquan', hand: [sha('a1')], equip: [wpn('w1')] },
      { seatId: B, name: '乙', heroId: 'guanyu', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    state.deck = [sha('d1'), sha('d2')];
    // 代价 = 装备区那把武器 + 手里那张杀
    ok(act(state, A, { type: 'useSkill', skillId: 'zhiheng', cardIds: ['w1', 'a1'], targetIds: [] }));
    expect(equipOf(state, A, 'weapon')).toBeNull(); // 装备槽被摘下来了
    expect(state.discard.some((c) => c.id === 'w1')).toBe(true); // 进弃牌堆
    expect(state.discard.some((c) => c.id === 'a1')).toBe(true);
    expect(a.hand.map((c) => c.id).sort()).toEqual(['d1', 'd2']); // 摸等量（顺序按牌堆顶来）
    expect(state.log.some((l) => l.message.includes('弃 2 张牌'))).toBe(true);
  });

  it('只装备区有牌也能发动制衡（canUse 不能只看手牌）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'sunquan', hand: [], equip: [armor('w1')] },
      { seatId: B, name: '乙', heroId: 'guanyu', hand: [] },
    ]);
    const prompt = toSnapshot(state, A).prompt!;
    expect(prompt.legalSkillIds ?? []).toContain('zhiheng');
    state.deck = [sha('d1')];
    ok(act(state, A, { type: 'useSkill', skillId: 'zhiheng', cardIds: ['w1'], targetIds: [] }));
    expect(equipOf(state, A, 'armor')).toBeNull();
  });

  it('文本写「手牌」的技能**不许**拿装备区凑数（青囊）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'huatuo', hand: [], equip: [wpn('w1')] },
      { seatId: B, name: '乙', heroId: 'guanyu', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.hp = 2;
    // 手上没牌、装备区有牌 → 青囊（弃一张**手牌**）必须拒绝
    const res = act(state, A, { type: 'useSkill', skillId: 'qingnang', cardIds: ['w1'], targetIds: [B] });
    expect(res.ok, '青囊不该接受装备区的牌').toBe(false);
    expect(equipOf(state, A, 'weapon')).not.toBeNull(); // 也没有被拿走
  });

  it('代价永远不含判定区：把判定区的牌当代价要被拒', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'sunquan', hand: [sha('a1')], equip: [] },
      { seatId: B, name: '乙', heroId: 'guanyu', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.judgment.push({ ...mk('j1', 'lebu', 'spade', 6) });
    const res = act(state, A, { type: 'useSkill', skillId: 'zhiheng', cardIds: ['j1'], targetIds: [] });
    expect(res.ok).toBe(false);
    expect(a.judgment.map((c) => c.id)).toEqual(['j1']);
  });
});
