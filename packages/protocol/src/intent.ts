import type { CardType } from './card';

// 回合阶段
export type Phase = 'judgment' | 'draw' | 'play' | 'discard' | 'turnEnd' | 'gameOver' | 'draft';

// 客户端发给服务端的"意图"：玩家想做什么
// 服务端拿意图喂给引擎做权威判定，再裁剪广播
export type Intent =
  // 主动出牌：出牌阶段打杀(指定目标)/桃(自回)/酒(自buff)/装备/锦囊
  // targetCardId: 过河拆桥/顺手牵羊时指定目标明牌区(装备/判定)的具体牌
  | { type: 'playCard'; cardId: string; as?: CardType; targetIds: string[]; targetCardId?: string }
  // 响应提示：被杀时出闪、濒死时出桃、锦囊响应(出杀/出闪/展示牌/弃牌)
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
  | { type: 'revealHero'; heroId: string }
  // 主动技能：出牌阶段使用武将主动技能（制衡/苦肉/离间等）
  | { type: 'useSkill'; skillId: string; cardIds?: string[]; targetIds: string[] } // 通用「选择一项」：技能要求某个角色在若干选项里选一个（反间/铁骑/除疠…）
  | { type: 'chooseOption'; optionId: string }
  // 从一组牌里选若干张（选牌原语：观星看牌堆顶、刚烈弃两张、仁德送牌…）
  | { type: 'pickCards'; cardIds: string[] }
  // 势力技：需要打出一张牌时，令同势力角色代打（曹操·护驾 / 刘备·激将）
  | { type: 'factionCall'; skillId: string }
  // 重铸：出牌阶段把一张可重铸的牌置入弃牌堆，然后摸一张牌（不是「使用」）
  | { type: 'recast'; cardId: string }
  // 看完私密信息（知己知彼）后确认
  | { type: 'ack' };
