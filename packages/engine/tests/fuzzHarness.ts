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
  type Card,
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
  // 君主将：君主技那条线（从游戏外取专属装备、装备牌自己的触发效果）很值得烧
  'juncaocao', // 君主旗/雄驰/征戎（虚拟伤害 + 从牌堆找【杀】）+ 专属宝物【六龙骖驾】
  'junliubei', // 励众（roundEnd 账本）+ 专属宝物【飞龙夺凤】
  'junyuanshao', // 会盟（势力人数 0↔非0）+ 授锋（首张伤害牌账本）+ 专属宝物【盟军大纛】
  'junsunquan', // 督授（跨武将的出牌阶段技能）+ 据江（锦囊额外结算一次）+ 专属宝物【定澜夜明珠】
  // 不臣篇·双势力：验「交给牌」的搬牌路径、按实体牌的强化、以及结束阶段的记账
  'liuqi', // 问计（交牌 + 回礼 + 无距离/次数/不能被响应）+ 屯江（出牌阶段记账 + 全场势力数）
  // 徐庶：诛害（别人结束阶段 → 由技能发起一次完整的【杀】使用 + 无视防具 + 闪后弃牌）
  // + 荐才（副将技：每轮获知武将牌 / 伤害前防止整笔 + 变更副将）
  'xushu',
];

/**
 * 全场所有「有归属」的牌：牌堆 + 弃牌堆 + 手牌/装备/判定/田/千幻。
 *
 * ⚠️ **木牛流马扣置的牌（cargo）跟着这张装备牌走**——所以在**任何**区域里都要连它一起数，
 * 不能只在装备区数：制蛮/顺手牵羊把【木牛流马】拿到手里时，扣置的牌也跟着进手牌，
 * 只数装备区的话会误报成「这张牌凭空消失了」（模糊测试里踩过）。
 */
export function allCardIds(state: GameState): string[] {
  const out: string[] = [];
  const push = (c: Card): void => {
    out.push(c.id);
    for (const x of c.cargo ?? []) out.push(x.id);
  };
  for (const c of state.deck) push(c);
  for (const c of state.discard) push(c);
  for (const p of state.players) {
    for (const c of p.hand) push(c);
    for (const slot of ['weapon', 'armor', 'plusMount', 'minusMount', 'treasure'] as const) {
      const c = p.equipment[slot];
      if (c) push(c);
    }
    for (const c of p.judgment) push(c);
    for (const c of p.tian) push(c);
    for (const c of p.qianhuan) push(c);
  }
  return out;
}

/** 这张牌此刻在哪些位置（用例内部排查重复牌时打印用） */
export function cardLocations(state: GameState, id: string): string[] {
  const out: string[] = [];
  const chk = (c: Card, where: string): void => {
    if (c.id === id) out.push(where);
    (c.cargo ?? []).forEach((x, i) => {
      if (x.id === id) out.push(`${where}.cargo[${i}]`);
    });
  };
  state.deck.forEach((c, i) => chk(c, `deck[${i}]`));
  state.discard.forEach((c, i) => chk(c, `discard[${i}]`));
  for (const p of state.players) {
    p.hand.forEach((c, i) => chk(c, `${p.seatId}.hand[${i}]`));
    for (const slot of ['weapon', 'armor', 'plusMount', 'minusMount', 'treasure'] as const) {
      const c = p.equipment[slot];
      if (c) chk(c, `${p.seatId}.equip.${slot}`);
    }
    p.judgment.forEach((c, i) => chk(c, `${p.seatId}.judg[${i}]`));
    p.tian.forEach((c, i) => chk(c, `${p.seatId}.tian[${i}]`));
    p.qianhuan.forEach((c, i) => chk(c, `${p.seatId}.qh[${i}]`));
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
        // 先试「带一张牌发动」——君威/制衡那类技能要付牌的代价，不递牌就永远发动不了
        // （君主将的专属装备因此一直没被烧到过）。失败再退回不带牌的写法。
        if (cards.length > 0) {
          const withCard = applyIntent(state, p.seatId, {
            type: 'useSkill',
            skillId,
            cardIds: [cards[Math.floor(rand() * cards.length)]!],
            targetIds: [],
          });
          if (withCard.ok) return;
        }
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


/**
 * 「牌不在任何区域」的守望器：跨步统计每张牌的缺席时长。
 *
 * 为什么不直接查「牌数守恒」：结算中途有牌**本来就该在飞**——判定牌被结算流程拿在手里、
 * 五谷丰登/观星亮出来的那一池、拼点亮出的两张……它们不在任何区域，但也不是丢了。
 * 只在「牌堆 + 弃牌堆 + 手牌 + 装备 + 判定区 + 田 + 千幻」里数牌，会被这些正常的在飞状态
 * 反复误报（一开始就是这么被误导的：几十个种子「少 1-2 张」，其实全是在飞）。
 *
 * 真正该抓的是**积压**：一条被打断的流程忘了接着跑，那张牌就一直攥在闭包里没人放回去。
 * 所以口径改成——
 * - 只在**稳定时刻**（出牌/弃牌阶段的挂起）数缺席：这时候除了在飞没有别的理由不在区域里；
 * - 同一张牌连续缺席超过 `limit` 个稳定步 = 积压（续接队列被卡住、结算被推迟）。
 * - 「游戏结束那一刻」不查：最后一击可能正结算到一半，牌还在飞属正常（实测 200 局里有
 *   55 张是这样「没回来」的，都不是 bug）。
 *
 * 标定（200 局实测，2026-09）：修掉续接队列的排序 bug 前最久 27-44 步，
 * 修完之后最久 4 步（都是判定链里正常的几次询问），所以 limit 取 5。
 */
export function makeCardWatch(ids0: string[], limit = 5) {
  const absence = new Map<string, number>();
  return {
    /** 每步调一次：返回第一条「积压」告警（同一张牌只报一次） */
    observe(state: GameState): string | null {
      const pend = state.pending;
      const stable = pend?.kind === 'play' || pend?.kind === 'discard';
      const now = new Set(allCardIds(state));
      for (const id of ids0) {
        if (now.has(id)) {
          absence.delete(id);
          continue;
        }
        if (!stable) continue;
        const n = (absence.get(id) ?? 0) + 1;
        if (n >= limit) {
          absence.delete(id); // 只报一次，别刷屏
          return `牌 ${id} 连续 ${n} 个稳定步不在任何区域（结算被积压了？）`;
        }
        absence.set(id, n);
      }
      return null;
    },
  };
}

