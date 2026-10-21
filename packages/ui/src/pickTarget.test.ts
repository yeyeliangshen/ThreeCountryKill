import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 出牌选目标的**快速连点**守门（真机调虎离山验收抓到的真 bug）：
 *
 * `pickTarget` 以前读**渲染闭包**里的 `selected`（非函数式 setState）——同一帧内连点两个目标，
 * 第二次读到还没重渲染的旧 `selected` ⇒ 第一个目标被**覆盖**，多目标牌（调虎离山/铁索连环…）
 * 只生效后点的那家。修成函数式更新（读 prev）。
 */
describe('选目标的快速连点不许丢目标', () => {
  const game = readFileSync(join(__dirname, 'pages/Game.tsx'), 'utf8');

  it('pickTarget 用函数式 setState（读 prev）', () => {
    const i = game.indexOf('function pickTarget');
    const body = game.slice(i, game.indexOf('\n  }', i));
    expect(body).toContain('setSelected((prev) =>');
    expect(body).not.toMatch(/setSelected\(\{\s*\.\.\.selected/);
  });
});
