import type { Card, PlayerView, Snapshot } from '@sgs/protocol';
import { MARKER_NAME, MARKER_ORDER } from '@sgs/protocol';
import type { GameState, Player } from './model';
import { getPlayer } from './model';
import { buildPrompt } from './legal';

function toPlayerView(p: Player, viewerSeatId: string, state: GameState): PlayerView {
  const isMe = p.seatId === viewerSeatId;
  const isLord = p.role === 'lord';
  // 国战：暗将时他人看不到武将名和阵营；阵亡/游戏结束后全亮
  const isGuozhan = state.mode === 'guozhan';
  const showMain =
    isMe || !isGuozhan || p.heroRevealed || !p.alive || state.gameOver;
  const showDeputy =
    isMe || !isGuozhan || p.deputyRevealed || !p.alive || state.gameOver;
  const showFaction =
    isMe ||
    !isGuozhan ||
    p.heroRevealed ||
    p.deputyRevealed ||
    !p.alive ||
    state.gameOver;
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
    hp: Math.max(0, p.hp),
    maxHp: p.maxHp,
    handCount: p.hand.length,
    isAlive: p.alive,
    equipment: [
      p.equipment.weapon,
      p.equipment.armor,
      p.equipment.plusMount,
      p.equipment.minusMount,
    ].filter(Boolean) as Card[],
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
