/**
 * 【乐不思蜀】的**距离限制**缺陷（用户 2026-09-22 口径，规则权威 → docs/guozhan-roster.md §5.208）。
 *
 * 口径原文：
 *   【乐不思蜀】的合法目标为**除使用者本人以外的一名其他角色**，本身**没有距离限制**。
 *   目标判断＝「存活的其他角色 + 其判定区能够合法置入【乐不思蜀】」；
 *   **不应额外检查角色间距离、攻击范围或坐骑修正**。
 *   距离限制只属于【兵粮寸断】（官方文本「距离 1 以内的角色」）。
 *
 * 改动前的现场：`playDelayedTrick` 把 `lebu` 与 `bingliang` **共用**一条 `distance(...) > 1`，
 * `legal.ts` 又各抄了一份 —— 于是【乐不思蜀】被错误地卡在距离 1 以内。
 *
 * ⚠️ 用例的**区分性**：凡是标了「改动前 ✗」的用例，在本缺陷修掉之前都是**红的**
 *    （`fail(...)` 那里拿到的是「目标超出距离1」，`legalCardIds` 里找不到那张牌），
 *    修好后转绿；标「回归线」的用例在改动前后都必须是绿的——它们钉的是**别把兵粮寸断的
 *    距离限制一起删掉**、以及目标数/自己/存活/判定区那几条校验**保持不动**。
 */
import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  createGame,
  delayedTrickDistanceLimit,
  delayedTrickTargetInRange,
  delayedTrickTargetLegal,
  distance,
  emptyFlags,
  getHero,
  toSnapshot,
  type GameState,
  type SeatSetup,
} from '../src';
import type { Card, Suit } from '@sgs/protocol';

const A = 's0';
const B = 's1';
const C = 's2';
const D = 's3';

function mk(id: string, type: Card['type'], suit: Suit = 'spade', rank = 6): Card {
  return { id, type, suit, rank };
}
const lebu = (id: string, suit: Suit = 'spade') => mk(id, 'lebu', suit);
const bingliang = (id: string) => mk(id, 'bingliang', 'club', 4);
const shan = (id: string, suit: Suit) => mk(id, 'shan', suit, 2);
/** +1 马（防御马）：让「别人计算与他的距离 +1」——坐骑修正也必须**不影响**乐不思蜀 */
const plusMount = (id: string): Card => ({
  id,
  type: 'plusMount',
  suit: 'heart',
  rank: 1,
  equipName: 'dilu',
});

interface SeatOpts {
  seatId: string;
  name: string;
  heroId: string;
  hand?: Card[];
  /** 判定区预置的牌（用来验「同类延时锦囊上限 1 张」） */
  judgment?: Card[];
  plusMount?: boolean;
  alive?: boolean;
}

/** 造一局：跳过选将、指定武将/手牌/判定区/坐骑，并让 0 号位进入出牌阶段 */
function game(seats: SeatOpts[]): GameState {
  const setup: SeatSetup[] = seats.map((s) => ({
    seatId: s.seatId,
    name: s.name,
    heroId: s.heroId,
  }));
  const state = createGame(setup, 'TEST');
  state.draft = null;
  for (const s of seats) {
    const p = state.players.find((pl) => pl.seatId === s.seatId)!;
    const hero = getHero(s.heroId);
    p.heroId = s.heroId;
    p.maxHp = Math.max(1, Math.floor(hero?.maxHp ?? 4));
    p.hp = p.maxHp;
    p.hand = (s.hand ?? []).slice();
    p.judgment = (s.judgment ?? []).slice();
    p.equipment.plusMount = s.plusMount ? plusMount(`pm-${s.seatId}`) : null;
    p.alive = s.alive ?? true;
    p.flags = emptyFlags();
  }
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: A };
  state.log = [];
  return state;
}

const act = (state: GameState, seatId: string, intent: Parameters<typeof applyIntent>[2]) =>
  applyIntent(state, seatId, intent);
function ok(res: ReturnType<typeof applyIntent>, msg?: string) {
  if (!res.ok) throw new Error(`预期成功但失败：${res.error} ${msg ?? ''}`);
}
const player = (state: GameState, seatId: string) =>
  state.players.find((p) => p.seatId === seatId)!;
const legalCards = (state: GameState, seatId: string) =>
  toSnapshot(state, seatId).prompt?.legalCardIds ?? [];

/**
 * 把控制权推到某个座位的出牌阶段：期间的「结束出牌阶段」与「明置武将牌」询问由本函数代答
 * （只推空手局面，所以不会遇到弃牌询问）。
 */
function runToPlayPhase(state: GameState, seatId: string): void {
  for (let i = 0; i < 30; i++) {
    const p = state.pending;
    if (!p) throw new Error('控制权丢了');
    if (p.kind === 'play') {
      if (p.seatId === seatId) return;
      ok(act(state, p.seatId, { type: 'endPhase' }));
      continue;
    }
    if (p.kind === 'choice') {
      const pick = p.options.find((o) => o.id === 'none') ?? p.options[0]!;
      ok(act(state, p.seatId, { type: 'chooseOption', optionId: pick.id }));
      continue;
    }
    throw new Error(`推进中遇到没预料到的询问：${p.kind}`);
  }
  throw new Error(`推进到 ${seatId} 的出牌阶段超时`);
}

// ——————————————————————————————————————————
// ① 唯一事实来源（纯函数）
// ——————————————————————————————————————————
describe('延时锦囊的距离判据：唯一事实来源', () => {
  it('只有【兵粮寸断】有距离上限；【乐不思蜀】【闪电】没有', () => {
    expect(delayedTrickDistanceLimit('bingliang')).toBe(1);
    expect(delayedTrickDistanceLimit('lebu')).toBeNull();
    expect(delayedTrickDistanceLimit('shandian')).toBeNull();
  });

  it('delayedTrickTargetLegal：乐不思蜀看「存活的其他角色 + 判定区」，不看距离', () => {
    // 4 人局：A→C 基础距离 2；B、D 的判定区已有同类【乐不思蜀】
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla' },
      { seatId: B, name: '乙', heroId: 'vanilla', judgment: [lebu('b0')] },
      { seatId: C, name: '丙', heroId: 'vanilla' },
      { seatId: D, name: '丁', heroId: 'vanilla', judgment: [lebu('d0')] },
    ]);
    const a = player(state, A);
    expect(distance(state, A, C)).toBe(2);
    // 远处角色合法（改动前 ✗：这里会因距离被拒）
    expect(delayedTrickTargetLegal(state, a, 'lebu', C)).toBe(true);
    // 自己不行、判定区已有同类的也不行
    expect(delayedTrickTargetLegal(state, a, 'lebu', A)).toBe(false);
    expect(delayedTrickTargetLegal(state, a, 'lebu', B)).toBe(false);
    // 同一局面下【兵粮寸断】的距离限制照旧
    expect(delayedTrickTargetLegal(state, a, 'bingliang', C)).toBe(false);
    // 「距离那一层」单独看：乐不思蜀恒放行
    expect(delayedTrickTargetInRange(state, a, 'lebu', C)).toBe(true);
    expect(delayedTrickTargetInRange(state, a, 'bingliang', C)).toBe(false);
  });
});

// ——————————————————————————————————————————
// ② 出牌校验（playDelayedTrick）
// ——————————————————————————————————————————
describe('【乐不思蜀】没有距离限制（用户 2026-09-22 口径）', () => {
  it('基础距离 2 的目标可以用，牌进判定区（改动前 ✗）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [lebu('lb1')] },
      { seatId: B, name: '乙', heroId: 'vanilla' },
      { seatId: C, name: '丙', heroId: 'vanilla' },
      { seatId: D, name: '丁', heroId: 'vanilla' },
    ]);
    expect(distance(state, A, C)).toBe(2);
    ok(act(state, A, { type: 'playCard', cardId: 'lb1', targetIds: [C] }));
    expect(player(state, C).judgment.map((c) => c.type)).toEqual(['lebu']);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('坐骑修正把距离抬到 2 也不影响（不看坐骑修正）（改动前 ✗）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [lebu('lb1')] },
      { seatId: B, name: '乙', heroId: 'vanilla' },
      { seatId: C, name: '丙', heroId: 'vanilla', plusMount: true },
    ]);
    // 3 人一圈：A→C 基础距离 1，目标 +1 马之后是 2
    expect(distance(state, A, C)).toBe(2);
    ok(act(state, A, { type: 'playCard', cardId: 'lb1', targetIds: [C] }));
    expect(player(state, C).judgment.some((c) => c.type === 'lebu')).toBe(true);
  });

  it('放到距离 2 的目标判定区后，判定阶段照常结算（改动前 ✗）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [lebu('lb1')] },
      { seatId: B, name: '乙', heroId: 'vanilla' },
      { seatId: C, name: '丙', heroId: 'vanilla', plusMount: true },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'lb1', targetIds: [C] }));
    ok(act(state, A, { type: 'endPhase' })); // A 结束 → B 的出牌阶段
    runToPlayPhase(state, B);
    // 控制判定牌：黑桃 5（非红桃）置于牌堆顶（drawOne 从末尾 pop）。
    // ⚠️ 必须在 B 的摸牌阶段**之后**压牌——B 开回合会摸两张，压早了会被 B 摸走。
    state.deck.push(mk('jc', 'sha', 'spade', 5));
    ok(act(state, B, { type: 'endPhase' })); // B 结束 → C 的判定阶段
    expect(player(state, C).flags.skipPlay).toBe(true);
    expect(player(state, C).judgment).toHaveLength(0);
    expect(state.log.some((e) => e.message.includes('【乐不思蜀】'))).toBe(true);
  });

  it('【兵粮寸断】距离 2 仍然被拒（回归线：别把它的限制一起删了）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [bingliang('bl1')] },
      { seatId: B, name: '乙', heroId: 'vanilla' },
      { seatId: C, name: '丙', heroId: 'vanilla' },
      { seatId: D, name: '丁', heroId: 'vanilla' },
    ]);
    expect(distance(state, A, C)).toBe(2);
    const res = act(state, A, { type: 'playCard', cardId: 'bl1', targetIds: [C] });
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('距离');
    // 距离 1 的角色照常可以（限制没被删，只是没错加在乐不思蜀身上）
    ok(act(state, A, { type: 'playCard', cardId: 'bl1', targetIds: [B] }));
    expect(player(state, B).judgment.some((c) => c.type === 'bingliang')).toBe(true);
  });

  it('奇才（黄月英）对【兵粮寸断】的豁免仍然有效（回归线）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'huangyueying', hand: [bingliang('bl1')] },
      { seatId: B, name: '乙', heroId: 'vanilla' },
      { seatId: C, name: '丙', heroId: 'vanilla' },
      { seatId: D, name: '丁', heroId: 'vanilla' },
    ]);
    expect(distance(state, A, C)).toBe(2);
    ok(act(state, A, { type: 'playCard', cardId: 'bl1', targetIds: [C] }));
  });

  it('目标数 / 自己 / 存活 / 判定区同类 的校验保持不动（回归线）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [lebu('lb1'), lebu('lb2'), lebu('lb3')] },
      { seatId: B, name: '乙', heroId: 'vanilla' },
      { seatId: C, name: '丙', heroId: 'vanilla', judgment: [lebu('c0')] },
      { seatId: D, name: '丁', heroId: 'vanilla', alive: false },
    ]);
    // 必须正好 1 名目标
    expect(act(state, A, { type: 'playCard', cardId: 'lb1', targetIds: [] }).ok).toBe(false);
    expect(act(state, A, { type: 'playCard', cardId: 'lb1', targetIds: [B, C] }).ok).toBe(false);
    // 不能是自己
    expect(act(state, A, { type: 'playCard', cardId: 'lb1', targetIds: [A] }).ok).toBe(false);
    // 目标必须存活
    expect(act(state, A, { type: 'playCard', cardId: 'lb1', targetIds: [D] }).ok).toBe(false);
    // 判定区已有同类延时锦囊 → 不能置入（哪怕距离 2 也一样拦）
    expect(act(state, A, { type: 'playCard', cardId: 'lb2', targetIds: [C] }).ok).toBe(false);
    // 距离 1 且判定区干净的乙照常可以
    ok(act(state, A, { type: 'playCard', cardId: 'lb3', targetIds: [B] }));
    expect(player(state, B).judgment.some((c) => c.type === 'lebu')).toBe(true);
  });
});

// ——————————————————————————————————————————
// ③ 提示下发（legal.ts）：合法牌 / 合法目标
// ——————————————————————————————————————————
describe('提示里的【乐不思蜀】合法目标', () => {
  it('远处角色是合法目标：只有他可选时，这张牌照样亮着（改动前 ✗）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [lebu('lb1')] },
      // B、D 的判定区已占（同类延时锦囊上限 1 张），于是只剩距离 2 的 C 可指
      { seatId: B, name: '乙', heroId: 'vanilla', judgment: [lebu('b0')] },
      { seatId: C, name: '丙', heroId: 'vanilla' },
      { seatId: D, name: '丁', heroId: 'vanilla', judgment: [lebu('d0')] },
    ]);
    const prompt = toSnapshot(state, A).prompt!;
    expect(distance(state, A, C)).toBe(2);
    expect(prompt.legalCardIds).toContain('lb1');
    // 远处的角色本身也在可点目标里（提示不按距离筛目标）
    expect(prompt.legalTargetIds).toContain(C);
  });

  it('【兵粮寸断】：只剩距离 2 的角色可指时，这张牌不该亮（回归线）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [bingliang('bl1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', judgment: [bingliang('b0')] },
      { seatId: C, name: '丙', heroId: 'vanilla' },
      { seatId: D, name: '丁', heroId: 'vanilla', judgment: [bingliang('d0')] },
    ]);
    expect(distance(state, A, C)).toBe(2);
    expect(legalCards(state, A)).not.toContain('bl1');
  });
});

// ——————————————————————————————————————————
// ④ 技能路径：转化牌产生的延时锦囊走**同一份**判据
// ——————————————————————————————————————————
describe('技能产生的【乐不思蜀】沿用同一份目标规则', () => {
  it('大乔·国色（方块牌当【乐不思蜀】）可对距离 2 的角色使用（改动前 ✗）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'daqiao', hand: [shan('a1', 'diamond')] },
      { seatId: B, name: '乙', heroId: 'vanilla' },
      { seatId: C, name: '丙', heroId: 'vanilla', plusMount: true },
    ]);
    expect(distance(state, A, C)).toBe(2);
    // 提示里这张方块牌是合法牌（远处角色也算合法目标）
    expect(legalCards(state, A)).toContain('a1');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', as: 'lebu', targetIds: [C] }));
    expect(player(state, C).judgment.some((c) => c.type === 'lebu')).toBe(true);
  });

  it('徐晃·断粮（黑牌当【兵粮寸断】）对距离 2 的角色仍被拒（回归线）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'xuhuang', hand: [mk('a1', 'shan', 'spade', 1)] },
      { seatId: B, name: '乙', heroId: 'vanilla' },
      { seatId: C, name: '丙', heroId: 'vanilla' },
      { seatId: D, name: '丁', heroId: 'vanilla' },
    ]);
    expect(distance(state, A, C)).toBe(2);
    expect(
      act(state, A, { type: 'playCard', cardId: 'a1', as: 'bingliang', targetIds: [C] }).ok,
    ).toBe(false);
  });
});
