// 牌的基础类型定义 —— 前后端共享（引擎、服务端、客户端都用这一份）

// —— 基本牌 ——
export type BasicCardType = 'sha' | 'shan' | 'tao' | 'jiu';
// —— 装备牌（按槽位分类）——
export type EquipSlot = 'weapon' | 'armor' | 'plusMount' | 'minusMount';
// —— 即时锦囊 ——
export type TrickType =
  | 'juedou' // 决斗
  | 'nanman' // 南蛮入侵
  | 'wanjian' // 万箭齐发
  | 'jiedao' // 借刀杀人
  | 'guohe' // 过河拆桥
  | 'shunshou' // 顺手牵羊
  | 'wuzhong' // 无中生有
  | 'wuxie' // 无懈可击
  | 'huogong' // 火攻
  | 'taoyuan'; // 桃园结义
// —— 延时锦囊 ——
export type DelayedTrickType = 'lebu' | 'shandian' | 'bingliang';

export type CardType = BasicCardType | EquipSlot | TrickType | DelayedTrickType;

export type Suit = 'spade' | 'heart' | 'club' | 'diamond';

export type DamageAttribute = 'fire' | 'thunder';

export interface Card {
  /** 全局唯一实例 id */
  id: string;
  type: CardType;
  suit: Suit;
  /** 点数 1-13（A=1, J=11, Q=12, K=13） */
  rank: number;
  /** 装备牌的牌名 id（查 EQUIP_NAME 显示） */
  equipName?: string;
  /** 武器攻击范围 */
  range?: number;
  /** 杀的属性伤害（火/雷），缺省为普通 */
  attribute?: DamageAttribute;
}

export const SUIT_COLOR: Record<Suit, 'red' | 'black'> = {
  heart: 'red',
  diamond: 'red',
  spade: 'black',
  club: 'black',
};

export const CARD_TYPE_NAME: Record<CardType, string> = {
  // 基本牌
  sha: '杀',
  shan: '闪',
  tao: '桃',
  jiu: '酒',
  // 装备牌
  weapon: '武器',
  armor: '防具',
  plusMount: '+1马',
  minusMount: '−1马',
  // 即时锦囊
  juedou: '决斗',
  nanman: '南蛮入侵',
  wanjian: '万箭齐发',
  jiedao: '借刀杀人',
  guohe: '过河拆桥',
  shunshou: '顺手牵羊',
  wuzhong: '无中生有',
  wuxie: '无懈可击',
  huogong: '火攻',
  taoyuan: '桃园结义',
  // 延时锦囊
  lebu: '乐不思蜀',
  shandian: '闪电',
  bingliang: '兵粮寸断',
};

/** 装备牌名 → 中文显示 */
export const EQUIP_NAME: Record<string, string> = {
  // 武器
  zhuge: '诸葛连弩',
  qinggang: '青釭剑',
  cixiong: '雌雄双股剑',
  qinglong: '青龙偃月刀',
  zhangba: '丈八蛇矛',
  guanshi: '贯石斧',
  fangtian: '方天画戟',
  qixing: '七星宝刀',
  zhuque: '朱雀羽扇',
  guding: '古锭刀',
  hanbing: '寒冰剑',
  // 防具
  bagua: '八卦阵',
  renwang: '仁王盾',
  tengjia: '藤甲',
  // +1马（防御马）
  dilu: '的卢',
  jueying: '绝影',
  zhuafei: '爪黄飞电',
  // −1马（进攻马）
  chitu: '赤兔',
  zizong: '紫骍',
  dawanma: '大宛马',
};

export const SUIT_NAME: Record<Suit, string> = {
  spade: '黑桃',
  heart: '红桃',
  club: '梅花',
  diamond: '方块',
};

// —— 牌分类谓词 ——
const BASIC_SET: ReadonlySet<BasicCardType> = new Set(['sha', 'shan', 'tao', 'jiu']);
const EQUIP_SET: ReadonlySet<EquipSlot> = new Set(['weapon', 'armor', 'plusMount', 'minusMount']);
const TRICK_SET: ReadonlySet<TrickType> = new Set([
  'juedou', 'nanman', 'wanjian', 'jiedao', 'guohe',
  'shunshou', 'wuzhong', 'wuxie', 'huogong', 'taoyuan',
]);
const DELAYED_SET: ReadonlySet<DelayedTrickType> = new Set(['lebu', 'shandian', 'bingliang']);

export function isBasicCard(card: Card): boolean {
  return BASIC_SET.has(card.type as BasicCardType);
}
export function isEquipCard(card: Card): boolean {
  return EQUIP_SET.has(card.type as EquipSlot);
}
export function isInstantTrick(card: Card): boolean {
  return TRICK_SET.has(card.type as TrickType);
}
export function isDelayedTrick(card: Card): boolean {
  return DELAYED_SET.has(card.type as DelayedTrickType);
}
/** 是否为锦囊牌（即时或延时） */
export function isTrickCard(card: Card): boolean {
  return isInstantTrick(card) || isDelayedTrick(card);
}

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
  const suit = SUIT_NAME[card.suit];
  const rank = rankLabel(card.rank);
  // 装备牌：显示具体牌名
  if (card.equipName && EQUIP_NAME[card.equipName]) {
    return `${suit}${rank}·${EQUIP_NAME[card.equipName]}`;
  }
  // 杀的属性变体
  let name = CARD_TYPE_NAME[card.type] ?? card.type;
  if (card.type === 'sha' && card.attribute === 'fire') name = '火杀';
  if (card.type === 'sha' && card.attribute === 'thunder') name = '雷杀';
  return `${suit}${rank}·${name}`;
}
