import type { Card, DamageAttribute, Suit, TrickType } from '@sgs/protocol';
import type { GameState, Player } from './model';

// 事件时序点（时机）。
// 引擎自身控制流会按这些顺序推进，并在每个时机调用 runHooks；
// 武将触发技可挂在某时机上，对结算进行修改/打断。
export type Timing =
  | 'turnStart'
  | 'judgePhase' // 判定阶段开始
  | 'beforeJudge' // 判定牌生效前（鬼才替判 / 天妒取牌）
  | 'drawPhase' // 摸牌阶段开始（可改摸牌数：突袭）
  | 'drawPhaseEnd' // 摸牌阶段结束时（裸衣：这时才弃牌加伤害）
  | 'playPhase'
  /**
   * 出牌阶段**结束**时（正常打完这个阶段；被乐不思蜀/巧变整个跳过的不会发）。
   * 董卓·暴凌挂这里。
   */
  | 'playPhaseEnd'
  /**
   * **其他角色**的出牌阶段开始时（派给**除他以外**的所有存活角色，
   * payload.turnSeatId 是回合玩家）。何太后·鸩毒挂这里——`playPhase` 只发给回合玩家本人。
   */
  | 'othersPlayPhase'
  | 'discardPhase'
  /**
   * 弃牌阶段**结束时**（弃完牌之后）。孟获·再起挂在这里——它要读「本回合进入
   * 弃牌堆的红桃牌数」，必须等弃牌阶段真的结束。
   */
  | 'discardPhaseEnd'
  | 'turnEnd'
  /**
   * **其他角色**的结束阶段（派发给非回合玩家，payload.turnSeatId 是回合玩家）。
   * 乐进·骁果那种「其他角色的结束阶段」的技能靠它——`turnEnd` 只发给回合玩家。
   */
  | 'othersTurnEnd'
  | 'useCard' // 使用牌时（声明使用、指定目标后）
  | 'becomeTarget' // 成为目标时（目标可响应）
  /**
   * **一名角色**成为【杀】的目标后（派给**所有存活角色**，payload.targetId 是谁成为目标）。
   * 徐盛·疑城挂这里——「与你势力相同的角色成为【杀】的目标后」，那是别人的事，
   * `becomeTarget` 只发给当事人本人，看不到。派发在目标自己的 becomeTarget **之前**，
   * 所以摸一弃一发生在防具/八卦/等出闪之前。
   */
  | 'othersBecomeTarget'
  | 'beforeResolve' // 结算前
  | 'afterResolve' // 结算后
  /**
   * **你使用或打出【闪】**（派给打出那张【闪】的人；八卦阵那种「视为使用【闪】」也算）。
   * 张角·雷击挂这里。
   */
  | 'shanUsed'
  /**
   * **你使用的【杀】被【闪】抵消**（派发给**来源**，payload.attack）。
   * 庞德·猛进挂这里。注意青龙偃月刀/贯石斧那两件武器是写死在 finishAttack 里的，
   * 英雄技能要走这个时机才挂得上去。
   */
  | 'shaDodged'
  | 'afterUse' // 使用牌后
  /**
   * **你的牌因弃置而进入弃牌堆**（派给牌的拥有者，payload.cards 是刚进弃牌堆的那几张）。
   * 孔融·礼让挂这里。注意只覆盖「弃置」：使用牌进弃牌堆、拼点亮牌、阵亡清牌都不算。
   */
  | 'cardDiscarded'
  | 'equipLost' // 失去装备区里的一张牌后（枭姬）
  | 'handEmptied' // 失去最后一张手牌后（连营）
  /**
   * **其他角色**失去所有手牌后（派给**除他以外**的所有存活角色，payload.emptiedSeatId）。
   * 蒋琬费祎·守成挂这里——「与你势力相同的一名角色于其回合外失去所有手牌后」是别人的事，
   * `handEmptied` 只发给当事人本人。是不是「其回合外」由技能自己按 payload 判断。
   */
  | 'othersHandEmptied'
  /**
   * 受到伤害时（扣血前）。**可挂起**，也是唯一能**取消**伤害的时机：
   * 钩子里设 `flags.damagePrevented = true`，引擎在钩子跑完之后读到就整条伤害作废
   * （不扣血、不跑伤害后钩子、不进濒死）。小乔·天香用它。
   */
  | 'damageDealt'
  | 'afterDamage' // 受到伤害后（派发给**受伤者**：反馈、刚烈、奸雄）
  /**
   * **一名角色**受到伤害后（派发给**所有存活角色**，payload.victimId 是谁受伤）。
   * 蔡文姬·悲歌那种「当一名角色受到【杀】造成的伤害后」挂这里——
   * `afterDamage` 只发给受伤者本人，观察不到别人挨打。
   */
  | 'anyDamaged'
  | 'afterDamageDealt' // 造成伤害后（派发给**伤害来源**：狂骨这类「你造成的伤害」技能）
  | 'nearDeath' // 濒死
  /**
   * **其他角色**进入濒死状态（派给**除濒死者外**的所有存活角色，
   * payload: { attack, dyingId }）。田丰·随势挂这里——`nearDeath` 只发给濒死者本人。
   */
  | 'otherNearDeath'
  /**
   * **其他角色**的弃牌阶段结束时（派给除该角色外的所有存活角色，
   * payload: { discardingSeatId, cards }，cards 是他这个弃牌阶段弃置的牌）。
   * 张昭张纮·固政挂这里。`discardPhaseEnd` 只发给回合玩家本人。
   */
  | 'othersDiscardPhaseEnd'
  /**
   * **你**（作为来源）即将对别人造成伤害时（派给**来源**，payload { attack, damage }）。
   * 和目标那一侧的 `damageDealt` 是同一时刻、两个视角：张任·穿心要「防止自己造成的伤害」，
   * 所以得在来源这边问。设上 `目标.flags.damagePrevented` 即可取消这次伤害。
   */
  | 'damageCaused'
  /**
   * **你**的【杀】整个结算完之后（派给**使用者**，payload.attack）。
   * 糜夫人·存嗣给的【勇决】挂这里（「此【杀】结算后你可以获得之」）。
   */
  | 'attackSettled'
  /**
   * **你**的武将牌被明置后（派给该玩家，payload.heroId）。
   * 糜夫人·闺秀挂这里（「当你明置此武将牌后，你可以摸两张牌」）。
   */
  | 'heroRevealed'
  | 'kill' // 你**杀死**了一名角色（派发给凶手，payload.victimId）——曹丕·行殇
  | 'afterHeal' // 回复体力后（派发给回复者，payload.amount 是**实际**回复量）——甘夫人·淑慎
  | 'death'; // 死亡

/**
 * 回复体力后的载荷。
 * `amount` 是**实际**回复量（受体力上限夹取后的值）——所以满体力时不触发钩子，
 * 「回复 2 点但只差 1 点」时 amount 是 1。
 */
export interface HealPayload {
  amount: number;
}

/** 装备区里失去一张牌的原因，供技能区分（都触发 equipLost，但语义不同） */
export interface EquipLostPayload {
  card: Card;
}

/**
 * 引擎注入给技能与钩子的内部 API。
 *
 * 定义放在 timing.ts（而不是 heroes.ts）是为了让 HookContext 能用它——
 * heroes 依赖 timing，反向依赖会变成两边都要 import 对方。
 * 由 engine.ts 构造注入，避免 heroes→engine 循环依赖。
 */
export interface SkillApi {
  /** 造成伤害（触发伤害钩子 + 濒死检查） */
  /**
   * 造成伤害（走完整伤害层：减伤 → 防止 → 扣血 → 伤害后钩子 → 濒死）。
   *
   * `after` 是「这次伤害**结算完**之后」的续接。伤害结算里可能挂起询问
   * （护心镜、卖血技、濒死求桃），所以**必须**用 after 来接后续步骤，
   * 不能在调用之后直接往下写——那样会在伤害真的落地之前就执行。
   * 小乔·天香要「先伤害、后摸 X 张牌」，靠的就是它。
   */
  dealDamage: (
    target: Player,
    damage: number,
    sourceId: string,
    attribute?: DamageAttribute,
    after?: () => void,
  ) => void;
  /** 失去体力（不触发伤害钩子，但触发濒死检查） */
  /** 失去体力（不是伤害：没有来源、不触发卖血技，但会进濒死）。`after` 同上。 */
  loseHp: (target: Player, amount: number, after?: () => void) => void;
  /**
   * 回复体力（上限夹取，并触发「回复体力后」的技能）。
   * 返回**实际**回复量；再经过 `afterHeal` 时对方拿到的也是这个数。
   */
  heal: (target: Player, amount: number) => number;
  /**
   * 让某个角色在若干选项里选一个（通用「选择一项」）。
   *
   * 在**钩子**里调用时不要传 returnTo：引擎会把被打断的流程记进续接队列，
   * 选完自动接着跑。传了反而会和引擎的续接打架。
   * 在**主动技 execute** 里调用时则必须传 returnTo（通常是技能使用者），
   * 否则选完 pending 会停在 null，出牌方再也动不了——整局就卡死了。
   */
  askChoice: (
    state: GameState,
    seatId: string,
    title: string,
    options: { id: string; label: string }[],
    resolve: (state: GameState, player: Player, optionId: string) => void,
    returnTo?: string,
  ) => void;
  /**
   * 让某个角色从给定的一组牌里选若干张。
   *
   * 候选牌不一定是手牌（观星看的是牌堆顶），所以直接传牌对象。
   * **本函数不动任何牌**——resolve 里要自己把它们搬走。
   * 秘密选牌传 `secret: true`，日志只记张数。
   *
   * 传 `returnTo` 的规则与 askChoice 相同：钩子里不传，技能 execute 里传。
   */
  askPickCards: (
    state: GameState,
    seatId: string,
    title: string,
    cards: Card[],
    min: number,
    max: number,
    resolve: (state: GameState, player: Player, picked: Card[]) => void,
    opts?: { returnTo?: string; secret?: boolean },
  ) => void;
  /**
   * 修改体力上限（董卓·崩坏减、袁术·庸肆之类）。
   * 上限变小时会把当前体力夹到新上限，并做一次濒死检查。
   */
  changeMaxHp: (target: Player, delta: number) => void;
  /**
   * 替换当前判定牌。**只能在 beforeJudge 的钩子里调用**。
   *
   * 它是给「要问了才知道换哪张」的技能准备的（鬼才、鬼道）：
   * 钩子先 `askPickCards` 让玩家挑，在回调里调本函数，引擎会接着按新判定牌结算。
   * 如果不需要询问（判定即换），直接在钩子里 `return { replaceCard }` 更简单。
   *
   * 不在判定里调用它没有效果（没有可替换的目标）。
   */
  replaceJudgeCard: (card: Card) => void;
  /**
   * 把某人的一张牌（手牌或装备区）转给另一个人。
   * 拿走装备会触发「失去装备」的技能（枭姬那类），after 在所有结算完成后调用。
   * 反馈 / 突袭 / 顺手牵羊那类「获得他人一张牌」都该走这里，别自己 splice。
   */
  transferCard: (fromSeatId: string, card: Card, toSeatId: string, after?: () => void) => void;
  /**
   * 让某人弃置自己的一张牌（手牌或装备区）。失去装备会触发那类技能。
   * after 在结算完成后调用。
   */
  discardCard: (ownerSeatId: string, card: Card, after?: () => void) => void;
  /**
   * 把一张**手牌**放进别人的装备区（张昭张纮·直谏）。
   *
   * 与 `moveFieldCard` 的区别：那张牌**还不在场上**（在某人手里），
   * 所以不能靠「找到它在哪」来移动。目标同栏位原有的牌会进弃牌堆，
   * 并触发他「失去装备区里的牌」的技能（枭姬那类）。
   */
  giveEquipTo: (card: Card, toSeatId: string, after?: () => void) => void;
  /**
   * 把当前【杀】的目标改成另一名角色（大乔·流离、小乔·天香那类）。
   * **只能在 becomeTarget 的钩子里调用**——引擎会据此对新目标重新走一遍
   * 「成为目标」的结算（被动亮将、防具、八卦、等出闪）。
   * 目标合法性（攻击范围等）由技能自己校验。
   */
  redirectAttack: (newTargetSeatId: string) => void;
  /**
   * 移动场上的一张牌到另一名角色的**对应区域**（装备牌→同类型装备栏、
   * 判定牌→判定区）。吕蒙·谋断 / 张郃·巧变用。
   *
   * 会触发失去装备区牌的技能（枭姬那类）；目标区域原有的牌进弃牌堆。
   * 找不到这张牌（已被移走/弃掉）就什么也不做，直接走 after。
   */
  moveFieldCard: (card: Card, toSeatId: string, after?: () => void) => void;
  /**
   * 立刻结束某人的出牌阶段，进入弃牌阶段（纪灵·双刃「没赢就结束出牌阶段」）。
   * 与挟天子以令诸侯走的是同一条路（goToDiscardPhase）。
   */
  endPlayPhase: (seatId: string) => void;
  /**
   * 把**刚进弃牌堆**的几张牌交给某个角色（孔融·礼让）。
   * 按 id 从弃牌堆里取出来塞进目标手牌；找不到的（已经被别人拿走了）跳过。
   */
  /** 把刚进弃牌堆的牌交给某人（孔融·礼让 / 小乔·天香）。skillName 只影响日志文案。 */
  giveDiscardedTo: (cards: Card[], targetSeatId: string, skillName?: string) => void;
  /** 交换两名角色的全部手牌（鲁肃·缔盟） */
  swapHands: (seatA: string, seatB: string) => void;
  /**
   * 拼点：双方各出一张手牌比点数，大者赢（平点算没人赢）。
   *
   * 依次问发起者与目标（扣牌阶段**不公布牌名**，等两边都扣好再一起亮），
   * 两张牌进弃牌堆，然后回调 `onResult(state, winnerId | null)`。
   * 任一方没有手牌时直接回调 null（调用方应先自己检查，给玩家一句明确的提示）。
   */
  pindian: (
    initiatorId: string,
    targetId: string,
    onResult: (state: GameState, winnerId: string | null) => void,
  ) => void;
  /**
   * 横置或重置某些角色（铁索连环）。已经处于目标状态的角色不动。
   * 横置状态本身不影响任何东西，只有**属性伤害**会沿横置的角色蔓延
   * （见 engine.spreadChainDamage）。
   */
  chainPlayers: (seatIds: string[], chained: boolean) => void;
  /**
   * 视为使用一张即时锦囊（乱击的两张牌当【万箭齐发】、荀攸·奇策那类）。
   *
   * 调用方负责把作为**代价**的牌先弃掉并写好日志；本函数只走锦囊的结算流程
   * （无懈可击询问 → 结算），来源记为 sourceSeatId。
   * 需要给花色——帷幕那类「不能被黑色锦囊指定」的锁定技要靠它判断。
   */
  castVirtualTrick: (
    sourceSeatId: string,
    spec: { type: TrickType; suit: Suit; rank?: number },
    targetIds?: string[],
  ) => void;
  /**
   * 令某角色的**非锁定技**失效，直到本回合结束（新国战·铁骑那类）。
   *
   * 靠 `locked` 标记来区分——技能要标 `locked: true` 才不会被屏蔽
   * （见 heroes.effectiveHeroes 与 Hero.lockedFields）。
   */
  nullifyNonLockedSkills: (targetSeatId: string) => void;
  /**
   * 获得另一个武将身上的某个技能（觉醒技/化身那类）。
   *
   * `skillName` 用**中文技能名**（与 skills[].name 一致）。引擎会从原武将身上
   * 摘出对应的钩子（按 HookRegistration.skillId）、主动技（按名字）、
   * 字段（按 Hero.skillFields）挂到该玩家身上，之后 `activeHeroes` 就会带上它。
   */
  /** 授予技能：默认给技能使用者，传 toSeatId 就给那个人（糜夫人·存嗣把勇决给队友） */
  grantSkill: (heroId: string, skillName: string, toSeatId?: string) => void;
  /**
   * 令某角色执行一次「军令」（董昭·劝进那类）。
   *
   * 流程：**发起者**先从随机两张军令里挑一张交给执行者，执行者再决定是否执行；
   * 执行就结算军令效果，不执行就什么都不发生。
   * `onDone(executed)` 在整条链走完后回调——技能据此结算自己的收益
   * （劝进：执行则摸一张，不执行则把手牌补到全场最多）。
   */
  armyOrder: (
    initiatorSeatId: string,
    executorSeatId: string,
    onDone: (state: GameState, executed: boolean) => void,
  ) => void;
  /**
   * 视为使用一张【杀】（夏侯渊·神速那类）。调用方先把代价付掉。
   *
   * 与 castVirtualTrick 对应——那边是锦囊，这边是【杀】。
   * 走的是和实体【杀】完全一样的结算（防具、八卦阵、流离、等出闪），
   * 只是没有实体牌（也不会进任何牌堆）。
   */
  castVirtualSha: (sourceSeatId: string, targetId: string, opts?: { logKind?: string }) => void;
  /**
   * 让某人**用一张实体牌**对某人使用【杀】（牌从手里扣掉、走正常结算）。
   *
   * 与 `castVirtualSha` 的区别：那个是「视为使用」（没有实体牌，如夏侯渊·神速）；
   * 这个是真把那张牌打出去——姜维·挑衅、贾诩·乱武都要求「使用一张【杀】」。
   * 借刀杀人那条路引擎内部就是这么做的，这里把它开放给技能用。
   */
  /**
   * 移除一张武将牌（国战「移除」：那张牌离场、用士兵牌顶替——没有技能，
   * 但势力/性别/体力上限保留）。糜夫人·闺秀/存嗣、董卓·暴凌、张任·穿心用它。
   * 若那张牌写着「被移除时回复 1 点体力」（闺秀），这里会连带结算。
   */
  removeHeroCard: (seatId: string, heroId: string) => void;
  /**
   * 让某名玩家**私密地**看一些内容（别人的手牌，或暗置武将牌的名字），
   * 他确认之后接着跑 `after`（不传就交回出牌阶段）。
   * 蒋钦·尚义用它做「令一名其他角色观看你的手牌」「观看其手牌 / 暗置武将牌」。
   */
  privateView: (
    viewerSeatId: string,
    title: string,
    content: { cards?: Card[]; note?: string },
    opts?: {
      /** 看完接着跑这里（技能里的中间步骤） */
      after?: () => void;
      /** 中间步骤以外的收尾：看完把出牌阶段还给谁（通常是技能使用者） */
      returnTo?: string;
    },
  ) => void;
  useShaOn: (
    sourceSeatId: string,
    targetId: string,
    card: Card,
    opts?: {
      logKind?: string;
      /** 这张【杀】**整个结算完**（含出闪/伤害/濒死）之后接着做的事 */
      after?: () => void;
    },
  ) => void;
  /**
   * 弃置某名角色区域里的一张牌（明牌按 id 指定；没指定或指定的是手牌时**随机**抽一张）。
   * 姜维·挑衅的「你弃置其一张牌」用它——手牌是不可见的，想拿哪张只能随机。
   */
  discardTargetCard: (targetSeatId: string, cardId?: string, after?: () => void) => void;
}

// 钩子上下文
export interface HookContext {
  state: GameState;
  player: Player;
  timing: Timing;
  payload?: unknown;
  /**
   * 引擎内部 API。钩子里要造成伤害、失去体力或发起「选择一项」一律走这里，
   * 不要手写 `hp -= n`——那样会漏掉伤害钩子与濒死检查。
   *
   * ⚠️ 用 askChoice 必须挂在**可挂起**的时机上，否则询问会被后续代码静默覆盖。
   *    可挂起的时机见 engine.ts 里 runHooksPausable 的注释。
   */
  api: SkillApi;
}

// 钩子返回：
//   { cancel: true } → 取消当前事件（becomeTarget 时 = 自动闪避）
//   { replaceCard } → 替换判定牌（beforeJudge 时 = 鬼才替判）
//   { gainJudgeCard: true } → 判定结束后把这张判定牌收入自己手里（天妒）
export type HookResult = void | { cancel?: boolean; replaceCard?: Card; gainJudgeCard?: boolean };

export type HookHandler = (ctx: HookContext) => HookResult;

export interface HookRegistration {
  timing: Timing;
  handler: HookHandler;
  /** 同时机优先级，数字大先执行 */
  priority?: number;
  /**
   * 这条钩子属于哪个技能——填**技能中文名**（钩子没有拼音 id，
   * 所以与 `skills[].name` / `ActiveSkill.name` 用同一套名）。
   *
   * 两个用途：①「获得技能」时按它把钩子从原武将身上摘出来（见 heroes.grantedHeroes）
   * ②「非锁定技失效」时可读可不读（那边主要看 `locked`）。
   * 不填＝这条钩子不归属于任何可被单独授予的技能。
   */
  skillId?: string;
  /**
   * 这是不是一个**锁定技**（咆哮/狂骨/无双…）。
   * 只影响「非锁定技失效」的判断（见 heroes.effectiveHeroes）——缺省＝非锁定技。
   */
  locked?: boolean;
}
