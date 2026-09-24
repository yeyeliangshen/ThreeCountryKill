/**
 * **先手确定**（用户 2026-09-23 报的缺陷）。
 *
 * 缺陷原文：「游戏开局固定由 1 号位开始行动……不应在引擎中将某个固定座位硬编码为先手。
 * 开局时应先按照模式规则确定本局先手玩家，再以该玩家开始第一个回合，之后按照正常座次
 * 顺序依次行动。」要重点检查的正是这一条：**「1 号位」到底是本局随机定出来的先手，
 * 还是被写死的座位。**
 *
 * 改动前的实现就是写死的：`let firstSeat = 0`（只有军争例外，走主公）⇒ 房主（座次 0）
 * 永远先手。现在：
 *   · 军争（身份局）→ **主公**先手（官方规则，行为不变）；
 *   · 国战等其余模式 → 本局**随机**一名角色先手（随机源 `state.rng`：生产是
 *     `Math.random`，测试给固定种子就能复现）。
 *
 * ⚠️ 定先手的时机是**选将结束**（`finishDraft`），所以用例都必须真跑一遍选将
 * （直接 `state.draft = null` 跳过去的话，那段逻辑根本不会执行）。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, nextAliveSeat, toSnapshot, type GameState } from '../src';
import { rng } from './fuzzHarness';

const seatsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ seatId: `s${i}`, name: `P${i}` }));

/** 国战 4 人局：跑完选将（每人一组固定搭配），返回定好先手的状态 */
function gzDone(seed: number, opts: { firstSeat?: string } = {}) {
  const state = createGame(seatsOf(4), `FS${seed}`, {
    mode: 'guozhan',
    freePick: true,
    rng: rng(seed * 7919 + 13),
    ...opts,
  });
  const pairs: [string, string][] = [
    ['guanyu', 'zhangfei'],
    ['xuchu', 'zhenji'],
    ['lvbu', 'diaochan'],
    ['sunquan', 'zhouyu'],
  ];
  state.seatOrder.forEach((seatId, i) => {
    const [heroId, deputyHeroId] = pairs[i]!;
    applyIntent(state, seatId, { type: 'pickHero', heroId, deputyHeroId });
  });
  return state;
}

const firstSeatOf = (seed: number): number => gzDone(seed).turn.seatIndex;

describe('先手：国战不写死「座次 0」', () => {
  it('同一颗种子必须复现同一个先手（用的是 state.rng，不是直连 Math.random）', () => {
    for (const seed of [1, 2, 7, 23, 101]) {
      expect(firstSeatOf(seed)).toBe(firstSeatOf(seed));
    }
  });

  it('换种子会换先手：存在不是座次 0 的先手（旧实现恒为 0，这条会红）', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) seen.add(firstSeatOf(seed));
    expect(seen.size).toBeGreaterThan(1);
    expect([...seen].some((i) => i !== 0)).toBe(true);
  });

  it('40 颗种子下四个座位都当过先手（不是「只在 0/1 之间抖」）', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) seen.add(firstSeatOf(seed));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  it('随机的是「先手」，不是「座次表」：座次表原样，之后按座次依次推进', () => {
    // 先找到一颗「先手不是 0」的种子，保证这条用例真的在考随机结果
    const seed = [...Array(60).keys()].map((s) => s + 1).find((s) => firstSeatOf(s) !== 0)!;
    const state = gzDone(seed);
    const first = state.turn.seatIndex;
    expect(first).not.toBe(0); // 随机落到了非 0 座位……
    expect(state.seatOrder).toEqual(['s0', 's1', 's2', 's3']); // ……但座次表没被动过
    expect(state.turn.phase).toBe('prepare'); // 「以该玩家开始第一个回合」
    // 座次顺序照旧：下一个行动的是它的下家（到底后绕回 s0）
    expect(nextAliveSeat(state, first)).toBe((first + 1) % 4);
    expect(nextAliveSeat(state, 3)).toBe(0);
  });
});

describe('先手：军争（身份局）仍旧由主公开始', () => {
  it('5 人军争，先手恒为主公（不受随机影响）', () => {
    for (const seed of [3, 11, 29, 77]) {
      const state = createGame(seatsOf(5), 'JZ', {
        mode: 'junzheng',
        // freePick：军争发将也是按座位分的，不开这个的话 'guanyu' 可能不在某人的将里 ⇒
        // 选将卡住不结束 ⇒ 根本走不到定先手那一步
        freePick: true,
        rng: rng(seed * 31 + 5),
      });
      state.seatOrder.forEach((seatId) =>
        applyIntent(state, seatId, { type: 'pickHero', heroId: 'guanyu' }),
      );
      const lord = state.players.find((p) => p.role === 'lord')!;
      expect(state.seatOrder[state.turn.seatIndex]).toBe(lord.seatId);
    }
  });
});

describe('先手：显式指定（测试与工具的口子）', () => {
  it('opts.firstSeat 指定谁就谁先手，且照样按座次推进', () => {
    const state = gzDone(7, { firstSeat: 's2' });
    expect(state.seatOrder[state.turn.seatIndex]).toBe('s2');
    expect(nextAliveSeat(state, state.turn.seatIndex)).toBe(3);
  });

  it('opts.firstSeat 写了不存在的座位 → 选将结束时直接报错（不静默退回默认）', () => {
    expect(() => gzDone(7, { firstSeat: 'nobody' })).toThrow(/firstSeat 不是本局座位/);
  });
});

/**
 * 「一轮」的边界也要跟着先手走。
 *
 * ⚠️ 这条是**同一处缺陷的连带隐藏假设**：判新一轮的条件原来写成 `next < current`，
 * 那等价于把「座次 0」当成每轮的起点。先手变随机之后，从座次 2 开局的牌局走完一圈
 * （2→3→0→1→2）时 `next`(2) > `current`(1) ⇒ **判不出新一轮**，`round` 不再 +1，
 * 靠「每轮结束/每轮开始」结算的东西（君主·励众、徐庶·荐才）就整局不触发。
 * 现在按 `roundStartSeat` 相对算，起点在哪都行。
 */
describe('先手：一轮的边界相对先手座位算，不写死座次 0', () => {
  /**
   * 全员「消极」推进：出牌阶段直接结束、弃牌按上限丢、其余一律弃权／选第一项。
   * 分支是照着 `fuzzHarness.step` 抄的（那边是跑了 200 局的老代码，pending 的种类它最全），
   * 只把随机选择换成保守选择——本用例要的是**回合按座次推进**，不要随机出牌。
   */
  function passStep(state: GameState): boolean {
    const p = state.pending;
    if (!p) return false;
    switch (p.kind) {
      case 'play':
        return applyIntent(state, p.seatId, { type: 'endPhase' }).ok;
      case 'choice':
        return applyIntent(state, p.seatId, { type: 'chooseOption', optionId: p.options[0]!.id })
          .ok;
      case 'pickCards':
        return applyIntent(state, p.seatId, {
          type: 'pickCards',
          cardIds: p.cards.slice(0, p.min).map((c) => c.id),
        }).ok;
      case 'viewCards':
        return applyIntent(state, p.seatId, { type: 'ack' }).ok;
      case 'discard':
        return applyIntent(state, p.seatId, {
          type: 'discard',
          cardIds: toSnapshot(state, p.seatId)
            .myHand.slice(0, p.count)
            .map((c) => c.id),
        }).ok;
      case 'respondSha':
      case 'respondTrick':
        return applyIntent(state, p.responderId, { type: 'pass' }).ok;
      case 'respondDeath':
      case 'wuxieQueue':
      case 'factionCall':
        return applyIntent(state, p.askQueue[p.askIndex]!, { type: 'pass' }).ok;
      default:
        return false;
    }
  }

  /** 记录每一回合的「行动座位 + 当时的轮号」 */
  function walkTurns(state: GameState, steps: number) {
    const trace: { seat: string; round: number }[] = [
      { seat: state.seatOrder[state.turn.seatIndex]!, round: state.round },
    ];
    for (let i = 0; i < steps && !state.gameOver; i++) {
      const before = state.turn.seatIndex;
      let guard = 0;
      // 同一个回合里可能要答好几个 prompt（摸牌、出牌、弃牌），一直答到回合交出去
      while (state.pending && guard++ < 40 && state.turn.seatIndex === before) {
        if (!passStep(state)) {
          throw new Error(
            `推进失败：阶段=${state.turn.phase} pending=${state.pending?.kind} 座位=${state.seatOrder[before]}`,
          );
        }
      }
      if (state.turn.seatIndex !== before)
        trace.push({ seat: state.seatOrder[state.turn.seatIndex]!, round: state.round });
      if (state.gameOver) break;
    }
    return trace;
  }

  it('从座次 2 开局：2→3→0→1→**2** 才算一轮走完（轮号在这时 +1）', () => {
    const state = gzDone(3, { firstSeat: 's2' });
    const round0 = state.round;
    const trace = walkTurns(state, 200);
    // 头五个回合的座位次序必须是座次环本身
    expect(trace.slice(0, 5).map((t) => t.seat)).toEqual(['s2', 's3', 's0', 's1', 's2']);
    // 回到起点之前不算新一轮（老写法在这里就已经 +1 了——那才是错的那一刀）
    expect(trace.slice(0, 4).every((t) => t.round === round0)).toBe(true);
    // 绕回座次 2 的那一刻，轮号 +1（老写法这里还是 round0 ⇒ 这条用例先前是红的）
    expect(trace[4]!.round).toBe(round0 + 1);
  });

  it('从座次 0 开局：行为与改动前完全一致（3→0 时轮号 +1）', () => {
    const state = gzDone(3, { firstSeat: 's0' });
    const round0 = state.round;
    const trace = walkTurns(state, 200);
    expect(trace.slice(0, 5).map((t) => t.seat)).toEqual(['s0', 's1', 's2', 's3', 's0']);
    expect(trace.slice(0, 4).every((t) => t.round === round0)).toBe(true);
    expect(trace[4]!.round).toBe(round0 + 1);
  });
});
