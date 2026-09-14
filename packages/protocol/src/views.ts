import type { Card } from './card';
import type { Phase } from './intent';

// —— 游戏模式 ——
export type GameMode = 'junzheng' | '2v2' | 'melee' | 'guozhan';

// —— 身份（军争模式） ——
export type RoleId = 'lord' | 'loyal' | 'rebel' | 'renegade';

// —— 阵营（国战模式） ——
export type Faction = 'shu' | 'wei' | 'wu' | 'qun' | 'neutral' | 'ambitionist';

// —— 服务端按玩家裁剪后下发的"视图"，不泄露他人手牌 ——

// 单个玩家的公开信息
export interface PlayerView {
  seatId: string;
  name: string;
  heroId: string | null; // 选将阶段未定，为 null
  hp: number;
  maxHp: number;
  handCount: number;
  isAlive: boolean;
  // 装备区/判定区在首期为空，先留结构供后续扩展
  equipmentCount: number;
  judgmentCount: number;
  // 身份（军争）：主公对所有人公开，其余仅本人可见（他人视图为 null）
  role?: RoleId | null;
  // 队伍（2v2）：公开
  team?: 0 | 1 | null;
  // 副将（国战）：暗置时对他人为 null
  deputyHeroId?: string | null;
  // 阵营（国战）：未亮将时对他人为 null
  faction?: Faction | null;
  // 主将是否已亮将（国战公开信息）
  heroRevealed?: boolean;
  // 副将是否已亮将（国战公开信息）
  deputyRevealed?: boolean;
}

export type PromptKind = 'play' | 'respondSha' | 'respondDeath' | 'discard' | 'pickHero';

// 告诉玩家当前需要做什么 + 合法选项（服务端权威计算后下发）
export interface PromptView {
  kind: PromptKind;
  message: string;
  // 可用的牌 id
  legalCardIds: string[];
  // 可选的目标 seatId
  legalTargetIds: string[];
  // 此提示需要选几个目标
  mustSelectTargetCount: number;
  // 选将阶段：发给我的武将 id 列表（仅 pickHero 有）
  legalHeroIds?: string[];
}

export interface LogEntry {
  message: string;
  kind: string;
}

// 大厅阶段的座位
export interface SeatView {
  seatId: string;
  name: string | null;
  isHost: boolean;
  connected: boolean;
  heroId: string | null;
}

// 下发给某个玩家的完整快照
export interface Snapshot {
  seatId: string; // 此快照属于哪个座位
  roomCode: string;
  started: boolean;
  mode: GameMode; // 当前对局模式
  players: PlayerView[];
  myHand: Card[]; // 仅本人手牌完整下发
  turn: { seatId: string; phase: Phase };
  prompt: PromptView | null; // 轮到你行动时非空
  winner: string | null; // 游戏未结束时为 null；结束时为胜方标识
  log: LogEntry[];
}
