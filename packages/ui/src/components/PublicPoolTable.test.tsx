import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card, PublicPoolView } from '@sgs/protocol';
import { PublicPoolTable } from './PublicPoolTable';

/**
 * 【五谷丰登】的牌桌牌池（用户 2026-09-23 规格）：固定顺序平铺在牌桌中央、所有人都看得到、
 * 轮到自己时**直接点牌**拿走、拿走的留在原位标「谁拿走」。
 *
 * 这里钉渲染：顺序、留痕文案、「能不能点」只认快照给的 `interactive`（界面不自己判断轮次）。
 */
const card = (id: string, type: Card['type'], rank: number): Card =>
  ({ id, type, suit: 'spade', rank }) as never;
const SHAN = card('d3', 'shan', 3);
const SHA = card('d2', 'sha', 5);
const TAO = card('d1', 'tao', 9);

const players = [
  { seatId: 's0', name: '甲' },
  { seatId: 's1', name: '乙' },
  { seatId: 's2', name: '丙' },
];

const pool = (over: Partial<PublicPoolView>): PublicPoolView => ({
  slots: [{ card: SHAN }, { card: SHA }, { card: TAO }],
  currentSeatId: 's0',
  queue: ['s0', 's1', 's2'],
  source: 'wugu',
  interactive: false,
  ...over,
});

const bindTip = () => ({});
const html = (p: PublicPoolView, onPick: (id: string) => void = () => {}) =>
  renderToStaticMarkup(
    <PublicPoolTable pool={p} players={players} onPick={onPick} bindTip={bindTip} />,
  );

describe('【五谷丰登】牌池渲染', () => {
  it('固定顺序平铺三张 + 标题写明亮出/已拿走/剩余 + 轮到谁', () => {
    const h = html(pool({}));
    expect(h).toContain('【五谷丰登】');
    expect(h).toContain('亮出 3 张');
    expect(h).toContain('已拿走 0 / 剩 3');
    expect(h).toContain('轮到 甲 选');
    // 顺序就是 slots 的顺序（固定顺序，不重排）
    const order = ['闪', '杀', '桃'].map((n) => h.indexOf(n));
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it('轮到我：每张还能点的牌都是**按钮**（直接点牌拿走）', () => {
    const h = html(pool({ interactive: true }));
    expect(h.match(/pool-card/g)?.length).toBe(3);
    expect(h.match(/<button/g)?.length).toBe(3); // 三张都可点
    expect(h).toContain('pool-card clickable');
  });

  it('不是我的轮次：一张都不给按钮（只能看牌桌）', () => {
    const h = html(pool({ interactive: false, currentSeatId: 's1' }));
    expect(h).not.toContain('<button');
    expect(h).not.toContain('clickable');
    expect(h).toContain('轮到 乙 选');
  });

  it('被拿走的牌**留在原位**并标「谁拿走」（位置不重排，一眼看出第几张归谁）', () => {
    const h = html(
      pool({
        currentSeatId: 's2',
        queue: ['s2'],
        interactive: false,
        slots: [
          { card: SHAN, takenBySeatId: 's0' },
          { card: SHA, takenBySeatId: 's1' },
          { card: TAO },
        ],
      }),
    );
    expect(h).toContain('已拿走 2 / 剩 1');
    expect(h).toContain('甲 拿走');
    expect(h).toContain('乙 拿走');
    expect(h.match(/pool-card taken/g)?.length).toBe(2);
    // 顺序依然是 闪 → 杀 → 桃（被拿走的没往前挤）
    const order = ['闪', '杀', '桃'].map((n) => h.indexOf(n));
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it('全拿完：写「都选完了」，且没有任何可点按钮', () => {
    const h = html(
      pool({
        currentSeatId: undefined,
        queue: [],
        interactive: false,
        slots: [
          { card: SHAN, takenBySeatId: 's0' },
          { card: SHA, takenBySeatId: 's1' },
          { card: TAO, takenBySeatId: 's2' },
        ],
      }),
    );
    expect(h).toContain('都选完了');
    expect(h).not.toContain('<button');
  });

  /**
   * 静态守门：① 牌桌中央那块必须渲染它；② 五谷那一手**不许**再画通用选牌框
   * （否则同一个选择出现两套 UI——用户要的正是「别再是文字选择框」）。
   */
  it('Game.tsx：牌池画在牌桌中央，且 pickFromPool 不再走通用选牌框', () => {
    const src = readFileSync(join(__dirname, '..', 'pages', 'Game.tsx'), 'utf8');
    const boardIdx = src.indexOf('className="board"');
    const poolIdx = src.indexOf('<PublicPoolTable');
    const dockIdx = src.indexOf('className="dock"');
    expect(boardIdx).toBeGreaterThan(-1);
    expect(poolIdx).toBeGreaterThan(boardIdx);
    expect(dockIdx).toBeGreaterThan(poolIdx); // 在对手行与手牌之间 = 牌桌中央
    // 通用选牌框必须排除 pickFromPool
    expect(src).toContain('!prompt.pickFromPool');
  });
});
