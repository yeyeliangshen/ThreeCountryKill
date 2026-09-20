import type { CardType, MarkerId, PromptView } from '@sgs/protocol';
import {
  CARD_TYPE_NAME,
  isDelayedTrick,
  isEquipCard,
  isInstantTrick,
  isWuxieLike,
} from '@sgs/protocol';
import type { AttackContext, GameState, Pending, Player, TrickContext } from './model';
import { getPlayer, getPlayerOrThrow } from './model';
import {
  bigFactions,
  effectiveFaction,
  EQUIP_SLOTS,
  isBigFaction,
  heroShaLimit,
  heroBlocksBeingTarget,
  heroIgnoresTrickDistance,
  suitSeenAs,
  unrevealedHeroes,
  wenjiMarked,
  type ActiveSkill,
  type Hero,
} from './heroes';
import { MARKER_DESC, MARKER_SKILL_PREFIX, markerActiveSkills } from './markers';
import { equipActiveSkills } from './equip';
import {
  draftOptionsFor,
  factionGrantedActiveSkills,
  huangtianFor,
  xuanhuoFor,
} from './heroes';
import type { Card } from '@sgs/protocol';
import {
  activeHeroes,
  canUseAsCard,
  chilingTargets,
  haolingTargets,
  duelShaRequired,
  factionHelpers,
  lianhengTargets,
  lianjunFactionOk,
  isTianCard,
  usableCardsOf,
} from './engine';
import { distance } from './distance';

// 根据 pending 状态，给"被询问的玩家"构建提示（含合法选项）。
// 其它玩家的 prompt 为 null（他们只是在等待）。
export function buildPrompt(state: GameState, seatId: string): PromptView | null {
  // 选将阶段：未选将的座位收到 pickHero 提示，已选者等待
  //
  // ⚠️ 例外：**选将期间也会挂询问**——双势力组合要在此时由玩家**选势力**（引擎给一条 `choice`）。
  //    这里以前无条件回 pickHero，那条询问就被 prompt 盖住了：客户端既看不到也答不了，
  //    玩家确认完武将后界面一直停在选将页（实测卡死，见 docs §5.133）。
  //    判定用「这一格是不是在问这个座位」，是的话交给下面的通用分支去构建（choice/pickCards/…）。
  const cur = state.pending;
  const askingThisSeat =
    !!cur && typeof cur === 'object' && 'seatId' in cur && cur.seatId === seatId && cur.kind !== 'play';
  if (state.draft && !askingThisSeat) {
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
        // 发到的那几张（界面照它渲染武将牌）
        legalHeroIds: state.draft.deals[seatId] ?? [],
        // 外加「君主/标准版互换」里**没人拿走**的那一版——界面据此显示「换成君主将」按钮
        draftVariants: draftOptionsFor(state, seatId).filter(
          (id) => !(state.draft!.deals[seatId] ?? []).includes(id),
        ),
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

    case 'pickSeats':
      if (pending.seatId !== seatId) return null;
      return {
        kind: 'pickSeats',
        message: pending.title,
        legalCardIds: [],
        // 可点的座位＝候选（界面据此点亮这几家）；下面两个数字是「至少/至多选几个」
        legalTargetIds: pending.candidates.slice(),
        mustSelectTargetCount: 0,
        pickTitle: pending.title,
        seatCandidates: pending.candidates.slice(),
        pickMin: pending.min,
        pickMax: pending.max,
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

/**
 * 「像手牌一样使用/打出」的候选牌：手牌 + 木牛流马的辎，**不含「田」**。
 *
 * 「田」只有两个去处（见 `isTianCard`）：通过【急袭】当【顺手牵羊】、或被【资粮】交出去。
 * 所以响应类提示（出闪/出杀/出桃/无懈）的候选一律用它，不能拿「田」里的牌来响应。
 */
function handLikeOf(player: Player): Card[] {
  return usableCardsOf(player).filter((c) => !isTianCard(c));
}

function buildPlayPrompt(state: GameState, seatId: string): PromptView {
  const player = getPlayerOrThrow(state, seatId);
  // 「本回合不能使用或打出手牌」：手牌一张都不可用（技能与结束阶段照常）
  const noCards = player.flags.cannotPlayCardsThisTurn;
  // 【木牛流马】扣置的牌可以「如手牌般使用」，所以可用牌是 usableCardsOf 而不是 hand
  const usable = usableCardsOf(player);
  const heroes = activeHeroes(state, player);
  // 诸葛连弩：本回合可出无限杀（陆抗·筑围的次数加成也要算进来——原来只有引擎算、
  // 界面漏了，结果是加了加成反倒点不动）
  const hasZhuge = player.equipment.weapon?.equipName === 'zhuge';
  const maxSha = hasZhuge
    ? Infinity
    : Math.max(1, ...heroes.map(heroShaLimit)) + player.flags.shaLimitBonus;
  const canSha = player.flags.shaCountThisTurn < maxSha;
  // 刘琦·问计标记的那张实体牌「无使用次数限制」——按**牌**放行（见下面循环里的要杀分支）
  const legalCardIds: string[] = [];
  const seen = new Set<string>();
  for (const card of noCards ? [] : usable) {
    if (seen.has(card.id)) continue;
    // 「田」不是手牌：只能通过【急袭】当【顺手牵羊】用，其余用法一律不给（见 isTianCard）
    if (isTianCard(card)) {
      const canShunshouViaTian =
        canUseAsCard(state, player, card, 'shunshou') &&
        state.players.some(
          (p) =>
            p.alive &&
            p.seatId !== seatId &&
            (heroIgnoresTrickDistance(heroes, player) || distance(state, seatId, p.seatId) <= 1),
        );
      if (canShunshouViaTian) {
        legalCardIds.push(card.id);
        seen.add(card.id);
      }
      continue;
    }
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
      const noDistance = heroIgnoresTrickDistance(heroes, player); // 黄月英·奇才（+ 夙智的动态标记）
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
            (noDistance || wenjiMarked(player, card.id) || distance(state, seatId, p.seatId) <= 1),
        );
        if (hasTarget) {
          legalCardIds.push(card.id);
          seen.add(card.id);
        }
      }
      continue;
    }
    // 杀（或可转化的红牌 / 鏖战桃当杀）——受出杀上限限制；
    // 被【问计】标记的那一张不受上限约束（但必须是这张牌本身）
    const shaOk = canSha || wenjiMarked(player, card.id);
    if (shaOk && (card.type === 'sha' || canUseAsCard(state, player, card, 'sha'))) {
      legalCardIds.push(card.id);
      seen.add(card.id);
      continue;
    }
    // 【丈八蛇矛】：只要手里还有**另一张**牌凑够两张，任何一张都能当【杀】用，
    // 所以这时候整手牌都是可点的（界面会多给一条「两张手牌当【杀】」的用法）
    if (canSha && canZhangba(player, usable.length)) {
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
    if (isInstantTrick(card) && !isWuxieLike(card)) {
      const trickType = card.type;
      let legal = false;
      if (trickType === 'wuzhong' || trickType === 'taoyuan') {
        legal = true; // 自身 / 全体，无需目标
      } else if (trickType === 'shunshou') {
        legal = state.players.some(
          (p) =>
            p.alive &&
            p.seatId !== seatId &&
            (heroIgnoresTrickDistance(heroes) ||
              wenjiMarked(player, card.id) ||
              distance(state, seatId, p.seatId) <= 1),
        );
      } else if (trickType === 'jiedao') {
        // 需要一个有武器的其他玩家
        legal = state.players.some(
          (p) => p.alive && p.seatId !== seatId && p.equipment.weapon !== null,
        );
      } else if (trickType === 'huoshao') {
        // 下家（可能再加同队列的人）——只要场上还有别人就打得出来
        legal = state.players.some((p) => p.alive && p.seatId !== seatId);
      } else if (trickType === 'xietianzi') {
        // 只有大势力角色能对自己使用
        legal = isBigFaction(state, effectiveFaction(state, player));
      } else if (trickType === 'lutong') {
        // 要有大势力才谈得上「所有大势力/小势力角色」
        legal = bigFactions(state).length > 0;
      } else if (trickType === 'guoanjianbang') {
        // 【固国安邦】：**只对自己使用**，所以只要活着就打得出（不需要目标、也不看有没有别人）
        legal = true;
      } else if (trickType === 'haolingtianxia') {
        // 【号令天下】：要有「体力值不是最少」的角色可指（目标可以包括自己）
        // ⚠️ 不按「能不能成为目标」筛：取消是**成为目标时**才发生的（用户 2026-09-21 口径）
        legal = haolingTargets(state).length > 0;
      } else if (trickType === 'kefuzhongyuan') {
        // 【克复中原】：至少一名角色（可以指自己），只要场上有人就能用
        legal = state.players.some((p) => p.alive);
      } else if (trickType === 'wenheluanwu') {
        // 【文和乱武】：对所有角色（含自己）——场上有人就能用
        legal = state.players.some((p) => p.alive);
      } else if (trickType === 'chiling') {
        // 【敕令】：对所有**没有势力**的角色使用（可能包括你自己）
        legal = chilingTargets(state).length > 0;
      } else if (trickType === 'lianjun') {
        // 【联军盛宴】：要有一个「与你不同、且已有人明置」的其他势力
        legal = state.players.some(
          (p) =>
            p.alive &&
            p.seatId !== seatId &&
            lianjunFactionOk(state, player, p),
        );
      } else if (trickType === 'tiaohu') {
        // 一至两名其他角色（可以只选一个）
        legal = state.players.some((p) => p.alive && p.seatId !== seatId);
      } else if (trickType === 'shuiyan') {
        // 需要一名「装备区里有牌」的其他角色
        legal = state.players.some(
          (p) =>
            p.alive &&
            p.seatId !== seatId &&
            EQUIP_SLOTS.some((s) => p.equipment[s]),
        );
      } else if (trickType === 'tiesuo' || trickType === 'yiyi' || trickType === 'wugu') {
        // 铁索连环可以只选自己；以逸待劳含自己；五谷丰登是全体
        legal = true;
      } else if (trickType === 'yuanjiao') {
        // 需要一名「**已确定势力**与你不同」的其他角色（与结算处的口径一致：暗置不算势力）
        const myFaction = effectiveFaction(state, player);
        legal =
          myFaction !== null &&
          state.players.some(
            (p) =>
              p.alive &&
              p.seatId !== seatId &&
              effectiveFaction(state, p) !== null &&
              effectiveFaction(state, p) !== myFaction,
          );
      } else {
        // 决斗 / 火攻 / 过河拆桥 / 知己知彼：只要有一个其他存活玩家就能用 ——
        // 帷幕/空城那类是「成为目标时取消之」，不是「选不了他」（用户 2026-09-21 口径）。
        legal = state.players.some((p) => p.alive && p.seatId !== seatId);
      }
      if (legal) {
        legalCardIds.push(card.id);
        seen.add(card.id);
      }
    }
    // 转化即时锦囊（甘宁·奇袭：黑色牌当过河拆桥；卧龙诸葛亮·火计：红色牌当火攻；
    // 颜良文丑·双雄：与判定牌异色的手牌当【决斗】）
    for (const it of ['guohe', 'huogong', 'juedou'] as const) {
      if (seen.has(card.id)) break;
      if (!canUseAsCard(state, player, card, it)) continue;
      const legal = state.players.some((p) => p.alive && p.seatId !== seatId);
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
          (noDistance || wenjiMarked(player, card.id) || distance(state, seatId, p.seatId) <= 1),
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
    // 连横标记（势备篇）：有合法目标时，这张牌即使本身不能「使用」（例如【闪】）
    // 也点得动——「连横」是它的另一种用法。
    if (!seen.has(card.id) && card.lianheng && lianhengTargets(state, player).length > 0) {
      legalCardIds.push(card.id);
      seen.add(card.id);
    }
  }
  // 不能成为目标的角色（调虎离山）也不该出现在可点目标里
  const legalTargetIds = state.players
    .filter((p) => p.alive && p.seatId !== seatId && !p.flags.cannotBeTargetThisTurn)
    .map((p) => p.seatId);
  // 可用主动技能：武将主动技 + 标记技能
  const legalSkillIds: string[] = [];
  const legalSkills: { id: string; name: string; desc: string }[] = [];
  // 国战：暗置武将的主动技也列出来——点了就等于「明置该武将 + 发动」
  // （规则：发动技能时必须明置该武将）。技能说明要连暗置的武将一起找。
  const darkHeroes = state.mode === 'guozhan' ? unrevealedHeroes(state.mode, player) : [];
  const descPool = [...heroes, ...darkHeroes];
  const skills: ActiveSkill[] = [
    ...heroes.flatMap((h) => h.activeSkills ?? []),
    ...darkHeroes.flatMap((h) => h.activeSkills ?? []),
    ...markerActiveSkills(state, player),
    ...equipActiveSkills(state, player),
    // 黄天（张角·群势力技）：**别人**的出牌阶段多出来的一条操作
    ...huangtianFor(state, player),
    // 眩惑（法正·反向技）：同势力角色的出牌阶段多出来的一条操作
    ...xuanhuoFor(state, player),
    // 督授（君孙权）：同势力角色的出牌阶段多出来的一条操作（提供者必须是已明置的君主）
    ...factionGrantedActiveSkills(state, player),
  ];
  for (const skill of skills) {
    if (
      skill.canUse(state, player) &&
      !(skill.oncePerTurn && player.flags.skillUsedThisTurn[skill.id]) &&
      !(skill.perPhaseLimit && (player.flags.skillUsesThisPhase[skill.id] ?? 0) >= skill.perPhaseLimit) &&
      !(skill.oncePerGame && player.usedOncePerGame[skill.id])
    ) {
      legalSkillIds.push(skill.id);
      legalSkills.push({ id: skill.id, name: skill.name, desc: skillDescFor(descPool, skill) });
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
    // 连横的合法目标（与具体哪张牌无关，整个出牌阶段只算一次）
    lianhengTargets: lianhengTargets(state, player),
    // 【丈八蛇矛】此刻能不能把两张手牌当【杀】用（能的话界面会多给一条用法）
    zhangbaOk: canSha && canZhangba(player, usable.length),
  };
}

/**
 * 【丈八蛇矛】：装备着它、且手里（含木牛流马的辎）至少有 2 张牌时，
 * 任意两张都能当【杀】使用或打出。
 */
function canZhangba(player: Player, usableCount: number): boolean {
  return player.equipment.weapon?.equipName === 'zhangba' && usableCount >= 2;
}

/** 手里有【丈八蛇矛】时，在「需打出【杀】」的提示后面补一句怎么用 */
function zhangbaHint(player: Player): string {
  return canZhangba(player, usableCardsOf(player).length)
    ? '（可用【丈八蛇矛】把两张手牌当【杀】）'
    : '';
}

/**
 * 响应「需打出某种牌」时的合法牌。
 * `need === 'sha'` 且装备着【丈八蛇矛】时，**任何两张**牌都能凑成【杀】，所以整手牌都可点。
 */
function respondCandidates(state: GameState, player: Player, need: CardType): string[] {
  // 「田」不能当手牌响应（见 handLikeOf）
  const cards = handLikeOf(player);
  if (need === 'sha' && canZhangba(player, cards.length)) return cards.map((c) => c.id);
  return cards
    .filter((c) => c.type === need || canUseAsCard(state, player, c, need))
    .map((c) => c.id);
}

/**
 * 取主动技能的说明文字。
 *
 * 武将主动技的说明写在 hero.skills 里、按**技能名**对应（这是仓库既有约定）；
 * 标记技能不属于任何武将，改查 MARKER_DESC。
 * 界面不再自己配对——那份配对逻辑只留在这里一处。
 */
function skillDescFor(heroes: Hero[], skill: ActiveSkill): string {
  // 技能自带说明的优先（借来的技能——黄天/眩惑——不在使用者自己的武将牌上，查不到）
  if (skill.desc) return skill.desc;
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
  const legalCardIds = handLikeOf(player)
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
    legalCardIds: respondCandidates(state, player, pending.needType),
    legalTargetIds: [],
    mustSelectTargetCount: 0,
    ...(pending.needType === 'sha' && canZhangba(player, usableCardsOf(player).length)
      ? { zhangbaOk: true }
      : {}),
  };
}

function buildRespondDeathPrompt(state: GameState, seatId: string, dyingId: string): PromptView {
  const player = getPlayerOrThrow(state, seatId);
  const dying = getPlayerOrThrow(state, dyingId);
  // 接受【桃】/【酒】，或武将可转化的红牌（华佗·急救：红牌当桃）
  const legalCardIds = handLikeOf(player)
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
      legalCardIds: respondCandidates(state, player, 'sha'),
      legalTargetIds: [],
      mustSelectTargetCount: 0,
      zhangbaOk: canZhangba(player, usableCardsOf(player).length),
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
          : `【决斗】：打出【杀】或弃权（受 1 点伤害）${zhangbaHint(player)}`;
      legalCardIds = respondCandidates(state, player, 'sha');
      break;
    }
    case 'huogong':
      if (!ctx.revealedSuit) {
        message = `【火攻】：展示一张手牌或弃权`;
        legalCardIds = player.hand.map((c) => c.id);
      } else {
        message = `【火攻】：弃一张${ctx.revealedSuit === 'heart' || ctx.revealedSuit === 'diamond' ? '红色' : '黑色'}${ctx.revealedSuit}花色手牌，或弃权`;
        // 按**出牌人**的口径比花色（小乔·红颜：她的黑桃视为红桃）
        legalCardIds = player.hand
          .filter((c) => suitSeenAs(state, player, c) === ctx.revealedSuit)
          .map((c) => c.id);
      }
      break;
    case 'jiedao':
      message = `【借刀杀人】：打出【杀】或弃权（交出武器）${zhangbaHint(player)}`;
      legalCardIds = respondCandidates(state, player, 'sha');
      break;
    case 'nanman':
      message = `【南蛮入侵】：打出【杀】或弃权（受 1 点伤害）${zhangbaHint(player)}`;
      legalCardIds = respondCandidates(state, player, 'sha');
      break;
    case 'wanjian':
      message = `【万箭齐发】：打出【闪】或弃权（受 1 点伤害）`;
      legalCardIds = handLikeOf(player)
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
    // 这一轮要打出的是【杀】时，装备着丈八蛇矛的人可以拿两张手牌顶一张
    ...(respondNeedType(ctx) === 'sha' && canZhangba(player, usableCardsOf(player).length)
      ? { zhangbaOk: true }
      : {}),
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
  // 链上已经有前一环时，这张无懈是**抵消上一张无懈**（效果恢复），提示要说清
  const countering = !!ctx.wuxieChain && ctx.wuxieChain.count > 0;
  // 逐目标的窗口：说清「现在轮到谁生效」，否则玩家不知道自己在拦谁
  const currentSeat =
    ctx.responders.length > 0
      ? ctx.responders[ctx.responderIndex]
      : (ctx.targetIds?.[0] ?? ctx.targetId);
  const currentName = currentSeat ? getPlayer(state, currentSeat)?.name : undefined;
  const message = countering
    ? `是否使用【无懈可击】抵消上一张【无懈可击】？（【${trickName}】的效果将恢复）`
    : `是否使用【无懈可击】抵消【${trickName}】对${
        currentName ? ` ${currentName} ` : '某名角色'
      }的效果？（之后别人还能再抵消这一张）`;
  return {
    kind: 'wuxieQueue',
    message,
    // 卧龙诸葛亮·看破：黑色手牌当【无懈可击】
    legalCardIds: handLikeOf(player)
      .filter((c) => isWuxieLike(c) || canUseAsCard(state, player, c, 'wuxie'))
      .map((c) => c.id),
    legalTargetIds: [],
    mustSelectTargetCount: 0,
  };
}
