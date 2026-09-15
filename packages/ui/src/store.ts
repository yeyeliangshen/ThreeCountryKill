// 全局状态：连接、大厅、快照；ws 收发；断线自动重连按 seatId 恢复
import { create } from 'zustand';
import type { ClientMessage, GameMode, Intent, SeatView, ServerMessage, Snapshot } from '@sgs/protocol';

export type Screen = 'join' | 'lobby' | 'game';

export interface LobbyState {
  roomCode: string;
  seats: SeatView[];
  started: boolean;
  mySeatId: string | null;
  mode: GameMode;
  /** 房主是否开了「选将不限（测试用）」 */
  freePick: boolean;
}

interface Store {
  screen: Screen;
  ws: WebSocket | null;
  // 表单
  serverAddr: string;
  roomCode: string;
  name: string;
  heroDealCount: number; // 房主配置：每人随机发将数
  connected: boolean;
  error: string | null;
  lobby: LobbyState | null;
  snapshot: Snapshot | null;
  reconnecting: boolean;
  // 内部
  _seatId: string | null;
  // setters
  setForm: (patch: Partial<Pick<Store, 'serverAddr' | 'roomCode' | 'name' | 'heroDealCount'>>) => void;
  // 动作
  connect: () => void;
  disconnect: () => void;
  send: (msg: ClientMessage) => void;
  claimSeat: (seatId: string) => void;
  setMode: (mode: GameMode) => void;
  startGame: () => void;
  sendIntent: (intent: Intent) => void;
  pickHero: (heroId: string) => void;
  pickHeroes: (heroId: string, deputyHeroId: string) => void;
  revealHero: (heroId: string) => void;
  useSkill: (skillId: string, cardIds: string[], targetIds: string[]) => void;
  setFreePick: (on: boolean) => void;
  chooseOption: (optionId: string) => void;
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
      case 'lobby':
        set({
          lobby: {
            roomCode: msg.roomCode,
            seats: msg.seats,
            started: msg.started,
            mySeatId: msg.mySeatId,
            mode: msg.mode,
            freePick: msg.freePick,
          },
          screen: msg.started ? 'game' : 'lobby',
          error: null,
          reconnecting: false,
        });
        // 若已开局但还没收到 snapshot，等 snapshot 到达；screen 已切 game
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
      // 进房
      get().send({ type: 'join', roomCode: roomCode.trim() || 'default', name: name.trim() || '无名' });
      // 若是重连且之前已落座，重新占回该座位（服务端保留座位）
      if (_seatId) get().send({ type: 'claimSeat', seatId: _seatId });
    };

    ws.onmessage = (e) => onMessage(typeof e.data === 'string' ? e.data : '');

    ws.onclose = () => {
      set({ connected: false });
      const { screen } = get();
      // 仅在已进房/游戏中才重连（纯 join 失败不重连，避免死循环）
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
    // 开发默认 localhost:8080；生产构建后默认空（用当前页 host，即部署服务器）
    serverAddr: import.meta.env.DEV ? 'localhost:8080' : '',
    roomCode: '',
    name: '',
    heroDealCount: 3,
    connected: false,
    error: null,
    lobby: null,
    snapshot: null,
    reconnecting: false,
    _seatId: null,

    setForm: (patch) => set(patch),

    connect: () => {
      // 关掉旧连接
      const old = get().ws;
      if (old) {
        old.onclose = null;
        old.close();
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      open();
    },

    disconnect: () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = get().ws;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      set({
        ws: null,
        connected: false,
        screen: 'join',
        lobby: null,
        snapshot: null,
        error: null,
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

    setMode: (mode) => get().send({ type: 'setMode', mode }),

    // 选将不限（测试用）：立刻广播，开局时服务端也带上这个标记
    setFreePick: (on) => get().send({ type: 'setFreePick', freePick: on }),

    startGame: () =>
      get().send({ type: 'startGame', mode: get().lobby?.mode ?? 'melee', heroDealCount: get().heroDealCount }),

    sendIntent: (intent) => get().send({ type: 'intent', intent }),

    pickHero: (heroId) => get().sendIntent({ type: 'pickHero', heroId }),

    pickHeroes: (heroId, deputyHeroId) =>
      get().sendIntent({ type: 'pickHero', heroId, deputyHeroId }),

    revealHero: (heroId) => get().sendIntent({ type: 'revealHero', heroId }),

    useSkill: (skillId, cardIds, targetIds) =>
      get().sendIntent({ type: 'useSkill', skillId, cardIds, targetIds }),

    chooseOption: (optionId) => get().sendIntent({ type: 'chooseOption', optionId }),

    dismissError: () => set({ error: null }),
  };
});
