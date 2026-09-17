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
  /** 周泰·不屈的「创」：扣在武将牌上的牌（公开信息） */
  wounds?: Card[];
  /** 颜良文丑·双雄：本回合判定牌的颜色（本回合可把异色手牌当【决斗】用） */
  shuangxiongColor?: 'red' | 'black' | null;
  // 副将是否已亮将（国战公开信息）
  deputyRevealed?: boolean;
  // 国战标记（公开信息）：持有数量 > 0 的标记
  markers?: { id: MarkerId; label: string; count: number }[];
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
  | 'activeSkill'
  | 'choice' // 通用「选择一项」
  | 'pickCards' // 从一组牌里选若干张
  | 'viewCards' // 私密查看（知己知彼）：只有本人看得到内容
  | 'factionCall'; // 势力技：依次问同势力角色是否代打一张牌

// 告诉玩家当前需要做什么 + 合法选项（服务端权威计算后下发）
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
  legalSkillIds?: string[];
  /**
   * 出牌阶段：可用主动技能的完整信息（仅 play 有）。
   *
   * 界面直接用这份渲染按钮，不要再拿技能名去 hero.skills 里配对——
   * 那样改名就会失效，而且标记带来的技能不属于任何武将，根本配不上。
   */
  legalSkills?: { id: string; name: string; desc: string }[];

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
  pickCards?: Card[];
  pickMin?: number;
  pickMax?: number;
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
}
