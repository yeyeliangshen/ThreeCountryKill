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

### 问题 ⑤：两套控制流收尾机制并存

老机制（`ongoingSkillChain` / `resumeQueue` / `ongoingTrick` / `ongoingChain`）是
「把剩下的压进队列，等某个 `resumePlay` 来接管」；新机制是「各流程用自己的 continuation
（`done` / `after`）显式往下走」+ 围栏 + waiter。两套同时存在：

- `resumePlay` 开头还要先照顾老机制（`ongoingSkillChain` → `ongoingChain` → `ongoingTrick`），
  顺序错一个就会「跑两遍」或「永远不醒」；
- 老机制下「谁接管」是隐式的（等下一次 `resumePlay`），与围栏的判据（槽有没有被碰过）
  不是同一套语义 → 修一处容易漏另一处。

**关联源码**（`resumePlay` 开头的三跳，`engine.ts:2145–2200` 附近；**压缩成一行的骨架**，
原文每支都有注释与边界处理）：

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

每一步都遵守同一条纪律（用户定的）：**先测量 → 只改一处 → 全量（含模糊）**。
