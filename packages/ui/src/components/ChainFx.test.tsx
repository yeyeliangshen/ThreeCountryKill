import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chainSpreadSequence, CHAIN_STEP_MS, CHAIN_BADGE_TEXT } from '../chainState';
import { ChainBadge, ChainSpreadTable } from './ChainFx';
import { HeroPanel } from './HeroPanel';
import type { PlayerView } from '@sgs/protocol';

/**
 * 连环（横置）状态的四种表现（用户 2026-09-24 口径①~④）。
 *
 * 判据（状态 diff / 传导顺序）在 `chainState.test.ts` 里直测；这里钉**渲染与接线**：
 *   ② 常驻标记：对手那一行与自己的武将面板各有一枚「横」
 *   ④ 传导面板：顺序 = 引擎给的顺序（延时 = 序号 × 步长），不吃点击
 *   ①③ 动画类名：Game.tsx / HeroPanel 真的把它们贴到卡面上（源码守门，无 jsdom）
 */
const players = [
  { seatId: 's0', name: '甲' },
  { seatId: 's1', name: '乙' },
  { seatId: 's2', name: '丙' },
];

/** 引擎写的名单：源头 s1，先传 s2、再传 s0（**不是**按座位号排的） */
const chain = {
  seq: 7,
  fromSeatId: 's1',
  order: [
    { seatId: 's2', index: 1 },
    { seatId: 's0', index: 2 },
  ],
};

const spreadHtml = (meSeatId = 's0') =>
  renderToStaticMarkup(
    <ChainSpreadTable steps={chainSpreadSequence(chain)} players={players} meSeatId={meSeatId} />,
  );

describe('连环传导面板（口径④）', () => {
  it('按引擎给的顺序排：源头在前，其余照 index', () => {
    const html = spreadHtml();
    expect(html).toContain('属性伤害 · 连环传导');
    expect(html).toContain('共 2 名横置角色');
    // 顺序：乙（源头）→ 丙（1）→ 甲（2）
    const order = ['乙', '丙', '甲'].map((n) => html.indexOf(`>${n}<`));
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    expect(html).toContain('源头');
    expect(html).toContain('>1<');
    expect(html).toContain('>2<');
  });

  it('逐棒延时来自引擎序号：源头 0ms，其余 1×、2× 步长', () => {
    const html = spreadHtml();
    const delays = [...html.matchAll(/animation-delay:(\d+)ms/g)].map((m) => Number(m[1]));
    expect(delays).toEqual([0, CHAIN_STEP_MS, CHAIN_STEP_MS * 2]);
  });

  it('标出「我」那一格（自己也在连环里时一眼看到自己被传到了）', () => {
    expect(spreadHtml('s0')).toContain('>我<');
    // 只看别人的旁观视角不该出现「我」的标记
    expect(spreadHtml('s9').includes('>我<')).toBe(false);
  });

  it('是 role=status 的播报区（无障碍：顺序信息不只靠动画）', () => {
    const html = spreadHtml();
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  /**
   * 静态守门：这块面板**绝不许挡住牌桌**——样式表里必须写着 `pointer-events: none`
   * （传导演出是纯展示，抢了点击就把出牌/选目标废了）。
   */
  it('样式守门：传导面板不吃点击、减弱动态时只留文字', () => {
    const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');
    const block = css.slice(css.indexOf('.chain-spread-table'), css.indexOf('.cs-title'));
    expect(block).toContain('pointer-events: none');
    // prefers-reduced-motion 那一段必须把动效全关掉（顺序信息仍在文字里）
    const rm = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    for (const cls of [
      '.chain-hit',
      '.cs-flash',
      '.player.chain-in-a',
      '.hero-panel.chain-out-b',
    ]) {
      expect(rm).toContain(cls);
    }
    expect(rm).toContain('animation: none !important');
  });
});

describe('常驻横置标记（口径②）', () => {
  it('ChainBadge 就是那一枚「横」（与武将面板同款 class）', () => {
    const html = renderToStaticMarkup(<ChainBadge />);
    expect(html).toContain('marker-chip mark-chained');
    expect(html).toContain(CHAIN_BADGE_TEXT);
  });

  it('武将面板：横置时画徽标与虚线描边类，未横置时不画', () => {
    const view = (chained: boolean): PlayerView =>
      ({
        seatId: 's0',
        name: '甲',
        heroId: 'zhugeliang',
        deputyHeroId: null,
        faction: 'shu',
        heroRevealed: true,
        deputyRevealed: true,
        markers: [],
        flipped: false,
        chained,
        hp: 3,
        maxHp: 3,
        handCount: 0,
        isAlive: true,
        equipment: [],
        judgment: [],
      }) as PlayerView;
    const slots = [
      {
        heroId: 'zhugeliang',
        name: '诸葛亮',
        faction: 'shu' as const,
        hidden: false,
        slotLabel: null,
      },
    ];
    const on = renderToStaticMarkup(<HeroPanel me={view(true)} mode="guozhan" slots={slots} />);
    expect(on).toContain('mark-chained');
    expect(on).toContain('hero-panel');
    expect(on).toContain('chained');
    const off = renderToStaticMarkup(<HeroPanel me={view(false)} mode="guozhan" slots={slots} />);
    expect(off).not.toContain('mark-chained');
    expect(off).not.toContain('chained');
  });

  it('武将面板：进入/解除动画类与传导脉冲（延时）照抄上层给的类名', () => {
    const me = {
      seatId: 's0',
      name: '甲',
      heroId: 'zhugeliang',
      deputyHeroId: null,
      faction: 'shu',
      heroRevealed: true,
      deputyRevealed: true,
      markers: [],
      flipped: false,
      chained: true,
      hp: 3,
      maxHp: 3,
      handCount: 0,
      isAlive: true,
      equipment: [],
      judgment: [],
    } as PlayerView;
    const slots = [
      {
        heroId: 'zhugeliang',
        name: '诸葛亮',
        faction: 'shu' as const,
        hidden: false,
        slotLabel: null,
      },
    ];
    const html = renderToStaticMarkup(
      <HeroPanel
        me={me}
        mode="guozhan"
        slots={slots}
        chainFx={{ cls: 'chain-out-a', hit: { cls: 'hit-b', delayMs: 1040 } }}
      />,
    );
    expect(html).toContain('chain-out-a');
    expect(html).toContain('chain-hit hit-b');
    expect(html).toContain('animation-delay:1040ms');
  });
});

/**
 * 接线守门（**没有 jsdom**，所以用源码字符串钉）：状态 diff / 传导顺序必须由
 * `useChainFx`（其判据是纯函数）算出来，并且**由 `players[].chained` 驱动**——
 * 不许出现「认牌 / 认技能」的第二套判据。
 */
describe('Game.tsx 接线', () => {
  const src = readFileSync(join(__dirname, '..', 'pages', 'Game.tsx'), 'utf8');

  it('用 useChainFx 驱动，输入是快照的 chained 与 chain（不是某张牌/某个技能）', () => {
    expect(src).toContain('useChainFx(snapshot?.players ?? [], snapshot?.chain ?? null)');
    expect(src).not.toContain("card.type === 'tiesuo'");
    expect(src).not.toContain("'tieSuoLock'");
  });

  it('对手那一行有常驻「横」徽标 + 进入/解除动画类 + 传导脉冲', () => {
    expect(src).toContain('{p.chained && <ChainBadge bind={bindTip} />}');
    expect(src).toContain('chainFx.cardClass[p.seatId]');
    expect(src).toContain('chainFx.hits[p.seatId]');
    expect(src).toContain('className={`chain-hit ${chainHit.cls}`}');
  });

  it('传导面板画在牌桌主列中部（对手行之后、手牌/操作区之前）', () => {
    const playersRow = src.indexOf('className="players-row"');
    const table = src.indexOf('<ChainSpreadTable');
    const dock = src.indexOf('className="dock"');
    expect(playersRow).toBeGreaterThan(-1);
    expect(table).toBeGreaterThan(playersRow);
    expect(dock).toBeGreaterThan(table);
  });

  it('自己那一格也接上（进入/解除 + 传导脉冲）', () => {
    expect(src).toContain(
      'chainFx={{ cls: chainFx.cardClass[me.seatId], hit: chainFx.hits[me.seatId] }}',
    );
  });
});
