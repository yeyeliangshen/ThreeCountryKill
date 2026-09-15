// 背景音乐。
//
// 音源优先级：
//   1. packages/ui/assets/bgm/<场景>.mp3  —— 某个场景专用
//   2. packages/ui/assets/bgm/default.*   —— 所有场景共用（没有专用文件时）
//   3. 内置合成音 —— 用 Web Audio 现场合成的五声音阶循环，不需要任何音频文件
//
// 浏览器要求先有用户交互才允许出声，所以首次 play() 若被自动播放策略挂起，
// 会在第一次 pointerdown / keydown 时自动恢复，不需要调用方配合。

export type BgmScene = 'menu' | 'battle';

export interface BgmState {
  /** 当前场景；null 表示已停止 */
  scene: BgmScene | null;
  muted: boolean;
  /** 0 ~ 1 */
  volume: number;
  /** 当前音源：文件 / 合成音 / 无 */
  source: 'file' | 'synth' | null;
  /** 因浏览器自动播放策略而等待用户交互 */
  blocked: boolean;
  /**
   * AudioContext 状态。'running' 才代表真的在出声；
   * 'suspended' 说明还没拿到播放许可（浏览器要求先有用户交互）。
   */
  contextState: AudioContextState | null;
  /** 音乐文件时长（秒）；null 表示没有文件或还没加载出来 */
  fileDuration: number | null;
  /** 音乐文件加载/解码失败，已退回合成音 */
  fileFailed: boolean;
}

// —— 真实音乐文件（可选）——
const MUSIC_FILES = import.meta.glob('../../assets/bgm/*.{mp3,ogg,m4a,mp4,wav}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** 所有场景都不指定文件时用的兜底文件名 */
const FALLBACK_NAME = 'default';

/** 按文件名匹配场景：battle.mp3 → 'battle'；没有专用文件则用 default.* */
function fileFor(scene: BgmScene): string | null {
  let fallback: string | null = null;
  for (const [path, url] of Object.entries(MUSIC_FILES)) {
    const base = path.split('/').pop()?.replace(/\.[^.]+$/, '');
    if (base === scene) return url;
    if (base === FALLBACK_NAME) fallback = url;
  }
  return fallback;
}

// —— 合成音参数 ——
// 五声音阶（宫商角徵羽）的半音间隔
const PENTATONIC = [0, 2, 4, 7, 9];

interface Track {
  /** 主音频率（Hz） */
  root: number;
  /** 每分钟拍数 */
  bpm: number;
  /** 持续低音（Hz），两个音构成空五度 */
  drone: [number, number];
  /** 每拍用几个音 */
  notesPerBeat: number;
  /** 出现鼓点的拍位（battle 用） */
  drums: boolean;
}

const TRACKS: Record<BgmScene, Track> = {
  // 菜单：慢、留白多
  menu: { root: 261.63, bpm: 52, drone: [130.81, 196.0], notesPerBeat: 2, drums: false },
  // 对局：快、加密、带鼓
  battle: { root: 220.0, bpm: 88, drone: [110.0, 164.81], notesPerBeat: 4, drums: true },
};

const STORE_KEY = 'sgs.audio';

function loadPrefs(): { muted: boolean; volume: number } {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { muted?: boolean; volume?: number };
      return { muted: !!p.muted, volume: typeof p.volume === 'number' ? p.volume : 0.5 };
    }
  } catch {
    // 隐私模式下 localStorage 可能不可用，忽略
  }
  return { muted: false, volume: 0.5 };
}

function savePrefs(muted: boolean, volume: number): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ muted, volume }));
  } catch {
    // 同上
  }
}

const prefs = loadPrefs();

let state: BgmState = {
  scene: null,
  muted: prefs.muted,
  volume: prefs.volume,
  source: null,
  blocked: false,
  contextState: null,
  fileDuration: null,
  fileFailed: false,
};

const listeners = new Set<() => void>();

function emit(patch: Partial<BgmState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

// —— 音频资源 ——
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let droneOscs: OscillatorNode[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let el: HTMLAudioElement | null = null;
/** 当前正在播的文件 URL，用于判断换场景时要不要重头播 */
let currentUrl: string | null = null;
let nextNoteTime = 0;
let step = 0;
let unlockBound = false;
/** 期望播放的场景：被自动播放策略挡住时记下来，等用户交互后补播 */
let wantScene: BgmScene | null = null;

/** 有效增益：静音时归零 */
function gain(): number {
  return state.muted ? 0 : state.volume;
}

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = gain();
    master.connect(ctx.destination);
    // 让界面能反映「还没拿到播放许可」的状态
    ctx.onstatechange = () => emit({ contextState: ctx?.state ?? null });
    emit({ contextState: ctx.state });
  }
  return ctx;
}

/** 首次用户交互时恢复被挂起的音频上下文，并补播之前被挡下的音乐 */
function bindUnlock(): void {
  if (unlockBound || typeof window === 'undefined') return;
  unlockBound = true;
  const onGesture = () => {
    if (ctx?.state === 'suspended') void ctx.resume();
    if (!state.blocked) return;
    emit({ blocked: false });
    // 之前没能真正出声，这里从头起一遍
    const scene = wantScene;
    if (scene) {
      stopSynth();
      stopFile();
      emit({ scene: null, source: null });
      bgm.play(scene);
    }
  };
  for (const ev of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(ev, onGesture);
  }
}

// —— 合成音：音符与鼓 ——

/** 拨弦音色：三角波 + 快速衰减包络 */
function pluck(freq: number, at: number, dur: number, level: number): void {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2200;
  osc.type = 'triangle';
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(level, at + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(lp).connect(env).connect(master);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

/** 鼓：短噪声 + 低通扫频 */
function drum(at: number, level: number): void {
  if (!ctx || !master) return;
  const len = Math.floor(ctx.sampleRate * 0.18);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    // 越往后越弱
    data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(420, at);
  lp.frequency.exponentialRampToValueAtTime(90, at + 0.16);
  const env = ctx.createGain();
  env.gain.value = level;
  src.connect(lp).connect(env).connect(master);
  src.start(at);
}

/** 推进一格节拍：排入后续音符 */
function schedule(): void {
  if (!ctx || !state.scene) return;
  // 还没拿到播放许可时 currentTime 是冻结的，照常排程会在恢复播放的瞬间
  // 把积压的音符一次性全放出来；这里只把游标拉到当前时间。
  if (ctx.state !== 'running') {
    nextNoteTime = ctx.currentTime + 0.1;
    return;
  }
  const track = TRACKS[state.scene];
  const beat = 60 / track.bpm;
  const slice = beat / track.notesPerBeat;
  // 提前 0.25s 排程，避免 setInterval 抖动造成卡顿
  while (nextNoteTime < ctx.currentTime + 0.25) {
    const at = nextNoteTime;
    const inBar = step % (track.notesPerBeat * 4);
    // 每格约 65% 概率出声，留出呼吸感
    if (Math.random() < 0.65) {
      const deg = PENTATONIC[Math.floor(Math.random() * PENTATONIC.length)]!;
      // 偶尔高八度，形成起伏
      const octave = Math.random() < 0.25 ? 2 : 1;
      const freq = track.root * Math.pow(2, deg / 12) * octave;
      pluck(freq, at, 0.85 + Math.random() * 0.5, 0.16);
    }
    if (track.drums && inBar % track.notesPerBeat === 0) {
      drum(at, inBar === 0 ? 0.28 : 0.16);
    }
    nextNoteTime += slice;
    step++;
  }
}

function startSynth(scene: BgmScene): void {
  const c = ensureCtx();
  if (!c || !master) return;
  bindUnlock();
  if (c.state === 'suspended') {
    void c.resume();
    if (c.state === 'suspended') emit({ blocked: true });
  }
  const track = TRACKS[scene];
  // 低音持续音
  for (const f of track.drone) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = f;
    g.gain.value = 0.07;
    osc.connect(g).connect(master);
    osc.start();
    droneOscs.push(osc);
  }
  step = 0;
  nextNoteTime = c.currentTime + 0.1;
  timer = setInterval(schedule, 60);
  schedule();
}

function stopSynth(): void {
  if (timer) clearInterval(timer);
  timer = null;
  for (const o of droneOscs) {
    try {
      o.stop();
    } catch {
      // 已停止则忽略
    }
  }
  droneOscs = [];
}

function stopFile(): void {
  if (el) {
    el.onloadedmetadata = null;
    el.onerror = null;
    el.pause();
    el = null;
  }
  currentUrl = null;
  if (state.fileDuration !== null) emit({ fileDuration: null });
}

function startFile(url: string, scene: BgmScene): void {
  currentUrl = url;
  if (!el) {
    el = new Audio(url);
    el.loop = true;
  } else if (!el.src.endsWith(url)) {
    el.src = url;
  }
  const audio = el;
  audio.onloadedmetadata = () => {
    if (el !== audio) return;
    // duration 有值说明文件真的被取到并解码成功
    emit({ fileDuration: Number.isFinite(audio.duration) ? audio.duration : null, fileFailed: false });
  };
  audio.onerror = () => {
    if (el !== audio) return;
    // 文件取不到或解码失败：退回内置合成音，别让玩家静默地没有声音
    emit({ fileFailed: true, fileDuration: null, source: 'synth' });
    stopFile();
    startSynth(scene);
  };
  audio.volume = gain();
  void audio.play().catch(() => {
    if (el === audio) emit({ blocked: true });
  });
}

// —— 对外 API ——
export const bgm = {
  /** 切到某个场景；同一场景重复调用无副作用 */
  play(scene: BgmScene): void {
    wantScene = scene;
    if (state.scene === scene) return;
    const file = fileFor(scene);
    // 两个场景用的是同一个文件（放的是 default.*）时接着播，
    // 否则从菜单进对局会把音乐打断、从头开始
    if (file && file === currentUrl) {
      stopSynth();
      emit({ scene, source: 'file', fileFailed: false, blocked: false });
      return;
    }
    stopSynth();
    stopFile();
    emit({ scene, fileFailed: false, blocked: false });
    if (file) {
      emit({ source: 'file' });
      startFile(file, scene);
    } else {
      emit({ source: 'synth' });
      startSynth(scene);
    }
  },

  stop(): void {
    wantScene = null;
    stopSynth();
    stopFile();
    emit({ scene: null, source: null });
  },

  toggleMuted(): void {
    bgm.setMuted(!state.muted);
  },

  setMuted(next: boolean): void {
    emit({ muted: next });
    applyGain();
    savePrefs(next, state.volume);
  },

  setVolume(v: number): void {
    const clamped = Math.max(0, Math.min(1, v));
    emit({ volume: clamped });
    applyGain();
    savePrefs(state.muted, clamped);
  },

  getState(): BgmState {
    return state;
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/** 把当前增益同步到实际播放的资源上 */
function applyGain(): void {
  if (master) master.gain.value = gain();
  if (el) el.volume = gain();
  // 从 0 音量恢复到有声时，合成音不会自动开始，这里重新起一遍
  if (!state.muted && state.volume > 0 && state.scene && state.source === 'synth' && !timer) {
    stopSynth();
    startSynth(state.scene);
  }
  if (!state.muted && state.volume > 0 && state.scene && state.source === 'file' && el?.paused) {
    void el.play().catch(() => emit({ blocked: true }));
  }
}
