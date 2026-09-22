import { describe, it, expect } from 'vitest';
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
