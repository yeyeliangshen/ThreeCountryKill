// 几个跨模块共用的小类型与工具。

/** 本机记住的会话：刷新/锁屏回来时用它自动回到原房间原座位 */
export interface SavedSession {
  roomCode: string;
  name: string;
  seatId: string | null;
}
