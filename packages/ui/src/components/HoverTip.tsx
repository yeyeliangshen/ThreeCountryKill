// 悬停 / 触摸提示（悬浮说明）。
//
// 用 position: fixed + 高 z-index，所以不会被 .hand / .log 这类滚动容器裁掉，
// 可以放在任意组件内部渲染。弹出的坐标由触发元素的 getBoundingClientRect 算出。
//
// 手牌、武将技能（含**其他玩家的明置武将**）、装备/判定图标共用这一套，样式统一（.hover-tip）。
//
// 交互（用户 2026-09-25 口径，手机端那一条是这次修的）：
// - **桌面**：悬停出、移开收（原样）；
// - **手机**：**点一下对象就出说明**（原来只有长按才出——点了没反应，于是大家以为「关不掉」）；
//   长按**仍然可用**（用户 2026-09-21 要求过，滑列表时点不了才靠它）；再点同一个对象＝收起；
// - **同一时刻只有一条说明**：点另一个对象＝直接切过去（不是「先关掉、再长按」）；
// - **点牌桌空白处立即关闭**（口径③）；
// - 说明自己 `pointer-events: none`：**不阻塞选牌、选目标、响应**（口径④；这条是样式保证的）；
// - 位置夹在视口内、上方放不下就翻到元素下方——说明是给手指点的对象看的，不能自己跑出屏幕。
//
// ⚠️ 为什么要有「全局」这一层：以前每个 `useHoverTip()` 实例各管各的 `tip`，于是
// ① 两个实例的说明能同时挂着；② 只有**触摸**那条路登记过「下次点屏幕就收」，
// 而手机浏览器点对象常常补发 mouseenter（走的是鼠标那条路）⇒ 说明挂上就再也关不掉，
// 一直挡着牌桌。现在统一成模块级的一条「当前说明」，鼠标/触摸两条路都吃同一个收口。
import { useEffect, useRef, useState, type MouseEvent, type TouchEvent } from 'react';

export interface HoverTipState {
  /** 锚点横坐标（说明以它居中，已夹进视口） */
  x: number;
  /** 锚点纵坐标（上面放不下时是元素下沿，配 `below` 用） */
  y: number;
  /** 挂在元素**下方**（上方空间不够时翻过来，避免整块跑到屏幕外） */
  below?: boolean;
  title: string;
  desc: string;
}

/** 长按多久算「要看提示」（老交互，保留） */
const LONG_PRESS_MS = 350;
/** 手指移动超过这个距离就当滚动，不出提示、也不当成点击 */
const MOVE_TOLERANCE = 10;
/** 与 styles.css 的 `.hover-tip` 宽度一致（夹进视口要算它） */
export const HOVER_TIP_WIDTH = 230;
/** 估算高度：上方放不下就翻到下方（高度随文本变，估一个够用的值） */
export const HOVER_TIP_HEIGHT = 96;
/** 与元素留的间距（与 css 里那 22px 对应） */
const GAP = 22;

/**
 * 说明该挂在元素上方还是下方（纯函数，直测）。
 *
 * 上方放得下就照老样子挂上面（不挡元素本身）；放不下就翻到下面——手机上顶部那一排对手的
 * 牌、以及贴着屏幕上沿的图标，原来会把说明整个顶出可视区（等于「点了没反应」）。
 */
export function tipPlacement(
  rect: { left: number; right: number; top: number; bottom: number; width: number },
  viewport: { width: number; height: number },
  tipWidth = HOVER_TIP_WIDTH,
  tipHeight = HOVER_TIP_HEIGHT,
): { x: number; y: number; below: boolean } {
  const half = tipWidth / 2 + 8;
  const x = Math.min(Math.max(rect.left + rect.width / 2, half), Math.max(half, viewport.width - half));
  const below = rect.top < tipHeight + GAP;
  return { x, y: below ? rect.bottom : rect.top, below };
}

/**
 * 当前那一条说明归谁（模块级）。
 *
 * 一个 `.hover-tip` 只能有一条：任一实例开说明时把 owner 抢过来，别的实例看到
 * owner 不是自己就把自己的收掉——这就是口径②「点另一个对象＝切换」。
 */
let activeOwner: symbol | null = null;
const ownerListeners = new Set<() => void>();
/** 当前那条说明的触发元素：点在它自己身上时交给它自己的 toggle 逻辑，全局这一层不抢 */
let activeTrigger: HTMLElement | null = null;

function setActiveOwner(id: symbol | null, trigger: HTMLElement | null = null): void {
  activeOwner = id;
  activeTrigger = id ? trigger : null;
  for (const l of ownerListeners) l();
}

let globalBound = false;

/** 「点空白就关」的全局收口（只挂一次） */
function bindGlobalDismiss(): void {
  if (globalBound || typeof document === 'undefined') return;
  globalBound = true;
  const onDown = (e: Event): void => {
    if (!activeOwner) return;
    const t = e.target;
    // 点的是**当前这条说明的触发元素自己**：不在这里关（它自己的 toggle 说了算）
    if (activeTrigger && t instanceof Node && activeTrigger.contains(t)) return;
    setActiveOwner(null);
  };
  // ⚠️ 必须用**捕获**阶段：一次「点另一个对象」的触摸，要先关掉旧的，再轮到 React 那边
  //    打开新的（冒泡阶段会把新开的那条立刻关掉）。
  document.addEventListener('touchstart', onDown, { capture: true, passive: true });
  document.addEventListener('mousedown', onDown, { capture: true });
}

/** 一次触摸的现场：用来区分「点一下」与「长按 / 滑动」 */
interface Press {
  x: number;
  y: number;
  opened: boolean;
  moved: boolean;
}

export function useHoverTip() {
  const [tip, setTip] = useState<HoverTipState | null>(null);
  const idRef = useRef<symbol>(Symbol('hover-tip'));
  const pressRef = useRef<Press | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 我这条说明是哪个元素开的（再点它＝收起） */
  const mineRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(false);
  openRef.current = tip !== null;

  const cancelPress = (): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const show = (el: HTMLElement, title: string, desc: string): void => {
    const r = el.getBoundingClientRect();
    const { x, y, below } = tipPlacement(
      { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width },
      { width: window.innerWidth, height: window.innerHeight },
    );
    mineRef.current = el;
    setActiveOwner(idRef.current, el);
    setTip({ x, y, below, title, desc });
  };

  const hide = (): void => {
    cancelPress();
    pressRef.current = null;
    mineRef.current = null;
    if (activeOwner === idRef.current) setActiveOwner(null);
    setTip(null);
  };

  useEffect(() => {
    bindGlobalDismiss();
    // 别人抢走了「当前说明」⇒ 我这条收掉（口径②：同时只有一条）
    const sync = (): void => {
      if (activeOwner !== idRef.current) setTip(null);
    };
    ownerListeners.add(sync);
    return () => {
      ownerListeners.delete(sync);
      if (activeOwner === idRef.current) setActiveOwner(null);
      cancelPress();
    };
  }, []);

  /** 展开到触发元素上：{...bind('制衡', '出牌阶段限一次…')} */
  const bind = (title: string, desc: string) => ({
    onMouseEnter: (e: MouseEvent<HTMLElement>) => show(e.currentTarget, title, desc),
    onMouseLeave: hide,
    onTouchStart: (e: TouchEvent<HTMLElement>) => {
      const t = e.touches[0];
      if (!t) return;
      const el = e.currentTarget;
      cancelPress();
      pressRef.current = { x: t.clientX, y: t.clientY, opened: false, moved: false };
      // 长按：老交互保留（手指按着不放也能看）
      timerRef.current = setTimeout(() => {
        const press = pressRef.current;
        if (!press || press.moved) return;
        press.opened = true;
        show(el, title, desc);
      }, LONG_PRESS_MS);
    },
    onTouchMove: (e: TouchEvent<HTMLElement>) => {
      const t = e.touches[0];
      const press = pressRef.current;
      if (!t || !press) return;
      if (
        Math.abs(t.clientX - press.x) > MOVE_TOLERANCE ||
        Math.abs(t.clientY - press.y) > MOVE_TOLERANCE
      ) {
        press.moved = true;
        cancelPress(); // 在滑列表 → 不出提示，也不当成点击
      }
    },
    onTouchEnd: (e: TouchEvent<HTMLElement>) => {
      const press = pressRef.current;
      cancelPress();
      pressRef.current = null;
      if (!press || press.moved || press.opened) return; // 滑动 / 已经由长按开过了
      // 口径①：**点一下**就出说明；再点同一个对象＝收起（口径③的对照手势）
      const el = e.currentTarget;
      if (openRef.current && mineRef.current === el) hide();
      else show(el, title, desc);
    },
    onTouchCancel: () => {
      cancelPress();
      pressRef.current = null;
    },
  });

  const tipNode = tip ? (
    <div className={`hover-tip${tip.below ? ' below' : ''}`} style={{ left: tip.x, top: tip.y }}>
      <div className="hover-tip-name">{tip.title}</div>
      <div className="hover-tip-desc">{tip.desc}</div>
    </div>
  ) : null;

  return { bind, hide, tipNode };
}
