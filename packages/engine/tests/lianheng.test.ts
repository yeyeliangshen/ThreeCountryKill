/**
 * **连横**（势备篇）——用户 2026-09-23 复报「【挟天子以令诸侯】无法连横」，并要求：
 * **不要只给某一张牌打补丁，把带连横标记的牌统一查一遍**。
 *
 * 口径（docs §「C. 连横」，来自牌面原文 + 那条不对称的官方 FAQ）：
 * - 能交给「势力**不同**」或「**尚未确定势力**」的角色；
 * - **不能**交给同势力角色；
 * - 自己是**未确定势力**时，只能交给同样未确定势力的角色；
 * - 摸一张**只发生在**「对方是已确定势力且与你不同」时；交给未确定势力的角色**不摸牌**；
 * - 连横**不是「使用牌」**：不进 useCard 钩子、不消耗出杀次数，与「使用」是**两条独立路径**
 *   （所以【闪】那种根本打不出去的牌也能连横）。
 *
 * 这个文件按用户列的七条逐条钉（入口 / 合法与非法目标 / 同势力排除 / 未确定势力可收 /
 * 转移 / 摸牌数 / 两条路径独立），并且用**全部 14 张带标记的牌**跑一遍，避免只修一张。
 */
import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  buildDeck,
  configFromPreset,
  createGame,
  effectiveFaction,
  emptyFlags,
  factionAliveCount,
  toSnapshot,
  type GameState,
} from '../src';
import type { Card, Faction } from '@sgs/protocol';

const A = 's0';
const B = 's1';
const C = 's2';
const D = 's3';

/** 势备篇里**所有**带连横标记的牌（按实体牌数：官方是 14 张）——只数一次（势备篇牌已在国战堆里） */
const LIANHENG_CARDS = buildDeck('guozhan', { shibei: true }).filter((c) => c.lianheng);
/** 去重后的「牌型」（3 张挟天子算一种），用于把每一种牌型都跑一遍行为 */
const LIANHENG_KINDS: { key: string; type: Card['type']; equipName?: string }[] = (() => {
  const seen = new Set<string>();
  const out: { key: string; type: Card['type']; equipName?: string }[] = [];
  for (const c of LIANHENG_CARDS) {
    const key = `${c.type}/${c.equipName ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, type: c.type, ...(c.equipName ? { equipName: c.equipName } : {}) });
  }
  return out;
})();

/**
 * 国战 4 人局：甲（吴，已明置）、乙（吴，同势力）、丙（魏，不同势力）、丁（暗置 → 未确定势力）。
 * 甲手里放一张带连横标记的牌（由用例指定类型）。
 */
function gz(cardType: Card['type'], equipName?: string): GameState {
  const state = createGame(
    [
      { seatId: A, name: '甲', heroId: 'sunquan' },
      { seatId: B, name: '乙', heroId: 'lumeng' },
      { seatId: C, name: '丙', heroId: 'caocao' },
      { seatId: D, name: '丁', heroId: 'guanyu' },
    ],
    'TEST',
    { mode: 'guozhan', config: configFromPreset('full2026') },
  );
  state.draft = null;
  /**
   * ⚠️ `player.faction` 是**选将时由引擎写**的字段（`effectiveFaction` 读它，
   * 而「暗置 ⇒ 未确定势力」是它上面那层判断）——测试直接摆武将，就必须自己补这一格，
   * 否则全场都是「未确定势力」，连横的目标规则自然全错（踩过一次）。
   */
  const set = (seatId: string, heroId: string, faction: Faction, revealed: boolean) => {
    const p = state.players.find((x) => x.seatId === seatId)!;
    p.heroId = heroId;
    p.faction = faction;
    p.heroRevealed = revealed;
    p.deputyRevealed = false;
    p.maxHp = 4;
    p.hp = 4;
    p.hand = [];
    p.flags = emptyFlags();
  };
  set(A, 'sunquan', 'wu', true); // 吴（已明置）
  set(B, 'lumeng', 'wu', true); // 吴（同势力）
  set(C, 'caocao', 'wei', true); // 魏（异势力）
  set(D, 'guanyu', 'shu', false); // 暗置 ⇒ 未确定势力（牌面上是蜀，但没亮）
  const a = state.players.find((p) => p.seatId === A)!;
  // ⚠️ 连横认的是**标记**（`Card.lianheng`）：夹具里的牌是现造的，标记必须自己打上
  a.hand = [
    {
      id: 'lh1',
      type: cardType,
      suit: 'spade',
      rank: 1,
      lianheng: true,
      ...(equipName ? { equipName } : {}),
    } as Card,
  ];
  // 牌堆放两张，用来观察「连横摸牌」
  state.deck = [
    { id: 'd1', type: 'sha', suit: 'spade', rank: 5 },
    { id: 'd2', type: 'sha', suit: 'club', rank: 6 },
  ];
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: A };
  state.log = [];
  return state;
}

const act = (state: GameState, seatId: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(state, seatId, i);
const lastLog = (state: GameState) => state.log.map((e) => e.message).join(' | ');

describe('连横 · 通用机制（【挟天子以令诸侯】+ 全部带标记的牌）', () => {
  it('口径前提：甲乙同吴、丙魏、丁未确定势力', () => {
    const state = gz('xietianzi');
    expect(effectiveFaction(state, state.players[0]!)).toBe('wu');
    expect(effectiveFaction(state, state.players[1]!)).toBe('wu');
    expect(effectiveFaction(state, state.players[2]!)).toBe('wei');
    expect(effectiveFaction(state, state.players[3]!)).toBeNull(); // 暗置 = 未确定势力
    // 顺手确认势力人数账本（大势力判定用得到）
    expect(factionAliveCount(state, 'wu')).toBe(2);
  });

  it('①【挟天子以令诸侯】有连横入口：即使这张牌本身打不出去（非大势力）也在 legalCardIds 里', () => {
    const state = gz('xietianzi');
    // 4 人局吴只有 2 人 ⇒ 不是大势力 ⇒ 挟天子用不了；但「连横」是它的另一种用法 ⇒ 仍可点
    expect(toSnapshot(state, A).prompt?.legalCardIds).toContain('lh1');
    // 服务端算好「能连横给谁」：丙（魏，不同）+ 丁（未确定）；**不含**乙（同势力）与自己
    const targets = toSnapshot(state, A).prompt?.lianhengTargets ?? [];
    expect(targets).toContain(C);
    expect(targets).toContain(D);
    expect(targets, '同势力不能连横').not.toContain(B);
    expect(targets).not.toContain(A);
  });

  it('②③④ 目标合法性：同势力被拒、异势力与未确定势力都能收', () => {
    const state = gz('xietianzi');
    expect(act(state, A, { type: 'lianheng', cardId: 'lh1', targetSeatId: B }).ok, '同势力应被拒').toBe(false);
    expect(state.players[0]!.hand.map((c) => c.id)).toEqual(['lh1']); // 牌还在手里
    expect(act(state, A, { type: 'lianheng', cardId: 'lh1', targetSeatId: C }).ok).toBe(true);
  });

  it('⑤⑥ 交给异势力：牌到手 + 摸一张', () => {
    const state = gz('xietianzi');
    okAct(state, A, { type: 'lianheng', cardId: 'lh1', targetSeatId: C });
    expect(state.players[0]!.hand.map((c) => c.id), '牌已交出去').toEqual(['d2']);
    expect(state.players[2]!.hand.map((c) => c.id), '丙收到牌').toEqual(['lh1']);
    expect(lastLog(state)).toContain('连横');
    expect(lastLog(state)).toContain('因连横摸了一张牌');
  });

  it('⑤⑥ 交给未确定势力：牌到手但**不摸牌**（用户点名的第 5 条）', () => {
    const state = gz('xietianzi');
    okAct(state, A, { type: 'lianheng', cardId: 'lh1', targetSeatId: D });
    expect(state.players[3]!.hand.map((c) => c.id), '丁收到牌').toEqual(['lh1']);
    expect(state.players[0]!.hand, '给未确定势力不摸牌 ⇒ 手里空了').toEqual([]);
    expect(lastLog(state)).not.toContain('因连横摸了一张牌');
  });

  it('⑦「使用牌」与「连横交出」是两条独立路径：连横不触发 useCard 钩子、不消耗出杀次数', () => {
    // 雷杀（♠J，带连横）：连横出去之后，出杀次数**不该**被消耗
    const state = gz('sha');
    okAct(state, A, { type: 'lianheng', cardId: 'lh1', targetSeatId: C });
    expect(state.players[0]!.flags.shaCountThisTurn, '连横不是「使用」').toBe(0);
    expect(state.players[2]!.hand.map((c) => c.id)).toEqual(['lh1']);
    // 而且甲手里还有 1 张（连横摸的），出牌阶段继续着
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('【闪】这类打不出去的牌也能连横（入口靠标记，不靠「能不能用」）', () => {
    const state = gz('shan');
    expect(toSnapshot(state, A).prompt?.legalCardIds, '闪 本身用不了，但有连横 ⇒ 可点').toContain('lh1');
    okAct(state, A, { type: 'lianheng', cardId: 'lh1', targetSeatId: C });
    expect(state.players[2]!.hand.map((c) => c.id)).toEqual(['lh1']);
  });

  it('没有标记的牌不能连横（通用机制：认标记，不认牌名）', () => {
    const state = gz('xietianzi');
    // 把标记抹掉 ⇒ 既不能连横，也不该进「有连横入口」的那条路
    state.players[0]!.hand = [{ id: 'lh1', type: 'xietianzi', suit: 'spade', rank: 1 } as Card];
    expect(act(state, A, { type: 'lianheng', cardId: 'lh1', targetSeatId: C }).ok).toBe(false);
  });

  it('自己是未确定势力时：只能交给同样未确定势力的角色（官方 FAQ 那条不对称）', () => {
    const state = gz('xietianzi');
    // 甲也暗置 ⇒ 未确定势力
    state.players[0]!.heroRevealed = false;
    const targets = toSnapshot(state, A).prompt?.lianhengTargets ?? [];
    expect(targets, '未确定势力只能给未确定势力').toEqual([D]);
    expect(act(state, A, { type: 'lianheng', cardId: 'lh1', targetSeatId: C }).ok).toBe(false);
    okAct(state, A, { type: 'lianheng', cardId: 'lh1', targetSeatId: D });
    expect(state.players[3]!.hand.map((c) => c.id)).toEqual(['lh1']);
    expect(lastLog(state)).not.toContain('因连横摸了一张牌'); // 双方都未确定 ⇒ 不摸
  });

  /** 用户要求：不要只针对一张牌特判 ⇒ 把**每一张**带标记的牌都跑一遍入口 + 转移 + 摸牌 */
  it('统一排查：势备篇全部带连横标记的牌都能连横（牌型 × 转移 × 摸牌）', () => {
    expect(LIANHENG_CARDS.length, '牌堆里应有 14 张带连横标记的牌').toBe(14);
    expect(LIANHENG_KINDS.length, '去重后 9 种牌型').toBe(9);
    for (const spec of LIANHENG_KINDS) {
      // 异势力目标：能连、能摸
      const s1 = gz(spec.type, spec.equipName);
      expect(toSnapshot(s1, A).prompt?.legalCardIds, `${spec.key} 应有连横入口`).toContain('lh1');
      const r1 = act(s1, A, { type: 'lianheng', cardId: 'lh1', targetSeatId: C });
      expect(r1.ok, `${spec.key} 连横给异势力应成功`).toBe(true);
      expect(s1.players[2]!.hand.map((c) => c.id), `${spec.key} 应到丙手上`).toEqual(['lh1']);
      expect(s1.players[0]!.hand.length, `${spec.key} 给异势力应摸一张`).toBe(1);

      // 未确定势力目标：能连、**不摸**
      const s2 = gz(spec.type, spec.equipName);
      const r2 = act(s2, A, { type: 'lianheng', cardId: 'lh1', targetSeatId: D });
      expect(r2.ok, `${spec.key} 连横给未确定势力应成功`).toBe(true);
      expect(s2.players[3]!.hand.map((c) => c.id), `${spec.key} 应到丁手上`).toEqual(['lh1']);
      expect(s2.players[0]!.hand.length, `${spec.key} 给未确定势力不摸牌`).toBe(0);
    }
  });
});

function okAct(state: GameState, seatId: string, i: Parameters<typeof applyIntent>[2]): void {
  const r = act(state, seatId, i);
  if (!r.ok) throw new Error(`预期成功但失败：${r.error}`);
}
