import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasSpecialZones, specialZoneChips } from './specialZones';

/**
 * 「武将牌上的牌区」的**统一口径**（公开信息）。
 *
 * 为什么值得测：这块以前只有**自己的面板**画，对手那一行什么都没有 ⇒ 对手有几张「节」
 * （满 3 就不再被【谦逊】挡）、几张「权」全看不到。真机验收 2026-09-22 撞出来的。
 * 两个消费者（HeroPanel 与 Game.tsx 的 opponents-row）必须共用这一份列表。
 */
describe('武将牌上的牌区（自己 / 对手共用）', () => {
  const card = (id: string, type: string) => ({ id, type, suit: 'spade', rank: 3 }) as never;

  it('实体牌逐张列**牌名**（不是内部类型 id），张数类画「X·N」', () => {
    const chips = specialZoneChips({
      jie: [card('j1', 'guohe'), card('j2', 'lebu')],
      quan: [card('q1', 'sha')],
      tianCount: 2,
      wounds: [card('w1', 'sha')],
    } as never);
    const labels = chips.map((c) => c.label);
    expect(labels).toContain('节·过河拆桥');
    expect(labels).toContain('节·乐不思蜀');
    expect(labels).toContain('权·杀'); // ⚠️ 以前画的是类型 id「权·sha」，那是实现细节
    expect(labels).toContain('田·2');
    expect(labels).toContain('创·1');
    // 张数类不逐张列（田/创的内容是暗的或与张数等价）
    expect(labels.filter((l) => l.startsWith('田·')).length).toBe(1);
  });

  it('每个芯片都有 key 与说明（悬浮提示不会空）', () => {
    const chips = specialZoneChips({ jie: [card('j1', 'guohe')], hunCount: 3 } as never);
    expect(chips.length).toBe(2);
    for (const c of chips) {
      expect(c.key.length).toBeGreaterThan(0);
      expect(c.tip.length).toBeGreaterThan(0);
    }
    // key 唯一（React 列表安全）
    expect(new Set(chips.map((c) => c.key)).size).toBe(chips.length);
  });

  it('「魂」是私有资源：本人看到具体武将牌，别人只看到张数（用户 2026-09-25 口径）', () => {
    // 本人的快照带 hunNames ⇒ 逐张列名字
    const mine = specialZoneChips({ hunNames: ['张角', '周瑜'], hunCount: 2 } as never);
    const label = mine.find((c) => c.key === '魂')!.label;
    expect(label).toContain('张角');
    expect(label).toContain('周瑜');
    // 别人的快照只有 hunCount ⇒ 只画张数
    const others = specialZoneChips({ hunCount: 2 } as never);
    const other = others.find((c) => c.key === '魂')!.label;
    expect(other).toBe('魂·2');
    expect(other).not.toContain('张角');
  });

  it('没有这些牌区 → 空列表（调用方据此整块不渲染）', () => {
    expect(specialZoneChips({} as never)).toEqual([]);
    expect(specialZoneChips(null)).toEqual([]);
    expect(specialZoneChips(undefined)).toEqual([]);
    expect(hasSpecialZones({} as never)).toBe(false);
    expect(hasSpecialZones({ jie: [card('j1', 'guohe')] } as never)).toBe(true);
  });

  /**
   * 静态守门：**两个消费者都要用这一份列表**——各写一份必然分叉（这次就是漏了对手那一行）。
   */
  it('HeroPanel 与 Game.tsx 的对手行都用 specialZoneChips', () => {
    const hero = readFileSync(join(__dirname, 'components', 'HeroPanel.tsx'), 'utf8');
    const game = readFileSync(join(__dirname, 'pages', 'Game.tsx'), 'utf8');
    expect(hero).toContain('specialZoneChips(');
    expect(game).toContain('specialZoneChips(');
    expect(game).toContain('p-zones');
    // 两处都不许再自己内联拼「田·」/「节·」这类芯片文案
    expect(hero).not.toMatch(/田·\{/);
    expect(game).not.toMatch(/田·\{/);
  });
});
