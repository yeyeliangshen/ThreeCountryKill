// 牌的基础类型定义 —— 前后端共享（引擎、服务端、客户端都用这一份）

export type CardType = 'sha' | 'shan' | 'tao' | 'jiu';

export type Suit = 'spade' | 'heart' | 'club' | 'diamond';

export interface Card {
  /** 全局唯一实例 id */
  id: string;
  type: CardType;
  suit: Suit;
  /** 点数 1-13（A=1, J=11, Q=12, K=13） */
  rank: number;
}

export const SUIT_COLOR: Record<Suit, 'red' | 'black'> = {
  heart: 'red',
  diamond: 'red',
  spade: 'black',
  club: 'black',
};

export const CARD_TYPE_NAME: Record<CardType, string> = {
  sha: '杀',
  shan: '闪',
  tao: '桃',
  jiu: '酒',
};

export const SUIT_NAME: Record<Suit, string> = {
  spade: '黑桃',
  heart: '红桃',
  club: '梅花',
  diamond: '方块',
};

export function isRed(card: Card): boolean {
  return SUIT_COLOR[card.suit] === 'red';
}

function rankLabel(rank: number): string {
  if (rank === 1) return 'A';
  if (rank === 11) return 'J';
  if (rank === 12) return 'Q';
  if (rank === 13) return 'K';
  return String(rank);
}

export function cardLabel(card: Card): string {
  return `${SUIT_NAME[card.suit]}${rankLabel(card.rank)}·${CARD_TYPE_NAME[card.type]}`;
}
