// 房间：座位管理 + 意图驱动引擎 + 按座位裁剪广播 + 断线重连占位
import type { GameMode, Intent, RoomSummary, ServerMessage, SeatView } from '@sgs/protocol';
import {
  applyIntent,
  configFromPreset,
  createGame,
  DEFAULT_GUOZHAN_PRESET,
  freezeConfig,
  toSnapshot,
  validateGuozhanConfig,
  type ApplyResult,
  type GameState,
  type GuozhanRoomConfig,
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
  /** 断线时刻（毫秒）；在线时为 null。用来判「离开太久、该把座位收回了」 */
  disconnectedAt: number | null;
}

export class Room {
  roomCode: string;
  readonly maxSeats: number;
  seats: SeatEntry[];
  hostSeatId: string | null = null;
  pendingMode: GameMode = 'melee';
  /** 测试用：选将不限（房主可开） */
  freePick = false;
  /**
   * 国战扩展开关（开局前房主可改，和 freePick 同一套；**开局后冻结**）。
   * 新建房间用 `DEFAULT_GUOZHAN_PRESET`（线上默认「标准国战」）。
   */
  config: GuozhanRoomConfig = configFromPreset(DEFAULT_GUOZHAN_PRESET);
  game: GameState | null = null;
  started = false;
  /** 开局那一刻的配置快照（只读）；`started` 之后一切以此为准 */
  frozenConfig: Readonly<GuozhanRoomConfig> | null = null;

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
      disconnectedAt: null,
    }));
  }

  /** 找第一个空座位（无人落座） */
  findEmpty(): SeatEntry | null {
    return this.seats.find((s) => s.name === null) ?? null;
  }

  /**
   * 这个昵称占着哪个座位。
   *
   * **一个昵称＝一个用户**：房间里的身份认昵称，不认连接。换设备、清了本地记录、
   * 或者同一个浏览器开第二个标签页时，靠它认出「这是我自己的座位」，
   * 而不是又占一个新位子、把旧座位变成离线幽灵。
   */
  findByName(name: string): SeatEntry | null {
    return this.seats.find((s) => s.name === name) ?? null;
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
    // 同名＝同一个人：点自己那个正在线的座位，等于「在别处接着打」，顶掉旧连接而不是被拒
    const sameSeatOtherConn = seat.name === name && seat.ws !== ws;
    if (seat.name !== null && seat.connected && seat.ws !== ws && !sameSeatOtherConn)
      return { ok: false, error: '该座位已被占用' };

    // 同昵称＝同一个用户：把**另一个**同名的座位让出来。
    // 不这么做就会「同名两个人」：旧座位变成离线幽灵，新座位又占一个位置。
    // ⚠️ 只在未开局时做：开局后座位是游戏状态的一部分（换座＝换人），不能因为同名就动它。
    const sameNameOther =
      this.started || seat.name === name
        ? null
        : this.seats.find((s) => s.name === name && s.seatId !== seatId) ?? null;

    // 换座：先离开原来那个座位（房主换座时身份也要跟着走，见下方再次指派）
    const previous = this.seats.find((s) => s.ws === ws && s.seatId !== seatId);
    let keepHost = !!previous?.isHost;

    // 顶掉旧连接：明确告诉他回大厅——否则他那边的界面会静默卡住（收不到 lobby 了）
    if (sameSeatOtherConn && seat.ws) {
      this.kickNotice(seat.ws, '同一个昵称在别处登入，这个座位已由新的连接接管。');
    }
    if (sameNameOther) {
      if (sameNameOther.isHost) keepHost = true; // 房主是「人」的属性，跟着人走
      // ⚠️ 只有**别的连接**才需要通知：同一条连接换座时，那个「同名旧座位」就是它自己
      //    刚离开的位子——发通知会把它自己顶回大厅。
      if (sameNameOther.connected && sameNameOther.ws && sameNameOther.ws !== ws) {
        this.kickNotice(sameNameOther.ws, '同一个昵称在别处登入，这里的座位已合并到那边。');
      }
      this.releaseSeat(sameNameOther.seatId);
    }
    if (previous) this.releaseSeat(previous.seatId);

    if (seat.name !== null) {
      // 重连：保留原 name / heroId / isHost
      seat.connected = true;
      seat.ws = ws;
      seat.disconnectedAt = null;
    } else {
      // 新落座
      seat.name = name;
      seat.connected = true;
      seat.ws = ws;
      seat.disconnectedAt = null;
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
    seat.disconnectedAt = null;
    if (wasHost) {
      this.hostSeatId = null;
      const next = this.seats.find((s) => s.name !== null);
      if (next) this.setHost(next.seatId);
    }
  }

  /**
   * 把「离开太久」的座位收回（等同本人点了「离开房间」）：离线超过 `timeoutMs` 就释放。
   *
   * 为什么不一直留着：座位是稀缺资源——一个离线幽灵会占着位子不让别人坐，
   * 还会拖着一整个房间（含对局状态）留在内存与大厅列表里。
   * 收回之后，本人再回来走的就是「新登录」那条路（昵称认不到旧座位 → 坐空位）。
   *
   * 对局中的座位被收回时，这一位就变成**可接替的空位**（见 `abandonedSeats`）：
   * 否则整局会永远卡在一个再也不会行动的幽灵身上。
   *
   * 返回：`changed` 有没有座位被收回（要重播 lobby）、`emptied` 是不是空了（调用方删房）。
   */
  releaseIdle(
    timeoutMs: number,
    now = Date.now(),
  ): { changed: boolean; emptied: boolean } {
    let changed = false;
    for (const s of this.seats) {
      if (s.name === null || s.connected) continue;
      const since = s.disconnectedAt ?? now;
      if (now - since <= timeoutMs) continue;
      pushIdleLog(this, s);
      this.releaseSeat(s.seatId);
      changed = true;
    }
    return { changed, emptied: this.isEmpty() };
  }

  /**
   * 对局中「座位空着、但游戏里还有这个人」的位置——可以让人**接替**打下去。
   * 判据两条：room 里没人占，且这局是在开局时把他算进去的。
   */
  abandonedSeats(): SeatEntry[] {
    if (!this.started || !this.game) return [];
    const inGame = new Set(this.game.players.map((p) => p.seatId));
    return this.seats.filter((s) => s.name === null && inGame.has(s.seatId));
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
  canJoin(seatId?: string, name?: string): { ok: true } | { ok: false; error: string } {
    if (!this.started) return { ok: true };
    const seat = seatId
      ? this.seats.find((s) => s.seatId === seatId)
      : name
        ? this.findByName(name)
        : undefined;
    if (seat && seat.name !== null && !seat.connected) return { ok: true };
    // 开局后**空出来的位子**（本人离线太久被收回、或一直没人坐）可以接替：
    // 那一位在游戏里是有人的，不让人接替的话整局就永远停在那儿了。
    if (seat ? this.abandonedSeats().some((s) => s.seatId === seat.seatId) : this.abandonedSeats().length > 0)
      return { ok: true };
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

  /**
   * 房主改「国战扩展开关」。
   *
   * ⚠️ 两条硬规矩（用户给定）：① 只有房主能改；② **开局后不许改**——武将池、势力锦囊、
   * 野心家状态都没法中途迁移，所以 `started` 之后一律拒绝（配置在开局那一刻冻结）。
   * ⚠️ 配置来自网络，先过 `validateGuozhanConfig`（类型只是编译期的）。
   */
  setGuozhanConfig(
    seatId: string,
    config: unknown,
  ): { ok: true } | { ok: false; error: string } {
    if (this.started) return { ok: false, error: '游戏已开始，扩展开关不能再改' };
    if (seatId !== this.hostSeatId) return { ok: false, error: '只有房主能改这个设置' };
    const valid = validateGuozhanConfig(config);
    if (!valid.ok) return { ok: false, error: `扩展配置不合法：${valid.errors.join('；')}` };
    this.config = config as GuozhanRoomConfig;
    return { ok: true };
  }

  /** 房主开局：收集已落座者 → createGame（按模式分配身份/队伍） */
  startGame(
    seatId: string,
    mode: GameMode,
    heroDealCount?: number,
    freePick?: boolean,
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
    this.game = createGame(setups, this.roomCode, {
      mode,
      heroDealCount,
      freePick: this.freePick,
      // 扩展开关用房间里存的那份（房主在大厅设过），**开局即冻结**
      config: this.frozenConfig ?? this.config,
    });
    this.started = true;
    this.frozenConfig = freezeConfig(this.config);
    return { ok: true };
  }

  /** 对外广播/开局用的配置：开局后是冻结的那份 */
  currentConfig(): Readonly<GuozhanRoomConfig> {
    return this.frozenConfig ?? this.config;
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

  /** 把一个连接「请回大厅」：座位上没它了，只能直接发（客户端收到就回大厅并提示） */
  private kickNotice(ws: WebSocket, reason: string): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'roomClosed', reason }));
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
          config: this.currentConfig() as GuozhanRoomConfig,

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
        s.disconnectedAt = Date.now();
      }
    }
    if (this.started) this.broadcastSnapshots();
    else this.broadcastLobby();
  }
}

/** 收回「离开太久」的座位时记一笔（服务端日志，方便运维看谁被清了） */
function pushIdleLog(room: Room, seat: SeatEntry): void {
  console.log(
    `[三国杀] 房间 ${room.roomCode}：${seat.name} 离线太久，座位 ${seat.seatId} 已收回` +
      (room.started ? '（这一局变成可接替的空位）' : ''),
  );
}
