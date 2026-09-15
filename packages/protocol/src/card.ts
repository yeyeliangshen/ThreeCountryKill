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

/** 各基本牌/锦囊牌的效果说明（客户端悬停提示用） */
export const CARD_DESC: Record<CardType, string> = {
  // 基本牌
  sha: '出牌阶段，对攻击范围内的一名角色使用。目标需打出【闪】，否则受到 1 点伤害。每回合限一次。',
  shan: '当你成为【杀】的目标时，可打出【闪】抵消之。',
  tao: '出牌阶段，对自己使用，回复 1 点体力（不能超过体力上限）。也可在角色濒死时使用，令其回复 1 点体力。',
  jiu: '出牌阶段，对自己使用，本回合下一张【杀】的伤害 +1。也可在濒死时使用，令其回复 1 点体力（每回合限一次）。',
  // 装备牌（具体牌名效果另见 EQUIP_DESC）
  weapon: '装备到武器栏。武器决定你的攻击范围。',
  armor: '装备到防具栏。防具可在你受到攻击时提供保护。',
  plusMount: '装备到防御马栏（+1马）。其他角色与你的距离 +1。',
  minusMount: '装备到进攻马栏（−1马）。你与其他角色的距离 −1。',
  // 即时锦囊
  juedou: '指定一名其他角色，与其轮流打出【杀】，先不出【杀】的一方受到 1 点伤害。',
  nanman: '其他所有角色依次需打出【杀】，否则受到 1 点伤害。',
  wanjian: '其他所有角色依次需打出【闪】，否则受到 1 点伤害。',
  jiedao: '指定一名装备了武器的角色，令其对你指定的另一名角色使用【杀】，否则你获得其武器。',
  guohe: '弃置一名其他角色（不限距离）区域内的一张牌（手牌/装备/判定牌）。',
  shunshou: '获得距离 1 以内的一名其他角色区域内的一张牌（手牌/装备/判定牌）。',
  wuzhong: '摸两张牌。',
  wuxie: '在锦囊牌生效前打出，抵消其对一名角色的效果。可被另一张【无懈可击】抵消。',
  huogong: '指定一名有手牌的角色，其展示一张手牌。你弃置一张与之花色相同的手牌，则对其造成 1 点火焰伤害。',
  taoyuan: '所有角色各回复 1 点体力（满体力的角色不回复）。',
  // 延时锦囊
  lebu: '置于一名其他角色（距离≤1）的判定区。其判定阶段判定：若不为红桃，跳过其出牌阶段。',
  shandian: '置于自己的判定区。判定阶段判定：若为黑桃2-9，受到 3 点雷电伤害；否则移动到下家的判定区。',
  bingliang: '置于一名其他角色（距离≤1）的判定区。其判定阶段判定：若不为梅花，跳过其摸牌阶段。',
};

/** 各装备牌的具体效果说明（客户端悬停提示用）。键为 equipName。 */
export const EQUIP_DESC: Record<string, string> = {
  // ——— 武器 ———
  zhuge: '攻击范围 1。出牌阶段，你可以使用任意数量的【杀】。',
  qinggang: '攻击范围 2。锁定技，当你使用【杀】指定一名角色为目标后，无视其防具。',
  guding: '攻击范围 2。锁定技，当你使用【杀】对目标角色造成伤害时，若其没有手牌，此伤害 +1。',
  qixing:
    '攻击范围 2。锁定技，当此牌进入你的装备区时，你弃置你判定区和装备区里所有的其他牌。',
  cixiong:
    '攻击范围 2。当你使用【杀】指定一名异性角色为目标后，你可以令其选择一项：1.弃置一张手牌；2.令你摸一张牌。',
  qinglong:
    '攻击范围 3。当你使用的【杀】被【闪】抵消时，你可以对相同的目标再使用一张【杀】。',
  zhangba: '攻击范围 3。你可以将两张手牌当【杀】使用或打出。',
  guanshi:
    '攻击范围 3。当你使用的【杀】被【闪】抵消时，你可以弃置两张牌，令此【杀】依然对其造成伤害。',
  fangtian:
    '攻击范围 4。你使用的【杀】若是你最后的手牌，你可以额外选择至多两个目标。',
  zhuque: '攻击范围 4。你可以将你的一张普通【杀】当作具火焰伤害的【杀】来使用。',
  // ——— 防具 ———
  bagua: '当你需要使用或打出【闪】时，你可以进行判定：若结果为红色，视为你使用或打出了一张【闪】。',
  renwang: '锁定技，黑色的【杀】对你无效。',
  tengjia:
    '锁定技，南蛮入侵、万箭齐发和普通【杀】对你无效；你受到火焰伤害时，此伤害 +1。',
  // ——— 坐骑 ———
  dilu: '其他角色与你的距离 +1。',
  jueying: '其他角色与你的距离 +1。',
  zhuafei: '其他角色与你的距离 +1。',
  chitu: '你与其他角色的距离 −1。',
  zizong: '你与其他角色的距离 −1。',
  dawanma: '你与其他角色的距离 −1。',
};

/** 尚未实现特效的装备（提示中如实标注，避免误导） */
const EQUIP_NOT_IMPLEMENTED: ReadonlySet<string> = new Set([
  'cixiong',
  'qinglong',
  'zhangba',
  'guanshi',
  'fangtian',
  'zhuque',
]);

/** 取一张牌的效果说明（装备牌按具体牌名取，其余按类型取） */
export function cardDescription(card: Card): string {
  if (card.equipName) {
    const desc = EQUIP_DESC[card.equipName];
    if (desc) {
      const note = EQUIP_NOT_IMPLEMENTED.has(card.equipName)
        ? '\n（本版本尚未实现该特效，目前仅攻击范围生效）'
        : '';
      return desc + note;
    }
  }
  return CARD_DESC[card.type] ?? '';
}

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

/**
 * 牌的显示名（不含花色点数）。
 * 装备牌显示具体牌名（如「诸葛连弩」），不显示槽位名（如「武器」）。
 */
export function cardShortName(card: Card): string {
  if (card.equipName && EQUIP_NAME[card.equipName]) return EQUIP_NAME[card.equipName];
  if (card.type === 'sha' && card.attribute === 'fire') return '火杀';
  if (card.type === 'sha' && card.attribute === 'thunder') return '雷杀';
  return CARD_TYPE_NAME[card.type] ?? card.type;
}
