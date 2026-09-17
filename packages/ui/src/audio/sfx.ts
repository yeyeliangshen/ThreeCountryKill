// 音效。
//
// 优先用 packages/ui/assets/sfx/ 里的真实音效文件（来自三国杀Online 音效包）；
// 没有对应文件时回退到 Web Audio 现场合成的音。
//
// 动作标识（日志里的 action）→ 音效文件：

import { lastPlayed } from './debug';

/** 音效名（纯合成音，没有对应文件的那些） */
export type SfxName =
  | 'click' // UI 点击
  | 'card' // 通用出牌（没专门音效的牌）
  | 'judge' // 判定翻牌
  | 'damage' // 受到伤害
  | 'heal' // 回复体力
  | 'death' // 阵亡
  | 'turn'; // 回合开始

/** 真实音效文件：动作 → 候选文件名（多个则随机取一个，避免每次听同一句） */
const ACTION_FILES: Record<string, string[]> = {
  sha: ['sha-1', 'sha-2'],
  'sha-fire': ['sha-fire-1', 'sha-fire-2'],
  'sha-thunder': ['sha-thunder-1', 'sha-thunder-2'],
  tao: ['heal'],
  equip: ['equip'],
  shandian: ['shandian'],
  shield: ['shield-1', 'shield-2'],
  selfhurt: ['selfhurt'],
};

/** 动作没有专门音效时，用哪个合成音兜底 */
const ACTION_FALLBACK: Record<string, SfxName> = {
  shan: 'card',
  jiu: 'heal',
  wuxie: 'judge',
  juedou: 'card',
  nanman: 'card',
  wanjian: 'card',
  jiedao: 'card',
  guohe: 'card',
  shunshou: 'card',
  wuzhong: 'card',
  huogong: 'damage',
  taoyuan: 'heal',
  lebu: 'judge',
  bingliang: 'judge',
};

const FILES = import.meta.glob('../../assets/sfx/*.{mp3,ogg,m4a,wav}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const BY_NAME: Record<string, string> = {};
for (const [path, url] of Object.entries(FILES)) {
  const name = path.split('/').pop()?.replace(/\.[^.]+$/, '');
  if (name) BY_NAME[name] = url;
}

let ctx: AudioContext | null = null;
let out: GainNode | null = null;

/** 音效总体音量（相对 BGM 更响一点，不然听不见） */
const SFX_GAIN = 0.5;

function ensure(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    ctx = new Ctor();
    out = ctx.createGain();
    out.gain.value = SFX_GAIN;
    out.connect(ctx.destination);
  }
  return ctx;
}

/** 播一个音频文件；文件不存在返回 false，交给合成音兜底 */
function playFile(name: string): boolean {
  const url = BY_NAME[name];
  if (!url) return false;
  const el = new Audio(url);
  el.volume = Math.min(1, SFX_GAIN + 0.25);
  void el.play().catch(() => {
    // 自动播放被拦或解码失败：静默放弃，不要因此报错打断游戏
  });
  return true;
}

/** 单音：波形 + 起止频率 + 时长 */
function tone(
  freqFrom: number,
  freqTo: number,
  dur: number,
  type: OscillatorType,
  level: number,
  delay = 0,
): void {
  const c = ensure();
  if (!c || !out) return;
  const at = c.currentTime + delay;
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freqFrom, at);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), at + dur);
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(level, at + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(env).connect(out);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

/** 噪声：用于打击感 */
function noise(dur: number, level: number, cutoff: number, delay = 0): void {
  const c = ensure();
  if (!c || !out) return;
  const at = c.currentTime + delay;
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = cutoff;
  const env = c.createGain();
  env.gain.value = level;
  src.connect(lp).connect(env).connect(out);
  src.start(at);
}

export const sfx = {
  /**
   * 播放一个合成音效。
   * 静音状态由调用方（useGameAudio）统一判断，这里只管发声。
   */
  play(name: SfxName): void {
    switch (name) {
      case 'click':
        tone(660, 440, 0.06, 'square', 0.1);
        break;
      case 'card':
        // 甩牌的「唰」：短噪声 + 上滑音
        noise(0.09, 0.16, 3500);
        tone(520, 900, 0.09, 'triangle', 0.11);
        break;
      case 'judge':
        // 翻牌：两声轻铃
        tone(1180, 1180, 0.22, 'sine', 0.13);
        tone(1570, 1570, 0.28, 'sine', 0.09, 0.06);
        break;
      case 'damage':
        // 受击：低频下坠 + 闷响
        tone(220, 60, 0.28, 'sawtooth', 0.16);
        noise(0.16, 0.2, 700);
        break;
      case 'heal':
        // 回复：三音上行
        tone(523, 523, 0.18, 'sine', 0.12);
        tone(659, 659, 0.18, 'sine', 0.12, 0.09);
        tone(784, 784, 0.3, 'sine', 0.12, 0.18);
        break;
      case 'death':
        tone(320, 70, 0.9, 'sawtooth', 0.15);
        break;
      case 'turn':
        // 回合开始：一声低锣
        tone(196, 180, 0.5, 'sine', 0.1);
        tone(294, 270, 0.4, 'sine', 0.06, 0.02);
        break;
    }
  },

  /**
   * 播放某个「动作」的音效（日志里的 action）。
   * 有真实音效文件就用文件，没有就用 ACTION_FALLBACK 里的合成音兜底；
   * 两者都没有则不出声（返回 false），由调用方决定要不要补别的音。
   */
  playAction(action: string): boolean {
    const names = ACTION_FILES[action];
    if (names && names.length > 0) {
      // 有多句变体时随机挑一句，免得每次都是同一个声音
      const pick = names[Math.floor(Math.random() * names.length)]!;
      if (playFile(pick)) {
        lastPlayed.sfx = pick;
        return true;
      }
    }
    const fallback = ACTION_FALLBACK[action];
    if (fallback) {
      sfx.play(fallback);
      lastPlayed.sfx = `synth:${fallback}`;
      return true;
    }
    return false;
  },
};
