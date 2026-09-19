import { defineConfig } from 'vitest/config';

/**
 * 引擎测试里有一批**重型用例**：模糊测试（riskyGame 跑几百局）、冒烟（每个武将都打到分出胜负）、
 * 随机对局不变式。它们本身是确定性的（固定种子），但**很吃 CPU**——`pnpm test` 会在工作区里
 * 并行跑 engine/ui/server 三个包，负载高的时候这些用例会撞上 vitest 默认的 5s 超时，
 * 表现成「同一份代码一次绿一次红」的假失败（已实测：引擎单独连跑 8 轮全绿、工作区并行跑偶发失败）。
 * 所以这里显式放宽超时——用例自己还会传更细的 per-test 上限。
 */
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
