import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { equipSkillButtonOf } from './equipSkill';

/**
 * 「点装备牌＝发动它自带的技能」的判据（用户 2026-09-22 报的缺陷：装了【木牛流马】点它没反应）。
 */
describe('装备牌自带主动技 → 可点', () => {
  it('木牛流马：技能可用时这张装备牌可点，并对应 muniu 技能', () => {
    expect(equipSkillButtonOf('muniu', ['muniu', 'zhiheng'])).toBe('muniu');
  });

  it('技能不可用（服务端没列出来）时不可点——例如手牌为空、或没装备上', () => {
    expect(equipSkillButtonOf('muniu', ['zhiheng'])).toBeNull();
    expect(equipSkillButtonOf(undefined, ['muniu'])).toBeNull();
    expect(equipSkillButtonOf(null, ['muniu'])).toBeNull();
  });

  it('其它装备牌（没有自带技能）不受影响：一律不可点', () => {
    for (const name of ['qinggang', 'bagua', 'chitu', 'dinglan']) {
      expect(equipSkillButtonOf(name, ['muniu', 'zhiheng']), name).toBeNull();
    }
  });

  /**
   * 静态守门：`HeroPanel` 必须**真的**用这个判据决定装备槽能不能点。
   * 为什么值得钉：这个入口以前压根不存在（装备槽一律不可点），而技能条那条路虽然通，
   * 玩家的直觉是点装备牌 —— 一旦有人把这行删掉，缺陷会原样回来。
   */
  it('HeroPanel 用的是这个判据渲染可点装备槽', () => {
    const src = readFileSync(join(__dirname, 'components', 'HeroPanel.tsx'), 'utf8');
    expect(src).toContain('equipSkillButtonOf(');
    expect(src).toContain('equip-slot-use');
  });
});
