import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applyIntent,
  createGame,
  distance,
  emptyFlags,
  getHero,
  seededRng,
  type Card,
  type Faction,
  type GameState,
  type SeatSetup,
} from '../src';

/**
 * 随机源钉死（与 engine.test.ts 同一纪律）：createGame 会洗牌，不钉的话沾了具体牌面的断言
 * 会偶发红。
 */
beforeEach(() => {
  const rnd = seededRng(20260922);
  vi.spyOn(Math, 'random').mockImplementation(() => rnd());
});
afterEach(() => {
  vi.restoreAllMocks();
});

const A = 's0';
const B = 's1';
const C = 's2';
const D = 's3';

function mk(id: string, type: Card['type'], suit: Card['suit'] = 'spade', rank = 1): Card {
  return { id, type, suit, rank };
}
const sha = (id: string, suit: Card['suit'] = 'spade') => mk(id, 'sha', suit);
const tao = (id: string) => mk(id, 'tao', 'heart');
/** ＋1 马（防御马）：别人计算与他的距离 +1 */
const plusMount = (id: string): Card => ({ id, type: 'plusMount', suit: 'spade', rank: 5 });

const act = (state: GameState, seatId: string, intent: Parameters<typeof applyIntent>[2]) =>
  applyIntent(state, seatId, intent);
function ok(res: ReturnType<typeof applyIntent>, msg?: string) {
  if (!res.ok) throw new Error(`预期成功但失败：${res.error} ${msg ?? ''}`);
}
function passWuxie(state: GameState) {
  while (state.pending?.kind === 'wuxieQueue') {
    const asked = state.pending.askQueue[state.pending.askIndex]!;
    ok(act(state, asked, { type: 'pass' }));
  }
}

interface GzSeat {
  seatId: string;
  name: string;
  heroId: string;
  deputyHeroId?: string;
  faction: Faction;
  hand?: Card[];
  hp?: number;
}

/** 国战可控局面：双将默认已明置（锁定技只认已明置的武将牌） */
function gzGame(seats: GzSeat[]): GameState {
  const setup: SeatSetup[] = seats.map((s) => ({
    seatId: s.seatId,
    name: s.name,
    heroId: s.heroId,
  }));
  const state = createGame(setup, 'TEST', { mode: 'guozhan' });
  state.draft = null;
  for (const s of seats) {
    const p = state.players.find((pl) => pl.seatId === s.seatId)!;
    const hero = getHero(s.heroId)!;
    const deputyId = s.deputyHeroId ?? 'guanyu';
    const deputy = getHero(deputyId)!;
    p.heroId = s.heroId;
    p.deputyHeroId = deputyId;
    p.faction = s.faction;
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.maxHp = Math.max(1, Math.floor((hero.maxHp + deputy.maxHp) / 2));
    p.hp = s.hp ?? p.maxHp;
    p.hand = (s.hand ?? []).slice();
    p.flags = emptyFlags();
  }
  const first = state.seatOrder[0]!;
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: first };
  state.log = [];
  return state;
}
const at = (state: GameState, seatId: string) => state.players.find((p) => p.seatId === seatId)!;

/** 把一张牌做成「田」（屯田收上来的判定牌，急袭靠 `tian` 标记认它） */
function makeTian(owner: string, state: GameState, card: Card): Card {
  card.tian = true;
  at(state, owner).tian.push(card);
  return card;
}

/**
 * 贾诩 × 邓艾（用户 2026-09-21 给的规格）。四组交互：
 *
 * ①【乱武】里邓艾打出的【杀】是**真实的牌离开手牌**（不是「系统代他打一张」）——
 *   他于贾诩的回合**回合外失去牌** → 触发【屯田】。
 * ② 若邓艾选「失去 1 点体力」，那是体力流失、不是失去牌 → **不触发【屯田】**；
 *   万一因此濒死，因为发生在贾诩回合内，还要受【完杀】影响。
 * ③【乱武】找「距离最近的另一名角色」必须用**含「田」修正**的距离（含坐骑/其他距离技能），
 *   不能自己另算一套座次距离；并列最近时由邓艾从里面挑。
 * ④【急袭】把「田」当【顺手牵羊】时**保留这张田的真实花色**——【帷幕】看的是颜色：
 *   黑桃/梅花田转化出来的【顺手牵羊】是黑色 → 被帷幕取消；方块田是红色 → 不受影响
 *   （红桃根本不会成为「田」）。
 */
describe('国战 · 贾诩 × 邓艾（乱武 / 屯田 / 急袭 / 帷幕）', () => {
  it('① 乱武里邓艾用实体【杀】→ 回合外失去牌 → 触发【屯田】', () => {
    const state = gzGame([
      { seatId: A, name: '甲', heroId: 'jiaxu', faction: 'qun' },
      { seatId: B, name: '乙', heroId: 'dengai', faction: 'wei', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', faction: 'shu' },
    ]);
    const b = at(state, B);
    state.deck = [mk('j1', 'sha', 'club', 5)]; // 屯田的判定牌（非红桃 → 可以收为田）
    ok(act(state, A, { type: 'useSkill', skillId: 'luanwu', cardIds: [], targetIds: [] }));
    // 乙（贾诩下家）两项都有：对最近的人出杀 / 失去 1 点体力
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'sha' }));
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    // 三个人一圈，甲和丙都离乙 1 格 → 并列最近，由乙自己挑（这里挑丙）
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: C }));
    expect(state.pending?.kind).toBe('respondSha');
    const c = at(state, C);
    ok(act(state, C, { type: 'pass' })); // 丙不出闪 → 掉 1 血
    // 这一刀按**出杀之前**定下的目标结算（丙）
    expect(c.hp).toBe(c.maxHp - 1);
    // 链子继续问丙（丙没杀 → 只能失去 1 点体力）
    ok(act(state, C, { type: 'chooseOption', optionId: 'hp' }));
    // ⚠️ 关键：这张【杀】离手让乙「回合外失去牌」→ 屯田问到他
    const q = state.pending;
    expect(q?.kind, '乱武里打出的实体【杀】要触发屯田').toBe('choice');
    if (q?.kind !== 'choice') throw new Error('应当轮到屯田的询问');
    expect(q.seatId).toBe(B);
    expect(q.title).toContain('屯田');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' })); // 发动屯田
    const q2 = state.pending;
    if (q2?.kind !== 'choice') throw new Error(`预期收田询问，实际是 ${q2?.kind}`);
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' })); // 收为「田」
    expect(b.tian.map((x) => x.id)).toEqual(['j1']);
    // ⚠️ 这一张新「田」**不会倒过来**改已经选好的目标：上面那一刀已经打在丙身上了
    //    （目标是在出杀**之前**按当时的距离定的，之后不再重算）
    expect(c.hp).toBe(c.maxHp - 2); // 挨了一刀 + 自己选的那次失去体力
    // 全部问完 → 回到贾诩的出牌阶段
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('② 乱武里邓艾选「失去 1 点体力」→ 不是失去牌，不触发【屯田】', () => {
    const state = gzGame([
      { seatId: A, name: '甲', heroId: 'jiaxu', faction: 'qun' },
      { seatId: B, name: '乙', heroId: 'dengai', faction: 'wei', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', faction: 'shu' },
    ]);
    const b = at(state, B);
    ok(act(state, A, { type: 'useSkill', skillId: 'luanwu', cardIds: [], targetIds: [] }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'hp' }));
    expect(b.hp).toBe(b.maxHp - 1);
    ok(act(state, C, { type: 'chooseOption', optionId: 'hp' }));
    // 体力流失 ≠ 失去牌：整条链跑完也没有屯田的询问
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    expect(b.tian).toHaveLength(0);
    expect(state.log.some((e) => e.message.includes('屯田'))).toBe(false);
    expect(b.hand.map((c) => c.id)).toEqual(['b1']); // 那张杀还在手里
  });

  it('②补 乱武里失去体力进濒死 → 贾诩回合内的【完杀】生效（其他人不能出桃）', () => {
    const state = gzGame([
      { seatId: A, name: '甲', heroId: 'jiaxu', faction: 'qun', hand: [tao('a1')] },
      { seatId: B, name: '乙', heroId: 'dengai', faction: 'wei', hp: 1 }, // 没手牌 → 只能失去体力
      { seatId: C, name: '丙', heroId: 'vanilla', faction: 'shu', hand: [tao('c1')] },
    ]);
    ok(act(state, A, { type: 'useSkill', skillId: 'luanwu', cardIds: [], targetIds: [] }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'hp' }));
    expect(state.pending?.kind).toBe('respondDeath');
    if (state.pending?.kind === 'respondDeath') {
      expect(state.pending.askQueue).toContain(B); // 濒死者自己能出桃
      expect(state.pending.askQueue).toContain(A); // 完杀持有者（当前回合人）也能
      expect(state.pending.askQueue, '【完杀】：丙不能用桃救别人').not.toContain(C);
    }
  });

  it('③ 乱武的「最近角色」用**含「田」修正**的距离（并列最近由邓艾自己挑）', () => {
    const state = gzGame([
      { seatId: A, name: '甲', heroId: 'jiaxu', faction: 'qun' },
      { seatId: B, name: '乙', heroId: 'dengai', faction: 'wei', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', faction: 'shu' },
      { seatId: D, name: '丁', heroId: 'vanilla', faction: 'wu' },
    ]);
    const b = at(state, B);
    // 一座「田」都没有时：乙→甲/丙 都是 1，乙→丁 是 2
    expect(distance(state, B, A)).toBe(1);
    expect(distance(state, B, C)).toBe(1);
    expect(distance(state, B, D)).toBe(2);
    makeTian(B, state, mk('t1', 'sha', 'diamond', 8));
    // 一张田 → 所有人的距离 -1，但**下限是 1**：丁从 2 变成 1，于是和甲、丙并列最近
    expect(distance(state, B, A)).toBe(1);
    expect(distance(state, B, D)).toBe(1);
    ok(act(state, A, { type: 'useSkill', skillId: 'luanwu', cardIds: [], targetIds: [] }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'sha' }));
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    // 并列最近的三个都能选（丁是被「田」拉进来的那个）
    const q = state.pending;
    expect(q?.kind).toBe('choice');
    if (q?.kind !== 'choice') throw new Error('应当让乙挑目标');
    expect(q.options.map((o) => o.id).sort()).toEqual([A, C, D]);
  });

  it('④ 急袭×帷幕：黑桃/梅花田当【顺手牵羊】被取消，方块田不受影响', () => {
    const state = gzGame([
      { seatId: A, name: '甲', heroId: 'dengai', faction: 'wei', hand: [] },
      { seatId: B, name: '乙', heroId: 'jiaxu', faction: 'qun', hand: [sha('b1'), tao('b2')] },
    ]);
    const a = at(state, A);
    const b = at(state, B);
    // 邓艾是**主将**（急袭是主将技）
    expect(a.heroId).toBe('dengai');
    const spadeTian = makeTian(A, state, mk('t1', 'sha', 'spade', 5));
    const clubTian = makeTian(A, state, mk('t2', 'sha', 'club', 5));
    const diamondTian = makeTian(A, state, mk('t3', 'sha', 'diamond', 8));
    // 黑桃田 → 黑色【顺手牵羊】→ 帷幕取消这个目标（整次使用不成立）
    const r1 = act(state, A, { type: 'playCard', cardId: spadeTian.id, as: 'shunshou', targetIds: [B] });
    expect(r1.ok, '黑色田转化的顺手牵羊要被帷幕挡掉').toBe(false);
    const r2 = act(state, A, { type: 'playCard', cardId: clubTian.id, as: 'shunshou', targetIds: [B] });
    expect(r2.ok, '梅花田同理').toBe(false);
    expect(a.tian.map((c) => c.id)).toEqual(['t1', 't2', 't3']); // 都没被消耗
    expect(b.hand).toHaveLength(2);
    // 方块田 → 红色【顺手牵羊】→ 帷幕不管，正常结算
    ok(act(state, A, { type: 'playCard', cardId: diamondTian.id, as: 'shunshou', targetIds: [B] }));
    passWuxie(state);
    ok(act(state, A, { type: 'chooseOption', optionId: 'hand:0' })); // 盲选一张手牌
    expect(a.tian.map((c) => c.id)).toEqual(['t1', 't2']); // 方块田用掉了
    expect(b.hand).toHaveLength(1);
    expect(a.hand.map((c) => c.id)).toEqual(['b1']); // 拿到的牌进了手牌
  });

  it('④补 田的花色来自判定牌本身（红桃根本不会成为「田」）', () => {
    const state = gzGame([
      { seatId: A, name: '甲', heroId: 'vanilla', faction: 'qun', hand: [mk('a1', 'guohe', 'spade', 6)] },
      { seatId: B, name: '乙', heroId: 'dengai', faction: 'wei', hand: [tao('b1')] },
    ]);
    const b = at(state, B);
    state.deck = [mk('j1', 'shan', 'heart', 3)]; // 红桃判定 → 不能作为田
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    ok(act(state, A, { type: 'chooseOption', optionId: 'hand:0' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' })); // 发动屯田
    expect(state.pending).toEqual({ kind: 'play', seatId: A }); // 红桃不问「是否置为田」
    expect(b.tian).toHaveLength(0);
    expect(state.discard.some((c) => c.id === 'j1')).toBe(true);
  });
});
