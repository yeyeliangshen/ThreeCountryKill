import type { Intent } from './intent';
import type { GameMode, RoomSummary, SeatView, Snapshot } from './views';

// —— WebSocket 消息信封 ——
//
// 流程：连上 → `enterHall` 进大厅（只登记昵称）→ 看房间列表 → `createRoom` 或 `joinRoom`
// → 房间内（`lobby`）→ `startGame` → 对局（`snapshot`）。
// 注意**没有**「填房号建房」这条路了：房间由房主显式创建，没有房主的房间不存在。

// 客户端 → 服务端
export type ClientMessage =
  /** 进大厅：只登记昵称，**不建房**。之后会收到 `hall` 房间列表 */
  | { type: 'enterHall'; name: string }
  /** 大厅：创建房间。服务端分配房号，创建者成为房主并自动落座 1 号位 */
  | { type: 'createRoom' }
  /**
   * 大厅：进指定房间。
   * 带 `seatId` 表示要**认回/接替**那个座位（刷新回来、换设备、救离线的人）；
   * 不带就自动坐第一个空位。已开局的房间只允许带 seatId 的认回。
   */
  | { type: 'joinRoom'; roomCode: string; seatId?: string }
  /** 大厅：主动要一次最新的房间列表（界面上的「刷新」） */
  | { type: 'listRooms' }
  /** 房间内：离开房间。未开局才释放座位（对局中由服务端改成只断开） */
  | { type: 'leaveRoom' }
  /**
   * 房间内选座：换到空座位，或认回自己的离线座位。
   * 已经坐着的话会先释放原座位（换座）。
   */
  | { type: 'claimSeat'; seatId: string }
  // 房主在大厅切换模式（实时广播给他人）
  | { type: 'setMode'; mode: GameMode }
  // 房主在大厅切换「选将不限」（测试用）
  | { type: 'setFreePick'; freePick: boolean }
  /** 房主切换「势备篇（+52 张）」。和 freePick 一样是**开局前的房间状态** */
  | { type: 'setShibei'; shibei: boolean }
  // 房主开局：指定模式 + 可选每人发将数 + 可选选将不限
  | {
      type: 'startGame';
      mode: GameMode;
      heroDealCount?: number;
      freePick?: boolean;
      /** 势备篇：开启后国战牌堆追加 52 张（只追加到国战） */
      shibei?: boolean;
    }
  // 游戏中的行动意图
  | { type: 'intent'; intent: Intent };

// 服务端 → 客户端
export type ServerMessage =
  /** 大厅的房间列表。只有「在大厅里」的连接会收到（已进房的不收） */
  | { type: 'hall'; rooms: RoomSummary[] }
  // 房间状态
  | {
      type: 'lobby';
      roomCode: string;
      seats: SeatView[];
      started: boolean;
      mySeatId: string | null;
      mode: GameMode; // 房主当前选择的模式
      freePick: boolean; // 房主是否开了「选将不限（测试用）」
      shibei: boolean; // 房主是否开了「势备篇（+52 张）」
    }
  /** 房间被删了（房主离开且没人留下，或房主解散）：客户端回大厅并提示 */
  | { type: 'roomClosed'; reason: string }
  // 游戏中按玩家裁剪的快照
  | { type: 'snapshot'; snapshot: Snapshot }
  // 错误提示
  | { type: 'error'; message: string };
