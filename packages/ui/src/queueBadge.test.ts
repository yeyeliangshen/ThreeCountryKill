import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 「队列」与【天覆】形态的**界面侧守门**（用户 2026-09-24 口径 §六）。
 *
 * 判据只在引擎里（`heroes.formationQueue` / `heroes.tianfuMode`）：队列＝连续相邻同势力 ≥2 人，
 * 【天覆】在两态（常规＝自己回合内♠／队列＝同队列回合内黑牌）之间实时切换。界面**只显示**——
 * 一旦有人在 UI 里重算一遍势力相邻，两处口径迟早会分叉（这就是之前「连环状态」踩过的老路）。
 */
describe('队列标记 + 【天覆】形态：界面只显示、不自己算', () => {
  const ui = (p: string) => readFileSync(join(__dirname, p), 'utf8');

  it('两个渲染点（对手那一行 / 自己的面板）都读引擎下发的 `inFormation`', () => {
    for (const file of ['pages/Game.tsx', 'components/HeroPanel.tsx']) {
      const src = ui(file);
      expect(src, `${file} 应画队列标记`).toContain('queue-badge');
      expect(src, `${file} 的判据必须是引擎下发的 inFormation`).toContain('inFormation');
    }
    // ⚠️ 界面不许自己算「相邻同势力」——势力比较只应出现在引擎里
    const game = ui('pages/Game.tsx');
    expect(/formationQueue|effectiveFaction/.test(game), '界面里不该出现引擎的队列/势力判定').toBe(false);
  });

  it('【天覆】的说明跟着 `me.tianfuMode` 走，且两态都写了（否则只有一个形态说得清）', () => {
    const game = ui('pages/Game.tsx');
    expect(game).toContain('me.tianfuMode');
    expect(game, '队列形态的说明').toContain('队列（黑色手牌 → 无懈可击）');
    expect(game, '常规形态的说明').toContain('常规（你的回合内：黑桃手牌 → 无懈可击）');
  });

  it('有 `.queue-badge` 的样式（很轻：不加动画、不连线）', () => {
    const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
    const block = css.slice(css.indexOf('.queue-badge'));
    expect(block.length, 'styles.css 里应有 .queue-badge 规则').toBeGreaterThan(20);
    expect(/animation|@keyframes/.test(block.slice(0, 400)), '队列标记不加持续动画').toBe(false);
  });

  it('形态只有引擎的两个取值，界面按同一枚举分支', () => {
    const game = ui('pages/Game.tsx');
    expect(game).toContain("me.tianfuMode === 'formation'");
  });
});
