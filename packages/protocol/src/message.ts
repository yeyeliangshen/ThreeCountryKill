import type { Intent } from './intent';
import type { SeatView, Snapshot } from './views';

// —— WebSocket 消息信封 ——

// 客户端 → 服务端
export type ClientMessage =
  // 进房
  | { type: 'join'; roomCode: string; name: string }
  // 大厅选座
  | { type: 'claimSeat'; seatId: string }
  // 房主开局：可指定每人随机发将数（默认 3）
  | { type: 'startGame'; heroDealCount?: number }
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
    }
  // 游戏中按玩家裁剪的快照
  | { type: 'snapshot'; snapshot: Snapshot }
  // 错误提示
  | { type: 'error'; message: string };
