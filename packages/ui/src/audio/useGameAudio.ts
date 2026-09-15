// 把游戏状态接到音频层：按当前界面切 BGM，按新增日志播音效。
import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { bgm } from './bgm';
import { sfx } from './sfx';
import { pickNewSfx } from './pickNewSfx';

export function useGameAudio(): void {
  const screen = useStore((s) => s.screen);
  const log = useStore((s) => s.snapshot?.log);

  // 界面 → BGM 场景
  useEffect(() => {
    bgm.play(screen === 'game' ? 'battle' : 'menu');
  }, [screen]);

  // 新日志 → 音效（判断依据见 pickNewSfx）
  const lastId = useRef(-1);
  useEffect(() => {
    const { name, lastId: next } = pickNewSfx(lastId.current, log);
    lastId.current = next;
    if (name && !bgm.getState().muted) sfx.play(name);
  }, [log]);
}
