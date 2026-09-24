/**
 * **魏延·【狂骨】**（用户 2026-09-26 口径：**一次伤害事件触发一次**）。
 *
 * 现行文本：「当你对一名角色**造成伤害后**，若其扣减体力前你计算与其的距离不大于 1，
 * 你可以选择一项：①回复 1 点体力；②摸一张牌。」
 *
 * ⚠️ 用户点名的正是「按点 / 按事件」这一类问题：2025-09-19 那批调整把狂骨从
 * 「每造成 **1 点**伤害后」（逐点问）改成「造成伤害后」（一次事件问一次）——
 * 酒【杀】2 点现在只问一次、最多回 1 点。
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
const jiu = (id: string) => mk(id, 'jiu', 'spade', 9);

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
/** 魏延（甲·2 血） + 乙（邻居） + 丙（距离 2） */
function table(): GameState {
  return gz([
    { seatId: 's0', name: '甲', heroId: 'weiyan', faction: 'shu', hand: [sha('a1'), jiu('a2')], hp: 2 },
    { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
    { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
    { seatId: 's3', name: '丁', heroId: 'lvmeng', faction: 'wu' },
  ]);
}

describe('【狂骨】：按**伤害事件**触发，不按点', () => {
  it('酒【杀】2 点 ⇒ **只问一次**；选回血只回 1 点（旧实现会问两次、回 2 点）', () => {
    const state = table();
    state.deck = [mk('d1', 'sha', 'club', 7), mk('d2', 'sha', 'club', 8), mk('d3', 'sha', 'club', 9)];
    ok(act(state, 's0', { type: 'playCard', cardId: 'a2', targetIds: [] }), '酒');
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }), '酒杀');
    ok(act(state, 's1', { type: 'pass' }), '乙不闪 ⇒ 挨 2 点');
    expect(at(state, 's1').hp).toBe(2);
    // 一次事件 ⇒ 一问
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.title).toContain('狂骨');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'heal' }));
    expect(at(state, 's0').hp, '只回 1 点').toBe(3);
    expect(state.pending, '没有第二问').toEqual({ kind: 'play', seatId: 's0' });
  });

  it('两次**独立**的伤害事件 ⇒ 各问一次（换而言之：不是「每回合一次」）', () => {
    const state = table();
    state.deck = [mk('d1', 'sha', 'club', 7), mk('d2', 'sha', 'club', 8)];
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }), '第 1 张杀');
    ok(act(state, 's1', { type: 'pass' }));
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'heal' }));
    expect(at(state, 's0').hp).toBe(3);
    // 第 2 个伤害事件（同一回合内）——注意【杀】有次数上限，这里换一张牌打：用【决斗】不便，
    // 直接让乙再挨一次（贾诩的乱武那种太重）⇒ 用「对丙的伤害」不行（距离 2）。
    // 所以走「弃牌阶段之外的第二次伤害」捷径：给乙再来一刀的是**虚拟杀**（丈八/寄篱不方便），
    // 这里改用最直接的：让乙自己受一次伤害（丙 用【杀】打乙），魏延不是来源 ⇒ 不该问。
    // ⇒ 真正要验的是「同一回合的第二个**自己造成的**伤害事件」：用【火攻】不方便，改用【决斗】打乙。
    at(state, 's0').hand.push(mk('a9', 'juedou', 'spade', 9));
    ok(act(state, 's0', { type: 'playCard', cardId: 'a9', targetIds: ['s1'] }), '决斗');
    while (state.pending?.kind === 'respondTrick' || state.pending?.kind === 'wuxieQueue') {
      const p = state.pending as { kind: string; responderId?: string; askQueue?: string[]; askIndex?: number };
      if (p.kind === 'wuxieQueue') ok(act(state, p.askQueue![p.askIndex!]!, { type: 'pass' }));
      else ok(act(state, p.responderId!, { type: 'pass' }));
    }
    expect(at(state, 's1').hp, '乙又挨 1 点（4→3→2）').toBe(2);
    // 第二个事件 ⇒ 再问一次
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.title).toContain('狂骨');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'draw' }));
    expect(at(state, 's0').hand.map((c) => c.id)).toContain('d2');
  });

  it('距离大于 1 ⇒ 不问（对照组）', () => {
    const state = table();
    state.deck = [mk('d1', 'sha', 'club', 7)];
    // 甲打丙（s2，距离 2）——需要无视距离：用【酒】+【杀】不行 ⇒ 换成先装武器
    at(state, 's0').equipment.weapon = { ...mk('w1', 'weapon', 'spade', 6), equipName: 'qinggang', range: 2 } as Card;
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s2'] }), '打距离 2');
    ok(act(state, 's2', { type: 'pass' }));
    expect(at(state, 's2').hp).toBe(3);
    expect(state.pending, '距离 2 ⇒ 狂骨不问').toEqual({ kind: 'play', seatId: 's0' });
  });

  it('技能文本去掉了「1 点」（现在是「造成伤害后」）', () => {
    const desc = getHeroForMode('weiyan', 'guozhan')!.skills[0]!.desc ?? '';
    expect(desc).toContain('当你对一名角色造成伤害后');
    expect(desc, '不再写「造成1点伤害后」').not.toContain('造成1点伤害后');
  });
});
