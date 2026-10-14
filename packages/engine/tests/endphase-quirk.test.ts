/**
 * **§5.240 的既有 quirk**：出牌阶段里刚跑过「**出牌阶段开始时**」的钩子询问（纪灵·双刃、
 * 丁奉·奋迅）之后，玩家第一次「结束出牌」只把 `turn.phase` 翻成 discard，**弃牌询问没有
 * 摆上槽**（pending 仍是出牌占位）——要等下一个意图把它冲出来（再点一次「结束」才正常）。
 *
 * 复现特征（改动前）：
 * - 第一次 endPhase 返回 ok、`phase === 'discard'`，但 `pending = {kind:'play'}`；
 * - 对照组（起手就 endPhase、不经过钩子询问）一次就对：`pending = {kind:'discard'}`。
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
    p.flags = emptyFlags();
    p.maxHp = 4;
    p.hp = 4;
  }
  const idx = state.seatOrder.indexOf(turnSeat);
  state.turn = { seatIndex: idx, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[state.turn.seatIndex]! };
  state.log = [];
  return state;
}

describe('§5.240 quirk：钩子询问之后的第一次 endPhase 必须直接摆上弃牌询问', () => {
  /** 造一局：丙先手，收掉他的回合 ⇒ 甲（纪灵）的出牌阶段开始 ⇒ 双刃询问 ⇒ 答掉 */
  function afterBladeAsk(): GameState {
    const state = gz(
      [
        {
          seatId: 's0',
          name: '甲',
          heroId: 'jiling',
          faction: 'qun',
          // 5 张手牌 / 体力 4 ⇒ 弃牌阶段要弃 1 张；其中一张 1 点用于拼点必输
          hand: [mk('a0', 'sha', 'spade', 1), sha('a1'), sha('a2'), sha('a3'), sha('a4')],
        },
        { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [mk('b1', 'sha', 'club', 13)] },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      ],
      's2',
    );
    ok(act(state, 's2', { type: 'endPhase' }), '丙结束');
    while (state.pending?.kind === 'discard') ok(act(state, 's2', { type: 'discard', cardIds: [] }));
    // 甲的回合 ⇒ 出牌阶段开始 ⇒ 双刃问一句
    if ((state.pending as { kind?: string })?.kind === 'choice' && /明置/.test((state.pending as { title?: string }).title ?? '')) {
      ok(act(state, 's0', { type: 'chooseOption', optionId: 'none' }), '跳明置');
    }
    expect(state.pending?.kind, '双刃询问').toBe('choice');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }), '发动双刃');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 's1' }), '与乙拼点');
    ok(act(state, 's0', { type: 'pickCards', cardIds: ['a0'] }), '甲扣 1 点');
    ok(act(state, 's1', { type: 'pickCards', cardIds: ['b1'] }), '乙扣 13 点（甲必输）');
    expect(at(state, 's0').flags.cannotTargetOthersThisPhase, '没赢 ⇒ 立标记').toBe(true);
    return state;
  }

  it('双刃答完 ⇒ endPhase 一次就把弃牌询问摆上槽（修复前 pending 仍是 play）', () => {
    const state = afterBladeAsk();
    expect(state.pending?.kind, '答完双刃后回到出牌阶段').toBe('play');
    ok(act(state, 's0', { type: 'endPhase' }), '第一次结束出牌');
    expect(state.turn.phase, '阶段已翻').toBe('discard');
    expect(state.pending?.kind, '⚠️ 弃牌询问必须已经在槽上（§5.240 quirk）').toBe('discard');
    if (state.pending?.kind === 'discard') {
      expect(state.pending.seatId).toBe('s0');
      // 手牌＝5 − 1（拼点扣掉 a0）＋ 2（回合开始的摸牌阶段）＝ 6，上限 4 ⇒ 弃 2
      expect(state.pending.count, '6 手牌 / 上限 4 ⇒ 弃 2').toBe(2);
    }
    ok(act(state, 's0', { type: 'discard', cardIds: ['a1', 'a2'] }), '直接弃牌');
    expect(state.pending?.kind).not.toBe('discard');
  });

  it('奋迅（同为出牌阶段开始钩子）之后也一样', () => {
    const state = gz(
      [
        { seatId: 's0', name: '甲', heroId: 'dingfeng', faction: 'wu', hand: [sha('a1'), sha('a2'), sha('a3'), sha('a4'), sha('a5')] },
        { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu' },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      ],
      's2',
    );
    ok(act(state, 's2', { type: 'endPhase' }), '丙结束');
    while (state.pending?.kind === 'discard') ok(act(state, 's2', { type: 'discard', cardIds: [] }));
    if ((state.pending as { kind?: string })?.kind === 'choice' && /明置/.test((state.pending as { title?: string }).title ?? '')) {
      ok(act(state, 's0', { type: 'chooseOption', optionId: 'none' }), '跳明置');
    }
    expect(state.pending?.kind, '奋迅询问').toBe('choice');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'no' }), '不发动');
    ok(act(state, 's0', { type: 'endPhase' }), '结束出牌');
    expect(state.pending?.kind, '弃牌询问一次到位').toBe('discard');
  });

  it('对照组：不经过钩子询问的 endPhase 一次就对（既有行为，不许回归）', () => {
    const state = gz(
      [
        { seatId: 's0', name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1'), sha('a2'), sha('a3'), sha('a4'), sha('a5')] },
        { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      ],
      's0',
    );
    ok(act(state, 's0', { type: 'endPhase' }));
    expect(state.pending?.kind).toBe('discard');
  });

  it('界面侧：第一次 endPhase 之后玩家收到的提示就是「弃牌」而不是出牌', () => {
    const state = afterBladeAsk();
    ok(act(state, 's0', { type: 'endPhase' }));
    const prompt = toSnapshot(state, 's0').prompt;
    expect(prompt?.kind, '快照下发的是弃牌询问').toBe('discard');
  });
});
