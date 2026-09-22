/**
 * **技能提示浮层**（用户 2026-09-25 口径①~④）——渲染与接线守门。
 *
 * 判据（事件流 → 该显示什么、什么时候收）在 `../skillTips.test.ts` 里直测；这里钉的是：
 *   ① 技能名真的画在**发动者那一格**（对手那张牌 / 自己的武将面板）；
 *   ② 点它展开完整描述（描述是引擎的武将技能文本，不是新造的规则文本）；
 *   ③ 「结算中」这种「还在等回答」的状态有可见文字（不只靠动画）；
 *   ④ 不遮挡、不抢事件：样式表里浮层不吃点击、减弱动态时动画全关；提示挂在**禁用按钮之外**
 *      （`.player-slot`），否则点不开（真机踩点：禁用元素连子元素都收不到鼠标事件）。
 *
 * ⚠️ 带「改动前 ✗」的用例在本特性落地前必红。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SkillTipChip } from './SkillTip';
import { HeroPanel } from './HeroPanel';
import { nextSkillTip, SKILL_TIP_BASE_MS } from '../skillTips';
import type { PlayerView, SkillFxView } from '@sgs/protocol';

const ev = (patch: Partial<SkillFxView> = {}): SkillFxView => ({
  seq: 1,
  seatId: 's1',
  skillName: '刚烈',
  settling: true,
  ...patch,
});

const chip = (patch: Partial<SkillFxView> = {}, pinned = false) => {
  const tip = { ...nextSkillTip(null, ev(patch), 0)!, pinned };
  return renderToStaticMarkup(
    <SkillTipChip
      tip={tip}
      seatName="乙"
      desc="受到伤害后判定，非红桃则由伤害来源选择一项。"
      onToggle={() => {}}
    />,
  );
};

describe('① 技能名画在发动者那一格', () => {
  it('技能名 + 座次/技能名数据属性（真机验收与调试都靠它定位这张提示）', () => {
    const html = chip();
    expect(html).toContain('刚烈');
    expect(html).toContain('data-seat="s1"');
    expect(html).toContain('data-skill="刚烈"');
    expect(html).toContain('class="skill-tip');
  });

  it('是 role=status 的播报区：技能名不只靠动画（无障碍）', () => {
    const html = chip();
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html, '播报里带上发动者').toContain('乙 发动【刚烈】');
  });
});

describe('② 点开看完整描述', () => {
  it('没点开时只有技能名（描述不占地方）', () => {
    const html = chip({}, false);
    expect(html).not.toContain('st-desc');
  });

  it('点开后画出完整技能描述（同一份文本，不新造）', () => {
    const html = chip({}, true);
    expect(html).toContain('st-desc');
    expect(html).toContain('非红桃则由伤害来源选择一项');
    expect(html, 'aria-expanded 跟着走').toContain('aria-expanded="true"');
  });

  it('没有说明时不留白（写明「暂无」而不是空块）', () => {
    const tip = { ...nextSkillTip(null, ev(), 0)!, pinned: true };
    const html = renderToStaticMarkup(
      <SkillTipChip tip={tip} seatName="乙" desc="" onToggle={() => {}} />,
    );
    expect(html).toContain('暂无技能说明');
  });
});

describe('③ 等待响应 / 多步结算：提示带「结算中」且是可见文字', () => {
  it('settling 时画「结算中」并带 settling 类；结算完就不画（改动前 ✗）', () => {
    const on = chip({ settling: true });
    expect(on).toContain('st-wait');
    expect(on).toContain('结算中');
    expect(on).toContain('skill-tip settling');
    const off = chip({ settling: false });
    expect(off).not.toContain('st-wait');
    expect(off).not.toContain('skill-tip settling');
  });
});

describe('④ 不遮挡、不抢事件（样式守门）', () => {
  const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');

  it('浮层只在**自己那一小块**吃点击：根节点 pointer-events: none，只有技能名 auto', () => {
    const block = css.slice(css.indexOf('.skill-tip {'), css.indexOf('.st-name {'));
    expect(block, '根节点不吃点击 ⇒ 牌桌照常点').toContain('pointer-events: none');
    const chipBlock = css.slice(css.indexOf('.st-name {'), css.indexOf('.st-name:hover'));
    expect(chipBlock, '技能名这一枚可点').toContain('pointer-events: auto');
    const descBlock = css.slice(css.indexOf('.st-desc {'), css.indexOf('.st-sr {'));
    expect(descBlock, '展开的说明块不接指针（不许把底下牌桌的点击吃掉）').toContain(
      'pointer-events: none',
    );
  });

  it('展开的说明块**从技能名往下挂**（第一排对手的牌在屏幕顶端，往上顶会把技能名顶出视口）', () => {
    const chipBlock = css.slice(css.indexOf('.st-name {'), css.indexOf('.st-name:hover'));
    expect(chipBlock, '技能名是说明块的定位父级').toContain('position: relative');
    const descBlock = css.slice(css.indexOf('.st-desc {'), css.indexOf('.st-sr {'));
    expect(descBlock, '往下挂').toContain('position: absolute');
    expect(descBlock).toContain('top: calc(100% + 4px)');
    expect(descBlock, '不再用 order: -1 往上顶').not.toContain('order: -1');
    expect(descBlock, '带 max-height，长文本也不顶出屏幕').toContain('max-height');
    expect(descBlock, '不接指针（不许把底下牌桌的点击吃掉）').toContain('pointer-events: none');
  });

  it('prefers-reduced-motion 下动画全关（信息仍在文字里）', () => {
    // 从**技能提示那一块之后**找第一个减弱动态块：本文件里别处也有同名的媒体查询，
    // 不能写「取最后一个」——那是连环那块的位置约定（见 ChainFx.test.tsx）
    const rm = css.slice(
      css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.skill-tip {')),
    );
    for (const cls of ['.st-name', '.st-desc', '.st-dot']) expect(rm).toContain(cls);
    expect(rm).toContain('animation: none !important');
  });

  it('提示块贴在牌的**右下角**（名字/血量在左上，装备与判定从左边排起）', () => {
    const block = css.slice(css.indexOf('.skill-tip {'), css.indexOf('.st-name {'));
    expect(block).toContain('position: absolute');
    expect(block).toContain('right: 4px');
    expect(block).toContain('bottom: 4px');
  });
});

describe('接线守门（无 jsdom：用源码字符串钉）', () => {
  const game = readFileSync(join(__dirname, '..', 'pages', 'Game.tsx'), 'utf8');

  it('由引擎下发的 `snapshot.skillFx` 驱动（不去解析日志里的中文技能名）', () => {
    expect(game).toContain('useSkillTip(snapshot?.skillFx ?? null)');
    // 反向门：不许出现「正则匹配技能名」这类第二套判据
    expect(game).not.toMatch(/log.*match\(.*【/);
    expect(game).not.toContain("split('【')");
  });

  it('对手那格：提示是禁用按钮的**兄弟**（`.player-slot`），否则点不开', () => {
    const slot = game.indexOf('className="player-slot"');
    const button = game.indexOf('className={`player ${isCurrent', slot);
    const closeBtn = game.indexOf('</button>', button);
    const tipChip = game.indexOf('<SkillTipChip {...skillTipHere} />', closeBtn);
    expect(slot).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(slot);
    expect(tipChip, '提示在 </button> 之后（不在禁用按钮里面）').toBeGreaterThan(closeBtn);
  });

  it('自己那一格（武将面板）同样接上，用的是同一个组件', () => {
    expect(game).toContain('skillTip={skillTipOf(me.seatId) ?? undefined}');
    const panel = readFileSync(join(__dirname, 'HeroPanel.tsx'), 'utf8');
    expect(panel).toContain('<SkillTipChip');
    expect(panel).toContain('skillTip.tip');
  });

  it('提示只挂在**发动者那一座**（判据在纯函数里，不按人硬编码）', () => {
    expect(game).toContain('if (!tip || tip.seatId !== seatId) return null;');
  });

  it('基础停留时长是个常量（口径①的「短暂」可核对），没有散落的魔法数', () => {
    expect(SKILL_TIP_BASE_MS).toBeGreaterThan(1000);
    expect(game).not.toMatch(/setTimeout\([^,]+,\s*4\d{3}\)/);
  });
});

describe('武将面板：提示画在面板内（自己发动技能也看得见）', () => {
  it('传了 skillTip 就画，没传就不画（改动前 ✗：面板根本没有这个口）', () => {
    const me = {
      seatId: 's0',
      name: '甲',
      heroId: 'sunquan',
      deputyHeroId: null,
      faction: 'wu',
      heroRevealed: true,
      deputyRevealed: true,
      markers: [],
      flipped: false,
      chained: false,
      hp: 4,
      maxHp: 4,
      handCount: 0,
      isAlive: true,
      equipment: [],
      judgment: [],
    } as unknown as PlayerView;
    const slots = [
      { heroId: 'sunquan', name: '孙权', faction: 'wu' as const, hidden: false, slotLabel: null },
    ];
    const tip = nextSkillTip(null, ev({ seatId: 's0', skillName: '制衡', settling: false }), 0)!;
    const on = renderToStaticMarkup(
      <HeroPanel
        me={me}
        mode="guozhan"
        slots={slots}
        skillTip={{ tip, seatName: '甲', desc: '出牌阶段限一次…', onToggle: () => {} }}
      />,
    );
    expect(on).toContain('data-skill="制衡"');
    expect(on).toContain('skill-tip');
    const off = renderToStaticMarkup(<HeroPanel me={me} mode="guozhan" slots={slots} />);
    expect(off).not.toContain('skill-tip');
  });
});
