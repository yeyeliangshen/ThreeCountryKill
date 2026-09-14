import type { Card, CardType, DamageAttribute, Faction, GameMode, LogEntry, Phase, RoleId, Suit } from '@sgs/protocol';

// —— 装备区 ——
/** 4 个槽位：武器 / 防具 / +1马(防御马) / −1马(进攻马) */
export interface Equipment {
  weapon: Card | null;
  armor: Card | null;
  plusMount: Card | null;
  minusMount: Card | null;
}

export function emptyEquipment(): Equipment {
  return { weapon: null, armor: null, plusMount: null, minusMount: null };
}

// —— 玩家状态 ——
export interface PlayerFlags {
  /** 本回合已出杀数 */
  shaCountThisTurn: number;
  /** 本回合酒buff：下一张杀伤害+1 */
  jiuActive: boolean;
  /** 本回合已用酒救次数（限1次/回合） */
  taoSaveCountThisTurn: number;
  /** 本回合已用主动技能标记 */
  skillUsedThisTurn: Record<string, boolean>;
  /** 跳过出牌阶段（乐不思蜀） */
  skipPlay: boolean;
  /** 跳过摸牌阶段（兵粮寸断） */
  skipDraw: boolean;
}

export function emptyFlags(): PlayerFlags {
  return {
    shaCountThisTurn: 0,
    jiuActive: false,
    taoSaveCountThisTurn: 0,
    skillUsedThisTurn: {},
    skipPlay: false,
    skipDraw: false,
  };
}

export interface Player {
  seatId: string;
  name: string;
  heroId: string | null; // 选将阶段未定，为 null
  hp: number;
  maxHp: number;
  hand: Card[];
  equipment: Equipment;
  judgment: Card[]; // 延时锦囊判定区
  alive: boolean;
  flags: PlayerFlags;
  role: RoleId | null; // 身份（军争），选将阶段未定
  team: 0 | 1 | null; // 队伍（2v2），非 2v2 为 null
  deputyHeroId: string | null; // 副将（国战），非国战为 null
  heroRevealed: boolean; // 主将是否已亮将（国战用，非国战恒 true）
  deputyRevealed: boolean; // 副将是否已亮将（国战用，非国战恒 true）
  faction: Faction | null; // 阵营（国战用），非国战为 null
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
  /** 伤害属性（火/雷） */
  attribute?: DamageAttribute;
  /** 需要的闪数（默认1，吕布·无双=2，马超·铁骑/黄忠·烈弓=Infinity 不可闪避） */
  requiredShan?: number;
}

// 即时锦囊结算上下文（贯穿：打出→无懈可击询问→结算→响应）
export interface TrickContext {
  sourceId: string;
  card: Card;
  // 过河拆桥/顺手牵羊：目标与指定的明牌区牌
  targetId?: string;
  targetCardId?: string;
  // 南蛮/万箭：需依次响应的存活玩家队列
  responders: string[];
  responderIndex: number;
  // 决斗：当前该谁出杀（target=目标方，source=来源方）
  duelTurn?: 'target' | 'source';
  // 火攻：目标展示的手牌花色
  revealedSuit?: Suit;
  // 借刀杀人：被指定出杀的目标（targetIds[1]）
  shaTargetId?: string;
  // 主动技能创建的虚拟锦囊标识（离间=lilian）
  skillId?: string;
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
  | { kind: 'discard'; seatId: string; count: number }
  // 锦囊响应：出杀(南蛮/决斗/借刀)/出闪(万箭)/展示牌(火攻)/弃牌(火攻)
  | { kind: 'respondTrick'; responderId: string; ctx: TrickContext }
  // 无懈可击询问轮：全体依次可打出无懈
  | { kind: 'wuxieQueue'; ctx: TrickContext; askQueue: string[]; askIndex: number }
  // 主动技能：出牌阶段使用主动技能（多步交互时暂停）
  | { kind: 'activeSkill'; seatId: string; skillId: string };

// 选将阶段：每人随机发到 K 张武将，各自选 1（并发，全选完才开局）
export interface DraftState {
  deals: Record<string, string[]>; // seatId -> 该座发到的 K 个 heroId
  pendingSeats: string[]; // 尚未选将的 seatId
}

export interface GameState {
  roomCode: string;
  mode: GameMode; // 当前对局模式
  players: Player[];
  seatOrder: string[]; // 回合顺序
  deck: Card[];
  discard: Card[];
  turn: { seatIndex: number; phase: Phase };
  pending: Pending | null;
  draft: DraftState | null; // 非空表示处于选将阶段
  // AOE锦囊(南蛮/万箭)被濒死中断时暂存上下文，near-death结算后继续下一个响应者
  ongoingTrick: TrickContext | null;
  started: boolean;
  gameOver: boolean;
  winner: string | null; // 胜方标识（阵营/队伍/身份方），未结束时为 null
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
