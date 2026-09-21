import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlayerView } from '@sgs/protocol';
import { HeroChips, heroChipsOf, skillsTipDesc } from './HeroChips';

/**
 * 对手面板的武将小卡（用户 2026-09-21）：
 * - 国战画**两张**（主将 / 副将）——原来只画了主将一张，副将整个看不见；
 * - 明置的武将小卡要能通过悬浮/长按看到**技能名与效果**（提示内容由纯函数算，这里测）。
 */
function view(extra: Partial<PlayerView>): PlayerView {
  return {
    seatId: 's1',
    name: '乙',
    heroId: 'zhugeliang',
    deputyHeroId: 'huangyueying',
    heroRevealed: true,
    deputyRevealed: true,
    faction: 'shu',
    markers: [],
    flipped: false,
    chained: false,
    hp: 3,
    maxHp: 3,
    handCount: 0,
    isAlive: true,
    equipment: [],
    judgment: [],
    ...extra,
  } as PlayerView;
}

describe('对手的武将小卡（HeroChips）', () => {
  it('国战：两个将都给出来，并各自带上主将/副将标记', () => {
    const chips = heroChipsOf(view({}), 'guozhan');
    expect(chips.map((c) => c.label)).toEqual(['诸葛亮', '黄月英']);
    expect(chips.map((c) => c.slotLabel)).toEqual(['主将', '副将']);
    expect(chips.every((c) => !c.hidden)).toBe(true);
  });

  it('国战：暗置那张只显示「暗」，提示说明亮将后才有技能（不泄露技能）', () => {
    const chips = heroChipsOf(
      view({ heroRevealed: true, deputyRevealed: false, deputyHeroId: null }),
      'guozhan',
    );
    expect(chips[0]!.label).toBe('诸葛亮');
    const hidden = chips[1]!;
    expect(hidden.hidden).toBe(true);
    expect(hidden.label).toBe('暗');
    expect(hidden.heroId).toBeNull();
    expect(hidden.tipTitle).toBe('暗将');
    expect(hidden.tipDesc).toContain('亮将');
    expect(hidden.tipDesc).not.toContain('集智');
  });

  it('明置武将的提示＝技能名 + 效果（一行一条）', () => {
    const chips = heroChipsOf(view({ deputyHeroId: null, deputyRevealed: false }), 'guozhan');
    const main = chips[0]!;
    expect(main.tipTitle).toBe('诸葛亮（主将）');
    expect(main.tipDesc).toContain('【观星】');
    expect(main.tipDesc).toContain('【空城】');
    expect(main.tipDesc.split('\n').length).toBeGreaterThan(1);
  });

  it('其他模式只有一张，且没有主将/副将标记', () => {
    const chips = heroChipsOf(view({}), 'junzheng');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.slotLabel).toBeNull();
    expect(chips[0]!.label).toBe('诸葛亮');
  });

  it('没技能的武将也给一句「（没有技能）」，不留空提示', () => {
    expect(skillsTipDesc({ skills: [] })).toBe('（没有技能）');
  });

  it('渲染：两张小卡 + 「暗」角标都在 DOM 里', () => {
    const html = renderToStaticMarkup(
      <HeroChips
        chips={heroChipsOf(
          view({ heroRevealed: true, deputyRevealed: false, deputyHeroId: null }),
          'guozhan',
        )}
      />,
    );
    expect(html).toContain('主将');
    expect(html).toContain('副将');
    expect(html).toContain('暗');
  });
});
