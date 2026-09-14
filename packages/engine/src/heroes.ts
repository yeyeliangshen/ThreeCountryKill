import { cardLabel, isRed } from '@sgs/protocol';
import type { Card, CardType, DamageAttribute, Faction, Intent, RoleId } from '@sgs/protocol';
import type { HookRegistration, Timing } from './timing';
import type { AttackContext, GameState, Player } from './model';
import { drawOne } from './deck';
import { getPlayer, pushLog } from './model';

// —— 武将定义 ——
// canUseAs：转化技（能否把 card 当 type 使用/打出）。
// shaLimit：被动修改器（本回合最多可出杀数，默认 1）。
// hooks：触发技钩子。
// activeSkills：主动技能（出牌阶段可主动发动）。
// skills：UI 展示用技能描述。

/** 引擎内部 API（由 engine.ts 注入，避免 heroes→engine 循环依赖） */
export interface SkillApi {
  /** 造成伤害（触发伤害钩子 + 濒死检查 + 恢复出牌） */
  dealDamage: (target: Player, damage: number, sourceId: string, attribute?: DamageAttribute) => void;
  /** 失去体力（不触发伤害钩子，但触发濒死检查） */
  loseHp: (target: Player, amount: number) => void;
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
  /** 珠联璧合：与另一武将搭配时获得加成 */
  combo?: { with: string; bonus: 'hp' | 'skill' };
  /** UI 展示用技能描述 */
  skills: { name: string; desc: string }[];
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
  skills: [{ name: '铁骑', desc: '当你使用【杀】指定目标后，你可以进行判定：若为红色，此【杀】不可被闪避。' }],
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
  skills: [{ name: '离间', desc: '出牌阶段限一次，弃一张牌并选两名男性角色，令A对B使用【杀】。A不出则受1伤害。（简化版）' }],
};

const ZHENJI: Hero = {
  id: 'zhenji',
  name: '甄姬',
  faction: 'wei',
  maxHp: 3,
  gender: 'female',
  // 倾国：黑色牌当【闪】
  canUseAs: (card, type) => type === 'shan' && !isRed(card),
  skills: [{ name: '倾国', desc: '你可以将一张黑色牌当【闪】使用或打出。' }],
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
  ],
  skills: [{ name: '鬼才', desc: '在判定牌生效前，你可以打出一张手牌替换之。（简化：自动选有利手牌替换）' }],
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
  skills: [{ name: '急救', desc: '你的回合外，可以将一张红色牌当【桃】使用。' }],
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
  skills: [{ name: '反间', desc: '出牌阶段限一次，展示一张手牌给目标：目标交回一张不同类型手牌，或受1伤害。（简化版）' }],
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
        pushLog(state, 'skill', `${player.name} 发动【苦肉】，失去 1 点体力。`);
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
