import type { Player } from './model';
import type { GameState } from './model';
import { getPlayer, getPlayerOrThrow } from './model';
import { effectiveHeroes } from './heroes';

/**
 * 基础距离：圆桌上从 fromId 到 toId 的最短座次距。
 * 只计算存活玩家——阵亡者从环中移除。
 */
export function baseDistance(state: GameState, fromId: string, toId: string): number {
  const alive = state.seatOrder.filter((id) => getPlayer(state, id)?.alive);
  const n = alive.length;
  if (n <= 1) return 0;
  const fromIdx = alive.indexOf(fromId);
  const toIdx = alive.indexOf(toId);
  if (fromIdx < 0 || toIdx < 0) return Infinity;
  const diff = Math.abs(fromIdx - toIdx);
  return Math.min(diff, n - diff);
}

/**
 * 实际距离 = 基础距离 − from的−1马(进攻马) + to的+1马(防御马) − from的距离修正。
 * 距离修正是锁定技（马超·马术：你计算与其他角色的距离-1），国战暗将不算。
 */
export function distance(state: GameState, fromId: string, toId: string): number {
  let d = baseDistance(state, fromId, toId);
  const from = getPlayer(state, fromId);
  const to = getPlayer(state, toId);
  if (from?.equipment.minusMount) d -= 1;
  if (to?.equipment.plusMount) d += 1;
  if (from) {
    for (const hero of effectiveHeroes(state, from)) {
      d -= hero.distanceFrom ?? 0;
    }
  }
  return Math.max(0, d);
}

/** 攻击范围 = 1 + 武器 range */
export function attackRange(player: Player): number {
  const weapon = player.equipment.weapon;
  return 1 + (weapon?.range ?? 0);
}

/** from 能否攻击到 to：攻击范围 ≥ 距离 */
export function canTarget(state: GameState, fromId: string, toId: string): boolean {
  const from = getPlayerOrThrow(state, fromId);
  return attackRange(from) >= distance(state, fromId, toId);
}
