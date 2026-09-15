// 音效。全部用 Web Audio 现场合成，不依赖任何音频文件。
//
// 想要更好的效果，可以按 BGM 的办法往 packages/ui/assets/sfx/ 放文件，
// 然后把 play() 里的合成分支换成 <场景名>.mp3 —— 目前先只做合成音。

/** 音效名 */
export type SfxName =
  | 'click' // UI 点击
  | 'card' // 出牌（杀/锦囊/装备/技能）
  | 'judge' // 判定翻牌
  | 'damage' // 受到伤害
  | 'heal' // 回复体力
  | 'death' // 阵亡
  | 'turn'; // 回合开始

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
   * 播放一个音效。
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
};
