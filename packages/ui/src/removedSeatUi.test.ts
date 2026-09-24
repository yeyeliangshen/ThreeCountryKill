import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 「移出座次」（【调虎离山】）的**界面守门**：
 *
 * 牌面写着「不计入距离和座次的计算」，结算日志也点名了谁被移出——但牌桌上以前**没有任何标记**，
 * 玩家只能靠回忆知道谁不在座次里（距离、队列、围攻都跟着变了）。所以两个渲染点各画一枚很轻的「移」标，
 * 值来自引擎下发的 `PlayerView.removedFromSeating`（公开状态）。
 */
describe('移出座次标记', () => {
  it('两个渲染点都从引擎下发的字段来', () => {
    const game = readFileSync(join(__dirname, 'pages/Game.tsx'), 'utf8');
    const panel = readFileSync(join(__dirname, 'components/HeroPanel.tsx'), 'utf8');
    expect(game).toContain('p.removedFromSeating');
    expect(panel).toContain('me.removedFromSeating');
    for (const src of [game, panel]) expect(src).toContain('removed-badge');
  });

  it('样式很轻：虚线小标、不加动画、不改指针', () => {
    const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
    expect(css).toContain('.removed-badge');
    const block = css.slice(css.indexOf('.removed-badge'), css.indexOf('.removed-badge') + 260);
    expect(block).toContain('dashed');
    expect(/animation|@keyframes|cursor/.test(block)).toBe(false);
  });
});
