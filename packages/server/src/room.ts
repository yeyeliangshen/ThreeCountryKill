// 房间：座位管理 + 意图驱动引擎 + 按座位裁剪广播 + 断线重连占位
import type { GameMode, Intent, ServerMessage, SeatView } from '@sgs/protocol';
import {
  applyIntent,
  createGame,
  toSnapshot,
  type ApplyResult,
  type GameState,
  type SeatSetup,
} from '@sgs/engine';
import type { WebSocket } from 'ws';

/** 模式所需人数校验 */
function modeMinPlayers(mode: GameMode): number {
  switch (mode) {
    case '2v2':
      return 4;
    case 'junzheng':
      return 5;
    default:
      return 2;
  }
}
function modeMaxPlayers(mode: GameMode): number {
  switch (mode) {
    case '2v2':
      return 4;
    case 'junzheng':
      return 8;
    default:
      return 8;
  }
}

/** 单个座位的服务端视图：名字 + 是否在线 + 武将 + 持有连接 */
export interface SeatEntry {
  seatId: string;
  name: string | null;
  isHost: boolean;
  connected: boolean;
  heroId: string | null;
  ws: WebSocket | null;
}

export class Room {
  roomCode: string;
  readonly maxSeats: number;
  seats: SeatEntry[];
  hostSeatId: string | null = null;
  pendingMode: GameMode = 'melee';
  /** 测试用：选将不限（房主可开） */
  freePick = false;
  /** 房主是否开了势备篇（开局前可改，和 freePick 同一套） */
  shibei = false;
  game: GameState | null = null;
  started = false;

  constructor(roomCode: string, maxSeats = 8) {
    this.roomCode = roomCode;
    this.maxSeats = maxSeats;
    this.seats = Array.from({ length: maxSeats }, (_, i) => ({
      seatId: String(i + 1),
      name: null,
      isHost: false,
      connected: false,
      heroId: null,
      ws: null,
    }));
  }

  /** 找第一个空座位（无人落座） */
  findEmpty(): SeatEntry | null {
    return this.seats.find((s) => s.name === null) ?? null;
  }

  /**
   * 落座 / 重连。
   * - 空座位：新落座，首个落座者成为房主。
   * - 已占用且断线：重连，恢复原身份（保留 name / heroId / isHost）。
   * - 已占用且在线：拒绝。
   */
  claimSeat(
    seatId: string,
    ws: WebSocket,
    name: string,
  ): { ok: true; seatId: string } | { ok: false; error: string } {
    const seat = this.seats.find((s) => s.seatId === seatId);
    if (!seat) return { ok: false, error: '座位不存在' };
    if (seat.name !== null && seat.connected) return { ok: false, error: '该座位已被占用' };

    if (seat.name !== null) {
      // 重连：保留原 name / heroId / isHost
      seat.connected = true;
      seat.ws = ws;
    } else {
      // 新落座
      seat.name = name;
      seat.connected = true;
      seat.ws = ws;
      if (this.hostSeatId === null) {
        this.hostSeatId = seatId;
        seat.isHost = true;
      }
    }
    return { ok: true, seatId };
  }

  /** 房主切换模式（大厅阶段） */
  setMode(seatId: string, mode: GameMode): { ok: true } | { ok: false; error: string } {
    if (this.started) return { ok: false, error: '游戏已开始' };
    if (seatId !== this.hostSeatId) return { ok: false, error: '只有房主能切换模式' };
    this.pendingMode = mode;
    return { ok: true };
  }

  /** 房主切换「选将不限（测试用）」 */
  setFreePick(seatId: string, freePick: boolean): { ok: true } | { ok: false; error: string } {
    if (this.started) return { ok: false, error: '游戏已开始' };
    if (seatId !== this.hostSeatId) return { ok: false, error: '只有房主能改这个设置' };
    this.freePick = !!freePick;
    return { ok: true };
  }

  /** 房主切换「势备篇（+52 张）」 */
  setShibei(seatId: string, shibei: boolean): { ok: true } | { ok: false; error: string } {
    if (this.started) return { ok: false, error: '游戏已开始' };
    if (seatId !== this.hostSeatId) return { ok: false, error: '只有房主能改这个设置' };
    this.shibei = !!shibei;
    return { ok: true };
  }

  /** 房主开局：收集已落座者 → createGame（按模式分配身份/队伍） */
  startGame(
    seatId: string,
    mode: GameMode,
    heroDealCount?: number,
    freePick?: boolean,
    shibei?: boolean,
  ): { ok: true } | { ok: false; error: string } {
    if (this.started) return { ok: false, error: '游戏已开始' };
    if (seatId !== this.hostSeatId) return { ok: false, error: '只有房主能开始游戏' };
    const occupied = this.seats.filter((s) => s.name !== null);
    const n = occupied.length;
    const min = modeMinPlayers(mode);
    const max = modeMaxPlayers(mode);
    const modeName =
      mode === '2v2' ? '2v2' : mode === 'junzheng' ? '军争' : mode === 'guozhan' ? '国战' : '混战';
    if (n < min) return { ok: false, error: `${modeName}模式至少需要 ${min} 人` };
    if (n > max) return { ok: false, error: `${modeName}模式最多 ${max} 人` };
    const setups: SeatSetup[] = occupied.map((s) => ({
      seatId: s.seatId,
      name: s.name!,
    }));
    // freePick 是房主在开局前用 setFreePick 设过的状态，开局消息里可以不带。
    // 带 `!!freePick` 会把「设过但没带」冲成 false，开关就白点了。
    if (freePick !== undefined) this.freePick = !!freePick;
    // 同理：不带 shibei 就别动已设好的状态（写成 !!shibei 会把开关冲掉）
    if (shibei !== undefined) this.shibei = !!shibei;
    this.game = createGame(setups, this.roomCode, {
      mode,
      heroDealCount,
      freePick: this.freePick,
      shibei: this.shibei,
    });
    this.started = true;
    return { ok: true };
  }

  /** 意图驱动：applyIntent 原子变更权威状态 */
  handleIntent(seatId: string, intent: Intent): ApplyResult {
    if (!this.game) return { ok: false, error: '游戏未开始' };
    return applyIntent(this.game, seatId, intent);
  }

  /** 协议层座位视图（大厅广播用） */
  seatViews(): SeatView[] {
    return this.seats.map((s) => ({
      seatId: s.seatId,
      name: s.name,
      isHost: s.isHost,
      connected: s.connected,
      heroId: s.heroId,
    }));
  }

  private sendToSeat(seatId: string, msg: ServerMessage): void {
    const seat = this.seats.find((s) => s.seatId === seatId);
    if (seat?.ws && seat.connected && seat.ws.readyState === seat.ws.OPEN) {
      seat.ws.send(JSON.stringify(msg));
    }
  }

  /** 大厅阶段：给所有在线座位广播 lobby */
  broadcastLobby(): void {
    const seats = this.seatViews();
    for (const s of this.seats) {
      if (s.connected && s.name !== null) {
        this.sendToSeat(s.seatId, {
          type: 'lobby',
          roomCode: this.roomCode,
          seats,
          started: this.started,
          mySeatId: s.seatId,
          mode: this.pendingMode,
          freePick: this.freePick,
          shibei: this.shibei,
        });
      }
    }
  }

  /** 游戏阶段：给每个在线座位发各自的裁剪快照 */
  broadcastSnapshots(): void {
    if (!this.game) return;
    for (const s of this.seats) {
      if (s.connected && s.name !== null) {
        this.sendToSeat(s.seatId, {
          type: 'snapshot',
          snapshot: toSnapshot(this.game, s.seatId),
        });
      }
    }
  }

  /** 断线：标记 disconnected，保留座位（可重连） */
  disconnect(ws: WebSocket): void {
    for (const s of this.seats) {
      if (s.ws === ws) {
        s.connected = false;
        s.ws = null;
      }
    }
    if (this.started) this.broadcastSnapshots();
    else this.broadcastLobby();
  }
}
