// 全局状态：连接、大厅（房间列表）、房间、快照；ws 收发；
// 断线/刷新后按本地记住的 {房号, 座位} 自动回到原房间原座位。
import { create } from 'zustand';
import type {
  ClientMessage,
  GameMode,
  Intent,
  RoomSummary,
  SeatView,
  ServerMessage,
  Snapshot,
} from '@sgs/protocol';
import { clearSession, loadSession, saveSession } from './session';

/** 四个界面：填地址进大厅 → 大厅（房间列表）→ 房间 → 对局 */
export type Screen = 'join' | 'hall' | 'lobby' | 'game';

export interface LobbyState {
  roomCode: string;
  seats: SeatView[];
  started: boolean;
  mySeatId: string | null;
  mode: GameMode;
  /** 房主是否开了「选将不限（测试用）」 */
  freePick: boolean;
  /** 房主是否开了「势备篇（+52 张）」（只对国战生效） */
  shibei: boolean;
}

interface Store {
  screen: Screen;
  ws: WebSocket | null;
  // 连哪台服务器：**不给玩家填**，由页面地址/开发环境默认值决定（见下方初始化）
  serverAddr: string;
  name: string;
  /** 当前所在房间号（在大厅里是空串）。刷新后从 localStorage 恢复，用来认回房间 */
  roomCode: string;
  /** 大厅的房间列表 */
  rooms: RoomSummary[];
  heroDealCount: number; // 房主配置：每人随机发将数
  connected: boolean;
  error: string | null;
  lobby: LobbyState | null;
  snapshot: Snapshot | null;
  reconnecting: boolean;
  // 内部
  _seatId: string | null;
  // setters
  setForm: (patch: Partial<Pick<Store, 'name' | 'heroDealCount'>>) => void;
  // 动作
  connect: () => void;
  disconnect: () => void;
  send: (msg: ClientMessage) => void;
  claimSeat: (seatId: string) => void;
  /** 大厅：创建房间（自己当房主，自动落座 1 号位） */
  createRoom: () => void;
  /** 大厅：进指定房间。带 seatId 表示认回/接替那个座位 */
  joinRoom: (roomCode: string, seatId?: string) => void;
  /** 房间内：离开房间回大厅（对局中服务端会拒绝） */
  leaveRoom: () => void;
  /** 大厅：刷新房间列表 */
  refreshRooms: () => void;
  setMode: (mode: GameMode) => void;
  startGame: () => void;
  sendIntent: (intent: Intent) => void;
  pickHero: (heroId: string) => void;
  pickHeroes: (heroId: string, deputyHeroId: string) => void;
  revealHero: (heroId: string) => void;
  useSkill: (skillId: string, cardIds: string[], targetIds: string[]) => void;
  setFreePick: (on: boolean) => void;
  setShibei: (on: boolean) => void;
  chooseOption: (optionId: string) => void;
  pickCards: (cardIds: string[]) => void;
  factionCall: (skillId: string) => void;
  dismissError: () => void;
}

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function buildWsUrl(addr: string): string {
  const a = addr.trim();
  // 留空：用当前页 host 作为 ws 地址（部署后页面与 ws 同端口，自动同源）
  if (!a) return `ws://${location.host}`;
  let withProto = a;
  if (!/^wss?:\/\//.test(withProto)) withProto = `ws://${withProto}`;
  // 无端口则补 8080
  const m = withProto.match(/^(wss?:\/\/[^:/]+)(:\d+)?(.*)$/);
  if (m && !m[2]) withProto = `${m[1]}:8080${m[3] ?? ''}`;
  return withProto;
}

// 上次的会话（服务器 / 房号 / 昵称 / 座位）——刷新回来能直接接上。
// 放在模块作用域：下面自动重连要用，create 的回调外面也得看得见。
const saved = loadSession();

export const useStore = create<Store>()((set, get) => {
  // 处理服务端消息
  const onMessage = (raw: string) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hall':
        // 只有「在大厅里」的连接会收到这个；进房后服务端就不再发了
        set({
          rooms: msg.rooms,
          screen: 'hall',
          lobby: null,
          snapshot: null,
          roomCode: '',
          _seatId: null,
          error: null,
          reconnecting: false,
        });
        break;
      case 'lobby':
        set((prev) => {
          const lobby = {
            roomCode: msg.roomCode,
            seats: msg.seats,
            started: msg.started,
            mySeatId: msg.mySeatId,
            mode: msg.mode,
            freePick: msg.freePick,
            shibei: msg.shibei,
          };
          // 记住「我在哪」：刷新/锁屏回来时靠它自动回到原房间原座位
          saveSession({
            roomCode: msg.roomCode,
            name: prev.name,
            seatId: msg.mySeatId,
          });
          return {
            lobby,
            roomCode: msg.roomCode,
            _seatId: msg.mySeatId,
            screen: msg.started ? 'game' : 'lobby',
            error: null,
            reconnecting: false,
          };
        });
        // 若已开局但还没收到 snapshot，等 snapshot 到达；screen 已切 game
        break;
      case 'roomClosed':
        // 房主离开后没人留下（或房主解散）→ 回大厅并提示
        clearSession();
        set({
          screen: 'hall',
          lobby: null,
          snapshot: null,
          roomCode: '',
          _seatId: null,
          error: msg.reason,
        });
        break;
      case 'snapshot':
        set({ snapshot: msg.snapshot, screen: 'game', error: null, reconnecting: false });
        break;
      case 'error':
        set({ error: msg.message });
        break;
    }
  };

  // 建立连接：onopen 发 join；onclose 自动重连
  const open = () => {
    const { serverAddr, roomCode, name, _seatId } = get();
    const url = buildWsUrl(serverAddr);
    const ws = new WebSocket(url);
    set({ ws });

    ws.onopen = () => {
      set({ connected: true, error: null, reconnecting: false });
      // 先进大厅（只登记昵称，服务端不建房）
      get().send({ type: 'enterHall', name: name.trim() || '无名' });
      // 上次还在房间里（刷新/锁屏回来）→ 直接回那个房间并认回自己的座位。
      // 座位号一起带上：服务端认这个座而不是随便给我塞一个空位。
      if (roomCode) get().send({ type: 'joinRoom', roomCode, seatId: _seatId ?? undefined });
    };

    ws.onmessage = (e) => onMessage(typeof e.data === 'string' ? e.data : '');

    ws.onclose = () => {
      set({ connected: false });
      const { screen } = get();
      // 仅在已进房/游戏中才重连（单纯的连接失败不重连，避免死循环）。
      // 大厅里断线不自动重连：列表本来就是一次性的，点「刷新」即可。
      if (screen === 'lobby' || screen === 'game') {
        set({ reconnecting: true });
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(open, 1500);
      } else {
        set({ screen: 'join' });
      }
    };

    ws.onerror = () => {
      set({ error: '无法连接到服务器，请检查地址' });
    };
  };

  return {
    screen: 'join',
    ws: null,
    // 开发默认 localhost:8080；生产构建后空 = 用当前页 host（部署服务器）。
    // ⚠️ 不再读存档里的地址：登录页已经没有这一栏，留着旧值只会把人指到别的服务器。
    serverAddr: import.meta.env.DEV ? 'localhost:8080' : '',
    name: saved?.name ?? '',
    roomCode: saved?.roomCode ?? '',
    rooms: [],
    heroDealCount: 3,
    connected: false,
    error: null,
    lobby: null,
    snapshot: null,
    reconnecting: false,
    _seatId: saved?.seatId ?? null,

    setForm: (patch) => set(patch),

    connect: () => {
      // 关掉旧连接
      const old = get().ws;
      if (old) {
        old.onclose = null;
        old.close();
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      // 有记住的房间 → 这是「回来」而不是「第一次进」，给个提示
      if (get().roomCode) set({ reconnecting: true });
      open();
    },

    disconnect: () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = get().ws;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      // 主动断开：连本地记住的会话一起清掉，否则下次进来又自动回去了
      clearSession();
      set({
        ws: null,
        connected: false,
        screen: 'join',
        lobby: null,
        snapshot: null,
        error: null,
        rooms: [],
        roomCode: '',
        _seatId: null,
        reconnecting: false,
      });
    },

    send: (msg) => {
      const ws = get().ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },

    claimSeat: (seatId) => {
      set({ _seatId: seatId });
      get().send({ type: 'claimSeat', seatId });
    },

    createRoom: () => get().send({ type: 'createRoom' }),

    joinRoom: (roomCode, seatId) => {
      // 认回自己的座位时先把 seatId 记下（服务端可能拒了，那也不影响）
      if (seatId) set({ _seatId: seatId });
      get().send({ type: 'joinRoom', roomCode: roomCode.trim(), ...(seatId ? { seatId } : {}) });
    },

    leaveRoom: () => {
      get().send({ type: 'leaveRoom' });
      // 本地也当场清掉「我在房间里」，免得服务端拒绝（对局中）时状态不一致
      clearSession();
      set({ roomCode: '', _seatId: null, lobby: null, snapshot: null });
    },

    refreshRooms: () => get().send({ type: 'listRooms' }),

    setMode: (mode) => get().send({ type: 'setMode', mode }),

    // 选将不限（测试用）：立刻广播，开局时服务端也带上这个标记
    setFreePick: (on) => get().send({ type: 'setFreePick', freePick: on }),

    setShibei: (on) => get().send({ type: 'setShibei', shibei: on }),

    startGame: () =>
      get().send({
        type: 'startGame',
        mode: get().lobby?.mode ?? 'melee',
        heroDealCount: get().heroDealCount,
        // 开局消息把 freePick 一起带上：不带的话服务端会把它当成没设过
        freePick: get().lobby?.freePick ?? false,
        shibei: get().lobby?.shibei ?? false,
      }),

    sendIntent: (intent) => get().send({ type: 'intent', intent }),

    pickHero: (heroId) => get().sendIntent({ type: 'pickHero', heroId }),

    pickHeroes: (heroId, deputyHeroId) =>
      get().sendIntent({ type: 'pickHero', heroId, deputyHeroId }),

    revealHero: (heroId) => get().sendIntent({ type: 'revealHero', heroId }),

    useSkill: (skillId, cardIds, targetIds) =>
      get().sendIntent({ type: 'useSkill', skillId, cardIds, targetIds }),

    chooseOption: (optionId) => get().sendIntent({ type: 'chooseOption', optionId }),

    pickCards: (cardIds) => get().sendIntent({ type: 'pickCards', cardIds }),

    factionCall: (skillId) => get().sendIntent({ type: 'factionCall', skillId }),

    dismissError: () => set({ error: null }),
  };
});

// 上次还在房间里（刷新 / 锁屏回来 / 页面被回收后重开）→ **自动回去**，
// 不用再点一次「进入大厅」：连上 ws 后 open() 会 enterHall 再 joinRoom 认回座位。
// 没有存过房间就老老实实停在填昵称那一屏，不要凭空去连服务器。
// 用 setTimeout 推到下一个 tick：不想在 create() 里同步建 WebSocket。
if (saved?.roomCode) {
  setTimeout(() => useStore.getState().connect(), 0);
}
