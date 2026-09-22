/**
 * 用户 2026-09-22 报的两个缺陷：
 * ① 【木牛流马】装备后点它没反应（存牌/使用流程进不去）；
 * ② 暗将无法通过「主动发动技能」的方式明置。
 *
 * 这里只测**引擎侧**：技能注册 / 可用条件 / pending 交互流程（界面那半另有人工与真机验证）。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, getHero, toSnapshot, type GameState } from '../src';
import type { Card } from '@sgs/protocol';

const A = 's0';
const B = 's1';
const C = 's2';
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
const sha = (id: string) => mk(id, 'sha', 'spade', 5);

function gz(seats: { seatId: string; name: string; heroId: string; deputy?: string; hand?: Card[] }[]): GameState {
  const state = createGame(
    seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  for (const s of seats) {
    const p = state.players.find((x) => x.seatId === s.seatId)!;
    p.heroId = s.heroId; // 直接指定武将牌（绕开选将）
    p.deputyHeroId = s.deputy ?? s.heroId;
    p.maxHp = 4;
    p.hp = 4;
    p.faction = getHero(s.heroId)!.faction;
    p.hand = (s.hand ?? []).slice();
    p.flags = emptyFlags();
    p.heroRevealed = false;
    p.deputyRevealed = false;
  }
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
  state.log = [];
  return state;
}

describe('木牛流马：装备后的存牌技能要能被「列出 + 发动」', () => {
  it('装备【木牛流马】后：出牌提示里列出它的技能，发动后能把一张手牌扣置到装备牌下', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'guanyu', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'zhangfei' },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.treasure = { ...mk('m1', 'treasure', 'heart', 5), equipName: 'muniu' };
    const prompt = toSnapshot(state, A).prompt!;
    expect(prompt.legalSkillIds ?? [], '出牌提示要列出【木牛流马】').toContain('muniu');
    expect((prompt.legalSkills ?? []).find((s) => s.id === 'muniu')?.name).toBe('木牛流马');
    // 发动 → 选一张手牌 → 扣置到装备牌下
    ok(act(state, A, { type: 'useSkill', skillId: 'muniu', cardIds: [], targetIds: [] }));
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    expect(a.equipment.treasure?.cargo?.map((c) => c.id)).toEqual(['a1']);
    expect(a.hand.map((c) => c.id)).toEqual(['a2']);
  });

  it('没装备【木牛流马】时不列这个技能；手牌为空时也不可用', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'guanyu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhangfei' },
    ]);
    expect(toSnapshot(state, A).prompt!.legalSkillIds ?? []).not.toContain('muniu');
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.treasure = { ...mk('m1', 'treasure', 'heart', 5), equipName: 'muniu' };
    a.hand = [];
    expect(toSnapshot(state, A).prompt!.legalSkillIds ?? []).not.toContain('muniu');
  });
});

describe('暗将：主动发动技能要能「自动明置该武将」', () => {
  it('暗置的孙权用【制衡】→ 孙权被明置，且技能照常结算', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'sunquan', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhangfei' },
      { seatId: C, name: '丙', heroId: 'caocao' },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.heroRevealed).toBe(false);
    // 暗将的主动技也应当列在出牌提示里（点了就等于「明置 + 发动」）
    expect(toSnapshot(state, A).prompt!.legalSkillIds ?? [], '暗将的主动技也要列').toContain(
      'zhiheng',
    );
    state.deck = [sha('d1')];
    ok(act(state, A, { type: 'useSkill', skillId: 'zhiheng', cardIds: ['a1'], targetIds: [] }));
    expect(a.heroRevealed, '发动技能后该武将应当明置').toBe(true);
    expect(state.log.some((l) => l.message.includes('亮将：孙权'))).toBe(true);
  });

  it('副将暗置、主将已明置：发动副将的技能也要明置副将（且不动已有的势力）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'guanyu', deputy: 'sunquan', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'zhangfei' },
      { seatId: C, name: '丙', heroId: 'caocao' },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.heroRevealed = true; // 主将关羽已明置（蜀）
    a.deputyRevealed = false;
    expect(toSnapshot(state, A).prompt!.legalSkillIds ?? []).toContain('zhiheng');
    state.deck = [sha('d1')];
    ok(act(state, A, { type: 'useSkill', skillId: 'zhiheng', cardIds: ['a1'], targetIds: [] }));
    expect(a.deputyRevealed, '发动副将技能后副将应当明置').toBe(true);
    expect(a.faction).toBe(getHero('guanyu')!.faction);
  });
});
