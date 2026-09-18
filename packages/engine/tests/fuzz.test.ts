// 随机对局不变式（模糊测试）。
//
// 为什么值得单独留一份：像「诸葛亮·观星把一张牌放进顶堆和底堆两个数组」「鬼才/鬼道替判时
// 替换牌被弃两次」「制蛮拿走判定区的牌却还留在原地」这类 bug，单元测试里很难撞见——它们需要
// 一条具体的随机路径。这里用轮换的高风险武将阵容跑随机对局，每步检查不变式。
//
// 这套网到目前为止抓到并修掉的（每条都有注释记着现场）：
//   ① 荀攸·奇策「先打锦囊再问变更副将」→ 锦囊结算完控制权丢失、整局卡死
//   ② 鬼才/鬼道替判时替换牌被弃两次（同一张牌在弃牌堆出现两次）
//   ③ 吕范·调度链条收尾丢控制权（嵌套询问吃掉了外层续接）
//   ④ 制蛮拿走判定区的牌时 `api.transferCard` 没处理判定区 → 一牌两地
//   ⑤ 重铸只从手牌删牌 → 邓艾「田」上的牌重铸后一牌两地
//   ⑥ 续接队列**排序**错了：从续接内部入队的续接被排到外层后面，外层一跑完就把 pending
//      挂回去，内层续接（判定牌归位 + 判红摸牌）被永久搁置——实测搁置 27-44 步，
//      跨了好几个回合才执行（见 engine.ts `pushResume` 的注释）
//   ⑦ 军令抽两张、牌堆洗完重洗、重洗后摸牌… 里有几处 `shuffle()` 没传 `state.rng`，
//      退回 `Math.random`：同一个种子两遍跑出不同对局（这就是「确定性」那条用例抓的）
//   ⑧ 一条醒得太晚的钩子链（跨了好几个回合）重新触发【鬼才】，替早已结算完的判定打出替换牌
//      —— 那张牌写进没人接手的判定盒子后凭空消失（见文件末尾那段；数据丢失已拦，
//      触发时机仍是错的）
//
// ⚠️ 两条纪律（都是踩过的坑）：
//   - **只在稳定时刻**查牌张类不变式（出牌/弃牌阶段的 pending）：结算中途有些牌本来就会短暂地
//     同时挂在两处或不在任何区域（判定牌在飞、五谷丰登亮出的那一池），那不是 bug。
//   - **随机源必须走 state.rng**：见 ⑦。同种子必须能稳定重放，否则定位器复现不了 bug。
import { describe, it, expect } from 'vitest';
import {
  allCardIds,
  checkDuplicate,
  makeCardWatch,
  riskyGame,
  rng,
  step,
  type GameState,
} from './fuzzHarness';

describe('随机对局不变式：控制权不丢', () => {
  it('60 局随机对局里任何一步都有 pending', () => {
    // ⚠️ 分出胜负那一步本来就 pending=null（不是 bug），漏判会误报。
    //    引擎里另有一道统一兜底（续接排空后若无 pending、回合座次未变且仍在出牌阶段，
    //    就把出牌阶段还给回合玩家）——把兜底撤掉这条会立刻红（seed=13/21/25/29/37 等）。
    const problems: string[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const rand = rng(seed * 977);
      const state = riskyGame(seed);
      let steps = 0;
      try {
        while (!state.gameOver && steps < 4000) {
          step(state, rand);
          steps++;
          if (!state.pending) {
            if (state.gameOver) break;
            problems.push(`seed=${seed} 第 ${steps} 步：控制权丢了（pending=null）`);
            break;
          }
        }
      } catch (e) {
        problems.push(`seed=${seed} 第 ${steps} 步抛错：${(e as Error).message}`);
      }
    }
    if (problems.length > 0)
      console.log('发现问题：' + String.fromCharCode(10) + problems.slice(0, 10).join(String.fromCharCode(10)));
    expect(problems).toEqual([]);
  }, 60000);
});

describe('随机对局不变式：牌不会同时挂在两处、也不会被流程积压', () => {
  it('200 局随机对局里都不出现重复牌 / 长期缺席', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed * 977);
      const state = riskyGame(seed);
      const watch = makeCardWatch(allCardIds(state));
      let steps = 0;
      try {
        while (!state.gameOver && steps < 4000) {
          step(state, rand);
          steps++;
          if (!state.pending) {
            if (state.gameOver) break;
            // 控制权丢了由上面那条用例负责报，这里不重复
            break;
          }
          // 只在**稳定时刻**查牌张（见文件头 ⚠️）
          if (state.pending.kind !== 'play' && state.pending.kind !== 'discard') continue;
          const bad = checkDuplicate(state) ?? watch.observe(state);
          if (bad) {
            problems.push(`seed=${seed} 第 ${steps} 步：${bad}`);
            break;
          }
        }
      } catch (e) {
        problems.push(`seed=${seed} 第 ${steps} 步抛错：${(e as Error).message}`);
      }
    }
    if (problems.length > 0)
      console.log('发现问题：' + String.fromCharCode(10) + problems.slice(0, 10).join(String.fromCharCode(10)));
    expect(problems).toEqual([]);
  }, 180000);
});

describe('随机对局不变式：曾经出过问题的种子（回归）', () => {
  /**
   * 这几个种子在更深的扫描（1500 局）里抓出过真 bug，各自的现场记在这里：
   * - `seed=1145` / `seed=1313`：【以逸待劳】的选择池是「当时手牌的快照」，等牌被选中时
   *   它可能已经不在手里（问话挂起期间被【鬼才】打出去替判），于是同一张牌在弃牌堆里两份。
   * - `seed=1329`：【恩怨】要求「交给对方一张手牌」，但那张询问挂起期间来源的手牌已经没了
   *   ——发出去的询问要求选 1 张、池子却是空的，谁也答不上来：整局 20000 步纹丝不动。
   * - `seed=425`：【过河拆桥】的牌主在结算走完之前阵亡、手牌被清进弃牌堆，随后结算继续
   *   走「收代价」，把已经在弃牌堆里的那张又推了一遍 → 同一张牌两份。
   * - `seed=1405`：判定阶段把整叠判定牌拿在手上逐张往下递，判定者被自己的【闪电】劈死，
   *   死亡清场接管、判定阶段再也不往下走 —— 手里那叠（一张【兵粮寸断】）跟到结束都没回来。
   * 四条都已修（min 兜底 / 答话时重查手牌 / `takeAndDiscard` 取不到就不弃 /
   * 判定在飞台账 `GameState.judgmentInFlight`），这里钉住。
   */
  it('1145 / 1313 / 1329 / 425 / 1405 跑满 6000 步：不重复、不长期缺席、能分出胜负', () => {
    const problems: string[] = [];
    for (const seed of [1145, 1313, 1329, 425, 1405]) {
      const rand = rng(seed * 977);
      const state = riskyGame(seed);
      const watch = makeCardWatch(allCardIds(state));
      let steps = 0;
      try {
        while (!state.gameOver && steps < 6000) {
          step(state, rand);
          steps++;
          if (!state.pending) {
            if (state.gameOver) break;
            problems.push(`seed=${seed} 第 ${steps} 步：控制权丢了`);
            break;
          }
          if (state.pending.kind !== 'play' && state.pending.kind !== 'discard') continue;
          const bad = checkDuplicate(state) ?? watch.observe(state);
          if (bad) {
            problems.push(`seed=${seed} 第 ${steps} 步：${bad}`);
            break;
          }
        }
        if (!state.gameOver) problems.push(`seed=${seed} 跑了 ${steps} 步还没结束（卡死了？）`);
      } catch (e) {
        problems.push(`seed=${seed} 第 ${steps} 步抛错：${(e as Error).message}`);
      }
    }
    if (problems.length > 0)
      console.log('发现问题：' + String.fromCharCode(10) + problems.join(String.fromCharCode(10)));
    expect(problems).toEqual([]);
  }, 300000);
});

// ⚠️ 这条网还压着一个**没修完**的问题（数据丢失那半已经拦住，见下）：
//
// 询问只有一个槽（`state.pending`），而「钩子先问玩家、再按回答决定」是跨步的。
// 一条醒得太晚的链（例如某次「失去牌」的钩子链）在判定正问着【鬼才】时又问了【屯田】，
// 就会把鬼才那条问**覆盖**掉：鬼才的回答永远等不到，而屯田的答案被当成鬼才的回答喂给判定，
// 替判定打出的那张替换牌就落进了一条**已经结束的**判定链的盒子里（seed=7/132/175 都是
// 【闪电】判定 + 鬼才替换这一路）。
//
// 现在兜住的是「牌不能没」：`JudgeBox.chain` 记住这条判定链是否已结束，结束之后写进来的
// 替换牌直接进弃牌堆（不再凭空消失）。**但触发时机仍然是错的**——那条链本来就不该在
// 棋局翻篇之后才醒，不该重复触发技能。
//
// 想按「不覆盖」来根治是不行的（试过）：这条要求会撞上引擎现在的设计——技能在阶段里发问
// 就是靠覆盖出牌/弃牌阶段的空位接管控制权的，一刀切成「已有 pending 就不许覆盖」会挂
// 93 项测试、连「不许覆盖任何 question」也有同样的规模。真正的修法是给续接条目带上
// 「归属哪条链」的标记，唤醒时校验现场还是不是那一手（见 docs/guozhan-roster.md §5.43）。

describe('随机对局不变式：同种子可稳定重放', () => {
  /** 跑一整局，返回一个能代表整局走向的指纹（步数 + 终局 + 全场牌 + 日志） */
  function digest(seed: number): string {
    const rand = rng(seed * 977);
    const state: GameState = riskyGame(seed);
    let steps = 0;
    while (!state.gameOver && steps < 1200) {
      step(state, rand);
      steps++;
    }
    return `${steps}|${state.gameOver}|${allCardIds(state).join(',')}|${state.log.map((l) => l.message).join('/')}`;
  }

  it('同一个种子跑两遍完全一致（中间还夹一局别的）', () => {
    // 这条抓的是「某处随机没走 state.rng」：以前军令抽两张、弃牌堆重洗用的是 `Math.random`，
    // 于是同一个种子两遍跑出不同对局，定位器和用例互相矛盾，白查了两轮。
    const first = digest(2);
    digest(3); // 夹一局别的：跨局共享的 `Math.random` 状态会被这次消耗掉
    expect(digest(2)).toBe(first);
    // 反向确认：不同种子确实跑出不同对局（否则说明随机源根本没接进去，这条网是假的）
    expect(digest(4)).not.toBe(first);
  }, 60000);
});

// 还没做的一条：**不询问阵亡者**。历史上报过 `seed=1/18/22` 的「在问一个已经阵亡的角色
// （choice）」——但要先判断合法性（询问挂起期间当事人死了属正常），得把检查放宽成
// 「阵亡者不能**新**被问」再判，所以先不在这条网里。
//
// 另有一条**规则待核**（不是 bug）：官方「田」只能当【顺手牵羊】用（急袭），而本引擎允许把
// 「田」当可重铸牌重铸。机制上已经干净（不再一牌两地），是否该禁止等确认官方 FAQ（见文档 §5.42）。
