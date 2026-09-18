// 模糊测试的**共用驱动**：随机对局 + 不变式检查。
//
// 抽出来是因为「用例」和临时写的「定位器」必须逐字节一致——之前两者结果互相矛盾，
// 十有八九就是两边的驱动有细微差别（同样的种子跑出不同的对局）。一个驱动、两个消费者。
import {
  applyIntent,
  createGame,
  getHero,
  seededRng,
  toSnapshot,
  type GameState,
  type SeatSetup,
} from '../src';

export const rng = seededRng;

/** 轮换用的「高风险武将」：多牌操作 / 摆牌堆 / 借技能那一类 */
export const RISKY = [
  'zhugeliang', // 观星：把牌堆顶的牌重排（曾经在这里出过「同一张牌放两堆」的 bug）
  'huangyueying', // 集智
  'lvmeng', // 克己/谋断（用牌账本）
  'luxun', // 连营（手牌清空时机）
  'sunshangxiang', // 枭姬（每张失去都触发）
  'lingtong', // 旋略（一次失去只触发一次）
  'wuguotai', // 甘露（交换装备区）
  'lidian', // 忘隙（濒死救回也算存活）
  'caiwenji', // 悲歌（判定 + 弃两张）
  'zhangjiao', // 鬼道（改判）
  'simayi', // 鬼才（改判）
  'guojia', // 天妒（收判定牌）
  'dengai', // 屯田/资粮（失去牌 + 体力上限）
  'yuanshu', // 庸肆/伪帝（玉玺 + 摸牌账本 + 换手牌）
  'zuoci', // 役鬼/汲魂（魂牌堆）
  'yuji', // 千幻（武将牌上的牌堆）
  'yanbaihu', // 寄篱（结算两次）/ 雉盗
  'fazheng', // 眩惑（借技能）
  'kongrong', // 礼让（刚进弃牌堆的牌转交）
  'xunyou', // 奇策（虚拟锦囊 + 变更副将）
  'masu', // 制蛮（防止伤害 + 变更副将）
  'lvfan', // 调度（依次问同势力角色）
  'wangping', // 将略（一条军令问多人）
  'lukang', // 恪守/筑围（减伤 + 判定）
];

/** 全场所有「有归属」的牌：牌堆 + 弃牌堆 + 手牌/装备/判定/田/千幻 + 木牛流马的扣置区 */
export function allCardIds(state: GameState): string[] {
  const out: string[] = [];
  for (const c of state.deck) out.push(c.id);
  for (const c of state.discard) out.push(c.id);
  for (const p of state.players) {
    for (const c of p.hand) out.push(c.id);
    for (const slot of ['weapon', 'armor', 'plusMount', 'minusMount', 'treasure'] as const) {
      const c = p.equipment[slot];
      if (c) {
        out.push(c.id);
        for (const x of c.cargo ?? []) out.push(x.id);
      }
    }
    for (const c of p.judgment) out.push(c.id);
    for (const c of p.tian) out.push(c.id);
    for (const c of p.qianhuan) out.push(c.id);
  }
  return out;
}

/** 这张牌此刻在哪些位置（用例内部排查重复牌时打印用） */
export function cardLocations(state: GameState, id: string): string[] {
  const out: string[] = [];
  state.deck.forEach((c, i) => {
    if (c.id === id) out.push(`deck[${i}]`);
  });
  state.discard.forEach((c, i) => {
    if (c.id === id) out.push(`discard[${i}]`);
  });
  for (const p of state.players) {
    p.hand.forEach((c, i) => {
      if (c.id === id) out.push(`${p.seatId}.hand[${i}]`);
    });
    for (const slot of ['weapon', 'armor', 'plusMount', 'minusMount', 'treasure'] as const) {
      const c = p.equipment[slot];
      if (!c) continue;
      if (c.id === id) out.push(`${p.seatId}.equip.${slot}`);
      (c.cargo ?? []).forEach((x, i) => {
        if (x.id === id) out.push(`${p.seatId}.cargo[${i}]`);
      });
    }
    p.judgment.forEach((c, i) => {
      if (c.id === id) out.push(`${p.seatId}.judg[${i}]`);
    });
    p.tian.forEach((c, i) => {
      if (c.id === id) out.push(`${p.seatId}.tian[${i}]`);
    });
    p.qianhuan.forEach((c, i) => {
      if (c.id === id) out.push(`${p.seatId}.qh[${i}]`);
    });
  }
  return out;
}

/** 同一张牌不能同时存在于两个区域（这条最狠：抓到过两次真 bug） */
export function checkDuplicate(state: GameState): string | null {
  const seen = new Set<string>();
  for (const id of allCardIds(state)) {
    if (seen.has(id)) return `牌 ${id} 同时存在于两个区域`;
    seen.add(id);
  }
  return null;
}

export function pickDraft(state: GameState, seatId: string): void {
  const options = state.draft!.deals[seatId] ?? [];
  for (const a of options)
    for (const b of options) {
      if (a === b) continue;
      if (getHero(a)?.faction !== getHero(b)?.faction) continue;
      if (getHero(b)?.isLord) continue;
      if (applyIntent(state, seatId, { type: 'pickHero', heroId: a, deputyHeroId: b }).ok) return;
    }
}

/** 随机走一步：为「当前该行动的人」生成一个意图 */
export function step(state: GameState, rand: () => number): void {
  if (state.draft) {
    const seat = state.draft.pendingSeats[0];
    if (!seat) throw new Error('选将阶段没有待选座位却没结束');
    pickDraft(state, seat);
    return;
  }
  const p = state.pending;
  if (!p) throw new Error('既没有 pending 也不在选将阶段——控制权丢了');
  switch (p.kind) {
    case 'play': {
      const prompt = toSnapshot(state, p.seatId).prompt;
      const cards = prompt?.legalCardIds ?? [];
      const targets = prompt?.legalTargetIds ?? [];
      const skills = prompt?.legalSkillIds ?? [];
      const roll = rand();
      if (roll < 0.5 && cards.length > 0) {
        const cardId = cards[Math.floor(rand() * cards.length)]!;
        const n = rand() < 0.3 ? Math.min(2, targets.length) : targets.length > 0 ? 1 : 0;
        const r = applyIntent(state, p.seatId, {
          type: 'playCard',
          cardId,
          targetIds: targets.slice(0, n),
        });
        if (!r.ok && !applyIntent(state, p.seatId, { type: 'playCard', cardId, targetIds: [] }).ok) {
          applyIntent(state, p.seatId, { type: 'endPhase' });
        }
        return;
      }
      if (roll < 0.85 && skills.length > 0) {
        const skillId = skills[Math.floor(rand() * skills.length)]!;
        if (!applyIntent(state, p.seatId, { type: 'useSkill', skillId, targetIds: [] }).ok) {
          applyIntent(state, p.seatId, { type: 'endPhase' });
        }
        return;
      }
      applyIntent(state, p.seatId, { type: 'endPhase' });
      return;
    }
    case 'choice':
      applyIntent(state, p.seatId, {
        type: 'chooseOption',
        optionId: p.options[Math.floor(rand() * p.options.length)]!.id,
      });
      return;
    case 'pickCards':
      applyIntent(state, p.seatId, {
        type: 'pickCards',
        cardIds: p.cards
          .slice(0, Math.min(p.max, p.min + (rand() < 0.5 ? 1 : 0)))
          .map((c) => c.id),
      });
      return;
    case 'viewCards':
      applyIntent(state, p.seatId, { type: 'ack' });
      return;
    case 'discard':
      applyIntent(state, p.seatId, {
        type: 'discard',
        cardIds: toSnapshot(state, p.seatId)
          .myHand.slice(0, p.count)
          .map((c) => c.id),
      });
      return;
    case 'respondSha':
      applyIntent(state, p.responderId, { type: 'pass' });
      return;
    case 'respondTrick':
      applyIntent(state, p.responderId, { type: 'pass' });
      return;
    case 'respondDeath':
      applyIntent(state, p.askQueue[p.askIndex]!, { type: 'pass' });
      return;
    case 'wuxieQueue':
      applyIntent(state, p.askQueue[p.askIndex]!, { type: 'pass' });
      return;
    case 'factionCall':
      applyIntent(state, p.askQueue[p.askIndex]!, { type: 'pass' });
      return;
    default:
      throw new Error('未覆盖的 pending: ' + p.kind);
  }
}

/** 造一局：座位轮换取 RISKY 里的武将（跳过选将阶段，直接给定主副将） */
export function riskyGame(seed: number): GameState {
  const n = 4 + (seed % 3);
  const setup: SeatSetup[] = Array.from({ length: n }, (_, i) => ({
    seatId: `s${i}`,
    name: `P${i}`,
    heroId: 'vanilla',
  }));
  const state = createGame(setup, `F${seed}`, {
    mode: 'guozhan',
    shibei: true,
    freePick: true,
    rng: rng(seed * 7919),
  });
  state.draft = null;
  state.players.forEach((p, i) => {
    const heroId = RISKY[(seed * 3 + i * 7) % RISKY.length]!;
    p.heroId = heroId;
    p.deputyHeroId = RISKY[(seed * 5 + i * 11 + 3) % RISKY.length]!;
    p.faction = getHero(heroId)?.faction ?? 'qun';
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.maxHp = Math.max(1, Math.floor(getHero(heroId)?.maxHp ?? 4));
    p.hp = p.maxHp;
  });
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
  state.log = [];
  return state;
}

