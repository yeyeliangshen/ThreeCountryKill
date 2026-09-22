/**
 * **牌桌上公开摆着的牌池**（【五谷丰登】）——用户 2026-09-23 的规格：
 *
 * > 把亮出的所有牌按固定顺序平铺在牌桌中央，所有需要选择的玩家都能看到；按结算顺序依次选：
 * > 当前玩家直接点牌桌上的一张牌，被选中的牌立即从展示区移除并进手牌，剩余牌状态实时更新，
 * > 选完自动轮到下一名玩家，直到所有人选完或牌被取空。
 *
 * 这里钉**数据侧**：池子是**公开**的（谁都能看到整池与轮到谁）、顺序固定、拿走的留痕、
 * 「我能不能点」按观看者算（规则层决定，界面不猜）、结算完撤下牌桌。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, buildDeck, createGame, emptyFlags, toSnapshot, type GameState } from '../src';
import { PublicPoolView, type Card } from '@sgs/protocol';

const A = 's0';
const B = 's1';
const C = 's2';

const wugu = (id: string): Card => ({ id, type: 'wugu', suit: 'heart', rank: 7 });

/** 甲拿【五谷丰登】：3 人局 ⇒ 亮 3 张（牌堆顶三张由用例指定） */
function gz(deckTop: Card[]): GameState {
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
  const HERO: Record<string, string> = { [A]: 'guanyu', [B]: 'zhangfei', [C]: 'caocao' };
  for (const p of state.players) {
    p.heroId = HERO[p.seatId]!;
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.maxHp = 4;
    p.hp = 4;
    p.hand = [];
    p.flags = emptyFlags();
  }
  const a = state.players.find((p) => p.seatId === A)!;
  a.hand = [wugu('w1')];
  // 摸牌是从牌堆**尾**摸（drawOne 用 pop），所以把要亮出来的牌放到尾部、按亮出顺序排好
  state.deck = [...buildDeck('guozhan'), ...[mkDeck('d1'), mkDeck('d2'), mkDeck('d3')]];
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: A };
  state.log = [];
  return state;
}
const mkDeck = (id: string): Card => ({ id, type: 'sha', suit: 'spade', rank: 5 });

const act = (state: GameState, seatId: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(state, seatId, i);
const ok = (r: ReturnType<typeof applyIntent>) => {
  if (!r.ok) throw new Error(`预期成功但失败：${r.error}`);
};
const poolOf = (state: GameState, seat: string): PublicPoolView | null | undefined =>
  toSnapshot(state, seat).publicPool;
/** 池子里还没被拿走的那几张（＝现在能点的） */
const availIds = (p: PublicPoolView | null | undefined) =>
  (p?.slots ?? []).filter((s) => !s.takenBySeatId).map((s) => s.card.id);

describe('【五谷丰登】的牌桌牌池：公开、按序、拿走留痕', () => {
  it('亮牌即上桌：固定顺序平铺、公开给所有人、轮到发起者先选', () => {
    const state = gz([]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'w1', targetIds: [] }));
    // 无懈窗口先过掉
    while (state.pending?.kind === 'wuxieQueue') {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    const seenByB = poolOf(state, B)!; // ⭐ 旁观者也看得到整池
    expect(seenByB).toBeTruthy();
    expect(seenByB.source).toBe('wugu');
    expect(seenByB.slots.map((s) => s.card.id)).toEqual(['d3', 'd2', 'd1']); // 摸牌顺序（从堆尾）
    expect(seenByB.currentSeatId).toBe(A);
    expect(seenByB.queue).toEqual([A, B, C]);
    expect(seenByB.slots.every((s) => s.takenBySeatId === undefined)).toBe(true);
    // 「我能不能点」按观看者算：轮到甲 ⇒ 只有甲那份是 interactive
    expect(poolOf(state, A)!.interactive).toBe(true);
    expect(poolOf(state, B)!.interactive).toBe(false);
    // 乙手上没有这笔询问（他不是当前选择者），但池子照样看得到
    expect(toSnapshot(state, B).prompt?.pickFromPool).toBeUndefined();
    expect(b.hand).toHaveLength(0);
  });

  it('点一张就拿走一张：进手牌、原位留痕、轮到下一个、剩余牌顺序不变', () => {
    const state = gz([]);
    ok(act(state, A, { type: 'playCard', cardId: 'w1', targetIds: [] }));
    while (state.pending?.kind === 'wuxieQueue') {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    // 甲点桌面上的 d3
    expect(toSnapshot(state, A).prompt?.pickFromPool).toBe(true);
    ok(act(state, A, { type: 'pickCards', cardIds: ['d3'] }));
    const afterA = poolOf(state, C)!;
    expect(afterA.slots.map((s) => s.card.id)).toEqual(['d3', 'd2', 'd1']); // 位置仍在、顺序不变
    expect(afterA.slots[0]!.takenBySeatId).toBe(A); // 留痕：被甲拿走
    expect(availIds(afterA)).toEqual(['d2', 'd1']); // 剩下这两张可点
    expect(afterA.currentSeatId).toBe(B); // 自动轮到下一位
    expect(afterA.queue).toEqual([B, C]);
    expect(poolOf(state, B)!.interactive).toBe(true);
    expect(poolOf(state, A)!.interactive).toBe(false);
    expect(state.players.find((p) => p.seatId === A)!.hand.map((c) => c.id)).toEqual(['d3']);
    // 乙接着拿 d1（顺序不限，但拿走后依然是留痕 + 顺延）
    ok(act(state, B, { type: 'pickCards', cardIds: ['d1'] }));
    const afterB = poolOf(state, A)!;
    expect(afterB.slots.map((s) => `${s.card.id}:${s.takenBySeatId ?? '-'}`)).toEqual([
      'd3:s0',
      'd2:-',
      'd1:s1',
    ]);
    expect(afterB.currentSeatId).toBe(C);
    // 丙拿最后一张 → 池子撤下牌桌、结算收尾
    ok(act(state, C, { type: 'pickCards', cardIds: ['d2'] }));
    expect(poolOf(state, A) ?? null).toBeNull();
    const hands = state.players.map((p) => ({ s: p.seatId, n: p.hand.length }));
    expect(hands.every((h) => h.n === 1)).toBe(true);
  });

  it('中途有人被无懈跳过：池子仍在桌上，轮次顺延到他后面的人', () => {
    const state = gz([]);
    ok(act(state, A, { type: 'playCard', cardId: 'w1', targetIds: [] }));
    while (state.pending?.kind === 'wuxieQueue') {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    ok(act(state, A, { type: 'pickCards', cardIds: ['d3'] }));
    // 乙的无懈窗口：这里直接过（不抵消），确保流程照常
    while (state.pending?.kind === 'wuxieQueue') {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    expect(poolOf(state, A)!.currentSeatId).toBe(B);
    expect(availIds(poolOf(state, A))).toEqual(['d2', 'd1']);
  });

  it('轮到某人但他还在处理自己的无懈窗口时：标签是「轮到他」，但**还不能点**（不可交互）', () => {
    const state = gz([]);
    // 给乙一张无懈可击 ⇒ 甲拿完之后，乙会先被问无懈，选牌询问还没轮到他
    const b = state.players.find((p) => p.seatId === B)!;
    b.hand = [{ id: 'wx1', type: 'wuxie', suit: 'spade', rank: 11 } as never];
    ok(act(state, A, { type: 'playCard', cardId: 'w1', targetIds: [] }));
    // 先把【五谷丰登】这张牌自己的无懈窗口过完（甲乙都在队列里），然后才轮到甲选牌
    while (state.pending?.kind === 'wuxieQueue') {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    expect(toSnapshot(state, A).prompt?.pickFromPool).toBe(true);
    ok(act(state, A, { type: 'pickCards', cardIds: ['d3'] }));
    // 现在轮到乙，但他正被问「要不要无懈」⇒ 池子标签写「轮到乙」，而**不可交互**
    const during = poolOf(state, B)!;
    expect(during.currentSeatId).toBe(B);
    expect(during.interactive, '还在他的无懈窗口里 ⇒ 不能点牌').toBe(false);
    expect(toSnapshot(state, B).prompt?.kind).toBe('wuxieQueue');
    // 过掉他的无懈窗口 → 才真的轮到他点牌
    while (state.pending?.kind === 'wuxieQueue') {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    expect(poolOf(state, B)!.interactive).toBe(true);
    expect(toSnapshot(state, B).prompt?.pickFromPool).toBe(true);
    expect(availIds(poolOf(state, B))).toEqual(['d2', 'd1']);
  });

  it('同一张牌不会被拿两次（连点/迟到的点击都被拒），池子跨多次 intent 一直在桌上', () => {
    const state = gz([]);
    ok(act(state, A, { type: 'playCard', cardId: 'w1', targetIds: [] }));
    while (state.pending?.kind === 'wuxieQueue') {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    ok(act(state, A, { type: 'pickCards', cardIds: ['d3'] }));
    // 甲再点一次自己刚拿走的那张：此刻没有属于甲的询问 ⇒ 被拒，池子不变
    const again = act(state, A, { type: 'pickCards', cardIds: ['d3'] });
    expect(again.ok, '拿过的牌不能再拿一次').toBe(false);
    const pool = poolOf(state, A)!;
    expect(pool.slots[0]!.takenBySeatId).toBe(A);
    expect(availIds(pool)).toEqual(['d2', 'd1']); // 没有被重复扣掉
    expect(state.players.find((p) => p.seatId === A)!.hand.filter((c) => c.id === 'd3')).toHaveLength(1);
    // 池子跨 intent 存活：乙过掉无懈窗口后它还在（不像拼点结果那样一次行动就收起）
    while (state.pending?.kind === 'wuxieQueue') {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    expect(poolOf(state, B)!.currentSeatId).toBe(B);
    expect(poolOf(state, B)!.slots).toHaveLength(3);
  });
});
