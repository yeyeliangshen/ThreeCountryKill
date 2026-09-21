// 悬停提示（悬浮说明）。
//
// 用 position: fixed + 高 z-index，所以不会被 .hand / .log 这类滚动容器裁掉，
// 可以放在任意组件内部渲染。弹出的坐标由触发元素的 getBoundingClientRect 算出，
// 显示在元素上方。
//
// 手牌、武将技能（含**其他玩家的明置武将**）、装备/判定图标共用这一套，样式统一（.hover-tip）。
//
// ⚠️ **手机上没有 hover**：触摸屏要靠**长按**才看得到提示（用户 2026-09-21 要求）。
// 所以 bind 同时挂鼠标与触摸两套：
// - 鼠标：mouseenter 出、mouseleave 收（原样）；
// - 触摸：按住 350ms 出（这期间手指移动超过 ~10px 视为在滑列表 → 取消，不然一划就弹提示）；
//   抬手**不**立刻收（一松手就没了根本来不及看），改成「下一次触摸屏幕任意位置」时收起。
import { useRef, useState, type MouseEvent, type TouchEvent } from 'react';

export interface HoverTipState {
  x: number;
  y: number;
  title: string;
  desc: string;
}

/** 长按多久算「要看提示」 */
const LONG_PRESS_MS = 350;
/** 手指移动超过这个距离就当滚动，不再出提示 */
const MOVE_TOLERANCE = 10;

export function useHoverTip() {
  const [tip, setTip] = useState<HoverTipState | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);

  function hide() {
    setTip(null);
  }

  const cancelPress = (): void => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressStart.current = null;
  };

  /** 长按成功：出提示，并登记「下一次点屏幕就收」 */
  const showFromTouch = (state: HoverTipState): void => {
    setTip(state);
    cancelPress();
    document.addEventListener('touchstart', hide, { once: true, passive: true });
  };

  /** 展开到触发元素上：{...bind('制衡', '出牌阶段限一次…')} */
  const bind = (title: string, desc: string) => ({
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ x: r.left + r.width / 2, y: r.top, title, desc });
    },
    onMouseLeave: hide,
    onTouchStart: (e: TouchEvent<HTMLElement>) => {
      const t = e.touches[0];
      if (!t) return;
      const r = e.currentTarget.getBoundingClientRect();
      pressStart.current = { x: t.clientX, y: t.clientY };
      cancelPress();
      pressTimer.current = setTimeout(
        () => showFromTouch({ x: r.left + r.width / 2, y: r.top, title, desc }),
        LONG_PRESS_MS,
      );
    },
    onTouchMove: (e: TouchEvent<HTMLElement>) => {
      const t = e.touches[0];
      const start = pressStart.current;
      if (!t || !start) return;
      if (
        Math.abs(t.clientX - start.x) > MOVE_TOLERANCE ||
        Math.abs(t.clientY - start.y) > MOVE_TOLERANCE
      ) {
        cancelPress(); // 在滑列表 → 不弹提示
      }
    },
    onTouchEnd: cancelPress, // 抬手只取消「还没到时间」的那次长按；已经弹出的保留
    onTouchCancel: cancelPress,
  });

  const tipNode = tip ? (
    <div className="hover-tip" style={{ left: tip.x, top: tip.y }}>
      <div className="hover-tip-name">{tip.title}</div>
      <div className="hover-tip-desc">{tip.desc}</div>
    </div>
  ) : null;

  return { bind, hide, tipNode };
}
