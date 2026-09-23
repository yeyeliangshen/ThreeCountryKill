/**
 * **纪灵·【双刃】**（用户 2026-09-26 口径：拼点**没赢**的后果）。
 *
 * 现行：「没赢 ⇒ **此阶段不能对其他角色使用牌**」——**不是**「结束出牌阶段」。
 * 用户还特别点明：**桃 / 酒 / 装备这类属于「对自己使用牌」，不受影响**。
 *
 * 实现：新标记 `PlayerFlags.cannotTargetOthersThisPhase`，在 `onPlayCard` 里与严白虎·雉盗
 * **同一处**拦（判据同源 `cardTargetsOutside`：显式目标 + 南蛮/万箭/桃园那类不指定目标却会打到别人的牌）；
 * 下一阶段开始时与回合结束时清掉。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, getHeroForMode, type GameState } from '../src';
import type { Card, Faction } from '@sgs/protocol';

const ok = (r: { ok: boolean; error?: string }, tag = ''): void => {
  if (!r.ok) throw new Error(`${tag} 意图被拒：${r.error}`);
};
const bad = (r: { ok: boolean; error?: string }, tag = ''): void => {
  if (r.ok) throw new Error(`${tag} 本应被拒但成功了`);
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
const sha = (id: string, rank = 1) => mk(id, 'sha', 'spade', rank);

interface Seat {
  seatId: string;
  name: string;
  heroId: string;
  faction?: Faction;
  hand?: Card[];
  hp?: number;
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
    p.hp = s.hp ?? 4;
  }
  const idx = state.seatOrder.indexOf(turnSeat);
  state.turn = { seatIndex: idx < 0 ? 0 : idx, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[state.turn.seatIndex]! };
  state.log = [];
  return state;
}
/**
 * 纪灵（甲）与乙拼点、**输掉**：甲拿 1 点、乙拿 13 点 ⇒ 甲没赢。
 * 甲手里另备「对别人用的牌」与「对自己用的牌」各几张，供后面断言。
 */
function losePindian(): GameState {
  const state = gz(
    [
      {
        seatId: 's0',
        name: '甲',
        heroId: 'jiling',
        faction: 'qun',
        hp: 2,
        hand: [
          sha('a0', 1), // 拼点用的（注定输）
          sha('a1', 7), // 对别人用的
          mk('a2', 'guohe', 'spade', 3), // 对别人用的（锦囊）
          mk('a3', 'nanman', 'spade', 5), // 不指定目标也会打到别人
          mk('a4', 'tao', 'heart', 3), // 对自己用
          mk('a5', 'jiu', 'spade', 9), // 对自己用
          { ...mk('a6', 'armor', 'club', 2), equipName: 'bagua' } as Card, // 对自己用（装备）
        ],
      },
      { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [sha('b1', 13), sha('b2', 7)] },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun', hand: [sha('c1', 6)] },
    ],
    's2', // 先手给丙：收掉丙的回合，甲的回合才**真正开始**（双刃挂在「出牌阶段开始时」）
  );
  ok(act(state, 's2', { type: 'endPhase' }), '丙结束');
  while (state.pending?.kind === 'discard') ok(act(state, 's2', { type: 'discard', cardIds: [] }));
  // 甲的出牌阶段开始 ⇒ 双刃问一句
  const ask = state.pending;
  expect(ask?.kind).toBe('choice');
  ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }), '发动');
  ok(act(state, 's0', { type: 'chooseOption', optionId: 's1' }), '与乙拼点');
  ok(act(state, 's0', { type: 'pickCards', cardIds: ['a0'] }), '甲扣 a0（1 点）');
  ok(act(state, 's1', { type: 'pickCards', cardIds: ['b1'] }), '乙扣 b1（13 点）');
  expect(at(state, 's0').flags.cannotTargetOthersThisPhase, '没赢 ⇒ 立标记').toBe(true);
  return state;
}

describe('【双刃】没赢：此阶段不能对其他角色使用牌（对自己使用的不受影响）', () => {
  it('出牌阶段**没有**被结束（旧实现在这里直接进弃牌阶段）', () => {
    const state = losePindian();
    expect(state.pending?.kind, '还是甲的出牌阶段').toBe('play');
    if (state.pending?.kind === 'play') expect(state.pending.seatId).toBe('s0');
    expect(state.turn.phase).toBe('play');
  });

  it('**对别人用的牌**一律被拒：杀 / 过河拆桥 / 南蛮入侵', () => {
    const state = losePindian();
    bad(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }), '杀');
    bad(act(state, 's0', { type: 'playCard', cardId: 'a2', targetIds: ['s1'] }), '过河拆桥');
    bad(act(state, 's0', { type: 'playCard', cardId: 'a3', targetIds: [] }), '南蛮入侵');
    expect(at(state, 's1').hp, '谁都没掉血').toBe(4);
  });

  it('**对自己用的牌**照常：桃 / 酒 / 装备', () => {
    const state = losePindain2();
    ok(act(state, 's0', { type: 'playCard', cardId: 'a4', targetIds: [] }), '桃（自己已受伤）');
    expect(at(state, 's0').hp).toBe(3);
    ok(act(state, 's0', { type: 'playCard', cardId: 'a5', targetIds: [] }), '酒');
    ok(act(state, 's0', { type: 'playCard', cardId: 'a6', targetIds: [] }), '装备');
    expect(at(state, 's0').equipment.armor?.id).toBe('a6');
  });

  it('标记随回合结束清掉（下一个出牌阶段恢复）', () => {
    const state = losePindian();
    ok(act(state, 's0', { type: 'endPhase' }), '结束出牌阶段');
    // ⚠️ 需要**推第二次**才能进弃牌阶段：见 docs §5.240 §四那个既有 quirk——出牌阶段里刚跑过
    //    「出牌阶段开始时」的钩子询问之后，第一次 endPhase 只把 `turn.phase` 改成 discard，
    //    弃牌询问还没摆上槽（pending 仍是出牌占位），要等下一个意图把它冲出来。
    if (state.pending?.kind === 'play') ok(act(state, 's0', { type: 'endPhase' }), '再推一次');
    let guard = 0;
    while (state.pending?.kind === 'discard' && guard++ < 8) {
      const need = (state.pending as { count?: number }).count ?? 1;
      const ids = at(state, 's0').hand.map((c) => c.id).slice(0, need);
      ok(act(state, 's0', { type: 'discard', cardIds: ids }), '弃牌');
    }
    expect(at(state, 's0').flags.cannotTargetOthersThisPhase, '回合结束清掉').toBe(false);
  });

  it('文本改成「此阶段你不能对其他角色使用牌」', () => {
    const desc = getHeroForMode('jiling', 'guozhan')!.skills.find((s) => s.name === '双刃')!.desc ?? '';
    expect(desc).toContain('此阶段你不能对其他角色使用牌');
    expect(desc).not.toContain('结束出牌阶段');
  });
});

/** 与 losePindian 同一现场，但保留甲「对自己用」的牌（上一条用例会把它们用掉，各自独立起局） */
function losePindain2(): GameState {
  return losePindian();
}
