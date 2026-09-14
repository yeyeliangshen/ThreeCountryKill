// 引擎对外 API：前后端共享
export * from './model';
export * from './timing';
export * from './heroes';
export * from './distance';
export { createGame, applyIntent, type SeatSetup, type ApplyResult } from './engine';
export { toSnapshot } from './snapshot';
export { buildPrompt } from './legal';
export { buildDeck, shuffle, seededRng, drawOne } from './deck';
