#!/usr/bin/env node
/**
 * 陪练机器人 —— 本地联机自测 / 看界面用。
 *
 * 连上服务端后：建一个混战房间（默认开「选将不限」，方便挑想看的武将）→
 * 有真人进来就开局 → 自己随便选一个将 → 出牌阶段一律结束、需要响应一律弃权。
 * 这样单人就能把界面从选将点到出牌，不用真等第二个玩家。
 *
 * 用法：
 *   node scripts/bot.mjs                        # 建房当房主，等真人进来开局
 *   ROOM=4831 SEAT=1 node scripts/bot.mjs       # 接替某个座位（重连已开局的陪练）
 *   SGS_URL=ws://192.168.1.5:8080 node scripts/bot.mjs
 *   NAME=陪练 HERO=zhangfei node scripts/bot.mjs
 *   REVEAL=1 node scripts/bot.mjs                 # 准备阶段选择「全部明置」（看别人面板的
 *                                                # 「明置武将 + 技能提示」时用；默认保持暗将）
 *
 * 只用到 Node 自带的 WebSocket（Node 22+），不需要额外装包。
 * 房号/座位号在服务端日志或大厅里能看到；接替座位用的是「离线座位可以认回」那条规则。
 */
const URL = process.env.SGS_URL ?? 'ws://127.0.0.1:8080';
const NAME = process.env.NAME ?? '陪练';
const ROOM = process.env.ROOM ?? null;
const SEAT = process.env.SEAT ?? null;
const HERO = process.env.HERO ?? null;
let mode = null; // 当前房间模式（国战要选两位同阵营武将）
let pairs = []; // 国战选将的候选组合（被服务端拒就换下一对）
let pickAttempt = 0;
const HEROES = (process.env.HEROES ?? '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean); // 想先试哪一对（例如 HEROES=caocao,xiahoudun）

function sendGuozhanPick() {
  const pair = pairs[pickAttempt];
  if (!pair) {
    log('国战选将：候选组合都试完了');
    return;
  }
  pickAttempt++;
  log('选将（国战）尝试：', pair[0], '+', pair[1]);
  send({ type: 'intent', intent: { type: 'pickHero', heroId: pair[0], deputyHeroId: pair[1] } });
}

const log = (...a) => console.log('[bot]', ...a);
const ws = new WebSocket(URL);
const send = (msg) => ws.send(JSON.stringify(msg));

let asked = false; // 只在第一次拿到大厅列表时做一次「建房 / 进房」
let started = false;
let picked = false;

ws.addEventListener('open', () => {
  log('已连接', URL, '→ 进大厅');
  send({ type: 'enterHall', name: NAME });
});

ws.addEventListener('close', () => log('连接关闭'));
ws.addEventListener('error', () => log('连接出错'));

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
    mode = msg.mode;
    log(`房号 ${msg.roomCode}，我在 ${msg.mySeatId} 号座，已落座 ${seated} 人，模式 ${msg.mode}`);
    // 房主才切换模式 / 开局；接替座位的那条路不动这些
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
    // 国战选将「两位要同阵营」：被拒就换下一对继续试（否则这个陪练永远不发将、整局开不起来）
    if (mode === 'guozhan' && !picked && msg.message.includes('国战需选')) sendGuozhanPick();
    return;
  }

  if (msg.type !== 'snapshot') return;
  const prompt = msg.snapshot.prompt;
  if (!prompt) return;
  // 诊断：把「我看到什么提示」打出来（排查「陪练不动了」时一眼能看出卡在哪条询问上）
  log('提示：', prompt.kind, '|', (prompt.message ?? '').slice(0, 36));

  const pick = (n) => (prompt.legalCardIds ?? []).slice(0, n);

  if (prompt.kind === 'pickHero' && !picked) {
    const heroes = prompt.legalHeroIds ?? [];
    if (heroes.length === 0) return;
    // 国战要**两位同阵营**武将（主将 + 副将），瞎送一位会被服务端拒（「国战需选 2 位武将」）。
    // 这里把发到的牌两两列成候选（HEROES 指定的那对排最前），被拒就换下一对——**直到服务端收下**；
    // 非国战照旧只送一位。
    if (mode === 'guozhan') {
      const pref = HEROES.filter((h) => heroes.includes(h));
      const ordered = [...pref, ...heroes.filter((h) => !pref.includes(h))];
      pairs = [];
      for (let i = 0; i < ordered.length; i++)
        for (let j = 0; j < ordered.length; j++) {
          if (i === j) continue;
          if (pref.length === 2 && !(pref.includes(ordered[i]) && pref.includes(ordered[j]))) continue;
          pairs.push([ordered[i], ordered[j]]);
        }
      pickAttempt = 0;
      sendGuozhanPick();
      return;
    }
    picked = true;
    const mine = HERO && heroes.includes(HERO) ? HERO : heroes[heroes.length - 1];
    log('选将：', mine);
    send({ type: 'intent', intent: { type: 'pickHero', heroId: mine } });
    return;
  }

  if (prompt.kind === 'play') {
    picked = true; // 已经进对局了，说明选将已被接受
    log('出牌阶段 → 结束，把回合让出去');
    send({ type: 'intent', intent: { type: 'endPhase' } });
    return;
  }

  if (prompt.kind === 'discard') {
    const n = prompt.mustSelectTargetCount ?? 0;
    log('弃牌', n, '张');
    send({ type: 'intent', intent: { type: 'discard', cardIds: pick(n) } });
    return;
  }

  if (prompt.kind === 'pickCards') {
    const n = Math.max(1, prompt.mustSelectTargetCount ?? 1);
    send({ type: 'intent', intent: { type: 'pickCards', cardIds: pick(n) } });
    return;
  }

  if (prompt.kind === 'choice') {
    // ⚠️ 选项字段是 **`choiceOptions`**（不是 `options`）——以前这里读错字段，`opt` 永远是
    //    undefined，于是「看到了询问却什么也不发」：对局停在别人的询问上（实测：陪练收到
    //    【阵法召唤】的 choice、日志打了提示、然后整局不动）。
    if (process.env.DUMP) log('原始 prompt：', JSON.stringify(prompt).slice(0, 300));
    const opts = prompt.choiceOptions ?? prompt.options ?? [];
    // 默认策略是「能不发动就不发动」（no/none 优先）；例外：**阵法召唤**要响应，
    // 否则陪练永远保持暗置、召唤验证不了（配合「准备阶段选暂不明置」＝保持暗将状态）。
    const isSummon = (prompt.message ?? '').includes('阵法召唤');
    // 阵法召唤有两问：①「是否响应」→ 要 **yes**；②「明置哪一张武将牌」→ 没有 yes，
    // 取第一个（＝明置主将）。以前第二问也去找 yes，找不到就整局不动了（实测）。
    // REVEAL=1：准备阶段的「是否明置武将牌」一律选「全部明置」——
    // 默认策略是保持暗将（配合「能不发动就不发动」），但要看**别人面板上的明置武将/技能提示**
    // 时得先让陪练亮出来。
    const isRevealAsk = (prompt.message ?? '').includes('明置武将牌');
    const wantReveal = process.env.REVEAL === '1' && isRevealAsk;
    const opt = isSummon
      ? (opts.find((o) => o.id === 'yes') ?? opts[0])
      : wantReveal
        ? (opts.find((o) => o.label?.includes('全部明置')) ?? opts.find((o) => o.label?.includes('明置主将')) ?? opts[0])
        : (opts.find((o) => o.id === 'no' || o.id === 'none') ?? opts[0]);
    if (!opt) {
      log('choice 没有可选项，弃权兜底：', prompt.message ?? '');
      send({ type: 'intent', intent: { type: 'pass' } });
      return;
    }
    send({ type: 'intent', intent: { type: 'chooseOption', optionId: opt.id } });
    log('选择：', opt.label ?? opt.id);
    return;
  }

  // 其余（出闪/无懈/濒死求桃/弃权…）一律 pass
  send({ type: 'intent', intent: { type: 'pass' } });
});
