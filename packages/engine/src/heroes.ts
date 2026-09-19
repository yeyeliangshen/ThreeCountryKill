import {
  CARD_TYPE_NAME,
  DAMAGE_CARD_TYPES,
  FACTION_TRICK_TYPES,
  cardColor,
  cardLabel,
  FIRE_TRICKS,
  isBasicCard,
  isDelayedTrick,
  isEquipCard,
  isInstantTrick,
  isRed,
} from '@sgs/protocol';
import type {
  Card,
  CardType,
  MarkerId,
  DamageAttribute,
  Faction,
  GameMode,
  Intent,
  RoleId,
  Suit,
  TrickType,
} from '@sgs/protocol';
import type { HealPayload, HookContext, HookRegistration, SkillApi, Timing } from './timing';
import type { AttackContext, GameState, MarkerUsage, Player, TrickContext } from './model';
import { addMarker, consumeMarker, markerCount, noteMarkerUsed, useXianqu, useYinyangyu, useYinyangyuHandLimit, useZhulian } from './markers';
import {
  drawOne,
  lordEquipDinglan,
  lordEquipFeilong,
  lordEquipLiulong,
  lordEquipMengjun,
} from './deck';
import { attackRange, canTarget, distance } from './distance';

import {
  alivePlayers,
  emptyEquipment,
  getPlayer,
  heartCardsInDiscardThisTurn,
  pushLog,
  toDiscard,
} from './model';

// —— 武将定义 ——
// canUseAs：转化技（能否把 card 当 type 使用/打出）。
// shaLimit：被动修改器（本回合最多可出杀数，默认 1）。
// hooks：触发技钩子。
// activeSkills：主动技能（出牌阶段可主动发动）。
// skills：UI 展示用技能描述。
//
// ⚠️ 国战与军争（身份局）的同名技能描述并不相同，各平台之间还有版本差异。
//    身份局/军争版本写在 Hero 顶层字段；国战版本写在 hero.guozhan 里，
//    只写与身份局不同的字段、其余沿用。取用时必须走 getHeroForMode()，
//    否则国战会拿到身份局的技能。已核实的差异写在各自 guozhan 块的注释里
//    （来源：萌娘百科/三国杀Wiki 的分模式技能表，取新国战即 2019 典藏版口径）。

// SkillApi 的正式定义在 timing.ts（HookContext 要用它），这里转出去，
// 免得使用方为了一个类型多 import 一个模块。
export type { SkillApi } from './timing';

/** 主动技能「可选几张牌」的判断依据——服务端与客户端都构造得出来 */
export interface SkillCardCtx {
  maxHp: number;
  handCount: number;
}

/** 主动技能接口 */
export interface ActiveSkill {
  id: string;
  name: string;
  /**
   * 技能说明。只有**借来的**主动技需要写（黄天、眩惑）——
   * 一般的主动技说明由 legal.skillDescFor 从自己武将牌的 skills[] 里查，
   * 而借来的技能不在使用者的武将牌上，查不到。
   */
  desc?: string;
  /** 限 1 次/回合 */
  oncePerTurn?: boolean;
  /**
   * **每个出牌阶段**限 N 次（界钟会·排异：限两次）。
   * 与 oncePerTurn 正交：这个是**阶段**内的额度，额外出牌阶段会重新拿到；
   * 计数在 `flags.skillUsesThisPhase`，随出牌阶段开始清零。
   */
  perPhaseLimit?: number;
  /**
   * 限定技：**每局**只能用一次（不随回合重置）。
   * 与 oncePerTurn 可以同时为假；两者都填就都受约束。
   */
  oncePerGame?: boolean;
  /** 这是不是一个锁定技（影响「非锁定技失效」，缺省＝非锁定技） */
  locked?: boolean;
  /** 目标数范围 */
  minTargets: number;
  maxTargets: number;
  /** 是否需要选择手牌（制衡/苦肉/离间/反间） */
  needsCards?: boolean;
  /**
   * 最多可选几张手牌。不给则由客户端按 99 处理。
   * 做成函数是因为国战·制衡的上限是「你的体力上限」；参数只用两边都有的信息
   * （服务端是 Player，客户端是 PlayerView），这样界面和引擎读同一份规则。
   */
  maxCards?: (ctx: SkillCardCtx) => number;
  /** 当前是否可用 */
  canUse: (state: GameState, player: Player) => boolean;
  /** 执行技能：返回 void=成功，string=错误消息 */
  execute: (
    state: GameState,
    player: Player,
    intent: Extract<Intent, { type: 'useSkill' }>,
    api: SkillApi,
  ) => void | string;
}

/** 国战版本的技能覆盖：只写与身份局/军争不同的字段，其余沿用 Hero 顶层 */
export interface HeroVariant {
  canUseAs?: Hero['canUseAs'];
  shaLimit?: Hero['shaLimit'];
  hooks?: HookRegistration[];
  activeSkills?: ActiveSkill[];
  combo?: Hero['combo'];
  /** 展示用技能列表（国战版可能与身份局不同） */
  skills?: Hero['skills'];
  distanceFrom?: Hero['distanceFrom'];
  extraDraw?: Hero['extraDraw'];
  handLimit?: Hero['handLimit'];
  lockedFields?: Hero['lockedFields'];
  skillFields?: Hero['skillFields'];
  /** 国战版的「出牌阶段可明置此武将牌」（邹氏·祸水、小乔·红颜） */
  canRevealInPlayPhase?: Hero['canRevealInPlayPhase'];
  spadeAsHeart?: Hero['spadeAsHeart'];
  virtualYuxi?: Hero['virtualYuxi'];
  fengyang?: Hero['fengyang'];
  jili?: Hero['jili'];
}

export interface Hero {
  id: string;
  name: string;
  faction: Faction;
  maxHp: number;
  /** 性别（离间需选男性角色） */
  gender?: 'male' | 'female';
  /**
   * 转化技：能否把 card 当 type 使用/打出。
   * 关羽·武圣：红色牌当【杀】。
   * 赵云·龙胆：【杀】【闪】互转。
   * 甄姬·倾国：黑色牌当【闪】。
   * 华佗·急救：红色牌当【桃】（用于濒死救援）。
   */
  /**
   * 转化技。大部分技能只看牌面（武圣：红牌当杀）；
   * 少数要看**本回合的状态**（颜良文丑·双雄：与判定牌颜色不同的手牌当【决斗】），
   * 所以后两个参数是可选的 state/player。
   */
  canUseAs?: (card: Card, type: CardType, state?: GameState, player?: Player) => boolean;
  /**
   * 被动修改器：本回合最多可出杀数。默认 1。
   * 张飞·咆哮：无限。
   */
  shaLimit?: () => number;
  /** 触发技钩子 */
  hooks?: HookRegistration[];
  /** 主动技能 */
  activeSkills?: ActiveSkill[];
  /**
   * 距离修正：你计算与其他角色的距离时减少这个值（马超·马术 = 1）。
   * 锁定技，两个模式一致。
   */
  distanceFrom?: number;
  /**
   * 摸牌阶段额外多摸几张（周瑜·英姿 = 1）。
   * 引擎取所有生效武将里的最大值。
   */
  extraDraw?: number;
  /**
   * 手牌上限的计算方式。不给则用默认（当前体力）。
   * 周瑜·英姿（国战）追加「手牌上限 = 体力上限」。
   */
  handLimit?: (state: GameState, player: Player) => number;
  /**
   * 珠联璧合：与之构成官方组合的武将 id（可多个，如刘备同时与关羽、张飞）。
   * 判定统一走 hasCombo()，不要自己比字段。
   */
  combos?: string[];
  /**
   * @deprecated 单搭档的旧写法，只保留读取兼容（见 hasCombo）。
   * 新数据一律用 combos。
   */
  combo?: { with: string; bonus: 'hp' | 'skill' };
  /**
   * 该武将参与【决斗】时，对手每次响应需要打出几张【杀】（吕布·无双 = 2，缺省 1）。
   * 【杀】那半部分由无双的 useCard 钩子置 requiredShan=2 实现，不走这个字段。
   */
  duelShaRequired?: number;
  /**
   * 锁定技：**不能**成为这张牌的合法目标（返回 true 即挡掉）。
   * 诸葛亮·空城（没手牌时不能被【杀】【决斗】指定）、
   * 陆逊·谦逊（不能被【顺手牵羊】【乐不思蜀】指定）、
   * 贾诩·帷幕（不能被黑色锦囊指定）。
   * 引擎在指定目标时校验，见 heroBlocksBeingTarget。
   */
  cannotBeTargetOf?: (state: GameState, self: Player, card: Card, source: Player) => boolean;
  /** 锁定技：使用锦囊牌无距离限制（黄月英·奇才） */
  ignoresTrickDistance?: boolean;
  /**
   * 锁定技：其**回合内**其他角色不能使用【桃】救别人（贾诩·完杀）。
   * 只有濒死者本人与持有者本人能发起救援。
   */
  blocksExternalSaves?: boolean;
  /**
   * 国战君主将。官方君主特性**全部已实现**：只能作主将、不会成为野心家、亮将时主副将同时亮出、
   * 与同势力所有其他武将构成珠联璧合、**阵亡时令同势力角色各失去 1 点体力**（`engine.lordDeathLoss`）；
   * 势力的**势力技**（护驾 / 激将 / 黄天）、君主技【君威】与四件专属装备也都在。
   * 官方口径见 docs/guozhan-reference.md §3.1。
   */
  isLord?: boolean;
  /**
   * 「君主技给全势力发的那个东西」：这个君主在场（且已明置）时，**该势力的角色**在准备阶段
   * 会多出一个选项（君曹操的「五子良将纛」是第一个用例）。
   * 值＝势力；引擎按势力把选项发给对应角色（见 engine 的 askLordBanner）。
   */
  lordBanner?: Faction;
  /**
   * **同一个武将本体的 id**（用户给定的口径）：标准版与它的君主版（以及将来的界/谋等版本）
   * 共用同一个 `canonicalId`，默认就是自己的 id。
   *
   * 用途：组双将时禁止「同一本体的两个版本」（曹操 + 君曹操）。将来加界曹操/谋曹操，
   * 只要让它们也填 `canonicalId: 'caocao'` 就自动受这条约束，不用改判定代码。
   */
  canonicalId?: string;
  /**
   * **这张武将牌属于哪个扩展包**（与 roster 的 `pack` 同口径）。
   *
   * 用途：扩展开关按它整包过滤——例如 `buchen: 'off'` 时，所有 `pack: 'buchen'` 的武将
   * （不论单势力、双势力还是野心家）都不进选将池。用户要求：「不开启不臣篇，
   * 就应当选不到不臣篇的武将」。
   */
  pack?: string;
  /**
   * **双势力武将牌**的第二个势力（不臣篇）。用户给定规则要点：
   * - 2023 改版后**主将、副将都可以**（旧规则「只能副将」作废）；
   * - 势力要**确定**，确定后整局都按那一个势力算（不是两个都算）——
   *   落在 `Player.determinedFaction` 上，见 `determineDualFaction()`；
   * - 判定规则（2023）：与普通单势力武将组合 → **自动跟随那个势力**；两张双势力只有一个
   *   共同势力 → **自动取共同势力**；有两个共同势力 / 与野心家武将组合 → **玩家自己选**
   *   （后两种要玩家自己选势力：引擎会挂一条 `choice` 询问，**不再拒绝**——见 §5.126 的 ✅ 后续；
   *     客户端那条询问能不能弹出来还没实测）。
   */
  secondFaction?: Faction;
  /**
   * 「这个武将给**同势力角色**授予一个出牌阶段技能」——值是那条技能的 id（目前只有君孙权的督授）。
   * 与 `lordBanner` 同一类：引擎按它去场上找提供者（见 `factionGrantedActiveSkills`）。
   */
  factionSkillId?: string;

  /**
   * 锁定技：【南蛮入侵】对你无效（祝融·巨象、孟获·祸起）。
   * 由引擎在构造 AOE 响应队列时把该角色排除掉。
   */
  immuneToNanman?: boolean;
  /**
   * 势力技（曹操·护驾 / 刘备·激将）：当你**需要打出** needType 时，
   * 可以令同势力其他角色代打一张，视为你使用/打出。
   *
   * 引擎在对应的响应提示里给出「发动」入口（见 legal.ts），
   * 目前支持 needType 为【闪】的两种场景：被【杀】指定、响应【万箭齐发】。
   */
  factionCall?: { id: string; name: string; needType: CardType };
  /**
   * 锁定技：**同势力的其他角色**对你使用【桃】时，你额外回复这么多点体力
   * （孙权·救援 = 1）。只在国战有意义——要靠 faction 判断。
   */
  rescueHealBonusFromFaction?: number;
  /**
   * 该武将造成的伤害的额外加成（裸衣 = 1）。
   *
   * 引擎只在【杀】与【决斗】的伤害结算处读取它——裸衣的加成范围正好是这两者，
   * 所以没给它加参数。将来若有技能需要按牌型区分，再补一个 kind 参数。
   */
  dealtDamageBonus?: (state: GameState, self: Player) => number;
  /**
   * **任何**伤害的数值修正（张绣·从谏），不限【杀】/【决斗】。
   *
   * 与 dealtDamageBonus 的分工：那个在【杀】/【决斗】的结算处就读掉了（裸衣的范围），
   * 这个在 damageStep 里统一读——它是「回合外造成伤害 +1 / 回合内受到伤害 +1」那种
   * 跟牌型无关的修正。来源与目标**双方**的武将都会被问到，返回正数表示加伤。
   */
  damageDelta?: (
    state: GameState,
    self: Player,
    ctx: { sourceId?: string; targetId: string },
  ) => number;
  /**
   * **有条件**的「摸牌阶段额外摸 X 张」（潘濬·聪察②：场上所有存活角色都已确定势力时 +2）。
   *
   * 与 `extraDraw`（无条件的固定值）分开：这个每次摸牌阶段**现算**。走这里而不是在
   * `drawPhase` 钩子里加 `flags.drawCountDelta`，是因为摸牌阶段被跳过时不该留下任何痕迹
   * （官方：那是「摸牌阶段多摸两张」，阶段没了就无从多加）。
   */
  drawCountDelta?: (state: GameState, self: Player) => number;
  /**
   * 只在列出的模式里出现。不填＝全模式可用。
   *
   * 国战专属武将（甘夫人、丁奉、马腾、孔融、纪灵、田丰、潘凤、邹氏）必须标
   * `['guozhan']`，否则会漏进军争/混战的选将池——它们只在国战里存在。
   * 取池子一律走 poolForMode()，不要直接读 HEROES。
   */
  modes?: GameMode[];
  /** UI 展示用技能描述（身份局/军争版本） */
  skills: { name: string; desc: string }[];
  /** 国战版本的技能覆盖，见文件顶部说明 */
  guozhan?: HeroVariant;
  /**
   * 这个武将身上哪些**字段型**技能是锁定技。
   *
   * 「非锁定技失效」（新国战·铁骑）会把没列在这里的字段型技能一并屏蔽掉，
   * 所以要按官方描述老实填：武圣/龙胆这类**不填**，马术/空城/帷幕这类要填。
   * 钩子与主动技不用管——它们各自的 `locked` 标记说了算。
   */
  lockedFields?: FieldSkill[];
  /**
   * 锁定技：装备区没有防具牌时，视为装备着【八卦阵】（卧龙诸葛亮·八阵）。
   * 由 equip.tryBaguaDodge 读取。
   */
  hasBaguaAlways?: boolean;
  /**
   * 锁定技：【南蛮入侵】造成的伤害，来源视为你（孟获·祸首）。
   * 与 immuneToNanman 配合：「对**你**无效」+「对别人的伤害算**你**造成的」。
   * 由 engine.ts 的 nanmanDamageSource() 在 AOE 伤害处读取。
   */
  nanmanDamageSource?: boolean;
  /**
   * 邹氏·祸水（锁定技的一部分）：你的回合内，其他角色不能明置武将牌。
   * 由 engine 的 canRevealNow 拦（「真的去明置」与「暗置时用转化技」两条路都问它）。
   */
  blocksOthersReveal?: boolean;
  /**
   * 邹氏·祸水的前半句：**出牌阶段**也可以明置这张武将牌
   * （通常只有准备阶段能主动明置，见 engine 的 onRevealHero）。
   * 小乔·红颜也是同一句（国战文本里写着「出牌阶段，你可明置此武将牌」）。
   */
  canRevealInPlayPhase?: boolean;
  /**
   * 刘禅·享乐（锁定技）：当你成为【杀】的目标后，除非使用者弃置一张基本牌，
   * 否则此【杀】对你无效。由 engine 的 afterShaTargetResolve 在防具之前问。
   */
  xingleBasicDiscard?: boolean;
  /** 副将技的「此武将牌减少半个阴阳鱼」（孙策·魂殇）：在**副将**位时 -1 体力上限 */
  deputySlotHalfYang?: boolean;
  /** 邓艾·屯田：你计算与其他角色的距离 -X（X 为武将牌上「田」的数量） */
  distanceMinusPerTian?: boolean;
  /** 飞影：其他角色计算与你的距离 +1（曹洪·鹤翼授予同队列者） */
  feiying?: boolean;
  /** 鹤翼（阵法技）：与你处于同一队列的其他角色视为拥有【飞影】 */
  grantsFeiyingToQueue?: boolean;
  /**
   * 只作为「被授予的技能」存在的伪武将（崩坏、勇决…）：不进选将池，
   * 只能通过 api.grantSkill 挂到别人身上。
   */
  notDraftable?: boolean;
  /**
   * **主将技**：这些技能只有这张武将牌在**主将**位时才生效。
   *
   * ⚠️ 限制是按**技能**算的，不是按武将牌算的——同一个武将的其它技能不受影响
   *    （董卓：暴凌是主将技，横征哪个位置都能用）。钩子在 collectTimingHooks 里过滤；
   *    字段型技能（canUseAs 那类）暂时只覆盖钩子，用到时再补。
   */
  mainSlotSkills?: string[];
  /** 副将技：这些技能只有这张武将牌在**副将**位时才生效（邓艾·资粮、孙策·魂殇）。 */
  deputySlotSkills?: string[];
  /**
   * 主将技的代价：此武将牌**减少半个阴阳鱼**（本引擎体力是阴阳鱼×2 的口径，所以 -1）。
   * 只在它处于主将位时算，且由 finishDraft 读。
   */
  mainSlotHalfYang?: boolean;
  /**
   * 闺秀那类：这张武将牌**被移除**时，其拥有者回复 1 点体力。
   * （移除是「那张牌离场」，所以这条效果由移除原语直接结算，不靠钩子。）
   */
  healOwnerOnRemoval?: boolean;
  /**
   * 祝融·巨象的后半句（锁定技）：**其他角色**使用的【南蛮入侵】结算结束后，你获得之。
   * 由 engine 在南蛮结算完（enterTrickResponse 的出口）读——只在牌还躺在弃牌堆里时给
   * （被曹操·奸雄那类收走就不给了）。
   */
  gainsUsedNanman?: boolean;
  /**
   * 小乔·红颜（锁定技）：你的黑桃牌视为红桃牌。
   *
   * 「你的牌」按官方口径包括：你的手牌、你装备区的牌、**由你进行的判定**的判定牌
   * （「谁判定，判定牌就属于谁」——所以鬼才/鬼道换上去的牌也算你的；反过来，
   * 马超·铁骑、夏侯惇·刚烈那种技能拥有者做判定，判定牌是他们的，红颜不生效）。
   *
   * 实现是 `cardAsSeenBy()` 一处：转换技合法性（canUseAs）、判定、火攻、
   * 装备区颜色判定（仁王盾/八卦阵）、丈八凑出来的【杀】颜色都过它。
   */
  spadeAsHeart?: boolean;
  /**
   * 严白虎·寄篱（副将技，锁定技）：成为红色基本牌/红色普通锦囊牌的**唯一目标**后，
   * 这张牌结算两次（＝使用者对你再使用一次同名牌）。
   */
  jili?: boolean;
  /**
   * 吴景·风扬（阵法技，锁定技）：与你势力不同或未确定势力的角色，不能弃置或获得
   * **与你处于同一队列**的角色装备区里的牌。判定收在 `heroes.fengyangBlocksEquip`，
   * 由引擎在「拿走/弃置他人装备牌」的几处收口调用。
   */
  fengyang?: boolean;
  /**
   * 士燮·避乱（锁定技）：**其他角色**计算与你的距离 +X，X＝你装备区的牌数，**至少 1**。
   * 是**单向**修正（只有别人看你变远，你计算别人不受影响），且装备数是**实时**读的。
   * 判定收在 `heroes.biluanAgainst`，由 `distance()` 在 `to` 一侧统一加。
   */
  biluan?: boolean;
  /**
   * 朱灵·方圆（阵法技，锁定技）：① 与方圆拥有者处于**同一围攻关系**的**围攻角色**手牌上限 +1、
   * **被围攻角色** -1（同一个技能实例对同一角色最多 ±1 一次，按「有没有这样的关系」判，不按关系数累加）；
   * ② 方圆拥有者**被围攻**时，自己的结束阶段可以选一名围攻者，视为对其使用一张纯虚拟普通【杀】。
   * 判定收在 `heroes.fangyuanHandLimitDelta`，由引擎在 `handLimit()` 里统一加。
   */
  fangyuan?: boolean;
  /**
   * **阵法技**的类型（可多个）：`'queue'` 队列型、`'siege'` 围攻型。
   *
   * 只用来回答一个问题——**阵法召唤**（`FORMATION_SUMMON`）时，「这个人亮将之后能形成
   * 哪种关系」：队列型要看亮将后是否与召唤者同一**队列**，围攻型看是否进同一**围攻关系**。
   * 每个技能的生效判定仍各在各处（`formationQueue` / `siegeRelations` / `hasFeiying`…），
   * 这里只是给「召唤」一个可读的来源。见 docs/guozhan-roster.md §5.132。
   */
  formation?: ('queue' | 'siege')[];
  /**
   * 朱灵·【决绝】第三句：「你杀死与你势力相同的角色时，**不执行奖惩**」。
   * 国战的基础奖惩见 engine 的 applyKillPenalty（同势力击杀 → 弃置所有牌）。
   */
  exemptFromKillPenalty?: boolean;
  /**
   * 诸葛恪·【傲才】（§5.116）：**回合外**被要求使用/打出**基本牌**时，可以观看牌堆顶两张，
   * 用其中一张**满足请求的实体基本牌**完成这次使用/打出（不进手牌、不是虚拟牌）。
   */
  aocai?: boolean;
  /**
   * **目标级**的「本回合【杀】次数豁免」：整张牌**提议的全部目标**都满足条件时才允许突破次数上限。
   * 夏侯霸·【豹烈】②是第一个用例（目标当前体力 ≥ 自己当前体力）。
   * ⚠️ 语义是「这张杀的这批目标能不能豁免」，**不是**「有技能就无限出杀」——
   * 目标里只要有一个不满足，就不豁免（与文本「对体力值不小于你的角色使用【杀】」一致）。
   */
  shaBypassLimit?: (state: GameState, owner: Player, targetIds: string[]) => boolean;
  /**
   * **目标级**的「使用【杀】无视距离」：只对满足条件的目标放行，其余目标照常判距离。
   * 夏侯霸·【豹烈】②：目标当前体力 ≥ 自己当前体力时对**该目标**无距离限制。
   */
  ignoreShaDistanceTo?: (state: GameState, owner: Player, targetId: string) => boolean;
  /**
   * 袁术·庸肆（锁定技）：**若场上没有【玉玺】**，你视为装备着【玉玺】。
   *
   * 两处消费方都走 `hasYuxi()`（equip.ts 的摸牌加成 + engine 的出牌阶段开始时视为使用
   * 【知己知彼】），所以只要把判定收在那一个函数里，玉玺的条款就只需实现一次。
   */
  virtualYuxi?: boolean;
  /**
   * 孔融·名士（锁定技）：当你受到伤害时，若伤害来源**有暗置的武将牌**，
   * 此伤害 -1。由 engine 的 finalizeDamage 在所有伤害点上统一读。
   */
  reduceDamageFromHiddenSource?: boolean;
  /**
   * 丁奉·短兵：使用【杀】时可以**多选择一名距离为 1** 的角色为目标。
   * 由 engine 的 shaTargetRule 读（与方天画戟的目标数规则合在一处算）。
   */
  shaExtraTargetAtRange1?: boolean;
  /**
   * 每个技能各自「拥有」哪些字段型能力，键是**技能中文名**。
   *
   * 只在一个地方用得上：把技能从别的武将身上摘出来时（「获得技能」，
   * 见 grantedHeroes）——否则摘出来的会是空壳。例如周瑜的【英姿】
   * 其实是由 extraDraw / handLimit 两个字段实现的，摘它就得连字段一起摘。
   */
  skillFields?: Record<string, FieldSkill[]>;
}

/**
 * 用「字段」表达的技能（不是钩子、也不是主动技）。
 * 名字与 Hero 上的字段同名，便于对照。
 */
export type FieldSkill =
  | 'canUseAs'
  | 'shaLimit'
  | 'distanceFrom'
  | 'biluan'
  | 'shaBypassLimit'
  | 'fangyuan'
  | 'ignoreShaDistanceTo'
  | 'extraDraw'
  | 'handLimit'
  | 'cannotBeTargetOf'
  | 'blocksExternalSaves'
  | 'ignoresTrickDistance'
  | 'rescueHealBonusFromFaction'
  | 'dealtDamageBonus'
  /** 张绣·从谏：任何伤害的数值修正（回合外造成 / 回合内受到 → +1） */
  | 'damageDelta'
  | 'factionCall'
  | 'duelShaRequired'
  | 'hasBaguaAlways'
  | 'immuneToNanman'
  | 'nanmanDamageSource'
  /** 丁奉·短兵：你使用【杀】可以**多选择一名距离为 1** 的角色为目标 */
  | 'shaExtraTargetAtRange1'
  /** 孔融·名士：伤害来源**有暗置的武将牌**时，你受到的伤害 -1 */
  | 'reduceDamageFromHiddenSource'
  /** 邹氏·祸水：你的回合内，其他角色不能明置武将牌 */
  | 'blocksOthersReveal'
  /** 邹氏·祸水：出牌阶段也可以明置这张武将牌 */
  | 'canRevealInPlayPhase'
  /** 祝融·巨象后半句：其他角色用过的【南蛮入侵】结算后你获得之 */
  | 'gainsUsedNanman'
  /** 刘禅·享乐：成为【杀】目标后使用者要弃一张基本牌 */
  | 'xingleBasicDiscard'
  /** 曹洪·鹤翼（阵法技）：同一队列的其他角色视为拥有【飞影】 */
  | 'grantsFeiyingToQueue'
  /** 飞影：其他角色计算与你的距离 +1 */
  | 'feiying'
  /** 邓艾·屯田：距离 -X（X 为「田」的数量） */
  | 'distanceMinusPerTian'
  /** 小乔·红颜：你的黑桃牌视为红桃牌 */
  | 'spadeAsHeart'
  /** 袁术·庸肆：场上没有实体【玉玺】时视为装备着【玉玺】 */
  | 'virtualYuxi'
  /** 吴景·风扬：同队列角色的装备区里的牌不受异势力角色弃置/获得 */
  | 'fengyang'
  /** 严白虎·寄篱：成为红色基本牌/普通锦囊的唯一目标后，此牌结算两次 */
  | 'jili'
  /** 潘濬·聪察②：场上所有存活角色都已确定势力时，摸牌阶段多摸两张 */
  | 'drawCountDelta';

const ALL_FIELD_SKILLS: FieldSkill[] = [
  'canUseAs',
  'shaLimit',
  'distanceFrom',
  'biluan',
  'shaBypassLimit',
  'fangyuan',
  'ignoreShaDistanceTo',
  'extraDraw',
  'handLimit',
  'cannotBeTargetOf',
  'blocksExternalSaves',
  'ignoresTrickDistance',
  'rescueHealBonusFromFaction',
  'dealtDamageBonus',
  'damageDelta',
  'factionCall',
  'duelShaRequired',
  'hasBaguaAlways',
  'immuneToNanman',
  'nanmanDamageSource',
  'shaExtraTargetAtRange1',
  'reduceDamageFromHiddenSource',
  'blocksOthersReveal',
  'canRevealInPlayPhase',
  'spadeAsHeart',
  'virtualYuxi',
  'fengyang',
  'jili',
  'gainsUsedNanman',
  'xingleBasicDiscard',
  'grantsFeiyingToQueue',
  'feiying',
  'distanceMinusPerTian',
  'drawCountDelta',
];

const GUANYU: Hero = {
  id: 'guanyu',
  name: '关羽',
  faction: 'shu',
  maxHp: 4,
  gender: 'male',
  canUseAs: (card, type) => type === 'sha' && isRed(card),
  combos: ['zhangfei'],
  skillFields: { 武圣: ['canUseAs'] },
  skills: [{ name: '武圣', desc: '你可以将一张红色牌当【杀】使用或打出。' }],
};

const ZHANGFEI: Hero = {
  id: 'zhangfei',
  name: '张飞',
  faction: 'shu',
  maxHp: 4,
  gender: 'male',
  shaLimit: () => Infinity,
  lockedFields: ['shaLimit'],
  combos: ['guanyu'],
  // 眩惑能把「咆哮」借给别人，所以字段要登记进 skillFields（grantedHeroes 靠它摘字段）
  skillFields: { 咆哮: ['shaLimit'] },
  skills: [{ name: '咆哮', desc: '出牌阶段，你可以使用任意数量的【杀】。' }],
  // 国战（新国战）：咆哮追加「出牌阶段使用了第二张【杀】后，摸一张牌」
  guozhan: {
    hooks: [
      {
        timing: 'useCard',
        skillId: '咆哮',
        locked: true,
        handler: (ctx) => {
          const payload = ctx.payload as { attack?: AttackContext } | undefined;
          if (payload?.attack?.asType !== 'sha') return;
          // useCard 在 shaCountThisTurn++ 之后触发，所以这里已经是含本张的计数
          if (ctx.player.flags.shaCountThisTurn === 2) {
            const c = drawOne(ctx.state);
            if (c) {
              ctx.player.hand.push(c);
              pushLog(ctx.state, 'skill', `${ctx.player.name} 发动【咆哮】，摸了 1 张牌。`);
            }
          }
        },
      },
    ],
    skills: [
      {
        name: '咆哮',
        desc: '锁定技，出牌阶段，你使用【杀】无次数限制；你于出牌阶段使用第二张【杀】后，摸一张牌。（国战版）',
      },
    ],
  },
};

const ZHAOYUN: Hero = {
  id: 'zhaoyun',
  name: '赵云',
  faction: 'shu',
  maxHp: 4,
  gender: 'male',
  // 龙胆：杀↔闪互转
  canUseAs: (card, type) =>
    (type === 'sha' && card.type === 'shan') || (type === 'shan' && card.type === 'sha'),
  skillFields: { 龙胆: ['canUseAs'] },
  skills: [{ name: '龙胆', desc: '你可以将【杀】当【闪】、【闪】当【杀】使用或打出。' }],
};

const MACHAO: Hero = {
  id: 'machao',
  name: '马超',
  faction: 'shu',
  maxHp: 4,
  gender: 'male',
  // 铁骑：使用【杀】指定目标后，翻判定牌→红色则不可闪避。
  // 走统一的技能判定（api.judge）：鬼才/鬼道可以改判、天妒可以收走判定牌。
  // 这要归功于 `useCard` 已经转成**可挂起**的时机——以前它是同步分发的，
  // 判定里鬼才一发问就会被随后的成为目标/结算覆盖掉（当时只能裸判定，注释里记过）。
  hooks: [
    {
      timing: 'useCard',
      skillId: '铁骑',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext } | undefined;
        if (payload?.attack?.asType !== 'sha') return;
        ctx.api.judge('铁骑', (judgeCard) => {
          if (!judgeCard) return;
          if (isRed(judgeCard)) {
            payload.attack!.requiredShan = Infinity;
            pushLog(ctx.state, 'skill', `【铁骑】判定为红色，此【杀】不可闪避！`);
          }
        });
      },
    },
  ],
  // 马术：锁定技，计算与其他角色的距离 -1（distance() 读这个字段）
  distanceFrom: 1,
  lockedFields: ['distanceFrom'],
  skills: [
    { name: '马术', desc: '锁定技，你计算与其他角色的距离-1。' },
    {
      name: '铁骑',
      desc: '当你使用【杀】指定目标后，你可以进行判定：若为红色，此【杀】不可被闪避。',
    },
  ],
};

const HUANGZHONG: Hero = {
  id: 'huangzhong',
  name: '黄忠',
  faction: 'shu',
  maxHp: 4,
  gender: 'male',
  combos: ['weiyan'],
  // 烈弓：目标手牌数≥己 或 体力≤己 → 不可闪避
  hooks: [
    {
      timing: 'useCard',
      skillId: '烈弓',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext } | undefined;
        if (payload?.attack?.asType !== 'sha') return;
        const target = getPlayer(ctx.state, payload.attack.targetId);
        if (!target) return;
        if (target.hand.length >= ctx.player.hand.length || target.hp <= ctx.player.hp) {
          payload.attack.requiredShan = Infinity;
          pushLog(ctx.state, 'skill', `${ctx.player.name} 发动【烈弓】，此【杀】不可闪避！`);
        }
      },
    },
  ],
  skills: [
    {
      name: '烈弓',
      desc: '当你使用【杀】指定目标后，若目标手牌数≥你或体力≤你，此【杀】不可被闪避。',
    },
  ],
  // 国战：烈弓的判定条件与身份局不同——
  // 身份局比的是「目标手牌数/体力 vs 你的手牌数/体力」；
  // 国战比的是「目标手牌数 vs 你的体力值 / 你的攻击范围」
  guozhan: {
    hooks: [
      {
        timing: 'useCard',
        skillId: '烈弓',
        handler: (ctx) => {
          const payload = ctx.payload as { attack?: AttackContext } | undefined;
          if (payload?.attack?.asType !== 'sha') return;
          const target = getPlayer(ctx.state, payload.attack.targetId);
          if (!target) return;
          const hand = target.hand.length;
          if (hand >= ctx.player.hp || hand <= attackRange(ctx.state, ctx.player)) {
            payload.attack.requiredShan = Infinity;
            pushLog(ctx.state, 'skill', `${ctx.player.name} 发动【烈弓】，此【杀】不可闪避！`);
          }
        },
      },
    ],
    skills: [
      {
        name: '烈弓',
        desc: '当你于出牌阶段内使用【杀】指定一名角色为目标后，若该角色手牌数不小于你的体力值或不大于你的攻击范围，你可以令其不能使用【闪】响应此【杀】。（国战版）',
      },
    ],
  },
};

const LVBU: Hero = {
  id: 'lvbu',
  name: '吕布',
  faction: 'qun',
  maxHp: 4,
  gender: 'male',
  // 无双：【杀】要两张闪（下面的钩子），【决斗】对手每次要两张杀（duelShaRequired）
  duelShaRequired: 2,
  lockedFields: ['duelShaRequired'],
  combos: ['diaochan'],
  // 无双：目标需出2张【闪】
  hooks: [
    {
      timing: 'useCard',
      skillId: '无双',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext } | undefined;
        if (payload?.attack?.asType !== 'sha') return;
        payload.attack.requiredShan = 2;
      },
      locked: true, // 无双是锁定技
    },
  ],
  skills: [{ name: '无双', desc: '当你使用【杀】指定目标后，目标需使用两张【闪】才能闪避。' }],
};

const DIAOCHAN: Hero = {
  id: 'diaochan',
  name: '貂蝉',
  faction: 'qun',
  maxHp: 3,
  gender: 'female',
  combos: ['lvbu'],
  // 离间：弃1牌→选2名男性角色→令A对B出杀，A不出则受1伤害
  activeSkills: [
    {
      id: 'lilian',
      name: '离间',
      oncePerTurn: true,
      minTargets: 2,
      maxTargets: 2,
      needsCards: true,
      maxCards: () => 1,
      canUse: (state, player) => {
        if (player.hand.length === 0) return false;
        const males = state.players.filter(
          (p) => p.alive && p.seatId !== player.seatId && isMalePlayer(state, p),
        );
        return males.length >= 2;
      },
      execute: (state, player, intent, _api) => {
        const ids = intent.cardIds ?? [];
        if (ids.length === 0) return '请选择一张牌弃置';
        const card = removeCard(player.hand, ids[0]!);
        if (!card) return '找不到手牌';
        toDiscard(state, card);
        const aId = intent.targetIds[0];
        const bId = intent.targetIds[1];
        if (!aId || !bId) return '请选择两名男性角色';
        const a = getPlayer(state, aId);
        const b = getPlayer(state, bId);
        if (!a || !b) return '目标不存在';
        if (!isMalePlayer(state, a) || !isMalePlayer(state, b)) return '目标须为男性角色';
        pushLog(
          state,
          'skill',
          `${player.name} 发动【离间】，令 ${a.name} 对 ${b.name} 使用【杀】。`,
        );
        // 创建虚拟锦囊：A 须对 B 出杀，否则受1伤害
        state.pending = {
          kind: 'respondTrick',
          responderId: aId,
          ctx: {
            sourceId: player.seatId,
            card: { id: `lilian-${aId}-${bId}`, type: 'sha', suit: 'heart', rank: 0 },
            responders: [aId],
            responderIndex: 0,
            shaTargetId: bId,
            skillId: 'lilian',
          },
        };
      },
    },
  ],
  // 闭月：结束阶段，你可以摸一张牌（官方是「可以」，所以先问一句再摸）
  hooks: [
    {
      timing: 'turnEnd',
      skillId: '闭月',
      handler: (ctx) => {
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【闭月】？',
          [
            { id: 'yes', label: '发动（摸一张牌）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            const c = drawOne(st);
            if (!c) return;
            p.hand.push(c);
            pushLog(st, 'skill', `${p.name} 发动【闭月】，摸了 1 张牌。`);
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '离间',
      desc: '出牌阶段限一次，弃一张牌并选两名男性角色，令A对B使用【杀】。A不出则受1伤害。（简化版）',
    },
    { name: '闭月', desc: '结束阶段开始时，你可以摸一张牌。' },
  ],
};

/**
 * 洛神本体：判到红色为止，黑色判定牌收下。
 * 身份局与国战的结果一样，只是日志口径不同（国战强调「一次性获得」）。
 *
 * 「是否发动」由调用方先问——官方写法是「**可以**进行判定」，
 * 之前实现成无条件发动，玩家没有选择权。
 */
function luoshen(state: GameState, player: Player, guozhan: boolean): void {
  const got: Card[] = [];
  for (;;) {
    const j = drawOne(state);
    if (!j) break;
    // 判定由甄姬自己做（「谁判定，判定牌就属于谁」）——红颜那类也要按她的口径看
    if (isRed(cardAsSeenBy(state, player, j))) {
      toDiscard(state, j);
      pushLog(
        state,
        'skill',
        guozhan
          ? `${player.name} 发动【洛神】，判定${cardLabel(j)}为红色，结束。`
          : `${player.name} 发动【洛神】，判定：${cardLabel(j)}。`,
      );
      break;
    }
    pushLog(state, 'skill', `${player.name} 发动【洛神】，判定：${cardLabel(j)}。`);
    got.push(j);
  }
  if (got.length > 0) {
    player.hand.push(...got);
    pushLog(
      state,
      'skill',
      guozhan
        ? `${player.name} 的【洛神】一次性获得 ${got.length} 张黑色判定牌。`
        : `${player.name} 的【洛神】获得 ${got.length} 张黑色牌。`,
    );
  }
}

/** 「是否发动洛神」的询问（准备阶段，可挂起） */
function askLuoshen(
  ctx: { state: GameState; player: Player; api: SkillApi },
  guozhan: boolean,
): void {
  ctx.api.askChoice(
    ctx.state,
    ctx.player.seatId,
    '是否发动【洛神】？',
    [
      { id: 'yes', label: '发动（判定直到出现红色为止）' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked === 'yes') luoshen(st, p, guozhan);
    },
  );
}

const ZHENJI: Hero = {
  id: 'zhenji',
  name: '甄姬',
  faction: 'wei',
  maxHp: 3,
  gender: 'female',
  // 倾国：黑色牌当【闪】
  canUseAs: (card, type) => type === 'shan' && !isRed(card),
  // 洛神：准备阶段，你可以判定
  hooks: [
    {
      timing: 'turnStart',
      skillId: '洛神',
      handler: (ctx) => askLuoshen(ctx, false),
    },
  ],
  skillFields: { 倾国: ['canUseAs'] },
  skills: [
    { name: '倾国', desc: '你可以将一张黑色牌当【闪】使用或打出。' },
    {
      name: '洛神',
      desc: '准备阶段，你可以进行判定：若为黑色，你获得此牌，然后你可以重复此流程。',
    },
  ],
  // 国战版洛神：判到红色为止，然后**一次性**获得此前所有黑色判定牌
  guozhan: {
    hooks: [
      {
        timing: 'turnStart',
        handler: (ctx) => askLuoshen(ctx, true),
      },
    ],
    skills: [
      { name: '倾国', desc: '你可以将一张黑色牌当【闪】使用或打出。' },
      {
        name: '洛神',
        desc: '准备阶段，你可以进行判定：若为黑色，你获得此牌并可重复此流程，直到出现红色为止；然后你一次性获得所有黑色判定牌。（国战版）',
      },
    ],
  },
};

const SIMAYI: Hero = {
  id: 'simayi',
  name: '司马懿',
  faction: 'wei',
  maxHp: 3,
  gender: 'male',
  // 鬼才：在判定牌生效前，你可以打出一张手牌替换之。
  //
  // 「换哪张」要问了才知道，而 HookResult 是同步返还的，
  // 所以走 api.replaceJudgeCard —— 引擎会把被挂起的判定流程接回去（见 engine.JudgeBox）。
  hooks: [
    {
      timing: 'beforeJudge',
      skillId: '鬼才',
      handler: (ctx) => {
        const payload = ctx.payload as { judgeCard?: Card } | undefined;
        if (!payload?.judgeCard) return;
        if (ctx.player.hand.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `是否发动【鬼才】替换判定牌（当前 ${cardLabel(payload.judgeCard)}）？`,
          [
            { id: 'yes', label: '发动（打出一张手牌替换）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            const hand = p.hand.slice();
            if (picked !== 'yes' || hand.length === 0) return;
            ctx.api.askPickCards(
              st,
              p.seatId,
              '【鬼才】：选择要打出的手牌（将替换判定牌）',
              hand,
              1,
              1,
              (st2, p2, chosen) => {
                const card = chosen[0];
                if (!card) return;
                // ⚠️ 只从手里摘出来，**不要**在这里 toDiscard：这张牌会成为**新的判定牌**，
                // 判定结算完由 disposeJudgeCard 统一处置（进弃牌堆，或被天妒收走）。
                // 以前这里顺手弃了一次，于是同一张牌在弃牌堆里出现两次（模糊测试抓到的）。
                removeCard(p2.hand, card.id);
                pushLog(
                  st2,
                  'skill',
                  `${p2.name} 发动【鬼才】，打出【${cardLabel(card)}】替换判定牌。`,
                );
                ctx.api.replaceJudgeCard(card);
              },
            );
          },
        );
      },
    },
    // 反馈：受到伤害后，获得伤害来源的一张牌（由自己挑）
    {
      timing: 'afterDamage',
      skillId: '反馈',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext; /* ⚠️ 直写槽：heroes 不能 import engine（循环依赖），这一处暂不过版本号，见 docs §5.124 待办 */ damage?: number } | undefined;
        if (!payload?.attack || !payload.damage) return;
        const source = getPlayer(ctx.state, payload.attack.sourceId);
        if (!source || source.seatId === ctx.player.seatId) return; // 无来源或自伤
        if (handAndEquipOf(source).length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `是否发动【反馈】获得 ${source.name} 的一张牌？`,
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.askPickCards(
              st,
              p.seatId,
              `【反馈】：选择要获得 ${source.name} 的一张牌`,
              handAndEquipOf(source),
              1,
              1,
              (st2, p2, chosen) => {
                const card = chosen[0];
                if (!card) return;
                // 走 API 而不是自己 splice：拿装备要触发枭姬那类技能
                ctx.api.transferCard(source.seatId, card, p2.seatId, () => {
                  pushLog(
                    st2,
                    'skill',
                    `${p2.name} 发动【反馈】，获得 ${source.name} 的【${cardLabel(card)}】。`,
                  );
                });
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    { name: '反馈', desc: '当你受到伤害后，你可以获得伤害来源的一张牌。' },
    { name: '鬼才', desc: '在判定牌生效前，你可以打出一张手牌替换之。' },
  ],
};

const XIAHOUDUN: Hero = {
  id: 'xiahoudun',
  name: '夏侯惇',
  faction: 'wei',
  maxHp: 4,
  gender: 'male',
  // 刚烈（2025-09 官方调整后的口径，国战与身份局一致）：
  // 受到伤害后判定，非红桃则由**伤害来源选择一项**。
  //
  // 这是第一处「钩子内发起询问」。它依赖 engine.ts 的 runHooksPausable：
  // 询问会把伤害结算流程打断，引擎把「剩下的流程」记进续接队列，
  // 等来源选完再接着跑。挂在不支持挂起的时机上会被静默吞掉。
  hooks: [
    {
      timing: 'afterDamage',
      skillId: '刚烈',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
        if (!payload?.attack || !payload.damage) return;
        const source = getPlayer(ctx.state, payload.attack.sourceId);
        if (!source || source.seatId === ctx.player.seatId) return; // 无来源或自伤不触发
        // 统一技能判定（鬼才/鬼道可改判、天妒可收牌）；判定者＝夏侯惇本人
        ctx.api.judge('刚烈', (judgeCard) => {
          if (!judgeCard) return;
          // 判定的**所属**是发动技能的人（夏侯惇），不是被刚烈的目标——
          // 官方口径：铁骑/刚烈这类「技能拥有者判定」的判定牌不受小乔·红颜影响。
          if (cardAsSeenBy(ctx.state, ctx.player, judgeCard).suit === 'heart') {
            pushLog(ctx.state, 'skill', '判定为红桃，【刚烈】无效。');
            return;
          }
          ganglieEffect(ctx, source);
        });
      },
    },
  ],
  skills: [
    {
      name: '刚烈',
      desc: '当你受到伤害后，你可以进行判定：若结果不为红桃，伤害来源选择一项——1.弃置两张手牌；2.受到你造成的1点伤害。',
    },
  ],
};

/** 刚烈判定不为红桃之后的效果（伤害来源二选一） */
function ganglieEffect(ctx: HookContext, source: Player): void {
  const holder = ctx.player;
  const discardsNum = Math.min(2, source.hand.length);
  // 没有手牌时选项一等于什么都没做，就不摆出来了
  const options: { id: string; label: string }[] = [
    { id: 'damage', label: `受到 ${holder.name} 造成的 1 点伤害` },
  ];
  if (discardsNum > 0) {
    options.unshift({
      id: 'discard',
      label: `弃置${discardsNum === 2 ? '两' : '一'}张手牌`,
    });
  }
  ctx.api.askChoice(
    ctx.state,
    source.seatId,
    `${holder.name} 对你发动了【刚烈】：请选择一项`,
    options,
    (st, p, picked) => {
      if (picked === 'discard') {
        // 由来源**自己挑**要弃哪两张（选牌原语）
        const hand = p.hand.slice();
        const need = Math.min(2, hand.length);
        ctx.api.askPickCards(
          st,
          p.seatId,
          '请选择要弃置的手牌',
          hand,
          need,
          need,
          (st2, p2, chosen) => {
            for (const c of chosen) {
              removeCard(p2.hand, c.id);
              toDiscard(st2, c);
            }
            pushLog(st2, 'skill', `${p2.name} 弃置了 ${chosen.length} 张手牌。`);
          },
        );
        return;
      }
      pushLog(st, 'skill', `${p.name} 选择受到 1 点伤害。`);
      // 伤害由刚烈持有者造成（不是来源自己）
      ctx.api.dealDamage(p, 1, holder.seatId);
    },
  );
}

const XUCHU: Hero = {
  id: 'xuchu',
  name: '许褚',
  faction: 'wei',
  maxHp: 4,
  gender: 'male',
  combos: ['caocao'],
  // 伤害加成由引擎在【杀】与【决斗】的结算处读取
  dealtDamageBonus: (_state, self) => self.flags.damageBonusThisTurn,
  // 裸衣（身份局）：摸牌阶段少摸一张，本回合【杀】【决斗】伤害+1
  hooks: [
    {
      timing: 'drawPhase',
      skillId: '裸衣',
      handler: (ctx) => {
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【裸衣】？',
          [
            { id: 'yes', label: '发动（少摸一张牌，本回合【杀】【决斗】伤害 +1）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            p.flags.drawCountDelta -= 1;
            p.flags.damageBonusThisTurn = 1;
            pushLog(st, 'skill', `${p.name} 发动【裸衣】，本回合【杀】与【决斗】伤害 +1。`);
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '裸衣',
      desc: '摸牌阶段，你可以少摸一张牌；若如此做，本回合你使用【杀】或【决斗】造成的伤害+1。',
    },
  ],
  // 国战：代价改成「摸牌阶段结束时弃置一张牌」，所以挂在 drawPhaseEnd 而不是 drawPhase
  guozhan: {
    hooks: [
      {
        timing: 'drawPhaseEnd',
        handler: (ctx) => {
          if (ctx.player.hand.length === 0) return;
          ctx.api.askChoice(
            ctx.state,
            ctx.player.seatId,
            '是否发动【裸衣】？',
            [
              { id: 'yes', label: '弃一张牌，本回合【杀】【决斗】伤害 +1' },
              { id: 'no', label: '不发动' },
            ],
            (st, p, picked) => {
              if (picked !== 'yes') return;
              ctx.api.askPickCards(
                st,
                p.seatId,
                '【裸衣】：选择要弃置的一张牌',
                p.hand.slice(),
                1,
                1,
                (st2, p2, chosen) => {
                  for (const c of chosen) {
                    removeCard(p2.hand, c.id);
                    toDiscard(st2, c);
                  }
                  p2.flags.damageBonusThisTurn = 1;
                  pushLog(st2, 'skill', `${p2.name} 发动【裸衣】，本回合【杀】与【决斗】伤害 +1。`);
                },
              );
            },
          );
        },
      },
    ],
    skills: [
      {
        name: '裸衣',
        desc: '摸牌阶段结束时，你可以弃置一张牌；若如此做，本回合你为伤害来源的【杀】或【决斗】造成的伤害+1。（国战版）',
      },
    ],
  },
};

const HUATUO: Hero = {
  id: 'huatuo',
  name: '华佗',
  faction: 'qun',
  maxHp: 3,
  gender: 'male',
  // 急救：红色牌当【桃】（用于濒死救援）
  canUseAs: (card, type) => type === 'tao' && isRed(card),
  // 青囊：出牌阶段限一次，弃一张手牌令一名已受伤角色回复 1 点体力
  activeSkills: [
    {
      id: 'qingnang',
      name: '青囊',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      needsCards: true,
      maxCards: () => 1,
      canUse: (state, player) =>
        player.hand.length > 0 && state.players.some((p) => p.alive && p.hp < p.maxHp),
      execute: (state, player, intent, api) => {
        const ids = intent.cardIds ?? [];
        if (ids.length !== 1) return '请选择一张手牌弃置';
        const card = removeCard(player.hand, ids[0]!);
        if (!card) return '找不到手牌';
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名已受伤的角色';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        if (target.hp >= target.maxHp) return '该角色体力已满';
        toDiscard(state, card);
        const healed = api.heal(target, 1);
        pushLog(
          state,
          'skill',
          `${player.name} 发动【青囊】，弃置【${cardLabel(card)}】，令 ${target.name} 回复 ${healed} 点体力。`,
          { seat: player.seatId, action: 'tao' },
        );
      },
    },
  ],
  skillFields: { 急救: ['canUseAs'] },
  skills: [
    { name: '急救', desc: '你的回合外，可以将一张红色牌当【桃】使用。' },
    {
      name: '青囊',
      desc: '出牌阶段限一次，你可以弃置一张手牌并选择一名已受伤的角色，令其回复 1 点体力。',
    },
  ],
};

const SUNQUAN: Hero = {
  id: 'sunquan',
  name: '孙权',
  faction: 'wu',
  maxHp: 4,
  gender: 'male',
  combos: ['zhouyu'],
  // 救援：同势力的**其他**角色对你使用【桃】时，你额外回复 1 点（国战势力技）
  rescueHealBonusFromFaction: 1,
  lockedFields: ['rescueHealBonusFromFaction'],
  // 制衡：弃任意张牌→摸等量
  activeSkills: [
    {
      id: 'zhiheng',
      name: '制衡',
      oncePerTurn: true,
      minTargets: 0,
      maxTargets: 0,
      needsCards: true,
      canUse: (_state, player) => player.hand.length > 0,
      execute: (state, player, intent, _api) => {
        const ids = intent.cardIds ?? [];
        if (ids.length === 0) return '请选择至少一张牌';
        const discarded: Card[] = [];
        for (const id of ids) {
          const c = removeCard(player.hand, id);
          if (!c) return `找不到手牌 ${id}`;
          discarded.push(c);
        }
        for (const c of discarded) toDiscard(state, c);
        pushLog(state, 'skill', `${player.name} 发动【制衡】，弃 ${discarded.length} 张牌。`);
        for (let i = 0; i < discarded.length; i++) {
          const drawn = drawOne(state);
          if (drawn) player.hand.push(drawn);
        }
      },
    },
  ],
  skills: [{ name: '制衡', desc: '出牌阶段限一次，你可以弃置任意张牌，然后摸等量的牌。' }],
  // 国战：制衡限「至多 X 张」（X = 你的体力上限），身份局无张数上限
  guozhan: {
    activeSkills: [
      {
        id: 'zhiheng',
        name: '制衡',
        oncePerTurn: true,
        minTargets: 0,
        maxTargets: 0,
        needsCards: true,
        maxCards: (ctx) => ctx.maxHp,
        canUse: (_state, player) => player.hand.length > 0,
        execute: (state, player, intent, _api) => {
          const ids = intent.cardIds ?? [];
          if (ids.length === 0) return '请选择至少一张牌';
          if (ids.length > player.maxHp)
            return `国战【制衡】最多弃置 ${player.maxHp} 张（体力上限）`;
          const discarded: Card[] = [];
          for (const id of ids) {
            const c = removeCard(player.hand, id);
            if (!c) return `找不到手牌 ${id}`;
            discarded.push(c);
          }
          for (const c of discarded) toDiscard(state, c);
          pushLog(state, 'skill', `${player.name} 发动【制衡】，弃 ${discarded.length} 张牌。`);
          for (let i = 0; i < discarded.length; i++) {
            const drawn = drawOne(state);
            if (drawn) player.hand.push(drawn);
          }
        },
      },
    ],
    skills: [
      {
        name: '制衡',
        desc: '出牌阶段限一次，你可以弃置至多 X 张牌（X 为你的体力上限），然后摸等量的牌。（国战版）',
      },
      {
        name: '救援',
        desc: '锁定技，其他吴势力角色对你使用【桃】时，你额外回复 1 点体力。',
      },
    ],
  },
};

const ZHOUYU: Hero = {
  id: 'zhouyu',
  name: '周瑜',
  faction: 'wu',
  maxHp: 3,
  gender: 'male',
  combos: ['sunquan', 'huanggai'],
  // 反间（简化）：展示1手牌给目标→目标若有不同类型手牌则交给周瑜，否则受1伤害
  activeSkills: [
    {
      id: 'fanjian',
      name: '反间',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      needsCards: true,
      canUse: (_state, player) => player.hand.length > 0,
      execute: (state, player, intent, api) => {
        const ids = intent.cardIds ?? [];
        if (ids.length === 0) return '请选择一张手牌';
        const shownCard = removeCard(player.hand, ids[0]!);
        if (!shownCard) return '找不到手牌';
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名目标';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        if (target.seatId === player.seatId) return '不能选择自己';
        pushLog(
          state,
          'skill',
          `${player.name} 发动【反间】，向 ${target.name} 展示 ${cardLabel(shownCard)}。`,
        );
        // 目标自动响应：找一张不同类型的手牌交给周瑜
        const diffTypeCard = target.hand.find((c) => c.type !== shownCard.type);
        if (diffTypeCard) {
          removeCard(target.hand, diffTypeCard.id);
          player.hand.push(diffTypeCard);
          target.hand.push(shownCard);
          pushLog(
            state,
            'skill',
            `${target.name} 交给 ${player.name} ${cardLabel(diffTypeCard)}，并获得 ${cardLabel(shownCard)}。`,
          );
        } else {
          pushLog(state, 'skill', `${target.name} 无不同类型手牌，受到 1 点伤害。`);
          player.hand.push(shownCard);
          api.dealDamage(target, 1, player.seatId);
        }
      },
    },
  ],
  extraDraw: 1,
  // 英姿是由 extraDraw 这个字段实现的，摘它得以字段为单位（见 Hero.skillFields）
  skillFields: { 英姿: ['extraDraw'] },
  skills: [
    { name: '英姿', desc: '摸牌阶段，你可以多摸一张牌。' },
    {
      name: '反间',
      desc: '出牌阶段限一次，展示一张手牌给目标：目标交回一张不同类型手牌，或受1伤害。（简化版）',
    },
  ],
  // 国战（2.110 调整）：英姿改为锁定技，并追加「手牌上限 = 体力上限」
  guozhan: {
    extraDraw: 1,
    handLimit: (_state, player) => player.maxHp,
    lockedFields: ['extraDraw', 'handLimit'],
    skillFields: { 英姿: ['extraDraw', 'handLimit'] },
    // 反间（2.110 国战版）：展示一张手牌交给目标，目标「选择一项」——
    // 1. 展示所有手牌，弃置与此牌花色相同的所有牌；2. 失去 1 点体力。
    // 由通用的 askChoice 机制实现（见 engine.askChoice）。
    activeSkills: [
      {
        id: 'fanjian',
        name: '反间',
        oncePerTurn: true,
        minTargets: 1,
        maxTargets: 1,
        needsCards: true,
        maxCards: () => 1,
        canUse: (_state, player) => player.hand.length > 0,
        execute: (state, player, intent, api) => {
          const ids = intent.cardIds ?? [];
          if (ids.length !== 1) return '请选择一张手牌展示';
          const card = removeCard(player.hand, ids[0]!);
          if (!card) return '找不到手牌';
          const targetId = intent.targetIds[0];
          if (!targetId) return '请选择一名其他角色';
          const target = getPlayer(state, targetId);
          if (!target || !target.alive) return '目标无效';
          if (target.seatId === player.seatId) return '不能选择自己';
          target.hand.push(card);
          pushLog(
            state,
            'skill',
            `${player.name} 发动【反间】，展示【${cardLabel(card)}】并交给 ${target.name}。`,
          );
          api.askChoice(
            state,
            target.seatId,
            `${player.name} 对你发动了【反间】（${cardLabel(card)}）：请选择一项`,
            [
              { id: 'discard', label: '展示所有手牌，弃置与此牌花色相同的所有牌' },
              { id: 'loseHp', label: '失去 1 点体力' },
            ],
            (st, p, picked) => {
              if (picked === 'loseHp') {
                pushLog(st, 'skill', `${p.name} 选择失去 1 点体力。`);
                api.loseHp(p, 1);
                return;
              }
              // 展示手牌并弃置同花色
              pushLog(
                st,
                'skill',
                `${p.name} 展示手牌：${p.hand.map((c) => cardLabel(c)).join('、') || '（无）'}。`,
              );
              const same = p.hand.filter((c) => c.suit === card.suit);
              for (const c of same) {
                removeCard(p.hand, c.id);
                toDiscard(st, c);
              }
              pushLog(
                st,
                'skill',
                `弃置了 ${same.length} 张与【${cardLabel(card)}】花色相同的牌。`,
              );
            },
            // 选完回到周瑜的出牌阶段，否则这一局就卡住了
            player.seatId,
          );
        },
      },
    ],
    skills: [
      {
        name: '英姿',
        desc: '锁定技，摸牌阶段，你多摸一张牌；你的手牌上限等于你的体力上限。（国战版）',
      },
      {
        name: '反间',
        desc: '出牌阶段限一次，你可以展示一张手牌并将之交给一名其他角色，该角色选择一项：1.展示所有手牌，然后弃置与此牌花色相同的所有牌；2.失去1点体力。（国战版）',
      },
    ],
  },
};

const GANNING: Hero = {
  id: 'ganning',
  name: '甘宁',
  faction: 'wu',
  maxHp: 4,
  gender: 'male',
  // 奇袭：黑色牌当【过河拆桥】
  canUseAs: (card, type) => type === 'guohe' && !isRed(card),
  skillFields: { 奇袭: ['canUseAs'] },
  skills: [{ name: '奇袭', desc: '你可以将一张黑色牌当【过河拆桥】使用。' }],
};

const HUANGGAI: Hero = {
  id: 'huanggai',
  name: '黄盖',
  faction: 'wu',
  maxHp: 4,
  gender: 'male',
  combos: ['zhouyu'],
  // 苦肉：失去1体力→摸2张
  activeSkills: [
    {
      id: 'kurou',
      name: '苦肉',
      oncePerTurn: true,
      minTargets: 0,
      maxTargets: 0,
      canUse: (_state, player) => player.hp > 0,
      execute: (state, player, _intent, api) => {
        pushLog(state, 'skill', `${player.name} 发动【苦肉】，失去 1 点体力。`, {
          seat: player.seatId,
          action: 'selfhurt',
        });
        api.loseHp(player, 1);
        const drawn: Card[] = [];
        for (let i = 0; i < 2; i++) {
          const c = drawOne(state);
          if (c) drawn.push(c);
        }
        player.hand.push(...drawn);
        pushLog(state, 'skill', `${player.name} 摸了 ${drawn.length} 张牌。`);
      },
    },
  ],
  skills: [
    { name: '苦肉', desc: '出牌阶段，你可以失去 1 点体力，然后摸两张牌。（简化：限1次/回合）' },
  ],
  // 国战（新国战）：苦肉从「可多次发动、失1体力摸2张」改成
  // 「限一次、弃一张牌、失1体力、摸三张，然后本回合可额外使用一张【杀】」
  guozhan: {
    activeSkills: [
      {
        id: 'kurou',
        name: '苦肉',
        oncePerTurn: true,
        minTargets: 0,
        maxTargets: 0,
        needsCards: true,
        maxCards: () => 1,
        canUse: (_state, player) => player.hp > 0 && player.hand.length > 0,
        execute: (state, player, intent, api) => {
          const ids = intent.cardIds ?? [];
          if (ids.length !== 1) return '请选择一张牌弃置';
          const c = removeCard(player.hand, ids[0]!);
          if (!c) return '找不到手牌';
          toDiscard(state, c);
          pushLog(
            state,
            'skill',
            `${player.name} 发动【苦肉】，弃置【${cardLabel(c)}】并失去 1 点体力。`,
            {
              seat: player.seatId,
              action: 'selfhurt',
            },
          );
          api.loseHp(player, 1);
          const drawn: Card[] = [];
          for (let i = 0; i < 3; i++) {
            const d = drawOne(state);
            if (d) drawn.push(d);
          }
          player.hand.push(...drawn);
          pushLog(state, 'skill', `${player.name} 摸了 ${drawn.length} 张牌。`);
          // 本回合可额外使用一张【杀】：把已出杀数退 1（下限 0）即可
          player.flags.shaCountThisTurn = Math.max(0, player.flags.shaCountThisTurn - 1);
          pushLog(state, 'skill', `本回合可额外使用一张【杀】。`);
        },
      },
    ],
    skills: [
      {
        name: '苦肉',
        desc: '出牌阶段限一次，你可以弃置一张牌，失去 1 点体力并摸三张牌，然后本回合可额外使用一张【杀】。（国战版）',
      },
    ],
  },
};

// —— 以下为「按最新国战标准补武将」新增的武将 ——
// 说明：身份局与国战行为一致时只写一份 skills；有差异的写 guozhan.skills。
// 无法在本引擎忠实实现的技能不收入（拼点/觉醒技/限定技），见 docs/guozhan-reference.md §6。

const CAOCAO: Hero = {
  id: 'caocao',
  name: '曹操',
  faction: 'wei',
  maxHp: 4,
  gender: 'male',
  // ⚠️ 这里原本挂着 `isLord: true`（当时想给将来补君主留个伏笔），但它会连带开启
  //    **君主规则**：和任何同势力武将都算珠联璧合、亮将必须两张一起亮、且只能当主将。
  //    官方国战里曹操/刘备就是**普通武将**，君主是另一张牌（君曹操/君刘备）——所以把标记摘了，
  //    将来真做君主时新增独立的武将条目（那才是官方模型），这几个分支也就自然生效了。
  combos: ['xuchu'], // 曹操 ❤ 许褚
  // 护驾：需要打出【闪】时，可以令其他魏势力角色代打（势力技）
  factionCall: { id: 'hujia', name: '护驾', needType: 'shan' },
  // 奸雄：受到伤害后，获得对你造成伤害的那张牌
  hooks: [
    {
      timing: 'afterDamage',
      skillId: '奸雄',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
        const cardId = payload?.attack?.cardId;
        if (!cardId) return;
        // 伤害牌此时已在弃牌堆里（杀/锦囊用过就进了弃牌堆）
        const idx = ctx.state.discard.findIndex((c) => c.id === cardId);
        if (idx < 0) return;
        const [card] = ctx.state.discard.splice(idx, 1);
        if (!card) return;
        ctx.player.hand.push(card);
        pushLog(
          ctx.state,
          'skill',
          `${ctx.player.name} 发动【奸雄】，获得对其造成伤害的【${cardLabel(card)}】。`,
        );
      },
    },
  ],
  skills: [
    { name: '奸雄', desc: '当你受到伤害后，你可以获得对你造成伤害的牌。' },
    {
      name: '护驾',
      desc: '势力技，当你需要使用或打出一张【闪】时，你可以令其他魏势力角色选择是否打出一张【闪】（视为由你使用或打出）。',
    },
  ],
};

const HUANGYUEYING: Hero = {
  id: 'huangyueying',
  name: '黄月英',
  faction: 'shu',
  maxHp: 3,
  gender: 'female',
  combos: ['zhugeliang'], // 诸葛亮 ❤ 黄月英
  ignoresTrickDistance: true, // 奇才
  lockedFields: ['ignoresTrickDistance'],
  // 集智：使用一张非延时类锦囊牌时，摸一张牌（摸到基本牌还可以弃之再摸一张）。
  //
  // ⚠️ 挂 `cardActionStarted`（**可挂起**）而不是 `useCard`（同步分发）：后半句要发问，
  // 同步时机上的询问会被后续流程静默覆盖（本引擎的老坑）。这个时机是「使用/打出」的公共点，
  // 用 `isInstantTrick` 过滤后正好是「使用非延时锦囊」——包括响应时使用【无懈可击】。
  hooks: [
    {
      timing: 'cardActionStarted',
      skillId: '集智',
      handler: (ctx) => {
        const payload = ctx.payload as { card?: Card } | undefined;
        const card = payload?.card;
        if (!card || !isInstantTrick(card)) return;
        const me = ctx.player;
        const c = drawOne(ctx.state);
        if (!c) return;
        me.hand.push(c);
        pushLog(ctx.state, 'skill', `${me.name} 发动【集智】，摸了 1 张牌。`);
        // 后半句（官方原文）：「若你以此法摸到的牌为基本牌，你可以弃置之，然后摸一张牌。」
        // ⚠️ 只有**第一张**会触发（摸到的第二张不再继续滚），所以这里不做递归。
        if (!isBasicCard(c) || me.hand.length === 0) return;
        if (!me.hand.some((x) => x.id === c.id)) return; // 牌已经不在了（极端情况）
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          `【集智】：摸到的是基本牌【${cardLabel(c)}】，是否弃置并再摸一张？`,
          [
            { id: 'yes', label: '弃置并再摸一张' },
            { id: 'no', label: '留在手里' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            removeCard(p.hand, c.id);
            toDiscard(st, c);
            const again = drawOne(st);
            if (again) p.hand.push(again);
            pushLog(
              st,
              'skill',
              `${p.name} 的【集智】：弃置【${cardLabel(c)}】${again ? `并摸了【${cardLabel(again)}】` : '，牌堆已空'}。`,
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '集智',
      desc: '当你使用一张非延时类锦囊牌时，你可以摸一张牌；若你以此法摸到的牌为基本牌，你可以弃置之，然后摸一张牌。',
    },
    { name: '奇才', desc: '锁定技，你使用锦囊牌无距离限制。' },
  ],
};

/**
 * 观星：观看牌堆顶 X 张（X = 存活角色数，至多 5），把其中若干张置于牌堆底。
 *
 * 官方是「以**任意顺序**置于牌堆顶或牌堆底」——本实现只让玩家选「哪些沉底」，
 * 留在牌堆顶的保持原序（简化）。顺序自由需要带排序的选牌界面。
 *
 * 牌堆的「顶」是数组末尾（drawOne 从末尾 pop），所以：
 * 留在顶上的要**倒序**压回去，沉底的要 unshift 到数组最前面（最早被抽到时才会最后抽到）。
 */
function guanxing(state: GameState, player: Player, api: SkillApi): void {
  const count = Math.min(5, alivePlayers(state).length);
  const top: Card[] = [];
  for (let i = 0; i < count; i++) {
    const c = drawOne(state);
    if (!c) break;
    top.push(c);
  }
  if (top.length === 0) return;
  /**
   * 摆放：牌堆在引擎里是**栈**——`deck` 末尾是牌堆顶（drawOne 从末尾抽），
   * 数组开头是牌堆底。`topPile` / `bottomPile` 里的顺序都是**玩家点的顺序**
   * （第一张＝该堆里最先被抽到的）。
   */
  const place = (st: GameState, p: Player, topPile: Card[], bottomPile: Card[]): void => {
    for (let i = topPile.length - 1; i >= 0; i--) st.deck.push(topPile[i]!);
    // 沉底的那批：先被抽到的排在最靠后（数组开头是最深的牌堆底，所以整批要倒过来）
    st.deck.unshift(...[...bottomPile].reverse());
    pushLog(
      st,
      'skill',
      `${p.name} 发动【观星】：${topPile.length} 张置于牌堆顶，${bottomPile.length} 张置于牌堆底。`,
    );
  };
  // 第一步：牌堆**顶**放哪些、按什么顺序（按官方原文的顺序：先顶后底）
  api.askPickCards(
    state,
    player.seatId,
    `【观星】：观看牌堆顶 ${top.length} 张。选择要置于牌堆**顶**的牌（按点击顺序＝从最上面往下数；一张不选＝都不动，全部按原序留在牌堆顶）`,
    top,
    0,
    top.length,
    (st, p, topPicked) => {
      // 「一张不选」＝什么都不动（旧行为）：全部按原序留在牌堆顶，也不再问第二步。
      // 想把某几张放回牌堆底，就在第一步里把**其余的**挑出来（挑出来的按点击顺序置顶）。
      if (topPicked.length === 0) {
        place(st, p, top, []);
        return;
      }
      const topIds = new Set(topPicked.map((c) => c.id));
      const rest = top.filter((c) => !topIds.has(c.id));
      if (rest.length === 0) {
        place(st, p, topPicked, []);
        return;
      }
      // 第二步：剩下的这些，哪些沉底、按什么顺序（先被抽到的先点）
      api.askPickCards(
        st,
        p.seatId,
        `【观星】：剩下的 ${rest.length} 张里，选择要置于牌堆**底**的牌（按点击顺序＝沉底后先抽到的先点；一张不选＝全部按原序沉底）`,
        rest,
        0,
        rest.length,
        (st2, p2, bottomPicked) => {
          // ⚠️ 「一张不选」时 bottom = rest、middle 必须为**空**——否则同一张牌会被同时
          // 放进「顶上那批」和「沉底那批」两个数组里（牌堆里出现两张同样的牌！）
          const bottomIds = new Set(bottomPicked.map((c) => c.id));
          const middle = bottomPicked.length > 0 ? rest.filter((c) => !bottomIds.has(c.id)) : [];
          const bottom = bottomPicked.length > 0 ? bottomPicked : rest;
          place(st2, p2, [...topPicked, ...middle], bottom);
        },
        // 看牌堆顶是私密信息：日志只记张数，不记牌名
        { secret: true },
      );
    },
    { secret: true },
  );
}

/**
 * 突袭：让张辽依次挑「至多两名其他角色」，然后各拿他们一张手牌。
 *
 * 分两步而不是一步：先定人再拿牌（拿牌要一张张问，因为要看对方手牌）。
 * 选人阶段给一个「不再选人」的选项——官方是「至多两名」，只选一个也合法。
 */
function tuxiAskTargets(
  state: GameState,
  player: Player,
  picked: string[],
  api: SkillApi,
  // 技能名只是日志/提示文案的差别：张郃·巧变跳过摸牌阶段时用的是**同一套**拿手牌流程
  skillName = '突袭',
): void {
  const candidates = state.players.filter(
    (p) => p.alive && p.seatId !== player.seatId && p.hand.length > 0 && !picked.includes(p.seatId),
  );
  if (picked.length >= 2 || candidates.length === 0) {
    tuxiTakeCards(state, player, picked, 0, api, skillName);
    return;
  }
  const options = candidates.map((p) => ({ id: p.seatId, label: p.name }));
  if (picked.length >= 1) options.push({ id: '__stop', label: '不再选人' });
  api.askChoice(
    state,
    player.seatId,
    `【${skillName}】：选择要拿谁的一张手牌（已选 ${picked.length} 人，至多 2 人）`,
    options,
    (st, p, id) => {
      if (id === '__stop') {
        tuxiTakeCards(st, p, picked, 0, api, skillName);
        return;
      }
      tuxiAskTargets(st, p, [...picked, id], api, skillName);
    },
  );
}

/** 依次从已定目标手里挑一张手牌拿走 */
function tuxiTakeCards(
  state: GameState,
  player: Player,
  targets: string[],
  i: number,
  api: SkillApi,
  skillName = '突袭',
): void {
  if (i >= targets.length) {
    pushLog(
      state,
      'skill',
      `${player.name} 发动【${skillName}】，获得 ${targets.length} 名角色的各一张手牌。`,
    );
    return;
  }
  const t = getPlayer(state, targets[i]!);
  if (!t || !t.alive || t.hand.length === 0) {
    tuxiTakeCards(state, player, targets, i + 1, api, skillName);
    return;
  }
  api.askPickCards(
    state,
    player.seatId,
    `【${skillName}】：选择获得 ${t.name} 的一张手牌`,
    t.hand.slice(),
    1,
    1,
    (st, p, chosen) => {
      const c = chosen[0];
      if (c) api.transferCard(t.seatId, c, p.seatId);
      tuxiTakeCards(st, p, targets, i + 1, api, skillName);
    },
  );
}

/** 突袭的入口：先问是否发动，愿意就少摸一张，然后选人拿牌 */
function askTuxi(ctx: { state: GameState; player: Player; api: SkillApi }): void {
  const others = ctx.state.players.filter(
    (p) => p.alive && p.seatId !== ctx.player.seatId && p.hand.length > 0,
  );
  if (others.length === 0) return;
  ctx.api.askChoice(
    ctx.state,
    ctx.player.seatId,
    '是否发动【突袭】？',
    [
      { id: 'yes', label: '发动（少摸一张牌，改为获得至多两名角色各一张手牌）' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      // 少摸一张：摸牌阶段紧接着会读这个增减量
      p.flags.drawCountDelta -= 1;
      pushLog(st, 'skill', `${p.name} 发动【突袭】，本回合少摸一张牌。`);
      tuxiAskTargets(st, p, [], ctx.api);
    },
  );
}

/** 「是否发动观星」的询问（准备阶段，可挂起） */
function askGuanxing(ctx: { state: GameState; player: Player; api: SkillApi }): void {
  ctx.api.askChoice(
    ctx.state,
    ctx.player.seatId,
    '是否发动【观星】？',
    [
      { id: 'yes', label: '发动' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked === 'yes') guanxing(st, p, ctx.api);
    },
  );
}

const ZHUGELIANG: Hero = {
  id: 'zhugeliang',
  name: '诸葛亮',
  faction: 'shu',
  maxHp: 3,
  gender: 'male',
  combos: ['huangyueying'],
  // 空城：没有手牌时，不能被【杀】或【决斗】指定为目标
  cannotBeTargetOf: (_state, self, card) =>
    self.hand.length === 0 && (card.type === 'sha' || card.type === 'juedou'),
  lockedFields: ['cannotBeTargetOf'],
  // 观星：准备阶段，你可以观看牌堆顶 X 张，把其中若干张置于牌堆底
  hooks: [
    {
      timing: 'turnStart',
      skillId: '观星',
      handler: (ctx) => askGuanxing(ctx),
    },
  ],
  skills: [
    {
      name: '观星',
      desc: '准备阶段，你可以观看牌堆顶 X 张牌（X 为存活角色数且至多为 5），然后将其中任意张置于牌堆底。（简化：留在牌堆顶的保持原序，不做任意排序）',
    },
    { name: '空城', desc: '锁定技，若你没有手牌，你不能成为【杀】或【决斗】的目标。' },
  ],
};

/**
 * 狂骨：每造成 1 点伤害就有一个「回复 1 点体力 / 摸一张牌 / 不发动」的机会。
 *
 * 「扣减体力前」的距离：距离只跟座次与装备有关、跟体力无关，而这个时机仍在阵亡结算
 * 之前（受伤者 hp<=0 但还没被移出座次），所以此刻算出来的就是官方要的那个距离。
 */
function askKuanggu(ctx: HookContext, left?: number): void {
  const state = ctx.state;
  const me = ctx.player;
  const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
  const attack = payload?.attack;
  const times = left ?? payload?.damage ?? 0;
  if (!attack || times <= 0) return;
  if (attack.sourceId !== me.seatId) return;
  if (attack.targetId === me.seatId) return; // 自伤不触发
  if (distance(state, me.seatId, attack.targetId) > 1) return;
  ctx.api.askChoice(
    state,
    me.seatId,
    times > 1 ? `【狂骨】：选择一项（本次伤害还有 ${times} 点没结算）` : '【狂骨】：选择一项',
    [
      { id: 'heal', label: '回复 1 点体力' },
      { id: 'draw', label: '摸一张牌' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked === 'heal') {
        const healed = ctx.api.heal(p, 1);
        pushLog(st, 'skill', `${p.name} 发动【狂骨】，回复 ${healed} 点体力。`);
      } else if (picked === 'draw') {
        const c = drawOne(st);
        if (c) p.hand.push(c);
        pushLog(st, 'skill', `${p.name} 发动【狂骨】，摸了 1 张牌。`);
      }
      // 多点伤害逐点问：这一点的选择不影响下一点
      if (times > 1) askKuanggu(ctx, times - 1);
    },
  );
}

const WEIYAN: Hero = {
  id: 'weiyan',
  name: '魏延',
  faction: 'shu',
  maxHp: 4,
  gender: 'male',
  combos: ['huangzhong'], // 黄忠 ❤ 魏延
  // 狂骨（2019 国标 / 界魏延文本，已核）：当你对一名角色造成 1 点伤害后，若其**扣减体力前**
  // 你计算与其的距离不大于 1，你可以选择一项：①回复 1 点体力；②摸一张牌。
  //
  // ⚠️ 与旧国战文本的差别：旧版是**锁定技**、只能回血（「每当你对距离1以内的一名角色
  //    造成1点伤害后，你回复1点体力」）；新版多了「或摸一张牌」，所以它不是锁定技。
  //    多点伤害**逐点结算**（官方 FAQ：酒杀造成 2 点可以一点回血、一点摸牌），
  //    所以按 payload.damage 的次数循环问。
  hooks: [
    {
      // 注意是 afterDamageDealt（派给伤害来源），不是 afterDamage（那是派给受伤者的）
      timing: 'afterDamageDealt',
      skillId: '狂骨',
      handler: (ctx) => askKuanggu(ctx),
    },
  ],
  skills: [
    {
      name: '狂骨',
      desc: '当你对一名角色造成1点伤害后，若其扣减体力前你计算与其的距离不大于1，你可以选择一项：1.回复1点体力；2.摸一张牌。',
    },
  ],
};

const DAQIAO: Hero = {
  id: 'daqiao',
  name: '大乔',
  faction: 'wu',
  maxHp: 3,
  gender: 'female',
  // 国色：方块牌当【乐不思蜀】使用
  canUseAs: (card, type) => type === 'lebu' && card.suit === 'diamond',
  // 流离：成为【杀】的目标时，可以弃一张牌把此【杀】转移给自己攻击范围内的一名其他角色。
  //
  // 改目标靠 api.redirectAttack：钩子把新目标写进 AttackBox，
  // 引擎对新目标重新走一遍「成为目标」的结算（见 engine.becomeTargetFor）。
  hooks: [
    {
      timing: 'becomeTarget',
      skillId: '流离',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext } | undefined;
        const attack = payload?.attack;
        if (!attack || attack.asType !== 'sha') return;
        if (attack.targetId !== ctx.player.seatId) return;
        if (attack.redirected) return; // 已经被改过一次，别再弹回去
        // 要有牌可弃
        const cost = handAndEquipOf(ctx.player);
        if (cost.length === 0) return;
        // 自己攻击范围内要有别的角色
        const reachable = alivePlayers(ctx.state).filter(
          (p) =>
            p.seatId !== ctx.player.seatId && canTarget(ctx.state, ctx.player.seatId, p.seatId),
        );
        if (reachable.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【流离】把此【杀】转移给别人？',
          [
            { id: 'yes', label: '发动（弃置一张牌，转移此【杀】）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            const nowCost = handAndEquipOf(p);
            if (nowCost.length === 0) return;
            ctx.api.askPickCards(
              st,
              p.seatId,
              '【流离】：选择要弃置的一张牌',
              nowCost,
              1,
              1,
              (st2, p2, chosen) => {
                const card = chosen[0];
                if (!card) return;
                ctx.api.discardCard(p2.seatId, card, () => {
                  // 挑人的时候重新算一遍攻击范围（刚弃掉的可能是马）
                  const targets = alivePlayers(st2).filter(
                    (x) => x.seatId !== p2.seatId && canTarget(st2, p2.seatId, x.seatId),
                  );
                  if (targets.length === 0) return;
                  ctx.api.askChoice(
                    st2,
                    p2.seatId,
                    '【流离】：把此【杀】转移给谁？',
                    targets.map((x) => ({ id: x.seatId, label: x.name })),
                    (st3, _p3, newTargetId) => {
                      pushLog(
                        st3,
                        'skill',
                        `${p2.name} 发动【流离】，弃置【${cardLabel(card)}】。`,
                      );
                      ctx.api.redirectAttack(newTargetId);
                    },
                  );
                });
              },
            );
          },
        );
      },
    },
  ],
  skillFields: { 国色: ['canUseAs'] },
  skills: [
    { name: '国色', desc: '你可以将一张方块牌当【乐不思蜀】使用。' },
    {
      name: '流离',
      desc: '当你成为【杀】的目标时，你可以弃置一张牌，将此【杀】转移给你攻击范围内的一名其他角色。',
    },
  ],
};

/** 天香可用的牌：红桃手牌（红颜在场时，黑桃手牌也算红桃） */
function tianxiangHearts(state: GameState, me: Player): Card[] {
  return me.hand.filter((c) => suitSeenAs(state, me, c) === 'heart');
}

/**
 * 天香（**新国战 2018 版**，已核文本）：当你受到伤害时，你可以弃置一张红桃手牌，
 * 防止此伤害并选择一名其他角色，若如此做，你选择一项：
 *   ①令其受到伤害来源对其造成的 1 点伤害，然后摸 X 张牌（X 为其已损失体力值且至多 5）；
 *   ②令其失去 1 点体力，然后其获得你弃置的牌。
 *
 * 实现要点：
 * - 「防止此伤害」走 `damageDealt` 钩子的取消通道：钩子只能设
 *   `flags.damagePrevented`，引擎在钩子跑完之后读它（见 engine 的 damageStep）。
 * - ①的伤害是**新的一次 1 点伤害**（原文是先「防止」再「令其受到」），所以不带原伤害的属性；
 *   来源沿用原来源，且**来源不存在时不给这个选项**（闪电那类没有来源，无法令其受到来源的伤害）。
 * - X 是「然后」摸的，所以按伤害**之后**的已损失体力算（「至多 5」是国战版的封顶）。
 * - 代价与效果一起在最后落地：中途反悔不付代价，与引擎里其它「先问清楚再动手」的技能一致。
 */
function tianxiangGuozhan(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const payload = ctx.payload as { damage?: number; attack?: AttackContext } | undefined;
  const attack = payload?.attack;
  const hearts = tianxiangHearts(state, me);
  const others = state.players.filter((p) => p.alive && p.seatId !== me.seatId);
  if (hearts.length === 0 || others.length === 0) return; // 付不出代价 / 没有别人可选
  ctx.api.askChoice(
    state,
    me.seatId,
    `是否发动【天香】弃置一张红桃手牌，防止这 ${payload?.damage ?? 1} 点伤害？`,
    [
      { id: 'yes', label: '发动' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      ctx.api.askPickCards(
        st,
        p.seatId,
        '【天香】：弃置一张红桃手牌',
        hearts,
        1,
        1,
        (st2, p2, chosen) => {
          const card = chosen[0];
          if (!card) return;
          ctx.api.askChoice(
            st2,
            p2.seatId,
            '【天香】：选择一名其他角色',
            others.map((o) => ({ id: o.seatId, label: o.name })),
            (st3, p3, targetId) => {
              const target = getPlayer(st3, targetId);
              if (!target) return;
              const src = attack?.sourceId ? getPlayer(st3, attack.sourceId) : undefined;
              const options: { id: string; label: string }[] = [];
              if (src) {
                options.push({
                  id: 'damage',
                  label: `令 ${target.name} 受到 ${src.name} 造成的 1 点伤害，然后其摸 X 张牌（X 为其已损失体力值，至多 5）`,
                });
              }
              options.push({
                id: 'loseHp',
                label: `令 ${target.name} 失去 1 点体力，然后其获得你弃置的【${cardLabel(card)}】`,
              });
              ctx.api.askChoice(
                st3,
                p3.seatId,
                '【天香】：选择一项',
                options,
                (st4, p4, option) => {
                  p4.flags.damagePrevented = true;
                  ctx.api.discardCard(p4.seatId, card, () => {
                    pushLog(
                      st4,
                      'skill',
                      `${p4.name} 发动【天香】，弃置【${cardLabel(card)}】防止此伤害。`,
                    );
                    if (option === 'damage' && src) {
                      ctx.api.dealDamage(target, 1, src.seatId, undefined, () => {
                        const x = Math.min(5, Math.max(0, target.maxHp - target.hp));
                        if (x > 0 && target.alive) {
                          for (let i = 0; i < x; i++) {
                            const c = drawOne(st4);
                            if (c) target.hand.push(c);
                          }
                          pushLog(st4, 'skill', `${target.name} 因【天香】摸了 ${x} 张牌。`);
                        }
                      });
                      return;
                    }
                    // ②失去体力（不是伤害：没有来源、不触发卖血技，但会进濒死）
                    ctx.api.loseHp(target, 1, () =>
                      ctx.api.giveDiscardedTo([card], target.seatId, '天香'),
                    );
                  });
                },
              );
            },
          );
        },
      );
    },
  );
}

/**
 * 天香（**身份局/军争原版**）：当你受到伤害时，你可以弃置一张红桃手牌，
 * 将此伤害转移给一名其他角色，然后该角色摸 X 张牌（X 为该角色已损失的体力值）。
 *
 * 与国战版的区别：这里是真的**转移**同一份伤害（属性跟着走），没有二选一。
 */
function tianxiangClassic(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const payload = ctx.payload as { damage?: number; attack?: AttackContext } | undefined;
  const attack = payload?.attack;
  const hearts = tianxiangHearts(state, me);
  const others = state.players.filter((p) => p.alive && p.seatId !== me.seatId);
  if (hearts.length === 0 || others.length === 0) return;
  ctx.api.askChoice(
    state,
    me.seatId,
    `是否发动【天香】弃置一张红桃手牌，将此伤害转移给一名其他角色？`,
    [
      { id: 'yes', label: '发动' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      ctx.api.askPickCards(
        st,
        p.seatId,
        '【天香】：弃置一张红桃手牌',
        hearts,
        1,
        1,
        (st2, p2, chosen) => {
          const card = chosen[0];
          if (!card) return;
          ctx.api.askChoice(
            st2,
            p2.seatId,
            '【天香】：把此伤害转移给谁？',
            others.map((o) => ({ id: o.seatId, label: o.name })),
            (st3, p3, targetId) => {
              const target = getPlayer(st3, targetId);
              if (!target) return;
              p3.flags.damagePrevented = true;
              ctx.api.discardCard(p3.seatId, card, () => {
                pushLog(
                  st3,
                  'skill',
                  `${p3.name} 发动【天香】，弃置【${cardLabel(card)}】，把伤害转移给 ${target.name}。`,
                );
                ctx.api.dealDamage(
                  target,
                  payload?.damage ?? 1,
                  attack?.sourceId ?? '',
                  attack?.attribute,
                  () => {
                    const x = Math.max(0, target.maxHp - target.hp);
                    if (x > 0 && target.alive) {
                      for (let i = 0; i < x; i++) {
                        const c = drawOne(st3);
                        if (c) target.hand.push(c);
                      }
                      pushLog(st3, 'skill', `${target.name} 因【天香】摸了 ${x} 张牌。`);
                    }
                  },
                );
              });
            },
          );
        },
      );
    },
  );
}

/**
 * 小乔 —— 天香 / 红颜。
 *
 * ⚠️ 两个模式的**天香不是同一个技能**：国战 2018 版改成了「防止此伤害 + 二选一」，
 *    身份局/军争还是原来的「转移伤害」；红颜在国战里多一句「出牌阶段，你可明置此武将牌」。
 *    所以身份局版写在顶层、国战版写在 `guozhan` 覆盖块里（取将一律走 getHeroForMode）。
 *
 * 红颜的「黑桃视为红桃」是**全局口径**（手牌/装备/她自己进行的判定），
 * 由 `cardAsSeenBy()` 一处提供，engine/equip/legal 都在用。
 */
/**
 * 徐盛 —— 疑城（君临天下·阵，2019 典藏版文本，已核）：
 * 当一名与你势力相同的角色成为【杀】的目标后，该角色可以摸一张牌，然后弃置一张牌。
 *
 * ⚠️ 与 2013 初版的差别：旧版是**徐盛**决定要不要发动、且只能对他人生效；
 *    2019 典藏版把发动权交给**成为目标的那个角色**，也涵盖徐盛自己。
 *    这里按 2019 口径写（项目统一的取新国战口径）。
 *
 * 「与你势力相同」按引擎既有的**互相认同**口径：双方都得已明置（暗置＝没势力），
 * 徐盛自己当然满足。见 docs/guozhan-roster.md 里 effectiveFaction 的说明。
 *
 * 【鸟翔】（阵法技）**已实现**：同一个围攻关系里，围攻角色出【杀】指定被围攻者时，
 *    那名角色需**依次使用两张【闪】**才能抵消（`requiredShan = 2`，与蒋钦同款钩子）。
 */
/**
 * **队列**：存活座次里「连续相邻、势力相同」的一段。返回某人所在的那一段（含他自己）。
 * 用于阵法技（曹洪·鹤翼「与你处于同一队列的其他角色视为拥有飞影」）。
 */
export function formationQueue(state: GameState, player: Player): Player[] {
  const alive = state.seatOrder
    .map((id) => getPlayer(state, id))
    // 被【调虎离山】移出的角色**不计入座次**（这是那张牌的核心效果），所以也不能当队列的
    // 「断开点」——吴景·调归正是靠「把中间的人调走、让同势力连起来」形成队列的。
    .filter((p): p is Player => !!p && p.alive && !p.flags.removedFromSeating);
  const n = alive.length;
  if (n < 2) return [];
  const idx = alive.findIndex((p) => p.seatId === player.seatId);
  if (idx < 0) return [];
  const faction = effectiveFaction(state, player);
  if (!faction) return [player];
  const out: Player[] = [player];
  // 往两边各走一圈，直到遇到不同势力（或绕回自己）
  for (const step of [1, -1]) {
    for (let k = 1; k < n; k++) {
      const p = alive[(((idx + step * k) % n) + n) % n]!;
      if (p.seatId === player.seatId) break;
      if (effectiveFaction(state, p) !== faction) break;
      out.push(p);
    }
  }
  return out;
}

/**
 * **围攻关系**：官方定义（三国杀移动版·国战 阵法技说明）——
 * 「一名角色的上家和下家为另外两名**势力相同**的角色（且与该角色势力不同）时，该角色被
 * **围攻**，其上家和下家称为**围攻角色**」。
 *
 * ⚠️ 两个邻居**彼此**势力相同是定义的一部分（光「两个都是敌人」不算：四人局四家不同时，
 * 若只看「左右都不是我」会让**所有人**都被判成被围攻）。
 *
 * 返回 { besiegedSeatId, besiegers } 的列表（存活 ≥4 人才成立——阵法技的共同前提；
 * 被【调虎离山】移出座次的人不计座次）。
 */
export function siegeRelations(
  state: GameState,
): { besiegedSeatId: string; besiegers: string[] }[] {

  const alive = state.seatOrder
    .map((id) => getPlayer(state, id))
    // 被【调虎离山】移出座次的人**不计入座次**（与 baseDistance / formationQueue 同一口径）
    .filter((p): p is Player => !!p && p.alive && !p.flags.removedFromSeating);
  const n = alive.length;
  if (n < 4) return [];
  const out: { besiegedSeatId: string; besiegers: string[] }[] = [];
  for (let i = 0; i < n; i++) {
    const me = alive[i]!;
    const my = effectiveFaction(state, me);
    // 官方阵法口径：**野心家不能成为围攻角色**（只能被围攻）——围攻者里出现野心家时整个关系不成立
    const neighbors = [alive[(i - 1 + n) % n]!, alive[(i + 1) % n]!];
    if (neighbors.some((p) => effectiveFaction(state, p) === 'ambitionist')) continue;
    if (!my) continue;
    const left = alive[(i + n - 1) % n]!;
    const right = alive[(i + 1) % n]!;
    const lf = effectiveFaction(state, left);
    const rf = effectiveFaction(state, right);
    if (!lf || !rf) continue; // 未确定势力 = 无势力 → 构不成关系
    // 上家与下家**同势力**、且都与中间这位不同 → 才是围攻关系
    if (lf === rf && lf !== my) {
      out.push({ besiegedSeatId: me.seatId, besiegers: [left.seatId, right.seatId] });
    }
  }
  return out;
}

// ——————————————————————————————————————————
// 阵法召唤（移动版口径，见 docs/guozhan-roster.md §5.132）
// ——————————————————————————————————————————

/** 某人**当前生效**的阵法技类型（队列型 / 围攻型）。暗将没有势力 → 阵法技整体不成立 → 空。 */
export function formationKindsOf(state: GameState, player: Player): ('queue' | 'siege')[] {
  if (!effectiveFaction(state, player)) return [];
  const kinds = new Set<'queue' | 'siege'>();
  for (const h of effectiveHeroes(state, player)) for (const k of h.formation ?? []) kinds.add(k);
  return [...kinds];
}

/**
 * 假想「这个人亮出这张武将牌」之后，能不能和召唤者形成 `kind` 那种关系。
 *
 * 实现是**改标志位 → 量 → 复原**：不派发任何时机、不写日志，纯粹算一次关系。
 * 这样关系判定永远与正式规则同一套代码（`effectiveFaction` / `formationQueue` / `siegeRelations`），
 * 不会出现「召唤时算一套、真亮将后算另一套」。
 *
 * ⚠️ 君主将（主副将必须同亮）这里只翻一张——两张牌的势力相同，对关系判定没有影响。
 */
function revealWouldJoin(
  state: GameState,
  candidate: Player,
  slot: 'main' | 'deputy',
  summoner: Player,
  kind: 'queue' | 'siege',
): boolean {
  const savedHero = candidate.heroRevealed;
  const savedDeputy = candidate.deputyRevealed;
  if (slot === 'main') candidate.heroRevealed = true;
  else candidate.deputyRevealed = true;
  try {
    const mine = effectiveFaction(state, candidate);
    const theirs = effectiveFaction(state, summoner);
    if (!mine || !theirs || mine !== theirs) return false; // 不同势力 → 免谈
    if (kind === 'queue') {
      return formationQueue(state, summoner).some((p) => p.seatId === candidate.seatId);
    }
    // 围攻型：「与你处于同一围攻关系」——两种都在内：同为围攻角色，或者他围攻的正是你
    return siegeRelations(state).some(
      (r) =>
        (r.besiegers.includes(summoner.seatId) && r.besiegers.includes(candidate.seatId)) ||
        (r.besiegedSeatId === summoner.seatId && r.besiegers.includes(candidate.seatId)),
    );
  } finally {
    candidate.heroRevealed = savedHero;
    candidate.deputyRevealed = savedDeputy;
  }
}

/** 武将牌**均暗置**（未确定势力）的存活角色 */
function isFullyDark(p: Player): boolean {
  return p.alive && !p.heroRevealed && !p.deputyRevealed;
}

/** 这个候选亮哪几张牌能满足召唤（0～2 张：双势力/单势力组合里可能只有一张满足） */
function qualifyingSlots(
  state: GameState,
  candidate: Player,
  summoner: Player,
  kinds: ('queue' | 'siege')[],
): ('main' | 'deputy')[] {
  const slots: ('main' | 'deputy')[] = [];
  for (const slot of ['main', 'deputy'] as const) {
    const heroId = slot === 'main' ? candidate.heroId : candidate.deputyHeroId;
    if (!heroId) continue;
    if (kinds.some((k) => revealWouldJoin(state, candidate, slot, summoner, k))) slots.push(slot);
  }
  return slots;
}

/** 响应顺序：从召唤者的**下一家**起、按行动顺序（国战里就是官方说的「逆时针依次」） */
function summonOrder(state: GameState, summonerSeatId: string): Player[] {
  const n = state.seatOrder.length;
  const start = state.seatOrder.indexOf(summonerSeatId);
  const out: Player[] = [];
  for (let k = 1; k < n; k++) {
    const p = getPlayer(state, state.seatOrder[(start + k) % n]!);
    if (p && p.alive && !p.flags.removedFromSeating) out.push(p);
  }
  return out;
}

/** 现在这一次阵法召唤有没有人可问（没人可问就不该把技能摆出来） */
function formationSummonOffer(state: GameState, player: Player): boolean {
  const kinds = formationKindsOf(state, player);
  if (kinds.length === 0) return false;
  if (state.players.filter((p) => p.alive).length < 4) return false;
  return summonOrder(state, player.seatId).some(
    (p) => isFullyDark(p) && qualifyingSlots(state, p, player, kinds).length > 0,
  );
}

/**
 * **阵法召唤**（阵法技持有者的通用机制，移动版：出牌阶段限一次）。
 *
 * 官方口径（用户 2026-09 提供的移动版资料，见 §5.132）：
 * 「拥有阵法技的角色发起。**能够在明置武将牌后形成该阵法技所需要的队列或围攻关系、
 *   且武将牌均暗置的同势力角色**，可以响应召唤并明置一张武将牌。」可响应、也**可以不响应**；
 * 符合条件的角色按**逆时针方向依次**决定。
 *
 * 三个容易写错的点，这里都照着官方来：
 * 1. **先判「如果亮将能不能形成关系」，再允许响应**——不是先随便亮、亮完再看；
 * 2. **每次有人响应之后要重新算候选人**：一个人亮将可能让后面的人**才**够格（队列往后接）；
 * 3. 「是队友」不够——中间隔着别的势力就不算（队列/围攻都要真的形成）。
 */
function formationSummonImpl(state: GameState, player: Player, api: SkillApi): string | undefined {
  const kinds = formationKindsOf(state, player);
  if (kinds.length === 0) return '你没有阵法技';
  if (state.players.filter((p) => p.alive).length < 4)
    return '阵法技需要场上至少 4 名存活角色';
  const order = summonOrder(state, player.seatId);
  pushLog(state, 'skill', `${player.name} 发起【阵法召唤】。`, { seat: player.seatId });
  const step = (i: number): void => {
    const candidate = order[i];
    if (!candidate) return;
    // 拒过/亮过的都不再问；每次重新算「他现在够不够格」（前面的人亮将可能把他补上）
    if (!isFullyDark(candidate)) {
      step(i + 1);
      return;
    }
    const slots = qualifyingSlots(state, candidate, player, kinds);
    if (slots.length === 0) {
      step(i + 1);
      return;
    }
    api.askChoice(
      state,
      candidate.seatId,
      `【阵法召唤】：${player.name} 令你选择是否明置一张武将牌（响应后即可形成阵法）？`,
      [
        { id: 'yes', label: '响应（明置一张武将牌）' },
        { id: 'no', label: '不响应' },
      ],
      (st, cp, picked) => {
        if (picked !== 'yes') {
          step(i + 1);
          return;
        }
        const reveal = (slot: 'main' | 'deputy'): void => {
          const heroId = slot === 'main' ? cp.heroId : cp.deputyHeroId;
          if (heroId) api.revealHeroCard(cp.seatId, heroId);
          pushLog(st, 'skill', `${cp.name} 响应了【阵法召唤】。`, { seat: cp.seatId });
          step(i + 1);
        };
        if (slots.length === 1) {
          reveal(slots[0]!);
          return;
        }
        // 两张牌都能满足（双势力组合）：**由他选**明置哪一张
        api.askChoice(
          st,
          cp.seatId,
          '【阵法召唤】：明置哪一张武将牌？',
          slots.map((slot) => ({
            id: slot,
            label:
              getHeroForMode(slot === 'main' ? cp.heroId : cp.deputyHeroId, st.mode)?.name ?? slot,
          })),
          (st2, cp2, slot) => reveal(slot as 'main' | 'deputy'),
        );
      },
    );
  };
  step(0);
  return undefined;
}

/** 阵法召唤这个「技能」本身（给拥有阵法技的武将用的通用主动技） */
export const FORMATION_SUMMON: ActiveSkill = {
  id: 'zhenfa_summon',
  name: '阵法召唤',
  // 不是武将牌上印的技能，所以自带说明（与「借来的技能」同一处理）
  desc: '出牌阶段限一次，令能够通过明置武将牌与你形成队列/围攻关系的未确定势力角色依次选择是否明置一张武将牌。',
  perPhaseLimit: 1,
  minTargets: 0,
  maxTargets: 0,
  canUse: (state, player) => formationSummonOffer(state, player),
  execute: (state, player, _intent, api) => formationSummonImpl(state, player, api),
};


export function besiegingTarget(state: GameState, player: Player): string | null {
  for (const r of siegeRelations(state)) {
    if (r.besiegers.includes(player.seatId)) return r.besiegedSeatId;
  }
  return null;
}

/**
 * 飞影：别人计算与你的距离 +1。来源有两处——你自己的武将牌写着这个字段，
 * 或者与你**同一队列**的队友有【鹤翼】（阵法技把飞影授予同队列其他人）。
 */
export function hasFeiying(state: GameState, player: Player): boolean {
  if (effectiveHeroes(state, player).some((h) => h.feiying === true)) return true;
  // 阵法技的**全局前提**：存活角色至少 4 名（残局只剩 3 人时阵法整体不成立）——与风扬同一口径
  if (state.players.filter((p) => p.alive).length < 4) return false;
  // 同队列里有人有鹤翼 → 我也视为拥有飞影
  const q = formationQueue(state, player);
  return q.some(
    (ally) =>
      ally.seatId !== player.seatId &&
      effectiveHeroes(state, ally).some((h) => h.grantsFeiyingToQueue === true),
  );
}

/**
 * 阵法技「鸟翔 / 锋矢」的公共触发判断：被指定的目标是不是**正在被别人围攻**的角色，
 * 而使用者是不是这个围攻关系里的**围攻角色**（同一个关系才算——「在同一个围攻关系中」）。
 * 返回被围攻者（不是的话返回 null）。
 */
function besiegedBySha(state: GameState, sourceId: string, targetId: string): Player | null {
  for (const r of siegeRelations(state)) {
    if (r.besiegedSeatId !== targetId) continue;
    if (!r.besiegers.includes(sourceId)) continue;
    const t = getPlayer(state, targetId);
    return t && t.alive ? t : null;
  }
  return null;
}

/** 双方是否**已明置**且势力相同（国战里暗置＝没有势力，判断同势力一律走这里） */
export function sameKnownFaction(state: GameState, a: Player, b: Player): boolean {
  const fa = effectiveFaction(state, a);
  return !!fa && fa === effectiveFaction(state, b);
}

/**
 * 蒋琬费祎 —— 生息 / 守成（君临天下·阵，2015 版文本，已核；实卡在国战典藏版 2017 定稿）。
 *
 * - 生息：弃牌阶段开始时，若你未于此回合内造成过伤害，你可以摸两张牌。
 *   （2013 初版在**出牌阶段结束时**，2015 挪到弃牌阶段开始，避免与刘禅·放权打架；
 *     移动版 2021 又挪到结束阶段。这里按 2015/典藏版口径。）
 * - 守成：当与你势力相同的一名角色于其回合外失去所有手牌后，你可以令其摸一张牌。
 *
 * 两处实现说明：
 * - 「造成过伤害」用新标记 `flags.dealtDamageThisTurn`，在 afterDamageDealt 的入口登记；
 *   自伤不派发那个时机，所以自伤不算（官方口径里自伤也算「造成过伤害」，这里从简，已注明）。
 * - 「与你势力相同」仍是引擎既有的**互相认同**口径：双方都得已明置。
 */
/**
 * 何太后 —— 鸩毒 / 戚乱（君临天下·阵，2013 原版文本，已核）。
 *
 * - 鸩毒：其他角色的出牌阶段开始时，你可以弃置一张手牌。若如此做，其视为使用一张【酒】，
 *   然后你对其造成 1 点伤害。
 * - 戚乱：一名角色的回合结束后，若你于此回合内杀死过角色，你可以摸三张牌。
 *
 * ⚠️ 版本差异：OL 2020 起鸩毒改成「每名角色（含自己）…若其不是你，你对其造成 1 点伤害」，
 *    戚乱改成按本回合死亡人数动态摸牌。这里取**君临天下·阵 印刷版（2013）**的口径：
 *    鸩毒只对**其他角色**、戚乱固定摸三张。
 *
 * 实现说明：
 * - 鸩毒挂在 `othersPlayPhase`（新时机）：`playPhase` 只发给回合玩家本人，看不到别人的出牌阶段。
 * - 「视为使用一张【酒】」= 给他挂上 `flags.jiuActive`——引擎里【酒】的效果就是这个标记
 *   （本回合下一张【杀】伤害 +1）。
 * - 「你于此回合内杀死过角色」用 `state.killedThisTurn`（与 damagedThisTurn 同一套：
 *   kill 时机的公共入口登记、每个回合开始清空）。戚乱是在**任何**回合结束时检查的，
 *   所以必须按回合清、不能挂在何太后自己的 flags 上。
 */
/**
 * 曹洪 —— 护援（君临天下·阵，已核国战文本）：
 * 结束阶段，你可以将一张装备牌置入一名角色的装备区，然后你可以弃置其距离为 1 的
 * 一名角色的一张牌。
 *
 * 【鹤翼】（阵法技）**已实现**：「与你处于同一队列的其他角色视为拥有【飞影】」——
 *    队列走 `formationQueue`（存活座次里与你势力相同、连续相邻的一段），
 *    授予的【飞影】在 `distance.ts` 里按「与拥有者的距离 +1」生效。
 *
 * 实现要点：装备牌从**曹洪手里**挑（手上的装备牌；置入时若目标该栏已有装备，
 * 旧的那张进弃牌堆并触发失去装备的时机——这段在 api.giveEquipTo 里）。
 * 「其距离为 1」的「其」是**接收装备的那个人**，不是曹洪。
 */
/**
 * 蒋钦 —— 尚义（君临天下·阵，已核文本）：
 * 出牌阶段限一次，你可以令一名其他角色观看你的手牌。若如此做，你选择一项：
 * ①观看其手牌并可以弃置其中的一张黑色牌；②观看其所有暗置的武将牌。
 *
 * 实现要点：三步都是「私密内容 + 确认」，用新原语 api.privateView
 * （走的是引擎里既有的 viewCards 提示：内容按座位裁剪，日志里不出现牌名/武将名）。
 *
 * 【鸟翔】（阵法技）**已实现**：同一个围攻关系里，围攻角色出【杀】指定被围攻者时，
 *    那名角色需**依次使用两张【闪】**才能抵消（钩子见下面的 `requiredShan`）。
 */
const JIANGQIN: Hero = {
  id: 'jiangqin',
  name: '蒋钦',
  faction: 'wu',
  pack: 'zhen', // zhen 包：该包开关关闭时不进选将池
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  // 鸟翔（阵法技，围攻型）：阵法召唤按「亮将后进同一围攻关系」判
  formation: ['siege'],
  hooks: [
    {
      // 【鸟翔】（阵法技，与徐盛同款）
      timing: 'othersBecomeTarget',
      skillId: '鸟翔',
      handler: (ctx) => {
        const payload = ctx.payload as { targetId?: string; attack?: AttackContext } | undefined;
        const attack = payload?.attack;
        if (!attack || attack.asType !== 'sha' || !payload?.targetId) return;
        const victim = besiegedBySha(ctx.state, attack.sourceId, payload.targetId);
        if (!victim) return;
        const mine = besiegingTarget(ctx.state, ctx.player);
        if (mine !== victim.seatId) return;
        attack.requiredShan = Math.max(attack.requiredShan ?? 1, 2);
        pushLog(ctx.state, 'skill', `【鸟翔】生效：${victim.name} 需依次使用两张【闪】才能抵消。`, {
          seat: ctx.player.seatId,
          action: 'skill',
        });
      },
    },
  ],
  activeSkills: [
    FORMATION_SUMMON,
    {
      id: 'shangyi',
      name: '尚义',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      needsCards: false,
      canUse: (state, player) => state.players.some((p) => p.alive && p.seatId !== player.seatId),
      execute: (state, player, intent, api) => {
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名其他角色';
        if (targetId === player.seatId) return '不能选择自己';
        const target0 = getPlayer(state, targetId);
        if (!target0 || !target0.alive) return '目标无效';
        pushLog(state, 'skill', `${player.name} 发动【尚义】，令 ${target0.name} 观看其手牌。`);
        // ①：目标观看蒋钦的手牌（私密内容，他确认后接着跑 ②）
        api.privateView(
          targetId,
          `${player.name} 的手牌（${player.hand.length} 张）`,
          { cards: player.hand.slice() },
          {
            after: () => {
              const target = getPlayer(state, targetId);
              if (!target) return;
              // ②：蒋钦二选一
              api.askChoice(
                state,
                player.seatId,
                '【尚义】：选择一项',
                [
                  { id: 'hand', label: `观看 ${target.name} 的手牌，并可弃置其中一张黑色牌` },
                  { id: 'hero', label: `观看 ${target.name} 所有暗置的武将牌` },
                ],
                (st, p, picked) => {
                  const t = getPlayer(st, targetId);
                  if (!t) return;
                  if (picked === 'hero') {
                    const hidden = unrevealedHeroes(st.mode, t);
                    pushLog(st, 'skill', `${p.name} 观看了 ${t.name} 的暗置武将牌。`, {
                      seat: p.seatId,
                      action: 'zhibi',
                    });
                    // 最后一步：看完把出牌阶段还给蒋钦
                    api.privateView(
                      p.seatId,
                      '你观看的暗置武将牌',
                      {
                        note:
                          hidden.length > 0
                            ? hidden.map((h) => h.name).join('、')
                            : '（他没有暗置的武将牌）',
                      },
                      { returnTo: p.seatId },
                    );
                    return;
                  }
                  // 选①：看对方手牌，然后可以弃其中一张黑色牌
                  api.privateView(
                    p.seatId,
                    `${t.name} 的手牌（${t.hand.length} 张）`,
                    { cards: t.hand.slice() },
                    {
                      after: () => {
                        const t2 = getPlayer(st, targetId);
                        if (!t2) return;
                        const blacks = t2.hand.filter((c) => cardColor(c) === 'black');
                        if (blacks.length === 0) {
                          pushLog(st, 'skill', `${t2.name} 手里没有黑色牌，【尚义】就此结束。`);
                          return;
                        }
                        api.askPickCards(
                          st,
                          p.seatId,
                          `【尚义】：弃置 ${t2.name} 的一张黑色牌（也可以一张都不选）`,
                          blacks,
                          0,
                          1,
                          (st2, _p2, chosen) => {
                            const card = chosen[0];
                            if (!card) return;
                            api.discardTargetCard(targetId, card.id);
                            pushLog(
                              st2,
                              'skill',
                              `${player.name} 弃置了 ${t2.name} 的一张黑色牌。`,
                              { seat: player.seatId, action: 'discard' },
                            );
                          },
                          // 收尾：选完（或一张都不选）把出牌阶段还给蒋钦
                          { returnTo: p.seatId },
                        );
                      },
                    },
                  );
                },
              );
            },
          },
        );
        return undefined;
      },
    },
  ],
  skills: [
    {
      name: '尚义',
      desc: '出牌阶段限一次，你可以令一名其他角色观看你的手牌。若如此做，你选择一项：1.观看其手牌并可以弃置其中的一张黑色牌；2.观看其所有暗置的武将牌。',
    },
    {
      name: '鸟翔',
      desc: '阵法技，在同一个围攻关系中，若你是围攻角色，则你或另一名围攻角色使用【杀】指定被围攻角色为目标后，你令该角色需依次使用两张【闪】才能抵消。',
    },
  ],
};

const CAOHONG: Hero = {
  id: 'caohong',
  name: '曹洪',
  faction: 'wei',
  pack: 'zhen', // zhen 包：该包开关关闭时不进选将池
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  // 鹤翼（阵法技）：与你同一队列的其他角色视为拥有【飞影】——由 distance() 读
  grantsFeiyingToQueue: true,
  formation: ['queue'], // 阵法召唤：亮将后与召唤者进同一**队列**
  lockedFields: ['grantsFeiyingToQueue'],
  hooks: [
    {
      timing: 'turnEnd',
      skillId: '护援',
      handler: (ctx) => {
        const me = ctx.player;
        const equips = me.hand.filter((c) => isEquipCard(c));
        if (equips.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          '是否发动【护援】将一张装备牌置入一名角色的装备区？',
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            const cards = p.hand.filter((c) => isEquipCard(c));
            if (cards.length === 0) return;
            ctx.api.askPickCards(
              st,
              p.seatId,
              '【护援】：选择要置入的装备牌',
              cards,
              1,
              1,
              (st2, p2, chosen) => {
                const card = chosen[0];
                if (!card) return;
                const others = st2.players.filter((x) => x.alive);
                ctx.api.askChoice(
                  st2,
                  p2.seatId,
                  '【护援】：置入谁的装备区？',
                  others.map((x) => ({ id: x.seatId, label: x.name })),
                  (st3, p3, toId) => {
                    const receiver = getPlayer(st3, toId);
                    if (!receiver) return;
                    removeCard(p3.hand, card.id);
                    // 置入别人的装备区；顶掉旧装备会触发「失去装备」的时机
                    ctx.api.giveEquipTo(card, toId, () => {
                      pushLog(
                        st3,
                        'skill',
                        `${p3.name} 发动【护援】，将【${cardLabel(card)}】置入 ${receiver.name} 的装备区。`,
                      );
                      // 第二步（可选）：弃置**其**（接收者）距离 1 的一名角色的一张牌
                      const near = getPlayer(st3, toId)!.alive
                        ? st3.players.filter(
                            (x) =>
                              x.alive && distance(st3, toId, x.seatId) === 1 && x.seatId !== toId,
                          )
                        : [];
                      if (near.length === 0) return;
                      ctx.api.askChoice(
                        st3,
                        p3.seatId,
                        `【护援】：是否弃置 ${receiver.name} 距离 1 的一名角色的一张牌？`,
                        [
                          ...near.map((x) => ({ id: x.seatId, label: `弃置 ${x.name} 的一张牌` })),
                          { id: 'no', label: '不弃置' },
                        ],
                        (st4, p4, pickedId) => {
                          if (pickedId === 'no') return;
                          const victim = getPlayer(st4, pickedId);
                          if (!victim) return;
                          pickOneOfTargetCards(st4, p4, victim, ctx.api, '护援');
                        },
                      );
                    });
                  },
                );
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '护援',
      desc: '结束阶段，你可以将一张装备牌置入一名角色的装备区，然后你可以弃置其距离为1的一名角色的一张牌。',
    },
    {
      name: '鹤翼',
      desc: '阵法技，与你处于同一队列的其他角色视为拥有【飞影】。',
    },
  ],
  // 阵法召唤（通用机制，见 §5.132）：拥有阵法技的角色都多出这一条出牌阶段限一次的操作
  activeSkills: [FORMATION_SUMMON],

};

const HETAIHOU: Hero = {
  id: 'hetaihou',
  name: '何太后',
  faction: 'qun',
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'female',
  modes: ['guozhan'],
  hooks: [
    {
      timing: 'othersPlayPhase',
      skillId: '鸩毒',
      handler: (ctx) => {
        const turnSeatId = (ctx.payload as { turnSeatId?: string } | undefined)?.turnSeatId;
        if (!turnSeatId) return;
        const target = getPlayer(ctx.state, turnSeatId);
        if (!target || !target.alive) return;
        if (ctx.player.hand.length === 0) return; // 代价付不出
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `是否对 ${target.name} 发动【鸩毒】？`,
          [
            {
              id: 'yes',
              label: `发动（弃一张手牌，${target.name} 视为使用【酒】，你对其造成 1 点伤害）`,
            },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.askPickCards(
              st,
              p.seatId,
              '【鸩毒】：弃置一张手牌',
              p.hand.slice(),
              1,
              1,
              (st2, p2, chosen) => {
                const card = chosen[0];
                if (!card) return;
                pushLog(st2, 'skill', `${p2.name} 发动【鸩毒】，弃置【${cardLabel(card)}】。`);
                ctx.api.discardCard(p2.seatId, card, () => {
                  const t = getPlayer(st2, turnSeatId);
                  if (!t || !t.alive) return;
                  t.flags.jiuActive = true;
                  pushLog(st2, 'skill', `${t.name} 视为使用了一张【酒】。`);
                  // 然后何太后对其造成 1 点伤害（真伤害：会触发卖血技、会被防止）
                  ctx.api.dealDamage(t, 1, p2.seatId);
                });
              },
            );
          },
        );
      },
    },
    {
      timing: 'turnEnd',
      skillId: '戚乱',
      handler: (ctx) => qiluan(ctx),
    },
    {
      timing: 'othersTurnEnd',
      skillId: '戚乱',
      handler: (ctx) => qiluan(ctx),
    },
  ],
  skills: [
    {
      name: '鸩毒',
      desc: '其他角色的出牌阶段开始时，你可以弃置一张手牌。若如此做，其视为使用一张【酒】，然后你对其造成1点伤害。',
    },
    {
      name: '戚乱',
      desc: '一名角色的回合结束后，若你于此回合内杀死过角色，你可以摸三张牌。',
    },
  ],
};

/** 戚乱：回合结束时，本回合杀死过角色就摸三张（自己的回合与别人的回合共用） */
function qiluan(ctx: HookContext): void {
  if (!ctx.state.killedThisTurn.includes(ctx.player.seatId)) return;
  ctx.api.askChoice(
    ctx.state,
    ctx.player.seatId,
    '是否发动【戚乱】摸三张牌？',
    [
      { id: 'yes', label: '摸三张牌' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      let got = 0;
      for (let i = 0; i < 3; i++) {
        const c = drawOne(st);
        if (!c) break;
        p.hand.push(c);
        got++;
      }
      pushLog(st, 'skill', `${p.name} 发动【戚乱】，摸了 ${got} 张牌。`);
    },
  );
}

const JIANGWAN_FEYI: Hero = {
  id: 'jiangwan_feyi',
  name: '蒋琬费祎',
  faction: 'shu',
  pack: 'zhen', // zhen 包：该包开关关闭时不进选将池
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      timing: 'discardPhase',
      skillId: '生息',
      handler: (ctx) => {
        if (ctx.player.flags.dealtDamageThisTurn) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【生息】摸两张牌？',
          [
            { id: 'yes', label: '摸两张牌' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            let got = 0;
            for (let i = 0; i < 2; i++) {
              const c = drawOne(st);
              if (!c) break;
              p.hand.push(c);
              got++;
            }
            pushLog(st, 'skill', `${p.name} 发动【生息】，摸了 ${got} 张牌。`);
          },
        );
      },
    },
    {
      timing: 'othersHandEmptied',
      skillId: '守成',
      handler: (ctx) => {
        const payload = ctx.payload as { emptiedSeatId?: string } | undefined;
        const sid = payload?.emptiedSeatId;
        if (!sid || sid === ctx.player.seatId) return;
        const who = getPlayer(ctx.state, sid);
        if (!who || !who.alive) return;
        // 「**于其回合外**失去所有手牌」——他自己回合里清空不算
        if (ctx.state.seatOrder[ctx.state.turn.seatIndex] === sid) return;
        if (!sameKnownFaction(ctx.state, ctx.player, who)) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `【守成】：是否令 ${who.name} 摸一张牌？`,
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, _p, picked) => {
            if (picked !== 'yes') return;
            const t = getPlayer(st, sid);
            if (!t) return;
            const c = drawOne(st);
            if (c) t.hand.push(c);
            pushLog(st, 'skill', `${who.name} 因【守成】摸了 1 张牌。`, { seat: who.seatId });
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '生息',
      desc: '弃牌阶段开始时，若你未于此回合内造成过伤害，你可以摸两张牌。',
    },
    {
      name: '守成',
      desc: '当与你势力相同的一名角色于其回合外失去所有手牌后，你可以令其摸一张牌。',
    },
  ],
};

/**
 * 陈武董袭 —— 断绁 / 奋命（君临天下·势，2013 印刷版，已核）。
 *
 * - 断绁：出牌阶段限一次，你可以令一名其他角色横置，若如此做，你横置。
 *   （2022 国战加强版改成「至多 X 名其他角色，X 为你已损失的体力值且至少为 1」，未采用。）
 * - 奋命：结束阶段开始时，若你处于连环状态，你可弃置处于连环状态的每名角色的一张牌。
 *   （「每名角色」包含自己；从**可见的**装备/判定牌里挑，手牌只能随机抽——与挑衅同一套。）
 */
const CHENWU_DONGXI: Hero = {
  id: 'chenwu_dongxi',
  name: '陈武董袭',
  faction: 'wu',
  pack: 'shi', // shi 包：该包开关关闭时不进选将池
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  activeSkills: [
    {
      id: 'duanxie',
      name: '断绁',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      needsCards: false,
      canUse: (state, player) =>
        !player.chained &&
        state.players.some((p) => p.alive && p.seatId !== player.seatId && !p.chained),
      execute: (state, player, intent, api) => {
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名其他角色';
        if (targetId === player.seatId) return '不能选择自己';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        if (target.chained) return '该角色已经处于连环状态';
        if (player.chained) return '你已经处于连环状态';
        api.chainPlayers([targetId], true);
        pushLog(state, 'skill', `${player.name} 发动【断绁】，横置 ${target.name}。`);
        api.chainPlayers([player.seatId], true);
        pushLog(state, 'skill', `${player.name} 因【断绁】横置了自己。`);
        return undefined;
      },
    },
  ],
  hooks: [
    {
      timing: 'turnEnd',
      skillId: '奋命',
      handler: (ctx) => {
        if (!ctx.player.chained) return;
        const chained = ctx.state.players.filter((p) => p.alive && p.chained);
        if (chained.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `是否发动【奋命】弃置所有横置角色（共 ${chained.length} 名）的一张牌？`,
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            fenmingStep(
              st,
              p,
              chained.map((x) => x.seatId),
              0,
              ctx.api,
            );
          },
        );
      },
    },
  ],
  skills: [
    { name: '断绁', desc: '出牌阶段限一次，你可以令一名其他角色横置，若如此做，你横置。' },
    {
      name: '奋命',
      desc: '结束阶段开始时，若你处于连环状态，你可弃置处于连环状态的每名角色的一张牌。',
    },
  ],
};

/** 奋命：按座次把「横置的每个角色」各弃一张（一个个问，所以是一条续接链） */
function fenmingStep(
  state: GameState,
  me: Player,
  queue: string[],
  i: number,
  api: SkillApi,
): void {
  const target = i < queue.length ? getPlayer(state, queue[i]!) : undefined;
  if (!target || !target.alive) {
    if (i < queue.length) fenmingStep(state, me, queue, i + 1, api);
    return;
  }
  pickOneOfTargetCards(state, me, target, api, '奋命', () =>
    fenmingStep(state, me, queue, i + 1, api),
  );
}

const XUSHENG: Hero = {
  id: 'xusheng',
  name: '徐盛',
  faction: 'wu',
  pack: 'zhen', // zhen 包：该包开关关闭时不进选将池
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  // 鸟翔（阵法技，围攻型）：阵法召唤按「亮将后进同一围攻关系」判
  formation: ['siege'],
  hooks: [
    {
      // 【鸟翔】（阵法技）：同一个围攻关系里，围攻角色出【杀】指定被围攻者 → 需两张【闪】
      timing: 'othersBecomeTarget',
      skillId: '鸟翔',
      handler: (ctx) => {
        const payload = ctx.payload as { targetId?: string; attack?: AttackContext } | undefined;
        const attack = payload?.attack;
        if (!attack || attack.asType !== 'sha' || !payload?.targetId) return;
        const victim = besiegedBySha(ctx.state, attack.sourceId, payload.targetId);
        if (!victim) return;
        // 本人在这个围攻关系里也是围攻角色吗？
        const mine = besiegingTarget(ctx.state, ctx.player);
        if (mine !== victim.seatId) return;
        attack.requiredShan = Math.max(attack.requiredShan ?? 1, 2);
        pushLog(ctx.state, 'skill', `【鸟翔】生效：${victim.name} 需依次使用两张【闪】才能抵消。`, {
          seat: ctx.player.seatId,
          action: 'skill',
        });
      },
    },
    {
      timing: 'othersBecomeTarget',
      skillId: '疑城',
      handler: (ctx) => {
        const payload = ctx.payload as { targetId?: string; attack?: AttackContext } | undefined;
        const tid = payload?.targetId;
        const attack = payload?.attack;
        if (!tid || !attack || attack.asType !== 'sha') return;
        if (attack.dodged) return;
        const target = getPlayer(ctx.state, tid);
        if (!target || !target.alive) return;
        const mine = effectiveFaction(ctx.state, ctx.player);
        const theirs = effectiveFaction(ctx.state, target);
        if (!mine || mine !== theirs) return;
        ctx.api.askChoice(
          ctx.state,
          target.seatId,
          '【疑城】：是否摸一张牌，然后弃置一张牌？',
          [
            { id: 'yes', label: '摸一张牌，然后弃置一张牌' },
            { id: 'no', label: '不发动' },
          ],
          (st, t, picked) => {
            if (picked !== 'yes') return;
            const c = drawOne(st);
            if (c) t.hand.push(c);
            pushLog(st, 'skill', `${t.name} 因【疑城】摸了 1 张牌。`);
            if (t.hand.length === 0) return;
            ctx.api.askPickCards(
              st,
              t.seatId,
              '【疑城】：弃置一张牌',
              t.hand.slice(),
              1,
              1,
              (st2, t2, chosen) => {
                const card = chosen[0];
                if (card) ctx.api.discardCard(t2.seatId, card);
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '疑城',
      desc: '当一名与你势力相同的角色成为【杀】的目标后，该角色可以摸一张牌，然后弃置一张牌。',
    },
    {
      name: '鸟翔',
      desc: '阵法技，在同一个围攻关系中，若你是围攻角色，则你或另一名围攻角色使用【杀】指定被围攻角色为目标后，你令该角色需依次使用两张【闪】才能抵消。',
    },
  ],
  // 阵法召唤（通用机制，见 §5.132）：拥有阵法技的角色都多出这一条出牌阶段限一次的操作
  activeSkills: [FORMATION_SUMMON],

};

const XIAOQIAO: Hero = {
  id: 'xiaoqiao',
  name: '小乔',
  faction: 'wu',
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'female',
  spadeAsHeart: true,
  lockedFields: ['spadeAsHeart'],
  skillFields: { 红颜: ['spadeAsHeart', 'canRevealInPlayPhase'] },
  hooks: [{ timing: 'damageDealt', skillId: '天香', handler: (ctx) => tianxiangClassic(ctx) }],
  skills: [
    {
      name: '天香',
      desc: '当你受到伤害时，你可以弃置一张红桃手牌，将此伤害转移给一名其他角色，然后该角色摸 X 张牌（X 为该角色已损失的体力值）。',
    },
    { name: '红颜', desc: '锁定技，你的黑桃牌均视为红桃牌。' },
  ],
  guozhan: {
    canRevealInPlayPhase: true,
    hooks: [{ timing: 'damageDealt', skillId: '天香', handler: (ctx) => tianxiangGuozhan(ctx) }],
    skills: [
      {
        name: '天香',
        desc: '当你受到伤害时，你可以弃置一张红桃手牌，防止此伤害并选择一名其他角色，若如此做，你选择一项：1.令其受到伤害来源对其造成的1点伤害，然后摸X张牌（X为其已损失体力值且至多5）；2.令其失去1点体力，然后其获得你弃置的牌。',
      },
      { name: '红颜', desc: '出牌阶段，你可明置此武将牌；你的黑桃牌视为红桃牌。' },
    ],
  },
};

const TAISHICI: Hero = {
  id: 'taishici',
  name: '太史慈',
  faction: 'wu',
  maxHp: 4,
  gender: 'male',
  // 天义：与一名其他角色拼点，赢了本回合可额外出一张【杀】且【杀】无距离限制
  activeSkills: [
    {
      id: 'tianyi',
      name: '天义',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      canUse: (state, player) =>
        player.hand.length > 0 &&
        state.players.some((p) => p.alive && p.seatId !== player.seatId && p.hand.length > 0),
      execute: (state, player, intent, api) => {
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名其他角色';
        if (targetId === player.seatId) return '不能选择自己';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        if (target.hand.length === 0) return '该角色没有手牌，无法拼点';
        api.pindian(player.seatId, targetId, (st, winner) => {
          if (winner !== player.seatId) {
            pushLog(st, 'skill', `${player.name} 的【天义】拼点未获胜。`);
            return;
          }
          // 额外一张【杀】：把已出杀数退 1（和苦肉同一招）
          player.flags.shaCountThisTurn = Math.max(0, player.flags.shaCountThisTurn - 1);
          player.flags.ignoreShaDistanceThisTurn = true;
          pushLog(
            st,
            'skill',
            `${player.name} 的【天义】拼点获胜：本回合可额外使用一张【杀】，且使用【杀】无距离限制。`,
          );
        });
      },
    },
  ],
  skills: [
    {
      name: '天义',
      desc: '出牌阶段限一次，你可以与一名其他角色拼点：若你赢，本回合你可以额外使用一张【杀】，且你使用【杀】无距离限制。',
    },
  ],
};

/**
 * 吕蒙 —— 技能按**最新国战标准版（2018）**文本。
 *
 * - 克己：锁定技，弃牌阶段开始时，若你于出牌阶段内**未使用过颜色不同的牌**，
 *   或出牌阶段被跳过，你的手牌上限于此回合内 +4。
 * - 谋断：结束阶段，若你于出牌阶段内使用过**四种花色**或**三种类别**的牌，
 *   你可以移动场上的一张牌。
 *
 * ⚠️ 界限突破版的吕蒙是「克己（未出杀可跳过弃牌阶段）+ 勤学（觉醒技）」，
 *    那是另一套技能，国战用的是克己 + 谋断。
 */
/**
 * 张郃 —— 巧变（国战/标准版文本，已核）：
 * 你可以弃置一张手牌并跳过一个阶段（准备阶段和结束阶段除外）。
 * 若你以此法跳过摸牌阶段，你可以获得至多两名角色的各一张手牌；
 * 若你以此法跳过出牌阶段，你可以移动场上的一张牌。
 *
 * ⚠️ 跳过**判定阶段**时，判定区的延时锦囊原样留着（和夏侯渊·神速一样，
 *    因为整个阶段被跳过了，牌不结算也不进弃牌堆）。
 */
/**
 * 李典 —— 恂恂 / 忘隙（君临天下·势，已核）。
 *
 * - 恂恂（**2013 印刷版**）：摸牌阶段摸牌时，你可改为观看牌堆顶的四张牌，将其中两张收入手牌，
 *   其余以任意顺序置于牌堆底。
 *   ⚠️ 2015 修订版把「收入手牌」改成「两张以任意顺序置于牌堆顶」——那样就不与张辽·突袭
 *      冲突了。这里按《君临天下·势》印刷卡面写（与项目对君临天下各包的取法一致）。
 * - 忘隙：每当你对其他角色造成 1 点伤害后，或受到其他角色造成的 1 点伤害后，若该角色存活，
 *   你可以令你与其各摸一张牌。（两个方向、逐点都要问）
 */
/**
 * 从某人的区域里「**拿**」一张牌交给 picker（董卓·横征）。
 * 可见的牌（装备/判定）给选项，手牌只能随机拿——与「弃置其一张牌」同一套口径，
 * 区别只是搬运方向（走 api.transferCard 而不是 discardTargetCard）。
 */
function takeOneOfTargetCards(
  state: GameState,
  picker: Player,
  target: Player,
  api: SkillApi,
  skillName: string,
  after?: () => void,
): void {
  const visible: Card[] = [
    ...(EQUIP_SLOTS.map((slot) => target.equipment[slot]).filter(Boolean) as Card[]),
    ...target.judgment,
  ];
  const options: { id: string; label: string }[] = visible.map((c) => ({
    id: c.id,
    label: `获得其【${cardLabel(c)}】`,
  }));
  if (target.hand.length > 0) {
    options.push({ id: '__hand', label: `获得其一张手牌（随机，共 ${target.hand.length} 张）` });
  }
  if (options.length === 0) {
    after?.();
    return;
  }
  api.askChoice(
    state,
    picker.seatId,
    `【${skillName}】：获得 ${target.name} 的一张牌`,
    options,
    (st, _p, picked) => {
      if (picked === '__hand') {
        const idx = Math.floor(state.rng() * target.hand.length);
        const card = target.hand[idx];
        if (!card) {
          after?.();
          return;
        }
        api.transferCard(target.seatId, card, picker.seatId, after);
        return;
      }
      const card = visible.find((c) => c.id === picked);
      if (!card) {
        after?.();
        return;
      }
      api.transferCard(target.seatId, card, picker.seatId, after);
    },
  );
}

/** 横征：放弃摸牌，挨个从其他角色区域里拿一张（一条续接链） */
function hengzhengStep(
  state: GameState,
  me: Player,
  queue: string[],
  i: number,
  api: SkillApi,
): void {
  const target = i < queue.length ? getPlayer(state, queue[i]!) : undefined;
  if (!target || !target.alive) {
    if (i < queue.length) hengzhengStep(state, me, queue, i + 1, api);
    return;
  }
  takeOneOfTargetCards(state, me, target, api, '横征', () =>
    hengzhengStep(state, me, queue, i + 1, api),
  );
}

/**
 * 董卓 —— 横征 / 暴凌（君临天下·势）。
 *
 * - 横征（2019 典藏版文本，已核）：摸牌阶段开始时，若你的体力值为 1 或你没有手牌，
 *   你可以放弃摸牌，改为从其他每名角色的所属区域内各获得一张牌。
 * - 暴凌（**主将技**，锁定技）：出牌阶段结束时，移除你的副将，然后加 3 点体力上限并
 *   回复 3 点体力，失去【暴凌】并获得【崩坏】。
 *
 * 暴凌（主将技，锁定技）+ 它给的【崩坏】**已实现**（见下面的 `playPhaseEnd` 钩子）：
 *   出牌阶段结束时 → `api.removeHeroCard` 移除副将 → `api.changeMaxHp(+3)` + `api.heal(3)`
 *   → `api.grantSkill('bengshuai', '崩坏')`。「失去【暴凌】」用 `usedOncePerGame.baling`
 *   记账（挂上就打勾，钩子下次直接 return）——本仓库的「借来的技能」是永久形态
 *   （`api.grantSkill`），不需要额外的技能增删制度。用例见 tests 的「董卓·暴凌」那条。
 */
/**
 * 马岱 —— 潜袭 / 马术（君临天下·势，2013 印刷版，已核）。
 *
 * - 潜袭：准备阶段，你可以进行判定，然后令距离为 1 的一名角色本回合不能使用或打出与
 *   结果颜色相同的手牌。（2018 修订版改成「摸一张牌并弃置一张牌」代替判定，未采用。）
 * - 马术：锁定技，你计算与其他角色的距离 -1（distanceFrom，与马超同一个字段）。
 *
 * 实现说明：
 * - 「本回合不能使用或打出**这个颜色**的手牌」是引擎级限制（新标记 flags.cannotPlayColor），
 *   在「使用牌 / 重铸 / 打出响应」三处统一拦（与既有的 cannotPlayCardsThisTurn 并列），
 *   回合结束清掉。
 * - 判定用的是技能自带判定（drawOne + 进弃牌堆），与张角·雷击 / 蔡文姬·悲歌同一档：
 *   不走 askBeforeJudge，所以鬼才/鬼道改不了它——这是引擎里既有的一处简化。
 */
/**
 * 凌统 —— 旋略 / 勇进（君临天下·变，已核国战文本）。
 *
 * - 旋略：当你失去装备区的牌后，你可以弃置一名其他角色的一张牌。
 *   （只能选手牌或装备牌，不能动判定区；官方是「一次失去只触发一次」，
 *     而本引擎的 equipLost 逐张派发，所以同时失去多张时会问两遍——已在注释里注明。）
 * - 勇进：限定技，出牌阶段，你可以移动场上至多三张装备牌。
 *
 * 两个技能都用现成的搬运原语：弃牌走 discardTargetCard，移动走 api.moveFieldCard。
 */
/**
 * 马谡 —— 散谣 / 制蛮（君临天下·变，2013 印刷版文本，已核）。
 *
 * - 散谣：出牌阶段限一次，你可以弃置一张牌并选择一名体力值最大的角色，然后你对其造成 1 点伤害。
 *   （移动版后来改成「手牌数或体力值大于你的其他角色」，这里按印刷版写。）
 * - 制蛮：当你对其他角色造成伤害时，你可以防止此伤害，然后获得其装备区或判定区里的一张牌；
 *   然后若其与你势力相同，其可以**变更副将**。
 *
 * **实现状态：三条都做了**——①「防止此伤害、获得其装备区/判定区一张牌」（`damageCaused` 钩子）；
 *    ②「若其与你势力相同，其可以**变更副将**」（交接完成后问一句 → `api.changeDeputyHero`，
 *    与黄祖·袭射换暗副将同一套）；散谣也已完成。用例见「制蛮：防止伤害、获得其装备区一张牌，
 *    同势力时其可变更副将」。
 */
/**
 * 邓艾 —— 屯田 / 急袭（主将技）/ 资粮（副将技）（君临天下·阵，已核国战文本）。
 *
 * - 屯田：当你于**回合外失去牌后**，你可以判定，当非红桃判定牌生效后，你将此牌置于你的
 *   武将牌上，称为「田」。你计算与其他角色的距离 -X（X 为「田」的数量）。
 * - 急袭：主将技，此武将牌减少半个阴阳鱼。你可以将一张「田」当【顺手牵羊】使用。
 * - 资粮：副将技，当与你势力相同的一名角色受到伤害后，你可以交给其一张「田」。
 *
 * 三处地基：新时机 cardsLost（回合外失去牌，快照比对实现）、Player.tian（武将牌上的牌堆）、
 * distanceMinusPerTian（距离随「田」减少）。急袭的转化走 canUseAs + 引擎的 usable 区扩展。
 */
const DENGAI: Hero = {
  id: 'dengai',
  name: '邓艾',
  faction: 'wei',
  pack: 'zhen', // zhen 包：该包开关关闭时不进选将池
  // 国战牌面 2 阴阳鱼 → 4（走主将技时再减 1）
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  // 屯田：距离 -「田」数；急袭是主将技（并让那张牌少半个阴阳鱼）
  distanceMinusPerTian: true,
  lockedFields: ['distanceMinusPerTian'],
  // ⚠️ **急袭也要登记**：它提供 canUseAs，而「主将技/副将技按位置过滤」要靠
  //    `conversionSkillName()` 反查出「这个转化技是哪个技能给的」——漏登记就会被当成
  //    「没有位置限制的转化技」，于是邓艾当副将时也能拿「田」当【顺手牵羊】。
  skillFields: { 屯田: ['distanceMinusPerTian'], 急袭: ['canUseAs'] },
  mainSlotSkills: ['急袭'],
  mainSlotHalfYang: true,
  deputySlotSkills: ['资粮'],
  // 急袭：一张「田」当【顺手牵羊】使用（判定在 canUseAs 里，用的是武将牌上的牌）
  canUseAs: (card, type) => type === 'shunshou' && card.tian === true,
  hooks: [
    {
      timing: 'cardsLost',
      skillId: '屯田',
      handler: (ctx) => {
        // 一张「田」都没有时也要问（判定可以只是一次判定），所以这里不做前置过滤
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【屯田】判定？',
          [
            { id: 'yes', label: '发动（判定，非红桃则收为「田」）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            // 统一技能判定：鬼才/鬼道可改判。判定牌要留着自己收「田」，所以 keepCard。
            // ⚠️ canTake=false（天妒把这张牌收走了）要**先判**：那时牌已经进了天妒的手牌，
            //    这里再动它就是「一牌两地」。以前红桃分支排在前面，天妒收走红桃判定牌时
            //    会同时出现在天妒手牌和弃牌堆里。
            ctx.api.judge(
              '屯田',
              (judge, canTake) => {
                if (!judge) return;
                if (!canTake) {
                  pushLog(st, 'skill', '【屯田】的判定牌已被【天妒】取走，无法作为「田」。');
                  return;
                }
                if (judge.suit === 'heart') {
                  toDiscard(st, judge);
                  pushLog(st, 'skill', '【屯田】判定为红桃，此牌不能作为「田」。');
                  return;
                }
                judge.tian = true;
                p.tian.push(judge);
                pushLog(
                  st,
                  'skill',
                  `【屯田】判定牌置于武将牌上作为「田」（现有 ${p.tian.length} 张）。`,
                );
              },
              { keepCard: true },
            );
          },
        );
      },
    },
    {
      timing: 'anyDamaged',
      skillId: '资粮',
      handler: (ctx) => {
        const payload = ctx.payload as { victimId?: string } | undefined;
        const victim = payload?.victimId ? getPlayer(ctx.state, payload.victimId) : undefined;
        if (!victim || !victim.alive) return;
        if (victim.seatId === ctx.player.seatId) return; // 「与你势力相同的一名角色」＝其他人
        if (!sameKnownFaction(ctx.state, ctx.player, victim)) return;
        if (ctx.player.tian.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `【资粮】：是否交给 ${victim.name} 一张「田」？`,
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            const card = p.tian[0];
            if (!card) return;
            p.tian.shift();
            const t = getPlayer(st, victim.seatId);
            if (!t) return;
            t.hand.push(card);
            pushLog(st, 'skill', `${p.name} 发动【资粮】，把一张「田」交给 ${t.name}。`);
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '屯田',
      desc: '当你于回合外失去牌后，你可以进行判定，当非红桃判定牌生效后，你将此牌置于你的武将牌上，称为「田」。你计算与其他角色的距离-X（X为你「田」的数量）。',
    },
    {
      name: '急袭',
      desc: '主将技，此武将牌减少半个阴阳鱼。你可以将一张「田」当【顺手牵羊】使用。',
    },
    {
      name: '资粮',
      desc: '副将技，当与你势力相同的一名角色受到伤害后，你可以交给其一张「田」。',
    },
  ],
};

/**
 * 君主将（君临天下 · 阵/势/变/权）—— 四张**独立的武将牌**：君曹操 / 君刘备 / 君孙权 / 君袁绍。
 *
 * ⚠️ 与「普通的曹操/刘备/孙权/袁绍」是**不同的牌**（§5.37 记过：把 `isLord` 挂在普通武将身上
 * 会让君主规则一直错误地生效，所以摘掉了）。官方口径见 docs/guozhan-reference.md §3：
 * 君主将四项固定特性（引擎里原本就有分支，只是以前没有君主牌，从没生效过）：
 *   ① 只能作为**主将**（`onPickHero` 里拦）；
 *   ② 不会成为**野心家**（组局分配时跳过）；
 *   ③ 亮将时**主副将同时亮出**；
 *   ④ 与**同势力所有**武将珠联璧合（不限于官方组合表）。
 * ⑤ 阵亡时**与你势力相同的角色各失去 1 点体力**（`doDeath` 里实现）。
 *
 * 当初标「部分实现」的两块**后来都补齐了**（这里曾是「本轮未实现」清单）：
 *   - 君主技【君威】与四件**专属装备**（飞龙夺凤 / 六龙骖驾 / 定澜夜明珠 / 盟军大纛）——见 `JUNWEI`；
 *   - 各君主自己的常规技能：君刘备的`章武`/`励众`、君曹操的`建安`（→ 五子良将纛，见 engine 的
 *     `askLordBanner`）；四位君主共用同一套【君威】句式。
 * 牌面数值：四张都是 **2 阴阳鱼**（本引擎的口径是 `maxHp = 2 × 阴阳鱼`，与邓艾一致）。
 */
function lordHero(
  id: string,
  name: string,
  faction: Faction,
  note: string,
  extra?: Partial<Hero>,
): Hero {
  return {
    id,
    name,
    faction,
    maxHp: 4, // 2 阴阳鱼
    gender: 'male',
    modes: ['guozhan'],
    isLord: true,
    // 技能：只有文本核实过的才写进来（见 roster 里的「部分实现」说明）
    skills: [{ name: '君主将', desc: note }],
    ...extra,
  };
}

/**
 * 【君威】（君主技，四位君主共用同一句式）：
 * 「出牌阶段，若场上没有【你的专属装备】，你可以弃置一张牌，从游戏外使用之。
 *   当你死亡时，与你势力相同的角色各失去1点体力。」
 * （死亡那半句是君主将的固定特性，由引擎统一实现，不在这个技能里。）
 * 每位君主的差别只有「专属装备是哪一张」，所以做成工厂，四位君主共用一份实现。
 */
function junweiSkill(
  equipName: string,
  equipLabel: string,
  makeEquip: (seq: number) => Card,
): ActiveSkill {
  return {
    id: 'junwei',
    name: '君威',
    minTargets: 0,
    maxTargets: 0,
    needsCards: true, // 弃置一张牌作为代价（点手牌）
    canUse: (state, player) => !lordEquipOnField(state, equipName) && player.hand.length > 0,
    execute: (state, player, intent, api) => {
      const ids = intent.cardIds ?? [];
      if (ids.length !== 1) return '请弃置一张牌作为代价';
      const cost = removeCard(player.hand, ids[0]!);
      if (!cost) return '这张牌不在你手里';
      toDiscard(state, cost);
      pushLog(
        state,
        'skill',
        `${player.name} 发动【君威】：弃置【${cardLabel(cost)}】，从游戏外使用【${equipLabel}】。`,
      );
      // 「从游戏外使用之」＝直接把这张牌放进装备区（替换旧宝物照常触发失去装备）。
      // 号从 state 上取：同一个种子重放出来的 id 必须一致（见 GameState.lordEquipSeq）
      api.giveEquipTo(makeEquip(state.lordEquipSeq++), player.seatId);
    },
  };
}

/** 场上（任何人的装备区）有没有这张专属装备——【君威】的发动条件 */
function lordEquipOnField(state: GameState, equipName: string): boolean {
  return state.players.some((p) =>
    EQUIP_SLOTS.some((slot) => p.equipment[slot]?.equipName === equipName),
  );
}

/**
 * 【雄驰】（君曹操；口径来自用户核对后的精确转述）：
 * 「当你每回合第一次造成伤害后，你可以令受伤的角色对一名与你势力相同的角色造成1点虚拟伤害。」
 *
 * 口径与存疑（见 docs/guozhan-roster.md §5.59）：
 * - 「每回合第一次」＝ **每个回合**（任何人的回合）里你第一次造成伤害的那个时机；问过一次就用掉
 *   （选择「不发动」也算用掉，官方是「首次…后，你可以」的一次性时机）。所以账本记在
 *   `state.xiongchiDoneSeats` 上——`PlayerFlags` 只在自己回合开始时清，不满足「每个回合」。
 * - 「虚拟伤害」＝ 没有牌、没有属性来源的伤害，走 `api.dealDamage`（攻击上下文 cardId 为空）。
 *   它照样触发卖血技（反馈/遗计…）、照样会进濒死，但**不算「使用【杀】造成伤害」**。
 * - 「一名与你势力相同的角色」由**技能使用者**（君主）指定：官方文本没写谁选，本实现按
 *   「发动者做选择」的通例。候选＝和你势力相同、**已明置**（effectiveFaction 口径）、存活的角色，
 *   但不包括受伤者本人（不能被令对自己造成伤害）。
 */
function askXiongchi(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
  const attack = payload?.attack;
  if (!attack || (payload?.damage ?? 0) <= 0) return;
  if (attack.sourceId !== me.seatId) return; // 派给来源的钩子，保险
  const victim = getPlayer(state, attack.targetId);
  if (!victim || victim.seatId === me.seatId || !victim.alive) return; // 自伤 / 已被反噬致死都不问
  if (state.xiongchiDoneSeats.includes(me.seatId)) return; // 本回合的第一次已经用掉
  const faction = effectiveFaction(state, me);
  if (!faction) return;
  const mates = state.players.filter(
    (p) => p.alive && p.seatId !== victim.seatId && effectiveFaction(state, p) === faction,
  );
  if (mates.length === 0) return;
  state.xiongchiDoneSeats.push(me.seatId);
  ctx.api.askChoice(
    state,
    me.seatId,
    `【雄驰】：是否令 ${victim.name} 对一名与你势力相同的角色造成 1 点伤害？`,
    [
      ...mates.map((p) => ({ id: p.seatId, label: `${p.name} 受到 1 点伤害` })),
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked === 'no') return;
      const target = getPlayer(st, picked);
      const source = getPlayer(st, victim.seatId);
      if (!target || !target.alive || !source || !source.alive) return;
      pushLog(
        st,
        'skill',
        `${p.name} 发动【雄驰】：${source.name} 对 ${target.name} 造成 1 点虚拟伤害。`,
        { seat: p.seatId },
      );
      ctx.api.dealDamage(target, 1, source.seatId);
    },
  );
}

/**
 * 【征戎】（君曹操；口径来自用户核对后的精确转述）：
 * 「当你受到伤害后，你可以将一名角色的至多X张手牌替换为等量张【杀】（X为你已损失的体力值且至少为1）」
 *
 * 口径（用户明确认定）：
 * - 换来的【杀】是**牌堆里的实体牌**（从牌堆里找出来塞进对方手牌），不是凭空生成的虚拟杀，
 *   也**不是**从弃牌堆拿；所以牌堆里还剩几张【杀】就最多换几张（不够就少换，绝不凭空生成）。
 * - 「替换」＝ 选中某人至多 X 张手牌 → 这些原手牌被换走 → 从牌堆找等量【杀】交给他当手牌。
 *   原手牌的去向用户转述里没写，本实现按**弃置进弃牌堆**处理（待核对，见 §5.59）。
 * - X ＝ 已损失的体力值（`maxHp - hp`），且至少 1。
 * - 「一名角色」不限阵营、也可以是自己。
 */
function askZhengrong(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
  if ((payload?.damage ?? 0) <= 0) return; // 0 点伤害不触发
  const x = Math.max(1, me.maxHp - me.hp);
  const shaInDeck = state.deck.filter((c) => c.type === 'sha').length;
  const max = Math.min(x, shaInDeck);
  if (max <= 0) return; // 牌堆里一张【杀】都没有 → 替换无从谈起（不能白扔牌）
  const candidates = state.players.filter((p) => p.alive && p.hand.length > 0);
  if (candidates.length === 0) return; // 全场没手牌 → 不弹询问
  ctx.api.askChoice(
    state,
    me.seatId,
    `【征戎】（至多 ${max} 张）：是否将一名角色的手牌替换为等量张【杀】？`,
    [
      ...candidates.map((p) => ({ id: p.seatId, label: `${p.name}（${p.hand.length} 张手牌）` })),
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked === 'no') return;
      const target = getPlayer(st, picked);
      if (!target || !target.alive || target.hand.length === 0) return;
      const limit = Math.min(max, target.hand.length);
      ctx.api.askPickCards(
        st,
        p.seatId,
        `【征戎】：选择要替换 ${target.name} 的至多 ${limit} 张手牌（换成等量【杀】）`,
        target.hand.slice(),
        0,
        limit,
        (st2, p2, cards) => {
          if (cards.length === 0) return;
          // 原手牌换走（进弃牌堆）：走 API 的「一次弃多张」，让失去牌触发的技能照常响
          ctx.api.discardCards(target.seatId, cards, () => {
            const got: Card[] = [];
            for (let i = 0; i < cards.length; i++) {
              // 「从牌堆中**找到**」——按牌堆顺序搜出【杀】，不是从堆顶摸
              const idx = st2.deck.findIndex((c) => c.type === 'sha');
              if (idx < 0) break;
              const [sha] = st2.deck.splice(idx, 1);
              if (!sha) break;
              target.hand.push(sha);
              got.push(sha);
            }
            pushLog(
              st2,
              'skill',
              `${p2.name} 发动【征戎】：${target.name} 的 ${cards.length} 张手牌被换走，从牌堆获得 ${got.length} 张【杀】。`,
              { seat: p2.seatId },
            );
          });
        },
      );
    },
  );
}

/**
 * 君曹操。
 *
 * 技能集合按**用户核对后的口径**定为【君威】+【雄驰】+【征戎】，三条都已实现。
 * 【君威】的专属装备是【六龙骖驾】（♥K 宝物：你计算与其他角色的距离 -3）。
 *
 * ⚠️ 来源说明（免得以后有人对着 git 历史发懵）：本仓库最早是按一份**早期资料**做的
 *    【建安】（五子良将纛）+【挥鞭】；用户随后给出上表这三条并说明君曹操就是这三条，
 *    所以那两条已从本定义摘掉（实现留在 git 历史，见 docs §5.57）。
 *    同一份早期资料里的其它词条（用户已确认作废）没有进过本仓库。
 *    引擎侧的「君主旗」机制（`Hero.lordBanner` / `askLordBanner` / 五子良将纛）保留着，
 *    目前**没有任何武将挂载**——它就是段待用的机制，不是君曹操的技能。
 */
const JUN_CAOCAO: Hero = lordHero(
  'juncaocao',
  '君曹操',
  'wei',
  '君主将：只能作主将、不当野心家、亮将时双将同亮、与同势力全员珠联璧合、阵亡令同势力各失去1点体力。【君威】（专属装备【六龙骖驾】）、【雄驰】、【征戎】，三条都已实现。',
  {
    // 与标准版【曹操】是同一个武将本体：两者不能同时当主将+副将（见 heroCanonicalId）
    pack: 'jun', // jun 包（君主将；junlintianxia 关闭时不进池）

    canonicalId: 'caocao',
    skills: [
      { name: '君主将', desc: '君主将的固定特性（见武将注释）。' },
      {
        name: '君威',
        desc: '出牌阶段，若场上没有【六龙骖驾】，你可以弃置一张牌，然后从游戏外使用一张【六龙骖驾】。当你死亡时，与你势力相同的角色各失去 1 点体力。',
      },
      {
        name: '雄驰',
        desc: '当你每回合第一次造成伤害后，你可以令受伤的角色对一名与你势力相同的角色造成 1 点虚拟伤害。',
      },
      {
        name: '征戎',
        desc: '当你受到伤害后，你可以将一名角色的至多 X 张手牌替换为等量张【杀】（X 为你已损失的体力值且至少为 1）。',
      },
    ],
    activeSkills: [
      // 【君威】（专属装备【六龙骖驾】，♥K 宝物：你计算与其他角色的距离 -3）
      junweiSkill('liulong', '六龙骖驾', lordEquipLiulong),
    ],
    hooks: [
      { timing: 'afterDamageDealt', skillId: '雄驰', handler: (ctx) => askXiongchi(ctx) },
      { timing: 'afterDamage', skillId: '征戎', handler: (ctx) => askZhengrong(ctx) },
    ],
  },
);

/**
 * 【章武】（君刘备；用户核对后提供的官方文本）：
 * 「一名角色的结束阶段，你可以视为使用1枚与你势力相同的角色本回合使用过的国战标记。」
 *
 * 口径与待核对（见 docs/guozhan-roster.md §5.62）：
 * - 「一名角色的结束阶段」＝ **任何**角色的结束阶段，包括他自己的。引擎把结束阶段拆成两个
 *   时机（`turnEnd` 只发给回合玩家、`othersTurnEnd` 发给其余人），所以两个都挂。
 * - 「本回合使用过的国战标记」看账本 `state.markerUsesThisTurn`（真用掉一枚就记一笔、
 *   记在**用的人**头上，`startTurn` 清空）；只认**与你势力相同**（已确定势力口径）的角色用过的。
 *   同一枚被用过多次只出一个选项——「视为使用」的效果与是谁用的无关。
 * - 「视为使用」＝ 照那枚标记**这一回合被用掉时的那种用法**结算一遍，**不消耗任何标记**
 *   （君刘备手里有没有都无所谓）。用户核对后的口径：账本要记「实际的使用记录」而不只是标记
 *   种类——阴阳鱼出牌阶段用是「摸一张」、弃牌阶段用是「手牌上限 +2」，复现时照原样执行
 *   （哪怕结束阶段再给「上限 +2」通常已经没有实际作用）。
 * - 【先驱】本来就要「选择一名其他角色」（观看其暗置武将牌），视为使用时同样先问这个目标。
 * - 【阴阳鱼】在**弃牌阶段**的那条用法（弃置 → 本回合手牌上限 +2）**已实现**：位置在
 *   `markers.ts` 的 `useYinyangyu`（走 `handLimitBonus += 2`）+ 弃牌阶段开始时的主动询问
 *   （见 §5.66；`afterDiscardPhaseHooks` 里当「本阶段确实要弃牌」才问）。账本两个阶段都会记——
 *   本条注释曾长期误写成「本仓库还没做」，§5.66 订正过文档、这里一并订正代码。
 */
function askZhangwu(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const faction = effectiveFaction(state, me);
  if (!faction) return;
  // 本回合「与你势力相同的角色」用过的标记——**按「标记 + 用法」去重**：
  // 阴阳鱼在出牌阶段（摸一张）与弃牌阶段（手牌上限 +2）是两种不同的效果，各出一个选项。
  const used: { markerId: MarkerId; usage: MarkerUsage }[] = [];
  for (const u of state.markerUsesThisTurn) {
    const user = getPlayer(state, u.seatId);
    if (!user || effectiveFaction(state, user) !== faction) continue;
    if (used.some((x) => x.markerId === u.markerId && x.usage === u.usage)) continue;
    used.push({ markerId: u.markerId, usage: u.usage });
  }
  if (used.length === 0) return; // 这回合同势力没用过标记 → 不弹询问
  const NAME: Record<string, string> = { xianqu: '先驱', yinyangyu: '阴阳鱼', zhulian: '珠联璧合' };
  /** 选项/日志里那句话要说清是**哪一种用法**（章武要复现对应的使用效果） */
  const label = (u: { markerId: MarkerId; usage: MarkerUsage }): string => {
    const n = NAME[u.markerId] ?? u.markerId;
    if (u.markerId === 'yinyangyu') {
      return u.usage === 'handLimit' ? `${n}（手牌上限 +2）` : `${n}（摸一张）`;
    }
    if (u.markerId === 'zhulian') {
      return u.usage === 'heal' ? `${n}（回复 1 点体力）` : `${n}（摸两张）`;
    }
    return n;
  };
  const keyOf = (u: { markerId: MarkerId; usage: MarkerUsage }): string =>
    `${u.markerId}:${u.usage}`;
  const via = (u: { markerId: MarkerId; usage: MarkerUsage }): string =>
    `【章武】视为使用【${label(u)}】：`;
  ctx.api.askChoice(
    state,
    me.seatId,
    '【章武】：视为使用一枚本回合同势力角色用过的国战标记？',
    [
      ...used.map((u) => ({ id: keyOf(u), label: `视为使用【${label(u)}】` })),
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked === 'no') return;
      const pickedUse = used.find((u) => keyOf(u) === picked);
      if (!pickedUse) return;
      const { markerId, usage } = pickedUse;
      // 「视为使用」本身也算「这一回合用过这枚标记」——照原样记（含用法）
      noteMarkerUsed(st, p.seatId, markerId, usage);
      if (markerId === 'yinyangyu') {
        if (usage === 'handLimit') useYinyangyuHandLimit(st, p, via(pickedUse));
        else useYinyangyu(st, p, via(pickedUse));
        return;
      }
      if (markerId === 'zhulian') {
        // 按记录好的那条用法直接结算，不再问一遍「摸牌还是回血」；钩子里不能传 returnTo
        useZhulian(st, p, ctx.api, via(pickedUse), {
          forced: usage === 'heal' ? 'heal' : 'draw',
        });
        return;
      }
      if (markerId === 'xianqu') {
        const others = st.players.filter((x) => x.alive && x.seatId !== p.seatId);
        if (others.length === 0) {
          useXianqu(st, p, undefined, ctx.api, via(pickedUse));
          return;
        }
        ctx.api.askChoice(
          st,
          p.seatId,
          '【章武】视为使用【先驱】：观看哪名其他角色未明置的副将？',
          others.map((x) => ({ id: x.seatId, label: x.name })),
          (st2, p2, seatId) => {
            // 钩子里**不传** returnTo：看过之后由钩子链条自己接着跑（见 runHooksFrom）
            useXianqu(st2, p2, getPlayer(st2, seatId), ctx.api, via(pickedUse));
          },
        );
      }
    },
  );
}

/**
 * 君刘备。三条技能都实现了：【君威】（专属装备【飞龙夺凤】）、【章武】（结束阶段「视为使用」
 * 一枚本回合同势力角色用过的国战标记）、【励众】（锁定技，每轮结束时给本轮造成伤害最多的
 * 同势力角色各一枚「先驱」）。
 */
const JUN_LIUBEI: Hero = lordHero(
  'junliubei',
  '君刘备',
  'shu',
  '君主将：只能作主将、不当野心家、亮将时双将同亮、与同势力全员珠联璧合、阵亡令同势力各失去1点体力。【君威】（专属装备【飞龙夺凤】）、【章武】、【励众】都已实现。',
  {
    pack: 'jun', // jun 包（君主将；junlintianxia 关闭时不进池）

    canonicalId: 'liubei', // 与【刘备】同一本体
    skills: [
      { name: '君主将', desc: '君主将的固定特性（见武将注释）。' },
      {
        name: '君威',
        desc: '出牌阶段，若场上没有【飞龙夺凤】，你可以弃置一张牌，然后从游戏外使用一张【飞龙夺凤】。当你死亡时，与你势力相同的角色各失去 1 点体力。',
      },
      {
        name: '章武',
        desc: '一名角色的结束阶段，你可以视为使用 1 枚与你势力相同的角色本回合使用过的国战标记。',
      },
      {
        name: '励众',
        desc: '锁定技，每轮结束时，你令与你势力相同的角色中本轮造成过伤害且造成伤害值最多的角色各获得 1 枚「先驱」标记。',
      },
    ],
    activeSkills: [junweiSkill('feilong', '飞龙夺凤', lordEquipFeilong)],
    hooks: [
      // 章武：「一名角色的结束阶段」——自己那份走 turnEnd、别人的走 othersTurnEnd
      { timing: 'turnEnd', skillId: '章武', handler: (ctx) => askZhangwu(ctx) },
      { timing: 'othersTurnEnd', skillId: '章武', handler: (ctx) => askZhangwu(ctx) },
      {
        // 官方原文（移动版 WIKI）：「锁定技，每轮结束时，你令与你势力相同的角色中本轮造成过伤害
        // 且造成伤害值最多的角色各获得 1 枚『先驱』标记。」
        // 「轮」＝座次从首位走到末位再绕回（引擎在回合交替处派发 roundEnd，见 afterTurnEnd）。
        timing: 'roundEnd',
        skillId: '励众',
        locked: true,
        handler: (ctx) => {
          const me = ctx.player;
          const myFaction = effectiveFaction(ctx.state, me);
          if (!myFaction) return;
          const peers = ctx.state.players.filter(
            (p) => p.alive && effectiveFaction(ctx.state, p) === myFaction,
          );
          const dealtOf = (p: Player): number => ctx.state.damageThisRound[p.seatId] ?? 0;
          const most = Math.max(0, ...peers.map(dealtOf));
          if (most <= 0) return; // 本轮谁都没造成伤害 → 不发作
          const winners = peers.filter((p) => dealtOf(p) === most);
          for (const p of winners) {
            addMarker(p, 'xianqu');
            pushLog(
              ctx.state,
              'marker',
              `【励众】：${p.name} 本轮造成了 ${most} 点伤害（同势力最多），获得【先驱】。`,
              { seat: p.seatId },
            );
          }
        },
      },
    ],
  },
);

/**
 * 【督授】（君孙权；用户核对后提供的口径，与移动版 WIKI 的「君孙权」一致）：
 * 「每名与你势力相同的角色的出牌阶段限一次，其可以弃置至多两张牌，令你摸等量的牌。」
 *
 * 口径：
 * - 它不是「君孙权自己发动的技能」，而是**同势力角色手里多出来的一个出牌阶段技能**——
 *   所以走 `factionGrantedActiveSkills`（与标记技能 `markerActiveSkills` 同一套接线：
 *   合法的出牌提示与 useSkill 各合并一次）。
 * - 「与你势力相同」按**已确定势力**口径（effectiveFaction）——提供者（君孙权）与使用者都要明置；
 *   君主自己也在「与你势力相同的角色」里，对自己用就是弃两张摸两张（官方也不禁止）。
 * - 「弃置至多两张牌」＝自己的**手牌**（与【君威】的代价同一口径：本引擎要付牌的技能一律点手牌）。
 *   弃置走 `api.discardCards`（一个动作、会触发「失去牌/弃牌后」那类效果，
 *   比如宝物【定澜夜明珠】的「首次弃牌后摸一张」与孔融·礼让）。
 * - 「令你摸等量的牌」＝按**弃置成功的张数**给君孙权摸（弃了两张就摸两张）。
 */
function dushouSkill(providerSeatId: string): ActiveSkill {
  return {
    id: 'dushou',
    name: '督授',
    oncePerTurn: true, // 「出牌阶段限一次」
    minTargets: 0,
    maxTargets: 0,
    needsCards: true, // 弃置至多两张牌作代价 → 点手牌
    canUse: (_state, player) => handAndEquipOf(player).length > 0,
    execute: (state, player, intent, api) => {
      const ids = (intent.cardIds ?? []).slice(0, 2);
      if (ids.length === 0) return '请选择至多两张要弃置的牌';
      const provider = getPlayer(state, providerSeatId);
      if (!provider || !provider.alive) return '【督授】的授予者已不在场';
      const cards: Card[] = [];
      for (const id of ids) {
        const c = player.hand.find((x) => x.id === id);
        if (!c) return '这张牌不在你手里';
        cards.push(c);
      }
      pushLog(
        state,
        'skill',
        `${player.name} 发动【督授】：弃置 ${cards.length} 张牌，令 ${provider.name} 摸 ${cards.length} 张牌。`,
        { seat: player.seatId },
      );
      api.discardCards(player.seatId, cards, () => {
        let got = 0;
        for (let i = 0; i < cards.length; i++) {
          const c = drawOne(state);
          if (!c) break;
          provider.hand.push(c);
          got++;
        }
        pushLog(state, 'skill', `${provider.name} 因【督授】摸了 ${got} 张牌。`, {
          seat: provider.seatId,
        });
      });
      return undefined;
    },
  };
}

/** 场上有没有「给同势力角色授予这条技能」的**已明置**提供者；有就返回它的座位 */
function factionSkillProviderOf(
  state: GameState,
  faction: Faction,
  skillId: string,
): string | undefined {
  for (const p of state.players) {
    if (!p.alive) continue;
    if (effectiveFaction(state, p) !== faction) continue;
    const main = p.heroRevealed ? getHeroForMode(p.heroId, state.mode) : undefined;
    const deputy = p.deputyRevealed ? getHeroForMode(p.deputyHeroId, state.mode) : undefined;
    if (main?.factionSkillId === skillId || deputy?.factionSkillId === skillId) return p.seatId;
  }
  return undefined;
}

/**
 * 某角色此刻可以发动的「同势力君主授予的技能」（目前只有督授）。
 * 与 `markerActiveSkills` 同一套路：合法的出牌提示与 useSkill 各自合并一次。
 */
export function factionGrantedActiveSkills(state: GameState, player: Player): ActiveSkill[] {
  if (state.mode !== 'guozhan') return [];
  const faction = effectiveFaction(state, player);
  if (!faction) return [];
  const provider = factionSkillProviderOf(state, faction, 'dushou');
  if (!provider) return [];
  return [dushouSkill(provider)];
}

/**
 * 刘琦·问计：这张牌是不是本回合被【问计】**标记的那张实体牌**。
 *
 * 标记的是**实体牌 id**（不是牌名）——交来一张具体的【杀】，只有这一张无距离/无次数/
 * 不能被响应；手里同名的另一张【杀】按普通牌处理（用户口径，见 docs/guozhan-roster.md §5.88）。
 */
export function wenjiMarked(player: Player, cardId: string): boolean {
  return !!player.flags.wenjiCardId && player.flags.wenjiCardId === cardId;
}

/**
 * 士燮·避乱：`from` 计算与 `to` 的距离时要额外加多少？
 *
 * 只认**已明置**的士燮（`effectiveHeroes` 里才会有这个字段——暗置的武将牌没有技能），
 * 而且是**单向**的：只有「别人 → 士燮」加，士燮自己计算别人不加。
 * X＝士燮**装备区当前牌数**（每次距离结算现算，不缓存档位），**最低 1**。
 * 装备自身的距离效果（+1 马等）是另一层，`distance()` 里已经先算过了。
 */
export function biluanAgainst(state: GameState, to: Player): number {
  if (!effectiveHeroes(state, to).some((h) => h.biluan === true)) return 0;
  const count = EQUIP_SLOTS.filter((s) => to.equipment[s] !== null).length;
  return Math.max(count, 1);
}

/**
 * 孟达 —— 求安 / 量反（不臣篇·上，魏/蜀 双势力，2 阴阳鱼 → 4；移动版现行口径，见 §5.93）。
 *
 * 求安：即将受到伤害时（beforeDamageApply：数值已定、尚未扣血），若武将牌旁没有「函」，
 *   可把**造成这次伤害的实体牌**扣成「函」并**防止整次伤害**（不是减 1）。没有可移动实体牌的
 *   情况（纯虚拟牌、技能直伤）不能发动；有函期间不能再发动。
 * 量反：自己准备阶段**强制**：获得所有「函」→ **失去 1 点体力**（不是伤害，可能因此进濒死）；
 *   本回合用函牌造成伤害后，可获得该受伤角色的一张牌（AOE 逐目标各一次，2 点伤害一次事件只一次）。
 */

/** 【求安】：把造成这次伤害的实体牌扣成「函」，整次伤害作废 */
function askQiuan(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const payload = ctx.payload as
    | { targetId?: string; damage?: number; attack?: AttackContext }
    | undefined;
  if (payload?.targetId !== me.seatId) return;
  const dmg = payload.damage ?? 0;
  if (dmg <= 0 || me.han.length > 0) return;
  const attack = payload.attack;
  if (!attack) return;
  const movable = damageCardIds(state, attack).filter((id) => findCardAnywhere(state, id) !== null);
  if (movable.length === 0) return;
  const first = findCardAnywhere(state, movable[0]!)!;
  ctx.api.askChoice(
    state,
    me.seatId,
    `【求安】：是否将【${cardLabel(first)}】扣成「函」，防止这 ${dmg} 点伤害？`,
    [
      { id: 'yes', label: '发动（防止整次伤害）' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      const self = getPlayer(st, p.seatId);
      if (!self) return;
      const got: Card[] = [];
      for (const id of movable) {
        const where = findCardAnywhere(st, id);
        if (!where) continue;
        removeFromAnywhere(st, id);
        self.han.push(where);
        got.push(where);
      }
      if (got.length === 0) return;
      self.flags.damagePrevented = true;
      pushLog(
        st,
        'skill',
        `${self.name} 发动【求安】，将【${got.map((c) => cardLabel(c)).join('】【')}】扣成「函」，防止了这 ${dmg} 点伤害。`,
        { seat: self.seatId },
      );
    },
  );
}

/** 这张牌此刻在哪个区域（弃牌堆/牌堆/手牌/装备区）——找不到返回 null */
function findCardAnywhere(state: GameState, id: string): Card | null {
  const d = state.discard.find((c) => c.id === id);
  if (d) return d;
  const k = state.deck.find((c) => c.id === id);
  if (k) return k;
  for (const p of state.players) {
    const h = p.hand.find((c) => c.id === id);
    if (h) return h;
    for (const slot of EQUIP_SLOTS) {
      if (p.equipment[slot]?.id === id) return p.equipment[slot]!;
    }
  }
  return null;
}

/** 把这张牌从它所在的区域摘掉（调用方负责放到新区域） */
function removeFromAnywhere(state: GameState, id: string): void {
  const di = state.discard.findIndex((c) => c.id === id);
  if (di >= 0) {
    state.discard.splice(di, 1);
    return;
  }
  const ki = state.deck.findIndex((c) => c.id === id);
  if (ki >= 0) {
    state.deck.splice(ki, 1);
    return;
  }
  for (const p of state.players) {
    const hi = p.hand.findIndex((c) => c.id === id);
    if (hi >= 0) {
      p.hand.splice(hi, 1);
      return;
    }
    for (const slot of EQUIP_SLOTS) {
      if (p.equipment[slot]?.id === id) {
        p.equipment[slot] = null;
        return;
      }
    }
  }
}

/** 这次伤害对应的实体牌 id（虚拟牌连材料一起看）。见 §5.93 的待办：丈八那份找不回材料 */
function damageCardIds(state: GameState, attack: AttackContext): string[] {
  const found = findCardAnywhere(state, attack.cardId);
  if (!found) return [];
  return found.materials?.length ? found.materials.map((c) => c.id) : [found.id];
}

/** 【量反】①：强制收函，然后失去 1 点体力（不是伤害；先拿牌后失血） */
function askLiangfan(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  if (me.han.length === 0) return;
  const got = me.han.slice();
  me.han = [];
  for (const c of got) me.hand.push(c);
  state.liangfanHanIds = [...state.liangfanHanIds, ...got.map((c) => c.id)];
  pushLog(
    state,
    'skill',
    `${me.name} 的【量反】：获得${got.length > 1 ? '所有' : ''}「函」（${got.map((c) => cardLabel(c)).join('、')}）。`,
    { seat: me.seatId },
  );
  ctx.api.loseHp(me, 1, () => {
    pushLog(state, 'skill', `${me.name} 因【量反】失去 1 点体力。`, { seat: me.seatId });
  });
}

/** 【量反】②：本回合用函牌造成伤害后，可获得受伤角色的一张牌（AOE 逐目标各一次） */
function askLiangfanObtain(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  if (state.liangfanHanIds.length === 0) return;
  const attack = (ctx.payload as { attack?: AttackContext } | undefined)?.attack;
  if (!attack || attack.sourceId !== me.seatId) return;
  if (!damageCardIds(state, attack).some((id) => state.liangfanHanIds.includes(id))) return;
  const victim = getPlayer(state, attack.targetId);
  if (!victim || !victim.alive) return;
  ctx.api.askChoice(
    state,
    me.seatId,
    `【量反】：是否获得 ${victim.name} 的一张牌？`,
    [
      { id: 'yes', label: '获得其一张牌' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      const t = getPlayer(st, victim.seatId);
      if (!t) return;
      takeOneOfTargetCards(st, p, t, ctx.api, '量反', () => {
        pushLog(st, 'skill', `${p.name} 的【量反】：获得了 ${t.name} 的一张牌。`, {
          seat: p.seatId,
        });
      });
    },
  );
}

const MENGDA: Hero = {
  id: 'mengda',
  name: '孟达',
  pack: 'buchen',
  faction: 'wei',
  secondFaction: 'shu',
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    { timing: 'beforeDamageApply', skillId: '求安', handler: askQiuan },
    { timing: 'turnStart', skillId: '量反', handler: askLiangfan },
    { timing: 'afterDamageDealt', skillId: '量反', handler: askLiangfanObtain },
  ],
  skills: [
    {
      name: '求安',
      desc: '当你即将受到伤害时，若你的武将牌旁没有「函」，你可以将造成此伤害的牌置于你的武将牌旁，称为「函」，然后防止此伤害。',
    },
    {
      name: '量反',
      desc: '准备阶段，若你的武将牌旁有「函」，你获得所有「函」，然后失去 1 点体力；本回合你使用「函」造成伤害后，可以获得受到此伤害的角色的一张牌。',
    },
  ],
};

/**
/**
 * 张鲁 —— 布施 / 米道（不臣篇·上，魏/群 双势力，1.5 阴阳鱼 → 3；移动版现行口径，见 §5.94）。
 *
 * 布施：① 张鲁**自己**受到伤害后，**每 1 点**都可以令一名与自己势力相同的角色摸 1 张（可选）；
 *   ② 张鲁**对其他角色**造成伤害后，**必须**令一名与**受伤者**势力相同的角色摸 1 张
 *   （一次伤害事件只处理一次，与 amount 无关）。受伤者未确定势力时没有合法目标。
 * 米道：与张鲁势力相同的角色（含**张鲁自己**）使用**有实体牌**的【杀】指定目标时，可以交给张鲁
 *   一张**手牌**，然后由**张鲁**重新声明这次使用的**花色**与**伤害属性**；只改这一次使用，
 *   实体牌本身不动。⚠️ 只接了【杀】；伤害类锦囊同一批待办。
 */
function factionMatesOf(state: GameState, faction: Faction | null): Player[] {
  if (!faction) return [];
  return state.players.filter((p) => p.alive && effectiveFaction(state, p) === faction);
}

/** 【布施】①：自己受到伤害后——**每 1 点**各问一次（可选），同势力任一角色摸 1 */
function askBushiSelf(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const n = (ctx.payload as { damage?: number } | undefined)?.damage ?? 0;
  if (n <= 0) return;
  const mates = factionMatesOf(state, effectiveFaction(state, me));
  if (mates.length === 0) return;
  const step = (i: number): void => {
    if (i >= n) return;
    ctx.api.askChoice(
      state,
      me.seatId,
      `【布施】（第 ${i + 1}/${n} 点）：是否令一名与你势力相同的角色摸一张牌？`,
      [
        ...mates.map((p) => ({ id: p.seatId, label: p.name })),
        { id: 'no', label: '不发动' },
      ],
      (st, p, picked) => {
        if (picked !== 'no') {
          const t = getPlayer(st, picked);
          const c = t && t.alive ? drawOne(st) : null;
          if (c && t) {
            t.hand.push(c);
            pushLog(st, 'skill', `${p.name} 的【布施】：${t.name} 摸了一张牌。`, { seat: t.seatId });
          }
        }
        step(i + 1);
      },
    );
  };
  step(0);
}

/** 【布施】②：张鲁对其他角色造成伤害后——**必须**令受伤者势力的一名角色摸 1（一次事件一次） */
function askBushiDealt(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const attack = (ctx.payload as { attack?: AttackContext } | undefined)?.attack;
  if (!attack || attack.targetId === me.seatId) return;
  const victim = getPlayer(state, attack.targetId);
  if (!victim) return;
  const vf = effectiveFaction(state, victim);
  if (!vf) return; // 未确定势力：不偷看印面势力，也没有「与其势力相同」的合法目标
  const mates = factionMatesOf(state, vf);
  if (mates.length === 0) return;
  ctx.api.askChoice(
    state,
    me.seatId,
    `【布施】（强制）：令一名与 ${victim.name} 势力相同的角色摸一张牌`,
    mates.map((p) => ({ id: p.seatId, label: p.name })),
    (st, p, picked) => {
      const t = getPlayer(st, picked);
      const c = t && t.alive ? drawOne(st) : null;
      if (c && t) {
        t.hand.push(c);
        pushLog(st, 'skill', `${p.name} 的【布施】：${t.name} 摸了一张牌。`, { seat: t.seatId });
      }
    },
  );
}

/** 【米道】：同势力角色（含张鲁自己）用有实体牌的【杀】指定目标时，交一张手牌、由张鲁改花色与属性 */
function askMidao(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const payload = ctx.payload as { attack?: AttackContext; card?: Card } | undefined;
  const attack = payload?.attack;
  if (!attack) return;
  // `othersBecomeTarget` 只带 attack，牌面按 id 找回来（虚拟牌连材料一起看）
  const card = payload?.card ?? findCardAnywhere(state, attack.cardId);
  if (!card) return;
  if (state.turn.phase !== 'play') return;
  const user = getPlayer(state, attack.sourceId);
  if (!user || !user.alive) return;
  const mine = effectiveFaction(state, me);
  const theirs = effectiveFaction(state, user);
  if (!mine || !theirs || mine !== theirs) return;
  const physical = damageCardIds(state, attack).filter((id) => findCardAnywhere(state, id) !== null);
  if (physical.length === 0) return; // 纯虚拟牌不能发动
  if (state.midaoUsedSeats.includes(user.seatId)) return;
  const declare = (st: GameState): void => {
    st.midaoUsedSeats = [...st.midaoUsedSeats, user.seatId];
    ctx.api.askChoice(
      st,
      me.seatId,
      `【米道】：声明【${cardLabel(card)}】这次使用的**花色**`,
      [
        { id: 'spade', label: '黑桃' },
        { id: 'heart', label: '红桃' },
        { id: 'club', label: '梅花' },
        { id: 'diamond', label: '方块' },
      ],
      (st2, _p, suit) => {
        const red = suit === 'heart' || suit === 'diamond';
        ctx.api.askChoice(
          st2,
          me.seatId,
          '【米道】：声明这次使用的**伤害属性**',
          [
            { id: 'normal', label: '普通伤害' },
            { id: 'fire', label: '火焰伤害' },
            { id: 'thunder', label: '雷电伤害' },
          ],
          (st3, _p2, nature) => {
            attack.cardColor = red ? 'red' : 'black';
            if (nature === 'normal') delete attack.attribute;
            else attack.attribute = nature as 'fire' | 'thunder';
            pushLog(
              st3,
              'skill',
              `${me.name} 的【米道】：${user.name} 的【${cardLabel(card)}】这次使用视为${red ? '红' : '黑'}色、${nature === 'normal' ? '普通' : nature === 'fire' ? '火焰' : '雷电'}伤害。`,
              { seat: me.seatId },
            );
          },
        );
      },
    );
  };
  if (user.seatId === me.seatId) {
    ctx.api.askChoice(
      state,
      me.seatId,
      `【米道】：是否重新声明这次【${cardLabel(card)}】的花色与伤害属性？`,
      [
        { id: 'yes', label: '发动' },
        { id: 'no', label: '不发动' },
      ],
      (st, _p, picked) => {
        if (picked === 'yes') declare(st);
      },
    );
    return;
  }
  if (user.hand.length === 0) return; // 交不出手牌（**手牌**口径，见 §5.94）
  ctx.api.askChoice(
    state,
    user.seatId,
    `【米道】：是否交给 ${me.name} 一张手牌，重新声明这次【${cardLabel(card)}】的花色与伤害属性？`,
    [
      { id: 'yes', label: '发动（交一张手牌）' },
      { id: 'no', label: '不发动' },
    ],
    (st, u, picked) => {
      if (picked !== 'yes') return;
      ctx.api.askPickCards(
        st,
        u.seatId,
        `【米道】：选择交给 ${me.name} 的一张手牌`,
        u.hand.slice(),
        1,
        1,
        (st2, u2, chosen) => {
          const give = chosen[0];
          if (!give) return;
          ctx.api.transferCard(u2.seatId, give, me.seatId, () => {
            pushLog(st2, 'skill', `${u2.name} 因【米道】交给 ${me.name} 【${cardLabel(give)}】。`, {
              seat: u2.seatId,
            });
            declare(st2);
          });
        },
      );
    },
  );
}

const ZHANGLU: Hero = {
  id: 'zhanglu',
  name: '张鲁',
  pack: 'buchen',
  faction: 'wei',
  secondFaction: 'qun',
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    { timing: 'afterDamage', skillId: '布施', handler: askBushiSelf },
    { timing: 'afterDamageDealt', skillId: '布施', handler: askBushiDealt },
    // ⚠️ 米道要看到**别人**的使用：`useCard` 只派给使用者本人（实测：只挂它的话，队友用牌时
    //    张鲁根本收不到询问）。改挂 `othersUseCard`——「其他角色使用牌时」派给全场、**可挂起**
    //    （钩子能发问），就是「指定目标时」的等价落点。
    { timing: 'othersUseCard', skillId: '米道', handler: askMidao },
  ],
  skills: [
    {
      name: '布施',
      desc: '当你受到伤害后，你可以令一名与你势力相同的角色摸一张牌（每点伤害处理一次）；当你对其他角色造成伤害后，你必须令一名与其势力相同的角色摸一张牌。',
    },
    {
      name: '米道',
      desc: '与你势力相同的角色每回合限一次，其使用有对应实体牌的【杀】指定目标时，可以交给你一张手牌，然后由你重新声明此牌的花色和伤害属性。',
    },
  ],
};

/**
 * 糜芳傅士仁 —— 锋势（不臣篇·上，蜀/吴 双势力，2 阴阳鱼 → 4；移动版现行口径，见 §5.95）。
 *
 * 两个**镜像**分支、**发动权不同**（最易写错处）：
 * - 主动：我用牌且唯一目标是别人、双方都有牌、目标手牌**少于**我 → **我**决定发动；
 * - 被动：别人用牌且我是唯一目标、双方都有牌、我手牌**少于**对方 → **由对方**决定发动（负面）。
 * 两个分支下**弃哪两张都由糜芳傅士仁选**；两张都弃成功后，这张牌的**基础伤害 +1**。
 * 不看牌种（官方问答：与伤害无关的牌也能发动）；增伤改的是**这次使用**、不动实体牌。
 * ⚠️ 只接了【杀】；伤害类锦囊的基础伤害需挂在 TrickContext 上（与米道同一批待办）。
 */
function askFengshi(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const payload = ctx.payload as { attack?: AttackContext; card?: Card } | undefined;
  const attack = payload?.attack;
  const card = payload?.card;
  if (!attack || !card) return;
  if ((attack.totalTargets ?? 1) !== 1) return; // 「唯一目标」一票否决
  const target = getPlayer(state, attack.targetId);
  if (!target || !target.alive) return;
  const mine = attack.sourceId === me.seatId;
  const amTarget = target.seatId === me.seatId;
  if (mine === amTarget) return;
  if (mine) {
    if (handAndEquipOf(me).length === 0 || handAndEquipOf(target).length === 0) return;
    if (target.hand.length >= me.hand.length) return;
    ctx.api.askChoice(
      state,
      me.seatId,
      `【锋势】：是否弃置你与 ${target.name} 各一张牌，令此牌基础伤害 +1？`,
      [
        { id: 'yes', label: '发动' },
        { id: 'no', label: '不发动' },
      ],
      (st, p, picked) => {
        if (picked === 'yes') fengshiDiscard(st, p, target.seatId, attack, card, ctx);
      },
    );
    return;
  }
  const user = getPlayer(state, attack.sourceId);
  if (!user || !user.alive) return;
  if (handAndEquipOf(me).length === 0 || handAndEquipOf(user).length === 0) return;
  if (me.hand.length >= user.hand.length) return;
  ctx.api.askChoice(
    state,
    user.seatId,
    `【锋势】：是否弃置你与 ${me.name} 各一张牌，令此牌基础伤害 +1？（两张都由 ${me.name} 选）`,
    [
      { id: 'yes', label: '发动' },
      { id: 'no', label: '不发动' },
    ],
    (st, _u, picked) => {
      if (picked === 'yes') fengshiDiscard(st, me, user.seatId, attack, card, ctx);
    },
  );
}

/** 弃双方各一张（都由 picker 选），两张都弃成功才 +1 基础伤害 */
function fengshiDiscard(
  state: GameState,
  picker: Player,
  otherSeatId: string,
  attack: AttackContext,
  card: Card,
  ctx: HookContext,
): void {
  const own = handAndEquipOf(picker);
  if (own.length === 0) return;
  ctx.api.askPickCards(
    state,
    picker.seatId,
    '【锋势】：选择弃置你自己的一张牌',
    own,
    1,
    1,
    (st, p, chosen) => {
      const c1 = chosen[0];
      if (!c1) return;
      ctx.api.discardCards(p.seatId, [c1], () => {
        const o = getPlayer(st, otherSeatId);
        if (!o) return;
        const pool = handAndEquipOf(o);
        if (pool.length === 0) return; // 中途没了就不增伤（通用执行完整性口径）
        ctx.api.askPickCards(
          st,
          p.seatId,
          `【锋势】：选择弃置 ${o.name} 的一张牌`,
          pool,
          1,
          1,
          (st2, p2, chosen2) => {
            const c2 = chosen2[0];
            if (!c2) return;
            ctx.api.discardCards(o.seatId, [c2], () => {
              attack.damage += 1; // 挂这次使用的基础伤害（酒/技能/防具那条链照常）
              pushLog(
                st2,
                'skill',
                `${p2.name} 发动【锋势】：弃置双方各一张牌，【${cardLabel(card)}】的基础伤害 +1。`,
                { seat: p2.seatId },
              );
            });
          },
        );
      });
    },
  );
}

const MIFANG: Hero = {
  id: 'mifangfushiren',
  name: '糜芳傅士仁',
  pack: 'buchen',
  faction: 'shu',
  secondFaction: 'wu',
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [{ timing: 'useCard', skillId: '锋势', handler: askFengshi }],
  skills: [
    {
      name: '锋势',
      desc: '你使用牌指定一名其他角色为唯一目标时，若其手牌数小于你且双方都有牌，你可以弃置你与其各一张牌，令此牌基础伤害值+1；其他角色使用牌指定你为唯一目标时，若你的手牌数小于其且双方都有牌，其可以令你弃置其与你各一张牌，令此牌基础伤害值+1。',
    },
  ],
};

/**
 * 士燮·【礼下】：一名**与士燮势力不同**的角色进入准备阶段时，其可以弃置士燮装备区的一张牌；
 * 若这么做，再由其从三项里选一项（弃两张手牌 / 失去 1 点体力 / 令士燮摸两张牌）。
 *
 * 口径（用户给出，移动版 2021 不臣篇；**不要与 2022 实体版混**）：
 * - **发动权在当前回合的那个角色**（问 payload.turnSeatId 那位），士燮不能拒绝；
 * - 「与士燮势力不同」要求**双方都已确定势力**：未确定势力（暗置）**不触发**
 *   （2022 实体版才把「没有势力」也算进来，这里不做）；
 * - 士燮没有装备就不弹询问；弃哪一张由**当前回合角色**选；
 * - 三项里「弃两张手牌」在手牌不足 2 张时**不给这个选项**（完整动作才可选）；
 *   「失去 1 点体力」不看体力，1 点体力也能选（之后照常进濒死流程）；
 * - 弃装备走 `api.discardCards`（士燮的名下）——「失去装备」那类联动照常响；
 *   避乱的距离实时读装备数，所以拆掉一件之后立刻变化，不用手动同步。
 */
function askLixia(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player; // 士燮
  const actorId = (ctx.payload as { turnSeatId?: string } | undefined)?.turnSeatId;
  if (!actorId || actorId === me.seatId) return;
  const actor = getPlayer(state, actorId);
  if (!actor || !actor.alive) return;
  const mine = effectiveFaction(state, me);
  const theirs = effectiveFaction(state, actor);
  if (!mine || !theirs || theirs === mine) return; // 未确定势力 / 同势力：不触发
  const equips = EQUIP_SLOTS.map((sl) => me.equipment[sl]).filter((c): c is Card => !!c);
  if (equips.length === 0) return; // 没装备可弃 → 不弹询问
  ctx.api.askChoice(
    state,
    actor.seatId,
    `【礼下】：是否弃置 ${me.name} 装备区的一张牌？`,
    [
      { id: 'yes', label: `发动（弃置 ${me.name} 的一张装备）` },
      { id: 'no', label: '不发动' },
    ],
    (st, a, picked) => {
      if (picked !== 'yes') return;
      const user = getPlayer(st, a.seatId);
      const owner = getPlayer(st, me.seatId);
      if (!user || !owner) return;
      const pool = EQUIP_SLOTS.map((sl) => owner.equipment[sl]).filter((c): c is Card => !!c);
      if (pool.length === 0) return; // 询问是跨步的：回答时装备可能已经没了
      ctx.api.askPickCards(
        st,
        user.seatId,
        `【礼下】：选择弃置 ${owner.name} 的一张装备`,
        pool,
        1,
        1,
        (st2, a2, chosen) => {
          const card = chosen[0];
          if (!card) return;
          ctx.api.discardCards(owner.seatId, [card], () => {
            pushLog(
              st2,
              'skill',
              `${a2.name} 发动【礼下】，弃置了 ${owner.name} 的【${cardLabel(card)}】。`,
              { seat: a2.seatId },
            );
            const choices = [
              ...(a2.hand.length >= 2
                ? [{ id: 'discard2', label: '弃置两张手牌' }]
                : []),
              { id: 'losehp', label: '失去 1 点体力' },
              { id: 'draw2', label: `令 ${owner.name} 摸两张牌` },
            ];
            ctx.api.askChoice(st2, a2.seatId, '【礼下】：选择一项', choices, (st3, a3, pick) => {
              if (pick === 'discard2') {
                ctx.api.askPickCards(
                  st3,
                  a3.seatId,
                  '【礼下】：弃置两张手牌',
                  a3.hand.slice(),
                  2,
                  2,
                  (st4, a4, cards) => {
                    if (cards.length === 0) return;
                    ctx.api.discardCards(a4.seatId, cards, () => {
                      pushLog(
                        st4,
                        'skill',
                        `${a4.name} 因【礼下】弃置了 ${cards.length} 张手牌。`,
                        { seat: a4.seatId },
                      );
                    });
                  },
                );
                return;
              }
              if (pick === 'losehp') {
                ctx.api.loseHp(a3, 1, () => {
                  pushLog(st3, 'skill', `${a3.name} 因【礼下】失去 1 点体力。`, {
                    seat: a3.seatId,
                  });
                });
                return;
              }
              const owner2 = getPlayer(st3, me.seatId);
              if (!owner2) return;
              let got = 0;
              for (let i = 0; i < 2; i++) {
                const c = drawOne(st3);
                if (!c) break;
                owner2.hand.push(c);
                got++;
              }
              pushLog(st3, 'skill', `${owner2.name} 因【礼下】摸了 ${got} 张牌。`, {
                seat: owner2.seatId,
              });
            });
          });
        },
      );
    },
  );
}

/**
 * 士燮（不臣篇·上；**双势力 吴/群**，1.5 阴阳鱼 → 体力上限 3）。
 *
 * 口径＝**用户给出的等价规则实现文本**（移动版 2021 不臣篇，2026-09 核对；
 * ⚠️ 不要与身份场士燮、2022 实体典藏版混——那两版的【避乱】【礼下】是另一套，见 §5.92）：
 * - 【避乱】（锁定技）：**其他角色**计算与士燮的距离 +X，X＝士燮装备区的牌数，**至少 1**
 *   （0 件和 1 件都是 +1）。单向修正、实时读装备区；装备自身的 +1 马是另一层修正。
 * - 【礼下】：一名与士燮**势力不同**的角色进入准备阶段时，其可以弃置士燮装备区的一张牌；
 *   若这么做，再由其选择：弃两张手牌 / 失去 1 点体力 / 令士燮摸两张牌。
 *
 * 双势力：最终势力由 `determineDualFaction` 决定，之后两个技能都读 `effectiveFaction`。
 */
const SHIXIE: Hero = {
  id: 'shixie',
  name: '士燮',
  pack: 'buchen',
  faction: 'wu',
  secondFaction: 'qun',
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  lockedFields: ['biluan'],
  skillFields: { 避乱: ['biluan'] },
  biluan: true,
  hooks: [{ timing: 'othersTurnStart', skillId: '礼下', handler: askLixia }],
  skills: [
    {
      name: '避乱',
      desc: '锁定技，其他角色计算与你的距离时，额外增加 X（X 为你装备区的牌数，最低为 1）。',
    },
    {
      name: '礼下',
      desc: '一名与你势力不同的角色进入准备阶段时，其可以弃置你装备区的一张牌，然后选择一项：弃置两张手牌；失去 1 点体力；令你摸两张牌。',
    },
  ],
};

/**
 * 场上「**有受伤角色**的势力」的数量（唐咨·兴棹的四档门槛）——国战公共规则函数。
 *
 * 口径（用户给出，2026-09）：
 * - 「受伤角色」＝ `hp < maxHp` 的**存活**角色；
 * - 只数**已确定势力**（`effectiveFaction`）：暗置/未确定势力的受伤角色**不计入**任何势力
 *   （与【会盟】、刘琦【问计】同一口径，不读后台印面势力）；
 * - **不是人数**：两个魏国角色都受伤也只算 1 个势力；
 * - 势力 id 直接进 Set——将来「新建立的势力 / 野心家」由统一的势力系统决定是不是不同 id，
 *   这里不另定一套。
 */
export function woundedFactionCount(state: GameState): number {
  const seen = new Set<string>();
  for (const p of state.players) {
    if (!p.alive || p.hp >= p.maxHp) continue;
    const f = effectiveFaction(state, p);
    if (f) seen.add(f);
  }
  return seen.size;
}

/**
 * 【兴棹】第 2 档：唐咨受到伤害**之后**（重新数一次受伤势力，条件可能刚因这次伤害满足），
 * 比较唐咨与来源的**当前**手牌数——**唯一较少**的一方摸 1 张；一样多则都不摸。
 */
function askXingzhaoHands(ctx: HookContext): void {
  const me = ctx.player;
  const state = ctx.state;
  if (woundedFactionCount(state) < 2) return;
  const attack = (ctx.payload as { attack?: AttackContext } | undefined)?.attack;
  const srcId = attack?.sourceId;
  if (!srcId || srcId === me.seatId) return; // 自己对自己造成的伤害：没有「另一方」可比
  const src = getPlayer(state, srcId);
  if (!src || !src.alive) return;
  const mine = me.hand.length;
  const theirs = src.hand.length;
  if (mine === theirs) return; // 一样多 → 没人摸
  const lucky = mine < theirs ? me : src;
  const c = drawOne(state);
  if (c) lucky.hand.push(c);
  pushLog(
    state,
    'skill',
    `${me.name} 的【兴棹】：${lucky.name} 手牌较少，摸了 1 张牌（${mine} : ${theirs}）。`,
    { seat: lucky.seatId },
  );
}

/**
 * 【兴棹】第 4 档：唐咨**失去装备区里的牌**后摸 1 张。
 *
 * 「失去」比「弃置」宽：被拆、被拿走、被换下、作为代价弃掉都算——统一挂引擎的 `equipLost`
 * 事件（它一次失去一个批次一个 eventId）。**同一批失去多张只摸 1 张**，靠 eventId 去重。
 */
function askXingzhaoEquip(ctx: HookContext): void {
  const me = ctx.player;
  const state = ctx.state;
  if (woundedFactionCount(state) < 4) return;
  const eventId = (ctx.payload as { eventId?: number } | undefined)?.eventId ?? -1;
  if (me.flags.xingzhaoEquipEventId === eventId) return; // 同一批已经摸过了
  me.flags.xingzhaoEquipEventId = eventId;
  const c = drawOne(state);
  if (c) me.hand.push(c);
  pushLog(state, 'skill', `${me.name} 的【兴棹】：失去装备区里的牌后摸了 1 张牌。`, {
    seat: me.seatId,
  });
}

/**
 * 【恂恂】（唐咨·兴棹第 1 档**动态提供**的衍生技能）：
 * 摸牌阶段开始时，可以看牌堆顶 4 张，把其中 2 张按任意顺序放回牌堆顶、另外 2 张按任意顺序放底。
 *
 * 与观星同一套「先选放顶、再从剩下的里选放底」的两步询问（点击顺序就是顺序）。
 * 牌堆方向：`drawOne` 从数组**尾**取牌，所以「牌堆顶」＝数组尾。
 */
function askXunxun(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  if (woundedFactionCount(state) < 1) return; // 兴棹第 1 档不满足 → 没有恂恂
  const n = Math.min(4, state.deck.length);
  if (n === 0) return;
  const top = state.deck.slice(state.deck.length - n).reverse(); // 从牌堆顶往下数
  const put = (topPile: Card[], bottomPile: Card[]): void => {
    state.deck.splice(state.deck.length - n, n); // 先摘掉看过的那几张
    // 放顶：topPile[0] 要**最先**被摸到 → 数组尾放它 → 倒着压回去
    for (const c of [...topPile].reverse()) state.deck.push(c);
    // 放底：bottomPile[0] 是「沉底后先抽到」的那张 → 它更靠近顶部 → 最后一个 unshift
    state.deck.unshift(...[...bottomPile].reverse());
    pushLog(
      state,
      'skill',
      `${me.name} 发动【恂恂】：${topPile.length} 张置于牌堆顶、${bottomPile.length} 张置于牌堆底。`,
      { seat: me.seatId },
    );
  };
  ctx.api.askPickCards(
    state,
    me.seatId,
    `【恂恂】：选择要置于牌堆**顶**的牌（按点击顺序＝从最上面往下数）`,
    top,
    Math.min(2, n),
    Math.min(2, n),
    (st, p, chosen) => {
      const rest = top.filter((c) => !chosen.some((x) => x.id === c.id));
      if (rest.length <= 1) {
        put(chosen, rest);
        return;
      }
      ctx.api.askPickCards(
        st,
        p.seatId,
        `【恂恂】：剩下的 ${rest.length} 张里，选择置于牌堆**底**的牌（按点击顺序＝沉底后先抽到的先点）`,
        rest,
        rest.length,
        rest.length,
        (_st2, _p2, bottom) => {
          const keep = rest.filter((c) => !bottom.some((x) => x.id === c.id));
          put([...chosen, ...keep], bottom);
        },
      );
    },
  );
}

/**
 * 全场**已确定势力**的数量（刘琦·屯江的 X）——国战公共规则函数，不写死在技能里。
 *
 * 口径（用户要求做成公共函数）：
 * - 只数**存活**角色；每人只按其**已确定势力**计一次（`effectiveFaction`：暗置＝未确定＝无势力）；
 * - 同一势力多人算 1；君主的势力照常算；野心家按 `effectiveFaction` 的返回值算一类。
 * ⚠️ 待核对：移动版对「多个独立野心家」「2023 新建立的势力」如何计入「全场势力数」
 *    没有单独 FAQ（用户也说明未查到）。将来核到细则只改这一处。
 */
export function currentFactionCount(state: GameState): number {
  const seen = new Set<string>();
  for (const p of state.players) {
    if (!p.alive) continue;
    const f = effectiveFaction(state, p);
    if (f) seen.add(f);
  }
  return seen.size;
}

/**
 * 【据江】（君孙权，锁定技）「若吴势力不为大势力，与你势力相同的角色指定你为目标的
 * **非伤害牌**额外结算一次（装备牌、延时锦囊牌和势力锦囊牌除外）」
 *
 * 口径与待核对（见 docs/guozhan-roster.md §5.61）：
 * - 「非伤害牌」＝ 不在 `DAMAGE_CARD_TYPES` 里的牌（【杀】【决斗】【南蛮】【万箭】【火攻】
 *   【水淹七军】【火烧连营】**以及【闪电】**都是伤害牌，一律排除）。
 * - 排除项：「装备牌」走的是另一条路（不经锦囊结算，自然到不了这里）；「延时锦囊牌」由
 *   playDelayedTrick 处理，也不经这里；「势力锦囊牌」＝《不臣篇》那四张（魏【号令天下】/
 *   蜀【克复中原】/ 吴【固国安邦】/ 群【文和乱武】），见 protocol 的 `FACTION_TRICK_TYPES`
 *   （用户核对后的官方定义；那四张尚未进本仓库牌堆，名单先登记着）。
 * - 「与你势力相同的角色」按**已确定势力**口径（effectiveFaction）：暗置的角色没有势力，
 *   不算；君孙权自己也在内。
 * - 「吴势力不为大势力」用 `isBigFaction`（与势备篇的大势力同一口径；没有势备篇时
 *   大势力概念本就不存在，等于恒真）。
 * - 「额外结算一次」＝ 同一张牌再走一遍完整结算，于是**所有**目标都再结算一次——
 *   官方原文是「此牌额外结算一次」，不是「只对你再算一次」。同一张牌只追加一遍
 *   （`state.extraResolvedCards` 按牌 id 去重）。
 * - ⚠️ 这套「追加结算」与严白虎·寄篱的「再使用一张虚拟同名牌」是**两套机制**，底层已拆开：
 *   据江走 `extraResolve`（同一张牌、不新建使用、不重开响应窗口），
 *   寄篱走 `jiliUse` + `engine.useVirtualSameNameCard`（新牌、新使用、重开响应窗口）。
 */
function askJujiang(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const payload = ctx.payload as
    { card?: Card; targetIds?: string[]; trickCtx?: TrickContext } | undefined;
  const card = payload?.card;
  const tctx = payload?.trickCtx;
  if (!card || !tctx) return;
  if (!(payload?.targetIds ?? []).includes(me.seatId)) return; // 没指定我为目标 → 不触发
  if (DAMAGE_CARD_TYPES.has(card.type)) return; // 伤害牌不算
  if (FACTION_TRICK_TYPES.has(card.type)) return; // 势力锦囊牌不算
  if (isDelayedTrick(card)) return; // 延时锦囊牌不算（正常也到不了这里，兜底）
  if (isEquipCard(card)) return; // 装备牌不算（同上）
  const myFaction = effectiveFaction(state, me);
  if (!myFaction) return;
  if (isBigFaction(state, myFaction)) return; // 本势力是大势力就不发动
  const user = getPlayer(state, tctx.sourceId);
  if (!user || !user.alive) return;
  if (effectiveFaction(state, user) !== myFaction) return; // 只有「与你势力相同的角色」的牌才算
  if (tctx.extraResolve || tctx.extraResolveDone) return;
  if (state.extraResolvedCards.includes(card.id)) return; // 同一张牌只追加一遍
  tctx.extraResolve = true;
  tctx.rerunSkill = '据江';
  state.extraResolvedCards.push(card.id);
  pushLog(
    state,
    'skill',
    `【据江】：${user.name} 的【${cardLabel(card)}】指定了 ${me.name}，此牌额外结算一次。`,
    { seat: me.seatId },
  );
}

const JUN_SUNQUAN: Hero = lordHero(
  'junsunquan',
  '君孙权',
  'wu',
  '君主将：只能作主将、不当野心家、亮将时双将同亮、与同势力全员珠联璧合、阵亡令同势力各失去1点体力。【君威】（专属装备【定澜夜明珠】）、【督授】、【据江】已实现。',
  {
    pack: 'jun', // jun 包（君主将；junlintianxia 关闭时不进池）

    canonicalId: 'sunquan', // 与【孙权】同一本体
    // 督授：给**同势力角色**一个出牌阶段技能（引擎按这个 id 找提供者，见 factionGrantedActiveSkills）
    factionSkillId: 'dushou',
    skills: [
      { name: '君主将', desc: '君主将的固定特性（见武将注释）。' },
      {
        name: '君威',
        desc: '出牌阶段，若场上没有【定澜夜明珠】，你可以弃置一张牌，然后从游戏外使用一张【定澜夜明珠】。当你死亡时，与你势力相同的角色各失去 1 点体力。',
      },
      {
        name: '督授',
        desc: '每名与你势力相同的角色的出牌阶段限一次，其可以弃置至多两张牌，令你摸等量的牌。',
      },
      {
        name: '据江',
        desc: '锁定技，若吴势力不为大势力，与你势力相同的角色指定你为目标的非伤害牌额外结算一次（装备牌、延时锦囊牌和势力锦囊牌除外）。',
      },
    ],
    activeSkills: [
      // 【君威】（专属装备【定澜夜明珠】：每回合首次弃置牌后摸一张，离开装备区即销毁）
      junweiSkill('dinglan', '定澜夜明珠', lordEquipDinglan),
    ],
    hooks: [
      {
        // 据江：挂在「这张锦囊的目标定下来了」那个时机（多目标锦囊也能观察到），
        // 置位后由 endTrickResolution 把同一张牌再走一遍（复用寄篱那套）。
        timing: 'trickTargeted',
        skillId: '据江',
        locked: true,
        handler: (ctx) => askJujiang(ctx),
      },
    ],
  },
);

/**
 * 【会盟】（君袁绍，锁定技；用户核对后的转述，与移动版 WIKI 原文一致）：
 * 「当场上一个势力的角色数从0变为其他数字或者从其他数字变为0时，你摸一张牌。」
 *
 * 口径：
 * - 「一个势力的角色数」＝ **已确定势力**（明置）的存活角色数，见 `knownFactionCount`
 *   （未确定势力的角色不属于任何势力；野心家/中立不算一个势力）。⚠️ 待核对：官方没写明置还是
 *   真实势力，本实现取明置口径，理由与备选口径见 docs/guozhan-roster.md §5.60。
 * - 两个方向的转换都由引擎在**明置**（revealHeroCard）与**阵亡**（doDeath）两处派发，
 *   payload 里带着 from/to，技能自己判断是不是「0 ↔ 非0」。
 * - 锁定技：不询问，直接摸（明置之后才生效——暗置的武将牌没有技能，引擎的钩子收集本就如此）。
 */
function askHuimeng(ctx: HookContext): void {
  const payload = ctx.payload as { faction?: Faction; from?: number; to?: number } | undefined;
  const from = payload?.from ?? 0;
  const to = payload?.to ?? 0;
  const appeared = from === 0 && to > 0;
  const vanished = from > 0 && to === 0;
  if (!appeared && !vanished) return;
  const name = payload?.faction ? (FACTION_NAME[payload.faction] ?? payload.faction) : '某势力';
  const card = drawOne(ctx.state);
  if (card) ctx.player.hand.push(card);
  pushLog(
    ctx.state,
    'skill',
    `【会盟】：${name} 的角色数从 ${from} 变为 ${to}，${ctx.player.name} ${card ? '摸一张牌' : '无牌可摸'}。`,
    { seat: ctx.player.seatId },
  );
}

/**
 * 【授锋】（君袁绍；用户核对后的转述，与移动版 WIKI 原文一致）：
 * 「当一名角色于其出牌阶段使用首张伤害牌结算结束后，你可以交给其一张牌（若该角色为你则跳过
 *   此操作），然后获得此伤害牌。」
 *
 * 口径：
 * - 「首张伤害牌」由引擎判定（`GameState.firstDamageCard`：本回合出牌阶段用掉的第一张
 *   伤害牌，在使用的那一刻登记）；「结算结束后」由引擎在锦囊/【杀】两个出口派发。
 * - 交给的「一张牌」＝ 自己的手牌或装备区（与反馈/刚烈同一口径）。给的是**别人**时，
 *   手里连装备区都没牌就发不了（没法给）；目标是自己则跳过这一步。
 * - 「然后获得此伤害牌」从**弃牌堆**里按 id 取回（与曹操·奸雄同一做法）。牌已经不在弃牌堆
 *   （被奸雄收走、或是丈八凑出来的虚拟牌）时拿不到，只记日志。⚠️ 官方对这两种情形怎么处理
 *   还没核到（见 §5.60 的待核对）。
 * - 「伤害牌」的集合见 protocol 的 `DAMAGE_CARD_TYPES`。
 */
function askShoufeng(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const payload = ctx.payload as
    { card?: Card; cardIds?: string[]; userSeatId?: string } | undefined;
  const card = payload?.card;
  const cardIds = payload?.cardIds;
  const user = payload?.userSeatId ? getPlayer(state, payload.userSeatId) : undefined;
  if (!card || !user) return;
  const gain = (st: GameState, p: Player): void => shoufengGain(st, p, card, cardIds);
  const isSelf = user.seatId === me.seatId;
  const cost = handAndEquipOf(me);
  if (!isSelf && cost.length === 0) return; // 连一张牌都拿不出 → 发不了
  ctx.api.askChoice(
    state,
    me.seatId,
    isSelf
      ? `【授锋】：你使用了首张伤害牌【${cardLabel(card)}】，是否获得之？`
      : `【授锋】：${user.name} 于出牌阶段使用了首张伤害牌【${cardLabel(card)}】，是否交给其一张牌，然后获得此牌？`,
    [
      { id: 'yes', label: isSelf ? '获得此牌' : '交给其一张牌，并获得此牌' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      if (isSelf) {
        gain(st, p);
        return;
      }
      const pool = handAndEquipOf(p);
      if (pool.length === 0) {
        gain(st, p);
        return;
      }
      ctx.api.askPickCards(
        st,
        p.seatId,
        `【授锋】：选择要交给 ${user.name} 的一张牌`,
        pool,
        1,
        1,
        (st2, p2, chosen) => {
          const give = chosen[0];
          if (!give) {
            gain(st2, p2);
            return;
          }
          // 走 API 而不是自己 splice：交出去的可能是装备，要触发失去装备那类技能
          ctx.api.transferCard(p2.seatId, give, user.seatId, () => {
            pushLog(
              st2,
              'skill',
              `${p2.name} 发动【授锋】，交给 ${user.name} 【${cardLabel(give)}】。`,
              { seat: p2.seatId },
            );
            gain(st2, p2);
          });
        },
      );
    },
  );
}

/** 【授锋】的后半句：从弃牌堆取回那张伤害牌（取不到只记日志） */
function shoufengGain(state: GameState, me: Player, card: Card, cardIds?: string[]): void {
  // 「获得此伤害牌」＝照**使用时记下的实体牌清单**逐张取，只拿还在弃牌堆里的
  // （用户给定的口径：已被【奸雄】那类搬进别人手牌/装备区的不追回；纯「视为使用」的
  //  虚拟牌没有实体牌，所以一张也拿不到——但它照样满足「用过首张伤害牌」）。
  const ids = cardIds && cardIds.length > 0 ? cardIds : [];
  const taken: Card[] = [];
  for (const id of ids) {
    const idx = state.discard.findIndex((c) => c.id === id);
    if (idx < 0) continue; // 已被别人拿走 / 本来就不是实体牌 → 不追回
    const [c] = state.discard.splice(idx, 1);
    if (!c) continue;
    me.hand.push(c);
    taken.push(c);
  }
  if (taken.length === 0) {
    pushLog(
      state,
      'skill',
      `【授锋】：【${cardLabel(card)}】没有可获得的实体牌（已被【奸雄】那类效果拿走，或是纯虚拟牌）。`,
    );
    return;
  }
  pushLog(
    state,
    'skill',
    `${me.name} 发动【授锋】，获得【${taken.map((c) => cardLabel(c)).join('】【')}】${
      taken.length > 1 ? `（共 ${taken.length} 张）` : ''
    }。`,
    { seat: me.seatId },
  );
}

/**
 * 君袁绍。三条技能都按用户核对后提供的口径实现：
 * 【君威】（专属装备【盟军大纛】）、【会盟】（锁定技，势力角色数 0↔非0 时摸一张）、
 * 【授锋】（首张伤害牌结算结束后给一张、再把这张伤害牌收回）。
 *
 * ⚠️ 待核对：专属装备【盟军大纛】的**花色/点数/类型**没核到（WIKI 没有这张牌的页面、
 *    移动版公告只写了效果），本实现按同族的「宝物」记录、花色点数用占位值（见 deck.ts）。
 */
const JUN_YUANSHAO: Hero = lordHero(
  'junyuanshao',
  '君袁绍',
  'qun',
  '君主将：只能作主将、不当野心家、亮将时双将同亮、与同势力全员珠联璧合、阵亡令同势力各失去1点体力。【君威】（专属装备【盟军大纛】）、【会盟】、【授锋】已实现。',
  {
    pack: 'jun', // jun 包（君主将；junlintianxia 关闭时不进池）

    canonicalId: 'yuanshao', // 与【袁绍】同一本体
    skills: [
      { name: '君主将', desc: '君主将的固定特性（见武将注释）。' },
      {
        name: '君威',
        desc: '出牌阶段，若场上没有【盟军大纛】，你可以弃置一张牌，然后从游戏外使用一张【盟军大纛】。当你死亡时，与你势力相同的角色各失去 1 点体力。',
      },
      {
        name: '会盟',
        desc: '锁定技，当场上一个势力的角色数从 0 变为其他数字或者从其他数字变为 0 时，你摸一张牌。',
      },
      {
        name: '授锋',
        desc: '当一名角色于其出牌阶段使用首张伤害牌结算结束后，你可以交给其一张牌（若该角色为你则跳过此操作），然后获得此伤害牌。',
      },
    ],
    activeSkills: [
      // 【君威】（专属装备【盟军大纛】：受到伤害时可弃两张牌防止之，离开装备区即销毁）
      junweiSkill('mengjun', '盟军大纛', lordEquipMengjun),
    ],
    hooks: [
      { timing: 'factionCountChanged', skillId: '会盟', locked: true, handler: (ctx) => askHuimeng(ctx) },
      { timing: 'cardResolved', skillId: '授锋', handler: (ctx) => askShoufeng(ctx) },
    ],
  },
);

const MASU: Hero = {
  id: 'masu',
  name: '马谡',
  faction: 'shu',
  pack: 'bian', // bian 包：该包开关关闭时不进选将池
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      // 「当你对其他角色造成伤害时」——来源视角（damageCaused）
      timing: 'damageCaused',
      skillId: '制蛮',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
        const attack = payload?.attack;
        if (!attack || attack.sourceId !== ctx.player.seatId) return;
        const victim = getPlayer(ctx.state, attack.targetId);
        if (!victim || !victim.alive || victim.seatId === ctx.player.seatId) return;
        const zoneCards: Card[] = [
          ...(EQUIP_SLOTS.map((slot) => victim.equipment[slot]).filter(Boolean) as Card[]),
          ...victim.judgment,
        ];
        if (zoneCards.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `是否对 ${victim.name} 发动【制蛮】防止此伤害，改为获得其一张牌？`,
          [
            { id: 'yes', label: '发动（防止伤害，获得其装备/判定区一张牌）' },
            { id: 'no', label: '不发动' },
          ],
          (st, _p, picked) => {
            if (picked !== 'yes') return;
            const t = getPlayer(st, victim.seatId);
            if (!t) return;
            t.flags.damagePrevented = true;
            pushLog(st, 'skill', `${ctx.player.name} 发动【制蛮】，防止此伤害。`);
            const cards = [
              ...(EQUIP_SLOTS.map((slot) => t.equipment[slot]).filter(Boolean) as Card[]),
              ...t.judgment,
            ];
            if (cards.length === 0) return;
            ctx.api.askChoice(
              st,
              ctx.player.seatId,
              `【制蛮】：获得 ${t.name} 的哪张牌？`,
              cards.map((c) => ({ id: c.id, label: `获得其【${cardLabel(c)}】` })),
              (st2, p2, cardId) => {
                const card = cards.find((c) => c.id === cardId);
                if (!card) return;
                ctx.api.transferCard(t.seatId, card, p2.seatId, () => {
                  // 同势力的话，**其**可以变更副将（可选）
                  const t2 = getPlayer(st2, t.seatId);
                  if (!t2 || !t2.deputyHeroId) return;
                  if (!sameKnownFaction(st2, p2, t2)) return;
                  ctx.api.askChoice(
                    st2,
                    t2.seatId,
                    '【制蛮】：是否变更副将？',
                    [
                      { id: 'yes', label: '变更副将' },
                      { id: 'no', label: '不变更' },
                    ],
                    (st3, t3, choice) => {
                      if (choice !== 'yes') return;
                      ctx.api.changeDeputyHero(t3.seatId);
                    },
                  );
                });
              },
            );
          },
        );
      },
    },
  ],
  activeSkills: [
    {
      id: 'sanyao',
      name: '散谣',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      needsCards: true,
      maxCards: () => 1,
      canUse: (state, player) => {
        if (player.hand.length === 0) return false;
        const pool = state.players.filter((x) => x.alive && x.seatId !== player.seatId);
        if (pool.length === 0) return false;
        const top = Math.max(...state.players.filter((x) => x.alive).map((x) => x.hp));
        return pool.some((x) => x.hp === top);
      },
      execute: (state, player, intent, api) => {
        const cardId = intent.cardIds?.[0];
        const card = cardId ? player.hand.find((c) => c.id === cardId) : undefined;
        if (!card) return '请选择要弃置的一张牌';
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名体力值最大的角色';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        if (target.seatId === player.seatId) return '不能选择自己';
        const top = Math.max(...state.players.filter((x) => x.alive).map((x) => x.hp));
        if (target.hp !== top) return '只能选择体力值最大的角色';
        removeCard(player.hand, card.id);
        toDiscard(state, card);
        pushLog(
          state,
          'skill',
          `${player.name} 发动【散谣】，弃置【${cardLabel(card)}】并对 ${target.name} 造成 1 点伤害。`,
        );
        api.dealDamage(target, 1, player.seatId);
        return undefined;
      },
    },
  ],
  skills: [
    {
      name: '散谣',
      desc: '出牌阶段限一次，你可以弃置一张牌并选择一名体力值最大的角色，然后你对其造成1点伤害。',
    },
    {
      name: '制蛮',
      desc: '当你对其他角色造成伤害时，你可以防止此伤害，然后获得其装备区或判定区里的一张牌。然后若该角色与你势力相同，其可以变更副将。',
    },
  ],
};

const LINGTONG: Hero = {
  id: 'lingtong',
  name: '凌统',
  faction: 'wu',
  pack: 'bian', // bian 包：该包开关关闭时不进选将池
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      timing: 'equipLost',
      skillId: '旋略',
      handler: (ctx) => {
        // 官方口径：**一次**失去装备只触发一次。而 equipLost 是逐张派发的（枭姬要每张都算），
        // 所以这里按 payload.eventId 去重——甘露交换、水淹七军弃光装备、贯石斧一次弃两张
        // 都算「一次」，不会连问好几遍。
        const payload = ctx.payload as { eventId?: number } | undefined;
        const eventId = payload?.eventId ?? -1;
        if (ctx.player.flags.xuanlveEventId === eventId) return;
        ctx.player.flags.xuanlveEventId = eventId;
        const others = ctx.state.players.filter((x) => x.alive && x.seatId !== ctx.player.seatId);
        if (others.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【旋略】弃置一名其他角色的一张牌？',
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            const targets = st.players.filter((x) => x.alive && x.seatId !== p.seatId);
            if (targets.length === 0) return;
            ctx.api.askChoice(
              st,
              p.seatId,
              '【旋略】：弃置谁的牌？',
              targets.map((x) => ({ id: x.seatId, label: x.name })),
              (st2, p2, targetId) => {
                const t = getPlayer(st2, targetId);
                if (!t) return;
                pickOneOfTargetCards(st2, p2, t, ctx.api, '旋略', undefined, { noJudgment: true });
              },
            );
          },
        );
      },
    },
  ],
  activeSkills: [
    {
      id: 'yongjin',
      name: '勇进',
      oncePerGame: true,
      minTargets: 0,
      maxTargets: 0,
      needsCards: false,
      canUse: (state) => {
        const hasEquip = state.players.some(
          (x) => x.alive && EQUIP_SLOTS.some((slot) => !!x.equipment[slot]),
        );
        return hasEquip && state.players.filter((x) => x.alive).length >= 2;
      },
      execute: (state, player, _intent, api) => {
        pushLog(state, 'skill', `${player.name} 发动【勇进】。`);
        yongjinStep(state, player, 0, api);
        return undefined;
      },
    },
  ],
  skills: [
    { name: '旋略', desc: '当你失去装备区的牌后，你可以弃置一名其他角色的一张牌。' },
    { name: '勇进', desc: '限定技，出牌阶段，你可以移动场上至多三张装备牌。' },
  ],
};

/** 勇进：最多搬三张装备牌（每张都要逐个问，所以是一条续接链） */
function yongjinStep(state: GameState, me: Player, done: number, api: SkillApi): void {
  if (done >= 3) return;
  const entries: { card: Card; owner: Player }[] = [];
  for (const p of state.players) {
    if (!p.alive) continue;
    for (const slot of EQUIP_SLOTS) {
      const c = p.equipment[slot];
      if (c) entries.push({ card: c, owner: p });
    }
  }
  // 只在「还有别人能接收」时才列出来——移到原地等于没动
  const movable = entries.filter(
    (e) => state.players.filter((x) => x.alive && x.seatId !== e.owner.seatId).length > 0,
  );
  if (movable.length === 0) return;
  const options: { id: string; label: string }[] = movable.map((e) => ({
    id: e.card.id,
    label: `移动 ${e.owner.name} 的【${cardLabel(e.card)}】`,
  }));
  if (done > 0) options.push({ id: 'stop', label: '不再移动' });
  // 主动技里的询问都要传 returnTo（技能使用者），否则整条链跑完 pending 会是 null
  api.askChoice(
    state,
    me.seatId,
    `【勇进】：移动场上一张装备牌（已移动 ${done} / 至多 3）`,
    options,
    (st, _p, picked) => {
      if (picked === 'stop') return;
      const entry = movable.find((e) => e.card.id === picked);
      if (!entry) return;
      const dest = st.players.filter((x) => x.alive && x.seatId !== entry.owner.seatId);
      if (dest.length === 0) return;
      api.askChoice(
        st,
        me.seatId,
        `【勇进】：把【${cardLabel(entry.card)}】移到谁的装备区？`,
        dest.map((x) => ({ id: x.seatId, label: x.name })),
        (st2, _p2, toId) => {
          api.moveFieldCard(entry.card, toId, () => yongjinStep(st2, me, done + 1, api));
        },
        me.seatId,
      );
    },
    me.seatId,
  );
}

const MADAI: Hero = {
  id: 'madai',
  name: '马岱',
  faction: 'shu',
  pack: 'shi', // shi 包：该包开关关闭时不进选将池
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  distanceFrom: 1,
  lockedFields: ['distanceFrom'],
  hooks: [
    {
      timing: 'turnStart',
      skillId: '潜袭',
      handler: (ctx) => {
        const targets = ctx.state.players.filter(
          (x) =>
            x.alive &&
            x.seatId !== ctx.player.seatId &&
            distance(ctx.state, ctx.player.seatId, x.seatId) === 1,
        );
        if (targets.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【潜袭】？',
          [
            { id: 'yes', label: '发动（判定，令距离 1 的一名角色本回合不能用对应颜色的手牌）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            // 统一技能判定（鬼才/鬼道可改判）
            ctx.api.judge('潜袭', (judge) => {
              if (!judge) return;
              const color: 'red' | 'black' = cardColor(judge) === 'red' ? 'red' : 'black';
              pushLog(
                st,
                'skill',
                `${p.name} 发动【潜袭】，判定牌：${cardLabel(judge)}（${color === 'red' ? '红色' : '黑色'}）。`,
              );
              ctx.api.askChoice(
                st,
                p.seatId,
                `【潜袭】：令谁本回合不能使用或打出${color === 'red' ? '红色' : '黑色'}手牌？`,
                targets.map((x) => ({ id: x.seatId, label: x.name })),
                (st2, _p2, targetId) => {
                  const t = getPlayer(st2, targetId);
                  if (!t) return;
                  t.flags.cannotPlayColor = color;
                  pushLog(
                    st2,
                    'skill',
                    `${t.name} 本回合不能使用或打出${color === 'red' ? '红色' : '黑色'}手牌。`,
                  );
                },
              );
            });
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '潜袭',
      desc: '准备阶段，你可以进行判定，然后令距离为1的一名角色本回合不能使用或打出与结果颜色相同的手牌。',
    },
    { name: '马术', desc: '锁定技，你计算与其他角色的距离-1。' },
  ],
};

/**
 * 【崩坏】（伪武将，只作为「被授予的技能」存在）。
 * 董卓·暴凌把自己变成「大董卓」时获得它。
 */
/**
 * 于吉 —— 千幻（君临天下·阵，**现行国战文本**，已核）。
 *
 * ⚠️ 注意：国战于吉是【千幻】，不是【蛊惑】——蛊惑是身份局版本的于吉，两者完全不同。
 *
 * 千幻：当与你势力相同的一名角色受到伤害后，你可以将一张与你武将牌上牌花色均不同的牌
 *      置于你的武将牌上。当与你势力相同的角色成为非装备牌的唯一目标时，你可以移去一张
 *      「千幻」牌取消之。
 *
 * 实现：千幻牌堆放在 Player.qianhuan（与「田」同类的武将牌上区域）；「成为非装备牌的
 * 唯一目标」用 othersBecomeTarget 这个时机——单人目标的锦囊现在也会派发它（见
 * startTrickResolution），【杀】那边本来就派发；取消【杀】走 attack.dodged，
 * 取消锦囊走 ctx.negatedSeats（与【无懈可击·国】同一条路）。
 */
/**
 * 荀攸 —— 奇策 / 智愚（君临天下·变，已核文本）。
 *
 * - 奇策：出牌阶段限一次，你可以将**所有手牌**当**任意一张普通锦囊牌**使用，
 *   你不能以此法使用目标数超过 X 的牌（X 为你的手牌数），然后你可以变更一次副将。
 * - 智愚：当你受到伤害后，你可以摸一张牌，然后展示所有手牌，若颜色均相同，来源弃置一张手牌。
 *
 * 奇策的交互形状与别的主动技相反：**先定锦囊、再定目标**（目标数还受手牌数限制），
 * 所以它不收 targetIds，全在 execute 里问：选锦囊 → 按那张锦囊的目标数选目标 →
 * 把手牌全部当材料打出去（api.castVirtualTrick）→ 最后可以变更一次副将。
 *
 * ⚠️ 虚拟锦囊的「花色」取第一张材料牌的花色（引擎的 castVirtualTrick 需要一个花色，
 *    而奇策的牌没有实体牌面）——只影响【帷幕】那类看颜色的判断，已注明。
 */
/**
 * 孙策 —— 激昂 / 鹰扬 / 魂殇（君临天下·势，已核国战文本）。
 *
 * - 激昂：当你使用【决斗】或红色【杀】指定目标后，或成为【决斗】或红色【杀】的目标后，
 *   你可以摸一张牌。（两个方向：自己用、自己成为目标）
 * - 鹰扬：当你拼点的牌亮出后，你可以令此牌的点数 +3 或 -3。
 * - 魂殇：副将技，此武将牌减少半个阴阳鱼；准备阶段，若你的体力值不大于 1，
 *   你本回合拥有「英姿」和「英魂」。
 *
 * **三条都做了**（这条注释曾停在「本批只做了【激昂】」）：
 *   鹰扬——拼点亮牌之后、比大小之前插了一次询问（`askPindianRevealed`，见 engine 的拼点流程）；
 *   魂殇——走 `api.grantTempSkill`（「只到本回合结束」那套，见 timing.ts），turnStart 里体力 ≤1
 *   就授予【英姿】【英魂】。
 */
/**
 * 吕范 —— 调度 / 典财（君临天下·变，**2017 印刷版**文本，已核）。
 *
 * - 调度：出牌阶段限一次，所有与你势力相同的角色可以依次选择一项：
 *   ①使用一张装备牌；②将装备区里的一张牌移动至另一名与你势力相同的角色的装备区里。
 *   ⚠️ 2019 修订版把调度整个换掉了（改成「同势力角色使用装备牌时摸一张」+「出牌阶段开始时
 *      拿队友一张装备再交给别人」）。这里按印刷版写，与项目对君临天下各包的一贯取法一致。
 * - 典财：其他角色的出牌阶段结束时，若你于此阶段失去了 X 张或更多的牌，则你可以将手牌
 *   摸至体力上限。若如此做，你可以变更副将（X 为你**当前体力值**）。
 *
 * 两处小地基：新时机 `othersPlayPhaseEnd`（其他角色的出牌阶段结束时，派给全场——与
 * othersPlayPhase 对称），以及「你这一个出牌阶段内失去了几张牌」的计数
 * （flags.lostCardsThisPhase，在 cardsLost 那个公共事件上累加、阶段结束再清零）。
 */
/**
 * 左慈 —— 役鬼 / 汲魂（**2019 典藏版 / OL2021** 国战文本，已核）。
 *
 * ⚠️ 版本差异很大：2017《君临天下·变》印刷版是「化身 + 新生」（看剩余武将牌堆的 5 张、
 *    扣至多 2 张当「化身」牌、届时明置并发动其中一张武将牌的技能），2019 典藏版改成
 *    「役鬼 + 汲魂」（把剩余武将牌堆的武将牌当「魂」，移去一张就视为使用一张牌）。
 *    两者是**完全不同的两套技能**，这里按项目口径取**新国战（2019 典藏版）**的役鬼/汲魂。
 *
 * - 役鬼：当你首次明置武将牌后，你将剩余武将牌堆中的两张武将牌扣置于武将牌上，称为「魂」牌；
 *   你可以移去一张「魂」牌，视为使用一张你于当前回合内未以此法使用过的基本牌或普通锦囊牌，
 *   且目标必须为与此「魂」牌势力相同或未确定势力的角色。
 * - 汲魂：当你受到伤害后，你可以从剩余武将牌堆中扣置一张牌加入「魂」牌；
 *   当一名角色的濒死结算结束后，若其与你势力不同且存活，你可以从剩余武将牌堆中扣置一张牌
 *   加入「魂」牌。
 *
 * 实现口径（都写在注释里）：
 * - 「魂」牌在武将牌上是**暗置**的，所以用的时候是**随机**移去一张（左慈自己也不知道是哪张），
 *   移去时把那张武将牌亮出来（牌面与势力公开），目标限制就按它的势力算。
 * - 基本牌里只列【杀】【酒】【桃】（【闪】不能在出牌阶段主动使用）；锦囊用与奇策同一张表，
 *   但**排除【无懈可击】**（它只能在响应时机用），且群体锦囊只有当"场上所有目标都符合势力
 *   限制"时才列出来（否则用了也会违反限制）。
 * - 「每回合内未以此法使用过」按**牌名**记（flags.hunUsedNames ✓ 回合开始清零）。
 */
/**
 * 卞夫人 —— 挽危 / 约俭（君临天下·变，**2017 印刷版**文本，已核）。
 *
 * - 挽危：当你因被其他角色**获得或弃置**而失去牌时，你可以改为**自己选择**失去的牌。
 *   ⚠️ 2020 修订版整个换掉了（改成「从牌堆获得一张同名牌」，每回合限一次），未采用；
 *      版本差异写在这里与 roster。
 * - 约俭：锁定技，与你势力相同的角色的弃牌阶段开始时，若其本回合未使用牌指定过
 *   其他势力的角色为目标，其本回合手牌上限等于其体力上限。
 *
 * 实现：
 * - 挽危：单人目标的锦囊在结算前会派一环「成为目标后」（payload 里带 trickCtx 与牌），
 *   如果那张是【过河拆桥】/【顺手牵羊】且**自己就是目标**，就问自己挑哪张丢，
 *   把结果写进 `trickCtx.targetCardId` —— 引擎那边的 pickTargetCard 已经支持
 *   「指定的手牌」（刚补的），所以拆/顺就按她挑的那张结算。
 * - 约俭：新时机 othersDiscardPhase（派给全场，技能自己按势力过滤）+
 *   flags.targetedOtherFactionThisTurn（在 useCard 时按载荷里的 targetIds 登记）。
 *   手牌上限＝体力上限的做法是给那名角色加 `handLimitBonus += maxHp - hp`。
 */
/**
 * 沙摩柯 —— 蒺藜（君临天下·变，已核）。
 *
 * 蒺藜：当你于一回合内使用或打出第 X 张牌时，你可以摸 X 张牌（X 为你的攻击范围）。
 *
 * 官方 FAQ 里那条最容易做错的：**武器牌自己不算**——「本回合先出牌、再装青釭剑」不能发动，
 * 「先装青釭剑（范围变 2）、再出牌」才可以。所以范围要取**这张牌生效之前**的值，
 * 引擎在 onPlayCard/onRespondCard 里记了 `flags.actionRangeSnapshot` 就是干这个的
 * （装备牌的生效会把范围改掉，快照留的是改之前的值）。
 */
/**
 * 李傕郭汜 —— 凶算（君临天下·变，已核；**国战只有这一个技能**）。
 *
 * ⚠️ 【亦算】不是国战李傕郭汜的技能（那是身份/SP 单体李傕的），别混。国战双将的技能只有凶算。
 *
 * 凶算：限定技，出牌阶段，你可以弃置一张手牌并选择与你势力相同的一名角色，对其造成 1 点伤害，
 * 然后你摸三张牌。若其有已发动的限定技，你选择其一个限定技，此结束阶段视为此限定技未发动过。
 *
 * 实现：「视为未发动」＝在本回合结束时把那名角色 `usedOncePerGame` 里的那条删掉。
 * 所以先把被点名的技能 id 记在被点名角色身上（flags.limitedToReset），
 * 到李傕郭汜自己的结束阶段（turnEnd，锁定技式、不问）统一清掉。
 */
/**
 * 于禁 —— 节钺（君临天下·权，已核；与印刷版/OL 一致）。
 *
 * 节钺：准备阶段开始时，你可以交给**不是魏势力**（即与你势力不同）的一名角色一张手牌，
 * 然后令其执行一次「军令」。若其执行，你摸一张牌；若其不执行，则你本回合摸牌阶段额外摸三张牌。
 *
 * 军令那套机制是现成的（董昭·劝进用过：api.armyOrder），这里只是方向相反——
 * 劝进是自己交给受伤角色、节钺是交给异势力角色。
 */
/**
 * 崔琰毛玠 —— 征辟 / 奉迎（君临天下·权，取 **2019 修订版**文本，已核）。
 *
 * ⚠️ 三版差异很大，这里按 2019 修订版（2023 国战典藏版也是这版）写：
 *   - 2018 初版：征辟①是「令一名未确定势力的角色**视为与你势力相同**」——官方随后以
 *     「逼人亮将、可能直接引发胜利」为由改掉；
 *   - 2019 修订版（本实现）：①改成「你对其使用牌无距离和次数限制」；
 *   - 2021 现行线上版：征辟①又变成「此阶段结束时，若其明置过武将牌，你获得其一张手牌和
 *     一张装备区里的牌」；奉迎也从「同势力摸至体力上限」改成「弃光手牌换一个额外回合」。
 *
 * 2019 版原文：
 * - 征辟：出牌阶段开始时，你可以选择一项：①选择一名未确定势力的其他角色，直到回合结束
 *   或其明置武将牌，你对其使用牌无距离和次数限制；②选择一名有明置武将牌的其他角色，
 *   你将一张基本牌交给该角色，然后其将一张非基本牌或两张基本牌交给你。
 * - 奉迎：限定技，你可以将所有手牌当【挟天子以令诸侯】使用（无视大势力限制），
 *   然后每名与你势力相同的角色将手牌摸至体力上限。
 *
 * 实现要点：
 * - 「无距离和次数限制」用新标记 flags.distanceLimitlessToSeat：distance() 里对那个座位
 *   直接返回 1（够得着），playSha 的距离/次数校验也放行；「直到其明置武将牌」靠**惰性判断**
 *   实现——只要目标还有暗置武将牌，这个效果就还在（明置了自然失效）。
 * - 奉迎的虚拟锦囊走 api.castVirtualTrick（不带大势力校验），之后按 api.handLimit 给
 *   同势力角色补到手牌上限。
 */
const CUIYAN_MAOJIE: Hero = {
  id: 'cuiyan_maojie',
  name: '崔琰毛玠',
  faction: 'wei',
  pack: 'quan', // quan 包：该包开关关闭时不进选将池
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      timing: 'playPhase',
      skillId: '征辟',
      handler: (ctx) => {
        const me = ctx.player;
        const hiddenOthers = ctx.state.players.filter(
          (p) =>
            p.alive &&
            p.seatId !== me.seatId &&
            unrevealedHeroes(ctx.state.mode, p).length > 0 &&
            !effectiveFaction(ctx.state, p),
        );
        const shownOthers = ctx.state.players.filter(
          (p) => p.alive && p.seatId !== me.seatId && !!effectiveFaction(ctx.state, p),
        );
        const basics = me.hand.filter((c) => isBasicCard(c));
        const options: { id: string; label: string }[] = [];
        if (hiddenOthers.length > 0) {
          options.push({
            id: 'limitless',
            label: '①令一名未确定势力的角色：本回合你对其用牌无距离和次数限制',
          });
        }
        if (shownOthers.length > 0 && basics.length > 0) {
          options.push({ id: 'swap', label: '②与一名已明置的角色交换牌（你给一张基本牌）' });
        }
        options.push({ id: 'no', label: '不发动' });
        ctx.api.askChoice(ctx.state, me.seatId, '是否发动【征辟】？', options, (st, p, picked) => {
          if (picked === 'no') return;
          if (picked === 'limitless') {
            ctx.api.askChoice(
              st,
              p.seatId,
              '【征辟①】：选择一名未确定势力的角色',
              hiddenOthers.map((x) => ({ id: x.seatId, label: x.name })),
              (st2, p2, targetId) => {
                p2.flags.distanceLimitlessToSeat = targetId;
                pushLog(
                  st2,
                  'skill',
                  `${p2.name} 发动【征辟】：本回合对 ${getPlayer(st2, targetId)?.name ?? '对方'} 使用牌无距离和次数限制。`,
                );
              },
              p.seatId,
            );
            return;
          }
          // ②交换：先挑一张基本牌，再挑一名已明置的角色
          const basicsNow = p.hand.filter((c) => isBasicCard(c));
          if (basicsNow.length === 0) return;
          ctx.api.askPickCards(
            st,
            p.seatId,
            '【征辟②】：选择要交出的基本牌',
            basicsNow,
            1,
            1,
            (st2, p2, chosen) => {
              const card = chosen[0];
              if (!card) return;
              const shown = st2.players.filter(
                (x) => x.alive && x.seatId !== p2.seatId && !!effectiveFaction(st2, x),
              );
              if (shown.length === 0) return;
              ctx.api.askChoice(
                st2,
                p2.seatId,
                '【征辟②】：交给谁？',
                shown.map((x) => ({ id: x.seatId, label: x.name })),
                (st3, p3, targetId) => {
                  const target = getPlayer(st3, targetId);
                  if (!target) return;
                  removeCard(p3.hand, card.id);
                  target.hand.push(card);
                  pushLog(
                    st3,
                    'skill',
                    `${p3.name} 发动【征辟】，把【${cardLabel(card)}】交给 ${target.name}。`,
                  );
                  caoyanSwapBack(st3, p3, target, ctx.api);
                },
                p2.seatId,
              );
            },
            { returnTo: p.seatId },
          );
        });
      },
    },
    {
      timing: 'playPhase',
      skillId: '奉迎',
      handler: (ctx) => {
        const me = ctx.player;
        if (me.usedOncePerGame.fengying) return;
        if (me.hand.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          '是否发动限定技【奉迎】（所有手牌当【挟天子以令诸侯】使用）？',
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            p.usedOncePerGame.fengying = true;
            const materials = p.hand.slice();
            const suit = materials[0]?.suit ?? 'spade';
            for (const c of materials) removeCard(p.hand, c.id);
            toDiscard(st, ...materials);
            pushLog(
              st,
              'skill',
              `${p.name} 发动【奉迎】，用 ${materials.length} 张手牌当【挟天子以令诸侯】使用。`,
            );
            ctx.api.castVirtualTrick(p.seatId, { type: 'xietianzi', suit }, []);
            // 然后每名同势力角色摸至手牌上限
            for (const ally of st.players) {
              if (!ally.alive) continue;
              if (!sameKnownFaction(st, p, ally)) continue;
              const need = ctx.api.handLimit(ally.seatId) - ally.hand.length;
              let got = 0;
              for (let i = 0; i < Math.max(0, need); i++) {
                const c = drawOne(st);
                if (!c) break;
                ally.hand.push(c);
                got++;
              }
              if (got > 0) {
                pushLog(st, 'skill', `${ally.name} 因【奉迎】摸了 ${got} 张牌。`, {
                  seat: ally.seatId,
                });
              }
            }
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '征辟',
      desc: '出牌阶段开始时，你可以选择一项：1.选择一名未确定势力的其他角色，直到回合结束或其明置武将牌，你对其使用牌无距离和次数限制；2.选择一名有明置武将牌的其他角色，你将一张基本牌交给该角色，然后其将一张非基本牌或两张基本牌交给你。',
    },
    {
      name: '奉迎',
      desc: '限定技，你可以将所有手牌当【挟天子以令诸侯】使用（无视大势力限制），然后每名与你势力相同的角色将手牌摸至体力上限。',
    },
  ],
};

/** 征辟②的回礼：由**对方**选择交一张非基本牌，或两张基本牌 */
function caoyanSwapBack(state: GameState, me: Player, target: Player, api: SkillApi): void {
  const nonBasics = target.hand.filter((c) => !isBasicCard(c));
  const basics = target.hand.filter((c) => isBasicCard(c));
  const options: { id: string; label: string }[] = [];
  if (nonBasics.length > 0) options.push({ id: 'nonbasic', label: '交给对方一张非基本牌' });
  if (basics.length >= 2) options.push({ id: 'twoBasics', label: '交给对方两张基本牌' });
  if (options.length === 0) {
    pushLog(state, 'skill', `${target.name} 没有合适的牌可以交回，【征辟】就此结束。`);
    return;
  }
  api.askChoice(
    state,
    target.seatId,
    `【征辟】：${me.name} 给了你一张基本牌，你交回什么？`,
    options,
    (st, t, picked) => {
      const pool = picked === 'nonbasic' ? nonBasics : basics;
      const count = picked === 'nonbasic' ? 1 : 2;
      api.askPickCards(
        st,
        t.seatId,
        `【征辟】：选择交给 ${me.name} 的牌`,
        pool,
        count,
        count,
        (st2, t2, chosen) => {
          for (const c of chosen) {
            removeCard(t2.hand, c.id);
            me.hand.push(c);
          }
          pushLog(st2, 'skill', `${t2.name} 交给 ${me.name} ${chosen.length} 张牌。`, {
            seat: t2.seatId,
          });
        },
        { returnTo: t.seatId },
      );
    },
    me.seatId,
  );
}

const YUJIN: Hero = {
  id: 'yujin',
  name: '于禁',
  faction: 'wei',
  pack: 'quan', // quan 包：该包开关关闭时不进选将池
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      timing: 'turnStart',
      skillId: '节钺',
      handler: (ctx) => {
        const me = ctx.player;
        if (me.hand.length === 0) return;
        const mine = effectiveFaction(ctx.state, me);
        const targets = ctx.state.players.filter(
          (p) => p.alive && p.seatId !== me.seatId && effectiveFaction(ctx.state, p) !== mine,
        );
        if (targets.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          '是否发动【节钺】？',
          [
            { id: 'yes', label: '发动（交给一名其他势力的角色一张手牌，令其执行「军令」）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.askPickCards(
              st,
              p.seatId,
              '【节钺】：选择要交出的手牌',
              p.hand.slice(),
              1,
              1,
              (st2, p2, chosen) => {
                const card = chosen[0];
                if (!card) return;
                const list = st2.players.filter(
                  (x) =>
                    x.alive &&
                    x.seatId !== p2.seatId &&
                    effectiveFaction(st2, x) !== effectiveFaction(st2, p2),
                );
                if (list.length === 0) return;
                ctx.api.askChoice(
                  st2,
                  p2.seatId,
                  '【节钺】：把这张牌交给谁？',
                  list.map((x) => ({ id: x.seatId, label: x.name })),
                  (st3, p3, targetId) => {
                    const target = getPlayer(st3, targetId);
                    if (!target) return;
                    removeCard(p3.hand, card.id);
                    target.hand.push(card);
                    pushLog(
                      st3,
                      'skill',
                      `${p3.name} 发动【节钺】，将【${cardLabel(card)}】交给 ${target.name} 并令其执行军令。`,
                    );
                    ctx.api.armyOrder(p3.seatId, targetId, (st4, executed) => {
                      if (executed) {
                        const c = drawOne(st4);
                        if (c) p3.hand.push(c);
                        pushLog(st4, 'skill', `${target.name} 执行了军令，${p3.name} 摸一张牌。`);
                        return;
                      }
                      // 不执行：本回合摸牌阶段额外摸三张
                      p3.flags.drawCountDelta += 3;
                      pushLog(
                        st4,
                        'skill',
                        `${target.name} 拒绝执行军令，${p3.name} 本回合摸牌阶段多摸三张牌。`,
                      );
                    });
                  },
                  p2.seatId,
                );
              },
              { returnTo: p.seatId },
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '节钺',
      desc: '准备阶段，你可以交给不是魏势力的一名角色一张手牌，然后令其执行一次「军令」。若其执行，你摸一张牌；若其不执行，你本回合摸牌阶段多摸三张牌。',
    },
  ],
};

/**
 * 法正 —— 恩怨 / 眩惑（君临天下·权，取 **2019 修订版**＝三国杀官网现行文本，已核）。
 *
 * - 恩怨（锁定技）
 *   ① 当其他角色对你使用【桃】时，其摸一张牌。
 *   ② 当你受到伤害后，伤害来源选择交给你一张手牌或失去 1 点体力。
 *   ⚠️ 2018 初版的①是「当你获得一名其他角色至少两张牌后，该角色摸一张牌」，2019 修订版
 *      换成了「对你用桃的人摸一张牌」——本实现取 2019 版（官网现行文本）。
 *   ①只可能发生在**濒死求桃**时（【桃】平时只能对自己使用），所以引擎在救援收尾处把它
 *      放进 afterHeal 的 payload.taoSaverId 里派发。与【孙权·救援】同一口径：**只认实体
 *      【桃】**，红牌当桃（华佗·急救）与酒当桃不算——它俩在引擎里是「转化/替代」，连救援
 *      的加成也吃不到（详见 engine.respondDeathSave 的注释）。
 *   ②是**强制**的（锁定技，没得选「不发动」）。来源没手牌可交时只剩「失去 1 点体力」一条路，
 *      这种情况直接结算、不弹一个只有单项的询问。
 *
 * - 眩惑：与你势力相同的**其他**角色的出牌阶段限一次，其可以交给你一张手牌并弃置一张牌，
 *   然后其本回合获得「武圣」「咆哮」「龙胆」「铁骑」「烈弓」「狂骨」之一
 *   （不能选择场上已有的技能）。
 *   与【黄天】一样是**反向**技能（由别人发动、好处给别人），所以挂在外部技能表上
 *   （legal 的可选技能表 + engine.onUseSkill 的查找），不在法正自己的技能表里。
 *   - 「场上已有」按**明置武将牌上写着这个技能**算（含别人借到的技能——那是公开信息），
 *     暗置武将的技能不算：国战里暗置的武将牌本来就没有技能。六个全在场上时用不了。
 *   - 六个技能都是**国战版**（getHeroForMode 取的那张牌），所以借来的「烈弓」按国战条件判、
 *     「咆哮」带上「第二张杀摸一张」那一句。
 *   - 发动者自己必须是**已确定势力**的角色（effectiveFaction 非空）——暗将没有势力，
 *     「与你势力相同」无从谈起。官方 2018 初版给王平·将略专门写了「未确定势力的角色可以
 *     在此时明置武将牌」，说明常规情况下未确定势力者不参与这类结算（黄天同一口径）。
 */
const FAZHENG: Hero = {
  id: 'fazheng',
  name: '法正',
  faction: 'shu',
  pack: 'quan', // quan 包：该包开关关闭时不进选将池
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      // 恩怨①：别人用【桃】把你从濒死救回来 → 他摸一张牌
      timing: 'afterHeal',
      skillId: '恩怨',
      locked: true,
      handler: (ctx) => {
        const payload = ctx.payload as HealPayload | undefined;
        const saverId = payload?.taoSaverId;
        if (!saverId) return;
        const saver = getPlayer(ctx.state, saverId);
        if (!saver) return;
        const c = drawOne(ctx.state);
        if (!c) return;
        saver.hand.push(c);
        pushLog(ctx.state, 'skill', `${saver.name} 因【恩怨】摸了 1 张牌。`);
      },
    },
    {
      // 恩怨②：受到伤害后，来源「交给你一张手牌」或「失去 1 点体力」——由**来源**选
      timing: 'afterDamage',
      skillId: '恩怨',
      locked: true,
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
        const sourceId = payload?.attack?.sourceId;
        if (!payload?.damage || !sourceId || sourceId === ctx.player.seatId) return;
        const source = getPlayer(ctx.state, sourceId);
        if (!source) return;
        const me = ctx.player;
        const makeLoseHp = (st: GameState, who: Player): void => {
          pushLog(st, 'skill', `${who.name} 因【恩怨】失去 1 点体力。`);
          ctx.api.loseHp(who, 1);
        };
        if (source.hand.length === 0) {
          makeLoseHp(ctx.state, source); // 没手牌可交，只剩这一条
          return;
        }
        ctx.api.askChoice(
          ctx.state,
          source.seatId,
          `【恩怨】：交给 ${me.name} 一张手牌，或失去 1 点体力`,
          [
            { id: 'give', label: `交给 ${me.name} 一张手牌` },
            { id: 'lose', label: '失去 1 点体力' },
          ],
          (st, p, picked) => {
            if (picked === 'lose') {
              makeLoseHp(st, p);
              return;
            }
            // ⚠️ 手牌可能在这条询问挂起期间没了（别人顺手拿走/自己刚交出去）——那就只剩
            //    「失去 1 点体力」这一条。不重查的话会发一个「一张都没有却要求选 1 张」的
            //    询问：谁也答不上来，整局卡死（模糊测试 20000 步不动，seed=1329）。
            if (p.hand.length === 0) {
              makeLoseHp(st, p);
              return;
            }
            ctx.api.askPickCards(
              st,
              p.seatId,
              `【恩怨】：选择交给 ${me.name} 的一张手牌`,
              p.hand.slice(),
              1,
              1,
              (st2, p2, chosen) => {
                const card = chosen[0];
                if (!card) return;
                ctx.api.transferCard(p2.seatId, card, me.seatId, () => {
                  pushLog(st2, 'skill', `${p2.name} 因【恩怨】交给 ${me.name} 一张手牌。`);
                });
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '恩怨',
      desc: '锁定技，当其他角色对你使用【桃】时，其摸一张牌。当你受到伤害后，伤害来源选择交给你一张手牌或失去1点体力。',
    },
  ],
};

/** 眩惑能选的六个技能（都是**国战版**，所以借谁就用谁那张牌上的版本） */
const XUANHUO_SKILLS: { heroId: string; name: string }[] = [
  { heroId: 'guanyu', name: '武圣' },
  { heroId: 'zhangfei', name: '咆哮' },
  { heroId: 'zhaoyun', name: '龙胆' },
  { heroId: 'machao', name: '铁骑' },
  { heroId: 'huangzhong', name: '烈弓' },
  { heroId: 'weiyan', name: '狂骨' },
];

/** 这张（可能是合成/借来的）武将牌上有没有这个技能 */
function heroHasSkill(h: Hero, name: string): boolean {
  if (h.skills?.some((s) => s.name === name)) return true;
  if (h.hooks?.some((hk) => hk.skillId === name)) return true;
  if (h.activeSkills?.some((s) => s.name === name)) return true;
  if (h.skillFields?.[name]) return true;
  return false;
}

/** 这个技能在场上吗（只看**活着**的角色的**明置**武将牌 + 已授予的技能） */
export function skillOnField(state: GameState, name: string): boolean {
  for (const p of state.players) {
    if (!p.alive) continue;
    for (const h of effectiveHeroes(state, p)) if (heroHasSkill(h, name)) return true;
  }
  return false;
}

/** 眩惑此刻能选的技能：六个里场上还没有的那些 */
function xuanhuoChoices(state: GameState): { heroId: string; name: string }[] {
  return XUANHUO_SKILLS.filter((s) => !skillOnField(state, s.name));
}

/** 眩惑要交给谁：场上与你势力相同的、明置的、活着的法正（不含自己） */
function xuanhuoDonors(state: GameState, player: Player): Player[] {
  const mine = effectiveFaction(state, player);
  if (!mine) return []; // 暗将没有势力
  return state.players.filter(
    (p) =>
      p.alive &&
      p.seatId !== player.seatId &&
      effectiveFaction(state, p) === mine &&
      effectiveHeroes(state, p).some((h) => h.id === 'fazheng'),
  );
}

/**
 * 眩惑（法正·反向技能，见 FAZHENG 的注释）。
 *
 * 三步：交一张手牌给法正 → 弃一张牌（手牌或装备区）→ 选一个技能借到回合结束。
 * 材料不足 / 六个技能全在场时**不能发动**（canUse 直接拦掉），
 * 免得发动到一半才发现没得选。
 */
const XUANHUO: ActiveSkill = {
  id: 'xuanhuo',
  name: '眩惑',
  desc: '出牌阶段限一次，你可以交给一名明置的法正一张手牌并弃置一张牌，然后你本回合获得「武圣」「咆哮」「龙胆」「铁骑」「烈弓」「狂骨」之一（不能选择场上已有的技能）。',
  oncePerTurn: true,
  minTargets: 0,
  maxTargets: 0,
  needsCards: false,
  canUse: (state, player) =>
    xuanhuoDonors(state, player).length > 0 &&
    player.hand.length >= 1 &&
    handAndEquipOf(player).length >= 2 &&
    xuanhuoChoices(state).length > 0,
  execute: (state, player, _intent, api) => {
    const donors = xuanhuoDonors(state, player);
    if (donors.length === 0) return '场上没有与你势力相同的明置法正';
    if (player.hand.length === 0) return '眩惑要交给法正一张手牌';
    if (handAndEquipOf(player).length < 2) return '眩惑还要再弃置一张牌';
    if (xuanhuoChoices(state).length === 0) return '那六个技能场上都已经有了';

    // 第三步：从「场上还没有的」里挑一个，借到回合结束
    const chooseSkill = (): void => {
      const choices = xuanhuoChoices(state);
      if (choices.length === 0) return;
      api.askChoice(
        state,
        player.seatId,
        '【眩惑】：获得以下技能之一（直到回合结束）',
        choices.map((o) => ({ id: o.name, label: o.name })),
        (st, p, name) => {
          const pick = XUANHUO_SKILLS.find((o) => o.name === name);
          if (!pick) return;
          api.grantTempSkill(pick.heroId, pick.name, p.seatId);
          pushLog(st, 'skill', `${p.name} 因【眩惑】获得【${pick.name}】，直到回合结束。`);
        },
        player.seatId,
      );
    };

    // 第二步：弃一张牌（手牌或装备区——装备牌被弃会触发那类技能，走 api.discardCard）
    const discardStep = (): void => {
      api.askPickCards(
        state,
        player.seatId,
        '【眩惑】：弃置一张牌',
        handAndEquipOf(player),
        1,
        1,
        (st, p, chosen) => {
          const card = chosen[0];
          if (!card) {
            chooseSkill();
            return;
          }
          api.discardCard(p.seatId, card, () => {
            pushLog(st, 'skill', `${p.name} 发动【眩惑】，弃置了一张牌。`);
            chooseSkill();
          });
        },
        { returnTo: player.seatId },
      );
    };

    // 第一步：交一张**手牌**给法正
    const giveStep = (donor: Player): void => {
      api.askPickCards(
        state,
        player.seatId,
        `【眩惑】：选择交给 ${donor.name} 的一张手牌`,
        player.hand.slice(),
        1,
        1,
        (st, p, chosen) => {
          const card = chosen[0];
          if (!card) return;
          // 走 transferCard 而不是自己 splice：统一由它处理「牌的去向」与日志时机
          api.transferCard(p.seatId, card, donor.seatId, () => {
            pushLog(st, 'skill', `${p.name} 发动【眩惑】，交给 ${donor.name} 一张手牌。`);
            discardStep();
          });
        },
        { returnTo: player.seatId },
      );
    };

    if (donors.length === 1) {
      giveStep(donors[0]!);
      return undefined;
    }
    api.askChoice(
      state,
      player.seatId,
      '【眩惑】：交给哪位法正？',
      donors.map((p) => ({ id: p.seatId, label: p.name })),
      (_st, _p, targetSeatId) => {
        const t = donors.find((p) => p.seatId === targetSeatId);
        if (t) giveStep(t);
      },
      player.seatId,
    );
    return undefined;
  },
};

/** 法正能让别人用眩惑吗（给 engine / legal 的技能表用） */
export function xuanhuoFor(state: GameState, player: Player): ActiveSkill[] {
  return XUANHUO.canUse(state, player) ? [XUANHUO] : [];
}

/**
 * 王平 —— 将略（君临天下·权，限定技；文本按**三国杀官网现行文本**，已核）。
 *
 * 将略：限定技，出牌阶段，你可以选择一个「军令」，与你势力相同的其他角色均可执行该军令。
 *       你和每一个执行军令的角色体力上限+1且回复1点体力，然后你摸X张牌
 *       （X 为因此回复体力的角色数）。
 *
 * ⚠️ 版本差异：《君临天下·权》2018 印刷版里还有一句「未确定势力的角色可以在此时明置武将牌」，
 *    线上现行文本（官网 / OL / 移动版）删掉了它——本实现按现行文本，**不能让暗将借机明置**。
 *
 * 实现要点：
 * - 军令那套机制现成（董昭·劝进、于禁·节钺），这里用的是「**一条**军令问**多个**人」的
 *   变体 `api.armyOrderMulti`（引擎侧与 armyOrder 共用随机两张的挑令流程与结算队列）。
 * - 「体力上限+1且回复1点体力」的**顺序按官方原文**：先加满上限、再回血。这个顺序有实际影响：
 *   满血的队友加上限之后就有空间回这 1 点，所以「因此回复体力」的人必然是活着的参与者，
 *   X 也就等于「王平 + 真正执行的队友」的人数（被军令翻面的那种会因为不能回复体力而不算，
 *   所以用 `api.heal` 的**实际**回复量来数，不靠人数硬算）。
 * - 军令中途可能打死人（「造成 1 点伤害」那条），所以名单上的人要**依次**问、
 *   死掉的跳过——这也是 armyOrderMulti 里那个 step 链存在的原因。
 */
const WANGPING: Hero = {
  id: 'wangping',
  name: '王平',
  faction: 'shu',
  pack: 'quan', // quan 包：该包开关关闭时不进选将池
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  activeSkills: [
    {
      id: 'jianglue',
      name: '将略',
      oncePerGame: true,
      minTargets: 0,
      maxTargets: 0,
      needsCards: false,
      canUse: (state, player) => sameFactionOthers(state, player).length > 0,
      execute: (state, player, _intent, api) => {
        const mates = sameFactionOthers(state, player);
        if (mates.length === 0) return '没有与你势力相同的其他角色';
        pushLog(state, 'skill', `${player.name} 发动【将略】。`);
        api.armyOrderMulti(
          player.seatId,
          mates.map((m) => m.seatId),
          (st, executed) => {
            let healed = 0;
            for (const seatId of [player.seatId, ...executed]) {
              const p = getPlayer(st, seatId);
              if (!p || !p.alive) continue;
              api.changeMaxHp(p, 1); // 先加上限
              if (api.heal(p, 1) > 0) healed++; // 再回血；回不动的（不能回复体力）不算
            }
            const me = getPlayer(st, player.seatId);
            if (!me) return;
            pushLog(
              st,
              'skill',
              `${me.name} 的【将略】：${healed} 名角色体力上限+1并回复1点体力。`,
            );
            for (let i = 0; i < healed; i++) {
              const c = drawOne(st);
              if (c) me.hand.push(c);
            }
            pushLog(st, 'skill', `${me.name} 因【将略】摸了 ${healed} 张牌。`);
          },
        );
        return undefined;
      },
    },
  ],
  skills: [
    {
      name: '将略',
      desc: '限定技，出牌阶段，你可以选择一个「军令」，与你势力相同的其他角色均可执行该军令。你和每一个执行军令的角色体力上限+1且回复1点体力，然后你摸X张牌（X为因此回复体力的角色数）。',
    },
  ],
};

/** 场上与你势力相同的其他角色（含暗置的吗？不含——暗将没有势力，见 effectiveFaction） */
function sameFactionOthers(state: GameState, player: Player): Player[] {
  const mine = effectiveFaction(state, player);
  if (!mine) return [];
  return state.players.filter(
    (p) => p.alive && p.seatId !== player.seatId && effectiveFaction(state, p) === mine,
  );
}

const LIJUE_GUOSI: Hero = {
  id: 'lijue_guosi',
  name: '李傕郭汜',
  faction: 'qun',
  pack: 'bian', // bian 包：该包开关关闭时不进选将池
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  activeSkills: [
    {
      id: 'xiongsuan',
      name: '凶算',
      oncePerGame: true,
      minTargets: 1,
      maxTargets: 1,
      needsCards: true,
      maxCards: () => 1,
      canUse: (state, player) =>
        player.hand.length > 0 &&
        state.players.some((p) => p.alive && sameKnownFaction(state, player, p)),
      execute: (state, player, intent, api) => {
        const cardId = intent.cardIds?.[0];
        const card = cardId ? player.hand.find((c) => c.id === cardId) : undefined;
        if (!card) return '请弃置一张手牌';
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名与你势力相同的角色';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        if (!sameKnownFaction(state, player, target)) return '只能选择与你势力相同的角色';
        removeCard(player.hand, card.id);
        toDiscard(state, card);
        pushLog(
          state,
          'skill',
          `${player.name} 发动【凶算】，弃置【${cardLabel(card)}】，对 ${target.name} 造成 1 点伤害。`,
        );
        api.dealDamage(target, 1, player.seatId, undefined, () => {
          let got = 0;
          for (let i = 0; i < 3; i++) {
            const c = drawOne(state);
            if (!c) break;
            player.hand.push(c);
            got++;
          }
          pushLog(state, 'skill', `${player.name} 因【凶算】摸了 ${got} 张牌。`);
          // 已发动的限定技。
          // ① 主动技形式的限定技：按 id 找得到中文名；
          // ② 钩子形式的限定技（涅槃/暴凌/志继…）：用好者自己写的 key（都是拼音 id，
          //    如 'niepan'），找不到中文名就直接拿 key 当标签——这一点如实记在注释里。
          const used: { id: string; name: string }[] = [];
          for (const hero of effectiveHeroes(state, target)) {
            for (const sk of hero.activeSkills ?? []) {
              if (!sk.oncePerGame) continue;
              if (target.usedOncePerGame[sk.id]) used.push({ id: sk.id, name: sk.name });
            }
          }
          for (const [key, on] of Object.entries(target.usedOncePerGame)) {
            if (!on) continue;
            if (used.some((u) => u.id === key)) continue;
            used.push({ id: key, name: key });
          }
          if (used.length === 0) return;
          api.askChoice(
            state,
            player.seatId,
            `【凶算】：选择 ${target.name} 一个已发动的限定技（本回合结束时视为未发动）`,
            used.map((u) => ({ id: u.id, label: u.name })),
            (st, _p, skillId) => {
              const t = getPlayer(st, target.seatId);
              if (!t) return;
              t.flags.limitedToReset.push(skillId);
              const name = used.find((u) => u.id === skillId)?.name ?? skillId;
              pushLog(st, 'skill', `${t.name} 的限定技【${name}】将在本回合结束时视为未发动。`, {
                seat: t.seatId,
              });
            },
            player.seatId,
          );
        });
        return undefined;
      },
    },
  ],
  hooks: [
    {
      timing: 'turnEnd',
      skillId: '凶算',
      locked: true,
      handler: (ctx) => {
        // 本回合结束时，「凶算」点过名的限定技一律视为未发动过
        for (const p of ctx.state.players) {
          if (p.flags.limitedToReset.length === 0) continue;
          for (const skillId of p.flags.limitedToReset) {
            delete p.usedOncePerGame[skillId];
          }
          pushLog(
            ctx.state,
            'skill',
            `${p.name} 的限定技（${p.flags.limitedToReset.length} 个）视为未发动过。`,
            { seat: p.seatId },
          );
          p.flags.limitedToReset = [];
        }
      },
    },
  ],
  skills: [
    {
      name: '凶算',
      desc: '限定技，出牌阶段，你可以弃置一张手牌并选择与你势力相同的一名角色，对其造成1点伤害，然后你摸三张牌。若其有已发动的限定技，你选择其一个限定技，此结束阶段视为此限定技未发动过。',
    },
  ],
};

/**
 * 陆抗 —— 恪守 / 筑围（君临天下·权，吴，**1.5 阴阳鱼 → 3**，称号·孤柱扶厦；已核）。
 *
 * 恪守：当你受到伤害时，你可以弃置两张颜色相同的牌，令此伤害-1，若没有与你势力相同的
 *       其他角色，你判定，若结果为红色，你摸一张牌。
 * 筑围：当你的判定牌生效后，若此牌为【杀】或伤害锦囊牌，你可以获得之，然后你可以令当前
 *       回合角色本回合手牌上限+1、使用【杀】的限制次数+1。
 *
 * 读法与实现要点：
 * - 恪守的两句**互不依赖**（官网文本里第二句既没有「若如此做」也没有「然后」）：付不起、
 *   或不想付代价时，只要「没有与你势力相同的其他角色」，判定照样做。
 *   ⚠️ 版本差异：B 站 Wiki 的国战栏把它写成「……令此伤害-1，**然后**若没有……你进行一次判定」，
 *   读起来像「付了代价才判」。本实现取三国杀官网口径。
 * - 「令此伤害-1」走新通道 `flags.damageReduce`——damageDealt 钩子里除「防止」之外的第二个
 *   出口（可选的减伤没法写进 finalizeDamage 那套锁定技算法里）；减到 0 按「没造成伤害」处理。
 * - 筑围的「获得之」与【天妒】同路（beforeJudge 返回 `gainJudgeCard`）。⚠️ 与天妒一样是
 *   **自动收**（白拿一张牌严格优于不拿，官方那半句是「可以」）；真正需要问的是后半句
 *   （给当前回合角色加手牌上限/杀次数可能是在帮敌人），所以后半句单独弹一次询问。
 * - 「伤害锦囊牌」＝结算时会造成伤害的锦囊：决斗 / 南蛮入侵 / 万箭齐发 / 火攻 +
 *   势备篇的火烧连营、水淹七军（后者是「弃装备或受 1 点雷电伤害」二选一，能造成伤害所以算）。
 */
/**
 * 张绣 —— 附敌 / 从谏（君临天下·权，群，**2 阴阳鱼 → 4**；文本按三国杀官网，已核）。
 *
 * 附敌：当你受到伤害后，你可以交给伤害来源一张手牌。若如此做，你对与其势力相同的角色中
 *       体力值最多且不小于你的一名角色造成 1 点伤害。
 * 从谏：锁定技，当你于回合外造成伤害时，或当你于回合内受到伤害时，此伤害 +1。
 *
 * 读法与实现要点：
 * - 附敌的「其」是**伤害来源**：先把一张手牌交给来源（`api.transferCard`），再从「与来源
 *   势力相同的角色」里挑人打 1 点。候选要**体力值 ≥ 你**（体力值＝当前体力），其中取体力
 *   **最多**那一档；并列时由张绣挑。一个候选都没有时（例如来源是暗将、没有确定势力）
 *   连询问都不该弹，所以先算候选再决定要不要问。
 *   「与来源势力相同的角色」**含来源自己**（官方写的是「与其势力相同的角色」而非「其他角色」），
 *   也含同势力的张绣自己。
 * - 从谏是**锁定技**、用字段 `damageDelta` 表达（引擎在 damageStep 里读，所以任何伤害都吃得到，
 *   不像裸衣那样只作用于【杀】/【决斗】）。两个方向各自判断：① 你（来源）**回合外**造成伤害
 *   → +1；② 你（目标）**回合内**受到伤害 → +1。两条同时命中的只有「在自己回合里对自己
 *   造成伤害」——那时算②，不会加两次。
 */
/**
 * 吴国太 —— 甘露 / 补益（君临天下·权，吴，**1.5 阴阳鱼 → 3**，称号·武烈皇后；已核）。
 *
 * 甘露：出牌阶段限一次，你可以交换两名角色装备区里的牌（两者装备区里牌数之差不大于你已
 *       损失体力值，且牌数之和不小于 1）。
 * 补益：每回合限一次，当与你势力相同的角色脱离濒死状态后，你可以令本次伤害来源执行一次
 *       「军令」，若其不执行，此濒死角色回复 1 点体力。
 *
 * 实现要点：
 * - 甘露的两个限制都在「两名角色」这一对上，所以目标选择收在 execute 里校验（界面的合法目标
 *   是通用的「所有其他角色」，选错组合时给一句明确的错误）。交换走新原语
 *   `api.swapEquipAreas`——先把两边装备区的牌都收下来（各自触发失去装备的钩子），再互换放回，
 *   中途不会把牌顶进弃牌堆（那张「顶掉」的做法会把本来要换过去的牌弃掉）。
 *   「你已损失的体力值」按 X = 体力上限 - 当前体力。
 * - 补益挂在 `nearDeathResolved`（本轮才补上的派发点，见 engine.dispatchNearDeathResolved），
 *   payload 里的 `sourceId` 就是「本次伤害来源」。没有来源（闪电那种）时无从执行军令，直接跳过。
 *   「每回合限一次」用 `flags.skillUsedThisTurn['补益']`（随吴国太自己的回合重置）。
 */
/**
 * 袁术 —— 庸肆 / 伪帝（君临天下·权，群，**2 阴阳鱼 → 4**；文本按三国杀官网现行文本，已核）。
 *
 * 庸肆：锁定技，若场上没有【玉玺】，你视为装备着【玉玺】。当你成为【知己知彼】的目标时，
 *       你展示所有手牌。
 * 伪帝：出牌阶段限一次，你可以令一名本回合从牌堆获得过牌的其他角色执行一次「军令」，
 *       若其不执行，你获得其所有手牌并交给其等量张牌。
 *
 * 实现要点 / 读法：
 * - 虚拟玉玺用字段 `virtualYuxi`，两处消费方（摸牌阶段多摸一张、出牌阶段开始时视为使用
 *   【知己知彼】）都走 `heroes.hasYuxi`：**真的装**了，或者「庸肆 + 场上没有任何实体玉玺」。
 *   所以别人拿到实体玉玺时，袁术的虚拟玉玺就没了（官方写的是「若场上没有【玉玺】」）。
 * - 「成为【知己知彼】的目标时展示手牌」挂 `othersBecomeTarget`：单目标锦囊在
 *   `startTrickResolution` 里给**所有存活角色**（含目标本人）派发这个时机，所以袁术收得到
 *   自己那一条（按 payload.targetId 认人）；时机在无懈可击窗口之前，正好是「成为目标时」。
 *   「展示所有手牌」按本引擎的惯例写成一条**日志**（火攻、智愚都是这么表示公开亮牌的）。
 * - 伪帝的目标必须「本回合**从牌堆**获得过牌」：账本在 `state.gainedFromDeckThisTurn`
 *   （在 drawOne 里盖戳、随回合清空），判定时反过来查该角色的手牌/装备区里有没有这些牌。
 *   2019 修订版写的是「其他角色」（2018 初版可以对自己发动），本实现按 2019 版。
 * - 不执行军令的惩罚「你获得其所有手牌并交给其等量张牌」分两步：先把他的手牌全拿过来，
 *   再由袁术挑**等量**张还回去（还的时候可以还手牌或装备区的牌——官方 FAQ 明确过，
 *   所以还牌走 `api.transferCard`，丢装备会触发枭姬那类技能）。
 */
const YUANSHU: Hero = {
  id: 'yuanshu',
  name: '袁术',
  faction: 'qun',
  pack: 'quan', // quan 包：该包开关关闭时不进选将池
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  lockedFields: ['virtualYuxi'],
  skillFields: { 庸肆: ['virtualYuxi'] },
  virtualYuxi: true,
  hooks: [
    {
      timing: 'othersBecomeTarget',
      skillId: '庸肆',
      locked: true,
      handler: (ctx) => {
        const payload = ctx.payload as { targetId?: string; card?: Card } | undefined;
        if (payload?.targetId !== ctx.player.seatId) return; // 只看自己成为目标的那一次
        if (payload.card?.type !== 'zhibi') return;
        const me = ctx.player;
        const shown = me.hand.map((c) => cardLabel(c)).join('、') || '（无）';
        pushLog(
          ctx.state,
          'skill',
          `${me.name} 的【庸肆】：成为【知己知彼】的目标，展示手牌 ${shown}。`,
          {
            seat: me.seatId,
          },
        );
      },
    },
  ],
  activeSkills: [
    {
      id: 'weidi',
      name: '伪帝',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      needsCards: false,
      canUse: (state, player) => weidiTargets(state, player).length > 0,
      execute: (state, player, intent, api) => {
        const targetId = intent.targetIds[0];
        const target = targetId ? getPlayer(state, targetId) : undefined;
        if (!target || !weidiTargets(state, player).some((t) => t.seatId === target.seatId)) {
          return '只能选一名本回合从牌堆获得过牌的其他角色';
        }
        pushLog(
          state,
          'skill',
          `${player.name} 发动【伪帝】，令 ${target.name} 执行一次「军令」。`,
        );
        api.armyOrder(player.seatId, target.seatId, (st, executed) => {
          if (executed) return;
          const t = getPlayer(st, target.seatId);
          const me = getPlayer(st, player.seatId);
          if (!t || !me || !t.alive) return;
          const n = t.hand.length;
          if (n === 0) return;
          // 第一步：获得其**所有**手牌（走直接搬运：这不是「获得他人的牌」的响应时机，
          // 伪帝是惩罚结算，没有可以插进来的时机）
          for (const c of t.hand.slice()) {
            removeCard(t.hand, c.id);
            me.hand.push(c);
          }
          pushLog(st, 'skill', `${me.name} 获得 ${t.name} 的所有手牌（${n} 张）。`);
          // 第二步：交给其等量张牌（袁术自己挑，可以是手牌或装备区的牌）
          const pool = handAndEquipOf(me);
          const need = Math.min(n, pool.length);
          if (need === 0) return;
          api.askPickCards(
            st,
            me.seatId,
            `【伪帝】：交给 ${t.name} ${need} 张牌`,
            pool,
            need,
            need,
            (st2, _p2, chosen) => {
              const giveStep = (i: number): void => {
                const c = chosen[i];
                if (!c) {
                  pushLog(
                    st2,
                    'skill',
                    `${me.name} 交给 ${t.name} ${chosen.length} 张牌（伪帝）。`,
                  );
                  return;
                }
                // 走 transferCard：还装备区的牌会触发枭姬那类「失去装备」的技能
                api.transferCard(me.seatId, c, t.seatId, () => giveStep(i + 1));
              };
              giveStep(0);
            },
            { returnTo: player.seatId },
          );
        });
        return undefined;
      },
    },
  ],
  skills: [
    {
      name: '庸肆',
      desc: '锁定技，若场上没有【玉玺】，你视为装备着【玉玺】。当你成为【知己知彼】的目标时，你展示所有手牌。',
    },
    {
      name: '伪帝',
      desc: '出牌阶段限一次，你可以令一名本回合从牌堆获得过牌的其他角色执行一次「军令」，若其不执行，你获得其所有手牌并交给其等量张牌。',
    },
  ],
};

/** 伪帝能点名的人：本回合从牌堆获得过牌的其他存活角色 */
function weidiTargets(state: GameState, player: Player): Player[] {
  const owners = state.deckGainOwner;
  if (Object.keys(owners).length === 0) return [];
  // 「本回合从牌堆获得过牌」＝他手上还拿着**他自己摸到**的牌。用归因表而不是「本回合抽出的
  // 牌 id 列表」：后者会把「摸到之后被顺手牵羊拿走」的新持有者也算进来（账本记牌不记人）。
  const holds = (p: Player): boolean => {
    const all = [
      ...p.hand,
      ...EQUIP_SLOTS.map((s) => p.equipment[s]).filter((c): c is Card => !!c),
    ];
    return all.some((c) => owners[c.id] === p.seatId);
  };
  return state.players.filter((p) => p.alive && p.seatId !== player.seatId && holds(p));
}

/**
 * 吴景 —— 调归 / 风扬（不臣篇·上，吴，**2 阴阳鱼 → 4**，称号·汗马鎏金；移动版 2021 口径，已核）。
 *
 * 调归：出牌阶段限一次，你可以将一张装备牌当【调虎离山】使用，若你的势力**因此**形成队列，
 *       你摸 X 张牌（X 为该队列的人数）。
 * 风扬（阵法技，锁定技）：与你势力不同或未确定势力的角色不能弃置或获得**与你处于同一队列**
 *       的角色装备区里的牌。
 *
 * 实现要点 / 读法：
 * - 调归按字面只说「将一张装备牌当【调虎离山】使用」：材料是**手牌里的装备牌**，
 *   代价先付（进弃牌堆），然后走 `api.castVirtualTrick`（虚拟锦囊的完整流程：可被无懈抵消）。
 * - 「**因此**形成队列」按字面读：要求这次结算后队列**确实形成或变长**（before/after 比较，
 *   before 存在 `flags.queueSizeBeforeTrick` 里）。若吴景本来就有队列、这次没让它变长，不摸牌。
 *   为此引擎在【调虎离山】结算收尾处派发了 `afterUse`（详见那处注释：目前只开这一条路）。
 * - 队列 = `formationQueue`（与你势力相同的角色连续相邻的一段；被调虎离山移出的人不算座次，
 *   所以不算断开点）。⚠️ 官方阵法技里「队列」是否要求**至少 3 名**，本实现按「至少 2 名」
 *   处理（调归的典型用法就是把一名间隔角色调走、让两人连成一段），这一点已在 roster note 里标注。
 * - 风扬做成字段 `fengyang` + `fengyangBlocksEquip()`：引擎在「获得/弃置他人装备区里的牌」的
 *   几处收口调用它（过河拆桥/顺手牵羊的选牌、反馈那类转牌、麒麟弓/寒冰剑的弃牌）。
 *   「移动」类（巧变/谋断/勇进/甘露）不受限——官方只说「弃置或获得」，移动是另一种动作。
 */
/**
 * 严白虎 —— 雉盗 / 寄篱（不臣篇·上，群，**2 阴阳鱼 → 4**，称号·豺牙落涧；已核）。
 *
 * 雉盗（锁定技）：出牌阶段开始时，你选择一名其他角色，直到回合结束，你计算与其的距离视为 1
 *   且你不能使用牌指定除你与你与其外的角色为目标，然后当你于出牌阶段内第一次对其造成伤害后，
 *   你获得其区域里的一张牌。
 * 寄篱（**副将技**，锁定技）：你计算体力上限时减少 1 个单独的阴阳鱼。当你成为红色基本牌或
 *   红色普通锦囊牌的唯一目标后，在此牌结算结束后，此牌的使用者对你再使用一次相同牌名的牌。
 *   当你受到伤害时，若你于当前阶段内受到过伤害的次数为 1，你防止此伤害，然后移除该武将牌。
 *   ⚠️ 版本差异：2021 线下实体卡把中间那句写成「此牌结算两次」（同义）；2022 版（2023 典藏）
 *   去掉了「副将技」标签与「减少 1 个阴阳鱼」——本实现取 **2021 移动版**口径（副将技齐全），
 *   并在 roster note 里记了另两版。
 *
 * 实现要点：
 * - 雉盗的两个限制：距离用现成的 `flags.distanceToOneThisTurn`（丁奉·奋迅那套）；
 *   「只能指定他与你」用新标记 `flags.cardTargetOnlySeat`，在 engine.onPlayCard 里统一拦
 *   （`zhidaoTargetsBlocked`）——显式目标直接查，AOE 那类「不用指定目标却会打到别人」的牌
 *   在「除你与他还有别的存活角色」时也不许用。
 * - 「第一次对其造成伤害后」挂 afterDamageDealt（派给来源），用 `flags.zhidaoHitDone` 记一次，
 *   并且要求当前是**出牌阶段**；拿牌走现成的 `takeOneOfTargetCards`（手牌随机、明牌可选）。
 * - 寄篱的减伤+移除：在 `damageDealt`（扣血前）读「本阶段已受过几次伤」——
 *   计数记在 `flags.damageCountKey/damageCount`（键＝`回合座位:阶段名`，所以不用给每个阶段
 *   转换点加重置代码）。第 2 次直接 `flags.damagePrevented = true` 并移除这张武将牌。
 */
/**
 * 【荐才】「获知尚未登场的同势力武将牌」：把已知数量**补足**到 `轮数 × 3`。
 *
 * 两个要点（用户口径）：
 * - **「增至 X 张」，不是「每轮再看 X 张」**：先与武将牌堆取交集（已经真的登场的牌不再算
 *   「尚未登场」，自然让出名额），再把缺口补齐。
 * - 只是**私有信息**：牌仍然留在 `state.heroPool`（不算获得、不进手牌），只写进
 *   `player.knownHeroIds`——快照里只发给本人那一份（`knownHeroes`）。
 */
function jiancaiKnow(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const mine = effectiveFaction(state, me);
  if (!mine) return;
  // 已获知里「已经登场」的牌让位（与武将牌堆取交集）
  me.knownHeroIds = me.knownHeroIds.filter((id) => state.heroPool.includes(id));
  const want = state.round * 3;
  if (me.knownHeroIds.length >= want) return;
  const pool = state.heroPool.filter((id) => {
    if (me.knownHeroIds.includes(id)) return false;
    return getHeroForMode(id, state.mode)?.faction === mine;
  });
  const take = pool.slice(0, want - me.knownHeroIds.length);
  if (take.length === 0) return;
  me.knownHeroIds.push(...take);
  pushLog(
    state,
    'skill',
    `${me.name} 发动【荐才】：获知了 ${take.length} 张尚未登场的同势力武将牌。`,
    { seat: me.seatId },
  );
}

/**
 * 【荐才】保护：与徐庶势力相同的角色将受到**足以令其进入濒死**的伤害时，
 * 防止**整笔**伤害，然后变更徐庶自己的副将（徐庶就是当前副将，所以换完【荐才】也就离场了）。
 *
 * 判定用的是**已定的最终伤害值**（`beforeDamageApply` 的 payload，减伤/护心镜之前）——
 * 比官方口径略微容易触发，已记在文档里。
 */
function askJiancai(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const payload = ctx.payload as { targetId?: string; damage?: number } | undefined;
  const targetId = payload?.targetId;
  const dmg = payload?.damage ?? 0;
  const target = targetId ? getPlayer(state, targetId) : undefined;
  if (!target || !target.alive || dmg <= 0) return;
  const mine = effectiveFaction(state, me);
  if (!mine) return;
  // 「与你势力相同的角色」——没写「其他角色」，所以徐庶自己也可以被自己保护
  if (effectiveFaction(state, target) !== mine) return;
  if (target.hp - dmg > 0) return; // 不会进入濒死 → 不触发
  if (me.removedHeroIds.includes('xushu')) return; // 武将牌已经被移除（士兵牌顶替）→ 没有这个技能
  ctx.api.askChoice(
    state,
    me.seatId,
    `【荐才】：${target.name} 将受到 ${dmg} 点伤害（会进入濒死），是否防止之并变更你的副将？`,
    [
      { id: 'yes', label: '发动（防止伤害 + 变更副将）' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      const t = getPlayer(st, target.seatId);
      if (t) t.flags.damagePrevented = true; // 整笔伤害作废（引擎在 damageDealt 之后统一读这个标记）
      pushLog(
        st,
        'skill',
        `${p.name} 发动【荐才】：防止了 ${target.name} 受到的 ${dmg} 点伤害，然后变更自己的副将。`,
        { seat: p.seatId },
      );
      // 势力**不是全场唯一大势力**时，可以优先从已获知的武将里挑新副将
      const uniqueBig = isBigFaction(st, mine) && bigFactions(st).length === 1;
      const preferred = uniqueBig ? undefined : p.knownHeroIds.slice();
      if (uniqueBig) {
        pushLog(st, 'skill', `${p.name} 的势力是全场唯一大势力，只能走普通变更副将。`, {
          seat: p.seatId,
        });
      }
      ctx.api.changeDeputyHero(p.seatId, preferred ? { preferred } : undefined);
    },
  );
}

/**
 * 徐庶 —— 【诛害】/【荐才】（不臣篇·上，蜀，**2 阴阳鱼 → 4**，称号·难为完臣）。
 *
 * 口径＝**用户给出的等价规则实现文本**（2026-09，移动版现行；见 docs/guozhan-roster.md §5.89）：
 * - 【诛害】：**其他角色进入结束阶段时**，若该角色本回合**造成过伤害**，你可以对他**使用一张【杀】**
 *   ——正常走完整的使用流程（使用→指定目标→防具→闪响应→结算→伤害），**有距离限制**，
 *   实体【杀】/转化【杀】/【丈八蛇矛】两张牌凑的虚拟【杀】都允许。
 *   若该角色本回合还**伤害过与徐庶势力相同的角色**，这张【杀】强化：
 *   **无视其防具**，且其**每实际使用（或视为使用）一张【闪】响应后，弃置 1 张牌**。
 * - 【荐才】（**副将技**）：① 副将位时组合体力上限再减 1 个单独阴阳鱼（`deputySlotHalfYang`）；
 *   ② **这张副将明置时**与**每轮开始时**，私下获知「尚未登场且与自己势力相同的武将牌」，
 *   数量**补足到 轮数×3**（是「增至 X 张」不是「每轮再看 X 张」）；
 *   ③ 与徐庶同势力的角色将受到**足以令其进入濒死**的伤害时，可以**防止整笔伤害**，
 *   然后**变更自己的副将**——势力不是**全场唯一大势力**时，可以**优先从已获知的那批武将里挑**。
 *
 * ⚠️ 版本差异：仓库原先按 **2021 线下实体卡**口径实现的是【诛害】+【举荐】（举荐＝结束阶段弃一张
 *   非基本牌、令同势力角色二选一摸牌/回血，然后可变更副将；那一版留在 git 历史里）。用户核对后
 *   给的现行口径是「诛害带强化 + 副将技【荐才】」，本轮按后者改写。
 * ⚠️ 变更副将**不重算体力上限**（官方「变更」规则）：荐才换掉徐庶之后，上限不会变。
 */
const XUSHU: Hero = {
  id: 'xushu',
  name: '徐庶',
  faction: 'shu',
  pack: 'buchen', // 不臣篇（buchen 开关关闭时不进选将池）
  // 国战牌面 2 阴阳鱼 → 4（走副将位时举荐再减 1）
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  // 珠联璧合（国战徐庶）：赵云、卧龙诸葛亮
  combos: ['zhaoyun', 'wolong'],
  deputySlotSkills: ['荐才'],
  deputySlotHalfYang: true,
  hooks: [
    {
      timing: 'othersTurnEnd',
      skillId: '诛害',
      handler: (ctx) => {
        const payload = ctx.payload as { turnSeatId?: string } | undefined;
        const endingId = payload?.turnSeatId;
        const me = ctx.player;
        if (!endingId || endingId === me.seatId) return; // 只对**别人**的结束阶段
        const ending = getPlayer(ctx.state, endingId);
        if (!ending || !ending.alive) return;
        if (!ending.flags.dealtDamageThisTurn) return; // 「若该角色本回合造成过伤害」
        // 【诛害】**有距离限制**（文本里没有「无距离限制」；强化分支的「无视防具」也不等于无视距离）
        if (!canTarget(ctx.state, me.seatId, endingId)) return;
        // 强化条件：该角色本回合**伤害过与徐庶势力相同的角色**。
        // 势力按**伤害发生那一刻**的公开状态记（effectiveFaction，暗将＝未确定），不追溯。
        const mine = effectiveFaction(ctx.state, me);
        const enhanced =
          mine !== null &&
          ctx.state.damageLedgerThisTurn.some(
            (e) => e.sourceId === endingId && e.targetFaction === mine,
          );
        const shaCards = usableShaCards(ctx.state, me);
        // 【丈八蛇矛】：两张手牌当【杀】（官方口径明确诛害可以用它）
        const zhangbaOk = me.equipment.weapon?.equipName === 'zhangba' && me.hand.length >= 2;
        if (shaCards.length === 0 && !zhangbaOk) return;
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          enhanced
            ? `是否发动【诛害】，对 ${ending.name} 使用一张【杀】？（其本回合伤害过你的同势力角色 → 此【杀】无视其防具、其每用一张【闪】响应后须弃一张牌）`
            : `是否发动【诛害】，对 ${ending.name} 使用一张【杀】？`,
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            pushLog(
              st,
              'skill',
              enhanced
                ? `${p.name} 发动【诛害】（强化），对 ${ending.name} 使用一张【杀】：无视其防具，其每用一张【闪】响应后须弃一张牌。`
                : `${p.name} 发动【诛害】，对 ${ending.name} 使用一张【杀】。`,
            );
            const use = (card: Card, extra?: string[]): void => {
              ctx.api.useShaOn(p.seatId, ending.seatId, card, {
                logKind: 'skill',
                ignoreArmor: enhanced,
                skillId: '诛害',
                ...(extra ? { extraCardIds: extra } : {}),
              });
            };
            const options = [
              ...shaCards.map((c) => ({ id: c.id, label: `使用【${cardLabel(c)}】` })),
              ...(zhangbaOk
                ? [{ id: 'zhangba', label: '【丈八蛇矛】：两张手牌当【杀】' }]
                : []),
            ];
            // 手里一张【杀】都没有、但有【丈八蛇矛】：直接进「选两张牌」
            if (shaCards.length === 0 && zhangbaOk) {
              ctx.api.askPickCards(
                st,
                p.seatId,
                '【诛害】·【丈八蛇矛】：选择两张手牌当【杀】',
                p.hand.slice(),
                2,
                2,
                (_st3, _p3, chosen) => {
                  const [c1, c2] = chosen;
                  if (!c1 || !c2) return;
                  use(c1, [c2.id]);
                },
              );
              return;
            }
            if (options.length === 1) {
              use(shaCards[0]!);
              return;
            }
            ctx.api.askChoice(
              st,
              p.seatId,
              '【诛害】：怎么出这张【杀】？',
              options,
              (st2, p2, how) => {
                if (how === 'zhangba') {
                  ctx.api.askPickCards(
                    st2,
                    p2.seatId,
                    '【诛害】·【丈八蛇矛】：选择两张手牌当【杀】',
                    p2.hand.slice(),
                    2,
                    2,
                    (_st3, _p3, chosen) => {
                      const [c1, c2] = chosen;
                      if (!c1 || !c2) return;
                      use(c1, [c2.id]);
                    },
                  );
                  return;
                }
                const c = p2.hand.find((x) => x.id === how);
                if (c) use(c);
              },
            );
          },
        );
      },
    },
    // 【诛害】强化分支的另一半：这张【杀】的目标**每实际使用一张【闪】响应后，弃置 1 张牌**
    // （「不能响应」那类不涉及；八卦阵的视为出闪在这条路上走不到——强化杀无视防具，八卦阵直接不触发）
    {
      timing: 'anyShanUsed',
      skillId: '诛害',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext; responderId?: string } | undefined;
        const attack = payload?.attack;
        if (!attack || attack.skillId !== '诛害' || !attack.ignoreArmor) return;
        if (attack.targetId !== payload?.responderId) return; // 只认「这张杀的目标」的闪
        const victim = getPlayer(ctx.state, attack.targetId);
        if (!victim || !victim.alive) return;
        const pool = handAndEquipOf(victim); // 「能够自行弃置的牌」＝手牌 + 装备区
        if (pool.length === 0) return; // 没有可弃的牌 → 这一步没有实际效果
        ctx.api.askPickCards(
          ctx.state,
          victim.seatId,
          '【诛害】：你用【闪】响应了强化【杀】，须弃置一张牌',
          pool,
          1,
          1,
          (st, t, chosen) => {
            const card = chosen[0];
            if (!card) return;
            ctx.api.discardCard(t.seatId, card, () => {
              pushLog(st, 'skill', `${t.name} 因【诛害】弃置了【${cardLabel(card)}】。`, {
                seat: t.seatId,
              });
            });
          },
        );
      },
    },
    // 【荐才】①「这张副将明置时」与②「每轮开始时」：私下获知武将牌（补足到 轮数×3）
    { timing: 'heroRevealed', skillId: '荐才', handler: jiancaiKnow },
    { timing: 'roundStart', skillId: '荐才', handler: jiancaiKnow },
    // 【荐才】③：同势力角色将受到**会令其进入濒死**的伤害 → 防止整笔 + 变更自己的副将
    { timing: 'beforeDamageApply', skillId: '荐才', handler: askJiancai },
  ],
  skills: [
    {
      name: '诛害',
      desc: '其他角色的结束阶段，若该角色本回合造成过伤害，则你可以对其使用一张【杀】。若其本回合对与你势力相同的角色造成过伤害，则此【杀】无视其防具，且其每使用一张【闪】响应后须弃置一张牌。',
    },
    {
      name: '荐才',
      desc: '副将技，你计算体力上限时减少 1 个单独的阴阳鱼。当你明置此武将牌后或每轮开始时，你获知 X 张尚未登场的与你势力相同的武将牌（X 为轮数×3，已获知的仍有效）。当你与你势力相同的角色将受到会令其进入濒死的伤害时，你可以防止此伤害，然后变更你的副将；若你的势力不为全场唯一大势力，你可以优先从已获知的武将牌中选择新的副将。',
    },
  ],
};

const YANBAIHU: Hero = {
  id: 'yanbaihu',
  name: '严白虎',
  faction: 'qun',
  pack: 'buchen', // 不臣篇（buchen 开关关闭时不进选将池）
  jili: true,
  // 国战牌面 2 阴阳鱼 → 4（走副将位时寄篱再减 1）
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  deputySlotSkills: ['寄篱'],
  deputySlotHalfYang: true,
  hooks: [
    {
      timing: 'playPhase',
      skillId: '雉盗',
      locked: true,
      handler: (ctx) => {
        const me = ctx.player;
        const others = ctx.state.players.filter((p) => p.alive && p.seatId !== me.seatId);
        if (others.length === 0) return;
        const lock = (target: Player): void => {
          me.flags.distanceToOneThisTurn = target.seatId;
          me.flags.cardTargetOnlySeat = target.seatId;
          me.flags.zhidaoHitDone = false;
          pushLog(
            ctx.state,
            'skill',
            `${me.name} 的【雉盗】：本回合锁定 ${target.name}（距离视为 1、只能指定他与你）。`,
          );
        };
        if (others.length === 1) {
          lock(others[0]!);
          return;
        }
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          '【雉盗】：选择本回合锁定的一名其他角色',
          others.map((p) => ({ id: p.seatId, label: p.name })),
          (_st, _p, id) => {
            const t = getPlayer(ctx.state, id);
            if (t) lock(t);
          },
        );
      },
    },
    {
      // 雉盗后半句：出牌阶段内第一次对他造成伤害后，获得他区域里的一张牌
      timing: 'afterDamageDealt',
      skillId: '雉盗',
      locked: true,
      handler: (ctx) => {
        const me = ctx.player;
        const locked = me.flags.cardTargetOnlySeat;
        if (!locked || me.flags.zhidaoHitDone) return;
        if (ctx.state.turn.phase !== 'play') return;
        const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
        if (!payload?.damage || payload.attack?.targetId !== locked) return;
        const victim = getPlayer(ctx.state, locked);
        if (!victim) return;
        me.flags.zhidaoHitDone = true;
        takeOneOfTargetCards(ctx.state, me, victim, ctx.api, '雉盗', () => {
          pushLog(
            ctx.state,
            'skill',
            `${me.name} 的【雉盗】：对其造成伤害后，获得了 ${victim.name} 的一张牌。`,
          );
        });
      },
    },
    {
      // 寄篱①：成为**红色即时锦囊**的唯一目标 → 记下「此牌结算结束后，其使用者要再用一张
      // 虚拟同名锦囊指定我」（单目标锦囊在 startTrickResolution 里给所有存活角色派发
      // othersBecomeTarget，所以目标本人也收得到自己的那一条；多人目标不走这条派发）
      timing: 'othersBecomeTarget',
      skillId: '寄篱',
      locked: true,
      handler: (ctx) => {
        const payload = ctx.payload as
          { targetId?: string; card?: Card; trickCtx?: TrickContext } | undefined;
        if (payload?.targetId !== ctx.player.seatId) return;
        const card = payload.card;
        const tctx = payload.trickCtx;
        if (!card || !tctx) return;
        if (cardColor(card) !== 'red') return;
        if (!isInstantTrick(card)) return; // 只认「普通锦囊」，延时锦囊不算
        if (tctx.jiliUse) return; // 同一张牌只再造一张
        tctx.jiliUse = true;
        tctx.jiliTargetId = ctx.player.seatId;
      },
    },
    {
      // 寄篱②：成为**红色【杀】**的**唯一**目标 → 同样记下「结算结束后再用一张虚拟同名【杀】」。
      // 「唯一目标」看 attack.totalTargets（playSha 填；方天画戟那种多目标不算）。
      timing: 'becomeTarget',
      skillId: '寄篱',
      locked: true,
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext } | undefined;
        const attack = payload?.attack;
        if (!attack || attack.asType !== 'sha') return;
        if (attack.targetId !== ctx.player.seatId) return;
        if (attack.cardColor !== 'red') return;
        if ((attack.totalTargets ?? 1) !== 1) return; // 只认唯一目标
        if (attack.jiliUse) return; // 同一张杀只再造一张
        if (attack.generatedBy === 'jili') return; // 寄篱造的虚拟牌不再生一张（它无色，这里是第二道保险）
        attack.jiliUse = true;
      },
    },
    {
      // 寄篱：本阶段第 2 次受到伤害 → 防止并移除这张武将牌
      timing: 'damageDealt',
      skillId: '寄篱',
      locked: true,
      handler: (ctx) => {
        const me = ctx.player;
        const payload = ctx.payload as { damage?: number } | undefined;
        if (!payload?.damage) return;
        if (me.flags.damageCount !== 1) return; // 只在「本阶段已经受过 1 次」时触发
        me.flags.damagePrevented = true;
        pushLog(
          ctx.state,
          'skill',
          `【寄篱】：${me.name} 本阶段第 2 次受到伤害，防止此伤害并移除【寄篱】。`,
        );
        ctx.api.removeHeroCard(me.seatId, 'yanbaihu');
      },
    },
  ],
  skills: [
    {
      name: '雉盗',
      desc: '锁定技，出牌阶段开始时，你选择一名其他角色，直到回合结束，你计算与其的距离视为 1 且你不能使用牌指定除你与你与其外的角色为目标，然后当你于出牌阶段内第一次对其造成伤害后，你获得其区域里的一张牌。',
    },
    {
      name: '寄篱',
      desc: '副将技，锁定技，你计算体力上限时减少 1 个单独的阴阳鱼。当你成为红色基本牌或红色普通锦囊牌的唯一目标后，在此牌结算结束后，此牌的使用者对你再使用一次相同牌名的牌。当你受到伤害时，若你于当前阶段内受到过伤害的次数为 1，你防止此伤害，然后移除该武将牌。',
      // 实现口径（docs/guozhan-roster.md §5.87）：第二张牌是**无对应实体牌的虚拟同名牌**
      // （subcards=[]、不继承花色点数、无色、generatedBy='jili'），并且是**一次全新的使用**
      // （新卡牌使用事件：重新指定目标、重开响应窗口、严白虎仍可正常出【闪】/锦囊会开新的
      // 无懈链）。见 engine 的 virtualSameNameCard / useVirtualSameNameCard。
    },
  ],
};

/**
 * 严白虎·雉盗的目标限制：本回合「不能使用牌指定除你与你与其外的角色」。
 *
 * 显式目标直接查 `intent.targetIds`；像【南蛮入侵】【万箭齐发】【桃园结义】那种
 * **不用指定目标、却会打到别人**的牌，只有在「除你与他之外没有别的存活角色」时才放行——
 * 否则它们实际指定的就是别人。
 */
export function zhidaoTargetsBlocked(
  state: GameState,
  player: Player,
  card: Card,
  targetIds: string[],
): boolean {
  const locked = player.flags.cardTargetOnlySeat;
  if (!locked) return false;
  const allowed = new Set([player.seatId, locked]);
  if (targetIds.some((id) => !allowed.has(id))) return true;
  const aoeLike: ReadonlySet<string> = ZHIDAO_AOE_TRICKS;
  if (!aoeLike.has(card.type)) return false;
  return state.players.some((p) => p.alive && !allowed.has(p.seatId));
}

/** 「不用指定目标却会打到别人」的锦囊（雉盗用；将来加新的群体牌要往这里补） */
const ZHIDAO_AOE_TRICKS: ReadonlySet<string> = new Set([
  'nanman',
  'wanjian',
  'taoyuan',
  'wugu',
  'lianjun',
  'lutong',
  'yiyi',
  'chiling',
]);

const WUJING: Hero = {
  id: 'wujing',
  name: '吴景',
  faction: 'wu',
  pack: 'buchen', // 不臣篇（buchen 开关关闭时不进选将池）
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  lockedFields: ['fengyang'],
  skillFields: { 风扬: ['fengyang'] },
  // 风扬（阵法技，队列型）：阵法召唤按「亮将后与召唤者同队列」判
  formation: ['queue'],
  fengyang: true,
  activeSkills: [
    FORMATION_SUMMON,
    {
      id: 'diaogui',
      name: '调归',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 2,
      needsCards: true,
      maxCards: () => 1,
      // 「一张装备牌」不限手牌——装备区里的也算（用户口径：不要硬编码只能从手牌选）
      canUse: (state, player) => handAndEquipOf(player).some((c) => isEquipCard(c)),
      execute: (state, player, intent, api) => {
        const cardId = intent.cardIds?.[0];
        const material = cardId
          ? handAndEquipOf(player).find((c) => c.id === cardId)
          : undefined;
        if (!material || !isEquipCard(material)) return '调归要用一张装备牌当【调虎离山】';
        const targets = intent.targetIds.filter((id) => id !== player.seatId);
        if (targets.length === 0) return '【调虎离山】要指定一名其他角色';
        // 先付代价：材料牌进弃牌堆（装备区里的那张先摘下来）
        const eqSlot = EQUIP_SLOTS.find((sl) => player.equipment[sl]?.id === material.id);
        if (eqSlot) player.equipment[eqSlot] = null;
        else removeCard(player.hand, material.id);
        toDiscard(state, material);
        pushLog(
          state,
          'skill',
          `${player.name} 发动【调归】，将【${cardLabel(material)}】当【调虎离山】使用。`,
        );
        // 记下「用之前」的队列大小，结算完再比（afterUse 里读）
        player.flags.queueSizeBeforeTrick = formationQueue(state, player).length;
        api.castVirtualTrick(
          player.seatId,
          {
            type: 'tiaohu',
            suit: material.suit,
            rank: material.rank,
            // 带上实体子牌：虚拟牌自己找不到，靠这份清单让「获得此牌」那类效果有据可依
            materials: [material],
          },
          targets,
        );
        return undefined;
      },
    },
  ],
  hooks: [
    {
      // 调归的收尾：结算完成后（含被无懈抵消的情况）看队列有没有**因此**形成/变长
      timing: 'afterUse',
      skillId: '调归',
      handler: (ctx) => {
        const me = ctx.player;
        const before = me.flags.queueSizeBeforeTrick;
        if (before === null) return; // 不是本回合那次调归（或已经结算过）
        me.flags.queueSizeBeforeTrick = null;
        const q = formationQueue(ctx.state, me);
        if (q.length < 2 || q.length <= before) return;
        for (let i = 0; i < q.length; i++) {
          const c = drawOne(ctx.state);
          if (c) me.hand.push(c);
        }
        pushLog(
          ctx.state,
          'skill',
          `${me.name} 的【调归】因此形成队列（${q.length} 名），摸了 ${q.length} 张牌。`,
        );
      },
    },
  ],
  skills: [
    {
      name: '调归',
      desc: '出牌阶段限一次，你可以将一张装备牌当【调虎离山】使用，若你的势力因此形成队列，你摸X张牌（X为该队列人数）。',
    },
    {
      name: '风扬',
      desc: '阵法技，与你势力不同或未确定势力的角色不能弃置或获得与你处于同一队列的角色装备区里的牌。',
    },
  ],
};

/**
 * 风扬（吴景·阵法技）：这次「拿走/弃置 **[owner]** 的 **[card]**」的动作是不是被风扬挡住？
 *
 * 条件：那张牌在 owner 的**装备区**里；场上有明置的吴景；owner 与那名吴景**同一队列**；
 * 动手的人（actor）与那名吴景**势力不同或未确定势力**。吴景自己动手不受自己限制。
 * 引擎在几个收口处读它（见吴景武将注释里的清单）。
 */
export function fengyangBlocksEquip(
  state: GameState,
  actorSeatId: string,
  owner: Player,
  card: Card,
): boolean {
  if (!EQUIP_SLOTS.some((s) => owner.equipment[s]?.id === card.id)) return false;
  // 阵法技的**全局前提**（用户口径）：存活角色至少 4 名——残局只剩 3 人时风扬不再生效。
  // （与围攻关系同一条前提，见 `besiegers` 那套。）
  if (state.players.filter((p) => p.alive).length < 4) return false;
  const actor = getPlayer(state, actorSeatId);
  if (!actor) return false;
  const actorFaction = effectiveFaction(state, actor);
  for (const p of state.players) {
    if (!p.alive || p.seatId === actorSeatId) continue;
    if (!effectiveHeroes(state, p).some((h) => h.fengyang === true)) continue;
    const mine = effectiveFaction(state, p);
    if (!mine) continue; // 暗置的吴景没有风扬（effectiveHeroes 已经滤掉，这里是双保险）
    if (actorFaction === mine) continue; // 同势力不受限
    // 吴景自己**处于队列中**（连续相邻的同势力至少 2 名）才谈得上「与你处于同一队列」——
    // 单名的 `formationQueue` 只返回他自己，那时不保护任何人（用户口径：阵法技不是常驻锁定技）。
    const queue = formationQueue(state, p);
    if (queue.length < 2) continue;
    if (queue.some((q) => q.seatId === owner.seatId)) return true;
  }
  return false;
}

const WUGUOTAI: Hero = {
  id: 'wuguotai',
  name: '吴国太',
  faction: 'wu',
  pack: 'quan', // quan 包：该包开关关闭时不进选将池
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'female',
  modes: ['guozhan'],
  hooks: [
    {
      timing: 'nearDeathResolved',
      skillId: '补益',
      handler: (ctx) => {
        const payload = ctx.payload as
          { dyingSeatId?: string; alive?: boolean; sourceId?: string } | undefined;
        const me = ctx.player;
        if (!payload?.alive || !payload.dyingSeatId || !payload.sourceId) return;
        if (me.flags.skillUsedThisTurn['补益']) return; // 每回合限一次
        const dying = getPlayer(ctx.state, payload.dyingSeatId);
        const source = getPlayer(ctx.state, payload.sourceId);
        if (!dying || !source || !source.alive) return;
        const mine = effectiveFaction(ctx.state, me);
        if (!mine || effectiveFaction(ctx.state, dying) !== mine) return; // 只对同势力
        if (dying.seatId === me.seatId) return; // 「与你势力相同的角色」是**别人**
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          `是否发动【补益】？（令 ${source.name} 执行一次「军令」，不执行则 ${dying.name} 回复 1 点体力）`,
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            p.flags.skillUsedThisTurn['补益'] = true;
            ctx.api.armyOrder(p.seatId, source.seatId, (st2, executed) => {
              if (executed) return;
              const d = getPlayer(st2, dying.seatId);
              if (!d || !d.alive) return;
              const healed = ctx.api.heal(d, 1);
              pushLog(
                st2,
                'skill',
                `${source.name} 没有执行军令，${d.name} 因【补益】回复 ${healed} 点体力。`,
              );
            });
          },
        );
      },
    },
  ],
  activeSkills: [
    {
      id: 'ganlu',
      name: '甘露',
      oncePerTurn: true,
      minTargets: 2,
      maxTargets: 2,
      needsCards: false,
      canUse: (state, player) => ganluPairs(state, player).length > 0,
      execute: (state, player, intent, api) => {
        const pair = ganluPairs(state, player).find(
          (p) => p.has(intent.targetIds[0]!) && p.has(intent.targetIds[1]!),
        );
        if (!pair) return '要选两名装备区里牌数之差不大于你已损失体力值的角色';
        const [a, b] = [intent.targetIds[0]!, intent.targetIds[1]!];
        pushLog(state, 'skill', `${player.name} 发动【甘露】。`);
        api.swapEquipAreas(a, b, () => {
          pushLog(state, 'skill', `${player.name} 交换了装备区里的牌（甘露）。`);
        });
        return undefined;
      },
    },
  ],
  skills: [
    {
      name: '甘露',
      desc: '出牌阶段限一次，你可以交换两名角色装备区里的牌（两者装备区里牌数之差不大于你已损失体力值，且牌数之和不小于 1）。',
    },
    {
      name: '补益',
      desc: '每回合限一次，当与你势力相同的角色脱离濒死状态后，你可以令本次伤害来源执行一次「军令」，若其不执行，此濒死角色回复 1 点体力。',
    },
  ],
};

/**
 * 甘露此刻能交换的「角色对」：两两组合里满足
 * ① 装备区牌数之差 ≤ 吴国太已损失体力值；② 两边牌数之和 ≥ 1（不能是两张空装备区）。
 * 返回的是「座位对」的集合（用来判玩家的目标选择是否合法）。
 */
function ganluPairs(state: GameState, player: Player): Set<string>[] {
  const lost = player.maxHp - player.hp;
  const alive = state.players.filter((p) => p.alive);
  const count = (p: Player): number => EQUIP_SLOTS.filter((s) => !!p.equipment[s]).length;
  const out: Set<string>[] = [];
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i]!;
      const b = alive[j]!;
      const na = count(a);
      const nb = count(b);
      if (na + nb < 1) continue;
      if (Math.abs(na - nb) > lost) continue;
      out.push(new Set([a.seatId, b.seatId]));
    }
  }
  return out;
}

const ZHANGXIU: Hero = {
  id: 'zhangxiu',
  name: '张绣',
  faction: 'qun',
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  lockedFields: ['damageDelta'],
  // 引擎记日志时要反查「是哪个技能改的伤害」（skillNameForField），所以登记一下
  skillFields: { 从谏: ['damageDelta'] },
  damageDelta: (state, self, ctx) => {
    const turnSeatId = state.seatOrder[state.turn.seatIndex];
    const inOwnTurn = turnSeatId === self.seatId;
    let d = 0;
    if (ctx.sourceId === self.seatId && !inOwnTurn) d += 1; // ① 回合外造成的伤害 +1
    if (ctx.targetId === self.seatId && inOwnTurn) d += 1; // ② 回合内受到的伤害 +1
    return d;
  },
  hooks: [
    {
      timing: 'afterDamage',
      skillId: '附敌',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
        const sourceId = payload?.attack?.sourceId;
        if (!payload?.damage || !sourceId || sourceId === ctx.player.seatId) return;
        const me = ctx.player;
        const source = getPlayer(ctx.state, sourceId);
        if (!source || me.hand.length === 0) return;
        if (fudiTargets(ctx.state, me, source).length === 0) return; // 没有合法目标就不该发动
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          `是否发动【附敌】？（交给 ${source.name} 一张手牌，然后对其势力中体力最多的角色造成 1 点伤害）`,
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.askPickCards(
              st,
              p.seatId,
              `【附敌】：选择交给 ${source.name} 的一张手牌`,
              p.hand.slice(),
              1,
              1,
              (st2, p2, chosen) => {
                const card = chosen[0];
                if (!card) return;
                ctx.api.transferCard(p2.seatId, card, source.seatId, () => {
                  pushLog(st2, 'skill', `${p2.name} 发动【附敌】，交给 ${source.name} 一张手牌。`);
                  // 牌交出去之后**重算**候选（手牌变化可能影响不到体力，但保持与当下状态一致）
                  const list = fudiTargets(st2, p2, source);
                  if (list.length === 0) return;
                  const hit = (victim: Player): void => {
                    pushLog(st2, 'skill', `${p2.name} 对 ${victim.name} 造成 1 点伤害（附敌）。`);
                    ctx.api.dealDamage(victim, 1, p2.seatId);
                  };
                  if (list.length === 1) {
                    hit(list[0]!);
                    return;
                  }
                  ctx.api.askChoice(
                    st2,
                    p2.seatId,
                    '【附敌】：对其中哪一名角色造成 1 点伤害？',
                    list.map((t) => ({ id: t.seatId, label: t.name })),
                    (st3, _p3, victimId) => {
                      const victim = getPlayer(st3, victimId);
                      if (victim) hit(victim);
                    },
                  );
                });
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '附敌',
      desc: '当你受到伤害后，你可以交给伤害来源一张手牌。若如此做，你对与其势力相同的角色中体力值最多且不小于你的一名角色造成1点伤害。',
    },
    {
      name: '从谏',
      desc: '锁定技，当你于回合外造成伤害时，或当你于回合内受到伤害时，此伤害+1。',
    },
  ],
};

/**
 * 附敌能打的人：与**伤害来源**势力相同的存活角色里，体力值 ≥ 张绣自己、且取体力最多的那一档。
 * 来源自己也算（官方写的是「与其势力相同的角色」）。
 */
function fudiTargets(state: GameState, me: Player, source: Player): Player[] {
  const f = effectiveFaction(state, source);
  if (!f) return []; // 来源没有确定势力（暗将）→ 无从谈起
  const candidates = state.players.filter(
    (p) => p.alive && effectiveFaction(state, p) === f && p.hp >= me.hp,
  );
  if (candidates.length === 0) return [];
  const maxHp = Math.max(...candidates.map((p) => p.hp));
  return candidates.filter((p) => p.hp === maxHp);
}

const LUKANG: Hero = {
  id: 'lukang',
  name: '陆抗',
  faction: 'wu',
  pack: 'quan', // quan 包：该包开关关闭时不进选将池
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      timing: 'damageDealt',
      skillId: '恪守',
      handler: (ctx) => {
        const me = ctx.player;
        // 第一句：弃两张同色牌 → 此伤害 -1
        const pool = handAndEquipOf(me);
        const sameColor = pool.filter(
          (c) => pool.filter((x) => cardColor(x) === cardColor(c)).length >= 2,
        );
        if (sameColor.length >= 2 && me.flags.damageReduce === 0) {
          ctx.api.askChoice(
            ctx.state,
            me.seatId,
            '是否发动【恪守】？（弃置两张颜色相同的牌，令此伤害-1）',
            [
              { id: 'yes', label: '发动（弃两张同色牌）' },
              { id: 'no', label: '不发动' },
            ],
            (st, p, picked) => {
              if (picked !== 'yes') {
                lukangJudgePart(ctx);
                return;
              }
              ctx.api.askPickCards(
                st,
                p.seatId,
                '【恪守】：弃置两张颜色相同的牌',
                sameColor,
                2,
                2,
                (st2, p2, chosen) => {
                  const [c1, c2] = chosen;
                  if (!c1 || !c2 || cardColor(c1) !== cardColor(c2)) {
                    // 选了两张不同色的（界面理论上不会给这种组合）——按不发动处理
                    lukangJudgePart(ctx);
                    return;
                  }
                  p2.flags.damageReduce += 1;
                  // 两张牌依次弃（走 api.discardCard：丢掉装备牌会触发枭姬那类技能）
                  const doDiscard = (i: number): void => {
                    const next = chosen[i];
                    if (!next) {
                      pushLog(
                        st2,
                        'skill',
                        `${p2.name} 发动【恪守】，弃置两张${cardColor(c1) === 'red' ? '红' : '黑'}色牌，此伤害-1。`,
                      );
                      lukangJudgePart(ctx);
                      return;
                    }
                    ctx.api.discardCard(p2.seatId, next, () => doDiscard(i + 1));
                  };
                  doDiscard(0);
                },
              );
            },
          );
          return;
        }
        lukangJudgePart(ctx);
      },
    },
    {
      timing: 'beforeJudge',
      skillId: '筑围',
      handler: (ctx) => {
        const payload = ctx.payload as { judgeCard?: Card; judgedId?: string } | undefined;
        const judge = payload?.judgeCard;
        // 只认**自己**的判定（与天妒同一口径）
        if (!judge || payload?.judgedId !== ctx.player.seatId) return;
        if (!isDamageCardForZhujwei(judge)) return;
        // 后半句：给当前回合角色「本回合手牌上限+1、使用【杀】的限制次数+1」
        const turnSeatId = ctx.state.seatOrder[ctx.state.turn.seatIndex];
        const turnPlayer = turnSeatId ? getPlayer(ctx.state, turnSeatId) : undefined;
        if (turnPlayer && turnPlayer.alive) {
          ctx.api.askChoice(
            ctx.state,
            ctx.player.seatId,
            `【筑围】：是否令 ${turnPlayer.name} 本回合手牌上限+1、使用【杀】的限制次数+1？`,
            [
              { id: 'yes', label: '发动' },
              { id: 'no', label: '不发动' },
            ],
            (st, _p, picked) => {
              if (picked !== 'yes') return;
              const t = getPlayer(st, turnPlayer.seatId);
              if (!t) return;
              t.flags.handLimitBonus += 1;
              t.flags.shaLimitBonus += 1;
              pushLog(
                st,
                'skill',
                `${t.name} 因【筑围】本回合手牌上限+1、使用【杀】的限制次数+1。`,
                { seat: t.seatId },
              );
            },
          );
        }
        return { gainJudgeCard: true };
      },
    },
  ],
  skills: [
    {
      name: '恪守',
      desc: '当你受到伤害时，你可以弃置两张颜色相同的牌，令此伤害-1；若没有与你势力相同的其他角色，你判定，若结果为红色，你摸一张牌。',
    },
    {
      name: '筑围',
      desc: '当你的判定牌生效后，若此牌为【杀】或伤害锦囊牌，你可以获得之，然后你可以令当前回合角色本回合手牌上限+1、使用【杀】的限制次数+1。',
    },
  ],
};

/** 恪守的第二句：没有同势力其他角色时判定，判红摸一张（与第一句互不依赖） */
function lukangJudgePart(ctx: HookContext): void {
  const me = ctx.player;
  if (!me.alive) return;
  const mine = effectiveFaction(ctx.state, me);
  const mates = ctx.state.players.filter(
    (p) => p.alive && p.seatId !== me.seatId && effectiveFaction(ctx.state, p) === mine,
  );
  // 注意：暗将没有势力 → mine 为 null 时要按「没有同势力角色」算吗？
  // 官方口径是「没有与你势力相同的其他角色」，暗置的自己没有确定势力，这里按**没有**处理
  // （也就是暗置时那半句不触发）——与其它势力类技能一致。
  if (!mine || mates.length > 0) return;
  // 统一技能判定：鬼才/鬼道可改判、天妒可收牌
  ctx.api.judge('恪守', (judge) => {
    if (!judge) return;
    if (cardColor(judge) === 'red') {
      const c = drawOne(ctx.state);
      if (c) me.hand.push(c);
      pushLog(ctx.state, 'skill', `【恪守】判定为红色，${me.name} 摸了 1 张牌。`);
    }
  });
}

/** 筑围认的牌：【杀】或（会）造成伤害的锦囊 */
function isDamageCardForZhujwei(card: Card): boolean {
  if (card.type === 'sha') return true;
  return (
    card.type === 'juedou' ||
    card.type === 'nanman' ||
    card.type === 'wanjian' ||
    card.type === 'huogong' ||
    card.type === 'huoshao' ||
    card.type === 'shuiyan'
  );
}

const SHAMOKE: Hero = {
  id: 'shamoke',
  name: '沙摩柯',
  faction: 'shu',
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      timing: 'cardActionStarted',
      skillId: '蒺藜',
      handler: (ctx) => cili(ctx),
    },
  ],
  skills: [
    {
      name: '蒺藜',
      desc: '当你于一回合内使用或打出第X张牌时，你可以摸X张牌（X为你的攻击范围）。',
    },
  ],
};

/** 蒺藜：本回合使用/打出的牌数正好等于（牌生效前的）攻击范围时，摸那么多张 */
function cili(ctx: HookContext): void {
  const me = ctx.player;
  const x = me.flags.actionRangeSnapshot;
  if (x <= 0) return;
  if (me.flags.cardsUsedOrPlayed !== x) return;
  ctx.api.askChoice(
    ctx.state,
    me.seatId,
    `是否发动【蒺藜】摸 ${x} 张牌？`,
    [
      { id: 'yes', label: `摸 ${x} 张牌` },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      let got = 0;
      for (let i = 0; i < x; i++) {
        const c = drawOne(st);
        if (!c) break;
        p.hand.push(c);
        got++;
      }
      pushLog(st, 'skill', `${p.name} 发动【蒺藜】，摸了 ${got} 张牌。`);
    },
  );
}

const BIANFUREN: Hero = {
  id: 'bianfuren',
  name: '卞夫人',
  faction: 'wei',
  pack: 'bian', // bian 包：该包开关关闭时不进选将池
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'female',
  modes: ['guozhan'],
  hooks: [
    {
      timing: 'othersBecomeTarget',
      skillId: '挽危',
      handler: (ctx) => {
        const payload = ctx.payload as
          { targetId?: string; card?: Card; trickCtx?: TrickContext } | undefined;
        if (payload?.targetId !== ctx.player.seatId) return;
        const type = payload?.card?.type;
        if (type !== 'guohe' && type !== 'shunshou') return;
        const me = ctx.player;
        if (me.hand.length <= 1) return; // 只有一张牌时挑不挑都一样
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          `是否发动【挽危】自己选择失去哪张牌？`,
          [
            { id: 'yes', label: '发动（自己挑）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            const cards = p.hand.slice();
            if (cards.length === 0) return;
            ctx.api.askPickCards(
              st,
              p.seatId,
              '【挽危】：选择失去哪张手牌',
              cards,
              1,
              1,
              (_st2, _p2, chosen) => {
                const card = chosen[0];
                if (!card) return;
                if (payload?.trickCtx) payload.trickCtx.targetCardId = card.id;
                pushLog(_st2, 'skill', `${_p2.name} 发动【挽危】，自己选择了失去的牌。`);
              },
            );
          },
        );
      },
    },
    {
      timing: 'othersDiscardPhase',
      skillId: '约俭',
      locked: true,
      handler: (ctx) => {
        const turnSeatId = (ctx.payload as { turnSeatId?: string } | undefined)?.turnSeatId;
        if (!turnSeatId) return;
        const who = getPlayer(ctx.state, turnSeatId);
        if (!who || !who.alive) return;
        if (!sameKnownFaction(ctx.state, ctx.player, who)) return; // 「与你势力相同」
        if (who.flags.targetedOtherFactionThisTurn) return; // 指定过其他势力 → 不生效
        const bonus = Math.max(0, who.maxHp - who.hp);
        if (bonus === 0) return; // 上限本来就等于体力上限
        who.flags.handLimitBonus += bonus;
        // ⚠️ 已知偏差（记在 §5.100）：这里把「手牌上限**视为**体力上限」落成了**一次性差值加成**，
        //    严格说应是覆盖语义（体力变化要跟随、不与兴棹+4 那类叠加）。改成覆盖会让
        //    「卞夫人·约俭」的既有用例失败（弃牌阶段的上限口径需要一起重定），留单独一轮处理。
        who.flags.handLimitSetToMaxHp = false; // 不再走覆盖路径
        pushLog(
          ctx.state,
          'skill',
          `${ctx.player.name} 的【约俭】生效：${who.name} 本回合手牌上限视为体力上限（${who.maxHp}）。`,
        );
      },
    },
  ],
  skills: [
    {
      name: '挽危',
      desc: '当你因被其他角色获得或弃置而失去牌时，你可以改为自己选择失去的牌。',
    },
    {
      name: '约俭',
      desc: '锁定技，与你势力相同的角色的弃牌阶段开始时，若其本回合未使用牌指定过其他势力的角色为目标，其本回合手牌上限等于其体力上限。',
    },
  ],
};

const ZUOCI: Hero = {
  id: 'zuoci',
  name: '左慈',
  faction: 'qun',
  pack: 'bian', // bian 包：该包开关关闭时不进选将池
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      timing: 'heroRevealed',
      skillId: '役鬼',
      handler: (ctx) => {
        const me = ctx.player;
        if (me.usedOncePerGame.zugui) return;
        me.usedOncePerGame.zugui = true;
        let got = 0;
        for (let i = 0; i < 2; i++) {
          const id = ctx.state.heroPool.shift();
          if (!id) break;
          me.hun.push(id);
          got++;
        }
        pushLog(ctx.state, 'skill', `${me.name} 发动【役鬼】：扣置 ${got} 张武将牌作为「魂」。`, {
          seat: me.seatId,
          action: 'skill',
        });
      },
    },
    {
      timing: 'afterDamage',
      skillId: '汲魂',
      handler: (ctx) => {
        const me = ctx.player;
        if (me.usedOncePerGame.jihunDamage) return; // 「受伤害后」每回合一次（flag 随回合清）
        me.usedOncePerGame.jihunDamage = true;
        const id = ctx.state.heroPool.shift();
        if (!id) return;
        me.hun.push(id);
        pushLog(ctx.state, 'skill', `${me.name} 发动【汲魂】，扣置一张武将牌作为「魂」。`, {
          seat: me.seatId,
          action: 'gain',
        });
      },
    },
    {
      timing: 'nearDeathResolved',
      skillId: '汲魂',
      handler: (ctx) => {
        const payload = ctx.payload as { dyingSeatId?: string; alive?: boolean } | undefined;
        const dying = payload?.dyingSeatId ? getPlayer(ctx.state, payload.dyingSeatId) : undefined;
        if (!dying || !payload?.alive) return; // 「存活」才给
        if (dying.seatId === ctx.player.seatId) return;
        if (sameKnownFaction(ctx.state, ctx.player, dying)) return; // 「与你势力不同」
        const id = ctx.state.heroPool.shift();
        if (!id) return;
        ctx.player.hun.push(id);
        pushLog(ctx.state, 'skill', `${ctx.player.name} 因【汲魂】扣置一张武将牌作为「魂」。`, {
          seat: ctx.player.seatId,
          action: 'gain',
        });
      },
    },
  ],
  activeSkills: [
    {
      id: 'yigui_use',
      name: '役鬼',
      minTargets: 0,
      maxTargets: 0,
      needsCards: false,
      canUse: (state, player) => player.hun.length > 0 && hunOptions(state, player).length > 0,
      execute: (state, player, _intent, api) => {
        const options = hunOptions(state, player);
        if (options.length === 0) return '当前没有可以这样使用的牌';
        api.askChoice(
          state,
          player.seatId,
          '【役鬼】：移去一张「魂」，视为使用哪张牌？',
          options,
          (st, p, picked) => {
            // 移去一张「魂」（暗置 → 随机），并把那张武将牌亮出来（牌面与势力公开）
            const idx = Math.floor(state.rng() * p.hun.length);
            const heroId = p.hun.splice(idx, 1)[0]!;
            const hero = getHeroForMode(heroId, st.mode);
            p.flags.hunUsedNames.push(picked);
            pushLog(
              st,
              'skill',
              `${p.name} 发动【役鬼】，移去一张「魂」（${hero?.name ?? heroId}，势力 ${hero?.faction ?? '未确定'}）。`,
              { seat: p.seatId, action: 'skill' },
            );
            // ⚠️ §5.121：双势力「魂」= 两个牌面势力**都算**（集合，不是单值）
            const factions = hero ? printedFactionsOf(hero.id) : null;
            if (picked === 'sha' || picked === 'jiu' || picked === 'tao') {
              if (picked === 'jiu') {
                p.flags.jiuActive = true;
                pushLog(st, 'skill', `${p.name} 视为使用了一张【酒】。`);
                return;
              }
              if (picked === 'tao') {
                const healed = api.heal(p, 1);
                pushLog(st, 'skill', `${p.name} 视为使用了一张【桃】，回复 ${healed} 点体力。`);
                return;
              }
              // 【杀】：选一个符合势力限制的目标
              const targets = hunTargets(st, p, factions, true);
              if (targets.length === 0) {
                pushLog(st, 'skill', '没有符合势力限制的目标，【役鬼】未生效。');
                return;
              }
              api.askChoice(
                st,
                p.seatId,
                '【役鬼】：【杀】的目标',
                targets.map((t) => ({ id: t.seatId, label: t.name })),
                (st2, p2, tid) => api.castVirtualSha(p2.seatId, tid, { logKind: 'skill' }),
                p.seatId,
              );
              return;
            }
            // 锦囊
            const spec = QICE_TRICKS.find((t) => t.type === picked);
            if (!spec) return;
            const need = spec.min;
            const cands = hunTargets(st, p, factions, false, spec.type);
            const step = (chosen: string[]): void => {
              if (chosen.length >= Math.max(1, need) && need > 0) {
                fireHun(st, p, spec.type, chosen, api);
                return;
              }
              if (need === 0) {
                fireHun(st, p, spec.type, [], api);
                return;
              }
              const rest = cands.filter((c) => !chosen.includes(c.seatId));
              if (rest.length === 0) {
                pushLog(st, 'skill', '没有符合势力限制的目标，【役鬼】未生效。');
                return;
              }
              api.askChoice(
                st,
                p.seatId,
                `【役鬼】：为【${CARD_TYPE_NAME[spec.type]}】选择目标`,
                rest.map((c) => ({ id: c.seatId, label: c.name })),
                (st2, p2, tid) => step2Hun(st2, p2, tid, chosen, spec.type, factions, api),
                p.seatId,
              );
            };
            step([]);
          },
        );
        return undefined;
      },
    },
  ],
  skills: [
    {
      name: '役鬼',
      desc: '当你首次明置武将牌后，你将剩余武将牌堆中的两张武将牌扣置于武将牌上，称为「魂」牌；你可以移去一张「魂」牌，视为使用一张你于当前回合内未以此法使用过的基本牌或普通锦囊牌，且目标必须为与此「魂」牌势力相同或未确定势力的角色。',
    },
    {
      name: '汲魂',
      desc: '当你受到伤害后，你可以从剩余武将牌堆中扣置一张牌加入「魂」牌；当一名角色的濒死结算结束后，若其与你势力不同且存活，你可以从剩余武将牌堆中扣置一张牌加入「魂」牌。',
    },
  ],
};

/** 役鬼能视为使用的牌名（基本牌只列能在出牌阶段主动用的；锦囊排除无懈可击） */
function hunOptions(state: GameState, player: Player): { id: string; label: string }[] {
  const used = new Set(player.flags.hunUsedNames);
  const out: { id: string; label: string }[] = [];
  for (const [id, name] of [
    ['sha', '杀'],
    ['jiu', '酒'],
    ['tao', '桃'],
  ] as const) {
    if (used.has(id)) continue;
    out.push({ id, label: name });
  }
  for (const spec of QICE_TRICKS) {
    if (spec.type === 'wuxie') continue;
    if (used.has(spec.type)) continue;
    // 群体锦囊：如果场上有人不符合势力限制，就不能用（它会自动指定所有人）
    if (spec.min === 0 && spec.max === 0) {
      const all = state.players.filter((p) => p.alive && p.seatId !== player.seatId);
      const bad = all.some((p) => !hunFactionOk(state, p, player, null));
      if (bad) continue;
    }
    out.push({ id: spec.type, label: CARD_TYPE_NAME[spec.type] });
  }
  return out;
}

/** 势力限制：目标的势力与「魂」牌相同，或者**未确定势力** */
function hunFactionOk(
  state: GameState,
  target: Player,
  _player: Player,
  factions: Faction[] | null,
): boolean {
  const tf = effectiveFaction(state, target);
  if (!tf) return true; // 未确定势力 → 可以
  if (!factions) return true;
  return factions.includes(tf); // 双势力「魂」= 两个牌面势力都算（§5.121）
}

/** 役鬼的候选目标（势力限制 + 距离等既有合法性） */
function hunTargets(
  state: GameState,
  player: Player,
  factions: Faction[] | null,
  isSha: boolean,
  trickType?: TrickType,
): Player[] {
  const alive = state.players.filter((p) => p.alive);
  const base = isSha
    ? alive.filter(
        (p) =>
          p.seatId !== player.seatId &&
          !heroBlocksBeingTarget(state, p, cardOfType('juedou'), player) &&
          distance(state, player.seatId, p.seatId) <= attackRange(state, player),
      )
    : qiceTargets(state, player, trickType ?? 'guohe');
  return base.filter((p) => hunFactionOk(state, p, player, factions));
}

/** 役鬼用锦囊：直接把虚拟锦囊打出去 */
function fireHun(
  state: GameState,
  player: Player,
  type: TrickType,
  targets: string[],
  api: SkillApi,
): void {
  pushLog(state, 'skill', `${player.name} 视为使用了一张【${CARD_TYPE_NAME[type]}】。`);
  api.castVirtualTrick(player.seatId, { type, suit: 'spade' }, targets);
}

/** 役鬼选第二个目标（只有需要 2 个目标的锦囊会走到） */
function step2Hun(
  state: GameState,
  player: Player,
  targetId: string,
  chosen: string[],
  type: TrickType,
  factions: Faction[] | null,
  api: SkillApi,
): void {
  const spec = QICE_TRICKS.find((t) => t.type === type);
  if (!spec) return;
  const next = [...chosen, targetId];
  if (next.length < spec.min) {
    const rest = hunTargets(state, player, factions, false, type).filter(
      (c) => !next.includes(c.seatId),
    );
    if (rest.length > 0) {
      api.askChoice(
        state,
        player.seatId,
        `【役鬼】：为【${CARD_TYPE_NAME[type]}】选择目标`,
        rest.map((c) => ({ id: c.seatId, label: c.name })),
        (st2, p2, tid) => step2Hun(st2, p2, tid, next, type, factions, api),
        player.seatId,
      );
      return;
    }
  }
  fireHun(state, player, type, next, api);
}

const LVFAN: Hero = {
  id: 'lvfan',
  name: '吕范',
  faction: 'wu',
  pack: 'bian', // bian 包：该包开关关闭时不进选将池
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      timing: 'othersPlayPhaseEnd',
      skillId: '典财',
      handler: (ctx) => {
        const me = ctx.player;
        // 「其他角色的」出牌阶段结束时——派发时已经排除了回合玩家，这里再确认一次
        const turnSeatId = (ctx.payload as { turnSeatId?: string } | undefined)?.turnSeatId;
        if (!turnSeatId || turnSeatId === me.seatId) return;
        const lost = me.flags.lostCardsThisPhase;
        if (lost < me.hp) return; // 失去 X 张或更多（X＝你的体力值）
        const limit = ctx.api.handLimit(me.seatId);
        if (me.hand.length >= limit) return; // 补不上就不用问
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          `是否发动【典财】将手牌摸至体力上限（${limit} 张）？`,
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            const need = ctx.api.handLimit(p.seatId) - p.hand.length;
            let got = 0;
            for (let i = 0; i < Math.max(0, need); i++) {
              const c = drawOne(st);
              if (!c) break;
              p.hand.push(c);
              got++;
            }
            pushLog(st, 'skill', `${p.name} 发动【典财】，摸了 ${got} 张牌。`);
            if (!p.deputyHeroId) return;
            ctx.api.askChoice(
              st,
              p.seatId,
              '【典财】：是否变更一次副将？',
              [
                { id: 'yes', label: '变更副将' },
                { id: 'no', label: '不变更' },
              ],
              (st2, p2, choice) => {
                if (choice === 'yes') ctx.api.changeDeputyHero(p2.seatId);
              },
            );
          },
        );
      },
    },
  ],
  activeSkills: [
    {
      id: 'diaodu',
      name: '调度',
      oncePerTurn: true,
      minTargets: 0,
      maxTargets: 0,
      needsCards: false,
      canUse: (state, player) => diaoduQueue(state, player).length > 0,
      execute: (state, player, _intent, api) => {
        const queue = diaoduQueue(state, player);
        if (queue.length === 0) return '没有与你势力相同的角色';
        pushLog(state, 'skill', `${player.name} 发动【调度】。`);
        diaoduStep(state, player, queue, 0, api);
        return undefined;
      },
    },
  ],
  skills: [
    {
      name: '调度',
      desc: '出牌阶段限一次，所有与你势力相同的角色可以依次选择一项：1.使用一张装备牌；2.将装备区里的一张牌移动至另一名与你势力相同的角色的装备区里。',
    },
    {
      name: '典财',
      desc: '其他角色的出牌阶段结束时，若你于此阶段失去了X张或更多的牌，则你可以将手牌摸至体力上限。若如此做，你可以变更副将（X为你当前体力值）。',
    },
  ],
};

/** 调度要依次问的人：所有与你势力相同的角色（含自己） */
function diaoduQueue(state: GameState, player: Player): string[] {
  const mine = effectiveFaction(state, player);
  if (!mine) return [];
  return state.seatOrder.filter((id) => {
    const p = getPlayer(state, id);
    return !!p && p.alive && effectiveFaction(state, p) === mine;
  });
}

/** 调度：按座次一个一个问「使用一张装备牌 / 把装备移给队友 / 不选」 */
function diaoduStep(
  state: GameState,
  lvfan: Player,
  queue: string[],
  i: number,
  api: SkillApi,
): void {
  const p = i < queue.length ? getPlayer(state, queue[i]!) : undefined;
  if (!p || !p.alive) {
    if (i < queue.length) {
      diaoduStep(state, lvfan, queue, i + 1, api);
      return;
    }
    // 链条走完了。⚠️ 必须显式还控制权：某一步「移动装备」会**嵌套**触发别人的询问
    // （枭姬那类），那次嵌套询问结束之后没人负责还控制权——pending 会停在 null、整局卡死
    // （模糊测试抓到的）。有询问在挂起时这个调用不生效，不会抢流程。
    api.returnPlayPhase(lvfan.seatId);
    return;
  }
  const mine = effectiveFaction(state, p);
  const mates = state.seatOrder
    .map((id) => getPlayer(state, id))
    .filter(
      (x): x is Player =>
        !!x && x.alive && x.seatId !== p.seatId && effectiveFaction(state, x) === mine,
    );
  const options: { id: string; label: string }[] = [];
  for (const c of p.hand.filter((c) => isEquipCard(c))) {
    options.push({ id: `use:${c.id}`, label: `使用【${cardLabel(c)}】` });
  }
  if (mates.length > 0) {
    for (const slot of EQUIP_SLOTS) {
      const c = p.equipment[slot];
      if (c) options.push({ id: `move:${c.id}`, label: `把【${cardLabel(c)}】移给队友` });
    }
  }
  options.push({ id: 'no', label: '不选择' });
  // 链条往前一格。⚠️ 走到尽头时**显式还控制权**：某一步「移动装备」会嵌套触发别人的询问
  // （枭姬那类），那次嵌套询问结束之后没人负责还控制权——pending 会停在 null、整局卡死
  // （模糊测试抓到的）。有询问在挂起时 returnPlayPhase 不生效，不会抢流程。
  const next = (): void => {
    if (i + 1 >= queue.length) {
      api.returnPlayPhase(lvfan.seatId);
      return;
    }
    diaoduStep(state, lvfan, queue, i + 1, api);
  };
  if (options.length === 1) {
    next();
    return;
  }
  api.askChoice(
    state,
    p.seatId,
    `【调度】：${p.name} 选择一项（也可以不选）`,
    options,
    (st, p2, picked) => {
      if (picked === 'no') {
        next();
        return;
      }
      const [kind, cardId] = picked.split(':');
      const card = kind === 'use' ? p2.hand.find((c) => c.id === cardId) : undefined;
      if (kind === 'use' && card) {
        removeCard(p2.hand, card.id);
        api.giveEquipTo(card, p2.seatId, next);
        return;
      }
      let equipCard: Card | undefined;
      for (const slot of EQUIP_SLOTS) {
        if (p2.equipment[slot]?.id === cardId) equipCard = p2.equipment[slot] ?? undefined;
      }
      if (kind === 'move' && equipCard && mates.length > 0) {
        if (mates.length === 1) {
          api.moveFieldCard(equipCard, mates[0]!.seatId, next);
          return;
        }
        api.askChoice(
          st,
          p2.seatId,
          `【调度】：把【${cardLabel(equipCard)}】移给谁？`,
          mates.map((m) => ({ id: m.seatId, label: m.name })),
          (_st2, _p3, toId) => api.moveFieldCard(equipCard!, toId, next),
          p2.seatId,
        );
        return;
      }
      next();
    },
    lvfan.seatId,
  );
}

const SUNCE: Hero = {
  id: 'sunce',
  name: '孙策',
  faction: 'wu',
  pack: 'shi', // shi 包：该包开关关闭时不进选将池
  // 国战牌面 2 阴阳鱼 → 4（副将位走魂殇时再减 1）
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  // 珠联璧合（国战孙策）：周瑜、大乔、太史慈
  combos: ['zhouyu', 'daqiao', 'taishici'],
  deputySlotSkills: ['魂殇'],
  deputySlotHalfYang: true,
  hooks: [
    {
      // 魂殇：准备阶段，若你的体力值不大于 1，你本回合拥有「英姿」和「英魂」。
      // 两者都是**临时**授予（回合结束自动清掉）。「英魂」的触发点也是准备阶段，
      // 与魂殇同一个时机——按同时触发处理：授完就在这同一阶段直接结算一次。
      timing: 'turnStart',
      skillId: '魂殇',
      handler: (ctx) => {
        const me = ctx.player;
        if (me.hp > 1) return;
        ctx.api.grantTempSkill('zhouyu', '英姿', me.seatId);
        ctx.api.grantTempSkill('sunjian', '英魂', me.seatId);
        pushLog(ctx.state, 'skill', `${me.name} 的【魂殇】生效：本回合拥有【英姿】和【英魂】。`);
        // 立刻结算一次英魂（用孙坚那张武将牌上的钩子）
        const hun = getHero('sunjian')?.hooks?.find((h) => h.skillId === '英魂');
        if (hun) hun.handler(ctx);
      },
    },
    {
      // 自己**使用**【决斗】或红色【杀】指定目标后
      timing: 'useCard',
      skillId: '激昂',
      handler: (ctx) => {
        const payload = ctx.payload as { card?: Card; attack?: AttackContext } | undefined;
        const attack = payload?.attack;
        const card = payload?.card;
        const isDuel = card?.type === 'juedou' || attack?.asType === 'juedou';
        const isRedSha = attack?.asType === 'sha' && attack.cardColor === 'red';
        if (!isDuel && !isRedSha) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【激昂】摸一张牌？',
          [
            { id: 'yes', label: '摸一张牌' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            const c = drawOne(st);
            if (c) p.hand.push(c);
            pushLog(st, 'skill', `${p.name} 发动【激昂】，摸了 1 张牌。`);
          },
        );
      },
    },
    {
      // 自己**成为**【杀】的目标后（红色杀才算）
      timing: 'becomeTarget',
      skillId: '激昂',
      handler: (ctx) => {
        const attack = (ctx.payload as { attack?: AttackContext } | undefined)?.attack;
        if (!attack || attack.asType !== 'sha' || attack.cardColor !== 'red') return;
        jiyangDraw(ctx);
      },
    },
    {
      // 自己成为【决斗】的目标后（单人目标的锦囊走这条派发）
      timing: 'othersBecomeTarget',
      skillId: '激昂',
      handler: (ctx) => {
        const payload = ctx.payload as { targetId?: string; card?: Card } | undefined;
        if (payload?.targetId !== ctx.player.seatId) return;
        if (payload?.card?.type !== 'juedou') return;
        jiyangDraw(ctx);
      },
    },
    {
      // 鹰扬：拼点的牌亮出后、比大小前，可以令**自己那张**点数 ±3（至少为 A、至多 K）。
      // 改点数走 api.setPindianRank（引擎那条拼点链读它，见 engine.askPindianRevealed）。
      timing: 'pindianRevealed',
      skillId: '鹰扬',
      handler: (ctx) => {
        const payload = ctx.payload as { card?: Card } | undefined;
        const card = payload?.card;
        if (!card) return;
        const me = ctx.player;
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          `【鹰扬】：是否令你拼点的【${cardLabel(card)}】（${card.rank} 点）+3 或 -3？`,
          [
            { id: 'plus', label: `点数 +3（${Math.min(13, card.rank + 3)} 点）` },
            { id: 'minus', label: `点数 -3（${Math.max(1, card.rank - 3)} 点）` },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked === 'no') return;
            const after =
              picked === 'plus' ? Math.min(13, card.rank + 3) : Math.max(1, card.rank - 3);
            ctx.api.setPindianRank(after);
            pushLog(st, 'skill', `${p.name} 发动【鹰扬】，其拼点牌点数 ${card.rank} → ${after}。`, {
              seat: p.seatId,
            });
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '激昂',
      desc: '当你使用【决斗】或红色【杀】指定目标后，或成为【决斗】或红色【杀】的目标后，你可以摸一张牌。',
    },
    {
      name: '鹰扬',
      desc: '当你拼点的牌亮出后，你可以令此牌的点数+3或-3（至少为A，至多为K）。',
    },
    {
      name: '魂殇',
      desc: '副将技，此武将牌减少半个阴阳鱼；准备阶段，若你的体力值不大于1，你本回合拥有「英姿」和「英魂」。',
    },
  ],
};

/** 激昂：摸一张（「成为目标后」的两个入口共用） */
function jiyangDraw(ctx: HookContext): void {
  ctx.api.askChoice(
    ctx.state,
    ctx.player.seatId,
    '是否发动【激昂】摸一张牌？',
    [
      { id: 'yes', label: '摸一张牌' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      const c = drawOne(st);
      if (c) p.hand.push(c);
      pushLog(st, 'skill', `${p.name} 发动【激昂】，摸了 1 张牌。`);
    },
  );
}

const XUNYOU: Hero = {
  id: 'xunyou',
  name: '荀攸',
  faction: 'wei',
  pack: 'bian', // bian 包：该包开关关闭时不进选将池
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  activeSkills: [
    {
      id: 'qice',
      name: '奇策',
      oncePerTurn: true,
      minTargets: 0,
      maxTargets: 0,
      needsCards: false,
      canUse: (state, player) => player.hand.length > 0 && qiceOptions(state, player).length > 0,
      execute: (state, player, _intent, api) => {
        const options = qiceOptions(state, player);
        if (options.length === 0) return '当前没有可以这样使用的锦囊';
        pushLog(state, 'skill', `${player.name} 发动【奇策】。`);
        api.askChoice(
          state,
          player.seatId,
          `【奇策】：把所有手牌（${player.hand.length} 张）当哪张普通锦囊使用？`,
          options,
          (st, p, picked) => {
            const spec = QICE_TRICKS.find((t) => t.type === picked);
            if (!spec) return;
            const maxTargets = Math.min(p.hand.length, spec.max);
            const step = (chosen: string[]): void => {
              if (chosen.length < Math.min(spec.min, maxTargets)) {
                const candidates = qiceTargets(st, p, spec.type).filter(
                  (c) => !chosen.includes(c.seatId),
                );
                if (candidates.length === 0) {
                  pushLog(st, 'skill', '没有合法目标，【奇策】未生效。');
                  return;
                }
                api.askChoice(
                  st,
                  p.seatId,
                  `【奇策】：为【${CARD_TYPE_NAME[spec.type]}】选择目标（第 ${chosen.length + 1} 个）`,
                  candidates.map((c) => ({ id: c.seatId, label: c.name })),
                  (st2, p2, tid) => step2(st2, p2, tid, chosen, spec, api),
                  p.seatId,
                );
                return;
              }
              fire(st, p, spec, chosen, api);
            };
            step([]);
          },
        );
        return undefined;
      },
    },
  ],
  hooks: [
    {
      timing: 'afterDamage',
      skillId: '智愚',
      handler: (ctx) => {
        const me = ctx.player;
        const sourceId = (ctx.payload as { attack?: AttackContext } | undefined)?.attack?.sourceId;
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          '是否发动【智愚】摸一张牌并展示手牌？',
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            const c = drawOne(st);
            if (c) p.hand.push(c);
            pushLog(st, 'skill', `${p.name} 发动【智愚】，摸了一张牌并展示手牌。`);
            if (p.hand.length === 0) return;
            const colors = new Set(p.hand.map((x) => cardColor(x)));
            if (colors.size !== 1) return; // 颜色均相同才继续
            const src = sourceId ? getPlayer(st, sourceId) : undefined;
            if (!src || !src.alive || src.seatId === p.seatId || src.hand.length === 0) return;
            const idx = Math.floor(st.rng() * src.hand.length);
            const card = src.hand[idx];
            if (!card) return;
            ctx.api.discardCard(src.seatId, card);
            pushLog(st, 'skill', `${src.name} 因【智愚】弃置了一张手牌。`);
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '奇策',
      desc: '出牌阶段限一次，你可以将所有手牌当任意一张普通锦囊牌使用，你不能以此法使用目标数超过X的牌（X为你的手牌数），然后你可以变更一次副将。',
    },
    {
      name: '智愚',
      desc: '当你受到伤害后，你可以摸一张牌，然后展示所有手牌，若颜色均相同，来源弃置一张手牌。',
    },
  ],
};

/** 奇策能当的普通锦囊：min/max 是要指定的目标数（0 表示不用指定） */
const QICE_TRICKS: { type: TrickType; min: number; max: number }[] = [
  { type: 'guohe', min: 1, max: 1 },
  { type: 'shunshou', min: 1, max: 1 },
  { type: 'juedou', min: 1, max: 1 },
  { type: 'huogong', min: 1, max: 1 },
  { type: 'jiedao', min: 2, max: 2 },
  { type: 'tiesuo', min: 1, max: 2 },
  { type: 'huoshao', min: 1, max: 2 },
  { type: 'zhibi', min: 1, max: 1 },
  { type: 'yuanjiao', min: 1, max: 1 },
  { type: 'wuzhong', min: 0, max: 0 },
  { type: 'taoyuan', min: 0, max: 0 },
  { type: 'wugu', min: 0, max: 0 },
  { type: 'nanman', min: 0, max: 0 },
  { type: 'wanjian', min: 0, max: 0 },
  { type: 'yiyi', min: 0, max: 0 },
  { type: 'xietianzi', min: 0, max: 0 },
];

/** 不指定目标的锦囊「这次使用会指定多少人」（奇策的限制看的是这个数） */
function qiceTargetCount(state: GameState, player: Player, type: TrickType): number {
  const alive = state.players.filter((p) => p.alive);
  switch (type) {
    case 'nanman':
    case 'wanjian':
      return alive.length - 1;
    case 'taoyuan':
    case 'wugu':
      return alive.length;
    case 'wuzhong':
      return 1;
    case 'yiyi':
      return alive.filter((p) => sameKnownFaction(state, player, p)).length;
    case 'xietianzi':
      return alive.filter((p) => !effectiveFaction(state, p)).length;
    default:
      return QICE_TRICKS.find((t) => t.type === type)?.min ?? 1;
  }
}

/** 奇策现在能当哪些普通锦囊用（目标数不能超过手牌数） */
function qiceOptions(state: GameState, player: Player): { id: string; label: string }[] {
  const hand = player.hand.length;
  const out: { id: string; label: string }[] = [];
  for (const spec of QICE_TRICKS) {
    if (qiceTargetCount(state, player, spec.type) > hand) continue;
    out.push({ id: spec.type, label: CARD_TYPE_NAME[spec.type] });
  }
  return out;
}

/** 奇策可选的目标（距离 + 既有的目标封锁，如帷幕/空城） */
function qiceTargets(state: GameState, player: Player, type: TrickType): Player[] {
  const alive = state.players.filter((p) => p.alive);
  const others = alive.filter((p) => p.seatId !== player.seatId);
  const legal = (p: Player): boolean => !heroBlocksBeingTarget(state, p, cardOfType(type), player);
  switch (type) {
    case 'tiesuo':
    case 'taoyuan':
    case 'wugu':
      return alive.filter(legal);
    case 'shunshou':
      return others.filter((p) => distance(state, player.seatId, p.seatId) <= 1 && legal(p));
    case 'guohe':
    case 'huogong':
    case 'juedou':
    case 'zhibi':
    case 'yuanjiao':
      return others.filter(legal);
    case 'huoshao':
      return alive.filter(legal);
    default:
      return others.filter(legal);
  }
}

/** 造一张「只为问目标合法性」的假牌（不对应牌堆里的实体牌） */
function cardOfType(type: TrickType): Card {
  return { id: `virtual-ask-${type}`, type, suit: 'spade', rank: 0 };
}

/** 收下一个目标：够了就把它打出去 */
function step2(
  state: GameState,
  player: Player,
  targetId: string,
  chosen: string[],
  spec: { type: TrickType; min: number; max: number },
  api: SkillApi,
): void {
  const next = [...chosen, targetId];
  const need = Math.min(spec.min, Math.min(player.hand.length, spec.max));
  if (next.length < need) {
    const candidates = qiceTargets(state, player, spec.type).filter(
      (c) => !next.includes(c.seatId),
    );
    if (candidates.length > 0) {
      api.askChoice(
        state,
        player.seatId,
        `【奇策】：为【${CARD_TYPE_NAME[spec.type]}】选择目标（第 ${next.length + 1} 个）`,
        candidates.map((c) => ({ id: c.seatId, label: c.name })),
        (st2, p2, tid) => step2(st2, p2, tid, next, spec, api),
        player.seatId,
      );
      return;
    }
  }
  fire(state, player, spec, next, api);
}

/**
 * 把手牌全部当材料打出去，然后可以变更一次副将。
 *
 * ⚠️ **先问「是否变更副将」、再打出那张虚拟锦囊**——官方原文是「使用……然后你可以变更副将」，
 * 顺序上是反的，但这里必须反过来：虚拟锦囊可能是【挟天子以令诸侯】那类**会结束出牌阶段**
 * 的牌，一旦先打出去，回合就推进到下家、出牌阶段已经结束，这个询问就落在了一个**已经结束的
 * 流程**上（答完之后 pending 变 null，整局静默卡死——模糊测试抓到过）。
 * 变更副将本身与那张锦囊的结算互不影响，所以提前问不改变结果，只把顺序里的风险去掉。
 */
function fire(
  state: GameState,
  player: Player,
  spec: { type: TrickType },
  targets: string[],
  api: SkillApi,
): void {
  const play = (): void => {
    const materials = player.hand.slice();
    const suit = materials[0]?.suit ?? 'spade';
    for (const c of materials) removeCard(player.hand, c.id);
    toDiscard(state, ...materials);
    pushLog(
      state,
      'skill',
      `${player.name} 用 ${materials.length} 张手牌当【${CARD_TYPE_NAME[spec.type]}】使用。`,
    );
    api.castVirtualTrick(player.seatId, { type: spec.type, suit }, targets);
  };
  if (!player.deputyHeroId) {
    play();
    return;
  }
  api.askChoice(
    state,
    player.seatId,
    '【奇策】：是否变更一次副将？（之后打出这张虚拟锦囊）',
    [
      { id: 'yes', label: '变更副将' },
      { id: 'no', label: '不变更' },
    ],
    (_st, p, choice) => {
      if (choice === 'yes') api.changeDeputyHero(p.seatId);
      play();
    },
  );
}

const YUJI: Hero = {
  id: 'yuji',
  name: '于吉',
  faction: 'qun',
  pack: 'zhen', // zhen 包：该包开关关闭时不进选将池
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      timing: 'anyDamaged',
      skillId: '千幻',
      handler: (ctx) => {
        const victimId = (ctx.payload as { victimId?: string } | undefined)?.victimId;
        const victim = victimId ? getPlayer(ctx.state, victimId) : undefined;
        if (!victim || !victim.alive) return;
        if (!sameKnownFaction(ctx.state, ctx.player, victim)) return;
        const me = ctx.player;
        const suits = new Set(me.qianhuan.map((c) => c.suit));
        // 「与你武将牌上牌花色均不同的牌」——手牌或装备区里挑
        const pool = [
          ...me.hand,
          ...(EQUIP_SLOTS.map((slot) => me.equipment[slot]).filter(Boolean) as Card[]),
        ].filter((c) => !suits.has(c.suit));
        if (pool.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          `是否发动【千幻】把一张牌置于武将牌上（成为「千幻」）？`,
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            const cards = p.hand
              .filter((c) => !suits.has(c.suit))
              .concat(
                (EQUIP_SLOTS.map((slot) => p.equipment[slot]).filter(Boolean) as Card[]).filter(
                  (c) => !suits.has(c.suit),
                ),
              );
            if (cards.length === 0) return;
            ctx.api.askPickCards(
              st,
              p.seatId,
              '【千幻】：选择一张置于武将牌上（花色要与已有「千幻」都不同）',
              cards,
              1,
              1,
              (st2, p2, chosen) => {
                const card = chosen[0];
                if (!card) return;
                // 从手牌或装备区搬走（装备要用 discardCard 那套触发失去装备）
                const inHand = p2.hand.some((c) => c.id === card.id);
                if (inHand) {
                  removeCard(p2.hand, card.id);
                  p2.qianhuan.push(card);
                  pushLog(st2, 'skill', `${p2.name} 发动【千幻】，将一张牌置于武将牌上。`);
                } else {
                  // 装备区的牌：先离场再进「千幻」——**要触发「失去装备区的牌」**
                  // （枭姬/旋略/白银狮子/兴棹第4档都会响；直接清槽位会漏）
                  ctx.api.loseEquip(p2.seatId, card, () => {
                    p2.qianhuan.push(card);
                    pushLog(st2, 'skill', `${p2.name} 发动【千幻】，将装备区的牌置于武将牌上。`);
                  });
                }
              },
            );
          },
        );
      },
    },
    {
      timing: 'othersBecomeTarget',
      skillId: '千幻',
      handler: (ctx) => {
        const payload = ctx.payload as
          | { targetId?: string; card?: Card; attack?: AttackContext; trickCtx?: TrickContext }
          | undefined;
        const targetId = payload?.targetId;
        if (!targetId) return;
        const victim = getPlayer(ctx.state, targetId);
        if (!victim || !victim.alive) return;
        if (!sameKnownFaction(ctx.state, ctx.player, victim)) return;
        if (ctx.player.qianhuan.length === 0) return;
        const me = ctx.player;
        // 「非装备牌」：装备牌不算；【杀】要看是不是唯一目标（方天画戟那种多目标不算）
        const card = payload?.card;
        if (card && isEquipCard(card)) return;
        const attack = payload?.attack;
        if (attack && (attack.fangtianQueue?.length ?? 0) > 0) return;
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          `是否移去一张「千幻」取消针对 ${victim.name} 的这张牌？`,
          [
            { id: 'yes', label: '取消之' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            const gone = p.qianhuan.shift();
            if (!gone) return;
            toDiscard(st, gone);
            pushLog(st, 'skill', `${p.name} 移去一张「千幻」，取消了这张牌。`);
            const a2 = payload?.attack;
            if (a2) {
              a2.dodged = true;
              return;
            }
            // 锦囊：走「抵消」那套（与【无懈可击·国】同一条路——引擎里被抵消的角色是靠
            // wuxieChain 的奇数张生效来判的，这里记一条只针对该目标的链）
            const trick = payload?.trickCtx;
            if (trick) {
              trick.wuxieChain = { scope: [targetId], count: 1 };
            }
            void card;
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '千幻',
      desc: '当与你势力相同的一名角色受到伤害后，你可以将一张与你武将牌上牌花色均不同的牌置于你的武将牌上。当与你势力相同的角色成为非装备牌的唯一目标时，你可以移去一张「千幻」牌取消之。',
    },
  ],
};

const BENGSHUAI: Hero = {
  id: 'bengshuai',
  name: '崩坏',
  faction: 'neutral',
  maxHp: 1,
  notDraftable: true,
  hooks: [
    {
      timing: 'turnEnd',
      skillId: '崩坏',
      locked: true,
      handler: (ctx) => {
        const me = ctx.player;
        const alive = ctx.state.players.filter((x) => x.alive);
        const lowest = Math.min(...alive.map((x) => x.hp));
        if (me.hp <= lowest) return; // 体力值最小的角色之一 → 不触发
        const options: { id: string; label: string }[] = [];
        options.push({ id: 'hp', label: '失去 1 点体力' });
        if (me.maxHp > 1) options.push({ id: 'maxhp', label: '减 1 点体力上限' });
        ctx.api.askChoice(ctx.state, me.seatId, '【崩坏】：选择一项', options, (st, p, picked) => {
          if (picked === 'maxhp') {
            ctx.api.changeMaxHp(p, -1);
            pushLog(st, 'skill', `${p.name} 的【崩坏】生效：减 1 点体力上限。`);
            return;
          }
          ctx.api.loseHp(p, 1);
          pushLog(st, 'skill', `${p.name} 的【崩坏】生效：失去 1 点体力。`);
        });
      },
    },
  ],
  skills: [
    {
      name: '崩坏',
      desc: '锁定技，结束阶段，若你不是体力值最小的角色，你失去1点体力或减1点体力上限。',
    },
  ],
};

/**
 * 【勇决】（伪武将，只作为被授予的技能存在）：糜夫人·存嗣把它交给一名角色。
 * 「当你于出牌阶段使用的第一张牌为【杀】且此【杀】结算结束后，若你与你势力相同的
 *  一名角色拥有【勇决】…」——官方把它写成持有者的技能，所以这里挂在 attackSettled 上：
 *  看**使用者**这一回合出牌阶段用过的牌（本引擎有 usedCardsInPlayPhase），
 *  第一张就是这张【杀】、且使用者与持有者势力相同 → 持有者可以获得这张【杀】。
 */
const YONGJUE: Hero = {
  id: 'yongjue',
  name: '勇决',
  faction: 'neutral',
  maxHp: 1,
  notDraftable: true,
  hooks: [
    {
      timing: 'attackSettled',
      skillId: '勇决',
      handler: (ctx) => {
        const attack = (ctx.payload as { attack?: AttackContext } | undefined)?.attack;
        if (!attack) return;
        const source = getPlayer(ctx.state, attack.sourceId);
        if (!source || !source.alive) return;
        // 「于其出牌阶段使用的第一张牌」——本引擎在 useCard 时记牌，长度 1 就说明是首张
        const used = source.flags.usedCardsInPlayPhase;
        if (used.length !== 1) return;
        if (used[0]!.kind !== 'basic') return;
        if (!sameKnownFaction(ctx.state, source, ctx.player)) return;
        const idx = ctx.state.discard.findIndex((c) => c.id === attack.cardId);
        if (idx < 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `是否发动【勇决】获得 ${source.name} 结算完的【杀】？`,
          [
            { id: 'yes', label: '获得这张【杀】' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.giveDiscardedTo([{ id: attack.cardId } as Card], p.seatId, '勇决');
            void st;
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '勇决',
      desc: '当一名与你势力相同的角色于其出牌阶段使用的第一张牌为【杀】且此【杀】结算结束后，你可以获得之。',
    },
  ],
};

/**
 * 糜夫人 —— 闺秀 / 存嗣（君临天下·势，已核文本）。
 *
 * - 闺秀：当你明置此武将牌后，你可以摸两张牌；当你移除此武将牌后，你可以回复 1 点体力。
 * - 存嗣：出牌阶段，你可以移除此武将牌并令一名角色获得【勇决】；
 *   若其不为你，其摸两张牌。
 *
 * 两条都用「移除武将牌」那套地基（removedHeroIds / removeHeroCard / healOwnerOnRemoval），
 * 明置那半走新时机 heroRevealed，【勇决】的触发走新时机 attackSettled。
 */
/**
 * 张任 —— 穿心 / 锋矢（君临天下·势，已核国战文本）。
 *
 * - 穿心：当你于出牌阶段内使用【杀】或【决斗】对目标角色造成伤害时，若其与你势力不同
 *   且有副将，你可以防止此伤害。若如此做，该角色选择一项：①弃置装备区里的所有牌，
 *   若如此做，其失去 1 点体力；②移除副将。
 * - 锋矢：阵法技（围攻关系）→ **已实现**：同一个围攻关系里，围攻角色出【杀】指定被围攻者后，
 *   可以令其弃置装备区里的一张牌（见下面的 `锋矢` 钩子）。
 *
 * 实现：穿心挂在 `damageDealt`（伤害结算前的可挂起时机，也是引擎里唯一能「取消这次伤害」
 * 的通道——把 flags.damagePrevented 设上就行）。
 */
const ZHANGREN: Hero = {
  id: 'zhangren',
  name: '张任',
  faction: 'qun',
  pack: 'shi', // shi 包：该包开关关闭时不进选将池
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  // 锋矢（阵法技，围攻型）：阵法召唤按「亮将后进同一围攻关系」判
  formation: ['siege'],
  hooks: [
    {
      // 【锋矢】（阵法技）：同一个围攻关系里，围攻角色出【杀】指定被围攻者 → 令其弃装备区一张
      timing: 'othersBecomeTarget',
      skillId: '锋矢',
      handler: (ctx) => {
        const payload = ctx.payload as { targetId?: string; attack?: AttackContext } | undefined;
        const attack = payload?.attack;
        if (!attack || attack.asType !== 'sha' || !payload?.targetId) return;
        const victim = besiegedBySha(ctx.state, attack.sourceId, payload.targetId);
        if (!victim) return;
        const mine = besiegingTarget(ctx.state, ctx.player);
        if (mine !== victim.seatId) return;
        const equips = EQUIP_SLOTS.map((slot) => victim.equipment[slot]).filter(Boolean) as Card[];
        if (equips.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `是否对 ${victim.name} 发动【锋矢】令其弃置装备区一张牌？`,
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, _p, picked) => {
            if (picked !== 'yes') return;
            const t = getPlayer(st, victim.seatId);
            if (!t) return;
            const cards = EQUIP_SLOTS.map((slot) => t.equipment[slot]).filter(Boolean) as Card[];
            if (cards.length === 0) return;
            ctx.api.askChoice(
              st,
              t.seatId,
              '【锋矢】：弃置装备区里的一张牌',
              cards.map((c) => ({ id: c.id, label: `弃置【${cardLabel(c)}】` })),
              (st2, t2, cardId) => {
                const card = cards.find((c) => c.id === cardId);
                if (card) ctx.api.discardCard(t2.seatId, card);
              },
            );
          },
        );
      },
    },
    {
      // 「造成伤害时」——挂在**来源**这一侧（damageDealt 是目标那一侧）
      timing: 'damageCaused',
      skillId: '穿心',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
        const attack = payload?.attack;
        if (!attack || attack.sourceId !== ctx.player.seatId) return;
        if (attack.asType !== 'sha' && attack.asType !== 'juedou') return;
        if (ctx.state.turn.phase !== 'play') return; // 「于出牌阶段内」
        const victim = getPlayer(ctx.state, attack.targetId);
        if (!victim || !victim.alive || victim.seatId === ctx.player.seatId) return;
        const mine = effectiveFaction(ctx.state, ctx.player);
        const theirs = effectiveFaction(ctx.state, victim);
        if (!mine || mine === theirs) return; // 「与你势力不同」
        if (!victim.deputyHeroId || victim.removedHeroIds.includes(victim.deputyHeroId)) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `是否对 ${victim.name} 发动【穿心】防止此伤害？`,
          [
            { id: 'yes', label: '发动（其弃装备掉血，或移除副将）' },
            { id: 'no', label: '不发动' },
          ],
          (st, _p, picked) => {
            if (picked !== 'yes') return;
            const t = getPlayer(st, victim.seatId);
            if (!t) return;
            // 防止这次伤害：damageStep 会在钩子跑完之后读这个标记
            t.flags.damagePrevented = true;
            pushLog(st, 'skill', `${ctx.player.name} 发动【穿心】，防止此伤害。`);
            const equips = EQUIP_SLOTS.map((slot) => t.equipment[slot]).filter(Boolean) as Card[];
            const options: { id: string; label: string }[] = [];
            options.push({
              id: 'remove',
              label: '移除副将',
            });
            options.unshift({
              id: 'discard',
              label:
                equips.length > 0
                  ? '弃置装备区所有牌，然后失去 1 点体力'
                  : '失去 1 点体力（没有装备可弃）',
            });
            ctx.api.askChoice(st, t.seatId, `【穿心】：选择一项`, options, (st2, t2, choice) => {
              if (choice === 'remove') {
                if (t2.deputyHeroId) ctx.api.removeHeroCard(t2.seatId, t2.deputyHeroId);
                return;
              }
              for (const slot of EQUIP_SLOTS) {
                const c = t2.equipment[slot];
                if (c) ctx.api.discardCard(t2.seatId, c);
              }
              ctx.api.loseHp(t2, 1);
              pushLog(st2, 'skill', `${t2.name} 因【穿心】失去 1 点体力。`);
            });
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '穿心',
      desc: '当你于出牌阶段内使用【杀】或【决斗】对目标角色造成伤害时，若其与你势力不同且有副将，你可以防止此伤害。若如此做，该角色选择一项：1.弃置装备区里的所有牌，若如此做，其失去1点体力；2.移除副将。',
    },
    {
      name: '锋矢',
      desc: '阵法技，在同一个围攻关系中，若你是围攻角色，则你或另一名围攻角色使用【杀】指定被围攻角色为目标后，你令该角色弃置装备区里的一张牌。',
    },
  ],
  // 阵法召唤（通用机制，见 §5.132）：拥有阵法技的角色都多出这一条出牌阶段限一次的操作
  activeSkills: [FORMATION_SUMMON],

};

const MIFUREN: Hero = {
  id: 'mifuren',
  name: '糜夫人',
  faction: 'shu',
  pack: 'shi', // shi 包：该包开关关闭时不进选将池
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'female',
  modes: ['guozhan'],
  healOwnerOnRemoval: true,
  hooks: [
    {
      timing: 'heroRevealed',
      skillId: '闺秀',
      handler: (ctx) => {
        const heroId = (ctx.payload as { heroId?: string } | undefined)?.heroId;
        if (heroId !== 'mifuren') return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【闺秀】摸两张牌？',
          [
            { id: 'yes', label: '摸两张牌' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            let got = 0;
            for (let i = 0; i < 2; i++) {
              const c = drawOne(st);
              if (!c) break;
              p.hand.push(c);
              got++;
            }
            pushLog(st, 'skill', `${p.name} 发动【闺秀】，摸了 ${got} 张牌。`);
          },
        );
      },
    },
  ],
  activeSkills: [
    {
      id: 'cunsi',
      name: '存嗣',
      minTargets: 1,
      maxTargets: 1,
      needsCards: false,
      canUse: (state, player) =>
        !player.removedHeroIds.includes('mifuren') && state.players.some((x) => x.alive),
      execute: (state, player, intent, api) => {
        if (player.removedHeroIds.includes('mifuren')) return '【存嗣】已经用过了（武将牌已移除）';
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名角色';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        pushLog(state, 'skill', `${player.name} 发动【存嗣】。`);
        api.removeHeroCard(player.seatId, 'mifuren');
        api.grantSkill('yongjue', '勇决', targetId);
        pushLog(state, 'skill', `${target.name} 获得了技能【勇决】。`, { seat: target.seatId });
        if (target.seatId !== player.seatId) {
          let got = 0;
          for (let i = 0; i < 2; i++) {
            const c = drawOne(state);
            if (!c) break;
            target.hand.push(c);
            got++;
          }
          pushLog(state, 'skill', `${target.name} 因【存嗣】摸了 ${got} 张牌。`);
        }
        return undefined;
      },
    },
  ],
  skills: [
    {
      name: '闺秀',
      desc: '当你明置此武将牌后，你可以摸两张牌；当你移除此武将牌后，你可以回复1点体力。',
    },
    {
      name: '存嗣',
      desc: '出牌阶段，你可以移除此武将牌并令一名角色获得【勇决】，若其不为你，其摸两张牌。',
    },
  ],
};

const DONGZHUO: Hero = {
  id: 'dongzhuo',
  name: '董卓',
  faction: 'qun',
  pack: 'shi', // shi 包：该包开关关闭时不进选将池
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  // 暴凌：主将技（只它受限，横征不受影响）；并且让它少半个阴阳鱼（-1 体力上限）
  mainSlotSkills: ['暴凌'],
  mainSlotHalfYang: true,
  hooks: [
    {
      timing: 'playPhaseEnd',
      skillId: '暴凌',
      locked: true,
      handler: (ctx) => {
        const me = ctx.player;
        if (me.usedOncePerGame.baling) return; // 已经用过了（发动后失去暴凌）
        if (!me.deputyHeroId) return;
        me.usedOncePerGame.baling = true;
        ctx.api.removeHeroCard(me.seatId, me.deputyHeroId);
        ctx.api.changeMaxHp(me, 3);
        const healed = ctx.api.heal(me, 3);
        ctx.api.grantSkill('bengshuai', '崩坏');
        pushLog(
          ctx.state,
          'skill',
          `${me.name} 的【暴凌】生效：移除副将，体力上限 +3、回复 ${healed} 点体力并获得【崩坏】。`,
        );
      },
    },
    {
      timing: 'drawPhase',
      skillId: '横征',
      handler: (ctx) => {
        const me = ctx.player;
        if (me.flags.skipDraw) return;
        // 条件：体力值为 1 或没有手牌
        if (!(me.hp === 1 || me.hand.length === 0)) return;
        const others = ctx.state.players.filter(
          (p) =>
            p.alive &&
            p.seatId !== me.seatId &&
            (p.hand.length > 0 ||
              p.judgment.length > 0 ||
              EQUIP_SLOTS.some((slot) => !!p.equipment[slot])),
        );
        if (others.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          `是否发动【横征】放弃摸牌，改为从其他每名角色各获得一张牌？`,
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            p.flags.skipDraw = true; // 放弃摸牌
            pushLog(st, 'skill', `${p.name} 发动【横征】，放弃摸牌。`);
            hengzhengStep(
              st,
              p,
              others.map((x) => x.seatId),
              0,
              ctx.api,
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '横征',
      desc: '摸牌阶段开始时，若你的体力值为1或你没有手牌，你可以放弃摸牌，改为从其他每名角色的所属区域内各获得一张牌。',
    },
    {
      name: '暴凌',
      desc: '主将技，锁定技，出牌阶段结束时，移除你的副将，然后你加3点体力上限并回复3点体力，失去【暴凌】并获得【崩坏】。',
    },
  ],
};

/**
 * 臧霸 —— 横江（君临天下·势，印刷版文本，已核）：
 * 当你受到 1 点伤害后，你可以令当前回合角色的手牌上限于此回合内 -1，
 * 回合结束时，若其未于弃牌阶段内弃置过牌，你摸一张牌。
 *
 * （2023 典藏版修订成「若其手牌上限大于 0」+「摸 X 张，X 为本回合发动次数」，
 *   这里按印刷版写，差异写在注释里。）
 *
 * 实现：减上限直接改那名角色自己的 `handLimitBonus`（与吕蒙·克己同一套标记）；
 * 「未于弃牌阶段内弃置过牌」在 `othersDiscardPhaseEnd` 时机看那一阶段弃掉的牌——
 * 这个时机本来就带着「他这阶段弃了哪些牌」的 payload。
 */
const ZANGBA: Hero = {
  id: 'zangba',
  name: '臧霸',
  faction: 'wei',
  // 国战牌面 2 阴阳鱼 → 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      timing: 'afterDamage',
      skillId: '横江',
      handler: (ctx) => hengjiangAsk(ctx),
    },
    {
      timing: 'othersDiscardPhaseEnd',
      skillId: '横江',
      handler: (ctx) => {
        const payload = ctx.payload as { discardingSeatId?: string; cards?: Card[] } | undefined;
        const who = payload?.discardingSeatId;
        if (!who) return;
        // 本回合没对他用过横江就别触发
        if (ctx.player.flags.hengjiangTarget !== who) return;
        ctx.player.flags.hengjiangTarget = null;
        if ((payload?.cards ?? []).length > 0) return; // 他弃过牌 → 不摸
        const c = drawOne(ctx.state);
        if (!c) return;
        ctx.player.hand.push(c);
        pushLog(
          ctx.state,
          'skill',
          `${ctx.player.name} 的【横江】生效：${getPlayer(ctx.state, who)?.name ?? '对方'} 未弃牌，其摸一张牌。`,
        );
      },
    },
  ],
  skills: [
    {
      name: '横江',
      desc: '当你受到1点伤害后，你可以令当前回合角色的手牌上限于此回合内-1，回合结束时，若其未于弃牌阶段内弃置过牌，你摸一张牌。',
    },
  ],
};

/** 横江：受到 1 点伤害就问一次「要不要减当前回合角色的手牌上限」（逐点） */
function hengjiangAsk(ctx: HookContext, left?: number): void {
  const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
  const times = left ?? payload?.damage ?? 0;
  if (times <= 0) return;
  const turnSeat = ctx.state.seatOrder[ctx.state.turn.seatIndex];
  const turnPlayer = turnSeat ? getPlayer(ctx.state, turnSeat) : undefined;
  if (!turnPlayer) return;
  ctx.api.askChoice(
    ctx.state,
    ctx.player.seatId,
    times > 1
      ? `【横江】：是否令 ${turnPlayer.name} 本回合手牌上限 -1？（还有 ${times} 点没结算）`
      : `【横江】：是否令 ${turnPlayer.name} 本回合手牌上限 -1？`,
    [
      { id: 'yes', label: '发动' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked === 'yes') {
        const t = getPlayer(st, turnSeat!);
        if (t) {
          t.flags.handLimitBonus -= 1;
          p.flags.hengjiangTarget = t.seatId;
          pushLog(st, 'skill', `${p.name} 发动【横江】，${t.name} 本回合手牌上限 -1。`);
        }
      }
      if (times > 1) hengjiangAsk(ctx, times - 1);
    },
  );
}

const LIDIAN: Hero = {
  id: 'lidian',
  name: '李典',
  faction: 'wei',
  pack: 'shi', // shi 包：该包开关关闭时不进选将池
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      timing: 'drawPhase',
      skillId: '恂恂',
      handler: (ctx) => {
        const me = ctx.player;
        if (me.flags.skipDraw) return; // 已经被跳过摸牌了（兵粮/神速）就别再改
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          '是否发动【恂恂】放弃摸牌，改为观看牌堆顶四张牌？',
          [
            { id: 'yes', label: '发动（取其中两张，其余置牌堆底）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            // 「放弃摸牌」：把这一阶段的摸牌数改成 0
            p.flags.skipDraw = true;
            const top: Card[] = [];
            for (let i = 0; i < 4; i++) {
              const c = drawOne(st);
              if (!c) break;
              top.push(c);
            }
            if (top.length === 0) return;
            const take = Math.min(2, top.length);
            ctx.api.askPickCards(
              st,
              p.seatId,
              `【恂恂】：观看牌堆顶 ${top.length} 张，取其中 ${take} 张`,
              top,
              take,
              take,
              (st2, p2, chosen) => {
                const gotIds = new Set(chosen.map((c) => c.id));
                const rest = top.filter((c) => !gotIds.has(c.id));
                for (const c of chosen) p2.hand.push(c);
                // 其余以任意顺序置于牌堆底（这里按原序放；`unshift` 让第一张最靠底）
                st2.deck.unshift(...rest);
                // 取牌是私密信息：日志只记张数，不记牌名（与观星一致）
                pushLog(
                  st2,
                  'skill',
                  `${p2.name} 发动【恂恂】：取得 ${chosen.length} 张，其余 ${rest.length} 张置于牌堆底。`,
                );
              },
            );
          },
        );
      },
    },
    {
      timing: 'afterDamageDealt',
      skillId: '忘隙',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
        const attack = payload?.attack;
        if (!attack || attack.targetId === ctx.player.seatId) return;
        wangxiAsk(ctx, attack.targetId, payload?.damage ?? 0);
      },
    },
    {
      timing: 'afterDamage',
      skillId: '忘隙',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
        const attack = payload?.attack;
        if (!attack?.sourceId || attack.sourceId === ctx.player.seatId) return;
        wangxiAsk(ctx, attack.sourceId, payload?.damage ?? 0);
      },
    },
    {
      // 「被打进濒死」的那一半：濒死结算完了才知道对方到底活没活下来（官方口径是
      // 濒死结算在前、伤害后时机在后；本引擎相反，所以用这条时机把待办接上）。
      timing: 'nearDeathResolved',
      skillId: '忘隙',
      handler: (ctx) => {
        const payload = ctx.payload as { dyingSeatId?: string; alive?: boolean } | undefined;
        const seatId = payload?.dyingSeatId;
        if (!seatId) return;
        const list = ctx.player.flags.wangxiPending;
        const idx = list.findIndex((x) => x.seatId === seatId);
        if (idx < 0) return;
        const [pending] = list.splice(idx, 1);
        if (!pending || !payload?.alive) return; // 没活下来 → 官方也不触发
        wangxiAskNow(ctx, pending.seatId, pending.left);
      },
    },
  ],
  skills: [
    {
      name: '恂恂',
      desc: '摸牌阶段摸牌时，你可改为观看牌堆顶的四张牌，将其中两张收入手牌，其余以任意顺序置于牌堆底。',
    },
    {
      name: '忘隙',
      desc: '每当你对其他角色造成1点伤害后，或受到其他角色造成的1点伤害后，若该角色存活，你可以令你与其各摸一张牌。',
    },
  ],
};

/** 忘隙：逐点问一次「要不要各摸一张」（造成与受到两个方向共用） */
function wangxiAsk(ctx: HookContext, otherSeatId: string, left: number): void {
  if (left <= 0) return;
  const other = getPlayer(ctx.state, otherSeatId);
  if (!other || !other.alive) return;
  // 「若该角色存活」：本引擎伤害层的顺序是「伤害后钩子 → 濒死」，官方是「濒死结算 → 伤害后钩子」。
  // 所以**被打进濒死**（hp ≤ 0）的情况不能现在判——记一笔待办，等 nearDeathResolved
  // （濒死结算完、知道活没活下来）再问。这样「救回来了照样触发」和官方一致。
  if (other.hp <= 0) {
    if (!ctx.player.flags.wangxiPending.some((x) => x.seatId === otherSeatId)) {
      ctx.player.flags.wangxiPending.push({ seatId: otherSeatId, left });
    }
    return;
  }
  wangxiAskNow(ctx, otherSeatId, left);
}

/** 忘隙的询问本体（调用方已经确认对方存活） */
function wangxiAskNow(ctx: HookContext, otherSeatId: string, left: number): void {
  if (left <= 0) return;
  const other = getPlayer(ctx.state, otherSeatId);
  if (!other || !other.alive || other.hp <= 0) return;
  ctx.api.askChoice(
    ctx.state,
    ctx.player.seatId,
    left > 1
      ? `【忘隙】：是否与 ${other.name} 各摸一张牌？（还有 ${left} 点没结算）`
      : `【忘隙】：是否与 ${other.name} 各摸一张牌？`,
    [
      { id: 'yes', label: '发动' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked === 'yes') {
        const t = getPlayer(st, otherSeatId);
        const c1 = drawOne(st);
        if (c1) p.hand.push(c1);
        const c2 = t ? drawOne(st) : undefined;
        if (t && c2) t.hand.push(c2);
        pushLog(
          st,
          'skill',
          `${p.name} 发动【忘隙】，${p.name} 与 ${t?.name ?? '对方'} 各摸一张牌。`,
        );
      }
      if (left > 1) wangxiAsk(ctx, otherSeatId, left - 1);
    },
  );
}

const ZHANGHE: Hero = {
  id: 'zhanghe',
  name: '张郃',
  faction: 'wei',
  maxHp: 4,
  gender: 'male',
  hooks: [
    { timing: 'judgePhase', skillId: '巧变', handler: (ctx) => qiaobianAsk(ctx, 'judgment') },
    { timing: 'drawPhase', skillId: '巧变', handler: (ctx) => qiaobianAsk(ctx, 'draw') },
    { timing: 'playPhase', skillId: '巧变', handler: (ctx) => qiaobianAsk(ctx, 'play') },
    { timing: 'discardPhase', skillId: '巧变', handler: (ctx) => qiaobianAsk(ctx, 'discard') },
  ],
  skills: [
    {
      name: '巧变',
      desc: '你可以弃置一张手牌并跳过一个阶段（准备阶段和结束阶段除外）。若你以此法跳过摸牌阶段，你可以获得至多两名角色的各一张手牌；若你以此法跳过出牌阶段，你可以移动场上的一张牌。',
    },
  ],
};

const LVMENG: Hero = {
  id: 'lvmeng',
  name: '吕蒙',
  faction: 'wu',
  maxHp: 4,
  gender: 'male',
  hooks: [
    {
      timing: 'discardPhase',
      skillId: '克己',
      // 锁定技，不需要询问
      handler: (ctx) => {
        const used = ctx.player.flags.usedCardsInPlayPhase;
        const colors = new Set(used.map((c) => c.color));
        const skipped = ctx.player.flags.skipPlay;
        if (!skipped && colors.size > 1) return;
        ctx.player.flags.handLimitBonus += 4;
        pushLog(ctx.state, 'skill', `${ctx.player.name} 的【克己】生效，本回合手牌上限 +4。`);
      },
    },
    {
      timing: 'turnEnd',
      skillId: '谋断',
      handler: (ctx) => {
        const used = ctx.player.flags.usedCardsInPlayPhase;
        const suits = new Set(used.map((c) => c.suit));
        const kinds = new Set(used.map((c) => c.kind));
        if (suits.size < 4 && kinds.size < 3) return;
        askMoveFieldCard(ctx, '谋断');
      },
    },
  ],
  skills: [
    {
      name: '克己',
      desc: '锁定技，弃牌阶段开始时，若你于出牌阶段内未使用过颜色不同的牌，或出牌阶段被跳过，你的手牌上限于此回合内 +4。',
    },
    {
      name: '谋断',
      desc: '结束阶段，若你于出牌阶段内使用过四种花色或三种类别的牌，你可以移动场上的一张牌。',
    },
  ],
};

/**
 * 鲁肃 —— 按最新官方文本（标准版原文）。
 *
 * - 好施：摸牌阶段，你可以多摸两张牌，然后若你的手牌数大于 5，
 *   你将一半的手牌（向下取整）交给手牌最少的一名其他角色。
 * - 缔盟：出牌阶段限一次，你可以选择两名其他角色并弃置 X 张牌
 *   （X 为两名角色手牌数之差），然后交换两者手牌。
 *
 * 缔盟的 X 只有选定目标之后才知道，所以**目标由主动技收、弃牌在 execute 里再问**
 * （`api.askPickCards` + `returnTo`），否则界面没法告诉玩家要弃几张。
 *
 * ⚠️ 好施是**钩子**，在钩子里发起询问**不能传 returnTo**：会把摸牌阶段整个跳掉
 *    （returnTo 走 resumePlay，直接把 pending 设成出牌阶段）。钩子里靠引擎的
 *    续接队列（resumeQueue）接着跑——这正是 timing.ts 里那条注释说的情况。
 */
const LUSU: Hero = {
  id: 'lusu',
  name: '鲁肃',
  faction: 'wu',
  maxHp: 3,
  gender: 'male',
  hooks: [
    {
      timing: 'drawPhase',
      skillId: '好施',
      handler: (ctx) => {
        const player = ctx.player;
        ctx.api.askChoice(
          ctx.state,
          player.seatId,
          '是否发动【好施】？（多摸两张；若因此手牌数大于 5，要把一半交给手牌最少的人）',
          [
            { id: 'yes', label: '发动（多摸两张牌）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            // 多摸的这两张直接从牌堆拿，不走「摸牌阶段摸几张」那套计数
            for (let i = 0; i < 2; i++) {
              const c = drawOne(st);
              if (c) p.hand.push(c);
            }
            pushLog(st, 'skill', `${p.name} 发动【好施】，多摸了两张牌。`);
            if (p.hand.length <= 5) return;
            const half = Math.floor(p.hand.length / 2);
            // 「手牌最少的一名其他角色」——并列最少时由发动者挑一个
            const others = st.players.filter((x) => x.alive && x.seatId !== p.seatId);
            if (others.length === 0) return;
            const min = Math.min(...others.map((x) => x.hand.length));
            const tied = others.filter((x) => x.hand.length === min);
            const give = (targetSeatId: string): void => {
              const target = getPlayer(st, targetSeatId);
              if (!target) return;
              ctx.api.askPickCards(
                st,
                p.seatId,
                `【好施】：选择交给 ${target.name} 的 ${half} 张手牌`,
                p.hand.slice(),
                half,
                half,
                (st2, p2, picked2) => {
                  for (const c of picked2) {
                    removeCard(p2.hand, c.id);
                    target.hand.push(c);
                  }
                  pushLog(
                    st2,
                    'skill',
                    `${p2.name} 把 ${picked2.length} 张手牌交给了 ${target.name}（【好施】）。`,
                  );
                },
              );
            };
            if (tied.length === 1) {
              give(tied[0]!.seatId);
              return;
            }
            ctx.api.askChoice(
              st,
              p.seatId,
              '【好施】：手牌最少的角色有并列，选择交给谁',
              tied.map((x) => ({ id: x.seatId, label: x.name })),
              (_st2, _p2, seatId) => give(seatId),
            );
          },
        );
      },
    },
  ],
  activeSkills: [
    {
      id: 'dimeng',
      name: '缔盟',
      oncePerTurn: true,
      minTargets: 2,
      maxTargets: 2,
      needsCards: false,
      canUse: (state, player) =>
        player.hand.length > 0 &&
        state.players.filter((p) => p.alive && p.seatId !== player.seatId).length >= 2,
      execute: (state, player, intent, api) => {
        const [idA, idB] = intent.targetIds;
        if (!idA || !idB) return '请选择两名其他角色';
        if (idA === idB) return '两名目标不能是同一人';
        const a = getPlayer(state, idA);
        const b = getPlayer(state, idB);
        if (!a || !b || !a.alive || !b.alive) return '目标无效';
        if (a.seatId === player.seatId || b.seatId === player.seatId) return '不能选择自己';
        const cost = Math.abs(a.hand.length - b.hand.length);
        if (cost === 0) {
          // X=0 时不用弃牌，直接交换
          api.swapHands(a.seatId, b.seatId);
          return undefined;
        }
        if (player.hand.length < cost) return `手牌不足，需弃置 ${cost} 张`;
        api.askPickCards(
          state,
          player.seatId,
          `【缔盟】：弃置 ${cost} 张牌（两人手牌数之差）`,
          player.hand.slice(),
          cost,
          cost,
          (st, p, picked) => {
            for (const c of picked) {
              removeCard(p.hand, c.id);
              toDiscard(st, c);
            }
            const na = getPlayer(st, idA);
            const nb = getPlayer(st, idB);
            if (na && nb) api.swapHands(na.seatId, nb.seatId);
          },
          { returnTo: player.seatId },
        );
        return undefined;
      },
    },
  ],
  skills: [
    {
      name: '好施',
      desc: '摸牌阶段，你可以多摸两张牌，然后若你的手牌数大于 5，你将一半的手牌（向下取整）交给手牌最少的一名其他角色。',
    },
    {
      name: '缔盟',
      desc: '出牌阶段限一次，你可以选择两名其他角色并弃置 X 张牌（X 为两名角色手牌数之差），然后交换两者手牌。',
    },
  ],
};

const LUXUN: Hero = {
  id: 'luxun',
  name: '陆逊',
  faction: 'wu',
  maxHp: 3,
  gender: 'male',
  // 谦逊：不能被【顺手牵羊】和【乐不思蜀】指定为目标
  cannotBeTargetOf: (_state, _self, card) => card.type === 'shunshou' || card.type === 'lebu',
  lockedFields: ['cannotBeTargetOf'],
  // 连营：失去最后一张手牌后，你可以摸一张牌。
  // 挂 handEmptied —— 引擎在每个 intent 结束时比对各家手牌数，覆盖所有减手牌的路径。
  hooks: [
    {
      timing: 'handEmptied',
      skillId: '连营',
      handler: (ctx) => {
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【连营】？',
          [
            { id: 'yes', label: '发动（摸一张牌）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            const c = drawOne(st);
            if (!c) return;
            p.hand.push(c);
            pushLog(st, 'skill', `${p.name} 发动【连营】，摸了 1 张牌。`);
          },
        );
      },
    },
  ],
  skills: [
    { name: '谦逊', desc: '锁定技，你不能成为【顺手牵羊】和【乐不思蜀】的目标。' },
    { name: '连营', desc: '当你失去最后一张手牌后，你可以摸一张牌。' },
  ],
};

const SUNSHANGXIANG: Hero = {
  id: 'sunshangxiang',
  name: '孙尚香',
  faction: 'wu',
  maxHp: 3,
  gender: 'female',
  // 结姻：弃两张手牌，令一名已受伤的男性角色回复 1 点体力，你也回复 1 点
  activeSkills: [
    {
      id: 'jieyin',
      name: '结姻',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      needsCards: true,
      maxCards: () => 2,
      canUse: (state, player) =>
        player.hand.length >= 2 &&
        state.players.some(
          (p) => p.alive && p.seatId !== player.seatId && isMalePlayer(state, p) && p.hp < p.maxHp,
        ),
      execute: (state, player, intent, api) => {
        const ids = intent.cardIds ?? [];
        if (ids.length !== 2) return '请选择两张手牌弃置';
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名已受伤的男性角色';
        if (targetId === player.seatId) return '不能选择自己';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        if (!isMalePlayer(state, target)) return '目标须为男性角色';
        if (target.hp >= target.maxHp) return '该角色体力已满';
        const discarded: Card[] = [];
        for (const id of ids) {
          const c = removeCard(player.hand, id);
          if (!c) return `找不到手牌 ${id}`;
          discarded.push(c);
        }
        for (const c of discarded) toDiscard(state, c);
        const targetHealed = api.heal(target, 1);
        const selfHealed = api.heal(player, 1);
        pushLog(
          state,
          'skill',
          `${player.name} 发动【结姻】，弃 ${discarded.length} 张牌，令 ${target.name} 回复 ${targetHealed} 点体力，自己回复 ${selfHealed} 点体力。`,
        );
        return undefined;
      },
    },
  ],
  skills: [
    {
      name: '结姻',
      desc: '出牌阶段限一次，你可以弃置两张手牌并选择一名已受伤的男性角色，令其回复 1 点体力，然后你回复 1 点体力。',
    },
    { name: '枭姬', desc: '当你失去装备区里的一张牌后，你可以摸两张牌。' },
  ],
  // 枭姬：失去装备区里的一张牌后，你可以摸两张牌。
  // 挂在 equipLost 上——顶替装备、被拆、被顺、借刀交武器都会触发。
  hooks: [
    {
      timing: 'equipLost',
      skillId: '枭姬',
      handler: (ctx) => {
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【枭姬】？',
          [
            { id: 'yes', label: '发动（摸两张牌）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            let got = 0;
            for (let i = 0; i < 2; i++) {
              const c = drawOne(st);
              if (!c) break;
              p.hand.push(c);
              got++;
            }
            pushLog(st, 'skill', `${p.name} 发动【枭姬】，摸了 ${got} 张牌。`);
          },
        );
      },
    },
  ],
};

/**
 * 乱武的续接链：按座次问每一个其他角色「对最近的人出【杀】 / 失去 1 点体力」。
 *
 * 为什么是一条链而不是一个循环：每一次询问都会挂起（引擎的 pending），
 * 出杀还要等那张【杀】整个结算完（`useShaOn` 的 after 回调），所以只能一个一个接着推。
 */
function luanwuStep(
  state: GameState,
  jia: Player,
  queue: string[],
  i: number,
  api: SkillApi,
): void {
  if (state.gameOver) return;
  const me = i < queue.length ? getPlayer(state, queue[i]!) : undefined;
  if (!me || !me.alive) {
    // 阵亡/中途没了 → 跳过
    if (i < queue.length) luanwuStep(state, jia, queue, i + 1, api);
    return;
  }
  const next = (): void => luanwuStep(state, jia, queue, i + 1, api);

  // 「距离最近的另一名角色」（可能并列，并列时他自己挑）
  let best = Infinity;
  const nearest: Player[] = [];
  for (const o of state.players) {
    if (!o.alive || o.seatId === me.seatId) continue;
    const d = distance(state, me.seatId, o.seatId);
    if (d < best) {
      best = d;
      nearest.length = 0;
      nearest.push(o);
    } else if (d === best) {
      nearest.push(o);
    }
  }
  // 最近的里面还得够得着（【杀】本身有攻击范围限制）
  const inRange = nearest.filter(
    (o) => attackRange(state, me) >= distance(state, me.seatId, o.seatId),
  );
  const canSha = inRange.length > 0 && usableShaCards(state, me).length > 0;

  const options: { id: string; label: string }[] = [];
  if (canSha) {
    options.push({
      id: 'sha',
      label: `对 ${inRange.map((o) => o.name).join('、')} 使用一张【杀】`,
    });
  }
  options.push({ id: 'hp', label: '失去 1 点体力' });

  // returnTo 传**贾诩**：整条链跑完后要把出牌阶段还给他（技能是在他的出牌阶段里用的）
  api.askChoice(
    state,
    me.seatId,
    `【乱武】（${jia.name}）：选择一项`,
    options,
    (st, p, picked) => {
      if (picked !== 'sha' || !canSha) {
        api.loseHp(p, 1, next);
        return;
      }
      const useOn = (card: Card, victim: Player): void => {
        pushLog(st, 'skill', `${p.name} 因【乱武】对 ${victim.name} 使用了【杀】。`);
        api.useShaOn(p.seatId, victim.seatId, card, {
          after: () => luanwuStep(st, jia, queue, i + 1, api),
        });
      };
      api.askPickCards(
        st,
        p.seatId,
        '【乱武】：选择一张【杀】',
        usableShaCards(st, p),
        1,
        1,
        (st2, p2, chosen) => {
          const card = chosen[0];
          if (!card) {
            next();
            return;
          }
          if (inRange.length === 1) {
            useOn(card, inRange[0]!);
            return;
          }
          api.askChoice(
            st2,
            p2.seatId,
            '【乱武】：选择【杀】的目标',
            inRange.map((o) => ({ id: o.seatId, label: o.name })),
            (st3, _p2, targetId) => {
              const victim = getPlayer(st3, targetId);
              if (!victim) {
                next();
                return;
              }
              useOn(card, victim);
            },
            jia.seatId,
          );
        },
        { returnTo: jia.seatId },
      );
    },
    jia.seatId,
  );
}

const JIAXU: Hero = {
  id: 'jiaxu',
  name: '贾诩',
  faction: 'qun',
  maxHp: 3,
  gender: 'male',
  // 帷幕：不能被黑色锦囊牌（含延时锦囊）指定为目标
  cannotBeTargetOf: (_state, _self, card) =>
    (isInstantTrick(card) || isDelayedTrick(card)) && !isRed(card),
  lockedFields: ['cannotBeTargetOf', 'blocksExternalSaves'],
  blocksExternalSaves: true, // 完杀
  // 乱武（限定技，已核国战文本）：出牌阶段，你可以令所有其他角色依次选择一项：
  // ①对其距离最近的另一名角色使用一张【杀】；②失去 1 点体力。
  //
  // 三个要点：
  // - 「依次」= 按座次一个一个问，所以是一条续接链（每个人答完才轮到下一个人）。
  // - 「距离最近」按**这个角色自己**算（不是贾诩的），并列时他可以从中挑一个。
  // - 最近的若不在他的攻击范围内，这一项就做不了（只能失去 1 点体力）——
  //   官方 FAQ 里「因+1马导致无法指定目标」就是这种情况。失去体力是**体力流失**，
  //   不触发卖血技，所以用 api.loseHp 而不是造成伤害。
  activeSkills: [
    {
      id: 'luanwu',
      name: '乱武',
      oncePerGame: true,
      minTargets: 0,
      maxTargets: 0,
      needsCards: false,
      canUse: (state, player) => state.players.some((p) => p.alive && p.seatId !== player.seatId),
      execute: (state, player, _intent, api) => {
        // 从贾诩的下家起、按座次排出所有存活的其他角色（heroes.ts 拿不到引擎的
        // aliveSeatsFrom，就地算一份）
        const idx = state.seatOrder.indexOf(player.seatId);
        const n = state.seatOrder.length;
        const queue: string[] = [];
        for (let k = 1; k <= n; k++) {
          const sid = state.seatOrder[(idx + k) % n]!;
          if (sid === player.seatId) continue;
          if (getPlayer(state, sid)?.alive) queue.push(sid);
        }
        pushLog(state, 'skill', `${player.name} 发动【乱武】！`);
        luanwuStep(state, player, queue, 0, api);
        return undefined;
      },
    },
  ],
  skills: [
    { name: '帷幕', desc: '锁定技，你不能成为黑色锦囊牌的目标。' },
    {
      name: '完杀',
      desc: '锁定技，你的回合内，除你以外，只有处于濒死状态的角色才能使用【桃】。',
    },
    {
      name: '乱武',
      desc: '限定技，出牌阶段，你可以令所有其他角色依次选择一项：1.对其距离最近的另一名角色使用一张【杀】；2.失去1点体力。',
    },
  ],
};

const ZHANGLIAO: Hero = {
  id: 'zhangliao',
  name: '张辽',
  faction: 'wei',
  maxHp: 4,
  gender: 'male',
  // 突袭：摸牌阶段，少摸一张牌，改为获得至多两名其他角色各一张手牌。
  // 挂在 drawPhase（摸牌之前），所以它设的 drawCountDelta 会被紧接着的摸牌读到。
  hooks: [
    {
      timing: 'drawPhase',
      skillId: '突袭',
      handler: (ctx) => askTuxi(ctx),
    },
  ],
  skills: [
    {
      name: '突袭',
      desc: '摸牌阶段，你可以少摸一张牌，改为获得至多两名其他角色的各一张手牌。（拿哪一张由你选）',
    },
  ],
};

const LIUBEI: Hero = {
  id: 'liubei',
  name: '刘备',
  faction: 'shu',
  maxHp: 4,
  gender: 'male',
  // 同上：摘掉 isLord（官方国战刘备是普通武将，君主另有「君刘备」）
  combos: ['guanyu', 'zhangfei'], // 刘备 ❤ 关羽、张飞
  // 激将：需要打出【杀】时，可以令其他蜀势力角色代打（势力技）
  factionCall: { id: 'jijiang', name: '激将', needType: 'sha' },
  //
  // 仁德：出牌阶段，可以把任意张手牌交给一名其他角色；
  // 本阶段给出的牌**首次达到两张**时回复 1 点体力。
  activeSkills: [
    {
      id: 'rende',
      name: '仁德',
      // 官方不限次数（可以分几次给），所以不设 oncePerTurn
      minTargets: 1,
      maxTargets: 1,
      needsCards: true,
      canUse: (state, player) =>
        player.hand.length > 0 && state.players.some((p) => p.alive && p.seatId !== player.seatId),
      execute: (state, player, intent, api) => {
        const ids = intent.cardIds ?? [];
        if (ids.length === 0) return '请选择要交出的手牌';
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名其他角色';
        if (targetId === player.seatId) return '不能选择自己';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        const given: Card[] = [];
        for (const id of ids) {
          const c = removeCard(player.hand, id);
          if (!c) return `找不到手牌 ${id}`;
          given.push(c);
        }
        for (const c of given) target.hand.push(c);
        pushLog(
          state,
          'skill',
          `${player.name} 发动【仁德】，将 ${given.length} 张手牌交给 ${target.name}。`,
        );
        // 本阶段给出的牌首次达到两张 → 回复 1 点体力（只回一次）
        const total = (player.flags.skillNumbers.rende_given ?? 0) + given.length;
        player.flags.skillNumbers.rende_given = total;
        if (total >= 2 && !player.flags.skillUsedThisTurn.rende_healed) {
          player.flags.skillUsedThisTurn.rende_healed = true;
          const healed = api.heal(player, 1);
          pushLog(
            state,
            'skill',
            `【仁德】本阶段给出的牌达到两张，${player.name} 回复 ${healed} 点体力。`,
          );
        }
        return undefined;
      },
    },
  ],
  skills: [
    {
      name: '仁德',
      desc: '出牌阶段，你可以将任意张手牌交给一名其他角色。若你于此阶段内给出的牌首次达到两张，你回复 1 点体力。',
    },
    {
      name: '激将',
      desc: '势力技，当你需要使用或打出一张【杀】时，你可以令其他蜀势力角色选择是否打出一张【杀】（视为由你使用或打出）。',
    },
  ],
};

/** 手里有没有两张花色相同的牌（乱击的可用性判断） */
function hasSameSuitPair(hand: Card[]): boolean {
  const seen = new Set<string>();
  for (const c of hand) {
    if (seen.has(c.suit)) return true;
    seen.add(c.suit);
  }
  return false;
}

const YUANSHAO: Hero = {
  id: 'yuanshao',
  name: '袁绍',
  faction: 'qun',
  maxHp: 4,
  gender: 'male',
  // 乱击：出牌阶段，可以将两张花色相同的手牌当【万箭齐发】使用。
  // 注意：身份局里他还有主公技【血裔】，国战里他不是君主，所以这里不收录。
  activeSkills: [
    {
      id: 'luanji',
      name: '乱击',
      minTargets: 0,
      maxTargets: 0,
      needsCards: true,
      maxCards: () => 2,
      canUse: (_state, player) => hasSameSuitPair(player.hand),
      execute: (state, player, intent, api) => {
        const ids = intent.cardIds ?? [];
        if (ids.length !== 2) return '请选择两张花色相同的手牌';
        const cards = ids.map((id) => player.hand.find((c) => c.id === id));
        if (cards.some((c) => !c)) return '找不到手牌';
        const [c1, c2] = cards as [Card, Card];
        if (c1.suit !== c2.suit) return '两张牌的花色必须相同';
        for (const c of [c1, c2]) {
          removeCard(player.hand, c.id);
          toDiscard(state, c);
        }
        pushLog(
          state,
          'skill',
          `${player.name} 发动【乱击】，弃置【${cardLabel(c1)}】【${cardLabel(c2)}】，视为使用【万箭齐发】。`,
        );
        // 虚拟锦囊走统一入口；花色沿用弃掉的那两张（帷幕那类要看花色）
        api.castVirtualTrick(player.seatId, { type: 'wanjian', suit: c1.suit });
      },
    },
  ],
  skills: [
    {
      name: '乱击',
      desc: '出牌阶段，你可以将两张花色相同的手牌当【万箭齐发】使用。',
    },
  ],
};

const CAOREN: Hero = {
  id: 'caoren',
  name: '曹仁',
  faction: 'wei',
  maxHp: 4,
  gender: 'male',
  // 据守：结束阶段摸三张牌，然后把武将牌翻面（翻面的代价由 startTurn 处理：跳过下一个回合）
  hooks: [
    {
      timing: 'turnEnd',
      skillId: '据守',
      handler: (ctx) => {
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【据守】？',
          [
            { id: 'yes', label: '发动（摸三张牌，然后翻面）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            let got = 0;
            for (let i = 0; i < 3; i++) {
              const c = drawOne(st);
              if (!c) break;
              p.hand.push(c);
              got++;
            }
            p.flipped = true;
            pushLog(st, 'skill', `${p.name} 发动【据守】，摸 ${got} 张牌并翻面。`);
          },
        );
      },
    },
  ],
  skills: [{ name: '据守', desc: '结束阶段，你可以摸三张牌，然后将你的武将牌翻面。' }],
};

const DIANWEI: Hero = {
  id: 'dianwei',
  name: '典韦',
  faction: 'wei',
  maxHp: 4,
  gender: 'male',
  // 强袭：出牌阶段限一次，弃一张武器牌或失去 1 点体力，然后对攻击范围内的一名其他角色造成 1 点伤害
  activeSkills: [
    {
      id: 'qiangxi',
      name: '强袭',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      canUse: (state, player) =>
        (player.hp > 1 || !!player.equipment.weapon) &&
        state.players.some(
          (p) => p.alive && p.seatId !== player.seatId && canTarget(state, player.seatId, p.seatId),
        ),
      execute: (state, player, intent, api) => {
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名目标';
        if (targetId === player.seatId) return '不能选择自己';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        if (!canTarget(state, player.seatId, targetId)) return '目标超出攻击范围';
        const weapon = player.equipment.weapon;
        const options: { id: string; label: string }[] = [];
        if (player.hp > 1) options.push({ id: 'loseHp', label: '失去 1 点体力' });
        if (weapon) options.push({ id: 'weapon', label: `弃置武器【${cardLabel(weapon)}】` });
        if (options.length === 0) return '没有可支付的代价';
        api.askChoice(state, player.seatId, '【强袭】：选择代价', options, (st, p, picked) => {
          if (picked === 'weapon') {
            const w = p.equipment.weapon;
            if (!w) return;
            // 走 discardCard：弃装备要触发枭姬那类技能
            api.discardCard(p.seatId, w, () => {
              pushLog(st, 'skill', `${p.name} 发动【强袭】，弃置武器【${cardLabel(w)}】。`);
              api.dealDamage(target, 1, p.seatId);
            });
            return;
          }
          pushLog(st, 'skill', `${p.name} 发动【强袭】，失去 1 点体力。`);
          api.loseHp(p, 1);
          api.dealDamage(target, 1, p.seatId);
        });
      },
    },
  ],
  skills: [
    {
      name: '强袭',
      desc: '出牌阶段限一次，你可以弃置一张武器牌或失去 1 点体力，然后对你攻击范围内的一名其他角色造成 1 点伤害。',
    },
  ],
};

const XUNYU: Hero = {
  id: 'xunyu',
  name: '荀彧',
  faction: 'wei',
  maxHp: 3,
  gender: 'male',
  // 驱虎：与一名体力值大于你的角色拼点。赢了 → 该角色对其攻击范围内你指定的一名角色造成 1 点伤害；
  //       没赢 → 该角色对你造成 1 点伤害。
  // 节命：受到伤害后，令一名角色把牌补到体力上限（至多五张）。
  activeSkills: [
    {
      id: 'quhu',
      name: '驱虎',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      canUse: (state, player) =>
        player.hand.length > 0 &&
        state.players.some(
          (p) => p.alive && p.seatId !== player.seatId && p.hp > player.hp && p.hand.length > 0,
        ),
      execute: (state, player, intent, api) => {
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名体力值大于你的角色';
        if (targetId === player.seatId) return '不能选择自己';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        if (target.hp <= player.hp) return '目标体力值须大于你';
        if (target.hand.length === 0) return '该角色没有手牌，无法拼点';
        api.pindian(player.seatId, targetId, (st, winner) => {
          if (winner !== player.seatId) {
            pushLog(
              st,
              'skill',
              `${player.name} 的【驱虎】拼点未获胜，受到 ${target.name} 造成的 1 点伤害。`,
            );
            api.dealDamage(player, 1, target.seatId);
            return;
          }
          // 赢了：该角色对其攻击范围内、由荀彧指定的一名角色造成 1 点伤害
          const reachable = st.players.filter(
            (p) => p.alive && canTarget(st, target.seatId, p.seatId),
          );
          if (reachable.length === 0) {
            pushLog(st, 'skill', `${target.name} 攻击范围内没有角色，【驱虎】无效果。`);
            return;
          }
          api.askChoice(
            st,
            player.seatId,
            `【驱虎】：令 ${target.name} 对其攻击范围内的一名角色造成 1 点伤害`,
            reachable.map((p) => ({ id: p.seatId, label: p.name })),
            (st2, _p, victimId) => {
              const victim = getPlayer(st2, victimId);
              if (!victim) return;
              pushLog(st2, 'skill', `${target.name} 对 ${victim.name} 造成 1 点伤害（【驱虎】）。`);
              api.dealDamage(victim, 1, target.seatId);
            },
          );
        });
      },
    },
  ],
  hooks: [
    {
      timing: 'afterDamage',
      skillId: '节命',
      handler: (ctx) => {
        const payload = ctx.payload as { damage?: number } | undefined;
        // 【节命】官方触发词是「当你受到**1点**伤害后」：一次受到 2 点要**依次触发两次**
        // （官方攻略明确：可以依次发动多次，甚至可以分别选不同目标）。
        // ⚠️ 与遗计/放逐/反馈/智愚/恩怨/刚烈那几条「当你受到伤害后」**不同**——那些只触发一次，
        //    现行国战文本（含 2025-09-19 调整）已确认，别一起改。
        const points = payload?.damage ?? 0;
        if (points <= 0) return;
        const others = ctx.state.players.filter((p) => p.alive);
        if (others.length === 0) return;
        const step = (st0: GameState, left: number): void => {
          if (left <= 0) return;
          ctx.api.askChoice(
            st0,
            ctx.player.seatId,
            left > 1 ? `是否发动【节命】？（本笔伤害还剩 ${left} 点）` : '是否发动【节命】？',
            [
              { id: 'yes', label: '发动（令一名角色把牌补到体力上限）' },
              { id: 'no', label: '不发动' },
            ],
            (st, p, picked) => {
              if (picked !== 'yes') {
                step(st, left - 1); // 每一点各自「可以」：这一点不发，后面照问
                return;
              }
              ctx.api.askChoice(
                st,
                p.seatId,
                '【节命】：选择要让谁补牌',
                st.players.filter((x) => x.alive).map((x) => ({ id: x.seatId, label: x.name })),
                (st2, _p2, whoId) => {
                  const who = getPlayer(st2, whoId);
                  if (who) {
                    const limit = Math.min(5, who.maxHp);
                    let got = 0;
                    while (who.hand.length < limit) {
                      const c = drawOne(st2);
                      if (!c) break;
                      who.hand.push(c);
                      got++;
                    }
                    pushLog(
                      st2,
                      'skill',
                      `${p.name} 发动【节命】，${who.name} 补了 ${got} 张牌（至 ${limit} 张）。`,
                    );
                  }
                  step(st2, left - 1);
                },
              );
            },
          );
        };
        step(ctx.state, points);
      },
    },
  ],
  skills: [
    {
      name: '驱虎',
      desc: '出牌阶段限一次，你可以与一名体力值大于你的角色拼点：若你赢，该角色对其攻击范围内由你指定的一名角色造成 1 点伤害；若你没赢，该角色对你造成 1 点伤害。',
    },
    {
      name: '节命',
      desc: '当你受到伤害后，你可以令一名角色将手牌补至 X 张（X 为其体力上限且至多 5 张）。',
    },
  ],
};

const CAOPI: Hero = {
  id: 'caopi',
  name: '曹丕',
  faction: 'wei',
  maxHp: 3,
  gender: 'male',
  hooks: [
    // 行殇：当你杀死一名角色后，你可以获得其所有牌。
    // 挂在 `kill` 时机上（派发给**凶手**），而且必须在死者的牌被清进弃牌堆之前——
    // 所以 engine.doDeath 里是「先跑 kill 钩子、再清牌」。
    {
      timing: 'kill',
      skillId: '行殇',
      handler: (ctx) => {
        const payload = ctx.payload as { victimId?: string } | undefined;
        const victim = payload?.victimId ? getPlayer(ctx.state, payload.victimId) : undefined;
        if (!victim) return;
        const total = handAndEquipOf(victim).length + victim.judgment.length;
        if (total === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `是否发动【行殇】获得 ${victim.name} 的所有牌？`,
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            let got = 0;
            for (const c of [...victim.hand]) {
              removeCard(victim.hand, c.id);
              p.hand.push(c);
              got++;
            }
            const eq = victim.equipment;
            for (const slot of EQUIP_SLOTS) {
              const c = eq[slot];
              if (c) {
                eq[slot] = null;
                p.hand.push(c);
                got++;
              }
            }
            for (const c of [...victim.judgment]) {
              removeCard(victim.judgment, c.id);
              p.hand.push(c);
              got++;
            }
            pushLog(st, 'skill', `${p.name} 发动【行殇】，获得 ${victim.name} 的 ${got} 张牌。`);
          },
        );
      },
    },
    // 放逐：受到伤害后，令一名其他角色摸 X 张牌然后翻面（X = 你已损失的体力值）
    {
      timing: 'afterDamage',
      skillId: '放逐',
      handler: (ctx) => {
        const payload = ctx.payload as { damage?: number } | undefined;
        if (!payload?.damage) return;
        const lost = ctx.player.maxHp - ctx.player.hp;
        if (lost <= 0) return;
        const others = ctx.state.players.filter((p) => p.alive && p.seatId !== ctx.player.seatId);
        if (others.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【放逐】？',
          [
            { id: 'yes', label: `发动（令一名其他角色摸 ${lost} 张牌并翻面）` },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.askChoice(
              st,
              p.seatId,
              `【放逐】：令谁摸 ${lost} 张牌并翻面？`,
              others.map((o) => ({ id: o.seatId, label: o.name })),
              (st2, _p2, whoId) => {
                const who = getPlayer(st2, whoId);
                if (!who) return;
                let got = 0;
                for (let i = 0; i < lost; i++) {
                  const c = drawOne(st2);
                  if (!c) break;
                  who.hand.push(c);
                  got++;
                }
                who.flipped = true;
                pushLog(st2, 'skill', `${p.name} 发动【放逐】，${who.name} 摸 ${got} 张牌并翻面。`);
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    { name: '行殇', desc: '当你杀死一名角色后，你可以获得其所有牌。' },
    {
      name: '放逐',
      desc: '当你受到伤害后，你可以令一名其他角色摸 X 张牌，然后将武将牌翻面（X 为你已损失的体力值）。',
    },
  ],
};

const XIAHOUYUAN: Hero = {
  id: 'xiahouyuan',
  name: '夏侯渊',
  faction: 'wei',
  maxHp: 4,
  gender: 'male',
  // 神速：二选一——①跳过判定与摸牌阶段 ②跳过出牌阶段并弃一张装备牌；
  // 无论选哪个，都视为对一名其他角色使用一张【杀】。
  //
  // 在准备阶段（turnStart）声明：所以代价都是设标记，由后面的阶段自己去读。
  hooks: [
    {
      timing: 'turnStart',
      skillId: '神速',
      handler: (ctx) => {
        const player = ctx.player;
        const slots = EQUIP_SLOTS.filter((s) => player.equipment[s]);
        const targets = ctx.state.players.filter((p) => p.alive && p.seatId !== player.seatId);
        if (targets.length === 0) return;
        const options: { id: string; label: string }[] = [
          { id: 'skip', label: '跳过判定阶段与摸牌阶段' },
        ];
        if (slots.length > 0) {
          options.push({ id: 'discard', label: '跳过出牌阶段并弃置一张装备牌' });
        }
        options.push({ id: 'no', label: '不发动' });
        ctx.api.askChoice(
          ctx.state,
          player.seatId,
          '是否发动【神速】？',
          options,
          (st, p, picked) => {
            if (picked === 'no') return;
            ctx.api.askChoice(
              st,
              p.seatId,
              '【神速】：选择【杀】的目标',
              targets.map((t) => ({ id: t.seatId, label: t.name })),
              (st2, p2, targetId) => {
                if (picked === 'skip') {
                  p2.flags.skipJudgment = true;
                  p2.flags.skipDraw = true;
                } else {
                  p2.flags.skipPlay = true;
                }
                const fireSha = (): void =>
                  ctx.api.castVirtualSha(p2.seatId, targetId, { logKind: 'skill' });
                if (picked !== 'discard') {
                  fireSha();
                  return;
                }
                // 还要先弃一张装备牌
                const nowSlots = EQUIP_SLOTS.filter((s) => p2.equipment[s]);
                ctx.api.askChoice(
                  st2,
                  p2.seatId,
                  '【神速】：弃置哪张装备牌？',
                  nowSlots.map((s) => ({ id: s, label: cardLabel(p2.equipment[s]!) })),
                  (st3, p3, slot) => {
                    const card = p3.equipment[slot as (typeof EQUIP_SLOTS)[number]];
                    if (!card) {
                      fireSha();
                      return;
                    }
                    ctx.api.discardCard(p3.seatId, card, fireSha);
                  },
                );
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '神速',
      desc: '你可以选择一项：1.跳过判定阶段和摸牌阶段；2.跳过出牌阶段并弃置一张装备牌。若你如此做，你视为对一名其他角色使用一张【杀】。',
    },
  ],
};

/** 装备槽清单（顺序即界面上的顺序）。新增槽位只改这里，别在各处再写字面量数组。 */
export const EQUIP_SLOTS = ['weapon', 'armor', 'plusMount', 'minusMount', 'treasure'] as const;

/**
 * 「移动场上的一张牌」（吕蒙·谋断 / 张郃·巧变）。
 *
 * 两步询问：先选场上的一张牌（各角色装备区 4 槽 + 判定区），再选移给谁。
 * 牌的搬运与随之而来的「失去装备」触发都交给 `api.moveFieldCard`——
 * heroes 层拿不到 fireEquipLost，所以这段必须在引擎里。
 *
 * 没有可移动的牌、或没有别人可移时就什么都不问（静默跳过）。
 */
function askMoveFieldCard(ctx: HookContext, skillName: string): void {
  const state = ctx.state;
  const player = ctx.player;
  const entries: { card: Card; ownerSeatId: string; label: string }[] = [];
  for (const p of state.players) {
    if (!p.alive) continue;
    for (const slot of EQUIP_SLOTS) {
      const c = p.equipment[slot];
      if (c)
        entries.push({
          card: c,
          ownerSeatId: p.seatId,
          label: `${p.name} 装备区的【${cardLabel(c)}】`,
        });
    }
    for (const c of p.judgment) {
      entries.push({
        card: c,
        ownerSeatId: p.seatId,
        label: `${p.name} 判定区的【${cardLabel(c)}】`,
      });
    }
  }
  if (entries.length === 0) return;
  if (state.players.filter((p) => p.alive).length < 2) return;
  const options = entries.map((e) => ({ id: e.card.id, label: `移动 ${e.label}` }));
  options.push({ id: 'no', label: '不发动' });
  ctx.api.askChoice(
    state,
    player.seatId,
    `是否发动【${skillName}】移动场上的一张牌？`,
    options,
    (st, _p, picked) => {
      if (picked === 'no') return;
      const entry = entries.find((e) => e.card.id === picked);
      if (!entry) return;
      // 移到**别人**的区域去——移给自己等于没动
      const candidates = st.players.filter((x) => x.alive && x.seatId !== entry.ownerSeatId);
      if (candidates.length === 0) return;
      ctx.api.askChoice(
        st,
        player.seatId,
        `【${skillName}】：把【${cardLabel(entry.card)}】移到谁的对应区域？`,
        candidates.map((x) => ({ id: x.seatId, label: x.name })),
        (st2, _p2, seatId) => {
          ctx.api.moveFieldCard(entry.card, seatId);
        },
      );
    },
  );
}

/** 巧变能跳过的阶段（官方把准备阶段与结束阶段排除在外） */
type QiaobianPhase = 'judgment' | 'draw' | 'play' | 'discard';

const QIAOBIAN_PHASE_NAME: Record<QiaobianPhase, string> = {
  judgment: '判定阶段',
  draw: '摸牌阶段',
  play: '出牌阶段',
  discard: '弃牌阶段',
};

/**
 * 巧变：弃置一张手牌，跳过当前这个阶段。
 *
 * 四个阶段各挂一个钩子，钩子问的时机就是**该阶段一开始**——所以同一回合里
 * 每个阶段都能各自决定跳不跳（各付一张手牌），两个奖励也各自只在跳过对应阶段时给。
 * 这里只负责收代价、设标记、发奖励；标记由各阶段的收尾逻辑去读
 * （engine.ts 的 startJudgmentPhase / doDrawPhase / enterPlayPhase / goToDiscardPhase）。
 *
 * ⚠️ 奖励必须在**设完标记之后**再跑：拿手牌和移动场上的牌都会挂起询问，
 *    要是等询问回来才设标记，这个阶段可能已经带着旧标记走过去了。
 */
function qiaobianAsk(ctx: HookContext, phase: QiaobianPhase): void {
  const state = ctx.state;
  const player = ctx.player;
  if (player.hand.length === 0) return; // 没手牌可弃，问了也发动不了
  const bonus =
    phase === 'draw'
      ? '，并获得至多两名角色各一张手牌'
      : phase === 'play'
        ? '，并移动场上的一张牌'
        : '';
  ctx.api.askChoice(
    state,
    player.seatId,
    `是否发动【巧变】弃置一张手牌，跳过${QIAOBIAN_PHASE_NAME[phase]}${bonus}？`,
    [
      { id: 'yes', label: '发动' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      ctx.api.askPickCards(
        st,
        p.seatId,
        '【巧变】：弃置一张手牌',
        p.hand.slice(),
        1,
        1,
        (st2, p2, chosen) => {
          const card = chosen[0];
          if (!card) return; // 上面已保证手牌非空，走不到；真弃不了就当没发动
          ctx.api.discardCard(p2.seatId, card, () => {
            pushLog(
              st2,
              'skill',
              `${p2.name} 发动【巧变】，弃置一张手牌跳过${QIAOBIAN_PHASE_NAME[phase]}。`,
            );
            switch (phase) {
              case 'judgment':
                p2.flags.skipJudgment = true;
                return;
              case 'discard':
                p2.flags.skipDiscard = true;
                return;
              case 'draw':
                p2.flags.skipDraw = true;
                // 「若你以此法跳过摸牌阶段」——和突袭同一套拿牌流程，只是不用少摸牌
                tuxiAskTargets(st2, p2, [], ctx.api, '巧变');
                return;
              case 'play':
                p2.flags.skipPlay = true;
                askMoveFieldCard(ctx, '巧变');
                return;
            }
          });
        },
      );
    },
  );
}

const YUEJIN: Hero = {
  id: 'yuejin',
  name: '乐进',
  faction: 'wei',
  maxHp: 4,
  gender: 'male',
  // 骁果：**其他角色**的结束阶段，弃一张基本牌，令该角色二选一（弃一张装备牌 / 受你 1 点伤害）
  hooks: [
    {
      timing: 'othersTurnEnd',
      skillId: '骁果',
      handler: (ctx) => {
        const payload = ctx.payload as { turnSeatId?: string } | undefined;
        const turnP = payload?.turnSeatId ? getPlayer(ctx.state, payload.turnSeatId) : undefined;
        if (!turnP || !turnP.alive) return;
        const basics = ctx.player.hand.filter((c) => isBasicCard(c));
        if (basics.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `是否发动【骁果】弃一张基本牌，令 ${turnP.name} 弃装备或受伤？`,
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.askPickCards(
              st,
              p.seatId,
              '【骁果】：弃置一张基本牌',
              p.hand.filter((c) => isBasicCard(c)),
              1,
              1,
              (st2, p2, chosen) => {
                const c = chosen[0];
                if (!c) return;
                ctx.api.discardCard(p2.seatId, c, () => {
                  pushLog(st2, 'skill', `${p2.name} 发动【骁果】，弃置【${cardLabel(c)}】。`);
                  const slots = EQUIP_SLOTS.filter((s) => turnP.equipment[s]);
                  const opts: { id: string; label: string }[] = [];
                  if (slots.length > 0) opts.push({ id: 'discard', label: '弃置一张装备牌' });
                  opts.push({ id: 'damage', label: `受到 ${p2.name} 造成的 1 点伤害` });
                  ctx.api.askChoice(
                    st2,
                    turnP.seatId,
                    `${p2.name} 的【骁果】：请选择一项`,
                    opts,
                    (st3, p3, choice) => {
                      if (choice === 'damage') {
                        ctx.api.dealDamage(p3, 1, p2.seatId);
                        return;
                      }
                      const nowSlots = EQUIP_SLOTS.filter((s) => p3.equipment[s]);
                      if (nowSlots.length === 0) {
                        pushLog(st3, 'skill', `${p3.name} 没有装备牌可弃，改为受到 1 点伤害。`);
                        ctx.api.dealDamage(p3, 1, p2.seatId);
                        return;
                      }
                      ctx.api.askChoice(
                        st3,
                        p3.seatId,
                        '【骁果】：弃置哪张装备牌？',
                        nowSlots.map((s) => ({ id: s, label: cardLabel(p3.equipment[s]!) })),
                        (st4, p4, slot) => {
                          const card = p4.equipment[slot as (typeof EQUIP_SLOTS)[number]];
                          if (!card) return;
                          ctx.api.discardCard(p4.seatId, card, () => {
                            pushLog(st4, 'skill', `${p4.name} 弃置了装备【${cardLabel(card)}】。`);
                          });
                        },
                      );
                    },
                  );
                });
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '骁果',
      desc: '其他角色的结束阶段，你可以弃置一张基本牌，令该角色选择一项：弃置一张装备牌，或受到你造成的 1 点伤害。',
    },
  ],
};

const XUHUANG: Hero = {
  id: 'xuhuang',
  name: '徐晃',
  faction: 'wei',
  maxHp: 4,
  gender: 'male',
  // 断粮：黑色基本牌或黑色装备牌当【兵粮寸断】
  //
  // ⚠️ 界面限制：黑色【杀】【装备】本来就能直接使用，而界面的用法选择只会对
  // 「不能直接使用」的牌给转化（甘宁·奇袭、大乔·国色也一直如此），
  // 所以目前只有黑色【闪】【桃】这类会走断粮。要完整支持得给界面加「选择用法」。
  canUseAs: (card, type) =>
    type === 'bingliang' && !isRed(card) && (isBasicCard(card) || isEquipCard(card)),
  skillFields: { 断粮: ['canUseAs'] },
  skills: [
    {
      name: '断粮',
      desc: '你可以将一张黑色基本牌或黑色装备牌当【兵粮寸断】使用。',
    },
  ],
};

const WOLONG: Hero = {
  id: 'wolong',
  name: '卧龙诸葛亮',
  faction: 'shu',
  // ⚠️ 国战体力其实是 1.5 阴阳鱼（官方国战牌印的体力与身份局不同），
  //    这里先按身份局的 3——国战体力值需要一次专门的数据核对（见文档）。
  maxHp: 3,
  gender: 'male',
  combos: ['huangyueying', 'pangtong'],
  // 八阵：锁定技，装备区没有防具牌时视为装备着【八卦阵】
  hasBaguaAlways: true,
  lockedFields: ['hasBaguaAlways'],
  // 火计：红色手牌当【火攻】；看破：黑色手牌当【无懈可击】
  canUseAs: (card, type) =>
    (type === 'huogong' && isRed(card)) || (type === 'wuxie' && !isRed(card)),
  skillFields: { 火计: ['canUseAs'], 看破: ['canUseAs'] },
  skills: [
    { name: '八阵', desc: '锁定技，若你的装备区没有防具牌，视为你装备着【八卦阵】。' },
    { name: '火计', desc: '你可以将一张红色手牌当【火攻】使用。' },
    { name: '看破', desc: '你可以将一张黑色手牌当【无懈可击】使用。' },
  ],
};

const ZHURONG: Hero = {
  id: 'zhurong',
  name: '祝融',
  faction: 'shu',
  maxHp: 4,
  gender: 'female',
  // 巨象（锁定技，已核文本）：【南蛮入侵】对你无效；**其他角色**使用的【南蛮入侵】
  // 结算结束后，你获得之（前提是那张牌还在弃牌堆里——曹操·奸雄那类先收走就没有了）。
  immuneToNanman: true,
  gainsUsedNanman: true,
  lockedFields: ['immuneToNanman', 'gainsUsedNanman'],
  skillFields: { 巨象: ['immuneToNanman', 'gainsUsedNanman'] },
  // 烈刃：你使用【杀】对目标造成伤害后，可以与其拼点，若你赢则获得其一张牌。
  hooks: [
    {
      timing: 'afterDamageDealt',
      skillId: '烈刃',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
        if (!payload?.attack || !payload.damage) return;
        if (payload.attack.asType !== 'sha') return;
        const target = getPlayer(ctx.state, payload.attack.targetId);
        if (!target || !target.alive || target.seatId === ctx.player.seatId) return;
        if (ctx.player.hand.length === 0 || target.hand.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `是否发动【烈刃】与 ${target.name} 拼点？`,
          [
            { id: 'yes', label: '发动' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.pindian(p.seatId, target.seatId, (st2, winner) => {
              if (winner !== p.seatId) {
                pushLog(st2, 'skill', `${p.name} 的【烈刃】拼点未获胜。`);
                return;
              }
              const cards = handAndEquipOf(target);
              if (cards.length === 0) return;
              ctx.api.askPickCards(
                st2,
                p.seatId,
                `【烈刃】：选择获得 ${target.name} 的一张牌`,
                cards,
                1,
                1,
                (st3, p3, chosen) => {
                  const card = chosen[0];
                  if (!card) return;
                  ctx.api.transferCard(target.seatId, card, p3.seatId, () => {
                    pushLog(
                      st3,
                      'skill',
                      `${p3.name} 的【烈刃】拼点获胜，获得 ${target.name} 的一张牌。`,
                    );
                  });
                },
              );
            });
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '巨象',
      desc: '锁定技，【南蛮入侵】对你无效；其他角色使用的【南蛮入侵】结算结束后，你获得之。',
    },
    {
      name: '烈刃',
      desc: '当你使用【杀】对目标角色造成伤害后，你可以与其拼点：若你赢，你获得其一张牌。',
    },
  ],
};

const GUOJIA: Hero = {
  id: 'guojia',
  name: '郭嘉',
  faction: 'wei',
  maxHp: 3,
  gender: 'male',
  hooks: [
    // 天妒：自己的判定牌生效后，你可以获得之。
    // 官方是「可以」，这里自动收取——白拿一张牌严格优于不拿，所以自动等于最优出牌。
    {
      timing: 'beforeJudge',
      skillId: '天妒',
      handler: (ctx) => {
        const payload = ctx.payload as { judgeCard?: Card; judgedId?: string } | undefined;
        if (!payload?.judgeCard) return;
        if (payload.judgedId !== ctx.player.seatId) return; // 只收**自己**的判定牌
        pushLog(ctx.state, 'skill', `${ctx.player.name} 发动【天妒】，收下这张判定牌。`, {
          seat: ctx.player.seatId,
        });
        return { gainJudgeCard: true };
      },
    },
    // 遗计：受到伤害后摸两张牌，然后可以把摸到的牌交给一名其他角色。
    // 引擎没有「受到 1 点伤害」的细分，所以按「每次伤害事件触发一次」（简化）。
    {
      timing: 'afterDamage',
      skillId: '遗计',
      handler: (ctx) => {
        const payload = ctx.payload as { damage?: number } | undefined;
        if (!payload?.damage) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【遗计】？',
          [
            { id: 'yes', label: '发动（摸两张牌）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            const drawn: Card[] = [];
            for (let i = 0; i < 2; i++) {
              const c = drawOne(st);
              if (!c) break;
              drawn.push(c);
              p.hand.push(c);
            }
            if (drawn.length === 0) return;
            pushLog(st, 'skill', `${p.name} 发动【遗计】，摸了 ${drawn.length} 张牌。`);
            if (st.players.filter((x) => x.alive && x.seatId !== p.seatId).length === 0) return;
            // 第二步：把摸到的**这两张**（官方口径）挑出来送人
            ctx.api.askPickCards(
              st,
              p.seatId,
              '【遗计】：选择要交给其他角色的牌（一张不选则全部留下）',
              drawn.slice(),
              0,
              drawn.length,
              (st2, p2, given) => {
                if (given.length === 0) return;
                // 第三步：选择交给谁
                ctx.api.askChoice(
                  st2,
                  p2.seatId,
                  `【遗计】：把 ${given.length} 张牌交给谁？`,
                  st2.players
                    .filter((x) => x.alive && x.seatId !== p2.seatId)
                    .map((x) => ({ id: x.seatId, label: x.name })),
                  (st3, p3, targetId) => {
                    const target = getPlayer(st3, targetId);
                    if (!target) return;
                    for (const c of given) {
                      removeCard(p3.hand, c.id);
                      target.hand.push(c);
                    }
                    pushLog(
                      st3,
                      'skill',
                      `${p3.name} 把 ${given.length} 张牌交给了 ${target.name}。`,
                    );
                  },
                );
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    { name: '天妒', desc: '当你的判定牌生效后，你可以获得之。' },
    {
      name: '遗计',
      desc: '当你受到伤害后，你可以摸两张牌，然后可以将摸到的牌交给一名其他角色。（国战现行规则：**按一次伤害事件**触发一次，不按点数——与节命的「受到1点伤害后」不同）',
    },
  ],
};

/**
 * 董昭·【劝进】**能否选择自己**作为目标？
 * ⚠️ 待实测项：技能文字没有「其他角色」，但动作是「交给一名角色一张手牌」，
 *    移动版没有可靠 FAQ 说明自己能不能被劝进 → 单独留成配置点（用户要求别埋进公共交出逻辑）。
 */
const QUANJIN_CAN_TARGET_SELF = false;

const DONGZHAO: Hero = {
  id: 'dongzhao',
  name: '董昭',
  faction: 'wei',
  pack: 'buchen', // 不臣篇（buchen 开关关闭时不进选将池）
  // 国战牌上印的是 **1.5 阴阳鱼**，而引擎吃的是身份局口径的体力值：
  // 阴阳鱼数 = 身份局体力 ÷ 2，所以这里要填 3（半天前填成 1.5 是错的）。
  // 校验：董昭(3) + 许褚(4) → floor(3.5) = 3，与官方「1.5+2 阴阳鱼 → 上限 3」一致。
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'], // 不臣篇是国战专属
  // 劝进：把一张手牌交给一名**当前出牌阶段**受到过伤害的角色，令其执行一次军令。
  //
  // ⚠️ 待实测项（用户 2026-09 指定）：技能文字没写「其他角色」，董昭**能否选自己**没有可靠 FAQ
  //    → 单独留成配置点，别把它埋进公共的「交给」逻辑里。当前取 false（不能选自己）。
  //    ⚠️ 另外「在当前出牌阶段受到过伤害」是**阶段**口径（不是回合），走 state.damagedThisPhase。
  // 凿运（不臣篇·上 2021，已核）：出牌阶段限一次，你可以选择一名与你势力不同且距离
  // 大于 1 的角色并弃置 X 张手牌（X 为你计算与其的距离 - 1），令你本回合计算与其的
  // 距离视为 1，然后你对其造成 1 点伤害。
  //
  // ⚠️ 代价张数看**距离**，而距离要等目标定了才知道，所以走缔盟那套：
  //    主动技只收目标，弃牌在 execute 里再问（不然界面没法告诉玩家要弃几张）。
  activeSkills: [
    {
      id: 'zaoyun',
      name: '凿运',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      needsCards: false,
      canUse: (state, player) =>
        state.players.some((p) => {
          if (!p.alive || p.seatId === player.seatId) return false;
          const f = effectiveFaction(state, p);
          // 只能选**明置**且势力不同的角色（暗将没有势力，选不了）
          if (!f || f === effectiveFaction(state, player)) return false;
          return distance(state, player.seatId, p.seatId) > 1;
        }),
      execute: (state, player, intent, api) => {
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名与你势力不同、且距离大于 1 的角色';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        if (target.seatId === player.seatId) return '不能选择自己';
        const tf = effectiveFaction(state, target);
        if (!tf) return '该角色尚未明置，无法选择（暗将没有势力）';
        if (tf === effectiveFaction(state, player)) return '只能选择与你势力不同的角色';
        const dist = distance(state, player.seatId, target.seatId);
        if (dist <= 1) return '只能选择距离大于 1 的角色';
        const cost = dist - 1;
        if (player.hand.length < cost) return `手牌不足：需要弃置 ${cost} 张（距离 ${dist}）`;
        // 顺序按官方：先弃牌 → 再把距离视为 1 → 最后造成伤害。
        // 距离标记先落，所以即使伤害被防止/转移，本回合的距离也已经拉近了。
        api.askPickCards(
          state,
          player.seatId,
          `【凿运】：弃置 ${cost} 张手牌（与 ${target.name} 距离 ${dist}，弃 ${dist} - 1 张）`,
          player.hand.slice(),
          cost,
          cost,
          (st, p, picked) => {
            for (const c of picked) {
              removeCard(p.hand, c.id);
              toDiscard(st, c);
            }
            pushLog(
              st,
              'skill',
              `${p.name} 发动【凿运】，弃置 ${picked.length} 张手牌，本回合计算与 ${target.name} 的距离视为 1。`,
            );
            p.flags.distanceToOneThisTurn = target.seatId;
            api.dealDamage(target, 1, p.seatId);
          },
          { returnTo: player.seatId },
        );
        return undefined;
      },
    },
    {
      id: 'quanjin',
      name: '劝进',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      needsCards: true,
      maxCards: () => 1,
      canUse: (state, player) =>
        player.hand.length > 0 &&
        state.players.some(
          (p) =>
            p.alive &&
            (QUANJIN_CAN_TARGET_SELF || p.seatId !== player.seatId) &&
            state.damagedThisPhase.includes(p.seatId),
        ),
      execute: (state, player, intent, api) => {
        const ids = intent.cardIds ?? [];
        if (ids.length !== 1) return '请选择要交给对方的一张手牌';
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名在当前出牌阶段受到过伤害的角色';
        if (!QUANJIN_CAN_TARGET_SELF && targetId === player.seatId) return '不能选择自己（待实测项）';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        if (!state.damagedThisPhase.includes(targetId))
          return '该角色在当前出牌阶段没有受到过伤害';
        const card = removeCard(player.hand, ids[0]!);
        if (!card) return '找不到手牌';
        target.hand.push(card);
        pushLog(
          state,
          'skill',
          `${player.name} 发动【劝进】，将【${cardLabel(card)}】交给 ${target.name} 并令其执行军令。`,
        );
        api.armyOrder(player.seatId, targetId, (st, executed) => {
          if (executed) {
            const c = drawOne(st);
            if (c) player.hand.push(c);
            pushLog(st, 'skill', `${target.name} 执行了军令，${player.name} 摸一张牌。`);
            return;
          }
          // 不执行：把手牌补到全场最多（至多摸五张）
          const most = Math.max(...st.players.filter((p) => p.alive).map((p) => p.hand.length));
          const need = Math.min(5, Math.max(0, most - player.hand.length));
          let got = 0;
          for (let i = 0; i < need; i++) {
            const c = drawOne(st);
            if (!c) break;
            player.hand.push(c);
            got++;
          }
          pushLog(
            st,
            'skill',
            `${target.name} 拒绝执行军令，${player.name} 摸 ${got} 张牌补至全场最多。`,
          );
        });
      },
    },
  ],
  skills: [
    {
      name: '劝进',
      desc: '出牌阶段限一次，你可以将一张手牌交给一名于此阶段内受到过伤害的角色，然后令其执行一次「军令」。若其执行，你摸一张牌；若其不执行，你将手牌摸至手牌数全场最多（至多摸五张）。',
    },
    {
      name: '凿运',
      desc: '出牌阶段限一次，你可以选择一名与你势力不同且距离大于1的角色并弃置X张手牌（X为你计算与其的距离-1），令你本回合计算与其的距离视为1，然后你对其造成1点伤害。',
    },
  ],
};

/**
 * 某人手里「能当【杀】用」的牌。
 *
 * 明置武将的转化技（武圣/龙胆那类）算——挑衅/乱武要的是「使用一张【杀】」，转化技合法。
 * 不含【丈八蛇矛】的两张凑一张（那要额外的 extraCardIds，留给专门的入口）。
 * ⚠️ 暗置武将的转化技不在内：暗将等于没有技能，要用就得先明置（国战语义）。
 */
function usableShaCards(state: GameState, p: Player): Card[] {
  return p.hand.filter(
    (c) =>
      c.type === 'sha' ||
      effectiveHeroes(state, p).some((h) => heroCanUseAs(h, c, 'sha', state, p)),
  );
}

/**
 * 让 `picker` 从 `target` 的牌里挑一张弃掉：装备/判定这类明牌给选项，手牌只能随机。
 * （手牌不可见，官方也是随机抽——所以不给「看看手牌再挑」的机会。）
 */
function pickOneOfTargetCards(
  state: GameState,
  picker: Player,
  target: Player,
  api: SkillApi,
  skillName = '挑衅',
  after?: () => void,
  // 凌统·旋略只能弃手牌/装备，官方明确不能动判定区
  opts?: { noJudgment?: boolean },
): void {
  const visible: Card[] = [
    ...(EQUIP_SLOTS.map((s) => target.equipment[s]).filter(Boolean) as Card[]),
    ...(opts?.noJudgment ? [] : target.judgment),
  ];
  const options: { id: string; label: string }[] = visible.map((c) => ({
    id: c.id,
    label: `弃置其【${cardLabel(c)}】`,
  }));
  if (target.hand.length > 0) {
    options.push({ id: '__hand', label: `弃置其一张手牌（随机，共 ${target.hand.length} 张）` });
  }
  if (options.length === 0) {
    pushLog(state, 'skill', `${target.name} 没有牌可以被弃置。`);
    after?.();
    return;
  }
  api.askChoice(
    state,
    picker.seatId,
    `【${skillName}】：弃置 ${target.name} 的一张牌`,
    options,
    (st, _p, picked) => {
      api.discardTargetCard(target.seatId, picked === '__hand' ? undefined : picked, after);
    },
  );
}

const JIANGWEI: Hero = {
  id: 'jiangwei',
  name: '姜维',
  faction: 'shu',
  pack: 'zhen', // zhen 包：该包开关关闭时不进选将池
  maxHp: 4,
  gender: 'male',
  // 挑衅（已核国战文本）：出牌阶段限一次，你可以令一名**攻击范围内包含你**的角色对你
  // 使用一张【杀】，否则你弃置其一张牌。
  //
  // 两步走：先问目标「对姜维使用一张【杀】 / 不（让姜维弃你一张牌）」；选前者再让他挑
  // 一张能当【杀】的牌，真打出去（api.useShaOn，走正常结算，姜维自己得出闪）；
  // 选后者由姜维挑一张牌弃掉（明牌可选、手牌随机——手牌本来就不该被看见）。
  activeSkills: [
    {
      id: 'tiaoxin',
      name: '挑衅',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      needsCards: false,
      canUse: (state, player) =>
        state.players.some(
          (p) =>
            p.alive &&
            p.seatId !== player.seatId &&
            attackRange(state, p) >= distance(state, p.seatId, player.seatId),
        ),
      execute: (state, player, intent, api) => {
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名攻击范围内包含你的角色';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        if (target.seatId === player.seatId) return '不能选择自己';
        if (attackRange(state, target) < distance(state, target.seatId, player.seatId)) {
          return '该角色的攻击范围不包含你';
        }
        const shaCards = usableShaCards(state, target);
        const options: { id: string; label: string }[] = [];
        if (shaCards.length > 0) {
          options.push({ id: 'sha', label: `对 ${player.name} 使用一张【杀】` });
        }
        options.push({ id: 'no', label: `不（${player.name} 弃置你一张牌）` });
        api.askChoice(
          state,
          target.seatId,
          `【挑衅】：${player.name} 令你选择一项`,
          options,
          (st, t, picked) => {
            if (picked === 'sha') {
              api.askPickCards(
                st,
                t.seatId,
                `【挑衅】：选择一张【杀】（对 ${player.name} 使用）`,
                usableShaCards(st, t),
                1,
                1,
                (st2, t2, chosen) => {
                  const card = chosen[0];
                  if (!card) return;
                  pushLog(st2, 'skill', `${t2.name} 因【挑衅】对 ${player.name} 使用了【杀】。`);
                  api.useShaOn(t2.seatId, player.seatId, card);
                },
                { returnTo: t.seatId },
              );
              return;
            }
            // 不出杀 → 姜维弃其一张牌
            pickOneOfTargetCards(st, player, target, api);
          },
        );
        return undefined;
      },
    },
  ],
  // 志继：觉醒技，准备阶段，若你没有手牌，你减 1 点体力上限并获得【观星】。
  //
  // 觉醒技按定义就是锁定技，满足条件**必须**发动，所以这里不问、直接结算。
  // 获得【观星】走 api.grantSkill——从诸葛亮身上把那个 turnStart 钩子摘过来。
  hooks: [
    {
      timing: 'turnStart',
      skillId: '志继',
      locked: true,
      handler: (ctx) => {
        if (ctx.player.usedOncePerGame.zhiji) return;
        if (ctx.player.hand.length > 0) return;
        ctx.player.usedOncePerGame.zhiji = true;
        ctx.api.changeMaxHp(ctx.player, -1);
        ctx.api.grantSkill('zhugeliang', '观星');
        pushLog(
          ctx.state,
          'skill',
          `${ctx.player.name} 觉醒：【志继】减 1 点体力上限并获得【观星】。`,
        );
      },
    },
  ],
  skills: [
    {
      name: '志继',
      desc: '觉醒技，准备阶段，若你没有手牌，你减 1 点体力上限并获得【观星】。',
    },
    {
      name: '挑衅',
      desc: '出牌阶段限一次，你可以令一名攻击范围内包含你的角色对你使用一张【杀】，否则你弃置其一张牌。',
    },
  ],
};

const LIUSHAN: Hero = {
  id: 'liushan',
  name: '刘禅',
  faction: 'shu',
  maxHp: 4,
  gender: 'male',
  // 享乐（锁定技，已核国战文本）：当你成为一名角色使用【杀】的目标后，
  // 除非其弃置一张基本牌，否则令此【杀】对你无效。
  // 由 engine 的 afterShaTargetResolve 在「防具之前」问使用者（雌雄双股剑之后）。
  xingleBasicDiscard: true,
  lockedFields: ['xingleBasicDiscard'],
  skillFields: { 享乐: ['xingleBasicDiscard'] },
  //
  // 放权：结束阶段，你可以弃置一张手牌，令一名其他角色进行一个额外的回合
  hooks: [
    {
      timing: 'turnEnd',
      skillId: '放权',
      handler: (ctx) => {
        const self = ctx.player;
        if (self.hand.length === 0) return;
        if (ctx.state.players.filter((x) => x.alive && x.seatId !== self.seatId).length === 0)
          return;
        ctx.api.askChoice(
          ctx.state,
          self.seatId,
          '是否发动【放权】？',
          [
            { id: 'yes', label: '发动（弃一张手牌，令一名其他角色获得额外回合）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.askPickCards(
              st,
              p.seatId,
              '【放权】：选择要弃置的一张手牌',
              p.hand.slice(),
              1,
              1,
              (st2, p2, chosen) => {
                for (const c of chosen) {
                  removeCard(p2.hand, c.id);
                  toDiscard(st2, c);
                }
                pushLog(st2, 'skill', `${p2.name} 发动【放权】，弃置了 ${chosen.length} 张手牌。`);
                ctx.api.askChoice(
                  st2,
                  p2.seatId,
                  '【放权】：令谁进行一个额外的回合？',
                  st2.players
                    .filter((x) => x.alive && x.seatId !== p2.seatId)
                    .map((x) => ({ id: x.seatId, label: x.name })),
                  (st3, _p3, targetId) => {
                    const t = getPlayer(st3, targetId);
                    if (!t) return;
                    st3.extraTurns.push(targetId);
                    pushLog(st3, 'skill', `【放权】：${t.name} 将进行一个额外的回合。`);
                  },
                );
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '放权',
      desc: '结束阶段，你可以弃置一张手牌，令一名其他角色进行一个额外的回合。',
    },
    {
      name: '享乐',
      desc: '锁定技，当你成为一名角色使用【杀】的目标后，除非其弃置一张基本牌，否则令此【杀】对你无效。',
    },
  ],
};

const PANGTONG: Hero = {
  id: 'pangtong',
  name: '庞统',
  faction: 'shu',
  maxHp: 3,
  gender: 'male',
  // 连环：你可以将一张**梅花手牌**当【铁索连环】使用或重铸。
  // 「或重铸」那半边不用另写：引擎只要看到「这张牌能当可重铸的牌型用」就允许重铸
  // （见 engine.ts 的 canRecastCard / onRecast）。
  canUseAs: (card, type) => type === 'tiesuo' && card.suit === 'club',
  //
  // 涅槃：限定技，濒死时弃置所有牌、摸三张、体力回复至 3。
  // 它不在出牌阶段，所以不能用 activeSkills 的 oncePerGame，
  // 而是挂 nearDeath 钩子 + 自己读写 player.usedOncePerGame。
  hooks: [
    {
      timing: 'nearDeath',
      skillId: '涅槃',
      handler: (ctx) => {
        if (ctx.player.usedOncePerGame.niepan) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动限定技【涅槃】？',
          [
            { id: 'yes', label: '发动（弃置所有牌，摸三张，体力回复至 3）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            p.usedOncePerGame.niepan = true;
            // 弃置区域里的所有牌
            const all: Card[] = [...p.hand];
            const eq = p.equipment;
            for (const c of EQUIP_SLOTS.map((s) => eq[s])) {
              if (c) all.push(c);
            }
            all.push(...p.judgment);
            p.hand = [];
            p.equipment = emptyEquipment();
            p.judgment = [];
            for (const c of all) toDiscard(st, c);
            // 摸三张 + 体力回复至 3
            const drawn: Card[] = [];
            for (let i = 0; i < 3; i++) {
              const c = drawOne(st);
              if (!c) break;
              drawn.push(c);
              p.hand.push(c);
            }
            const before = p.hp;
            // 「回复至 3 点」= 回复 (3 - 当前体力) 点，所以走 api.heal 让「回复体力后」也能触发
            ctx.api.heal(p, 3 - p.hp);
            pushLog(
              st,
              'skill',
              `${p.name} 发动限定技【涅槃】：弃置 ${all.length} 张牌，摸 ${drawn.length} 张，体力从 ${before} 回复至 ${p.hp}。`,
            );
          },
        );
      },
    },
  ],
  skillFields: { 连环: ['canUseAs'] },
  skills: [
    {
      name: '涅槃',
      desc: '限定技，当你处于濒死状态时，你可以弃置你区域里的所有牌，然后摸三张牌，将体力回复至 3 点。',
    },
    { name: '连环', desc: '你可以将一张梅花手牌当【铁索连环】使用或重铸。' },
  ],
};

/**
 * 甘夫人 —— 国战专属（modes: ['guozhan']）。
 *
 * 技能按**最新官方版本**（国战标准版 2018 口径）：
 * - 淑慎：当你回复 1 点体力后，你可以令一名其他角色摸一张牌。
 *   （2012 旧版限定「与你势力相同的其他角色」，新版去掉了势力限制。）
 * - 神智：准备阶段，你可以弃置所有手牌，若你以此法弃置的手牌数不小于 X，
 *   你回复 1 点体力（X 为你当前的体力值）。
 *   （注意不是「准备阶段回复 1 点」，旧记忆里的那个版本是错的。）
 */
const GANFUREN: Hero = {
  id: 'ganfuren',
  name: '甘夫人',
  faction: 'shu',
  // 牌面 1.5 阴阳鱼 → 身份局体力 3（见 docs/guozhan-roster.md §4.1）
  maxHp: 3,
  gender: 'female',
  modes: ['guozhan'],
  hooks: [
    {
      timing: 'afterHeal',
      skillId: '淑慎',
      handler: (ctx) => {
        const others = ctx.state.players.filter((p) => p.alive && p.seatId !== ctx.player.seatId);
        if (others.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【淑慎】？',
          [
            { id: 'yes', label: '发动（令一名其他角色摸一张牌）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.askChoice(
              st,
              p.seatId,
              '【淑慎】：选择摸牌的角色',
              others.map((t) => ({ id: t.seatId, label: t.name })),
              (st2, p2, targetId) => {
                const target = getPlayer(st2, targetId);
                if (!target) return;
                const c = drawOne(st2);
                if (c) target.hand.push(c);
                pushLog(st2, 'skill', `${p2.name} 发动【淑慎】，令 ${target.name} 摸一张牌。`);
              },
            );
          },
        );
      },
    },
    {
      timing: 'turnStart',
      skillId: '神智',
      handler: (ctx) => {
        const player = ctx.player;
        if (player.hand.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          player.seatId,
          `是否发动【神智】？弃置全部 ${player.hand.length} 张手牌，不少于当前体力 ${player.hp} 则回复 1 点`,
          [
            { id: 'yes', label: '发动（弃置所有手牌）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            const n = p.hand.length;
            const hpBefore = p.hp;
            for (const c of p.hand.slice()) toDiscard(st, c);
            p.hand = [];
            if (n < hpBefore) {
              pushLog(
                st,
                'skill',
                `${p.name} 发动【神智】弃置 ${n} 张手牌，少于当前体力 ${hpBefore}，不回复体力。`,
              );
              return;
            }
            // 回复走 api.heal → 会再触发自己的【淑慎】
            const healed = ctx.api.heal(p, 1);
            pushLog(st, 'skill', `${p.name} 发动【神智】，回复 ${healed} 点体力。`);
          },
        );
      },
    },
  ],
  skills: [
    { name: '淑慎', desc: '当你回复 1 点体力后，你可以令一名其他角色摸一张牌。' },
    {
      name: '神智',
      desc: '准备阶段，你可以弃置所有手牌，若你以此法弃置的手牌数不小于 X，你回复 1 点体力（X 为你当前的体力值）。',
    },
  ],
};

/**
 * 孟获 —— 国战专属（modes: ['guozhan']）。
 *
 * - 祸首：锁定技，【南蛮入侵】对你无效；当其他角色使用【南蛮入侵】时，
 *   你代替其成为此牌造成伤害的来源。
 * - 再起：**弃牌阶段结束时**，你可以令至多 X 名与你势力相同的角色各选择一项：
 *   1.摸一张牌；2.令你回复 1 点体力。
 *   **X = 本回合进入弃牌堆的红桃（♥）牌数**（按你的口径取红桃，不是红色）。
 */
const MENGHUO: Hero = {
  id: 'menghuo',
  name: '孟获',
  faction: 'shu',
  // 牌面 2 阴阳鱼 → 身份局体力 4
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  immuneToNanman: true,
  nanmanDamageSource: true,
  lockedFields: ['immuneToNanman', 'nanmanDamageSource'],
  skillFields: { 祸首: ['immuneToNanman', 'nanmanDamageSource'] },
  hooks: [
    {
      timing: 'discardPhaseEnd',
      skillId: '再起',
      handler: (ctx) => {
        const player = ctx.player;
        // X 只看「与你势力相同」的其他角色（自己也能是目标：官方是「至多X名角色」）
        const candidates = ctx.state.players.filter((p) => p.alive);
        const x = heartCardsInDiscardThisTurn(ctx.state);
        if (x <= 0 || candidates.length === 0) return;
        const chosen: string[] = [];
        // 逐个人问「还要不要选」——多选目标没有现成原语，用重复询问拼出来
        const askNext = (): void => {
          const left = candidates.filter((p) => !chosen.includes(p.seatId));
          if (chosen.length >= x || left.length === 0) {
            resolveChoices(0);
            return;
          }
          const options = left.map((p) => ({ id: p.seatId, label: p.name }));
          options.push({ id: 'stop', label: '结束选择' });
          ctx.api.askChoice(
            ctx.state,
            player.seatId,
            `【再起】：选择至多 ${x} 名角色（已选 ${chosen.length}，本回合进入弃牌堆的红桃牌 ${x} 张）`,
            options,
            (_st, _p, picked) => {
              if (picked === 'stop') {
                resolveChoices(0);
                return;
              }
              chosen.push(picked);
              askNext();
            },
          );
        };
        // 被选中的角色依次二选一
        const resolveChoices = (index: number): void => {
          if (index >= chosen.length) return;
          const seatId = chosen[index]!;
          const target = getPlayer(ctx.state, seatId);
          if (!target || !target.alive) {
            resolveChoices(index + 1);
            return;
          }
          ctx.api.askChoice(
            ctx.state,
            seatId,
            `【再起】：请选择一项（孟获：${player.name}）`,
            [
              { id: 'draw', label: '自己摸一张牌' },
              { id: 'heal', label: `令 ${player.name} 回复 1 点体力` },
            ],
            (st, t, picked) => {
              if (picked === 'draw') {
                const c = drawOne(st);
                if (c) t.hand.push(c);
                pushLog(st, 'skill', `${t.name} 因【再起】摸了一张牌。`);
              } else {
                const healed = ctx.api.heal(player, 1);
                pushLog(
                  st,
                  'skill',
                  `${t.name} 选择了【再起】的第二项，${player.name} 回复 ${healed} 点体力。`,
                );
              }
              resolveChoices(index + 1);
            },
          );
        };
        ctx.api.askChoice(
          ctx.state,
          player.seatId,
          `是否发动【再起】？（本回合进入弃牌堆的红桃牌 ${x} 张）`,
          [
            { id: 'yes', label: `发动（令至多 ${x} 名角色各选一项）` },
            { id: 'no', label: '不发动' },
          ],
          (_st, _p, picked) => {
            if (picked === 'yes') askNext();
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '祸首',
      desc: '锁定技，【南蛮入侵】对你无效；当其他角色使用【南蛮入侵】时，你代替其成为此牌造成伤害的来源。',
    },
    {
      name: '再起',
      desc: '弃牌阶段结束时，你可以令至多 X 名角色各选择一项：1.摸一张牌；2.令你回复 1 点体力（X 为本回合进入弃牌堆的红桃牌数）。',
    },
  ],
};

const VANILLA: Hero = {
  id: 'vanilla',
  name: '平民',
  faction: 'neutral',
  maxHp: 4,
  skills: [],
};

// —— 国战标准版·群 / 吴（续）——
//
// 这三个都是**国战专属文本**（身份局同名武将的技能不一样），所以 modes 只放 guozhan。
// 体力按仓库约定填身份局口径：阴阳鱼 × 2（见 docs/guozhan-roster.md §4.1）。

const MATENG: Hero = {
  id: 'mateng',
  name: '马腾',
  faction: 'qun',
  // 国战牌面 2 阴阳鱼
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  // 马术：锁定技，你计算与其他角色的距离 -1（distance() 读 distanceFrom 这个字段，
  // 与马超同款）
  distanceFrom: 1,
  lockedFields: ['distanceFrom'],
  skillFields: { 马术: ['distanceFrom'] },
  activeSkills: [
    {
      id: 'xiongyi',
      name: '雄异',
      // 限定技：**每局**一次（不是每回合）
      oncePerGame: true,
      minTargets: 0,
      maxTargets: 0,
      canUse: () => true,
      execute: (state, player, _intent, api) => {
        // 令与你**势力相同**的所有角色各摸三张牌。暗置的人没有势力（effectiveFaction
        // 返回 null），所以不会跟未确定势力的人算成同势力——这条在国战里很关键。
        const faction = effectiveFaction(state, player);
        const mates = state.players.filter(
          (p) => p.alive && (p.seatId === player.seatId || effectiveFaction(state, p) === faction),
        );
        for (const m of mates) {
          for (let i = 0; i < 3; i++) {
            const c = drawOne(state);
            if (!c) break;
            m.hand.push(c);
          }
        }
        pushLog(
          state,
          'skill',
          `${player.name} 发动限定技【雄异】：${mates.map((m) => m.name).join('、')} 各摸三张牌。`,
          { seat: player.seatId, action: 'draw' },
        );
        // 然后若你的势力是**角色最少的势力（或之一）**，你回复 1 点体力。
        // 数的是真实势力人数（野心家不算势力），所以别用 effectiveFaction 那一套。
        const counts = [...new Set(state.players.filter((p) => p.alive).map((p) => p.faction))]
          .filter((f) => f !== 'ambitionist')
          .map((f) => factionAliveCount(state, f));
        const mine = factionAliveCount(state, faction);
        if (counts.length > 0 && mine <= Math.min(...counts)) {
          const healed = api.heal(player, 1);
          pushLog(
            state,
            'skill',
            `${player.name} 的势力人数最少，【雄异】令其回复 ${healed} 点体力。`,
          );
        }
        return undefined;
      },
    },
  ],
  skills: [
    { name: '马术', desc: '锁定技，你计算与其他角色的距离-1。' },
    {
      name: '雄异',
      desc: '限定技，出牌阶段，你可以令与你势力相同的所有角色各摸三张牌，然后若你的势力是角色最少的势力（或之一），你回复1点体力。',
    },
  ],
};

const PANFENG: Hero = {
  id: 'panfeng',
  name: '潘凤',
  faction: 'qun',
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  // 狂斧：当你使用【杀】对目标造成伤害后，你可以将其装备区里的一张牌
  // 置入你的装备区（同栏位顶替）或弃置之。
  hooks: [
    {
      timing: 'afterDamageDealt',
      skillId: '狂斧',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext } | undefined;
        const attack = payload?.attack;
        if (!attack || attack.asType !== 'sha') return; // 只认【杀】
        if (attack.sourceId !== ctx.player.seatId) return;
        const target = getPlayer(ctx.state, attack.targetId);
        if (!target || !target.alive || target.seatId === ctx.player.seatId) return;
        const equips = EQUIP_SLOTS.map((slot) => target.equipment[slot]).filter(Boolean) as Card[];
        if (equips.length === 0) return;
        const me = ctx.player;
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          `【狂斧】：是否处置 ${target.name} 装备区里的一张牌？`,
          [
            { id: 'no', label: '不发动' },
            { id: 'yes', label: '发动（取走或弃置一张）' },
          ],
          (st, _p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.askPickCards(
              st,
              me.seatId,
              `【狂斧】：选择 ${target.name} 装备区里的一张牌`,
              equips,
              1,
              1,
              (st2, p2, chosen) => {
                const card = chosen[0];
                if (!card) return;
                // 结算期间那张牌可能已经被挪走/弃掉了
                if (!EQUIP_SLOTS.some((slot) => target.equipment[slot]?.id === card.id)) return;
                ctx.api.askChoice(
                  st2,
                  p2.seatId,
                  `【狂斧】：把【${cardLabel(card)}】怎么办？`,
                  [
                    { id: 'take', label: '置入自己的装备区' },
                    { id: 'drop', label: '弃置' },
                  ],
                  (st3, p3, how) => {
                    if (how === 'take') {
                      // moveFieldCard 会顶掉自己同栏位里的旧装备
                      ctx.api.moveFieldCard(card, p3.seatId);
                      pushLog(
                        st3,
                        'skill',
                        `${p3.name} 发动【狂斧】，取走了 ${target.name} 的【${cardLabel(card)}】。`,
                        { seat: p3.seatId, action: 'equip' },
                      );
                    } else {
                      ctx.api.discardCard(target.seatId, card);
                      pushLog(
                        st3,
                        'skill',
                        `${p3.name} 发动【狂斧】，弃置了 ${target.name} 的【${cardLabel(card)}】。`,
                        { seat: p3.seatId, action: 'discard' },
                      );
                    }
                  },
                );
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '狂斧',
      desc: '当你使用【杀】对目标角色造成伤害后，你可以将其装备区里的一张牌置入你的装备区或弃置之。',
    },
  ],
};

const SUNJIAN: Hero = {
  id: 'sunjian',
  name: '孙坚',
  faction: 'wu',
  // 国战牌面 **2.5 阴阳鱼**（2018 年由 2 上调）→ 身份局口径 5。
  // 别照身份局孙坚的 4 填——这是国战专属体力。
  maxHp: 5,
  gender: 'male',
  combos: ['wuguotai'],
  modes: ['guozhan'],
  // 英魂：准备阶段（本引擎里就是回合开始的 turnStart），若你已受伤，
  // 选择一名其他角色 + 二选一。
  hooks: [
    {
      timing: 'turnStart',
      skillId: '英魂',
      handler: (ctx) => {
        const player = ctx.player;
        const lost = player.maxHp - player.hp;
        if (lost <= 0) return; // 未受伤不发动
        const others = ctx.state.players.filter((p) => p.alive && p.seatId !== player.seatId);
        if (others.length === 0) return;
        const X = lost;
        ctx.api.askChoice(
          ctx.state,
          player.seatId,
          `是否发动【英魂】？（你已损失 ${X} 点体力）`,
          [
            { id: 'no', label: '不发动' },
            { id: 'drawX', label: `令一名角色摸 ${X} 张，然后弃一张` },
            { id: 'draw1', label: `令一名角色摸 1 张，然后弃 ${X} 张` },
          ],
          (st, _p, picked) => {
            if (picked === 'no') return;
            ctx.api.askChoice(
              st,
              player.seatId,
              '【英魂】：选择一名其他角色',
              others.map((p) => ({ id: p.seatId, label: p.name })),
              (st2, _p2, targetSeatId) => {
                const target = getPlayer(st2, targetSeatId);
                if (!target || !target.alive) return;
                const drawCount = picked === 'drawX' ? X : 1;
                const discardCount = picked === 'drawX' ? 1 : X;
                let drew = 0;
                for (let i = 0; i < drawCount; i++) {
                  const c = drawOne(st2);
                  if (!c) break;
                  target.hand.push(c);
                  drew++;
                }
                pushLog(
                  st2,
                  'skill',
                  `${player.name} 对 ${target.name} 发动【英魂】：摸 ${drew} 张，然后弃 ${discardCount} 张。`,
                  { seat: player.seatId, action: 'draw' },
                );
                // 弃牌数按实际手牌夹取（手牌不够就有什么弃什么）
                const need = Math.min(discardCount, target.hand.length);
                if (need <= 0) return;
                ctx.api.askPickCards(
                  st2,
                  target.seatId,
                  `【英魂】：请弃置 ${need} 张牌`,
                  target.hand.slice(),
                  need,
                  need,
                  (st3, t3, picked2) => {
                    for (const c of picked2) {
                      removeCard(t3.hand, c.id);
                      toDiscard(st3, c);
                    }
                    pushLog(st3, 'skill', `${t3.name} 因【英魂】弃置了 ${picked2.length} 张牌。`);
                  },
                );
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '英魂',
      desc: '准备阶段，若你已受伤，你可以选择一名其他角色并选择一项：1.令其摸X张牌，然后弃置一张牌；2.令其摸一张牌，然后弃置X张牌（X为你已损失的体力值）。',
    },
  ],
};

// —— 国战标准版·群 / 吴（第三批）——

const PANGDE: Hero = {
  id: 'pangde',
  name: '庞德',
  faction: 'qun',
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  // 马术：锁定技，你计算与其他角色的距离 -1
  distanceFrom: 1,
  lockedFields: ['distanceFrom'],
  skillFields: { 马术: ['distanceFrom'] },
  hooks: [
    {
      // 猛进：**你使用的【杀】被【闪】抵消**时，可以弃置其一张牌。
      // 注意这个时机是派给**来源**的（shaDodged），青龙偃月刀/贯石斧那两件武器
      // 是写死在 finishAttack 里的，英雄技能只有走这个时机才挂得上去。
      timing: 'shaDodged',
      skillId: '猛进',
      handler: (ctx) => {
        const attack = (ctx.payload as { attack?: AttackContext } | undefined)?.attack;
        if (!attack || attack.sourceId !== ctx.player.seatId) return;
        const target = getPlayer(ctx.state, attack.targetId);
        if (!target || !target.alive || target.seatId === ctx.player.seatId) return;
        const pool = [
          ...target.hand,
          ...(EQUIP_SLOTS.map((slot) => target.equipment[slot]).filter(Boolean) as Card[]),
        ];
        if (pool.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `【猛进】：是否弃置 ${target.name} 的一张牌？（他手里 ${target.hand.length} 张）`,
          [
            { id: 'no', label: '不发动' },
            { id: 'yes', label: '发动（随机弃置其一张牌）' },
          ],
          (st, _p, picked) => {
            if (picked !== 'yes') return;
            // 手牌是暗信息：不看内容、随机抽一张（与过河拆桥/顺手牵羊同一套口径）。
            // 装备牌本来就是明的，抽到谁就是谁。
            const pool2 = [
              ...target.hand,
              ...(EQUIP_SLOTS.map((slot) => target.equipment[slot]).filter(Boolean) as Card[]),
            ];
            if (pool2.length === 0) return;
            const card = pool2[Math.floor(st.rng() * pool2.length)]!;
            const fromHand = target.hand.some((c) => c.id === card.id);
            st.log.push({
              id: st.logSeq++,
              kind: 'skill',
              message: fromHand
                ? `${ctx.player.name} 发动【猛进】，弃置了 ${target.name} 的一张手牌。`
                : `${ctx.player.name} 发动【猛进】，弃置了 ${target.name} 的【${cardLabel(card)}】。`,
              seat: ctx.player.seatId,
              action: 'discard',
            });
            ctx.api.discardCard(target.seatId, card);
          },
        );
      },
    },
  ],
  skills: [
    { name: '马术', desc: '锁定技，你计算与其他角色的距离-1。' },
    {
      name: '猛进',
      desc: '当你使用的【杀】被目标角色使用的【闪】抵消时，你可以弃置其一张牌。',
    },
  ],
};

const DINGFENG: Hero = {
  id: 'dingfeng',
  name: '丁奉',
  faction: 'wu',
  maxHp: 4,
  gender: 'male',
  combos: ['xusheng'],
  modes: ['guozhan'],
  // 短兵：你使用【杀】可以**多选择一名距离为 1** 的角色为目标。
  // 名额由 engine 的 shaTargetRule 与方天画戟合在一处算，距离约束在 playSha 里校验。
  shaExtraTargetAtRange1: true,
  lockedFields: ['shaExtraTargetAtRange1'],
  skillFields: { 短兵: ['shaExtraTargetAtRange1'] },
  activeSkills: [
    {
      id: 'fenxun',
      name: '奋迅',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      needsCards: true,
      maxCards: () => 1,
      canUse: (state, player) =>
        player.hand.length > 0 && state.players.some((p) => p.alive && p.seatId !== player.seatId),
      execute: (state, player, intent) => {
        const cardId = intent.cardIds?.[0];
        const card = cardId ? player.hand.find((c) => c.id === cardId) : undefined;
        if (!card) return '请选择要弃置的一张牌';
        const targetId = intent.targetIds[0];
        const target = targetId ? getPlayer(state, targetId) : undefined;
        if (!target || !target.alive || target.seatId === player.seatId) return '目标无效';
        removeCard(player.hand, card.id);
        toDiscard(state, card);
        // 「本回合你计算与其的距离视为 1」——distance() 读这个字段，回合结束清掉
        player.flags.distanceToOneThisTurn = target.seatId;
        pushLog(
          state,
          'skill',
          `${player.name} 发动【奋迅】，弃置【${cardLabel(card)}】：本回合至 ${target.name} 的距离视为 1。`,
          { seat: player.seatId, action: 'skill' },
        );
        return undefined;
      },
    },
  ],
  skills: [
    { name: '短兵', desc: '你使用【杀】可以多选择一名距离为1的角色为目标。' },
    {
      name: '奋迅',
      desc: '出牌阶段限一次，你可以弃置一张牌并选择一名其他角色，然后本回合你计算与其的距离视为1。',
    },
  ],
};

const JILING: Hero = {
  id: 'jiling',
  name: '纪灵',
  faction: 'qun',
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  // 双刃：出牌阶段开始时与一名角色拼点。赢→视为对其或其同势力的另一名角色
  // 使用一张【杀】（不计入次数）；没赢→结束出牌阶段。
  hooks: [
    {
      timing: 'playPhase',
      skillId: '双刃',
      handler: (ctx) => {
        const player = ctx.player;
        if (player.hand.length === 0) return; // 没牌可拼
        const others = ctx.state.players.filter(
          (p) => p.alive && p.seatId !== player.seatId && p.hand.length > 0,
        );
        if (others.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          player.seatId,
          '是否发动【双刃】？（与一名角色拼点，赢则视为对其使用一张【杀】）',
          [
            { id: 'no', label: '不发动' },
            { id: 'yes', label: '发动' },
          ],
          (st, _p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.askChoice(
              st,
              player.seatId,
              '【双刃】：与谁拼点？',
              others.map((p) => ({ id: p.seatId, label: `${p.name}（手牌 ${p.hand.length} 张）` })),
              (st2, _p2, targetSeatId) => {
                ctx.api.pindian(player.seatId, targetSeatId, (st3, winnerId) => {
                  if (winnerId !== player.seatId) {
                    // 没赢：结束出牌阶段（直接进弃牌阶段）
                    pushLog(st3, 'skill', `${player.name} 的【双刃】没赢，结束出牌阶段。`, {
                      seat: player.seatId,
                      action: 'skill',
                    });
                    ctx.api.endPlayPhase(player.seatId);
                    return;
                  }
                  // 赢：视为对「拼点对象」或「与其势力相同的另一名角色」使用一张【杀】。
                  // 官方没写「无距离限制」，所以照常按攻击范围筛目标。
                  const opponent = getPlayer(st3, targetSeatId);
                  const faction = opponent ? effectiveFaction(st3, opponent) : null;
                  const candidates = st3.players.filter(
                    (p) =>
                      p.alive &&
                      p.seatId !== player.seatId &&
                      (p.seatId === targetSeatId ||
                        (faction !== null && effectiveFaction(st3, p) === faction)) &&
                      canTarget(st3, player.seatId, p.seatId),
                  );
                  if (candidates.length === 0) {
                    pushLog(st3, 'skill', `${player.name} 的【双刃】没有可指定的目标。`, {
                      seat: player.seatId,
                      action: 'skill',
                    });
                    return;
                  }
                  ctx.api.askChoice(
                    st3,
                    player.seatId,
                    '【双刃】拼点赢了：视为对谁使用一张【杀】？',
                    candidates.map((p) => ({ id: p.seatId, label: p.name })),
                    (st4, _p4, victimId) => {
                      ctx.api.castVirtualSha(player.seatId, victimId, { logKind: 'skill' });
                    },
                  );
                });
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '双刃',
      desc: '出牌阶段开始时，你可以与一名角色拼点。若你赢，你视为对其或与其势力相同的另一名角色使用一张【杀】（不计入出牌阶段使用次数的限制）；若你没赢，你结束出牌阶段。',
    },
  ],
};

// —— 国战标准版·群（第四批）——

const KONGRONG: Hero = {
  id: 'kongrong',
  name: '孔融',
  faction: 'qun',
  // 国战牌面 1.5 阴阳鱼 → 身份局口径 3
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  // 名士：锁定技，当你受到伤害时，若伤害来源**有暗置的武将牌**，此伤害 -1。
  // 实现在 engine 的 finalizeDamage 里——所有伤害点都过它，所以这里只挂字段。
  reduceDamageFromHiddenSource: true,
  lockedFields: ['reduceDamageFromHiddenSource'],
  skillFields: { 名士: ['reduceDamageFromHiddenSource'] },
  hooks: [
    {
      // 礼让：当你的牌**因弃置**而置入弃牌堆时，你可以将之交给一名其他角色。
      // 由 engine 在「某人的牌被弃置」的几处发 cardDiscarded（弃牌阶段、被拆、
      // 技能弃置…），payload.cards 是刚进弃牌堆的那几张。
      timing: 'cardDiscarded',
      skillId: '礼让',
      handler: (ctx) => {
        const payload = ctx.payload as { cards?: Card[] } | undefined;
        const cards = payload?.cards ?? [];
        if (cards.length === 0) return;
        const others = ctx.state.players.filter((p) => p.alive && p.seatId !== ctx.player.seatId);
        if (others.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `【礼让】：是否把刚弃置的 ${cards.length} 张牌交给一名其他角色？`,
          [
            { id: 'no', label: '不发动' },
            { id: 'yes', label: `发动（${cards.map((c) => cardLabel(c)).join('、')}）` },
          ],
          (st, _p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.askChoice(
              st,
              ctx.player.seatId,
              '【礼让】：交给谁？',
              others.map((p) => ({ id: p.seatId, label: p.name })),
              (st2, _p2, targetSeatId) => {
                ctx.api.giveDiscardedTo(cards, targetSeatId);
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '名士',
      desc: '锁定技，当你受到伤害时，若伤害来源有暗置的武将牌，此伤害-1。',
    },
    { name: '礼让', desc: '当你的牌因弃置而置入弃牌堆时，你可以将之交给一名其他角色。' },
  ],
};

const CAIWENJI: Hero = {
  id: 'caiwenji',
  name: '蔡文姬',
  faction: 'qun',
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'female',
  modes: ['guozhan'],
  hooks: [
    {
      // 悲歌：当**一名角色**受到【杀】造成的伤害后，你可以弃置一张牌，然后令其判定。
      // 注意时机是 anyDamaged（派给所有人）——afterDamage 只发给受伤者本人，
      // 观察不到别人挨打。
      timing: 'anyDamaged',
      skillId: '悲歌',
      handler: (ctx) => {
        const payload = ctx.payload as
          { attack?: AttackContext; damage?: number; victimId?: string } | undefined;
        const attack = payload?.attack;
        if (!attack || attack.asType !== 'sha' || !payload?.damage) return;
        const victim = payload.victimId ? getPlayer(ctx.state, payload.victimId) : undefined;
        if (!victim) return;
        const me = ctx.player;
        const mine = [
          ...me.hand,
          ...(EQUIP_SLOTS.map((slot) => me.equipment[slot]).filter(Boolean) as Card[]),
        ];
        // 只认「因【杀】受到的伤害」；但要不要发动得先有牌可弃
        if (mine.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          `【悲歌】：${victim.name} 受到了【杀】的伤害，是否弃置一张牌发动？`,
          [
            { id: 'no', label: '不发动' },
            { id: 'yes', label: '发动（弃一张牌并令其判定）' },
          ],
          (st, _p, picked) => {
            if (picked !== 'yes') return;
            const pool = [
              ...me.hand,
              ...(EQUIP_SLOTS.map((slot) => me.equipment[slot]).filter(Boolean) as Card[]),
            ];
            if (pool.length === 0) return;
            ctx.api.askPickCards(
              st,
              me.seatId,
              '【悲歌】：弃置一张牌',
              pool,
              1,
              1,
              (st2, _p2, chosen) => {
                const cost = chosen[0];
                if (cost) ctx.api.discardCard(me.seatId, cost);
                const source = attack.sourceId ? getPlayer(st2, attack.sourceId) : undefined;
                // 统一技能判定，判定者＝**受伤者**（「谁判定，判定牌就属于谁」）
                ctx.api.judge(
                  '悲歌',
                  (judgeCard) => {
                    if (!judgeCard) return;
                    switch (cardAsSeenBy(st2, victim, judgeCard).suit) {
                      case 'heart': {
                        const healed = ctx.api.heal(victim, 1);
                        pushLog(
                          st2,
                          'skill',
                          `【悲歌】红桃：${victim.name} 回复 ${healed} 点体力。`,
                        );
                        break;
                      }
                      case 'diamond': {
                        for (let i = 0; i < 2; i++) {
                          const c = drawOne(st2);
                          if (c) victim.hand.push(c);
                        }
                        pushLog(st2, 'skill', `【悲歌】方块：${victim.name} 摸两张牌。`);
                        break;
                      }
                      case 'club': {
                        // 伤害来源弃置两张牌（手牌随机，与仓库口径一致）。
                        // 这是**一个动作**，所以用 discardCards 一次交出去——里面的装备牌
                        // 算同一次「失去装备」事件（旋略只触发一次）。
                        if (!source) break;
                        const picks: Card[] = [];
                        for (let i = 0; i < 2; i++) {
                          const pool2 = [
                            ...source.hand,
                            ...(EQUIP_SLOTS.map((slot) => source.equipment[slot]).filter(
                              Boolean,
                            ) as Card[]),
                            ...picks,
                          ];
                          if (pool2.length === 0) break;
                          picks.push(pool2[Math.floor(st2.rng() * pool2.length)]!);
                        }
                        if (picks.length > 0) ctx.api.discardCards(source.seatId, picks);
                        pushLog(
                          st2,
                          'skill',
                          `【悲歌】梅花：${source?.name ?? '来源'} 弃置两张牌。`,
                        );
                        break;
                      }
                      case 'spade': {
                        if (!source) break;
                        source.flipped = !source.flipped;
                        pushLog(
                          st2,
                          'skill',
                          `【悲歌】黑桃：${source.name} ${source.flipped ? '翻面' : '翻回正面'}。`,
                        );
                        break;
                      }
                    }
                  },
                  { judgeSeatId: victim.seatId },
                );
              },
            );
          },
        );
      },
    },
    {
      // 断肠：锁定技，当你死亡时，你令杀死你的角色失去**一张武将牌**的所有技能。
      // 官方 FAQ：**由蔡文姬选择**失去哪一张（不是凶手选）；暗置的武将牌被点名后
      // 将来明置也只有势力和性别、没有技能。
      timing: 'death',
      skillId: '断肠',
      locked: true,
      handler: (ctx) => {
        const killerId = (ctx.payload as { killerId?: string } | undefined)?.killerId;
        const killer = killerId ? getPlayer(ctx.state, killerId) : undefined;
        if (!killer || killer.seatId === ctx.player.seatId) return;
        const slots: { id: string; label: string }[] = [];
        if (killer.heroId) {
          const h = getHero(killer.heroId);
          slots.push({ id: killer.heroId, label: `${h?.name ?? '主将'}（主将）` });
        }
        if (killer.deputyHeroId) {
          const h = getHero(killer.deputyHeroId);
          slots.push({ id: killer.deputyHeroId, label: `${h?.name ?? '副将'}（副将）` });
        }
        if (slots.length === 0) return;
        const dying = ctx.player;
        ctx.api.askChoice(
          ctx.state,
          dying.seatId,
          `【断肠】：令杀死你的 ${killer.name} 失去哪张武将牌的所有技能？`,
          slots,
          (st, _p, heroId) => {
            killer.nullifiedHeroId = heroId;
            const h = getHero(heroId);
            pushLog(st, 'skill', `【断肠】：${killer.name} 的【${h?.name ?? '?'}】失去所有技能。`, {
              seat: killer.seatId,
              action: 'skill',
            });
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '悲歌',
      desc: '当一名角色受到【杀】造成的伤害后，你可以弃置一张牌，然后令其进行判定，若结果为：红桃，其回复1点体力；方块，其摸两张牌；梅花，伤害来源弃置两张牌；黑桃，伤害来源翻面。',
    },
    {
      name: '断肠',
      desc: '锁定技，当你死亡时，你令杀死你的角色失去一张武将牌的所有技能。',
    },
  ],
};

// —— 国战标准版·群（第四批，续）——

const YANLIANG_WENCHOU: Hero = {
  id: 'yanliang_wenchou',
  name: '颜良文丑',
  faction: 'qun',
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  /**
   * 双雄：摸牌阶段，你可以改为进行一次判定，你获得判定牌，
   * 且本回合可以将一张**与之颜色不同**的手牌当【决斗】使用。
   *
   * 这是少数要看**本回合状态**的转化技，所以 canUseAs 用得上后面两个参数
   * （state/player）——判定牌的颜色记在 flags.shuangxiongColor，每回合清。
   */
  canUseAs: (card, type, _state, player) => {
    if (type !== 'juedou') return false;
    const color = player?.flags.shuangxiongColor ?? null;
    if (!color) return false;
    return (isRed(card) ? 'red' : 'black') !== color;
  },
  skillFields: { 双雄: ['canUseAs'] },
  hooks: [
    {
      timing: 'drawPhase',
      skillId: '双雄',
      handler: (ctx) => {
        const player = ctx.player;
        // 已经被跳过摸牌了（兵粮寸断/神速）就不再问
        if (player.flags.skipDraw) return;
        ctx.api.askChoice(
          ctx.state,
          player.seatId,
          '是否发动【双雄】？（放弃摸牌，改为判定并获得判定牌；本回合可把异色手牌当【决斗】）',
          [
            { id: 'no', label: '不发动（正常摸两张）' },
            { id: 'yes', label: '发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            // 「改为进行一次判定」＝正常的两张不摸了（跳过摸牌阶段），
            // 判定牌直接进手牌（官方是「你获得判定牌」，不走判定区）
            p.flags.skipDraw = true;
            const judgeCard = drawOne(st);
            if (!judgeCard) return;
            p.hand.push(judgeCard);
            p.flags.shuangxiongColor = isRed(judgeCard) ? 'red' : 'black';
            pushLog(
              st,
              'skill',
              `${p.name} 发动【双雄】，判定牌【${cardLabel(judgeCard)}】：本回合可将${
                p.flags.shuangxiongColor === 'red' ? '黑' : '红'
              }色手牌当【决斗】使用。`,
              { seat: p.seatId, action: 'skill' },
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '双雄',
      desc: '摸牌阶段，你可以改为进行一次判定，你获得判定牌且本回合可以将一张与之颜色不同的手牌当【决斗】使用。',
    },
  ],
};

// —— 国战标准版·吴 / 群（第五批）——

const ZHANGZHAO_ZHANGHONG: Hero = {
  id: 'zhangzhao_zhanghong',
  name: '张昭张纮',
  faction: 'wu',
  // 国战牌面 1.5 阴阳鱼 → 身份局口径 3
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  activeSkills: [
    {
      // 直谏：出牌阶段，你可以将手牌中的一张装备牌置于一名其他角色的装备区里，
      // 然后摸一张牌。注意是**手牌里的装备牌**（不能拿别人装备区、也不能拿自己装备区的）。
      id: 'zhijian',
      name: '直谏',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      needsCards: true,
      maxCards: () => 1,
      canUse: (state, player) =>
        player.hand.some((c) => isEquipCard(c)) &&
        state.players.some((p) => p.alive && p.seatId !== player.seatId),
      execute: (state, player, intent, api) => {
        const cardId = intent.cardIds?.[0];
        const card = cardId ? player.hand.find((c) => c.id === cardId) : undefined;
        if (!card) return '请选择一张手牌里的装备牌';
        if (!isEquipCard(card)) return '【直谏】只能给装备牌';
        const targetId = intent.targetIds[0];
        const target = targetId ? getPlayer(state, targetId) : undefined;
        if (!target || !target.alive || target.seatId === player.seatId) return '目标无效';
        // 从手牌置入对方装备区（同栏位顶替 → 旧装备进弃牌堆）
        removeCard(player.hand, card.id);
        api.giveEquipTo(card, target.seatId);
        const drawn = drawOne(state);
        if (drawn) player.hand.push(drawn);
        pushLog(
          state,
          'skill',
          `${player.name} 发动【直谏】，把【${cardLabel(card)}】置于 ${target.name} 的装备区，然后摸了一张牌。`,
          { seat: player.seatId, action: 'equip' },
        );
        return undefined;
      },
    },
  ],
  hooks: [
    {
      // 固政：其他角色的弃牌阶段结束时，你可以将该角色此阶段弃置的**一张手牌**
      // 交给该角色，然后你可以获得其余此阶段弃置的牌。
      timing: 'othersDiscardPhaseEnd',
      skillId: '固政',
      handler: (ctx) => {
        const payload = ctx.payload as { discardingSeatId?: string; cards?: Card[] } | undefined;
        const other = payload?.discardingSeatId
          ? getPlayer(ctx.state, payload.discardingSeatId)
          : undefined;
        const cards = payload?.cards ?? [];
        if (!other || !other.alive || cards.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `【固政】：${other.name} 弃了 ${cards.length} 张牌，是否发动？`,
          [
            { id: 'no', label: '不发动' },
            { id: 'yes', label: '发动（还他一张，其余归你）' },
          ],
          (st, _p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.askPickCards(
              st,
              ctx.player.seatId,
              `【固政】：选择一张还给 ${other.name}（其余归你）`,
              cards,
              1,
              1,
              (st2, p2, chosen) => {
                const back = chosen[0];
                const rest = cards.filter((c) => c.id !== back?.id);
                if (back) {
                  // 从弃牌堆取出交还本人
                  const i = st2.discard.findIndex((c) => c.id === back.id);
                  if (i < 0) return; // 跨步询问：回答时它可能已经不在弃牌堆了 → 不能凭空交还
                  st2.discard.splice(i, 1);
                  other.hand.push(back);
                }
                for (const c of rest) {
                  const i = st2.discard.findIndex((x) => x.id === c.id);
                  if (i < 0) continue;
                  st2.discard.splice(i, 1);
                  p2.hand.push(c);
                }
                pushLog(
                  st2,
                  'skill',
                  `${p2.name} 发动【固政】：${other.name} 收回 ${
                    back ? `【${cardLabel(back)}】` : '0 张'
                  }，其余 ${rest.length} 张归 ${p2.name}。`,
                  { seat: p2.seatId, action: 'gain' },
                );
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '直谏',
      desc: '出牌阶段，你可以将手牌中的一张装备牌置于一名其他角色的装备区里，然后摸一张牌。',
    },
    {
      name: '固政',
      desc: '其他角色的弃牌阶段结束时，你可以将该角色此阶段弃置的一张手牌交给该角色，然后你可以获得其余此阶段弃置的牌。',
    },
  ],
};

const TIANFENG: Hero = {
  id: 'tianfeng',
  name: '田丰',
  faction: 'qun',
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      // 死谏：当你失去最后的手牌时，你可以弃置一名其他角色的一张牌。
      // handEmptied 是「你失去最后一张手牌」的时机（连营用的那个）。
      timing: 'handEmptied',
      skillId: '死谏',
      handler: (ctx) => {
        const me = ctx.player;
        const others = ctx.state.players.filter((p) => p.alive && p.seatId !== me.seatId);
        if (others.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          '是否发动【死谏】？（弃置一名其他角色的一张牌）',
          [
            { id: 'no', label: '不发动' },
            { id: 'yes', label: '发动' },
          ],
          (st, _p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.askChoice(
              st,
              me.seatId,
              '【死谏】：弃置谁的牌？',
              others
                .filter((p) => p.hand.length > 0 || EQUIP_SLOTS.some((s) => p.equipment[s]))
                .map((p) => ({ id: p.seatId, label: p.name })),
              (st2, _p2, targetSeatId) => {
                const target = getPlayer(st2, targetSeatId);
                if (!target) return;
                const pool = [
                  ...target.hand,
                  ...(EQUIP_SLOTS.map((s) => target.equipment[s]).filter(Boolean) as Card[]),
                ];
                if (pool.length === 0) return;
                // 手牌随机不看内容（与猛进/过河拆桥同一口径）
                const card = pool[Math.floor(st.rng() * pool.length)]!;
                const fromHand = target.hand.some((c) => c.id === card.id);
                pushLog(
                  st2,
                  'skill',
                  fromHand
                    ? `${me.name} 发动【死谏】，弃置了 ${target.name} 的一张手牌。`
                    : `${me.name} 发动【死谏】，弃置了 ${target.name} 的【${cardLabel(card)}】。`,
                  { seat: me.seatId, action: 'discard' },
                );
                ctx.api.discardCard(target.seatId, card);
              },
            );
          },
        );
      },
    },
    {
      // 随势（锁定技）：当一名**其他**角色进入濒死状态时，若其体力上限与你相同，你摸一张牌。
      // otherNearDeath 是给「旁人」的濒死通知（nearDeath 只发给濒死者本人）。
      timing: 'otherNearDeath',
      skillId: '随势',
      locked: true,
      handler: (ctx) => {
        const dyingId = (ctx.payload as { dyingId?: string } | undefined)?.dyingId;
        const dying = dyingId ? getPlayer(ctx.state, dyingId) : undefined;
        if (!dying || dying.seatId === ctx.player.seatId) return;
        if (dying.maxHp !== ctx.player.maxHp) return;
        const c = drawOne(ctx.state);
        if (c) ctx.player.hand.push(c);
        pushLog(
          ctx.state,
          'skill',
          `${ctx.player.name} 的【随势】生效（${dying.name} 与其体力上限同为 ${dying.maxHp}），摸一张牌。`,
          { seat: ctx.player.seatId, action: 'draw' },
        );
      },
    },
  ],
  skills: [
    { name: '死谏', desc: '当你失去最后的手牌时，你可以弃置一名其他角色的一张牌。' },
    {
      name: '随势',
      desc: '锁定技，当一名其他角色进入濒死状态时，若其体力上限与你相同，你摸一张牌。',
    },
  ],
};

const ZOUSHI: Hero = {
  id: 'zoushi',
  name: '邹氏',
  faction: 'qun',
  // 国战牌面 1.5 阴阳鱼 → 3
  maxHp: 3,
  gender: 'female',
  modes: ['guozhan'],
  // 祸水：出牌阶段你可以明置此武将牌；**你的回合内，其他角色不能明置其武将牌**。
  // 后半句是锁定效果，由 engine 的 revealHeroCard（所有明置的唯一入口）拦。
  blocksOthersReveal: true,
  canRevealInPlayPhase: true,
  lockedFields: ['blocksOthersReveal'],
  skillFields: { 祸水: ['blocksOthersReveal', 'canRevealInPlayPhase'] },
  activeSkills: [
    {
      // 倾城：出牌阶段限一次，你可以弃置一张装备牌，然后令一名其他角色将其武将牌叠置（翻面）。
      id: 'qingcheng',
      name: '倾城',
      oncePerTurn: true,
      minTargets: 1,
      maxTargets: 1,
      needsCards: true,
      maxCards: () => 1,
      canUse: (state, player) =>
        player.hand.some((c) => isEquipCard(c)) &&
        state.players.some((p) => p.alive && p.seatId !== player.seatId),
      execute: (state, player, intent, api) => {
        const cardId = intent.cardIds?.[0];
        const card = cardId ? player.hand.find((c) => c.id === cardId) : undefined;
        if (!card) return '请选择一张要弃置的装备牌';
        if (!isEquipCard(card)) return '【倾城】只能弃置装备牌';
        const targetId = intent.targetIds[0];
        const target = targetId ? getPlayer(state, targetId) : undefined;
        if (!target || !target.alive || target.seatId === player.seatId) return '目标无效';
        api.discardCard(player.seatId, card, () => {
          target.flipped = !target.flipped;
          pushLog(
            state,
            'skill',
            `${player.name} 发动【倾城】，弃置【${cardLabel(card)}】：${target.name} ${
              target.flipped ? '武将牌叠置（翻面）' : '武将牌翻回正面'
            }。`,
            { seat: player.seatId, action: 'skill' },
          );
        });
        return undefined;
      },
    },
  ],
  skills: [
    {
      name: '祸水',
      desc: '出牌阶段，你可以明置此武将牌；你的回合内，其他角色不能明置其武将牌。',
    },
    {
      name: '倾城',
      desc: '出牌阶段限一次，你可以弃置一张装备牌，然后令一名其他角色将其武将牌叠置。',
    },
  ],
};

// —— 国战标准版·群 / 吴（第六批）——

/**
 * 黄天（张角·**群势力技**）：其他群势力角色可以在其出牌阶段，
 * 将一张【闪】或【闪电】交给张角。
 *
 * 这是**反向**势力技：技能由**别人**发动、好处给张角。所以它不在张角本人的技能表里，
 * 而是「场上有明置的张角时，其他群势力玩家出牌阶段多出来的一条操作」——
 * 与标记技能一样挂在 legal / onUseSkill 的技能表上（见 engine 的 externalActiveSkills）。
 */
function huangtianDonors(state: GameState, player: Player): Player[] {
  if (state.mode !== 'guozhan') return [];
  if (effectiveFaction(state, player) !== 'qun') return [];
  return state.players.filter(
    (p) =>
      p.alive &&
      p.seatId !== player.seatId &&
      // 用 effectiveHeroes 而不是 engine 的 activeHeroes：heroes.ts 不能反向依赖 engine
      effectiveHeroes(state, p).some((h) => h.id === 'zhangjiao'),
  );
}

/** 能交给张角的牌：手牌里的【闪】或【闪电】 */
function huangtianCards(player: Player): Card[] {
  return player.hand.filter((c) => c.type === 'shan' || c.type === 'shandian');
}

const HUANGTIAN: ActiveSkill = {
  id: 'huangtian',
  name: '黄天',
  desc: '出牌阶段，你可以将一张【闪】或【闪电】交给一名明置的张角。',
  minTargets: 0,
  maxTargets: 0,
  needsCards: true,
  maxCards: () => 1,
  canUse: (state, player) =>
    huangtianDonors(state, player).length > 0 && huangtianCards(player).length > 0,
  execute: (state, player, intent, api) => {
    const cardId = intent.cardIds?.[0];
    const card = cardId ? huangtianCards(player).find((c) => c.id === cardId) : undefined;
    if (!card) return '只能交【闪】或【闪电】';
    const donors = huangtianDonors(state, player);
    if (donors.length === 0) return '场上没有明置的张角';
    const give = (target: Player): void => {
      removeCard(player.hand, card.id);
      target.hand.push(card);
      pushLog(
        state,
        'skill',
        `${player.name} 发动【黄天】，把【${cardLabel(card)}】交给 ${target.name}。`,
        { seat: player.seatId, action: 'gain' },
      );
    };
    if (donors.length === 1) {
      give(donors[0]!);
      return undefined;
    }
    api.askChoice(
      state,
      player.seatId,
      '【黄天】：交给哪位张角？',
      donors.map((p) => ({ id: p.seatId, label: p.name })),
      (_st, _p, targetSeatId) => {
        const t = donors.find((p) => p.seatId === targetSeatId);
        if (t) give(t);
      },
    );
    return undefined;
  },
};

/** 张角能拿黄天吗（给 engine 的技能表用） */
export function huangtianFor(state: GameState, player: Player): ActiveSkill[] {
  return HUANGTIAN.canUse(state, player) ? [HUANGTIAN] : [];
}

const ZHANGJIAO: Hero = {
  id: 'zhangjiao',
  name: '张角',
  faction: 'qun',
  // 国战牌面 1.5 阴阳鱼 → 身份局口径 3
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      // 雷击：当你使用或打出【闪】时，你可以令一名其他角色判定，若为黑桃，
      // 你对其造成 2 点雷电伤害。（八卦阵那种「视为使用【闪】」也算，见 engine 的 shanUsed）
      timing: 'shanUsed',
      skillId: '雷击',
      handler: (ctx) => {
        const me = ctx.player;
        const others = ctx.state.players.filter((p) => p.alive && p.seatId !== me.seatId);
        if (others.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          me.seatId,
          '是否发动【雷击】？（令一名其他角色判定，黑桃则对其造成 2 点雷电伤害）',
          [
            { id: 'no', label: '不发动' },
            { id: 'yes', label: '发动' },
          ],
          (st, _p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.askChoice(
              st,
              me.seatId,
              '【雷击】：令谁判定？',
              others.map((p) => ({ id: p.seatId, label: p.name })),
              (st2, _p2, targetSeatId) => {
                const target = getPlayer(st2, targetSeatId);
                if (!target || !target.alive) return;
                // 统一技能判定，判定者＝**被指定的角色**（官方：雷击由张角指定的人判定）——
                // 所以鬼才/鬼道替他改判，天妒（他自己是郭嘉时）也能收走这张牌。
                ctx.api.judge(
                  '雷击',
                  (judgeCard) => {
                    if (!judgeCard) return;
                    // 小乔的黑桃判定牌视为红桃，所以雷击劈不中她。
                    if (cardAsSeenBy(st2, target, judgeCard).suit !== 'spade') {
                      pushLog(st2, 'skill', `【雷击】判定不是黑桃，无效。`);
                      return;
                    }
                    ctx.api.dealDamage(target, 2, me.seatId, 'thunder');
                  },
                  { judgeSeatId: target.seatId },
                );
              },
            );
          },
        );
      },
    },
    {
      // 鬼道：当一名角色的判定牌生效前，你可以打出一张**黑色牌**替换之。
      // 与司马懿·鬼才同一套机制（api.replaceJudgeCard 会把挂起的判定流程接回去），
      // 区别只在于限定黑色牌。
      timing: 'beforeJudge',
      skillId: '鬼道',
      handler: (ctx) => {
        const payload = ctx.payload as { judgeCard?: Card } | undefined;
        if (!payload?.judgeCard) return;
        const blacks = ctx.player.hand.filter((c) => !isRed(c));
        if (blacks.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          `是否发动【鬼道】替换判定牌（当前 ${cardLabel(payload.judgeCard)}）？`,
          [
            { id: 'no', label: '不发动' },
            { id: 'yes', label: '发动（打出一张黑色牌替换）' },
          ],
          (st, p, picked) => {
            const pool = p.hand.filter((c) => !isRed(c));
            if (picked !== 'yes' || pool.length === 0) return;
            ctx.api.askPickCards(
              st,
              p.seatId,
              '【鬼道】：选择要打出的黑色牌（将替换判定牌）',
              pool,
              1,
              1,
              (st2, p2, chosen) => {
                const card = chosen[0];
                if (!card) return;
                // ⚠️ 只从手里摘出来，**不要**在这里 toDiscard：这张牌会成为**新的判定牌**，
                // 判定结算完由 disposeJudgeCard 统一处置（进弃牌堆，或被天妒收走）。
                // 以前这里顺手弃了一次，于是同一张牌在弃牌堆里出现两次（模糊测试抓到的）。
                removeCard(p2.hand, card.id);
                pushLog(
                  st2,
                  'skill',
                  `${p2.name} 发动【鬼道】，打出【${cardLabel(card)}】替换判定牌。`,
                );
                ctx.api.replaceJudgeCard(card);
              },
            );
          },
        );
      },
    },
  ],
  skills: [
    {
      name: '雷击',
      desc: '当你使用或打出【闪】时，你可以令一名其他角色进行判定，若结果为黑桃，你对其造成2点雷电伤害。',
    },
    {
      name: '鬼道',
      desc: '当一名角色的判定牌生效前，你可以打出一张黑色牌替换之。',
    },
    {
      name: '黄天',
      desc: '群势力技，其他群势力角色可以在其出牌阶段将一张【闪】或【闪电】交给你。',
    },
  ],
};

const ZHOUTAI: Hero = {
  id: 'zhoutai',
  name: '周泰',
  faction: 'wu',
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    {
      // 不屈（锁定技）：当你处于濒死状态时，你将牌堆顶的一张牌置于你的武将牌上，
      // 称为「创」；若此牌点数与其他「创」均不同，你回复至 1 点体力，否则移去此牌。
      //
      // 挂在 nearDeath（可挂起）：把体力改回 1 就等于「没死」——engine 会看到
      // hp > 0 而不建濒死队列（涅槃是同一套用法）。
      timing: 'nearDeath',
      skillId: '不屈',
      locked: true,
      handler: (ctx) => {
        const me = ctx.player;
        const card = drawOne(ctx.state);
        if (!card) return;
        const dup = me.wounds.some((w) => w.rank === card.rank);
        if (dup) {
          // 点数相同 → 移去此「创」（进弃牌堆），照常走濒死
          toDiscard(ctx.state, card);
          pushLog(
            ctx.state,
            'skill',
            `${me.name} 的【不屈】翻出 ${cardLabel(card)}，与已有的「创」点数相同——移去此牌。`,
            { seat: me.seatId, action: 'skill' },
          );
          return;
        }
        me.wounds.push(card);
        me.hp = 1;
        pushLog(
          ctx.state,
          'skill',
          `${me.name} 发动【不屈】，翻出 ${cardLabel(card)}（第 ${me.wounds.length} 个「创」），体力回复至 1。`,
          { seat: me.seatId, action: 'skill' },
        );
      },
    },
    // 奋激：一名角色的结束阶段，若其没有手牌，你可以令其摸两张牌，然后你失去 1 点体力。
    // 自己的结束阶段走 turnEnd，别人的走 othersTurnEnd（payload.turnSeatId）。
    {
      timing: 'turnEnd',
      skillId: '奋激',
      handler: (ctx) => fenji(ctx, ctx.player),
    },
    {
      timing: 'othersTurnEnd',
      skillId: '奋激',
      handler: (ctx) => {
        const turnSeatId = (ctx.payload as { turnSeatId?: string } | undefined)?.turnSeatId;
        const turnPlayer = turnSeatId ? getPlayer(ctx.state, turnSeatId) : undefined;
        if (!turnPlayer) return;
        fenji(ctx, turnPlayer);
      },
    },
  ],
  skills: [
    {
      name: '不屈',
      desc: '锁定技，当你处于濒死状态时，你将牌堆顶的一张牌置于你的武将牌上，称为「创」，若此牌点数与其他「创」均不同，你回复至1点体力，否则移去此牌。',
    },
    {
      name: '奋激',
      desc: '一名角色的结束阶段，若其没有手牌，你可以令其摸两张牌，然后你失去1点体力。',
    },
  ],
};

/** 奋激的共用处理：`who` 是那个要结束回合、且没有手牌的角色 */
function fenji(ctx: HookContext, who: Player): void {
  const me = ctx.player;
  if (!who.alive || who.hand.length > 0) return;
  ctx.api.askChoice(
    ctx.state,
    me.seatId,
    `【奋激】：${who.name} 的结束阶段没有手牌，是否令其摸两张牌？（你失去 1 点体力）`,
    [
      { id: 'no', label: '不发动' },
      { id: 'yes', label: '发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      for (let i = 0; i < 2; i++) {
        const c = drawOne(st);
        if (c) who.hand.push(c);
      }
      pushLog(st, 'skill', `${me.name} 发动【奋激】：${who.name} 摸两张牌。`, {
        seat: me.seatId,
        action: 'draw',
      });
      ctx.api.loseHp(p, 1);
    },
  );
}


/** 势力显示名（未确定势力＝两张武将牌都暗着）——【问计】的选项与日志用它 */
function factionNameOf(state: GameState, p: Player): string {
  const f = effectiveFaction(state, p);
  return f ? (FACTION_NAME[f] ?? f) : '未确定势力';
}

/**
 * 刘琦·【问计】。出牌阶段开始时，可以令一名其他角色交给你一张牌：
 * - 其**已确定势力且与你不同** → 你交给其一张**其他**牌（不能就是刚收到的那张；
 *   没有其他牌可交时**就不交**——不凭空造牌，也不把刚收到的牌当「其他牌」）；
 * - 否则（**未确定势力**，或与你同势力）→ 把你收到的那张**实体牌**记为本回合的
 *   【问计】牌：你使用**这一张**无距离限制、无使用次数限制，且其他角色不能响应。
 *
 * ⚠️ 未确定势力（两张武将牌都暗着）走**友好**分支：不能按后台印面势力判断
 *    （与会盟、野心家同一口径——隐藏武将的势力不参与公开的势力规则）。
 */
function askWenji(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const candidates = state.players.filter(
    (p) => p.alive && p.seatId !== me.seatId && handAndEquipOf(p).length > 0,
  );
  if (candidates.length === 0) return; // 没人有牌可交 → 不弹空询问
  ctx.api.askChoice(
    state,
    me.seatId,
    '【问计】：是否令一名其他角色交给你一张牌？',
    [
      ...candidates.map((p) => ({ id: p.seatId, label: `${p.name}（${factionNameOf(state, p)}）` })),
      { id: 'no', label: '不发动' },
    ],
    (st, self, picked) => {
      if (picked === 'no') return;
      const giver = getPlayer(st, picked);
      if (!giver || !giver.alive) return;
      const pool = handAndEquipOf(giver);
      if (pool.length === 0) return;
      ctx.api.askPickCards(
        st,
        giver.seatId,
        `【问计】：选择交给 ${self.name} 的一张牌`,
        pool,
        1,
        1,
        (st2, giver2, chosen) => {
          const received = chosen[0];
          if (!received) return;
          // ⚠️ 询问是**跨步**的：发起时算好的池子，到回答时可能已经不成立（牌被别的链条
          //    拿走/弃掉——模糊测试撞到过：交牌者的「失去牌」钩子又弹出询问，回来时这张牌
          //    已经不在他手上了）。所以落点先验证「这张牌此刻还在不在交牌者手上」，
          //    不在就当这次交牌作废——不凭空造牌，也不把已经不存在的牌再搬一次
          //    （否则 transferCard 按 id 找不到可移除的牌、却仍然往目标手里推一份 → 一牌两地）。
          if (!handAndEquipOf(giver2).some((c) => c.id === received.id)) {
            pushLog(
              st2,
              'skill',
              `【问计】：${giver2.name} 原本要交的那张牌已经不在其手上了，作罢。`,
              { seat: giver2.seatId },
            );
            return;
          }
          // 走 API 搬牌而不是自己 splice：交出来的可能是装备，要触发「失去装备」那类技能
          ctx.api.transferCard(giver2.seatId, received, self.seatId, () => {
            pushLog(
              st2,
              'skill',
              `${self.name} 发动【问计】，${giver2.name} 交给其【${cardLabel(received)}】。`,
              { seat: self.seatId },
            );
            const mine = effectiveFaction(st2, self);
            const theirs = effectiveFaction(st2, giver2);
            // 未确定势力（暗置）按**友好**分支；同势力也是友好分支
            if (theirs === null || (mine !== null && theirs === mine)) {
              self.flags.wenjiCardId = received.id;
              pushLog(
                st2,
                'skill',
                `【问计】：${giver2.name}${theirs === null ? '未确定势力' : '与刘琦同势力'}——本回合刘琦使用【${cardLabel(received)}】无距离与次数限制，且其他角色不能响应。`,
                { seat: self.seatId },
              );
              return;
            }
            // 已确定势力且不同 → 回礼一张**其他牌**（刚收到的那张不算「其他牌」）
            const back = handAndEquipOf(self).filter((c) => c.id !== received.id);
            if (back.length === 0) {
              pushLog(
                st2,
                'skill',
                `【问计】：${giver2.name} 与刘琦势力不同，但刘琦没有其他牌可交（不交）。`,
                { seat: self.seatId },
              );
              return;
            }
            ctx.api.askPickCards(
              st2,
              self.seatId,
              `【问计】：${giver2.name} 与你势力不同，选择交给其一张其他牌`,
              back,
              1,
              1,
              (st3, self3, picked2) => {
                const backCard = picked2[0];
                if (!backCard) return;
                // 同上：池子是发起时的快照，落点再验一次「这张牌还在不在自己手上」
                if (!handAndEquipOf(self3).some((c) => c.id === backCard.id)) {
                  pushLog(
                    st3,
                    'skill',
                    `【问计】：${self3.name} 原本要回礼的那张牌已经不在其手上了，回礼作罢。`,
                    { seat: self3.seatId },
                  );
                  return;
                }
                ctx.api.transferCard(self3.seatId, backCard, giver2.seatId, () => {
                  pushLog(
                    st3,
                    'skill',
                    `【问计】：${self3.name} 交给 ${giver2.name} 【${cardLabel(backCard)}】。`,
                    { seat: self3.seatId },
                  );
                });
              },
            );
          });
        },
      );
    },
  );
}

/**
 * 刘琦·【屯江】。结束阶段，若你于**本回合的出牌阶段内**使用过至少一张牌、且这些牌
 * **一张都没有指定其他角色为目标**，你可以摸 X 张牌（X＝全场势力数）。
 *
 * 两个条件都用回合内的记账（都在 useCard 那个统一入口登记，随回合清零）：
 * - `usedCardsInPlayPhase`（引擎既有）：本回合出牌阶段用过的牌（含装备、对自己用的【桃】）；
 * - `targetedOtherThisTurn`（刘琦这版加的）：本回合有没有指定过**其他角色**——
 *   AOE 那类目标由规则定死的牌也算（按「真正会影响谁」判定，不看牌名）。
 */
function askTunjiang(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  if (me.flags.usedCardsInPlayPhase.length === 0) return; // 什么都没用过 → 不满足
  if (me.flags.targetedOtherThisTurn) return; // 指定过其他角色 → 不满足
  const x = currentFactionCount(state);
  if (x <= 0) return; // 全场没有已确定势力 → 摸 0 张，不必问
  ctx.api.askChoice(
    state,
    me.seatId,
    `【屯江】：是否摸 ${x} 张牌（全场势力数）？`,
    [
      { id: 'yes', label: `发动，摸 ${x} 张` },
      { id: 'no', label: '不发动' },
    ],
    (st, self, picked) => {
      if (picked !== 'yes') return;
      // X 按**结算那一刻**的全场势力数（询问期间可能有人明置或阵亡）
      const n = currentFactionCount(st);
      let got = 0;
      for (let i = 0; i < n; i++) {
        const c = drawOne(st);
        if (!c) break;
        self.hand.push(c);
        got++;
      }
      pushLog(st, 'skill', `${self.name} 发动【屯江】，摸了 ${got} 张牌（全场势力数 ${n}）。`, {
        seat: self.seatId,
      });
    },
  );
}

/**
 * 刘琦（不臣篇·上；**双势力 群/蜀**，国战牌面 1.5 阴阳鱼 → 体力上限 3）。
 *
 * 技能按**用户给出的等价规则实现文本**实现（2026-09 核对；来源与口径见
 * docs/guozhan-roster.md §5.88，含移动版 WIKI 引文）。本仓库不逐字复制牌面文本。
 * 双势力：主将/副将都可以放；最终势力由组合关系决定（`determineDualFaction`），
 * 确定之后【问计】判「与你势力相同」读的是 `effectiveFaction`——不会因为牌面印着
 * 「群/蜀」就同时把群和蜀都当自己势力。
 */
const LIUQI: Hero = {
  id: 'liuqi',
  name: '刘琦',
  pack: 'buchen',
  faction: 'qun',
  secondFaction: 'shu',
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    { timing: 'playPhase', skillId: '问计', handler: askWenji },
    { timing: 'turnEnd', skillId: '屯江', handler: askTunjiang },
  ],
  skills: [
    {
      name: '问计',
      desc: '出牌阶段开始时，你可以令一名其他角色交给你一张牌：若其已确定势力且与你不同，你交给其一张其他牌；否则本回合你使用此牌无距离和次数限制，且其他角色不能响应。',
    },
    {
      name: '屯江',
      desc: '结束阶段，若你于本回合的出牌阶段内使用过牌且未指定过其他角色为目标，你可以摸 X 张牌（X 为全场势力数）。',
    },
  ],
};

/**
 * 唐咨（不臣篇·上；**双势力 魏/吴**，2 阴阳鱼 → 体力上限 4）。
 *
 * 【兴棹】（锁定技）按**场上「有受伤角色的势力」数**（`woundedFactionCount`）**累计**开启四档：
 *   ≥1 → 拥有【恂恂】；≥2 → 唐咨受到伤害后，唐咨与来源中**手牌数唯一较少**的一方摸 1 张；
 *   ≥3 → 手牌上限 +4；≥4 → 唐咨失去装备区里的牌后摸 1 张（**同一批失去只摸 1 张**）。
 *
 * 四档全部**实时**判定（不缓存档位）：条件会因回血/阵亡/明置/势力确定而随时增减——
 * 第 2 档也必须在**伤害之后再数一次**（这次伤害本身就可能让受伤势力数从 1 变 2）。
 * 「势力数」不是人数：两名魏将都受伤也只算 1 个势力；暗置（未确定势力）的受伤角色不计入
 * （与【会盟】同一口径）。口径来源：用户给出的等价规则实现文本（见 docs/guozhan-roster.md §5.91）。
 *
 * 双势力：主将/副将都能放，最终势力由 `determineDualFaction` 决定；确定之后【兴棹】与
 * 【恂恂】的判定都读 `effectiveFaction`。
 */
const TANGZI: Hero = {
  id: 'tangzi',
  name: '唐咨',
  pack: 'buchen',
  faction: 'wei',
  secondFaction: 'wu',
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  // 手牌上限 +4 是【兴棹】第 3 档（锁定技的一部分），别被「非锁定技失效」关掉
  lockedFields: ['handLimit'],
  // 第 3 档：**动态**手牌上限（每次查询现算，不落成 buff）
  handLimit: (state, player) => player.hp + (woundedFactionCount(state) >= 3 ? 4 : 0),
  hooks: [
    { timing: 'afterDamage', skillId: '兴棹', locked: true, handler: askXingzhaoHands },
    { timing: 'equipLost', skillId: '兴棹', locked: true, handler: askXingzhaoEquip },
    // 【恂恂】是兴棹第 1 档**动态提供**的衍生技能：钩子常挂，档位条件在handler 里现算
    { timing: 'drawPhase', skillId: '恂恂', handler: askXunxun },
  ],
  skills: [
    {
      name: '兴棹',
      desc: '锁定技，当场上有受伤角色的势力数不小于 1/2/3/4 时，你依次拥有以下效果：获得【恂恂】；你受到伤害后，你与伤害来源中手牌数唯一较少的一方摸一张牌；你的手牌上限+4；你失去装备区里的牌后摸一张牌。',
    },
    {
      name: '恂恂',
      desc: '摸牌阶段开始时，你可以观看牌堆顶四张牌，将其中两张以任意顺序置于牌堆顶，其余两张以任意顺序置于牌堆底。',
    },
  ],
};

/**
 * 潘濬 —— 聪察 / 公清（不臣篇·下，**蜀/吴双势力**，1.5 阴阳鱼 → **3**；无珠联璧合；
 * 技能文本按移动版现行页面 + 用户给出的等价实现口径）。
 *
 * 【聪察】两段，**不共用任何状态**（用户点名：不要用一个 congchaActive 布尔值）：
 * ① 准备阶段，可以「观察」一名**尚未确定势力**的其他角色；被观察者**首次确定势力**时立即结算：
 *    最终势力与潘濬相同 → 双方各摸 2（潘濬先）；否则该角色**失去 1 点体力**（不是伤害）。
 *    观察只持续到**潘濬自己的下一个回合开始**；多个潘濬各自一条、互不覆盖。
 * ② 摸牌阶段，若场上**所有存活角色**都已确定势力 → 本次多摸 2 张。
 *
 * 读法要点（用户口径，逐条）：
 * - 监听的是「**首次确定势力**」这件事（引擎新时机 `factionDetermined`），**不是**「亮将」：
 *   单势力明置、双势力确定最终势力、野心家身份转化在底层都是「确定势力」，而**只有第一次**算；
 *   之后势力再变（野心家 / 新势力）都不再触发这一次观察（结算即删除标记）。
 * - 「尚未确定势力」＝**已确定势力为空**（`effectiveFaction(...) === null`，本仓库口径的暗置），
 *   **不读**武将牌上的卡面势力，也不能因为服务器知道暗将组合就提前判。
 * - 同不同势力比的是**结算当时双方已确定的实际势力**（潘濬卡面蜀/吴、本局确定吴 → 只和「吴」比），
 *   不是卡面的势力集合（唐咨卡面魏/吴、本局确定魏 → 与潘濬不同 → 唐咨失去 1 点体力）。
 * - 「失去 1 点体力」走 `loseHp`（不是 `dealDamage`）：没有来源、不是伤害事件、不触发
 *   「受到伤害后」；体力到 0 正常进濒死。
 * - ② 是「摸牌阶段多摸两张」，所以**摸牌阶段被跳过时不会凭空多摸**（做成 `drawCountDelta`
 *   字段现算，而不是提前塞 `flags.drawCountDelta`）。
 *
 * 【公清】（锁定技）潘濬**受到伤害时**，按**伤害来源的攻击范围**（`attackRange`：武器牌上印的数，
 * 空手 1；**不是距离、不算坐骑**）：
 * - < 3 → 此伤害**调整为 1**（是「设为 1」不是「-1」：5 点也变 1 点）；
 * - = 3 → 什么都不做；
 * - > 3 → 此伤害 **+1**。
 * 两支刻意放在**两个不同阶段**：「+1」走 `damageDelta`（较早的加伤层，与裸衣/从谏同层）、
 * 「改为 1」走 `beforeDamageApply` 的**可写 payload**（伤害值确定的最后一步）——这样以后和
 * 酒/锋势/凶虐/藤甲的交互不会取决于监听器注册顺序。没有伤害来源（闪电那类）时两支都不处理。
 */
/** 【聪察】①：还没确定势力的存活角色（不含潘濬自己） */
function congchaCandidates(state: GameState, me: Player): Player[] {
  return state.players.filter(
    (p) => p.alive && p.seatId !== me.seatId && !effectiveFaction(state, p),
  );
}

/** 【聪察】②：场上所有存活角色都已确定势力（阵亡的暗将不算「场上角色」） */
function allAlivePlayersDetermined(state: GameState): boolean {
  return state.players.filter((p) => p.alive).every((p) => !!effectiveFaction(state, p));
}

/**
 * 【聪察】②：**摸牌阶段**，场上所有存活角色都已确定势力时，**可以**多摸两张牌。
 *
 * ⚠️ 用户 2026-09 核后纠正：文面是「**可以**」→ 必须**询问**，不能无条件 +2
 *    （此前按无条件实现是错的）。走 `drawPhase` 钩子 + `flags.drawCountDelta`：
 *    钩子在 `doDrawPhase` **之前**跑，所以这里设的改量会被紧接着的摸牌读到；
 *    摸牌阶段被跳过时钩子里的询问仍会弹，但那张数用不上（与「多摸两张」同义）。
 */
function askCongchaExtraDraw(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  if (!allAlivePlayersDetermined(state)) return;
  ctx.api.askChoice(
    state,
    me.seatId,
    '【聪察】：场上所有存活角色均已确定势力，是否多摸两张牌？',
    [
      { id: 'yes', label: '多摸两张' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      p.flags.drawCountDelta += 2;
      pushLog(st, 'skill', `${p.name} 的【聪察】：多摸两张牌。`, { seat: p.seatId });
    },
  );
}

/** 【聪察】①的发动：准备阶段观察一名尚未确定势力的角色（顺带清掉上一轮的过期观察） */
function askCongcha(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  // 观察只到「潘濬自己的下一个回合开始」：每次自己的准备阶段先把上一轮挂着的清掉
  // （口径不是「当前回合结束」、也不是「被观察者的下个回合」）
  for (const p of state.players) {
    const i = p.congchaWatchedBy.indexOf(me.seatId);
    if (i < 0) continue;
    p.congchaWatchedBy.splice(i, 1);
    pushLog(state, 'skill', `${me.name} 的【聪察】：对 ${p.name} 的观察已到期。`, {
      seat: me.seatId,
    });
  }
  if (congchaCandidates(state, me).length === 0) return;
  ctx.api.askChoice(
    state,
    me.seatId,
    '【聪察】：是否观察一名尚未确定势力的角色？',
    [
      { id: 'yes', label: '观察一名角色' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      const cands = congchaCandidates(st, p); // 重新算：前面的询问里场上可能已经变了
      if (cands.length === 0) return;
      ctx.api.askChoice(
        st,
        p.seatId,
        '【聪察】：选择要观察的角色',
        cands.map((t) => ({ id: t.seatId, label: t.name })),
        (st2, p2, targetId) => {
          const target = getPlayer(st2, targetId);
          if (!target) return;
          if (!target.congchaWatchedBy.includes(p2.seatId)) {
            target.congchaWatchedBy.push(p2.seatId);
          }
          pushLog(
            st2,
            'skill',
            `${p2.name} 发动【聪察】：观察 ${target.name}（其首次确定势力时结算）。`,
            { seat: p2.seatId },
          );
        },
      );
    },
  );
}

/** 【聪察】①的结算：被观察者**首次确定势力**（多个潘濬各自结算、互不覆盖） */
function onFactionDetermined(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const ev = ctx.payload as
    | { playerId?: string; faction?: string; isFirstDetermination?: boolean }
    | undefined;
  if (!ev?.playerId || !ev.faction || ev.isFirstDetermination !== true) return;
  const target = getPlayer(state, ev.playerId);
  if (!target) return;
  const idx = target.congchaWatchedBy.indexOf(me.seatId);
  if (idx < 0) return; // 这个潘濬没在观察他
  // 首次确定即消耗（不是留到下个回合开始）
  target.congchaWatchedBy.splice(idx, 1);
  const mine = effectiveFaction(state, me);
  const name = FACTION_NAME[ev.faction as Faction] ?? ev.faction;
  if (mine && ev.faction === mine) {
    // 同势力：双方各摸 2（潘濬先摸，目标后摸）
    pushLog(
      state,
      'skill',
      `${me.name} 的【聪察】：${target.name} 首次确定势力为${name}，与${me.name}相同——双方各摸两张牌。`,
      { seat: me.seatId },
    );
    for (let i = 0; i < 2; i++) {
      const c = drawOne(state);
      if (!c) break;
      me.hand.push(c);
    }
    if (target.alive) {
      for (let i = 0; i < 2; i++) {
        const c = drawOne(state);
        if (!c) break;
        target.hand.push(c);
      }
    }
    return;
  }
  if (!target.alive) return;
  pushLog(
    state,
    'skill',
    `${me.name} 的【聪察】：${target.name} 首次确定势力为${name}，与${me.name}不同——失去 1 点体力。`,
    { seat: me.seatId },
  );
  ctx.api.loseHp(target, 1);
}

/** 【公清】伤害来源的攻击范围（没有来源就返回 null —— 闪电那类不处理） */
function gongqingRange(state: GameState, sourceId: string | undefined): number | null {
  if (!sourceId) return null;
  const src = getPlayer(state, sourceId);
  if (!src) return null;
  return attackRange(state, src);
}

/** 【公清】>3：**较早**的加伤层（与裸衣/从谏同层，走 damageDelta 字段） */
function gongqingDelta(
  state: GameState,
  self: Player,
  ev: { sourceId?: string; targetId: string },
): number {
  if (ev.targetId !== self.seatId) return 0; // 只管「潘濬受到的伤害」
  const range = gongqingRange(state, ev.sourceId);
  if (range === null) return 0;
  return range > 3 ? 1 : 0;
}

/** 【公清】<3：把伤害**调整为 1**（伤害值确定的最后一步，走 beforeDamageApply 的可写 payload） */
function gongqingSetOne(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const payload = ctx.payload as
    | { targetId?: string; damage?: number; attack?: AttackContext }
    | undefined;
  if (!payload || payload.targetId !== me.seatId) return;
  const range = gongqingRange(state, payload.attack?.sourceId);
  if (range === null) return;
  // = 3 不动；> 3 已经在 damageDelta 那一层加过了（这里不再碰）
  if (range >= 3) return;
  if ((payload.damage ?? 0) === 1) return;
  payload.damage = 1;
  pushLog(
    state,
    'skill',
    `${me.name} 的【公清】：伤害来源攻击范围 ${range} 小于 3，此伤害调整为 1。`,
    { seat: me.seatId },
  );
}

const PANJUN: Hero = {
  id: 'panjun',
  name: '潘濬',
  pack: 'buchen',
  faction: 'shu',
  secondFaction: 'wu',
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  // 公清是锁定技：伤害修正不能被「非锁定技失效」关掉
  lockedFields: ['damageDelta'],
  skillFields: { 公清: ['damageDelta'] },
  damageDelta: gongqingDelta,
  hooks: [
    { timing: 'turnStart', skillId: '聪察', handler: askCongcha },
    // 聪察②：「可以」→ 询问（用户核后纠正，见 askCongchaExtraDraw 的注释）
    { timing: 'drawPhase', skillId: '聪察', handler: askCongchaExtraDraw },
    { timing: 'factionDetermined', skillId: '聪察', handler: onFactionDetermined },
    { timing: 'beforeDamageApply', skillId: '公清', locked: true, handler: gongqingSetOne },
  ],
  skills: [
    {
      name: '聪察',
      desc: '准备阶段，你可以观察一名尚未确定势力的其他角色：当其首次确定势力时，若其势力与你相同，你与其各摸两张牌；否则其失去1点体力（观察持续到你的下一个回合开始）。摸牌阶段，若场上所有存活角色均已确定势力，你多摸两张牌。',
    },
    {
      name: '公清',
      desc: '锁定技，当你受到伤害时，若伤害来源的攻击范围小于3，此伤害调整为1；若大于3，此伤害+1。',
    },
  ],
};

/**
 * 苏飞 —— 联翩（不臣篇·下，**吴/群双势力**，2 阴阳鱼 → **4**，珠联璧合【甘宁】；
 * 技能按移动版当前国战版，用户核对后给出等价实现口径）。
 *
 * 【联翩】（结束阶段开始时，可发动）：统计**结束阶段这位角色本回合弃置的牌数 D**
 * （是「**本回合**」不是「弃牌阶段」；是「弃置**任意角色**的牌」，所以只认**执行弃置动作的人**，
 * 不是牌主）→ 门槛 `D >= 苏飞当前体力值 + 1`（**实时**读体力，不缓存阈值）：
 * - 若结束阶段的就是苏飞本人：**完全替换**成「令一名与你势力相同的角色将手牌补至**体力上限**」
 *   （含苏飞自己 ✓；目标按**已确定势力**筛，摸到的是 `maxHp` 不是当前体力）；
 * - 若结束阶段的是别人：**由那个人**决定发动与否，再二选一——
 *   ① 弃置苏飞的一张牌（选牌与弃置动作的**执行者都是他**；这次弃置本身也算进他本回合的弃置数，
 *   所以**多个苏飞必须逐个实时重算**）；② 令苏飞回复 1 点体力（正常回复，不产生【桃】的使用）。
 *
 * 值得一提的两处复用：
 * - 弃置账本走引擎的 `state.turnDiscards`（**执行者** actorId 与**牌主** ownerId 分开记），
 *   而「置入弃牌堆」（朱灵·决绝那类）根本不进这本账——这正是用户要区分的那条线。
 * - 结束阶段**开始**就结算：`turnEnd` / `othersTurnEnd` 上给一个**高优先级**，排在其他结束阶段
 *   技能前面（引擎没有独立的「结束阶段开始时」时机，同队列里按优先级先后）。
 */
/** 某人**本回合弃置**的牌数（按执行弃置动作的人统计，见 state.turnDiscards） */
export function turnDiscardCountBy(state: GameState, actorSeatId: string): number {
  return state.turnDiscards
    .filter((r) => r.actorId === actorSeatId)
    .reduce((sum, r) => sum + r.cardIds.length, 0);
}

function askLianpian(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player; // 苏飞
  // 自己的结束阶段走 turnEnd（payload 无 turnSeatId），别人的走 othersTurnEnd
  const payload = ctx.payload as { turnSeatId?: string } | undefined;
  const endingSeatId = payload?.turnSeatId ?? me.seatId;
  const ending = getPlayer(state, endingSeatId);
  if (!ending || !ending.alive) return;
  if (!me.alive) return;
  // 门槛：结束阶段这位**本回合弃置**的张数 ≥ 苏飞**当前体力 + 1**（实时读，别缓存）
  const count = turnDiscardCountBy(state, endingSeatId);
  if (count < me.hp + 1) return;

  if (endingSeatId === me.seatId) {
    // —— 自己的结束阶段：完全替换成「同势力角色手牌补至体力上限」 ——
    const mine = effectiveFaction(state, me);
    if (!mine) return;
    const cands = state.players.filter(
      (p) => p.alive && effectiveFaction(state, p) === mine,
    );
    if (cands.length === 0) return;
    ctx.api.askChoice(
      state,
      me.seatId,
      `【联翩】（本回合已弃置 ${count} 张）：是否令一名与你势力相同的角色将手牌补至体力上限？`,
      [
        { id: 'yes', label: '发动' },
        { id: 'no', label: '不发动' },
      ],
      (st, p, picked) => {
        if (picked !== 'yes') return;
        const list = st.players.filter((x) => x.alive && effectiveFaction(st, x) === mine);
        if (list.length === 0) return;
        ctx.api.askChoice(
          st,
          p.seatId,
          '【联翩】：选择将手牌补至体力上限的角色',
          list.map((t) => ({ id: t.seatId, label: t.name })),
          (st2, p2, targetId) => {
            const target = getPlayer(st2, targetId);
            if (!target) return;
            // 补至**体力上限**（不是当前体力）；手牌已经够多就摸 0 张
            const need = Math.max(0, target.maxHp - target.hand.length);
            let got = 0;
            for (let i = 0; i < need; i++) {
              const c = drawOne(st2);
              if (!c) break;
              target.hand.push(c);
              got++;
            }
            pushLog(
              st2,
              'skill',
              `${p2.name} 的【联翩】：${target.name} 将手牌补至体力上限（摸 ${got} 张）。`,
              { seat: p2.seatId },
            );
          },
        );
      },
    );
    return;
  }

  // —— 别人的结束阶段：**由他**决定 ——
  const opts: { id: string; label: string }[] = [];
  if (handAndEquipOf(me).length > 0) opts.push({ id: 'discard', label: `弃置 ${me.name} 的一张牌` });
  if (me.hp < me.maxHp) opts.push({ id: 'heal', label: `令 ${me.name} 回复 1 点体力` });
  if (opts.length === 0) return;
  ctx.api.askChoice(
    state,
    ending.seatId,
    `【联翩】${me.name}（你本回合已弃置 ${count} 张牌），是否发动？`,
    [...opts, { id: 'no', label: '不发动' }],
    (st, _p, picked) => {
      if (picked === 'no') return;
      if (picked === 'heal') {
        ctx.api.heal(me, 1);
        pushLog(
          st,
          'skill',
          `${me.name} 因【联翩】回复 1 点体力。`,
          { seat: ending.seatId },
        );
        return;
      }
      // ① 弃置苏飞的一张牌：选牌与**执行弃置的都是结束阶段那位**
      const pool = handAndEquipOf(me);
      if (pool.length === 0) return;
      const pick = (st2: GameState, chosen: typeof pool): void => {
        const card = chosen[0];
        if (!card) return;
        // ⚠️ 第四个参数是**执行弃置动作的人**——账本因此记在结束阶段这位名下
        //    （这也会让他本回合的弃置数 +1，所以多个苏飞要逐个实时重算门槛）
        ctx.api.discardCard(me.seatId, card, () => {
          pushLog(
            st2,
            'skill',
            `${ending.name} 因【联翩】弃置了 ${me.name} 的【${cardLabel(card)}】。`,
            { seat: ending.seatId },
          );
        }, ending.seatId);
      };
      if (pool.length === 1) {
        pick(st, pool);
        return;
      }
      ctx.api.askPickCards(
        st,
        ending.seatId,
        `【联翩】：选择要弃置的 ${me.name} 的一张牌`,
        pool,
        1,
        1,
        (st2, _p2, chosen) => pick(st2, chosen),
      );
    },
  );
}

const SUFEI: Hero = {
  id: 'sufei',
  name: '苏飞',
  pack: 'buchen',
  faction: 'wu',
  secondFaction: 'qun',
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  combos: ['ganning'], // 珠联璧合【甘宁】
  hooks: [
    // 结束阶段**开始**：同队列里给高优先级，排在其他结束阶段技能前面
    { timing: 'turnEnd', skillId: '联翩', priority: 10, handler: askLianpian },
    { timing: 'othersTurnEnd', skillId: '联翩', priority: 10, handler: askLianpian },
  ],
  skills: [
    {
      name: '联翩',
      desc: '一名角色的结束阶段开始时，若其本回合弃置的牌数不小于你的体力值+1，你可以：若该角色为你，令一名与你势力相同的角色将手牌补至其体力上限；否则令其选择一项：弃置你的一张牌，或令你回复1点体力。',
    },
  ],
};

/**
 * 许攸（**国战专属**）—— 成略 / 恃才（不臣篇·下，**魏/群双势力**，1.5 阴阳鱼 → **3**，无珠联璧合）。
 *
 * ⚠️ 与**身份场许攸**（转换技成略 + 控顶恃才 + 寸目）是**两个武将实体**，本仓库只做国战版。
 *
 * 【成略】（一次「使用牌完整结算结束」时可发动）：一名与许攸**势力相同**的角色使用了一张
 * **目标数大于 1** 的牌（多目标**杀** / 群体锦囊…），整张牌结算结束后：
 * ① 许攸可以令**这名使用者**摸 1 张；② 然后，若许攸**被这张牌实际伤害过**，可以再令一名
 * 「与许攸同势力、且**当前没有【阴阳鱼】标记**」的角色获得 1 枚【阴阳鱼】。
 * - 使用者可以是许攸自己（文本没写「其他角色」）；候选也不排除许攸自己。
 * - 「目标数」看的是**这次使用指定的目标**（`attack.declaredTargets`），不是伤害目标数——
 *   多目标牌即使只伤到一个人也满足；单目标牌即使伤害被传导给别的人也不满足。
 * - 「被这张牌伤害过」严格绑定**这一次使用**（`attack.cardUseId` + `state.useDamages`）：
 *   同一个人连用两张【南蛮】，第二张不能因为第一张打过许攸就算数；被防止的伤害也不算。
 * - **阴阳鱼**是国战**标记**（复用 `markers.ts` 的 `yinyangyu`），不是体力/阴阳鱼素材。
 *
 * 【恃才】（**锁定技**）：许攸**受到一次伤害后**，按这次伤害的**实际伤害值**：
 * 等于 1 → 摸 2 张；大于 1 → **弃置所有手牌**（真正的「弃置」，执行者是许攸自己——
 * 所以会正确计入苏飞·联翩那种「谁弃的牌」统计；0 手牌时技能照样成立，只是移动 0 张）。
 * 按**伤害事件**触发（一次 2 点只触发一次），不按点数。
 *
 * ⚠️ **本轮未接**：群体锦囊（南蛮/万箭）那条「使用结算结束」还没接线（引擎里目前只有
 * 【杀】在 `attackSettled` 上派发一次），所以成略暂时只对**多目标杀**生效——
 * 记得在「锦囊结算收尾」补同一个派发点（欠账记在 docs §5.115）。
 */
function askChenglue(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const payload = ctx.payload as
    | { useId?: number; sourceId?: string; targetIds?: string[] }
    | undefined;
  if (!payload?.useId) return;
  const targets = payload.targetIds ?? [];
  if (targets.length <= 1) return; // 目标数要大于 1（不是伤害目标数）
  const user = getPlayer(state, payload.sourceId ?? '');
  if (!user || !user.alive) return;
  const mine = effectiveFaction(state, me);
  if (!mine || effectiveFaction(state, user) !== mine) return; // 同势力（含许攸自己）；未确定势力不算
  ctx.api.askChoice(
    state,
    me.seatId,
    `【成略】：是否令 ${user.name} 摸一张牌？`,
    [
      { id: 'yes', label: '发动' },
      { id: 'no', label: '不发动' },
    ],
    (st, p2, picked) => {
      if (picked !== 'yes') return;
      const drawn = drawOne(st);
      if (drawn) user.hand.push(drawn);
      pushLog(st, 'skill', `${me.name} 发动【成略】：${user.name} 摸一张牌。`, { seat: me.seatId });
      // 第二段：**这一次使用**有没有实际伤害过许攸
      const hurt = st.useDamages.some(
        (d) => d.useId === payload.useId && d.targetId === me.seatId && d.amount > 0,
      );
      if (!hurt) return;
      const pool = (): Player[] =>
        st.players.filter(
          (x) => x.alive && effectiveFaction(st, x) === mine && markerCount(x, 'yinyangyu') === 0,
        );
      if (pool().length === 0) return;
      ctx.api.askChoice(
        st,
        p2.seatId,
        '【成略】：是否令一名没有【阴阳鱼】标记的同势力角色获得一枚【阴阳鱼】？',
        [
          { id: 'yes', label: '发动' },
          { id: 'no', label: '不发动' },
        ],
        (st2, p3, second) => {
          if (second !== 'yes') return;
          const list = pool();
          if (list.length === 0) return;
          ctx.api.askChoice(
            st2,
            p3.seatId,
            '【成略】：选择获得【阴阳鱼】的角色',
            list.map((t) => ({ id: t.seatId, label: t.name })),
            (st3, p4, targetId) => {
              const target = getPlayer(st3, targetId);
              if (!target) return;
              addMarker(target, 'yinyangyu');
              pushLog(st3, 'marker', `${target.name} 因【成略】获得一枚【阴阳鱼】。`, {
                seat: p4.seatId,
              });
            },
          );
        },
      );
    },
  );
}

/** 【恃才】（锁定技）：受 1 点伤害摸 2；受更多则弃置所有手牌 */
function askShicai(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const amount = (ctx.payload as { damage?: number } | undefined)?.damage ?? 0;
  if (amount <= 0) return;
  if (amount === 1) {
    for (let i = 0; i < 2; i++) {
      const c = drawOne(state);
      if (!c) break;
      me.hand.push(c);
    }
    pushLog(state, 'skill', `${me.name} 的【恃才】：受到 1 点伤害，摸两张牌。`, {
      seat: me.seatId,
    });
    return;
  }
  const hand = me.hand.slice();
  if (hand.length === 0) {
    pushLog(state, 'skill', `${me.name} 的【恃才】：受到 ${amount} 点伤害，但没有手牌可弃。`, {
      seat: me.seatId,
    });
    return;
  }
  pushLog(state, 'skill', `${me.name} 的【恃才】：受到 ${amount} 点伤害，弃置所有手牌。`, {
    seat: me.seatId,
  });
  // 真正的「弃置」：执行者是许攸自己（会进苏飞·联翩那种按执行者统计的账本）
  ctx.api.discardCards(me.seatId, hand, undefined, me.seatId);
}

const XUYOU: Hero = {
  id: 'xuyou',
  name: '许攸',
  pack: 'buchen',
  faction: 'wei',
  secondFaction: 'qun',
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    // 「使用牌结算结束」：目前引擎只在**杀**打完（attackSettled）时派发一次
    { timing: 'cardUseEnded', skillId: '成略', handler: askChenglue },
    { timing: 'afterDamage', skillId: '恃才', locked: true, handler: askShicai },
  ],
  skills: [
    {
      name: '成略',
      desc: '一名与你势力相同的角色使用一张目标数大于1的牌结算结束后，你可以令其摸一张牌；若你曾受到此牌造成的伤害，你可以令一名与你势力相同且没有【阴阳鱼】的角色获得一枚【阴阳鱼】。',
    },
    {
      name: '恃才',
      desc: '锁定技，当你受到一次伤害后，若此伤害的伤害值为1，你摸两张牌；若大于1，你弃置所有手牌。',
    },
  ],
};

/**
 * 诸葛恪 —— 傲才 / 黩武（不臣篇·下，**吴**，1.5 阴阳鱼 → 3，珠联璧合【丁奉】）。
 *
 * ⚠️ **国战【黩武】与身份场那条完全不是一回事**：这里是**限定技 + 群体军令**
 * （身份场的「弃 X 张牌造成 1 点伤害」**没有**实现、也不该混进来）。
 * 另：移动版这一页标注国战权限暂未开放，所以本仓库是在实现**已存在的规则定义**。
 *
 * 【黩武】（限定技，出牌阶段）：按**公共军令**机制（与董昭·劝进 / 王平·将略**同一套**
 * `api.armyOrderMulti`）令**攻击范围内**的每名「其他角色且（势力不同 **或未确定势力**）」
 * 依次选择执行 / 拒绝；拒绝者受到诸葛恪造成的 **1 点普通技能伤害**（先伤害、整条流程走完，
 * 然后诸葛恪摸 1）。全部处理完后，若**整个黩武结算期间**有人**进入濒死并被救回**，
 * 诸葛恪**失去 1 点体力**（只一次，不是伤害）。
 * - 目标在**发动时冻结**（之后装备/攻击范围变化不改变名单）；
 * - 「未确定势力」**算目标**（暗将也在范围内——这条最容易写错）；
 * - 濒死的两个出口（被技能救回 / 被【桃】救回）都记在 `state.duwuRescued`，
 *   所以「执行军令时被打进濒死」与「拒绝后被黩武伤害打进濒死」都算。
 *
 * 【傲才】**已实现**（`engine.onAocai` + 响应询问里的「【傲才】看牌堆顶两张」按钮）：
 * 回合外被要求使用/打出一张基本牌（【闪】【桃】【杀】）时，看**牌堆顶两张**、可直接**使用**其中一张
 * 满足要求——用的是**真实实体牌**（不经过手牌、不是虚拟牌、两张都不匹配就原样留在牌堆）。
 * ⚠️ 它是**定点实现**，没有落成 docs §5.116 设想的通用 `CardProvider` 抽象；将来再出现
 * 「从特殊区域提供响应牌」的技能时，把这个口子抽出来（欠账仍留在 §5.116）。
 */
function duwuTargets(state: GameState, me: Player): Player[] {
  const mine = effectiveFaction(state, me);
  return state.players.filter((p) => {
    if (!p.alive || p.seatId === me.seatId) return false;
    // 在**诸葛恪的攻击范围内**（方向是诸葛恪 → 对方；武器/加范围技能照常参与）
    if (!canTarget(state, me.seatId, p.seatId)) return false;
    const f = effectiveFaction(state, p);
    if (!f) return true; // 未确定势力也算（暗将）
    return f !== mine;
  });
}

const DUWU_SKILL: ActiveSkill = {
  id: 'duwu',
  name: '黩武',
  oncePerGame: true,
  minTargets: 0,
  maxTargets: 0,
  needsCards: false,
  canUse: (state, player) => duwuTargets(state, player).length > 0,
  execute: (state, player, _intent, api) => {
    const targets = duwuTargets(state, player);
    if (targets.length === 0) return '攻击范围内没有符合条件的角色';
    pushLog(state, 'skill', `${player.name} 发动【黩武】。`);
    // 结算期间记账（会挂起好几次询问，所以用 state 上的状态位）
    state.duwuWatchSeat = player.seatId;
    state.duwuRescued = false;
    api.armyOrderMulti(
      player.seatId,
      targets.map((t) => t.seatId),
      (st) => {
        const rescued = state.duwuRescued;
        state.duwuWatchSeat = null;
        state.duwuRescued = false;
        if (rescued && player.alive) {
          pushLog(
            st,
            'skill',
            `${player.name} 的【黩武】：结算期间有人进入濒死并被救回，失去 1 点体力。`,
            { seat: player.seatId },
          );
          api.loseHp(player, 1);
        }
      },
      {
        // 拒绝：**先**造成 1 点普通技能伤害（整条伤害/濒死流程走完），**再**摸 1
        onRefuse: (st, executorSeatId, next) => {
          const target = getPlayer(st, executorSeatId);
          if (!target || !target.alive) {
            next();
            return;
          }
          pushLog(
            st,
            'skill',
            `${target.name} 拒绝执行军令，受到【黩武】的 1 点普通伤害。`,
            { seat: player.seatId },
          );
          api.dealDamage(target, 1, player.seatId, undefined, () => {
            if (player.alive) {
              const c = drawOne(st);
              if (c) player.hand.push(c);
              pushLog(st, 'skill', `${player.name} 因【黩武】摸一张牌。`, {
                seat: player.seatId,
              });
            }
            next();
          });
        },
      },
    );
    return undefined;
  },
};

const ZHUGEKE: Hero = {
  id: 'zhugeke',
  name: '诸葛恪',
  pack: 'buchen',
  faction: 'wu',
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  combos: ['dingfeng'], // 珠联璧合【丁奉】
  aocai: true,
  activeSkills: [DUWU_SKILL],
  skills: [
    {
      name: '傲才',
      desc: '你的回合外，当你被要求使用或打出一张基本牌时，你可以观看牌堆顶的两张牌，然后使用其中一张满足要求的基本牌。',
    },
    {
      name: '黩武',
      desc: '限定技，出牌阶段，你可以令攻击范围内所有与你势力不同或未确定势力的其他角色依次选择是否执行一项「军令」：不执行者受到你造成的1点普通伤害，然后你摸一张牌。若此技能结算期间有角色进入濒死状态并被救回，你失去1点体力。',
    },
  ],
};

/**
 * 黄祖 —— 袭射（不臣篇·下，**群**，2 阴阳鱼 → 4，无珠联璧合）。
 *
 * 【袭射】两段：
 * ① **其他角色**的准备阶段（自己的不行）：可以**逐轮**「弃置**自己装备区**的一张牌 → 视为对该角色
 *    使用一张**纯虚拟普通【杀】**（无实体子牌、无花色点数、`generatedBy: 'xishe'`）」，无距离限制、
 *    不占本回合出杀次数；每张结算完才问下一轮，每轮**重新扫装备区**（中途新装上来的也能当成本），
 *    黄祖或该角色死了就停。
 * ② 该回合**结束时**（是 TurnEnd，不是结束阶段开始）：若本回合有人**死于袭射的杀造成的伤害**
 *    （因果链：死亡 ← 伤害 ← `generatedBy='xishe'` 的使用；**被救回来不算**、额外目标死了也算、
 *    一回合杀多人也只换一次），黄祖可以**变更一次副将**——新副将**暗置**、**不重算体力上限**、
 *    **已确定的势力不因新副将暗置而退回 null**（早期移动版有那个旧结算，已修正）。
 *
 * 目标级「不能响应」：每张袭射的杀**在使用时实时**判 `目标体力 < 黄祖体力`（严格小于；相等仍可响应），
 * 写在 `unrespondableTargets`（只锁该目标，与彭羕·嚣逆同一套）。
 */
function xisheCosts(me: Player): import('@sgs/protocol').Card[] {
  return EQUIP_SLOTS.map((sl) => me.equipment[sl]).filter((c): c is import('@sgs/protocol').Card => !!c);
}

function askXisheOne(ctx: HookContext, phaseSeatId: string): void {
  const state = ctx.state;
  const me = ctx.player;
  const phasePlayer = getPlayer(state, phaseSeatId);
  if (!me.alive || !phasePlayer || !phasePlayer.alive) return;
  const costs = xisheCosts(me);
  if (costs.length === 0) return; // 没有可弃的装备 → 流程结束（每轮都重新扫）
  ctx.api.askChoice(
    state,
    me.seatId,
    `【袭射】：是否弃置一张装备区的牌，视为对 ${phasePlayer.name} 使用一张普通【杀】？`,
    [
      { id: 'yes', label: '发动' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      const pool = xisheCosts(p);
      if (pool.length === 0) return;
      const fire = (st2: GameState, card: import('@sgs/protocol').Card): void => {
        // 成本是**真正的弃置**（执行者＝黄祖；会进「本回合弃置」账本）
        ctx.api.discardCard(p.seatId, card, () => {
          ctx.api.castVirtualSha(p.seatId, phaseSeatId, {
            logKind: 'skill',
            generatedBy: 'xishe',
            // 目标体力值**小于**黄祖 → 不能响应（每次使用时实时判，所以连射会越来越险）
            unrespondableTo: (s2, t) => t.hp < p.hp,
          });
        }, p.seatId);
        void st2;
      };
      if (pool.length === 1 && pool[0]) {
        fire(st, pool[0]);
        return;
      }
      ctx.api.askPickCards(
        st,
        p.seatId,
        '【袭射】：选择要弃置的装备牌',
        pool,
        1,
        1,
        (st2, _p, chosen) => {
          const card = chosen[0];
          if (card) fire(st2, card);
        },
      );
    },
  );
}

/** 【袭射】①：其他角色的准备阶段开始 */
function askXisheAtTurnStart(ctx: HookContext): void {
  const me = ctx.player;
  const turnSeatId = (ctx.payload as { turnSeatId?: string } | undefined)?.turnSeatId;
  if (!turnSeatId || turnSeatId === me.seatId) return; // 只在**其他角色**的准备阶段
  askXisheOne(ctx, turnSeatId);
}

/** 【袭射】①的续轮：每张袭射的杀**完整结算完**之后才问下一轮（还在此期间才算） */
function askXisheNext(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const attack = (ctx.payload as { attack?: AttackContext } | undefined)?.attack;
  if (attack?.sourceId !== me.seatId || attack.generatedBy !== 'xishe') return;
  // 还在那位角色的**准备阶段**里才继续（引擎里准备阶段 = phase 'judgment'）
  const turnSeatId = state.seatOrder[state.turn.seatIndex];
  if (state.turn.phase !== 'judgment' || !turnSeatId || turnSeatId === me.seatId) return;
  askXisheOne(ctx, turnSeatId);
}

/** 【袭射】②的门槛：本回合有人**死于袭射的杀** */
function noteXisheKill(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const killerId = (ctx.payload as { killerId?: string } | undefined)?.killerId;
  if (killerId !== me.seatId) return;
  if (state.lastDamageSourceId !== me.seatId) return;
  if (state.lastDamageGeneratedBy !== 'xishe') return;
  state.xisheKilledSeat = me.seatId;
  pushLog(state, 'skill', `${me.name} 的【袭射】：本回合有人死于袭射的【杀】。`, {
    seat: me.seatId,
  });
}

/** 【袭射】②：回合**结束**（TurnEnd）时可变更一次副将 */
function askXisheChangeDeputy(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  if (!me.alive || state.xisheKilledSeat !== me.seatId) return;
  ctx.api.askChoice(
    state,
    me.seatId,
    '【袭射】：是否变更一次副将（新副将暗置、不重算体力上限）？',
    [
      { id: 'yes', label: '变更副将' },
      { id: 'no', label: '不变更' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      pushLog(st, 'skill', `${p.name} 的【袭射】：变更副将。`, { seat: p.seatId });
      // 统一的「变更副将」原语：换出来的新副将**暗置**（引擎按换将规则处理，不重算体力上限）
      ctx.api.changeDeputyHero(p.seatId);
      const np = getPlayer(st, p.seatId);
      if (np) np.deputyRevealed = false;
    },
  );
}

const HUANGZU: Hero = {
  id: 'huangzu',
  name: '黄祖',
  pack: 'buchen',
  faction: 'qun',
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    { timing: 'othersTurnStart', skillId: '袭射', handler: askXisheAtTurnStart },
    { timing: 'attackSettled', skillId: '袭射', handler: askXisheNext },
    { timing: 'playerDied', skillId: '袭射', handler: noteXisheKill },
    { timing: 'turnEnd', skillId: '袭射', handler: askXisheChangeDeputy },
    // ⚠️ 袭射②是「**该回合**结束时」——他杀人的那个回合往往是**别人的**回合
    //    （袭射①只在其他角色的准备阶段发动），所以必须同时挂 othersTurnEnd，
    //    否则黄祖永远等不到那次换将机会（本轮补测试时发现的缺口）。
    { timing: 'othersTurnEnd', skillId: '袭射', handler: askXisheChangeDeputy },
  ],
  skills: [
    {
      name: '袭射',
      desc: '其他角色的准备阶段，你可以弃置自己装备区里的一张牌，视为对该角色使用一张无距离限制的普通【杀】（目标体力值小于你时不能响应此【杀】；此流程可重复）。若本回合有角色死于该【杀】造成的伤害，该回合结束时你可以变更一次副将（新副将暗置）。',
    },
  ],
};

/**
 * 不臣篇的**野心家武将**（势力本身就是「野」）——与「因人数超限被转成野心家」完全是两回事
 * （用户反复强调过：前者才关联「暴露野心 → 建立新势力」）。它们只能作主将（`pickHero` 已拦副将），
 * 且只在 `buchen: 'current'` 时进选将池。
 *
 * ⚠️ 与双势力同一状态：**技能文本未核到**（技能名见 docs/guozhan-roster.md §5.83），
 *    能力、暴露野心/建立新势力流程都还没实装。
 */
/**
 * SP司马昭 —— 昭心 / 夙智（不臣篇·下，**野心家武将本体**，1.5 阴阳鱼 → 3；移动版现行口径，见 §5.101）。
 *
 * ⚠️ 这是「**野心家武将**」（`faction: 'ambitionist'`，即野势力本体），与「普通势力人数超限后
 *    转化出来的野心家」是两回事——后者由 `revealHeroCard` 里的人数判定产生，本武将不参与那套。
 *
 * 【昭心】受到**一次**伤害后（DamageEvent 粒度，不按点数）：可以公开展示自己全部手牌，
 *   然后令一名**手牌数不大于自己**的其他角色与自己**交换全部手牌**（走 `api.swapHands` 原子交换）。
 * 【夙智】（锁定技，仅自己回合内）：三个子效果**共用 3 次额度**：
 *   ① 自己使用的【杀】/【决斗】对其他角色实际造成伤害时，此伤害 +1（走 `Hero.damageDelta`，
 *      进统一的伤害修正链；被闪/被防止不消耗次数，2 点伤害也只 +1 一次）；
 *   ② 使用锦囊牌无距离限制，且每使用一张锦囊摸 1 张（第 3 次本身完整生效后才失效）；
 *   ③ 其他角色因**弃置**进弃牌堆时，获得其中 1 张（挂 `anyCardDiscarded`，同一批只拿 1 张）。
 *   回合结束时若本回合触发**不足 3 次**，获得临时【反馈】，持续到**自己的下个回合开始**。
 */
function suzhiAvailable(state: GameState, me: Player): boolean {
  if (state.turn.seatIndex !== state.seatOrder.indexOf(me.seatId)) return false; // 仅自己回合
  return state.suzhiTriggers < 3;
}

/** 【夙智】：消耗一次额度；用满 3 次后本回合失效（同时关掉「锦囊无距离」） */
function consumeSuzhi(state: GameState, me: Player): void {
  state.suzhiTriggers += 1;
  if (state.suzhiTriggers >= 3) me.flags.ignoresTrickDistanceThisTurn = false;
}

/** 【昭心】：一次伤害后，交换双方**全部手牌**（目标是手牌数不大于自己的其他角色） */
function askZhaoxin(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const payload = ctx.payload as { damage?: number } | undefined;
  if (!payload?.damage) return;
  const cands = state.players.filter(
    (p) => p.alive && p.seatId !== me.seatId && p.hand.length <= me.hand.length,
  );
  ctx.api.askChoice(
    state,
    me.seatId,
    cands.length === 0
      ? '【昭心】：没有手牌数不大于你的其他角色，是否仍展示手牌？（无目标则无事发生）'
      : '【昭心】：是否公开全部手牌，并与一名手牌数不大于你的角色交换全部手牌？',
    [
      ...cands.map((p) => ({ id: p.seatId, label: `${p.name}（${p.hand.length} 张手牌）` })),
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked === 'no') return;
      // 公开展示全部手牌（日志是公开信息）
      pushLog(
        st,
        'skill',
        `${p.name} 发动【昭心】，公开手牌：${p.hand.map((c) => `【${cardLabel(c)}】`).join('、') || '（无）'}。`,
        { seat: p.seatId },
      );
      const t = getPlayer(st, picked);
      if (!t || !t.alive) return;
      // 目标合法性按**发动时**的当前手牌数再确认一次（询问是跨步的）
      if (t.hand.length > p.hand.length) return;
      ctx.api.swapHands(p.seatId, t.seatId);
      pushLog(st, 'skill', `${p.name} 与 ${t.name} 交换了全部手牌（【昭心】）。`, {
        seat: p.seatId,
      });
    },
  );
}

/** 【夙智】①：自己回合内，自己用的【杀】/【决斗】对他人造成伤害时 +1（被闪/被防止不消耗额度） */
function suzhiDamageDelta(
  state: GameState,
  me: Player,
  atk: { sourceId?: string; targetId?: string },
): number {
  if (!suzhiAvailable(state, me)) return 0;
  if (atk.sourceId !== me.seatId || atk.targetId === me.seatId) return 0;
  return 1;
}

/** 【夙智】①的额度结算：伤害**真的落地**后（afterDamageDealt）才消耗一次 */
function suzhiOnDealt(ctx: HookContext): void {
  const me = ctx.player;
  const state = ctx.state;
  if (!suzhiAvailable(state, me)) return;
  const attack = (ctx.payload as { attack?: AttackContext } | undefined)?.attack;
  if (!attack || attack.sourceId !== me.seatId || attack.targetId === me.seatId) return;
  if (attack.asType !== 'sha' && attack.cardId === '') return;
  // 只有这次伤害确实来自【杀】或【决斗】的攻击上下文才算
  if (!(attack.asType === 'sha' || attack.asType === 'juedou')) return;
  consumeSuzhi(state, me);
  pushLog(state, 'skill', `${me.name} 的【夙智】：此伤害 +1（本回合第 ${state.suzhiTriggers} 次）。`, {
    seat: me.seatId,
  });
}

/** 【夙智】②：自己回合内使用锦囊 → 摸 1（并消耗一次额度；无距离限制由标记提供） */
function suzhiOnTrick(ctx: HookContext): void {
  const me = ctx.player;
  const state = ctx.state;
  if (!suzhiAvailable(state, me)) return;
  const card = (ctx.payload as { card?: Card } | undefined)?.card;
  if (!card) return;
  if (isBasicCard(card) || isEquipCard(card)) return; // 只认锦囊牌
  const c = drawOne(state);
  if (c) me.hand.push(c);
  consumeSuzhi(state, me);
  pushLog(
    state,
    'skill',
    `${me.name} 的【夙智】：使用锦囊摸了一张牌（本回合第 ${state.suzhiTriggers} 次）。`,
    { seat: me.seatId },
  );
}

/**
 * 【夙智】③：**其他角色**的牌因**弃置**进入弃牌堆时，获得其中 1 张（同一批只拿 1 张，计 1 次）。
 * 挂在 `cardDiscarded`（引擎里「因弃置」的收口，payload 带整批 `cards`，且**只有弃置**走它——
 * 用牌/响应/判定进弃牌堆都不算）。跨步安全：只从**此刻仍在弃牌堆**的牌里选。
 */
function suzhiOnDiscarded(ctx: HookContext): void {
  // 挂 `anyCardDiscarded`（**派给全场**）：ctx.player 是技能拥有者（司马昭本人），
  // payload.ownerSeatId 才是**弃牌的人**——「其他角色」由这一句排掉。
  const suzhi = ctx.player;
  const state = ctx.state;
  const payload = ctx.payload as { cards?: Card[]; ownerSeatId?: string } | undefined;
  const discarderSeat = payload?.ownerSeatId;
  if (!discarderSeat || discarderSeat === suzhi.seatId) return;
  const discarder = getPlayer(state, discarderSeat);
  if (!discarder) return;
  if (!suzhiAvailable(state, suzhi)) return;
  const cards = payload?.cards ?? [];
  const pool: Card[] = [];
  for (const c of cards) {
    const still = state.discard.find((x) => x.id === c.id);
    if (still) pool.push(still); // 必须**仍在弃牌堆**（可能已被别的效果拿走）
  }
  if (pool.length === 0) return;
  ctx.api.askChoice(
    state,
    suzhi.seatId,
    `【夙智】：${discarder.name} 弃置了 ${pool.length} 张牌，是否获得其中一张？`,
    [
      ...pool.map((c) => ({ id: c.id, label: `获得【${cardLabel(c)}】` })),
      { id: 'no', label: '不获得' },
    ],
    (st, p, picked) => {
      if (picked === 'no') return;
      const idx = st.discard.findIndex((c) => c.id === picked);
      if (idx < 0) return; // 跨步：已经被拿走了
      const [card] = st.discard.splice(idx, 1);
      if (!card) return;
      p.hand.push(card);
      consumeSuzhi(st, p);
      pushLog(
        st,
        'skill',
        `${p.name} 的【夙智】：获得 ${discarder.name} 弃置的【${cardLabel(card)}】（本回合第 ${st.suzhiTriggers} 次）。`,
        { seat: p.seatId },
      );
    },
  );
}

/** 【夙智】回合结束：本回合触发不足 3 次 → 获得临时【反馈】（持续到自己的下个回合开始） */
function suzhiOnTurnEnd(ctx: HookContext): void {
  const me = ctx.player;
  const state = ctx.state;
  if (state.suzhiTriggers >= 3) return;
  if (me.grantedSkills.some((g) => g.skillName === '反馈')) return; // 已经有了（别的来源给的就别重复发）
  me.grantedSkills.push({ heroId: 'simayi', skillName: '反馈' });
  pushLog(
    state,
    'skill',
    `${me.name} 的【夙智】：本回合触发 ${state.suzhiTriggers} 次（不足 3 次），获得【反馈】直到自己的下个回合开始。`,
    { seat: me.seatId },
  );
}

/** 自己的回合开始时：收回【夙智】给的临时【反馈】、打开「锦囊无距离」标记 */
function suzhiOnTurnStart(ctx: HookContext): void {
  const me = ctx.player;
  const state = ctx.state;
  const before = me.grantedSkills.length;
  me.grantedSkills = me.grantedSkills.filter((g) => g.skillName !== '反馈');
  if (me.grantedSkills.length !== before) {
    pushLog(state, 'skill', `${me.name} 的【反馈】到期失效（【夙智】的临时授予）。`, {
      seat: me.seatId,
    });
  }
  me.flags.ignoresTrickDistanceThisTurn = true; // 夙智②的距离部分（用满 3 次或回合结束即关）
}

const SP_SIMAZHAO: Hero = {
  id: 'sp_simazhao',
  name: 'SP司马昭',
  pack: 'buchen',
  faction: 'ambitionist', // **野心家武将本体**（野势力），不是人数超限转化出来的那种
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  combos: ['simayi'], // 珠联璧合：界司马懿
  skillFields: { 夙智: ['damageDelta'] },
  damageDelta: (state, me, atk) => suzhiDamageDelta(state, me, atk),
  hooks: [
    { timing: 'afterDamage', skillId: '昭心', handler: askZhaoxin },
    { timing: 'afterDamageDealt', skillId: '夙智', locked: true, handler: suzhiOnDealt },
    { timing: 'useCard', skillId: '夙智', locked: true, handler: suzhiOnTrick },
    { timing: 'anyCardDiscarded', skillId: '夙智', locked: true, handler: suzhiOnDiscarded },
    { timing: 'turnStart', skillId: '夙智', locked: true, handler: suzhiOnTurnStart },
    { timing: 'turnEnd', skillId: '夙智', locked: true, handler: suzhiOnTurnEnd },
  ],
  skills: [
    {
      name: '昭心',
      desc: '当你受到伤害后，你可以公开展示你的所有手牌，然后令一名手牌数不大于你的其他角色与你交换所有手牌。',
    },
    {
      name: '夙智',
      desc: '锁定技，在你的回合内，你使用【杀】或【决斗】对其他角色造成的伤害+1；你使用锦囊牌无距离限制且每使用一张锦囊牌摸一张牌；其他角色因弃置而进入弃牌堆的牌，你获得其中一张。以上效果每回合共可触发三次，第三次结算完毕后此技能于本回合失效。回合结束时若本回合触发次数不足三次，你获得【反馈】直到你的下个回合开始。',
    },
  ],
};

/**
 * 公孙渊 —— 怀异 / 恣睢（不臣篇·下，**野心家武将本体**，2 阴阳鱼 → 4；移动版 2021 口径，见 §5.103）。
 *
 * ⚠️ 版本边界（用户 2026-09 明确）：**移动版 2021 没有**「必须红黑双色」前提，也**没有**
 *    「异可如手牌使用/打出」——那两条是线下 2022/2025 典藏版；本仓库取移动版。
 *
 * 【怀异】（出牌阶段限一次）：展示全部手牌 → 选择其中**存在的一种颜色**（红/黑）→ 弃掉该颜色的
 *   **全部**手牌 → X＝实际弃掉的手牌数 → 至多选择 X 名**不同**的其他角色，各获得其一张牌；
 *   本次获得的牌里**凡是装备牌**的，置于武将牌旁成为「异」（看牌的类型，不看它原来在哪个区域）。
 * 【恣睢】（锁定技）：① 摸牌阶段额外摸 X 张（X＝当前「异」数，走摸牌数修正 `drawCountDelta`，
 *   **不是**另开一次摸牌）② 结束阶段开始时若 X **大于**体力上限 → **直接死亡**（不是失去体力、
 *   不是伤害、不进濒死救援）。「异」数每次现算，不设计数器。
 */
function askHuaiyi(state: GameState, player: Player, api: SkillApi): string | undefined {
  if (player.hand.length === 0) return '【怀异】需要至少一张手牌';
  // 展示全部手牌（公开信息）
  pushLog(
    state,
    'skill',
    `${player.name} 发动【怀异】，展示全部手牌：${player.hand.map((c) => `【${cardLabel(c)}】`).join('、')}。`,
    { seat: player.seatId },
  );
  const colorOf = (c: Card): 'red' | 'black' => (cardColor(c) === 'red' ? 'red' : 'black');
  const colors = [...new Set(player.hand.map(colorOf))];
  const finish = (st: GameState, me: Player, obtained: Card[]): void => {
    // 本次获得的牌里**装备牌**成为「异」（看牌的类型，不看来源区域）
    const equips = obtained.filter((c) => isEquipCard(c));
    if (equips.length === 0) return;
    const still: Card[] = [];
    for (const c of equips) {
      const i = me.hand.findIndex((x) => x.id === c.id);
      if (i < 0) continue; // 跨步：已经不在了就不强搬
      const [card] = me.hand.splice(i, 1);
      if (!card) continue;
      me.yi.push(card);
      still.push(card);
    }
    if (still.length > 0) {
      pushLog(
        st,
        'skill',
        `${me.name} 的【怀异】：${still.map((c) => `【${cardLabel(c)}】`).join('、')} 置于武将牌旁成为「异」（共 ${me.yi.length} 张）。`,
        { seat: me.seatId },
      );
    }
  };
  const pickTargets = (st0: GameState, me: Player, left: number, picked: string[], obtained: Card[]): void => {
    if (left <= 0) {
      finish(st0, me, obtained);
      return;
    }
    const cands = st0.players.filter(
      (q) => q.alive && q.seatId !== me.seatId && !picked.includes(q.seatId) && handAndEquipOf(q).length > 0,
    );
    if (cands.length === 0) {
      finish(st0, me, obtained);
      return;
    }
    api.askChoice(
      st0,
      me.seatId,
      `【怀异】：选择第 ${picked.length + 1} 名角色获得其一张牌（至多 ${left + picked.length} 名，可提前结束）`,
      [
        ...cands.map((q) => ({ id: q.seatId, label: `${q.name}（${q.hand.length} 张手牌）` })),
        { id: 'stop', label: '结束选择' },
      ],
      (st, p, pickedId) => {
        if (pickedId === 'stop') {
          finish(st, p, obtained);
          return;
        }
        const t = getPlayer(st, pickedId);
        if (!t) {
          pickTargets(st, p, left - 1, picked, obtained);
          return;
        }
        // takeOneOfTargetCards 的回调不带参数：用「拿牌前后手牌差集」认出拿到的那张
        const beforeIds = new Set(p.hand.map((c) => c.id));
        takeOneOfTargetCards(st, p, t, api, '怀异', () => {
          const got = p.hand.find((c) => !beforeIds.has(c.id));
          pushLog(st, 'skill', `${p.name} 的【怀异】：获得了 ${t.name} 的一张牌。`, {
            seat: p.seatId,
          });
          pickTargets(st, p, left - 1, [...picked, pickedId], got ? [...obtained, got] : obtained);
        });
      },
    );
  };
  api.askChoice(
    state,
    player.seatId,
    `【怀异】：选择要**全部弃置**的颜色（本次弃几张，就能选几名角色）`,
    colors.map((c) => ({
      id: c,
      label: `${c === 'red' ? '红色' : '黑色'}（${player.hand.filter((x) => colorOf(x) === c).length} 张）`,
    })),
    (st, p, picked) => {
      const cards = p.hand.filter((c) => colorOf(c) === picked);
      if (cards.length === 0) return;
      api.discardCards(p.seatId, cards, () => {
        pushLog(
          st,
          'skill',
          `${p.name} 的【怀异】：弃置${picked === 'red' ? '红' : '黑'}色手牌 ${cards.length} 张。`,
          { seat: p.seatId },
        );
        pickTargets(st, p, cards.length, [], []);
      });
    },
    player.seatId,
  );
  return undefined;
}

/** 【恣睢】①：摸牌阶段额外摸「异」张（走摸牌数修正，不是另开一次摸牌） */
function zisuiDraw(ctx: HookContext): void {
  const me = ctx.player;
  const state = ctx.state;
  if (me.yi.length === 0) return;
  me.flags.drawCountDelta += me.yi.length;
  pushLog(
    state,
    'skill',
    `${me.name} 的【恣睢】：摸牌阶段额外摸 ${me.yi.length} 张（「异」数）。`,
    { seat: me.seatId },
  );
}

/** 【恣睢】②：结束阶段开始时，若「异」数**大于**体力上限 → **直接死亡**（不进濒死救援） */
function zisuiDeath(ctx: HookContext): void {
  const me = ctx.player;
  const state = ctx.state;
  if (me.yi.length <= me.maxHp) return; // 等于也不死（严格大于）
  ctx.api.kill(me.seatId, '恣睢');
}

const GONGSUNYUAN: Hero = {
  id: 'gongsunyuan',
  name: '公孙渊',
  pack: 'buchen',
  faction: 'ambitionist', // 野心家武将本体（野势力）
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  activeSkills: [
    {
      id: 'huaiyi',
      name: '怀异',
      oncePerTurn: true,
      minTargets: 0,
      maxTargets: 0,
      needsCards: false,
      canUse: (_state, player) => player.hand.length > 0,
      execute: (state, player, _intent, api) => askHuaiyi(state, player, api),
    },
  ],
  hooks: [
    { timing: 'drawPhase', skillId: '恣睢', locked: true, handler: zisuiDraw },
    { timing: 'turnEnd', skillId: '恣睢', locked: true, handler: zisuiDeath },
  ],
  skills: [
    {
      name: '怀异',
      desc: '出牌阶段限一次，你可以展示所有手牌，然后弃置其中一种颜色的所有手牌（X 为你以此法弃置的手牌数），令至多 X 名其他角色各交给你一张牌。若你以此法获得了装备牌，将这些装备牌置于你的武将牌旁，称为「异」。',
    },
    {
      name: '恣睢',
      desc: '锁定技，摸牌阶段，你额外摸 X 张牌（X 为「异」的数量）；结束阶段开始时，若你的「异」的数量大于你的体力上限，你死亡。',
    },
  ],
};

/**
 * 刘巴 —— 统度 / 清隐（不臣篇·下，蜀，1.5 阴阳鱼 → 3；移动版现行口径，见 §5.105）。
 *
 * 【统度】与刘巴势力相同的角色进入**结束阶段时**，**由该角色本人决定**是否摸 X 张：
 *   X＝其**本回合弃牌阶段弃置的牌数**（按**张**算，**至多 3**）。只数弃牌阶段（出牌阶段弃的
 *   代价牌不算）、只数该角色自己弃的；X＝0 时不弹无意义窗口。
 *   ⚠️ 版本差异：较早的 2021 规则集写成「刘巴**可以令其**摸」，当前移动版页面写的是
 *   「**该角色可以**摸」——本仓库取移动版口径（决定权在结束阶段角色本人）。
 * 【清隐】（**限定技**）：出牌阶段，所有与刘巴势力相同的角色把体力**回复至各自上限**（走正常
 *   回复流程，各人独立算回复量），然后**移除刘巴这张武将牌**（走公共的 removeHeroCard：
 *   主将/副将位都行，替换为该势力同性别的士兵牌；不是把槽位置空、也不是删技能）。
 *   ⚠️「移除武将牌」与「变更副将」是两回事（后者会另抽一张新副将替换），不要共用实现。
 */
function tongduX(state: GameState, seatId: string): number {
  return Math.min(state.discardPhaseCountsThisTurn[seatId] ?? 0, 3);
}

/** 统度：某人的结束阶段 → 若他与刘巴同势力且 X>0，问**他本人**要不要摸 X 张 */
function askTongdu(
  state: GameState,
  me: Player,
  endingSeatId: string | undefined,
  api: SkillApi,
): void {
  if (!endingSeatId) return;
  const ending = getPlayer(state, endingSeatId);
  if (!ending || !ending.alive) return;
  const mine = effectiveFaction(state, me);
  if (!mine) return;
  if (effectiveFaction(state, ending) !== mine) return; // 同势力（都要求已确定）
  const x = tongduX(state, ending.seatId);
  if (x <= 0) return; // 不弹「摸 0 张」的无意义窗口
  // 当前移动版口径：**由结束阶段的角色本人决定**是否摸
  api.askChoice(
    state,
    ending.seatId,
    `【统度】（${me.name}）：是否摸 ${x} 张牌？（本回合弃牌阶段弃了 ${state.discardPhaseCountsThisTurn[ending.seatId] ?? 0} 张）`,
    [
      { id: 'yes', label: `摸 ${x} 张` },
      { id: 'no', label: '不摸' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      let got = 0;
      for (let i = 0; i < x; i++) {
        const c = drawOne(st);
        if (!c) break;
        p.hand.push(c);
        got++;
      }
      pushLog(st, 'skill', `${p.name} 因【统度】摸了 ${got} 张牌。`, { seat: p.seatId });
    },
  );
}

const LIUBA: Hero = {
  id: 'liuba',
  name: '刘巴',
  pack: 'buchen', // 不臣篇·下（不臣篇开关关闭时不进选将池）
  faction: 'shu',
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  activeSkills: [
    {
      id: 'qingyin',
      name: '清隐',
      oncePerGame: true, // 限定技
      minTargets: 0,
      maxTargets: 0,
      needsCards: false,
      canUse: () => true,
      execute: (state, player, _intent, api) => {
        const mine = effectiveFaction(state, player);
        pushLog(state, 'skill', `${player.name} 发动【清隐】。`, { seat: player.seatId });
        // 先回血（各自回复至上限，走正常回复流程）——即使没人受伤也要继续移除武将牌
        const allies = mine
          ? state.players.filter((p) => p.alive && effectiveFaction(state, p) === mine)
          : [];
        const healedNames: string[] = [];
        for (const t of allies) {
          const amount = Math.max(0, t.maxHp - t.hp);
          if (amount <= 0) continue;
          const healed = api.heal(t, amount);
          healedNames.push(`${t.name}（+${healed}）`);
        }
        if (healedNames.length > 0) {
          pushLog(state, 'skill', `${player.name} 的【清隐】：${healedNames.join('、')} 回复至体力上限。`, {
            seat: player.seatId,
          });
        }
        // 再移除刘巴这张武将牌（主将/副将位都行；替换为该势力同性别的士兵牌）
        api.removeHeroCard(player.seatId, 'liuba');
        return undefined;
      },
    },
  ],
  hooks: [
    // 自己的结束阶段走 turnEnd；**别人**的结束阶段走 othersTurnEnd（国战里「他人的阶段」的既有机制）
    {
      timing: 'turnEnd',
      skillId: '统度',
      locked: true,
      handler: (ctx) => askTongdu(ctx.state, ctx.player, ctx.player.seatId, ctx.api),
    },
    {
      timing: 'othersTurnEnd',
      skillId: '统度',
      locked: true,
      handler: (ctx) =>
        askTongdu(
          ctx.state,
          ctx.player,
          (ctx.payload as { turnSeatId?: string } | undefined)?.turnSeatId,
          ctx.api,
        ),
    },
  ],
  skills: [
    {
      name: '统度',
      desc: '与你势力相同的角色进入结束阶段时，该角色可以摸 X 张牌（X 为其本回合弃牌阶段弃置的牌数，至多 3）。',
    },
    {
      name: '清隐',
      desc: '限定技，出牌阶段，你可以令所有与你势力相同的角色将体力回复至其体力上限，然后移除此武将牌。',
    },
  ],
};

/**
 * 夏侯霸 —— 豹烈（不臣篇·下，**魏/蜀双势力**，2 阴阳鱼 → 4；移动版现行口径，见 §5.106）。
 *
 * 【豹烈】（**锁定技**）两个子效果，底层拆开（UI 上仍是一个技能）：
 * ① **进入出牌阶段时**（`playPhase`，锁定、不可选择不发动）：把「**攻击范围内包含夏侯霸**」的
 *   其他势力（都已确定势力）角色**做一次快照**，按座次依次处理——其可以**使用**一张【杀】
 *   指定夏侯霸（走完整使用流程，可被闪、可触发技能；实体杀/转化杀/丈八都行，与徐庶·诛害同一套
 *   取牌方式）；**不使用**则由**夏侯霸**弃置其一张牌（明牌可选、手牌随机，沿用引擎既有的
 *   `discardTargetCard` 语义）；某人整张【杀】结算完之后才轮到下一个人；夏侯霸中途死亡即刻停止。
 * ② 夏侯霸对**当前体力 ≥ 自己当前体力**的角色使用【杀】时，**无距离限制、无次数限制**——
 *   两个都是**目标级**修正（新增通用接口 `Hero.ignoreShaDistanceTo` / `Hero.shaBypassLimit`）：
 *   距离只对满足条件的目标放行；次数只有**整张杀的这批目标全都满足**才豁免，且每次声明使用都
 *   现场读双方当前体力（不缓存）。
 *
 * 待办（见 §5.106）：① 引擎的杀使用入口（`useShaOn`）一次只支持**单个**目标，所以【豹烈①】里
 *   方天画戟那种「合法多目标杀（含夏侯霸）」的用法暂时打不出来（文本允许）；② 未确定势力角色
 *   暂不进入【豹烈①】候选（详细规则集写「与你势力不同的角色」，与会盟/问计同一口径）。
 */
function askBaoliePlayPhase(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const api = ctx.api;
  const mine = effectiveFaction(state, me);
  if (!mine) return;
  // 候选**快照**：已确定势力、与夏侯霸不同势力、且**其攻击范围内包含夏侯霸**（方向别写反）
  const cands = state.players.filter((t) => {
    if (!t.alive || t.seatId === me.seatId) return false;
    const tf = effectiveFaction(state, t);
    if (!tf || tf === mine) return false;
    return canTarget(state, t.seatId, me.seatId); // canTarget(from,to) = 攻击范围 ≥ 距离
  });
  const step = (i: number): void => {
    if (i >= cands.length) return;
    if (!me.alive) return; // 夏侯霸中途死亡 → 后续豹烈①停止
    const t = getPlayer(state, cands[i]!.seatId);
    if (!t || !t.alive) {
      step(i + 1);
      return;
    }
    const shas = usableShaCards(state, t); // 实体杀 + 转化杀（武圣那类）
    const withZhangba = t.equipment.weapon?.equipName === 'zhangba' && t.hand.length >= 2;
    const use = (card: Card, extra?: string[]): void => {
      pushLog(state, 'skill', `${t.name} 因【豹烈】对 ${me.name} 使用一张【杀】。`, {
        seat: t.seatId,
      });
      // 走完整使用流程；after = 这张【杀】整个结算完之后才轮到下一个人
      api.useShaOn(t.seatId, me.seatId, card, {
        logKind: 'skill',
        ...(extra ? { extraCardIds: extra } : {}),
        after: () => step(i + 1),
      });
    };
    const punish = (): void => {
      // 不使用【杀】→ **夏侯霸**（不是对方）弃置其一张牌；明牌可选、手牌随机
      const picks = handAndEquipOf(t).filter((c) => !t.hand.some((x) => x.id === c.id));
      api.askChoice(
        state,
        me.seatId,
        `${t.name} 没有使用【杀】，【豹烈】：弃置其一张牌`,
        [
          ...picks.map((c) => ({ id: c.id, label: `弃置【${cardLabel(c)}】` })),
          { id: 'random', label: '随机弃置其一张手牌' },
          { id: 'none', label: '其没有可弃置的牌' },
        ].filter((o) => o.id !== 'none' || picks.length === 0),
        (st, p, picked) => {
          if (picked === 'none') {
            step(i + 1);
            return;
          }
          p.seatId; // 选择者就是夏侯霸（api.askChoice 已按 me.seatId 发问）
          ctx.api.discardTargetCard(
            t.seatId,
            picked === 'random' ? undefined : picked,
            () => {
              pushLog(st, 'skill', `${p.name} 因【豹烈】弃置了 ${t.name} 的一张牌。`, {
                seat: p.seatId,
              });
              step(i + 1);
            },
          );
        },
      );
    };
    const options = [
      { id: 'no', label: '不使用【杀】（由其弃你一张牌）' },
      ...shas.map((c) => ({ id: c.id, label: `使用【${cardLabel(c)}】` })),
      ...(withZhangba ? [{ id: 'zhangba', label: '【丈八蛇矛】：两张手牌当【杀】' }] : []),
    ];
    if (shas.length === 0 && !withZhangba) {
      punish();
      return;
    }
    api.askChoice(state, t.seatId, `【豹烈】：是否对 ${me.name} 使用一张【杀】？`, options, (st, _p, picked) => {
      if (picked === 'no') {
        punish();
        return;
      }
      if (picked === 'zhangba') {
        api.askPickCards(
          st,
          t.seatId,
          '【豹烈】·【丈八蛇矛】：选择两张手牌当【杀】',
          t.hand.slice(),
          2,
          2,
          (_st2, _p2, chosen) => {
            const [c1, c2] = chosen;
            if (!c1 || !c2) {
              punish();
              return;
            }
            use(c1, [c2.id]);
          },
        );
        return;
      }
      const c = t.hand.find((x) => x.id === picked);
      if (c) use(c);
      else punish();
    });
  };
  step(0);
}

const XIAHOUBA: Hero = {
  id: 'xiahouba',
  name: '夏侯霸',
  pack: 'buchen',
  faction: 'wei',
  secondFaction: 'shu',
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  combos: ['jiangwei'], // 珠联璧合：姜维
  skillFields: { 豹烈: ['shaBypassLimit', 'ignoreShaDistanceTo'] },
  // ② 两个**目标级**修正（每次使用现场读双方当前体力，不缓存）
  ignoreShaDistanceTo: (_state, owner, targetId) => {
    const t = _state.players.find((p) => p.seatId === targetId);
    return !!t && t.seatId !== owner.seatId && t.hp >= owner.hp;
  },
  shaBypassLimit: (state, owner, targetIds) => {
    if (targetIds.length === 0) return false;
    // **整批目标全都满足**才豁免：有一个低血目标就不算
    return targetIds.every((id) => {
      const t = state.players.find((p) => p.seatId === id);
      return !!t && t.seatId !== owner.seatId && t.hp >= owner.hp;
    });
  },
  hooks: [{ timing: 'playPhase', skillId: '豹烈', locked: true, handler: askBaoliePlayPhase }],
  skills: [
    {
      name: '豹烈',
      desc: '锁定技，你进入出牌阶段时，所有攻击范围内包含你的其他势力角色依次可以对你使用一张【杀】，若不使用，你弃置其一张牌；你使用【杀】指定体力值不小于你的角色为目标时，无距离和次数限制。',
    },
  ],
};

/**
 * 孙綝 —— 嗜戮 / 凶虐（不臣篇·下，**野心家武将本体**，2 阴阳鱼 → 4；移动版 2021 线上口径，见 §5.107）。
 *
 * 【嗜戮】：① 角色**死亡时**，孙綝可以收走该角色**仍然存在**的武将牌（已移除的收不到、用士兵牌
 *   顶替的也不算）作为「戮」——**是真实的武将牌**（记 id + **这张牌牌面上的势力集合**：双势力牌两个都算，§5.131），
 *   不是计数标记；
 *   若此人是**孙綝杀死**的，再从未登场武将牌堆额外取至多 2 张（不足就取多少算多少，不凭空造牌）。
 *   ② **准备阶段**：有戮则（至多戮数）弃牌 + 摸**实际弃牌数**张（与【制衡】那类「弃几摸几」同形）。
 * 【凶虐】：① **出牌阶段开始时**消费 1 张戮（**自己选**哪一张，因为不同戮的势力不同）→ 三选一，
 *   持续到本回合结束：对**该戮势力**的角色伤害 +1 / 造成伤害后获得其一张牌（一次伤害事件一张）/
 *   对其使用牌无次数限制。② **出牌阶段结束时**消费 2 张戮（势力不限）→ 直到**自己的下个回合开始**
 *   受到**其他角色**的伤害 -1（每次伤害事件都生效；减到 0 视为没造成伤害）。
 * ⚠️ ② 的时点严格是**出牌阶段结束时**：出牌阶段被跳过（乐不思蜀）就没有这个窗口。
 */
function luFactionOf(entry: { faction: Faction | null }): Faction | null {
  return entry.faction;
}

/** 嗜戮①：有人死亡 → 收其仍存在的武将牌；若是我杀的，再从未登场武将堆取至多 2 张 */
function askShilu(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const payload = ctx.payload as { victimId?: string; killerId?: string } | undefined;
  const victimId = payload?.victimId;
  if (!victimId || victimId === me.seatId) return;
  const victim = getPlayer(state, victimId);
  if (!victim) return;
  // 仍存在的武将牌：主/副将位里**没被移除**的那些（移除过的已经换成士兵牌）
  const collectable = [victim.heroId, victim.deputyHeroId].filter(
    (id): id is string => !!id && !victim.removedHeroIds.includes(id),
  );
  if (collectable.length === 0) return; // 两张都被移除 → 没有可收的武将牌
  const iKilled = payload?.killerId === me.seatId;
  const faction = victim.determinedFaction ?? victim.faction;
  ctx.api.askChoice(
    state,
    me.seatId,
    `【嗜戮】：是否收走 ${victim.name} 的武将牌作为「戮」？（${collectable.length} 张${iKilled ? '，且你亲手杀死，可再从未登场武将堆取至多 2 张' : ''}）`,
    [
      { id: 'yes', label: '发动' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      const names: string[] = [];
      for (const id of collectable) {
        p.lu.push({ heroId: id, factions: printedFactionsOf(id) });
        names.push(getHeroForMode(id, st.mode)?.name ?? id);
      }
      if (iKilled) {
        // 从未登场武将牌堆取（左慈·汲魂同一套资源；不足就取多少算多少）
        for (let k = 0; k < 2; k++) {
          const id = st.heroPool.shift();
          if (!id) break;
          const h = getHeroForMode(id, st.mode);
          // 从**未登场武将牌堆**随机取来的那张：同样按**牌面势力**记（双势力牌 → 两个都算）。
          // 用户 2026-09 口径：不是二选一，也不是沿用该武将死亡前所属角色的单一势力（§5.131）。
          p.lu.push({ heroId: id, factions: printedFactionsOf(id) });
          names.push(h?.name ?? id);
        }
      }
      pushLog(st, 'skill', `${p.name} 的【嗜戮】：收得「戮」${names.map((n) => `【${n}】`).join('、')}（共 ${p.lu.length} 张）。`, {
        seat: p.seatId,
      });
    },
  );
}

/**
 * **武将牌牌面**上的势力标签（可以有多个）。
 *
 * ⚠️ 与「角色的势力」（`effectiveFaction`／`determinedFaction`，**只能有一个**）是两回事：
 * 一张双势力武将牌脱离角色、作为**武将牌资源**存在时（孙綝的「戮」、左慈的「魂」）
 * 同时对应**牌面上的两个势力**——依据是移动版不臣篇对左慈【汲魂】+ 双势力魂的实测
 * （用户 2026-09 给的证据链，见 docs §5.121）。所以「戮」不再存单个 `faction`。
 */
export function printedFactionsOf(heroId: string): Faction[] {
  const h = getHero(heroId);
  if (!h) return [];
  return h.secondFaction ? [h.faction, h.secondFaction] : [h.faction];
}

/** 这个「戮」是否对某角色生效（角色**已确定**的势力落在这张牌面的势力集合里） */
function luMatchesPlayer(state: GameState, entry: { factions: Faction[] }, p: Player): boolean {
  const f = effectiveFaction(state, p);
  return !!f && entry.factions.includes(f);
}

/** 嗜戮②（准备阶段）+ 凶虐效果到期：换牌 & 清掉上一回合的凶虐状态 */
function askShiluPrepare(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  // 凶虐：① 的攻击效果只在本回合有效（新回合开始即失效）；② 的防御持续到**自己的下个回合开始**
  if (state.xiongnue) state.xiongnue = null;
  state.xiongnueDefense = false;
  const x = me.lu.length;
  if (x === 0) return;
  const pool = handAndEquipOf(me);
  const max = Math.min(x, pool.length);
  if (max === 0) return;
  ctx.api.askPickCards(
    state,
    me.seatId,
    `【嗜戮】：至多弃 ${max} 张牌（戮 ${x} 张），然后摸等量张`,
    pool,
    0,
    max,
    (st, p, chosen) => {
      if (chosen.length === 0) return;
      ctx.api.discardCards(p.seatId, chosen, () => {
        let got = 0;
        for (let i = 0; i < chosen.length; i++) {
          const c = drawOne(st);
          if (!c) break;
          p.hand.push(c);
          got++;
        }
        pushLog(
          st,
          'skill',
          `${p.name} 发动【嗜戮】：弃置 ${chosen.length} 张牌，摸了 ${got} 张。`,
          { seat: p.seatId },
        );
      });
    },
    { returnTo: me.seatId },
  );
}

/** 凶虐①：出牌阶段开始 → 消费 1 张戮（自己选）→ 三选一，持续到本回合结束 */
function askXiongnueOffense(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  if (me.lu.length === 0) return;
  if (state.xiongnue) return; // 一个出牌阶段只处理一次
  // 每张「戮」都带**牌面势力集合**（双势力牌**同时**对应两个牌面势力，用户 2026-09 口径，
  // 见 §5.131）：所以这里没有「拿不到势力、不可选」的戮了——`factions.length > 0` 只是兜底
  // （理论上不会有空集合；真遇到空集合就整个不出询问，不做「凭空惩罚」那套）。
  const usable = me.lu.filter((e) => e.factions.length > 0);
  if (usable.length === 0) return;
  ctx.api.askChoice(
    state,
    me.seatId,
    '【凶虐】：是否移去一张「戮」，令其返回未登场武将牌堆，并选择本回合的攻击效果？',
    [
      { id: 'yes', label: '发动' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      ctx.api.askChoice(
        st,
        p.seatId,
        '【凶虐】：选择要移去的「戮」（不同戮对应不同势力）',
        // 双势力牌那张标签写「魏/吴」这样两个势力（**不是**二选一：移去之后就按这两个都生效）
        usable.map((e) => ({
          id: e.heroId,
          label: `${getHeroForMode(e.heroId, st.mode)?.name ?? e.heroId}（${e.factions.map((f) => FACTION_NAME[f] ?? f).join('/')}）`,
        })),
        (st2, p2, heroId) => {
          const idx = p2.lu.findIndex((e) => e.heroId === heroId);
          const entry = idx >= 0 ? p2.lu[idx] : undefined;
          if (!entry) return;
          // 返回未登场武将牌堆（不是销毁——以后还可能被变更副将/技能取到）
          p2.lu.splice(idx, 1);
          st2.heroPool.push(entry.heroId);
          pushLog(
            st2,
            'skill',
            `${p2.name} 的【凶虐】：移去「戮」【${getHeroForMode(entry.heroId, st2.mode)?.name ?? entry.heroId}】（${entry.factions.map((f) => FACTION_NAME[f] ?? f).join('/')}），其返回未登场武将牌堆。`,
            { seat: p2.seatId },
          );
          const modes: { id: 'dmg' | 'obtain' | 'limit'; label: string }[] = [
            { id: 'dmg', label: '本回合对其势力角色造成的伤害 +1' },
            { id: 'obtain', label: '本回合对其势力角色造成伤害后，获得其一张牌' },
            { id: 'limit', label: '本回合对其势力角色使用牌无次数限制' },
          ];
          ctx.api.askChoice(st2, p2.seatId, '【凶虐】：选择本回合的攻击效果', modes, (st3, p3, mode) => {
            if (entry.factions.length === 0) return; // 理论上不会
            // ⚠️ 双势力「戮」= **两个牌面势力都算**（§5.121 的口径）
            st3.xiongnue = { factions: entry.factions.slice(), mode: mode as 'dmg' | 'obtain' | 'limit' };
            pushLog(
              st3,
              'skill',
              `${p3.name} 的【凶虐】：本回合对【${entry.factions.map((f) => FACTION_NAME[f] ?? f).join('、')}】势力生效（${modes.find((m) => m.id === mode)?.label ?? mode}）。`,
              { seat: p3.seatId },
            );
          });
        },
      );
    },
  );
}

/** 凶虐②：**出牌阶段结束时**消费 2 张戮（势力不限）→ 受到其他角色伤害 -1，直到自己的下个回合开始 */
function askXiongnueDefense(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  if (me.lu.length < 2) return;
  ctx.api.askChoice(
    state,
    me.seatId,
    '【凶虐】：是否移去 2 张「戮」（势力不限），令你直到自己的下个回合开始受到其他角色的伤害 -1？',
    [
      { id: 'yes', label: '发动' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      ctx.api.askChoice(
        st,
        p.seatId,
        '【凶虐】：选择移去的第 1 张「戮」',
        p.lu.map((e, i) => ({
          id: String(i),
          label: getHeroForMode(e.heroId, st.mode)?.name ?? e.heroId,
        })),
        (st2, p2, first) => {
          const i1 = Number(first);
          const e1 = p2.lu[i1];
          if (!e1) return;
          p2.lu.splice(i1, 1);
          st2.heroPool.push(e1.heroId);
          ctx.api.askChoice(
            st2,
            p2.seatId,
            '【凶虐】：选择移去的第 2 张「戮」',
            p2.lu.map((e, i) => ({
              id: String(i),
              label: getHeroForMode(e.heroId, st2.mode)?.name ?? e.heroId,
            })),
            (st3, p3, second) => {
              const e2 = p3.lu[Number(second)];
              if (!e2) return;
              p3.lu.splice(Number(second), 1);
              st3.heroPool.push(e2.heroId);
              st3.xiongnueDefense = true;
              pushLog(
                st3,
                'skill',
                `${p3.name} 的【凶虐】：移去 2 张「戮」，直到自己的下个回合开始受到其他角色的伤害 -1。`,
                { seat: p3.seatId },
              );
            },
          );
        },
      );
    },
  );
}

/** 凶虐的伤害修正（同一个字段同时服务来源侧 +1 与目标侧 -1） */
function xiongnueDamageDelta(
  state: GameState,
  me: Player,
  atk: { sourceId?: string; targetId?: string },
): number {
  const target = atk.targetId ? getPlayer(state, atk.targetId) : undefined;
  // ① 来源侧：本回合选定的势力 → 对其角色伤害 +1
  if (atk.sourceId === me.seatId && state.xiongnue && target) {
    if (state.xiongnue.mode === 'dmg' && luMatchesPlayer(state, state.xiongnue, target)) {
      return 1;
    }
  }
  // ② 目标侧：受到**其他角色**的伤害 -1（无来源/自己造成的不减）
  if (state.xiongnueDefense && atk.targetId === me.seatId) {
    if (atk.sourceId && atk.sourceId !== me.seatId) return -1;
  }
  return 0;
}

/** 凶虐①的「造成伤害后获得其一张牌」 */
function xiongnueObtain(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const eff = state.xiongnue;
  if (!eff || eff.mode !== 'obtain') return;
  const attack = (ctx.payload as { attack?: AttackContext } | undefined)?.attack;
  if (!attack || attack.sourceId !== me.seatId || attack.targetId === me.seatId) return;
  const target = getPlayer(state, attack.targetId);
  if (!target || !target.alive) return;
  if (!luMatchesPlayer(state, eff, target)) return;
  if (handAndEquipOf(target).length === 0) return; // 无牌可获得
  ctx.api.askChoice(
    state,
    me.seatId,
    `【凶虐】：是否获得 ${target.name} 的一张牌？`,
    [
      { id: 'yes', label: '获得其一张牌' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      const t = getPlayer(st, target.seatId);
      if (!t) return;
      takeOneOfTargetCards(st, p, t, ctx.api, '凶虐', () => {
        pushLog(st, 'skill', `${p.name} 的【凶虐】：获得了 ${t.name} 的一张牌。`, {
          seat: p.seatId,
        });
      });
    },
  );
}

const SUNCHEN: Hero = {
  id: 'sunchen',
  name: '孙綝',
  pack: 'buchen',
  faction: 'ambitionist', // 野心家武将本体（野势力）
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  skillFields: { 凶虐: ['damageDelta', 'shaBypassLimit'] },
  damageDelta: (state, me, atk) => xiongnueDamageDelta(state, me, atk),
  // 凶虐③：只豁免**次数限制**（距离/目标数/其他合法性一律不豁免）——整批目标都要是那个势力
  shaBypassLimit: (state, owner, targetIds) => {
    const eff = state.xiongnue;
    if (!eff || eff.mode !== 'limit') return false;
    if (targetIds.length === 0) return false;
    return targetIds.every((id) => {
      const t = state.players.find((p) => p.seatId === id);
      return !!t && luMatchesPlayer(state, eff, t);
    });
  },
  hooks: [
    { timing: 'playerDied', skillId: '嗜戮', handler: askShilu },
    { timing: 'turnStart', skillId: '嗜戮', handler: askShiluPrepare },
    { timing: 'playPhase', skillId: '凶虐', handler: askXiongnueOffense },
    { timing: 'playPhaseEnd', skillId: '凶虐', handler: askXiongnueDefense },
    { timing: 'afterDamageDealt', skillId: '凶虐', handler: xiongnueObtain },
  ],
  skills: [
    {
      name: '嗜戮',
      desc: '角色死亡时，你可以获得其武将牌，称为「戮」；若其为你杀死的，你额外从未登场武将牌堆获得两张「戮」。准备阶段，若你有「戮」，你可以弃置至多 X 张牌，然后摸等量的牌（X 为「戮」的数量）。',
    },
    {
      name: '凶虐',
      desc: '出牌阶段开始时，你可以移去一张「戮」，令其返回未登场武将牌堆，然后选择一项：本回合你对与其势力相同的角色造成的伤害+1；你对其造成伤害后获得其一张牌；你对其使用牌无次数限制。出牌阶段结束时，你可以移去两张「戮」，令你直到自己的下个回合开始受到其他角色的伤害-1。',
    },
  ],
};

/**
 * 彭羕 —— 达命 / 嚣逆（不臣篇·下，**蜀/群双势力**，1.5 阴阳鱼 → 3；移动版现行口径，见 §5.108）。
 *
 * 【达命】（**其他/自己**的同势力角色进入**出牌阶段时**，可发动）：弃置 1 张**锦囊牌** →
 *   横置一名角色（「进入连环状态」是**置位**，不是铁索那种 toggle）→ 摸 X 张
 *   （X＝**有连环角色的势力数**，按已确定势力去重、未确定不计）→ 二选一：
 *   ① 当前回合角色**回复 1 点体力**（⚠️ 移动版现行为**直接回复**，**不是**旧版的「视为使用【桃】」）；
 *   ② 当前回合角色**视为对另一名角色使用一张雷【杀】**——**纯虚拟牌、subcards=[]**（无实体可被
 *      奸雄/授锋/求安取用），**不计入出杀次数**（`castVirtualSha` 走 resolvePlayedSha，天然不占次数），
 *      但**不自动无视距离**：目标仍要过普通【杀】的攻击范围校验。
 * 【嚣逆】（锁定技）：满足「场上还有**其他**同势力角色」且「彭羕手牌数是同势力里**最大**（**并列也算**）」
 *   时——彭羕使用牌指定目标后，**被指定的那些目标本人不能响应此牌**；其他角色用牌指定彭羕后，
 *   **只有彭羕自己不能响应**。条件是**指定目标那一刻**实时判定的，之后再变手牌不追溯。
 *   ⚠️ 它是**按玩家**的「不能响应」（`unrespondableTargets`），不是整张牌的全局标志：
 *   别人照样能对这张牌打【无懈可击】、其他目标也照样能出【闪】/打出【杀】。
 */
/** 「有连环角色的势力数」（达命的 X）：已确定势力去重，未确定势力不计 */
export function chainedFactionCount(state: GameState): number {
  const seen = new Set<string>();
  for (const p of state.players) {
    if (!p.alive || !p.chained) continue;
    const f = effectiveFaction(state, p);
    if (f) seen.add(f);
  }
  return seen.size;
}

/** 嚣逆是否生效：还有**其他**同势力角色，且自己手牌数是同势力最大（并列算） */
function xiaoniActive(state: GameState, me: Player): boolean {
  const mine = effectiveFaction(state, me);
  if (!mine) return false;
  const allies = state.players.filter(
    (p) => p.alive && p.seatId !== me.seatId && effectiveFaction(state, p) === mine,
  );
  if (allies.length === 0) return false; // 「同势力的**其他**角色」——孤家不算
  const maxHand = Math.max(me.hand.length, ...allies.map((a) => a.hand.length));
  return me.hand.length === maxHand; // 并列最多也满足
}

/** 【达命】：同势力角色进入出牌阶段时，彭羕可以弃一张锦囊、横置一人、摸 X、二选一 */
function askDaming(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  // 别人的出牌阶段走 othersPlayPhase（payload.turnSeatId）；**自己的**走 playPhase（没有 payload）
  const activeId =
    (ctx.payload as { turnSeatId?: string } | undefined)?.turnSeatId ?? me.seatId;
  const active = getPlayer(state, activeId);
  if (!active || !active.alive) return;
  const mine = effectiveFaction(state, me);
  if (!mine || effectiveFaction(state, active) !== mine) return; // 必须是同势力（都要求已确定）
  const tricks = handAndEquipOf(me).filter((c) => !isBasicCard(c) && !isEquipCard(c));
  if (tricks.length === 0) return; // 没有锦囊可弃 → 不弹窗口
  const chainables = state.players.filter(
    (p) => p.alive && !p.chained && !immuneToChaining(state, p),
  );
  if (chainables.length === 0) return;
  ctx.api.askChoice(
    state,
    me.seatId,
    `【达命】：${active.name} 进入出牌阶段，是否弃置一张锦囊牌发动？`,
    [
      { id: 'yes', label: '发动（弃一张锦囊）' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      ctx.api.askPickCards(
        st,
        p.seatId,
        '【达命】：选择弃置的一张锦囊牌',
        tricks,
        1,
        1,
        (st2, p2, chosen) => {
          const cost = chosen[0];
          if (!cost) return;
          ctx.api.discardCards(p2.seatId, [cost], () => {
            // 横置（置位，不是 toggle）
            ctx.api.askChoice(
              st2,
              p2.seatId,
              '【达命】：横置哪名角色（进入连环状态）？',
              chainables.map((t) => ({ id: t.seatId, label: t.name })),
              (st3, p3, targetId) => {
                const target = getPlayer(st3, targetId);
                if (!target) return;
                target.chained = true; // 已排除「已横置/免疫横置」的候选
                pushLog(
                  st3,
                  'skill',
                  `${p3.name} 发动【达命】：弃置【${cardLabel(cost)}】，横置了 ${target.name}。`,
                  { seat: p3.seatId },
                );
                // 重新统计 X（横置之后再数）
                const x = chainedFactionCount(st3);
                let got = 0;
                for (let i = 0; i < x; i++) {
                  const c = drawOne(st3);
                  if (!c) break;
                  p3.hand.push(c);
                  got++;
                }
                pushLog(
                  st3,
                  'skill',
                  `${p3.name} 的【达命】：有连环角色的势力数 ${x}，摸了 ${got} 张。`,
                  { seat: p3.seatId },
                );
                // 二选一：① 当前回合角色回复 1 点体力（**不是**虚拟【桃】）
                const slashTargets = st3.players.filter(
                  (t) =>
                    t.alive &&
                    t.seatId !== active.seatId &&
                    canTarget(st3, active.seatId, t.seatId) &&
                    !heroBlocksBeingTarget(st3, t, { id: '', type: 'sha', suit: 'spade', rank: 0 }, active),
                );
                const opts = [
                  { id: 'recover', label: `令 ${active.name} 回复 1 点体力` },
                  ...(slashTargets.length > 0
                    ? [{ id: 'slash', label: `令 ${active.name} 视为对一名角色使用雷【杀】` }]
                    : []),
                ];
                ctx.api.askChoice(st3, p3.seatId, '【达命】：选择一项', opts, (st4, p4, choice) => {
                  if (choice === 'recover') {
                    const healed = ctx.api.heal(active, 1);
                    pushLog(st4, 'skill', `${active.name} 因【达命】回复 ${healed} 点体力。`, {
                      seat: active.seatId,
                    });
                    return;
                  }
                  ctx.api.askChoice(
                    st4,
                    p4.seatId,
                    '【达命】：令其视为对谁使用雷【杀】？',
                    slashTargets.map((t) => ({ id: t.seatId, label: t.name })),
                    (st5, p5, victimId) => {
                      ctx.api.castVirtualSha(active.seatId, victimId, {
                        logKind: 'skill',
                        attribute: 'thunder',
                      });
                      pushLog(
                        st5,
                        'skill',
                        `${p5.name} 的【达命】：${active.name} 视为对 ${getPlayer(st5, victimId)?.name ?? '?'} 使用了一张雷【杀】。`,
                        { seat: active.seatId },
                      );
                    },
                  );
                });
              },
            );
          });
        },
      );
    },
  );
}

/**
 * 【嚣逆】分支①：**彭羕自己用牌**（挂在来源侧的 `useCard`）→ 这次使用的**所有目标**不能响应。
 * 多目标牌逐个目标都写进名单（不是把整张牌做成「全场不可响应」）。
 */
function xiaoniOnMyUse(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  if (!xiaoniActive(state, me)) return;
  const payload = ctx.payload as { attack?: AttackContext; targetIds?: string[] } | undefined;
  const atk = payload?.attack;
  const tctx = payload as unknown as TrickContext | undefined;
  const ids = atk ? [atk.targetId] : (payload?.targetIds ?? []);
  if (ids.length === 0) return;
  if (atk) atk.unrespondableTargets = [...(atk.unrespondableTargets ?? []), ...ids];
  else if (tctx) tctx.unrespondableTargets = [...(tctx.unrespondableTargets ?? []), ...ids];
  pushLog(state, 'skill', `${me.name} 的【嚣逆】：被指定的目标不能响应这张牌。`, {
    seat: me.seatId,
  });
}

/**
 * 【嚣逆】分支②：**别人用牌指定了彭羕**（杀走目标侧的 `becomeTarget`、锦囊走 `trickTargeted`）
 * → **只有彭羕自己**不能响应（别人照常打【无懈可击】、其他目标照常出闪）。
 */
function xiaoniOnTargeted(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  if (!xiaoniActive(state, me)) return;
  const payload = ctx.payload as
    | { targetId?: string; attack?: AttackContext; targetIds?: string[]; trickCtx?: TrickContext }
    | undefined;
  const atk = payload?.attack;
  const tctx = payload?.trickCtx;
  const targetedMe = atk
    ? atk.targetId === me.seatId && atk.sourceId !== me.seatId
    : !!(tctx && tctx.sourceId !== me.seatId && (payload?.targetIds ?? []).includes(me.seatId));
  if (!targetedMe) return;
  if (atk) atk.unrespondableTargets = [...(atk.unrespondableTargets ?? []), me.seatId];
  else if (tctx) tctx.unrespondableTargets = [...(tctx.unrespondableTargets ?? []), me.seatId];
  pushLog(state, 'skill', `${me.name} 的【嚣逆】：${me.name} 不能响应这张牌。`, {
    seat: me.seatId,
  });
}

const PENGYANG: Hero = {
  id: 'pengyang',
  name: '彭羕',
  pack: 'buchen',
  faction: 'shu',
  secondFaction: 'qun',
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'],
  hooks: [
    // 达命：自己与别人的出牌阶段开始分别走 playPhase / othersPlayPhase
    { timing: 'playPhase', skillId: '达命', handler: askDaming },
    { timing: 'othersPlayPhase', skillId: '达命', handler: askDaming },
    // 嚣逆：自己用牌挂来源侧的 useCard（杀与锦囊都会派给使用者）；
    // 别人指定彭羕时——杀走目标侧的 becomeTarget、锦囊走 trickTargeted（带完整目标列表）
    { timing: 'useCard', skillId: '嚣逆', locked: true, handler: xiaoniOnMyUse },
    { timing: 'becomeTarget', skillId: '嚣逆', locked: true, handler: xiaoniOnTargeted },
    { timing: 'trickTargeted', skillId: '嚣逆', locked: true, handler: xiaoniOnTargeted },
  ],
  skills: [
    {
      name: '达命',
      desc: '一名与你势力相同的角色进入出牌阶段时，你可以弃置一张锦囊牌，横置一名角色，然后摸 X 张牌（X 为有连环角色的势力数），令该角色回复 1 点体力或其视为对另一名角色使用一张不计入次数的雷【杀】。',
    },
    {
      name: '嚣逆',
      desc: '锁定技，若场上有与你势力相同的其他角色且你的手牌数为其中最多，你使用牌指定目标后，这些目标不能响应此牌；其他角色使用牌指定你为目标后，你不能响应此牌。',
    },
  ],
};

/**
 * 文钦 —— 矜伐（不臣篇·下，**魏/吴双势力**，2 阴阳鱼 → 4；移动版现行口径，见 §5.109）。
 *
 * 【矜伐】（出牌阶段限一次）：弃置**自己的一张牌**（手牌或装备区都行，没有类型限制）
 *   → 选择一名**有牌**的其他角色（0 手牌但有装备也算）→ 由**该角色**二选一：
 *   A. 文钦获得其一张牌（谁被指定谁选分支、具体拿哪张由**文钦**选）；
 *   B. 该角色**交给**文钦一张**装备牌**（装备区里的也算；**交哪张由该角色自己选**）
 *      —— 若交出的装备是**黑桃**，该角色**视为对文钦使用一张纯虚拟的普通【杀】**
 *      （`physicalCardIds = []`：**绝不能**把刚交过来的那件装备当这张杀的实体子牌，
 *        所以【奸雄】【授锋】【求安】都拿不到任何实体牌；属性是**普通**，不继承装备的属性）。
 *
 * 权限关系（用户口径，最容易写错的一处）：**分支由被指定的角色选**，但「A 里拿哪张」在文钦、
 *   「B 里交哪张装备」在被指定的角色。
 * 另外：选项必须**按当前状态动态生成**——没有可获得牌就没有 A、没有可交出的装备牌就没有 B；
 *   只剩一个合法分支时**直接执行**，不给「选一个执行不了的选项白逃」的机会。
 * ⚠️ 产生的那张【杀】是**技能指定的 CardUse**（使用者与目标都被技能定死），所以创建时不再受
 *   普通出杀的**距离**与**次数**限制（`api.castVirtualSha` 走 `resolvePlayedSha`，本身既不查距离
 *   也不占次数）；但后续的【闪】、防具、伤害增减、成为杀目标/造成伤害后等事件**全部照常**。
 */
function askJinfa(state: GameState, me: Player, api: SkillApi): string | undefined {
  const pool = handAndEquipOf(me);
  if (pool.length === 0) return '【矜伐】需要弃置一张牌';
  const targets = state.players.filter(
    (t) => t.alive && t.seatId !== me.seatId && handAndEquipOf(t).length > 0,
  );
  if (targets.length === 0) return '没有「有牌」的其他角色';
  api.askPickCards(
    state,
    me.seatId,
    '【矜伐】：弃置你自己的一张牌（手牌或装备区都行）',
    pool,
    1,
    1,
    (st, p, chosen) => {
      const cost = chosen[0];
      if (!cost) return;
      // 走 API 弃置：装备区的牌会正常触发「失去装备」那套
      api.discardCards(p.seatId, [cost], () => {
        const cands = st.players.filter(
          (t) => t.alive && t.seatId !== p.seatId && handAndEquipOf(t).length > 0,
        );
        if (cands.length === 0) return;
        api.askChoice(
          st,
          p.seatId,
          '【矜伐】：选择一名有牌的其他角色',
          cands.map((t) => ({ id: t.seatId, label: `${t.name}（${t.hand.length} 手牌）` })),
          (st2, p2, tid) => {
            const target = getPlayer(st2, tid);
            if (!target || !target.alive) return;
            const giveable = handAndEquipOf(target).filter((c) => isEquipCard(c));
            // 选项按当前状态动态生成（A：有可获得牌；B：真的有可交出的装备牌）
            const opts = [
              { id: 'A', label: `令 ${p2.name} 获得你的一张牌` },
              ...(giveable.length > 0
                ? [{ id: 'B', label: `你交给 ${p2.name} 一张装备牌` }]
                : []),
            ];
            const runB = (st3: GameState, t3: Player): void => {
              const equips = handAndEquipOf(t3).filter((c) => isEquipCard(c));
              if (equips.length === 0) return;
              api.askPickCards(
                st3,
                t3.seatId,
                `【矜伐】：选择交给 ${p2.name} 的一张装备牌`,
                equips,
                1,
                1,
                (st4, t4, picked) => {
                  const equip = picked[0];
                  if (!equip) return;
                  // 「交给」走 transferCard：装备区里的那张会正常触发失去装备
                  api.transferCard(t4.seatId, equip, p2.seatId, () => {
                    pushLog(
                      st4,
                      'skill',
                      `${t4.name} 因【矜伐】交给 ${p2.name} 【${cardLabel(equip)}】。`,
                      { seat: t4.seatId },
                    );
                    // 看的是**这张装备牌自己的花色**；黑桃 → 该角色视为对文钦使用纯虚拟普通【杀】
                    if (equip.suit !== 'spade') return;
                    pushLog(
                      st4,
                      'skill',
                      `【矜伐】：交出的【${cardLabel(equip)}】是黑桃，${t4.name} 视为对 ${p2.name} 使用一张普通【杀】。`,
                      { seat: t4.seatId },
                    );
                    // ⚠️ 纯虚拟牌：subcards=[]、不继承装备的属性；装备留在文钦那里
                    api.castVirtualSha(t4.seatId, p2.seatId, { logKind: 'skill' });
                  });
                },
              );
            };
            if (opts.length === 1) {
              // 只剩 A：直接执行，不给「选一个执行不了的选项白逃」
              takeOneOfTargetCards(st2, p2, target, api, '矜伐', () => {
                pushLog(st2, 'skill', `${p2.name} 的【矜伐】：获得了 ${target.name} 的一张牌。`, {
                  seat: p2.seatId,
                });
              });
              return;
            }
            api.askChoice(
              st2,
              target.seatId,
              `【矜伐】：${p2.name} 令你选择一项`,
              opts,
              (st3, t3, pick) => {
                if (pick === 'B') {
                  runB(st3, t3);
                  return;
                }
                const owner = getPlayer(st3, p2.seatId);
                const victim = getPlayer(st3, t3.seatId);
                if (!owner || !victim) return;
                takeOneOfTargetCards(st3, owner, victim, api, '矜伐', () => {
                  pushLog(st3, 'skill', `${owner.name} 的【矜伐】：获得了 ${victim.name} 的一张牌。`, {
                    seat: owner.seatId,
                  });
                });
              },
            );
          },
        );
      });
    },
  );
  return undefined;
}

const WENQIN: Hero = {
  id: 'wenqin',
  name: '文钦',
  pack: 'buchen',
  faction: 'wei',
  secondFaction: 'wu',
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  activeSkills: [
    {
      id: 'jinfa',
      name: '矜伐',
      oncePerTurn: true,
      minTargets: 0,
      maxTargets: 0,
      needsCards: false,
      canUse: (state, player) =>
        handAndEquipOf(player).length > 0 &&
        state.players.some(
          (t) => t.alive && t.seatId !== player.seatId && handAndEquipOf(t).length > 0,
        ),
      execute: (state, player, _intent, api) => askJinfa(state, player, api),
    },
  ],
  skills: [
    {
      name: '矜伐',
      desc: '出牌阶段限一次，你可以弃置一张牌并选择一名有牌的其他角色，令其选择一项：你获得其一张牌；或其交给你一张装备牌，若此牌为黑桃，其视为对你使用一张普通【杀】。',
    },
  ],
};

/**
 * 朱灵 —— 决绝 / 方圆（不臣篇·下，魏，2 阴阳鱼 → 4；移动版现行口径，见 §5.110）。
 *
 * 【决绝】（出牌阶段外的两个时点）：
 *   ① **弃牌阶段开始**：朱灵可以**失去 1 点体力**（不是伤害：没有来源、不触发「受到伤害后」；
 *      1 点体力发动则照常进濒死）——发动后记为「本回合已发动」。
 *   ② **本回合弃牌阶段结束时**（落地在 `turnEnd`＝结束阶段开始，紧接弃牌阶段）：若已发动、
 *      且朱灵**本阶段弃置过手牌**，则令所有其他角色依次（按座次）二选一：
 *      A. **将 X 张手牌置入弃牌堆**（X＝朱灵本阶段**弃置的全部**牌数——⚠️ 与「弃过手牌」这个
 *         **门槛**是两个口径；且 A 要求其手牌数 ≥ X，否则这个选项**不合法**）；
 *      B. 受到朱灵造成的 **1 点普通伤害**（技能直伤：没有实体牌、不能闪/无懈，但「受到伤害后」
 *         「造成伤害后」「濒死」等全部照常）。
 *      ⚠️ **A 是「置入弃牌堆」不是「弃置」**（官方描述原则明确区分）：实现上直接 `toDiscard`，
 *      **不走**引擎里「因弃置」的收口，所以【夙智】③、【统度】、【礼让】、【定澜夜明珠】那类
 *      「因弃置进弃牌堆」的监听都**不会**被它触发。
 *   ③ 朱灵杀死与自己**同势力**的角色时，不执行国战的同势力击杀奖惩——引擎**已实现**那套奖惩
 *      （`engine.applyKillPenalty`，见 §5.125），朱灵靠 `exemptFromKillPenalty: true` 跳过。
 * 【方圆】（**阵法技**，锁定；仅**存活 ≥4** 且围攻关系成立时生效）——**建立在公共围攻关系
 *   `siegeRelations` 上**，不自己看左右座位：
 *   ① 与朱灵处于**同一围攻关系**的**围攻角色**手牌上限 **+1**、**被围攻角色** **-1**
 *      （同一技能实例对同一角色最多 ±1 一次；关系消失即实时消失）；
 *   ② 朱灵**被围攻**时，其**结束阶段**可以选该关系中的一名围攻角色，**视为对其使用一张纯虚拟
 *      普通【杀】**（`subcards=[]`、无实体；技能定死了使用者与目标，所以创建时不查距离/不占次数，
 *      之后的【闪】、防具、伤害等全部照常）。
 */
/** 方圆①：这个角色的手牌上限要额外加/减多少（按**围攻关系**判，实时） */
export function fangyuanHandLimitDelta(state: GameState, target: Player): number {
  const rels = siegeRelations(state); // 自带「存活 ≥4」与「调虎离山不计座次」的前提
  if (rels.length === 0) return 0;
  let delta = 0;
  for (const p of state.players) {
    if (!p.alive) continue;
    if (!effectiveHeroes(state, p).some((h) => h.fangyuan === true)) continue;
    if (p.seatId === target.seatId) {
      // 朱灵自己也在关系里：他是围攻者就 +1、是被围攻者就 -1
    }
    const asAttacker = rels.some(
      (r) => r.besiegers.includes(p.seatId) && r.besiegers.includes(target.seatId),
    );
    if (asAttacker) {
      delta += 1;
      continue;
    }
    const asBesieged = rels.some(
      (r) => r.besiegers.includes(p.seatId) && r.besiegedSeatId === target.seatId,
    );
    if (asBesieged) delta -= 1;
  }
  return delta;
}

/** 决绝①：弃牌阶段开始，可以失去 1 点体力（不是伤害） */
function askJuejueArm(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  ctx.api.askChoice(
    state,
    me.seatId,
    '【决绝】：是否失去 1 点体力？（本回合弃牌阶段结束时若你弃置过手牌，将令所有其他角色二选一）',
    [
      { id: 'yes', label: '发动（失去 1 点体力）' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      // ⚠️ 每次询问都要**重新赋值**（包括选「不发动」）：否则上一回合选的「发动」会一直挂着，
      //    这一回合明明选了不发动、只要弃过手牌就会被误结算（这个状态是**回合内**的）
      st.juejueArmed = picked === 'yes';
      if (picked !== 'yes') return;
      ctx.api.loseHp(p, 1, () => {
        pushLog(st, 'skill', `${p.name} 发动【决绝】：失去 1 点体力。`, { seat: p.seatId });
      });
    },
  );
}

/** 决绝②：本回合弃牌阶段结束时（落地在 turnEnd）逐个结算 */
function askJuejueSettle(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  if (!state.juejueArmed) return;
  if (!me.alive) return;
  if (!state.handDiscardedInDiscardPhase.includes(me.seatId)) return; // 门槛：本阶段弃过**手牌**
  const x = state.discardPhaseCountsThisTurn[me.seatId] ?? 0; // X＝本阶段弃置的**全部**牌数
  if (x <= 0) return;
  const others = state.players.filter((p) => p.alive && p.seatId !== me.seatId);
  if (others.length === 0) return;
  const step = (i: number): void => {
    if (i >= others.length) return;
    if (!me.alive) return;
    const victim = getPlayer(state, others[i]!.seatId);
    if (!victim || !victim.alive) {
      step(i + 1);
      return;
    }
    const opts = [
      ...(victim.hand.length >= x
        ? [{ id: 'put', label: `将 ${x} 张手牌置入弃牌堆` }]
        : []),
      { id: 'dmg', label: `受到 ${me.name} 造成的 1 点普通伤害` },
    ];
    const settle = (st: GameState, v: Player, pick: string): void => {
      if (pick === 'put') {
        ctx.api.askPickCards(
          st,
          v.seatId,
          `【决绝】：选择 ${x} 张手牌置入弃牌堆`,
          v.hand.slice(),
          x,
          x,
          (st2, v2, chosen) => {
            // ⚠️ 「置入弃牌堆」不是「弃置」：直接 toDiscard，不派发「因弃置」的收口
            for (const c of chosen) {
              removeCard(v2.hand, c.id);
              toDiscard(st2, c);
            }
            pushLog(
              st2,
              'skill',
              `${v2.name} 因【决绝】将 ${chosen.length} 张手牌置入弃牌堆。`,
              { seat: v2.seatId },
            );
            step(i + 1);
          },
        );
        return;
      }
      pushLog(st, 'skill', `${v.name} 因【决绝】受到 1 点普通伤害。`, { seat: v.seatId });
      // ⚠️ 这 1 点伤害可能把目标打进濒死：那时 pending 被求桃队列占着，**不能**接着同步
      //    问下一个人（会把求桃询问顶掉）。挂到 ongoingSkillChain，等濒死那串走完再继续。
      ctx.api.dealDamage(v, 1, me.seatId, undefined, () => {
        if (st.pending) st.ongoingSkillChain.push(() => step(i + 1));
        else step(i + 1);
      });
    };
    if (opts.length === 1) {
      settle(state, victim, 'dmg'); // 手牌不够 X → 只能吃伤害，不给「执行不了的选项」
      return;
    }
    ctx.api.askChoice(
      state,
      victim.seatId,
      `【决绝】（${me.name}）：选择一项`,
      opts,
      (st, v, pick) => settle(st, v, pick),
    );
  };
  step(0);
}

/** 方圆②：自己**被围攻**时，结束阶段选一名围攻者，视为使用纯虚拟普通【杀】 */
function askFangyuanSlash(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const rel = siegeRelations(state).find((r) => r.besiegedSeatId === me.seatId);
  if (!rel) return;
  const cands = rel.besiegers
    .map((id) => getPlayer(state, id))
    .filter((p): p is Player => !!p && p.alive);
  if (cands.length === 0) return;
  ctx.api.askChoice(
    state,
    me.seatId,
    '【方圆】：你被围攻，是否视为对一名围攻角色使用一张普通【杀】？',
    [
      ...cands.map((p) => ({ id: p.seatId, label: `对 ${p.name} 使用【杀】` })),
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked === 'no') return;
      // 纯虚拟普通【杀】：无实体、不继承花色点数；使用者与目标由技能定死 → 不查距离/不占次数
      pushLog(st, 'skill', `${p.name} 发动【方圆】，视为对 ${getPlayer(st, picked)?.name ?? '?'} 使用一张普通【杀】。`, {
        seat: p.seatId,
      });
      ctx.api.castVirtualSha(p.seatId, picked, { logKind: 'skill' });
    },
  );
}

const ZHULING: Hero = {
  id: 'zhuling',
  name: '朱灵',
  pack: 'buchen',
  faction: 'wei',
  maxHp: 4,
  gender: 'male',
  modes: ['guozhan'],
  // 方圆是锁定技（阵法技），要在 handLimit 与回合钩子上都生效
  // 方圆（阵法技，围攻型）：阵法召唤按「亮将后进同一围攻关系」判
  formation: ['siege'],
  lockedFields: ['fangyuan'],
  exemptFromKillPenalty: true,
  skillFields: { 方圆: ['fangyuan'] },
  fangyuan: true,
  hooks: [
    { timing: 'discardPhase', skillId: '决绝', handler: askJuejueArm },
    { timing: 'turnEnd', skillId: '决绝', handler: askJuejueSettle },
    { timing: 'turnEnd', skillId: '方圆', locked: true, handler: askFangyuanSlash },
  ],
  skills: [
    {
      name: '决绝',
      desc: '弃牌阶段开始时，你可以失去1点体力；本回合弃牌阶段结束时，若你于此阶段内弃置过手牌，你令所有其他角色依次选择一项：将X张手牌置入弃牌堆（X为你于此阶段内弃置的牌数）；或受到你造成的1点普通伤害。你杀死与你势力相同的角色时，不执行奖惩。',
    },
    {
      name: '方圆',
      desc: '阵法技，锁定技，与你处于同一围攻关系的围攻角色手牌上限+1、被围攻角色手牌上限-1；若你处于被围攻状态，你的结束阶段可以视为对一名围攻角色使用一张普通【杀】。',
    },
  ],
  // 阵法召唤（通用机制，见 §5.132）：拥有阵法技的角色都多出这一条出牌阶段限一次的操作
  activeSkills: [FORMATION_SUMMON],

};

/**
 * 界钟会 —— 权计 / 排异（不臣篇·下，**武将牌本身就是「野」**，2 阴阳鱼 → **4**，
 * 珠联璧合【姜维】；技能按**移动版当前国战版**，用户核对后给出等价实现口径）。
 *
 * ⚠️ **版本差异（用户点名）**：这是移动版当前的「不臣篇-下」**国战**版，不是身份场界钟会、
 *    也不是线下典藏版——【排异】早已从旧版「出牌阶段限一次、摸 X（X＝权数，至多 7）」
 *    改成 **出牌阶段限两次、固定摸 2**。本仓库按新版实现（`perPhaseLimit: 2`）。
 *
 * 【权计】两个触发入口，结算完全相同：
 * - ① 自己**受到一次伤害后**——按**伤害事件**，不按点数：一次 2 点伤害只给一次机会
 *   （与郭嘉/曹丕那条用户已拍板的口径同一类）。
 * - ② 自己**使用一张仅指定一个目标的牌**，该牌的效果对那个目标**实际造成伤害后**。
 *   判据是「这次使用指定的**目标名单**就是挨打的那位」（`attack.declaredTargets`），于是：
 *   **铁索传导**给非目标的伤害不算（传导是从原攻击上下文复制出来的，名单仍是原目标）；
 *   **技能直伤**不算（`cardId` 为空，排异那类）；**多目标牌**不算（方天画戟的多目标杀、
 *   南蛮/万箭）。牌种不限定（杀、决斗、单目标伤害锦囊都算）。
 *   结算：**先摸 1 张**，再把**自己的一张牌**（手牌或装备区；本仓库不自行扩到判定区）
 *   置于武将牌上成为「权」（真实实体牌，见 `Player.quan`）。
 * - **每有 1 张「权」，手牌上限 +1**（动态读，不缓存；权被移去立刻 −1）。
 *
 * 【排异】出牌阶段**限两次**：移去 1 张「权」（真实牌 → 弃牌堆，是「移去」不是「弃置」）
 * → 令**一名角色**（含自己，文本没有「其他」）摸 2 张 → 若其手牌数**严格大于**界钟会
 * （**摸完之后**再比）→ 其受到界钟会造成的 **1 点普通伤害**（技能直伤：没有实体牌、
 * 不能闪、不能无懈，但正常走受伤/濒死/死亡那一整套）。
 */
/** 【权计】①/②共用的判据：这一次伤害算不算触发 */
function quanjiTrigger(attack: AttackContext | undefined, me: Player): boolean {
  if (!attack) return false;
  // ① 自己**受到**伤害（这个钩子每次伤害事件只派发一次，所以天然是「按事件不按点数」）
  if (attack.targetId === me.seatId) return true;
  // ② 自己**使用**的牌，唯一目标就是挨打的那位
  if (attack.sourceId !== me.seatId) return false;
  if (!attack.cardId) return false; // 技能直伤（排异那类）没有实体牌
  const list = attack.declaredTargets;
  if (!list || list.length !== 1 || list[0] !== attack.targetId) return false;
  return true;
}

/** 【权计】：摸 1 张，然后把**自己的一张牌**（手牌或装备区）置于武将牌上成为「权」 */
function askQuanji(ctx: HookContext): void {
  const state = ctx.state;
  const me = ctx.player;
  const attack = (ctx.payload as { attack?: AttackContext } | undefined)?.attack;
  if (!quanjiTrigger(attack, me)) return;
  ctx.api.askChoice(
    state,
    me.seatId,
    '【权计】：是否摸一张牌，然后将一张牌置于武将牌上作为「权」？',
    [
      { id: 'yes', label: '发动（摸一张，然后放一张「权」）' },
      { id: 'no', label: '不发动' },
    ],
    (st, p, picked) => {
      if (picked !== 'yes') return;
      // 顺序：**先摸 1 张**，再选自家的牌
      const drawn = drawOne(st);
      if (drawn) p.hand.push(drawn);
      pushLog(st, 'skill', `${p.name} 发动【权计】：摸一张牌。`, { seat: p.seatId });
      // ⚠️ 「一张牌」不是「一张手牌」：手牌与**装备区**都可以（国战版公开说明点名了装备牌）
      const cands = handAndEquipOf(p);
      if (cands.length === 0) return;
      ctx.api.askPickCards(
        st,
        p.seatId,
        '【权计】：选择一张牌置于武将牌上作为「权」',
        cands,
        1,
        1,
        (st2, p2, chosen) => {
          const card = chosen[0];
          if (!card) return;
          const put = (): void => {
            p2.quan.push(card);
            pushLog(
              st2,
              'skill',
              `${p2.name} 将【${cardLabel(card)}】置于武将牌上作为「权」。`,
              { seat: p2.seatId },
            );
          };
          const slot = EQUIP_SLOTS.find((sl) => p2.equipment[sl]?.id === card.id);
          if (slot) {
            // 装备区的牌：先摘下来（正常触发「失去装备」那套联动），再进「权」
            ctx.api.loseEquip(p2.seatId, card, put);
            return;
          }
          removeCard(p2.hand, card.id);
          put();
        },
      );
    },
  );
}

/** 【排异】：出牌阶段限两次，移去一张「权」，令一名角色摸 2 张；其手牌数大于你就吃 1 点伤害 */
const PAIYI_SKILL: ActiveSkill = {
  id: 'paiyi',
  name: '排异',
  // 新版口径：**每个出牌阶段限两次**（额外出牌阶段重新拿到额度）
  perPhaseLimit: 2,
  minTargets: 1,
  maxTargets: 1,
  needsCards: false,
  canUse: (state, player) => player.quan.length > 0,
  execute: (state, player, intent, api) => {
    if (player.quan.length === 0) return '你没有「权」';
    const targetId = intent.targetIds[0];
    const target = targetId ? getPlayer(state, targetId) : undefined;
    if (!target || !target.alive) return '请选择一名存活角色（可以是自己）';
    /** 移去这张「权」之后的全部结算（选牌/自动选牌两条路共用） */
    const resolve = (st: GameState, quanCard: import('@sgs/protocol').Card): void => {
      removeCard(player.quan, quanCard.id);
      // 「移去」＝置入弃牌堆（是一张正常实体牌；不是「弃置」，不派发因弃置那套收口）
      toDiscard(st, quanCard);
      pushLog(
        st,
        'skill',
        `${player.name} 发动【排异】：移去一张「权」（${cardLabel(quanCard)}）。`,
        { seat: player.seatId },
      );
      // 先摸 2 张，**摸完之后**再比手牌数
      for (let i = 0; i < 2; i++) {
        const c = drawOne(st);
        if (c) target.hand.push(c);
      }
      pushLog(st, 'skill', `${target.name} 摸两张牌。`, { seat: target.seatId });
      if (target.hand.length > player.hand.length) {
        pushLog(
          st,
          'skill',
          `${target.name} 的手牌数（${target.hand.length}）大于 ${player.name}（${player.hand.length}），受到 1 点伤害。`,
          { seat: player.seatId },
        );
        // 普通技能伤害：没有实体牌（权计② 不会因此触发）、不能闪、不能无懈
        api.dealDamage(target, 1, player.seatId);
      }
    };
    const only = player.quan[0];
    if (player.quan.length === 1 && only) {
      resolve(state, only);
      return undefined;
    }
    api.askPickCards(
      state,
      player.seatId,
      '【排异】：选择要移去的一张「权」',
      player.quan.slice(),
      1,
      1,
      (st, _p, chosen) => {
        const card = chosen[0];
        if (card) resolve(st, card);
      },
    );
    return undefined;
  },
};

const JIE_ZHONGHUI: Hero = {
  id: 'jie_zhonghui',
  name: '界钟会',
  pack: 'buchen',
  // ⚠️ 国战版：**武将牌本身就是「野」**（不是魏势力人数超限后才转的野心家）
  faction: 'ambitionist',
  maxHp: 4, // 2 阴阳鱼
  gender: 'male',
  modes: ['guozhan'],
  combos: ['jiangwei'], // 珠联璧合【姜维】
  // 「每有 1 张权，手牌上限 +1」不可关（非锁定技失效也照算）
  lockedFields: ['handLimit'],
  skillFields: { 权计: ['handLimit'], 排异: [] },
  handLimit: (state, player) => Math.max(0, player.hp) + player.quan.length,
  hooks: [
    // ①「受到伤害后」（按伤害事件，不按点数）与 ②「使用仅指定一个目标的牌造成伤害后」
    // 两个时机分别派发，但都汇进同一个判据 + 同一个询问
    { timing: 'afterDamage', skillId: '权计', handler: askQuanji },
    { timing: 'afterDamageDealt', skillId: '权计', handler: askQuanji },
  ],
  activeSkills: [PAIYI_SKILL],
  skills: [
    {
      name: '权计',
      desc: '当你受到一次伤害后，或当你使用仅指定一个目标的牌对该目标造成伤害后，你可以摸一张牌，然后将你的一张牌置于武将牌上，称为「权」。你每有一张「权」，手牌上限+1。',
    },
    {
      name: '排异',
      desc: '出牌阶段限两次，你可以移去一张「权」，然后令一名角色摸两张牌：若其手牌数大于你，你对其造成1点伤害。',
    },
  ],
};

const BUCHEN_AMBITIONIST: Hero[] = [
  JIE_ZHONGHUI,
  SP_SIMAZHAO,
  GONGSUNYUAN,
];

export const HEROES: Hero[] = [
  LIUQI,
  TANGZI,
  SHIXIE,
  ZHANGLU,
  MIFANG,
  MENGDA,
  LIUBA,
  XIAHOUBA,
  SUNCHEN,
  PENGYANG,
  WENQIN,
  ZHULING,
  PANJUN,
  SUFEI,
  XUYOU,
  ZHUGEKE,
  HUANGZU,
  ...BUCHEN_AMBITIONIST,
  JUN_CAOCAO,
  JUN_LIUBEI,
  JUN_SUNQUAN,
  JUN_YUANSHAO,
  GUANYU,
  ZHANGFEI,
  ZHAOYUN,
  MACHAO,
  HUANGZHONG,
  WEIYAN,
  ZHUGELIANG,
  WOLONG,
  HUANGYUEYING,
  LIUSHAN,
  PANGTONG,
  GANFUREN,
  MENGHUO,
  LIUBEI,
  JIANGWEI,
  ZHURONG,
  LVBU,
  DIAOCHAN,
  JIAXU,
  DONGZHAO,
  ZHENJI,
  SIMAYI,
  XIAHOUDUN,
  XUCHU,
  GUOJIA,
  ZHANGLIAO,
  ZHANGHE,
  LIDIAN,
  ZANGBA,
  MADAI,
  LINGTONG,
  MASU,
  BENGSHUAI,
  DONGZHUO,
  CAOCAO,
  XUNYU,
  CAOPI,
  CAOREN,
  DIANWEI,
  XIAHOUYUAN,
  YUEJIN,
  XUHUANG,
  HUATUO,
  YUANSHAO,
  SUNQUAN,
  ZHOUYU,
  GANNING,
  HUANGGAI,
  DAQIAO,
  XIAOQIAO,
  XUSHENG,
  CHENWU_DONGXI,
  JIANGWAN_FEYI,
  HETAIHOU,
  MIFUREN,
  ZHANGREN,
  DENGAI,
  YUJI,
  XUNYOU,
  SUNCE,
  LVFAN,
  ZUOCI,
  BIANFUREN,
  SHAMOKE,
  LIJUE_GUOSI,
  YUJIN,
  CUIYAN_MAOJIE,
  FAZHENG,
  WANGPING,
  LUKANG,
  ZHANGXIU,
  WUGUOTAI,
  YUANSHU,
  WUJING,
  YANBAIHU,
  XUSHU,
  YONGJUE,
  CAOHONG,
  JIANGQIN,
  TAISHICI,
  LVMENG,
  LUSU,
  LUXUN,
  SUNSHANGXIANG,
  MATENG,
  PANFENG,
  SUNJIAN,
  PANGDE,
  DINGFENG,
  JILING,
  KONGRONG,
  CAIWENJI,
  YANLIANG_WENCHOU,
  ZHANGZHAO_ZHANGHONG,
  TIANFENG,
  ZOUSHI,
  ZHANGJIAO,
  ZHOUTAI,
  VANILLA,
];

const HERO_MAP: Record<string, Hero> = Object.fromEntries(HEROES.map((h) => [h.id, h]));

export function getHero(id: string | null | undefined): Hero | undefined {
  if (id == null) return undefined;
  return HERO_MAP[id];
}

/**
 * 某模式下可进入选将池的武将（还没做势力/中立之类的额外过滤）。
 *
 * 国战专属武将靠 Hero.modes 挡在军争/混战之外。取池子一律走这里，
 * 不要再直接遍历 HEROES——否则加了国战专属武将就会漏进其它模式。
 */
export function poolForMode(mode: GameMode): Hero[] {
  // notDraftable：只作为「被授予的技能」存在的伪武将（崩坏、勇决…），不进选将池
  return HEROES.filter((h) => !h.notDraftable && (!h.modes || h.modes.includes(mode)));
}

/**
 * 生效势力：国战里**暗置的武将牌没有势力**（暗将之间也互视为不同势力）。
 * 所以只有「至少明置了一张武将牌」的国战角色才有势力，其余返回 null。
 *
 * ⚠️ 它只用于「谁和谁算同势力」这类**互相认同**的判断
 * （护驾/激将、救援、以逸待劳、远交近攻、吴六剑的攻击范围加成）。这两类**不要**用它：
 * - 胜负判定 / 野心家判定：势力选将时就定下了，暗置只是别人不知道；
 * - 鏖战那种客观残局条件：同样是数真实势力（见 isAoyu）。
 */
/**
 * 「场上一个**已确定势力**的存活角色数」——君袁绍·会盟用的计数。
 *
 * 口径（用户核对后的官方规则）：
 * - 只数**当前已经确定势力**的存活角色；**未确定势力的角色不计入任何势力**——
 *   哪怕程序后台知道他那两张武将牌是什么势力（官方有「未确定势力角色」这个明确状态，
 *   野心家规则也写作「当一名**明置武将确定势力**时」才按该势力当前人数判断）。
 * - 这里**不读** `player.faction` 这个后台真实势力：判定统一走 `effectiveFaction`。
 * - 野心家/中立不算「一个势力」（与 bigFactions、isAoyu 的排除一致）。
 * - ⚠️ 实现说明（用户提醒）：`effectiveFaction` 现在的写法是「明置过至少一张武将牌」，
 *   在**双势力 / 新势力**那些规则下，「明置」与「确定势力」并不完全等价。真正该有的是一个
 *   显式的 `determinedFaction` 状态。本仓库目前只在**这一个函数**里做判定，所以将来要换口径
 *   只需改这里（各处没有自己写 `heroRevealed` 判断），见 docs/guozhan-roster.md §5.71。
 */
export function knownFactionCount(state: GameState, faction: Faction | null): number {
  if (!faction || faction === 'ambitionist' || faction === 'neutral') return 0;
  return state.players.filter((p) => p.alive && effectiveFaction(state, p) === faction).length;
}

export function effectiveFaction(state: GameState, player: Player): Faction | null {
  if (state.mode !== 'guozhan') return player.faction;
  // 顺序要紧：**先看「有没有确定势力」**（暗置 = 未确定势力，谁都看不到），
  // 再看**确定下来的是哪一个**——双势力武将填了 `determinedFaction` 就用它
  // （见 determineDualFaction；确定后整局都按这一个势力算，不会因为重新暗置切回另一个），
  // 没填的（单势力武将）等价于 `player.faction`。
  if (!player.heroRevealed && !player.deputyRevealed) return null;
  return player.determinedFaction ?? player.faction;
}

/**
 * 某势力当前的存活人数（按**真实**势力数）。
 *
 * 和 `effectiveFaction` 一样、和胜负/鏖战同口径：暗置只是别人不知道，牌上的势力仍然在。
 * 「势力存活统计」以前在 isAoyu / checkWin / finishDraft 里各写了一份，
 * 现在统一走这里，避免出现第四种口径。
 */
export function factionAliveCount(state: GameState, faction: Faction | null): number {
  if (!faction) return 0;
  return state.players.filter((p) => p.alive && p.faction === faction).length;
}

/**
 * 场上的**大势力**（势备篇）：某势力存活 ≥2 且为全场最多（并列最多也算）。
 *
 * 野心家不计入（它不是「势力」，是单独的阵营）。都没有 ≥2 时返回空数组
 * ——那也意味着没有小势力。
 */
export function bigFactions(state: GameState): Faction[] {
  const counts = new Map<Faction, number>();
  for (const p of state.players) {
    // ⚠️ 口径：**未确定势力（暗置）的角色不属于任何势力**，不能拿后台的 p.faction 充人数
    //    （暗置者「没有任何武将技能、性别以及势力」）。与会盟/问计/兴棹同一口径。
    const f = effectiveFaction(state, p);
    if (!p.alive || !f || f === 'ambitionist') continue;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const max = Math.max(0, ...counts.values());
  if (max < 2) return [];
  return [...counts.entries()].filter(([, n]) => n === max).map(([f]) => f);
}

/** 该势力是不是大势力 */
export function isBigFaction(state: GameState, faction: Faction | null): boolean {
  return !!faction && bigFactions(state).includes(faction);
}

/**
 * 该势力是不是小势力：**存在大势力时**，不是大势力的那些势力都是小势力。
 * 没有大势力（谁都没到 2 人）时不算小势力——所以小势力与大势力互斥且成对出现。
 */
export function isSmallFaction(state: GameState, faction: Faction | null): boolean {
  if (!faction) return false;
  const bigs = bigFactions(state);
  return bigs.length > 0 && !bigs.includes(faction);
}

/**
 * 取某个玩家**还暗着**的武将（国战「预亮」要用）。
 *
 * 与 `revealedHeroes` 相对：那边是「已经生效的技能」，这边是「可以预亮、
 * 但技能还没生效」的那几张牌。非国战没有暗置概念，恒返回空数组。
 */
export function unrevealedHeroes(
  mode: GameMode,
  p: {
    heroId: string | null;
    deputyHeroId: string | null;
    heroRevealed: boolean;
    deputyRevealed: boolean;
  },
): Hero[] {
  if (mode !== 'guozhan') return [];
  const out: Hero[] = [];
  const main = getHeroForMode(p.heroId, mode);
  if (main && !p.heroRevealed) out.push(main);
  const deputy = getHeroForMode(p.deputyHeroId, mode);
  if (deputy && !p.deputyRevealed) out.push(deputy);
  return out;
}

/**
 * 取某个玩家**当前生效**的武将（国战暗将不算，暗将技能一律不生效）。
 *
 * 放在 heroes.ts 而不是 engine.ts，是为了让 distance.ts 也能用：
 * engine 依赖 distance，distance 不能再反向依赖 engine。
 */
export function revealedHeroes(
  mode: GameMode,
  p: {
    heroId: string | null;
    deputyHeroId: string | null;
    heroRevealed: boolean;
    deputyRevealed: boolean;
  },
): Hero[] {
  const out: Hero[] = [];
  const main = getHeroForMode(p.heroId, mode);
  if (main && (mode !== 'guozhan' || p.heroRevealed)) out.push(main);
  const deputy = getHeroForMode(p.deputyHeroId, mode);
  if (deputy && (mode !== 'guozhan' || p.deputyRevealed)) out.push(deputy);
  return out;
}

/**
 * 取某个模式下该武将的实际定义。
 *
 * **国战与军争的同名技能不一样**，所以引擎判定技能、界面展示技能说明时
 * 都必须用这个函数；直接 getHero() 会拿到身份局版本。
 */
/**
 * 「君主将 ↔ 标准版」的对应表（国战选将时两者可以互换）。
 *
 * 官方国战里君主将是**替换**同名标准武将登场的，而发将又是随机的——所以线上通行做法是：
 * 你发到了标准版，就等于你也拿到了对应的君主版（反之亦然），选将时随便用哪一个。
 * 键与值互为对应，从哪一边查都行。
 *
 * ⚠️ 只有这四对：每位君主对应一位同势力的标准武将。
 */
const LORD_VARIANTS: Record<string, string> = {
  caocao: 'juncaocao',
  juncaocao: 'caocao',
  liubei: 'junliubei',
  junliubei: 'liubei',
  sunquan: 'junsunquan',
  junsunquan: 'sunquan',
  yuanshao: 'junyuanshao',
  junyuanshao: 'yuanshao',
};

/**
 * 一个武将的**本体 id**：同一武将的不同版本（标准版 / 君主版 / 将来的界·谋…）返回同一个值。
 *
 * 用户给定的口径：**同一个本体的两个版本不能同时当主将+副将**（「曹操 + 君曹操」这种组合
 * 是同一名武将，规则上不允许）；这也顺带说明了将来加「界曹操」时该怎么处理——填同一个
 * `canonicalId` 即可，判定代码不用改。默认（没填 `canonicalId` 的武将）就是它自己的 id。
 */
export function heroCanonicalId(heroId: string | null | undefined): string | undefined {
  if (!heroId) return undefined;
  return getHero(heroId)?.canonicalId ?? heroId;
}

/** 这两张武将牌是不是**同一个武将的两个版本** */
export function sameHeroBody(a: string, b: string): boolean {
  const ca = heroCanonicalId(a);
  return !!ca && ca === heroCanonicalId(b);
}

/**
 * 双势力武将的**确定势力**规则（2023 移动版口径，用户给定）。
 *
 * 输入是主将、副将两张牌，返回：
 * - `{ kind: 'auto', faction }`：唯一能确定的势力 → 直接采用；
 * - `{ kind: 'choice', options }`：有两个共同势力，或与野心家武将组合 → **要玩家自己选**；
 * - `null`：跟双势力无关（两张都是单势力）→ 沿用原来的单势力逻辑。
 */
export function determineDualFaction(
  main: Hero | undefined,
  deputy: Hero | undefined,
  mode: GameMode,
): { kind: 'auto'; faction: Faction } | { kind: 'choice'; options: Faction[] } | null {
  if (mode !== 'guozhan' || !main || !deputy) return null;
  const factionsOf = (h: Hero): Faction[] =>
    h.secondFaction ? [h.faction, h.secondFaction] : [h.faction];
  const isWild = (h: Hero): boolean => h.faction === 'ambitionist';
  const mainDual = !!main.secondFaction;
  const deputyDual = !!deputy.secondFaction;
  if (!mainDual && !deputyDual) return null; // 两张都是单势力 → 不归它管
  // 与野心家武将组合 → 玩家自己选那张双势力牌的势力
  if (isWild(main) || isWild(deputy)) {
    const dual = mainDual ? main : deputy;
    return { kind: 'choice', options: factionsOf(dual) };
  }
  const shared = factionsOf(main).filter((f) => factionsOf(deputy).includes(f));
  if (shared.length === 1) return { kind: 'auto', faction: shared[0]! };
  if (shared.length >= 2) return { kind: 'choice', options: shared };
  // 没有任何共同势力：官方没写这种组合（两张双势力却没有共同势力），不猜
  return null;
}

/** 这张武将牌可以换成的另一版（君主版 / 标准版）；没有对应版本时返回 undefined */
export function lordVariantOf(heroId: string | null | undefined): string | undefined {
  if (!heroId) return undefined;
  return LORD_VARIANTS[heroId];
}

/**
 * 某个座位选将时**实际可选**的武将 id 列表。
 *
 * ＝ 发到的那几张，外加「君主/标准版互换」里**没有发到别人手上**的另一版。
 *
 * ⚠️ 为什么必须看别人手里有没有：发将本来是「武将池洗牌后按座次不重叠发牌」（一张武将牌
 * 只在一个人的选项里），而「君主↔标准版」这条放宽等于把两张牌绑在一起——若不检查，
 * A 发到【曹操】就能换成【君曹操】，而【君曹操】可能正发在 B 手里，于是同一张武将牌
 * 落到两个人身上（珠联璧合、变更副将、UI 的「谁是谁」全都依赖武将牌唯一）。
 * 规则口径按「那张牌在谁手里就是谁的」：只有**没人拿到**的那一版才是白捡的。
 *
 * 引擎的 pickHero 校验与界面提示（`legalHeroIds`）都用它。
 */
export function draftOptionsFor(state: GameState, seatId: string): string[] {
  const draft = state.draft;
  if (!draft) return [];
  const mine = draft.deals[seatId] ?? [];
  const others = new Set<string>();
  for (const [seat, list] of Object.entries(draft.deals)) {
    if (seat === seatId) continue;
    for (const id of list) others.add(id);
  }
  const out = [...mine];
  for (const id of mine) {
    const variant = lordVariantOf(id);
    if (variant && !others.has(variant) && !out.includes(variant)) out.push(variant);
  }
  return out;
}

/** 这个座位此刻能不能选这个武将（发到的将，或没人拿走的互换版本） */
export function draftAllowsHero(state: GameState, seatId: string, heroId: string): boolean {
  return draftOptionsFor(state, seatId).includes(heroId);
}

export function getHeroForMode(id: string | null | undefined, mode: GameMode): Hero | undefined {
  const base = getHero(id);
  if (!base) return undefined;
  if (mode !== 'guozhan' || !base.guozhan) return base;
  return { ...base, ...base.guozhan };
}

/**
 * 非锁定技失效时，把这张武将牌上「非锁定的部分」摘掉。
 *
 * 「非锁定技失效」认的是 `PlayerFlags.nonLockedSkillsDisabled`（新国战·铁骑那类）。
 * 钩子/主动技看各自的 `locked`；字段型技能看 Hero.lockedFields——
 * **没列进 lockedFields 的字段一律删掉**，这正是武圣/龙胆会被屏蔽、
 * 马术/空城不会的原因。
 */
function nullifyHero(h: Hero): Hero {
  const lockedFields = new Set(h.lockedFields ?? []);
  const out: Record<string, unknown> = { ...h };
  for (const f of ALL_FIELD_SKILLS) {
    if (!lockedFields.has(f)) delete out[f];
  }
  out.hooks = h.hooks?.filter((hk) => hk.locked);
  out.activeSkills = h.activeSkills?.filter((s) => s.locked);
  return out as unknown as Hero;
}

/**
 * 「获得技能」借来的技能：从原武将身上只摘出指定的那一个，打包成合成武将。
 *
 * 三样东西都要摘：钩子（按 `HookRegistration.skillId`）、主动技（按名字）、
 * 字段型能力（按 `Hero.skillFields`）。摘完是个合法的 Hero，所以
 * activeHeroes 的所有消费方（runHooks / activeSkills / 各字段）都能原样工作。
 */
export function grantedHeroes(state: GameState, p: Player): Hero[] {
  const out: Hero[] = [];
  // 永久授予的 + 本回合临时授予的（tempGrantedSkills，回合结束时清空）
  for (const g of [...(p.grantedSkills ?? []), ...(p.tempGrantedSkills ?? [])]) {
    const src = getHeroForMode(g.heroId, state.mode);
    if (!src) continue;
    const srcRaw = src as unknown as Record<string, unknown>;
    const synthetic: Record<string, unknown> = {
      id: `${src.id}#${g.skillName}`,
      name: src.name,
      faction: src.faction,
      maxHp: src.maxHp,
      skills: [],
    };
    for (const f of src.skillFields?.[g.skillName] ?? []) synthetic[f] = srcRaw[f];
    synthetic.hooks = src.hooks?.filter((hk) => hk.skillId === g.skillName);
    synthetic.activeSkills = src.activeSkills?.filter((s) => s.name === g.skillName);
    out.push(synthetic as unknown as Hero);
  }
  return out;
}

/**
 * 取某玩家**当前生效**的武将——已考虑暗将、「非锁定技失效」与「借来的技能」。
 *
 * 引擎的 activeHeroes 与 distance.ts 的马术都走这里，所以两处口径一致。
 */
export function effectiveHeroes(state: GameState, p: Player): Hero[] {
  let heroes = [...revealedHeroes(state.mode, p), ...grantedHeroes(state, p)];
  // 国战「移除」：那张牌离场、用士兵牌顶替，**没有技能**（势力/性别/体力上限保留）
  if (p.removedHeroIds.length > 0) {
    heroes = heroes.filter((h) => !p.removedHeroIds.includes(h.id));
  }
  // （主将技/副将技的过滤在 collectTimingHooks 里按技能做——见 Hero.mainSlotSkills）
  // 蔡文姬·断肠：被点名的那张武将牌**技能全失**（势力/性别照旧，所以它还在
  // selectable 的名单里、只是没有技能）。暗置时被点名也照样算——将来明置也不会有技能。
  if (p.nullifiedHeroId) heroes = heroes.filter((h) => h.id !== p.nullifiedHeroId);
  if (!p.flags.nonLockedSkillsDisabled) return heroes;
  return heroes.map(nullifyHero);
}

/**
 * 这个角色「算不算装备着【玉玺】」——真的装在宝物栏，或者是袁术·庸肆给的虚拟玉玺。
 *
 * 庸肆：锁定技，**若场上没有【玉玺】**，你视为装备着【玉玺】。
 * 「场上没有」按字面理解成「任何角色的装备区里都没有实体玉玺」——所以别人拿到玉玺时，
 * 庸肆的虚拟玉玺就没了（袁术明置与否由 effectiveHeroes 决定：暗置时没有技能）。
 * 【玉玺】的两条效果（摸牌阶段多摸一张、出牌阶段开始时视为使用【知己知彼】）都读这个函数。
 */
export function hasYuxi(state: GameState, player: Player): boolean {
  if (player.equipment.treasure?.equipName === 'yuxi') return true;
  if (!effectiveHeroes(state, player).some((h) => h.virtualYuxi === true)) return false;
  return !state.players.some((p) => p.equipment.treasure?.equipName === 'yuxi');
}

/**
 * 这张牌「对某个角色而言」长什么样（只有花色/颜色会被改写，id 与实体不变）。
 *
 * 目前唯一的来源是小乔·红颜（锁定技，你的黑桃牌视为红桃牌）。官方对「你的牌」的
 * 界定：你的手牌、你装备区的牌、**由你进行的判定**的判定牌——「谁判定，判定牌
 * 就属于谁」，所以鬼才/鬼道换上来的牌也算她的；而马超·铁骑、夏侯惇·刚烈那种
 * 「技能拥有者判定」的判定牌不算（那些牌的主人是不带红颜的那个人，天然不受影响）。
 *
 * 暗置的小乔不生效——`effectiveHeroes` 已经把暗置武将滤掉了。
 */
export function cardAsSeenBy(
  state: GameState | undefined,
  owner: Player | undefined,
  card: Card,
): Card {
  if (!state || !owner) return card;
  // 虚拟牌没有实体牌面：不参与「黑桃当红桃」这类**看花色**的转化
  // （它的颜色只由 `color` 决定；严白虎·寄篱的第二张牌正是靠这一点保持无色，不会自环）
  if (card.virtual) return card;
  if (card.suit !== 'spade') return card;
  if (!effectiveHeroes(state, owner).some((h) => h.spadeAsHeart === true)) return card;
  // 红桃 + 红色一起改：读 suit 的地方（判定/火攻/仁王盾颜色）两样都会用到
  return { ...card, suit: 'heart', color: 'red' };
}

/** 这张牌对某个角色而言的花色（红颜：黑桃 → 红桃） */
export function suitSeenAs(
  state: GameState | undefined,
  owner: Player | undefined,
  card: Card,
): Suit {
  return cardAsSeenBy(state, owner, card).suit;
}

/** 这张牌对某个角色而言的颜色（红颜：黑桃 → 红桃 → 红色） */
export function colorSeenAs(
  state: GameState | undefined,
  owner: Player | undefined,
  card: Card,
): 'red' | 'black' | null {
  return cardColor(cardAsSeenBy(state, owner, card));
}

/** 取武将每回合杀数上限，缺省 1 */
export function heroShaLimit(hero: Hero): number {
  return hero.shaLimit?.() ?? 1;
}

/**
 * 取武将可否把 card 当 type 用。
 *
 * 传进去的是**对这名玩家而言**的牌面（小乔·红颜：她的黑桃视为红桃），
 * 所以武圣（红色）、奇袭/断粮（黑色）、国色（方块）这些按花色写的转化技
 * 自动按红颜的口径判——一处收口，避免每个 canUseAs 自己记得转换。
 */
export function heroCanUseAs(
  hero: Hero,
  card: Card,
  type: CardType,
  state?: GameState,
  player?: Player,
): boolean {
  const seen = player ? cardAsSeenBy(state, player, card) : card;
  return hero.canUseAs?.(seen, type, state, player) ?? false;
}

/** 取该武将参与【决斗】时、对手每次需打出的【杀】数（吕布·无双 = 2），缺省 1 */
export function heroDuelShaRequired(hero: Hero): number {
  return hero.duelShaRequired ?? 1;
}

/**
 * 珠联璧合：两名武将是否构成官方组合。
 * 内部两个方向都查了，所以调用方一次调用即可，不必再反向调一遍。
 */
export function hasCombo(a: Hero, b: Hero): boolean {
  if (a.combos?.includes(b.id) || b.combos?.includes(a.id)) return true;
  if (a.combo?.with === b.id || b.combo?.with === a.id) return true;
  return false;
}

/**
 * 目标角色是否被其**生效武将**的锁定技挡掉，不能成为 card 的目标。
 * 空城/谦逊/帷幕都走这里（暗将的锁定技同样不生效，因为走的是 revealedHeroes）。
 */
/**
 * 明光铠（锁定技）：当你成为火焰类锦囊（【火攻】【火烧连营】）的目标时，取消之。
 *
 * 做成「目标合法性」判断而不是事后取消——效果与【帷幕】那类一致，
 * 所以挂在 heroBlocksBeingTarget 里，那十来个调用点（出牌校验 + 提示的合法目标）全部生效。
 * 火【杀】不走这里：它由 armorNullifiesSha 在「目标已定」之后作废（能正确豁免青釭剑）。
 */
export function armorCancelsFireTrick(state: GameState, target: Player, card: Card): boolean {
  if (card.equipName) return false; // 装备牌不是锦囊
  if (!FIRE_TRICKS.has(card.type)) return false;
  return target.equipment.armor?.equipName === 'mingguang';
}

/**
 * 会不会被横置（明光铠：小势力角色不会被横置）。
 * 大势力 / 未确定势力的人照常可被横置——只有「小势力」这一条豁免。
 */
export function immuneToChaining(state: GameState, player: Player): boolean {
  if (player.equipment.armor?.equipName !== 'mingguang') return false;
  return isSmallFactionCharacter(state, player);
}

/**
 * 「**小势力角色**」判定（【勠力同心】【明光铠】共用，官方势备篇）：
 *   大势力＝人数最多且大于 1 的势力；**存在大势力时**「除大势力角色外的**所有**角色均称为小势力角色」。
 * ⚠️ 关键：这里的「所有角色」**不要求已确定势力**——暗置/未确定势力的角色**也算小势力角色**；
 *    但**不存在大势力**时这套定义整体不成立（谁都不是小势力角色）。
 */
export function isSmallFactionCharacter(state: GameState, player: Player): boolean {
  const bigs = bigFactions(state);
  if (bigs.length === 0) return false;
  const f = effectiveFaction(state, player);
  return f === null ? true : !bigs.includes(f);
}

export function heroBlocksBeingTarget(
  state: GameState,
  target: Player,
  card: Card,
  source: Player,
): boolean {
  // 非「技能」造成的不可被指定（调虎离山：本回合不能成为任何牌的目标）也统一走这里，
  // 这样那十来个调用点（出牌校验 + legal 的合法目标计算）自动全部生效。
  if (target.flags.cannotBeTargetThisTurn) return true;
  // 装备带来的「取消目标」（明光铠 vs 火焰类锦囊）也在这里统一判
  if (armorCancelsFireTrick(state, target, card)) return true;
  return revealedHeroes(state.mode, target).some(
    (h) => h.cannotBeTargetOf?.(state, target, card, source) ?? false,
  );
}

/** 这组生效武将里是否有人无视锦囊牌的距离限制（黄月英·奇才） */
export function heroIgnoresTrickDistance(heroes: Hero[], player?: Player): boolean {
  // SP司马昭·夙智②：本回合「使用锦囊无距离限制」（与黄月英·奇才同一个判据：
  // 调用方把 player 传进来时，动态标记也一并生效）
  if (player?.flags.ignoresTrickDistanceThisTurn) return true;
  return heroes.some((h) => h.ignoresTrickDistance === true);
}

/** 从手牌中移除一张牌（按 id） */
function removeCard(hand: Card[], id: string): Card | null {
  const i = hand.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const [c] = hand.splice(i, 1);
  return c ?? null;
}

/** 某人身上可以被「拿走」的牌：手牌 + 装备区 */
function handAndEquipOf(p: Player): Card[] {
  const eq = p.equipment;
  return [...p.hand, ...EQUIP_SLOTS.map((s) => eq[s]).filter((c): c is Card => c !== null)];
}

/**
 * 这个字段型能力是哪个技能给的（读 `Hero.skillFields` 的反向表）。
 *
 * 两处用：① 把技能从别的武将身上摘出来时知道要带走哪些字段；
 * ② 引擎记日志时说出正确的技能名——否则「南蛮对我无效」会被硬编码成
 * 【巨象】，孟获的【祸首】就会在日志里被写成别人的技能。
 */
export function skillNameForField(heroes: Hero[], field: FieldSkill): string | null {
  for (const h of heroes) {
    for (const [name, fields] of Object.entries(h.skillFields ?? {})) {
      if (fields.includes(field)) return name;
    }
  }
  return null;
}

/**
 * 判断玩家是否为男性。
 *
 * 取的是**明置**的武将：国战里暗置的武将牌**没有性别**，所以暗将既不是男性
 * 也不是女性（雌雄双股剑、结姻这些「异性 / 男性」判定都不认它）。
 * 两张都明置时按官方规则**取主将的性别**。
 */
export function isMalePlayer(state: GameState, player: Player): boolean {
  const heroes = revealedHeroes(state.mode, player);
  if (heroes.length === 0) return false; // 全暗置：没有性别
  return heroes[0]!.gender === 'male';
}

// —— 身份显示名（军争模式） ——
export const ROLE_NAME: Record<RoleId, string> = {
  lord: '主公',
  loyal: '忠臣',
  rebel: '反贼',
  renegade: '内奸',
};

// —— 阵营显示名（国战模式） ——
export const FACTION_NAME: Record<Faction, string> = {
  shu: '蜀',
  wei: '魏',
  wu: '吴',
  qun: '群',
  neutral: '中立',
  ambitionist: '野心家',
};
