/**
 * **隐藏手牌盲选**里「这一张画牌面还是画牌背」的判据（用户 2026-09-22 的规格）。
 *
 * 分工是规格的核心原话：**规则层负责决定「可以操作谁的哪些牌」，界面层负责根据当前玩家的
 * 可见权限决定展示牌面还是牌背。** 所以：
 *  - 规则层（`packages/engine/src/legal.ts`）在 `hidden` 时把候选剥成 `{ id }`（牌面根本
 *    不下发），并把「已因别的效果公开」的那几张的 id 放进 `pickVisibleIds`；
 *  - 这里只读这两个字段回答「露不露脸」——不查 state、不猜技能、不认识任何一张牌。
 *
 * 抽成纯函数是为了能单测：写死在 JSX 里的 `prompt.pickHidden && !…` 没法验，
 * 而这条判据一旦反了（把牌背画成牌面）就是**直接泄露对手手牌**。
 */
export interface BlindPickView {
  /** 候选来自其他角色的未知手牌（规则层置的标记） */
  pickHidden?: boolean;
  /** 其中已公开的那几张（照常画牌面） */
  pickVisibleIds?: string[];
}

/** 这张候选要不要画成牌背（true = 只能看到牌背） */
export function pickIsFaceDown(
  prompt: BlindPickView | null | undefined,
  cardId: string,
): boolean {
  if (!prompt?.pickHidden) return false;
  return !(prompt.pickVisibleIds ?? []).includes(cardId);
}

/** 盲选区上方的提示：说清「在看谁的手牌」；拿不到名字就退成「对方」 */
export function blindPickOwnerText(ownerName?: string | null): string {
  return ownerName ? `从 ${ownerName} 的手牌中选择` : '从未知手牌中选择';
}
