/**
 * 「先测量」：跑 N 局随机对局，把 `resumePlay` **覆盖掉没答过的询问**的那些场合聚类打印。
 *
 * 为什么要有它：docs/pending-ownership.md 的「建议顺序 ②」要求先把 `blockedTakeovers` 的
 * 数据补全（原来只有带围栏的两处锦囊收尾会记），再做一次聚类测量。这只探针
 * （`SGS_PROBE_CLOBBER=1`）覆盖全部 19 个 `resumePlay` 调用点，本脚本负责跑量 + 聚类。
 *
 * 用法（在 packages/engine 下）：
 *   SGS_PROBE_CLOBBER=1 npx tsx scripts/measure-takeover.ts [局数]
 *
 * ⚠️ 这是**测量**脚本，不进测试套件：它只读、不改行为（探针本身也只记不改），
 *    结论写回 docs/guozhan-roster.md。
 */
import { riskyGame, step, rng, checkDuplicate } from '../tests/fuzzHarness';

const games = Number(process.argv[2] ?? 60);

interface Rec {
  finalizer: string;
  currentKind: string | null;
  phase: string;
  inDying: boolean;
  caller?: string;
}

const byKind = new Map<string, number>();
const byCaller = new Map<string, number>();
const byPair = new Map<string, number>();
let total = 0;
let finished = 0;
let stuck = 0;

for (let seed = 1; seed <= games; seed++) {
  const state = riskyGame(seed);
  const rand = rng(seed * 977);
  let steps = 0;
  while (!state.gameOver && steps < 4000) {
    step(state, rand);
    steps++;
    const dup = checkDuplicate(state);
    if (dup) throw new Error(`seed=${seed} ${dup}`);
  }
  if (state.gameOver) finished++;
  else stuck++;
  for (const r of state.blockedTakeovers as unknown as Rec[]) {
    if (r.finalizer !== 'resumePlay(clobber)') continue;
    total++;
    const k = `${r.currentKind ?? 'null'}${r.inDying ? '(濒死)' : ''}`;
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
    const caller = (r.caller ?? 'unknown').replace(/^resumePlay$/, 'resumePlay(递归)');
    byCaller.set(caller, (byCaller.get(caller) ?? 0) + 1);
    const pair = `${k} ← ${caller}`;
    byPair.set(pair, (byPair.get(pair) ?? 0) + 1);
  }
}

const top = (m: Map<string, number>, n: number): string =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${v}\t${k}`)
    .join('\n');

console.log(`局数 ${games}｜跑完 ${finished}｜未结束 ${stuck}｜「收尾抢了没答过的询问」共 ${total} 次`);
console.log(`\n—— 被抢的槽（按 kind）——\n${top(byKind, 12)}`);
console.log(`\n—— 动手的收尾（按调用点）——\n${top(byCaller, 12)}`);
console.log(`\n—— 组合 TOP20 ——\n${top(byPair, 20)}`);
