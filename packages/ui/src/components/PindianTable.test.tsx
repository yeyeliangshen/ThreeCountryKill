import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card, PindianView } from '@sgs/protocol';
import { PindianTable } from './PindianTable';

/**
 * 拼点区（用户 2026-09-23 规格）：空牌位 → 牌背 → 双方翻牌 → 点数与胜负。
 *
 * 这里钉的是**渲染出来的东西**（DOM 文本 + class）：空位画「等待扣置」、扣好画**牌背**且
 * 一个字的牌面都不出现、翻牌后画牌名与点数、结果条写明胜/负或平点。
 * 数据侧「双方扣好前不下发牌面」由引擎用例把关（packages/engine/tests/pindian-ui.test.ts）。
 */
const card = (id: string, name: string, rank: number): Card =>
  ({ id, type: 'sha', suit: 'heart', rank, name }) as never;

const players = [
  { seatId: 's0', name: '甲' },
  { seatId: 's1', name: '乙' },
] as never;

const waiting: PindianView = {
  sides: [
    { seatId: 's0', chosen: false, isInitiator: true },
    { seatId: 's1', chosen: false },
  ],
  revealed: false,
};

const oneChosen: PindianView = {
  sides: [
    { seatId: 's0', chosen: true, isInitiator: true },
    { seatId: 's1', chosen: false },
  ],
  revealed: false,
};

const revealed: PindianView = {
  sides: [
    { seatId: 's0', chosen: true, isInitiator: true, card: card('a1', '杀', 13), point: 13 },
    { seatId: 's1', chosen: true, card: card('b1', '桃', 5), point: 5 },
  ],
  revealed: true,
  winnerSeatId: 's0',
  tie: false,
};

const tied: PindianView = {
  sides: [
    { seatId: 's0', chosen: true, isInitiator: true, card: card('a1', '杀', 9), point: 9 },
    { seatId: 's1', chosen: true, card: card('b1', '桃', 9), point: 9 },
  ],
  revealed: true,
  winnerSeatId: null,
  tie: true,
};

const html = (p: PindianView) =>
  renderToStaticMarkup(<PindianTable pindian={p} players={players} meSeatId="s0" />);

describe('拼点区渲染', () => {
  it('开局：两个空牌位 + 「等待扣置」，进度 0/2，且没有牌面', () => {
    const h = html(waiting);
    expect(h.match(/等待扣置/g)?.length).toBe(2);
    expect(h).toContain('已扣 0/2');
    expect(h).toContain('pd-slot empty');
    expect(h).not.toContain('pd-back-img'); // 还没人扣牌 ⇒ 没有牌背
    expect(h).not.toContain('pd-point');
  });

  it('一方扣好：那格画**牌背**（不给牌面），另一格仍是空位', () => {
    const h = html(oneChosen);
    expect(h).toContain('已扣 1/2');
    expect(h).toContain('pd-slot filled'); // 有牌背的那格
    expect(h.match(/等待扣置/g)?.length).toBe(1); // 另一格还在等
    // ⭐ 关键：扣好但没翻牌时，**牌名与点数一个字都不许出现**
    expect(h).not.toContain('杀');
    expect(h).not.toContain('13');
    expect(h).not.toContain('pd-point');
  });

  it('双方扣好 → 翻开：两张牌面 + 点数 + 胜负 + 比大小符号', () => {
    const h = html(revealed);
    expect(h).toContain('拼点 · 结果');
    expect(h).toContain('pd-slot filled');
    expect(h).not.toContain('等待扣置');
    expect(h).toContain('13');
    expect(h).toContain('5');
    expect(h).toContain('pd-face'); // 正面（不是牌背）
    expect(h).not.toContain('pd-back-img');
    expect(h).toContain('>'); // 比大小
    expect(h).toContain('甲 胜');
    expect(h).toContain('乙 负');
  });

  it('平点：写明「平点 · 无人获胜」并给平局样式（不能显示成某方胜）', () => {
    const h = html(tied);
    expect(h).toContain('平点 · 无人获胜');
    expect(h).toContain('pd-result tie');
    expect(h).toContain('='); // 平点的比较符号
    expect(h).not.toContain('胜（点数更大）');
  });

  /**
   * 静态守门：`Game.tsx` 必须真的把这块区域放在**牌桌中央**（记录区那一列），
   * 而且只在有拼点时渲染——不然拼点就只剩日志文字了（用户报的就是「只有文字提示」）。
   */
  it('Game.tsx 把拼点区渲染在**牌桌中央**（对手行与手牌之间，不是右侧日志栏）', () => {
    const src = readFileSync(join(__dirname, '..', 'pages', 'Game.tsx'), 'utf8');
    const boardIdx = src.indexOf('className="board"');
    const pindianIdx = src.indexOf('<PindianTable');
    const dockIdx = src.indexOf('className="dock"');
    expect(boardIdx).toBeGreaterThan(-1);
    expect(pindianIdx).toBeGreaterThan(boardIdx); // 在牌桌那一列
    expect(dockIdx).toBeGreaterThan(pindianIdx); // 在手牌/操作区之前 ⇒ 位于牌桌中部
    expect(src).toContain('<PindianTable');
  });
});
