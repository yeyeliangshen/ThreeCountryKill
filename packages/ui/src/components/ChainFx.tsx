/**
 * **连环（横置）状态的四种表现**——用户 2026-09-24 口径①~④。
 *
 *   ① 进入连环：卡面「锁链收紧」动画（倾斜 + 高光 + 一道金属扫描带扫过）
 *   ② 持续标识：卡面上一枚小徽标（「横」，与武将面板上既有的那一枚同款）＋ 一圈虚线描边
 *   ③ 解除连锁：卡面「抖断」动画（横向抖动 + 亮闪），徽标与描边同时消失
 *   ④ 属性伤害传导：牌桌中央一块**按引擎顺序**逐棒点亮的传递面板 ＋ 每一棒在自己的卡面上
 *      依次闪一下（延时 = 引擎给的序号 × 步长）
 *
 * 判据全在 `../chainState.ts`（纯函数、直测）：这里只做「把结果贴成 class / 延时」和
 * 定时收起来。**不认牌、不认技能**——任何改 `chained` 的东西都会走到同一套表现上。
 *
 * 收尾一律靠定时器而不是「等下一份快照」：传导可能发生在别人回合、也可能之后很久没有新动作，
 * 动画必须自己回到静止（game-feel：反馈是瞬时的，不能变成新的常态）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ChainSpreadView } from '@sgs/protocol';
import {
  CHAIN_BADGE_TEXT,
  CHAIN_BADGE_TIP,
  chainSpreadSequence,
  chainSpreadTotalMs,
  diffChainStates,
  type ChainSeat,
  type ChainSpreadStep,
} from '../chainState';

/** 进入 / 解除动画的时长（与 styles.css 里的 keyframes 对齐）；播完就把 class 摘掉 */
export const CHAIN_ANIM_MS = 780;

export interface ChainHit {
  /** 动画类名（`hit-a` / `hit-b` 交替：同一座次连着两次也能重新播） */
  cls: string;
  /** 延时（毫秒）= 引擎给的传导序号 × 步长；源头为 0 */
  delayMs: number;
}

export interface ChainFx {
  /** seatId → 卡面上现在该带的进入/解除动画类（没有就是 ''） */
  cardClass: Record<string, string>;
  /** seatId → 传导脉冲（含引擎顺序算出的延时） */
  hits: Record<string, ChainHit>;
  /** 牌桌中央那块传递面板要画的内容；null = 现在没有传导 */
  spread: { seq: number; steps: ChainSpreadStep[] } | null;
}

/**
 * 连环状态的动画状态机（一个 hook 同时服务口径①③④）。
 *
 * ⚠️ 判据只来自**状态**：`players[].chained` 的翻转（`diffChainStates`）与引擎下发的
 * `ChainSpreadView`。界面绝不自己推断「谁被铁索连环点了」。
 */
export function useChainFx(players: readonly ChainSeat[], chain: ChainSpreadView | null): ChainFx {
  // 上一份连环状态：没有基线时（刚进房 / 刷新）不播动画，见 diffChainStates
  const prevRef = useRef<readonly ChainSeat[] | null>(null);
  const variantRef = useRef(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [cardClass, setCardClass] = useState<Record<string, string>>({});
  const [spread, setSpread] = useState<{ seq: number; steps: ChainSpreadStep[] } | null>(null);

  useEffect(
    () => () => {
      for (const t of timersRef.current) clearTimeout(t);
      timersRef.current = [];
    },
    [],
  );

  // ①③ 状态翻转 → 进入 / 解除动画（判据是纯函数）
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = players;
    const events = diffChainStates(prev, players);
    if (events.length === 0) return;
    const patch: Record<string, string> = {};
    for (const ev of events) {
      // 交替后缀：class 名变了 → 浏览器重新播一遍动画（同一座次连着两次也行）
      const variant = variantRef.current++ % 2 === 0 ? 'a' : 'b';
      patch[ev.seatId] = `${ev.kind === 'chained' ? 'chain-in' : 'chain-out'}-${variant}`;
    }
    setCardClass((cur) => ({ ...cur, ...patch }));
    const t = setTimeout(() => {
      setCardClass((cur) => {
        const next = { ...cur };
        for (const seatId of Object.keys(patch)) {
          if (next[seatId] === patch[seatId]) delete next[seatId];
        }
        return next;
      });
    }, CHAIN_ANIM_MS);
    timersRef.current.push(t);
  }, [players]);

  // ④ 引擎下发的传导顺序 → 传递面板（顺序照抄引擎，界面只负责挨个点亮）
  const spreadSeq = chain ? chain.seq : null;
  useEffect(() => {
    if (!chain || spreadSeq === null) {
      setSpread(null);
      return;
    }
    setSpread({ seq: chain.seq, steps: chainSpreadSequence(chain) });
    const t = setTimeout(
      () => setSpread((cur) => (cur && cur.seq === chain.seq ? null : cur)),
      chainSpreadTotalMs(chain),
    );
    timersRef.current.push(t);
    // 只认「换了一次传导」（seq 变了）；同一份传导重渲染不必重播
  }, [spreadSeq]);

  const hits: Record<string, ChainHit> = {};
  if (spread) {
    const suffix = spread.seq % 2 === 0 ? 'a' : 'b';
    // 源头（order 0）用 src 类：它是这次伤害的落点，与「被传导到的」稍作区分
    for (const step of spread.steps) {
      hits[step.seatId] = {
        cls: step.order === 0 ? 'hit-src' : `hit-${suffix}`,
        delayMs: step.delayMs,
      };
    }
  }

  return { cardClass, hits, spread };
}

/** 常驻标记（口径②）：与武将面板上那枚「横」同款的小徽标，任何人都能一眼看出谁横着 */
export function ChainBadge({
  bind,
}: {
  /** 悬浮提示绑定器（桌面悬停 / 手机长按），与仓库其余徽标一致；不传就退回原生 title */
  bind?: (title: string, desc: string) => Record<string, unknown>;
}) {
  const tip = bind
    ? bind('横置', CHAIN_BADGE_TIP)
    : ({ title: CHAIN_BADGE_TIP } as Record<string, unknown>);
  return (
    <span className="marker-chip mark-chained" aria-label={CHAIN_BADGE_TIP} {...tip}>
      {CHAIN_BADGE_TEXT}
    </span>
  );
}

/**
 * 牌桌中央的**连环传导**面板（口径④）：按**引擎给的顺序**逐棒点亮。
 *
 * 顺序不是界面排的：`steps` 直接来自 `chainSpreadSequence(ChainSpreadView)`，
 * 而 `ChainSpreadView` 是引擎在 `queueChainSpread` 里写下的实际结算名单。
 * `pointer-events: none`（见 styles.css）：它只是演出，绝不许抢牌桌的点击。
 */
export function ChainSpreadTable({
  steps,
  players,
  meSeatId,
}: {
  steps: ChainSpreadStep[];
  players: readonly { seatId: string; name: string }[];
  meSeatId: string;
}) {
  const nameOf = (seatId: string) => players.find((p) => p.seatId === seatId)?.name ?? seatId;
  return (
    <div className="chain-spread-table" role="status" aria-live="polite">
      <div className="cs-title">
        属性伤害 · 连环传导
        <span className="cs-progress">共 {steps.length - 1} 名横置角色</span>
      </div>
      <div className="cs-row">
        {steps.map((step) => (
          <span key={step.seatId} className={`cs-node ${step.order === 0 ? 'src' : ''}`}>
            <span className="cs-link" aria-hidden="true" />
            <span className="cs-name">{nameOf(step.seatId)}</span>
            <span className="cs-order">{step.order === 0 ? '源头' : step.order}</span>
            {/* 逐棒点亮的延时：顺序来自引擎（order × 步长），界面只做乘法 */}
            <span
              className={`cs-flash ${step.order === 0 ? 'flash-src' : ''}`}
              style={{ animationDelay: `${step.delayMs}ms` }}
            />
            {step.seatId === meSeatId && <span className="cs-me">我</span>}
          </span>
        ))}
      </div>
    </div>
  );
}
