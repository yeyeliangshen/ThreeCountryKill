/**
 * **国战徐盛**（用户 2026-09-25 口径：按当前《三国杀移动版》国战徐盛）。
 *
 * 口径要点（逐条对着写用例）：
 * - 吴、2 阴阳鱼（→ 4）、**珠联璧合丁奉**；当前国战技能**只有【疑城】**
 *   （⚠️【鸟翔】属于**蒋钦**——以前徐盛名下误挂了一份「与蒋钦同款」，本轮删掉）。
 * - 【疑城】：当一名与你势力相同的角色成为【杀】的目标后，**你可以**令该角色摸一张牌，
 *   然后**其**弃置一张牌。
 *   · **发动权在徐盛**（移动版现行文本；2019 典藏版是「成为目标的那个角色」决定——版本差异见 §5.230）；
 *   · 「与你势力相同」：**自己**这一侧用后台已知的势力（明置前只有自己知道自己的势力 ⇒
 *     预亮后暗置的徐盛也能被问「是否明置并发动」），**目标**那一侧用**公开**势力
 *     （暗将＝未确定 ⇒ 不触发；野心家各自一种势力 ⇒ 不与他人相同）——不许翻暗将底牌；
 *   · 时机＝**成为【杀】目标后、出【闪】之前**（摸到的【闪】可以立刻用来响应这张【杀】）；
 *   · 「其弃置**一张牌**」＝手牌**或装备区**、**由被保护的角色自己挑**（不随机、不含判定区）；
 *   · **没有每回合限一次**：每一次符合条件的「成为【杀】目标」都可以问一轮
 *     （一张【杀】指定两个同势力角色 ⇒ 两次机会）。
 * - 徐盛**自己**成为【杀】目标时也满足「与你势力相同的角色」（文本没有「其他」二字）。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, getHeroForMode, toSnapshot, type GameState } from '../src';
import type { Card, Faction } from '@sgs/protocol';

const A = 's0'; // 出杀的人
const B = 's1'; // 徐盛
const C = 's2'; // 被【杀】指定的目标
const D = 's3';

const ok = (r: { ok: boolean; error?: string }, tag = ''): void => {
  if (!r.ok) throw new Error(`${tag} 意图被拒：${r.error}`);
};
const act = (s: GameState, seat: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(s, seat, i);
const at = (s: GameState, seat: string) => s.players.find((p) => p.seatId === seat)!;
const mk = (id: string, type: Card['type'], suit: Card['suit'], rank = 1): Card => ({
  id,
  type,
  suit,
  rank,
});
const sha = (id: string) => mk(id, 'sha', 'spade', 7);
const shan = (id: string) => mk(id, 'shan', 'heart', 2);
const tao = (id: string) => mk(id, 'tao', 'heart', 3);
const armor = (id: string): Card => ({
  ...mk(id, 'armor', 'club', 2),
  equipName: 'bagua',
});

interface Seat {
  seatId: string;
  name: string;
  heroId: string;
  deputy?: string;
  faction?: Faction;
  hand?: Card[];
  equip?: Card[];
  reveal?: boolean;
}
function gz(seats: Seat[], turnSeat = A): GameState {
  const state = createGame(
    seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  for (const s of seats) {
    const p = at(state, s.seatId);
    p.heroId = s.heroId;
    p.deputyHeroId = s.deputy ?? null;
    p.faction = s.faction ?? getHeroForMode(s.heroId, 'guozhan')?.faction ?? 'qun';
    const shown = s.reveal !== false;
    p.heroRevealed = shown;
    p.deputyRevealed = shown;
    p.hand = (s.hand ?? []).slice();
    for (const c of s.equip ?? []) p.equipment[c.type === 'armor' ? 'armor' : 'weapon'] = c;
    p.flags = emptyFlags();
    const main = getHeroForMode(s.heroId, 'guozhan')!;
    const dep = p.deputyHeroId ? getHeroForMode(p.deputyHeroId, 'guozhan')! : undefined;
    if (dep) {
      const mainHp = main.maxHp - (main.mainSlotHalfYang ? 1 : 0);
      const depHp = dep.maxHp - (dep.deputySlotHalfYang ? 1 : 0);
      p.maxHp = Math.floor((mainHp + depHp) / 2);
    } else {
      p.maxHp = main.maxHp - (main.mainSlotHalfYang ? 1 : 0);
    }
    p.hp = p.maxHp;
  }
  const idx = state.seatOrder.indexOf(turnSeat);
  state.turn = { seatIndex: idx < 0 ? 0 : idx, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[state.turn.seatIndex]! };
  state.log = [];
  return state;
}

/** 甲（出杀者·蜀） + 乙（徐盛·吴） + 丙（目标·吴） 的三人现场 */
function field(opts: { targetFaction?: Faction; targetReveal?: boolean; hand?: Card[] } = {}): GameState {
  return gz([
    { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
    { seatId: B, name: '徐盛', heroId: 'xusheng', faction: 'wu', hand: [] },
    {
      seatId: C,
      name: '丙',
      heroId: 'lvmeng',
      faction: opts.targetFaction ?? 'wu',
      hand: opts.hand ?? [tao('c1'), tao('c2')],
      reveal: opts.targetReveal ?? true,
    },
  ]);
}

describe('【疑城】的目标条件（不偷看暗将底牌）', () => {
  it('同势力队友成为【杀】目标 ⇒ 问的是**徐盛**，不是目标', () => {
    const state = field();
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.seatId, '发动权在徐盛').toBe(B);
      expect(state.pending.title).toContain('疑城');
      expect(state.pending.title, '标题里点名被保护的人').toContain('丙');
    }
  });

  it('徐盛**自己**成为【杀】目标也可以发动（文本没有「其他」二字）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '徐盛', heroId: 'xusheng', faction: 'wu', hand: [tao('b1')] },
      { seatId: C, name: '丙', heroId: 'lvmeng', faction: 'wu', hand: [] },
    ]);
    state.deck = [mk('d0', 'shan', 'club', 2), mk('d1', 'shan', 'club', 3)];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(state.pending?.kind, '照样问徐盛').toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    expect(at(state, B).hand.map((c) => c.id).sort(), '自己摸 1').toEqual(['b1', 'd1']);
    ok(act(state, B, { type: 'chooseOption', optionId: 'card:b1' }), '自己挑一张弃');
    expect(at(state, B).hand.map((c) => c.id), '弃完只剩摸到的那张').toEqual(['d1']);
  });

  it('**不同势力**的角色成为目标 ⇒ 不触发', () => {
    const state = field({ targetFaction: 'shu' });
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    expect(state.pending?.kind, '直接进【闪】响应').toBe('respondSha');
    expect(state.log.some((e) => e.message.includes('疑城'))).toBe(false);
  });

  it('**未确定势力**的暗将成目标 ⇒ 不触发（不因底牌是吴就认队友）', () => {
    const state = field({ targetFaction: 'wu', targetReveal: false });
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    expect(state.pending?.kind).toBe('respondSha');
    expect(state.log.some((e) => e.message.includes('疑城'))).toBe(false);
  });

  it('只认**【杀】**：南蛮入侵 / 万箭齐发 / 决斗 都不触发', () => {
    // 疑城的时机是「成为【杀】的目标后」——伤害类**锦囊**不算（它们不是【杀】）
    for (const type of ['nanman', 'wanjian', 'juedou'] as const) {
      const state = gz([
        { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [mk('a1', type, 'spade', 7)] },
        { seatId: B, name: '徐盛', heroId: 'xusheng', faction: 'wu', hand: [] },
        { seatId: C, name: '丙', heroId: 'lvmeng', faction: 'wu', hand: [] },
      ]);
      state.deck = [mk('d0', 'sha', 'club', 9)];
      const r = act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] });
      // 南蛮/万箭是全体目标（不接受 targetIds），决斗要目标 —— 两条都给上
      if (!r.ok) ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }), `${type} 出牌`);
      expect(state.log.some((e) => e.message.includes('疑城')), `${type} 不该触发疑城`).toBe(false);
    }
  });

  it('**野心家**之间不算同势力（目标明置成野心家 ⇒ 不触发）', () => {
    const state = field();
    at(state, C).faction = 'ambitionist';
    at(state, C).determinedFaction = 'ambitionist';
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    expect(state.pending?.kind).toBe('respondSha');
    expect(state.log.some((e) => e.message.includes('疑城'))).toBe(false);
  });
});

describe('【疑城】的结算：摸 1 → 目标自己弃 1 → 回到【杀】', () => {
  /** 走到「徐盛已发动、等目标弃牌」这一步 */
  function afterYes(state: GameState) {
    if (state.pending?.kind === 'choice') ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
  }

  it('先摸 1（摸到的是牌堆顶）；再由**目标自己**弃 1（手牌给牌面、不是随机）', () => {
    const state = field();
    state.deck = [mk('d0', 'sha', 'club', 9), mk('d1', 'shan', 'heart', 4)];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    afterYes(state);
    expect(at(state, C).hand.map((c) => c.id).sort(), '先摸 1').toEqual(['c1', 'c2', 'd1']);
    // 弃哪张：**丙自己**挑（选项是他自己手牌的牌面）
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.seatId, '由被保护者自己挑').toBe(C);
      expect(state.pending.options.map((o) => o.id).sort()).toEqual([
        'card:c1',
        'card:c2',
        'card:d1',
      ]);
    }
    ok(act(state, C, { type: 'chooseOption', optionId: 'card:c2' }), '点第二张桃');
    expect(at(state, C).hand.map((c) => c.id).sort(), '点哪张就弃哪张').toEqual(['c1', 'd1']);
    expect(state.discard.some((c) => c.id === 'c2')).toBe(true);
    // 弃完之后**才**进【闪】响应
    expect(state.pending?.kind, '回到原来的【杀】结算').toBe('respondSha');
  });

  it('**装备牌**也可以弃（「其弃置一张牌」不是「手牌」），且走失去装备的钩子', () => {
    const state = field({ hand: [tao('c1')] });
    at(state, C).equipment.armor = armor('ar1');
    state.deck = [mk('d0', 'sha', 'club', 9)];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    afterYes(state);
    if (state.pending?.kind === 'choice') {
      expect(state.pending.options.map((o) => o.id).sort(), '手牌 + 装备都在候选里').toEqual([
        'card:ar1',
        'card:c1',
        'card:d0',
      ]);
    }
    ok(act(state, C, { type: 'chooseOption', optionId: 'card:ar1' }), '弃装备');
    expect(at(state, C).equipment.armor, '装备区空了').toBeFalsy();
    expect(state.discard.some((c) => c.id === 'ar1')).toBe(true);
  });

  it('**判定区**不在候选里（代价只认手牌 + 装备区）', () => {
    const state = field({ hand: [tao('c1')] });
    at(state, C).judgment = [mk('j1', 'lebu', 'spade', 6)];
    state.deck = [mk('d0', 'sha', 'club', 9)];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    afterYes(state);
    if (state.pending?.kind === 'choice') {
      expect(state.pending.options.some((o) => o.id === 'card:j1'), '判定区的牌不出现').toBe(false);
    }
  });

  it('**疑城摸到的【闪】可以立刻用来响应这张【杀】**（时机在出闪之前）', () => {
    const state = field({ hand: [tao('c1')] });
    state.deck = [mk('d0', 'sha', 'club', 9), mk('d1', 'shan', 'heart', 4)]; // 顶上是那张闪
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    afterYes(state);
    ok(act(state, C, { type: 'chooseOption', optionId: 'card:c1' }), '把桃弃掉');
    expect(at(state, C).hand.map((c) => c.id)).toEqual(['d1']);
    // 现在轮到他出闪：摸到的那张【闪】就在手里（这正是疑城的价值）
    expect(state.pending?.kind).toBe('respondSha');
    ok(act(state, C, { type: 'respondCard', cardId: 'd1' }), '用刚摸到的闪响应');
    expect(state.log.some((e) => e.message.includes('闪避') || e.message.includes('使用了【闪】'))).toBe(true);
  });

  it('问徐盛时把他**保护的那位**一起下发（界面轻微高亮）', () => {
    const state = field();
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    const snap = toSnapshot(state, B).prompt;
    expect(snap?.kind).toBe('choice');
    expect(snap?.relatedSeats, 'relatedSeats = 被保护的丙').toEqual([C]);
  });

  it('**别人看不到目标的手牌**：这条弃牌询问只发给目标自己', () => {
    // 用户 §十五：徐盛发动疑城**不会**因此看到队友的全部手牌；其他人更看不到。
    // 引擎侧靠「询问只发给当事人」保证：徐盛的快照里根本没有那条带牌名的 choice。
    const state = field();
    state.deck = [mk('d0', 'sha', 'club', 9), mk('d1', 'shan', 'heart', 4)];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    if (state.pending?.kind === 'choice') ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    // 此刻待答的是**丙**（选弃哪张）——
    const owner = toSnapshot(state, C).prompt;
    expect(owner?.kind, '当事人看得到').toBe('choice');
    expect(owner?.choiceOptions?.map((o) => o.id)).toContain('card:c1');
    // 徐盛与第三方：看不到那条询问，也看不到丙的手牌内容
    for (const viewer of [B, A]) {
      const pv = toSnapshot(state, viewer).prompt;
      expect(pv?.choiceOptions ?? [], `座位 ${viewer} 看不到丙的候选`).toEqual([]);
    }
    // 连带：徐盛看到的丙的手牌**只有张数**（没有任何牌面字段）
    const viewOfC = toSnapshot(state, B).players.find((p) => p.seatId === C)!;
    expect(JSON.stringify(viewOfC), '别人的手牌不出现在快照里').not.toContain('"c1"');
  });

  it('徐盛**不能替目标**挑牌（问的是目标本人；徐盛的候选里没有别人的手牌）', () => {
    const state = field();
    state.deck = [mk('d0', 'sha', 'club', 9)];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    afterYes(state);
    const p = state.pending;
    expect(p?.kind).toBe('choice');
    if (p?.kind === 'choice') expect(p.seatId).not.toBe(B);
    // 徐盛本人这时没有待答的询问（他那一问已经答过了）
    const snap = toSnapshot(state, B).prompt;
    expect(snap?.kind ?? null, '徐盛这边没有可答的东西').not.toBe('choice');
  });
});

describe('【疑城】的次数：每次「成为【杀】目标」都可以问一轮', () => {
  it('同一回合两张【杀】 ⇒ 两次机会（没有每回合限一次）', () => {
    // ⚠️ 4 人环形里与甲相邻的是 B 和 D（距离 1）——所以让两个**目标**坐 B/D，徐盛坐 C
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '丙', heroId: 'lvmeng', faction: 'wu', hand: [tao('c1'), tao('c2')] },
      { seatId: C, name: '徐盛', heroId: 'xusheng', faction: 'wu', hand: [] },
      { seatId: D, name: '丁', heroId: 'lvmeng', faction: 'wu', hand: [tao('d1'), tao('d2')] },
    ]);
    state.deck = [mk('k1', 'sha', 'club', 1), mk('k2', 'sha', 'club', 2)];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, C, { type: 'chooseOption', optionId: 'yes' }), '第 1 次发动');
    ok(act(state, B, { type: 'chooseOption', optionId: 'card:c1' }));
    if (state.pending?.kind === 'respondSha') ok(act(state, B, { type: 'pass' }), '丙不闪');
    // 第 2 张【杀】（此时 A 的手牌里还剩 a2）
    if (state.pending?.kind === 'play') {
      ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [D] }));
      expect(state.pending?.kind, '第二次照样问他').toBe('choice');
      if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(C);
    }
  });

  it('一张【杀】指定**两个**同势力目标 ⇒ 两个目标各产生一次机会', () => {
    // 甲＝丁奉（短兵：可以额外指定一名距离 1 的角色）
    const state = gz([
      { seatId: A, name: '甲', heroId: 'dingfeng', faction: 'wu', hand: [sha('a1')] },
      { seatId: B, name: '丙', heroId: 'lvmeng', faction: 'wu', hand: [tao('c1'), tao('c2')] },
      { seatId: C, name: '徐盛', heroId: 'xusheng', faction: 'wu', hand: [] },
      { seatId: D, name: '丁', heroId: 'lvmeng', faction: 'wu', hand: [tao('d1'), tao('d2')] },
    ]);
    state.deck = [mk('k1', 'sha', 'club', 1), mk('k2', 'sha', 'club', 2)];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, D] }), '短兵双目标');
    // 第一个目标（丙·B）
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, C, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'card:c1' }));
    if (state.pending?.kind === 'respondSha') ok(act(state, B, { type: 'pass' }));
    // 第二个目标（丁）——同一张【杀】的第二次机会
    expect(state.pending?.kind, '第二个目标也问').toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.title).toContain('丁');
  });
});

describe('暗置徐盛：预亮后在时机到来时「明置并发动」', () => {
  it('预亮之后：先问「是否明置【徐盛】并发动」，明置后照常摸一弃一', () => {
    // ⚠️ 4 人局：吴 只有「目标 + 徐盛」两人 ⇒ 明置时 2 > 4/2 不成立，**不会**被超编规则转成野心家
    //    （3 人局里两个吴就超半场了，徐盛一明置就变野心家 —— 那条另有专门用例）
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '丙', heroId: 'lvmeng', faction: 'wu', hand: [tao('c1'), tao('c2')] },
      { seatId: C, name: '徐盛', heroId: 'xusheng', faction: 'wu', hand: [] },
      { seatId: D, name: '丁', heroId: 'xuchu', faction: 'wei', hand: [] },
    ]);
    at(state, C).heroRevealed = false;
    at(state, C).deputyRevealed = false;
    at(state, C).prelitSkills = ['疑城'];
    state.deck = [mk('d0', 'sha', 'club', 9), mk('d1', 'shan', 'heart', 4)];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // 第一问：明置并发动
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.title, '预亮的那一问').toContain('明置');
      ok(act(state, C, { type: 'chooseOption', optionId: 'yes' }));
    }
    expect(at(state, C).heroRevealed, '发动时明置').toBe(true);
    // 第二问：疑城本体（问的还是徐盛）
    const p = state.pending;
    expect(p?.kind).toBe('choice');
    if (p?.kind === 'choice') {
      expect(p.seatId).toBe(C);
      ok(act(state, C, { type: 'chooseOption', optionId: 'yes' }));
    }
    expect(at(state, B).hand.map((c) => c.id).sort()).toContain('d1');
  });

  it('明置时因**超编**变成野心家 ⇒ 疑城不再触发（他不再与吴同势力）', () => {
    // 3 人局：吴 已有 1 人（目标），徐盛一明置就 2 > 3/2 ⇒ 转野心家。
    // 这时「与你势力相同」不成立（野心家各自一种势力、不与任何人相同）⇒ 摸一弃一**不执行**。
    const state = field();
    at(state, B).heroRevealed = false;
    at(state, B).deputyRevealed = false;
    at(state, B).prelitSkills = ['疑城'];
    state.deck = [mk('d0', 'sha', 'club', 9), mk('d1', 'shan', 'heart', 4)];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    if (state.pending?.kind === 'choice') ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    expect(at(state, B).heroRevealed).toBe(true);
    expect(at(state, B).faction, '超编 ⇒ 野心家').toBe('ambitionist');
    expect(state.log.some((e) => e.message.includes('发动【疑城】')), '没有摸一弃一').toBe(false);
    expect(at(state, C).hand.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
  });

  it('没有预亮 ⇒ 暗置的徐盛收不到这一问（国战：发动前要先声明）', () => {
    const state = field();
    at(state, B).heroRevealed = false;
    at(state, B).deputyRevealed = false;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    expect(state.pending?.kind, '直接进【闪】').toBe('respondSha');
    expect(state.log.some((e) => e.message.includes('疑城'))).toBe(false);
  });
});

describe('徐盛的数据口径（技能表 / 珠联璧合）', () => {
  it('国战徐盛**只有【疑城】**，没有【鸟翔】（鸟翔属于蒋钦）', () => {
    const x = getHeroForMode('xusheng', 'guozhan')!;
    expect(x.skills.map((s) => s.name)).toEqual(['疑城']);
    expect(x.formation, '阵法技字段也不该在徐盛身上').toBeUndefined();
    expect(x.hooks?.some((h) => h.skillId === '鸟翔') ?? false, '没有鸟翔钩子').toBe(false);
    // 蒋钦那边有（功能没丢）
    const j = getHeroForMode('jiangqin', 'guozhan')!;
    expect(j.skills.map((s) => s.name)).toContain('鸟翔');
    expect(j.hooks?.some((h) => h.skillId === '鸟翔') ?? false).toBe(true);
  });

  it('珠联璧合【丁奉】两侧都登记了', () => {
    expect(getHeroForMode('xusheng', 'guozhan')!.combos).toContain('dingfeng');
    expect(getHeroForMode('dingfeng', 'guozhan')!.combos).toContain('xusheng');
  });

  it('技能文本是移动版现行口径（「你可以令该角色…然后其弃置」）', () => {
    const desc = getHeroForMode('xusheng', 'guozhan')!.skills[0]!.desc ?? '';
    expect(desc).toContain('你可以令该角色摸一张牌，然后其弃置一张牌');
  });
});
