import type { Card } from '@sgs/protocol';
import type { GameState, Player } from './model';

// 事件时序点（时机）。
// 引擎自身控制流会按这些顺序推进，并在每个时机调用 runHooks；
// 武将触发技可挂在某时机上，对结算进行修改/打断。
export type Timing =
  | 'turnStart'
  | 'judgePhase' // 判定阶段开始
  | 'beforeJudge' // 判定牌生效前（鬼才替判）
  | 'drawPhase'
  | 'playPhase'
  | 'discardPhase'
  | 'turnEnd'
  | 'useCard' // 使用牌时（声明使用、指定目标后）
  | 'becomeTarget' // 成为目标时（目标可响应）
  | 'beforeResolve' // 结算前
  | 'afterResolve' // 结算后
  | 'afterUse' // 使用牌后
  | 'damageDealt' // 受到伤害时（扣血前）
  | 'afterDamage' // 受到伤害后
  | 'nearDeath' // 濒死
  | 'death'; // 死亡

// 钩子上下文
export interface HookContext {
  state: GameState;
  player: Player;
  timing: Timing;
  payload?: unknown;
}

// 钩子返回：
//   { cancel: true } → 取消当前事件（becomeTarget 时 = 自动闪避）
//   { replaceCard } → 替换判定牌（beforeJudge 时 = 鬼才替判）
export type HookResult =
  | void
  | { cancel?: boolean; replaceCard?: Card };

export type HookHandler = (ctx: HookContext) => HookResult;

export interface HookRegistration {
  timing: Timing;
  handler: HookHandler;
  /** 同时机优先级，数字大先执行 */
  priority?: number;
}
