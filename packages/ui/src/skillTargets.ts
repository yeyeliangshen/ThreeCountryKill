/**
 * **技能目标的「对」限制**（用户 2026-09-25 口径）。
 *
 * 绝大多数技能的目标是「逐目标」判合法的（在不在距离内、是不是其他角色…），界面直接用引擎
 * 下发的 `legalTargetIds` 就够了。少数技能的限制落在**一对目标**上——典型是吴国太·甘露：
 *
 * > 两名角色装备区里的牌数之差 ≤ 你已损失的体力值，且两边的牌数之和 ≥ 1。
 *
 * 这种限制**逐目标判不出来**（同一个角色跟甲配合法、跟乙配就不合法），所以引擎在
 * `legalSkills[].legalTargetPairs` 里把**合法座位对**整批下发，界面据此做**动态过滤**：
 * 选完第一个目标之后，把「跟他凑不出合法对」的座位直接置灰——玩家不用自己去算
 * 「3 和 1 差多少」（用户原话：UI 帮他做合法性过滤）。
 *
 * ⚠️ 这一层**只是帮忙**：真正的判据在引擎的 `execute` 里（选错组合会被拒并给出原因）。
 * 界面不许把这里的判断当成「合不合法」的最终答案——两边口径都以引擎下发的 pairs 为准。
 */

/** 技能模式里的一对目标（引擎下发的合法座位对，元素是 [座次, 座次]） */
export type TargetPairs = readonly (readonly string[])[] | undefined;

/**
 * 在已经选了 `picked` 的情况下，再点 `candidate` 是否还凑得出合法的一对？
 *
 * - 没有 `legalTargetPairs`（绝大多数技能）⇒ 一律 `true`（照旧，界面不拦）；
 * - 再点已经选过的那个 ⇒ `true`（那是「取消选择」的手势）；
 * - 目前只选了 0 个 ⇒ `true`（第一个人得让玩家点得动）；
 * - 目前选了 1 个 ⇒ 第二个人必须跟第一个**同属某一对**；
 * - 已经选满（2 个）⇒ 交给调用方（`maxTargets` 那一层）判，这里返回 `true`。
 */
export function pairAllowsMore(pairs: TargetPairs, picked: readonly string[], candidate: string): boolean {
  if (!pairs || pairs.length === 0) return true;
  if (picked.includes(candidate)) return true;
  if (picked.length === 0) return true;
  if (picked.length >= 2) return true;
  const first = picked[0]!;
  return pairs.some((pair) => pair.includes(first) && pair.includes(candidate));
}

/** 这一对（先选的人 + 再选的人）本身合法吗——给「确认」按钮用 */
export function pairComplete(pairs: TargetPairs, picked: readonly string[]): boolean {
  if (!pairs || pairs.length === 0) return true;
  if (picked.length < 2) return true;
  const [a, b] = picked;
  return pairs.some((pair) => pair.includes(a!) && pair.includes(b!));
}

/**
 * 【甘露】交换预览里那行「核对说明」（用户 2026-09-25 口径：玩家不该自己去算差值）。
 *
 * 例：`装备区：3 件 ⇄ 1 件（差 2，你已损失 1 点体力 → 上限 1）`
 * —— 上限那一截直接写明「≤ 已损失体力」，玩家一眼能看出这次能不能换。
 */
export function equipSwapNote(countA: number, countB: number, lostHp: number): string {
  const diff = Math.abs(countA - countB);
  return `装备区：${countA} 件 ⇄ ${countB} 件（差 ${diff}，你已损失 ${lostHp} 点体力 → 上限 ${lostHp}）`;
}
