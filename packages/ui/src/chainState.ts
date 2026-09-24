/**
 * **连环（横置）状态的表现判据**——用户 2026-09-24 口径：
 *
 * > 【铁索连环】及连环状态缺少明确的视觉特效…① 进入连环状态时应有明显的铁索连接或横置
 * > 状态动画；② 已经处于连环状态时应持续提供清晰但不过度遮挡牌桌的视觉标识；③ 解除连环
 * > 状态时应播放对应的解除效果；④ 属性伤害发生连环传导时，应通过动画明确表现伤害从一名
 * > 连环角色向其他连环角色传递的**顺序**。该效果应绑定「连环状态」本身，而不是只绑定
 * > 【铁索连环】这张牌，以便其他能够令角色进入或解除连环状态的技能同样复用。
 *
 * 所以这一层**只认状态**：输入是两份相邻快照里的 `PlayerView.chained`（以及引擎下发的
 * 传导顺序视图 `ChainSpreadView`），输出是「谁刚被横置 / 谁刚被重置」的事件流与「照引擎顺序
 * 排好的动画序列」。**不认牌、不认技能**——【铁索连环】【勠力同心】【奋命】、以及将来任何
 * 令角色横置/重置的技能，改的都是同一个 `chained` 字段，表现自然一致。
 *
 * 这里全是纯函数（`chainState.test.ts` 直测），React 只负责把结果贴成 class / 延时。
 */
import type { ChainSpreadView } from '@sgs/protocol';

/** 判据只需要这三个字段（`PlayerView` 天然满足；测试里传小对象即可） */
export interface ChainSeat {
  seatId: string;
  name: string;
  /** 是否处于横置（连环）状态。缺省视作未横置 */
  chained?: boolean;
}

/** 一次状态变化的方向 */
export type ChainEventKind = 'chained' | 'unchained';

export interface ChainEvent {
  seatId: string;
  name: string;
  kind: ChainEventKind;
  /** 本次 diff 内的序号（从 1 起，按 `players` 的顺序）——同一份快照里多人同时变时靠它排序 */
  index: number;
}

/**
 * **两份快照的连环状态 diff → 进入 / 解除事件流**（口径①③的判据）。
 *
 * 规则（有意写死，别让上层再判一遍）：
 * - 只认 `false → true`（chained）与 `true → false`（unchained）这两种**翻转**；
 * - **没有基线**（第一次见到这个人，例如刚进房、刚刷新）不产生事件——否则开局重连会把所有
 *   横置角色当成「刚刚被横置」，播一遍假动画；
 * - 快照里消失的座次（不该发生）忽略。
 */
export function diffChainStates(
  prev: readonly ChainSeat[] | null,
  next: readonly ChainSeat[],
): ChainEvent[] {
  if (!prev) return [];
  const before = new Map(prev.map((p) => [p.seatId, !!p.chained]));
  const events: ChainEvent[] = [];
  for (const p of next) {
    const was = before.get(p.seatId);
    if (was === undefined) continue; // 新出现的人没有基线 → 不播动画
    const now = !!p.chained;
    if (was === now) continue;
    events.push({
      seatId: p.seatId,
      name: p.name,
      kind: now ? 'chained' : 'unchained',
      index: events.length + 1,
    });
  }
  return events;
}

/** 传导动画每多一棒的间隔（毫秒）。整段约 N×这个值，短到不打断操作、长到看得出先后 */
export const CHAIN_STEP_MS = 520;
/** 最后一棒播完再留一点余量才收起来（动画本身的时长） */
export const CHAIN_TAIL_MS = 900;

export interface ChainSpreadStep {
  seatId: string;
  /** 0 = 源头（吃到属性伤害、因此被重置的那位）；1..N = 引擎给的传导序号 */
  order: number;
  /** 该棒动画的延时（毫秒）：源头 0，其余 = 引擎序号 × stepMs */
  delayMs: number;
}

/**
 * **传导顺序 → 动画序列**（口径④的判据）。
 *
 * 顺序**完全来自引擎**（`ChainSpreadView.order[].index`，见 `queueChainSpread` / `chainStep`），
 * 前端只做乘法换算成延时——绝不自己按座位号或距离排一遍。
 */
export function chainSpreadSequence(
  chain: ChainSpreadView,
  stepMs: number = CHAIN_STEP_MS,
): ChainSpreadStep[] {
  return [
    { seatId: chain.fromSeatId, order: 0, delayMs: 0 },
    ...chain.order.map((o) => ({ seatId: o.seatId, order: o.index, delayMs: o.index * stepMs })),
  ];
}

/** 这次传导的动画总时长（用来定「什么时候把面板收起来」） */
export function chainSpreadTotalMs(chain: ChainSpreadView, stepMs: number = CHAIN_STEP_MS): number {
  return chain.order.length * stepMs + CHAIN_TAIL_MS;
}

/** 座位 → 该座的传导动画信息（给「按顺序逐张闪一下」的卡面动画用） */
export function chainSpreadBySeat(
  chain: ChainSpreadView | null,
  stepMs: number = CHAIN_STEP_MS,
): Record<string, ChainSpreadStep> {
  if (!chain) return {};
  const out: Record<string, ChainSpreadStep> = {};
  for (const step of chainSpreadSequence(chain, stepMs)) out[step.seatId] = step;
  return out;
}

/**
 * 常驻标记的文案（口径②）：一行字，窄屏也不换行。
 *
 * 用「横」而不是「铁索」：武将面板上**本来就有一枚**同名的横置徽标
 * （`marker-chip mark-chained`，与「翻」并排，见 HeroPanel），对手那一行以前没有——
 * 这里补上同一枚，两处一眼就能对上。独立成常量是为了让文案只有一处。
 */
export const CHAIN_BADGE_TEXT = '横';
export const CHAIN_BADGE_TIP =
  '横置（铁索连环状态）：受到属性伤害时会被重置，并让其他横置的角色受到同样的伤害。';
