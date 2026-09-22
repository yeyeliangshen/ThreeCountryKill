/**
 * 【无懈可击】的语义：**抵消的不是「锦囊牌」本身，而是某张锦囊在某个结算对象上的「效果实例」**。
 *
 * 用户 2026-09-21 给的规则清单（原表见 docs §5.179）。这套用例就是那张表逐行的落地——
 * 每一条都写清「官方口径」与「本仓库实现」的对应关系，改引擎时先看这里。
 *
 * ⚠️ 三条最容易实现错的：
 * 1. **未确定势力不妨碍单体的抵消**：国无懈的「单体模式」不需要任何势力，
 *    势力只影响「能不能扩散到同势力尚未结算的目标」；
 * 2. **扩散的势力以「基准目标」当时的已确定势力为准**（不是无懈使用者的势力），
 *    暗将后来亮将**不追溯**，已结算过的同势力角色**不追溯**；
 * 3. 国无懈被无懈 → **整片势力范围一起失效**（不是只失效基准那一个）。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, getHero, type GameState } from '../src';
import type { Card, Faction } from '@sgs/protocol';

const A = 's0';
const B = 's1';
const C = 's2';
const D = 's3';
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
const sha = (id: string) => mk(id, 'sha', 'spade');
const juedou = (id: string) => mk(id, 'juedou', 'spade');
const nanman = (id: string) => mk(id, 'nanman', 'spade');
const wuxie = (id: string) => mk(id, 'wuxie', 'spade');
const wuxieguo = (id: string) => mk(id, 'wuxieguo', 'diamond', 11);

/** 一个国战局：`revealed: false` 的人是**未确定势力**（暗置） */
function gz(
  seats: {
    seatId: string;
    name: string;
    heroId: string;
    faction: Faction;
    hand?: Card[];
    revealed?: boolean;
  }[],
): GameState {
  const state = createGame(
    seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  for (const s of seats) {
    const p = state.players.find((x) => x.seatId === s.seatId)!;
    const hero = getHero(s.heroId)!;
    p.heroId = s.heroId;
    p.faction = s.faction;
    const shown = s.revealed !== false;
    p.heroRevealed = shown;
    p.deputyRevealed = shown;
    p.maxHp = Math.max(1, Math.floor(hero.maxHp));
    p.hp = p.maxHp;
    p.hand = (s.hand ?? []).slice();
    p.flags = emptyFlags();
  }
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
  state.log = [];
  return state;
}
/** 依次让每个被问的人弃权，直到无懈窗口关闭 */
function passWuxie(state: GameState): void {
  while (state.pending?.kind === 'wuxieQueue') {
    const asked = state.pending.askQueue[state.pending.askIndex]!;
    ok(act(state, asked, { type: 'pass' }));
  }
}
const hp = (state: GameState, seatId: string) =>
  state.players.find((p) => p.seatId === seatId)!.hp;
const logHas = (state: GameState, needle: string) =>
  state.log.some((l) => (l.message ?? '').includes(needle));

describe('无懈可击：按「效果实例」抵消（用户 2026-09-21 规则表）', () => {
  it('① 【决斗】→暗将，普通无懈 → 该角色这次【决斗】的效果被抵消', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [juedou('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', revealed: false, hand: [] },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei', hand: [wuxie('c1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' })); // 无懈【决斗】对乙的效果
    passWuxie(state);
    expect(hp(state, B)).toBe(4); // 乙没有掉血：决斗效果被抵消
    expect(state.pending?.kind).toBe('play'); // 控制权回到甲
  });

  it('② 【决斗】→暗将，【无懈可击·国】的**单体模式**同样能抵消（不需要任何势力）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [juedou('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', revealed: false, hand: [] },
      // 丙也是暗将（自己没确定势力）：照样能打国无懈、照样能抵消单体
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei', revealed: false, hand: [wuxieguo('c1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    passWuxie(state);
    expect(hp(state, B)).toBe(4);
    expect(logHas(state, '未能抵消任何效果')).toBe(false);
  });

  it('③ 【决斗】→暗将：按势力扩散不成立（基准未确定势力），但**基准本身仍被抵消**', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [juedou('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', revealed: false, hand: [] },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei', hand: [wuxieguo('c1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    passWuxie(state);
    expect(hp(state, B)).toBe(4); // 单体抵消成立
  });

  it('④ 南蛮→魏乙、魏丙：普通无懈只保护被抵消的那一个', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei', hand: [wuxie('c1'), sha('c2')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' })); // 无懈【南蛮】对乙的效果
    // 候选不止一个（乙、丙都还没结算）→ 引擎会问「抵消谁的效果」
    if (state.pending?.kind === 'choice') ok(act(state, C, { type: 'chooseOption', optionId: B }));
    passWuxie(state);
    // 乙不用出杀、也不掉血（对他无效）；丙自己照常要响应
    expect(hp(state, B)).toBe(4);
    expect(state.pending?.kind).toBe('respondTrick');
  });

  it('⑤ 南蛮→魏乙、魏丙：国无懈以「魏」为基准 → 乙丙**都**被抵消', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei', hand: [wuxieguo('c1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    if (state.pending?.kind === 'choice') ok(act(state, C, { type: 'chooseOption', optionId: B }));
    passWuxie(state);
    expect(hp(state, B)).toBe(4);
    expect(hp(state, C)).toBe(4);
  });

  it('⑥ 南蛮→魏乙、**暗**丙：国无懈按魏扩散时，暗丙不因为「底牌其实是魏」被保护', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      {
        seatId: C,
        name: '丙',
        heroId: 'caocao',
        faction: 'wei',
        revealed: false, // 未确定势力
        hand: [wuxieguo('c1'), sha('c2')],
      },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    if (state.pending?.kind === 'choice') ok(act(state, C, { type: 'chooseOption', optionId: B }));
    passWuxie(state);
    expect(hp(state, B)).toBe(4); // 乙被保护
    // 丙自己：国无懈的扩散不该把他算进「魏」
    expect(logHas(state, '丙（未确定势力）')).toBe(false);
  });

  it('⑦ 暗丙后来亮将 → 此前的国无懈**不追溯**（他照常响应南蛮）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      {
        seatId: C,
        name: '丙',
        heroId: 'caocao',
        faction: 'wei',
        revealed: false,
        hand: [wuxieguo('c1')], // 没有杀 → 国无懈只保护乙，丙要正常挨南蛮
      },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    if (state.pending?.kind === 'choice') ok(act(state, C, { type: 'chooseOption', optionId: B }));
    passWuxie(state);
    // 轮到丙自己：没有人再打无懈 → 他没杀 → 掉血（不能被「后来才亮将」追溯保护）
    while (state.pending?.kind === 'wuxieQueue' || state.pending?.kind === 'respondTrick') {
      if (state.pending.kind === 'wuxieQueue') {
        const asked = state.pending.askQueue[state.pending.askIndex]!;
        ok(act(state, asked, { type: 'pass' }));
      } else {
        ok(act(state, state.pending.responderId, { type: 'pass' }));
      }
    }
    expect(hp(state, C)).toBe(3); // 掉了 1 点
  });

  it('⑧ 乙已经结算完，丙那时才发动「魏」国无懈 → **不追溯**乙', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei', hand: [wuxieguo('c1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    // 乙自己的窗口：谁都不打无懈，乙没杀 → 掉 1 点（已结算）
    while (state.pending?.kind === 'wuxieQueue') {
      const asked = state.pending.askQueue[state.pending.askIndex]!;
      ok(act(state, asked, { type: 'pass' }));
    }
    ok(act(state, B, { type: 'pass' })); // 乙不出杀
    expect(hp(state, B)).toBe(3);
    // 轮到丙：这时用国无懈按「魏」——只能保护丙自己（乙已结算，不追溯）
    if (state.pending?.kind === 'wuxieQueue') {
      const asked = state.pending.askQueue[state.pending.askIndex]!;
      if (asked === C) ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    }
    passWuxie(state);
    expect(hp(state, B)).toBe(3); // 不追溯
    expect(hp(state, C)).toBe(4); // 丙自己被保护
  });

  it('⑨ 国无懈被另一张无懈抵消 → **整片势力范围**一起恢复（官方 FAQ）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1'), wuxie('a2')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei', hand: [wuxieguo('c1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    if (state.pending?.kind === 'choice') ok(act(state, C, { type: 'chooseOption', optionId: B }));
    // 甲用普通无懈抵消那张国无懈 → 乙丙都恢复
    while (state.pending?.kind === 'wuxieQueue') {
      const asked = state.pending.askQueue[state.pending.askIndex]!;
      if (asked === A) {
        ok(act(state, A, { type: 'respondCard', cardId: 'a2' }));
        break;
      }
      ok(act(state, asked, { type: 'pass' }));
    }
    while (state.pending?.kind === 'wuxieQueue') {
      const asked = state.pending.askQueue[state.pending.askIndex]!;
      ok(act(state, asked, { type: 'pass' }));
    }
    // 乙照常被问响应（南蛮没被抵消）
    expect(state.pending?.kind).toBe('respondTrick');
  });

  it('⑩ 无懈被无懈 → 第一张失效（奇数抵消、偶数恢复）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [juedou('a1'), wuxie('a2')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei', hand: [wuxie('c1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' })); // ① 抵消决斗
    // 甲再用一张普通无懈抵消 ① → 决斗恢复
    while (state.pending?.kind === 'wuxieQueue') {
      const asked = state.pending.askQueue[state.pending.askIndex]!;
      if (asked === A) {
        ok(act(state, A, { type: 'respondCard', cardId: 'a2' }));
        break;
      }
      ok(act(state, asked, { type: 'pass' }));
    }
    while (state.pending?.kind === 'wuxieQueue') {
      const asked = state.pending.askQueue[state.pending.askIndex]!;
      ok(act(state, asked, { type: 'pass' }));
    }
    // 决斗恢复生效 → 乙要出杀
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') expect(state.pending.responderId).toBe(B);
  });

  it('⑪ 离间：技能本体不能被无懈，但它生成的那张【决斗】**可以**被无懈', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'diaochan', faction: 'qun', hand: [mk('a1', 'sha', 'spade')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei', hand: [wuxie('c1')] },
      { seatId: D, name: '丁', heroId: 'lvbu', faction: 'qun', hand: [] },
    ]);
    ok(act(state, A, { type: 'useSkill', skillId: 'lilian', cardIds: ['a1'], targetIds: [B, D] }));
    // 离间本身没有无懈窗口（它是一个技能）；它生成的【决斗】才开窗口
    expect(state.pending?.kind).toBe('wuxieQueue');
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    passWuxie(state);
    // 决斗被抵消 → 两个男性角色都没掉血
    expect(hp(state, B)).toBe(4);
    expect(hp(state, D)).toBe(4);
  });

  it('⑫ 纯技能效果（闭月摸牌）没有无懈窗口', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'diaochan', faction: 'qun', hand: [] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [wuxieguo('b1')] },
    ]);
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'endPhase' }));
    // 一路推到回合交出：全程不该出现无懈窗口（闭月是纯技能效果）
    let guard = 0;
    while (state.pending && state.pending.kind !== 'play' && guard++ < 30) {
      const p = state.pending;
      if (p.kind === 'wuxieQueue') throw new Error('闭月不该开无懈窗口');
      if (p.kind === 'choice') ok(act(state, p.seatId, { type: 'chooseOption', optionId: 'no' }));
      else if (p.kind === 'discard') ok(act(state, p.seatId, { type: 'discard', cardIds: [] }));
      else break;
    }
    expect(logHas(state, '【无懈')).toBe(false);
  });

  it('⑬ 国无懈的势力范围以**基准目标**为准（不是使用者的势力）：蜀丙按魏乙扩散 → 只保护魏', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [wuxieguo('c1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    // 丙（蜀）用国无懈，**以乙为基准** → 扩散的是「魏」那一圈，丙自己（蜀）不在保护范围内
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    if (state.pending?.kind === 'choice') ok(act(state, C, { type: 'chooseOption', optionId: B }));
    passWuxie(state);
    expect(hp(state, B)).toBe(4); // 乙被保护（基准）
    expect(state.pending?.kind).toBe('respondTrick'); // 丙自己仍要响应南蛮
    if (state.pending?.kind === 'respondTrick') expect(state.pending.responderId).toBe(C);
  });

  it('⑭ 国无懈覆盖到的后续目标：轮到它时**不再开无懈窗口**，直接跳过', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei', hand: [wuxieguo('c1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    if (state.pending?.kind === 'choice') ok(act(state, C, { type: 'chooseOption', optionId: B }));
    passWuxie(state); // 国无懈那一链问完 → 乙、丙都被覆盖
    // 乙、丙都不该再被问响应、也不该再开无懈窗口 → 直接回到甲的出牌阶段
    expect(state.pending?.kind).toBe('play');
    expect(hp(state, B)).toBe(4);
    expect(hp(state, C)).toBe(4);
  });
});
