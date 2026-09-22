// 引擎对外 API：前后端共享
export * from './model';
export * from './timing';
export * from './heroes';
export * from './markers';
export * from './config';
export * from './distance';
/**
 * 延时锦囊「合法目标」的**唯一事实来源**（用户 2026-09-22 口径：只有【兵粮寸断】有距离限制，
 * 【乐不思蜀】没有）。引擎出牌校验（`playDelayedTrick`）与提示下发（`legal.ts` 两处）共用。
 */
export * from './delayedTrickTargets';
export {
  createGame,
  applyIntent,
  activeHeroes,
  canUseAsCard,
  factionHelpers,
  isAoyu,
  prelitableSkills,
  /**
   * 【火攻】「目标必须有手牌」的**唯一判据**（纯函数）：直接出牌的校验、技能的目标候选
   * （奇策/役鬼）、以及虚拟锦囊的结算入口三处共用（用户 2026-09-23 复报「其他交互路径」）。
   */
  dropTargetsWithoutHand,
  /**
   * 「这张牌**打出之后**，该角色手里还剩几张手牌」——【火攻】指**自己**时的目标判据
   * （打出后这张火攻已离开自己的手牌，所以要把它自己减掉再数；用户 2026-09-24 口径
   * 「自己有手牌才可对自己使用，自己没手牌时仍不可选」）。出牌校验与提示下发共用。
   */
  handCardsAfterPlaying,
  /** 探针用：这一格是不是「已走完却还占着槽」（施工方案 Step 1.5 的指标探测器） */
  isCompletedPending,
  /** 施工方案 Step 3b：被围栏挡住且没有 waiter 可去时抛出（`SGS_FENCE_ENFORCE=1` 才生效） */
  FenceBlockedError,
  /** 施工方案 Step 4.7：还没被唤醒的等待者数量（`blockedContinuationNeverResumed` 的探测器） */
  pendingWaiterCount,
  /**
   * 开发工具（「测试场景编辑器」，docs §5.206）：选牌目录 + 每个区域的可用性规则。
   * 正式规则路径不使用它们；前端面板与它共用同一份「哪些牌能放哪个区域」的判据。
   */
  resolveExtensions,
  testScenarioCatalog,
  testDealZonesFor,
  type TestScenarioCard,
  type SeatSetup,
  type ApplyResult,
} from './engine';
export { toSnapshot } from './snapshot';
export { buildPrompt } from './legal';
export { buildDeck, shuffle, seededRng, drawOne } from './deck';
