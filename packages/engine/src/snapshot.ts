import type { Card, PlayerView, Snapshot } from '@sgs/protocol';
import { MARKER_NAME, MARKER_ORDER } from '@sgs/protocol';
import { getHeroForMode } from './heroes';
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
  return {
    seatId: p.seatId,
    name: p.name,
    heroId: showMain ? p.heroId : null,
    deputyHeroId: showDeputy ? p.deputyHeroId : null,
    faction: showFaction ? p.faction : null,
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
    qianhuanCount: p.qianhuan.length,
    hunCount: p.hun.length,
    // 「创」（周泰·不屈）也是公开信息：牌就扣在武将牌上
    wounds: p.wounds.slice(),
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
  };
}
