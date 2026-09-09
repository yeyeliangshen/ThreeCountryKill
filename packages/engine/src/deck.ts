import type { Card, CardType, Suit } from '@sgs/protocol';
import type { GameState } from './model';

// 构建一副基础牌（首期简化牌组，约 60 张）。
// 闪/桃全为红色（关羽武圣可转化），杀/酒混合花色。
export function buildDeck(): Card[] {
  const cards: Card[] = [];
  let n = 0;
  const mk = (type: CardType, suit: Suit, rank: number): Card => ({
    id: `c${n++}`,
    type,
    suit,
    rank,
  });

  // 杀 28：黑桃8 + 梅花7 + 红桃7 + 方块6
  for (let r = 1; r <= 8; r++) cards.push(mk('sha', 'spade', r));
  for (let r = 1; r <= 7; r++) cards.push(mk('sha', 'club', r));
  for (let r = 1; r <= 7; r++) cards.push(mk('sha', 'heart', r));
  for (let r = 1; r <= 6; r++) cards.push(mk('sha', 'diamond', r));

  // 闪 18（全红）
  for (let r = 1; r <= 9; r++) cards.push(mk('shan', 'heart', r));
  for (let r = 1; r <= 9; r++) cards.push(mk('shan', 'diamond', r));

  // 桃 10（全红）
  for (let r = 1; r <= 6; r++) cards.push(mk('tao', 'heart', r));
  for (let r = 1; r <= 4; r++) cards.push(mk('tao', 'diamond', r));

  // 酒 4（黑色）
  cards.push(mk('jiu', 'spade', 1));
  cards.push(mk('jiu', 'spade', 2));
  cards.push(mk('jiu', 'club', 1));
  cards.push(mk('jiu', 'club', 2));

  return cards;
}

/** Fisher-Yates 洗牌，返回新数组 */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/** 简单可种子化 RNG（测试/重放用） */
export function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从牌堆顶抽一张；牌堆空时把弃牌堆洗回 */
export function drawOne(state: GameState): Card | null {
  if (state.deck.length === 0) {
    if (state.discard.length === 0) return null;
    state.deck = shuffle(state.discard);
    state.discard = [];
  }
  return state.deck.pop() ?? null;
}
