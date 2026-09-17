// 悬停提示（悬浮说明）。
//
// 用 position: fixed + 高 z-index，所以不会被 .hand / .log 这类滚动容器裁掉，
// 可以放在任意组件内部渲染。弹出的坐标由触发元素的 getBoundingClientRect 算出，
// 显示在元素上方。
//
// 手牌和武将技能共用这一套，样式统一（.hover-tip）。
import { useState, type MouseEvent } from 'react';

export interface HoverTipState {
  x: number;
  y: number;
  title: string;
  desc: string;
}

export function useHoverTip() {
  const [tip, setTip] = useState<HoverTipState | null>(null);

  /** 展开到触发元素上：{...bind('制衡', '出牌阶段限一次…')} */
  const bind = (title: string, desc: string) => ({
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ x: r.left + r.width / 2, y: r.top, title, desc });
    },
    onMouseLeave: hide,
  });

  function hide() {
    setTip(null);
  }

  const tipNode = tip ? (
    <div className="hover-tip" style={{ left: tip.x, top: tip.y }}>
      <div className="hover-tip-name">{tip.title}</div>
      <div className="hover-tip-desc">{tip.desc}</div>
    </div>
  ) : null;

  return { bind, hide, tipNode };
}
