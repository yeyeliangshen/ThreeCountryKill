import type { Card, PlayerView, Snapshot } from '@sgs/protocol';
import { MARKER_NAME, MARKER_ORDER } from '@sgs/protocol';
import {
  effectiveFaction,
  formationQueue,
  getHeroForMode,
  hasTianfu,
  publicGender,
  tianfuModeOf,
} from './heroes';
import type { GameState, Player } from './model';
import { getPlayer } from './model';
import { buildPrompt } from './legal';
import { prelitableSkills } from './engine';

/**
 * 扣置牌（【木牛流马】下的「辎」）对**非持有者**只暴露张数。
 *
 * 返回的是一份浅拷贝，不会动引擎里的真牌。
 */
function hideCargo(card: Card, isOwner: boolean): Card {
  if (isOwner || !card.cargo || card.cargo.length === 0) return card;
  const { cargo, ...rest } = card;
  return { ...rest, cargoCount: cargo.length } as Card;
}

function toPlayerView(p: Player, viewerSeatId: string, state: GameState): PlayerView {
  const isMe = p.seatId === viewerSeatId;
  const isLord = p.role === 'lord';
  // 国战：暗将时他人看不到武将名和阵营；阵亡/游戏结束后全亮
  const isGuozhan = state.mode === 'guozhan';
  const showMain = isMe || !isGuozhan || p.heroRevealed || !p.alive || state.gameOver;
  const showDeputy = isMe || !isGuozhan || p.deputyRevealed || !p.alive || state.gameOver;
  const showFaction =
    isMe || !isGuozhan || p.heroRevealed || p.deputyRevealed || !p.alive || state.gameOver;
  // 当前**公开**性别（♂/♀；全暗置＝未确定 ⇒ 不给字段）。判据只有 heroes.publicGender 一处，
  // 界面拿它画标记、离间的可点目标也按它算——谁都不许去翻暗将底牌猜性别。
  const genderOf = publicGender(state, p);
  return {
    seatId: p.seatId,
    name: p.name,
    heroId: showMain ? p.heroId : null,
    deputyHeroId: showDeputy ? p.deputyHeroId : null,
    // 「当前所属势力」（用户 2026-09-21：看别人时要显示他现在属于哪个势力）：
    // 别人看到的是**已确定势力**——两将全暗 = 未确定（null）、只亮副将的野心家 = 暂时按副将的
    // 势力、野心家主将明置后 = 野心家（见 effectiveFaction）。本人那一份仍给后台真实势力，
    // 免得自己的面板在暗置时没有势力可显示（自己知道自己是什么势力，不是泄露）。
    faction: showFaction ? (isMe ? p.faction : effectiveFaction(state, p)) : null,
    heroRevealed: p.heroRevealed,
    deputyRevealed: p.deputyRevealed,
    // 国战标记是公开信息；只下发持有数量 > 0 的，免得界面渲染一堆 0。
    // 按 MARKER_ORDER 排序，保证同一份状态每次下发的顺序一致。
    markers: MARKER_ORDER.filter((id) => (p.markers[id] ?? 0) > 0).map((id) => ({
      id,
      label: MARKER_NAME[id],
      count: p.markers[id]!,
    })),
    flipped: p.flipped,
    chained: p.chained,
    // 断肠点名的武将牌：**公开信息**（失去技能是明面上的事），所有人看得到
    nullifiedHeroId: p.nullifiedHeroId,
    removedHeroIds: p.removedHeroIds.slice(),
    // 「田」「千幻」都是扣在武将牌上的牌，公开信息
    tianCount: p.tian.length,
    // 国战【空城】的暂存牌：张数公开、内容暗（只下发数量）
    kongchengCount: p.kongcheng.length,
    qianhuanCount: p.qianhuan.length,
    hunCount: p.hun.length,
    // 「魂」的具体是哪几张武将牌：**只给持有者本人**（别人只知道数量）——
    // 左慈的「役鬼」要由他本人挑移去哪张，界面上也得让他看得到自己的魂区。
    ...(isMe
      ? { hunNames: p.hun.map((id) => getHeroForMode(id, state.mode)?.name ?? id) }
      : {}),
    // 队列（公开信息）：与天覆/鸟翔/鹤翼同一份判据
    inFormation: formationQueue(state, p).length >= 2,
    // 本回合被【调虎离山】移出座次（公开状态，见 protocol 的字段说明）
    ...(p.flags.removedFromSeating ? { removedFromSeating: true } : {}),
    // 当前公开性别（♂/♀；全暗置＝性别未确定 ⇒ 不给这个字段）
    ...(publicGender(state, p) ? { gender: publicGender(state, p)! } : {}),
    // 【天覆】的形态只发给本人（技能栏里的说明要跟着变）
    ...(isMe && hasTianfu(state, p) ? { tianfuMode: tianfuModeOf(state, p) } : {}),
    // 「创」（周泰·不屈）也是公开信息：牌就扣在武将牌上
    wounds: p.wounds.slice(),
    han: p.han.slice(),
    yi: p.yi.slice(),
    // 界钟会·权（实体牌）与孙綝·戮（武将牌：数量 + 牌名）
    quan: p.quan.slice(),
    // 陆逊（国战）·谦逊收下的「节」：扣在武将牌上的实体牌，公开信息（度势要看张数）
    jie: p.jie.slice(),
    luCount: p.lu.length,
    luNames: p.lu.map((e) => getHeroForMode(e.heroId, state.mode)?.name ?? e.heroId),
    // 双雄的判定牌颜色：也是公开的（判定牌大家都看到了），界面据此给出「当【决斗】使用」
    shuangxiongColor: p.flags.shuangxiongColor,
    // 预亮是对手看不到的信息，只放进本人的那一份快照
    ...(isMe
      ? {
          prelitSkills: p.prelitSkills.slice(),
          prelitableSkills: prelitableSkills(state, p).map((x) => x.name),
          // 【荐才】（徐庶）获知的未登场同势力武将牌：**私有信息**，只随本人那一份快照下发
          knownHeroes: p.knownHeroIds.map((id) => ({
            id,
            name: getHeroForMode(id, state.mode)?.name ?? id,
          })),
        }
      : {}),
    hp: Math.max(0, p.hp),
    maxHp: p.maxHp,
    handCount: p.hand.length,
    isAlive: p.alive,
    // 【木牛流马】下面扣置的牌是**暗信息**：只有持有者看得到内容，
    // 别人只看到张数（`cargoCount`）。扣置牌被使用/打出离开扣置区后才公开。
    equipment: [
      p.equipment.weapon,
      p.equipment.armor,
      p.equipment.plusMount,
      p.equipment.minusMount,
      p.equipment.treasure,
    ]
      .filter(Boolean)
      .map((c) => hideCargo(c as Card, isMe)) as Card[],
    judgment: p.judgment.slice(),
    // 身份：主公公开；阵亡后亮身份；游戏结束全员亮身份；其余仅本人可见
    role: isMe || isLord || !p.alive || state.gameOver ? p.role : null,
    // 队伍：2v2 公开，其余模式为 null
    team: state.mode === '2v2' ? p.team : null,
  };
}

/**
 * 把权威状态按玩家裁剪成下发的快照。
 * 他人手牌只暴露数量，本人手牌完整下发。
 * 身份（军争）：主公对所有人公开，其余仅本人可见。
 */
export function toSnapshot(state: GameState, seatId: string): Snapshot {
  const me = getPlayer(state, seatId);
  const turnSeat = state.seatOrder[state.turn.seatIndex]!;
  return {
    seatId,
    roomCode: state.roomCode,
    started: state.started,
    mode: state.mode,
    players: state.players.map((p) => toPlayerView(p, seatId, state)),
    myHand: me ? me.hand.slice() : [],
    turn: { seatId: turnSeat, phase: state.turn.phase },
    prompt: buildPrompt(state, seatId),
    winner: state.winner,
    log: state.log.slice(-50),
    // 拼点区（公开信息，两边一样）：进行中只有「谁扣好了」，双方扣好之后才有牌面/点数/胜负——
    // 牌面**由服务端把关**（`pindianView` 里 revealed 之前压根不写 card 字段）
    pindian: state.pindianView ?? null,
    // 牌桌上公开摆着的牌池（【五谷丰登】）：整份公开，但「我能不能点」按**观看者**算——
    // 规则层决定「谁现在可以操作」，界面不猜（与盲选同一条分工）。
    // ⚠️ 判据是「**这一格现在真的握着那张选牌询问**」，不是「轮到我了」：轮到某人时他可能还在
    //    处理自己的无懈窗口（那会儿点牌是无效操作）。所以这里直接看 pending。
    publicPool: state.publicPool
      ? {
          ...state.publicPool,
          interactive:
            state.pending?.kind === 'pickCards' &&
            state.pending.fromPool === true &&
            state.pending.seatId === seatId,
        }
      : null,
    // 属性伤害这次沿连环角色传导的**顺序**（用户 2026-09-24 口径④）：源头 + 按顺序的名单。
    // 顺序只有引擎知道（见 `queueChainSpread` / `chainStep`），界面照 index 排动画。
    // 只带座次与序号，不带牌面。
    chain: state.chainView ?? null,
    // 「刚发动 / 刚触发的技能」（用户 2026-09-25 口径①~④）：界面据此在**那个角色附近**浮现技能名，
    // 点开看完整描述。写入点是 `pushLog`（`kind === 'skill'` 且此刻有技能身份，
    // 见 model.ts 的 `withSkillCtx` / `announceSkill`）——**不认牌、不认武将**，
    // 也不带任何武将牌信息，所以暗将的技能不会因为这条提示泄露。
    // `settling` 一并下发：别人的询问不在我的 `prompt` 里，界面只能靠它判断「要不要保持提示」。
    skillFx: state.skillFx ?? null,
  };
}
