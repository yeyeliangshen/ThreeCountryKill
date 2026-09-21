import { describe, it, expect } from 'vitest';
import { skillEntryShown } from './skillPhase';

/**
 * 「技能入口在哪些阶段渲染」的回归网（docs §5.177）。
 *
 * 为什么值得单独立一条：这三处门以前各写各的 `prompt.kind === 'play'`，于是**弃牌阶段**
 * 那几枚国战标记（【阴阳鱼】"弃置 → 手牌上限 +2" 那一支）既不渲染、也点不动——
 * 用户报的「标记点了没用」里最典型的一种。判据现在收在 `skillEntryShown`。
 */
describe('技能入口的阶段门', () => {
  it('出牌阶段与弃牌阶段都给入口', () => {
    expect(skillEntryShown('play')).toBe(true);
    expect(skillEntryShown('discard')).toBe(true);
  });

  it('其他阶段都不给（那些时机用不上，也不该在别人的询问里点）', () => {
    for (const kind of [
      'respondSha',
      'respondTrick',
      'respondDeath',
      'wuxieQueue',
      'choice',
      'pickCards',
      'pickSeats',
      'viewCards',
      'factionCall',
      'pickHero',
      undefined,
      null,
    ]) {
      expect(skillEntryShown(kind as string | null | undefined), String(kind)).toBe(false);
    }
  });
});
