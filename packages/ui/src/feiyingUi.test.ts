import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 【飞影】/【鹤翼】那两枚状态标的**界面守门**（用户 2026-09-26 口径）：
 *
 * - 飞影**可能是别人给的**（【鹤翼】两态互斥：队列态下同队列的其他人有飞影、曹洪自己反而没有）
 *   ⇒ 标上要能写清**来源**，玩家才知道「这不是他自己的武将技」；
 * - 鹤翼持有者本人要把**当前形态**写在标上（常规 / 队列），别写成「全员都有飞影」；
 * - 两枚标都只是**显示**：判据在引擎（`hasFeiying` / `heyiInFormation` / `feiyingSource`），
 *   界面不自己算距离或座次。
 */
describe('飞影 / 鹤翼形态标', () => {
  const game = readFileSync(join(__dirname, 'pages/Game.tsx'), 'utf8');
  const panel = readFileSync(join(__dirname, 'components/HeroPanel.tsx'), 'utf8');

  it('两个渲染点都画飞影标，且值来自引擎下发的 feiying / feiyingFrom', () => {
    expect(game).toContain('p.feiying');
    expect(game).toContain('p.feiyingFrom');
    expect(panel).toContain('me.feiying');
    for (const src of [game, panel]) expect(src).toContain('feiying-badge');
  });

  it('飞影的说明里写了**来源**（鹤翼）', () => {
    expect(game).toContain('来源：【鹤翼】');
    expect(panel).toContain('来源：【鹤翼】');
  });

  it('鹤翼持有者本人的形态标（常规 / 队列），值来自引擎下发的 heyiMode', () => {
    expect(panel).toContain('me.heyiMode');
    expect(panel).toContain('heyi-badge');
    // 标上的文字按 heyiMode 二选一（实际写法是模板：鹤翼·{formation ? '队列' : '常规'}）
    expect(panel).toContain("me.heyiMode === 'formation' ? '队列' : '常规'");
    expect(panel).toContain('鹤翼·');
  });

  it('界面不自己算距离 / 座次（判据只在引擎）', () => {
    expect(game).not.toContain('hasFeiying');
    expect(game).not.toContain('formationQueue');
    expect(panel).not.toContain('hasFeiying');
  });

  it('样式很轻：小标、不加动画', () => {
    const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
    expect(css).toContain('.feiying-badge');
    expect(css).toContain('.heyi-badge');
    const block = css.slice(css.indexOf('.feiying-badge'), css.indexOf('.feiying-badge') + 500);
    expect(/animation|@keyframes/.test(block), '不加动画').toBe(false);
  });
});
