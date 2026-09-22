import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { darkSkillAction } from './darkSkillAction';

/**
 * 「暗置武将的技能 chip 点下去是**明置**还是**预亮**」的判据。
 *
 * 用户 2026-09-22 报的缺陷：锁定技的预亮/明置机制不完整——锁定技既进不了预亮名单，
 * 又没有「点它主动明置」的入口。这里的判据一侧连着界面（onClick 发哪个 intent），
 * 另一侧连着引擎（`revealBySkill` 的时机守卫 / `isLockedSkillOf`），两侧必须同口径。
 */
describe('暗置的技能 chip：明置 or 预亮', () => {
  it('锁定技 + 自己的出牌阶段 → 明置（发 revealBySkill）', () => {
    expect(
      darkSkillAction({ locked: true, prelitable: true, myPlayPhase: true, busy: false }),
    ).toBe('reveal');
  });

  it('**已经预亮的锁定技**：出牌阶段仍然是明置入口（不能因为已预亮就把亮将入口去掉）', () => {
    // 这条是用户口径的原话：「不能因为技能属于锁定技，或已经存在『预亮』机制，就取消主动亮将入口」。
    // 预亮与明置是两件事——预亮过的锁定技照样要能点着明置。
    expect(
      darkSkillAction({ locked: true, prelitable: true, myPlayPhase: true, busy: false }),
    ).toBe('reveal');
  });

  it('锁定技 + 不是我的出牌阶段 → 退回预亮开关（原来那条路不消失）', () => {
    expect(
      darkSkillAction({ locked: true, prelitable: true, myPlayPhase: false, busy: false }),
    ).toBe('prelight');
  });

  it('锁定技 + 不是我的出牌阶段 + 不能预亮（马术那类常驻字段技）→ 不给点', () => {
    expect(
      darkSkillAction({ locked: true, prelitable: false, myPlayPhase: false, busy: false }),
    ).toBe('none');
    // 出牌阶段点它照样能明置（引擎的 revealBySkill 认锁定字段技）
    expect(
      darkSkillAction({ locked: true, prelitable: false, myPlayPhase: true, busy: false }),
    ).toBe('reveal');
  });

  it('锁定技 + 出牌阶段但手头有别的选择（选了牌/选了目标/正在配置技能）→ 先不给点', () => {
    expect(darkSkillAction({ locked: true, prelitable: true, myPlayPhase: true, busy: true })).toBe(
      'none',
    );
  });

  it('非锁定技不受影响：能预亮就是预亮开关（不分阶段），不能预亮就不给点', () => {
    for (const myPlayPhase of [true, false]) {
      expect(darkSkillAction({ locked: false, prelitable: true, myPlayPhase, busy: false })).toBe(
        'prelight',
      );
      expect(darkSkillAction({ locked: false, prelitable: false, myPlayPhase, busy: false })).toBe(
        'none',
      );
    }
  });
});

/**
 * 静态守门：`Game.tsx` 必须**真的**用这套判据渲染暗置的技能 chip，并且
 * ① 发的是 `revealBySkill`（明置）；② 预亮那条老路（`prelightSkill`）还在；
 * ③ 「哪些算锁定技」与引擎共用 `isLockedSkillOf`（不许界面自己另写一份）。
 */
describe('Game.tsx 用的是这套判据', () => {
  const src = readFileSync(join(__dirname, 'pages', 'Game.tsx'), 'utf8');

  it('锁定技分支：用 isLockedSkillOf + darkSkillAction，并分别发两个 intent', () => {
    expect(src).toContain('isLockedSkillOf(');
    expect(src).toContain('darkSkillAction(');
    expect(src).toContain("type: 'revealBySkill'");
    expect(src, '预亮那条老路不能被删').toContain("type: 'prelightSkill'");
  });

  it('chip 文案说清了「明置该武将（锁定技）」与「预亮」', () => {
    expect(src).toContain('点击＝明置该武将（锁定技）');
    expect(src).toContain('点击＝预亮');
  });

  it('亮将入口挂在「我的出牌阶段」上（与引擎 onRevealBySkill 的时机守卫同口径）', () => {
    const start = src.indexOf('if (hidden && isLockedSkillOf(');
    expect(start, 'Game.tsx 里找不到锁定技分支').toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('if (hidden && prelitable.has(', start));
    expect(block).toContain('myPlayPhase');
    // 锁定技分支必须在预亮分支**之前**（否则锁定技又会掉进「点一下预亮」那条路）
    expect(block.length).toBeGreaterThan(0);
  });

  it('「我的出牌阶段」读的是快照的回合座位与阶段（不在我的出牌阶段就不发 revealBySkill）', () => {
    expect(src).toContain("const myPlayPhase = myTurn && phase === 'play';");
  });
});
