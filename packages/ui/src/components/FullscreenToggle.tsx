// 全屏 / 横屏开关。
//
// 为什么需要它：卡牌游戏横过来才好操作，而浏览器**不允许**网站随便锁方向——
// 唯一的路子是「先进全屏，再 screen.orientation.lock('landscape')」，而且：
//   - Android Chrome：支持，点了就横过来（还免掉地址栏，屏幕更宽）；
//   - iOS Safari：**没有**这个 API，锁不了，只能用户自己把手机横过来。
// 所以这里做两件事：① 请求全屏；② 顺手试一下锁横屏，失败就退化成「提示用户手动横屏」，
// 不会报错也不影响用。横过来之后布局会自动切到宽屏双栏（见 styles.css 里
// `orientation: landscape and max-height: 560px` 那条），不是歪着显示。
import { useEffect, useState } from 'react';

/** 手机横屏时视口高度通常 ≤ 560（iPhone 14 Pro Max 横屏 430） */
function isPhoneLandscape(): boolean {
  return window.innerHeight <= 560 && window.innerWidth > window.innerHeight;
}

export function FullscreenToggle() {
  const [full, setFull] = useState(false);
  const [hint, setHint] = useState('');

  useEffect(() => {
    const onChange = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    onChange();
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // 提示看完就撤（和错误 toast 一个节奏）
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(''), 4000);
    return () => clearTimeout(t);
  }, [hint]);

  const toggle = async (): Promise<void> => {
    if (document.fullscreenElement) {
      try {
        (screen.orientation as ScreenOrientation & { unlock?: () => void }).unlock?.();
      } catch {
        /* 不支持就算了 */
      }
      await document.exitFullscreen?.();
      return;
    }
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      setHint('这台设备不允许网页进全屏');
      return;
    }
    // 全屏之后再试锁横屏：能锁就锁（Android），锁不了就提示手动横过来（iOS）
    const lock = (
      screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      }
    )?.lock;
    if (typeof lock === 'function') {
      try {
        await lock.call(screen.orientation, 'landscape');
        return;
      } catch {
        /* 落到下面的提示 */
      }
    }
    if (!isPhoneLandscape()) {
      setHint('这台设备锁不了方向：把手机横过来即可（布局会自动切成横屏）');
    }
  };

  return (
    <div className="fs-ctl">
      <button
        className="ghost sound-btn"
        title={full ? '退出全屏' : '全屏（手机横过来更好操作）'}
        aria-label={full ? '退出全屏' : '全屏'}
        aria-pressed={full}
        onClick={() => void toggle()}
      >
        {full ? '⤡' : '⛶'}
      </button>
      {hint && <div className="fs-hint">{hint}</div>}
    </div>
  );
}
