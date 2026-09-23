import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 「与当前这条询问有关的角色」的**界面守门**（用户 2026-09-25 口径）：
 *
 * 徐盛·【疑城】问徐盛时，被保护的那位要在牌桌上**轻微高亮**——让徐盛一眼看出
 * 「我现在保护的是谁」。判据由引擎下发（`PromptView.relatedSeats`），
 * 界面**只显示**，而且**不改变可点性**（可点与否仍由 legalTargets / 候选决定）。
 */
describe('relatedSeats：仅高亮、不改可点性', () => {
  const game = readFileSync(join(__dirname, 'pages/Game.tsx'), 'utf8');

  it('对手那一行读引擎下发的 relatedSeats，加一枚 related 类', () => {
    expect(game).toContain('prompt?.relatedSeats?.includes(p.seatId)');
    expect(game).toContain("${isRelated ? 'related' : ''}");
  });

  it('related 只影响样式，不参与 canClickTarget 的判据', () => {
    // 可点性只看 legalTargets / 候选 / 已选 —— relatedSeats 不许出现在这些判据里
    const canClick = game.slice(game.indexOf('function canClickTarget'), game.indexOf('function handleTargetClick'));
    expect(canClick).not.toContain('relatedSeats');
    expect(canClick).toContain('legalTargets');
  });

  it('保护**自己**时自己的面板也描边（徐盛自己被杀那种情形）', () => {
    expect(game).toContain('related={prompt?.relatedSeats?.includes(me.seatId) ?? false}');
    const panel = readFileSync(join(__dirname, 'components/HeroPanel.tsx'), 'utf8');
    expect(panel).toContain('related?: boolean;');
    expect(panel).toContain('relatedClass');
  });

  it('样式只有描边（不加动画、不改指针）', () => {
    const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
    expect(css).toContain('.player.related');
    expect(css, '自己面板那一份也在').toContain('.hero-panel.related');
    const block = css.slice(css.indexOf('.player.related'), css.indexOf('.player.related') + 220);
    expect(block).toContain('box-shadow');
    expect(/animation|@keyframes|cursor/.test(block), '不带动画、不改指针').toBe(false);
  });
});
