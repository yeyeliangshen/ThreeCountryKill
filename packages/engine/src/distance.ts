import type { Player } from './model';
import type { GameState } from './model';
import { getPlayer, getPlayerOrThrow } from './model';
import {
  biluanAgainst,
  effectiveFaction,
  effectiveHeroes,
  hasFeiying,
  unrevealedHeroes,
} from './heroes';

/**
 * 基础距离：圆桌上从 fromId 到 toId 的最短座次距。
 * 只计算存活玩家——阵亡者从环中移除。
 */
export function baseDistance(state: GameState, fromId: string, toId: string): number {
  // 「不计入座次」的角色也从环里去掉（调虎离山）：那样他与别人之间距离为 Infinity，
  // 等价于「不能成为目标、也不能用牌够到他」。
  const alive = state.seatOrder.filter((id) => {
    const p = getPlayer(state, id);
    return p?.alive && !p.flags.removedFromSeating;
  });
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
  const from = getPlayer(state, fromId);
  // 丁奉·奋迅：本回合「你至其的距离视为 1」。这是**覆盖**，所以要在马匹/马术之前返回。
  if (from?.flags.distanceToOneThisTurn === toId) return 1;
  // 崔琰毛玠·征辟①：本回合对其「使用牌无距离限制」——同样在距离这一层直接放行。
  // 目标明置武将牌后就失效（惰性判断：他还得有暗置武将牌）。
  if (from?.flags.distanceLimitlessToSeat === toId) {
    const target = getPlayer(state, toId);
    if (target && unrevealedHeroes(state.mode, target).length > 0) return 1;
  }
  let d = baseDistance(state, fromId, toId);
  const to = getPlayer(state, toId);
  if (from?.equipment.minusMount) d -= 1;
  // 【六龙骖驾】（君主将专属宝物）：你计算与其他角色的距离 -3。
  // 与 −1马 同一根轴（都算「进攻距离」），只是数值更大；据用户提供的牌面文本实现。
  if (from?.equipment.treasure?.equipName === 'liulong') d -= 3;
  if (to?.equipment.plusMount) d += 1;
  // 飞影（曹洪·鹤翼授予同队列者）：别人计算与他的距离 +1
  if (to && hasFeiying(state, to)) d += 1;
  // 士燮·避乱（锁定技）：**别人**计算与士燮的距离 +X（X＝其装备区牌数，至少 1）——单向
  if (to) d += biluanAgainst(state, to);
  if (from) {
    for (const hero of effectiveHeroes(state, from)) {
      d -= hero.distanceFrom ?? 0;
      // 邓艾·屯田：「你计算与其他角色的距离 -X，X 为『田』的数量」
      if (hero.distanceMinusPerTian === true) d -= from.tian.length;
    }
  }
  // ⚠️ **距离下限是 1**（用户 2026-09-21 的口径，也是官方基本规则）：修正再多也不能把距离压到 0。
  //    以前写的是 `Math.max(0, d)` —— 有田/马术的邓艾算「距离最近的另一名角色」时，
  //    原本距离 1 的人会被压成 0 而**独占**最近，把原本并列的人挤出去（乱武选目标就会错）。
  //    对「距离≤1」那类检查（顺手牵羊/兵粮）两种下限等价，但 `=== 1` 那类判断会漏人。
  return Math.max(1, d);
}

/**
 * 攻击范围：**空手 1，装备武器就等于武器牌上印的那个数**（方天画戟 4、青龙偃月刀 3、
 * 诸葛连弩 1…）。与【距离】是两回事：−1马/马术改的是距离，不改攻击范围。
 *
 * ⚠️ 这里以前写的是「1 + 武器 range」，等于给每把武器凭空 +1（连弩变成 2、麒麟弓变成 6），
 *    杀能多够到一个人、潘濬·【公清】的 <3 / =3 / >3 三档也会整体错位。牌堆里存的就是
 *    官方攻击范围（见 deck.ts 的 方天画戟 range: 4），所以直接取它即可。
 */
export function attackRange(state: GameState, player: Player): number {
  const weapon = player.equipment.weapon;
  let range = weapon?.range ?? 1;
  // 吴六剑（锁定技）：与你**势力相同**的其他角色攻击范围 +1。
  // 「势力」用 effectiveFaction——暗置的角色没有势力，也就不享受这个加成。
  // 注意是攻击范围 +1，不是距离 -1（不影响顺手牵羊/兵粮寸断的距离判定）。
  const myFaction = effectiveFaction(state, player);
  if (myFaction) {
    const allyHasWuliu = state.players.some(
      (p) =>
        p.alive &&
        p.seatId !== player.seatId &&
        p.equipment.weapon?.equipName === 'wuliu' &&
        effectiveFaction(state, p) === myFaction,
    );
    if (allyHasWuliu) range += 1;
  }
  return range;
}

/** from 能否攻击到 to：攻击范围 ≥ 距离 */
export function canTarget(state: GameState, fromId: string, toId: string): boolean {
  const from = getPlayerOrThrow(state, fromId);
  return attackRange(state, from) >= distance(state, fromId, toId);
}
