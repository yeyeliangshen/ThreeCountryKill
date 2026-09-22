import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { SkillButtons, type SkillRow } from './SkillButtons';

/**
 * 国战暗置的技能 chip（用户 2026-09-22 口径）：锁定技在自己的出牌阶段点它＝**明置该武将**
 * （不是发动技能），其余时机＝预亮开关。两种情形都必须是**可点**的——
 * 「不能因为技能属于锁定技，或已经存在『预亮』机制，就取消主动亮将入口」。
 */
const row = (extra: Partial<SkillRow>): SkillRow => ({
  name: '咆哮',
  desc: '锁定技，出牌阶段，你使用【杀】无次数限制。',
  usable: true,
  active: false,
  onClick: () => {},
  ...extra,
});

/**
 * 已生效的锁定技（用户 2026-09-25 口径确认：【红颜】是锁定技）：
 * 「只要武将牌已经明置并且技能有效，就持续按文本自动生效，**不需要玩家每次选择是否发动**」。
 * UI 这一侧要做的是把它**显示成持续生效**，而不是做成一个「点了才发动」的按钮。
 */
describe('接线守门：Game.tsx 按引擎的 isLockedSkillOf 标「持续生效」', () => {
  const game = readFileSync(join(__dirname, '..', 'pages', 'Game.tsx'), 'utf8');

  it('已生效（未暗置）的锁定技才标 always；暗置那侧仍然是明置/预亮入口', () => {
    expect(game, '判定共用引擎那一份').toContain('isLockedSkillOf(hero, s.name)');
    expect(game, '只有明置的才算「持续生效」').toContain('always: !hidden && isLockedSkillOf(hero, s.name)');
  });

  it('skillRows 里「谁在生效」是以 hero 为口径算的（国战主将/副将分别算）', () => {
    expect(game).toContain('for (const hero of isGuozhan ? [myHero, myDeputyHero] : [myHero])');
  });
});

describe('SkillButtons：已生效的锁定技标「锁·持续生效」', () => {
  it('锁定技已生效 ⇒ chip 上有「锁」标，说明里写明「锁定技·持续生效」（改动前 ✗）', () => {
    const html = renderToStaticMarkup(
      <SkillButtons
        skills={[row({ name: '红颜', desc: '锁定技，你的黑桃牌均视为红桃牌。', usable: false, always: true })]}
      />,
    );
    expect(html).toContain('chip-lock');
    expect(html, 'chip 上那枚「锁」').toContain('锁');
    expect(html, '说明里要说清它是持续生效，不是等一个「是否发动」').toContain('持续生效');
    expect(html, '已生效的锁定技没有「点了才发动」这回事').toContain('aria-disabled="true"');
  });

  it('非锁定技 / 暗置那侧不受影响：没有「锁」标的照旧', () => {
    const html = renderToStaticMarkup(
      <SkillButtons skills={[row({ name: '制衡', usable: true })]} />,
    );
    expect(html).not.toContain('chip-lock');
    const dark = renderToStaticMarkup(
      <SkillButtons skills={[row({ name: '咆哮', state: 'reveal', action: '点击＝明置该武将（锁定技）' })]} />,
    );
    expect(dark, '暗置那边的入口是「明置」，不是「持续生效」').not.toContain('chip-lock');
    expect(dark).toContain('明置');
  });
});

describe('SkillButtons：锁定技的亮将入口', () => {
  it('明置入口：可点、有 reveal 外观、chip 上写着「明置」', () => {
    const html = renderToStaticMarkup(
      <SkillButtons skills={[row({ state: 'reveal', action: '点击＝明置该武将（锁定技）' })]} />,
    );
    expect(html).toContain('skill-chip');
    expect(html).toContain('reveal');
    expect(html).toContain('usable');
    expect(html, 'chip 上要写出动作（手机没有 hover）').toContain('明置');
    expect(html).toContain('咆哮');
    expect(html, '入口必须是可点的').not.toContain('aria-disabled="true"');
  });

  it('预亮开关照旧（暗置 / 已预亮两种外观都在），且都可点', () => {
    const html = renderToStaticMarkup(
      <SkillButtons
        skills={[
          row({ name: '铁骑', state: 'dark', action: '点击＝预亮' }),
          row({ name: '遗计', state: 'prelit', active: true, action: '已预亮，点击取消' }),
        ]}
      />,
    );
    expect(html).toMatch(/class="skill-chip usable\s+dark"/);
    expect(html).toContain('class="skill-chip usable active prelit"');
    expect(html.match(/aria-disabled="true"/g) ?? []).toHaveLength(0);
    expect(html, '预亮开关的 chip 上不写「明置」').not.toContain('明置');
  });

  it('不可点的 chip（服务端没列出来）保持 aria-disabled，但不禁用鼠标事件', () => {
    const html = renderToStaticMarkup(<SkillButtons skills={[row({ usable: false })]} />);
    expect(html).toContain('aria-disabled="true"');
    // 用 aria-disabled 而不是 disabled：禁用元素收不到鼠标事件，就看不到悬停说明
    expect(html).not.toContain('disabled=""');
  });
});
