// 引擎对外 API：前后端共享
export * from './model';
export * from './timing';
export * from './heroes';
export * from './markers';
export * from './config';
export * from './distance';
export {
  createGame,
  applyIntent,
  activeHeroes,
  canUseAsCard,
  factionHelpers,
  isAoyu,
  prelitableSkills,
  /** 探针用：这一格是不是「已走完却还占着槽」（施工方案 Step 1.5 的指标探测器） */
  isCompletedPending,
  /** 施工方案 Step 3b：被围栏挡住且没有 waiter 可去时抛出（`SGS_FENCE_ENFORCE=1` 才生效） */
  FenceBlockedError,
  /** 施工方案 Step 4.7：还没被唤醒的等待者数量（`blockedContinuationNeverResumed` 的探测器） */
  pendingWaiterCount,
  type SeatSetup,
  type ApplyResult,
} from './engine';
export { toSnapshot } from './snapshot';
export { buildPrompt } from './legal';
export { buildDeck, shuffle, seededRng, drawOne } from './deck';
