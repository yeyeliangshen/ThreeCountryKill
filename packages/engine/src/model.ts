import type {
  Card,
  CardType,
  DamageAttribute,
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
   * 非锁定技失效（新国战·铁骑那类）：本回合内该角色的非锁定技全部不起作用。
   * 由 afterTurnEnd 统一清掉（「直到回合结束」）。
   */
  nonLockedSkillsDisabled: boolean;
  /**
   * 本回合不能使用或打出手牌（军令「本回合不能使用或打出手牌」那一项）。
   * 比 skipPlay 窄：还能发动技能、结束阶段照常。
   */
  cannotPlayCardsThisTurn: boolean;
  /** 本回合不能回复体力（军令「翻面且本回合不能回复体力」那一项） */
  cannotHealThisTurn: boolean;
  /** 国战：双将首次同时明置的奖励（阴阳鱼/珠联璧合）是否已结算过 */
  revealRewarded: boolean;
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
    dealtDamageThisTurn: false,
    skipJudgment: false,
    handLimitBonus: 0,
    drawCountDelta: 0,
    damageBonusThisTurn: 0,
    ignoreShaDistanceThisTurn: false,
    nonLockedSkillsDisabled: false,
    cannotPlayCardsThisTurn: false,
    cannotHealThisTurn: false,
    revealRewarded: false,
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
   * 通过觉醒技/化身等途径「获得」的技能：从别的武将身上借来的。
   * 只记来源武将 id 与技能名，具体怎么摘见 heroes.grantedHeroes。
   */
  grantedSkills: { heroId: string; skillName: string }[];
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
  card: Card;
  // 过河拆桥/顺手牵羊：目标与指定的明牌区牌
  targetId?: string;
  targetCardId?: string;
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
    }
  // 弃牌阶段：弃到上限
  | { kind: 'discard'; seatId: string; count: number }
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
  // 主动技能：出牌阶段使用主动技能（多步交互时暂停）
  | { kind: 'activeSkill'; seatId: string; skillId: string }
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
      /** 选完怎么继续。收到的是被选中的**牌对象**，不用再去找 */
      resolve: (state: GameState, player: Player, picked: Card[]) => void;
      /**
       * 选完把控制权还给谁。钩子发起的不传（走续接队列）；技能发起的必须传。
       */
      returnTo?: string;
      /** 选牌内容是不是秘密（观星）：是则日志只记张数，不记牌名 */
      secret?: boolean;
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
    };

// 选将阶段：每人随机发到 K 张武将，各自选 1（并发，全选完才开局）
export interface DraftState {
  deals: Record<string, string[]>; // seatId -> 该座发到的 K 个 heroId
  pendingSeats: string[]; // 尚未选将的 seatId
}

/**
 * 铁索连环蔓延的待续状态。
 * 被濒死打断时暂存在 GameState 上，等濒死结算完由 resumePlay 接着跑
 * ——和 AOE 锦囊用 ongoingTrick 是同一个套路。
 */
export interface ChainPending {
  attack: AttackContext;
  damage: number;
  /** 还要蔓延到的座次（按顺序） */
  rest: string[];
  index: number;
}

export interface GameState {
  roomCode: string;
  mode: GameMode; // 当前对局模式
  players: Player[];
  seatOrder: string[]; // 回合顺序
  deck: Card[];
  discard: Card[];
  turn: { seatIndex: number; phase: Phase };
  pending: Pending | null;
  draft: DraftState | null; // 非空表示处于选将阶段
  // AOE锦囊(南蛮/万箭)被濒死中断时暂存上下文，near-death结算后继续下一个响应者
  ongoingTrick: TrickContext | null;
  /** 铁索连环蔓延被濒死中断时暂存，濒死结算后继续 */
  ongoingChain: ChainPending | null;
  /**
   * 本回合**受到过伤害**的座次（董昭·劝进只能对这些人发动）。
   * 在 runHooks 分发 afterDamage 时统一登记，所以不用去每处伤害点加代码。
   */
  damagedThisTurn: string[];
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
