/**
 * 目标可点性的**界面侧判据**（纯函数，集中放这里，不要在 Game.tsx 各处散写）。
 *
 * 两条判据、两个来源：
 *
 * ① 「目标必须有手牌」（【火攻】要对方展示一张手牌）。
 *    口径来自用户 2026-09-22 报、09-23 复报的缺陷。引擎侧有**同一个判据**
 *    （`packages/engine/src/engine.ts` 的 `trickNeedsCardsInHand`：出牌校验、技能目标候选、
 *    虚拟锦囊结算入口三处共用）。两边必须一致：界面按这个判据把不可点的目标画成不可点，引擎则
 *    拒绝任何绕过界面的指定。
 *
 * ② 「能不能把**自己**选成目标」。
 *    口径来自用户 2026-09-24（规则权威，见 docs/guozhan-roster.md §5.209）：
 *    **是否能够选择自己必须由牌或技能文本决定，而不能由通用目标选择 UI 决定。**
 *    所以界面这里**没有、也不许有**「不能选自己」这类通用规则——判据只有一个：
 *    **服务端下发的自身合法目标**（出牌阶段的 `prompt.selfTargetUses`、技能条目的
 *    `legalSkills[].selfTarget`）。界面以前自己写了一张「哪些牌能选自己」的表
 *    （`Game.tsx` 的 `targetRange().self`），与引擎各写一套，结果【火攻】【号令天下】
 *    【克复中原】以及【青囊】【排异】这些「一名角色」的技能全被那张表挡在外面。
 */
import type { CardType, PromptView } from '@sgs/protocol';

export function targetNeedsHandCards(effType: string | null | undefined): boolean {
  return effType === 'huogong';
}

/**
 * 出牌阶段：这张牌**按这个用法**能不能把**自己**选成目标——读服务端下发的 `selfTargetUses`。
 *
 * `type` 是**生效牌型**（有转化用法时传 `as`，否则传牌面牌型）：同一张牌不同用法答案不同
 * （卧龙的红【决斗】：按【决斗】用不能指自己、按【火攻】用可以），所以服务端那份清单的每一项
 * 都是「牌 + 用法」的二元组。
 */
export function cardSelfTargetAllowed(
  prompt: Pick<PromptView, 'selfTargetUses'> | null | undefined,
  cardId: string,
  type: CardType | null | undefined,
): boolean {
  if (!prompt || !type) return false;
  return (prompt.selfTargetUses ?? []).some((u) => u.cardId === cardId && u.type === type);
}

/**
 * 技能模式：这个技能**自己的**目标规则允许把使用者选成目标吗。
 *
 * 数据源就是技能声明本身（`ActiveSkill.selfTarget`）——服务端 `legalSkills[]` 与界面本地武将表
 * 读的是**同一个字段**（标记技能不属于任何武将，只有服务端那份带得回来，所以实际传进来的
 * 通常是 `legalSkills` 里那一条）。
 */
export function skillSelfTargetAllowed(
  skill: { selfTarget?: boolean } | null | undefined,
): boolean {
  return skill?.selfTarget === true;
}
