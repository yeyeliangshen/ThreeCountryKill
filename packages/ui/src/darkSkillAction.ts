/**
 * 国战**暗置**武将的技能 chip：点下去是「明置」还是「预亮」？
 *
 * 用户 2026-09-22 口径（缺陷：锁定技的预亮/明置机制不完整）：
 * - 「预亮」只是意向登记，**不代表武将牌已经明置**；
 * - 拥有**锁定技**的暗置武将在**自己的出牌阶段**内，应允许玩家主动点它把武将牌**主动明置**；
 * - **不能**因为技能属于锁定技、或已经存在「预亮」机制，就把主动亮将入口去掉。
 *
 * 判据（`Game.tsx` 的 skillRows 用它决定 chip 的 onClick 与文案）：
 * - 锁定技 + **我的出牌阶段**（且手头没有别的选择）→ `'reveal'`：发 `revealBySkill`（明置，不发动技能）；
 * - 其余情形退回原来的**预亮开关**（`'prelight'`）；既不能明置也不能预亮时才 `'none'`（不给点）。
 *
 * ⚠️ 与引擎的两处判据必须同一条口径：
 *   `@sgs/engine` 的 `isLockedSkillOf`（哪些技能算锁定技——三种落法 + 描述兜底）、
 *   以及 `onRevealBySkill` 的时机守卫（自己的出牌阶段 + 出牌阶段的空闲窗口）。
 */
export type DarkSkillAction = 'reveal' | 'prelight' | 'none';

export function darkSkillAction(ctx: {
  /** 这个技能是不是锁定技（engine 的 isLockedSkillOf） */
  locked: boolean;
  /** 这个技能此刻能不能预亮（服务端下发的 prelitableSkills） */
  prelitable: boolean;
  /** 现在是不是**我的出牌阶段** */
  myPlayPhase: boolean;
  /** 手头有别的选择要做（选了牌 / 选了目标 / 正在配置某个技能） */
  busy: boolean;
}): DarkSkillAction {
  if (!ctx.locked) return ctx.prelitable ? 'prelight' : 'none';
  // 锁定技：出牌阶段的空闲窗口点它＝明置该武将（引擎的 revealBySkill）
  if (ctx.myPlayPhase) return ctx.busy ? 'none' : 'reveal';
  return ctx.prelitable ? 'prelight' : 'none';
}
