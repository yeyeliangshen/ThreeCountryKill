import type { Card, CardType } from './card';
import type { Phase } from './intent';

// —— 游戏模式 ——
export type GameMode = 'junzheng' | '2v2' | 'melee' | 'guozhan';

/** 各模式的中文名（界面上的模式选择、房间列表、对局标题都用这一份） */
export const MODE_NAME: Record<GameMode, string> = {
  junzheng: '军争',
  '2v2': '2v2',
  melee: '混战',
  guozhan: '国战',
};

// —— 身份（军争模式） ——
export type RoleId = 'lord' | 'loyal' | 'rebel' | 'renegade';

// —— 阵营（国战模式） ——
export type Faction = 'shu' | 'wei' | 'wu' | 'qun' | 'neutral' | 'ambitionist';

// —— 国战标记 ——
// 获得与用法见 docs/guozhan-reference.md §2。
export type MarkerId = 'xianqu' | 'yinyangyu' | 'zhulian' | 'ambitionist';

export const MARKER_NAME: Record<MarkerId, string> = {
  xianqu: '先驱',
  yinyangyu: '阴阳鱼',
  zhulian: '珠联璧合',
  // 野心家标记仅钟会、司马昭可获得，这两名武将未收录，所以引擎目前不会发放它。
  ambitionist: '野心家',
};

/** 标记的固定显示顺序（界面与快照都按它排，免得顺序随对象插入序乱跳） */
export const MARKER_ORDER: MarkerId[] = ['xianqu', 'yinyangyu', 'zhulian', 'ambitionist'];

// —— 服务端按玩家裁剪后下发的"视图"，不泄露他人手牌 ——

// 单个玩家的公开信息
export interface PlayerView {
  seatId: string;
  name: string;
  heroId: string | null; // 选将阶段未定，为 null
  hp: number;
  maxHp: number;
  handCount: number;
  isAlive: boolean;
  // 装备区（公开）：非空槽位的牌
  equipment: Card[];
  // 判定区（公开）：延时锦囊牌
  judgment: Card[];
  // 身份（军争）：主公对所有人公开，其余仅本人可见（他人视图为 null）
  role?: RoleId | null;
  // 队伍（2v2）：公开
  team?: 0 | 1 | null;
  // 副将（国战）：暗置时对他人为 null
  deputyHeroId?: string | null;
  // 阵营（国战）：未亮将时对他人为 null
  faction?: Faction | null;
  // 主将是否已亮将（国战公开信息）
  heroRevealed?: boolean;
  /** 被【断肠】点名的那张武将牌 id：它的技能全没了（界面上别再列它的技能） */
  nullifiedHeroId?: string | null;
  /** 已被移除的武将牌（国战：用士兵牌顶替，没有技能，但势力/性别/体力上限保留） */
  removedHeroIds?: string[];
  /** 武将牌上的「田」张数（邓艾·屯田） */
  tianCount?: number;
  /** 武将牌上的「千幻」张数（于吉·千幻） */
  qianhuanCount?: number;
  /** 武将牌上的「魂」张数（左慈·役鬼） */
  hunCount?: number;
  /**
   * 【役鬼】「魂」的**具体武将牌**（名字 + 势力）——**只发给持有者本人**（用户 2026-09-25 口径 §六：
   * 「魂」是私有资源：本人看得到是哪张武将、什么势力，别人只知道**数量**）。
   * 别人的快照里没有这个字段（只有 `hunCount`）。
   */
  hunNames?: string[];
  /**
   * **这个角色此刻是否处在「队列」里**（连续相邻的同势力角色 ≥ 2 人，与鸟翔/鹤翼、
   * 以及姜维·天覆用的是同一份判据）。公开信息——界面就此在那张牌上加一枚很轻的「队」标记
   * （用户 2026-09-24 口径 §六：不要大动画，信息本来就多）。
   */
  inFormation?: boolean;
  /**
   * **当前公开的性别**（界面上的 ♂ / ♀ / ?）：
   * - `'male'` / `'female'`：按**明置**的武将算，主副均明置时取**主将**；
   * - 不给这个字段（或 `undefined`）：**性别未确定**（全暗置）——离间这类「只能选男性」
   *   的技能**不认**他，也不许界面去翻暗将底牌猜（用户 2026-09-25 §十七）。
   *
   * ⚠️ 与 `faction` 一样属于**公开信息**：判据在引擎（`heroes.publicGender`），界面只显示。
   */
  gender?: 'male' | 'female';
  /**
   * 【天覆】此刻的形态（**只发给本人**，他技能栏里的说明要跟着变）：
   * - `'formation'`：与我同队列的人的回合内 ⇒ **黑色**手牌可当【无懈可击】；
   * - `'normal'`：其余情况 ⇒ **我自己的回合**内、**黑桃**手牌可当【无懈可击】。
   * 判据在引擎（`heroes.tianfuMode`），界面只显示，不自己算。
   */
  tianfuMode?: 'normal' | 'formation';
  /**
   * 国战【空城】第二段扣在武将牌上的**暂存牌张数**（诸葛亮，公开信息）。
   * ⚠️ 只下发张数：内容是暗信息（交给时就是扣着给的），谁都不该看到牌名。
   */
  kongchengCount?: number;
  /** 周泰·不屈的「创」：扣在武将牌上的牌（公开信息） */
  wounds?: Card[];
  /** 孟达·【求安】的「函」（公开信息） */
  han?: Card[];
  /** 界钟会·【权计】的「权」：公开放在武将牌旁的**实体牌** */
  quan?: Card[];
  /**
   * 陆逊（国战）·【谦逊】收下的「节」：扣在武将牌上的**实体牌**，公开信息（最多 3 张）。
   * 【度势】选项二要「三张「节」置入弃牌堆」，所以**张数**是玩家必须看得到的信息。
   */
  jie?: Card[];
  /** 孙綝·【嗜戮】的「戮」：**武将牌**（公开）→ 只下发数量与牌名 */
  luCount?: number;
  luNames?: string[];
  /** 公孙渊·【怀异】的「异」（公开信息） */
  yi?: Card[];
  /** 颜良文丑·双雄：本回合判定牌的颜色（本回合可把异色手牌当【决斗】用） */
  shuangxiongColor?: 'red' | 'black' | null;
  // 副将是否已亮将（国战公开信息）
  deputyRevealed?: boolean;
  // 国战标记（公开信息）：持有数量 > 0 的标记
  markers?: { id: MarkerId; label: string; count: number }[];
  /**
   * 【荐才】（徐庶·副将技）「获知」的**尚未登场的同势力武将牌**。
   * 这是**私有信息**：只有本人那一份快照里才有，别人的快照里连字段都没有。
   */
  knownHeroes?: { id: string; name: string }[];
  // 武将牌是否翻面朝上（公开信息）：为 true 时该角色跳过下一个回合
  flipped?: boolean;
  /** 是否处于横置状态（铁索连环，公开信息） */
  chained?: boolean;
  /**
   * 国战「预亮」的技能名。**只给自己的那一份快照**——预亮是对手看不到的信息
   * （线上只知道「某人有技能想发动」，不知道是哪个技能）。
   */
  prelitSkills?: string[];
  /**
   * 国战：现在**可以**预亮的技能名（暗置武将上的触发技与转化技）。
   *
   * 同样只给自己。放在快照而不是出牌提示里，是因为预亮必须**随时**能做——
   * 别人的回合里你也要能把【反馈】预亮上，否则等你自己的回合才允许预亮就没意义了。
   * 具体哪些技能可预亮只有引擎说了算（锁定技/主动技/常驻字段技都不在里面）。
   */
  prelitableSkills?: string[];
}

export type PromptKind =
  | 'play'
  | 'respondSha'
  | 'respondDeath'
  | 'discard'
  | 'pickHero'
  | 'respondTrick'
  | 'wuxieQueue'
  | 'choice' // 通用「选择一项」
  | 'pickCards' // 从一组牌里选若干张
  | 'pickSeats' // 一次选多名角色（多选座位原语）
  | 'viewCards' // 私密查看（知己知彼）：只有本人看得到内容
  | 'factionCall'; // 势力技：依次问同势力角色是否代打一张牌

// 告诉玩家当前需要做什么 + 合法选项（服务端权威计算后下发）
/**
 * 「操作**别人区域里的牌**」的分区布局（用户 2026-09-23 的口径）。
 *
 * 结构就按用户画的那张图：**不同角色横向分栏**；同一个角色内部按 `hand / equip / judge`
 * **纵向分区**（手牌在上、装备在下、判定区只在规则允许操作它时才出现）；**不写区名文字**——
 * 靠位置区分。隐藏信息一律画牌背。
 *
 * ⚠️ 它只是**布局描述**：点某一张仍然发 `chooseOption(item.optionId)`（每个 item 自带 optionId），
 *    所以引擎侧的解析与既有用例完全不受影响。
 * ⚠️ 分工：**规则层决定「能操作谁的哪些区、要几张」**（zones/count 由引擎算好），
 *    **牌面还是牌背由可见性决定**（`item.card` 有没有值就是规则层给的可见性判断，
 *    技能不许自己决定「这张画牌背」）。
 */
export interface ZonePickItem {
  /** 点这一张要发的 optionId（交给 `chooseOption`） */
  optionId: string;
  /** 正面展示的牌（装备/判定/已公开的手牌）；**隐藏的手牌不带它** ⇒ 界面画牌背 */
  card?: Card;
}

export interface ZonePickZone {
  /** 区域名（界面**不显示**这几个字，只用它决定位置与样式） */
  zone: 'hand' | 'equip' | 'judge';
  items: ZonePickItem[];
}

export interface ZonePickTarget {
  seatId: string;
  zones: ZonePickZone[];
}

export interface ZonePickLayout {
  targets: ZonePickTarget[];
  /** 已经选了几张（多步选择时由后续询问更新） */
  picked?: number;
  /** 还要选几张 */
  required?: number;
}

export interface PromptView {
  kind: PromptKind;
  message: string;
  // 可用的牌 id
  legalCardIds: string[];
  // 可选的目标 seatId
  legalTargetIds: string[];
  // 此提示需要选几个目标
  mustSelectTargetCount: number;
  // 选将阶段：发给我的武将 id 列表（仅 pickHero 有）
  legalHeroIds?: string[];
  /**
   * 选将阶段：**白捡的另一版**武将（仅 pickHero 有，国战「君主↔标准版」）。
   *
   * 发将是不重叠发牌（一张武将牌只在一个人的选项里），所以「发到曹操就等于也拿到君曹操」
   * 只在**君曹操没发到别人手里**时成立；这一栏就是那些确实没人拿、可以随便换的版本。
   * 界面用它决定要不要显示「换成君主将 / 换成标准版」按钮。
   */
  draftVariants?: string[];
  // 出牌阶段：可用的主动技能 id 列表（仅 play 有）
  /** 出牌阶段：可以「连横」交给哪些角色（势备篇，非空即说明手上有带标记的牌） */
  lianhengTargets?: string[];
  /**
   * 此刻能不能用【丈八蛇矛】把**两张手牌**当【杀】使用或打出。
   *
   * 出牌阶段与「需打出【杀】」的响应（南蛮/决斗/借刀/离间的杀、势力技代打杀）都可能为真。
   * 为真时 `legalCardIds` 里是**整手牌**——因为任意两张凑一起都能成【杀】，
   * 界面据此给出「两张手牌当【杀】」那条用法。
   */
  zhangbaOk?: boolean;
  /**
   * 出牌阶段：这批「牌 + 用法」此刻**可以把使用者自己选为目标**（仅 play 有）。
   *
   * 口径（用户 2026-09-24）：**能不能选自己由每张牌/每个技能的文本决定，不能由通用目标选择
   * UI 决定**。所以这一栏由**服务端**算好下发，界面只按它点亮自己那一栏——界面**不许**自己
   * 加一条「不能选自己」的通用规则，也不许自己按牌名硬编码（见 `cardTargetExcludesSelf`）。
   *
   * 用「牌 + 用法」而不是只给 cardId：同一张牌可能有多种用法，而「能否选自己」是**用法**的属性
   * ——卧龙的红【决斗】按【决斗】用（目标限「其他角色」）与按【火攻】用（「一名有手牌的角色」）
   * 就是两个答案。界面选中某条用法后，用 `(cardId, as ?? 牌面牌型)` 在这份清单里比对。
   */
  selfTargetUses?: { cardId: string; type: CardType }[];
  legalSkillIds?: string[];
  /**
   * 出牌阶段：可用主动技能的完整信息（仅 play 有）。
   *
   * 界面直接用这份渲染按钮，不要再拿技能名去 hero.skills 里配对——
   * 那样改名就会失效，而且标记带来的技能不属于任何武将，根本配不上。
   */
  /**
   * 现在可以点的主动技能。**带上选择参数**：标记技能（阴阳鱼/先驱/珠联璧合/野心家）
   * 不属于任何武将，界面在本地武将表里查不到定义，只能靠这份数据驱动「选牌/选目标」——
   * 见 ui 的 enterSkillMode（用户 2026-09-21：阴阳鱼点了没反应就是这个缺的）。
   */
  legalSkills?: {
    id: string;
    name: string;
    desc: string;
    needsCards: boolean;
    minTargets: number;
    maxTargets: number;
    /**
     * 代价牌能取自哪个区（**界面必须严格按它放行**，用户 2026-09-21 口径）：
     * - `'hand'`（缺省）：文本写「手牌」→ 只让点手牌；
     * - `'handEquip'`：文本写「一张牌」→ 手牌**和**自己装备区的牌都可点。
     */
    costFrom?: 'hand' | 'handEquip';
    /**
     * 这个技能**自己的目标规则**里，使用者自己可以被指定为目标吗？
     *
     * 与牌同一条口径（用户 2026-09-24）：技能文本写「一名**其他**角色」的 ⇒ 不置此位
     * （引擎侧由 `ActiveSkill.selfTarget` 缺省值统一拦；界面也据此不点亮自己）；
     * 写「一名角色」的（青囊/凶算/甘露/排异/存嗣）⇒ `true`。
     */
    selfTarget?: boolean;
    /**
     * **这个技能**自己的可点目标（缺省＝所有其他存活角色）。
     *
     * 例：貂蝉·离间只能选**男性**角色 ⇒ 这里只列男性（按**当前公开性别**算：
     * 全暗置＝未确定，不算男性）。界面据此把女性/未确定的角色**置灰**，
     * 而不是让玩家点了才被引擎拒绝（用户 2026-09-25 §十七 口径）。
     */
    legalTargets?: string[];
    /**
     * **有序目标**每个位置的角色说明（第 i 项＝第 i 个目标是什么角色）。
     *
     * 例：貂蝉·离间 `['【决斗】的目标', '发动【决斗】的角色']`——现行文本是
     * 「依次选择两名男性其他角色，令**后者**对**前者**使用【决斗】」，
     * 光看文本极易点反，所以界面要把每个已选角色**担任的角色**标出来。
     */
    targetSlotLabels?: string[];
    /**
     * **方向预览模板**（引擎给文本，`{1}`/`{2}`… 是第 i 个已选目标的名字）。
     * 例：离间 `'{2} ──【决斗】──▶ {1}'`——「令后者对前者」光看文本很难记，
     * 界面把它直接画成「谁对谁用决斗」。规则文本留在引擎，界面只做占位替换。
     */
    targetPreview?: string;
    /**
     * **合法目标「对」**：限制落在**一对目标**上的技能才给（目前只有吴国太·甘露）。
     *
     * 每个元素是一对座次 id，例如 `[['s0','s2'], ['s1','s2']]`。界面据此做**动态过滤**：
     * 选完第一个目标之后，把「跟他凑不出任何合法对」的座位直接置灰
     * （用户 2026-09-25 口径：不能让玩家自己去算「3 和 1 差多少」）。
     * 引擎侧在 `execute` 里照样再校验一遍——界面只是帮忙，不是判据。
     */
    legalTargetPairs?: string[][];
    /**
     * 界面预览形态（纯展示）：`'equipSwap'` ⇒ 两个目标选好后在中央列出**双方装备区**要求确认
     * （吴国太·甘露：换的是整个装备区，玩家不挑具体装备）。见 `ActiveSkill.preview`。
     */
    preview?: 'equipSwap';
  }[];

  // 「选择一项」提示（仅 choice 有）
  choiceTitle?: string;
  choiceOptions?: { id: string; label: string }[];
  /**
   * 从一组牌里选（仅 pickCards 有）。
   *
   * 给的是**完整牌面**而不是 id：这组牌不一定在手牌里——观星看的是牌堆顶，
   * 界面拿 id 去 myHand 查是查不到的。
   */
  pickTitle?: string;
  /**
   * 多选座位的候选座位（仅 `pickSeats` 有）：界面据此把这几家的面板点亮、可点。
   * 至多/至少几个看 `pickMin` / `pickMax`（与选牌共用）。
   */
  seatCandidates?: string[];
  pickCards?: Card[];
  /**
   * **这批候选对选择者是否隐藏**（「从其他角色未知手牌中选牌」的通用盲选，用户 2026-09-22 口径）。
   *
   * 为 true 时：`pickCards` 里**只填 id**（服务端不下发牌面），界面必须画**牌背**——玩家只看到
   * 张数与可选位置，点牌背按 id 选择；被选中的牌在规则要求公开之前**不许翻开**。
   * 规则层负责「能操作谁的哪些牌」，界面只按可见性画牌面还是牌背。
   */
  pickHidden?: boolean;
  /** 这些候选属于谁（盲选时用来标注「在看谁的手牌」） */
  pickOwnerSeatId?: string;
  /**
   * 其中**已经因其他效果公开**的那几张的 id（可见性由规则层判定，界面不猜）：
   * 它们照常画牌面——已公开的牌不能假装看不见。
   */
  pickVisibleIds?: string[];
  pickMin?: number;
  pickMax?: number;
  /**
   * 这一手选牌是**从牌桌上公开摆着的牌池里拿**（【五谷丰登】）：
   * 界面不要再画通用的选牌框，改为让玩家**直接点牌桌中央那张牌**（点完立即拿走）。
   */
  pickFromPool?: boolean;
  /** 「操作别人区域里的牌」的分区布局（见 ZonePickLayout）：界面据此画多栏 + 分区 */
  zonePick?: ZonePickLayout;
  /**
   * 私密查看（知己知彼）的标题 / 内容。
   * 内容只有发起者本人的快照里有——其他座位即使是同一个 pending 也拿不到。
   */
  viewTitle?: string;
  viewCards?: Card[];
  /** 不是牌的信息（暗置武将牌的名字） */
  viewNote?: string;
  /**
   * 势力技（护驾/激将）：你现在需要打出 needType，可以令这些同势力角色代打。
   * 有值就该在界面上给一个「发动【护驾】」的入口（仅 respondSha / respondTrick 可能有）。
   */
  factionCall?: {
    skillId: string;
    skillName: string;
    needType: CardType;
    helpers: { seatId: string; name: string }[];
  };
}

export interface LogEntry {
  /** 对局内自增序号（快照只带最近若干条，客户端靠它识别新事件） */
  id: number;
  message: string;
  kind: string;
  /** 触发这条日志的座次。客户端据此取该角色的信息（如性别，用于选语音） */
  seat?: string;
  /**
   * 语义化的动作标识，如 'sha' / 'sha-fire' / 'shan' / 'tao' / 'equip' / 'wuxie' /
   * 'juedou' …。客户端用它找对应的音效与语音。
   *
   * 注意是「实际动作」而不是牌面类型：关羽用【万箭齐发】发动武圣当【杀】时，
   * 这里应该是 'sha' 而不是 'wanjian'——语音要念「杀」。
   */
  action?: string;
}

// 大厅阶段的座位
export interface SeatView {
  seatId: string;
  name: string | null;
  isHost: boolean;
  connected: boolean;
  heroId: string | null;
}

/**
 * 大厅房间列表里的一张卡片。
 *
 * 只给「概况」——进了房间才拿 `lobby`（完整座位表）。
 * `players` 数的是**占着座位的人数**，不看在不在线：离线/锁屏/刷新的人还算占着，
 * 所以他们能认回座位，房间也不会因为一次断线就被判成空房。
 */
export interface RoomSummary {
  roomCode: string;
  /** 房主昵称（房主一定存在；房主离开时会把身份移交给房间里另一个人） */
  hostName: string;
  players: number;
  maxSeats: number;
  mode: GameMode;
  /** 已开局：大厅里显示但进不去 */
  started: boolean;
}

// 下发给某个玩家的完整快照
/**
 * 拼点区里**一方**的牌位（用户 2026-09-23 要求牌桌中央有一块独立的拼点 UI）。
 *
 * ⚠️ 关键约束：**双方都扣好之前，服务端一次都不下发牌面**（只有 `chosen`）。
 * 所以「先牌背、后翻牌」不是界面演出来的——牌面根本没到客户端（与盲选同一条规矩）。
 */
export interface PindianSideView {
  seatId: string;
  /** 这一方是否已经扣好牌（扣好后牌位先显示**牌背**） */
  chosen: boolean;
  /** 是不是发起者（拼点由一方发起：起点在发起者身上） */
  isInitiator?: boolean;
  /** 亮出的那张牌——**只有 `revealed` 为真时才有** */
  card?: Card;
  /** 比大小用的点数（鹰扬那类改判之后的值）——**只有 `revealed` 为真时才有** */
  point?: number;
}

/**
 * **牌桌上公开摆着的牌池**（【五谷丰登】这类「亮出若干张、按顺序依次拿」的牌）——
 * 用户 2026-09-23 的规格：平铺在**牌桌中央**，谁都能看到，按正常顺序依次点牌拿走，
 * 拿走的那张**立刻从展示区消失**（位置保留成「被谁拿走」的痕迹），剩余牌实时更新。
 *
 * 公开信息（亮出来的牌本来就是明的），所以整份快照都能下发。
 */
export interface PublicPoolView {
  /**
   * 固定顺序的**位置**：被拿走的牌**留在原位**并标上 `takenBySeatId`，
   * 这样「第几张被谁拿走了」一眼看得出（就是牌桌上摆一排牌的感觉）。
   */
  slots: { card: Card; takenBySeatId?: string }[];
  /** 现在轮到谁选（全拿完就没有这个字段了） */
  currentSeatId?: string;
  /** 还要按顺序选的人（含当前这位） */
  queue: string[];
  /** 池子是哪张牌亮出来的（界面用来画标题，如【五谷丰登】） */
  source: CardType;
  /** **本人**现在能不能点牌（规则层算好，界面不用猜） */
  interactive: boolean;
}

/** 拼点（当前/最近一次）的完整状态：牌桌中央那块区域就靠它渲染 */
export interface PindianView {
  sides: PindianSideView[];
  /** 双方都扣好了、已经翻开 */
  revealed: boolean;
  /** 赢家座位；平点时为 null（`revealed` 为真后才有意义） */
  winnerSeatId?: string | null;
  /** 是不是平点（`revealed` 为真后才有意义） */
  tie?: boolean;
}

/**
 * **属性伤害沿横置（连环）角色传导**的瞬时视图（用户 2026-09-24 口径④）。
 *
 * 为什么需要它：传导的**结算顺序**只有引擎知道——`queueChainSpread` / `chainStep` 是
 * **有序**的（名单是那一刻的 `state.players` 顺序），而整段传导通常在**同一条 intent 里
 * 同步跑完**（只有中途打出濒死/询问才会分帧）。所以界面拿到的两份相邻快照里，
 * `players[].chained` 会「一下子全变成 false」，光靠 diff 拿不到先后。
 * 这里把顺序**明写**进快照：客户端照 `order[].index` 排动画，顺序永远是引擎的。
 *
 * ⚠️ 只带**座次 + 序号**，不带任何牌面（与 `pindianView` 同一条「服务端把关」的规矩）。
 * 与拼点区同一生命周期：**下一次任何 intent 时清空**（`applyIntentInner` 里与
 * `pindianView` 一起清），动画播完就收起来。
 */
export interface ChainSpreadView {
  /** 本次传导的局内自增号：界面靠它认出「这是新的一次传导」并重播一遍动画 */
  seq: number;
  /** 触发这次传导的座次：受到属性伤害、并因此被重置的那一位（传导的源头） */
  fromSeatId: string;
  /** 还要按顺序传导到的座次——**顺序就是引擎的实际结算顺序**，`index` 从 1 起 */
  order: { seatId: string; index: number }[];
}

/**
 * **「某个技能正在发动 / 触发」的瞬时视图**（用户 2026-09-25 口径①~④：统一的技能展示 UI）。
 *
 * 为什么要有这一份结构化视图：其他角色发动技能时，本地玩家以前只能看到**最终结果**
 * （血量/手牌变了、日志多了一行），认不出「刚才是哪个技能、它现在结算到哪一步」。
 * 界面**不许**去正则匹配日志里的中文技能名，所以引擎把「谁、哪个技能、还在不在结算」
 * 明写在这里下发。
 *
 * 写入点是**唯一的**：`pushLog` 里凡是带技能的日志（`kind === 'skill'`）都会顺手盖上
 * 「此刻正在跑的那个技能」（`withSkillCtx` 在钩子派发 / 主动技执行处声明，见 model.ts）。
 * 这样**所有**武将（含将来新增的）都自动走上同一条事件源，不必逐个武将写提示逻辑，
 * 也不会为「注册了钩子但其实没发动」的技能误报（没写日志＝没发动）。
 *
 * 生命周期：下一次**已经结算完**的 intent 时让位（`applyIntentInner`）；
 * 仍在等某人回答（`settling`）的留着——用户口径③「等待响应或多步结算期间保持提示」。
 */
export interface SkillFxView {
  /** 自增号：界面靠它认出「这是新的一次发动」（同一份快照重复到达时不重播） */
  seq: number;
  /** 发动者座次：提示就贴在他那张牌 / 武将面板附近 */
  seatId: string;
  /** 技能拼音 id（只有主动技有；触发技的钩子只登记中文名，见 HookRegistration.skillId） */
  skillId?: string;
  /** 技能中文名（展示用；也是界面查技能描述的唯一键） */
  skillName: string;
  /**
   * **这次发动还在结算中吗**：引擎口径＝此刻有流程在等某个角色回答
   * （`pending` 非空、且不是出牌阶段那种「谁都能动」的占位空位）。
   *
   * 界面拿不到别人的询问（`prompt` 是**按观看者**构建的，别人的一律为 null），
   * 所以「要不要保持提示」只能由引擎说了算。
   */
  settling: boolean;
}

export interface Snapshot {
  seatId: string; // 此快照属于哪个座位
  roomCode: string;
  started: boolean;
  mode: GameMode; // 当前对局模式
  players: PlayerView[];
  myHand: Card[]; // 仅本人手牌完整下发
  turn: { seatId: string; phase: Phase };
  prompt: PromptView | null; // 轮到你行动时非空
  winner: string | null; // 游戏未结束时为 null；结束时为胜方标识
  log: LogEntry[];
  /**
   * 拼点区（公开信息：两边都看得到同一块）：进行中给「谁扣好了」，双方扣好后给牌面 + 点数 + 胜负。
   * 结算完不会立刻消失——下一次有人行动（任何 intent）时清空，让玩家有时间看清结果。
   */
  pindian?: PindianView | null;
  /**
   * 牌桌上公开摆着的牌池（【五谷丰登】）：牌桌中央平铺、按顺序依次拿走、拿走的立刻消失。
   * 同样是公开信息（亮出来的牌本来就是明的）——**所有人都看得到整池与谁轮到了**。
   */
  publicPool?: PublicPoolView | null;
  /**
   * 属性伤害这次沿连环角色的**传导顺序**（公开信息：横置本来就是明的）。
   * 没有传导时为 null；下一次任何 intent 时清空（同拼点区）。
   */
  chain?: ChainSpreadView | null;
  /**
   * **刚发动 / 刚触发的技能**（用户 2026-09-25 口径①~④）：提示贴 `seatId` 那位角色附近。
   *
   * 只带「谁、哪个技能（名 + id）、还在不在结算」——**不带牌面、不带武将牌信息**，
   * 所以暗置武将的技能不会因为这条提示泄露：引擎只会记**真的发动过**的技能
   * （写入点是 `pushLog(kind === 'skill')`，见 SkillFxView）。
   */
  skillFx?: SkillFxView | null;
}
