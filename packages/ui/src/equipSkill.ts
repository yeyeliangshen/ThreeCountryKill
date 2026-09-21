/**
 * 「装备牌自带的**可用主动技**」——点这张装备牌就等于发动它。
 *
 * 目前只有【木牛流马】：它给持有者一个出牌阶段主动技（把任意张手牌扣置到牌下、之后可以
 * 当手牌使用）。这个技能**不属于任何武将**，所以技能条上是靠服务端下发的 `legalSkillIds`
 * 补出来的（与国战标记同一条路）。
 *
 * ⚠️ 但光有技能条按钮不够——玩家的直觉是**点装备牌**。装备槽里的牌以前一律不可点
 * （只有技能模式选代价时才变成可点按钮），于是「装备了木牛流马之后点它毫无反应」
 * （用户 2026-09-22 报的缺陷）。
 *
 * 对应关系用**约定**：装备牌的 `equipName` 与该技能的 id 同名（`equip.ts` 里
 * `MUNIU_SKILL.id = 'muniu'`、牌的 `equipName = 'muniu'`）。这里只做这一处匹配，
 * 匹配不到就返回 null（＝这张装备牌不可点，行为与以前一致，不会误触发）。
 */
export function equipSkillButtonOf(
  equipName: string | undefined | null,
  legalSkillIds: readonly string[],
): string | null {
  if (!equipName) return null;
  return legalSkillIds.includes(equipName) ? equipName : null;
}
