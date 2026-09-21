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

  it('「节」（陆逊·国战·谦逊）逐张列出牌名——它是公开的实体牌', () => {
    const html = renderToStaticMarkup(
      <HeroPanel
        me={
          view({
            jie: [
              { id: 'j1', type: 'guohe', suit: 'spade', rank: 3 },
              { id: 'j2', type: 'lebu', suit: 'spade', rank: 6 },
            ],
          } as never)
        }
        mode="guozhan"
        slots={slots}
      />,
    );
    expect(html).toContain('节·过河拆桥');
    expect(html).toContain('节·乐不思蜀');
    // 逐张列 ⇒ 张数一眼看得出（3 张满、度势第二项要三张）；
    // 张数的完整说明在悬浮提示里（静态渲染不含提示节点，所以这里只数块数）
    expect(html.match(/节·/g)?.length).toBe(2);
  });

  /**
   * 装备槽必须显示**具体牌名**（用户 2026-09-23 报：势备篇的【明光铠】【护心镜】显示成
   * 「防具」、【惊帆】显示成「−1马」——那三张在 `EQUIP_NAME` 里缺名字，`cardShortName`
   * 于是回落到槽位名）。判据与牌堆的完整性用例同一份数据（见 engine 的 card-names.test.ts）。
   */
  it('装备槽显示具体牌名，不是「防具」「−1马」这类槽位名', () => {
    const html = renderToStaticMarkup(
      <HeroPanel
        me={
          view({
            equipment: [
              { id: 'e1', type: 'armor', suit: 'spade', rank: 2, equipName: 'mingguang' },
              { id: 'e2', type: 'armor', suit: 'club', rank: 2, equipName: 'huxinjing' },
              { id: 'e3', type: 'minusMount', suit: 'heart', rank: 3, equipName: 'jingfan' },
              { id: 'e4', type: 'armor', suit: 'club', rank: 2, equipName: 'bagua' },
            ],
          } as never)
        }
        mode="guozhan"
        slots={slots}
      />,
    );
    expect(html).toContain('明光铠');
    expect(html).toContain('护心镜');
    expect(html).toContain('惊帆');
    expect(html).toContain('八卦阵');
    expect(html).not.toContain('防具');
    expect(html).not.toContain('−1马');
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
    expect(html).toContain('权·杀'); // 牌名（以前是类型 id「权·sha」）
    expect(html).toContain('创·2');
  });
});
