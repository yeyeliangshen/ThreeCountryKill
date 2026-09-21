# 输入槽（pending）所有权：问题清单 + 关联源码

> 这篇文章把「输入槽」这套机制**现在仍然存在的问题**集中写在一处，并附上相关源码。
> 分散的记录在 `guozhan-roster.md` 的 §5.118 / §5.124 / §5.127 / §5.128 / §5.130 / §5.134；
> 这里是**汇总版**（用户 2026-09 要求整理）。

## 0. 这套机制要解决什么

引擎是「同步执行 + 中途挂起询问」的结构：玩家的一枪 `applyIntent` 可能跑到一半需要问人
（出闪、选牌、濒死求桃…），于是把「等谁回答什么」写进**输入槽** `state.pending`，
等下一次 `applyIntent` 把答案接上，再顺着续接把剩下的流程跑完。

问题全出在**收尾**上：一个子流程（伤害结算、锦囊结算、技能链、濒死链…）跑完了，要把控制权
**还给**出牌阶段（或者交给下一步），于是调 `resumePlay` 往槽里写 `{kind:'play'}`。
但如果这时候槽被**新产生的询问**占着（技能在收尾里发问、或嵌套使用另开了一个窗口），
这一写就把那条询问**冲掉了** —— 表现是「玩家再也答不上那个问题」或者「停在 0 体力的人永远不死」。

历史上这一类 bug 从「7~9 次修了又回退」一路走到今天，下面把**现状**（哪些已经解决、
哪些仍在）逐条列清楚。

---

## 1. 已经解决的（不要再当问题看）

| 曾经的毛病 | 现状 |
| --- | --- |
| 濒死链自己 `resumePlay`，跟挂起的钩子链抢控制权 | 已 continuation 化：`enterNearDeath(state, attack, done)` / `doDeath(..., done)`，链内**一处 resumePlay 都没有**（§5.127，提交 B） |
| 钩子里间接打出濒死 → 求桃被回合交接顶掉 | 钩子链现在认「**本链自己**打出来的」`respondDeath` 为被问住并挂起（`runHooksFrom` 的暂停条件 + `startedWith`）；四条 skip 全开（§5.130） |
| 伤害后钩子先跑、濒死后跑（与官方相反） | 已定序：扣体力 → 濒死/死亡 → 造成伤害后 → 受到伤害后 → damageFinished（`afterDamageSettled`，§5.128） |
| 求桃那一格用完没人交槽 | `respondDeath` 自带 `release`：走完（救回/阵亡）时若槽里还是它就 `setPending(null)` 再 `done()`（§5.128.2(a)） |
| 钩子链收尾把「已经答过的那一格」还回去 | `answeredPendings`（`WeakSet`）+ `applyIntent` 打标记：**答过的询问不许再被还原**（§5.128.2(b)） |

---

## 2. 仍然存在的问题（按严重程度）

> **§2 的现状（2026-09-21，Step 0–6 施工完之后）**：下面 ①–⑤ 都已解决（①窗口自完成 = Step 1、
> ②围栏覆盖 19/19 = Step 3a、③`requestResumePlay` 接线 = Step 4、④唤醒点收口 = Step 4.5/4.6、
> ⑤三跳删除 = Step 5）；⑥ 由 `releaseIfMine` + 不变量 B/D 兜住（约定仍在，但有了探测器）；
> ⑦ 仍在（诊断设施的成本**故意**保留）。各条的原文按原样留着，作为「当时的问题陈述」——
> **不要**把它们当成当前状态读。收口结论见 §4.11 / §4.12。

### 问题 ①（结构性的、最关键）：**窗口推进依赖「收尾抢槽」**

**症状**：不能把收尾改成「让路」（槽里有别人的询问就先等着）——一改，整局停在半路。

**实测**（60 局随机对局，`state.blockedTakeovers` 打点聚类）：共 **163 次**「收尾本来会抢槽、
被围栏判为被挡」，**清一色**是 `wuxieQueue`（102）与 `respondTrick`（61），且
`sameUse=false`（＝嵌套使用的窗口，不是同一次结算里抢早了）。

**两次「让路」尝试的失败机理**（都量到过）：

1. **让路对象常常是「已经问完的窗口」**：无懈窗口问过最后一家之后 `askIndex` 已越界、
   对象还挂在槽里等后续流程替换它 → 它**不会再被任何人回答**，登记等待＝整局挂死
   （探针表现：下一家取 prompt 时 `unknown seat undefined`）；
2. **窗口推进本身就靠这次抢槽**：南蛮「依次响应」的链条，要靠收尾把 `respondTrick` 换掉、
   续接队列里的推进才能接着跑 → 让路之后停在第二个响应窗口上。

⇒ 结论：**当前结构下「让路」没有安全落点**（§5.134）。真要做它，前置条件是
**把「窗口推进」从「依赖收尾抢槽」改成窗口自己显式设置下一格**。

**关联源码**：`packages/engine/src/engine.ts` 的 `resumePlay` 被挡分支（约 2260–2291 行；
下面为**节选**，打点对象里还有 `checkpointKind` / `turnSeat` / `resumeQueueLength` / `blockedUse` /
`myUse` 等字段，以及 `SGS_TRACE_TAKEOVER=1` 打到 stdout 的那几行）：

```ts
  if (since && !canTakeOverPending(state, since)) {
    // 关键诊断：挡住我的这条询问，属于**同一张牌的使用**还是**另一次（嵌套）使用**？
    const cur = state.pending as { ctx?: { cardUseId?: number } } | null;
    const curUse = cur && typeof cur === 'object' && 'ctx' in cur ? cur.ctx?.cardUseId : undefined;
    const rec = { finalizer: 'resumePlay', checkpointSeq: since.slotVersion, currentSeq: state.pendingSeq,
      currentKind: state.pending ? state.pending.kind : null, phase: String(state.turn.phase),
      inDying: state.pending?.kind === 'respondDeath', sameUse: curUse !== undefined ? String(curUse === since.useId) : 'n/a' };
    state.blockedTakeovers.push(rec);
    // ⚠️ **这里试过「让路」（改成登记等待，2026-09）——两处都站不住，已回退**，如实记：
    //    ① 让路对象常常是**已经问完的轮询窗口**（`wuxieQueue` 问过最后一家、`askIndex` 越界
    //       却还挂在槽里等后续流程替换）——它**不会再被回答**，登记等待＝整局挂死；
    //    ② 就算排除掉①，南蛮那类「依次响应」的推进也依赖这次抢槽。
    //    量到的口径（60 局随机、163 次被挡）：**全部**是 `wuxieQueue` / `respondTrick` 且
    //    `sameUse=false`——本来就该由收尾抢回槽来推进。所以「让路」在本引擎里**没有可安全
    //    应用的场合**；真要做它，得先把「窗口推进」从「依赖这次抢槽」改成窗口自己显式设置
    //    下一格（见 docs §5.134）。
  }
  setPending(state, { kind: 'play', seatId: sourceId });
```

### 问题 ②：围栏只覆盖了两个收尾点

`resumePlay(state, sourceId, since?)` 的 `since`（围栏快照）**只有锦囊结算那两个调用点传了**
（`engine.ts:5551` / `5562`，`ctx.pendingFence`）。另外 **15 个** `resumePlay` 调用点
（濒死链、钩子链、响应窗口、技能链…）**不带围栏** → 它们仍然会无条件抢槽，
只是「碰巧没撞上」或被别的机制兜住了。

**关联源码**（逐字）：`engine.ts` 里 17 个 `resumePlay(...)` 调用点，只有两处是
`resumePlay(state, ctx.sourceId, ctx.pendingFence)`；判据本身在

```ts
export function canTakeOverPending(state: GameState, checkpoint: PendingCheckpoint): boolean {
  const cur = state.pending;
  if (!cur) return true;                       // 槽空 → 可以
  return (
    checkpoint.requestId !== null &&
    pendingIdOf(cur) === checkpoint.requestId &&   // 还是我拍快照时那一份
    state.pendingSeq === checkpoint.slotVersion     // 且期间没被碰过
  );
}
```

### 问题 ③：`requestResumePlay`（请求式收尾）**写好了但没接线**

「槽空就取、有人等回答就只登记等待」+ 回合世代围栏的那套设施全在，**但没有任何地方调用它**
（只有注释与测试用）。它是问题①里「让路」的正解形态，等窗口推进显式化之后才能启用。

**关联源码**（`engine.ts:222–256`）：

```ts
function waitPendingResolved(state: GameState, requestId: number, waiter: () => void): void {
  const list = state.pendingWaiters.get(requestId) ?? [];
  list.push(waiter);
  state.pendingWaiters.set(requestId, list);
}

/** 某条询问（requestId）处理完了：唤醒在等它的那些待办（**唯一**唤醒点） */
function completePendingRequest(state: GameState, requestId: number): void {
  const waiters = state.pendingWaiters.get(requestId);
  if (!waiters) return;
  state.pendingWaiters.delete(requestId);
  for (const run of waiters) runResume(run);
}

export interface ResumePlayRequest { sourceId: string; turnSeq: number; }

export function requestResumePlay(state: GameState, req: ResumePlayRequest): void {
  if (state.gameOver) return;
  if (state.turnSeq !== req.turnSeq) return;                    // 世代围栏：迟到即作废
  if (state.seatOrder[state.turn.seatIndex] !== req.sourceId) return;
  const checkpoint = capturePendingCheckpoint(state);
  if (checkpoint.requestId === null) {
    setPending(state, { kind: 'play', seatId: req.sourceId });  // 槽空才取
    return;
  }
  waitPendingResolved(state, checkpoint.requestId, () => requestResumePlay(state, req)); // 有人问 → 等它答完
}
```

### 问题 ④：唤醒点只认「经过 `applyIntent` 的回答」

唤醒统一收口在 `applyIntent`（下面源码），覆盖了所有**由玩家回答**的路径（chooseOption /
pickCards / ack / respondCard / pass / discard…）。但引擎里还有一批**内部推进**：
窗口问完自动推进（`finishWuxieWindow`）、锦囊推进（`advanceTrick` / `endTrickResolution`）、
回合交接（`endTurn` / `goToDiscardPhase`）、阵亡收尾（`doDeath` 的 `done`）——
这些**不会**触发 `completePendingRequest`。等在这类「窗口对象」上的待办会永远不醒
（这正是问题①第 1 条的机理）。

**关联源码**（`applyIntent` 里的统一唤醒点，**节选**：上文还有 `handBefore` / `ownedBefore` /
`answering` 的取快照那几行）：

```ts
  const result = applyIntentInner(state, seatId, intent);
  if (result.ok) {
    if (answering && !isPlaceholderPending(answering)) answeredPendings.add(answering);
    // 「这条询问处理完了」：唤醒在等它的那些待办。**放在这里而不是各回答分支里**——
    // 回答路径有十来条（chooseOption / pickCards / ack / respondCard / pass / discard…），
    // 散着写必漏（实测：收尾被挡住的 163 次全是 wuxieQueue / respondTrick，恰好都在
    // 「respondCard / pass」那条路上，那三处旧唤醒点一个都不覆盖）。占位空位不算询问。
    if (answering && !isPlaceholderPending(answering)) {
      completePendingRequest(state, pendingIdOf(answering));
    }
    drainResume(state);
```

### 问题 ⑤：两套控制流收尾机制并存 —— ✅ **Step 5 已解决**（三跳已删，见 §4.11）

老机制（`ongoingSkillChain` / `resumeQueue` / `ongoingTrick` / `ongoingChain`）是
「把剩下的压进队列，等某个 `resumePlay` 来接管」；新机制是「各流程用自己的 continuation
（`done` / `after`）显式往下走」+ 围栏 + waiter。两套同时存在：

- `resumePlay` 开头还要先照顾老机制（`ongoingSkillChain` → `ongoingChain` → `ongoingTrick`），
  顺序错一个就会「跑两遍」或「永远不醒」；
- 老机制下「谁接管」是隐式的（等下一次 `resumePlay`），与围栏的判据（槽有没有被碰过）
  不是同一套语义 → 修一处容易漏另一处。

**关联源码**（`resumePlay` 开头的三跳，`engine.ts:2145–2200` 附近；**压缩成一行的骨架**，
原文每支都有注释与边界处理）——**下面是重构前的样子；三支现已全部删除（§4.11）**：

```ts
  // 被濒死打断的多步链（军令逐个问、决绝逐个结算、钩子链里打出的濒死）：先接着跑它们
  if (state.ongoingSkillChain.length > 0) { const run = state.ongoingSkillChain.shift()!; run(); return; }
  // 铁索连环蔓延被濒死打断 → 先把剩下的人打完
  if (state.ongoingChain) { runChainSpread(state, () => resumePlay(state, sourceId)); return; }
  // AOE 锦囊被濒死中断后，恢复时继续推进锦囊
  if (state.ongoingTrick) { /* …火烧连营 / 敕令 / advanceTrick… */ }
```

### 问题 ⑥：「谁清那一格」靠的是**约定**，不是框架

目前有两处显式约定（都做了，但没有机制保证）：

- **谁建谁清**：`enterDeathQueue` 的求桃格子自带 `release`；
- **答过的不能还原**：`answeredPendings` + `runHooksPausable` 的 `ambient` 判断。

只要以后有人在别处 `setPending` 建了格子却忘了清、或又在钩子链收尾时「还回去」，
同类 bug 会再回来（历史上踩过：`ambient` 无条件还原 → 求桃队列问不完，内存跑满）。

**关联源码**（`engine.ts` 的求桃 `release`）：

```ts
  const release = (): void => {
    if (state.pending === queuePending) setPending(state, null);
    done();
  };
```

### 问题 ⑦：诊断设施本身有成本

- `pendingIdOf` 用 `WeakMap` 给 pending 发号（只为文档/测试与诊断），
  `blockedTakeovers` 数组**只增不减**（一局里几百条，可接受，但长期跑长局要注意）；
- 打点只在带 `since` 的两个调用点产生（问题②）→ **覆盖率不足**，
  所以「哪些收尾在抢谁的槽」这件事目前只能看到锦囊那一半。

---

## 3. 如果要收口，建议的顺序

1. **先把「窗口推进」显式化**（问题①的前置）：让 `finishWuxieWindow` / `advanceTrick` /
   `endTrickResolution` 这些路径**自己 `setPending` 下一格**，而不是「留在槽里等收尾替换」。
   每改一处都能用现有全量 + 模糊（`fuzz.test.ts` 200 局 + `smoke.test.ts` 40 局 + 6 个历史种子）验；
2. **把 `since` 围栏铺到全部 17 个 `resumePlay` 调用点**（问题②），
   让 `blockedTakeovers` 的数据完整，再重新做一次 163 次那种聚类测量；
3. 数据干净之后，**接线 `requestResumePlay`**（问题③）：被挡的收尾改成「登记等待」；
   这时候它等的一定是**真在等回答**的询问（问题①、④ 的机理已消除），不会挂死；
4. 最后再逐步**退掉老机制**（`ongoingTrick` / `ongoingChain` / `ongoingSkillChain`，
   问题⑤），让「控制权交接」只有一条路：**显式 continuation + 围栏**。
   → ✅ 已做：`resumePlay` 的三跳全部删除（Step 5，见 §4.11）；唯一留下的
   `ongoingSkillChain` 队列**不是跳转**，而是「钩子链里打出的濒死」那条必需的续接队列。

每一步都遵守同一条纪律（用户定的）：**先测量 → 只改一处 → 全量（含模糊）**。

---

## 4. 施工进度（按用户 2026-09-21 给的《Pending 控制流结构性重构方案》）

方案的核心契约：**谁创建 pending，谁拥有其生命周期；pending 完成后显式释放自身，再通过
continuation 推进后续流程；如果 continuation 恢复时存在更新一代 pending，则等待，而不是覆盖或丢失。**
纪律：先测量 → 一次只改一处 → 每步完整回归 → 数据符合预期再进下一步；
测量工具 `packages/engine/scripts/measure-takeover.ts`（每步前后同命令同局数对比）。

### 4.1 Step 0（观测基线，零行为变化）—— ✅ 已完成

- takeover 记录统一成 `TakeoverRecord`（probe/site/phase/turnSeat/`oldPending{kind,owner,seq,
  answered,completed}`/newPendingKind/checkpoint/currentSeq/inDying/`ongoing{skillChain,chain,trick}`/
  resumeQueue/sameUse/caller）；`probe:'fence'`（带 checkpoint 的收尾）与 `probe:'clobber'`
  （顶掉没答过的询问）同一构造。
- 指标先行：`runContinuation` + `state.continuationRuns`（同一 id 执行 >1 次＝多执行）；
  `isCompletedPending()`（口径＝已 completed / **answered-final**，轮询队列「还没问完」不算）。
- 现场固定为回归用例：fuzz 的 `seed 9 / 84 / 86`（目前仅有的三处「收尾换掉一条没答过的询问」）。
- baseline（200 局）：takeover 459；指标 2/3 = 0；未结束 0。

### 4.2 Step 2.1 pending inventory（本轮施工范围）

`Pending` 的全量变体（`model.ts`）与各自的归属。**范围先定死，不在施工中改「问答型 pending」的定义**：

| pending 类型 | owner（谁拥有） | 创建点 | 完成源 | 谁 release | 可同步创建下一格 | 可嵌套 | 本轮 epoch |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `play` | 当前回合玩家（**占位**，不是询问） | 5 处（回合交接 / 收尾） | 出牌 / 结束 | 收尾 `resumePlay` 覆盖 | 是 | — | ❌ 占位不参与 |
| `respondSha` | 被问的那名角色（攻击流程） | 3 处 | `respondCard` / `pass` | 攻击流程收尾 | 是 | 是（借刀 / 寄篱） | ✅ |
| `respondDeath` | 求桃队列当前那一位 | 1 处（`enterDeathQueue`） | `respondCard` / `pass` | **自带 `release`（谁建谁清）** | 是 | 是 | ✅ |
| `discard` | 回合玩家 | 1 处（`beginDiscard`） | `discard` 意图 | 弃牌链收尾 | 是（复查可再摆） | 否 | ✅ |
| `respondTrick` | 当前响应者 | 8 处 | `respondCard` / `pass` | **Step 1 起自己离场**（`endTrickResolution` 顶部） | 是 | 是 | ✅ |
| `wuxieQueue` | 轮询队列（逐家问） | 4 处 | `respondCard` / `pass` | **Step 1 起自己离场**（`finishWuxieWindow`） | 是 | 是 | ✅ |
| `choice` | 被问的人 | 1 处（`askChoice`，全场通用） | `chooseOption` | 各流程自己（`returnTo` / 续接） | 是 | 是 | ✅ |
| `pickCards` | 被问的人 | 3 处 | `pickCards` | 同上 | 是 | 是 | ✅ |
| `pickSeats` | 被问的人 | 1 处（`askPickSeats`） | `pickSeats` | 同上 | 是 | 是 | ✅ |
| `factionCall` | 轮询队列（势力技代打） | 3 处 | `respondCard` / `pass` | 势力技链 | 是 | 是 | ✅ |
| `viewCards` | 观看者 | 3 处 | `ack` | 观看流程 | 是 | 是 | ✅ |
| `activeSkill` | —— | ~~0 处~~ | —— | —— | —— | —— | ✅ **已删除**（Step 6：没有任何创建点，连同 `legal.ts` 的空 case、`PromptKind` 里的同名项、smoke 的兜底分支一起清掉） |

### 4.3 Step 2.2 identity / epoch（身份与世代）

- **世代**：`state.pendingSeq` 每次 `setPending` 递增（＝「这一格是第几代」）；
  长流程在**真正拿到控制权的那一刻**拍 `capturePendingCheckpoint(state)`（记下 requestId +
  slotVersion + useId），收尾时用 `canTakeOverPending` 判「期间有没有人创建更新一代」。
- **身份**：`pendingIdOf(pending)`（WeakMap，一对象一号）用来回答「还是不是我自己那一格」；
  `releaseIfMine(state, mine)` 是唯一的释放原语：标完成 → **只在槽里还是我自己那格时才清**。
- 规则：**每个流程只能释放自己创建的那一格**；释放别人（更新一代）的格子＝takeover，不是释放。

### 4.4 Step 2.3 生命周期不变量与探测器

| 不变量 | 含义 | 探测器 | 现状 |
| --- | --- | --- | --- |
| **A** | completed pending 不能继续占据 `state.pending` | `isCompletedPending()` 在稳定观察点（两次 `applyIntent` 之间）采样 | `completedPendingStillOccupyingSlot = 0` ✅ |
| **B** | pending 最多完成一次 | `state.pendingCompletions`（`releaseIfMine` 里计数） | 重复完成 = 0 ✅ |
| **C** | 只能由自己的 owner / 完成契约释放 | 「收尾顶掉一条**没答过**的询问」记录（一直开着；栈只在探针开关打开时抓） | 目前 3 条（见 4.5） |
| **D** | 旧 generation 不得修改新 generation 的 pending | `releaseIfMine` 的拒绝计数 `state.refusedReleases`（拒绝＝正确行为，但 Step 4 要逐条改成登记等待） | 拒绝 = 0 ✅ |

### 4.5 Step 1（窗口自完成）—— ✅ 已完成

- `finishWuxieWindow`：无懈窗口问完 → 先 `releaseIfMine` → 再跑 `onDone`/结算；
- `endTrickResolution` 顶部：槽里还挂着**同一 ctx** 的 `respondTrick` → 先让它离场
  （只认 `respondTrick`：`wuxieQueue` 可能是同一个 ctx，但归 `finishWuxieWindow` 管）；
- 续接计数 id 带**窗口身份**（同一个牌用会开多次无懈窗口，它们是各自独立的续接）。
  ⚠️ 踩坑：第一版只用 `${cardUseId}:wuxie-done`，量到 `continuationExecutedTwice = 215`
  （同一 id 跑到 ×5）→ 触发方案 §十三 硬停线 3；按纪律先停下来查**指标本身**，加窗口身份后归零。

**Step 1 前后（200 局，同命令）**：

| 指标 | baseline | Step 1 后 |
| --- | --- | --- |
| takeover 总数 | 459 | 3 |
| ↳ `wuxieQueue` 残留 | 242 | **0** |
| ↳ `respondTrick` 残留 | 214 | **0** |
| ↳ `discard`（未答）/ `respondSha`（已答） | 2 / 1 | 2 / 1（**未处理**） |
| 指标 2 完成后占槽 | 0 | 0 |
| 指标 3 续接重复执行 | 0 | 0（续接共执行 3502 次） |
| 指标 4 fenceBlockCount | 459 | 3 |
| 未结束局数 | 0 | 0 |

**仍未解决（不得写成「已清零」）**：剩下 3 条 takeover —— `seed 9/84` 的**未答**弃牌询问被换掉、
`seed 86` 的已答求闪询问被换掉；它们不在 Step 1 范围（方案 §十五 只点名两类窗口），
按方案应在 Step 3a 铺完 fence 后用 `wouldBlock` 数据决定归属。三跳已随 Step 5 删除（见 §4.11）。

### 4.6 下一步

Step 2（本节的 inventory / identity / 不变量）已完成；接着按方案的顺序：
**Step 3a**（21/21 收尾点接 checkpoint + fence shadow 只观测）→ **Step 3b**（fence 真生效 +
被挡时 fail-fast，不允许 silent drop）→ **Step 4**（接 `requestResumePlay` / waiter / drain 重入守卫）
→ **Step 5**（动态核查后逐支删三跳）→ **Step 6**（架构收口）。

### 4.7 Step 3a（fence shadow：只观测、不改行为）—— ✅ 已完成

**3a.1 收尾点的 checkpoint 覆盖**

方案里写的是「21/21」；**实测这份代码里 `resumePlay` 的调用点是 19 处**（如实记，不凑数）：
**18/19 带上了起点快照**，剩下 1 处是**设计上的例外**——

- `returnPlayPhase`（技能 API）：它自带「槽里有询问就不动」的前置判断（`if (state.pending !== null) return`），
  所以围栏对它是**恒真**的，硬塞一个「收尾前临时拍的快照」违反方案 §3a.1 的原意，故不加、只登记。
- （静态扫描另有 1 处假阴性：`resumeTurnPlay(state, since?)` 的透传本身，语义上是带围栏的。）

**checkpoint 的两处来源**（方案 §3a.1 的「真正开始拥有控制权的位置」）：

1. **`setPending` 里统一记录**：每条 pending 被装上时，把此刻的槽快照记在它身上
   （`pendingFences` WeakMap + `fenceOf(pending)`）——这就是「这条询问所属流程的起点」，
   回答类的收尾（`returnTo` 那几条）直接取它；
2. **长流程在入口显式拍**：攻击流程（`AttackContext.pendingFence`：`startAttack` / `resolvePlayedSha`）、
   伤害流程（`dealDamage` 进门时）、天香（伤害被防止那一刻）、铁索连环蔓延链、军令链、拼点链、
   势力技代打场景（沿用其 ctx 的）。

⚠️ **Step 1 是 3a 的前提**：`canTakeOverPending` 的判据是「槽空 → 可以覆盖」——
窗口自己离场之后，收尾看到的槽才是空的；否则每一次收尾都会被误判成「被挡」。

**3a.3 影子数据（200 局，`SGS_PROBE_CLOBBER=1`）**：takeover 记录 257 条，两类：

| 被换掉的那一格 | 次数 | 含义 |
| --- | --- | --- |
| `respondSha`（answered=true） | 237 | 【杀】的求闪询问**已答**、但流程还没换掉它，收尾把它覆盖掉 —— 与 Step 1 修的两类窗口**同一形状**（下一个该做自完成的窗口） |
| `discard`（answered=false） | 20 | **没答过**的弃牌询问被收尾顶掉 —— 真·控制权问题，属 Step 3b/4 的范围 |

**模型与事实是否一致（方案的 3a 验收问题）**：一致 —— 这两类都会被围栏判 `wouldBlock=true`
（从流程起点之后确实有人创建了更新一代 pending），没有出现「没被挡但被换掉」或
「被挡住但其实无害」的对立情况；新增的记录条数（3 → 257）**全部来自 Instrumentation 覆盖变广**
（同一条 takeover 之前没有围栏、看不见），**不是行为变化**：这一节零行为改动，全量测试 1022 条与
Step 1 后完全一致。

**结论与下一步**：fence 的判定模型可以直接进 Step 3b（真生效 + 被挡时 fail-fast）。
⚠️ 3b 按方案会**故意让一批对局失败**（被挡的 continuation 不许 silent drop），需要你点头再动。
Step 3a 后的固定指标：指标 1 = 257（影子视角）、指标 2/3 = 0、不变量 B/D = 0、未结束 0。

### 4.8 Step 3b（fence 真生效 + 被挡时 fail-fast，禁止 silent drop）—— ✅ 已完成

**做法**：`resumePlay` 被围栏挡住时——记录（一直开着）→ 若 `SGS_FENCE_ENFORCE=1` 则
**抛出 `FenceBlockedError`**（名字就是方案 §3b.1 要求的 `FenceBlockedWithoutWaiter`，
携带完整现场：site / phase / turnSeat / checkpoint / 被挡的那一格 / **调用栈**）。

- **绝不 silent drop**：方案明确禁止 `if (blocked) return`（那会让 continuation 永久消失）；
  这里被挡=不写槽 + 当场抛错 ✓。
- **默认关**：直到 Step 4 接上 waiter 之前，引擎的默认行为仍是「记录 + 照旧覆盖」
  （所以 `pnpm test` 三闸仍然全绿；跑 Step 3b 的数据要用开关显式打开）。
  Step 4 之后这里会换成「登记等待」，那时它才是默认行为。

**验收（`scripts/measure-fence-enforce.ts`，200 局）**：

```text
当场阻断（FenceBlockedWithoutWaiter）= 107 ｜ 正常跑完 = 93 ｜ 其它异常 = 0
按「收尾点 | 被挡的那一格」：
   101  resumePlay | old=respondSha(answered=true)   ← 求闪询问已答仍占槽（攻击收尾想覆盖它）
     6  resumePlay | old=discard(answered=false)     ← 没答过的弃牌询问
```

方案 §3b.2 的判据全部满足：错误 takeover **全部**变成了显式阻断（107 条，每条都带
site/phase/turn/checkpoint/caller，样例里有 `afterAttackSettledTail` 与钩子链两条调用栈），
**没有一条走到 watchdog 超时**（其它异常 0）。

**结论**：fence 能正确阻止错误覆盖、且被挡的 continuation 当场可定位 → 可以进 Step 4
（接 `requestResumePlay` / waiter，把这里的 throw 换成「登记等待」）。
⚠️ 顺带明确下一步的收尾顺序：107 条里 101 条是**【杀】的求闪询问**——它是 Step 1 那个
「窗口自完成」模式的同类项（已答、流程没换掉它），补一次「谁建谁清」就能让这批被挡直接消失；
剩下 6 条（没答过的弃牌询问）才是真正需要 waiter 机制的场景。

### 4.9 【杀】求闪询问的「自完成」（Step 1 同款）—— ✅ 已完成

Step 3b 的数据指出：107 条被挡里 **101 条是求闪询问（`respondSha`）已答仍占槽** ——
与 Step 1 修的两类窗口同一形状。补上同款：

- `finishAttack` 入口：这次攻击创建的求闪询问对象（`AttackContext.shanAsk`）如果还挂在槽里，
  先 `releaseIfMine`（标完成 → 只在槽里还是它时才清）再往下收尾；
- 三处创建求闪询问的地方本来就已经把对象记在 `attack.shanAsk` 上（那是「谁建谁清」那轮做的），
  所以身份对得上；不可闪避那类根本不创建询问，`shanAsk` 为空 → 天然不涉及。

**效果（同命令同局数）**：

| 指标 | Step 3a 后 | 本次之后 |
| --- | --- | --- |
| 影子 takeover 总数 | 257 | **20** |
| ↳ `respondSha`（已答仍占槽） | 237 | **0** |
| ↳ `discard`（**没答过**） | 20 | 20 |
| fence 真生效下的当场阻断 | 107 | **18** |
| 其它异常 / 未结束局数 | 0 / 0 | 0 / 0 |
| 指标 2 / 指标 3 / 不变量 B / 不变量 D | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |

**结论**：整个 takeover 面现在只剩**一类**——「收尾时槽里躺着一条**还活着**的弃牌询问」，
20 次 / 200 局。按方案这正是 **Step 4（waiter）** 的验收场景：被挡的收尾不再覆盖也不丢弃，
而是**登记等待**，等那条询问走完再由 `drain` 唤醒。（三跳已在 Step 5 删除，见 §4.11。）

### 4.10 Step 4（接通 waiter：被挡的收尾登记等待）—— ✅ 已完成

按方案 §4.1–4.7 接线（此前 `requestResumePlay` / `waitPendingResolved` / `completePendingRequest`
三件套都在、但**没有任何调用者**）：

- **4.1 默认行为翻转**：`resumePlay` 被围栏挡住时——**既不覆盖、也不丢弃**，改为
  **登记等待**：等挡住它的那条询问走完（`completePendingRequest`）再重新请求「回出牌阶段」；
  `requestResumePlay` 自带**回合世代围栏**（等太久、回合已交出去的请求直接作废，不抢未来回合）。
  `SGS_FENCE_ENFORCE=1` 仍保留为 §3b 的诊断模式（当场 throw）；
- **4.2 幂等**：`waitPendingResolved` 增加幂等键 + `state.deferredContinuations`——
  同一条续接只登记一次（多唤醒点重复注册会让它在询问走完后跑两遍 = 「多执行」）；
- **4.3 先消费再执行**：`completePendingRequest` 保持 `delete` 在前（continuation 内部可能同步
  又完成一条询问、重入到这里；先删掉才不会把自己再唤醒一遍）；
- **4.4 重入守卫**：`drainingWaiters` 深度（嵌套 drain 允许但不拦，因为每层列表都已消费、必然收敛）
  + `state.pendingDrainReentry` 计数器；
- **4.5/4.6 统一唤醒点**：**所有**「询问生命周期推进」都收口到 `setPending`——
  旧那一格被换掉 / 被释放成空时唤醒它的等待者。这一条覆盖了窗口自动推进、`advanceTrick`、
  `endTurn`、`doDeath`、`releaseIfMine` 等**内部推进**（方案 §4.6 的 Case B，即历史失败所在）；
  原有的 3 个「回答路径」唤醒点保留；
- **4.7 指标**：新增 `pendingWaiterCount(state)`（导出）→ 测量脚本输出
  `blockedContinuationNeverResumed`。

**顺带查出一个生命周期缺口（Step 4 逼出来的）**：势力技代打成功时
（`onRespondFactionCall`）**既不推进队列也不释放那一格**——它会一直占着槽，
于是 Step 4 的等待者挂在它身上、永远等不到唤醒（护驾用例当场抓到）。
已按 Step 1 同款补 `releaseIfMine`。

**Step 4 验收（200 局，同命令同局数）**：

| 指标 | Step 3b 后 | Step 4 后 |
| --- | --- | --- |
| 指标 5 `blockedContinuationNeverResumed` | n/a | **0** ✅（目标 0） |
| 未结束局数 | 0 | **0** ✅（200 局全部正常分出胜负） |
| 指标 1 takeover 记录 | 20 | 21（全部 `outcome: 'deferred'`，即**改成等待**而不是覆盖） |
| ↳ 那一格 | `discard`（没答过） | 同左（**这是唯一剩下的类**：收尾时槽里躺着一条还活着的弃牌询问） |
| 指标 2 / 指标 3 / 不变量 B / 不变量 D | 0 | 0 / 0 / 0 / 0 |
| 全量测试 | 1022+34+46 | 与 Step 4 前一致（含 fuzz 历史种子、smoke 40 局） |

**结论**：控制权**可以等待**了，而且等得到（指标 5 = 0）——方案的核心契约
「谁创建谁拥有、完成后释放自己、恢复时若遇到更新一代则等待」已经成立。
还剩 **Step 5**（动态核查后逐支删掉 `resumePlay` 的三跳旧机制）与 **Step 6**（架构收口 +
清 `activeSkill` 死代码）。

### 4.11 Step 5（逐支删除 `resumePlay` 的三跳旧机制）—— ✅ 已完成

方案 §5.1 的验收判据是「**实际语义依赖 == 0**」：先动态核查（命中数只是参考），
再**逐支关掉跑全量**，全绿才算没有语义依赖；然后 §5.2 要求**一次只删一支**，各自完整回归。

**5.1 先测量（没有直接开删）**

- 临时开关 `SGS_NO_ONGOING=skillChain,chain,trick`（可只写一支）+ 命中计数
  `state.ongoingBranchHits` + 核查脚本 `packages/engine/hits.ts`（跑 N 局，汇总三支命中数）；
- 结果：**200 局三支命中全 0**（`{"skillChain":0,"chain":0,"trick":0}`，200/200 局分出胜负）；
- 对照实验：逐支关掉、以及三支全关的预演 —— 全量（1022 引擎测试 + 34 server + 46 ui）
  全绿，200 局指标 2/3/5 = 0、不变量 B/D = 0、未结束 0 ⇒ 判据成立，可以删。

**5.2 逐支删（一次一支，各自跑全量后单独提交）**

| 顺序 | 删掉的跳转 | 为什么不再需要 | 提交 |
| --- | --- | --- | --- |
| 第 1 支 | `ongoingSkillChain` 的那一跳 | 该字段本身**没删**：`drainResume` 的排空循环（`applyIntent` 收尾）在用它，那是「钩子链里打出的濒死」这条**必需**机制（docs §5.130）——它不属于三跳 | `6fac926` |
| 第 2 支 | `ongoingChain` 的那一跳 | 铁索蔓延现在跑在**可挂起钩子链**上：`chainStep` → `afterDamageSettled` → `runDamagedHooks`（`runHooksPausable`/`runAllPlayersHooks`），中断续接记在 `resumeQueue`、由 `drainResume` 接着跑完。顺带清掉只为这一支服务的 `chainSince` | `d545c37` |
| 第 3 支 | `ongoingTrick` 的那一跳 | **不是纯删除**：唯一写入方是敕令，先把它的续接搬进濒死链的收尾回调（见下）；AOE / 火烧连营那一路早已由窗口自完成（Step 1）与可挂起钩子链接管 | 本次 |

**第 3 支为什么要改写而不是直接删**：`state.ongoingTrick` 的唯一写入点是
`chilingAskCurrent` 的「失去 1 点体力」支（把 ctx 挂起来，等 `resumePlay` 补跑）。
直接删掉跳转 ⇒ 敕令把人打进濒死之后，剩下的目标**永远不会被问**（停在濒死链的出口）。
改写后：把 `chilingNext` 交给 `enterNearDeath` 的收尾回调——「自己的收尾自己续」，
与求闪询问/无懈窗口的自完成（Step 1）是同一套做法，不引入任何新机制。
字段 `ongoingTrick` 随本支一起删除（已无写入方、也无读取方）；
`SGS_NO_ONGOING` 开关、`ongoingBranchHits` 计数、`hits.ts` 也一并清掉——三支都不在了，
开关与计数再没有作用对象（它们的历史数据就是本节这张表）。

**顺带修掉一个旧实现里的隐患（如实记）**：旧跳转续的是 `chilingStep`（**同一个 index**
重新问），所以「敕令把人打到 0 血、又被桃救回来」时，那个人**会被问第二遍**。
新实现续的是 `chilingNext`，那个人不会再被问。

**覆盖率：如实说明**。三支在 200 局里命中 **0** ⇒ 结论只能是「**已测量无语义依赖**」，
**不是**「已证明死代码」——这 200 局与全部用例都没走到那三条路径。所以第 3 支改写过的
那条路径（敕令打进濒死）**不能只靠模糊网兜底**，补了两条定点用例：

- 「失去体力打进濒死：被救回来后接着问**下一个人**（不会把被救的人再问一遍）」；
- 「失去体力把人判死：剩下的人照样问完，控制权回到出牌阶段」。

其中第一条**在旧代码上实测失败**（`git stash` 前后对照：1 failed | 7 passed），
确认它钉的是改写后的行为，而不是一条本来就能过的用例。

**Step 5 后的同命令同局数回归（200 局）**：

| 指标 | Step 4 后 | Step 5 后（三支全删） |
| --- | --- | --- |
| 未结束局数 | 0 | **0** |
| 指标 1 takeover 记录 | 21 | 21（同一类：收尾时槽里躺着一条**活着**的弃牌询问，全部 `outcome: 'deferred'`） |
| 指标 2 / 指标 3 | 0 / 0 | 0 / 0（续接共执行 3523 次） |
| 指标 4 `fenceBlockCount` | 21 | 21 |
| 指标 5 `blockedContinuationNeverResumed` | 0 | **0** |
| 不变量 B / 不变量 D | 0 / 0 | 0 / 0 |
| 全量测试 | 1022 + 34 + 46 | 1024 + 34 + 46（新增 2 条敕令用例） |

**结论**：`resumePlay` 顶部不再有任何「替别人补跑」的跳转——控制权交接只剩一条路：
**显式 continuation + 围栏 + waiter**。剩下的是 **Step 6**（架构收口 + 清 `activeSkill`
死代码 + 指标 1 那一类的归属裁定）。

### 4.12 Step 6（收口：清死代码 + 指标 1 归属裁定 + 最终统计）—— ✅ 已完成

**6.1 清死代码：`activeSkill`**

`Pending` 里那个 `{ kind: 'activeSkill'; seatId; skillId }` **没有任何创建点**（Step 2.1 的
inventory 就标了「❌ 死代码（Step 6 清）」）。本轮连同它的三处陪衬一起删：

| 位置 | 处理 |
| --- | --- |
| `model.ts` 的 `Pending` 联合 | 删掉该变体（多步主动技能真正用到时，走的是 `choice` / `pickCards` / `pickSeats` 通用原语） |
| `legal.ts` 的 `case 'activeSkill'`（恒返回 `null` 的空分支） | 删掉 |
| `protocol/views.ts` 的 `PromptKind` 里的 `'activeSkill'` | 删掉（引擎永远不会产生这种 prompt；UI 侧本来也没有处理分支） |
| `smoke.test.ts` 的兜底 `case 'activeSkill': throw` | 删掉（它守的就是「这个原语还没接完」，现在原语不存在了） |

**6.2 指标 1 那一类（21 条）的归属裁定：设计如此**

Step 5 之后指标 1 只剩一类：`fence | resumePlay | old=discard(answered=false) | new=play`
（200 局 21 条，全部 `outcome: 'deferred'`）。按纪律先**测量**再裁定，证据如下：

- **把被挡时的调用栈打出来**（`SGS_FENCE_ENFORCE=1` 会在被挡处当场 throw，
  异常里带 `caller: topStackFrame()`）：200 局里撞见 18 次「首次被挡」，按调用点分是
  15× 攻击结算尾（`afterAttackSettledTail`）、2× 锦囊结算收尾（`endTrickResolution` /
  `huoShaoStep`）、1× 钩子链；**按被挡的那一格分：18/18 全是 `discard(answered=false)`**。
- **被挡的那一格是什么**：`discard` pending 只有 `beginDiscard` 一个创建点（弃牌阶段 / 弃牌
  复查），所以被挡的永远是「**某人还欠着一次弃牌、询问挂在槽里、还没回答**」。
- **让路的后果**：Step 4 之前这类收尾会**直接把那条弃牌询问覆盖掉**（= 欠的弃牌被静默跳过，
  是**漏效果**的真 bug）；Step 4 起改成登记等待，等弃牌答完再由 `requestResumePlay` 决定还要不要
  回出牌阶段——它有**回合世代围栏**：如果这一等把回合等过去了（弃牌答完通常就结束回合了），
  那次请求**直接作废**，不会去抢下一个回合。
- **数据核对**：指标 2 = 0（没有「已完成还占槽」）、指标 5 = 0（没有「登记了没人醒」）、
  200/200 局正常分出胜负、全量测试全绿 ⇒ **等待都等到了、也没有卡死**。
- **逐帧核对一次**（seed 21，把 `setPending` / `resumePlay` 的轨迹打出来）：
  `[setPending] → discard | phase=discard` → `[resumePlay→play] 原来是 phase=discard
  pending=discard` → 玩家答完弃牌 → 回合正常交给下家（期间**没有**出现「给旧回合玩家重开
  出牌阶段」的杂散 pending）。

⇒ 裁定：**这一类属于「设计如此」**（收尾请求在一条还没答完的弃牌询问前排队），
保留 21 条记录当**回归基线**，不再当异常看。

**6.3 测量中顺带查出的一处瑕疵（如实记，本轮**没改**）**

上面逐帧核对时看到：`resumePlay` 里 `state.turn.phase = 'play'` 这一句写在**围栏判断之前**，
所以**即使这次收尾最终被挡住（只是登记等待、没有拿走槽）**，`turn.phase` 也已经被改成 `'play'`。
实测轨迹（seed 21）：正在**弃牌阶段**、槽里挂着弃牌询问，phase 却被这行改成了 `'play'`。

- **为什么这是瑕疵**：`turn.phase` 是「流程自己在哪一段」的权威字段，被一条**没拿到控制权**的
  收尾改写，就出现了「phase=play 但槽里是弃牌询问」的自相矛盾状态。
- **为什么暂时不改**：200 局 + 全量测试都**没有可观测症状**（回合推进靠各流程自己的
  continuation，不读这个字段；弃牌阶段能不能用某个技能看的是 pending 种类，不是 phase）。
  理论上的两个受影响点记在这里：①严白虎·寄篱那种用 `座位:阶段` 当「本阶段第几次伤害」账本键的
  技能会在这一小段窗口里重置账本；②`applyIntent` 末尾的兜底（`pending === null && phase ===
  'discard'` → 重新 `beginDiscard`）在这一小段窗口里会走 `play` 那一支。
- **修法**：把 `state.turn.phase = 'play'` 移到**确定要拿走槽之后**——已按此修掉，见 §4.13。

**6.4 最终统计（Step 0 → Step 6，同命令同局数 200 局）**

| 指标（§十二 固定指标块） | Step 0 基线 | Step 6 终局 |
| --- | --- | --- |
| 未结束局数 | 0 | **0** |
| 指标 1 takeover 记录 | 459 | **21**（唯一一类：`discard` 未答 → 见 6.2，全部 `deferred`） |
| ↳ `wuxieQueue` / `respondTrick` 残留 | 242 / 214 | **0 / 0** ✅ |
| ↳ `respondSha`（已答仍占槽） | 1 | **0** ✅ |
| ↳ `discard`（未答） | 2 | 21 —— ⚠️ **不是变多了**：Step 3a.1 把 fence 铺到 18/19 个收尾点之后，「本来会被覆盖的」才**看得见**（与 §4.7 的 3 → 257 同一个原因），行为没变 |
| 指标 2 `completedPendingStillOccupyingSlot` | 0 | **0** |
| 指标 3 `continuationExecutedTwice` | 0 | **0**（续接共执行 3523 次） |
| 指标 4 `fenceBlockCount` | 459 | 21（= 指标 1 那 21 条，全部 defer） |
| 指标 5 `blockedContinuationNeverResumed` | n/a | **0** ✅ |
| 指标 6 阶段/槽不一致（phase=play 却挂着 discard） | 未测（指标本身是本节新加） | **0**（修前实测 21，见 §4.13） |
| 不变量 B 重复完成 / 不变量 D 释放被拒 | 0 / 0 | **0 / 0** |
| 硬停线（新 takeover 类型 / 新不结束 seed / 异常 return） | — | **一条都没碰**（三跳是「测到无语义依赖」后按方案删的，不是靠放宽断言过测试） |
| 全量测试 | 1022 + 34 + 46 | **1024 + 34 + 46**（新增 2 条敕令用例；fuzz 里另加一条阶段/槽不变量，见 §4.13） |

**结论（Step 6 收口后的状态）**：
① `Pending` 的 11 个变体里不再有死代码；
② 控制权交接只有一条路：**显式 continuation + 围栏 + waiter**；
③ 「谁抢了谁的槽」这件事有完整的打点与不变量（指标 2/3、不变量 B/D）在网上；
④ 指标 1 那 21 条有**证据充分的归属裁定**（设计如此，留作回归基线）；
⑤ 6.3 那处 phase 写入时机**当天就修掉了**（§4.13），并且把不变量加进了 `pnpm test` 会跑的
   模糊网里，不是只留在手动脚本里。

### 4.13 修 §4.12 6.3 的 phase 写入时机（先量 → 只改一处 → 全量）

**先测量（改之前）**：给测量脚本加**指标 6**「`turn.phase === 'play'` 却挂着 `discard` 询问」
（`discard` 只有 `beginDiscard` 一个创建点、且只在弃牌阶段创建，所以这个组合正常应当是 0）。
改前跑 200 局：**指标 6 = 21**，种子与那 21 条被挡记录**完全同源**
（`9#371 / 21#61 / 23#164 / 31#106 / 40#21 …`）⇒ 这条瑕疵不是理论推演，是稳定可复现的。

**只改一处**：新增 `takePlayPhase(state, seatId)`（= 改 `turn.phase = 'play'` + 装 `play` 占用
pending，**两件事一起做**），并把「回出牌阶段」的三个落点换成它：

| 落点 | 原来 | 现在 |
| --- | --- | --- |
| `resumePlay` 顶部（围栏**之前**） | `state.turn.phase = 'play'`（无条件的，被挡住也照改） | **删掉**，只留下「这里不改」的说明 |
| `resumePlay` 尾部的正常落点 | `setPending({kind:'play'})` | `takePlayPhase(state, sourceId)` |
| `resumePlay` 里 `rid === null`（槽已空、这一格能拿） | 同上 | `takePlayPhase(state, sourceId)` |
| `requestResumePlay`（被挡后登记等待、醒来重新取槽） | 同上 | `takePlayPhase(state, req.sourceId)` |

**改后（同命令同局数 200 局）**：**指标 6 = 21 → 0**；其余指标**一字不变**
（takeover 21、指标 2/3 = 0、指标 4 = 21、指标 5 = 0、不变量 B/D = 0/0、未结束 0、
续接共执行 3523 次），全量测试全绿。

**给它配一张网（不再只靠手动脚本）**：把这条不变量加进 `packages/engine/tests/fuzz.test.ts`
的 200 局不变式里（稳定观察点：`phase === 'play'` 时槽里不许是 `discard`）。
**用 `git stash` 回到修前代码实测**：该断言当场报出
`seed=9 第 371 步 / seed=21 第 61 步 / seed=23 第 164 步 / seed=31 第 106 步 / seed=40 第 21 步 …`
——确认它钉的就是这次改动（修后通过）。**没有放宽任何既有断言**。

