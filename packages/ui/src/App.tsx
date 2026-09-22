import { useEffect } from 'react';
import { useStore } from './store';
import { JoinPage } from './pages/JoinPage';
import { Hall } from './pages/Hall';
import { Lobby } from './pages/Lobby';
import { Game } from './pages/Game';
import { SoundToggle, useGameAudio } from './audio';
import { FullscreenToggle } from './components/FullscreenToggle';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

/** 构建版本戳（由 client 的 vite 注入）。开发模式下没有，显示占位 */
const BUILD_STAMP = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : '开发模式（未构建）';

export function App() {
  const screen = useStore((s) => s.screen);
  const error = useStore((s) => s.error);
  const reconnecting = useStore((s) => s.reconnecting);
  const dismissError = useStore((s) => s.dismissError);

  // 按界面切 BGM、按游戏事件播音效
  useGameAudio();

  // 错误 toast 自动消失
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(dismissError, 3500);
    return () => clearTimeout(t);
  }, [error, dismissError]);

  return (
    <div className="app">
      <SoundToggle />
      <FullscreenToggle />

      {/* 渲染异常必须让玩家看得见（否则深色底上就是一块黑屏），见 ErrorBoundary 的注释 */}
      <ErrorBoundary>
        {screen === 'join' && <JoinPage />}
        {screen === 'hall' && <Hall />}
        {screen === 'lobby' && <Lobby />}
        {screen === 'game' && <Game />}
      </ErrorBoundary>

      {/* 版本戳：判断「浏览器看到的是不是最新那份构建」用，出问题先看这里 */}
      <div className="build-stamp" title="前端构建版本（commit · 构建时间）">
        {BUILD_STAMP}
      </div>

      {reconnecting && <div className="overlay-banner">连接断开，正在重连…</div>}
      {error && (
        <div className="error-toast" onClick={dismissError}>
          {error}
        </div>
      )}
    </div>
  );
}
