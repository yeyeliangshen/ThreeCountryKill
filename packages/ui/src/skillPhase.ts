/**
 * 「技能入口」（技能条上的技能按钮 / 技能确认条）在哪些 prompt 阶段渲染。
 *
 * 只有**出牌阶段**和**弃牌阶段**两个：
 * - 出牌阶段：武将主动技 + 四枚国战标记都能点；
 * - 弃牌阶段：只有显式声明了 `alsoUsableInDiscardPhase` 的技能该出现（典型是【阴阳鱼】
 *   的「弃置 → 本回合手牌上限 +2」，以及能当作阴阳鱼用的【野心家】）。
 *
 * ⚠️ 这里以前是三处分别写死的 `prompt.kind === 'play'`，于是**弃牌阶段的那几枚标记按钮
 *    根本不渲染**（引擎明明已经把 `legalSkillIds` / `legalSkills` 一起下发了）——用户报的
 *    「标记点了没用」里最典型的一种。判断收成这一个函数，改动只需动这里（docs §5.177）。
 */
export function skillEntryShown(promptKind: string | undefined | null): boolean {
  return promptKind === 'play' || promptKind === 'discard';
}
