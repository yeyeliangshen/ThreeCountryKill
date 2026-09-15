import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  baseDistance,
  canTarget,
  createGame,
  distance,
  HEROES,
  getHero,
  getHeroForMode,
  pushLog,
  toSnapshot,
  emptyFlags,
  type GameState,
  type SeatSetup,
} from '../src';
import type { Card, CardType, Faction, GameMode, Suit } from '@sgs/protocol';

// —— 测试辅助 ——
function mk(id: string, type: CardType, suit: Suit = 'spade', rank = 1): Card {
  return { id, type, suit, rank };
}
const sha = (id: string, suit: Suit = 'spade') => mk(id, 'sha', suit);
const shan = (id: string, suit: Suit = 'heart') => mk(id, 'shan', suit);
const tao = (id: string, suit: Suit = 'heart') => mk(id, 'tao', suit);
const jiu = (id: string, suit: Suit = 'spade') => mk(id, 'jiu', suit);
const lebu = (id: string, suit: Suit = 'spade') => mk(id, 'lebu', suit);
const shandian = (id: string, suit: Suit = 'spade') => mk(id, 'shandian', suit);
const bingliang = (id: string, suit: Suit = 'spade') => mk(id, 'bingliang', suit);
// 即时锦囊
const wuzhong = (id: string) => mk(id, 'wuzhong', 'heart');
const guohe = (id: string) => mk(id, 'guohe', 'spade');
const shunshou = (id: string) => mk(id, 'shunshou', 'spade');
const juedou = (id: string) => mk(id, 'juedou', 'spade');
const nanman = (id: string) => mk(id, 'nanman', 'spade');
const wanjian = (id: string) => mk(id, 'wanjian', 'heart');
const huogong = (id: string) => mk(id, 'huogong', 'heart');
const taoyuan = (id: string) => mk(id, 'taoyuan', 'heart');
const wuxie = (id: string) => mk(id, 'wuxie', 'spade');
const jiedao = (id: string) => mk(id, 'jiedao', 'club');
const wpn = (id: string): Card => ({ id, type: 'weapon', suit: 'spade', rank: 1, equipName: 'qinggang', range: 2 });

interface SeatOpts {
  seatId: string;
  name: string;
  heroId: string;
  hand: Card[];
  hp?: number;
}

/** 构造可控局面：指定武将/手牌/体力，并把第一个玩家置入出牌阶段 */
function makeGame(seats: SeatOpts[]): GameState {
  const setup: SeatSetup[] = seats.map((s) => ({
    seatId: s.seatId,
    name: s.name,
    heroId: s.heroId,
  }));
  const state = createGame(setup, 'TEST');
  // 直接构造中局：跳过选将阶段，手动设定武将/体力/手牌
  state.draft = null;
  for (const s of seats) {
    const p = state.players.find((pl) => pl.seatId === s.seatId)!;
    const hero = getHero(s.heroId);
    p.heroId = s.heroId;
    p.maxHp = hero?.maxHp ?? 4;
    p.hp = s.hp ?? p.maxHp;
    p.hand = s.hand.slice();
    p.flags = emptyFlags();
  }
  // 让第一个玩家进入出牌阶段（覆盖 createGame 的默认开局）
  const first = state.seatOrder[0]!;
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: first };
  state.log = [];
  return state;
}

/** 同 makeGame，但可指定模式（保留 createGame 设定的 role/team） */
function makeGameMode(seats: SeatOpts[], mode: GameMode): GameState {
  const setup: SeatSetup[] = seats.map((s) => ({
    seatId: s.seatId,
    name: s.name,
    heroId: s.heroId,
  }));
  const state = createGame(setup, 'TEST', { mode });
  state.draft = null;
  for (const s of seats) {
    const p = state.players.find((pl) => pl.seatId === s.seatId)!;
    const hero = getHero(s.heroId);
    p.heroId = s.heroId;
    p.maxHp = hero?.maxHp ?? 4;
    p.hp = s.hp ?? p.maxHp;
    p.hand = s.hand.slice();
    p.flags = emptyFlags();
  }
  const first = state.seatOrder[0]!;
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: first };
  state.log = [];
  return state;
}

const A = 's0';
const B = 's1';
const C = 's2';
const D = 's3';
const E = 's4';

function act(state: GameState, seatId: string, intent: Parameters<typeof applyIntent>[2]) {
  return applyIntent(state, seatId, intent);
}
function ok(res: ReturnType<typeof applyIntent>, msg?: string) {
  if (!res.ok) throw new Error(`预期成功但失败：${res.error} ${msg ?? ''}`);
}
function fail(res: ReturnType<typeof applyIntent>) {
  if (res.ok) throw new Error('预期失败但成功了');
}
/** 快速跳过无懈可击询问轮（所有人弃权） */
function passWuxie(state: GameState) {
  while (state.pending?.kind === 'wuxieQueue') {
    const asked = state.pending.askQueue[state.pending.askIndex]!;
    ok(act(state, asked, { type: 'pass' }));
  }
}
/** 快速跳过濒死救援轮（所有人弃权） */
function passDeathSaves(state: GameState) {
  while (state.pending?.kind === 'respondDeath') {
    const asked = state.pending.askQueue[state.pending.askIndex]!;
    ok(act(state, asked, { type: 'pass' }));
  }
}

// ——————————————————————————————————————————

describe('基础牌时序：杀→闪→伤害', () => {
  it('目标出闪，不扣血，回到来源出牌阶段', () => {
    const state = makeGame([
      { seatId: A, name: '张三', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '李四', heroId: 'vanilla', hand: [shan('b1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(state.pending?.kind).toBe('respondSha');
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(4); // 未扣血
    expect(b.hand).toHaveLength(0);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('目标弃权，扣 1 血', () => {
    const state = makeGame([
      { seatId: A, name: '张三', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '李四', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(3);
  });

  it('酒+杀：伤害+1', () => {
    const state = makeGame([
      { seatId: A, name: '张三', heroId: 'vanilla', hand: [jiu('a0'), sha('a1')] },
      { seatId: B, name: '李四', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a0', targetIds: [] })); // 酒
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] })); // 杀(伤害2)
    ok(act(state, B, { type: 'pass' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(2);
  });
});

describe('濒死→求桃→死亡 / 救活', () => {
  it('张飞一回合出 4 杀，对方无桃无闪，濒死求桃全弃权→阵亡→游戏结束', () => {
    const state = makeGame([
      { seatId: A, name: '张飞', heroId: 'zhangfei', hand: [sha('a1'), sha('a2'), sha('a3'), sha('a4')] },
      { seatId: B, name: '李四', heroId: 'vanilla', hand: [] },
    ]);
    // 4 杀，每次 B 弃权
    for (let i = 1; i <= 4; i++) {
      ok(act(state, A, { type: 'playCard', cardId: `a${i}`, targetIds: [B] }), `第${i}杀`);
      ok(act(state, B, { type: 'pass' }));
    }
    // 第 4 杀后 B 体力 0 → 濒死，轮询 [B, A]
    expect(state.pending?.kind).toBe('respondDeath');
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBeLessThanOrEqual(0);
    // B 弃权
    ok(act(state, B, { type: 'pass' }));
    // A 也被询问（可出桃救人），A 弃权
    ok(act(state, A, { type: 'pass' }));
    // 全部弃权 → 死亡
    expect(b.alive).toBe(false);
    expect(state.gameOver).toBe(true);
  });

  it('濒死时出桃自救，存活', () => {
    const state = makeGame([
      { seatId: A, name: '张飞', heroId: 'zhangfei', hand: [sha('a1'), sha('a2'), sha('a3'), sha('a4')] },
      { seatId: B, name: '李四', heroId: 'vanilla', hand: [tao('b1')] },
    ]);
    for (let i = 1; i <= 3; i++) {
      ok(act(state, A, { type: 'playCard', cardId: `a${i}`, targetIds: [B] }));
      ok(act(state, B, { type: 'pass' }));
    }
    // 第 4 杀 → 濒死
    ok(act(state, A, { type: 'playCard', cardId: 'a4', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(state.pending?.kind).toBe('respondDeath');
    // B 出桃自救
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.alive).toBe(true);
    expect(b.hp).toBe(1);
    expect(state.gameOver).toBe(false);
  });
});

describe('武将技能', () => {
  it('关羽·武圣：无杀但有红牌，可当杀使用', () => {
    const state = makeGame([
      { seatId: A, name: '关羽', heroId: 'guanyu', hand: [shan('a1')] }, // 红色闪
      { seatId: B, name: '李四', heroId: 'vanilla', hand: [] },
    ]);
    // 红色闪当杀（as='sha'）
    ok(act(state, A, { type: 'playCard', cardId: 'a1', as: 'sha', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(3);
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand).toHaveLength(0); // 红牌已作为杀打出
  });

  it('关羽·武圣：黑色牌不能当杀', () => {
    const state = makeGame([
      { seatId: A, name: '关羽', heroId: 'guanyu', hand: [mk('a1', 'tao', 'club')] }, // 黑色桃
      { seatId: B, name: '李四', heroId: 'vanilla', hand: [] },
    ]);
    fail(act(state, A, { type: 'playCard', cardId: 'a1', as: 'sha', targetIds: [B] }));
  });

  it('张飞·咆哮：一回合可出多张杀（普通武将只能 1 张）', () => {
    // 普通武将第二张杀应被拒
    const stateVanilla = makeGame([
      { seatId: A, name: '张三', heroId: 'vanilla', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '李四', heroId: 'vanilla', hand: [shan('b1'), shan('b2')] },
    ]);
    ok(act(stateVanilla, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(stateVanilla, B, { type: 'respondCard', cardId: 'b1' })); // 闪
    // 第二张杀：普通武将应被拒
    fail(act(stateVanilla, A, { type: 'playCard', cardId: 'a2', targetIds: [B] }));

    // 张飞：第二张杀允许
    const stateZF = makeGame([
      { seatId: A, name: '张飞', heroId: 'zhangfei', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '李四', heroId: 'vanilla', hand: [shan('b1'), shan('b2')] },
    ]);
    ok(act(stateZF, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(stateZF, B, { type: 'respondCard', cardId: 'b1' }));
    ok(act(stateZF, A, { type: 'playCard', cardId: 'a2', targetIds: [B] })); // 咆哮允许
    ok(act(stateZF, B, { type: 'respondCard', cardId: 'b2' }));
    const b = stateZF.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(4); // 两张杀都被闪避
  });

  it('桃·出牌阶段回血（体力未满时）', () => {
    const state = makeGame([
      { seatId: A, name: '张三', heroId: 'vanilla', hand: [tao('a1')], hp: 2 },
      { seatId: B, name: '李四', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hp).toBe(3);
  });
});

describe('回合流程与快照', () => {
  it('结束出牌→弃牌（超限时）→下一回合', () => {
    // A 手牌 5 张、体力 4 → 需弃 1 张
    const state = makeGame([
      { seatId: A, name: '张三', heroId: 'vanilla', hand: [sha('a1'), sha('a2'), sha('a3'), sha('a4'), sha('a5')] },
      { seatId: B, name: '李四', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'endPhase' }));
    expect(state.pending?.kind).toBe('discard');
    expect(state.pending).toMatchObject({ count: 1 });
    ok(act(state, A, { type: 'discard', cardIds: ['a5'] }));
    // 进入 B 的回合
    expect(state.turn.seatIndex).toBe(1);
    expect(state.turn.phase).toBe('play');
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('快照裁剪：他人手牌只暴露数量，本人手牌完整；被杀时收到 respondSha 提示', () => {
    const state = makeGame([
      { seatId: A, name: '张三', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '李四', heroId: 'vanilla', hand: [shan('b1'), tao('b2')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    const snapB = toSnapshot(state, B);
    expect(snapB.myHand).toHaveLength(2); // 本人完整
    expect(snapB.prompt?.kind).toBe('respondSha');
    expect(snapB.prompt?.legalCardIds).toEqual(['b1']); // 仅闪可响应
    const snapA = toSnapshot(state, A);
    expect(snapA.myHand).toHaveLength(0); // A 已打出杀
    expect(snapA.prompt).toBe(null); // A 在等待，无提示
    // A 看到的 B 手牌只有数量
    const bView = snapA.players.find((p) => p.seatId === B)!;
    expect(bView.handCount).toBe(2);
  });
});

describe('选将阶段（开局随机发将）', () => {
  it('createGame 进入选将：每人发 K 张，并发选完后开局', () => {
    const setup: SeatSetup[] = [
      { seatId: A, name: '张三' },
      { seatId: B, name: '李四' },
    ];
    const state = createGame(setup, 'TEST', { heroDealCount: 3 });

    // 处于选将阶段
    expect(state.draft).not.toBeNull();
    expect(state.turn.phase).toBe('draft');
    expect(state.pending).toBeNull();
    // 每人发 3 张将、两座均待选
    expect(state.draft!.deals[A]).toHaveLength(3);
    expect(state.draft!.deals[B]).toHaveLength(3);
    expect(state.draft!.pendingSeats).toEqual([A, B]);
    // 玩家武将未定
    expect(state.players[0]!.heroId).toBeNull();

    // 快照：只暴露本座发到的将；手牌为空
    const snapA = toSnapshot(state, A);
    expect(snapA.prompt?.kind).toBe('pickHero');
    expect(snapA.prompt?.legalHeroIds).toHaveLength(3);
    expect(snapA.myHand).toHaveLength(0);
    const snapB = toSnapshot(state, B);
    expect(snapB.prompt?.legalHeroIds).toHaveLength(3);

    // A 先选（并发，顺序无关）
    const aPick = state.draft!.deals[A]![0]!;
    ok(act(state, A, { type: 'pickHero', heroId: aPick }));
    expect(state.draft).not.toBeNull(); // B 仍未选
    expect(state.draft!.pendingSeats).toEqual([B]);
    // A 已选者再选应被拒
    fail(act(state, A, { type: 'pickHero', heroId: aPick }));
    // 选将阶段其它意图应被拒
    fail(act(state, A, { type: 'endPhase' }));

    // B 选最后一张 → 选将结束，开局
    const bPick = state.draft!.deals[B]![1]!;
    ok(act(state, B, { type: 'pickHero', heroId: bPick }));
    expect(state.draft).toBeNull();
    // 进入第一回合出牌阶段
    expect(state.turn.phase).toBe('play');
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    // 武将已定、初始手牌已发（首回合玩家再摸 2）
    const pa = state.players.find((p) => p.seatId === A)!;
    expect(pa.heroId).toBe(aPick);
    // 摸牌数不能写死 2：随机发到的武将可能有加成（周瑜·英姿 +1）
    const drawCount = 2 + (getHero(aPick)!.extraDraw ?? 0);
    expect(pa.hand).toHaveLength(4 + drawCount);
    const pb = state.players.find((p) => p.seatId === B)!;
    expect(pb.heroId).toBe(bPick);
    expect(pb.hand).toHaveLength(4);
  });

  it('发将数钳制到 [1,5]，默认 3', () => {
    const setup: SeatSetup[] = [
      { seatId: A, name: '张三' },
      { seatId: B, name: '李四' },
    ];
    expect(createGame(setup, 'T').draft!.deals[A]).toHaveLength(3);
    expect(createGame(setup, 'T', { heroDealCount: 0 }).draft!.deals[A]).toHaveLength(1);
    expect(createGame(setup, 'T', { heroDealCount: 99 }).draft!.deals[A]).toHaveLength(5);
    expect(createGame(setup, 'T', { heroDealCount: 2 }).draft!.deals[A]).toHaveLength(2);
  });

  it('不能选未发到的武将', () => {
    const setup: SeatSetup[] = [
      { seatId: A, name: '张三' },
      { seatId: B, name: '李四' },
    ];
    const state = createGame(setup, 'TEST', { heroDealCount: 3 });
    // vanilla 未必在 A 的发将中，随便挑一个不在的应被拒
    fail(act(state, A, { type: 'pickHero', heroId: '__not_dealt__' }));
  });

  it('扩池后跨玩家发将不重复（随机性回归）', () => {
    const setup: SeatSetup[] = [
      { seatId: A, name: '张三' },
      { seatId: B, name: '李四' },
    ];
    const state = createGame(setup, 'TEST', { heroDealCount: 3 });
    const aDeals = state.draft!.deals[A];
    const bDeals = state.draft!.deals[B];
    // 池已扩到 12+，6 张从 13 池中抽不重复 → 两人发将集应有差异
    const aSet = new Set(aDeals);
    const bSet = new Set(bDeals);
    const same = aDeals.every((id) => bSet.has(id)) && bDeals.every((id) => aSet.has(id));
    expect(same).toBe(false);
  });

  it('同一玩家发将不重复（n×k 超过武将池时的回归）', () => {
    // 5 人 × 3 张 = 15 张，超过 13 个武将 → 旧逻辑可能给同一人发重复武将
    const setup: SeatSetup[] = [
      { seatId: A, name: '甲' },
      { seatId: B, name: '乙' },
      { seatId: C, name: '丙' },
      { seatId: D, name: '丁' },
      { seatId: E, name: '戊' },
    ];
    for (let trial = 0; trial < 50; trial++) {
      const state = createGame(setup, 'TEST', { heroDealCount: 3 });
      for (const seat of setup) {
        const deals = state.draft!.deals[seat.seatId];
        const unique = new Set(deals);
        expect(unique.size).toBe(deals.length);
      }
    }
  });
});

// ——————————————————————————————————————————

describe('2v2 模式', () => {
  it('队伍分配：A B A B → s0/s2=team0, s1/s3=team1', () => {
    const setup: SeatSetup[] = [
      { seatId: A, name: '甲' },
      { seatId: B, name: '乙' },
      { seatId: C, name: '丙' },
      { seatId: D, name: '丁' },
    ];
    const state = createGame(setup, 'TEST', { mode: '2v2' });
    expect(state.mode).toBe('2v2');
    expect(state.players[0]!.team).toBe(0);
    expect(state.players[1]!.team).toBe(1);
    expect(state.players[2]!.team).toBe(0);
    expect(state.players[3]!.team).toBe(1);
  });

  it('某队全灭 → 对方队胜', () => {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'zhangfei', hand: [sha('a1'), sha('a2')] },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [], hp: 1 },
        { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
        { seatId: D, name: '丁', heroId: 'vanilla', hand: [], hp: 1 },
      ],
      '2v2',
    );
    // A(team0) 杀 B(team1, hp1) → B 阵亡
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // B 不出闪
    // B 濒死，求桃轮询 [B, C, D, A]
    expect(state.pending?.kind).toBe('respondDeath');
    if (state.pending?.kind === 'respondDeath') {
      for (const seat of state.pending.askQueue) {
        ok(act(state, seat, { type: 'pass' }));
      }
    }
    // B 阵亡，但 D 仍存活 → 未结束
    expect(state.players.find((p) => p.seatId === B)!.alive).toBe(false);
    expect(state.gameOver).toBe(false);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });

    // A 杀 D(team1, hp1) → D 阵亡 → team1 全灭 → team0 胜
    ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [D] }));
    ok(act(state, D, { type: 'pass' }));
    // D 濒死，求桃轮询 [D, A, C]（B 已死不在队列）
    if (state.pending?.kind === 'respondDeath') {
      for (const seat of state.pending.askQueue) {
        ok(act(state, seat, { type: 'pass' }));
      }
    }
    expect(state.gameOver).toBe(true);
    expect(state.winner).toBe('team0');
  });
});

// ——————————————————————————————————————————

describe('军争模式', () => {
  it('身份分配：5人 = 主1忠1反2内1', () => {
    const setup: SeatSetup[] = [
      { seatId: A, name: '甲' },
      { seatId: B, name: '乙' },
      { seatId: C, name: '丙' },
      { seatId: D, name: '丁' },
      { seatId: E, name: '戊' },
    ];
    const state = createGame(setup, 'TEST', { mode: 'junzheng' });
    expect(state.mode).toBe('junzheng');
    const roles = state.players.map((p) => p.role);
    expect(roles.filter((r) => r === 'lord')).toHaveLength(1);
    expect(roles.filter((r) => r === 'loyal')).toHaveLength(1);
    expect(roles.filter((r) => r === 'rebel')).toHaveLength(2);
    expect(roles.filter((r) => r === 'renegade')).toHaveLength(1);
  });

  it('快照身份可见性：主公公开、其余仅本人可见', () => {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
        { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
        { seatId: D, name: '丁', heroId: 'vanilla', hand: [] },
        { seatId: E, name: '戊', heroId: 'vanilla', hand: [] },
      ],
      'junzheng',
    );
    const lord = state.players.find((p) => p.role === 'lord')!;
    const rebel = state.players.find((p) => p.role === 'rebel')!;
    // 主公视角：自己 role=lord，他人中主公可见但这里自己是主公
    const snapLord = toSnapshot(state, lord.seatId);
    const meInLordSnap = snapLord.players.find((p) => p.seatId === lord.seatId)!;
    expect(meInLordSnap.role).toBe('lord');
    // 反贼视角：自己 role=rebel，主公 role=lord（公开），其他人 role=null
    const snapRebel = toSnapshot(state, rebel.seatId);
    const meInRebelSnap = snapRebel.players.find((p) => p.seatId === rebel.seatId)!;
    expect(meInRebelSnap.role).toBe('rebel');
    const lordInRebelSnap = snapRebel.players.find((p) => p.seatId === lord.seatId)!;
    expect(lordInRebelSnap.role).toBe('lord'); // 主公公开
    // 其他人（非主公非自己）的 role 应为 null
    const others = snapRebel.players.filter(
      (p) => p.seatId !== rebel.seatId && p.seatId !== lord.seatId,
    );
    for (const p of others) {
      expect(p.role).toBeNull();
    }
  });

  it('主公阵亡 → 反贼胜利', () => {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
        { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
        { seatId: D, name: '丁', heroId: 'vanilla', hand: [] },
        { seatId: E, name: '戊', heroId: 'vanilla', hand: [] },
      ],
      'junzheng',
    );
    // 找到主公，设体力为 1
    const lord = state.players.find((p) => p.role === 'lord')!;
    lord.hp = 1;
    // 角色随机分配，找一个非主公玩家作为攻击者
    const attacker = state.players.find((p) => p.role !== 'lord')!;
    const attackerIdx = state.seatOrder.indexOf(attacker.seatId);
    state.turn = { seatIndex: attackerIdx, phase: 'play' };
    state.pending = { kind: 'play', seatId: attacker.seatId };
    attacker.hand = [sha('a1')];
    // 给攻击者装武器（方天画戟 range 4），确保距离足够打到主公
    attacker.equipment.weapon = { id: 'w1', type: 'weapon', suit: 'spade', rank: 5, equipName: 'fangtian', range: 4 };
    ok(act(state, attacker.seatId, { type: 'playCard', cardId: 'a1', targetIds: [lord.seatId] }));
    ok(act(state, lord.seatId, { type: 'pass' })); // 主公不出闪
    // 主公濒死，全员弃权（不出桃救）
    expect(state.pending?.kind).toBe('respondDeath');
    if (state.pending?.kind === 'respondDeath') {
      for (const seat of state.pending.askQueue) {
        ok(act(state, seat, { type: 'pass' }));
      }
    }
    // 主公阵亡 → 反贼胜
    expect(state.gameOver).toBe(true);
    expect(state.winner).toBe('rebel');
  });

  it('内奸独活 → 内奸胜利', () => {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
        { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
        { seatId: D, name: '丁', heroId: 'vanilla', hand: [] },
        { seatId: E, name: '戊', heroId: 'vanilla', hand: [] },
      ],
      'junzheng',
    );
    // 找到内奸
    const renegade = state.players.find((p) => p.role === 'renegade')!;
    // 让内奸成为当前回合玩家
    const renIdx = state.seatOrder.indexOf(renegade.seatId);
    state.turn = { seatIndex: renIdx, phase: 'play' };
    state.pending = { kind: 'play', seatId: renegade.seatId };
    renegade.hand = [sha('r1')];
    // 其他玩家中只留一个存活且体力为 1（其余设为已死）
    const others = state.players.filter((p) => p.seatId !== renegade.seatId);
    for (let i = 0; i < others.length; i++) {
      if (i === 0) {
        others[i]!.hp = 1;
        others[i]!.alive = true;
      } else {
        others[i]!.hp = 0;
        others[i]!.alive = false;
      }
    }
    const victim = others[0]!;
    // 内奸杀 victim → victim 阵亡 → 仅剩内奸 → 内奸胜
    ok(act(state, renegade.seatId, { type: 'playCard', cardId: 'r1', targetIds: [victim.seatId] }));
    ok(act(state, victim.seatId, { type: 'pass' }));
    // victim 濒死，轮询 [victim, renegade]
    if (state.pending?.kind === 'respondDeath') {
      for (const seat of state.pending.askQueue) {
        ok(act(state, seat, { type: 'pass' }));
      }
    }
    expect(state.gameOver).toBe(true);
    expect(state.winner).toBe('renegade');
  });

  it('主公先手：选将结束后第一回合从主公开始', () => {
    const setup: SeatSetup[] = [
      { seatId: A, name: '甲' },
      { seatId: B, name: '乙' },
      { seatId: C, name: '丙' },
      { seatId: D, name: '丁' },
      { seatId: E, name: '戊' },
    ];
    const state = createGame(setup, 'TEST', { mode: 'junzheng' });
    // 所有玩家从发将中选第一张
    for (const p of state.players) {
      const options = state.draft!.deals[p.seatId];
      ok(act(state, p.seatId, { type: 'pickHero', heroId: options[0] }));
    }
    // finishDraft 后第一回合应从主公开始
    const lord = state.players.find((p) => p.role === 'lord')!;
    const firstTurnSeatId = state.seatOrder[state.turn.seatIndex];
    expect(firstTurnSeatId).toBe(lord.seatId);
  });

  it('死亡亮身份：阵亡玩家的身份对所有人公开', () => {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
        { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
        { seatId: D, name: '丁', heroId: 'vanilla', hand: [] },
        { seatId: E, name: '戊', heroId: 'vanilla', hand: [] },
      ],
      'junzheng',
    );
    const rebel = state.players.find((p) => p.role === 'rebel')!;
    const loyal = state.players.find((p) => p.role === 'loyal')!;
    // 反贼阵亡
    rebel.alive = false;
    rebel.hp = 0;
    // 忠臣视角能看到反贼身份
    const snap = toSnapshot(state, loyal.seatId);
    const rebelView = snap.players.find((p) => p.seatId === rebel.seatId)!;
    expect(rebelView.role).toBe('rebel');
  });

  it('游戏结束：全员身份公开', () => {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
        { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
        { seatId: D, name: '丁', heroId: 'vanilla', hand: [] },
        { seatId: E, name: '戊', heroId: 'vanilla', hand: [] },
      ],
      'junzheng',
    );
    const lord = state.players.find((p) => p.role === 'lord')!;
    lord.hp = 1;
    // 角色随机分配，找一个非主公玩家作为攻击者
    const attacker = state.players.find((p) => p.role !== 'lord')!;
    const attackerIdx = state.seatOrder.indexOf(attacker.seatId);
    state.turn = { seatIndex: attackerIdx, phase: 'play' };
    state.pending = { kind: 'play', seatId: attacker.seatId };
    attacker.hand = [sha('a1')];
    attacker.equipment.weapon = { id: 'w2', type: 'weapon', suit: 'spade', rank: 5, equipName: 'fangtian', range: 4 };
    ok(act(state, attacker.seatId, { type: 'playCard', cardId: 'a1', targetIds: [lord.seatId] }));
    ok(act(state, lord.seatId, { type: 'pass' }));
    if (state.pending?.kind === 'respondDeath') {
      for (const seat of state.pending.askQueue) {
        ok(act(state, seat, { type: 'pass' }));
      }
    }
    expect(state.gameOver).toBe(true);
    // 游戏结束后，从任意视角看所有人的身份都应可见
    const viewer = state.players.find((p) => p.role === 'renegade')!;
    const snap = toSnapshot(state, viewer.seatId);
    for (const p of snap.players) {
      expect(p.role).not.toBeNull();
    }
  });
});

// ——————————————————————————————————————————

describe('国战模式', () => {
  // 国战中局辅助：设置主将+副将+阵营+暗将状态，跳过选将
  interface GuozhanSeatOpts extends SeatOpts {
    deputyHeroId: string;
    faction: Faction;
  }
  function makeGuozhanGame(seats: GuozhanSeatOpts[]): GameState {
    const setup: SeatSetup[] = seats.map((s) => ({
      seatId: s.seatId,
      name: s.name,
      heroId: s.heroId,
    }));
    const state = createGame(setup, 'TEST', { mode: 'guozhan' });
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((pl) => pl.seatId === s.seatId)!;
      const mainHero = getHero(s.heroId)!;
      const deputyHero = getHero(s.deputyHeroId)!;
      p.heroId = s.heroId;
      p.deputyHeroId = s.deputyHeroId;
      p.faction = s.faction;
      p.heroRevealed = false;
      p.deputyRevealed = false;
      p.maxHp = Math.ceil((mainHero.maxHp + deputyHero.maxHp) / 2);
      p.hp = s.hp ?? p.maxHp;
      p.hand = s.hand.slice();
      p.flags = emptyFlags();
    }
    const first = state.seatOrder[0]!;
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: first };
    state.log = [];
    return state;
  }

  /** 从发到的武将中找 2 个同阵营的 */
  function findSameFactionPair(deals: string[]): { main: string; deputy: string } | null {
    const factionOf = (id: string) => getHero(id)?.faction;
    for (let i = 0; i < deals.length; i++) {
      for (let j = i + 1; j < deals.length; j++) {
        if (factionOf(deals[i]!) === factionOf(deals[j]!)) {
          return { main: deals[i]!, deputy: deals[j]! };
        }
      }
    }
    return null;
  }

  it('选将：每人发 7 张，选 2 张同阵营，验证双将与阵营正确设置', () => {
    const setup: SeatSetup[] = [
      { seatId: A, name: '甲' },
      { seatId: B, name: '乙' },
    ];
    const state = createGame(setup, 'TEST', { mode: 'guozhan' });
    expect(state.mode).toBe('guozhan');
    expect(state.draft).not.toBeNull();
    // 每人发 7 张
    expect(state.draft!.deals[A]).toHaveLength(7);
    expect(state.draft!.deals[B]).toHaveLength(7);
    // 发将池不含中立
    for (const id of state.draft!.deals[A]) {
      expect(getHero(id)?.faction).not.toBe('neutral');
    }

    // A 选 2 张同阵营武将
    const pairA = findSameFactionPair(state.draft!.deals[A]!)!;
    expect(pairA).not.toBeNull();
    ok(act(state, A, { type: 'pickHero', heroId: pairA.main, deputyHeroId: pairA.deputy }));
    const pa = state.players.find((p) => p.seatId === A)!;
    expect(pa.heroId).toBe(pairA.main);
    expect(pa.deputyHeroId).toBe(pairA.deputy);
    expect(pa.faction).toBe(getHero(pairA.main)!.faction);

    // B 也选
    const pairB = findSameFactionPair(state.draft!.deals[B]!)!;
    ok(act(state, B, { type: 'pickHero', heroId: pairB.main, deputyHeroId: pairB.deputy }));
    // 选将结束，进入出牌阶段
    expect(state.draft).toBeNull();
    expect(state.turn.phase).toBe('play');
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('同阵营校验：选不同阵营的 2 将 → 应返回 error', () => {
    const setup: SeatSetup[] = [
      { seatId: A, name: '甲' },
      { seatId: B, name: '乙' },
    ];
    const state = createGame(setup, 'TEST', { mode: 'guozhan' });
    // 7 张从 4 阵营池（16 将）中发，最大阵营 5 张，必含不同阵营对
    const dealsA = state.draft!.deals[A]!;
    let diff1 = '';
    let diff2 = '';
    for (let i = 0; i < dealsA.length; i++) {
      for (let j = i + 1; j < dealsA.length; j++) {
        if (getHero(dealsA[i]!)?.faction !== getHero(dealsA[j]!)?.faction) {
          diff1 = dealsA[i]!;
          diff2 = dealsA[j]!;
          break;
        }
      }
      if (diff1) break;
    }
    expect(diff1).toBeTruthy(); // 保证找到了不同阵营对
    fail(act(state, A, { type: 'pickHero', heroId: diff1, deputyHeroId: diff2 }));
  });

  it('体力计算：maxHp = floor((主将 + 副将) / 2)，珠联璧合再 +1', () => {
    const setup: SeatSetup[] = [
      { seatId: A, name: '甲' },
      { seatId: B, name: '乙' },
    ];
    const state = createGame(setup, 'TEST', { mode: 'guozhan' });
    const pairA = findSameFactionPair(state.draft!.deals[A]!)!;
    const mainHero = getHero(pairA.main)!;
    const deputyHero = getHero(pairA.deputy)!;
    // 官方规则：向下取整；若该组合为珠联璧合则体力上限再 +1
    const isCombo =
      (mainHero.combo?.with === deputyHero.id && mainHero.combo.bonus === 'hp') ||
      (deputyHero.combo?.with === mainHero.id && deputyHero.combo.bonus === 'hp');
    const expectedHp =
      Math.floor((mainHero.maxHp + deputyHero.maxHp) / 2) + (isCombo ? 1 : 0);
    ok(act(state, A, { type: 'pickHero', heroId: pairA.main, deputyHeroId: pairA.deputy }));
    const pairB = findSameFactionPair(state.draft!.deals[B]!)!;
    ok(act(state, B, { type: 'pickHero', heroId: pairB.main, deputyHeroId: pairB.deputy }));
    const pa = state.players.find((p) => p.seatId === A)!;
    expect(pa.maxHp).toBe(expectedHp);
    expect(pa.hp).toBe(expectedHp);
  });

  it('暗将隐藏：未亮将时他人快照 heroId/deputyHeroId/faction 均为 null', () => {
    const state = makeGuozhanGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputyHeroId: 'guanyu', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    // A 的视角看 B：未亮将 → 全 null
    const snapA = toSnapshot(state, A);
    const bView = snapA.players.find((p) => p.seatId === B)!;
    expect(bView.heroId).toBeNull();
    expect(bView.deputyHeroId).toBeNull();
    expect(bView.faction).toBeNull();
    // heroRevealed/deputyRevealed 是公开信息
    expect(bView.heroRevealed).toBe(false);
    expect(bView.deputyRevealed).toBe(false);
    // 自己看自己：完整可见
    const aView = snapA.players.find((p) => p.seatId === A)!;
    expect(aView.heroId).toBe('zhangfei');
    expect(aView.deputyHeroId).toBe('guanyu');
    expect(aView.faction).toBe('shu');
  });

  it('亮将：出牌阶段发 revealHero → 他人快照可见武将名和阵营', () => {
    const state = makeGuozhanGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputyHeroId: 'guanyu', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    // A 在自己的出牌阶段，亮主将
    ok(act(state, A, { type: 'revealHero', heroId: 'zhangfei' }));
    const pa = state.players.find((p) => p.seatId === A)!;
    expect(pa.heroRevealed).toBe(true);
    expect(pa.deputyRevealed).toBe(false);
    // B 的视角看 A：主将已亮 → heroId 可见、faction 可见
    const snapB = toSnapshot(state, B);
    const aView = snapB.players.find((p) => p.seatId === A)!;
    expect(aView.heroId).toBe('zhangfei');
    expect(aView.faction).toBe('shu');
    // 副将未亮 → 仍 null
    expect(aView.deputyHeroId).toBeNull();
    expect(aView.deputyRevealed).toBe(false);

    // 再亮副将
    ok(act(state, A, { type: 'revealHero', heroId: 'guanyu' }));
    expect(pa.deputyRevealed).toBe(true);
    const snapB2 = toSnapshot(state, B);
    const aView2 = snapB2.players.find((p) => p.seatId === A)!;
    expect(aView2.deputyHeroId).toBe('guanyu');
  });

  it('亮将校验：非国战模式不能亮将', () => {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      ],
      'melee',
    );
    fail(act(state, A, { type: 'revealHero', heroId: 'vanilla' }));
  });

  it('亮将校验：非自己回合不能亮将', () => {
    const state = makeGuozhanGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputyHeroId: 'guanyu', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    // B 不是当前回合玩家，亮将应失败
    fail(act(state, B, { type: 'revealHero', heroId: 'xuchu' }));
  });

  it('阵亡亮将：杀死玩家 → 他人快照可见双将名和阵营', () => {
    const state = makeGuozhanGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputyHeroId: 'guanyu', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [], hp: 1 },
    ]);
    // A 杀 B (hp1) → B 阵亡
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    // B 濒死，轮询
    if (state.pending?.kind === 'respondDeath') {
      for (const seat of state.pending.askQueue) {
        ok(act(state, seat, { type: 'pass' }));
      }
    }
    const pb = state.players.find((p) => p.seatId === B)!;
    expect(pb.alive).toBe(false);
    // 阵亡后双将亮
    expect(pb.heroRevealed).toBe(true);
    expect(pb.deputyRevealed).toBe(true);
    // A 的视角看 B：阵亡 → 双将可见
    const snapA = toSnapshot(state, A);
    const bView = snapA.players.find((p) => p.seatId === B)!;
    expect(bView.heroId).toBe('xuchu');
    expect(bView.deputyHeroId).toBe('zhenji');
    expect(bView.faction).toBe('wei');
  });

  it('阵营胜利：杀死其它阵营所有玩家 → 剩余阵营获胜', () => {
    const state = makeGuozhanGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputyHeroId: 'guanyu', faction: 'shu', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [], hp: 1 },
      { seatId: C, name: '丙', heroId: 'lvbu', deputyHeroId: 'diaochan', faction: 'qun', hand: [], hp: 1 },
    ]);
    // 亮主将张飞（咆哮：无限出杀），否则暗将只能出 1 杀
    ok(act(state, A, { type: 'revealHero', heroId: 'zhangfei' }));
    // A(shu) 杀 B(wei, hp1) → B 阵亡
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    if (state.pending?.kind === 'respondDeath') {
      for (const seat of state.pending.askQueue) {
        ok(act(state, seat, { type: 'pass' }));
      }
    }
    // B 阵亡，但 C(qun) 仍存活 → 未结束
    expect(state.gameOver).toBe(false);
    // A 杀 C(qun, hp1) → C 阵亡 → 只剩 A(shu) → 蜀势力胜
    ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [C] }));
    ok(act(state, C, { type: 'pass' }));
    if (state.pending?.kind === 'respondDeath') {
      for (const seat of state.pending.askQueue) {
        ok(act(state, seat, { type: 'pass' }));
      }
    }
    expect(state.gameOver).toBe(true);
    expect(state.winner).toBe('shu');
  });

  it('同阵营多人存活 → 该阵营胜', () => {
    const state = makeGuozhanGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputyHeroId: 'guanyu', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'machao', deputyHeroId: 'huangzhong', faction: 'shu', hand: [] },
      { seatId: C, name: '丙', heroId: 'lvbu', deputyHeroId: 'diaochan', faction: 'qun', hand: [], hp: 1 },
    ]);
    // A(shu) 杀 C(qun, hp1) → C 阵亡 → 只剩 A、B（均 shu）→ 蜀势力胜
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    ok(act(state, C, { type: 'pass' }));
    if (state.pending?.kind === 'respondDeath') {
      for (const seat of state.pending.askQueue) {
        ok(act(state, seat, { type: 'pass' }));
      }
    }
    expect(state.gameOver).toBe(true);
    expect(state.winner).toBe('shu');
  });
});

// ——————————————————————————————————————————

describe('即时锦囊', () => {
  it('无中生有：自己摸 2 张', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [wuzhong('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand).toHaveLength(2);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('过河拆桥：弃目标 1 张手牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [guohe('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hand).toHaveLength(0);
    expect(state.discard.some((c) => c.id === 'b1')).toBe(true);
  });

  it('过河拆桥：可拆指定装备', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [guohe('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.weapon = wpn('w1');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B], targetCardId: 'w1' }));
    passWuxie(state);
    expect(b.equipment.weapon).toBeNull();
    expect(state.discard.some((c) => c.id === 'w1')).toBe(true);
  });

  it('顺手牵羊：获得目标 1 张手牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [shunshou('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand.some((c) => c.id === 'b1')).toBe(true);
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hand).toHaveLength(0);
  });

  it('决斗：交替出杀，不出者受伤', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [juedou('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    // B 先出杀
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    // A 出杀
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, A, { type: 'respondCard', cardId: 'a2' }));
    // B 无杀 → 弃权受伤
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, B, { type: 'pass' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(3);
  });

  it('火攻：展示同花色 → 弃牌 → 火属性伤害', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [huogong('a1'), mk('a2', 'sha', 'heart')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    // B 展示手牌（红桃）
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    // A 弃同花色牌
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, A, { type: 'respondCard', cardId: 'a2' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(3);
  });

  it('借刀杀人：持有者交出武器', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [jiedao('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.weapon = wpn('w1');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, C] }));
    passWuxie(state);
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, B, { type: 'pass' }));
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand.some((c) => c.id === 'w1')).toBe(true);
    expect(b.equipment.weapon).toBeNull();
  });

  it('南蛮入侵：依次出杀或受伤', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    // B 出杀
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    // C 弃权 → 受伤
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, C, { type: 'pass' }));
    const c = state.players.find((p) => p.seatId === C)!;
    expect(c.hp).toBe(3);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('万箭齐发：依次出闪或受伤', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [wanjian('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    // B 出闪
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    // C 弃权 → 受伤
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, C, { type: 'pass' }));
    const c = state.players.find((p) => p.seatId === C)!;
    expect(c.hp).toBe(3);
  });

  it('桃园结义：所有存活回 1 体力', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [taoyuan('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [], hp: 3 },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [], hp: 2 },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    expect(a.hp).toBe(4); // 满血不回
    expect(b.hp).toBe(4);
    expect(c.hp).toBe(3);
  });

  it('无懈可击：取消锦囊效果', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [wuzhong('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [wuxie('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    expect(state.pending?.kind).toBe('wuxieQueue');
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand).toHaveLength(0); // 没有摸牌（锦囊被取消）
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('无懈可击不能主动使用', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [wuxie('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    fail(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
  });

  it('南蛮入侵：濒死救援后继续推进', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [tao('c1')], hp: 1 },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    // B 出杀
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    // C 弃权 → 受 1 伤害 → hp=0 → 濒死
    ok(act(state, C, { type: 'pass' }));
    expect(state.pending?.kind).toBe('respondDeath');
    // C 用桃自救
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    const c = state.players.find((p) => p.seatId === C)!;
    expect(c.hp).toBe(1);
    expect(c.alive).toBe(true);
    // 回到 A 的出牌阶段
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('南蛮入侵：无人救援 → 阵亡后继续', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [], hp: 1 },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    ok(act(state, C, { type: 'pass' }));
    // C 濒死 → 无人有桃 → 阵亡
    passDeathSaves(state);
    const c = state.players.find((p) => p.seatId === C)!;
    expect(c.alive).toBe(false);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('借刀杀人：持有者出杀 → 正常结算', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [jiedao('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [shan('c1')] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.weapon = wpn('w1');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, C] }));
    passWuxie(state);
    // B 对 C 出杀
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    // C 出闪
    expect(state.pending?.kind).toBe('respondSha');
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    // 回到 A 的出牌阶段
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    const c = state.players.find((p) => p.seatId === C)!;
    expect(c.hp).toBe(4); // 未受伤
  });
});

// ——————————————————————————————————————————
// 判定阶段与延时锦囊
// ——————————————————————————————————————————
describe('延时锦囊：放置', () => {
  it('闪电：置于自己判定区', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [shandian('sd1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'sd1', targetIds: [] }));
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.judgment).toHaveLength(1);
    expect(a.judgment[0]!.type).toBe('shandian');
    expect(a.hand).toHaveLength(0);
  });

  it('乐不思蜀：置于距离1内的目标判定区', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [lebu('lb1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'lb1', targetIds: [B] }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.judgment).toHaveLength(1);
    expect(b.judgment[0]!.type).toBe('lebu');
  });

  it('乐不思蜀：不能以自己为目标', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [lebu('lb1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    fail(act(state, A, { type: 'playCard', cardId: 'lb1', targetIds: [A] }));
  });

  it('乐不思蜀：距离>1的目标无效', () => {
    // 4人圆桌：A 与 C 距离 2（无武器/马）
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [lebu('lb1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
      { seatId: D, name: '丁', heroId: 'vanilla', hand: [] },
    ]);
    fail(act(state, A, { type: 'playCard', cardId: 'lb1', targetIds: [C] }));
  });

  it('同类延时锦囊：目标判定区上限1张', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [lebu('lb1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.judgment.push(lebu('lb0'));
    fail(act(state, A, { type: 'playCard', cardId: 'lb1', targetIds: [B] }));
  });
});

describe('判定阶段：延时锦囊结算', () => {
  it('乐不思蜀非红桃 → 跳过出牌阶段', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.judgment.push(lebu('lb0'));
    // 控制判定牌：黑桃5（非红桃）置于牌堆顶（drawOne 从末尾 pop）
    state.deck.push(mk('jc', 'sha', 'spade', 5));
    // A 结束出牌 → 弃牌(空手) → endTurn → startTurn(B)
    ok(act(state, A, { type: 'endPhase' }));
    // B 判定 skipPlay → 跳过出牌 → 弃牌 → endTurn → startTurn(C)
    expect(b.flags.skipPlay).toBe(true);
    expect(b.judgment).toHaveLength(0);
    expect(state.pending).toEqual({ kind: 'play', seatId: C });
  });

  it('乐不思蜀红桃 → 不跳过出牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.judgment.push(lebu('lb0'));
    state.deck.push(mk('jc', 'tao', 'heart', 1));
    ok(act(state, A, { type: 'endPhase' }));
    expect(b.flags.skipPlay).toBe(false);
    expect(b.judgment).toHaveLength(0);
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('兵粮寸断非梅花 → 跳过摸牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.judgment.push(bingliang('bl0'));
    state.deck.push(mk('jc', 'sha', 'spade', 5));
    ok(act(state, A, { type: 'endPhase' }));
    expect(b.flags.skipDraw).toBe(true);
    expect(b.hand).toHaveLength(0);
    expect(b.judgment).toHaveLength(0);
  });

  it('兵粮寸断梅花 → 不跳过摸牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.judgment.push(bingliang('bl0'));
    state.deck.push(mk('jc', 'sha', 'club', 5));
    ok(act(state, A, { type: 'endPhase' }));
    expect(b.flags.skipDraw).toBe(false);
    expect(b.hand).toHaveLength(2);
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('闪电黑桃2-9 → 3点雷电伤害', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.hp = 4;
    b.judgment.push(shandian('sd0'));
    state.deck.push(mk('jc', 'sha', 'spade', 5));
    ok(act(state, A, { type: 'endPhase' }));
    expect(b.hp).toBe(1);
    expect(b.judgment).toHaveLength(0);
  });

  it('闪电非黑桃2-9 → 传递给下家', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.judgment.push(shandian('sd0'));
    state.deck.push(mk('jc', 'tao', 'heart', 1));
    ok(act(state, A, { type: 'endPhase' }));
    expect(b.judgment).toHaveLength(0);
    const c = state.players.find((p) => p.seatId === C)!;
    expect(c.judgment).toHaveLength(1);
    expect(c.judgment[0]!.type).toBe('shandian');
  });
});

// ——————————————————————————————————————————

describe('主动技能框架', () => {
  it('useSkill 路由：无该技能 → 失败', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    fail(
      act(state, A, { type: 'useSkill', skillId: 'nonexistent', targetIds: [] }),
    );
  });

  it('useSkill 非出牌阶段 → 失败', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
    ]);
    // A 对 B 出杀 → 进入 respondSha，B 尝试用技能 → 应失败
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    fail(
      act(state, B, { type: 'useSkill', skillId: 'test', targetIds: [] }),
    );
  });
});

// ——————————————————————————————————————————

describe('武将技能（Step 6）', () => {
  // 1. 甘宁·奇袭：黑色牌当【过河拆桥】
  it('甘宁·奇袭：黑色闪当过河拆桥，拆目标手牌', () => {
    const state = makeGame([
      { seatId: A, name: '甘宁', heroId: 'ganning', hand: [shan('a1', 'spade')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    // 黑桃闪当过河拆桥，对 B 使用
    ok(act(state, A, { type: 'playCard', cardId: 'a1', as: 'guohe', targetIds: [B] }));
    passWuxie(state);
    // B 的手牌被拆
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hand).toHaveLength(0);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  // 2. 马超·铁骑：红色判定 → 不可闪避
  it('马超·铁骑：判定红色 → 杀不可闪避', () => {
    const state = makeGame([
      { seatId: A, name: '马超', heroId: 'machao', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
    ]);
    // 控制判定牌为红桃
    state.deck.push(mk('jc', 'tao', 'heart', 1));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // B 受到伤害（不可闪避），且手牌中仍有闪（未使用）
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(3);
    expect(b.hand).toHaveLength(1);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  // 3. 黄忠·烈弓：目标手牌数≥己 → 不可闪避
  it('黄忠·烈弓：目标手牌≥己 → 杀不可闪避', () => {
    const state = makeGame([
      { seatId: A, name: '黄忠', heroId: 'huangzhong', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1'), tao('b2')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // A 出杀后手牌 0，B 手牌 2 ≥ 0 → 不可闪避
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(3);
    expect(b.hand).toHaveLength(2); // 未使用闪
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  // 4. 吕布·无双：需 2 张闪 → 全出则闪避
  it('吕布·无双：目标出 2 张闪 → 闪避成功', () => {
    const state = makeGame([
      { seatId: A, name: '吕布', heroId: 'lvbu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1'), shan('b2')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(state.pending?.kind).toBe('respondSha');
    // B 出第一张闪 → 还需 1 张
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    expect(state.pending?.kind).toBe('respondSha');
    // B 出第二张闪 → 闪避
    ok(act(state, B, { type: 'respondCard', cardId: 'b2' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(4);
    expect(b.hand).toHaveLength(0);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  // 5. 吕布·无双：只出 1 张闪 → 弃权 → 受伤害
  it('吕布·无双：目标出 1 张闪后弃权 → 受伤害', () => {
    const state = makeGame([
      { seatId: A, name: '吕布', heroId: 'lvbu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // B 出 1 张闪 → 还需 1 张
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    expect(state.pending?.kind).toBe('respondSha');
    // B 弃权 → 受伤害
    ok(act(state, B, { type: 'pass' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(3);
    expect(b.hand).toHaveLength(0);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  // 6. 夏侯惇·刚烈：非红桃判定 → 来源弃 1 牌
  it('夏侯惇·刚烈：非红桃判定 → 来源弃 1 张手牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '夏侯惇', heroId: 'xiahoudun', hand: [] },
    ]);
    // 控制判定牌为黑桃（非红桃）
    state.deck.push(mk('jc', 'sha', 'spade', 5));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // B 弃权（不出闪）→ 受伤害 → 刚烈触发
    ok(act(state, B, { type: 'pass' }));
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(3);
    // A 出杀后剩 1 张，刚烈弃 1 张 → 0 张
    expect(a.hand).toHaveLength(0);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  // 7. 司马懿·鬼才：替换不利判定牌
  it('司马懿·鬼才：用红桃手牌替换非红桃判定牌', () => {
    const state = makeGame([
      { seatId: A, name: '司马懿', heroId: 'simayi', hand: [tao('a1', 'heart')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    // B 判定区有乐不思蜀
    const b = state.players.find((p) => p.seatId === B)!;
    b.judgment.push(lebu('lb0'));
    // 控制判定牌为黑桃（对乐不思蜀不利）
    state.deck.push(mk('jc', 'sha', 'spade', 5));
    // A 结束出牌 → B 回合开始 → 判定阶段
    ok(act(state, A, { type: 'endPhase' }));
    // 司马懿用红桃替换 → 乐不思蜀无效 → B 不跳过出牌
    expect(b.flags.skipPlay).toBe(false);
    // A 的红桃手牌已用于替换
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand).toHaveLength(0);
    // B 进入出牌阶段
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  // 8. 孙权·制衡：弃牌摸等量
  it('孙权·制衡：弃 2 张牌 → 摸 2 张', () => {
    const state = makeGame([
      { seatId: A, name: '孙权', heroId: 'sunquan', hand: [sha('a1'), shan('a2')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    // 控制摸到的牌
    state.deck.push(mk('d1', 'sha', 'club', 2));
    state.deck.push(mk('d2', 'shan', 'diamond', 3));
    ok(act(state, A, { type: 'useSkill', skillId: 'zhiheng', cardIds: ['a1', 'a2'], targetIds: [] }));
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand).toHaveLength(2);
    expect(a.flags.skillUsedThisTurn['zhiheng']).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  // 9. 黄盖·苦肉：失去 1 体力 → 摸 2 张
  it('黄盖·苦肉：失去 1 体力 → 摸 2 张', () => {
    const state = makeGame([
      { seatId: A, name: '黄盖', heroId: 'huanggai', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    state.deck.push(mk('d1', 'sha', 'club', 2));
    state.deck.push(mk('d2', 'shan', 'diamond', 3));
    ok(act(state, A, { type: 'useSkill', skillId: 'kurou', targetIds: [] }));
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hp).toBe(3);
    expect(a.hand).toHaveLength(2);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  // 10. 貂蝉·离间：令男性 A 对男性 B 出杀
  it('貂蝉·离间：令关羽对张飞出杀，张飞不出 → 受伤害', () => {
    const state = makeGame([
      { seatId: A, name: '貂蝉', heroId: 'diaochan', hand: [sha('a1')] },
      { seatId: B, name: '关羽', heroId: 'guanyu', hand: [sha('b1')] },
      { seatId: C, name: '张飞', heroId: 'zhangfei', hand: [] },
    ]);
    // 貂蝉弃 1 牌，选 B（关羽）对 C（张飞）出杀
    ok(act(state, A, { type: 'useSkill', skillId: 'lilian', cardIds: ['a1'], targetIds: [B, C] }));
    // B 被要求出杀 → B 出杀
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    // C 被要求出闪 → C 弃权 → 受伤害
    expect(state.pending?.kind).toBe('respondSha');
    ok(act(state, C, { type: 'pass' }));
    const c = state.players.find((p) => p.seatId === C)!;
    const b = state.players.find((p) => p.seatId === B)!;
    expect(c.hp).toBe(3);
    expect(b.hand).toHaveLength(0);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  // 11. 周瑜·反间：目标交出不同类型牌
  it('周瑜·反间：展示杀 → 目标交出闪（不同类型）', () => {
    const state = makeGame([
      { seatId: A, name: '周瑜', heroId: 'zhouyu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
    ]);
    ok(act(state, A, { type: 'useSkill', skillId: 'fanjian', cardIds: ['a1'], targetIds: [B] }));
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    // B 交出闪（不同类型），获得杀
    expect(a.hand).toHaveLength(1);
    expect(a.hand[0]!.id).toBe('b1');
    expect(b.hand).toHaveLength(1);
    expect(b.hand[0]!.id).toBe('a1');
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });
});

// ——————————————————————————————————————————

describe('国战进阶（Step 7）', () => {
  // 国战中局辅助（与「国战模式」describe 中的同名函数一致）
  interface GuozhanSeatOpts extends SeatOpts {
    deputyHeroId: string;
    faction: Faction;
  }
  function makeGuozhanGame(seats: GuozhanSeatOpts[]): GameState {
    const setup: SeatSetup[] = seats.map((s) => ({
      seatId: s.seatId,
      name: s.name,
      heroId: s.heroId,
    }));
    const state = createGame(setup, 'TEST', { mode: 'guozhan' });
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((pl) => pl.seatId === s.seatId)!;
      const mainHero = getHero(s.heroId)!;
      const deputyHero = getHero(s.deputyHeroId)!;
      p.heroId = s.heroId;
      p.deputyHeroId = s.deputyHeroId;
      p.faction = s.faction;
      p.heroRevealed = false;
      p.deputyRevealed = false;
      p.maxHp = Math.ceil((mainHero.maxHp + deputyHero.maxHp) / 2);
      p.hp = s.hp ?? p.maxHp;
      p.hand = s.hand.slice();
      p.flags = emptyFlags();
    }
    const first = state.seatOrder[0]!;
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: first };
    state.log = [];
    return state;
  }
  // —— 辅助：构造指定发将的国战对局，走完选将流程 ——
  const POOL = [
    'guanyu', 'zhangfei', 'zhaoyun', 'machao', 'huangzhong',
    'lvbu', 'diaochan', 'huatuo',
    'zhenji', 'simayi', 'xiahoudun', 'xuchu',
    'sunquan', 'zhouyu', 'ganning', 'huanggai',
  ];
  function makeGuozhanDraft(
    seatPicks: { seatId: string; name: string; main: string; deputy: string }[],
  ): GameState {
    const setup: SeatSetup[] = seatPicks.map((s) => ({
      seatId: s.seatId,
      name: s.name,
    }));
    const state = createGame(setup, 'TEST', { mode: 'guozhan' });
    for (const s of seatPicks) {
      const desired = [s.main, s.deputy];
      const rest = POOL.filter((id) => !desired.includes(id)).slice(0, 5);
      state.draft!.deals[s.seatId] = [...desired, ...rest];
    }
    for (const s of seatPicks) {
      ok(act(state, s.seatId, { type: 'pickHero', heroId: s.main, deputyHeroId: s.deputy }));
    }
    return state;
  }

  // 1. 珠联璧合
  it('珠联璧合：关羽+张飞 → maxHp +1', () => {
    const state = makeGuozhanDraft([
      { seatId: A, name: '甲', main: 'guanyu', deputy: 'zhangfei' },
      { seatId: B, name: '乙', main: 'xuchu', deputy: 'zhenji' },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    // 关羽(4)+张飞(4) → floor(8/2)=4 + 1(珠联璧合) = 5
    expect(a.maxHp).toBe(5);
    // 许褚(4)+甄姬(3) → floor(7/2)=3，无珠联璧合
    expect(b.maxHp).toBe(3);
  });

  it('珠联璧合：吕布+貂蝉 → maxHp +1', () => {
    const state = makeGuozhanDraft([
      { seatId: A, name: '甲', main: 'lvbu', deputy: 'diaochan' },
      { seatId: B, name: '乙', main: 'xuchu', deputy: 'zhenji' },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    // 吕布(4)+貂蝉(3) → floor(7/2)=3 + 1(珠联璧合) = 4
    expect(a.maxHp).toBe(4);
  });

  it('体力上限向下取整：孙权+周瑜 → floor(3.5)=3 再 +1 = 4（原 ceil 会得 5）', () => {
    const state = makeGuozhanDraft([
      { seatId: A, name: '甲', main: 'sunquan', deputy: 'zhouyu' },
      { seatId: B, name: '乙', main: 'xuchu', deputy: 'zhenji' },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.maxHp).toBe(4);
    expect(a.hp).toBe(4);
  });

  // 2. 野心家分配
  it('野心家分配：4 人局 3 蜀 → 最后一个蜀变为野心家', () => {
    const state = makeGuozhanDraft([
      { seatId: A, name: '甲', main: 'guanyu', deputy: 'zhangfei' },
      { seatId: B, name: '乙', main: 'zhaoyun', deputy: 'machao' },
      { seatId: C, name: '丙', main: 'huangzhong', deputy: 'guanyu' },
      { seatId: D, name: '丁', main: 'xuchu', deputy: 'zhenji' },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    const d = state.players.find((p) => p.seatId === D)!;
    expect(a.faction).toBe('shu');
    expect(b.faction).toBe('shu');
    // C 是最后一个蜀 → 变为野心家（3 蜀 > ceil(4/2)=2，多 1 人）
    expect(c.faction).toBe('ambitionist');
    expect(d.faction).toBe('wei');
  });

  // 3. 鏖战桃当杀
  it('鏖战：2 阵营存活时桃可当杀使用', () => {
    const state = makeGuozhanGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputyHeroId: 'guanyu', faction: 'shu', hand: [tao('t1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    // 2 人国战 = 2 阵营存活 → 鏖战激活
    // A 用桃当杀打 B
    ok(act(state, A, { type: 'playCard', cardId: 't1', targetIds: [B], as: 'sha' }));
    // B 无闪 → 进入响应杀
    expect(state.pending?.kind).toBe('respondSha');
    ok(act(state, B, { type: 'pass' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(4 - 1);
  });

  it('鏖战未激活（3 阵营）时桃不能当杀', () => {
    const state = makeGuozhanGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputyHeroId: 'guanyu', faction: 'shu', hand: [tao('t1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'sunquan', deputyHeroId: 'zhouyu', faction: 'wu', hand: [] },
    ]);
    // 3 阵营存活 → 鏖战未激活
    fail(act(state, A, { type: 'playCard', cardId: 't1', targetIds: [B], as: 'sha' }));
  });

  // 4. 被动亮将
  it('被动亮将：成为杀目标时自动亮双将', () => {
    const state = makeGuozhanGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputyHeroId: 'guanyu', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [shan('b1')] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.heroRevealed).toBe(false);
    expect(b.deputyRevealed).toBe(false);
    // A 对 B 出杀 → B 被动亮将
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(b.heroRevealed).toBe(true);
    expect(b.deputyRevealed).toBe(true);
  });

  it('被动亮将：濒死时自动亮双将', () => {
    const state = makeGuozhanGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputyHeroId: 'guanyu', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [], hp: 1 },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    // A 杀 B(hp1) → B 受伤 hp→0 → 濒死被动亮将
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    // B 应已被动亮将并进入濒死
    expect(b.heroRevealed).toBe(true);
    expect(b.deputyRevealed).toBe(true);
    expect(state.pending?.kind).toBe('respondDeath');
  });

  // 5. 阵营多数胜利
  it('阵营多数胜利：3 存活中 2 蜀 → 蜀胜', () => {
    const state = makeGuozhanGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputyHeroId: 'guanyu', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhaoyun', deputyHeroId: 'machao', faction: 'shu', hand: [] },
      { seatId: C, name: '丙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [], hp: 4 },
      { seatId: D, name: '丁', heroId: 'simayi', deputyHeroId: 'xiahoudun', faction: 'wei', hand: [], hp: 1 },
    ]);
    // A 杀 D(hp1) → D 阵亡 → 存活 [A,B,C]，蜀 2 > half(3)=1 → 蜀胜
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [D] }));
    ok(act(state, D, { type: 'pass' }));
    passDeathSaves(state);
    expect(state.gameOver).toBe(true);
    expect(state.winner).toBe('shu');
  });

  it('野心家胜利：最后存活者为野心家 → 野心家胜', () => {
    const state = makeGuozhanGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputyHeroId: 'guanyu', faction: 'ambitionist', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [], hp: 1 },
    ]);
    // A 杀 B(hp1) → B 阵亡 → 仅 A(野心家)存活 → 野心家胜
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    passDeathSaves(state);
    expect(state.gameOver).toBe(true);
    expect(state.winner).toBe('ambitionist');
  });
});

// ——————————————————————————————————————————

describe('快照：装备与判定区公开信息（Step 8）', () => {
  it('装备牌在快照中公开可见', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.weapon = wpn('w1');
    a.equipment.armor = { id: 'ar1', type: 'armor', suit: 'club', rank: 2, equipName: 'bagua' };
    const snapB = toSnapshot(state, B);
    const aView = snapB.players.find((p) => p.seatId === A)!;
    expect(aView.equipment).toHaveLength(2);
    expect(aView.equipment.some((c) => c.id === 'w1')).toBe(true);
    expect(aView.equipment.some((c) => c.id === 'ar1')).toBe(true);
  });

  it('判定区延时锦囊在快照中公开可见', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.judgment.push(lebu('l1'), shandian('s1'));
    const snapB = toSnapshot(state, B);
    const aView = snapB.players.find((p) => p.seatId === A)!;
    expect(aView.judgment).toHaveLength(2);
    expect(aView.judgment.some((c) => c.id === 'l1')).toBe(true);
    expect(aView.judgment.some((c) => c.id === 's1')).toBe(true);
  });
});

// ——————————————————————————————————————————

describe('装备与距离（Step 10 补充）', () => {
  it('装备替换：同槽位装备 → 旧装备进弃牌堆', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [wpn('w2')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.weapon = wpn('w1'); // 已有旧武器
    ok(act(state, A, { type: 'playCard', cardId: 'w2', targetIds: [] }));
    expect(a.equipment.weapon!.id).toBe('w2');
    // 旧武器进弃牌堆
    expect(state.discard.some((c) => c.id === 'w1')).toBe(true);
    expect(state.discard.some((c) => c.id === 'w2')).toBe(false);
  });

  it('距离校验：无武器时杀只能打距离1的目标', () => {
    // 3人局：A→B 距离1，A→C 距离1（圆形相邻）
    // B 装备 +1马后 A→B 距离2，无武器打不到
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.plusMount = { id: 'pm1', type: 'plusMount', suit: 'heart', rank: 1, equipName: 'dilu' };
    // A 无武器，攻击范围=1；B 有+1马，距离=2 → 打不到
    fail(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // C 无马，距离=1 → 可以打
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
  });

  it('武器扩展攻击范围：range=2 可打到距离2的目标', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.weapon = wpn('w1'); // range=2
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.plusMount = { id: 'pm1', type: 'plusMount', suit: 'heart', rank: 1, equipName: 'dilu' };
    // 距离2，武器range=2 → 可达
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
  });

  it('−1马缩短距离：可打到原本距离2的目标', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    // A 装备 -1马 → 对 B（有+1马）距离从2降为1
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.minusMount = { id: 'mm1', type: 'minusMount', suit: 'spade', rank: 1, equipName: 'chitu' };
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.plusMount = { id: 'pm1', type: 'plusMount', suit: 'heart', rank: 1, equipName: 'dilu' };
    // 无武器 range=1，-1马把距离2降为1 → 可达
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
  });
});

describe('酒限1次救人（Step 10 补充）', () => {
  it('同一回合酒救人仅限1次', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', hand: [sha('a1'), sha('a2'), jiu('j1'), jiu('j2')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [], hp: 1 },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    // A 出杀 → B 不闪 → B 濒死
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 弃权不闪
    // 濒死救援队列从濒死者起 → B 先被询问，B 弃权后轮到 A
    expect(state.pending!.kind).toBe('respondDeath');
    ok(act(state, B, { type: 'pass' })); // B 自己先弃权
    // A 用酒救人（第1次）→ 成功
    ok(act(state, A, { type: 'respondCard', cardId: 'j1' }));
    expect(b.hp).toBe(1);
    expect(b.alive).toBe(true);
    // A 再次出杀（张飞可出多杀）→ B 再濒死
    ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 弃权不闪
    ok(act(state, B, { type: 'pass' })); // B 弃权 death save
    // A 再用酒救人（第2次）→ 应失败（限1次/回合）
    expect(state.pending!.kind).toBe('respondDeath');
    fail(act(state, A, { type: 'respondCard', cardId: 'j2' }));
  });
});

describe('死亡弃装备与判定区（Step 10 补充）', () => {
  it('阵亡时装备4槽与判定区全部进弃牌堆', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [], hp: 1 },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    // A 装武器(range=2) → 攻击范围3 ≥ 距离2（B 有+1马）
    a.equipment.weapon = wpn('aw');
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.weapon = wpn('bw');
    b.equipment.armor = { id: 'ba', type: 'armor', suit: 'club', rank: 2, equipName: 'bagua' };
    b.equipment.plusMount = { id: 'bp', type: 'plusMount', suit: 'heart', rank: 1, equipName: 'dilu' };
    b.equipment.minusMount = { id: 'bm', type: 'minusMount', suit: 'spade', rank: 1, equipName: 'chitu' };
    b.judgment.push(lebu('bl'));
    // 出杀打死 B（1血）
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 弃权不闪
    passDeathSaves(state);
    expect(b.alive).toBe(false);
    // B 的装备4槽与判定牌全部进弃牌堆
    expect(state.discard.some((c) => c.id === 'bw')).toBe(true);
    expect(state.discard.some((c) => c.id === 'ba')).toBe(true);
    expect(state.discard.some((c) => c.id === 'bp')).toBe(true);
    expect(state.discard.some((c) => c.id === 'bm')).toBe(true);
    expect(state.discard.some((c) => c.id === 'bl')).toBe(true);
  });
});

// ——————————————————————————————————————————
// 装备特效（防具 + 标志性武器）
// ——————————————————————————————————————————

const armor = (id: string, equipName: string): Card => ({
  id, type: 'armor', suit: 'club', rank: 2, equipName,
});
const weapon = (id: string, equipName: string, range = 2): Card => ({
  id, type: 'weapon', suit: 'spade', rank: 5, equipName, range,
});
const fireSha = (id: string): Card => ({
  id, type: 'sha', suit: 'heart', rank: 5, attribute: 'fire',
});

describe('装备特效：防具', () => {
  it('仁王盾：黑色的杀对你无效（不询问闪、不扣血）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = armor('ba', 'renwang');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(b.hp).toBe(b.maxHp);
    expect(state.pending!.kind).toBe('play'); // 未进入出闪询问
  });

  it('仁王盾：红色的杀仍然生效', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1', 'heart')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = armor('ba', 'renwang');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(state.pending!.kind).toBe('respondSha');
    ok(act(state, B, { type: 'pass' }));
    expect(b.hp).toBe(b.maxHp - 1);
  });

  it('青釭剑无视防具：仁王盾对黑色杀失效', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    a.equipment.weapon = weapon('aw', 'qinggang');
    b.equipment.armor = armor('ba', 'renwang');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(state.pending!.kind).toBe('respondSha');
    ok(act(state, B, { type: 'pass' }));
    expect(b.hp).toBe(b.maxHp - 1);
  });

  it('藤甲：普通杀对你无效', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = armor('ba', 'tengjia');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(b.hp).toBe(b.maxHp);
    expect(state.pending!.kind).toBe('play');
  });

  it('藤甲：火杀生效且火焰伤害 +1（1 点基础 → 2 点）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [fireSha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = armor('ba', 'tengjia');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(b.hp).toBe(b.maxHp - 2);
  });

  it('藤甲：南蛮入侵对该角色无效（直接跳过询问）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [nanman('n1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = armor('ba', 'tengjia');
    ok(act(state, A, { type: 'playCard', cardId: 'n1', targetIds: [] }));
    passWuxie(state);
    expect(b.hp).toBe(b.maxHp);
    expect(state.pending!.kind).toBe('play');
  });

  it('八卦阵：判定为红色 → 视为出闪，不扣血', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = armor('ba', 'bagua');
    state.deck.push(mk('jc', 'sha', 'heart', 5)); // 红桃 → 八卦阵成功
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(b.hp).toBe(b.maxHp);
    expect(state.pending!.kind).toBe('play');
    expect(state.discard.some((c) => c.id === 'jc')).toBe(true);
  });

  it('八卦阵：判定为黑色 → 未闪避，仍需出闪或受伤', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = armor('ba', 'bagua');
    state.deck.push(mk('jc', 'sha', 'spade', 5)); // 黑桃 → 失败
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(state.pending!.kind).toBe('respondSha');
    ok(act(state, B, { type: 'pass' }));
    expect(b.hp).toBe(b.maxHp - 1);
  });
});

describe('装备特效：武器', () => {
  it('古锭刀：目标没有手牌时伤害 +1', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    a.equipment.weapon = weapon('aw', 'guding');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(b.hp).toBe(b.maxHp - 2);
  });

  it('古锭刀：目标有手牌时伤害正常（1 点）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [tao('b1')] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    a.equipment.weapon = weapon('aw', 'guding');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(b.hp).toBe(b.maxHp - 1);
  });

  it('七星宝刀：装备时弃置判定区与装备区其他所有牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [weapon('q1', 'qixing')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.weapon = weapon('ow', 'qinggang'); // 旧武器
    a.equipment.armor = armor('oa', 'renwang');
    a.judgment.push(lebu('jl'));
    ok(act(state, A, { type: 'playCard', cardId: 'q1', targetIds: [] }));
    expect(a.equipment.weapon!.id).toBe('q1'); // 七星宝刀自身保留
    expect(a.equipment.armor).toBe(null);
    expect(a.judgment.length).toBe(0);
    expect(state.discard.some((c) => c.id === 'ow')).toBe(true);
    expect(state.discard.some((c) => c.id === 'oa')).toBe(true);
    expect(state.discard.some((c) => c.id === 'jl')).toBe(true);
  });
});

// ——————————————————————————————————————————
// 发将去重（修复：原先每人独立洗牌 → 跨玩家重复）
// ——————————————————————————————————————————

describe('发将不重复', () => {
  const seats2: SeatSetup[] = [
    { seatId: A, name: '甲' },
    { seatId: B, name: '乙' },
  ];

  it('国战两人：发到的武将互不重复，且各自内部不重复', () => {
    const state = createGame(seats2, 'TEST', { mode: 'guozhan' });
    const da = state.draft!.deals[A]!;
    const db = state.draft!.deals[B]!;
    expect(da.length).toBe(7);
    expect(db.length).toBe(7);
    expect(new Set(da).size).toBe(da.length);
    expect(new Set(db).size).toBe(db.length);
    expect(da.filter((id) => db.includes(id))).toEqual([]);
  });

  it('混战三人：每人发到的武将互不重复', () => {
    const state = createGame(
      [
        { seatId: A, name: '甲' },
        { seatId: B, name: '乙' },
        { seatId: C, name: '丙' },
      ],
      'TEST',
      { mode: 'melee', heroDealCount: 3 },
    );
    const seen = new Set<string>();
    for (const seat of [A, B, C]) {
      for (const id of state.draft!.deals[seat]!) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
  });

  it('国战反复建局：每人始终能凑出 ≥2 名同阵营武将', () => {
    for (let i = 0; i < 40; i++) {
      const state = createGame(seats2, 'TEST', { mode: 'guozhan' });
      for (const seat of [A, B]) {
        const counts = new Map<string, number>();
        for (const id of state.draft!.deals[seat]!) {
          const f = getHero(id)!.faction;
          counts.set(f, (counts.get(f) ?? 0) + 1);
        }
        expect(Math.max(...counts.values())).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

// ——————————————————————————————————————————
// 日志序号：客户端（音效）靠 id 识别新事件，不能靠长度——
// 快照只下发最近 50 条，引擎日志本身也在 200 条封顶，长度会停止增长。
// ——————————————————————————————————————————

describe('日志序号', () => {
  const seats: SeatSetup[] = [
    { seatId: A, name: '甲', heroId: 'vanilla' },
    { seatId: B, name: '乙', heroId: 'vanilla' },
  ];

  it('id 单调递增且连续', () => {
    const state = createGame(seats, 'TEST');
    for (let i = 0; i < 5; i++) pushLog(state, 'draw', `第 ${i} 条`);
    const ids = state.log.map((e) => e.id);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBe(ids[i - 1]! + 1);
    }
  });

  it('超过 200 条时丢弃最旧的，保留下来的 id 仍连续递增', () => {
    const state = createGame(seats, 'TEST');
    for (let i = 0; i < 240; i++) pushLog(state, 'draw', `x${i}`);
    expect(state.log.length).toBe(200);
    const ids = state.log.map((e) => e.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBe(ids[i - 1]! + 1);
    }
    // 最新一条的 id 反映真实累计条数（开局 1 条 + 240 条）
    expect(ids[ids.length - 1]).toBe(240);
  });

  it('快照只带最近 50 条，客户端能用 id 分辨出哪条是新的', () => {
    const state = createGame(seats, 'TEST');
    for (let i = 0; i < 80; i++) pushLog(state, 'draw', `x${i}`);
    const snap = toSnapshot(state, A);
    expect(snap.log.length).toBe(50);
    // 窗口里最后一条就是全局最后一条
    const cursor = snap.log[snap.log.length - 1]!.id;
    expect(cursor).toBe(state.log[state.log.length - 1]!.id);

    // 再产生一条事件，客户端靠 id > cursor 认出它
    pushLog(state, 'damage', '新事件');
    const snap2 = toSnapshot(state, A);
    expect(snap2.log.filter((e) => e.id > cursor).map((e) => e.kind)).toEqual(['damage']);
  });
});

// ——————————————————————————————————————————
// 日志的 seat / action：客户端靠它播卡牌音效与语音。
// 注意 action 是「实际动作」而不是牌面类型——关羽拿【万箭齐发】发动武圣
// 当【杀】用时，语音要念「杀」。
// ——————————————————————————————————————————

describe('日志动作标注', () => {
  const lastAction = (state: GameState) => {
    for (let i = state.log.length - 1; i >= 0; i--) {
      const e = state.log[i]!;
      if (e.action) return e;
    }
    return undefined;
  };
  const lastLog = (state: GameState) => state.log[state.log.length - 1]!;

  it('普通杀：action=sha，seat 是出杀方', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    const e = lastAction(state)!;
    expect(e.action).toBe('sha');
    expect(e.seat).toBe(A);
  });

  it('火杀 / 雷杀：action 带上属性', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [fireSha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(lastAction(state)!.action).toBe('sha-fire');
  });

  it('桃 / 酒 / 装备 各自的 action', () => {
    // 体力不满才能用桃
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [tao('t1'), jiu('j1'), wpn('w1')], hp: 2 },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 't1', targetIds: [] }));
    expect(lastLog(state).action).toBe('tao');
    ok(act(state, A, { type: 'playCard', cardId: 'j1', targetIds: [] }));
    expect(lastLog(state).action).toBe('jiu');
    ok(act(state, A, { type: 'playCard', cardId: 'w1', targetIds: [] }));
    const e = lastAction(state)!;
    expect(e.action).toBe('equip');
    expect(e.seat).toBe(A);
  });

  it('闪：响应杀时 action=shan，seat 是出闪方', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    const e = lastAction(state)!;
    expect(e.action).toBe('shan');
    expect(e.seat).toBe(B);
  });

  it('即时锦囊：action 就是牌型', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [nanman('n1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'n1', targetIds: [] }));
    expect(lastAction(state)!.action).toBe('nanman');
  });

  it('延时锦囊置于判定区：action 是牌型（乐不思蜀/兵粮寸断）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [lebu('l1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'l1', targetIds: [B] }));
    const e = lastAction(state)!;
    expect(e.action).toBe('lebu');
    expect(e.seat).toBe(A);
  });

  it('防具令杀无效：action=shield，seat 是持防具的那一方', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    state.players.find((p) => p.seatId === B)!.equipment.armor = armor('ba', 'renwang');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    const e = lastAction(state)!;
    expect(e.action).toBe('shield');
    expect(e.seat).toBe(B);
  });

  it('摸牌这类的日志不带 action，客户端靠 kind 出音效', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    pushLog(state, 'draw', '甲 摸了 2 张牌。');
    expect(lastLog(state).action).toBeUndefined();
    expect(lastLog(state).kind).toBe('draw');
  });
});

// ——————————————————————————————————————————
// 国战与军争的技能差异。
// 同名技能在两个模式下**不是同一份**，所以：①取将必须走 getHeroForMode；
// ②同一武将在两模式下行为确实不同。这里逐条钉住差异，防止以后又被合并。
// ——————————————————————————————————————————

describe('国战 / 军争 技能差异', () => {
  // 技能版本只按「是否国战」分叉：军争与混战共用身份局那一套（见 getHeroForMode）。
  // 军争模式要求 5-8 人，单人测试跑不起来，所以行为用例用混战代替；
  // 定义层面的差异用 getHeroForMode 直接对比 军争 vs 国战。
  /** 造一个指定模式、指定武将的对局，并把该玩家置于出牌阶段 */
  function gameAs(mode: GameMode, heroId: string, hand: Card[] = [], hp = 3): GameState {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId, hand, hp },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      ],
      mode,
    );
    // 国战要亮将后技能才生效
    const me = state.players.find((p) => p.seatId === A)!;
    me.heroRevealed = true;
    me.deputyRevealed = true;
    return state;
  }

  it('取将按模式返回不同定义：同一 id 在两个模式下不是同一份', () => {
    const jun = getHeroForMode('sunquan', 'junzheng')!;
    const guo = getHeroForMode('sunquan', 'guozhan')!;
    expect(jun.skills[0]!.desc).not.toBe(guo.skills[0]!.desc);
    expect(guo.skills[0]!.desc).toContain('体力上限');
    // 没有国战覆盖的武将，两个模式是同一份
    expect(getHeroForMode('guanyu', 'junzheng')).toBe(getHeroForMode('guanyu', 'guozhan'));
  });

  it('制衡：非国战不限张数，国战至多体力上限张', () => {
    // 手牌 5 张、体力上限 3 → 国战只能弃 3 张
    const hand = [sha('h1'), sha('h2'), sha('h3'), sha('h4'), sha('h5')];
    const jun = gameAs('melee', 'sunquan', hand.slice(), 3);
    const guo = gameAs('guozhan', 'sunquan', hand.slice(), 3);
    const ids = hand.map((c) => c.id);

    ok(act(jun, A, { type: 'useSkill', skillId: 'zhiheng', cardIds: ids, targetIds: [] }));
    const guoRes = act(guo, A, { type: 'useSkill', skillId: 'zhiheng', cardIds: ids, targetIds: [] });
    expect(guoRes.ok).toBe(false);
    expect(guoRes.ok ? '' : guoRes.error).toContain('体力上限');

    // 国战弃 3 张是合法的
    ok(act(guo, A, { type: 'useSkill', skillId: 'zhiheng', cardIds: ids.slice(0, 3), targetIds: [] }));
    expect(guo.log.some((e) => e.message.includes('弃 3 张牌'))).toBe(true);
  });

  it('苦肉：非国战不需弃牌摸2张，国战要弃1张且摸3张', () => {
    const jun = gameAs('melee', 'huanggai', [sha('k1')], 3);
    const guo = gameAs('guozhan', 'huanggai', [sha('k1'), sha('k2')], 3);

    // 非国战：不选牌也能发动
    ok(act(jun, A, { type: 'useSkill', skillId: 'kurou', cardIds: [], targetIds: [] }));
    expect(jun.players.find((p) => p.seatId === A)!.hp).toBe(2);
    expect(jun.log.some((e) => e.message.includes('摸了 2 张牌'))).toBe(true);

    // 国战：必须先弃一张（国战版苦肉要弃牌）
    const guoRes = act(guo, A, { type: 'useSkill', skillId: 'kurou', cardIds: [], targetIds: [] });
    expect(guoRes.ok).toBe(false);
    ok(act(guo, A, { type: 'useSkill', skillId: 'kurou', cardIds: ['k1'], targetIds: [] }));
    expect(guo.players.find((p) => p.seatId === A)!.hp).toBe(2);
    expect(guo.log.some((e) => e.message.includes('摸了 3 张牌'))).toBe(true);
    // 额外一张杀：已出杀数被退到 0
    expect(guo.players.find((p) => p.seatId === A)!.flags.shaCountThisTurn).toBe(0);
  });

  it('咆哮：国战在第二张杀后摸一张牌，非国战不摸', () => {
    const mk3 = () => [sha('z1'), sha('z2'), sha('z3')];
    const jun = gameAs('melee', 'zhangfei', mk3(), 4);
    const guo = gameAs('guozhan', 'zhangfei', mk3(), 4);
    for (const st of [jun, guo]) {
      const me = st.players.find((p) => p.seatId === A)!;
      me.hand = mk3();
    }
    // 第一张杀
    for (const st of [jun, guo]) {
      ok(act(st, A, { type: 'playCard', cardId: 'z1', targetIds: [B] }));
      ok(act(st, B, { type: 'pass' }));
    }
    // 第二张杀：只有国战版会摸牌
    for (const st of [jun, guo]) {
      ok(act(st, A, { type: 'playCard', cardId: 'z2', targetIds: [B] }));
      ok(act(st, B, { type: 'pass' }));
    }
    expect(jun.log.some((e) => e.message.includes('发动【咆哮】'))).toBe(false);
    expect(guo.log.some((e) => e.message.includes('发动【咆哮】'))).toBe(true);
  });

  it('烈弓：国战判定条件不同（看体力值与攻击范围）', () => {
    // 目标手牌 2 张；黄忠体力 4、无武器（攻击范围 1）
    // 国战条件：手牌数 ≥ 你的体力值(4)？ 2 ≥ 4 否；手牌数 ≤ 攻击范围(1)？ 2 ≤ 1 否 → 不发动
    // 军争条件：目标手牌数 ≥ 你的手牌数 或 目标体力 ≤ 你的体力 → 看下面的取值
    const make = (mode: GameMode) => {
      const st = makeGameMode(
        [
          { seatId: A, name: '甲', heroId: 'huangzhong', hand: [sha('s1')], hp: 4 },
          { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('d1'), shan('d2')] },
        ],
        mode,
      );
      const me = st.players.find((p) => p.seatId === A)!;
      me.heroRevealed = true;
      me.deputyRevealed = true;
      return st;
    };
    const jun = make('melee');
    const guo = make('guozhan');
    // 军争：目标手牌2 ≥ 黄忠手牌1 → 发动
    ok(act(jun, A, { type: 'playCard', cardId: 's1', targetIds: [B] }));
    expect(jun.log.some((e) => e.message.includes('发动【烈弓】'))).toBe(true);
    // 国战：2 既不 ≥ 体力4 也不 ≤ 攻击范围1 → 不发动
    ok(act(guo, A, { type: 'playCard', cardId: 's1', targetIds: [B] }));
    expect(guo.log.some((e) => e.message.includes('发动【烈弓】'))).toBe(false);
  });
});

// ——————————————————————————————————————————
// 距离 / 摸牌数 / 手牌上限 三类被动修改器。
// 都是最新国战需要的机制：马术改距离、英姿加摸牌并把手牌上限抬到体力上限。
// ——————————————————————————————————————————

describe('被动修改器（距离 / 摸牌 / 手牌上限）', () => {
  it('马术：马超计算与其他角色的距离 -1', () => {
    const others: SeatOpts[] = [
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: 's2', name: '丙', heroId: 'vanilla', hand: [] },
      { seatId: 's3', name: '丁', heroId: 'vanilla', hand: [] },
    ];
    const noMashu = makeGame([{ seatId: A, name: '甲', heroId: 'vanilla', hand: [] }, ...others]);
    const withMashu = makeGame([{ seatId: A, name: '甲', heroId: 'machao', hand: [] }, ...others]);
    // 4 人桌：s0 到 s2 的基础距离是 2
    expect(baseDistance(noMashu, A, 's2')).toBe(2);
    expect(distance(noMashu, A, 's2')).toBe(2);
    // 马术 -1 → 距离 1，于是无武器也能打到原本 2 距离的对手
    expect(distance(withMashu, A, 's2')).toBe(1);
    expect(canTarget(withMashu, A, 's2')).toBe(true);
    expect(canTarget(noMashu, A, 's2')).toBe(false);
  });

  it('马术：国战暗将时不生效，亮将后才生效', () => {
    // 4 人桌：s0 到 s2 的基础距离是 2（3 人桌只有 1，测不出 -1）
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'machao', hand: [] },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
        { seatId: 's2', name: '丙', heroId: 'vanilla', hand: [] },
        { seatId: 's3', name: '丁', heroId: 'vanilla', hand: [] },
      ],
      'guozhan',
    );
    const me = state.players.find((p) => p.seatId === A)!;
    expect(me.heroRevealed).toBe(false);
    expect(distance(state, A, 's2')).toBe(2);
    me.heroRevealed = true;
    expect(distance(state, A, 's2')).toBe(1);
  });

  it('英姿：摸牌阶段摸 3 张而不是 2 张', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhouyu', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    // 甲结束回合 → 乙的回合开始（判定→摸牌），摸牌数由英姿 +1
    ok(act(state, A, { type: 'endPhase' }));
    expect(b.hand).toHaveLength(3);
    expect(state.log.some((e) => e.message.includes('摸了 3 张牌'))).toBe(true);
  });

  it('英姿（国战）：手牌上限 = 体力上限，低体力也不用弃满', () => {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'zhouyu', hand: [], hp: 1 },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      ],
      'guozhan',
    );
    const me = state.players.find((p) => p.seatId === A)!;
    me.heroRevealed = true;
    me.hand = [sha('d1'), sha('d2')];
    expect(me.hp).toBe(1);
    expect(me.maxHp).toBe(3);
    // 默认上限是当前体力 1 → 2 张手牌要弃 1；英姿把上限抬到 3 → 不用弃
    ok(act(state, A, { type: 'endPhase' }));
    expect(state.pending?.kind).not.toBe('discard');
  });

  it('没有英姿时手牌上限仍是当前体力', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [], hp: 1 },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const me = state.players.find((p) => p.seatId === A)!;
    me.hand = [sha('d1'), sha('d2')];
    ok(act(state, A, { type: 'endPhase' }));
    expect(state.pending?.kind).toBe('discard');
  });
});

// ——————————————————————————————————————————
// 第二批：洛神 / 闭月 / 反馈 / 青囊 + 国战版反间（通用「选择一项」）
// ——————————————————————————————————————————

describe('新增技能（含国战版差异）', () => {
  it('洛神：判到黑色就收下、判到红为止（非国战逐张获得）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhenji', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    // 牌堆从末尾抽：先 黑桃2、再 梅花3、再 红桃1 → 收下前两张后停
    state.deck.push(mk('r1', 'sha', 'heart', 1));
    state.deck.push(mk('b2', 'sha', 'spade', 2));
    state.deck.push(mk('b1', 'sha', 'club', 3));
    ok(act(state, A, { type: 'endPhase' })); // 乙的回合开始 → 准备阶段洛神
    const ids = b.hand.map((c) => c.id);
    expect(ids).toContain('b1');
    expect(ids).toContain('b2');
    expect(ids).not.toContain('r1'); // 红牌不进手
    expect(state.discard.some((c) => c.id === 'r1')).toBe(true);
  });

  it('洛神（国战）：判到红为止，然后一次性获得所有黑色判定牌', () => {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
        { seatId: B, name: '乙', heroId: 'zhenji', hand: [] },
      ],
      'guozhan',
    );
    const b = state.players.find((p) => p.seatId === B)!;
    b.heroRevealed = true;
    state.deck.push(mk('r1', 'sha', 'heart', 1));
    state.deck.push(mk('b2', 'sha', 'spade', 2));
    state.deck.push(mk('b1', 'sha', 'club', 3));
    ok(act(state, A, { type: 'endPhase' }));
    const ids = b.hand.map((c) => c.id);
    expect(ids).toContain('b1');
    expect(ids).toContain('b2');
    // 与身份局的关键差别：日志写明“一次性获得”，而不是逐张获得
    expect(state.log.some((e) => e.message.includes('一次性获得'))).toBe(true);
  });

  it('闭月：结束阶段摸一张牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'diaochan', hand: [], hp: 3, },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.hp = 3;
    const before = a.hand.length;
    ok(act(state, A, { type: 'endPhase' })); // 结束出牌 → 弃牌 → 回合结束（闭月摸 1）
    expect(a.hand.length).toBeGreaterThan(before);
    expect(state.log.some((e) => e.message.includes('发动【闭月】'))).toBe(true);
  });

  it('反馈：受到伤害后获得来源一张牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'simayi', hand: [tao('t1'), shan('s1')] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    const aHandBefore = a.hand.length;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 不出闪，受到 1 点伤害
    expect(state.log.some((e) => e.message.includes('发动【反馈】'))).toBe(true);
    // 甲少了一张牌、乙多了一张
    expect(a.hand.length).toBe(aHandBefore - 1);
    expect(b.hand.length).toBeGreaterThan(1);
  });

  it('青囊：弃一张手牌令已受伤角色回复 1 点', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'huatuo', hand: [tao('h1')], hp: 3 },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [], hp: 2 },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.hp = 1; // 甲自己受伤（青囊可对自己用）
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'useSkill', skillId: 'qingnang', cardIds: ['h1'], targetIds: [A] }));
    expect(a.hp).toBe(2);
    expect(state.log.some((e) => e.message.includes('发动【青囊】'))).toBe(true);
  });

  it('青囊：对体力已满的角色使用应被拒', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'huatuo', hand: [tao('h1')], hp: 3 },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const res = act(state, A, { type: 'useSkill', skillId: 'qingnang', cardIds: ['h1'], targetIds: [B] });
    expect(res.ok).toBe(false);
  });

  it('国战版反间：目标「选择一项」，选失去 1 点体力', () => {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'zhouyu', hand: [tao('f1')], hp: 3 },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('d1')] },
      ],
      'guozhan',
    );
    const b = state.players.find((p) => p.seatId === B)!;
    // 未亮将时主动技不可用，先亮将
    const a = state.players.find((p) => p.seatId === A)!;
    a.heroRevealed = true;
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'useSkill', skillId: 'fanjian', cardIds: ['f1'], targetIds: [B] }));
    // 目标收到「选择一项」提示
    expect(state.pending?.kind).toBe('choice');
    const snapB = toSnapshot(state, B);
    expect(snapB.prompt?.kind).toBe('choice');
    expect(snapB.prompt?.choiceOptions).toHaveLength(2);
    // 乙选「失去 1 点体力」
    const hpBefore = b.hp;
    ok(act(state, B, { type: 'chooseOption', optionId: 'loseHp' }));
    expect(b.hp).toBe(hpBefore - 1);
    expect(state.pending?.kind).not.toBe('choice');
  });

  it('国战版反间：选「弃同花色牌」会弃掉手牌里同花色的牌', () => {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'zhouyu', hand: [mk('f1', 'tao', 'heart', 5)], hp: 3 },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [mk('d1', 'shan', 'heart', 1), mk('d2', 'sha', 'spade', 2)] },
      ],
      'guozhan',
    );
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    a.heroRevealed = true;
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'useSkill', skillId: 'fanjian', cardIds: ['f1'], targetIds: [B] }));
    // 乙手上原有 2 张，反间又给了 1 张（红桃）→ 共 3 张；弃掉所有红桃
    expect(b.hand.length).toBe(3);
    ok(act(state, B, { type: 'chooseOption', optionId: 'discard' }));
    expect(b.hand.every((c) => c.suit !== 'heart')).toBe(true);
    expect(state.log.some((e) => e.message.includes('花色相同'))).toBe(true);
  });
});

// ——————————————————————————————————————————
// 端到端：国战版反间走完「出牌 → 目标收到选择项 → 选择 → 结算」。
// 用 toSnapshot 模拟服务端下发的报文、用 applyIntent 模拟客户端回传，
// 也就是把 React 之外的一整条链路串起来——客户端只负责把
// prompt.choiceOptions 渲染成按钮、把 id 回传成 chooseOption。
// ——————————————————————————————————————————

describe('端到端：国战版反间', () => {
  function setupGuozhanFanjian() {
    const state = makeGameMode(
      [
        { seatId: A, name: '周瑜', heroId: 'zhouyu', hand: [mk('f1', 'tao', 'heart', 7), mk('f2', 'sha', 'spade', 3)], hp: 3 },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [mk('d1', 'shan', 'heart', 2), mk('d2', 'sha', 'club', 4)], hp: 4 },
      ],
      'guozhan',
    );
    const a = state.players.find((p) => p.seatId === A)!;
    a.heroRevealed = true;
    state.pending = { kind: 'play', seatId: A };
    return state;
  }

  it('目标拿到的快照里带两个可点选项，且标题能看出是谁用什么牌发的', () => {
    const state = setupGuozhanFanjian();
    ok(act(state, A, { type: 'useSkill', skillId: 'fanjian', cardIds: ['f1'], targetIds: [B] }));
    const snap = toSnapshot(state, B);
    expect(snap.prompt?.kind).toBe('choice');
    // 标题写清来源与牌，否则目标不知道自己为什么被问
    expect(snap.prompt?.message).toContain('周瑜');
    expect(snap.prompt?.message).toContain('红桃7'); // 展示的那张牌
    const ids = snap.prompt?.choiceOptions?.map((o) => o.id);
    expect(ids).toEqual(['discard', 'loseHp']);
    // 两个选项的文案要是人话
    const labels = snap.prompt?.choiceOptions?.map((o) => o.label) ?? [];
    expect(labels[0]).toContain('弃置');
    expect(labels[1]).toContain('失去 1 点体力');
    // 出牌方此时没有任何提示（在等对方选择，界面显示“等待其他玩家行动…”）
    expect(toSnapshot(state, A).prompt).toBeNull();
  });

  it('选「失去 1 点体力」：只掉血，手牌不动', () => {
    const state = setupGuozhanFanjian();
    ok(act(state, A, { type: 'useSkill', skillId: 'fanjian', cardIds: ['f1'], targetIds: [B] }));
    const b = state.players.find((p) => p.seatId === B)!;
    const handBefore = b.hand.length; // 2 张 + 反间给过来的 1 张 = 3
    expect(handBefore).toBe(3);
    expect(b.hp).toBe(4);
    ok(act(state, B, { type: 'chooseOption', optionId: 'loseHp' }));
    expect(b.hp).toBe(3);
    expect(b.hand.length).toBe(handBefore); // 牌留着
    expect(state.pending).toEqual({ kind: 'play', seatId: A }); // 回到出牌方的出牌阶段
  });

  it('选「弃同花色」：只弃同花色，别的牌和体力都不动', () => {
    const state = setupGuozhanFanjian();
    ok(act(state, A, { type: 'useSkill', skillId: 'fanjian', cardIds: ['f1'], targetIds: [B] }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hand.length).toBe(3); // 红桃2(闪) + 梅花4(杀) + 反间给的红桃7
    ok(act(state, B, { type: 'chooseOption', optionId: 'discard' }));
    // 反间给的是红桃 → 弃掉所有红桃（红桃2 和 红桃7），只剩梅花4
    expect(b.hand.map((c) => c.id)).toEqual(['d2']);
    expect(b.hp).toBe(4); // 体力不动
    expect(state.discard.some((c) => c.id === 'd1')).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('选项无效 / 不是被问的人 都应被拒', () => {
    const state = setupGuozhanFanjian();
    ok(act(state, A, { type: 'useSkill', skillId: 'fanjian', cardIds: ['f1'], targetIds: [B] }));
    // 出牌方自己回传选择 → 拒绝
    expect(act(state, A, { type: 'chooseOption', optionId: 'loseHp' }).ok).toBe(false);
    // 目标回传不存在的选项 → 拒绝
    expect(act(state, B, { type: 'chooseOption', optionId: 'nope' }).ok).toBe(false);
    // 拒绝之后仍然停在等待选择的状态，不会卡死
    expect(state.pending?.kind).toBe('choice');
  });
});

// ——————————————————————————————————————————
// 测试功能：选将不限（freePick）
// 勾上后选将阶段每个人都能从全部武将里挑，用来定向验证某个技能，
// 不用反复重开房间等随机发到。国战「两名同阵营」的约束照旧。
// ——————————————————————————————————————————

describe('选将不限（测试用 freePick）', () => {
  const seats2: SeatSetup[] = [
    { seatId: A, name: '甲' },
    { seatId: B, name: '乙' },
  ];

  it('开启后每个人的可选项都是整个武将池（混战含中立）', () => {
    const state = createGame(seats2, 'TEST', { mode: 'melee', freePick: true });
    const all = state.draft!.deals[A]!;
    expect(all.length).toBe(HEROES.length);
    expect(all).toContain('zhouyu'); // 平时随机发将未必发得到
    expect(all).toEqual(state.draft!.deals[B]!); // 两人都能看到全集
  });

  it('开启后能直接选中平时发不到的武将', () => {
    const state = createGame(seats2, 'TEST', { mode: 'melee', freePick: true });
    ok(act(state, A, { type: 'pickHero', heroId: 'zhouyu' }));
    ok(act(state, B, { type: 'pickHero', heroId: 'diaochan' }));
    expect(state.draft).toBeNull(); // 两人都选完 → 开局
    expect(state.players.find((p) => p.seatId === A)!.heroId).toBe('zhouyu');
  });

  it('国战开启后仍排除中立武将，且「两名同阵营」的约束照旧', () => {
    const state = createGame(seats2, 'TEST', { mode: 'guozhan', freePick: true });
    const deal = state.draft!.deals[A]!;
    expect(deal).not.toContain('vanilla'); // 中立不在国战池里
    // 主将周瑜（吴）配不同阵营的貂蝉（群）→ 应被拒
    fail(act(state, A, { type: 'pickHero', heroId: 'zhouyu', deputyHeroId: 'diaochan' }));
    // 同阵营（周瑜 + 甘宁，都是吴）→ 通过
    ok(act(state, A, { type: 'pickHero', heroId: 'zhouyu', deputyHeroId: 'ganning' }));
  });

  it('不开启时仍是随机不重叠发将（不受影响）', () => {
    const state = createGame(seats2, 'TEST', { mode: 'guozhan' });
    expect(state.draft!.deals[A]!.length).toBe(7);
    expect(state.draft!.deals[A]!.filter((id) => state.draft!.deals[B]!.includes(id))).toEqual([]);
  });
});
