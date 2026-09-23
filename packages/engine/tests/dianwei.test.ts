/**
 * **典韦·【强袭】**（用户 2026-09-26 口径：现行移动版文本）。
 *
 * 现行文本：「出牌阶段限一次，你可以**弃置一张武器牌，或对你造成 1 点伤害**，
 * 然后对你攻击范围内的一名其他角色造成 1 点伤害。」
 *
 * ⚠️ 用户特别强调：代价的第一项是「**造成 1 点伤害**」，**不是**「失去 1 点体力」——
 *    这不是措辞差异，两者**触发的技能链完全不同**：
 *    - **伤害**：走完整伤害层 ⇒ 卖血技（「受到伤害后」）触发、有**伤害来源**（＝典韦自己）、
 *      铁索传导 / 护心镜 / 减伤 全都参与；
 *    - **失去体力**：一个都不触发，也没有来源。
 *    旧实现用的是 `api.loseHp`（见 docs §5.234）。
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

interface Seat {
  seatId: string;
  name: string;
  heroId: string;
  deputy?: string;
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
    p.deputyHeroId = s.deputy ?? null;
    p.faction = s.faction ?? getHeroForMode(s.heroId, 'guozhan')?.faction ?? 'qun';
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.hand = (s.hand ?? []).slice();
    p.flags = emptyFlags();
    const main = getHeroForMode(s.heroId, 'guozhan')!;
    const dep = p.deputyHeroId ? getHeroForMode(p.deputyHeroId, 'guozhan')! : undefined;
    if (dep) {
      const mainHp = main.maxHp - (main.mainSlotHalfYang ? 1 : 0);
      const depHp = dep.maxHp - (dep.deputySlotHalfYang ? 1 : 0);
      p.maxHp = Math.floor((mainHp + depHp) / 2);
    } else {
      p.maxHp = main.maxHp;
    }
    p.hp = s.hp ?? p.maxHp;
  }
  const idx = state.seatOrder.indexOf(turnSeat);
  state.turn = { seatIndex: idx < 0 ? 0 : idx, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[state.turn.seatIndex]! };
  state.log = [];
  return state;
}
/** 典韦（甲） + 陪坐：乙在攻击范围内 */
function table(me: Partial<Seat> = {}, others: Partial<Seat>[] = []): GameState {
  return gz([
    { seatId: 's0', name: '甲', heroId: 'dianwei', faction: 'wei', hand: [], ...me },
    { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wu', ...(others[0] ?? {}) },
    { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun', ...(others[1] ?? {}) },
  ]);
}

describe('【强袭】的代价是「对自己造成 1 点伤害」（不是失去体力）', () => {
  it('代价选项里明确写着「对自己造成 1 点伤害」', () => {
    const state = table();
    ok(act(state, 's0', { type: 'useSkill', skillId: 'qiangxi', targetIds: ['s1'] }));
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.options.map((o) => o.id)).toEqual(['selfDamage']);
      expect(state.pending.options[0]!.label).toContain('对自己造成 1 点伤害');
    }
  });

  it('**走完整伤害层**：伤害来源＝典韦自己（`loseHp` 会把它清空）', () => {
    const state = table();
    ok(act(state, 's0', { type: 'useSkill', skillId: 'qiangxi', targetIds: ['s1'] }));
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'selfDamage' }));
    // 自伤 1 点：典韦 4 → 3，并且**留下了伤害来源**（这是「伤害」与「失去体力」最硬的区别）
    expect(at(state, 's0').hp).toBe(3);
    expect(state.lastDamageSourceId, '来源＝典韦自己').toBe('s0');
    // 日志也必须是**伤害**那一类（`loseHp` 写的是「失去 1 点体力」，两者的日志 kind 都不同）
    expect(
      state.log.some((e) => e.kind === 'damage' && e.message.includes('甲 受到 1 点伤害')),
      '走的是伤害层（不是失去体力）',
    ).toBe(true);
    expect(
      state.log.some((e) => e.message.includes('失去 1 点体力') || e.message.includes('失去 1 点体力')),
      '没有「失去体力」那条日志',
    ).toBe(false);
  });

  it('**触发卖血技**：典韦 + 郭嘉（国战双将）自伤 ⇒ 【遗计】发动摸两张', () => {
    // 旧实现（失去体力）下这条必然红：卖血技一次都不会触发
    const state = table({ deputy: 'guojia' });
    state.deck = [mk('d1', 'sha', 'club', 9), mk('d2', 'sha', 'spade', 9)];
    let guard = 0;
    ok(act(state, 's0', { type: 'useSkill', skillId: 'qiangxi', targetIds: ['s1'] }));
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'selfDamage' }));
    // 遗计是「可以」⇒ 会问一句
    while (state.pending?.kind === 'choice' && guard++ < 4) {
      const p = state.pending;
      if (!p.title.includes('遗计')) break;
      ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }));
    }
    expect(
      at(state, 's0').hand.map((c) => c.id).sort(),
      '自伤触发了遗计 ⇒ 摸了两张',
    ).toEqual(['d1', 'd2']);
  });

  it('1 点体力时也能用（代价永远付得起）：自伤到 0 ⇒ 正常进濒死求桃，救回后照样打目标', () => {
    const state = table({ hp: 1, hand: [mk('t1', 'tao', 'heart', 3)] });
    ok(act(state, 's0', { type: 'useSkill', skillId: 'qiangxi', targetIds: ['s1'] }), '1 血也放行');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'selfDamage' }));
    expect(at(state, 's0').hp).toBeLessThanOrEqual(0);
    expect(state.pending?.kind, '自伤到 0 ⇒ 求桃').toBe('respondDeath');
    ok(act(state, 's0', { type: 'respondCard', cardId: 't1' }), '自己吃桃救回');
    expect(at(state, 's0').hp).toBe(1);
    // 救回来之后，那 1 点伤害照常落到目标头上
    expect(at(state, 's1').hp, '目标照样被打').toBe(at(state, 's1').maxHp - 1);
  });

  it('弃武器那一条不变（不扣血、武器进弃牌堆、目标照样受伤）', () => {
    const state = table();
    at(state, 's0').equipment.weapon = { ...mk('w1', 'weapon', 'spade', 6), equipName: 'qinggang', range: 2 } as Card;
    ok(act(state, 's0', { type: 'useSkill', skillId: 'qiangxi', targetIds: ['s1'] }));
    if (state.pending?.kind === 'choice') {
      expect(state.pending.options.map((o) => o.id)).toEqual(['selfDamage', 'weapon']);
    }
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'weapon' }));
    expect(at(state, 's0').equipment.weapon).toBeFalsy();
    expect(at(state, 's0').hp, '弃武器不掉血').toBe(at(state, 's0').maxHp);
    expect(state.discard.some((c) => c.id === 'w1')).toBe(true);
    expect(at(state, 's1').hp).toBe(at(state, 's1').maxHp - 1);
    expect(state.pending).toEqual({ kind: 'play', seatId: 's0' });
  });

  it('技能文本是现行口径（「对你造成 1 点伤害」）', () => {
    const desc = getHeroForMode('dianwei', 'guozhan')!.skills[0]!.desc ?? '';
    expect(desc).toContain('弃置一张武器牌，或对你造成 1 点伤害');
    expect(desc, '不再写「失去 1 点体力」').not.toContain('失去 1 点体力');
  });
});
