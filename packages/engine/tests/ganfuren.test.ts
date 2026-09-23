/**
 * **甘夫人·【淑慎】**（用户 2026-09-26 口径：现行文本两个分支）。
 *
 * - ①（仓库本来就有）「当你回复 1 点体力后，你可以令一名**其他角色**摸一张牌」；
 * - ②（本轮补）「当你**一次失去的牌数大于你的体力值**时，你可以令一名**与你势力相同的
 *   其他角色**摸一张牌」。
 *
 * ⚠️ 分支② 的两个要点：
 *   · 比的是**当前体力**（不是体力上限），而且是**严格大于**（相等不触发）；
 *   · 「一次」＝引擎按「这一手意图前后少了几张牌」算 ⇒ **弃牌阶段一次弃好几张**（在她自己回合里）
 *     也算一次事件。为此引擎侧把 `cardsLost` 的派发从「只派回合外」改成了「都派」，
 *     「回合外」由屯田自己按 payload 判（见 docs §5.239）。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, getHeroForMode, toSnapshot, type GameState } from '../src';
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
  reveal?: boolean;
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
    const shown = s.reveal !== false;
    p.heroRevealed = shown;
    p.deputyRevealed = shown;
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
/** 甲＝甘夫人（蜀），乙＝蜀队友，丙＝魏 */
function table(opts: { hand: Card[]; hp: number }): GameState {
  return gz(
    [
      { seatId: 's0', name: '甘夫人', heroId: 'ganfuren', faction: 'shu', hand: opts.hand, hp: opts.hp },
      { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu' },
      { seatId: 's2', name: '丙', heroId: 'vanilla', faction: 'wei' },
    ],
    's0',
  );
}
/** 走一次甲的弃牌阶段（弃到上限），返回是否出现了淑慎的询问 */
function discardDown(state: GameState, count: number): void {
  ok(act(state, 's0', { type: 'endPhase' }), '结束出牌阶段');
  expect(state.pending?.kind, '进入弃牌阶段').toBe('discard');
  if (state.pending?.kind === 'discard') {
    const ids = state.pending.cards ? [] : [];
    // 从手牌里挑前 count 张（`discard` 意图只收 id 列表）
    const hand = at(state, 's0').hand.map((c) => c.id).slice(0, count);
    ok(act(state, 's0', { type: 'discard', cardIds: hand }), '弃牌');
    void ids;
  }
}

describe('【淑慎】②：一次失去的牌数 > 当前体力值 ⇒ 可以令**同势力**其他角色摸一张', () => {
  it('自己回合的**弃牌阶段**一次弃 3 张（体力 2）⇒ 触发，且只有同势力的乙能当目标', () => {
    const state = table({
      hand: [sha('a1'), sha('a2'), sha('a3'), sha('a4'), sha('a5')],
      hp: 2,
    });
    state.deck = [mk('d1', 'sha', 'club', 3), mk('d2', 'sha', 'club', 4)];
    discardDown(state, 3); // 手牌 5 → 上限 2 ⇒ 弃 3 张（3 > 2 ✓）
    const p = state.pending;
    expect(p?.kind, '淑慎②的询问').toBe('choice');
    if (p?.kind === 'choice') {
      expect(p.seatId).toBe('s0');
      expect(p.title).toContain('淑慎');
      expect(p.title, '把「失了 3 张 / 体力 2」写清楚').toContain('3');
    }
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }));
    expect(state.pending?.kind, '在牌桌上点同势力角色').toBe('pickSeats');
    if (state.pending?.kind === 'pickSeats') {
      expect(state.pending.candidates, '只有同势力的乙，没有魏丙').toEqual(['s1']);
    }
    ok(act(state, 's0', { type: 'pickSeats', seatIds: ['s1'] }));
    expect(at(state, 's1').hand.map((c) => c.id), '队友摸了 1 张').toContain('d2');
  });

  it('失去的张数 **等于** 体力值 ⇒ 不触发（「大于」）', () => {
    const state = table({ hand: [sha('a1'), sha('a2'), sha('a3'), sha('a4')], hp: 2 });
    // 手牌 4 → 上限 2 ⇒ 弃 2 张（2 > 2 ✗）
    discardDown(state, 2);
    expect(state.pending?.kind, '没有淑慎的询问').not.toBe('choice');
    expect(state.log.some((e) => e.message.includes('淑慎'))).toBe(false);
  });

  it('一次只失去 1 张（体力 1）⇒ 不触发', () => {
    const state = table({ hand: [sha('a1'), sha('a2')], hp: 1 });
    discardDown(state, 1); // 弃 1 张（1 > 1 ✗）
    expect(state.log.some((e) => e.message.includes('淑慎'))).toBe(false);
  });

  it('没有同势力其他角色 ⇒ **不产生无意义询问**', () => {
    const state = gz(
      [
        { seatId: 's0', name: '甘夫人', heroId: 'ganfuren', faction: 'shu', hand: [sha('a1'), sha('a2'), sha('a3')], hp: 1 },
        { seatId: 's1', name: '乙', heroId: 'vanilla', faction: 'wei' },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      ],
      's0',
    );
    discardDown(state, 2);
    // ⚠️ 别断言「pending 不是 choice」——陪坐的武将可能自带询问（许褚·裸衣就会在摸牌阶段问一句）。
    //    要断的是**淑慎没问**：日志里没有它、槽里也没有它的标题。
    expect(state.pending?.title ?? '').not.toContain('淑慎');
    expect(state.log.some((e) => e.message.includes('淑慎'))).toBe(false);
  });

  it('同势力但**还暗着**的角色不算（不偷看底牌）', () => {
    const state = gz(
      [
        { seatId: 's0', name: '甘夫人', heroId: 'ganfuren', faction: 'shu', hand: [sha('a1'), sha('a2'), sha('a3')], hp: 1 },
        { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu', reveal: false },
        { seatId: 's2', name: '丙', heroId: 'vanilla', faction: 'wei' },
      ],
      's0',
    );
    discardDown(state, 2);
    expect(state.log.some((e) => e.message.includes('淑慎')), '没有合法的同势力对象 ⇒ 不问').toBe(false);
  });

  it('①「回复 1 点体力后」那一支没变（目标仍是**任意**其他角色）', () => {
    const state = table({ hand: [mk('t1', 'tao', 'heart', 3)], hp: 2 });
    // 用不着真回血：直接把血扣掉再用桃回（走 api 的 afterHeal 时机）
    at(state, 's0').hp = 2;
    ok(act(state, 's0', { type: 'playCard', cardId: 't1', targetIds: [] }), '吃桃回血');
    const p = state.pending;
    expect(p?.kind, '淑慎①的询问').toBe('choice');
    if (p?.kind === 'choice') {
      ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }));
      // ① 的目标不限势力：魏的丙也在候选里
      if (state.pending?.kind === 'choice') {
        expect(state.pending.options.map((o) => o.id).sort()).toEqual(['s1', 's2']);
      }
    }
  });

  it('文本两句都在', () => {
    const desc = getHeroForMode('ganfuren', 'guozhan')!.skills.find((s) => s.name === '淑慎')!.desc ?? '';
    expect(desc).toContain('当你回复 1 点体力后');
    expect(desc).toContain('一次失去的牌数大于你的体力值时');
    expect(desc).toContain('与你势力相同的其他角色');
  });
});
