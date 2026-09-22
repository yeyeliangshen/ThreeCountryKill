#!/usr/bin/env node
/**
 * **技能提示真机验收的最小陪练**（用户 2026-09-25 口径①~④）。
 *
 * `scripts/bot.mjs` 只出牌、**不发动技能**（它的策略里根本没有 useSkill），所以
 * 「让另一个角色发动一个技能，看本地玩家这边有没有技能名浮出来」这条验收在主陪练上
 * **构造不出来**。这个脚本只做那一件事：连上服务端 → 选一个**会主动/自动发动技能**的武将
 * → 按 `MODE` 走一条确定的技能路径，其余时候一律弃权（不干扰现场的时序观察）。
 *
 * 用法（本仓库的联机自测约定：服务端 8080 已在跑）：
 *   node scripts/verify-skill-tip.mjs                  # 建房当房主（混战 + 选将不限）
 *   ROOM=4831 SEAT=1 node scripts/verify-skill-tip.mjs # 接替某个座位
 *   HERO=zhenji node scripts/verify-skill-tip.mjs      # 指定武将（默认 zhenji 甄姬）
 *   HOLD_MS=2500 node scripts/verify-skill-tip.mjs     # 被询问时**故意拖多久**才回答
 *
 * 两条路径（`HERO` 决定用哪条）：
 * - `zhenji`（甄姬，默认）：判定阶段的【洛神】是**自动触发**的——它先判定、再问自己
 *   「是否继续」。于是「另一个角色发动技能」与「多步结算 / 等待响应」两条口径
 *   **在同一条流程里**都能观察到：提示出现 → 保持（每答一次继续算一步）→ 答「停止」后收起。
 * - 其他武将（例如 `sunquan` 孙权）：出牌阶段主动发动一次【制衡】（弃一张手牌）——
 *   覆盖「主动技」那条路（同步结算，提示短暂浮现后自动收）。
 * - `guanyu`（关羽）：出牌阶段用【武圣】**转化**（把一张红牌当【杀】打给对手）——
 *   覆盖「转化技」那条路（转化既没有主动技的 execute、也没有钩子，
 *   是引擎里单独收口的一类；牌面看不到，所以逐张试到服务端接受为止）。
 *
 * ⚠️ 它**只用来造现场**：不做任何断言（断言在浏览器那一侧的 DOM 观察里，见 docs §5.212）。
 * 只用到 Node 自带的 WebSocket（Node 22+），不需要装包。
 */
const URL = process.env.SGS_URL ?? 'ws://127.0.0.1:8080';
const NAME = process.env.NAME ?? '技能陪练';
const ROOM = process.env.ROOM ?? null;
const SEAT = process.env.SEAT ?? null;
const HERO = process.env.HERO ?? 'zhenji';
/** 被询问时故意拖多久才回答（毫秒）：留给浏览器观测「等待响应期间提示保持」 */
const HOLD_MS = Number(process.env.HOLD_MS ?? 2500);
/** 洛神最多继续判几次（避免无限判下去，现场看不完） */
const LUOSHEN_MAX = Number(process.env.LUOSHEN_MAX ?? 2);

const log = (...a) => console.log('[verify-skill-tip]', ...a);
const send = (msg) => ws.send(JSON.stringify(msg));

/**
 * 【武圣】那条路：把一张红牌当【杀】打给对手。
 *
 * 本客户端看不到牌面（提示里只有牌 id），所以**逐张试**：服务端对黑牌会拒
 * 「不能将该牌转化为该类型」，被拒就接着试下一张，直到一张被接受（红牌当【杀】能成）。
 * 上一次被接受的表现是「我的手牌少了一张」——下一次进来就收工，不再出第二张。
 */
function tryWusheng(prompt) {
  const ids = prompt.legalCardIds ?? [];
  const target = (prompt.legalTargetIds ?? [])[0];
  const me = lastSnapshot?.players?.find((p) => p.seatId === lastSnapshot.seatId);
  if (wushengTry > 0 && me && me.handCount < wushengHand) {
    log('【武圣】已经打出去了（手牌少了一张）→ 不再出牌');
    wushengDone = true;
    send({ type: 'intent', intent: { type: 'endPhase' } });
    return;
  }
  if (!target) {
    log('没有可指定的目标（对手可能已经死了）');
    wushengDone = true;
    send({ type: 'intent', intent: { type: 'endPhase' } });
    return;
  }
  if (wushengTry >= ids.length) {
    log('手上没有红牌可转化 → 结束回合');
    wushengDone = true;
    send({ type: 'intent', intent: { type: 'endPhase' } });
    return;
  }
  const cardId = ids[wushengTry++];
  wushengHand = me ? me.handCount : 0;
  log(`出牌阶段 → 试第 ${wushengTry}/${ids.length} 张当【杀】（武圣）`);
  send({ type: 'intent', intent: { type: 'playCard', cardId, targetIds: [target], as: 'sha' } });
}

const ws = new WebSocket(URL);
let asked = false; // 只在第一次拿到大厅列表时做一次「建房 / 进房」
let started = false;
let picked = false;
let luoshenSteps = 0;
let zhihengDone = false;
/** 武圣那条路：已经把第几张候选牌试过当【杀】（牌面看不到，只能逐张试） */
let wushengTry = 0;
let wushengDone = false;
/** 试这张之前我的手牌数（用来认「上一张被接受了」） */
let wushengHand = 0;
/** 最近一次出牌阶段的提示 + 最近一份快照（武圣逐张重试要用） */
let lastPlay = null;
let lastSnapshot = null;
/** 我自己的座次（服务端 lobby 里给） */
let mySeat = null;

ws.addEventListener('open', () => {
  log('已连接', URL);
  send({ type: 'enterHall', name: NAME });
});
ws.addEventListener('error', () => log('连接出错'));
ws.addEventListener('close', () => log('连接关闭'));

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));

  if (msg.type === 'hall' && !asked) {
    asked = true;
    if (ROOM) {
      log(`进房间 ${ROOM}${SEAT ? ` 的 ${SEAT} 号座` : ''}`);
      send({ type: 'joinRoom', roomCode: ROOM, ...(SEAT ? { seatId: SEAT } : {}) });
    } else {
      log('创建房间（混战 + 选将不限）');
      send({ type: 'createRoom' });
    }
    return;
  }

  if (msg.type === 'lobby') {
    const seated = msg.seats.filter((s) => s.name).length;
    mySeat = msg.mySeatId ?? mySeat;
    log(`房号 ${msg.roomCode}，我在 ${msg.mySeatId} 号座，已落座 ${seated} 人`);
    if (!ROOM) {
      if (msg.mode !== 'melee') send({ type: 'setMode', mode: 'melee' });
      if (!msg.freePick) send({ type: 'setFreePick', freePick: true });
      if (!started && seated >= 2) {
        started = true;
        log('两人到齐 → 开局');
        send({ type: 'startGame', mode: 'melee', freePick: true });
      }
    }
    return;
  }

  if (msg.type === 'error') {
    log('服务端拒绝：', msg.message);
    // 武圣那条路是**逐张试**的：被拒之后服务端不会因为一次「什么都没发生」的意图就重发快照，
    // 所以要自己接着试下一张（否则脚本会停在这儿等一个永远不来的提示）。
    if (HERO === 'guanyu' && !wushengDone && lastPlay && msg.message.includes('转化')) {
      setTimeout(() => tryWusheng(lastPlay), 120);
    }
    return;
  }
  if (msg.type !== 'snapshot') return;
  lastSnapshot = msg.snapshot;

  const prompt = msg.snapshot.prompt;
  if (!prompt) return;

  if (prompt.kind === 'pickHero' && !picked) {
    const heroes = prompt.legalHeroIds ?? [];
    if (!heroes.includes(HERO)) {
      log('发到的将里没有', HERO, '（选将不限应当给全部）——改选第一位');
    }
    const mine = heroes.includes(HERO) ? HERO : heroes[0];
    if (!mine) return;
    picked = true;
    log('选将：', mine);
    send({ type: 'intent', intent: { type: 'pickHero', heroId: mine } });
    return;
  }

  // 【洛神】的询问：「判定为黑色，是否继续？」——第一次答「继续」（多步结算现场），
  // 之后答「停止」（结算完成 → 提示应当自动收起）。
  if (prompt.kind === 'choice') {
    const yes = (prompt.choiceOptions ?? []).find((o) => o.id === 'yes');
    const no = (prompt.choiceOptions ?? []).find((o) => o.id === 'no');
    const pick = luoshenSteps < LUOSHEN_MAX ? yes : no;
    luoshenSteps++;
    log(
      `收到询问「${prompt.choiceTitle ?? prompt.message}」→ 拖 ${HOLD_MS}ms 后选 ${pick ? pick.id : '（无选项）'}`,
    );
    if (!pick) return;
    setTimeout(
      () => send({ type: 'intent', intent: { type: 'chooseOption', optionId: pick.id } }),
      HOLD_MS,
    );
    return;
  }

  if (prompt.kind === 'play') {
    picked = true;
    lastPlay = prompt; // 武圣逐张重试要用（见 error 那一支）
    // 转化技那条路（关羽·武圣）：把一张红牌当【杀】打给对手（见 tryWusheng）
    if (HERO === 'guanyu' && !wushengDone) {
      tryWusheng(prompt);
      return;
    }
    // 主动技那条路（非甄姬）：发动一次【制衡】就结束回合
    const legalSkills = prompt.legalSkillIds ?? [];
    if (HERO !== 'zhenji' && HERO !== 'guanyu' && !zhihengDone && legalSkills.includes('zhiheng')) {
      const cardId = (prompt.legalCardIds ?? [])[0];
      if (cardId) {
        zhihengDone = true;
        log('出牌阶段 → 发动【制衡】（弃 1 张）');
        send({
          type: 'intent',
          intent: { type: 'useSkill', skillId: 'zhiheng', cardIds: [cardId], targetIds: [] },
        });
        return;
      }
    }
    log('出牌阶段 → 结束（本脚本不主动出牌，免得干扰观察）');
    send({ type: 'intent', intent: { type: 'endPhase' } });
    return;
  }

  // 一切响应类询问都弃权：现场里不要有额外的牌在飞
  if (
    prompt.kind === 'respondSha' ||
    prompt.kind === 'respondTrick' ||
    prompt.kind === 'respondDeath'
  ) {
    send({ type: 'intent', intent: { type: 'pass' } });
    return;
  }
  if (prompt.kind === 'discard') {
    // ⚠️ 要弃几张在 `mustSelectTargetCount`（弃牌提示里它承载的是张数，见 legal.buildDiscardPrompt）
    const n = prompt.mustSelectTargetCount ?? 1;
    const ids = (prompt.legalCardIds ?? []).slice(0, n);
    if (ids.length > 0) send({ type: 'intent', intent: { type: 'discard', cardIds: ids } });
    return;
  }
  if (prompt.kind === 'pickCards') {
    const ids = (prompt.legalCardIds ?? prompt.pickCards?.map((c) => c.id) ?? []).slice(
      0,
      prompt.pickMin ?? 1,
    );
    if (ids.length > 0) send({ type: 'intent', intent: { type: 'pickCards', cardIds: ids } });
    return;
  }
  log('未处理的提示（忽略）：', prompt.kind);
});
