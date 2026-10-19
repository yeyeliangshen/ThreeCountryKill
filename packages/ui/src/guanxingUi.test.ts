import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **观星大面板**（用户 §十一：中央观星区、拖动排序）的界面守门。
 *
 * 关键约束：
 * - 它只是 `pickCards` 的一种**皮肤**：检测＝`pickTitle` 含「观星」；回答仍是
 *   `pickCards(cardIds)`（有序）——**不改询问结构、不改 intent 形状**；
 * - 顺序如实画出来（序号 + 当前顺序），确认按这个顺序发——顺序语义在引擎；
 * - 其它选牌（刚烈/仁德/五谷/盲选）**不许**被它接管；
 * - 桌面拖拽重排 + 手机点选/◀▶ 微调两条路都要有（HTML5 拖不动触屏）。
 */
describe('观星拖动大面板', () => {
  const game = readFileSync(join(__dirname, 'pages/Game.tsx'), 'utf8');
  const panel = readFileSync(join(__dirname, 'components/GuanxingPanel.tsx'), 'utf8');

  it('检测条件＝pickTitle 含「观星」，且只在非盲选/非牌池时接管', () => {
    expect(panel).toContain("title.includes('观星')");
    expect(game).toContain('isGuanxingPick(prompt.pickTitle)');
    // 通用行加了反向条件 ⇒ 其它选牌照旧
    expect(game.match(/!isGuanxingPick\(prompt\.pickTitle\)/g)?.length).toBeGreaterThanOrEqual(1);
    expect(game).toContain('!prompt.pickHidden');
    expect(game).toContain('!prompt.pickFromPool');
  });

  it('intent 形状不变：确认仍走 confirmPickCards（发 pickCards，有序）', () => {
    expect(game).toContain('onConfirm={confirmPickCards}');
  });

  it('两步的区名跟着标题走（置顶 / 沉底），不自己猜步骤', () => {
    expect(panel).toContain("title.includes('底')");
    expect(panel).toContain('牌堆顶（第一张最先被抽到）');
    expect(panel).toContain('牌堆底（先点＝沉得越靠前、越先被抽到）');
  });

  it('桌面拖拽（draggable + 三类落点）与手机（点选 + ◀▶ 微调）都有', () => {
    expect(panel).toContain('draggable');
    expect(panel).toContain('onDragStart');
    expect(panel).toContain('onReorder');
    expect(panel).toContain('aria-label="往前挪"');
    expect(panel).toContain('aria-label="往后挪"');
  });

  it('顺序如实画：已选牌带 ①②③ 序号（c-order），未安排区在下方', () => {
    expect(panel).toContain('c-order');
    expect(panel).toContain('gx-rest');
  });

  it('样式齐备（.guanxing / .gx-zone / .gx-nudge），不带动画', () => {
    const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
    for (const cls of ['.guanxing', '.gx-zone', '.gx-top', '.gx-rest', '.gx-nudge', '.gx-empty']) {
      expect(css, `styles.css 应有 ${cls}`).toContain(cls);
    }
    const block = css.slice(css.indexOf('.guanxing'), css.indexOf('.guanxing') + 900);
    expect(/animation|@keyframes/.test(block), '不加动画').toBe(false);
  });
});
