import { useEffect } from 'react';
import { useStore } from './store';
import { JoinPage } from './pages/JoinPage';
import { Lobby } from './pages/Lobby';
import { Game } from './pages/Game';
import { SoundToggle, useGameAudio } from './audio';
import './styles.css';

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

      {screen === 'join' && <JoinPage />}
      {screen === 'lobby' && <Lobby />}
      {screen === 'game' && <Game />}

      {reconnecting && <div className="overlay-banner">连接断开，正在重连…</div>}
      {error && (
        <div className="error-toast" onClick={dismissError}>
          {error}
        </div>
      )}
    </div>
  );
}
