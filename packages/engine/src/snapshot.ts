import type { PlayerView, Snapshot } from '@sgs/protocol';
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
    hp: Math.max(0, p.hp),
    maxHp: p.maxHp,
    handCount: p.hand.length,
    isAlive: p.alive,
    equipmentCount: p.equipment.length,
    judgmentCount: p.judgment.length,
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
