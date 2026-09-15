import { cardLabel, isRed } from '@sgs/protocol';
import type { Card, CardType, DamageAttribute, Faction, GameMode, Intent, RoleId } from '@sgs/protocol';
import type { HookRegistration, Timing } from './timing';
import type { AttackContext, GameState, Player } from './model';
import { drawOne } from './deck';
import { attackRange } from './distance';
import { getPlayer, pushLog } from './model';

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

/** 引擎内部 API（由 engine.ts 注入，避免 heroes→engine 循环依赖） */
export interface SkillApi {
  /** 造成伤害（触发伤害钩子 + 濒死检查 + 恢复出牌） */
  dealDamage: (target: Player, damage: number, sourceId: string, attribute?: DamageAttribute) => void;
  /** 失去体力（不触发伤害钩子，但触发濒死检查） */
  loseHp: (target: Player, amount: number) => void;
  /**
   * 让某个角色在若干选项里选一个（通用「选择一项」）。
   * 由 engine 注入——heroes 不能反向 import engine，所以走这里。
   */
  askChoice: (
    state: GameState,
    seatId: string,
    title: string,
    options: { id: string; label: string }[],
    resolve: (state: GameState, player: Player, optionId: string) => void,
  ) => void;
}

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
  canUseAs?: (card: Card, type: CardType) => boolean;
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
  /** 珠联璧合：与另一武将搭配时获得加成 */
  combo?: { with: string; bonus: 'hp' | 'skill' };
  /** UI 展示用技能描述（身份局/军争版本） */
  skills: { name: string; desc: string }[];
  /** 国战版本的技能覆盖，见文件顶部说明 */
  guozhan?: HeroVariant;
}

const GUANYU: Hero = {
  id: 'guanyu',
  name: '关羽',
  faction: 'shu',
  maxHp: 4,
  gender: 'male',
  canUseAs: (card, type) => type === 'sha' && isRed(card),
  combo: { with: 'zhangfei', bonus: 'hp' },
  skills: [{ name: '武圣', desc: '你可以将一张红色牌当【杀】使用或打出。' }],
};

const ZHANGFEI: Hero = {
  id: 'zhangfei',
  name: '张飞',
  faction: 'shu',
  maxHp: 4,
  gender: 'male',
  shaLimit: () => Infinity,
  combo: { with: 'guanyu', bonus: 'hp' },
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
    (type === 'sha' && card.type === 'shan') ||
    (type === 'shan' && card.type === 'sha'),
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
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext } | undefined;
        if (payload?.attack?.asType !== 'sha') return;
        const judgeCard = drawOne(ctx.state);
        if (!judgeCard) return;
        pushLog(ctx.state, 'skill', `${ctx.player.name} 发动【铁骑】，判定牌：${cardLabel(judgeCard)}。`);
        ctx.state.discard.push(judgeCard);
        if (isRed(judgeCard)) {
          payload.attack.requiredShan = Infinity;
          pushLog(ctx.state, 'skill', `判定为红色，此【杀】不可闪避！`);
        }
      },
    },
  ],
  // 马术：锁定技，计算与其他角色的距离 -1（distance() 读这个字段）
  distanceFrom: 1,
  skills: [
    { name: '马术', desc: '锁定技，你计算与其他角色的距离-1。' },
    { name: '铁骑', desc: '当你使用【杀】指定目标后，你可以进行判定：若为红色，此【杀】不可被闪避。' },
  ],
};

const HUANGZHONG: Hero = {
  id: 'huangzhong',
  name: '黄忠',
  faction: 'shu',
  maxHp: 4,
  gender: 'male',
  // 烈弓：目标手牌数≥己 或 体力≤己 → 不可闪避
  hooks: [
    {
      timing: 'useCard',
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
  skills: [{ name: '烈弓', desc: '当你使用【杀】指定目标后，若目标手牌数≥你或体力≤你，此【杀】不可被闪避。' }],
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
          if (hand >= ctx.player.hp || hand <= attackRange(ctx.player)) {
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
  combo: { with: 'diaochan', bonus: 'hp' },
  // 无双：目标需出2张【闪】
  hooks: [
    {
      timing: 'useCard',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext } | undefined;
        if (payload?.attack?.asType !== 'sha') return;
        payload.attack.requiredShan = 2;
      },
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
  combo: { with: 'lvbu', bonus: 'hp' },
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
        state.discard.push(card);
        const aId = intent.targetIds[0];
        const bId = intent.targetIds[1];
        if (!aId || !bId) return '请选择两名男性角色';
        const a = getPlayer(state, aId);
        const b = getPlayer(state, bId);
        if (!a || !b) return '目标不存在';
        if (!isMalePlayer(state, a) || !isMalePlayer(state, b)) return '目标须为男性角色';
        pushLog(state, 'skill', `${player.name} 发动【离间】，令 ${a.name} 对 ${b.name} 使用【杀】。`);
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
  // 闭月：结束阶段摸一张
  hooks: [
    {
      timing: 'turnEnd',
      handler: (ctx) => {
        const c = drawOne(ctx.state);
        if (!c) return;
        ctx.player.hand.push(c);
        pushLog(ctx.state, 'skill', `${ctx.player.name} 发动【闭月】，摸了 1 张牌。`);
      },
    },
  ],
  skills: [
    { name: '离间', desc: '出牌阶段限一次，弃一张牌并选两名男性角色，令A对B使用【杀】。A不出则受1伤害。（简化版）' },
    { name: '闭月', desc: '结束阶段开始时，你可以摸一张牌。' },
  ],
};

const ZHENJI: Hero = {
  id: 'zhenji',
  name: '甄姬',
  faction: 'wei',
  maxHp: 3,
  gender: 'female',
  // 倾国：黑色牌当【闪】
  canUseAs: (card, type) => type === 'shan' && !isRed(card),
  // 洛神：准备阶段判定，黑色则获得并可重复
  hooks: [
    {
      timing: 'turnStart',
      handler: (ctx) => {
        const got: Card[] = [];
        for (;;) {
          const j = drawOne(ctx.state);
          if (!j) break;
          pushLog(ctx.state, 'skill', `${ctx.player.name} 发动【洛神】，判定：${cardLabel(j)}。`);
          if (!isRed(j)) {
            got.push(j);
          } else {
            ctx.state.discard.push(j);
            break;
          }
        }
        if (got.length > 0) {
          ctx.player.hand.push(...got);
          pushLog(ctx.state, 'skill', `【洛神】获得 ${got.length} 张黑色牌。`);
        }
      },
    },
  ],
  skills: [
    { name: '倾国', desc: '你可以将一张黑色牌当【闪】使用或打出。' },
    { name: '洛神', desc: '准备阶段，你可以进行判定：若为黑色，你获得此牌，然后你可以重复此流程。' },
  ],
  // 国战版洛神：判到红色为止，然后**一次性**获得此前所有黑色判定牌
  guozhan: {
    hooks: [
      {
        timing: 'turnStart',
        handler: (ctx) => {
          const pending: Card[] = [];
          for (;;) {
            const j = drawOne(ctx.state);
            if (!j) break;
            if (isRed(j)) {
              // 判到红即止，红牌进弃牌堆
              ctx.state.discard.push(j);
              pushLog(ctx.state, 'skill', `${ctx.player.name} 发动【洛神】，判定${cardLabel(j)}为红色，结束。`);
              break;
            }
            pending.push(j);
          }
          if (pending.length > 0) {
            ctx.player.hand.push(...pending);
            pushLog(
              ctx.state,
              'skill',
              `${ctx.player.name} 的【洛神】一次性获得 ${pending.length} 张黑色判定牌。`,
            );
          }
        },
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
  // 鬼才：判定牌生效前，可打1手牌替换判定牌（简化：当前判定对己不利时自动选有利手牌替换）
  hooks: [
    {
      timing: 'beforeJudge',
      handler: (ctx) => {
        const payload = ctx.payload as { trick?: Card; judgeCard?: Card } | undefined;
        if (!payload?.trick || !payload.judgeCard) return;
        const trick = payload.trick;
        const judgeCard = payload.judgeCard;
        // 判定牌是否对己不利
        const isBad = (card: Card): boolean => {
          if (trick.type === 'lebu') return card.suit !== 'heart'; // 非红桃→跳过出牌
          if (trick.type === 'bingliang') return card.suit !== 'club'; // 非梅花→跳过摸牌
          if (trick.type === 'shandian') return card.suit === 'spade' && card.rank >= 2 && card.rank <= 9;
          return false;
        };
        if (!isBad(judgeCard)) return; // 已有利则不替换
        const goodCard = ctx.player.hand.find((c) => !isBad(c));
        if (!goodCard) return;
        removeCard(ctx.player.hand, goodCard.id);
        pushLog(ctx.state, 'skill', `${ctx.player.name} 发动【鬼才】，以 ${cardLabel(goodCard)} 替换判定牌。`);
        return { replaceCard: goodCard };
      },
    },
    // 反馈：受到伤害后，获得伤害来源的一张牌
    // 简化：来源有手牌就随机拿一张手牌，否则随机拿一张装备牌（真实规则是由你选一张）
    {
      timing: 'afterDamage',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
        if (!payload?.attack || !payload.damage) return;
        const source = getPlayer(ctx.state, payload.attack.sourceId);
        if (!source || source.seatId === ctx.player.seatId) return; // 无来源或自伤
        let taken: Card | undefined;
        if (source.hand.length > 0) {
          const i = Math.floor(Math.random() * source.hand.length);
          [taken] = source.hand.splice(i, 1);
        } else {
          const slots = ['weapon', 'armor', 'plusMount', 'minusMount'] as const;
          const filled = slots.filter((sl) => source.equipment[sl]);
          const sl = filled[Math.floor(Math.random() * filled.length)];
          if (sl) {
            taken = source.equipment[sl] ?? undefined;
            source.equipment[sl] = null;
          }
        }
        if (!taken) {
          pushLog(ctx.state, 'skill', `${ctx.player.name} 发动【反馈】，但 ${source.name} 没有牌可取。`);
          return;
        }
        ctx.player.hand.push(taken);
        pushLog(
          ctx.state,
          'skill',
          `${ctx.player.name} 发动【反馈】，获得 ${source.name} 的一张牌。`,
        );
      },
    },
  ],
  skills: [
    { name: '反馈', desc: '当你受到伤害后，你可以获得伤害来源的一张牌。（简化：随机取一张手牌，无手牌则取一张装备）' },
    { name: '鬼才', desc: '在判定牌生效前，你可以打出一张手牌替换之。（简化：自动选有利手牌替换）' },
  ],
};

const XIAHOUDUN: Hero = {
  id: 'xiahoudun',
  name: '夏侯惇',
  faction: 'wei',
  maxHp: 4,
  gender: 'male',
  // 刚烈：受到伤害后翻判定→非红桃则来源弃1牌（简化：自动弃随机手牌）
  hooks: [
    {
      timing: 'afterDamage',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext; damage?: number } | undefined;
        if (!payload?.attack || !payload.damage) return;
        const source = getPlayer(ctx.state, payload.attack.sourceId);
        if (!source || source.seatId === ctx.player.seatId) return; // 无来源或自伤不触发
        const judgeCard = drawOne(ctx.state);
        if (!judgeCard) return;
        pushLog(ctx.state, 'skill', `${ctx.player.name} 发动【刚烈】，判定牌：${cardLabel(judgeCard)}。`);
        ctx.state.discard.push(judgeCard);
        if (judgeCard.suit !== 'heart') {
          if (source.hand.length > 0) {
            const idx = Math.floor(Math.random() * source.hand.length);
            const [c] = source.hand.splice(idx, 1);
            if (c) {
              ctx.state.discard.push(c);
              pushLog(ctx.state, 'skill', `${source.name} 弃置了【${cardLabel(c)}】。`);
            }
          } else {
            pushLog(ctx.state, 'skill', `${source.name} 没有手牌可弃。`);
          }
        } else {
          pushLog(ctx.state, 'skill', `判定为红桃，【刚烈】无效。`);
        }
      },
    },
  ],
  skills: [{ name: '刚烈', desc: '当你受到伤害后，你可以进行判定：若非红桃，来源须弃置一张牌。（简化：自动弃随机手牌）' }],
};

const XUCHU: Hero = {
  id: 'xuchu',
  name: '许褚',
  faction: 'wei',
  maxHp: 4,
  gender: 'male',
  // 裸衣（简化）：你使用【杀】造成的伤害+1
  hooks: [
    {
      timing: 'useCard',
      handler: (ctx) => {
        const payload = ctx.payload as { attack?: AttackContext } | undefined;
        if (payload?.attack?.asType === 'sha') {
          payload.attack.damage += 1;
        }
      },
    },
  ],
  skills: [{ name: '裸衣', desc: '你使用【杀】造成的伤害+1。（简化版）' }],
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
      execute: (state, player, intent, _api) => {
        const ids = intent.cardIds ?? [];
        if (ids.length !== 1) return '请选择一张手牌弃置';
        const card = removeCard(player.hand, ids[0]!);
        if (!card) return '找不到手牌';
        const targetId = intent.targetIds[0];
        if (!targetId) return '请选择一名已受伤的角色';
        const target = getPlayer(state, targetId);
        if (!target || !target.alive) return '目标无效';
        if (target.hp >= target.maxHp) return '该角色体力已满';
        state.discard.push(card);
        target.hp += 1;
        pushLog(
          state,
          'skill',
          `${player.name} 发动【青囊】，弃置【${cardLabel(card)}】，令 ${target.name} 回复 1 点体力。`,
          { seat: player.seatId, action: 'tao' },
        );
      },
    },
  ],
  skills: [
    { name: '急救', desc: '你的回合外，可以将一张红色牌当【桃】使用。' },
    { name: '青囊', desc: '出牌阶段限一次，你可以弃置一张手牌并选择一名已受伤的角色，令其回复 1 点体力。' },
  ],
};

const SUNQUAN: Hero = {
  id: 'sunquan',
  name: '孙权',
  faction: 'wu',
  maxHp: 4,
  gender: 'male',
  combo: { with: 'zhouyu', bonus: 'hp' },
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
        for (const c of discarded) state.discard.push(c);
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
          for (const c of discarded) state.discard.push(c);
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
    ],
  },
};

const ZHOUYU: Hero = {
  id: 'zhouyu',
  name: '周瑜',
  faction: 'wu',
  maxHp: 3,
  gender: 'male',
  combo: { with: 'sunquan', bonus: 'hp' },
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
        pushLog(state, 'skill', `${player.name} 发动【反间】，向 ${target.name} 展示 ${cardLabel(shownCard)}。`);
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
  skills: [
    { name: '英姿', desc: '摸牌阶段，你可以多摸一张牌。' },
    { name: '反间', desc: '出牌阶段限一次，展示一张手牌给目标：目标交回一张不同类型手牌，或受1伤害。（简化版）' },
  ],
  // 国战（2.110 调整）：英姿改为锁定技，并追加「手牌上限 = 体力上限」
  guozhan: {
    extraDraw: 1,
    handLimit: (_state, player) => player.maxHp,
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
                st.discard.push(c);
              }
              pushLog(
                st,
                'skill',
                `弃置了 ${same.length} 张与【${cardLabel(card)}】花色相同的牌。`,
              );
            },
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
  skills: [{ name: '奇袭', desc: '你可以将一张黑色牌当【过河拆桥】使用。' }],
};

const HUANGGAI: Hero = {
  id: 'huanggai',
  name: '黄盖',
  faction: 'wu',
  maxHp: 4,
  gender: 'male',
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
  skills: [{ name: '苦肉', desc: '出牌阶段，你可以失去 1 点体力，然后摸两张牌。（简化：限1次/回合）' }],
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
          state.discard.push(c);
          pushLog(state, 'skill', `${player.name} 发动【苦肉】，弃置【${cardLabel(c)}】并失去 1 点体力。`, {
            seat: player.seatId,
            action: 'selfhurt',
          });
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

const VANILLA: Hero = {
  id: 'vanilla',
  name: '平民',
  faction: 'neutral',
  maxHp: 4,
  skills: [],
};

export const HEROES: Hero[] = [
  GUANYU,
  ZHANGFEI,
  ZHAOYUN,
  MACHAO,
  HUANGZHONG,
  LVBU,
  DIAOCHAN,
  ZHENJI,
  SIMAYI,
  XIAHOUDUN,
  XUCHU,
  HUATUO,
  SUNQUAN,
  ZHOUYU,
  GANNING,
  HUANGGAI,
  VANILLA,
];

const HERO_MAP: Record<string, Hero> = Object.fromEntries(HEROES.map((h) => [h.id, h]));

export function getHero(id: string | null | undefined): Hero | undefined {
  if (id == null) return undefined;
  return HERO_MAP[id];
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
export function getHeroForMode(
  id: string | null | undefined,
  mode: GameMode,
): Hero | undefined {
  const base = getHero(id);
  if (!base) return undefined;
  if (mode !== 'guozhan' || !base.guozhan) return base;
  return { ...base, ...base.guozhan };
}

/** 取武将每回合杀数上限，缺省 1 */
export function heroShaLimit(hero: Hero): number {
  return hero.shaLimit?.() ?? 1;
}

/** 取武将可否把 card 当 type 用 */
export function heroCanUseAs(hero: Hero, card: Card, type: CardType): boolean {
  return hero.canUseAs?.(card, type) ?? false;
}

/** 从手牌中移除一张牌（按 id） */
function removeCard(hand: Card[], id: string): Card | null {
  const i = hand.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const [c] = hand.splice(i, 1);
  return c ?? null;
}

/** 判断玩家是否为男性（主将或副将为男性即可） */
export function isMalePlayer(state: GameState, player: Player): boolean {
  const main = getHero(player.heroId);
  const deputy = getHero(player.deputyHeroId);
  return main?.gender === 'male' || deputy?.gender === 'male';
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
