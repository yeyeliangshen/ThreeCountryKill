/**
 * 延时锦囊的**合法目标**规则 —— 唯一事实来源。
 *
 * 口径依据（用户 2026-09-22 的原文口径，规则权威，已逐字记入 `docs/guozhan-roster.md` §5.208）：
 *
 *   【乐不思蜀】的合法目标为**除使用者本人以外的一名其他角色**，本身**没有距离限制**。
 *   目标判断＝「存活的其他角色 + 其判定区能够合法置入【乐不思蜀】」；
 *   **不应额外检查角色间距离、攻击范围或坐骑修正**。
 *   距离限制只属于【兵粮寸断】（官方文本「距离 1 以内的角色」）。
 *
 * 缺陷现场：`engine.ts` 的 `playDelayedTrick` 原来对 `lebu` 与 `bingliang` **共用**一条
 * `distance(...) > 1` 判断，于是【乐不思蜀】被错误地加上了距离 1 的限制；
 * `legal.ts` 又在两处（牌面延时锦囊 / 转化延时锦囊）各抄了一份同样的判断——三份抄写、
 * 一处改错就整体不一致。本模块把这张「哪张延时锦囊受距离限制」的事实收成**一份**，
 * 引擎出牌校验与提示下发都读它，另由 `packages/engine/tests/delayedTrickTargets.test.ts` 钉住。
 *
 * ⚠️ 与「成为目标时取消之」（帷幕/谦逊/空城…）是**两件事**：那些是「先打出去再取消」
 *    （见 `cancelBlockedTargets` 的说明），不是「选不了他」，所以**不在**这里的判据里。
 */
import type { DelayedTrickType } from '@sgs/protocol';
import type { GameState, Player } from './model';
import { getPlayer } from './model';
import { distance } from './distance';
import { effectiveHeroes, heroIgnoresTrickDistance, wenjiMarked } from './heroes';

/**
 * 这张延时锦囊**本身**的距离上限：只有【兵粮寸断】是「距离 1 以内的角色」，
 * 【乐不思蜀】与【闪电】都没有距离限制（返回 `null` ⇒ 恒合法）。
 *
 * 纯函数（不看局面），所以「谁受距离限制」这件事只有这一行可改。
 */
export function delayedTrickDistanceLimit(type: DelayedTrickType): number | null {
  return type === 'bingliang' ? 1 : null;
}

/**
 * 延时锦囊的目标在**距离**这一层到底合不合法。
 *
 * - 【乐不思蜀】：`delayedTrickDistanceLimit` 返回 `null` ⇒ **不看距离、不看攻击范围、
 *   不看坐骑修正**，直接放行；
 * - 【兵粮寸断】：距离 ≤ 1，但**沿用原有的两条豁免**——黄月英·奇才（含 SP 司马昭·夙智②
 *   的动态标记）与刘琦·【问计】标记的那张实体牌「无距离限制」。
 *
 * `cardId` 是这次实际使用的牌 id（虚拟/转化牌传转化后的那张牌的 id 即可）——
 * 【问计】标记认的是**实体牌 id**（见 `wenjiMarked`）。
 */
export function delayedTrickTargetInRange(
  state: GameState,
  player: Player,
  type: DelayedTrickType,
  targetId: string,
  cardId?: string,
): boolean {
  const limit = delayedTrickDistanceLimit(type);
  // 乐不思蜀/闪电：本身没有距离限制 ⇒ 这张牌够不够得着与目标无关
  if (limit === null) return true;
  if (heroIgnoresTrickDistance(effectiveHeroes(state, player), player)) return true;
  if (cardId && wenjiMarked(player, cardId)) return true;
  return distance(state, player.seatId, targetId) <= limit;
}

/**
 * 延时锦囊的**完整合法目标判据**：存活的其他角色 + 判定区能合法置入（判定区没有同名
 * 延时锦囊）+ 距离那一层（见上，只有【兵粮寸断】有）。
 *
 * 【闪电】不由这里判（它是「置于自己判定区」，在 `playDelayedTrick` 里单独一支）。
 *
 * `playDelayedTrick` 为了给出**分开的错误提示**（不能以自己为目标 / 目标无效 / 超出距离 /
 * 判定区已有同类）仍然逐条判断，但**距离那一条**用的就是上面的 `delayedTrickTargetInRange`；
 * 提示侧的「这张牌现在打不打得出」直接读本函数。两处因此不可能再各写一套。
 */
export function delayedTrickTargetLegal(
  state: GameState,
  player: Player,
  type: DelayedTrickType,
  targetId: string,
  cardId?: string,
): boolean {
  const target = getPlayer(state, targetId);
  if (!target || !target.alive) return false;
  if (target.seatId === player.seatId) return false;
  // 判定区同类延时锦囊上限 1 张
  if (target.judgment.some((c) => c.type === type)) return false;
  return delayedTrickTargetInRange(state, player, type, targetId, cardId);
}
