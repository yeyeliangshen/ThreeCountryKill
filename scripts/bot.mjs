#!/usr/bin/env node
/**
 * 陪练机器人 —— 本地联机自测 / 看界面用 / 当规则的真机验收现场。
 *
 * 连上服务端后：建一个混战房间（默认开「选将不限」，方便挑想看的武将）→
 * 有真人进来就开局 → 自己随便选一个将 → **每个出牌阶段挑一张牌打出去**、
 * 被要求响应时**手里有对应的牌就打、没有才弃权**。
 *
 * ⚠️ 为什么不再「一律弃权」（2026-09-22 改）：那样**永远构造不出**需要真机验收的现场——
 * 无懈窗口（要有人的牌被打进窗口）、无懈反制链、装备栏（要有装备挂在身上）、
 * 决斗/南蛮的响应。规则改完之后只能靠单测，看不到界面上真的发生。
 * 现在它每个回合**最多打一张**（装备 > 杀 > 锦囊 > 桃），出牌被服务端拒就直接结束回合，
 * 所以既热闹又不会把牌打空、也不会卡住。要回旧行为：`PASSIVE=1`。
 *
 * 用法：
 *   node scripts/bot.mjs                        # 建房当房主，等真人进来开局
 *   ROOM=4831 SEAT=1 node scripts/bot.mjs       # 接替某个座位（重连已开局的陪练）
 *   SGS_URL=ws://192.168.1.5:8080 node scripts/bot.mjs
 *   NAME=陪练 HERO=zhangfei node scripts/bot.mjs
 *   REVEAL=1 node scripts/bot.mjs                 # 准备阶段选择「全部明置」（看别人面板的
 *                                                # 「明置武将 + 技能提示」时用；默认保持暗将）
 *   PASSIVE=1 node scripts/bot.mjs                # 退回旧行为：出牌阶段一律结束、响应一律弃权
 *   PLAY_PER_TURN=4 node scripts/bot.mjs          # 本回合**最多打几张**（默认 1）：想构造
 *                                                # 「对手空手」这类现场时调到 4，几轮就把它打空
 *
 * 只用到 Node 自带的 WebSocket（Node 22+），不需要额外装包。
 * 房号/座位号在服务端日志或大厅里能看到；接替座位用的是「离线座位可以认回」那条规则。
 */
const URL = process.env.SGS_URL ?? 'ws://127.0.0.1:8080';
const NAME = process.env.NAME ?? '陪练';
const ROOM = process.env.ROOM ?? null;
const SEAT = process.env.SEAT ?? null;
const HERO = process.env.HERO ?? null;
const PASSIVE = process.env.PASSIVE === '1';
/** 每个出牌阶段**最多**打几张（默认 1：牌不会打空，看得到也留得住）。
 *  调大（如 4）是为了构造「对手手里没牌」这类现场——调小到 1 是默认行为。 */
const PLAY_PER_TURN = Math.max(1, Number(process.env.PLAY_PER_TURN ?? 1) || 1);
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

/** 需要指定目标的牌（类型 → 需要的目标数）；其余按「不需要目标」发，被拒就结束回合 */
const NEEDS_TARGET = {
  sha: 1,
  juedou: 1,
  guohe: 1,
  shunshou: 1,
  huogong: 1,
  lebu: 1,
  shandian: 1,
  bingliang: 1,
  jiedao: 2,
  tiesuo: 1,
  lianjun: 1,
  lutong: 1,
  huoshao: 0, // 目标由规则算（下家那一队）
  nanman: 0,
  wanjian: 0,
  wuzhong: 0,
  taoyuan: 0,
  yiyi: 0,
  chiling: 0,
};
const EQUIP_TYPES = new Set(['weapon', 'armor', 'plusMount', 'minusMount', 'treasure']);

/**
 * 出牌阶段挑**一张**要打的牌（每个回合最多一张，别把牌打空）：
 * 装备 > 杀 > 有目标的锦囊 > 无目标的锦囊 > 桃（自己受伤时）。
 *
 * 目标从 `prompt.legalTargetIds` 里取前 N 个（N 按牌型猜，猜错就被服务端拒、
 * 我们直接结束回合——不重试不卡住）。牌面（类型/花色/点数）从 `myHand` 里查。
 */
function choosePlayCard(snapshot, prompt) {
  const legal = prompt.legalCardIds ?? [];
  if (legal.length === 0) return null;
  const targets = prompt.legalTargetIds ?? [];
  const hand = new Map();
  for (const c of snapshot.myHand ?? []) hand.set(c.id, c);
  const me = (snapshot.players ?? []).find((p) => p.seatId === snapshot.seatId);
  // 木牛流马扣置的「辎」也算可用牌（本人那一份里能看到内容）
  for (const e of me?.equipment ?? []) for (const c of e.cargo ?? []) hand.set(c.id, c);
  const cardOf = (id) => hand.get(id);
  const label = (id) => {
    const c = cardOf(id);
    return c ? `${c.suit ?? ''}${c.rank ?? ''}·${c.type}` : id;
  };
  const wounded = !!me && me.hp < me.maxHp;
  const score = (c) => {
    if (EQUIP_TYPES.has(c.type)) return 0; // 装备优先（顺手就把对手面板的装备栏填上）
    if (c.type === 'sha') return targets.length > 0 ? 1 : 9;
    if (c.type === 'tao') return wounded ? 4 : 9;
    if (c.type === 'jiu') return 9;
    // 其余锦囊：需要目标的排在前面（更有戏看）
    return (NEEDS_TARGET[c.type] ?? 0) > 0 ? 2 : 3;
  };
  const pool = legal
    .map((id) => cardOf(id))
    .filter((c) => !!c && score(c) < 9)
    .sort((a, b) => score(a) - score(b));
  const card = pool[0];
  if (!card) return null;
  const need = NEEDS_TARGET[card.type] ?? 0;
  const targetIds = need > 0 ? targets.slice(0, need) : [];
  if (need > 0 && targetIds.length < need) return null; // 没有合法目标就不打这张
  return { cardId: card.id, targetIds, label: label(card.id) };
}

const ws = new WebSocket(URL);
const send = (msg) => ws.send(JSON.stringify(msg));

let playedThisTurn = 0; // 本回合已经打了几张（上限见 PLAY_PER_TURN）
let lastTurnSeat = null; // 上一次看到的回合座位（换了人就重置 playedThisTurn）
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
    // ⚠️ 判据是「**还在国战选将**」而不是某一句错误文案：房主开了「选将不限」时，
    //    服务端拒的理由会是「不能组合」那类，按文案匹配会让陪练卡死在选将阶段（实测踩到）。
    if (mode === 'guozhan' && !picked) sendGuozhanPick();
    return;
  }

  if (msg.type !== 'snapshot') return;
  // ⚠️ 「回合换人了就清零出牌计数」必须放在**下面那个早退之前**：
  //    没有提示（＝不是问我的那些快照）也要看回合座位。原来放在早退之后，于是陪练只在
  //    **自己**的回合才更新 lastTurnSeat ⇒ 一直是自己、永远不重置 ⇒ 从第二回合起每个
  //    出牌阶段都判成「本回合已经打过一张」、一张牌都不出（真机验收时撞出来的：
  //    日志里连续出现「出牌阶段 → 结束（本回合已经打过一张）」）。
  const turnSeat = msg.snapshot.turn?.seatId ?? null;
  if (turnSeat !== lastTurnSeat) {
    lastTurnSeat = turnSeat;
    playedThisTurn = 0;
  }
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
    if (PASSIVE || playedThisTurn >= PLAY_PER_TURN) {
      log(
        `出牌阶段 → 结束${PASSIVE ? '（PASSIVE=1）' : `（本回合已打 ${playedThisTurn} 张）`}`,
      );
      send({ type: 'intent', intent: { type: 'endPhase' } });
      return;
    }
    const chosen = choosePlayCard(msg.snapshot, prompt);
    if (!chosen) {
      log('出牌阶段 → 没有想打的牌，结束回合');
      send({ type: 'intent', intent: { type: 'endPhase' } });
      return;
    }
    playedThisTurn++;
    log(
      `出牌阶段 → 打出 ${chosen.label}${chosen.targetIds.length ? ` 指 ${chosen.targetIds.join('、')}` : ''}`,
    );
    send({
      type: 'intent',
      intent: { type: 'playCard', cardId: chosen.cardId, targetIds: chosen.targetIds },
    });
    // 被服务端拒（目标数不对之类）就**放弃这一手、结束回合**——不重试、不卡住
    return;
  }

  // 被【杀】指定 / 决斗・南蛮・万箭的响应：手里有对应的牌就打，没有才弃权
  if (prompt.kind === 'respondSha' || prompt.kind === 'respondTrick') {
    const legal = prompt.legalCardIds ?? [];
    if (!PASSIVE && legal.length > 0) {
      log('响应 →', prompt.kind, '打', legal[0]);
      send({ type: 'intent', intent: { type: 'respondCard', cardId: legal[0] } });
      return;
    }
    send({ type: 'intent', intent: { type: 'pass' } });
    return;
  }

  // 无懈窗口：手里有无懈（或能当无懈用的牌）就打——这样「无懈窗口/反制链」在真机上才走得到
  if (prompt.kind === 'wuxieQueue') {
    const legal = prompt.legalCardIds ?? [];
    if (!PASSIVE && legal.length > 0) {
      log('无懈窗口 → 打', legal[0]);
      send({ type: 'intent', intent: { type: 'respondCard', cardId: legal[0] } });
      return;
    }
    send({ type: 'intent', intent: { type: 'pass' } });
    return;
  }

  if (prompt.kind === 'discard') {
    const n = prompt.mustSelectTargetCount ?? 0;
    log('弃牌', n, '张');
    send({ type: 'intent', intent: { type: 'discard', cardIds: pick(n) } });
    return;
  }

  if (prompt.kind === 'pickCards') {
    // ⚠️ 候选牌在 **`pickCards`**（一整份牌面），张数区间在 **`pickMin`/`pickMax`**；
    //    `legalCardIds` 对这类询问是**空的**（它只用于手牌响应），`mustSelectTargetCount` 是 0。
    //    以前这里读的是后两个字段 ⇒ 发出去空 cardIds ⇒ 服务端拒「需选择 1-1 张牌」⇒ 陪练不再应答，
    //    整局**静默停在**「从一组牌里挑」的询问上（实测：太史慈天义拼点，2026-09-21）。
    const cards = prompt.pickCards ?? [];
    const min = Math.max(1, prompt.pickMin ?? 1);
    const n = Math.min(cards.length, min);
    if (n === 0) {
      log('pickCards：没有可选的牌，不发');
      return;
    }
    send({ type: 'intent', intent: { type: 'pickCards', cardIds: cards.slice(0, n).map((c) => c.id) } });
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

  if (prompt.kind === 'pickSeats') {
    // 多选座位（一次选几名角色）：候选在 `seatCandidates`，至少几个看 `pickMin`。
    // 与 pickCards 同一类坑——读错字段就会**静默卡住**，所以宁可显式处理。
    const cands = prompt.seatCandidates ?? [];
    const min = Math.max(1, prompt.pickMin ?? 1);
    if (cands.length < min) {
      log('pickSeats：候选不够，弃权兜底');
      send({ type: 'intent', intent: { type: 'pass' } });
      return;
    }
    send({ type: 'intent', intent: { type: 'pickSeats', seatIds: cands.slice(0, min) } });
    return;
  }

  if (prompt.kind === 'viewCards') {
    // 私密查看（知己知彼）：看完要 `ack`，`pass` 不是合法意图（会被拒 → 整局停在这一点）。
    send({ type: 'intent', intent: { type: 'ack' } });
    return;
  }

  // 其余（出闪/无懈/濒死求桃/弃权…）一律 pass
  send({ type: 'intent', intent: { type: 'pass' } });
});
