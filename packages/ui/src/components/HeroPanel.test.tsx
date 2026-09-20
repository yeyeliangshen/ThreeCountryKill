import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlayerView } from '@sgs/protocol';
import { HeroPanel } from './HeroPanel';

/** 造一个最小的玩家快照（只填面板读得到的字段） */
function view(extra: Partial<PlayerView>): PlayerView {
  return {
    seatId: 's0',
    name: '甲',
    heroId: 'zhugeliang',
    deputyHeroId: null,
    faction: 'shu',
    heroRevealed: true,
    deputyRevealed: true,
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

const slots = [{ heroId: 'zhugeliang', name: '诸葛亮', faction: 'shu' as const, hidden: false, slotLabel: null }];

/**
 * 特殊牌区（公开信息）的渲染：田 / 千幻 / 魂 / 创 / 【空城】暂存 只有张数是公开的，
 * 明细不能摊开——这条既是「功能有了」也是「别泄露暗牌」的守门测试。
 */
describe('HeroPanel 特殊牌区', () => {
  it('田 / 空城暂存 等只渲染张数', () => {
    const html = renderToStaticMarkup(
      <HeroPanel
        me={view({ tianCount: 2, kongchengCount: 3, qianhuanCount: 1, hunCount: 2 } as never)}
        mode="guozhan"
        slots={slots}
      />,
    );
    expect(html).toContain('田·2');
    expect(html).toContain('城·3');
    expect(html).toContain('幻·1');
    expect(html).toContain('魂·2');
  });

  it('没有这些牌区时整块不渲染（不给空壳）', () => {
    const html = renderToStaticMarkup(<HeroPanel me={view({})} mode="guozhan" slots={slots} />);
    expect(html).not.toContain('special-zones');
  });

  it('实体牌牌区（权/异/函）照旧列出，创按张数', () => {
    const html = renderToStaticMarkup(
      <HeroPanel
        me={
          view({
            quan: [{ id: 'q1', type: 'sha', suit: 'spade', rank: 5 }],
            wounds: [
              { id: 'w1', type: 'sha', suit: 'spade', rank: 5 },
              { id: 'w2', type: 'sha', suit: 'club', rank: 6 },
            ],
          } as never)
        }
        mode="guozhan"
        slots={slots}
      />,
    );
    expect(html).toContain('权·sha');
    expect(html).toContain('创·2');
  });
});
