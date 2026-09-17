// 房间：座位管理 + 意图驱动引擎 + 按座位裁剪广播 + 断线重连占位
import type { GameMode, Intent, RoomSummary, ServerMessage, SeatView } from '@sgs/protocol';
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
   * 落座 / 重连 / 换座。
   * - 空座位：新落座。房里还没有房主时（＝刚建好的房间）他成为房主。
   * - 已占用且断线：**重连**，恢复原身份（保留 name / heroId / isHost）——
   *   这就是「认回座位」和「接替离线的人」，服务端本来就靠这条实现。
   * - 已占用且在线：拒绝。
   *
   * 同一条连接如果已经坐在别的座位上，会**先释放原座位**（换座），
   * 否则换一次座会占着两个位置、还能把房主身份一起搬走。
   */
  claimSeat(
    seatId: string,
    ws: WebSocket,
    name: string,
  ): { ok: true; seatId: string } | { ok: false; error: string } {
    const seat = this.seats.find((s) => s.seatId === seatId);
    if (!seat) return { ok: false, error: '座位不存在' };
    if (seat.name !== null && seat.connected && seat.ws !== ws)
      return { ok: false, error: '该座位已被占用' };

    // 换座：先离开原来那个座位（房主换座时身份也要跟着走，见下方再次指派）
    const previous = this.seats.find((s) => s.ws === ws && s.seatId !== seatId);
    const keepHost = !!previous?.isHost;
    if (previous) this.releaseSeat(previous.seatId);

    if (seat.name !== null) {
      // 重连：保留原 name / heroId / isHost
      seat.connected = true;
      seat.ws = ws;
    } else {
      // 新落座
      seat.name = name;
      seat.connected = true;
      seat.ws = ws;
    }
    // 房主：新房里第一个落座的人（＝建房者），或刚换座过来的房主
    if (this.hostSeatId === null || keepHost) {
      this.setHost(seatId);
    }
    return { ok: true, seatId };
  }

  /** 把房主身份交给某个座位（先把旧的清掉，保证全场只有一个 isHost） */
  private setHost(seatId: string): void {
    for (const s of this.seats) s.isHost = false;
    const seat = this.seats.find((s) => s.seatId === seatId);
    if (!seat) {
      this.hostSeatId = null;
      return;
    }
    seat.isHost = true;
    this.hostSeatId = seatId;
  }

  /**
   * 释放一个座位（离开房间 / 换座时腾位置）。
   *
   * **房主让位时把房主移交给房间里下一个占着座位的人**；没人了就留 null
   * （调用方据此删房，见 index.ts 的 destroyRoom）。
   * 注意这里只处理「座位」，删房的判断在调用方——房间的存活条件只有一条：
   * 还有没有人占着座位（离线也算占着，所以他们能回来）。
   */
  releaseSeat(seatId: string): void {
    const seat = this.seats.find((s) => s.seatId === seatId);
    if (!seat) return;
    const wasHost = this.hostSeatId === seatId || seat.isHost;
    seat.name = null;
    seat.connected = false;
    seat.ws = null;
    seat.heroId = null;
    seat.isHost = false;
    if (wasHost) {
      this.hostSeatId = null;
      const next = this.seats.find((s) => s.name !== null);
      if (next) this.setHost(next.seatId);
    }
  }

  /** 房间里还有没有人**占着座位**（离线也算占着）——空了就该删房 */
  isEmpty(): boolean {
    return this.seats.every((s) => s.name === null);
  }

  /**
   * 能不能进这个房间。**已开局的房间只允许「认回/接替」**——
   * 即那个座位已经有名字但离线（刷新回来、换设备、救掉线的队友）；
   * 其他人一律进不去，免得半路插进一局正在打的牌。
   * 这是大厅那条「已开局 → 显示但点不进去」的唯一判定处。
   */
  canJoin(seatId?: string): { ok: true } | { ok: false; error: string } {
    if (!this.started) return { ok: true };
    const seat = seatId ? this.seats.find((s) => s.seatId === seatId) : undefined;
    if (seat && seat.name !== null && !seat.connected) return { ok: true };
    return { ok: false, error: '该房间已开局，无法加入' };
  }

  /**
   * 现在能不能离开房间。对局中不放人（座位保留、重连能接着打），
   * 打完（gameOver）之后就可以走了。
   */
  canLeave(): boolean {
    return !this.started || !!this.game?.gameOver;
  }

  /** 大厅房间列表里的一行 */
  summary(): RoomSummary {
    const host = this.seats.find((s) => s.seatId === this.hostSeatId);
    return {
      roomCode: this.roomCode,
      hostName: host?.name ?? '—',
      players: this.seats.filter((s) => s.name !== null).length,
      maxSeats: this.maxSeats,
      mode: this.pendingMode,
      started: this.started,
    };
  }

  /** 房间被删时的通知（房主离开且没人留下） */
  notifyClosed(reason: string): void {
    for (const s of this.seats) {
      if (s.name !== null && s.connected) this.sendToSeat(s.seatId, { type: 'roomClosed', reason });
    }
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
