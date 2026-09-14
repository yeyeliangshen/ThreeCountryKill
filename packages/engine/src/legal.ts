import type { PromptView } from '@sgs/protocol';
import { CARD_TYPE_NAME, isDelayedTrick, isEquipCard, isInstantTrick } from '@sgs/protocol';
import type { GameState, TrickContext } from './model';
import { getPlayerOrThrow } from './model';
import { heroCanUseAs, heroShaLimit } from './heroes';
import { activeHeroes } from './engine';
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
      return buildRespondShaPrompt(state, seatId);

    case 'respondDeath':
      if (pending.askQueue[pending.askIndex] !== seatId) return null;
      return buildRespondDeathPrompt(state, seatId, pending.dyingId);

    case 'discard':
      if (pending.seatId !== seatId) return null;
      return buildDiscardPrompt(state, seatId, pending.count);

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
    // 延时锦囊：闪电→自己判定区无同类即可；乐不思蜀/兵粮寸断→存在可达目标(distance≤1且目标判定区无同类)
    if (isDelayedTrick(card)) {
      const trickType = card.type as 'lebu' | 'shandian' | 'bingliang';
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
            distance(state, seatId, p.seatId) <= 1,
        );
        if (hasTarget) {
          legalCardIds.push(card.id);
          seen.add(card.id);
        }
      }
      continue;
    }
    // 杀（或可转化的红牌）——受出杀上限限制
    if (canSha && (card.type === 'sha' || heroes.some((h) => heroCanUseAs(h, card, 'sha')))) {
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
          (p) => p.alive && p.seatId !== seatId && distance(state, seatId, p.seatId) <= 1,
        );
      } else if (trickType === 'jiedao') {
        // 需要一个有武器的其他玩家
        legal = state.players.some(
          (p) => p.alive && p.seatId !== seatId && p.equipment.weapon !== null,
        );
      } else {
        // 决斗 / 火攻 / 南蛮 / 万箭 / 过河拆桥：有其他存活玩家即可
        legal = state.players.some((p) => p.alive && p.seatId !== seatId);
      }
      if (legal) {
        legalCardIds.push(card.id);
        seen.add(card.id);
      }
    }
  }
  const legalTargetIds = state.players
    .filter((p) => p.alive && p.seatId !== seatId)
    .map((p) => p.seatId);
  // 可用主动技能
  const legalSkillIds: string[] = [];
  for (const hero of heroes) {
    for (const skill of hero.activeSkills ?? []) {
      if (
        skill.canUse(state, player) &&
        !(skill.oncePerTurn && player.flags.skillUsedThisTurn[skill.id])
      ) {
        legalSkillIds.push(skill.id);
      }
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
  };
}

function buildRespondShaPrompt(state: GameState, seatId: string): PromptView {
  const player = getPlayerOrThrow(state, seatId);
  const heroes = activeHeroes(state, player);
  // 接受【闪】，或武将可转化的牌（赵云·龙胆：杀当闪；甄姬·倾国：黑牌当闪）
  const legalCardIds = player.hand
    .filter((c) => c.type === 'shan' || heroes.some((h) => heroCanUseAs(h, c, 'shan')))
    .map((c) => c.id);
  return {
    kind: 'respondSha',
    message: '你被【杀】指定为目标：出【闪】或弃权',
    legalCardIds,
    legalTargetIds: [],
    mustSelectTargetCount: 0,
  };
}

function buildRespondDeathPrompt(
  state: GameState,
  seatId: string,
  dyingId: string,
): PromptView {
  const player = getPlayerOrThrow(state, seatId);
  const heroes = activeHeroes(state, player);
  const dying = getPlayerOrThrow(state, dyingId);
  // 接受【桃】/【酒】，或武将可转化的红牌（华佗·急救：红牌当桃）
  const legalCardIds = player.hand
    .filter(
      (c) =>
        c.type === 'tao' || c.type === 'jiu' || heroes.some((h) => heroCanUseAs(h, c, 'tao')),
    )
    .map((c) => c.id);
  return {
    kind: 'respondDeath',
    message: `${dying.name} 濒死：出【桃】（或【酒】当桃）救援，或弃权`,
    legalCardIds,
    legalTargetIds: [],
    mustSelectTargetCount: 0,
  };
}

function buildDiscardPrompt(
  state: GameState,
  seatId: string,
  count: number,
): PromptView {
  const player = getPlayerOrThrow(state, seatId);
  return {
    kind: 'discard',
    message: `弃牌阶段：请弃 ${count} 张牌`,
    legalCardIds: player.hand.map((c) => c.id),
    legalTargetIds: [],
    mustSelectTargetCount: count,
  };
}

function buildRespondTrickPrompt(
  state: GameState,
  seatId: string,
  ctx: TrickContext,
): PromptView {
  const player = getPlayerOrThrow(state, seatId);
  const heroes = activeHeroes(state, player);
  const trickName = CARD_TYPE_NAME[ctx.card.type];
  let message: string;
  let legalCardIds: string[];

  switch (ctx.card.type) {
    case 'juedou':
      message = `【决斗】：打出【杀】或弃权（受 1 点伤害）`;
      legalCardIds = player.hand
        .filter((c) => c.type === 'sha' || heroes.some((h) => heroCanUseAs(h, c, 'sha')))
        .map((c) => c.id);
      break;
    case 'huogong':
      if (!ctx.revealedSuit) {
        message = `【火攻】：展示一张手牌或弃权`;
        legalCardIds = player.hand.map((c) => c.id);
      } else {
        message = `【火攻】：弃一张${ctx.revealedSuit === 'heart' || ctx.revealedSuit === 'diamond' ? '红色' : '黑色'}${ctx.revealedSuit}花色手牌，或弃权`;
        legalCardIds = player.hand
          .filter((c) => c.suit === ctx.revealedSuit)
          .map((c) => c.id);
      }
      break;
    case 'jiedao':
      message = `【借刀杀人】：打出【杀】或弃权（交出武器）`;
      legalCardIds = player.hand
        .filter((c) => c.type === 'sha' || heroes.some((h) => heroCanUseAs(h, c, 'sha')))
        .map((c) => c.id);
      break;
    case 'nanman':
      message = `【南蛮入侵】：打出【杀】或弃权（受 1 点伤害）`;
      legalCardIds = player.hand
        .filter((c) => c.type === 'sha' || heroes.some((h) => heroCanUseAs(h, c, 'sha')))
        .map((c) => c.id);
      break;
    case 'wanjian':
      message = `【万箭齐发】：打出【闪】或弃权（受 1 点伤害）`;
      legalCardIds = player.hand
        .filter((c) => c.type === 'shan' || heroes.some((h) => heroCanUseAs(h, c, 'shan')))
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
  };
}

function buildWuxiePrompt(
  state: GameState,
  seatId: string,
  ctx: TrickContext,
): PromptView {
  const player = getPlayerOrThrow(state, seatId);
  const trickName = CARD_TYPE_NAME[ctx.card.type];
  return {
    kind: 'wuxieQueue',
    message: `是否使用【无懈可击】取消【${trickName}】？`,
    legalCardIds: player.hand.filter((c) => c.type === 'wuxie').map((c) => c.id),
    legalTargetIds: [],
    mustSelectTargetCount: 0,
  };
}
