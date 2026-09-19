// 牌的基础类型定义 —— 前后端共享（引擎、服务端、客户端都用这一份）

import type { GameMode } from './views';

// —— 基本牌 ——
export type BasicCardType = 'sha' | 'shan' | 'tao' | 'jiu';
// —— 装备牌（按槽位分类）——
export type EquipSlot = 'weapon' | 'armor' | 'plusMount' | 'minusMount' | 'treasure';
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
  | 'wuxieguo' // 无懈可击·国（势备篇：按「势力」范围抵消）
  | 'huogong' // 火攻
  | 'taoyuan' // 桃园结义
  | 'tiesuo' // 铁索连环
  | 'tiaohu' // 调虎离山
  | 'shuiyan' // 水淹七军
  | 'lutong' // 勠力同心
  | 'xietianzi' // 挟天子以令诸侯
  | 'huoshao' // 火烧连营
  | 'chiling' // 敕令
  | 'lianjun' // 联军盛宴
  | 'yuanjiao' // 远交近攻
  | 'yiyi' // 以逸待劳
  | 'wugu' // 五谷丰登
  | 'zhibi'; // 知己知彼
// —— 延时锦囊 ——
export type DelayedTrickType = 'lebu' | 'shandian' | 'bingliang';

export type CardType = BasicCardType | EquipSlot | TrickType | DelayedTrickType;

/**
 * 可以**重铸**的牌：出牌阶段把这张牌置入弃牌堆，然后摸一张牌。
 *
 * 「重铸」不是使用——黄月英把【铁索连环】重铸时不会发动【集智】，
 * 也不会进任何「使用牌」的钩子。见 docs/guozhan-card-notes.md。
 */
export const RECASTABLE_CARD_TYPES: ReadonlySet<CardType> = new Set<CardType>(['tiesuo', 'zhibi']);

/**
 * 「伤害牌」：**使用之后可能造成伤害**的牌。
 *
 * 用于君袁绍·授锋（「当你于其出牌阶段使用首张伤害牌结算结束后」，原文见
 * docs/guozhan-roster.md §5.60）。本引擎里符合这个描述的只有下面这些：
 *   【杀】（含火杀/雷杀，属性只是伤害的属性）、【决斗】（拼杀，输的一方吃伤害）、
 *   【南蛮入侵】【万箭齐发】（不响应就吃伤害）、【火攻】（火焰伤害）、
 *   【水淹七军】（雷电伤害）【火烧连营】（火焰伤害）。
 *
 * ⚠️ 明确**不算**的：延时锦囊【闪电】（它确实会造成伤害，但那是判定阶段结算的，
 * 不是「于其出牌阶段使用并结算完」——本仓库的授锋在「这张牌结算结束」那一刻触发，
 * 闪电永远等不到）；【借刀杀人】（它本身不造成伤害，只是让别人去用【杀】）。
 * ⚠️ 待核对：官方对「伤害牌」的完整定义（势备篇/君临天下各包是否还有算进来的锦囊）
 *   还没核到，这里按本引擎实有卡牌的伤害能力枚举。
 */
export const DAMAGE_CARD_TYPES: ReadonlySet<CardType> = new Set<CardType>([
  'sha',
  'juedou',
  'nanman',
  'wanjian',
  'huogong',
  'shuiyan',
  'huoshao',
]);

/**
 * 「势力锦囊牌」——《三国杀国战·**不臣篇**》加入的一类特殊**非延时锦囊**（用户核对后给的官方口径）：
 *
 * - 牌本身有基础效果，同时**魏/蜀/吴/群各有一张**，并对**对应势力**产生强化效果；
 * - 它们仍然是普通（非延时）锦囊，按普通锦囊的规则使用与结算；「势力锦囊」是叠加在上面的
 *   特殊分类，也是**唯一**会被特殊规则单独排除的类别（例如君孙权·据江「装备牌、延时锦囊牌和
 *   势力锦囊牌除外」）；
 * - 「魏势力锦囊」**不等于只有魏国能用**：吴国玩家摸到【号令天下】照样能正常使用，
 *   牌里写给魏势力角色的那部分按势力条件判断；四张都是这个写法。
 * - 另一条特殊规则：这类牌**使用或弃置后不进弃牌堆循环，而是移出游戏**（规则集里进入
 *   「府库」这类特殊区域）。
 *
 * 四张分别是：魏【号令天下】/ 蜀【克复中原】/ 吴【固国安邦】/ 群【文和乱武】。
 *
 * ⚠️ **这四张还没进本仓库的牌堆**（属不臣篇，效果文本用户只给了转述版，数值不全），
 *    所以这份名单现在只是**登记**：等实装那四张牌时，把它们的 `Card.type` 填进来即可
 *    （以及给它们加上「使用/弃置后移出游戏」的那条规则）。
 * ⚠️ 本仓库先前的写法（把挟天子以令诸侯 / 联军盛宴 / 勠力同心当成势力锦囊）是**错的**，
 *    只是按「用不用得出来取决于势力」猜的；用户已给出官方定义，本轮订正。
 */
export const FACTION_TRICK_TYPES: ReadonlySet<string> = new Set<string>([
  // 不臣篇四张（尚未实装，先把 id 占好）
  'haolingtianxia', // 魏·号令天下
  'kefuzhongyuan', // 蜀·克复中原
  'guoanjianbang', // 吴·固国安邦
  'wenheluanwu', // 群·文和乱武
]);

export function isRecastable(card: Card): boolean {
  return RECASTABLE_CARD_TYPES.has(card.type);
}

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
  /**
   * 「离开装备区后销毁之」的牌（君主将的专属装备，官方文本如此）。
   * 销毁 = 移出游戏而不是进弃牌堆，见 model.toDiscard。
   */
  destroyOnLeave?: boolean;
  /**
   * 势备篇的「连横」标记：带这个标记的牌多一种用法——
   * 出牌阶段把它**作为手牌**交给一名势力不同或未确定势力的角色；
   * 交给势力不同的角色时你摸一张牌（交给未确定势力的则不摸）。
   * 已装备的牌不能连横（必须还在手牌里）。
   */
  lianheng?: boolean;
  /**
   * 【木牛流马】下面**扣置**的牌（官方叫「辎」）。
   *
   * 挂在**装备牌对象自己**身上，而不是挂在玩家身上——因为这张装备牌会连人带辎
   * 一起被移动到别的角色装备区；被弃置时这些牌要一同进弃牌堆（见 model.toDiscard）。
   * 持有者可以把它们「如手牌般使用或打出」。
   */
  cargo?: Card[];
  /**
   * 这张牌现在是**武将牌上的「田」**（邓艾·屯田）。放在武将牌上时置 true，
   * 离开时清掉——急袭的转化（「一张『田』当【顺手牵羊】使用」）靠它认牌。
   */
  tian?: boolean;
  /**
   * 扣置牌的张数——**给非持有者看的**。快照里别人的木牛流马只带这个数，
   * 不带内容（扣置是暗信息）。持有者自己拿到的是完整的 `cargo`。
   */
  cargoCount?: number;
  /**
   * 这是**虚拟牌**：由别的牌「当」出来的，牌面没有实体（丈八蛇矛的两张手牌当【杀】）。
   * 它的花色点数不可信，颜色看 `color`。
   */
  virtual?: boolean;
  /**
   * 虚拟牌的**颜色**。实体牌用 `cardColor(card)` 由花色推，虚拟牌直接读这个字段。
   *
   * 丈八蛇矛的口诀是「两红为红，两黑为黑，黑红无色」——**一红一黑是【无色】杀**，
   * 而【仁王盾】只挡黑色杀，所以无色杀对仁王盾有效。这条必须照做，不能一律当无色。
   */
  color?: 'red' | 'black' | null;
  /**
   * 这张（虚拟）牌是用哪些**实体牌**凑出来的。计价时按它们收，
   * 而不是收虚拟牌本身——见 engine 的 `consumeCard`。
   */
  materials?: Card[];
  /**
   * 虚拟牌的**来源标记**：哪个技能造出来的。目前只有严白虎·寄篱（`'jili'`）。
   * 它是一道判据——「由技能新造的无实体牌」，任何「把牌当实体牌处理」的逻辑
   * （进弃牌堆、被获得、被计成某张实体牌）都该先看它。
   */
  generatedBy?: string;
}

export const SUIT_COLOR: Record<Suit, 'red' | 'black'> = {
  heart: 'red',
  diamond: 'red',
  spade: 'black',
  club: 'black',
};

/**
 * 一张牌的颜色：实体牌看花色，虚拟牌看它自己的 `color`（可能为 null＝无色）。
 *
 * 这是**唯一**该用来判断颜色的入口——`isRed` 只回答「是不是红色」，
 * 而无色既不是红也不是黑，用它做 `!isRed(card)` 这种判断会把无色当成黑色。
 */
export function cardColor(card: Card): 'red' | 'black' | null {
  if (card.virtual) return card.color ?? null;
  return SUIT_COLOR[card.suit];
}

/**
 * 按丈八蛇矛的规则算两张牌凑出来的【杀】是什么颜色：
 * 两红为红、两黑为黑、一红一黑为**无色**。
 */
export function zhangbaShaColor(cards: Card[]): 'red' | 'black' | null {
  const colors = cards.map((c) => SUIT_COLOR[c.suit]);
  if (colors.every((c) => c === 'red')) return 'red';
  if (colors.every((c) => c === 'black')) return 'black';
  return null; // 红黑混杂 → 无色
}

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
  treasure: '宝物',
  // 即时锦囊
  juedou: '决斗',
  nanman: '南蛮入侵',
  wanjian: '万箭齐发',
  jiedao: '借刀杀人',
  guohe: '过河拆桥',
  shunshou: '顺手牵羊',
  wuzhong: '无中生有',
  wuxie: '无懈可击',
  wuxieguo: '无懈可击·国',
  huogong: '火攻',
  taoyuan: '桃园结义',
  tiesuo: '铁索连环',
  tiaohu: '调虎离山',
  shuiyan: '水淹七军',
  lutong: '勠力同心',
  xietianzi: '挟天子以令诸侯',
  huoshao: '火烧连营',
  chiling: '敕令',
  lianjun: '联军盛宴',
  yuanjiao: '远交近攻',
  yiyi: '以逸待劳',
  wugu: '五谷丰登',
  zhibi: '知己知彼',
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
  qilin: '麒麟弓',
  wuliu: '吴六剑',
  sanjian: '三尖两刃刀',
  // 君主将专属装备（只能通过【君威】从游戏外取得，离开装备区即销毁）
  // ⚠️ 仍缺【定澜夜明珠】（君孙权）的完整技能表；它的效果文本已核到一半
  //    （移动版公告：【定澜夜明珠】「锁定技，你每回合首次弃置牌后，摸一张牌。」），
  //    但君孙权另外两条技能没核到，所以整只武将还没做。
  feilong: '飞龙夺凤',
  liulong: '六龙骖驾',
  mengjun: '盟军大纛',
  dinglan: '定澜夜明珠',
  // 防具
  bagua: '八卦阵',
  renwang: '仁王盾',
  tengjia: '藤甲',
  bailong: '白银狮子',
  // +1马（防御马）
  dilu: '的卢',
  jueying: '绝影',
  zhuafei: '爪黄飞电',
  // −1马（进攻马）
  chitu: '赤兔',
  zizong: '紫骍',
  dawanma: '大宛马',
  // 宝物（势备篇）
  yuxi: '玉玺',
  muniu: '木牛流马',
};

export const SUIT_NAME: Record<Suit, string> = {
  spade: '黑桃',
  heart: '红桃',
  club: '梅花',
  diamond: '方块',
};

/** 花色的符号形式（卡面左上角用） */
export const SUIT_SYMBOL: Record<Suit, string> = {
  spade: '♠',
  heart: '♥',
  club: '♣',
  diamond: '♦',
};

/**
 * 会造成**火焰伤害**的锦囊（明光铠要按这个取消目标）。
 * 现在只有【火攻】；势备篇的【火烧连营】在它实现时加进来。
 */
export const FIRE_TRICKS: ReadonlySet<CardType> = new Set<CardType>(['huogong', 'huoshao']);

/**
 * 【无懈可击】与【无懈可击·国】——两者都是「响应锦囊时打出」的牌，
 * 都不能在出牌阶段主动使用，也都能被【看破】这类转化技转化出来。
 * 区别只在抵消的**范围**：普通无懈抵消整张（本版本是整张牌的简化口径），
 * 【无懈可击·国】抵消「一名角色 + 与其势力相同的所有尚未结算完毕的角色」。
 */
export function isWuxieLike(card: Card): boolean {
  return card.type === 'wuxie' || card.type === 'wuxieguo';
}

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
  treasure: '装备到宝物栏（第 5 个装备槽）。同一个宝物栏只能有一张牌。',
  // 即时锦囊
  juedou: '指定一名其他角色，与其轮流打出【杀】，先不出【杀】的一方受到 1 点伤害。',
  nanman: '其他所有角色依次需打出【杀】，否则受到 1 点伤害。',
  wanjian: '其他所有角色依次需打出【闪】，否则受到 1 点伤害。',
  jiedao: '指定一名装备了武器的角色，令其对你指定的另一名角色使用【杀】，否则你获得其武器。',
  guohe: '弃置一名其他角色（不限距离）区域内的一张牌（手牌/装备/判定牌）。',
  shunshou: '获得距离 1 以内的一名其他角色区域内的一张牌（手牌/装备/判定牌）。',
  wuzhong: '摸两张牌。',
  wuxie: '在锦囊牌生效前打出，抵消其对一名角色的效果。可被另一张【无懈可击】抵消。',
  huogong:
    '指定一名有手牌的角色，其展示一张手牌。你弃置一张与之花色相同的手牌，则对其造成 1 点火焰伤害。',
  taoyuan: '所有角色各回复 1 点体力（满体力的角色不回复）。',
  tiesuo:
    '对一至两名角色使用：横置或重置其武将牌（已横置的重置，未横置的横置）。处于连环状态的角色受到属性伤害时，其余连环角色依次受到同来源、同程度、同属性的伤害，然后全部重置。可重铸。',
  huoshao:
    '出牌阶段，对你的下家和与其处于同一队列的所有角色使用。每名角色受到你造成的 1 点火焰伤害。',
  xietianzi:
    '出牌阶段，若你是大势力角色，对你使用。结束你的出牌阶段，然后若你于弃牌阶段弃置一张牌，则于此回合结束后，你进行一个额外的回合。',
  lutong:
    '出牌阶段，对所有的大势力角色或所有的小势力角色使用。若目标角色不处于连环状态，则其横置；若目标角色处于连环状态，则其摸一张牌。',
  chiling:
    '出牌阶段，对所有没有势力的角色使用。目标角色各选择一项：1.明置一张武将牌，摸一张牌；2.弃置一张装备牌；3.失去 1 点体力。',
  lianjun:
    '出牌阶段，你选择一个其他势力，对你和该势力的所有角色使用。你选择一项：1.回复 X 点体力；2.摸 X 张牌（X 为该势力的存活角色数）。然后该势力的其他目标角色各摸一张牌且重置其武将牌。',
  wuxieguo:
    '在锦囊牌生效前，指定该牌的一名目标角色：抵消此牌对该角色及与其势力相同的所有尚未结算完毕的角色产生的效果。若该角色尚未确定势力，则抵消无效（牌仍然被使用）。',
  tiaohu:
    '出牌阶段，对一至两名其他角色使用。直到回合结束为止，目标角色不计入距离和座次的计算，不能使用任何牌且不能成为任何牌的目标。你使用此牌后摸一张牌。',
  shuiyan:
    '出牌阶段，对一名装备区里有牌的其他角色使用。目标角色选择一项：1.弃置装备区里的所有牌；2.你对其造成 1 点雷电伤害。',
  yuanjiao: '指定一名与你势力不同、且已明置武将牌的角色：该角色摸一张牌，然后你摸三张牌。',
  yiyi: '你与所有与你势力相同的其他角色依次各摸两张牌，然后弃置两张牌。',
  wugu: '对所有角色使用：亮出牌堆顶的等量牌，然后每名角色依次获得其中一张。',
  zhibi: '指定一名其他角色，观看其手牌，或观看其一张暗置的武将牌。可重铸。',
  // 延时锦囊
  lebu: '置于一名其他角色（距离≤1）的判定区。其判定阶段判定：若不为红桃，跳过其出牌阶段。',
  shandian:
    '置于自己的判定区。判定阶段判定：若为黑桃2-9，受到 3 点雷电伤害；否则移动到下家的判定区。',
  bingliang: '置于一名其他角色（距离≤1）的判定区。其判定阶段判定：若不为梅花，跳过其摸牌阶段。',
};

/** 各装备牌的具体效果说明（客户端悬停提示用）。键为 equipName。 */
export const EQUIP_DESC: Record<string, string> = {
  // ——— 武器 ———
  zhuge: '攻击范围 1。出牌阶段，你可以使用任意数量的【杀】。',
  qinggang: '攻击范围 2。锁定技，当你使用【杀】指定一名角色为目标后，无视其防具。',
  guding: '攻击范围 2。锁定技，当你使用【杀】对目标角色造成伤害时，若其没有手牌，此伤害 +1。',
  hanbing:
    '攻击范围 2。当你使用【杀】对目标角色造成伤害时，你可以防止此伤害，改为依次弃置其两张牌。',
  qixing: '攻击范围 2。锁定技，当此牌进入你的装备区时，你弃置你判定区和装备区里所有的其他牌。',
  cixiong:
    '攻击范围 2。当你使用【杀】指定一名异性角色为目标后，你可以令其选择一项：1.弃置一张手牌；2.令你摸一张牌。',
  qinglong: '攻击范围 3。当你使用的【杀】被【闪】抵消时，你可以对相同的目标再使用一张【杀】。',
  zhangba: '攻击范围 3。你可以将两张手牌当【杀】使用或打出。',
  guanshi:
    '攻击范围 3。当你使用的【杀】被【闪】抵消时，你可以弃置两张牌，令此【杀】依然对其造成伤害。',
  fangtian: '攻击范围 4。你使用的【杀】若是你最后的手牌，你可以额外选择至多两个目标。',
  zhuque: '攻击范围 4。你可以将你的一张普通【杀】当作具火焰伤害的【杀】来使用。',
  // ——— 武器（国战牌堆独有）———
  qilin: '攻击范围 5。当你使用【杀】对目标角色造成伤害时，你可以弃置其装备区里的一张坐骑牌。',
  wuliu: '攻击范围 2。锁定技，与你势力相同的其他角色攻击范围 +1。',
  sanjian:
    '攻击范围 3。当你使用【杀】对目标角色造成伤害后，你可以弃置一张手牌，然后对该角色距离为 1 的一名其他角色造成 1 点伤害。',
  // ——— 防具 ———
  bagua: '当你需要使用或打出【闪】时，你可以进行判定：若结果为红色，视为你使用或打出了一张【闪】。',
  renwang: '锁定技，黑色的【杀】对你无效。',
  tengjia: '锁定技，南蛮入侵、万箭齐发和普通【杀】对你无效；你受到火焰伤害时，此伤害 +1。',
  bailong:
    '锁定技，当你受到伤害时，若此伤害大于 1 点，防止多余的伤害。当你失去装备区里的【白银狮子】后，你回复 1 点体力。',
  // ——— 宝物与势备篇防具 ———
  huxinjing:
    '当你受到伤害时，若伤害值大于或等于你的体力值，你可以将【护心镜】置入弃牌堆，然后防止此伤害。带连横标记。（已知：闪电的雷电伤害暂不触发它）',
  mingguang:
    '锁定技，当你成为【火攻】【火烧连营】或火【杀】的目标时，取消之；若你是小势力角色，你不会被横置。',
  yuxi: '锁定技，若你有明置的武将牌：摸牌阶段你额外摸一张牌；出牌阶段开始时，你视为使用一张【知己知彼】。（OL 2026 版口径：不含「你所属势力成为唯一的大势力」那一条）',
  muniu:
    '出牌阶段限一次，你可以将一张手牌扣置于【木牛流马】下，然后将此装备牌移动到一名其他角色的装备区；你可以将扣置的牌如手牌般使用或打出。',
  // ——— 坐骑 ———
  dilu: '其他角色与你的距离 +1。',
  jueying: '其他角色与你的距离 +1。',
  zhuafei: '其他角色与你的距离 +1。',
  chitu: '你与其他角色的距离 −1。',
  zizong: '你与其他角色的距离 −1。',
  dawanma: '你与其他角色的距离 −1。',
};

/**
 * **国战模式下另有一套文本**的装备（同名牌在国战是另一个效果）。
 * 目前只有【方天画戟】：军争版是「最后一张手牌可额外指定两个目标」，
 * 国战版是「指定任意名势力各不相同的角色（未确定势力的不限），一人闪则对其余无效」。
 * 取说明用 `cardDescription(card, mode)`，别直接用 EQUIP_DESC。
 */
export const EQUIP_DESC_GUOZHAN: Record<string, string> = {
  fangtian:
    '攻击范围 4。你使用的【杀】可以指定任意名势力各不相同的角色及未确定势力的角色为目标。当此【杀】被一名目标角色使用【闪】抵消时，此【杀】对其他目标角色无效。',
};

/**
 * 尚未实现特效的装备（提示中如实标注，避免误导）。
 *
 * **全部装备、两个模式的方天画戟都已实现**：诸葛连弩、青釭剑、七星宝刀、古锭刀、寒冰剑、
 * 麒麟弓、吴六剑、三尖两刃刀、八卦阵、仁王盾、藤甲、白银狮子、贯石斧、青龙偃月刀、
 * 雌雄双股剑、丈八蛇矛、明光铠、护心镜、玉玺、木牛流马、方天画戟（国战版 / 军争版两套），
 * 以及马术类的距离修正。
 *
 * ⚠️ 方天画戟是**同名两张牌、两个模式两套效果**（最典型的一例）：国战版是「指定任意名
 * 势力各不相同的角色，一人闪则其余无效」，军争版是「最后一张手牌可额外指定两个目标」。
 * 引擎按模式分（见 `fangtianRule`），文本按模式取（见 `EQUIP_DESC_GUOZHAN`）。
 */
const EQUIP_NOT_IMPLEMENTED: ReadonlySet<string> = new Set<string>();

/** 国战模式下仍未实现特效的装备：**没有**了（与上方一致，留一个按模式取的空表） */
const EQUIP_NOT_IMPLEMENTED_GUOZHAN: ReadonlySet<string> = new Set<string>();

/** 取一张牌的效果说明（装备牌按具体牌名取，其余按类型取） */
export function cardDescription(card: Card, mode?: GameMode): string {
  if (card.equipName) {
    const desc =
      (mode === 'guozhan' ? EQUIP_DESC_GUOZHAN[card.equipName] : undefined) ??
      EQUIP_DESC[card.equipName];
    if (desc) {
      const notImplemented =
        mode === 'guozhan'
          ? EQUIP_NOT_IMPLEMENTED_GUOZHAN.has(card.equipName)
          : EQUIP_NOT_IMPLEMENTED.has(card.equipName);
      const note = notImplemented
        ? card.range === undefined
          ? '\n（本版本尚未实现该特效，目前是一张无效果的装备牌）'
          : '\n（本版本尚未实现该特效，目前仅攻击范围生效）'
        : '';
      return desc + note;
    }
  }
  return CARD_DESC[card.type] ?? '';
}

// —— 牌分类谓词 ——
const BASIC_SET: ReadonlySet<BasicCardType> = new Set(['sha', 'shan', 'tao', 'jiu']);
const EQUIP_SET: ReadonlySet<EquipSlot> = new Set([
  'weapon',
  'armor',
  'plusMount',
  'minusMount',
  'treasure',
]);
const TRICK_SET: ReadonlySet<TrickType> = new Set([
  'juedou',
  'nanman',
  'wanjian',
  'jiedao',
  'guohe',
  'shunshou',
  'wuzhong',
  'wuxie',
  'huogong',
  'taoyuan',
  'tiesuo',
  'yuanjiao',
  'yiyi',
  'wugu',
  'zhibi',
  'tiaohu',
  'shuiyan',
  'lutong',
  'xietianzi',
  'huoshao',
  'chiling',
  'lianjun',
  'wuxieguo',
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

/** 点数的显示形式：1→A、11→J、12→Q、13→K，其余原样 */
export function rankLabel(rank: number): string {
  if (rank === 1) return 'A';
  if (rank === 11) return 'J';
  if (rank === 12) return 'Q';
  if (rank === 13) return 'K';
  return String(rank);
}

export function cardLabel(card: Card): string {
  // 虚拟牌没有实体牌面，只报牌名（【杀】）
  if (card.virtual) return CARD_TYPE_NAME[card.type] ?? card.type;
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
  if (card.virtual) return CARD_TYPE_NAME[card.type] ?? card.type;
  if (card.equipName && EQUIP_NAME[card.equipName]) return EQUIP_NAME[card.equipName];
  if (card.type === 'sha' && card.attribute === 'fire') return '火杀';
  if (card.type === 'sha' && card.attribute === 'thunder') return '雷杀';
  return CARD_TYPE_NAME[card.type] ?? card.type;
}
