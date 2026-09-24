import { describe, it, expect } from 'vitest';
import type { ChainSpreadView } from '@sgs/protocol';
import {
  chainSpreadBySeat,
  chainSpreadSequence,
  chainSpreadTotalMs,
  diffChainStates,
  CHAIN_STEP_MS,
  type ChainSeat,
} from './chainState';

/**
 * 连环状态的**判据**（用户 2026-09-24 口径）：绑定「连环状态」本身，不绑定【铁索连环】这张牌。
 *
 * 这里钉三件事：
 *   ① 状态 diff 只认 `chained` 的翻转，且**只认状态**（测试里根本不提是哪张牌/哪个技能改的）；
 *   ② 没有基线（第一次见到某人）不产生事件——否则重连/刷新会播一遍假动画；
 *   ③ 传导顺序**照抄引擎给的 index**，前端不许自己按座位号重排。
 */
const seats = (...list: [string, boolean][]): ChainSeat[] =>
  list.map(([seatId, chained]) => ({ seatId, name: `玩家${seatId}`, chained }));

describe('连环状态 diff → 事件流', () => {
  it('false → true 是「进入」，true → false 是「解除」，没变就不产生事件', () => {
    const prev = seats(['s0', false], ['s1', true], ['s2', false]);
    const next = seats(['s0', true], ['s1', true], ['s2', false]);
    expect(diffChainStates(prev, next)).toEqual([
      { seatId: 's0', name: '玩家s0', kind: 'chained', index: 1 },
    ]);
    expect(diffChainStates(next, seats(['s0', false], ['s1', true], ['s2', false]))).toEqual([
      { seatId: 's0', name: '玩家s0', kind: 'unchained', index: 1 },
    ]);
    // 一个人同时进入、一个人同时解除：两个事件都在，指数按 players 顺序
    expect(
      diffChainStates(
        seats(['s0', false], ['s1', true]),
        seats(['s0', true], ['s1', false], ['s2', true]),
      ),
    ).toEqual([
      { seatId: 's0', name: '玩家s0', kind: 'chained', index: 1 },
      { seatId: 's1', name: '玩家s1', kind: 'unchained', index: 2 },
    ]);
  });

  it('没有基线（第一份快照 / 刚进房 / 刷新重连）不产生任何事件', () => {
    expect(diffChainStates(null, seats(['s0', true], ['s1', true]))).toEqual([]);
    // 第一次见到某个座次（新加入的人）同样不当成「刚被横置」
    const prev = seats(['s0', true]);
    expect(diffChainStates(prev, seats(['s0', true], ['s1', true]))).toEqual([]);
  });

  it('缺省 chained 视作未横置（老快照没有这个字段时不会误报）', () => {
    const prev: ChainSeat[] = [{ seatId: 's0', name: '甲' }];
    expect(diffChainStates(prev, [{ seatId: 's0', name: '甲', chained: true }])).toEqual([
      { seatId: 's0', name: '甲', kind: 'chained', index: 1 },
    ]);
  });

  it('与「是谁改的」无关：同一份 diff 里看不出牌或技能', () => {
    // 事件里只有座次/名字/方向/序号——没有 card、没有 skillId 这类字段
    const ev = diffChainStates(seats(['s0', false]), seats(['s0', true]))[0]!;
    expect(Object.keys(ev).sort()).toEqual(['index', 'kind', 'name', 'seatId']);
  });
});

describe('传导顺序 → 动画序列', () => {
  const view = (over: Partial<ChainSpreadView> = {}): ChainSpreadView => ({
    seq: 3,
    fromSeatId: 's1',
    order: [
      { seatId: 's3', index: 1 },
      { seatId: 's2', index: 2 },
    ],
    ...over,
  });

  it('源头排第一（order 0、延时 0），其余按**引擎给的 index** 依次延后', () => {
    expect(chainSpreadSequence(view())).toEqual([
      { seatId: 's1', order: 0, delayMs: 0 },
      { seatId: 's3', order: 1, delayMs: CHAIN_STEP_MS },
      { seatId: 's2', order: 2, delayMs: CHAIN_STEP_MS * 2 },
    ]);
  });

  it('顺序照抄引擎，不按座位号重排（这里引擎给的名单就是反着座位序的）', () => {
    const steps = chainSpreadSequence(view());
    expect(steps.map((s) => s.seatId)).toEqual(['s1', 's3', 's2']);
    expect(steps.map((s) => s.order)).toEqual([0, 1, 2]);
    // 归零成「前端自己按 seatId 排序」就会变成 s1,s2,s3 —— 明确钉死不是这样
    expect(steps.map((s) => s.seatId)).not.toEqual(['s1', 's2', 's3']);
  });

  it('步长可覆盖（测试/慢速调试用），延时严格递增', () => {
    const steps = chainSpreadSequence(view(), 100);
    expect(steps.map((s) => s.delayMs)).toEqual([0, 100, 200]);
    expect(chainSpreadTotalMs(view(), 100)).toBe(2 * 100 + 900);
  });

  it('座位查表（卡面按顺序闪一下用）：源头与每一棒都能查到自己那一棒', () => {
    const bySeat = chainSpreadBySeat(view());
    expect(bySeat['s1']).toEqual({ seatId: 's1', order: 0, delayMs: 0 });
    expect(bySeat['s2']!.order).toBe(2);
    expect(bySeat['s3']!.delayMs).toBe(CHAIN_STEP_MS);
    expect(chainSpreadBySeat(null)).toEqual({});
  });
});
