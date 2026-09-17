// 把游戏状态接到音频层：按当前界面切 BGM，按新增日志播音效与卡牌语音。
import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { getHero } from '@sgs/engine';
import { bgm } from './bgm';
import { sfx } from './sfx';
import { pickNewSfx } from './pickNewSfx';
import { playVoice } from './voice';
import { lastPlayed } from './debug';

export function useGameAudio(): void {
  const screen = useStore((s) => s.screen);
  const log = useStore((s) => s.snapshot?.log);
  const players = useStore((s) => s.snapshot?.players);

  // 界面 → BGM 场景
  useEffect(() => {
    bgm.play(screen === 'game' ? 'battle' : 'menu');
  }, [screen]);

  // 新日志 → 音效 + 卡牌语音（判断依据见 pickNewSfx）
  const lastId = useRef(-1);
  useEffect(() => {
    const { name, action, actionSeat, lastId: next } = pickNewSfx(lastId.current, log);
    lastId.current = next;
    if (bgm.getState().muted) return;
    lastPlayed.action = action;
    lastPlayed.seat = actionSeat;
    lastPlayed.sfx = null;
    lastPlayed.voice = null;
    // 有真实音效的动作优先用真实音效；否则退回按 kind 的合成音
    const played = action ? sfx.playAction(action) : false;
    if (!played && name) sfx.play(name);
    if (action) {
      // 语音按出牌角色的性别选：同一张牌男女声不同
      const seat = players?.find((p) => p.seatId === actionSeat);
      const gender = getHero(seat?.heroId ?? null)?.gender;
      lastPlayed.gender = gender ?? null;
      playVoice(action, gender);
    }
  }, [log, players]);
}
