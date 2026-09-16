import type { CardType, MarkerId, PromptView } from '@sgs/protocol';
import { CARD_TYPE_NAME, isDelayedTrick, isEquipCard, isInstantTrick } from '@sgs/protocol';
import type { AttackContext, GameState, Pending, Player, TrickContext } from './model';
import { getPlayerOrThrow } from './model';
import {
  heroShaLimit,
  heroBlocksBeingTarget,
  heroIgnoresTrickDistance,
  type ActiveSkill,
  type Hero,
} from './heroes';
import { MARKER_DESC, MARKER_SKILL_PREFIX, markerActiveSkills } from './markers';
import { activeHeroes, canUseAsCard, duelShaRequired, factionHelpers } from './engine';
import { distance } from './distance';

// 根据 pending 状态，给"被询问的玩家"构建提示（含合法选项）。
// 其它玩家的 prompt 为 null（他们只是在等待）。
export function buildPrompt(state: GameState, seatId: string): PromptView | null {
  // 选将阶段：未选将的座位收到 pickHero 提示，已选者等待
  if (state.draft) {
    if (state.draft.pendingSeats.includes(seatId)) {
      return {
        kind: 'pickHero',
        message:
          state.mode === 'guozhan'
            ? '请从发到的武将中选 2 位同阵营武将（主将 + 副将）'
            : '请从发到的武将中选 1 位',
        legalCardIds: [],
        legalTargetIds: [],
        mustSelectTargetCount: 1,
        legalHeroIds: state.draft.deals[seatId] ?? [],
      };
    }
    return null;
  }

  const pending = state.pending;
  if (!pending) return null;

  switch (pending.kind) {
    case 'play':
      if (pending.seatId !== seatId) return null;
      return buildPlayPrompt(state, seatId);

    case 'respondSha':
      if (pending.responderId !== seatId) return null;
      return buildRespondShaPrompt(state, seatId, pending.attack);

    case 'respondDeath':
      if (pending.askQueue[pending.askIndex] !== seatId) return null;
      return buildRespondDeathPrompt(state, seatId, pending.dyingId);

    case 'discard':
      if (pending.seatId !== seatId) return null;
      return buildDiscardPrompt(state, seatId, pending.count);

    case 'choice':
      if (pending.seatId !== seatId) return null;
      return {
        kind: 'choice',
        message: pending.title,
        legalCardIds: [],
        legalTargetIds: [],
        mustSelectTargetCount: 0,
        choiceTitle: pending.title,
        choiceOptions: pending.options,
      };

    case 'pickCards':
      if (pending.seatId !== seatId) return null;
      return {
        kind: 'pickCards',
        message: pending.title,
        legalCardIds: [],
        legalTargetIds: [],
        mustSelectTargetCount: 0,
        pickTitle: pending.title,
        // 下发的牌面可能是牌堆顶这种不在手牌里的牌，所以整份发过去
        pickCards: pending.cards.slice(),
        pickMin: pending.min,
        pickMax: pending.max,
      };

    case 'viewCards': {
      // 内容只属于这一个座位：别人的快照里连标题都不给（免得泄露「他在看什么」）
      if (pending.seatId !== seatId) return null;
      return {
        kind: 'viewCards',
        message: `${pending.title}　看完点「确认」`,
        legalCardIds: [],
        legalTargetIds: [],
        mustSelectTargetCount: 0,
        viewTitle: pending.title,
        viewCards: pending.cards.slice(),
        viewNote: pending.note,
      };
    }

    case 'factionCall':
      if (pending.askQueue[pending.askIndex] !== seatId) return null;
      return buildFactionCallPrompt(state, seatId, pending);

    case 'respondTrick':
      if (pending.responderId !== seatId) return null;
      return buildRespondTrickPrompt(state, seatId, pending.ctx);

    case 'wuxieQueue':
      if (pending.askQueue[pending.askIndex] !== seatId) return null;
      return buildWuxiePrompt(state, seatId, pending.ctx);

    case 'activeSkill':
      // 多步技能交互的提示由具体技能构建（Step 6 实现）
      return null;
  }
  return null;
}

function buildPlayPrompt(state: GameState, seatId: string): PromptView {
  const player = getPlayerOrThrow(state, seatId);
  const heroes = activeHeroes(state, player);
  // 诸葛连弩：本回合可出无限杀
  const hasZhuge = player.equipment.weapon?.equipName === 'zhuge';
  const maxSha = hasZhuge ? Infinity : Math.max(1, ...heroes.map(heroShaLimit));
  const canSha = player.flags.shaCountThisTurn < maxSha;
  const legalCardIds: string[] = [];
  const seen = new Set<string>();
  for (const card of player.hand) {
    if (seen.has(card.id)) continue;
    // 装备牌：总是可使用
    if (isEquipCard(card)) {
      legalCardIds.push(card.id);
      seen.add(card.id);
      continue;
    }
    // 延时锦囊：闪电→自己判定区无同类即可；乐不思蜀/兵粮寸断→存在可达目标
    // （目标判定区无同类、且没被帷幕/谦逊这类锁定技挡掉）
    if (isDelayedTrick(card)) {
      const trickType = card.type as 'lebu' | 'shandian' | 'bingliang';
      const noDistance = heroIgnoresTrickDistance(heroes); // 黄月英·奇才
      if (trickType === 'shandian') {
        if (!player.judgment.some((t) => t.type === 'shandian')) {
          legalCardIds.push(card.id);
          seen.add(card.id);
        }
      } else {
        const hasTarget = state.players.some(
          (p) =>
            p.alive &&
            p.seatId !== seatId &&
            !p.judgment.some((t) => t.type === trickType) &&
            !heroBlocksBeingTarget(state, p, card, player) &&
            (noDistance || distance(state, seatId, p.seatId) <= 1),
        );
        if (hasTarget) {
          legalCardIds.push(card.id);
          seen.add(card.id);
        }
      }
      continue;
    }
    // 杀（或可转化的红牌 / 鏖战桃当杀）——受出杀上限限制
    if (canSha && (card.type === 'sha' || canUseAsCard(state, player, card, 'sha'))) {
      legalCardIds.push(card.id);
      seen.add(card.id);
      continue;
    }
    // 桃：体力未满时可回血
    if (card.type === 'tao' && player.hp < player.maxHp) {
      legalCardIds.push(card.id);
      seen.add(card.id);
      continue;
    }
    // 酒：总是可使用（buff）
    if (card.type === 'jiu') {
      legalCardIds.push(card.id);
      seen.add(card.id);
    }
    // 即时锦囊（无懈可击不能主动使用）
    if (isInstantTrick(card) && card.type !== 'wuxie') {
      const trickType = card.type;
      let legal = false;
      if (trickType === 'wuzhong' || trickType === 'taoyuan') {
        legal = true; // 自身 / 全体，无需目标
      } else if (trickType === 'shunshou') {
        legal = state.players.some(
          (p) =>
            p.alive &&
            p.seatId !== seatId &&
            !heroBlocksBeingTarget(state, p, card, player) &&
            (heroIgnoresTrickDistance(heroes) || distance(state, seatId, p.seatId) <= 1),
        );
      } else if (trickType === 'jiedao') {
        // 需要一个有武器的其他玩家
        legal = state.players.some(
          (p) => p.alive && p.seatId !== seatId && p.equipment.weapon !== null,
        );
      } else if (trickType === 'tiesuo' || trickType === 'yiyi' || trickType === 'wugu') {
        // 铁索连环可以只选自己；以逸待劳含自己；五谷丰登是全体
        legal = true;
      } else if (trickType === 'yuanjiao') {
        // 需要一名「有明置武将牌 + 势力与你不同」的其他角色
        legal =
          player.faction !== null &&
          state.players.some(
            (p) =>
              p.alive &&
              p.seatId !== seatId &&
              p.faction !== null &&
              p.faction !== player.faction &&
              (p.heroRevealed || p.deputyRevealed) &&
              !heroBlocksBeingTarget(state, p, card, player),
          );
      } else {
        // 决斗 / 火攻 / 南蛮 / 万箭 / 过河拆桥 / 知己知彼：有其他存活玩家即可
        legal = state.players.some((p) => p.alive && p.seatId !== seatId);
      }
      if (legal) {
        legalCardIds.push(card.id);
        seen.add(card.id);
      }
    }
    // 转化即时锦囊（甘宁·奇袭：黑色牌当过河拆桥；卧龙诸葛亮·火计：红色牌当火攻）
    for (const it of ['guohe', 'huogong'] as const) {
      if (seen.has(card.id)) break;
      if (!canUseAsCard(state, player, card, it)) continue;
      const legal = state.players.some(
        (p) => p.alive && p.seatId !== seatId && !heroBlocksBeingTarget(state, p, card, player),
      );
      if (legal) {
        legalCardIds.push(card.id);
        seen.add(card.id);
      }
    }
    // 转化延时锦囊：大乔·国色（方块牌当【乐不思蜀】）、徐晃·断粮（黑色基本/装备牌当【兵粮寸断】）
    for (const trickType of ['lebu', 'bingliang'] as const) {
      if (seen.has(card.id)) break;
      if (!canUseAsCard(state, player, card, trickType)) continue;
      const asTrick = { ...card, type: trickType };
      const noDistance = heroIgnoresTrickDistance(heroes);
      const hasTarget = state.players.some(
        (p) =>
          p.alive &&
          p.seatId !== seatId &&
          !p.judgment.some((t) => t.type === trickType) &&
          !heroBlocksBeingTarget(state, p, asTrick, player) &&
          (noDistance || distance(state, seatId, p.seatId) <= 1),
      );
      if (hasTarget) {
        legalCardIds.push(card.id);
        seen.add(card.id);
      }
    }
    // 转化【铁索连环】（庞统·连环：梅花手牌当【铁索连环】）——可以只指定自己，
    // 所以总是合法；就算一个目标都不想选，也还能重铸。
    if (!seen.has(card.id) && canUseAsCard(state, player, card, 'tiesuo')) {
      legalCardIds.push(card.id);
      seen.add(card.id);
    }
  }
  const legalTargetIds = state.players
    .filter((p) => p.alive && p.seatId !== seatId)
    .map((p) => p.seatId);
  // 可用主动技能：武将主动技 + 标记技能
  const legalSkillIds: string[] = [];
  const legalSkills: { id: string; name: string; desc: string }[] = [];
  const skills: ActiveSkill[] = [
    ...heroes.flatMap((h) => h.activeSkills ?? []),
    ...markerActiveSkills(state, player),
  ];
  for (const skill of skills) {
    if (
      skill.canUse(state, player) &&
      !(skill.oncePerTurn && player.flags.skillUsedThisTurn[skill.id]) &&
      !(skill.oncePerGame && player.usedOncePerGame[skill.id])
    ) {
      legalSkillIds.push(skill.id);
      legalSkills.push({ id: skill.id, name: skill.name, desc: skillDescFor(heroes, skill) });
    }
  }
  return {
    kind: 'play',
    message: '你的出牌阶段：出牌或结束',
    legalCardIds,
    legalTargetIds,
    // 装备/桃/酒不需要目标；杀需1目标，客户端按牌类型判断
    mustSelectTargetCount: 0,
    legalSkillIds,
    legalSkills,
  };
}

/**
 * 取主动技能的说明文字。
 *
 * 武将主动技的说明写在 hero.skills 里、按**技能名**对应（这是仓库既有约定）；
 * 标记技能不属于任何武将，改查 MARKER_DESC。
 * 界面不再自己配对——那份配对逻辑只留在这里一处。
 */
function skillDescFor(heroes: Hero[], skill: ActiveSkill): string {
  for (const h of heroes) {
    const s = h.skills.find((x) => x.name === skill.name);
    if (s) return s.desc;
  }
  if (skill.id.startsWith(MARKER_SKILL_PREFIX)) {
    const id = skill.id.slice(MARKER_SKILL_PREFIX.length) as MarkerId;
    if (MARKER_DESC[id]) return MARKER_DESC[id];
  }
  return '';
}

function buildRespondShaPrompt(
  state: GameState,
  seatId: string,
  attack: AttackContext,
): PromptView {
  const player = getPlayerOrThrow(state, seatId);
  // 接受【闪】，或武将可转化的牌（赵云·龙胆：杀当闪；甄姬·倾国：黑牌当闪）
  const legalCardIds = player.hand
    .filter((c) => c.type === 'shan' || canUseAsCard(state, player, c, 'shan'))
    .map((c) => c.id);
  const required = attack.requiredShan ?? 1;
  const message =
    required > 1
      ? `你被【杀】指定为目标：需出 ${required} 张【闪】或弃权`
      : '你被【杀】指定为目标：出【闪】或弃权';
  return {
    kind: 'respondSha',
    message,
    legalCardIds,
    legalTargetIds: [],
    mustSelectTargetCount: 0,
    ...factionCallInfo(state, player, 'shan'),
  };
}

/**
 * 该玩家此刻能发动的势力技（护驾/激将）。
 * 条件：生效武将里有 needType 匹配的势力技，且有同势力角色手里有这种牌。
 */
function factionCallInfo(
  state: GameState,
  player: Player,
  needType: CardType | null,
): { factionCall?: PromptView['factionCall'] } {
  if (!needType) return {};
  for (const h of activeHeroes(state, player)) {
    const fc = h.factionCall;
    if (!fc || fc.needType !== needType) continue;
    const helperIds = factionHelpers(state, player, needType);
    if (helperIds.length === 0) continue;
    return {
      factionCall: {
        skillId: fc.id,
        skillName: fc.name,
        needType,
        helpers: helperIds.map((sid) => ({
          seatId: sid,
          name: getPlayerOrThrow(state, sid).name,
        })),
      },
    };
  }
  return {};
}

function buildFactionCallPrompt(
  state: GameState,
  seatId: string,
  pending: Extract<Pending, { kind: 'factionCall' }>,
): PromptView {
  const player = getPlayerOrThrow(state, seatId);
  return {
    kind: 'factionCall',
    message: `${pending.title}（轮到你了）`,
    legalCardIds: player.hand
      .filter(
        (c) => c.type === pending.needType || canUseAsCard(state, player, c, pending.needType),
      )
      .map((c) => c.id),
    legalTargetIds: [],
    mustSelectTargetCount: 0,
  };
}

function buildRespondDeathPrompt(state: GameState, seatId: string, dyingId: string): PromptView {
  const player = getPlayerOrThrow(state, seatId);
  const dying = getPlayerOrThrow(state, dyingId);
  // 接受【桃】/【酒】，或武将可转化的红牌（华佗·急救：红牌当桃）
  const legalCardIds = player.hand
    .filter((c) => c.type === 'tao' || c.type === 'jiu' || canUseAsCard(state, player, c, 'tao'))
    .map((c) => c.id);
  return {
    kind: 'respondDeath',
    message: `${dying.name} 濒死：出【桃】（或【酒】当桃）救援，或弃权`,
    legalCardIds,
    legalTargetIds: [],
    mustSelectTargetCount: 0,
  };
}

function buildDiscardPrompt(state: GameState, seatId: string, count: number): PromptView {
  const player = getPlayerOrThrow(state, seatId);
  return {
    kind: 'discard',
    message: `弃牌阶段：请弃 ${count} 张牌`,
    legalCardIds: player.hand.map((c) => c.id),
    legalTargetIds: [],
    mustSelectTargetCount: count,
  };
}

function buildRespondTrickPrompt(state: GameState, seatId: string, ctx: TrickContext): PromptView {
  const player = getPlayerOrThrow(state, seatId);
  const trickName = CARD_TYPE_NAME[ctx.card.type];
  let message: string;
  let legalCardIds: string[];

  // 离间虚拟锦囊：打出【杀】或弃权
  if (ctx.skillId === 'lilian') {
    return {
      kind: 'respondTrick',
      message: '【离间】：打出【杀】或弃权（受 1 点伤害）',
      legalCardIds: player.hand
        .filter((c) => c.type === 'sha' || canUseAsCard(state, player, c, 'sha'))
        .map((c) => c.id),
      legalTargetIds: [],
      mustSelectTargetCount: 0,
      ...factionCallInfo(state, player, 'sha'),
    };
  }

  switch (ctx.card.type) {
    case 'juedou': {
      // 无双（吕布）：对手每次要连出两张【杀】，提示里得说清还差几张
      const need = duelShaRequired(state, ctx, seatId);
      const played = ctx.duelShaCount ?? 0;
      message =
        need > 1
          ? `【决斗】（无双）：需连出 ${need} 张【杀】，已出 ${played} 张，还差 ${need - played} 张`
          : `【决斗】：打出【杀】或弃权（受 1 点伤害）`;
      legalCardIds = player.hand
        .filter((c) => c.type === 'sha' || canUseAsCard(state, player, c, 'sha'))
        .map((c) => c.id);
      break;
    }
    case 'huogong':
      if (!ctx.revealedSuit) {
        message = `【火攻】：展示一张手牌或弃权`;
        legalCardIds = player.hand.map((c) => c.id);
      } else {
        message = `【火攻】：弃一张${ctx.revealedSuit === 'heart' || ctx.revealedSuit === 'diamond' ? '红色' : '黑色'}${ctx.revealedSuit}花色手牌，或弃权`;
        legalCardIds = player.hand.filter((c) => c.suit === ctx.revealedSuit).map((c) => c.id);
      }
      break;
    case 'jiedao':
      message = `【借刀杀人】：打出【杀】或弃权（交出武器）`;
      legalCardIds = player.hand
        .filter((c) => c.type === 'sha' || canUseAsCard(state, player, c, 'sha'))
        .map((c) => c.id);
      break;
    case 'nanman':
      message = `【南蛮入侵】：打出【杀】或弃权（受 1 点伤害）`;
      legalCardIds = player.hand
        .filter((c) => c.type === 'sha' || canUseAsCard(state, player, c, 'sha'))
        .map((c) => c.id);
      break;
    case 'wanjian':
      message = `【万箭齐发】：打出【闪】或弃权（受 1 点伤害）`;
      legalCardIds = player.hand
        .filter((c) => c.type === 'shan' || canUseAsCard(state, player, c, 'shan'))
        .map((c) => c.id);
      break;
    default:
      message = `响应【${trickName}】`;
      legalCardIds = player.hand.map((c) => c.id);
  }

  return {
    kind: 'respondTrick',
    message,
    legalCardIds,
    legalTargetIds: [],
    mustSelectTargetCount: 0,
    ...factionCallInfo(state, player, respondNeedType(ctx)),
  };
}

/**
 * 这个响应场景需要打出哪种牌（势力技据此判断能不能发动）。
 * 与 engine.ts 的 factionCallScene 是一一对应的——改一边记得改另一边。
 */
function respondNeedType(ctx: TrickContext): CardType | null {
  if (ctx.skillId === 'lilian') return 'sha';
  switch (ctx.card.type) {
    case 'wanjian':
      return 'shan';
    case 'juedou':
    case 'nanman':
    case 'jiedao':
      return 'sha';
    default:
      return null;
  }
}

function buildWuxiePrompt(state: GameState, seatId: string, ctx: TrickContext): PromptView {
  const player = getPlayerOrThrow(state, seatId);
  const trickName = CARD_TYPE_NAME[ctx.card.type];
  return {
    kind: 'wuxieQueue',
    message: `是否使用【无懈可击】取消【${trickName}】？`,
    // 卧龙诸葛亮·看破：黑色手牌当【无懈可击】
    legalCardIds: player.hand
      .filter((c) => c.type === 'wuxie' || canUseAsCard(state, player, c, 'wuxie'))
      .map((c) => c.id),
    legalTargetIds: [],
    mustSelectTargetCount: 0,
  };
}
