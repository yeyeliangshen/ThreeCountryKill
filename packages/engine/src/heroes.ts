import {
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
  DamageAttribute,
  Faction,
  GameMode,
  Intent,
  RoleId,
} from '@sgs/protocol';
import type { HookContext, HookRegistration, SkillApi, Timing } from './timing';
import type { AttackContext, GameState, Player } from './model';
import { drawOne } from './deck';
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
  /** 限 1 次/回合 */
  oncePerTurn?: boolean;
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
   * 国战君主将。已实现的官方君主特性：只能作主将、不会成为野心家、
   * 亮将时主副将同时亮出、与同势力所有其他武将构成珠联璧合。
   *
   * 未实现：君主势力技（护驾/激将/黄天）、「君威」与专属装备、
   * 阵亡时令同势力角色各失去 1 点体力。见 docs/guozhan-reference.md §3.1。
   */
  isLord?: boolean;
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
   */
  canRevealInPlayPhase?: boolean;
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
  | 'extraDraw'
  | 'handLimit'
  | 'cannotBeTargetOf'
  | 'blocksExternalSaves'
  | 'ignoresTrickDistance'
  | 'rescueHealBonusFromFaction'
  | 'dealtDamageBonus'
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
  | 'canRevealInPlayPhase';

const ALL_FIELD_SKILLS: FieldSkill[] = [
  'canUseAs',
  'shaLimit',
  'distanceFrom',
  'extraDraw',
  'handLimit',
  'cannotBeTargetOf',
  'blocksExternalSaves',
  'ignoresTrickDistance',
  'rescueHealBonusFromFaction',
  'dealtDamageBonus',
  'factionCall',
  'duelShaRequired',
  'hasBaguaAlways',
  'immuneToNanman',
  'nanmanDamageSource',
  'shaExtraTargetAtRange1',
  'reduceDamageFromHiddenSource',
  'blocksOthersReveal',
  'canRevealInPlayPhase',
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
  skills: [{ name: '咆哮', desc: '出牌阶段，你可以使用任意数量的【杀】。' }],
  // 国战（新国战）：咆哮追加「出牌阶段使用了第二张【杀】后，摸一张牌」
  guozhan: {
    hooks: [
      {
        timing: 'useCard',
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
  // 铁骑：使用【杀】指定目标后，翻判定牌→红色则不可闪避
  hooks: [
    {
      timing: 'useCard',
      skillId: '铁骑',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext } | undefined;
        if (payload?.attack?.asType !== 'sha') return;
        const judgeCard = drawOne(ctx.state);
        if (!judgeCard) return;
        pushLog(
          ctx.state,
          'skill',
          `${ctx.player.name} 发动【铁骑】，判定牌：${cardLabel(judgeCard)}。`,
        );
        toDiscard(ctx.state, judgeCard);
        if (isRed(judgeCard)) {
          payload.attack.requiredShan = Infinity;
          pushLog(ctx.state, 'skill', `判定为红色，此【杀】不可闪避！`);
        }
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
    if (isRed(j)) {
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
                removeCard(p2.hand, card.id);
                toDiscard(st2, card);
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
        const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
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
        const judgeCard = drawOne(ctx.state);
        if (!judgeCard) return;
        pushLog(
          ctx.state,
          'skill',
          `${ctx.player.name} 发动【刚烈】，判定牌：${cardLabel(judgeCard)}。`,
        );
        toDiscard(ctx.state, judgeCard);
        if (judgeCard.suit === 'heart') {
          pushLog(ctx.state, 'skill', '判定为红桃，【刚烈】无效。');
          return;
        }
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
  isLord: true,
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
  // 集智：使用一张非延时类锦囊牌时，摸一张牌
  hooks: [
    {
      timing: 'useCard',
      skillId: '集智',
      handler: (ctx) => {
        const payload = ctx.payload as { card?: Card } | undefined;
        const card = payload?.card;
        if (!card || !isInstantTrick(card)) return;
        const c = drawOne(ctx.state);
        if (!c) return;
        ctx.player.hand.push(c);
        pushLog(ctx.state, 'skill', `${ctx.player.name} 发动【集智】，摸了 1 张牌。`);
      },
    },
  ],
  skills: [
    { name: '集智', desc: '当你使用一张非延时类锦囊牌时，你可以摸一张牌。' },
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
  api.askPickCards(
    state,
    player.seatId,
    `【观星】：观看牌堆顶 ${top.length} 张，选择要置于牌堆底的牌（其余按原序留在牌堆顶）`,
    top,
    0,
    top.length,
    (st, p, picked) => {
      const toBottom = new Set(picked.map((c) => c.id));
      const stay = top.filter((c) => !toBottom.has(c.id));
      const sink = top.filter((c) => toBottom.has(c.id));
      for (let i = stay.length - 1; i >= 0; i--) st.deck.push(stay[i]!);
      st.deck.unshift(...sink);
      pushLog(
        st,
        'skill',
        `${p.name} 发动【观星】：${stay.length} 张留在牌堆顶，${sink.length} 张置于牌堆底。`,
      );
    },
    // 看牌堆顶是私密信息：日志只记张数，不记牌名
    { secret: true },
  );
}

/**
 * 突袭：让张辽依次挑「至多两名其他角色」，然后各拿他们一张手牌。
 *
 * 分两步而不是一步：先定人再拿牌（拿牌要一张张问，因为要看对方手牌）。
 * 选人阶段给一个「不再选人」的选项——官方是「至多两名」，只选一个也合法。
 */
function tuxiAskTargets(state: GameState, player: Player, picked: string[], api: SkillApi): void {
  const candidates = state.players.filter(
    (p) => p.alive && p.seatId !== player.seatId && p.hand.length > 0 && !picked.includes(p.seatId),
  );
  if (picked.length >= 2 || candidates.length === 0) {
    tuxiTakeCards(state, player, picked, 0, api);
    return;
  }
  const options = candidates.map((p) => ({ id: p.seatId, label: p.name }));
  if (picked.length >= 1) options.push({ id: '__stop', label: '不再选人' });
  api.askChoice(
    state,
    player.seatId,
    `【突袭】：选择要拿谁的一张手牌（已选 ${picked.length} 人，至多 2 人）`,
    options,
    (st, p, id) => {
      if (id === '__stop') {
        tuxiTakeCards(st, p, picked, 0, api);
        return;
      }
      tuxiAskTargets(st, p, [...picked, id], api);
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
): void {
  if (i >= targets.length) {
    pushLog(
      state,
      'skill',
      `${player.name} 发动【突袭】，获得 ${targets.length} 名角色的各一张手牌。`,
    );
    return;
  }
  const t = getPlayer(state, targets[i]!);
  if (!t || !t.alive || t.hand.length === 0) {
    tuxiTakeCards(state, player, targets, i + 1, api);
    return;
  }
  api.askPickCards(
    state,
    player.seatId,
    `【突袭】：选择获得 ${t.name} 的一张手牌`,
    t.hand.slice(),
    1,
    1,
    (st, p, chosen) => {
      const c = chosen[0];
      if (c) api.transferCard(t.seatId, c, p.seatId);
      tuxiTakeCards(st, p, targets, i + 1, api);
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

const WEIYAN: Hero = {
  id: 'weiyan',
  name: '魏延',
  faction: 'shu',
  maxHp: 4,
  gender: 'male',
  combos: ['huangzhong'], // 黄忠 ❤ 魏延
  // 狂骨：对距离 1 以内的角色造成伤害后，回复 1 点体力
  hooks: [
    {
      // 注意是 afterDamageDealt（派给伤害来源），不是 afterDamage（那是派给受伤者的）
      timing: 'afterDamageDealt',
      skillId: '狂骨',
      locked: true, // 狂骨是锁定技
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
        const attack = payload?.attack;
        if (!attack || !payload?.damage) return;
        if (attack.sourceId !== ctx.player.seatId) return;
        if (attack.targetId === ctx.player.seatId) return;
        if (distance(ctx.state, ctx.player.seatId, attack.targetId) > 1) return;
        if (ctx.player.hp >= ctx.player.maxHp) return;
        const healed = ctx.api.heal(ctx.player, 1);
        pushLog(ctx.state, 'skill', `${ctx.player.name} 发动【狂骨】，回复 ${healed} 点体力。`);
      },
    },
  ],
  skills: [
    {
      name: '狂骨',
      desc: '锁定技，当你对距离 1 以内的角色造成伤害后，你回复 1 点体力。（简化：官方为「回复1点体力或摸一张牌」二选一）',
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
  skills: [
    { name: '帷幕', desc: '锁定技，你不能成为黑色锦囊牌的目标。' },
    {
      name: '完杀',
      desc: '锁定技，你的回合内，除你以外，只有处于濒死状态的角色才能使用【桃】。',
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
  isLord: true,
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
        if (!payload?.damage) return;
        const others = ctx.state.players.filter((p) => p.alive);
        if (others.length === 0) return;
        ctx.api.askChoice(
          ctx.state,
          ctx.player.seatId,
          '是否发动【节命】？',
          [
            { id: 'yes', label: '发动（令一名角色把牌补到体力上限）' },
            { id: 'no', label: '不发动' },
          ],
          (st, p, picked) => {
            if (picked !== 'yes') return;
            ctx.api.askChoice(
              st,
              p.seatId,
              '【节命】：选择要让谁补牌',
              st.players.filter((x) => x.alive).map((x) => ({ id: x.seatId, label: x.name })),
              (st2, _p2, whoId) => {
                const who = getPlayer(st2, whoId);
                if (!who) return;
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
              },
            );
          },
        );
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
  // 巨象：锁定技，【南蛮入侵】对你无效。
  // 「若其他角色使用的【南蛮入侵】结算后置入弃牌堆，你获得之」这一半暂未实现——
  // 需要在南蛮结算完把那张牌捞出来给她。
  immuneToNanman: true,
  lockedFields: ['immuneToNanman'],
  skillFields: { 巨象: ['immuneToNanman'] },
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
      desc: '锁定技，【南蛮入侵】对你无效。（「其他角色使用的南蛮结算后你获得之」尚未实现）',
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
      desc: '当你受到伤害后，你可以摸两张牌，然后可以将摸到的牌交给一名其他角色。（官方为「受到1点伤害后」逐点触发，本实现每次伤害事件触发一次）',
    },
  ],
};

const DONGZHAO: Hero = {
  id: 'dongzhao',
  name: '董昭',
  faction: 'wei',
  // 国战牌上印的是 **1.5 阴阳鱼**，而引擎吃的是身份局口径的体力值：
  // 阴阳鱼数 = 身份局体力 ÷ 2，所以这里要填 3（半天前填成 1.5 是错的）。
  // 校验：董昭(3) + 许褚(4) → floor(3.5) = 3，与官方「1.5+2 阴阳鱼 → 上限 3」一致。
  maxHp: 3,
  gender: 'male',
  modes: ['guozhan'], // 不臣篇是国战专属
  // 劝进：把一张手牌交给一名**本回合受到过伤害**的角色，令其执行一次军令。
  activeSkills: [
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
          (p) => p.alive && p.seatId !== player.seatId && state.damagedThisTurn.includes(p.seatId),
        ),
      execute: (state, player, intent, api) => {
        const ids = intent.cardIds ?? [];
        if (ids.length !== 1) return '请选择要交给对方的一张手牌';
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名本回合受到过伤害的角色';
        if (targetId === player.seatId) return '不能选择自己';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        if (!state.damagedThisTurn.includes(targetId)) return '该角色本回合没有受到过伤害';
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
      desc: '尚未实现：需要「本回合计算与其的距离视为 1」的距离覆盖机制。',
    },
  ],
};

const JIANGWEI: Hero = {
  id: 'jiangwei',
  name: '姜维',
  faction: 'shu',
  maxHp: 4,
  gender: 'male',
  // 挑衅：出牌阶段限一次，令一名其他角色对你使用一张【杀】，否则你弃置其一张牌。
  // 未实现——要接「令目标决定是否对我出杀」这条链（可以照离间/借刀的做法）。
  //
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
      desc: '尚未实现：需要「令目标决定是否对你使用【杀】」这条链。',
    },
  ],
};

const LIUSHAN: Hero = {
  id: 'liushan',
  name: '刘禅',
  faction: 'shu',
  maxHp: 4,
  gender: 'male',
  // 享乐：锁定技，当你成为【杀】的目标时，使用者需弃置一张基本牌，否则此【杀】对你无效。
  // 未实现——需要「成为目标时令使用者响应」，等 target_transfer 那批一起做。
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
      desc: '锁定技，当你成为【杀】的目标时，使用者需弃置一张基本牌，否则此【杀】对你无效。（尚未实现）',
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
            const card = pool2[Math.floor(Math.random() * pool2.length)]!;
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
                const judgeCard = drawOne(st2);
                if (!judgeCard) return;
                pushLog(
                  st2,
                  'skill',
                  `${me.name} 发动【悲歌】，判定牌：${cardLabel(judgeCard)}。`,
                  { seat: me.seatId, action: 'skill' },
                );
                toDiscard(st2, judgeCard);
                const source = attack.sourceId ? getPlayer(st2, attack.sourceId) : undefined;
                switch (judgeCard.suit) {
                  case 'heart': {
                    const healed = ctx.api.heal(victim, 1);
                    pushLog(st2, 'skill', `【悲歌】红桃：${victim.name} 回复 ${healed} 点体力。`);
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
                    // 伤害来源弃置两张牌（手牌随机，与仓库口径一致）
                    if (!source) break;
                    for (let i = 0; i < 2; i++) {
                      const pool2 = [
                        ...source.hand,
                        ...(EQUIP_SLOTS.map((slot) => source.equipment[slot]).filter(
                          Boolean,
                        ) as Card[]),
                      ];
                      if (pool2.length === 0) break;
                      ctx.api.discardCard(
                        source.seatId,
                        pool2[Math.floor(Math.random() * pool2.length)]!,
                      );
                    }
                    pushLog(st2, 'skill', `【悲歌】梅花：${source?.name ?? '来源'} 弃置两张牌。`);
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
                  if (i >= 0) st2.discard.splice(i, 1);
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
                const card = pool[Math.floor(Math.random() * pool.length)]!;
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
                const judgeCard = drawOne(st2);
                if (!judgeCard) return;
                toDiscard(st2, judgeCard);
                pushLog(
                  st2,
                  'skill',
                  `${me.name} 发动【雷击】，${target.name} 判定：${cardLabel(judgeCard)}。`,
                  { seat: me.seatId, action: 'skill' },
                );
                if (judgeCard.suit !== 'spade') {
                  pushLog(st2, 'skill', `判定不是黑桃，【雷击】无效。`);
                  return;
                }
                ctx.api.dealDamage(target, 2, me.seatId, 'thunder');
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
                removeCard(p2.hand, card.id);
                toDiscard(st2, card);
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

export const HEROES: Hero[] = [
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
  return HEROES.filter((h) => !h.modes || h.modes.includes(mode));
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
export function effectiveFaction(state: GameState, player: Player): Faction | null {
  if (state.mode !== 'guozhan') return player.faction;
  return player.heroRevealed || player.deputyRevealed ? player.faction : null;
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
    if (!p.alive || !p.faction || p.faction === 'ambitionist') continue;
    counts.set(p.faction, (counts.get(p.faction) ?? 0) + 1);
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
  for (const g of p.grantedSkills ?? []) {
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
  // 蔡文姬·断肠：被点名的那张武将牌**技能全失**（势力/性别照旧，所以它还在
  // selectable 的名单里、只是没有技能）。暗置时被点名也照样算——将来明置也不会有技能。
  if (p.nullifiedHeroId) heroes = heroes.filter((h) => h.id !== p.nullifiedHeroId);
  if (!p.flags.nonLockedSkillsDisabled) return heroes;
  return heroes.map(nullifyHero);
}

/** 取武将每回合杀数上限，缺省 1 */
export function heroShaLimit(hero: Hero): number {
  return hero.shaLimit?.() ?? 1;
}

/** 取武将可否把 card 当 type 用 */
export function heroCanUseAs(
  hero: Hero,
  card: Card,
  type: CardType,
  state?: GameState,
  player?: Player,
): boolean {
  return hero.canUseAs?.(card, type, state, player) ?? false;
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
  return isSmallFaction(state, effectiveFaction(state, player));
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
export function heroIgnoresTrickDistance(heroes: Hero[]): boolean {
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
