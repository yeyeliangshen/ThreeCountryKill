/**
 * 施工方案（Pending 控制流结构性重构）§十二「全过程固定指标」的采集脚本。
 *
 * 用法：
 *   SGS_PROBE_CLOBBER=1 npx tsx scripts/measure-takeover.ts [局数，默认 200]
 *
 * 每一步施工前后都用**同一条命令、同一个局数**跑，把输出的指标块贴进报告对比。
 *
 * 覆盖的指标：
 *   1. takeover 分类（probe | site | 被换掉的类型 | sameUse → 次数 / 首末 seed）
 *   2. completedPendingStillOccupyingSlot（稳定观察点上「已走完还占着槽」的格子数）
 *   3. continuationExecutedTwice（同一个 continuationId 执行 > 1 次的条目数）
 *   4. fenceBlockCount（围栏判「本来会挡住」的次数；Step 3a 起才有意义）
 *   5. blockedContinuationNeverResumed —— Step 4（waiter）之前不适用
 *   6-9. regression fixture / smoke / fuzz / 全量测试：由 `pnpm test` 那三条给，不在这里
 *
 * ⚠️ 只读、不改行为：探针本身只记不改（见 engine.ts 的 takeoverRecord / runContinuation）。
 */
import { riskyGame, step, rng, checkDuplicate, allCardIds, makeCardWatch } from '../tests/fuzzHarness';
import { isCompletedPending, pendingWaiterCount } from '../src';

const games = Number(process.argv[2] ?? 200);
const TOP = 12;

interface Rec {
  probe: string;
  site: string;
  oldPending: { kind: string; owner: string | null; answered: boolean; completed: boolean } | null;
  newPendingKind: string;
  sameUse: string;
  ongoing: { skillChain: number; chain: boolean };
  caller?: string;
}

const byClass = new Map<string, { n: number; firstSeed: number; lastSeed: number }>();
let totalRecs = 0;
let leftoverSlot = 0;
let leftoverSamples: string[] = [];
const notFinished: number[] = [];
let neverResumed = 0;
const neverResumedSamples: string[] = [];
const seedsByKind = new Map<string, number[]>();

for (let seed = 1; seed <= games; seed++) {
  const state = riskyGame(seed);
  const rand = rng(seed * 977);
  const watch = makeCardWatch(allCardIds(state));
  let steps = 0;
  while (!state.gameOver && steps < 4000) {
    step(state, rand);
    steps++;
    const dup = checkDuplicate(state);
    if (dup) throw new Error(`seed=${seed} ${dup}`);
    if (state.pending && (state.pending.kind === 'play' || state.pending.kind === 'discard')) {
      watch.observe(state);
    }
    // 稳定观察点＝两次 applyIntent 之间：这时候还挂着「已答完/已走完」的格子，
    // 说明这个窗口没有自己离场、要靠后面某次收尾抢槽（Step 1.5 指标，按方案口径包含 answered-final）
    if (isCompletedPending(state.pending)) {
      leftoverSlot++;
      if (leftoverSamples.length < 5) {
        leftoverSamples.push(`${seed}#${steps}:${state.pending?.kind}`);
      }
    }
  }
  if (!state.gameOver) notFinished.push(seed);
  // 指标 5（Step 4）：曾被挡住并登记 waiter、但到终态都没恢复的续接（目标 0）
  const waiters = pendingWaiterCount(state);
  if (waiters > 0) {
    neverResumed += waiters;
    if (neverResumedSamples.length < 5) neverResumedSamples.push(`${seed}:waiters=${waiters}`);
  }

  for (const r of state.blockedTakeovers as unknown as Rec[]) {
    totalRecs++;
    const key = `${r.probe} | ${r.site} | old=${r.oldPending?.kind ?? 'null'}(answered=${r.oldPending?.answered ?? '-'},completed=${r.oldPending?.completed ?? '-'}) | new=${r.newPendingKind} | sameUse=${r.sameUse}`;
    const cur = byClass.get(key) ?? { n: 0, firstSeed: seed, lastSeed: seed };
    cur.n++;
    cur.lastSeed = seed;
    byClass.set(key, cur);
    const k = r.oldPending?.kind ?? 'null';
    const arr = seedsByKind.get(k) ?? [];
    if (arr.length < 8) arr.push(seed);
    seedsByKind.set(k, arr);
  }
}

const nameOf = (id: string): string =>
  (() => {
    const kinds = seedsByKind.get(id);
    return kinds ? `（出现于 seed: ${kinds.join(',')}）` : '';
  })();

// ── 指标 1：takeover 分类 ────────────────────────────────────────────────
console.log(`\n=== 局数 ${games}｜未结束 ${notFinished.length}${notFinished.length ? ': ' + notFinished.slice(0, 10).join(',') : ''} ===`);
console.log(`\n【指标 1】takeover 分类（共 ${totalRecs} 条）`);
for (const [k, v] of [...byClass.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, TOP)) {
  console.log(`  ${String(v.n).padStart(5)}  seed ${v.firstSeed}..${v.lastSeed}  ${k}`);
}

// ── 指标 2：完成后仍占着槽 ───────────────────────────────────────────────
console.log(`\n【指标 2】completedPendingStillOccupyingSlot = ${leftoverSlot}${leftoverSamples.length ? `  ${leftoverSamples.join(' ')}` : ''}`);

// ── 指标 3：续接重复执行 ─────────────────────────────────────────────────
let twice = 0;
let runs = 0;
const twiceIds: string[] = [];
for (let seed = 1; seed <= games; seed++) {
  const state = riskyGame(seed);
  const rand = rng(seed * 977);
  let steps = 0;
  while (!state.gameOver && steps < 4000) {
    step(state, rand);
    steps++;
  }
  for (const [id, n] of state.continuationRuns) {
    runs += n;
    if (n > 1) {
      twice++;
      if (twiceIds.length < 8) twiceIds.push(`${id}×${n}`);
    }
  }
}
console.log(`\n【指标 3】continuationExecutedTwice = ${twice}${twiceIds.length ? `  ${twiceIds.join(' ')}` : ''}（续接共执行 ${runs} 次）`);

// ── 不变量 B/D（施工方案 Step 2.3）────────────────────────────────────────
let dupCompletions = 0;
let refused = 0;
const refusedKinds = new Map<string, number>();
{
  const state2 = { pendingCompletions: new Map<number, number>(), refusedReleases: [] as { id: number; kind: string }[] };
  const dupIds: string[] = [];
  for (let seed = 1; seed <= games; seed++) {
    const st = riskyGame(seed);
    const rand = rng(seed * 977);
    let steps = 0;
    while (!st.gameOver && steps < 4000) {
      step(st, rand);
      steps++;
    }
    for (const [pid, n] of st.pendingCompletions) {
      if (n > 1) {
        dupCompletions++;
        if (dupIds.length < 8) dupIds.push(`${pid}×${n}`);
      }
    }
    refused += st.refusedReleases.length;
    for (const r of st.refusedReleases) refusedKinds.set(r.kind, (refusedKinds.get(r.kind) ?? 0) + 1);
  }
  void state2;
  console.log(`
【不变量 B】同一 pending 重复完成 = ${dupCompletions}${dupIds.length ? `  ${dupIds.join(' ')}` : ''}`);
  console.log(
    `【不变量 D】release-if-mine 因「槽已换人」被拒 = ${refused}${refused ? `  ${[...refusedKinds].map(([k, v]) => `${k}:${v}`).join(' ')}（Step 4 要逐条改成登记等待）` : ''}`,
  );
}

// ── 指标 4/5 ─────────────────────────────────────────────────────────────
const fence = [...byClass.keys()].filter((k) => k.startsWith('fence')).reduce((s, k) => s + (byClass.get(k)?.n ?? 0), 0);
console.log(`\n【指标 4】fenceBlockCount = ${fence}（Step 3a 起才有意义）`);
console.log(
  `【指标 5】blockedContinuationNeverResumed = ${neverResumed}${neverResumedSamples.length ? `  ${neverResumedSamples.join(' ')}` : ''}（目标 0）`,
);

// ── 分类里出现的「非设计如此」种类，单独点出来 ────────────────────────────
/**
 * 已经**裁定过**的两类（有测量证据，见 docs/pending-ownership.md）：
 *   · `wuxieQueue` / `respondTrick` 的残留窗口 —— Step 1 起应恒为 0（窗口自己离场）；
 *   · `discard(answered=false)` —— Step 6 裁定为**设计如此**：收尾请求在「还没答完的弃牌询问」
 *     前排队（登记等待），不是抢槽。§4.12 的 6.2 有调用栈与逐帧证据。这 21 条是**回归基线**，
 *     数量或形状变了才是信号。
 * 剩下没被这两条覆盖的记录才是「待观察」——**不要**为了让这一行好看而扩大白名单。
 */
const ADJUDICATED_PREFIXES = ['old=wuxieQueue', 'old=respondTrick', 'old=discard'];
const adjudicated = [...byClass.entries()].filter(([k]) =>
  ADJUDICATED_PREFIXES.some((p) => k.includes(p)),
);
const odd = [...byClass.entries()].filter(
  ([k]) => !ADJUDICATED_PREFIXES.some((p) => k.includes(p)),
);
console.log(
  `\n【已裁定·设计如此】${adjudicated.map(([k, v]) => `${k.match(/old=([a-zA-Z]+)/)?.[1] ?? '?'}=${v.n}`).join('  ') || '（无）'}`,
);
console.log(`【待观察】不属于上述已裁定形状的记录：${odd.length} 类`);
for (const [k, v] of odd) console.log(`  ${v.n}  ${k} ${nameOf(k.match(/old=([a-zA-Z]+)/)?.[1] ?? '')}`);
