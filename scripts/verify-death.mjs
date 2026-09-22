#!/usr/bin/env node
/**
 * **濒死救援真机验证**：两个自控客户端走真服务端 + 真协议，构造「体力被打到 0 以下」的现场。
 *
 * 验的是这两条（用户 2026-09-23 报的缺陷）：
 *   ① 伤害超过当前体力 ⇒ 体力可以**为负**，求桃要**逐点**补回来（「还需 N 点体力才能脱离濒死」），
 *      不能一张桃就结束；
 *   ② 濒死时**其他角色**手里的【酒】**不能**当救援牌（只有濒死者本人能自救【酒】）。
 *
 * 构造：P1＝许褚（【裸衣】【杀】伤害 +1）打 P0＝平民（4 体力）。
 *   磨到 1 体力 → 发动【裸衣】再杀 = 2 点 ⇒ -1 ⇒ 一张桃只回到 0 ⇒ 必须继续求桃。
 *
 * ⚠️ 读数说明：伤害日志与快照里的 hp 都有 `Math.max(0, …)`（夹到 0），
 *   所以**负体力只能靠引擎那句「还需 N 点体力」反推**（回复后仍 ≤0 才打），
 *   本脚本打印所有相关日志就是这个用途。
 *
 * 用法（先起服务端，默认 127.0.0.1:8080；可 `SGS_URL=ws://…` 覆盖）：
 *   node scripts/verify-death.mjs
 */
const URL = process.env.SGS_URL ?? 'ws://127.0.0.1:8080';

// ⚠️ 写 stderr：node 往文件/管道写 stdout 是缓冲的，脚本被 timeout 掐掉时什么都看不到
const log = (...a) => process.stderr.write(['[verify]', ...a].join(' ') + String.fromCharCode(10));

/** 一个极简客户端：只做「照着指令发意图」和「把快照交给回调」 */
class Client {
  constructor(name) {
    this.name = name;
    this.seatId = null;
    this.state = null;
    this.lobby = null;
    this.prompt = null;
    this.snapCount = 0;
    this.opened = false;
    this.ws = new WebSocket(URL);
    this.ws.addEventListener('open', () => {
      this.opened = true;
    });
    this.onSnap = null;
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'seated') this.seatId = m.seatId ?? this.seatId;
      if (m.type === 'lobby') {
        this.lobby = m;
        this.seatId = m.mySeatId ?? this.seatId;
      }
      if (m.type === 'snapshot') {
        this.state = m.snapshot;
        this.prompt = m.snapshot.prompt;
        this.seatId = m.snapshot.seatId;
        this.snapCount++;
        this.onSnap?.(m.snapshot);
      }
      if (m.type === 'error') {
        log(`${this.name} 被拒：`, m.message);
        // ⚠️ 被拒说明这条策略此刻不合法（例如本回合已经出过【杀】）。
        //    不记住的话，下一次提示会**原样重发**、再次被拒，回合就会一路空转到超时——
        //    第一次跑就是这样把「打穿到负体力」熬没的。被拒之后改为推进回合。
        this.rejected = true;
      }
    });
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  intent(intent) {
    this.send({ type: 'intent', intent });
  }
  async open() {
    // ⚠️ 两个客户端是**同时**建连的：第二个的 'open' 很可能在我们等第一个时就已经触发过了，
    //    此时再挂 once 监听就永远等不到（踩过一次）。
    if (!this.opened) await new Promise((r) => this.ws.addEventListener('open', r, { once: true }));
    log(this.name, 'open');
    this.send({ type: 'enterHall', name: this.name });
    await sleep(300);
    log(this.name, 'entered hall, seat=', this.seatId);
  }
  hero(id) {
    this.intent({ type: 'pickHero', heroId: id });
  }
  get me() {
    return this.state?.players.find((p) => p.seatId === this.seatId);
  }
  get hand() {
    return this.state?.myHand ?? [];
  }
  get log() {
    return (this.state?.log ?? []).map((l) => l.message);
  }
  get others() {
    return (this.state?.players ?? []).filter((p) => p.seatId !== this.seatId);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等到某个条件成立（或超时） */
async function until(fn, ms = 6000, tag = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(60);
  }
  log(`⚠️ 等待超时：${tag}`);
  return false;
}

log('start');
const P0 = new Client('受害者');
const P1 = new Client('许褚');

await P0.open();
await P1.open();

// 建房（混战：2 人即可，且每人只选一名武将）
P1.send({ type: 'createRoom' });
await until(() => P1.lobby?.roomCode, 5000, '建房');
const room = P1.lobby?.roomCode;
if (!room) {
  log('没能建出房间，退出');
  process.exit(1);
}
log('房号', room);
P1.send({ type: 'setMode', mode: 'melee' });
P1.send({ type: 'setFreePick', freePick: true });
await sleep(500);
P0.send({ type: 'joinRoom', roomCode: room });
await until(() => P0.lobby?.roomCode, 5000, '入房');
await sleep(400);
P1.send({ type: 'startGame', mode: 'melee', freePick: true });
await until(() => P1.prompt?.kind === 'pickHero', 5000, '选将');
P1.hero('xuchu'); // 许褚（裸衣）
P0.hero('vanilla'); // 白板平民
await until(() => P1.prompt?.kind === 'play' || P1.prompt?.kind === 'choice', 6000, '开局');

// —— 主循环：谁被问了就照策略回答 ——
const notes = [];
let step = 0;
const MAX_STEPS = 700;
/** P1 本回合是否已用过裸衣 / 是否要攒着酒打一发 */
let luoyiArmedTurn = -1;
let dyingRound = 0;

function answerP0() {
  const p = P0.prompt;
  if (!p) return false;
  if (p.kind === 'play') {
    P0.intent({ type: 'endPhase' });
    return true;
  }
  if (p.kind === 'respondSha' || p.kind === 'respondTrick' || p.kind === 'respondDeath') {
    // 濒死救援：把**每一步下发的合法牌**记下来（这就是界面上可点的牌）
    if (p.kind === 'respondDeath') {
      notes.push({
        round: ++dyingRound,
        who: '受害者(濒死者本人)',
        hp: P0.me?.hp,
        msg: p.message,
        handAll: P0.hand.map((c) => `${c.suit}${c.rank}·${c.type}`),
        legal: p.legalCardIds.map((id) => {
          const c = P0.hand.find((x) => x.id === id);
          return c ? `${c.suit}${c.rank}·${c.type}` : id;
        }),
      });
    }
    // ⚠️ 测量点：濒死时**自己吃桃**。引擎在回复后体力仍 ≤0 时会打
    //    「…还需 N 点体力才能脱离濒死。」——`N` 是**唯一没被夹到 0** 的读数
    //    （伤害日志与快照的 hp 都有 Math.max(0,…)，负体力根本看不出来）。
    //    1 血挨 2 点 ⇒ -1；吃一张桃 ⇒ 0 ⇒ 日志必须说「还需 1 点」。
    if (p.kind === 'respondDeath') {
      const tao = P0.hand.find((c) => c.type === 'tao');
      if (tao) {
        P0.intent({ type: 'respondCard', cardId: tao.id });
        return true;
      }
    }
    P0.intent({ type: 'pass' });
    return true;
  }
  if (p.kind === 'discard') {
    const need = p.mustSelectTargetCount ?? 0;
    // 留住【桃】【酒】（救援要用），先丢别的
    const keep = (c) => c.type === 'tao' || c.type === 'jiu';
    const pool = [...P0.hand].sort((a, b) => Number(keep(a)) - Number(keep(b)));
    P0.intent({ type: 'discard', cardIds: pool.slice(0, need).map((c) => c.id) });
    return true;
  }
  if (p.kind === 'choice') {
    P0.intent({ type: 'chooseOption', optionId: p.choiceOptions?.[0]?.id ?? 'no' });
    return true;
  }
  if (p.kind === 'ack') {
    P0.intent({ type: 'ack' });
    return true;
  }
  return false;
}

function answerP1() {
  const p = P1.prompt;
  if (!p) return false;
  // 刚被拒过 ⇒ 这条打法此刻不合法，直接推进（出牌阶段结束 / 响应弃权）
  if (P1.rejected) {
    P1.rejected = false;
    if (p.kind === 'play') P1.intent({ type: 'endPhase' });
    else if (p.kind === 'discard') {
      const need = p.mustSelectTargetCount ?? 0;
      P1.intent({ type: 'discard', cardIds: P1.hand.slice(0, need).map((c) => c.id) });
    } else if (p.kind === 'choice') {
      P1.intent({ type: 'chooseOption', optionId: p.choiceOptions?.[0]?.id ?? 'no' });
    } else if (p.kind === 'ack') P1.intent({ type: 'ack' });
    else P1.intent({ type: 'pass' });
    return true;
  }
  const target = P1.others[0];
  const find = (t) => P1.hand.find((c) => c.type === t);
  if (p.kind === 'play') {
    const targetHp = target?.hp ?? 0;
    const sha = find('sha');
    // ⚠️ 策略要点（为了构造现场）：
    //  · **不主动打【酒】**——攒着，好在对方濒死时检查「其他角色的酒能不能救人」；
    //  · 对方体力 ≥2 时**拒掉【裸衣】**（每刀 1 点，慢慢磨到 1）；
    //  · 对方体力 ≤1 时**发动【裸衣】**⇒ 这一刀 2 点 ⇒ 打穿到**负体力**。
    if (sha && targetHp > 0) {
      P1.intent({ type: 'playCard', cardId: sha.id, targetIds: [target.seatId] });
      return true;
    }
    P1.intent({ type: 'endPhase' });
    return true;
  }
  if (p.kind === 'choice') {
    const opts = p.choiceOptions ?? [];
    // 裸衣的询问：体力 ≥2 时选「不发动」，≤1 时选「发动」
    if ((p.message ?? '').includes('裸衣')) {
      const hp = target?.hp ?? 9;
      const want = hp <= 1 ? /发动/ : /不发动/;
      const o = opts.find((x) => want.test(x.label ?? '')) ?? opts[0];
      P1.intent({ type: 'chooseOption', optionId: o.id });
      return true;
    }
    P1.intent({ type: 'chooseOption', optionId: opts[0]?.id ?? 'no' });
    return true;
  }
  if (p.kind === 'respondDeath') {
    // 濒死救援（**不是**濒死者）：把下发的合法牌记下来 ⇒ 这里**不该**出现【酒】
    notes.push({
      round: dyingRound,
      who: '许褚(其他角色)',
      hp: P0.me?.hp,
      msg: p.message,
      legal: p.legalCardIds.map((id) => {
        const c = P1.hand.find((x) => x.id === id);
        return c ? `${c.suit}${c.rank}·${c.type}` : id;
      }),
      handAll: P1.hand.map((c) => `${c.suit}${c.rank}·${c.type}`),
    });
    // 有桃就救（让现场能走到「逐点回复」那一步）
    const tao = P1.hand.find((c) => c.type === 'tao');
    if (tao) {
      P1.intent({ type: 'respondCard', cardId: tao.id });
      return true;
    }
    P1.intent({ type: 'pass' });
    return true;
  }
  if (p.kind === 'respondSha' || p.kind === 'respondTrick') {
    const c = P1.hand.find((x) => p.legalCardIds.includes(x.id));
    if (c) {
      P1.intent({ type: 'respondCard', cardId: c.id });
      return true;
    }
    P1.intent({ type: 'pass' });
    return true;
  }
  if (p.kind === 'discard') {
    const need = p.mustSelectTargetCount ?? 0;
    // 留住【桃】【酒】：桃用于救援、酒**专门**留着给「其他角色不能用酒救援」那一验
    const keep = (c) => c.type === 'tao' || c.type === 'jiu';
    const pool = [...P1.hand].sort((a, b) => Number(keep(a)) - Number(keep(b)));
    P1.intent({ type: 'discard', cardIds: pool.slice(0, need).map((c) => c.id) });
    return true;
  }
  if (p.kind === 'ack') {
    P1.intent({ type: 'ack' });
    return true;
  }
  return false;
}

const seenLogs = new Set();
while (step++ < MAX_STEPS) {
  // 有没有新日志里出现「还需 … 点体力」
  for (const m of P1.log) {
    if (seenLogs.has(m)) continue;
    seenLogs.add(m);
    if (/还需|濒死|阵亡|回复|酒|先手|摸牌/.test(m)) log('  ·', m);
  }
  for (const m of P0.log) {
    if (seenLogs.has(m)) continue;
    seenLogs.add(m);
    if (/还需|濒死|阵亡|回复|酒/.test(m)) log('  ·', m);
  }
  const p0hp = P0.me?.hp;
  const p1hp = P1.me?.hp;
  if (P0.state?.winner || P1.state?.winner) break;
  if (notes.length >= 6 && !P0.state?.winner && !P1.state?.winner) break; // 记够了就收
  if (!answerP0() && !answerP1()) {
    await sleep(200);
    // 两人都没提示 ⇒ 可能游戏结束了
    if (P0.state?.winner || P1.state?.winner) break;
  }
  await sleep(120);
}

log('---- 结果 ----');
// ⚠️ `me` 快照里**没有** alive（第一版打印出 `alive = `），存活状态要看 players 数组。
const seatInfo = (c, seatId) => c.state?.players?.find((x) => x.seatId === seatId);
log(
  '受害者 hp =',
  P0.me?.hp,
  'alive =',
  seatInfo(P0, P0.seatId)?.isAlive,
  '| 许褚 hp =',
  P1.me?.hp,
  'alive =',
  seatInfo(P1, P1.seatId)?.isAlive,
);
log('许褚 hp =', P1.me?.hp);
for (const n of notes) {
  log(
    `${n.who}（濒死者 hp=${n.hp}）\n    提示：${n.msg}\n    合法牌：${JSON.stringify(n.legal)}\n    手里有：${JSON.stringify(n.handAll ?? [])}`,
  );
}
log('最后 12 条日志：');
for (const m of P1.log.slice(-12)) log('   ', m);
process.exit(0);
