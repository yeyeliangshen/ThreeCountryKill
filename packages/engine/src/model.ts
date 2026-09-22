import { CARD_TYPE_NAME, EQUIP_NAME, FACTION_TRICK_TYPES } from '@sgs/protocol';
import type {
  GuozhanExtensions,
  ZonePickLayout,
  Card,
  CardType,
  DamageAttribute,
  PindianView,
  PublicPoolView,
  Faction,
  GameMode,
  LogEntry,
  MarkerId,
  Phase,
  RoleId,
  Suit,
} from '@sgs/protocol';

// —— 装备区 ——
/**
 * 装备区槽位：武器 / 防具 / +1马(防御马) / −1马(进攻马) / **宝物**（势备篇新增的第 5 槽）。
 *
 * ⚠️ 加槽位时不要只改这里——槽位名同时是牌的 `type`（见 protocol 的 EquipSlot），
 * 而引擎里还有一批按槽位写死的字面量数组。统一的槽位清单是 heroes.ts 的 `EQUIP_SLOTS`，
 * 新代码一律用它，别自己写 `['weapon','armor',...]`。
 */
export interface Equipment {
  weapon: Card | null;
  armor: Card | null;
  plusMount: Card | null;
  minusMount: Card | null;
  /** 宝物（玉玺 / 木牛流马）。势备篇的牌；与其它槽位一样只能有一张。 */
  treasure: Card | null;
}

export function emptyEquipment(): Equipment {
  return { weapon: null, armor: null, plusMount: null, minusMount: null, treasure: null };
}

// —— 国战标记 ——
/** 持有的标记及数量（只记 > 0 的，没有的键即 0） */
export type Markers = Partial<Record<MarkerId, number>>;

export function emptyMarkers(): Markers {
  return {};
}

// —— 玩家状态 ——
/**
 * 一枚国战标记**这一回合是怎么用掉的**——【章武】要「复现对应的使用效果」，所以光记标记
 * 种类不够（用户核对后的口径）：【阴阳鱼】出牌阶段用是「摸一张」、弃牌阶段用是「本回合
 * 手牌上限 +2」，复现时要照原样执行（哪怕在结束阶段「上限 +2」已经没有什么实际作用）。
 *
 * - `draw`：摸牌（阴阳鱼摸 1 / 珠联璧合摸 2）
 * - `handLimit`：阴阳鱼在弃牌阶段那条——本回合手牌上限 +2
 * - `heal`：珠联璧合的另一条——回复 1 点体力（即「当作一次【桃】的效果」）
 * - `view`：先驱——手牌补至四张并观看目标未明置的副将
 */
export type MarkerUsage = 'draw' | 'handLimit' | 'heal' | 'view';

export interface PlayerFlags {
  /** 本回合已出杀数 */
  shaCountThisTurn: number;
  /** 本回合酒buff：下一张杀伤害+1 */
  jiuActive: boolean;
  /** 本回合已用酒救次数（限1次/回合） */
  taoSaveCountThisTurn: number;
  /** 本回合已用主动技能标记 */
  skillUsedThisTurn: Record<string, boolean>;
  /**
   * 技能自己用的每回合计数（仁德记「本阶段给出几张」、苦肉记次数…）。
   * 随 emptyFlags() 每回合清零。键名建议用 `<技能id>_<含义>`。
   */
  skillNumbers: Record<string, number>;
  /**
   * 颜良文丑·双雄：本回合**判定牌的颜色**。本回合可以把颜色**不同**的手牌当【决斗】使用。
   * 随 emptyFlags 每回合清。
   */
  shuangxiongColor: 'red' | 'black' | null;
  /**
   * 本回合「你至某人的距离视为 1」（丁奉·奋迅）：存那个人的座位号。
   * 由 distance() 读；随回合结束清（见 engine 的 clearTurnScoped）。
   */
  distanceToOneThisTurn: string | null;
  /**
   * 本回合**自己的出牌阶段**里用过的牌（吕蒙·克己看颜色有几种、谋断看花色/类别有几种）。
   *
   * 只记摘要不记牌对象——牌用完就进弃牌堆了，留着引用没有意义。
   * 由 engine.ts 的 markCardUsed() 在 useCard 钩子处统一登记，
   * 所以新增出牌路径不需要各自加代码。
   */
  usedCardsInPlayPhase: { suit: Suit; color: 'red' | 'black'; kind: 'basic' | 'trick' | 'equip' }[];
  /** 跳过出牌阶段（乐不思蜀） */
  skipPlay: boolean;
  /** 跳过摸牌阶段（兵粮寸断 / 夏侯渊·神速 / 张郃·巧变） */
  skipDraw: boolean;
  /** 跳过弃牌阶段（张郃·巧变） */
  skipDiscard: boolean;
  /**
   * 崔琰毛玠·征辟①：本回合你对其**使用牌无距离和次数限制**（存的是那个座位）。
   * 「直到回合结束**或其明置武将牌**」——后者用惰性判断：目标还有暗置武将牌时才有效。
   */
  distanceLimitlessToSeat: string | null;
  /**
   * 李傕郭汜·凶算：被点名「本回合结束时视为未发动」的限定技 id（在那一回合结束时清掉）。
   */
  limitedToReset: string[];
  /**
   * 沙摩柯·蒺藜：本回合**使用或打出**的牌数，以及「这张牌生效前你的攻击范围」。
   * 范围要取**牌生效之前**的值——官方 FAQ：本回合先出牌再装武器，那张牌不算；
   * 先装武器再出牌，才算（武器装上后范围就变了）。
   */
  cardsUsedOrPlayed: number;
  actionRangeSnapshot: number;
  /**
   * 卞夫人·约俭：本回合有没有**指定过其他势力（含未确定势力）的角色**为目标。
   * 由 markCardUsed 在 useCard 时登记（载荷里带了 targetIds），随回合清零。
   */
  targetedOtherFactionThisTurn: boolean;
  /**
   * 刘琦·屯江：本回合的**出牌阶段**里有没有**指定过其他角色**（不看势力，看人）为目标。
   * 由 markCardUsed 登记「有明确目标」的那些；AOE 那类目标由规则定死的牌
   * （南蛮/万箭/桃园/五谷…）在 startTrickResolution 里按「真正会影响谁」补登记。
   * 装备牌、对自己用的【桃】、无中生有都不会置位。随回合清零（emptyFlags）。
   */
  targetedOtherThisTurn: boolean;
  /**
   * 刘琦·问计：本回合被【问计】**标记的那张实体牌**的 id（null＝本回合没有）。
   *
   * ⚠️ 记的是**实体牌**不是牌名：交来的那张【杀】享受强化，手里同名的另一张按普通牌处理。
   * 该牌享受：无距离限制、无使用次数限制、其他角色不能响应（见 engine 里的三处判定）。
   */
  wenjiCardId: string | null;
  /**
   * 左慈·役鬼：「本回合内已以此法使用过哪些牌名」（按牌名限一次，回合开始清零）。
   */
  hunUsedNames: string[];
  /**
   * 吕范·典财：本**出牌阶段**你失去了几张牌（cardsLost 那个公共事件上累加，
   * 出牌阶段结束时清零）。「其他角色的出牌阶段结束时」按它跟体力值比。
   */
  lostCardsThisPhase: number;
  /**
   * 臧霸·横江：本回合对**哪个**当前回合角色用过（回合结束时看他在弃牌阶段弃没弃牌）。
   */
  hengjiangTarget: string | null;
  /**
   * 本回合有没有**造成过伤害**（蒋琬费利·生息：没造成过才能在弃牌阶段开始时摸两张）。
   * 由 damageDealt 钩子的入口登记，随回合重置。
   */
  dealtDamageThisTurn: boolean;
  /**
   * 「本次伤害已被防止」——`damageDealt` 钩子唯一的**取消通道**。
   *
   * 钩子只能设标记（没有返回值），所以 damageStep 在派发前清、派发后读，
   * 读到就整条伤害作废（不扣血、不跑伤害后钩子、不进濒死）。小乔·天香用它。
   */
  damagePrevented: boolean;
  /**
   * 「本次伤害减少几点」——`damageDealt` 钩子里除「防止」之外的**减伤通道**。
   *
   * 与 damagePrevented 同样：派发前清 0、派发后读。陆抗·恪守的「令此伤害-1」用它——
   * 它是**要付代价的可选**减伤，所以不能像名士/白银狮子那样在 finalizeDamage 里直接算。
   * 减到 0 即「不造成伤害」：不扣血、不跑伤害后钩子、也不进铁索蔓延。
   */
  damageReduce: number;
  /**
   * 本回合「使用【杀】的限制次数」的额外加成（陆抗·筑围 = 1）。
   * 与 handLimitBonus 一样是「本回合」语义，随回合重置。
   */
  shaLimitBonus: number;
  /**
   * 跳过判定阶段（夏侯渊·神速）。
   * 注意是**整个判定阶段跳过**，所以判定区的延时锦囊会原样留着、下回合再判。
   */
  skipJudgment: boolean;
  /** 本回合手牌上限的额外加成（阴阳鱼标记 = 2） */
  handLimitBonus: number;
  /**
   * 本回合摸牌阶段的张数增减（裸衣/突袭的「少摸一张」= -1）。
   * 最终张数 = max(0, 2 + extraDraw + drawCountDelta)。
   */
  drawCountDelta: number;
  /**
   * 本回合该玩家造成的伤害加成（裸衣 = 1）。
   * 由 Hero.dealtDamageBonus 读取，引擎在伤害结算处统一加。
   */
  damageBonusThisTurn: number;
  /** 本回合使用【杀】无距离限制（太史慈·天义拼点赢） */
  ignoreShaDistanceThisTurn: boolean;
  /**
   * 唐咨·兴棹第 4 档：已经结算过的「失去装备区里的牌」批次编号（equipLost 的 eventId）。
   * 同一批失去（一次弃多张/一次被拿走多张）只摸 1 张，靠它去重。随回合清零。
   */
  xingzhaoEquipEventId: number;
  /**
   * 曹节·约俭：「本回合手牌上限**等于**（视为）其体力上限」——是**覆盖**语义，
   * 所以记成开关、由 `handLimit()` 每次现算，而不是一次性加差值（否则体力一变就跟着错、还会与
   * 兴棹+4 之类叠加）。
   */
  handLimitSetToMaxHp: boolean;
  /**
   * SP司马昭·夙智②：本回合「使用锦囊牌无距离限制」（由夙智在**自己的回合**里打开，
   * 三次额度用完即关）。距离校验里与黄月英·奇才走同一个判据。
   */
  ignoresTrickDistanceThisTurn: boolean;
  /**
   * 非锁定技失效（新国战·铁骑那类）：本回合内该角色的非锁定技全部不起作用。
   * 由 afterTurnEnd 统一清掉（「直到回合结束」）。
   */
  nonLockedSkillsDisabled: boolean;
  /**
   * 「**每个出牌阶段**限 N 次」的技能计数（界钟会·排异是第一个用例）。
   * ⚠️ 与 `skillUsedThisTurn` 分开：那个是**回合**内限一次，这个是**阶段**内限次——
   * 额外出牌阶段会重新拿到额度（用户口径），所以随**出牌阶段开始**清零。
   */
  skillUsesThisPhase: Record<string, number>;
  /**
   * 本回合不能使用或打出手牌（军令「本回合不能使用或打出手牌」那一项）。
   * 比 skipPlay 窄：还能发动技能、结束阶段照常。
   */
  cannotPlayCardsThisTurn: boolean;
  /**
   * 马岱·潜袭：本回合不能使用或打出**这个颜色**的手牌（判定结果的颜色）。
   * 与 cannotPlayCardsThisTurn 同一套：回合结束时清掉。
   */
  cannotPlayColor: 'red' | 'black' | null;
  /** 本回合不能回复体力（军令「翻面且本回合不能回复体力」那一项） */
  cannotHealThisTurn: boolean;
  /** 国战：双将首次同时明置的奖励（阴阳鱼/珠联璧合）是否已结算过 */
  revealRewarded: boolean;
  /**
   * 李典·忘隙的待办：伤害把对方打进了濒死，得等**濒死结算完**才知道他活没活下来
   * （本引擎伤害层顺序是「伤害后钩子→濒死」，官方相反）。nearDeathResolved 时按 seatId 取出来处理。
   */
  wangxiPending: { seatId: string; left: number }[];
  /**
   * 凌统·旋略：「同一次失去装备」的事件编号——官方口径是一次失去只触发一次，
   * 而 equipLost 是**逐张**派发的（枭姬要每张都触发）。靠 payload.eventId 去重。
   */
  xuanlveEventId: number;
  /**
   * 严白虎·雉盗：本回合「只能指定他与你」的那名角色（null = 没有这个限制）。
   * 与 distanceToOneThisTurn 同源，随回合清空。
   */
  cardTargetOnlySeat: string | null;
  /**
   * 寄篱的「同一阶段内受到伤害的次数」：阶段用 `回合座位:阶段名` 作键，
   * 键变了就当这是本阶段的第 1 次。这样不必给每个阶段转换点都加重置代码。
   */
  damageCountKey: string;
  damageCount: number;
  /** 严白虎·雉盗：这个出牌阶段是否已经「第一次对其造成伤害」领过牌了 */
  zhidaoHitDone: boolean;
  /** 【飞龙夺凤】本回合已经触发过「首次使用【杀】造成伤害」（每回合重置） */
  feilongDoneThisTurn: boolean;
  /** 【定澜夜明珠】「每回合首次弃置牌后摸一张」用过就算数（每回合在 startTurn 重置） */
  dinglanDoneThisTurn: boolean;
  /**
   * 吴景·调归：「这次【调虎离山】用之前的队列人数」——技能发出锦囊时记下，
   * 结算完成后（afterUse）拿来比「是否**因此**形成队列」。null 表示没有待结算的调归。
   */
  queueSizeBeforeTrick: number | null;
  /**
   * 势备篇【挟天子以令诸侯】：「本回合结束后我要进行一个额外回合」的待办。
   * 还要配合 discardedInDiscardPhase 一起判——规则是「若你于弃牌阶段弃置一张牌」。
   */
  xietianziPending: boolean;
  /** 本回合的弃牌阶段是否真弃过牌（挟天子判这个；也顺便能查其他「弃牌阶段弃过牌」的技能） */
  discardedInDiscardPhase: boolean;
  /**
   * 势备篇【调虎离山】：本回合「不计入距离与座次的计算」。
   *
   * 生效点只有三个收口——nextAliveSeat / aliveSeatsFrom / baseDistance——
   * 所以回合推进、AOE 响应队列、无懈队列、濒死队列、五谷/以逸待劳全部自动跟随。
   * 由 afterTurnEnd 统一清掉（「直到回合结束」）。
   */
  removedFromSeating: boolean;
  /**
   * 势备篇【调虎离山】：本回合不能成为任何牌的目标。
   * 由 heroBlocksBeingTarget 统一读取（那 12 个调用点自动生效）。
   */
  cannotBeTargetThisTurn: boolean;
}

export function emptyFlags(): PlayerFlags {
  return {
    shaCountThisTurn: 0,
    jiuActive: false,
    taoSaveCountThisTurn: 0,
    skillUsedThisTurn: {},
    skillNumbers: {},
    usedCardsInPlayPhase: [],
    skipPlay: false,
    skipDraw: false,
    skipDiscard: false,
    damagePrevented: false,
    damageReduce: 0,
    shaLimitBonus: 0,
    dealtDamageThisTurn: false,
    hengjiangTarget: null,
    lostCardsThisPhase: 0,
    hunUsedNames: [],
    targetedOtherFactionThisTurn: false,
    targetedOtherThisTurn: false,
    wenjiCardId: null,
    distanceLimitlessToSeat: null,
    limitedToReset: [],
    cardsUsedOrPlayed: 0,
    actionRangeSnapshot: 0,
    skipJudgment: false,
    handLimitBonus: 0,
    drawCountDelta: 0,
    skillUsesThisPhase: {},
    damageBonusThisTurn: 0,
    ignoreShaDistanceThisTurn: false,
    nonLockedSkillsDisabled: false,
    handLimitSetToMaxHp: false,
    ignoresTrickDistanceThisTurn: false,
    xingzhaoEquipEventId: -1,
    cannotPlayCardsThisTurn: false,
    cannotPlayColor: null,
    cannotHealThisTurn: false,
    revealRewarded: false,
    wangxiPending: [],
    xuanlveEventId: -1,
    queueSizeBeforeTrick: null,
    cardTargetOnlySeat: null,
    damageCountKey: '',
    damageCount: 0,
    zhidaoHitDone: false,
    // 【飞龙夺凤】「每回合首次使用【杀】造成伤害后」用过就算数（每回合在 startTurn 重置）
    feilongDoneThisTurn: false,
    dinglanDoneThisTurn: false,
    xietianziPending: false,
    discardedInDiscardPhase: false,
    removedFromSeating: false,
    cannotBeTargetThisTurn: false,
    distanceToOneThisTurn: null,
    shuangxiongColor: null,
  };
}

export interface Player {
  seatId: string;
  name: string;
  heroId: string | null; // 选将阶段未定，为 null
  hp: number;
  maxHp: number;
  hand: Card[];
  equipment: Equipment;
  judgment: Card[]; // 延时锦囊判定区
  alive: boolean;
  flags: PlayerFlags;
  role: RoleId | null; // 身份（军争），选将阶段未定
  team: 0 | 1 | null; // 队伍（2v2），非 2v2 为 null
  deputyHeroId: string | null; // 副将（国战），非国战为 null
  heroRevealed: boolean; // 主将是否已亮将（国战用，非国战恒 true）
  deputyRevealed: boolean; // 副将是否已亮将（国战用，非国战恒 true）
  faction: Faction | null; // 阵营（国战用），非国战为 null
  markers: Markers; // 国战标记（先驱/阴阳鱼/珠联璧合），非国战恒为空
  /**
   * 武将牌是否翻面朝上（曹仁·据守、曹丕·放逐）。
   * 为 true 时该玩家跳过他的下一个回合，翻回正面。
   */
  flipped: boolean;
  /**
   * 是否处于「横置」状态（铁索连环）。
   * 横置的角色受到**属性伤害**时会重置，并让其他横置角色依次受到同样的伤害。
   */
  chained: boolean;
  /**
   * 限定技是否用过（每局一次，**不随回合重置**）。
   * 放在 Player 上而不是 flags 里，因为 emptyFlags() 每个回合都会清。
   */
  usedOncePerGame: Record<string, boolean>;
  /**
   * 国战「预亮」的技能名（暗置时声明的发动意图）。
   *
   * 国战规则：暗置的武将牌**没有任何技能**。要发动技能必须明置该武将牌。
   * 线上做法是「预亮」——暗置时先把某个技能标成想发动，等它的时机到来时
   * 引擎才会询问是否发动（确认则明置武将牌并执行）。所以：
   * - 暗置 + 未预亮 → 时机到了**不询问**，技能不生效；
   * - 暗置 + 已预亮 → 时机到了询问，确认后明置并发动；
   * - 已明置 → 照常（不再需要预亮，预亮集合里留下的项无副作用）。
   *
   * 键是**技能中文名**：钩子用 HookRegistration.skillId（也就是技能名），
   * 主动技的 name 与 hero.skills[].name 同一套命名。
   * 不随回合清空（是「我想用这个技能」的持续声明），也不公开给对手。
   */
  prelitSkills: string[];
  /**
   * 【荐才】（徐庶）私下「获知」的武将牌 id：**尚未登场**（还在 `state.heroPool` 里）
   * 且与徐庶已确定势力相同。只给本人看（快照里走 `knownHeroes` 那一条）。
   * ⚠️ 真源是 `state.heroPool`：某张牌真的登场后，它就不再算「尚未登场」——
   *    每次使用时与 heroPool 取交集，所以这里留着旧 id 也不会算错。
   */
  knownHeroIds: string[];

  /**
   * 周泰·不屈的「创」：濒死时从牌堆顶扣在武将牌上的牌（**置于武将牌上**，
   * 不属于手牌/装备/判定任何区域）。点数与已有的均不同才能挡死，所以要看点数。
   */
  wounds: Card[];
  /**
   * 被【断肠】（蔡文姬）点名的那张武将牌：**它失去所有技能**
   * （势力与性别不受影响）。存 heroId，永久生效（不随回合清）。
   */
  nullifiedHeroId: string | null;
  /**
   * 「千幻」：于吉·千幻放在**武将牌上**的牌（旧国战 1.x 的「千幻」标记牌）。
   */
  qianhuan: Card[];
  /**
   * 「魂」：左慈·役鬼扣在武将牌上的**武将牌**（存的是武将 id）。
   * 暗置 → 用的时候随机移去一张，并把那张武将牌亮出来（势力决定目标限制）。
   */
  hun: string[];
  /** 孟达·【求安】的「函」：扣在武将牌旁的伤害牌（公开；不属于手牌/装备/弃牌堆） */
  han: Card[];
  /**
   * 公孙渊·【怀异】的「异」：**本次以此法获得的装备牌**置于武将牌旁（公开特殊牌区）。
   * ⚠️ 移动版口径：异**不是手牌**——不能正常使用/打出、不计手牌数；只被【恣睢】按张数读取。
   *    （2022 线下版才加了「异可如手牌使用/打出」，本仓库取移动版 2021。）
   */
  yi: Card[];
  /**
   * 孙綝·【嗜戮】的「戮」：**真实的武将牌**（不是计数标记）——每张记下武将牌 id 与
   * **这张牌牌面上的势力集合**（`printedFactionsOf`；双势力牌**两个都算**，§5.131）。
   *
   * ⚠️ 不是「死者生前所属角色的势力」（角色势力只能有一个，与牌面势力是两回事），
   *    也不是二选一——用户 2026-09 的口径。
   * 与左慈的「魂」(`hun: string[]`) 同一套资源语义：它们都从 `state.heroPool` 里来。
   */
  lu: { heroId: string; factions: Faction[] }[];
  /**
   * 界钟会·【权计】的「权」：**真实的实体牌**（从手牌或装备区移来），公开放在武将牌旁。
   * 它不是手牌、不算装备区，排异时被移去（进弃牌堆）；每有 1 张，手牌上限 +1（动态读，不缓存）。
   */
  quan: Card[];
  /**
   * 潘濬·【聪察】①的「观察」标记：**正在观察本角色**的潘濬座位。
   *
   * 每个观察来源**各自一条**（两个潘濬观察同一个人时互不覆盖，各自结算自己的那一次）；
   * 被观察者**首次确定势力**时结算并立即删除；潘濬自己的**下一个回合开始**时过期。
   * 只存座位 id，不含任何暗将信息。
   */
  congchaWatchedBy: string[];
  /**
   * 「田」：邓艾·屯田放在**武将牌上**的牌（第 5 个区域的味道，与周泰的「创」同类）。
   * 屯田判定出非红桃牌就收进来；急袭把「田」当【顺手牵羊】用；资粮把「田」交给同势力。
   */
  tian: Card[];
  /**
   * **「节」**（陆逊·谦逊，当前移动版国战）：被他【谦逊】收掉的**单目标锦囊牌**，扣在武将牌上。
   * 最多 3 张（满了【谦逊】就不再触发），可以被【度势】选项二「三张节当一张火焰牌」消耗。
   * 与「田/创/魂」同一类**实体牌区**（牌真的在这里，不是计数），所以模糊扫描要认得它。
   */
  jie: Card[];
  /**
   * 国战【空城】第二段的**暂存牌**：0 手牌的空城诸葛在自己回合外被其他角色「交给」牌时，
   * 这些牌改为置于其**武将牌上**（**不进手牌**，所以空城照旧成立），到他的下一个
   * 摸牌阶段开始时**一次性获得**（见 heroes.ts 的 kongchengStash 与 engine 的 giveCard）。
   *
   * ⚠️ 内容是**暗信息**（交给时就是扣着给的，诸葛亮自己也未必知道是哪几张），
   *    张数是公开的（牌就扣在武将牌上）——`snapshot` 只下发 `kongchengCount`。
   */
  kongcheng: Card[];
  /**
   * 已被**移除**的武将牌（id 列表）。
   *
   * 国战「移除」：那张牌离场，角色用「士兵牌」顶上——**势力/性别/体力上限都保留**，
   * 但**没有技能**。所以 effectiveHeroes 会滤掉它，而势力/性别那几条（读 faction 字段
   * 与英雄的 gender）照旧。糜夫人的闺秀/存嗣、张任的穿心、董卓的暴凌都用它。
   */
  removedHeroIds: string[];
  /**
   * 通过觉醒技/化身等途径「获得」的技能：从别的武将身上借来的。
   * 只记来源武将 id 与技能名，具体怎么摘见 heroes.grantedHeroes。
   */
  grantedSkills: { heroId: string; skillName: string }[];
  /**
   * 「**本回合**获得的技能」（与永久的 grantedSkills 平行，回合结束时清空）。
   * 孙策·魂殇（本回合拥有英姿/英魂）、法正·眩惑（获得武圣等之一直到回合结束）用它。
   */
  tempGrantedSkills: { heroId: string; skillName: string }[];

  /**
   * 君主技发的「临时技能库」记录（君曹操·建安 → 五子良将纛）。
   *
   * 与 `tempGrantedSkills`（**本回合**有效，回合开始清空）不同：纛给的技能持续到
   * **君主的下个回合开始**，中间要跨过别人的回合，所以单开一条记录、由君主的回合开始清掉。
   * 同时记下为代价「暂时不能明置」的那张武将牌（封锁同寿命）。
   */
  /**

   * **已确定的势力**（双势力武将，不臣篇）。

   *

   * 用户给定口径：双势力武将牌要「确定势力」，确定之后**整局都按那一个势力算**，

   * 不会因为重新暗置之类切回另一个。判定规则见 `heroes.determineDualFaction()`，

   * 读取一律走 `effectiveFaction()`（那里优先用它）。

   * 单势力武将不用填它（退回「明置即确定」的旧判定，两者等价）。

   */

  determinedFaction?: Faction | null;

  /**
   * **归属势力的 id**（用户 2026-09 给的 2023 口径：**每一次「建立新势力」生成一个独立的
   * `forceId`，加入该势力的人共享它**；不同野心家各建的势力**不会**因为原势力同为魏/蜀/吴/群
   * 而合并）。
   *
   * 本仓库当前只用到「野心家各自一种势力」这一半：因人数超编**转成野心家**、以及**野心家武将
   * 本体**，在明置确定势力那一刻各拿一个独立 `forceId`（`force:<序号>`）。
   * 「暴露野心 → 建立新势力」实装后，加入者应当**沿用发起者那个 `forceId`**（见 §5.137）。
   * 一切「是不是同势力」的判断都走 `heroes.factionGroupKey`（它优先读这个字段）。
   */
  forceId?: string;
  lordGrant?: {
    skillHeroId: string;
    skillName: string;
    blockedHeroId: string;
    lordSeatId: string;
  } | null;
}

// 一次"杀"的结算上下文（贯穿 使用→成为目标→结算）
export interface AttackContext {
  sourceId: string;
  cardId: string;
  /** 转化后的类型（武圣把红牌当杀时为 'sha'） */
  asType: CardType;
  targetId: string;
  damage: number;
  dodged: boolean;
  /** 伤害属性（火/雷） */
  attribute?: DamageAttribute;
  /**
   * 作为【杀】使用的牌的**颜色**：'red' / 'black' / null（无色）。
   * 仁王盾只挡**黑色**杀，所以无色杀对仁王盾有效——丈八蛇矛一红一黑那两张
   * 凑出来的就是无色杀（见 protocol 的 cardColor / zhangbaShaColor）。
   */
  cardColor?: 'red' | 'black' | null;
  /** 需要的闪数（默认1，吕布·无双=2，马超·铁骑/黄忠·烈弓=Infinity 不可闪避） */
  requiredShan?: number;
  /**
   * **这张牌这次使用指定的全部目标**（按点选顺序；【杀】与各种伤害锦囊在创建攻击上下文时填）。
   *
   * 为什么要有它：伤害是**逐目标**结算的，光看这一份 attack 分不出「这张牌只指定了一个目标」
   * 还是「指定了多个、我只是其中一个」。严白虎·寄篱走的是 `totalTargets`（只看张数），
   * 界钟会·【权计】要的是「**你使用的这张牌，唯一目标就是挨打的那位**」——所以要看名单：
   * 铁索连环的**传导伤害**是从原攻击上下文复制出来的（名单仍是原目标），一比对就露馅，
   * 不需要再单独加一个 `chain` 标记。
   */
  declaredTargets?: string[];
  /** 本次「使用牌」的编号（许攸·成略：把「这张牌造成的伤害」绑回这一次使用） */
  cardUseId?: number;
  /**
   * 这张【杀】一共指定了几个目标（playSha 填）。严白虎·寄篱只认「**唯一**目标」，
   * 而逐个结算时攻击上下文是每人一份，光看自己这份分不出是不是唯一目标。
   */
  totalTargets?: number;
  /**
   * 这张【杀】是不是由技能新造的虚拟牌（`Card.generatedBy` 透传过来）。
   * 目前只有严白虎·寄篱造的那张（`'jili'`）——它**无色**，所以寄篱的钩子不会再认它；
   * 这个字段是给技能判定用的第二道保险（别只看颜色）。
   */
  generatedBy?: string;
  /**
   * 彭羕·嚣逆（**按玩家**）：这次【杀】结算中，名单里的玩家**不能响应**（不能出【闪】）。
   * 与 `requiredShan === Infinity`（整张杀不可闪避）不同：只锁名单里的人。
   */
  unrespondableTargets?: string[];
  /**
   * 严白虎·寄篱：这张【杀】结算结束后，其使用者要**再使用一张虚拟同名【杀】**指定他。
   *
   * 由技能在他成为目标时置位，走到结算收尾（afterAttackSettledTail）消费掉——只消费一次：
   * 第二张是**全新的一次使用**（新的 AttackContext），不是把这一份重跑一遍。
   * ⚠️ 与君孙权·据江的「额外结算一次」是两套机制，别混（见 engine 的两个机制函数）。
   */
  jiliUse?: boolean;
  /**
   * 这次【杀】结算**无视目标防具**（徐庶·诛害的强化分支）。
   * 只作用于这一次结算（`equip.ts` 的四个防具判定点统一读它）：仁王盾/藤甲/明光铠的「无效」、
   * 八卦阵的代闪、藤甲的火焰 +1、白银狮子的防止多余，全部照「装备区没有防具」处理。
   */
  ignoreArmor?: boolean;
  /**
   * 这次结算是由哪个**技能**发起的（目前只有徐庶·诛害）。技能侧靠它认出「自己发起的那次使用」
   * （例如「目标每用一张【闪】响应后弃一张牌」）。
   */
  skillId?: string;
  /**
   * 这张【杀】已经被改过目标（大乔·流离）。
   * 只允许改一次，否则两个都会改目标的技能能让它来回弹、死循环。
   */
  redirected?: boolean;
  /**
   * 【方天画戟】（势备篇·国战版）的**剩余目标**队列。
   *
   * 国战版方天画戟允许一张【杀】指定任意名势力各不相同的角色（未确定势力的不限），
   * 而且「当此【杀】被一名目标使用【闪】抵消时，此【杀】对其他目标无效」——
   * 所以逐个结算：一人闪了，队列立刻被清空，其余目标什么也不受。
   */
  fangtianQueue?: string[];
  /**
   * 这张【杀】整个结算完之后要接着做什么（替代默认的「回到出牌阶段」）。
   * 贾诩·乱武要让若干个角色**依次**出杀：一张杀结算完才轮到下一个人，
   * 所以必须挂在这个收尾点上，不能在 useShaOn 后面直接往下写。
   */
  afterSettled?: () => void;
  /**
   * 这次**攻击流程**的起点快照（施工方案 Step 3a.1）：`startAttack`/`resolvePlayedSha` 刚拿到
   * 控制权时拍的槽快照，收尾 `resumePlay` 时当围栏用（判「我这段时间里有没有人创建更新一代」）。
   */
  pendingFence?: { requestId: number | null; slotVersion: number };
  /**
   * 这次【杀】摆上槽的那个「求闪询问」（`{kind:'respondSha'}`）对象本身。
   *
   * 用途是「**谁建谁清**」：自动响应（八卦阵/护驾那类代打）会在**同一个 intent 里**
   * 把这条询问创建又解决掉，槽里于是留下一个**已经处理完、却没人答过**的旧对象
   * （`answeredPendings` 里没有它）。不认它的话，钩子链收尾的「环境 pending 还原」会把它
   * 当成还在等人回答的询问原样还回去，诊断探针也会把它记成「收尾抢了一条没答过的询问」——
   * 实测（scripts/measure-takeover.ts，60 局）69 次记录**全是**这一类误报。
   * 所以结算收尾（`finishAttack`）认一次它的身份、打上「已处理」标记。
   */
  shanAsk?: { kind: string; responderId?: string } | null;
  /**
   * 刘禅·享乐问过了吗。
   * 享乐是「除非使用者弃一张基本牌，否则此【杀】对你无效」：付款之后要继续走
   * 防具/八卦/等出闪那一段，而那段又会回到同一个检查点，所以得留个记号防止来回问。
   */
  xingleChecked?: boolean;
  /**
   * 一人出【闪】是否令此【杀】对**其余目标全部无效**。
   * 只有**国战版**方天画戟是这样（军争版各目标独立结算），所以由 fangtianRule 赋值。
   */
  fangtianAbortOnDodge?: boolean;
}

// 即时锦囊结算上下文（贯穿：打出→无懈可击询问→结算→响应）
export interface TrickContext {
  sourceId: string;
  /**
   * **结算完把控制权还给谁**——缺省＝`sourceId`（谁用的牌就还给谁）。
   *
   * 只有「**在别人的回合里，替别人造一张牌**」那种技能才需要它：貂蝉·离间是貂蝉出牌阶段
   * 发动的，虚拟【决斗】的“使用者”是关羽（他要跟张飞决斗），但**回合还是貂蝉的**——
   * 收尾必须还给出牌阶段的貂蝉，不能把控制权交给关羽（用户 2026-09-21 口径）。
   */
  resumeSeatId?: string;
  card: Card;
  // 过河拆桥/顺手牵羊：目标与指定的明牌区牌
  targetId?: string;
  targetCardId?: string;
  /** 本次「使用牌」的编号（许攸·成略：把「这张锦囊造成的伤害」绑回这一次使用） */
  cardUseId?: number;
  /**
   * **这张牌开始结算时的输入槽快照**（所有权围栏，见 docs §5.124）：
   * 收尾要把控制权抢回出牌阶段时，拿它判断「槽里还是不是我结算前那一份」——
   * 期间若产生了新询问（弃置收口里的旁观技能、成略的询问…），就**只能排队等它答完**。
   */
  pendingFence?: { requestId: number | null; slotVersion: number };
  /**
   * 本次使用指定的全部目标（按玩家点选顺序）。
   * 单目标锦囊走 targetId 就够了，但**多目标**锦囊（铁索连环一至两名）只能靠这个。
   */
  targetIds?: string[];
  // 南蛮/万箭：需依次响应的存活玩家队列
  responders: string[];
  responderIndex: number;
  // 决斗：当前该谁出杀（target=目标方，source=来源方）
  duelTurn?: 'target' | 'source';
  /**
   * 君孙权·据江：「此牌**额外结算一次**」——**同一张牌**不新建使用，只在结算收尾处把
   * 同一份结算再完整走一遍（追加结算）。`rerunSkill` 只是日志里那个技能名。
   */
  extraResolve?: boolean;
  extraResolveDone?: boolean;
  rerunSkill?: string;
  /**
   * 严白虎·寄篱：这张锦囊结算结束后，其使用者**再使用一张虚拟同名锦囊**指定严白虎。
   * 与据江的「追加结算」刻意分开：第二张没有实体牌（`materials: []`）、不继承花色点数、
   * 会重新开无懈窗口——它是**一次全新的卡牌使用**（见 engine 的 useVirtualSameNameCard）。
   */
  jiliUse?: boolean;
  /**
   * 彭羕·嚣逆：**按玩家**的「不能响应这张牌」——只锁名单里的那些人，
   * 其余角色（含打【无懈可击】的）照常响应。与下面刘琦的 `unrespondable`
   * （**整张牌**不能被其他角色响应、连无懈窗口都不开）是两种语义，别混：
   * 嚣逆只作用于「被指定的那些目标本人」。
   */
  unrespondableTargets?: string[];
  /**
   * 刘琦·问计：这张牌不能被**其他角色**响应（使用者自己不受限）。
   *
   * 它一次拦掉三类响应：① 无懈窗口（openWuxieWindow 直接跳过）；
   * ② 群体锦囊的「依次响应」（南蛮出杀 / 万箭出闪）→ 直接按弃权结算；
   * ③ 决斗的「对方打出【杀】」与借刀杀人的「打出【杀】或交武器」→ 直接走弃权那一支。
   * 【杀】的响应走另一条通道（AttackContext.requiredShan = Infinity，与铁骑/烈弓同一处判定）。
   */
  unrespondable?: boolean;
  /** 寄篱第二张牌的目标（他成为目标那一刻记下来，结算收尾时用） */
  jiliTargetId?: string;
  /**
   * 决斗：当前响应方在「这一次响应」里已经打出的【杀】数。
   * 对手含无双时每次要出两张【杀】，凑满才换手（见 heroDuelShaRequired）。
   */
  duelShaCount?: number;
  // 火攻：目标展示的手牌花色
  revealedSuit?: Suit;
  // 借刀杀人：被指定出杀的目标（targetIds[1]）
  shaTargetId?: string;
  // 主动技能创建的虚拟锦囊标识（离间=lilian）
  skillId?: string;
  /**
   * 【无懈可击】的**抵消链**。
   *
   * 官方规则里无懈可击有两种用法：抵消一张锦囊对**一名角色**的效果，或者抵消
   * **另一张无懈可击**。所以它们串成一条链——第一张决定「抵消谁」（`scope`），
   * 之后每再打出一张都是在抵消上一张；抵消是**翻转**，于是
   * **奇数张 = 已抵消，偶数张 = 效果恢复**（见 `engine.negatedSeats`）。
   *
   * 【无懈可击·国】与普通无懈**走的是同一套机制**，只差 scope 的大小：
   * 普通无懈是一名角色，无懈·国是「一名角色 + 与其势力相同的所有尚未结算完毕的角色」。
   * 规则里的那条 FAQ 也自然成立——无懈·国被抵消时，它那整片范围一起恢复。
   */
  wuxieChain?: { scope: string[]; count: number };
}

// 引擎"暂停等待玩家输入"的几种状态
export type Pending =
  // 出牌阶段：你可继续出牌或结束
  | { kind: 'play'; seatId: string }
  // 被杀为目标：出闪或弃权
  | { kind: 'respondSha'; responderId: string; attack: AttackContext }
  // 濒死求桃：按座次轮询每个玩家
  | {
      kind: 'respondDeath';
      dyingId: string;
      askQueue: string[];
      askIndex: number;
      /** 把濒死者打到 0 的人，阵亡时要用来触发「杀死角色后」的技能（行殇） */
      killerId?: string;
      /**
       * 这一串濒死（求桃 / 阵亡）**整个走完之后**的续接——由发起濒死的那个流程传进来。
       *
       * 濒死系统自己不再决定「回到谁的出牌阶段」（见 docs §5.127）：它只负责调用 `done()`，
       * 控制权交回调用方。分岔到 pendig 里之后（求桃要等玩家回答），`done` 就挂在 pending 上，
       * 由回答分支（respondDeathSave / onPass）取出来用。
       */
      done: () => void;
    }
  /**
   * 弃牌阶段：弃到上限。
   *
   * `thrown`＝**本阶段到此刻为止已经弃掉的牌**（跨轮累加）：弃牌阶段里被技能塞回来的牌
   * 也要接着弃（用户 2026-09-21 口径），所以这一格可能被摆上多次；账本给
   * `othersDiscardPhaseEnd` 的 payload 用（「该角色此阶段弃置的牌」）。
   */
  | { kind: 'discard'; seatId: string; count: number; thrown?: Card[] }
  // 锦囊响应：出杀(南蛮/决斗/借刀)/出闪(万箭)/展示牌(火攻)/弃牌(火攻)
  | { kind: 'respondTrick'; responderId: string; ctx: TrickContext }
  /**
   * 无懈可击询问窗口：依次问队列里的人要不要打无懈。
   *
   * 这个窗口会出现**多次**——锦囊结算开始时一次，之后**每名角色生效前**再来一次
   * （官方时机就是「目标锦囊牌生效前」，所以群体锦囊是逐个角色各一次）。
   * `onDone` 是这一轮问完（没人再打无懈）之后接着干什么：不给就是「结算锦囊」，
   * 逐目标的那些窗口则给一个「继续结算这个目标」的续接。
   */
  | {
      kind: 'wuxieQueue';
      ctx: TrickContext;
      askQueue: string[];
      askIndex: number;
      onDone?: () => void;
    }
  /**
   * 通用「选择一项」：某角色在若干选项里选一个。
   * resolve 是选完之后怎么继续——引擎的 GameState 常驻内存、不做序列化
   * （下发的只是 toSnapshot 的结果），所以这里可以放闭包。
   */
  | {
      kind: 'choice';
      seatId: string;
      title: string;
      options: { id: string; label: string }[];
      resolve: (state: GameState, player: Player, optionId: string) => void;
      /**
       * 选完之后把控制权还给谁（回到他的出牌阶段）。
       * 不填则选完就停在 pending=null —— 那会让出牌方再也动不了，
       * 所以由技能发起的「选择一项」都应该填这个。
       */
      returnTo?: string;
      /**
       * 「操作**别人区域里的牌**」的**分区布局**（用户 2026-09-23 的口径）：不同角色横向分栏、
       * 同一角色内部按 hand/equip/judge 纵向分区。
       * ⚠️ 它**只是布局**——点某一张仍然回 `chooseOption(optionId)`，引擎的解析不变。
       */
      zonePick?: ZonePickLayout;
    }
  /**
   * 从一组牌里看/选若干张（选牌原语）。
   *
   * 与 discard/play 的区别：被选的牌**不一定是自己的手牌**——观星看的是牌堆顶。
   * 所以提示层要下发完整牌面，而不是让界面拿 id 去手牌里查。
   */
  | {
      kind: 'pickCards';
      seatId: string;
      title: string;
      /** 候选牌（引擎侧真实对象；此时它们可能还在手牌里或牌堆顶，由 resolve 自己搬） */
      cards: Card[];
      min: number;
      max: number;
      /**
       * 候选对**选择者**是否隐藏（「从其他角色未知手牌中选牌」的通用盲选，用户 2026-09-22）。
       * 为 true 时下发给选择者的快照里**只留 id**（见 legal 的 buildPrompt）——牌面不出服务端。
       */
      hidden?: boolean;
      /**
       * 这一手选牌是**从牌桌上公开摆着的牌池里拿**（【五谷丰登】）：界面不画通用选牌框，
       * 改为直接点牌桌中央那张牌（点完立即拿走）。见 `GameState.publicPool`。
       */
      fromPool?: boolean;
      /** 多目标时的分区布局（见 ZonePickLayout）：界面给每一家画一块独立牌位 */
      zonePick?: ZonePickLayout;
      /** 这些牌属于谁（盲选时界面标注「在看谁的手牌」） */
      ownerSeatId?: string;
      /** 其中已因其他效果公开的牌 id（由规则层给，界面照它画牌面） */
      visibleIds?: string[];
      /** 选完怎么继续。收到的是被选中的**牌对象**，不用再去找 */
      resolve: (state: GameState, player: Player, picked: Card[]) => void;
      /**
       * 选完把控制权还给谁。钩子发起的不传（走续接队列）；技能发起的必须传。
       */
      returnTo?: string;
      /**
       * 选牌内容是不是秘密（观星）：是则日志只记张数，不记牌名。
       * ⚠️ 盲选（`hidden`）**同样**不记牌名——见 `onPickCards` 的日志分支：
       *    日志是**发给全场**的，选了哪张写进去就等于把对手的手牌公开了。
       */
      secret?: boolean;
    }
  /**
   * 一次**选多名角色**（多选座位原语）。
   *
   * 那些「至多 X 名（不同）角色」的技能以前只能「逐个问 + 可提前结束」近似（怀异那类），
   * 现在可以一次点亮好几家再确认。`candidates` 由调用方按规则筛好（存活、可被选…）。
   */
  | {
      kind: 'pickSeats';
      seatId: string;
      title: string;
      candidates: string[];
      min: number;
      max: number;
      /** 选完怎么继续。收到的是选中的座位 id 列表 */
      resolve: (state: GameState, player: Player, picked: string[]) => void;
      /** 选完把控制权还给谁（技能发起的必须传，钩子发起的不传） */
      returnTo?: string;
    }
  /**
   * 势力技：依次问**同势力**角色是否代打一张牌（曹操·护驾 / 刘备·激将）。
   * 结构与 wuxieQueue 相同：一个按座次询问的队列。
   */
  | {
      kind: 'factionCall';
      /** 发起者——最后视为**他**使用/打出了这张牌 */
      callerId: string;
      /** 需要打出的牌型（护驾=闪） */
      needType: CardType;
      title: string;
      askQueue: string[];
      askIndex: number;
      /** 有人代打：牌已从他的手牌移除并进了弃牌堆 */
      onCard: (state: GameState, helper: Player, card: Card) => void;
      /** 没人愿意代打 */
      onNone: (state: GameState) => void;
    }
  /**
   * 私密信息查看（知己知彼）：只把内容下发给 `seatId` 这一个座位。
   * 其他座位的快照里什么也看不到，日志里也不出现牌名/武将名。
   */
  | {
      kind: 'viewCards';
      seatId: string;
      title: string;
      /** 要看的牌（可能是别人的手牌） */
      cards: Card[];
      /** 不是牌的信息：暗置武将牌的名字 */
      note?: string;
      /** 看完把控制权还给谁（通常是发起锦囊的玩家） */
      returnTo?: string;
      /**
       * 技能发起的私密查看：看完确认后接着跑这里（而不是把出牌阶段还给 returnTo）。
       * 蒋钦·尚义要「看完对方手牌，再看你要不要弃一张」这种多步流程。
       */
      after?: () => void;
    };

// 选将阶段：每人随机发到 K 张武将，各自选 1（并发，全选完才开局）
export interface DraftState {
  deals: Record<string, string[]>; // seatId -> 该座发到的 K 个 heroId
  pendingSeats: string[]; // 尚未选将的 seatId
}

/**
 * 铁索连环蔓延的待续状态。
 * 被濒死打断时暂存在 GameState 上，等濒死结算完由**可挂起钩子链**（`resumeQueue` /
 * `drainResume`）接着跑——旧的那条「resumePlay 看见它就补跑」的跳转已在 Step 5.2 删除。
 */
export interface ChainPending {
  attack: AttackContext;
  damage: number;
  /** 还要蔓延到的座次（按顺序） */
  rest: string[];
  index: number;
}

/**
 * takeover 打点记录（施工方案 Step 0.1：**所有** takeover 都记完整上下文）。
 *
 * 「takeover」＝一次收尾把**别人的**询问从槽里换掉。两种来源：
 * - `probe: 'fence'`：带 checkpoint 的收尾（围栏判「本来会挡住」）——一直开着，成本只是一次入队；
 * - `probe: 'clobber'`：把**还没人回答**的询问顶掉（更严重，只在 `SGS_PROBE_CLOBBER=1` 时记，
 *   因为要抓调用栈）。
 */
export interface TakeoverRecord {
  probe: 'fence' | 'clobber';
  /** 收尾点（clobber 用调用栈顶帧） */
  site: string;
  phase: string;
  turnSeat: string | null;
  /** 被换掉的那一格（fence 下是「当前槽」；clobber 下是「被顶掉的未答询问」） */
  oldPending: {
    kind: string;
    owner: string | null;
    seq: number;
    answered: boolean;
    completed: boolean;
  } | null;
  /**
   * 收尾**原本打算**安装的那一格（目前都是出牌阶段的占位）。
   * ⚠️ Step 4 之后它不再真的被覆盖：被挡的收尾改成「登记等待」，所以看 `outcome` 更准。
   */
  newPendingKind: string;
  /**
   * 这一步的**处置**：
   * - `'overwritten'`：照旧覆盖（Step 4 之前的老行为；`SGS_FENCE_ENFORCE=1` 时不会出现）
   * - `'deferred'`：登记等待，等挡住它的那条询问走完再回来（Step 4 起的默认行为）
   * - `'threw'`：当场 fail-fast（`SGS_FENCE_ENFORCE=1`，Step 3b 的诊断模式）
   */
  outcome?: 'overwritten' | 'deferred' | 'threw';
  checkpoint: { requestId: number | null; slotVersion: number; useId?: number | null } | null;
  currentSeq: number;
  inDying: boolean;
  /** 老机制三跳的当时状态（Step 5 靠数据判断能不能删；三跳已全清，剩这两项的是活着的队列） */
  ongoing: { skillChain: number; chain: boolean };
  resumeQueue: number;
  sameUse: string;
  caller?: string;
}

export interface GameState {
  roomCode: string;
  mode: GameMode; // 当前对局模式
  /**
   * **拼点区**（用户 2026-09-23 要求牌桌中央有一块独立的拼点 UI）。
   *
   * 只放**公开信息**：双方都扣好之前，`sides[].card` / `point` 连**字段都不写**——
   * 「扣好了先显示牌背、双方都扣好才翻牌」这条不是界面演出来的，是服务端就**没给**牌面
   * （与盲选 `Pending.pickCards.hidden` 同一条规矩）。
   *
   * 结算完不立刻清：下一次**任何 intent**（谁行动都行）时清空，让玩家看清点数与胜负。
   */
  pindianView?: PindianView | null;
  /**
   * **牌桌上公开摆着的牌池**（【五谷丰登】）：亮出的牌平铺在牌桌中央，按座次依次点牌拿走，
   * 拿走的立刻从展示区消失（位置留痕 + 谁拿的）。公开信息 ⇒ 整份下发。
   * 与拼点不同，它**跨多个 intent 存活**（每人一次选牌），所以不能在 applyIntent 里清。
   */
  publicPool?: PublicPoolView | null;
  players: Player[];
  seatOrder: string[]; // 回合顺序
  deck: Card[];
  /**
   * 【势力锦囊】四张（不臣篇）：开局**不在**摸牌堆里，放这儿等着**第一次重洗**时洗入；
   * 使用/弃置后**移出游戏**（不进弃牌堆循环）。见 `deck.factionTrickCards` 与 §5.136。
   */
  /** 归属势力 id 的自增号（`Player.forceId` 用它生成，见那里的说明） */
  forceSeq: number;
  /**
   * 本轮胜利判定里**已经问过要不要暴露野心**的座位（§5.141）。
   *
   * 存在的意义是防止死循环：某人选「不暴露」后，胜利判定还会再来一次，
   * 不记住就会把同一句话反复问。一旦这轮不再存在胜利条件就清空（下次重新给机会）。
   */
  ambitionAsked: string[];
  /**
   * **本次「暴露野心 → 建国」总流程里已经加入过新势力**的座位（§5.141 第 7 点）。
   *
   * 用途：一名角色在**同一次**建国总流程里最多加入一个新势力——旧移动版实测是排他的
   * （「接受一名野心家的拉拢后不能再响应其他野心家的拉拢」），2023 公告只放开了
   * 「一个建国者可以接纳多人」，没放开「中途改投」。与 `ambitionAsked` 同时清空。
   */
  ambitionJoined: string[];
  /**
   * 「一手意图的收尾钩子」里**因为槽被占而排队**的那些（`handEmptied` / `cardsLost`，见
   * `fireEndOfIntentHooks`）。存的是闭包，和 `Pending.resolve` 同一性质——引擎本来就把闭包
   * 放在状态里，不额外破坏什么。
   */
  deferredEndOfIntentHooks: (() => void)[];
  pendingFactionTricks: Card[];
  /**
   * **本局归一化后的扩展开关**（`createGame` 里算好后存下来）。
   *
   * 存它的理由：有些**规则**要看「当前模式实际开放了哪些牌」（例如【度势】② 的候选、
   * 势备篇独有的【火烧连营】）——不能在引擎里撒 `if (ext.xxx)`，所以把这份开关交给规则层读。
   */
  extensions: GuozhanExtensions;
  /**
   * **移出游戏**的牌（不是弃牌堆、也不会再回到任何牌区）：
   * 势力锦囊用/弃后进这里；君主专属装备「离开装备区即销毁」也进这里。
   * 单独记一份是为了让「牌不会凭空消失」这类守恒检查能如实核对（模糊测试网要看得到它们）。
   */
  exiled: Card[];
  discard: Card[];
  turn: { seatIndex: number; phase: Phase };
  pending: Pending | null;
  draft: DraftState | null; // 非空表示处于选将阶段
  /** 铁索连环蔓延被濒死中断时暂存，濒死结算后继续 */
  ongoingChain: ChainPending | null;
  /**
   * 本回合**受到过伤害**的座次（董昭·劝进只能对这些人发动）。
   * 在 runHooks 分发 afterDamage 时统一登记，所以不用去每处伤害点加代码。
   */
  damagedThisTurn: string[];
  /**
   * 本回合**杀死过角色**的人（何太后·戚乱：「你于此回合内杀死过角色」）。
   * 与 damagedThisTurn 同一套做法：在 kill 时机的公共入口登记、随回合清空。
   * 注意要按「回合」而不是「某人的回合」清——戚乱是在**任何**回合结束时检查的。
   */
  killedThisTurn: string[];
  /**
   * 本回合**从牌堆摸到过**的牌 id（袁术·伪帝：「本回合从牌堆获得过牌的角色」）。
   *
   * 在 `drawOne`（deck.ts，摸牌的**唯一**出口）登记、随回合清空。
   * ⚠️ 记的是**牌**而不是人：drawOne 只负责从牌堆取牌，把它塞进谁手里是调用方决定的，
   * 所以判定时反过来查「某人的手牌/装备区里有没有这些 id」。已知偏差：这张牌本回合被别人
   * 拿走（顺手牵羊那类）后，新持有者也会被算作「从牌堆获得过牌」——要做准就得再记「谁摸的」。
   */
  gainedFromDeckThisTurn: string[];
  /**
   * 「这张牌是**谁**从牌堆摸到的」（牌 id → 座次），随回合清空。袁术·伪帝用它认人。
   *
   * 为什么不能只看 `gainedFromDeckThisTurn`（牌 id 列表）：那张牌本回合被别人顺手牵羊拿走之后，
   * 新持有者按牌 id 查也会被算成「从牌堆获得过牌」。归因放在**意图结束时**做：一张牌第一次
   * 出现在某人手里、且它在本次抽牌账本里、且还没归过别人 → 才算他摸的。偷来的不会被算。
   * 已知偏差：同一手意图里「摸到又立刻弃掉」的牌不会归因（它没在意图结束时留在手上）。
   */
  deckGainOwner: Record<string, string>;
  /**
   * 君孙权·据江「此牌额外结算一次」的去重账本：已经追加结算过的牌 id。
   * 追加的那一遍里技能钩子会再次看到这张牌，靠它跳过（否则无限递归）。随回合清空。
   *
   * ⚠️ 只服务于「追加结算」（据江）那一套；严白虎·寄篱的第二张牌是**新建的虚拟牌**
   *    （不同 id），不需要账本——它自己也永远不会被再次触发（无色）。
   */
  extraResolvedCards: string[];
  /**
   * 严白虎·寄篱造出来的虚拟牌**发号器**（id 带序号 → 唯一；记在 state 上 → 同种子可重放）。
   */
  jiliVirtualSeq: number;
  /**
   * 轮号：从 **1** 开始，座次绕回首位时 +1（见 afterTurnEnd）。徐庶·荐才的
   * 「获知数量补足到 轮数×3」用它；`roundStart` 时机在 +1 之后派发。
   */
  round: number;
  /**
   * 本回合的**伤害事件账本**：每次真正落地的伤害记一条（来源、目标、**伤害发生那一刻**
   * 目标的已确定势力）。徐庶·诛害要问「该角色本回合有没有伤害过与徐庶**势力相同**的角色」——
   * 势力按当时公开的 `effectiveFaction` 记，**不追溯**（暗将之后亮出来不算，与会盟同一口径）。
   * 随回合清空（startTurn）。
   */
  damageLedgerThisTurn: { sourceId: string; targetId: string; targetFaction: Faction | null }[];
  /** 孟达·【量反】：本回合从「函」拿进手里的实体牌 id（资格不跨回合） */
  liangfanHanIds: string[];
  /**
   * SP司马昭·【夙智】：回合内的触发计数（**三个子效果共用 3 次额度**，0..3）。
   * 只在他自己的回合内有效，随回合开始清零。达到 3 即本回合剩余时间失效。
   */
  suzhiTriggers: number;
  /**
   * 孙綝·【凶虐】①：本回合选定的攻击效果（消费 1 张戮换来）。
   * `faction` 是那张戮**冻结时**的势力；`mode` 是三分支之一。随他的下个回合开始清空。
   */
  xiongnue: { factions: Faction[]; mode: 'dmg' | 'obtain' | 'limit' } | null;
  /**
   * 孙綝·【凶虐】②：本回合的出牌阶段结束时消费 2 张戮换来的「受到**其他角色**伤害 -1」，
   * 持续到**他自己的下个回合开始**（跨过别人的回合）。
   */
  xiongnueDefense: boolean;
  /**
   * 刘巴·【统度】：本回合**各自的弃牌阶段**里、由该角色**自己**弃置的牌数（按**张**统计，
   * 不看事件次数）。只在 `turn.phase === 'discard'` 且弃牌者就是当前回合角色时累加，
   * 随回合清零。用来算 X（至多 3）。
   */
  discardPhaseCountsThisTurn: Record<string, number>;
  /**
   * 被**濒死**打断的「多步链」的续接队列（王平·将略的军令逐个问、朱灵·决绝的逐个结算，
   * 以及**任何**在钩子链里打出来濒死的情况——见 engine 的 runHooksFrom）。
   *
   * 为什么要单独一份：这类链被打断之后
   * ① 不能让发起方接着同步跑——`askChoice` 会把濒死求桃的询问**直接顶掉**（被顶的人停在
   *    0 体力却永远不死，回合还照常往下走）；
   * ② 也不能只靠 `resumeQueue`——那条队列在「出牌阶段占位 pending」下不会被排空
   *    （见 `isIdlePending` 的注释），链会一直搁在队列里。
   * 所以挂到 state 上，由 `resumePlay` 在「控制权该还回去的时候」按**挂上的先后**依次惊醒。
   * （历史上与它同档的还有 `ongoingTrick`（AOE 锦囊）/ `ongoingChain`（铁索蔓延）两条旧跳转，
   *   Step 5 已把 `resumePlay` 顶部的三跳全部删除，只剩这一条队列。）
   */
  ongoingSkillChain: (() => void)[];
  /**
   * **本回合**的「弃置账本」：谁（`actorId`）弃置了谁（`ownerId`）的哪几张牌。
   *
   * ⚠️ 两个维度必须分开：**执行弃置动作的人**和**牌原来属于谁**是两回事——
   * 「A 用过河拆桥弃 B 的牌」是 `actorId = A, ownerId = B`；「A 令 B 弃置自己一张」是
   * `actorId = B, ownerId = B`（执行者是 B）。苏飞·【联翩】要的正是**执行者**那一维
   * （「本回合弃置任意角色的牌的总张数」），只看牌主一定会算错。
   *
   * 只记**真正的弃置**：这条账本由 `fireCardDiscarded` 写，而「置入弃牌堆」（朱灵·决绝那类
   * 直接落牌、使用/打出/判定后进弃牌堆）根本不走它，所以天然不算。
   * 随回合清空（`startTurn`）；同一回合内**逐个技能实例实时重算**，不要缓存。
   */
  turnDiscards: { actorId: string; ownerId: string; cardIds: string[] }[];
  /**
   * **一次「使用牌」的编号**（每次使用自增）＋「本回合各次使用实际造成的伤害」账本。
   *
   * 许攸·【成略】要求「**这张牌整个生命周期**有没有实际伤害过某个人」——必须绑定**这次使用**
   * （`cardUseId`），不能按牌名、也不能按「本回合受过伤」判断：同一个人连着用两张【南蛮】，
   * 第二张结算时不能因为第一张打过他就发阴阳鱼。
   * 只在**真的扣了血**之后记（被防止/减到 0 不算）；随回合清空。
   */
  /**
   * 诸葛恪·【黩武】：结算期间「谁在盯着」与「有没有人进入濒死并被救回」。
   * 两次状态（`duwuWatchSeat` = 发起者）——因为黩武的结算会挂起好几次询问，
   * 用局部变量接不住；随回合清空。
   */
  /** 「最近一次伤害」的来源与生成者（黄祖·袭射判断「被袭射的杀打死」用；随回合清） */
  lastDamageSourceId: string;
  lastDamageGeneratedBy: string | null;
  /** 黄祖·袭射②：本回合有人死于袭射的【杀】（存黄祖座位；随回合清） */
  xisheKilledSeat: string | null;
  duwuWatchSeat: string | null;
  duwuRescued: boolean;
  /**
   * **输入槽的版本号**：每次 `state.pending` 被写（set / clear / replace / answer / restore）都自增。
   *
   * 用来实现「收尾只能抢走自己开始前就存在、且期间从未被碰过的 pending」这条所有权规则
   * （lost-update / ABA 防护，见 engine 的 capturePendingCheckpoint / takeOverPendingIfUnchanged
   * 与 docs §5.124）。**不要直接写 `state.pending = …`**——要走那套收口函数，
   * 否则这个版本号不会动，收尾会误判成「没人碰过」。
   */
  pendingSeq: number;
  /**
   * **被围栏挡住的收尾待办**（订阅式唤醒，docs §5.124.2）：收尾想抢回出牌阶段但槽里是别人
   * 刚产生的询问时，把「等它答完再回来」登记在这里；那条 pending 一被 resolve/cancel
   * （回答询问的清槽点）就直接唤醒，而不是靠轮询队列（轮询在 play 占位下永远不跑）。
   */
  /** 等某一条询问（requestId）**完成**的待办（按 requestId 分组；不是「等 pending 变空」） */
  pendingWaiters: Map<number, (() => void)[]>;
  /** **回合世代**：每次回合交接（startTurn）自增；迟到的 resumePlay 请求靠它判过期 */
  turnSeq: number;
  /**
   * **打点**（docs §5.124.4）：围栏「本来会挡住」的 takeover 记录——用于把被挡的收尾按**语义**
   * 聚类（是「恢复交互入口」还是「提交不可延迟的状态迁移」），而不是按函数名猜。
   * 只记不改行为（当前仍照旧强制覆盖），所以开着它不会有任何行为变化。
   */
  blockedTakeovers: TakeoverRecord[];
  /**
   * 续接执行计数（施工方案 Step 1.4）：`continuationId` → 执行次数。
   * **同一个 id 被执行超过一次**就是「多执行」类失败（窗口自己推进了一次、旧的三跳又推一次），
   * 必须停下来查——所以它不是普通统计，是硬指标（目标：不允许出现 > 1 的条目）。
   */
  continuationRuns: Map<string, number>;
  /**
   * 不变量 B（施工方案 Step 2.3）：**一条 pending 最多完成一次**。
   * key = `pendingIdOf(pending)`，value = 它被「确认完成」过几次；出现 > 1 就是重复完成。
   */
  pendingCompletions: Map<number, number>;
  /**
   * 不变量 D（施工方案 Step 2.3）：`releaseIfMine` 因为「槽里已经是更新一代」而**拒绝释放**的次数。
   *
   * 拒绝本身是**正确行为**（说明有流程收尾晚了、控制权已经交出去），但这个数字是 Step 4
   * 接 waiter 的输入：每一条拒绝将来都要变成「登记等待」而不是「什么都不做」。
   */
  refusedReleases: { id: number; kind: string }[];
  /**
   * 施工方案 Step 4（4.2 幂等）：已经登记等待的续接 id 集合——同一条续接只登记一次，
   * 不许因为多个唤醒点重复注册而在询问走完后跑两遍（那正是「多执行」类的失败）。
   */
  deferredContinuations: Set<string>;
  /** 施工方案 Step 4.4：嵌套 drain 的次数（诊断用；正常应该很小） */
  pendingDrainReentry: number;
  cardUseSeq: number;
  useDamages: { useId: number; targetId: string; amount: number }[];
  /**
   * 朱灵·【决绝】的触发门槛：本回合**自己的弃牌阶段**里**弃置过手牌**的座位。
   * ⚠️ 与上面的「弃置总张数」是两个口径：门槛只看「有没有弃过**手牌**」，
   *    而 X＝本阶段弃置的**全部**牌数（含装备等其他牌）。
   */
  handDiscardedInDiscardPhase: string[];
  /**
   * 朱灵·【决绝】已在本回合的弃牌阶段失去过 1 点体力（记在本回合内，随回合清空）。
   */
  juejueArmed: boolean;
  /**
   * **当前阶段**实际受到过伤害的角色（伤被防止不算）。
   * 董昭·【劝进】要求目标是「在当前**出牌阶段**已经受到过伤害」的角色——注意是**阶段**不是回合，
   * 所以不能复用 `damagedThisTurn`。进入出牌阶段时清空（与 `lostCardsThisPhase` 同一生命周期口径）。
   */
  damagedThisPhase: string[];
  /** 张鲁·【米道】：本回合已经发动过米道的**使用者**座位（每名同势力角色各自每回合一次） */
  midaoUsedSeats: string[];
  /**
   * 装备「失去事件」的编号（见 timing.EquipLostPayload.eventId）。单调递增，不需要重置。
   */
  equipLossSeq: number;
  /**
   * 本局的随机源。`createGame` 的 `opts.rng` 会存进来（测试就是靠它做「固定种子」的对局）。
   *
   * ⚠️ 以前「随机选一张手牌」「军令随机抽两张」这类地方直接用了 `Math.random()`，
   * 于是**种子只固定了一部分对局**——同一个种子每次跑出来的局面不同，冒烟/模糊测试
   * 报出来的问题无法稳定复现（排查时白花了两轮）。新增随机逻辑一律走这个字段。
   */
  rng: () => number;
  /**
   * 「未加入游戏的武将牌堆」：选将结束后剩下的武将 id（变包的**变更副将**从这堆里
   * 连续亮将，直到亮出与主将势力相同者）。
   */
  heroPool: string[];
  /**
   * 本回合**进入过弃牌堆**的所有牌（孟获·再起的 X = 其中红桃牌的数量）。
   *
   * 只有 `toDiscard()` 会写这个账本——**不要直接 `state.discard.push(...)`**，
   * 否则会漏记。注意牌堆抽空时 `drawOne` 会把弃牌堆洗回牌堆，但账本不清空：
   * 那些牌确实「进入过弃牌堆」，规则上仍然要算。
   */
  discardThisTurn: Card[];
  started: boolean;
  gameOver: boolean;
  winner: string | null; // 胜方标识（阵营/队伍/身份方），未结束时为 null
  log: LogEntry[];
  /**
   * **本局先手**：`createGame` 的 `opts.firstSeat` 指定的座位（没有就是 null）。
   *
   * 只在选将结束时用一次——没有指定时按模式规则定：军争=主公、其余模式=**随机**一名角色
   * （用户 2026-09-23 报的缺陷：原来写死「座次 0 先手」，等于房主永远先手）。见 docs §5.205。
   * 存这一份是因为定先手的时机在 `finishDraft`，那里拿不到 `createGame` 的 opts。
   */
  forcedFirstSeat: string | null;
  /**
   * **开发工具开关**：本局是否接受「测试场景布置」意图（`createGame` 的 `testScenario`）。
   *
   * 正式对局恒为 false —— 服务端只在开发模式（`SGS_DEV_TOOLS` / 非 production）下开启，
   * fuzz / smoke / 常规回归都不开。见 docs §5.206。
   */
  testScenario: boolean;
  /**
   * **当前这一轮的起点座位**（`seatOrder` 的下标）＝本局先手所在的位置。
   *
   * 「一轮」是座次环上从先手走一圈，所以判「是否进入新一轮」必须**相对它**算，
   * 不能拿绝对的 `next < current` 去比——那个写法其实是把「座次 0」当成了每轮的起点
   * （先手变成随机座位之后，从座次 2 开局就会出现「一圈走完了却判不出新一轮」）。
   * 见 docs §5.205。
   */
  roundStartSeat: number;
  /** 日志自增序号：快照只带最近若干条，客户端靠它判断哪些是新事件 */
  logSeq: number;
  /** 国战：全场第一个明置武将的座次（先驱标记发给它），无人明置时为 null */
  xianquSeat: string | null;
  /**
   * 被询问打断的后续流程，等 pending 重新变回 null 时按序执行。
   *
   * 用途：触发技（钩子）里发起「选择一项」时，不能就地接着往下跑——会被后续代码
   * 覆盖掉 pending。于是把「剩下的钩子 + 调用方原本要做的事」压进这个队列，
   * 由 applyIntent 末尾的 drainResume 在 pending 为空时接着执行。
   *
   * 放进队列而不是挂在 pending 上，是为了让**级联**也正确：如果这次询问的结果
   * 又引发了濒死等新流程，队列会一直等到那串流程走完、pending 再次为空才继续。
   */
  resumeQueue: (() => void)[];

  /**
   * 判定阶段里**已经拿在手上、还没结算完**的判定牌（延时锦囊）。
   *
   * 为什么要有这本台账：`processJudgmentPhase` 一上来就把 `player.judgment` 清空，
   * 把整叠牌拿进局部数组逐张往下递（这样「闪电移到下家判定区」才不会两头都在）。
   * 可一旦判定者本人死在这一步（最典型：自己的【闪电】把自己劈死），死亡清场会接管流程，
   * 判定阶段**再也不会往下走**——那叠还攥在闭包里的牌就彻底没了（实测 seed=1405：
   * 一张【兵粮寸断】跟到游戏结束都没回场上）。死亡清场照着这本台账把它们一并弃置。
   */
  judgmentInFlight: { seatId: string; cards: Card[] } | null;

  /**
   * 「本轮」每个座位**造成**的伤害总量（君主·励众：「本轮造成过伤害且造成伤害值最多的角色」）。
   *
   * 与 `damagedThisTurn`（本回合**受到**过伤害的人）不是一回事：那个是受伤视角、且只活一个回合。
   * 这里是「造成」视角，生命周期是**一轮**（从首位走到末位、再回到首位时清空，见 engine 的回合交替处）。
   */
  damageThisRound: Record<string, number>;
  /**
   * 君主专属装备的**发号器**：每次「从游戏外获得专属装备」都造一张新牌，id 必须唯一。
   *
   * 为什么不能写死 id：那张牌不是场外的一张固定实体——它可以被顺手牵羊拿走（进手牌，
   * 于是【君威】的「场上没有【你的专属装备】」重新成立），此时再发动【君威】就会造出第二张。
   * 用固定 id 的话两张牌同 id，「一张牌同时存在两个区域」这类不变式立刻被破坏
   * （模糊测试抓到的：`step` 里让技能带牌发动之后，君威才第一次真的被跑到）。
   * 记在 state 上而不是模块级计数器，否则同一个种子重放出来的 id 会不一样。
   */
  lordEquipSeq: number;
  /**
   * 「本回合用过哪些国战标记」——君刘备·章武要「视为使用1枚**与你势力相同的角色本回合使用过**
   * 的国战标记」，所以每次真用掉一枚就记一笔（记在**用的人**头上）。
   *
   * 与 `damagedThisTurn` / `killedThisTurn` 一样是每回合清空的账本（`startTurn` 里清）。
   * 同一枚被同一人用多次就记多条，章武那边按标记 id 去重成选项。
   */
  markerUsesThisTurn: { seatId: string; markerId: MarkerId; usage: MarkerUsage }[];
  /**
   * 【授锋】的「本回合出牌阶段用掉的第一张伤害牌」（君袁绍）。
   *
   * 「首张」必须记在**使用的那一刻**（引擎在 `markCardUsed` 里顺手登记），不能等结算结束
   * 再判断：青龙偃月刀那种「第一张【杀】结算到一半又用出第二张」的情况下，第二张的结算
   * 会先结束，按结算顺序数就会把第二张当成首张。记下 id，结算结束时对一下。
   *
   * ⚠️ 用完**不能清成 null**：这本账的 null 含义是「这个出牌阶段还没有伤害牌被使用」，
   * 清掉的话同一回合的第二张伤害牌会重新被当成「首张」（写测试时踩到过）。
   * `resolved` 才是「这条已经派发过了」——同一张牌在寄篱那类重跑路径上可能走到两次出口。
   * 生命周期一个回合（`startTurn` 清成 null）。
   */
  firstDamageCard: {
    seatId: string;
    /** 使用时那张「生效牌」的 id（丈八是虚拟【杀】的 id，用来和结算出口对上） */
    cardId: string;
    /**
     * 这次使用**对应的实体牌** id 列表（用户给定的实现口径）：
     * 普通牌＝它自己；丈八两张牌凑的虚拟【杀】＝那两张；纯「视为使用」＝空。
     * 【授锋】的「获得此伤害牌」就是照这张表去弃牌堆逐张取——所以必须在**使用的那一刻**
     * 记下来，不能等触发时再去找「刚才那张牌」。
     */
    cardIds: string[];
    resolved: boolean;
  } | null;
  /**
   * 「本回合已经因【雄驰】问过一次」的角色（君曹操）。
   *
   * 【雄驰】是「当你**每回合第一次**造成伤害后」——「每回合」指场上每一个回合，
   * 不是只有自己的回合，所以不能靠 `PlayerFlags`（那套只在自己回合开始时清）。
   * 生命周期一个回合：与 `damagedThisTurn` 一起在 `startTurn` 清空。
   */
  xiongchiDoneSeats: string[];
  /**
   * 排队的额外回合（刘禅·放权、挟天子以令诸侯）。
   * 当前回合结束后先结算队首：该角色（存活的话）进行一个额外回合。
   */
  extraTurns: string[];
}

// —— 查询辅助 ——
export function getPlayer(state: GameState, seatId: string): Player | undefined {
  return state.players.find((p) => p.seatId === seatId);
}

export function getPlayerOrThrow(state: GameState, seatId: string): Player {
  const p = getPlayer(state, seatId);
  if (!p) throw new Error(`unknown seat ${seatId}`);
  return p;
}

/** 从 fromIndex 起（含）下一个存活的座次下标 */
export function nextAliveSeat(state: GameState, fromIndex: number): number {
  const n = state.seatOrder.length;
  for (let i = 1; i <= n; i++) {
    const idx = (fromIndex + i) % n;
    const p = getPlayer(state, state.seatOrder[idx]!);
    // 调虎离山：不计入座次的角色直接从环里跳过
    if (p?.alive && !p.flags.removedFromSeating) return idx;
  }
  return fromIndex;
}

/** 从某座次起、按回合顺序的存活玩家 seatId 列表（含起点） */
export function aliveSeatsFrom(state: GameState, startSeatId: string): string[] {
  const startIdx = state.seatOrder.indexOf(startSeatId);
  if (startIdx < 0) return [];
  const n = state.seatOrder.length;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const idx = (startIdx + i) % n;
    const seat = state.seatOrder[idx]!;
    const p = getPlayer(state, seat);
    if (p?.alive && !p.flags.removedFromSeating) out.push(seat);
  }
  return out;
}

export function alivePlayers(state: GameState): Player[] {
  return state.players.filter((p) => p.alive);
}

/**
 * 把牌放进弃牌堆。**这是唯一的入口**——直接 `state.discard.push` 会绕过本回合账本，
 * 让「本回合进入弃牌堆的牌」这类技能算错。
 *
 * 【木牛流马】被弃置时，它下面扣置的牌要**一同进弃牌堆**——所以卸载也放在这里：
 * 这是「进弃牌堆」的唯一入口，放在这里就不会漏掉任何一条弃置路径（被拆/被替换/主动弃）。
 */
export function toDiscard(state: GameState, ...cards: Card[]): void {
  for (const c of cards) {
    // 势力锦囊（不臣篇）：**要进弃牌堆时改为销毁**（＝移出游戏）——移动版口径，不建「府库」区
    if (FACTION_TRICK_TYPES.has(c.type)) {
      state.exiled.push(c);
      pushLog(state, 'discard', `【${CARD_TYPE_NAME[c.type]}】移出游戏（势力锦囊不进弃牌循环）。`);
      continue;
    }
    // 「离开装备区后销毁之」的牌（君主专属装备）：**移出游戏**，不进弃牌堆。
    // 官方文本就写在牌面上（例：【飞龙夺凤】「当此牌离开装备区后，销毁之」）。
    if (c.destroyOnLeave) {
      pushLog(
        state,
        'discard',
        `【${c.equipName ? (EQUIP_NAME[c.equipName] ?? c.equipName) : CARD_TYPE_NAME[c.type]}】离开装备区，销毁之（移出游戏）。`,
      );
      continue;
    }
    // 先递归卸载辎，再收这张装备牌自己（顺序不影响结果，但日志读起来更顺）
    if (c.cargo && c.cargo.length > 0) {
      const cargo = c.cargo;
      c.cargo = [];
      pushLog(state, 'discard', `【木牛流马】下扣置的 ${cargo.length} 张牌一同进入弃牌堆。`);
      toDiscard(state, ...cargo);
    }
    state.discard.push(c);
    state.discardThisTurn.push(c);
  }
}

/** 本回合进入弃牌堆的**红桃**牌数（孟获·再起）。 */
export function heartCardsInDiscardThisTurn(state: GameState): number {
  return state.discardThisTurn.filter((c) => c.suit === 'heart').length;
}

/**
 * 回复体力：夹到体力上限，返回**实际**回复量。
 *
 * 只做数值部分——**不触发**「回复体力后」的技能。要触发请用引擎里的
 * `healAndTrigger`（engine.ts），它在本函数之后跑 `afterHeal` 钩子；
 * 分开是为了让 model 层不依赖引擎。
 */
export function healPlayer(player: Player, amount: number): number {
  if (amount <= 0 || !player.alive) return 0;
  const before = player.hp;
  player.hp = Math.min(player.maxHp, player.hp + amount);
  return player.hp - before;
}

/** 日志附加信息：谁做的、做的什么动作（供客户端配语音/音效用） */
export interface LogExtra {
  /** 触发者座次 */
  seat?: string;
  /** 语义化动作标识，见 protocol 的 LogEntry.action */
  action?: string;
}

export function pushLog(state: GameState, kind: string, message: string, extra?: LogExtra): void {
  state.log.push({ id: state.logSeq++, kind, message, ...extra });
  // 保留最近 200 条，避免无限增长
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}
