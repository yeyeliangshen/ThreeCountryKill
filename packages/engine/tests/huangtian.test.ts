/**
 * 【黄天】（张角·群势力技）——用户 2026-09-23 定的口径：
 *
 * > 候选来源：**手牌**；合法牌名：**【闪】/【闪电】**；选择数量：**1**；移动方式：**公开**交给张角。
 * > 判定区里的【闪电】不能交（它已经是等待判定的延时锦囊）；【闪电】不是装备牌，装备区不存在这种状态。
 *
 * 这是**反向**势力技：由**其他群势力角色**发动、好处给张角，所以挂在外部技能表上
 * （`huangtianFor` → legal 的可选技能 + engine 的技能查找）。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, huangtianFor, type GameState } from '../src';
import type { Card, Faction } from '@sgs/protocol';

const A = 's0';
const B = 's1';
const C = 's2';

const mk = (id: string, type: Card['type'], suit: Card['suit'], rank = 1): Card => ({
  id,
  type,
  suit,
  rank,
});

function gz(opts: { bHand: Card[]; bJudgment?: Card[] }): GameState {
  const state = createGame(
    [
      { seatId: A, name: '甲', heroId: 'zhangjiao' }, // 张角（收牌方）
      { seatId: B, name: '乙', heroId: 'guanyu' }, // 发动黄天的群势力角色
      { seatId: C, name: '丙', heroId: 'zhangfei' },
    ],
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  const set = (seatId: string, heroId: string, faction: Faction) => {
    const p = state.players.find((x) => x.seatId === seatId)!;
    p.heroId = heroId;
    p.faction = faction;
    p.heroRevealed = true;
    p.deputyRevealed = false;
    p.maxHp = 4;
    p.hp = 4;
    p.hand = [];
    p.flags = emptyFlags();
  };
  set(A, 'zhangjiao', 'qun'); // 明置的张角
  set(B, 'guanyu', 'qun'); // 群势力（黄天由他发动）
  set(C, 'zhangfei', 'shu');
  const b = state.players.find((p) => p.seatId === B)!;
  b.hand = opts.bHand.slice();
  b.judgment = (opts.bJudgment ?? []).slice();
  state.turn = { seatIndex: 1, phase: 'play' };
  state.pending = { kind: 'play', seatId: B };
  state.log = [];
  return state;
}

const act = (state: GameState, seatId: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(state, seatId, i);
const logs = (s: GameState) => s.log.map((e) => e.message).join(' | ');
const handOf = (s: GameState, seatId: string) =>
  s.players.find((p) => p.seatId === seatId)!.hand.map((c) => c.id);

describe('【黄天】：只从**手牌**里交【闪】/【闪电】', () => {
  it('手牌里有【闪】→ 可以发动，牌进张角手牌，且**公开**（日志写明牌名）', () => {
    const state = gz({ bHand: [mk('b1', 'shan', 'heart', 2)] });
    const a = state.players.find((p) => p.seatId === A)!;
    expect(huangtianFor(state, state.players.find((p) => p.seatId === B)!).length).toBe(1);
    ok(act(state, B, { type: 'useSkill', skillId: 'huangtian', cardIds: ['b1'], targetIds: [] }));
    expect(handOf(state, A)).toEqual(['b1']);
    expect(handOf(state, B)).toEqual([]);
    expect(logs(state), '交出去的牌要**公开**（日志里有牌名）').toContain('【红桃2·闪】');
  });

  it('手牌里有【闪电】→ 也可以交', () => {
    const state = gz({ bHand: [mk('b1', 'shandian', 'spade', 1)] });
    ok(act(state, B, { type: 'useSkill', skillId: 'huangtian', cardIds: ['b1'], targetIds: [] }));
    expect(handOf(state, A)).toEqual(['b1']);
  });

  it('**判定区**里的【闪电】不能交：技能不可发动，硬指定也被拒', () => {
    const state = gz({
      bHand: [],
      bJudgment: [mk('j1', 'shandian', 'spade', 1)], // 判定区正在等待判定的闪电
    });
    const b = state.players.find((p) => p.seatId === B)!;
    expect(huangtianFor(state, b), '手牌里没有可交的牌 ⇒ 不出现这个技能').toEqual([]);
    const r = act(state, B, { type: 'useSkill', skillId: 'huangtian', cardIds: ['j1'], targetIds: [] });
    expect(r.ok, '判定区的牌交不出去').toBe(false);
    // 判定区那张还在
    expect(state.players.find((p) => p.seatId === B)!.judgment.map((c) => c.id)).toEqual(['j1']);
  });

  it('手里有【闪】、判定区也有【闪电】时：只交手里的那张（判定区不在候选里）', () => {
    const state = gz({
      bHand: [mk('b1', 'shan', 'heart', 2)],
      bJudgment: [mk('j1', 'shandian', 'spade', 1)],
    });
    expect(
      act(state, B, { type: 'useSkill', skillId: 'huangtian', cardIds: ['j1'], targetIds: [] }).ok,
      '判定区那张仍然交不出去',
    ).toBe(false);
    ok(act(state, B, { type: 'useSkill', skillId: 'huangtian', cardIds: ['b1'], targetIds: [] }));
    expect(handOf(state, A)).toEqual(['b1']);
  });

  it('【闪】【闪电】以外的牌交不了（例如【杀】）', () => {
    const state = gz({ bHand: [mk('b1', 'sha', 'spade', 5)] });
    const b = state.players.find((p) => p.seatId === B)!;
    expect(huangtianFor(state, b)).toEqual([]);
    expect(
      act(state, B, { type: 'useSkill', skillId: 'huangtian', cardIds: ['b1'], targetIds: [] }).ok,
    ).toBe(false);
  });

  it('场上没有**明置**的张角 → 不可发动（暗置不算）', () => {
    const state = gz({ bHand: [mk('b1', 'shan', 'heart', 2)] });
    state.players.find((p) => p.seatId === A)!.heroRevealed = false;
    const b = state.players.find((p) => p.seatId === B)!;
    expect(huangtianFor(state, b)).toEqual([]);
  });

  it('非群势力角色不能用黄天（它只给「其他群势力角色」）', () => {
    const state = gz({ bHand: [mk('b1', 'shan', 'heart', 2)] });
    const c = state.players.find((p) => p.seatId === C)!;
    c.hand = [mk('c1', 'shan', 'heart', 3)];
    expect(huangtianFor(state, c)).toEqual([]);
  });
});

function ok(r: ReturnType<typeof applyIntent>): void {
  if (!r.ok) throw new Error(`预期成功但失败：${r.error}`);
}
