import type { CardType } from './card';

// 回合阶段
export type Phase = 'judgment' | 'draw' | 'play' | 'discard' | 'turnEnd' | 'gameOver' | 'draft';

// 客户端发给服务端的"意图"：玩家想做什么
// 服务端拿意图喂给引擎做权威判定，再裁剪广播
export type Intent =
  // 主动出牌：出牌阶段打杀(指定目标)/桃(自回)/酒(自buff)
  | { type: 'playCard'; cardId: string; as?: CardType; targetIds: string[] }
  // 响应提示：被杀时出闪、濒死时出桃
  | { type: 'respondCard'; cardId: string; as?: CardType }
  // 不响应（弃权）
  | { type: 'pass' }
  // 结束当前阶段（出牌阶段结束等）
  | { type: 'endPhase' }
  // 弃牌阶段弃牌
  | { type: 'discard'; cardIds: string[] }
  // 选将阶段：从发到的武将中选 1 位（国战选 2 位，副将 id 传 deputyHeroId）
  | { type: 'pickHero'; heroId: string; deputyHeroId?: string }
  // 国战：出牌阶段主动亮将（传入要亮的武将 id）
  | { type: 'revealHero'; heroId: string };
