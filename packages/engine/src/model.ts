import type { Card, CardType, LogEntry, Phase } from '@sgs/protocol';

// —— 玩家状态 ——
export interface PlayerFlags {
  /** 本回合已出杀数 */
  shaCountThisTurn: number;
  /** 本回合酒buff：下一张杀伤害+1 */
  jiuActive: boolean;
}

export interface Player {
  seatId: string;
  name: string;
  heroId: string | null; // 选将阶段未定，为 null
  hp: number;
  maxHp: number;
  hand: Card[];
  equipment: Card[]; // 首期为空，留结构
  judgment: Card[]; // 首期为空，留结构
  alive: boolean;
  flags: PlayerFlags;
}

// 一次"杀"的结算上下文（贯穿 使用→成为目标→结算）
export interface AttackContext {
  sourceId: string;
  cardId: string;
  /** 转化后的类型（武圣把红牌当杀时为 'sha'） */
  asType: CardType;
  targetId: string;
  damage: number;
  dodged: boolean;
}

// 引擎"暂停等待玩家输入"的几种状态
export type Pending =
  // 出牌阶段：你可继续出牌或结束
  | { kind: 'play'; seatId: string }
  // 被杀为目标：出闪或弃权
  | { kind: 'respondSha'; responderId: string; attack: AttackContext }
  // 濒死求桃：按座次轮询每个玩家
  | { kind: 'respondDeath'; dyingId: string; askQueue: string[]; askIndex: number }
  // 弃牌阶段：弃到上限
  | { kind: 'discard'; seatId: string; count: number };

// 选将阶段：每人随机发到 K 张武将，各自选 1（并发，全选完才开局）
export interface DraftState {
  deals: Record<string, string[]>; // seatId -> 该座发到的 K 个 heroId
  pendingSeats: string[]; // 尚未选将的 seatId
}

export interface GameState {
  roomCode: string;
  players: Player[];
  seatOrder: string[]; // 回合顺序
  deck: Card[];
  discard: Card[];
  turn: { seatIndex: number; phase: Phase };
  pending: Pending | null;
  draft: DraftState | null; // 非空表示处于选将阶段
  started: boolean;
  gameOver: boolean;
  log: LogEntry[];
}

// —— 查询辅助 ——
export function getPlayer(state: GameState, seatId: string): Player | undefined {
  return state.players.find((p) => p.seatId === seatId);
}

export function getPlayerOrThrow(state: GameState, seatId: string): Player {
  const p = getPlayer(state, seatId);
  if (!p) throw new Error(`unknown seat ${seatId}`);
  return p;
}

/** 从 fromIndex 起（含）下一个存活的座次下标 */
export function nextAliveSeat(state: GameState, fromIndex: number): number {
  const n = state.seatOrder.length;
  for (let i = 1; i <= n; i++) {
    const idx = (fromIndex + i) % n;
    const p = getPlayer(state, state.seatOrder[idx]!);
    if (p?.alive) return idx;
  }
  return fromIndex;
}

/** 从某座次起、按回合顺序的存活玩家 seatId 列表（含起点） */
export function aliveSeatsFrom(state: GameState, startSeatId: string): string[] {
  const startIdx = state.seatOrder.indexOf(startSeatId);
  if (startIdx < 0) return [];
  const n = state.seatOrder.length;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const idx = (startIdx + i) % n;
    const seat = state.seatOrder[idx]!;
    const p = getPlayer(state, seat);
    if (p?.alive) out.push(seat);
  }
  return out;
}

export function alivePlayers(state: GameState): Player[] {
  return state.players.filter((p) => p.alive);
}

export function pushLog(state: GameState, kind: string, message: string): void {
  state.log.push({ kind, message });
  // 保留最近 200 条，避免无限增长
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}
