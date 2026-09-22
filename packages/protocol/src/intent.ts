import type { CardType, DamageAttribute } from './card';

// 回合阶段
/**
 * 回合阶段。**准备阶段与判定阶段是两个阶段**（用户 2026-09-21 口径：准备阶段在判定阶段前）——
 * 以前两者共用 `'judgment'`，于是「按阶段判断」的东西（典型是国战亮将：「准备阶段开始时」才能
 * 主动明置）在判定阶段也会生效。
 * `'turnEnd'` 只出现在类型里（结束阶段目前是一组钩子时机，不是 phase 值）。
 */
export type Phase =
  | 'prepare'
  | 'judgment'
  | 'draw'
  | 'play'
  | 'discard'
  | 'turnEnd'
  | 'gameOver'
  | 'draft';

// 客户端发给服务端的"意图"：玩家想做什么
// 服务端拿意图喂给引擎做权威判定，再裁剪广播
export type Intent =
  // 主动出牌：出牌阶段打杀(指定目标)/桃(自回)/酒(自buff)/装备/锦囊
  // targetCardId: 过河拆桥/顺手牵羊时指定目标明牌区(装备/判定)的具体牌
  | {
      type: 'playCard';
      cardId: string;
      as?: CardType;
      /**
       * 转化后的**伤害属性**（朱雀羽扇：普通【杀】当火【杀】）。
       * 与 `as` 的区别：这是同一张【杀】换属性，不是换牌型。
       */
      asAttribute?: DamageAttribute;
      targetIds: string[];
      targetCardId?: string;
      /**
       * 【丈八蛇矛】：与 `cardId` **一起**当【杀】使用的第二张手牌（两张牌合计）。
       * 只有它装备着丈八蛇矛时才合法；两张牌会被同时置入弃牌堆。
       */
      extraCardIds?: string[];
    }
  // 响应提示：被杀时出闪、濒死时出桃、锦囊响应(出杀/出闪/展示牌/弃牌)
  | {
      type: 'respondCard';
      cardId: string;
      as?: CardType;
      /** 【丈八蛇矛】响应时打出的第二张手牌，语义同 playCard.extraCardIds */
      extraCardIds?: string[];
    }
  // 不响应（弃权）
  | { type: 'aocai' } // 诸葛恪·傲才：用牌堆顶的实体基本牌满足当前响应
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
  // 一次选多名角色（多选座位原语：怀异那种「至多 X 名不同角色」）
  | { type: 'pickSeats'; seatIds: string[] }
  // 势力技：需要打出一张牌时，令同势力角色代打（曹操·护驾 / 刘备·激将）
  | { type: 'factionCall'; skillId: string }
  // 重铸：出牌阶段把一张可重铸的牌置入弃牌堆，然后摸一张牌（不是「使用」）
  | { type: 'recast'; cardId: string }
  // 看完私密信息（知己知彼）后确认
  | { type: 'ack' }
  /**
   * 国战「预亮」：暗置时声明某个技能的发动意图（skillName 是技能中文名）。
   * 同一个技能再发一次就是取消预亮。见 Player.prelitSkills 的规则说明。
   */
  | { type: 'prelightSkill'; skillName: string }
  /**
   * 势备篇「连横」：出牌阶段把一张带连横标记的**手牌**交给
   * 一名势力不同或未确定势力的角色（交给势力不同的角色时摸一张牌）。
   * 它**不是「使用牌」**，所以不触发任何 useCard 钩子。
   */
  | { type: 'lianheng'; cardId: string; targetSeatId: string }
  /**
   * **测试场景布置**（开发工具，不是游戏规则 —— 见 docs §5.206）。
   *
   * 只有 `createGame(..., { testScenario: true })` 的对局才接受它（服务端由
   * `SGS_DEV_TOOLS` / `NODE_ENV` 决定，正式对局一律拒绝）。用途是**构造现场**：
   * 给指定角色发指定的牌到指定区域，省掉「刷牌刷到为止」的成本。
   *
   * 布置**不走技能钩子**（不会触发【谦逊】这类「成为目标时」的询问），但牌的移动
   * 走引擎既有的搬运逻辑（装备走 `playEquip`、判定区照 `playDelayedTrick` 的校验、
   * 弃置一律 `toDiscard`），所以布置出来的局面与真打出来的局面**同构**。
   * 每次布置都会在牌局日志里留 `TEST_DEAL_OVERRIDE` 标记。
   */
  | {
      type: 'testScenario';
      /** 发牌：谁 / 哪张牌（实例 id）/ 放到哪个区域 */
      deals?: { seatId: string; cardId: string; zone: TestDealZone }[];
      /** 给谁几张「节」（陆逊·谦逊收集的牌；测试「度势②」用，上限 3） */
      jie?: { seatId: string; count: number }[];
    };

/**
 * 测试场景布置里能指定的区域。
 * 手牌谁都能放；装备区只放装备牌；判定区只放延时锦囊（且不能与已有的同名）。
 */
export type TestDealZone = 'hand' | 'equip' | 'judge';
