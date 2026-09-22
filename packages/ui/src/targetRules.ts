/**
 * 「目标必须有手牌」的牌型判据（界面侧）。
 *
 * **口径来自用户 2026-09-22 报、09-23 复报的缺陷**：【火攻】要目标「展示一张手牌」，
 * 所以没有手牌的角色**既不该进可选目标列表、也不能被任何交互路径强行指定**。
 *
 * ⚠️ 引擎侧有**同一个判据**（`packages/engine/src/engine.ts` 的 `trickNeedsCardsInHand`：
 * 出牌校验、技能目标候选、虚拟锦囊结算入口三处共用）。两边必须一致：界面按这个判据把
 * 不可点的目标画成不可点，引擎则拒绝任何绕过界面的指定。
 */
export function targetNeedsHandCards(effType: string | null | undefined): boolean {
  return effType === 'huogong';
}
