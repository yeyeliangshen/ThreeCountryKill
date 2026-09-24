import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 貂蝉·离间那套「方向感」界面的**守门**（用户 2026-09-25 口径）：
 *
 * 离间是「依次选两名男性角色，令**后者**对**前者**使用【决斗】」——玩家最容易点反。
 * 所以界面必须把「第几个点的人担任什么角色」和「谁对谁用决斗」写出来。
 * 但**规则文本一律来自引擎**（`legalSkills[].targetSlotLabels` / `targetPreview`），
 * 界面只做展示与占位替换——不许在 UI 里硬编码「决斗目标 / 发起者」这类规则措辞。
 *
 * 同时守住性别标记：它读的是引擎下发的**当前公开性别**（`publicGender`），
 * 界面绝不自己去翻武将表判性别（那会把暗将底牌泄露出去）。
 */
describe('离间的方向提示 + 公开性别标记', () => {
  const ui = (p: string) => readFileSync(join(__dirname, p), 'utf8');

  it('两个渲染点都画性别标记，且判据是引擎下发的 gender（不是本地武将表）', () => {
    for (const file of ['pages/Game.tsx', 'components/HeroPanel.tsx']) {
      const src = ui(file);
      expect(src, `${file} 应画性别标记`).toContain('gender-mark');
    }
    const game = ui('pages/Game.tsx');
    // 标记只读 `p.gender`（服务端算好的公开性别）
    expect(game).toContain('p.gender ?? ');
    // ⚠️ 界面只许**读**服务端算好的公开性别（`p.gender` 用来选 ♂/♀/? 这枚字），
    //    不许自己按武将表判「是不是男性」——那等于把规则抄到界面（`isMalePlayer` 是引擎的）
    expect(game).not.toContain('isMalePlayer');
    expect(game, '不查武将表判性别').not.toContain('getHeroForMode(me.heroId)?.gender');
  });

  it('自己面板的性别标记读 `me.gender`，且「未确定」画问号而不是猜一个', () => {
    const panel = ui('components/HeroPanel.tsx');
    expect(panel).toContain('me.gender');
    expect(panel, "未确定＝'?'").toContain("'?'");
  });

  it('有序目标的提示、每人的角色标签、方向预览**都从引擎下发**', () => {
    const game = ui('pages/Game.tsx');
    expect(game).toContain('targetSlotLabels');
    expect(game).toContain('targetPreview');
    // 提示语是「请选择<引擎给的说明>」，没有硬编码的「请选择第一名角色」
    expect(game).toContain('请选择${skillSlotLabel}');
    expect(game).not.toContain('请选择第一名');
    expect(game).not.toContain('请选择第二名');
    // 方向预览是模板替换（{1}/{2} → 名字），不是写死的箭头文案
    expect(game).toContain('replace(/[{](\\d+)[}]/g');
  });

  it('技能自己下发的可点目标优先于通用「所有其他角色」（女性/未确定要能置灰）', () => {
    const game = ui('pages/Game.tsx');
    expect(game).toContain('skillMode.skill.legalTargets');
    expect(game).toContain('allowed.has(p.seatId)');
  });

  it('样式齐备：.gender-mark 三态 + .slot-chip / .slot-arrow', () => {
    const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
    for (const cls of ['.gender-mark', '.gender-mark.male', '.gender-mark.female', '.gender-mark.unknown', '.slot-chip', '.slot-arrow']) {
      expect(css, `styles.css 应有 ${cls}`).toContain(cls);
    }
  });
});
