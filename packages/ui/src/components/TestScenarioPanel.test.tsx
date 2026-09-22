/**
 * 「测试场景编辑器」面板（开发工具，docs §5.206）—— 静态渲染测试。
 *
 * 仓库的 UI 测试约定是 `renderToStaticMarkup` + 纯数据 fixture（没有 jsdom / testing-library），
 * 所以这里验的是**渲染出来的结构**，交互逻辑交给引擎侧（`testDealZonesFor` / `applyTestScenario`
 * 已在 packages/engine/tests/test-scenario.test.ts 里逐条钉过）。
 *
 * 另外守一条**门槛**：面板的入口在 Game 页里必须是「dev 构建 + 服务端 devTools」双条件，
 * 免得哪天顺手把开发工具露在正式对局里（这条用源码静态检查，跟 PindianTable 的挂载点守卫一个路子）。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestScenarioCard } from '@sgs/engine';
import { TestScenarioPanel } from './TestScenarioPanel';

const catalog: TestScenarioCard[] = [
  { id: 'g1', name: '寒冰剑', zone: 'hand', type: 'weapon', copies: 1 },
  { id: 'c2', name: '火杀', zone: 'hand', type: 'sha', copies: 5 },
  { id: 'c3', name: '乐不思蜀', zone: 'hand', type: 'lebu', copies: 2 },
  { id: 'c4', name: '闪电', zone: 'hand', type: 'shandian', copies: 1 },
];

const players = [
  { seatId: 's0', name: '甲' },
  { seatId: 's1', name: '乙' },
];

const html = (over: Partial<Parameters<typeof TestScenarioPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <TestScenarioPanel
      players={players}
      defaultSeatId="s0"
      catalog={catalog}
      onDeal={() => {}}
      onJie={() => {}}
      onClose={() => {}}
      {...over}
    />,
  );

describe('测试场景编辑器：面板结构', () => {
  it('列出目标玩家、牌名、三个区域，并标出「节」与日志标记', () => {
    const out = html();
    expect(out).toContain('ds-seat');
    expect(out).toContain('甲');
    expect(out).toContain('乙');
    // 牌名按显示名（装备显示具体牌名，不是「武器」）
    expect(out).toContain('寒冰剑');
    expect(out).toContain('火杀');
    expect(out).toContain('乐不思蜀');
    expect(out).not.toContain('>武器<');
    // 三个区域按钮
    expect(out).toContain('手牌');
    expect(out).toContain('装备区');
    expect(out).toContain('判定区');
    // 「节」那一行 + TEST_DEAL_OVERRIDE 提示
    expect(out).toContain('发放节');
    expect(out).toContain('TEST_DEAL_OVERRIDE');
  });

  it('右上角有标题与关闭按钮（浮层不是全屏遮罩，牌桌还能操作）', () => {
    const out = html();
    expect(out).toContain('测试场景编辑器');
    expect(out).toContain('ds-close');
    expect(out).toContain('关闭');
  });

  it('没选牌时「发放」是禁用的（避免误点）', () => {
    const out = html();
    // 页面上有两个「发放」按钮（牌 / 节）——牌那个必须是 disabled
    const dealButtons = out.split('ds-deal');
    expect(dealButtons.length).toBeGreaterThan(1);
    expect(out).toMatch(/<button class="ds-deal" disabled="">发放<\/button>/);
  });

  it('张数 >1 的牌标出 ×N（杀这类重复牌一眼看出有几张）', () => {
    expect(html()).toContain('×5');
  });

  it('卡片的 title 说明它能放哪些区域（区域规则在界面上可见）', () => {
    const out = html();
    expect(out).toContain('可放：手牌/装备区'); // 寒冰剑
    expect(out).toContain('可放：手牌/判定区'); // 乐不思蜀、闪电
  });
});

describe('测试场景编辑器：入口只在开发模式（源码守卫）', () => {
  const src = readFileSync(join(__dirname, '..', 'pages', 'Game.tsx'), 'utf8');

  it('Game 页用「dev 构建 + 服务端 devTools」双条件把面板挡在正式对局之外', () => {
    expect(src).toContain('Boolean(lobby?.devTools) && import.meta.env.DEV');
  });

  it('面板与入口按钮都挂在同一个 devTools 条件下（不会漏出一半）', () => {
    expect(src).toContain('dev-setup-toggle');
    expect(src).toContain('{devTools && devOpen ? (');
    expect(src).toContain('<TestScenarioPanel');
  });

  it('入口按钮的名字就是「测试场景编辑器」（用户 2026-09-25：这是开发工具的正式叫法，不是「发牌自选」）', () => {
    expect(src).toContain('测试场景编辑器');
    // 面板自己的 aria-label 也用同一个名字（无障碍读屏时一致）
    const panel = readFileSync(join(__dirname, 'TestScenarioPanel.tsx'), 'utf8');
    expect(panel).toContain('aria-label="测试场景编辑器"');
  });

  it('面板把意图发给服务端（引擎侧才是权威），界面上不自己改牌', () => {
    expect(src).toContain(
      "sendIntent({ type: 'testScenario', deals: [{ seatId, cardId, zone }] })",
    );
    expect(src).toContain("sendIntent({ type: 'testScenario', jie: [{ seatId, count }] })");
  });
});
