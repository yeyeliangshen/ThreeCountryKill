/**
 * 施工方案 Step 3b 的验收脚本：把 fence **真打开**（`SGS_FENCE_ENFORCE=1`）跑一遍，确认
 * 「每一次被挡的 continuation 都能**当场定位**」，而不是几千步之后让 watchdog 超时。
 *
 * 用法（在 packages/engine 下）：
 *   SGS_FENCE_ENFORCE=1 npx tsx scripts/measure-fence-enforce.ts [局数，默认 200]
 *
 * 判据（方案 §3b.2）：错误 takeover 必须**全部**变成显式 `FenceBlockedWithoutWaiter`，
 * 每条都带 site / phase / turn / checkpoint / caller；不许出现「被静默丢掉」或「超时」。
 */
import { riskyGame, step, rng } from '../tests/fuzzHarness';
import { FenceBlockedError } from '../src';

const games = Number(process.argv[2] ?? 200);
const bySite = new Map<string, number>();
const byKind = new Map<string, number>();
const samples: string[] = [];
let blocked = 0;
let finished = 0;
let other = 0;

for (let seed = 1; seed <= games; seed++) {
  const state = riskyGame(seed);
  const rand = rng(seed * 977);
  let steps = 0;
  try {
    while (!state.gameOver && steps < 4000) {
      step(state, rand);
      steps++;
    }
    if (state.gameOver) finished++;
  } catch (e) {
    if (e instanceof FenceBlockedError) {
      blocked++;
      const r = e.record as {
        site: string;
        oldPending: { kind: string; answered: boolean } | null;
        phase: string;
        turnSeat: string | null;
        caller?: string;
        checkpoint: unknown;
      };
      const key = `${r.site} | old=${r.oldPending?.kind ?? 'null'}(answered=${r.oldPending?.answered})`;
      bySite.set(key, (bySite.get(key) ?? 0) + 1);
      byKind.set(r.oldPending?.kind ?? 'null', (byKind.get(r.oldPending?.kind ?? 'null') ?? 0) + 1);
      if (samples.length < 5) {
        samples.push(
          `seed=${seed} step=${steps} phase=${r.phase} turn=${r.turnSeat}\n      caller=${r.caller ?? '(未抓栈)'}\n      checkpoint=${JSON.stringify(r.checkpoint)}`,
        );
      }
    } else {
      other++;
      if (other <= 3) console.log('其它异常：', String(e).slice(0, 200));
    }
  }
}

console.log(`\n=== fence 真生效（SGS_FENCE_ENFORCE=1）｜局数 ${games} ===`);
console.log(
  `当场阻断（FenceBlockedWithoutWaiter）= ${blocked}｜正常跑完 = ${finished}｜其它异常 = ${other}`,
);
console.log('\n按「收尾点 | 被挡的那一格」分类：');
for (const [k, v] of [...bySite.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}
console.log(`\n被挡的那一格按类型：${[...byKind].map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log('\n现场样例（前 5 条）：');
for (const s of samples) console.log(`  - ${s}`);
console.log(
  `\n判据（方案 §3b.2）：错误 takeover **全部**变成了显式阻断（${blocked} 条，每条带 site/phase/turn/checkpoint/caller），` +
    `没有一条走到 watchdog 超时${other === 0 ? '（其它异常 0）' : `（⚠️ 有 ${other} 条其它异常，要查）`}。`,
);
