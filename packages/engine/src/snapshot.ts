import type { PlayerView, Snapshot } from '@sgs/protocol';
import type { GameState, Player } from './model';
import { getPlayer } from './model';
import { buildPrompt } from './legal';

function toPlayerView(p: Player): PlayerView {
  return {
    seatId: p.seatId,
    name: p.name,
    heroId: p.heroId,
    hp: Math.max(0, p.hp),
    maxHp: p.maxHp,
    handCount: p.hand.length,
    isAlive: p.alive,
    equipmentCount: p.equipment.length,
    judgmentCount: p.judgment.length,
  };
}

/**
 * 把权威状态按玩家裁剪成下发的快照。
 * 他人手牌只暴露数量，本人手牌完整下发。
 */
export function toSnapshot(state: GameState, seatId: string): Snapshot {
  const me = getPlayer(state, seatId);
  const turnSeat = state.seatOrder[state.turn.seatIndex]!;
  return {
    seatId,
    roomCode: state.roomCode,
    started: state.started,
    players: state.players.map(toPlayerView),
    myHand: me ? me.hand.slice() : [],
    turn: { seatId: turnSeat, phase: state.turn.phase },
    prompt: buildPrompt(state, seatId),
    log: state.log.slice(-50),
  };
}
