import type { Card, DamageAttribute, Suit, TrickType } from '@sgs/protocol';
import type { GameState, Player } from './model';

// 事件时序点（时机）。
// 引擎自身控制流会按这些顺序推进，并在每个时机调用 runHooks；
// 武将触发技可挂在某时机上，对结算进行修改/打断。
export type Timing =
  | 'turnStart'
  /**
   * **其他角色**的准备阶段（派给非回合玩家，payload.turnSeatId＝那个正在开始回合的人）。
   * 士燮·礼下挂在它上面：「一名与你势力不同的角色进入准备阶段时，其可以弃置你装备区的一张牌」——
   * 发动权在**当前回合的那个角色**，所以问的是 payload 的那位，而不是技能拥有者。
   */
  | 'othersTurnStart'
  /**
   * **其他角色**使用牌时（派给非使用者，payload 带 `{ attack, card }`，可挂起）。
   * 张鲁·米道挂在它上面：`useCard` 只派给**使用者本人**，旁观者技能收不到。
   */
  | 'othersUseCard'
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
   * **其他角色**的出牌阶段结束时（派给除回合玩家外的所有存活角色，
   * payload.turnSeatId）。吕范·典财挂这里——`playPhaseEnd` 只发给回合玩家本人。
   */
  | 'othersPlayPhaseEnd'
  /**
   * **其他角色**的出牌阶段开始时（派给**除他以外**的所有存活角色，
   * payload.turnSeatId 是回合玩家）。何太后·鸩毒挂这里——`playPhase` 只发给回合玩家本人。
   */
  | 'othersPlayPhase'
  | 'discardPhase'
  /**
   * **与你势力相同的角色的弃牌阶段开始时**——实际派给**全场**（payload.turnSeatId），
   * 由技能自己按势力过滤。卞夫人·约俭挂这里（`discardPhase` 只发给回合玩家本人）。
   */
  | 'othersDiscardPhase'
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
  /**
   * **你使用或打出**了一张牌的那一刻（使用与打出的**唯一**公共时机，payload.card）。
   * 沙摩柯·蒺藜挂这里——它要的是「本回合使用或打出的第 X 张牌」，而 useCard 只覆盖
   * 部分路径（普通出杀那条就没派发），所以另开一个只在「计数」处派发的时机。
   */
  | 'cardActionStarted'
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
   * **你于回合外失去牌后**（派给你自己，payload.cardIds 是这一手丢掉的牌 id）。
   * 邓艾·屯田挂这里。实现是「意图前后的手牌+装备区快照比对」，所以
   * 「先丢掉又摸回来」这种同一段结算里的往返检测不到（与 handEmptied 同一处局限）。
   */
  | 'cardsLost'
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
  /**
   * **一名角色的濒死结算结束后**（派给所有存活角色，
   * payload: { dyingSeatId, alive }——alive 是结算完还活着没有）。
   * 左慈·汲魂挂这里（`otherNearDeath` 是「刚进濒死」，拿不到结果）。
   */
  | 'nearDeathResolved'
  | 'kill' // 你**杀死**了一名角色（派发给凶手，payload.victimId）——曹丕·行殇
  | 'afterHeal' // 回复体力后（派发给回复者，payload.amount 是**实际**回复量）——甘夫人·淑慎
  /**
   * **你拼点的牌亮出后**（派发给拼点的**双方**，payload: { card, opponentCard, isInitiator }）。
   * 时机夹在「亮牌」与「比大小」之间——孙策·鹰扬要在这时改自己的点数。
   * 钩子在询问回调里调 `api.setPindianRank(n)` 写新点数（与判定里的 replaceJudgeCard 同一套：
   * 引擎那条自己的链读这个盒子，不能靠返回值——问了才知道改几）。
   */
  | 'pindianRevealed'
  | 'death' // 死亡
  | 'roundEnd' // 一轮结束（座次绕回首位；君主·励众在这里结算）
  | 'playerDied'
  /**
   * **有人死亡时**（派给**所有**存活角色，payload `{ victimId, killerId? }`，可挂起）。
   * 与只派给凶手的 `kill` 不同：孙綝·【嗜戮】「角色死亡时你可以收其武将牌」是**旁观者**技能，
   * 只挂 `kill` 收不到（别人杀死时……他自己是凶手反而是 `kill`）。
   */
  | 'roundStart' // 一轮开始（轮号 +1 之后、新一轮第一个回合开始之前；徐庶·荐才在这里获知武将牌）
  /**
   * 伤害**将要落地**（最终伤害值已定、尚未扣血、`flags.damagePrevented` 还没读）。
   * 与 `damageDealt`（只派给**目标**）不同，这个时机派给**全场**——徐庶·荐才那类
   * 「旁观者防止别人受到的致命伤害」才收得到；置 `target.flags.damagePrevented = true`
   * 即可让整笔伤害作废。
   */
  | 'beforeDamageApply'
  /**
   * 「**首次确定势力**」（潘濬·聪察）：一名角色从「未确定势力」第一次进入某个确定势力。
   * 派给**全场**（观察者是旁观者），payload `{ playerId, faction, isFirstDetermination }`。
   * ⚠️ 只有第一次派发——之后势力再变（野心家身份、新势力…）都不再走这里。
   */
  | 'factionDetermined'
  /**
   * 「**一次使用牌完整结算结束**」（许攸·成略）：整张牌（含所有目标）结算完之后派发，
   * payload `{ useId, sourceId, targetIds }`。派给**全场**（技能可能是旁观的同势力角色）。
   * 目前只在【杀】打完（队列清空）这一处派发——见 roster §5.115 的欠账。
   */
  | 'cardUseEnded'
  /**
   * 「**其他角色**因**弃置**把牌放进弃牌堆」（SP司马昭·夙智③）：派给**全场**——
   * `cardDiscarded` 只派给牌主，旁观者听不到，所以另开这一条。
   * payload `{ cards, ownerSeatId }`（牌主），技能自己排掉「自己弃的」。
   * 同样只算**弃置**（使用/打出/判定/「置入弃牌堆」都不走它）。
   */
  | 'anyCardDiscarded'
  /**
   * 「**任何**角色使用或打出【闪】之后」——派给全场（可挂起）。
   * 与只派给 responder 的 `shanUsed`（张角·雷击那种「你使用/打出闪」）不同：
   * 徐庶·诛害的「此【杀】的目标每用一张【闪】响应后弃一张牌」是**旁观者**的技能，收不到前者。
   */
  | 'anyShanUsed'
  /**
   * **一张「伤害牌」使用完、整个结算结束时**（派给**所有存活角色**，
   * payload: { card, userSeatId }）。
   *
   * 君袁绍·授锋挂这里（「当一名角色于其出牌阶段使用首张伤害牌结算结束后」）。
   * 「首张」由引擎判定：一本账记着**本回合出牌阶段**用掉的第一张伤害牌
   * （`GameState.firstDamageCard`，见 markCardUsed），只有它的结算结束才派发这个时机
   * （账本上打 `resolved` 标记，同一张牌在重跑路径上不会派发两次）。
   * 派发点有两个：锦囊走 `endTrickResolution`、【杀】走 `afterAttackSettledTail`。
   */
  | 'cardResolved'
  /**
   * **一个势力的角色数从 0 变成别的数（或反过来）时**（派给**所有存活角色**，
   * payload: { faction, from, to }）。
   *
   * 君袁绍·会盟挂这里。计数口径＝**已确定势力**（明置）的存活角色数，与 effectiveFaction
   * 同一口径：未确定势力的角色不属于任何势力。派发点：明置（revealHeroCard）与阵亡（doDeath）。
   * ⚠️ 待核对：WIKI 与官方公告都没写这个「角色数」按明置算还是按武将牌本身的势力算
   *    （后者是胜负/鏖战的口径），本实现按前者，理由见 docs/guozhan-roster.md §5.60。
   */
  | 'factionCountChanged'
  /**
   * **一张锦囊的目标定下来了**（派给**所有存活角色**，
   * payload: { card, targetIds, trickCtx }）。
   *
   * 君孙权·据江挂这里（「与你势力相同的角色指定你为目标的非伤害牌额外结算一次」）。
   * 与 `othersBecomeTarget` 的区别：那个只在「**唯一**目标」时派发（于吉·千幻要用它取消牌），
   * 而据江要看所有目标，多目标的锦囊（五谷/桃园/联军）也得能观察到。
   * 「额外结算一次」：技能在钩子里把 `trickCtx.extraResolve` 置位（+`rerunSkill` 供日志），
   * `endTrickResolution` 走到出口时把同一张牌再走一遍。
   */
  | 'trickTargeted';

/**
 * 回复体力后的载荷。
 * `amount` 是**实际**回复量（受体力上限夹取后的值）——所以满体力时不触发钩子，
 * 「回复 2 点但只差 1 点」时 amount 是 1。
 *
 * `taoSaverId` 只在**濒死求桃**那条路上有值：用【桃】把你救回来的那个**别人**是谁。
 * 法正·恩怨①「当其他角色对你使用【桃】时，其摸一张牌」靠它判断——
 * 【桃】平时只能对自己用，所以「别人对你用桃」只可能发生在你濒死时。
 */
export interface HealPayload {
  amount: number;
  taoSaverId?: string;
}

/**
 * 失去装备区里一张牌的载荷。
 *
 * `eventId` / `cards` 描述**同一次动作**：像甘露（交换装备区）、水淹七军（弃置装备区所有牌）、
 * 贯石斧（一次弃两张）这种「一个动作丢多张」的情况，逐张派发时**共用一个 eventId**、
 * `cards` 是这一批的全部牌。为什么要给：凌统·旋略官方口径是「一次失去只触发一次」，
 * 而孙尚香·枭姬是**每张**都触发——有了 eventId，两种口径可以各按各的来（旋略按 id 去重）。
 * 单张失去也会带一个全新的 eventId。
 */
export interface EquipLostPayload {
  card: Card;
  /** 同一次失去动作里的全部装备牌（单张时就是 [card]） */
  cards?: Card[];
  /** 同一次失去动作的编号（单调递增；同一次动作内的各张牌相同） */
  eventId?: number;
}

/**
 * 一张牌**为什么**换主人——牌移动的动作语义。
 *
 * 目前只落地了需要区分行为的两类（`transferCard` = gain / `giveCard` = give，
 * 差别在国战【空城】第二段只拦「交给」）；`steal` / `draw` / `distribute` 先占位，
 * 等 #9（统一的 CardMove）铺开时再给它们各自的落点规则。
 */
export type CardMoveReason = 'gain' | 'give' | 'steal' | 'draw' | 'distribute';

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
  /**
   * 某人当前的**手牌上限**（含体力、技能与「本回合 +N」的修正）。
   * 吕范·典财要把手牌摸至体力上限，用它算差多少张。
   */
  handLimit: (seatId: string) => number;
  /** 失去体力（不是伤害：没有来源、不触发卖血技，但会进濒死）。`after` 同上。 */
  loseHp: (target: Player, amount: number, after?: () => void) => void;
  /**
   * 把一张**装备区**里的牌移出并触发「失去装备区的牌」（equipLost，含枭姬/旋略/白银狮子等）。
   * 用于技能把装备移去非手牌的去处（于吉·千幻：置于武将牌上）——
   * 直接清槽位不会触发失去装备那套联动。
   */
  loseEquip: (seatId: string, card: Card, after?: () => void) => void;
  /**
   * **直接死亡**（不进濒死救援：不是失去体力、也不是受到伤害）。
   * 目前只有公孙渊·【恣睢】用：「若你的『异』数大于体力上限，你死亡」。
   */
  kill: (seatId: string, reason?: string) => void;
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
   * 一次**选多名角色**（多选座位原语）：候选、至多/至少几个，回答给选中的座位 id 列表。
   * 给「至多 X 名（不同）角色」那类技能用（怀异…）——比「逐个问 + 可提前结束」更贴近规则。
   */
  askPickSeats: (
    state: GameState,
    seatId: string,
    title: string,
    candidates: string[],
    min: number,
    max: number,
    resolve: (state: GameState, player: Player, picked: string[]) => void,
    opts?: { returnTo?: string },
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
   * 走一次**技能判定**（雷击 / 铁骑 / 刚烈 / 屯田 / 潜袭 / 悲歌 / 恪守…）。
   *
   * 官方：**所有**判定都要经过「判定牌生效前」这个时机——鬼才（司马懿）与鬼道（张角）都能
   * 打出手牌替换判定牌，天妒（郭嘉）也能收走**自己**的判定牌。以前这些技能各自 `drawOne`
   * 就完事，于是改判系技能对它们一律无效（roster 里把这条记成了简化）。
   *
   * `onDone(最终判定牌 | null)`：牌的去向已经处理好（没人收走就进弃牌堆，天妒收走就给天妒），
   * 技能直接读这张牌的花色/点数即可。牌堆耗尽时给 null。
   */
  judge: (
    skillName: string,
    onDone: (card: Card | null, canTake: boolean) => void,
    opts?: {
      /** 判定者（默认是技能使用者）。雷击/悲歌是**别人**判定（雷击指定的人 / 受伤者）。 */
      judgeSeatId?: string;
      /**
       * 这张判定牌由调用方自己安置（邓艾·屯田要把它当「田」收到武将牌上）。
       * 但**天妒**可能先把它收走了——那时代码拿到 `canTake = false`，不能再用这张牌。
       */
      keepCard?: boolean;
    },
  ) => void;
  /**
   * 改写本次拼点里**你那张牌**的点数。**只能在 `pindianRevealed` 的钩子里调用**。
   *
   * 与 replaceJudgeCard 同一套路：钩子常常要先问玩家（+3 还是 -3），那时拿不到返回值，
   * 所以在询问回调里调本函数，引擎接着按新点数比大小。不在拼点流程里调用没有效果。
   */
  setPindianRank: (rank: number) => void;
  /**
   * 把某人的一张牌（手牌或装备区）转给另一个人——**「获得」语义**（拿走/夺得/收缴）。
   * 拿走装备会触发「失去装备」的技能（枭姬那类），after 在所有结算完成后调用。
   * 反馈 / 突袭 / 顺手牵羊那类「获得他人一张牌」都该走这里，别自己 splice。
   */
  transferCard: (fromSeatId: string, card: Card, toSeatId: string, after?: () => void) => void;
  /**
   * 把某人的一张牌**交给**另一个人——**「交给」语义**（自愿给出的那种，文本里写「交给」的操作）。
   *
   * 与 `transferCard` 的搬运机制完全相同，区别只在这个语义：国战【空城】第二段
   * （「其他角色于你的回合外交给你牌时，改为把这些牌置于你的武将牌上」）**只拦「交给」**——
   * 摸牌/五谷丰登/获得他人牌（顺手牵羊、突袭…）都照常进手牌，不能靠它们把空城破掉。
   *
   * ⚠️ 技能文本里写「交给」的一律走这里（仁德/遗计/反间/恩怨/好施…），别自己 hand.push。
   *    这是 `docs/guozhan-roster.md` 里 #9「统一的牌移动语义」的第一块落地。
   */
  giveCard: (fromSeatId: string, card: Card, toSeatId: string, after?: () => void) => void;
  /**
   * 令某人**视为使用一张锦囊**（虚拟牌）——走**正常的锦囊流程**：开无懈窗口、派
   * `trickTargeted` / `othersBecomeTarget` 钩子、按正常路径结算与收尾。
   *
   * 为什么必须有这个口子（而不是在 heroes 里手搓一个 `respondTrick` 假 pending）：
   * 「视为使用一张锦囊」出来的东西**本身就是一张锦囊**——它要能被无懈、能被「成为目标时」
   * 的技能响应。手搓的假 pending 会把这些**全部绕过去**。
   *
   * 目前的使用者：貂蝉·离间（生成那张【决斗】，用户 2026-09-21 口径）。
   * `sourceSeatId` 是**视为使用这张牌的人**（不一定是技能的拥有者）。
   */
  useVirtualTrick: (
    sourceSeatId: string,
    card: Card,
    targetIds: string[],
    /** 结算完把控制权还给谁（缺省＝`sourceSeatId`）；离间要还给出牌阶段的貂蝉 */
    resumeSeatId?: string,
  ) => void;
  /**
   * 让某人弃置自己的一张牌（手牌或装备区）。失去装备会触发那类技能。
   * after 在结算完成后调用。
   */
  discardCard: (
    ownerSeatId: string,
    card: Card,
    after?: () => void,
    /** **执行弃置动作**的人（不填＝牌主自己）。「A 弃 B 的牌」时传 A（苏飞·联翩要用） */
    actorSeatId?: string,
  ) => void;
  /**
   * 让某人**一次**弃置多张牌（悲歌梅花那类）。与连续调 discardCard 的区别：
   * 这是**一个动作**，里面的装备牌算同一次「失去装备」事件（旋略只触发一次）。
   */
  discardCards: (
    ownerSeatId: string,
    cards: Card[],
    after?: () => void,
    /** **执行弃置动作**的人（不填＝牌主自己）；见 discardCard 的说明 */
    actorSeatId?: string,
  ) => void;
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
   * 把控制权还给某人的**出牌阶段**——**只在技能自己的链条收尾时用**。
   *
   * 为什么需要它：一串询问的「还控制权」原本是靠**最后一次询问的 returnTo** 兜的
   * （见 askChoice 的 returnTo 说明）。但如果链条的某一步里**嵌套**了别人的询问
   * （典型：吕范·调度把装备移给队友 → 触发枭姬的「是否摸两张」），那次嵌套询问结束之后
   * 控制权就没人还了——`pending` 停在 null、整局静默卡死（模糊测试抓到的）。
   * 所以链条自己在收尾处补一句：`if (state.pending === null) api.returnPlayPhase(seat)`。
   *
   * 引擎侧做两件事：没有 pending 时才生效（有询问在挂起就别抢），然后 resumePlay。
   */
  returnPlayPhase: (seatId: string) => void;
  /**
   * 把**刚进弃牌堆**的几张牌交给某个角色（孔融·礼让）。
   * 按 id 从弃牌堆里取出来塞进目标手牌；找不到的（已经被别人拿走了）跳过。
   */
  /**
   * 把刚进弃牌堆的牌交给某人（孔融·礼让 / 小乔·天香）。skillName 只影响日志文案。
   * `reason` 填 'give' 表示这是文本里的「交给」（礼让），要受国战【空城】第二段管辖；
   * 不填＝获得（天香那种「令其获得之」）。
   */
  giveDiscardedTo: (
    cards: Card[],
    targetSeatId: string,
    skillName?: string,
    reason?: CardMoveReason,
  ) => void;
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
    spec: {
      type: TrickType;
      suit: Suit;
      rank?: number;
      /**
       * 这张虚拟牌是用哪些**实体牌**凑出来的（吴景·调归：把一张装备牌当【调虎离山】）。
       * 引擎把它挂到虚拟牌的 `materials` 上——「获得此牌」那类效果按它找实体牌
       * （见 engine 里 `damageCardIds` 的注释：虚拟牌本身在任何区域都找不到）。
       */
      materials?: Card[];
    },
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
   * **令某人明置一张武将牌**（阵法召唤用：召唤是**召唤者发起、响应者亮将**，
   * 与「自己发起明置」那条 `revealHero` 意图不是一回事）。
   *
   * 与「发动技能顺带明置」走同一个入口（`engine.revealHeroCard`），所以势力确定、
   * 珠联璧合/会盟那类明置时机照常派发；被【祸水】【建安】挡着时返回 false。
   */
  revealHeroCard: (seatId: string, heroId: string) => boolean;
  /**
   * 授予技能，**只到本回合结束**（孙策·魂殇「本回合拥有英姿和英魂」、
   * 法正·眩惑「获得武圣等之一直到回合结束」）。回合结束时自动清掉。
   */
  grantTempSkill: (heroId: string, skillName: string, toSeatId?: string) => void;
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
   * 令**多名**角色依次决定是否执行**同一条**军令（王平·将略）。
   *
   * 与 `armyOrder` 的区别只有「问几个人」：发起者照样先从随机两张里挑一条，
   * 然后名单上的每个人各自决定执行/不执行，执行的各算各的效果（依次结算完再问下一个）。
   * `onDone(state, executedSeatIds)` 在整条链走完后回调，`executedSeatIds` 是**真正执行了**
   * 的人（拒绝的、中途阵亡的都不在里面）——将略要按它算「因此回复体力的角色数」。
   */
  armyOrderMulti: (
    initiatorSeatId: string,
    executorSeatIds: string[],
    onDone: (state: GameState, executedSeatIds: string[]) => void,
    opts?: {
      /** 拒绝执行时的额外结算（诸葛恪·黩武）；不填＝公共规则（什么都不发生） */
      onRefuse?: (st: GameState, executorSeatId: string, next: () => void) => void;
    },
  ) => void;
  /**
   * 视为使用一张【杀】（夏侯渊·神速那类）。调用方先把代价付掉。
   *
   * 与 castVirtualTrick 对应——那边是锦囊，这边是【杀】。
   * 走的是和实体【杀】完全一样的结算（防具、八卦阵、流离、等出闪），
   * 只是没有实体牌（也不会进任何牌堆）。
   */
  castVirtualSha: (
    sourceSeatId: string,
    targetId: string,
    opts?: {
      logKind?: string;
      attribute?: DamageAttribute;
      /** 纯虚拟牌的来源标记（黄祖·袭射的杀 = `'xishe'`；用于因果链判断） */
      generatedBy?: string;
      /** 目标级「不能响应」判定（黄祖·袭射：目标体力值 < 黄祖时不能出闪） */
      unrespondableTo?: (st: GameState, target: Player) => boolean;
      /**
       * 这张【杀】**整个结算完**（含求闪、伤害、濒死/阵亡）之后要做的事。
       * 有它才能把「一个人一个人接着问」的链推下去（【号令天下】的①）。
       */
      after?: () => void;
      /**
       * 是否**计入出杀次数**（默认不计，与神速那类「视为使用」一致）。
       * 【号令天下】的口径是「受次数限制且计入次数」——它自己先查 `canUseAnotherSha`，
       * 再叫这里带上 `countTowardLimit: true`。
       */
      countTowardLimit?: boolean;
      /**
       * 这张【杀】的**基础伤害**（默认 1）。蜀【克复中原】的「蜀势力角色的【杀】基础伤害 +1」
       * 用它（不改实体牌，只改这一次使用的基础值）。
       */
      damage?: number;
    },
  ) => void;
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
   * **变更副将**（变包）：从未加入游戏的武将牌堆里连续亮将，直到亮出与主将势力相同者，
   * 用它替换现有副将（新副将暗置、体力上限按新的两张牌重算）。马谡·制蛮、荀攸·奇策、
   * 吕范、左慈都用它。
   */
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
  /**
   * 变更副将（从**未加入游戏的武将牌堆**里连续亮将，直到亮出与主将势力相同者）。
   * `opts.preferred`：先按这个顺序在这些**尚未登场**的牌里找（徐庶·荐才「非唯一大势力时
   * 可以优先从已获知的武将里选」）——仍然要求与主将势力相同，不是凭空造牌。
   * ⚠️ 变更**不会**改变已经确定的体力上限（官方「变更」规则）。
   */
  changeDeputyHero: (seatId: string, opts?: { preferred?: string[] }) => void;
  useShaOn: (
    sourceSeatId: string,
    targetId: string,
    card: Card,
    opts?: {
      logKind?: string;
      /** 这次【杀】结算**无视目标防具**（徐庶·诛害的强化分支） */
      ignoreArmor?: boolean;
      /** 记录「这次结算由哪个技能发起」（技能侧据此认领这一次使用，如诛害的「闪后弃牌」） */
      skillId?: string;
      /**
       * 【丈八蛇矛】式用法：除 `card` 之外**再垫一张**手牌，两张一起当【杀】用
       * （生效的是一张虚拟【杀】；诛害要允许「两张牌转化出的杀」，官方口径明确过）。
       */
      extraCardIds?: string[];
      /**
       * **多目标形态**：一次对多名角色使用这张【杀】（夏侯霸·豹烈①那种「合法时可以多目标」）。
       * 给了就**不再用** `targetId`，改走引擎的多目标结算（逐目标结算队列），
       * 且**不再支持 `after`**（多目标的收尾请挂 `attackSettled`）。
       */
      targetIds?: string[];
      /** 这张【杀】**整个结算完**（含出闪/伤害/濒死）之后接着做的事 */
      after?: () => void;
    },
  ) => void;
  /**
   * 弃置某名角色区域里的一张牌（明牌按 id 指定；没指定或指定的是手牌时**随机**抽一张）。
   * 姜维·挑衅的「你弃置其一张牌」用它——手牌是不可见的，想拿哪张只能随机。
   */
  discardTargetCard: (targetSeatId: string, cardId?: string, after?: () => void) => void;
  /**
   * 交换两名角色**装备区里的牌**（吴国太·甘露）。
   *
   * 先把两边装备区的牌都收下来、各自触发「失去装备区里的牌」（枭姬、白银狮子回血…），
   * 再互换着放进对应栏位——所以中途**不会有牌被顶进弃牌堆**（甘露是交换，不是覆盖）。
   * `after` 在整条链（含可能挂起的失去装备钩子）走完后调用。
   */
  swapEquipAreas: (seatA: string, seatB: string, after?: () => void) => void;
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
  /**
   * **声明式触发条件**：「这个时机 + 这个 payload 下，我这次要不要发动？」
   *
   * 存在的唯一目的：让引擎在**派发之前**就知道「本次会发动的技能清单」，
   * 从而支持官方那条口径——「同一时机、同一层内由该角色**自己决定次序**」（见 docs §5.137.3）。
   * 没有它，引擎只知道「这个时机注册了几个钩子」，而钩子模型是「注册即触发、要不要发动由
   * handler 自己决定」——按注册数去问，等于在**每一处有两个钩子注册的时机**都插一问
   * （上一版就是这么失败的：19 条用例变红 + 冒烟 40 局卡在 5000 步，见 §5.137.4）。
   *
   * ⚠️ 写法要求：
   * - **纯条件判断**：不写状态、不发起询问、不改牌——它只是 handler 开头那几行守卫的「声明版」；
   * - 返回 true 的含义是「handler 这次会去问 / 会结算」，**不是**「玩家一定会同意」；
   * - 与 handler 里的守卫**必须同步**：两边判断不一致时，次序询问会把不发的技能列进去
   *   （或者漏掉真会发的），这正是这个字段唯一的坑。
   * - **锁定技也要填**：`locked` 只表示「玩家不能选择不发动」，触发条件照样要判；
   * - 不填 = 引擎对该钩子**无法预判** → 该时机的次序退回按 `priority` 固定排（不会出错，只是非自选）。
   */
  applies?: (ctx: HookContext) => boolean;
}
