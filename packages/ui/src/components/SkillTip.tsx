/**
 * **技能提示浮层**——用户 2026-09-25 口径①~④（见 `../skillTips.ts` 里的判据）。
 *
 * 表现：
 *   ① 技能发动/触发时，在**发动者那张牌 / 他的武将面板附近**浮现技能名（带一个呼吸的点）；
 *   ② 点它展开完整技能描述（描述来自引擎的武将技能文本，不新造规则文本）；悬停/手机长按同效；
 *   ③ 引擎说 `settling`（还在等某人响应 / 多步结算）时提示**保持**，并显示「结算中」；
 *   ④ 结算完自动收起（判据在 `nextSkillTip`，这里只负责定时与贴 class）。
 *
 * 两条硬约束（口径③「不遮挡、不抢事件」）：
 *   - 只在**自己那张牌的右下角**浮一小块（不盖手牌、不盖血量、不盖目标选择面板）；
 *   - 它**贴在一张牌旁边**而不是盖住它：`pointer-events` 只开在自己身上，牌桌照常点
 *     （`.skill-tip` 的定位父级不接管任何指针事件）。
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { SkillFxView } from '@sgs/protocol';
import { nextSkillTip, skillTipRemainingMs, type SkillTip } from '../skillTips';
import { useHoverTip } from './HoverTip';

/** 提示判据与「什么时候收起」全在 `../skillTips.ts`（纯函数、直测）；这里只管贴 DOM 与定时 */
export function useSkillTip(fx: SkillFxView | null): {
  tip: SkillTip | null;
  toggle: () => void;
} {
  const [tip, setTip] = useState<SkillTip | null>(null);
  // 判据读的都是 ref：定时器到点时不能依赖闭包里那份旧快照
  const fxRef = useRef<SkillFxView | null>(fx);
  fxRef.current = fx;
  const tipRef = useRef<SkillTip | null>(null);
  // 第一份快照只当基线（进房/刷新时那份 skillFx 可能是好几步之前的事，不该当新闻播）
  const baselineRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tick = useCallback(() => {
    const now = Date.now();
    const next = nextSkillTip(tipRef.current, fxRef.current, now, {
      baseline: baselineRef.current,
    });
    baselineRef.current = false;
    tipRef.current = next;
    // 判据没变就不要换新对象（否则每次 tick 都白重渲染一遍）
    setTip((cur) =>
      cur === next ||
      (cur &&
        next &&
        cur.seq === next.seq &&
        cur.settling === next.settling &&
        cur.pinned === next.pinned &&
        cur.expiresAt === next.expiresAt)
        ? cur
        : next,
    );
    if (timerRef.current) clearTimeout(timerRef.current);
    const remain = skillTipRemainingMs(next, now);
    // 到点再判一次：结算拖久了要按 settling 续时，结算完了要按 TAIL 收起来（口径③④）
    timerRef.current = remain === null ? null : setTimeout(tick, remain + 40);
  }, []);

  useEffect(() => {
    tick();
  }, [fx?.seq, fx?.settling, tick]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    [],
  );

  /** 口径②：点一下展开完整描述（再点一下收起）。展开后不再按常规时限自动收（见 skillTips） */
  const toggle = useCallback(() => {
    const cur = tipRef.current;
    if (!cur) return;
    tipRef.current = { ...cur, pinned: !cur.pinned };
    tick();
  }, [tick]);

  return { tip, toggle };
}

/**
 * 一条技能提示。挂在发动者那张牌旁边（对手那行用 `.player-slot` 包一层，自己用武将面板）。
 *
 * `seatName` 只用于无障碍播报（`role="status"`）；显示出来的只有技能名本身。
 */
export function SkillTipChip({
  tip,
  seatName,
  desc,
  onToggle,
}: {
  tip: SkillTip;
  seatName: string;
  desc: string;
  onToggle: () => void;
}) {
  const { bind, tipNode } = useHoverTip();
  const onClick = (e: MouseEvent<HTMLElement>): void => {
    // ⚠️ 不许把点击带给牌桌（对手那张牌是「选目标」按钮、自己的面板是「选自己」入口）：
    //    这里是**看技能说明**，不是选目标。
    e.stopPropagation();
    onToggle();
  };
  return (
    <span
      className={`skill-tip ${tip.settling ? 'settling' : ''} ${tip.pinned ? 'open' : ''}`}
      data-seat={tip.seatId}
      data-skill={tip.skillName}
      data-seq={tip.seq}
    >
      <span className="st-sr" role="status" aria-live="polite">
        {seatName} 发动【{tip.skillName}】
      </span>
      <button
        type="button"
        className="st-name"
        aria-expanded={tip.pinned}
        // 悬停（桌面）/ 长按（手机）也能看完整描述——与仓库其余提示同一套（HoverTip）
        {...bind(`【${tip.skillName}】`, desc || '（暂无技能说明）')}
        onClick={onClick}
      >
        <span className="st-dot" aria-hidden="true" />
        {tip.skillName}
        {/* 口径③：还在等响应 / 多步结算中 → 明说一句，别让玩家以为卡住了 */}
        {tip.settling && <span className="st-wait">结算中</span>}
      </button>
      {tip.pinned && <span className="st-desc">{desc || '（暂无技能说明）'}</span>}
      {tipNode}
    </span>
  );
}
