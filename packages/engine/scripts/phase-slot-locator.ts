/**
 * 「阶段 / 槽」不一致的**现场定位器**（模糊网不变量 6）。
 *
 * 症状：`state.turn.phase === 'play'` 时槽里却挂着一条**弃牌询问**。
 * 弃牌询问只该活在弃牌阶段（`beginDiscard` 是它唯一的创建点，摆询问时把阶段写成 'discard'），
 * 所以这条不一致 ＝ 阶段被翻回去过，或者询问是从别处摆出来的。
 *
 * ⚠️ 别用肉眼看日志猜「大概是谁翻的」——这里记录每一步的 (阶段, 槽, 槽里那一格的**对象身份**)，
 *    撞上不一致时**回放**到最后一个 phase≠'play' 的步，并打印这之间的全部日志。
 *    这一步是上一次没定位到栈的直接原因：探针挂在 takePlayPhase/enterPlayPhase 上根本没响，
 *    说明翻阶段的地方**不是**那两个函数。
 *
 * 用法：`npx tsx packages/engine/scripts/phase-slot-locator.ts`（可加 `SGS_TRACE_PHASE=1`）
 */
import {
  riskyGame,
  step,
  rng,
  checkDuplicate,
  allCardIds,
  makeCardWatch,
} from '../tests/fuzzHarness';
import type { GameState } from '../src';

interface Rec {
  step: number;
  phase: string;
  pk: string | null;
  owner: string | null;
  count: number | null;
  /** 槽里那一格的**对象身份**：用来分辨「同一格一直在」还是「换了一格」 */
  ref: unknown;
  logLen: number;
}

/** 一次阶段写入的记录（带调用栈） */
interface Write {
  step: number;
  what: string;
  from: unknown;
  to: unknown;
  stack: string;
}

/**
 * 给 `state.turn` 装**写入陷阱**：阶段是直接赋值的（`state.turn.phase = …`），
 * 而且 `state.turn` 本身会被整体换掉（`startTurn`），所以要在 `state` 上拦 `turn` 的赋值、
 * 再把新 turn 对象的 `phase` / `seatIndex` 也包上。这样**任何**写入都会留下栈，
 * 不用去猜是哪个函数干的（上一次就是猜错了函数，探针挂上去一声没响）。
 */
function trapTurn(state: GameState, writes: Write[], stepOf: () => number): void {
  const wrap = (turn: Record<string, unknown>): Record<string, unknown> => {
    for (const key of ['phase', 'seatIndex'] as const) {
      let val = turn[key];
      Object.defineProperty(turn, key, {
        configurable: true,
        enumerable: true,
        get: () => val,
        set: (v) => {
          writes.push({
            step: stepOf(),
            what: key,
            from: val,
            to: v,
            stack: new Error('phase-write').stack ?? '',
          });
          if (writes.length > 60) writes.shift();
          val = v;
        },
      });
    }
    return turn;
  };
  let cur = wrap(state.turn as unknown as Record<string, unknown>);
  Object.defineProperty(state, 'turn', {
    configurable: true,
    enumerable: true,
    get: () => cur,
    set: (v) => {
      cur = wrap(v as Record<string, unknown>);
    },
  });
}

for (let seed = 1; seed <= 200; seed++) {
  const rand = rng(seed * 977);
  const state: GameState = riskyGame(seed);
  const writes: Write[] = [];
  trapTurn(state, writes, () => steps);
  const watch = makeCardWatch(allCardIds(state));
  const hist: Rec[] = [];
  let steps = 0;
  const snapshot = (): Rec => {
    const pd = state.pending as
      { kind: string; seatId?: string; count?: number; responderId?: string } | null | undefined;
    return {
      step: steps,
      phase: state.turn.phase,
      pk: pd?.kind ?? null,
      owner: pd?.seatId ?? pd?.responderId ?? null,
      count: pd?.count ?? null,
      ref: state.pending,
      logLen: state.log.length,
    };
  };
  try {
    while (!state.gameOver && steps < 4000) {
      step(state, rand);
      steps++;
      hist.push(snapshot());
      if (hist.length > 400) hist.shift();
      if (!state.pending) {
        if (state.gameOver) break;
        break;
      }
      if (state.turn.phase === 'play' && state.pending.kind === 'discard') {
        const cur = hist[hist.length - 1]!;
        console.log(
          `seed=${seed} 步${steps} 阶段/槽不一致 owner=${cur.owner} count=${cur.count} 当前回合=${state.seatOrder[state.turn.seatIndex]}`,
        );
        // 回放到最后一个 phase≠'play' 的那一步
        let i = hist.length - 1;
        while (i > 0 && hist[i - 1]!.phase === 'play') i--;
        const from = hist[i]!;
        console.log(
          `   ↳ 从第 ${from.step} 步开始 phase 一直是 'play'（槽: ${from.pk ?? '空'}${from.owner ? '/' + from.owner : ''}）`,
        );
        console.log('   这一段的槽变化：');
        for (let k = i; k < hist.length; k++) {
          const a = hist[k]!;
          const b = hist[k + 1];
          if (k === i || a.pk !== b?.pk || a.owner !== b?.owner || a.ref !== b?.ref) {
            console.log(`     第 ${a.step} 步 → 槽=${a.pk ?? '空'}${a.owner ? '/' + a.owner : ''}`);
          }
        }
        console.log('   这一段日志：');
        console.log(
          state.log
            .slice(from.logLen)
            .map((l) => '     ' + l.message)
            .join(String.fromCharCode(10)),
        );
        console.log('   最近几次阶段/座次写入（含调用栈）：');
        for (const w of writes.slice(-6)) {
          const frames = w.stack
            .split(String.fromCharCode(10))
            .slice(1, 4)
            .map((f) => f.trim())
            .join('  ←  ');
          console.log(
            `     第 ${w.step} 步 ${w.what}: ${String(w.from)} → ${String(w.to)}   ${frames}`,
          );
        }
        process.exit(0);
      }
      const bad = checkDuplicate(state) ?? watch.observe(state);
      if (bad) {
        console.log(`seed=${seed} 第 ${steps} 步（别的检查先响了）：${bad}`);
        process.exit(0);
      }
    }
  } catch (e) {
    console.log(`seed=${seed} 第 ${steps} 步抛错：${(e as Error).message}`);
    process.exit(0);
  }
}
console.log('没找到：不变量 6 在当前代码下不再触发');
