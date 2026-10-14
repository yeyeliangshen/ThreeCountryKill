/**
 * **用户 2026-09-26 的 16 项规则裁定**（§5.247）里「立即修改或补测」的六项 + 两项顺带。
 *
 * 05 淑慎①：两个分支的摸牌目标都限「与你势力相同的**其他**角色」。
 * 07 天义：拼点**没赢（含平局）**⇒ 本回合**不能使用【杀】**（硬禁，加次数的技能抵消不了；
 *          只限「使用」，响应**打出**不受影响；OL 文本＝本回合）。
 * 12 看破：转化判据＝**黑色 + 手牌区**（有效颜色，装备区/「田」不可转）。
 * 14 孟达·量反 / 士燮·礼下：那两处「失去 1 点体力」走的是 **loseHp 流程**（无伤害来源、
 *    不触发卖血技、扣到 0 照常进濒死）——回归断言钉住，防止将来被当成 damage 的简写。
 * 03 烈弓：【乘势】只在国战版（身份版撤下，版本待源）。
 * 08 借刀杀人：文案补「其他」⇒ 武器持有者不能是自己（出杀目标仍可以是使用者）。
 * 11 反间（国战）：装备区计入同花色弃置、**判定区不计入**（判定区待官方判例）。
 */
import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  canUseAsCard,
  createGame,
  emptyFlags,
  getHeroForMode,
  type GameState,
} from '../src';
import {
  CARD_TARGET_EXCLUDES_SELF,
  CARD_DESC,
  type Card,
  type Faction,
} from '@sgs/protocol';

const ok = (r: { ok: boolean; error?: string }, tag = ''): void => {
  if (!r.ok) throw new Error(`${tag} 意图被拒：${r.error}`);
};
const bad = (r: { ok: boolean; error?: string }, tag = ''): void => {
  if (r.ok) throw new Error(`${tag} 本应被拒但成功了`);
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
const sha = (id: string, rank = 1) => mk(id, 'sha', 'spade', rank);
const tao = (id: string) => mk(id, 'tao', 'heart', 3);

interface Seat {
  seatId: string;
  name: string;
  heroId: string;
  faction?: Faction;
  hand?: Card[];
  hp?: number;
}
function gz(seats: Seat[], turnSeat = 's0'): GameState {
  const state = createGame(
    seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  for (const s of seats) {
    const p = at(state, s.seatId);
    p.heroId = s.heroId;
    p.deputyHeroId = null;
    p.faction = s.faction ?? getHeroForMode(s.heroId, 'guozhan')?.faction ?? 'qun';
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.hand = (s.hand ?? []).slice();
    p.flags = emptyFlags();
    p.maxHp = 4;
    p.hp = s.hp ?? 4;
  }
  const idx = state.seatOrder.indexOf(turnSeat);
  state.turn = { seatIndex: idx < 0 ? 0 : idx, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[state.turn.seatIndex]! };
  state.log = [];
  return state;
}
/** 跳过准备阶段那张「是否明置」占位询问（把回合摆到某人的准备阶段后用） */
function skipRevealAsk(state: GameState, seat: string): void {
  state.pending = {
    kind: 'choice',
    seatId: seat,
    title: '准备阶段：是否明置武将牌？',
    options: [{ id: 'none', label: '暂不明置' }],
    resolve: () => {},
  };
  ok(act(state, seat, { type: 'chooseOption', optionId: 'none' }), '跳过明置询问');
}

// ── 05 淑慎① ────────────────────────────────────────────────────────────
describe('05 淑慎①：回复体力后的摸牌目标也限「同势力其他角色」', () => {
  it('同势力在候选、异势力不在；没有同势力就不问', () => {
    const state = gz([
      { seatId: 's0', name: '甘夫人', heroId: 'ganfuren', faction: 'shu', hand: [tao('t1')], hp: 2 },
      { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: 's2', name: '丙', heroId: 'xuchu', faction: 'wei', hand: [] },
      { seatId: 's3', name: '丁', heroId: 'lvbu', faction: 'qun' },
    ]);
    ok(act(state, 's0', { type: 'playCard', cardId: 't1', targetIds: [] }), '吃桃');
    const p = state.pending;
    expect(p?.kind).toBe('choice');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }), '发动');
    expect(state.pending?.kind, '在牌桌上点').toBe('pickSeats');
    if (state.pending?.kind === 'pickSeats') {
      expect(state.pending.candidates, '只有同势力的乙').toEqual(['s1']);
    }
    ok(act(state, 's0', { type: 'pickSeats', seatIds: ['s1'] }));
    expect(at(state, 's1').hand).toHaveLength(1);

    // 没有同势力其他角色 ⇒ 不问（对照）
    const none = gz([
      { seatId: 's0', name: '甘夫人', heroId: 'ganfuren', faction: 'shu', hand: [tao('t1')], hp: 2 },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
    ]);
    ok(act(none, 's0', { type: 'playCard', cardId: 't1', targetIds: [] }));
    expect(none.log.some((e) => e.message.includes('淑慎')), '没有合法对象 ⇒ 不问').toBe(false);
  });
});

// ── 07 天义 ─────────────────────────────────────────────────────────────
describe('07 天义：拼点没赢（含平局）⇒ 本回合不能使用【杀】', () => {
  function pindian(state: GameState, myId: string, hisId: string): void {
    ok(act(state, 's0', { type: 'useSkill', skillId: 'tianyi', targetIds: ['s1'] }), '发动天义');
    ok(act(state, 's0', { type: 'pickCards', cardIds: [myId] }), '甲扣牌');
    ok(act(state, 's1', { type: 'pickCards', cardIds: [hisId] }), '乙扣牌');
  }
  function field(): GameState {
    return gz([
      {
        seatId: 's0',
        name: '太史慈',
        heroId: 'taishici',
        faction: 'wu',
        hand: [mk('a1', 'jiu', 'spade', 1), mk('a13', 'jiu', 'spade', 13), sha('a9', 7)],
      },
      {
        seatId: 's1',
        name: '乙',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [mk('b3', 'shan', 'club', 3), mk('b13', 'shan', 'club', 13)],
      },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
    ]);
  }

  it('拼点**输了** ⇒ 本回合【杀】被硬拒', () => {
    const state = field();
    pindian(state, 'a1', 'b13'); // 1 < 13
    expect(at(state, 's0').flags.cannotUseShaThisTurn).toBe(true);
    bad(act(state, 's0', { type: 'playCard', cardId: 'a9', targetIds: ['s1'] }), '杀被禁');
    expect(state.log.some((e) => e.message.includes('本回合不能使用【杀】'))).toBe(true);
  });

  it('拼点**平局**同样算没赢 ⇒ 一样禁', () => {
    const state = field();
    pindian(state, 'a13', 'b13'); // 平
    expect(at(state, 's0').flags.cannotUseShaThisTurn, '平局＝没赢').toBe(true);
    bad(act(state, 's0', { type: 'playCard', cardId: 'a9', targetIds: ['s1'] }), '平局也禁');
  });

  it('拼点**赢了** ⇒ 不禁（对照组）', () => {
    const state = field();
    pindian(state, 'a13', 'b3');
    expect(at(state, 's0').flags.cannotUseShaThisTurn).toBeFalsy();
    ok(act(state, 's0', { type: 'playCard', cardId: 'a9', targetIds: ['s1'] }), '赢了照常出杀');
  });

  it('硬禁优先于次数上限（直塞 flag：张飞·咆哮＝无限杀也被拒）', () => {
    const state = gz([
      { seatId: 's0', name: '张飞', heroId: 'zhangfei', faction: 'shu', hand: [sha('a9', 7)] },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
    ]);
    at(state, 's0').flags.cannotUseShaThisTurn = true;
    bad(act(state, 's0', { type: 'playCard', cardId: 'a9', targetIds: ['s1'] }), '咆哮绕不过硬禁');
  });

  it('只限「**使用**」：被【决斗】逼着**打出**【杀】不受影响', () => {
    const state = field();
    pindian(state, 'a1', 'b13');
    expect(at(state, 's0').flags.cannotUseShaThisTurn).toBe(true);
    at(state, 's1').hand.push(mk('b9', 'juedou', 'spade', 9));
    state.turn = { seatIndex: 1, phase: 'play' };
    state.pending = { kind: 'play', seatId: 's1' };
    ok(act(state, 's1', { type: 'playCard', cardId: 'b9', targetIds: ['s0'] }), '乙决斗甲');
    while (state.pending?.kind === 'wuxieQueue') {
      const p = state.pending;
      ok(act(state, p.askQueue[p.askIndex]!, { type: 'pass' }), '无懈过');
    }
    expect(state.pending?.kind, '轮到甲响应（打出杀）').toBe('respondTrick');
    ok(act(state, 's0', { type: 'respondCard', cardId: 'a9' }), '打出杀不受禁令影响');
  });
});

// ── 12 看破 ─────────────────────────────────────────────────────────────
describe('12 看破：黑色 + 手牌区（有效颜色；装备区与「田」不可转）', () => {
  it('黑色手牌可当【无懈】、红色不行', () => {
    const state = gz([
      { seatId: 's0', name: '卧龙', heroId: 'wolong', faction: 'shu', hand: [] },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
    ]);
    const me = at(state, 's0');
    me.hand.push(mk('h1', 'sha', 'spade', 7), mk('h2', 'tao', 'heart', 3));
    expect(canUseAsCard(state, me, me.hand[0]!, 'wuxie'), '♠ 可').toBe(true);
    expect(canUseAsCard(state, me, me.hand[1]!, 'wuxie'), '♥ 不可').toBe(false);
  });

  it('装备区里的黑牌**不能**当【无懈】', () => {
    const state = gz([
      { seatId: 's0', name: '卧龙', heroId: 'wolong', faction: 'shu', hand: [] },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
    ]);
    const blackEquip = { ...mk('e1', 'armor', 'spade', 6), equipName: 'renwang' } as Card;
    at(state, 's0').equipment.armor = blackEquip;
    expect(canUseAsCard(state, at(state, 's0'), blackEquip, 'wuxie'), '装备区不可转').toBe(false);
  });

  it('「田」里的黑牌**不能**当【无懈】（田不是手牌；只有急袭那条路）', () => {
    const state = gz([
      { seatId: 's0', name: '卧龙', heroId: 'wolong', faction: 'shu', hand: [] },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
    ]);
    const tianCard = { ...mk('t1', 'sha', 'spade', 7), tian: true } as Card;
    at(state, 's0').tian.push(tianCard);
    expect(canUseAsCard(state, at(state, 's0'), tianCard, 'wuxie'), '田不可转无懈').toBe(false);
    expect(canUseAsCard(state, at(state, 's0'), tianCard, 'shunshou'), '卧龙没有急袭').toBe(false);
  });

  it('有效颜色：与小乔（红颜）同队时♠视为♥ ⇒ 不能再当【无懈】', () => {
    const state = gz([
      { seatId: 's0', name: '卧龙', heroId: 'wolong', faction: 'wu', hand: [] },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
    ]);
    at(state, 's0').deputyHeroId = 'xiaoqiao';
    at(state, 's0').deputyRevealed = true;
    const spade = mk('x1', 'sha', 'spade', 7);
    at(state, 's0').hand.push(spade);
    expect(canUseAsCard(state, at(state, 's0'), spade, 'wuxie'), '♠→♥ ⇒ 不是黑色').toBe(false);
  });
});

// ── 14 孟达 / 士燮：loseHp 回归断言 ─────────────────────────────────────
describe('14 「失去 1 点体力」走 loseHp 流程（无伤害来源/不触发卖血技/照常进濒死）', () => {
  it('士燮·礼下选「失去 1 点体力」：扣血、无来源、卖血技不触发', () => {
    const state = gz(
      [
        // 甲＝士燮+郭嘉：若走伤害流程，郭嘉【遗计】会触发——用他当探针
        { seatId: 's0', name: '士燮', heroId: 'shixie', faction: 'qun', hand: [] },
        { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'wei', hand: [], hp: 2 },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      ],
      's0', // 先手给士燮自己：她一结束就轮到乙（异势力）⇒ 乙的准备阶段自然派发礼下
    );
    at(state, 's0').deputyHeroId = 'guojia';
    at(state, 's0').deputyRevealed = true;
    at(state, 's0').equipment.armor = { ...mk('ar1', 'armor', 'club', 2), equipName: 'bagua' } as Card;
    state.deck = [mk('d1', 'sha', 'club', 5), mk('d2', 'sha', 'club', 6)];
    // 礼下挂在「**别人**的回合开始」——要**自然**推进（士燮自己结束回合 ⇒ 乙的回合开始），
    // 手工摆 turn 不会跑钩子；乙进准备阶段前可能先弹「是否明置」占位，跳掉它
    ok(act(state, 's0', { type: 'endPhase' }), '士燮结束');
    while (state.pending?.kind === 'discard') ok(act(state, 's0', { type: 'discard', cardIds: [] }));
    if ((state.pending as { kind?: string; seatId?: string })?.kind === 'choice' && (state.pending as { seatId?: string }).seatId === 's1' && /明置/.test((state.pending as { title?: string }).title ?? '')) {
      ok(act(state, 's1', { type: 'chooseOption', optionId: 'none' }), '跳过明置');
    }
    expect(state.pending?.kind, '礼下询问（问乙）').toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe('s1');
    ok(act(state, 's1', { type: 'chooseOption', optionId: 'yes' }), '发动礼下');
    ok(act(state, 's1', { type: 'pickCards', cardIds: ['ar1'] }), '弃士燮的装备');
    ok(act(state, 's1', { type: 'chooseOption', optionId: 'losehp' }), '选失去体力');
    expect(at(state, 's1').hp, '扣了 1 点').toBe(1);
    expect(state.lastDamageSourceId, '没有伤害来源').toBe('');
    expect(at(state, 's0').hand, '遗计没触发（不是伤害）').toHaveLength(0);
  });

  it('孟达·量反：获得「函」后失去 1 点体力——无来源、不触发卖血技；扣到 0 照常进濒死', () => {
    const state = gz(
      [
        { seatId: 's0', name: '孟达', heroId: 'mengda', faction: 'wei', hand: [], hp: 1 },
        { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [sha('b1', 7)] },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      ],
      's1',
    );
    at(state, 's0').deputyHeroId = 'guojia';
    at(state, 's0').deputyRevealed = true;
    state.deck = [mk('d1', 'sha', 'club', 5), mk('d2', 'sha', 'club', 6)];
    ok(act(state, 's1', { type: 'playCard', cardId: 'b1', targetIds: ['s0'] }), '乙杀孟达');
    ok(act(state, 's0', { type: 'pass' }), '甲不出闪 → 伤害落地时求安问');
    const p = state.pending;
    expect(p?.kind, '求安询问').toBe('choice');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }), '发动求安');
    expect(at(state, 's0').hp, '伤害被防止').toBe(1);
    // 量反挂在**回合开始**（turnStart）⇒ 自然推进。座次环 s0→s1→s2：乙（s1）之后是丙（s2）、
    // 再回到孟达（s0）——把中间丙的回合也收掉
    ok(act(state, 's1', { type: 'endPhase' }), '乙结束');
    while (state.pending?.kind === 'discard') ok(act(state, 's1', { type: 'discard', cardIds: [] }));
    if ((state.pending as { kind?: string })?.kind === 'play' && (state.pending as { seatId?: string }).seatId === 's2') {
      ok(act(state, 's2', { type: 'endPhase' }), '丙结束');
      while (state.pending?.kind === 'discard') ok(act(state, 's2', { type: 'discard', cardIds: [] }));
    }
    expect(at(state, 's0').hp, '量反：获得函 + 失去 1 点体力（1→0）').toBeLessThanOrEqual(0);
    expect(state.pending?.kind, '失去体力到 0 ⇒ 照常进濒死').toBe('respondDeath');
    while (state.pending?.kind === 'respondDeath') {
      const pd = state.pending;
      ok(act(state, pd.askQueue[pd.askIndex]!, { type: 'pass' }), '没人救');
    }
    expect(state.lastDamageSourceId, '全程没有伤害来源').toBe('');
    expect(at(state, 's0').hand.every((c) => c.id !== 'd2'), '遗计没发牌（不是伤害）').toBe(true);
  });
});

// ── 03 烈弓 / 08 借刀 / 11 反间 ─────────────────────────────────────────
describe('03 烈弓：【乘势】只在国战版（身份版撤下，版本待源）', () => {
  it('身份版：条件命中只是不可闪避（伤害 1，不 +1）', () => {
    const state = createGame(
      [
        { seatId: 's0', name: '黄忠', heroId: 'huangzhong' },
        { seatId: 's1', name: '乙', heroId: 'xuchu' },
        { seatId: 's2', name: '丙', heroId: 'lvbu' },
      ],
      'TEST',
      { mode: 'identity' },
    );
    state.draft = null;
    for (const pl of state.players) {
      pl.heroId = pl.seatId === 's0' ? 'huangzhong' : pl.seatId === 's1' ? 'xuchu' : 'lvbu';
      pl.heroRevealed = true;
      pl.deputyRevealed = true;
      pl.flags = emptyFlags();
      pl.maxHp = 4;
      pl.hp = 4;
    }
    at(state, 's0').hand = [mk('a1', 'sha', 'spade', 7)];
    at(state, 's1').hand = [mk('b1', 'shan', 'heart', 2), mk('b2', 'shan', 'heart', 3)];
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: 's0' };
    state.log = [];
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }));
    // 不可闪避 ⇒ 没有响应窗口，杀同步结算完
    expect(at(state, 's1').hp, '身份版不 +1（掉 1 点）').toBe(3);
  });

  it('国战版保留【乘势】（对照：伤害 2）', () => {
    const state = gz([
      { seatId: 's0', name: '黄忠', heroId: 'huangzhong', faction: 'shu', hand: [mk('a1', 'sha', 'spade', 7)] },
      {
        seatId: 's1',
        name: '乙',
        heroId: 'xuchu',
        faction: 'wei',
        hand: [mk('b1', 'shan', 'heart', 2), mk('b2', 'shan', 'heart', 3), mk('b3', 'shan', 'heart', 4), mk('b4', 'shan', 'heart', 5)],
      },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
    ]);
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }));
    expect(at(state, 's1').hp, '国战版掉 2 点').toBe(2);
  });
});

describe('08 借刀杀人：武器持有者不能是自己（与「其他」文案对齐）', () => {
  it('文案含「其他」、排除表包含 jiedao、指自己被拒', () => {
    expect(CARD_DESC.jiedao).toContain('其他角色');
    expect(CARD_TARGET_EXCLUDES_SELF.has('jiedao')).toBe(true);
    const state = gz([
      { seatId: 's0', name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [mk('j1', 'jiedao', 'club', 12)] },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei', hand: [sha('b1', 7)] },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
    ]);
    at(state, 's0').equipment.weapon = { ...mk('w1', 'weapon', 'spade', 6), equipName: 'qinggang', range: 2 } as Card;
    bad(act(state, 's0', { type: 'playCard', cardId: 'j1', targetIds: ['s0', 's1'] }), '持有者不能是自己');
    at(state, 's1').equipment.weapon = { ...mk('w2', 'weapon', 'spade', 6), equipName: 'qinggang', range: 2 } as Card;
    ok(act(state, 's0', { type: 'playCard', cardId: 'j1', targetIds: ['s1', 's2'] }), '正常路径');
  });
});

describe('11 反间（国战）：装备区计入同花色、判定区不计入', () => {
  it('装备区同花色被弃、判定区原样不动', () => {
    const state = gz([
      { seatId: 's0', name: '周瑜', heroId: 'zhouyu', faction: 'wu', hand: [mk('a1', 'sha', 'spade', 7)] },
      { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [mk('b1', 'tao', 'heart', 3)] },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
    ]);
    at(state, 's1').equipment.weapon = { ...mk('w1', 'weapon', 'spade', 6), equipName: 'qinggang', range: 2 } as Card;
    at(state, 's1').judgment = [mk('j1', 'lebu', 'spade', 6)];
    ok(act(state, 's0', { type: 'useSkill', skillId: 'fanjian', cardIds: ['a1'], targetIds: ['s1'] }));
    ok(act(state, 's1', { type: 'chooseOption', optionId: 'discard' }), '选弃同花色');
    expect(at(state, 's1').equipment.weapon, '♠ 武器被弃').toBeFalsy();
    expect(state.discard.some((c) => c.id === 'w1')).toBe(true);
    expect(at(state, 's1').judgment.map((c) => c.id), '判定区的♠乐不思蜀原样不动').toEqual(['j1']);
  });
});
