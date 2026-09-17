// 声音开关 + 音量。固定在右上角，所有界面都能用。
import { useSyncExternalStore } from 'react';
import { bgm } from './bgm';

export function SoundToggle() {
  const state = useSyncExternalStore(
    (cb) => bgm.subscribe(cb),
    () => bgm.getState(),
  );
  const silent = state.muted || state.volume === 0;
  // 浏览器要求先有用户交互才允许出声，这里提示一下，免得以为坏了
  const waiting = !silent && state.contextState === 'suspended';

  return (
    <div className="sound-ctl">
      <button
        className="ghost sound-btn"
        title={silent ? '开启声音' : '静音'}
        aria-label={silent ? '开启声音' : '静音'}
        aria-pressed={!silent}
        onClick={() => bgm.toggleMuted()}
      >
        {silent ? '🔇' : '🔊'}
      </button>
      <input
        className="sound-vol"
        type="range"
        min={0}
        max={100}
        value={Math.round(state.volume * 100)}
        aria-label="音量"
        title={`音量 ${Math.round(state.volume * 100)}%`}
        onChange={(e) => {
          bgm.setVolume(Number(e.target.value) / 100);
          // 拖到 0 之后再拖回来，静音标记要一起解除，否则看着有音量却没声音
          if (state.muted && Number(e.target.value) > 0) bgm.setMuted(false);
        }}
      />
      {waiting && <span className="sound-hint">点击页面开启音乐</span>}
      {!waiting && state.fileFailed && (
        <span className="sound-hint">音乐文件加载失败，已用内置音乐</span>
      )}
    </div>
  );
}
