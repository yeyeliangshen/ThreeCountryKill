// 把游戏状态接到音频层：按当前界面切 BGM，按新增日志播音效与卡牌语音。
import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { getHero } from '@sgs/engine';
import { bgm } from './bgm';
import { sfx } from './sfx';
import { pickNewSfx } from './pickNewSfx';
import { pickNewVoices, type SeatHeroes } from './pickNewVoices';
import { playHeroVoice, playVoice } from './voice';
import { lastPlayed } from './debug';

export function useGameAudio(): void {
  const screen = useStore((s) => s.screen);
  const log = useStore((s) => s.snapshot?.log);
  const players = useStore((s) => s.snapshot?.players);

  // 界面 → BGM 场景
  useEffect(() => {
    bgm.play(screen === 'game' ? 'battle' : 'menu');
  }, [screen]);

  /**
   * 某座次手上那两个武将（id + 技能名）——武将语音要靠它把「日志里出现的技能名」对上武将。
   *
   * 暗置武将的快照里拿不到 id（国战暗置是暗信息），那种情况返回 null，武将语音就跳过；
   * 技能名同时收「身份/军争版」与「国战覆盖版」，因为同一张牌两种模式技能名可能不同。
   */
  const heroesOf = (seatId: string): SeatHeroes | null => {
    const seat = players?.find((p) => p.seatId === seatId);
    const ids = [seat?.heroId, seat?.deputyHeroId].filter((x): x is string => !!x);
    if (ids.length === 0) return null;
    const skills = ids.flatMap((id) => {
      const h = getHero(id);
      if (!h) return [];
      return [...(h.skills ?? []).map((s) => s.name), ...(h.guozhan?.skills ?? []).map((s) => s.name)];
    });
    return { heroId: seat?.heroId ?? null, deputyHeroId: seat?.deputyHeroId ?? null, skills };
  };

  // 新日志 → 音效 + 卡牌语音（判断依据见 pickNewSfx）
  const lastId = useRef(-1);
  // 武将语音单独一个游标：它按**每一条**新日志判（一条快照里可能有好几句技能语音）
  const lastVoiceId = useRef(-1);
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

    // 武将语音：【技能】念技能语音、【阵亡】念阵亡语音（没有对应文件就静默跳过）
    const voices = pickNewVoices(lastVoiceId.current, log, heroesOf);
    lastVoiceId.current = voices.lastId;
    for (const v of voices.requests) playHeroVoice(v.heroId, v.skill);
  }, [log, players]);
}
