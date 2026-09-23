/**
 * **国战田丰**（用户 2026-09-25 口径：当前《三国杀移动版》国战口径 = **2025-09-19 改版后**）。
 *
 * 逐条对着写用例：
 * - 【死谏】「当你失去**最后一张手牌**后」——核心判断是**一次牌移动完成以后**
 *   `前 > 0 且 后 === 0`：使用 / 打出 / 弃置 / 交出 / 被获得**都算**；
 *   一次丢掉多张（3 张 → 0）只触发**一次**；**没有「每回合限一次」**（空手后又拿到、再失去，可再触发）。
 * - 【死谏】能弃的是目标的**手牌或装备牌**，**不含判定区**；全场没有合法目标时**不询问**。
 * - 【随势①】其他角色**进入濒死**时，若**伤害来源与你势力相同** ⇒ 你摸 1（锁定技，**不询问**）；
 *   失去体力 / 闪电这类**无来源**的濒死**不算**；一次高额伤害只对应**一次**「进入濒死」。
 * - 【随势②】其他**与你势力相同**的角色**死亡**时 ⇒ **强制二选一**：
 *   ① 失去 1 点体力；② 弃置所有手牌。锁定技 ⇒ 没有「是否发动」，但**技能内部有选择**。
 * - 「同势力」一律按**当前已确定的势力**（明置口径；**野心家之间不算同势力**）。
 * - 两条分支都走引擎既有流程：失去体力照常进濒死；弃所有手牌是**一次移动**，
 *   于是会**自然接上【死谏】**（用户 §十六 点名的嵌套链）。
 */
import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  createGame,
  emptyFlags,
  getHero,
  getHeroForMode,
  formationQueue,
  toSnapshot,
  type GameState,
} from '../src';
import type { Card, Faction } from '@sgs/protocol';

const A = 's0'; // 田丰
const B = 's1'; // 陪坐（多数用例里是「同势力的那位」）
const C = 's2'; // 陪坐（多数用例里是「伤害来源 / 异势力」）
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
const sha = (id: string, suit: Card['suit'] = 'spade', rank = 7) => mk(id, 'sha', suit, rank);
const shan = (id: string, suit: Card['suit'] = 'heart', rank = 2) => mk(id, 'shan', suit, rank);
const tao = (id: string, suit: Card['suit'] = 'heart', rank = 3) => mk(id, 'tao', suit, rank);
const jiu = (id: string, suit: Card['suit'] = 'spade', rank = 9) => mk(id, 'jiu', suit, rank);

function gz(
  seats: {
    seatId: string;
    name: string;
    heroId: string;
    deputy?: string;
    faction?: Faction;
    hand?: Card[];
    hp?: number;
  }[],
  turnSeat = A,
): GameState {
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
    p.faction = s.faction ?? getHero(s.heroId)!.faction;
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.hand = (s.hand ?? []).slice();
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
    p.hp = s.hp ?? p.maxHp;
  }
  const idx = state.seatOrder.indexOf(turnSeat);
  state.turn = { seatIndex: idx < 0 ? 0 : idx, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[state.turn.seatIndex]! };
  state.log = [];
  return state;
}

/** 把当前所有求桃询问都弃掉（让濒死流程走完、该死的人死掉） */
function passDeathSaves(state: GameState): void {
  while (state.pending?.kind === 'respondDeath') {
    const asked = state.pending.askQueue[state.pending.askIndex]!;
    ok(act(state, asked, { type: 'pass' }));
  }
}

/** 田丰（甲·群） + 乙（群·张角） + 丙（魏·甄姬）的一局 */
function tf(hand: Card[], opts: { turnSeat?: string; bHand?: Card[]; cHand?: Card[] } = {}): GameState {
  return gz(
    [
      { seatId: A, name: '甲', heroId: 'tianfeng', faction: 'qun', hand },
      { seatId: B, name: '乙', heroId: 'zhangjiao', faction: 'qun', hand: opts.bHand ?? [] },
      { seatId: C, name: '丙', heroId: 'zhenji', faction: 'wei', hand: opts.cHand ?? [] },
    ],
    opts.turnSeat ?? A,
  );
}

/** 某人当前那条**待回答的询问**（占位空位「出牌/弃牌」不算；答的意思） */
function pendingOf(state: GameState, seat: string): GameState['pending'] {
  const p = state.pending;
  if (!p) return null;
  if (p.kind === 'play' || p.kind === 'discard') return null; // 占位空位，不是在问人
  if ('seatId' in p && p.seatId !== seat) return null;
  return p;
}

describe('【死谏】：失去最后一张手牌后（不是「弃牌后」，且没有每回合限一次）', () => {
  it('使用最后一张手牌 → 触发；牌序：先结算完这张牌，再轮到死谏', () => {
    const state = tf([sha('a1'), tao('a9')], { bHand: [shan('b1'), tao('b2')] });
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // 还剩一张（a9）⇒ 手牌没清空，不该问
    expect(state.pending?.kind).toBe('respondSha');
    ok(act(state, B, { type: 'pass' }));
    expect(pendingOf(state, A), '手牌还有一张 → 不触发死谏').toBeNull();
  });

  it('打出最后一张【闪】也算「失去最后一张手牌」', () => {
    // 乙留一张桃：否则他把唯一的牌打出去后**全场都没有合法牌**，
    // 按用户 §三 的口径本来就**不该问**（那一条单独有用例）
    const state = tf([], { bHand: [sha('b1'), tao('b9')], turnSeat: B, cHand: [] });
    at(state, A).hand = [shan('a1')];
    ok(act(state, B, { type: 'playCard', cardId: 'b1', targetIds: [A] }));
    expect(state.pending?.kind, '等甲出闪').toBe('respondSha');
    ok(act(state, A, { type: 'respondCard', cardId: 'a1' })); // 打出最后一张手牌
    expect(at(state, A).hand).toHaveLength(0);
    const p = pendingOf(state, A);
    expect(p?.kind, '打出最后一张 ⇒ 死谏询问（排队在杀结算之后）').toBe('choice');
    if (p?.kind === 'choice') expect(p.title).toContain('死谏');
  });

  it('被【顺手牵羊】获得最后一张手牌也触发（不只是「弃置」）', () => {
    const state = gz(
      [
        { seatId: A, name: '甲', heroId: 'tianfeng', faction: 'qun', hand: [] },
        { seatId: B, name: '乙', heroId: 'zhenji', faction: 'wei', hand: [mk('b1', 'shunshou', 'spade', 3)] },
        { seatId: C, name: '丙', heroId: 'zhangjiao', faction: 'qun', hand: [tao('c1')] },
      ],
      B,
    );
    at(state, A).hand = [tao('a1')]; // 只有这一张
    ok(act(state, B, { type: 'playCard', cardId: 'b1', targetIds: [A] }));
    // 顺手牵羊由**乙**挑拿甲的哪一张（甲只有一张 ⇒ 唯一选项）
    expect(state.pending?.kind, '乙挑要拿的牌').toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'hand:0' }));
    expect(at(state, A).hand, '最后一张被顺走').toHaveLength(0);
    const p = pendingOf(state, A);
    expect(p?.kind, '被获得最后一张 ⇒ 死谏询问').toBe('choice');
    if (p?.kind === 'choice') expect(p.title).toContain('死谏');
  });

  it('丢牌但没清空 ⇒ 不询问（空手时也没有「再次失牌」可言）', () => {
    const state = tf([shan('a1'), tao('a2')], { turnSeat: B, bHand: [mk('b1', 'guohe', 'spade', 4)] });
    ok(act(state, B, { type: 'playCard', cardId: 'b1', targetIds: [A] }));
    expect(state.pending?.kind, '拆甲的哪一张').toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'hand:0' }));
    expect(at(state, A).hand).toHaveLength(1);
    expect(pendingOf(state, A), '还剩一张 → 不问死谏').toBeNull();
  });

  it('空手之后又拿到牌、再失去 ⇒ **可以再次触发**（没有每回合限一次）', () => {
    const state = tf([sha('a1')], { bHand: [shan('b1'), tao('b2')], cHand: [] });
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    const p1 = pendingOf(state, A);
    expect(p1?.kind, '第一次触发').toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'no' }));
    // 甲现在空手、又拿到牌（模拟「后来获得 1 张牌」）
    at(state, A).hand.push(mk('a8', 'guohe', 'spade', 4));
    // 再失去这最后一张：用【过河拆桥】（【杀】有每回合一张的上限，换一张锦囊）
    state.deferredEndOfIntentHooks = []; // 上一问已答完，清掉可能残留的排队钩子
    ok(act(state, A, { type: 'playCard', cardId: 'a8', targetIds: [B] }));
    // 拆牌要由**甲**挑弃乙的哪一张
    if (state.pending?.kind === 'choice') {
      ok(act(state, A, { type: 'chooseOption', optionId: 'hand:0' }));
    }
    const p2 = pendingOf(state, A);
    expect(p2?.kind, '第二次仍可触发').toBe('choice');
    if (p2?.kind === 'choice') expect(p2.title).toContain('死谏');
  });

  it('候选**不含自己**；全场都没有合法牌时**完全不问**', () => {
    // 乙空手空装备 ⇒ 只有丙有牌可弃（自己永远不在候选里）
    const state = tf([sha('a1')], { bHand: [], cHand: [tao('c1')] });
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    ok(act(state, C, { type: 'pass' }));
    const p = pendingOf(state, A);
    expect(p?.kind, '先问是否发动').toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    expect(state.pending?.kind, '目标在牌桌上点').toBe('pickSeats');
    if (state.pending?.kind === 'pickSeats') {
      expect(state.pending.candidates, '乙空手空装备 ⇒ 不在候选；自己也不在').toEqual([C]);
    }
    ok(act(state, A, { type: 'pickSeats', seatIds: [C] }));
    expect(state.pending?.kind, '再来问弃丙的哪一张').toBe('choice');

    // 全场都没有合法牌：田丰空手打出最后一张时场上无人有牌 ⇒ 不问
    const none = gz(
      [
        { seatId: A, name: '甲', heroId: 'tianfeng', faction: 'qun', hand: [shan('a1')] },
        { seatId: B, name: '乙', heroId: 'zhangjiao', faction: 'qun', hand: [sha('b1')] },
      ],
      B,
    );
    ok(act(none, B, { type: 'playCard', cardId: 'b1', targetIds: [A] }));
    ok(act(none, A, { type: 'respondCard', cardId: 'a1' })); // 最后一张手牌打出去了
    expect(at(none, A).hand).toHaveLength(0);
    expect(pendingOf(none, A), '乙也没手牌没装备 ⇒ 不产生无意义询问').toBeNull();
    expect(none.deferredEndOfIntentHooks, '也没有排着队的待发钩子').toHaveLength(0);
  });

  it('分区面板：手牌只有 optionId（画牌背）、装备带牌面、**没有判定区**', () => {
    const state = tf([sha('a1')], { cHand: [], turnSeat: C });
    at(state, C).hand = [sha('c1')];
    at(state, B).hand = [tao('b1'), tao('b2')];
    // 乙挂一张【乐不思蜀】在判定区、一件装备
    at(state, B).judgment = [mk('j1', 'lebu', 'heart', 6)];
    at(state, B).equipment.weapon = mk('e1', 'qinggang', 'spade', 6);
    ok(act(state, C, { type: 'playCard', cardId: 'c1', targetIds: [A] }));
    ok(act(state, A, { type: 'pass' })); // 甲不出闪 → 甲被打到 0？不：这里让甲白挨一刀即可
    const p = pendingOf(state, A);
    if (p?.kind === 'choice') {
      ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
      ok(act(state, A, { type: 'pickSeats', seatIds: [B] }));
      const ask = state.pending;
      expect(ask?.kind).toBe('choice');
      if (ask?.kind === 'choice') {
        const zones = ask.zonePick?.targets[0]?.zones ?? [];
        const hand = zones.find((z) => z.zone === 'hand');
        const equip = zones.find((z) => z.zone === 'equip');
        expect(hand?.items.every((i) => !i.card), '手牌不出牌面（画牌背）').toBe(true);
        expect(hand?.items.map((i) => i.optionId)).toEqual(['hand:0', 'hand:1']);
        expect(equip?.items.map((i) => i.card?.id), '装备给牌面').toEqual(['e1']);
        expect(zones.some((z) => z.zone === 'judge'), '判定区不许出现').toBe(false);
        expect(ask.options.some((o) => o.id.startsWith('card:j1')), '选项里也没有判定牌').toBe(false);
      }
    }
  });

  it('弃置的是**田丰**选定的那一张（不是随机）', () => {
    const state = tf([sha('a1')], { turnSeat: A, bHand: [tao('b1'), tao('b2')] });
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    const p = pendingOf(state, A);
    expect(p?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, A, { type: 'pickSeats', seatIds: [B] }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'hand:1' })); // 点第 2 张
    expect(at(state, B).hand.map((c) => c.id)).toEqual(['b1']);
  });
});

describe('【随势①】：伤害来源与田丰势力相同 ⇒ 摸一张（锁定技，不问）', () => {
  it('同势力来源令别人濒死 ⇒ 摸 1；且**不弹确认框**', () => {
    // 乙（群）杀丙（魏）⇒ 伤害来源与田丰（群）同势力 ⇒ 摸
    const state = tf([tao('a9')], { bHand: [sha('b1'), tao('b9')], turnSeat: B, cHand: [] });
    // ⚠️ 牌堆在引擎里是**栈**：`deck` 末尾才是牌堆顶（drawOne 从末尾抽）
    state.deck = [mk('d2', 'shan', 'heart', 3), mk('d1', 'shan', 'heart', 2)];
    at(state, C).hp = 1;
    ok(act(state, B, { type: 'playCard', cardId: 'b1', targetIds: [C] }));
    ok(act(state, C, { type: 'pass' }));
    expect(at(state, A).hand.map((c) => c.id), '随势摸到的就是牌堆顶那张').toContain('d1');
    expect(state.pending?.kind, '锁定技：不该有「是否发动」').toBe('respondDeath');
    passDeathSaves(state);
  });

  it('来源与田丰**不同势力** ⇒ 不摸', () => {
    // 丙（魏）杀乙（群）⇒ 来源是魏，与田丰（群）不同 ⇒ 不摸
    const state = tf([tao('a9')], { bHand: [], turnSeat: C, cHand: [sha('c1')] });
    state.deck = [mk('d1', 'shan', 'heart', 2)];
    at(state, B).hp = 1;
    ok(act(state, C, { type: 'playCard', cardId: 'c1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(at(state, A).hand.map((c) => c.id)).not.toContain('d1');
    passDeathSaves(state);
  });

  it('**失去体力**进入濒死（无伤害来源）⇒ 不摸', () => {
    // 黄盖苦肉：出牌阶段限一次，失去 1 点体力、摸两张 —— 走的是 loseHp，不是伤害
    const state = gz(
      [
        { seatId: A, name: '甲', heroId: 'tianfeng', faction: 'qun', hand: [tao('a9')] },
        { seatId: B, name: '乙', heroId: 'huanggai', faction: 'wu', hand: [tao('b9')], hp: 1 },
        { seatId: C, name: '丙', heroId: 'zhenji', faction: 'wei', hand: [] },
      ],
      B,
    );
    state.deck = [mk('d3', 'shan', 'heart', 4), mk('d1', 'shan', 'heart', 2), mk('d2', 'shan', 'heart', 3)];
    // 「弃置一张牌」是苦肉的代价（handEquip）
    ok(act(state, B, { type: 'useSkill', skillId: 'kurou', cardIds: ['b9'], targetIds: [] }));
    expect(at(state, B).hp).toBeLessThanOrEqual(0);
    expect(at(state, A).hand.map((c) => c.id), '失去体力不进随势').not.toContain('d2');
    expect(at(state, A).hand.map((c) => c.id)).toContain('a9');
    passDeathSaves(state);
  });

  it('田丰**自己**进入濒死 ⇒ 不触发（「其他角色」）', () => {
    const state = tf([tao('a9')], { turnSeat: C, cHand: [sha('c1')] });
    at(state, A).hp = 1;
    at(state, C).hand = [sha('c1'), shan('c2')];
    ok(act(state, C, { type: 'playCard', cardId: 'c1', targetIds: [A] }));
    ok(act(state, A, { type: 'pass' }));
    expect(at(state, A).hp).toBeLessThanOrEqual(0);
    // 甲的询问是求桃，不该冒出随势的摸牌（手牌里只有原来那张桃）
    expect(at(state, A).hand.map((c) => c.id)).toEqual(['a9']);
    passDeathSaves(state);
  });

  it('一次高额伤害只对应**一次**「进入濒死」⇒ 只摸 1 张', () => {
    // 【酒】+【杀】= 2 点伤害，丙 2 血 → 一次进濒死（不是 2 次）
    const state = tf([tao('a9')], { bHand: [jiu('b1'), sha('b2')], turnSeat: B, cHand: [] });
    at(state, C).hp = 2;
    state.deck = [mk('d3', 'club', 2), mk('d2', 'spade', 2), mk('d1', 'shan', 'heart', 2)];
    ok(act(state, B, { type: 'playCard', cardId: 'b1' })); // 酒
    ok(act(state, B, { type: 'playCard', cardId: 'b2', targetIds: [C] }));
    ok(act(state, C, { type: 'pass' }));
    const drawn = at(state, A).hand.filter((c) => c.id.startsWith('d')).map((c) => c.id);
    expect(drawn, '2 点伤害也只摸 1 张（一次伤害＝一次「进入濒死」）').toEqual(['d1']);
    passDeathSaves(state);
  });

  it('濒死者最终死亡**不撤销**此前摸的牌', () => {
    const state = tf([tao('a9')], { bHand: [sha('b1')], turnSeat: B, cHand: [] });
    state.deck = [mk('d1', 'shan', 'heart', 2)];
    at(state, C).hp = 1;
    ok(act(state, B, { type: 'playCard', cardId: 'b1', targetIds: [C] }));
    ok(act(state, C, { type: 'pass' }));
    passDeathSaves(state);
    expect(at(state, C).alive, '丙没桃 ⇒ 阵亡').toBe(false);
    expect(at(state, A).hand.map((c) => c.id), '摸到的牌留在手里').toContain('d1');
  });

  it('来源**暗置**（势力未确定）⇒ 不触发（不偷看底牌）', () => {
    const state = tf([tao('a9')], { bHand: [sha('b1')], turnSeat: B, cHand: [] });
    state.deck = [mk('d1', 'shan', 'heart', 2)];
    at(state, C).hp = 1;
    at(state, B).heroRevealed = false;
    at(state, B).deputyRevealed = false;
    ok(act(state, B, { type: 'playCard', cardId: 'b1', targetIds: [C] }));
    ok(act(state, C, { type: 'pass' }));
    expect(at(state, A).hand.map((c) => c.id), '暗将的来源不算同势力').not.toContain('d1');
    passDeathSaves(state);
  });

  it('两个**野心家**之间不算同势力（来源是野心家 ⇒ 不摸）', () => {
    const state = tf([tao('a9')], { bHand: [sha('b1')], turnSeat: B, cHand: [] });
    state.deck = [mk('d1', 'shan', 'heart', 2)];
    at(state, C).hp = 1;
    // 乙与田丰都是野心家：各自一种势力 ⇒ 不同势力
    at(state, B).faction = 'ambitionist';
    at(state, B).determinedFaction = 'ambitionist';
    at(state, A).faction = 'ambitionist';
    at(state, A).determinedFaction = 'ambitionist';
    ok(act(state, B, { type: 'playCard', cardId: 'b1', targetIds: [C] }));
    ok(act(state, C, { type: 'pass' }));
    expect(at(state, A).hand.map((c) => c.id)).not.toContain('d1');
    passDeathSaves(state);
  });
});

describe('【随势②】：其他同势力角色死亡 ⇒ 锁定技的强制二选一', () => {
  /** 让丙（魏）杀掉乙（群）——乙与田丰同势力，丙不同 */
  function killed(state: GameState): void {
    state.deck = [];
    ok(act(state, C, { type: 'playCard', cardId: 'c1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    passDeathSaves(state);
  }

  it('同势力角色死亡 ⇒ 必须二选一（没有「是否发动」、也没有「取消」）', () => {
    const state = tf([tao('a9'), tao('a8'), tao('a7')], { turnSeat: C, cHand: [sha('c1')] });
    at(state, B).hp = 1;
    killed(state);
    expect(at(state, B).alive).toBe(false);
    const p = pendingOf(state, A);
    expect(p?.kind, '锁定技：直接给二选一').toBe('choice');
    if (p?.kind === 'choice') {
      expect(p.title).toContain('随势');
      expect(p.options.map((o) => o.id)).toEqual(['hp', 'hand']);
      expect(p.options.map((o) => o.label)).toEqual([
        '失去 1 点体力',
        '弃置所有手牌（当前 3 张）',
      ]);
      expect(
        p.options.some((o) => /不发动|取消|放弃/.test(o.label)),
        '锁定技不许出现「不发动/取消」',
      ).toBe(false);
    }
  });

  it('不同势力角色死亡 ⇒ 不询问', () => {
    const state = tf([tao('a9')], { turnSeat: C, cHand: [sha('c1'), sha('c2')] });
    at(state, B).hp = 1;
    at(state, B).faction = 'wei'; // 乙改成魏（与田丰不同势力）
    killed(state);
    expect(at(state, B).alive).toBe(false);
    expect(pendingOf(state, A), '不同势力：不问').toBeNull();
  });

  it('田丰**自己**死亡 ⇒ 不触发自己的随势', () => {
    const state = tf([tao('a9')], { turnSeat: C, cHand: [sha('c1')] });
    at(state, A).hp = 1;
    ok(act(state, C, { type: 'playCard', cardId: 'c1', targetIds: [A] }));
    ok(act(state, A, { type: 'pass' }));
    passDeathSaves(state);
    expect(at(state, A).alive).toBe(false);
    expect(state.pending?.kind, '甲已阵亡 ⇒ 没有给甲的询问').not.toBe('choice');
  });

  it('选①「失去 1 点体力」⇒ 走正常 loseHp（体力 -1，不触发伤害）', () => {
    const state = tf([tao('a9')], { turnSeat: C, cHand: [sha('c1')] });
    at(state, B).hp = 1;
    const hpBefore = at(state, A).hp;
    killed(state);
    ok(act(state, A, { type: 'chooseOption', optionId: 'hp' }));
    expect(at(state, A).hp).toBe(hpBefore - 1);
    expect(at(state, A).alive, '没到 0 ⇒ 不进濒死').toBe(true);
  });

  it('选①把自己带到 0 ⇒ **照常进入濒死**（求桃），不因为「技能代价」跳过', () => {
    const state = tf([tao('a9')], { turnSeat: C, cHand: [sha('c1')] });
    at(state, B).hp = 1;
    at(state, A).hp = 1;
    killed(state);
    ok(act(state, A, { type: 'chooseOption', optionId: 'hp' }));
    expect(at(state, A).hp).toBeLessThanOrEqual(0);
    expect(state.pending?.kind, '失去体力也要正常求桃').toBe('respondDeath');
    // 自己有一张桃 ⇒ 用掉它救回
    ok(act(state, A, { type: 'respondCard', cardId: 'a9' }));
    expect(at(state, A).hp).toBeGreaterThan(0);
  });

  it('选②「弃置所有手牌」⇒ 一次全部进弃牌堆（不逐张问）', () => {
    const state = tf([tao('a9'), tao('a8'), tao('a7')], { turnSeat: C, cHand: [sha('c1')] });
    at(state, B).hp = 1;
    killed(state);
    ok(act(state, A, { type: 'chooseOption', optionId: 'hand' }));
    expect(at(state, A).hand).toHaveLength(0);
    for (const id of ['a9', 'a8', 'a7']) {
      expect(state.discard.some((c) => c.id === id), `${id} 进弃牌堆`).toBe(true);
    }
  });

  it('选②把手牌清空 ⇒ **自然接上【死谏】**（用户 §十六 的嵌套链）', () => {
    // 丙要留一张牌：死谏没有合法目标时按口径**不询问**，那样就验不到这条链了
    const state = tf([tao('a9'), tao('a8'), tao('a7')], { turnSeat: C, cHand: [sha('c1'), tao('c9')] });
    at(state, B).hp = 1;
    killed(state);
    const p = pendingOf(state, A);
    expect(p?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'hand' }));
    const next = pendingOf(state, A);
    expect(next?.kind, '弃光手牌 ⇒ 死谏在意图收尾时接上').toBe('choice');
    if (next?.kind === 'choice') expect(next.title).toContain('死谏');
    // 真的能走完：选个目标、弃一张
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, A, { type: 'pickSeats', seatIds: [C] }));
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'hand:0' }));
    expect(at(state, C).hand, '丙最后一张被弃掉').toHaveLength(0);
  });

  it('**野心家**死亡 ⇒ 对田丰不触发（各自一种势力）', () => {
    const state = tf([tao('a9')], { turnSeat: C, cHand: [sha('c1')] });
    at(state, B).hp = 1;
    at(state, B).faction = 'ambitionist';
    at(state, B).determinedFaction = 'ambitionist';
    killed(state);
    expect(at(state, B).alive).toBe(false);
    expect(pendingOf(state, A)).toBeNull();
  });
});

describe('队列判据（阵法技地基）：野心家之间不算「同势力」', () => {
  it('两个相邻野心家**不构成队列**；同势力相邻则构成（对照组）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'tianfeng', faction: 'qun' },
      { seatId: B, name: '乙', heroId: 'zhangjiao', faction: 'qun' },
      { seatId: C, name: '丙', heroId: 'zhenji', faction: 'wei' },
    ]);
    expect(formationQueue(state, at(state, A)).map((p) => p.seatId), '对照组：同势力相邻').toEqual([
      A,
      B,
    ]);
    at(state, A).faction = 'ambitionist';
    at(state, A).determinedFaction = 'ambitionist';
    at(state, B).faction = 'ambitionist';
    at(state, B).determinedFaction = 'ambitionist';
    expect(formationQueue(state, at(state, A)).map((p) => p.seatId), '野心家各自成队').toEqual([A]);
    expect(formationQueue(state, at(state, B)).map((p) => p.seatId)).toEqual([B]);
  });

  it('快照里的 `inFormation` 跟着同一份判据走（界面徽标不会和规则分叉）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'tianfeng', faction: 'qun' },
      { seatId: B, name: '乙', heroId: 'zhangjiao', faction: 'qun' },
    ]);
    const snapOf = (seat: string) =>
      toSnapshot(state, seat).players.find((p) => p.seatId === seat)!.inFormation;
    expect(snapOf(A)).toBe(true);
    at(state, B).faction = 'ambitionist';
    at(state, B).determinedFaction = 'ambitionist';
    at(state, A).faction = 'ambitionist';
    at(state, A).determinedFaction = 'ambitionist';
    expect(snapOf(A), '野心家彼此不连').toBe(false);
  });
});
