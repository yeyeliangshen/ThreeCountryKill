/**
 * **乐进·【骁果】**（用户 2026-09-26 口径：目标**弃装备**这一项要**让乐进摸一张牌**）。
 *
 * 现行文本：「其他角色的结束阶段，你可以弃置一张基本牌，令该角色选择一项：
 * **弃置一张装备牌，然后你摸一张牌**；或受到你造成的 1 点伤害。」
 * （仓库旧实现只有「弃装备 / 受伤」两选一，**弃装备那条没有收益**——用户报的正是这一条。）
 *
 * ⚠️ 只有**成功弃置装备**那一支才摸：选「受伤」不摸；目标没有装备可弃而**改判受伤**的那条也不摸。
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
const wpn = (id: string): Card => ({
  ...mk(id, 'weapon', 'spade', 6),
  equipName: 'qinggang',
  range: 2,
});

interface Seat {
  seatId: string;
  name: string;
  heroId: string;
  faction?: Faction;
  hand?: Card[];
  equip?: Card;
}
function gz(seats: Seat[], turnSeat: string): GameState {
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
    if (s.equip) p.equipment.weapon = s.equip;
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
/** 甲＝乐进（魏），乙＝回合玩家（有武器、手里一张基本牌），丙＝陪坐 */
function table(opts: { targetEquip?: boolean } = {}): GameState {
  return gz(
    [
      { seatId: 's0', name: '乐进', heroId: 'yuejin', faction: 'wei', hand: [mk('y1', 'sha', 'spade', 7)] },
      {
        seatId: 's1',
        name: '乙',
        heroId: 'xuchu',
        faction: 'wu',
        hand: [],
        ...(opts.targetEquip === false ? {} : { equip: wpn('w1') }),
      },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun', hand: [] },
    ],
    's1',
  );
}
/** 把乙的回合推到结束阶段（会挂上【骁果】的询问） */
function endTargetTurn(state: GameState): void {
  ok(act(state, 's1', { type: 'endPhase' }), '结束阶段');
  while (state.pending?.kind === 'discard') ok(act(state, 's1', { type: 'discard', cardIds: [] }));
}
/** 乐进发动骁果（弃一张基本牌） */
function activate(state: GameState): void {
  const p = state.pending;
  expect(p?.kind, '乐进被问「是否发动」').toBe('choice');
  if (p?.kind === 'choice') expect(p.seatId).toBe('s0');
  ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }));
  ok(act(state, 's0', { type: 'pickCards', cardIds: ['y1'] }), '弃一张基本牌');
}

describe('【骁果】：目标弃装备 ⇒ **乐进摸一张牌**', () => {
  it('弃装备那一支：目标装备进弃牌堆，乐进摸一张（牌堆顶那张）', () => {
    const state = table();
    endTargetTurn(state);
    // ⚠️ 牌堆要**够大**：骁果摸完还要轮到丙摸牌，牌堆见底会触发「弃牌堆重洗」，
    //    刚进弃牌堆的那件装备会被洗回牌堆 ⇒ 「装备进了弃牌堆」这条断言会假红（踩过一次）。
    state.deck = [
      mk('d0', 'sha', 'club', 3),
      mk('d1', 'tao', 'heart', 4),
      mk('d2', 'sha', 'club', 5),
      mk('d3', 'sha', 'club', 6),
      mk('d4', 'sha', 'club', 7),
      mk('d5', 'sha', 'club', 8),
    ];
    activate(state);
    // 轮到乙选：选项里写明了乐进会摸牌
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.seatId, '由目标自己选').toBe('s1');
      expect(state.pending.options.find((o) => o.id === 'discard')?.label).toContain('乐进 摸一张牌');
    }
    ok(act(state, 's1', { type: 'chooseOption', optionId: 'discard' }), '选弃装备');
    ok(act(state, 's1', { type: 'chooseOption', optionId: 'weapon' }), '弃武器');
    // 乐进摸了牌堆**顶**那张（本仓库的牌堆是栈：数组末尾是顶 ⇒ 最后一张 d5）
    // 旧实现到这里手牌不会有变化 ⇒ 这条用例是判别性的
    expect(at(state, 's0').hand.map((c) => c.id)).toContain('d5');
    expect(at(state, 's1').equipment.weapon).toBeFalsy();
    expect(state.discard.some((c) => c.id === 'w1')).toBe(true);
    expect(state.log.some((e) => e.message.includes('因【骁果】摸了 1 张牌'))).toBe(true);
  });

  it('选「受到 1 点伤害」那一支：**不摸牌**（对照组）', () => {
    const state = table();
    endTargetTurn(state);
    // ⚠️ 牌堆要**够大**：骁果摸完还要轮到丙摸牌，牌堆见底会触发「弃牌堆重洗」，
    //    刚进弃牌堆的那件装备会被洗回牌堆 ⇒ 「装备进了弃牌堆」这条断言会假红（踩过一次）。
    state.deck = [
      mk('d0', 'sha', 'club', 3),
      mk('d1', 'tao', 'heart', 4),
      mk('d2', 'sha', 'club', 5),
      mk('d3', 'sha', 'club', 6),
      mk('d4', 'sha', 'club', 7),
      mk('d5', 'sha', 'club', 8),
    ];
    activate(state);
    ok(act(state, 's1', { type: 'chooseOption', optionId: 'damage' }), '选受伤');
    expect(at(state, 's1').hp).toBe(3);
    expect(at(state, 's0').hand.map((c) => c.id), '没有多摸').toEqual([]);
  });

  it('目标没有装备牌可弃 ⇒ 只剩「受伤」一项，也不摸牌', () => {
    const state = table({ targetEquip: false });
    endTargetTurn(state);
    // ⚠️ 牌堆要**够大**：骁果摸完还要轮到丙摸牌，牌堆见底会触发「弃牌堆重洗」，
    //    刚进弃牌堆的那件装备会被洗回牌堆 ⇒ 「装备进了弃牌堆」这条断言会假红（踩过一次）。
    state.deck = [
      mk('d0', 'sha', 'club', 3),
      mk('d1', 'tao', 'heart', 4),
      mk('d2', 'sha', 'club', 5),
      mk('d3', 'sha', 'club', 6),
      mk('d4', 'sha', 'club', 7),
      mk('d5', 'sha', 'club', 8),
    ];
    activate(state);
    const p = state.pending;
    expect(p?.kind).toBe('choice');
    if (p?.kind === 'choice') {
      expect(p.options.map((o) => o.id)).toEqual(['damage']);
    }
    ok(act(state, 's1', { type: 'chooseOption', optionId: 'damage' }));
    expect(at(state, 's1').hp).toBe(3);
    expect(at(state, 's0').hand.map((c) => c.id)).toEqual([]);
  });

  it('技能文本写明了「然后你摸一张牌」', () => {
    const desc = getHeroForMode('yuejin', 'guozhan')!.skills[0]!.desc ?? '';
    expect(desc).toContain('弃置一张装备牌，然后你摸一张牌');
  });
});
