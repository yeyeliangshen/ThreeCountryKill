import type { Intent } from './intent';
import type { GameMode, SeatView, Snapshot } from './views';

// —— WebSocket 消息信封 ——

// 客户端 → 服务端
export type ClientMessage =
  // 进房
  | { type: 'join'; roomCode: string; name: string }
  // 大厅选座
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
  // 大厅状态
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
  // 游戏中按玩家裁剪的快照
  | { type: 'snapshot'; snapshot: Snapshot }
  // 错误提示
  | { type: 'error'; message: string };
