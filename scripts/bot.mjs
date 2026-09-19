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
    return;
  }

  if (msg.type !== 'snapshot') return;
  const prompt = msg.snapshot.prompt;
  if (!prompt) return;

  const pick = (n) => (prompt.legalCardIds ?? []).slice(0, n);

  if (prompt.kind === 'pickHero' && !picked) {
    const heroes = prompt.legalHeroIds ?? [];
    if (heroes.length === 0) return;
    picked = true;
    // 国战要**两位同阵营**武将（主将 + 副将），送一个会被服务端拒掉（「国战需选 2 位武将」）——
    // 所以这里按「两两配对、挑第一对能同阵营的」来选；非国战照旧只送一位。
    if (mode === 'guozhan') {
      const off = HERO ? heroes.indexOf(HERO) : -1;
      const rest = off >= 0 ? [heroes[off], ...heroes.filter((h) => h !== HERO)] : heroes;
      log('选将（国战）：', rest[0], '+', rest[1]);
      send({
        type: 'intent',
        intent: { type: 'pickHero', heroId: rest[0], deputyHeroId: rest[1] },
      });
      return;
    }
    const mine = HERO && heroes.includes(HERO) ? HERO : heroes[heroes.length - 1];
    log('选将：', mine);
    send({ type: 'intent', intent: { type: 'pickHero', heroId: mine } });
    return;
  }

  if (prompt.kind === 'play') {
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
    const opt =
      (prompt.options ?? []).find((o) => o.id === 'no' || o.id === 'none') ?? prompt.options?.[0];
    if (opt) send({ type: 'intent', intent: { type: 'chooseOption', optionId: opt.id } });
    return;
  }

  // 其余（出闪/无懈/濒死求桃/弃权…）一律 pass
  send({ type: 'intent', intent: { type: 'pass' } });
});
