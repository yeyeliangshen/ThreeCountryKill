import { riskyGame, step, rng } from './tests/fuzzHarness';
const games = Number(process.argv[2] ?? 200);
const total = { skillChain: 0, chain: 0, trick: 0 };
let finished = 0; const unfinished: number[] = [];
for (let seed = 1; seed <= games; seed++) {
  const st = riskyGame(seed); const rand = rng(seed * 977); let steps = 0;
  while (!st.gameOver && steps < 4000) { step(st, rand); steps++; }
  total.skillChain += st.ongoingBranchHits.skillChain;
  total.chain += st.ongoingBranchHits.chain;
  total.trick += st.ongoingBranchHits.trick;
  if (st.gameOver) finished++; else unfinished.push(seed);
}
console.log(`局数 ${games}｜跑完 ${finished}｜未结束 ${unfinished.length ? unfinished.join(',') : 0}｜命中 ${JSON.stringify(total)}`);
