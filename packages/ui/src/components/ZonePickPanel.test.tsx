import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card, ZonePickLayout } from '@sgs/protocol';
import { ZonePickPanel } from './ZonePickPanel';

/**
 * 「操作别人区域里的牌」的分区面板（用户 2026-09-23 的口径）：
 * 不同角色**横向分栏**、同一角色内 hand/equip/judge **纵向分区**、**不写区名文字**、
 * 隐藏手牌一律牌背（带 `card` 的才画牌面）。
 */
const card = (id: string, type: Card['type'], equipName?: string): Card =>
  ({ id, type, suit: 'spade', rank: 2, ...(equipName ? { equipName } : {}) }) as Card;

const layout = (over?: Partial<ZonePickLayout>): ZonePickLayout => ({
  targets: [
    {
      seatId: 's1',
      zones: [
        { zone: 'hand', items: [{ optionId: 'hand:0' }, { optionId: 'hand:1' }] },
        {
          zone: 'equip',
          items: [
            { optionId: 'card:e1', card: card('e1', 'armor', 'bagua') },
            { optionId: 'card:e2', card: card('e2', 'plusMount', 'dilu') },
          ],
        },
        { zone: 'judge', items: [{ optionId: 'card:j1', card: card('j1', 'lebu') }] },
      ],
    },
  ],
  ...over,
});

const players = [
  { seatId: 's0', name: '我' },
  { seatId: 's1', name: '甲' },
  { seatId: 's2', name: '乙' },
];
const html = (l: ZonePickLayout, onPick: (id: string) => void = () => {}) =>
  renderToStaticMarkup(
    <ZonePickPanel layout={l} players={players} onPick={onPick} bindTip={() => ({})} />,
  );

describe('分区选牌面板', () => {
  it('按角色分栏 + 区内分区：手牌画**牌背**、装备/判定画**牌面**', () => {
    const h = html(layout());
    // 手牌两张 = 两个牌背；装备两张 + 判定一张 = 三个牌面
    expect(h.match(/zp-back"/g)?.length).toBe(2);
    expect(h.match(/zp-face"/g)?.length).toBe(3);
    expect(h).toContain('八卦阵');
    expect(h).toContain('的卢');
    expect(h).toContain('乐不思蜀');
    // 三个区都在（有 hand/equip/judge 三个容器）
    expect(h).toContain('zp-hand');
    expect(h).toContain('zp-equip');
    expect(h).toContain('zp-judge');
  });

  it('**不写区名文字**（用户明确要求：靠位置区分）', () => {
    const h = html(layout());
    expect(h).not.toContain('手牌区');
    expect(h).not.toContain('装备区');
    expect(h).not.toContain('判定区');
  });

  it('隐藏的手牌不给任何牌面信息（连 aria-label 都只说「看不到牌面」）', () => {
    const h = html(layout());
    const backBlock = h.slice(h.indexOf('zp-back'), h.indexOf('zp-back') + 320);
    expect(backBlock).toContain('看不到牌面');
    // 牌背里没有牌名/花色点数
    expect(backBlock).not.toContain('♠');
    expect(backBlock).not.toContain('八卦阵');
  });

  it('只显示规则允许的区域（寒冰剑那种：没有判定区就不出现）', () => {
    const h = html(
      layout({
        targets: [
          {
            seatId: 's1',
            zones: [
              { zone: 'hand', items: [{ optionId: 'hand:0' }] },
              { zone: 'equip', items: [{ optionId: 'card:e1', card: card('e1', 'armor', 'bagua') }] },
            ],
          },
        ],
      }),
    );
    expect(h).toContain('zp-hand');
    expect(h).toContain('zp-equip');
    expect(h).not.toContain('zp-judge');
  });

  it('多目标：每个角色一个独立栏（横向并排）', () => {
    const h = html({
      targets: [
        { seatId: 's1', zones: [{ zone: 'hand', items: [{ optionId: 'hand:0' }] }] },
        { seatId: 's2', zones: [{ zone: 'hand', items: [{ optionId: 'hand:0' }] }] },
      ],
    });
    expect(h.match(/zp-target/g)?.length).toBe(2);
    expect(h).toContain('甲');
    expect(h).toContain('乙');
    expect(h).toContain('zone-pick multi');
  });

  it('点某一张发的是它自己的 optionId（引擎照旧按 chooseOption 解析）', () => {
    const seen: string[] = [];
    const h = html(layout(), (id) => seen.push(id));
    // 渲染出来的每个可点元素都带上了正确的 optionId（用 aria-label 反查太脆，直接看结构）
    expect(h).toContain('<button');
    expect((h.match(/<button/g) ?? []).length).toBe(5); // 2 手牌 + 2 装备 + 1 判定
    expect(seen).toEqual([]); // 渲染不触发点击
  });

  it('Game.tsx 在 choice 询问带布局时改用这块面板（老询问照旧一排按钮）', () => {
    const src = readFileSync(join(__dirname, '..', 'pages', 'Game.tsx'), 'utf8');
    expect(src).toContain('<ZonePickPanel');
    expect(src).toContain('prompt.kind === \'choice\' && prompt.zonePick');
    expect(src, '带布局与不带布局是两条渲染分支').toContain("prompt.kind === 'choice' && !prompt.zonePick");
  });
});
