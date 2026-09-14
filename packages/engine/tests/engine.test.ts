import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, getHero, toSnapshot, type GameState, type SeatSetup } from '../src';
import type { Card, CardType, Faction, GameMode, Suit } from '@sgs/protocol';

// —— 测试辅助 ——
function mk(id: string, type: CardType, suit: Suit = 'spade', rank = 1): Card {
  return { id, type, suit, rank };
}
const sha = (id: string, suit: Suit = 'spade') => mk(id, 'sha', suit);
const shan = (id: string, suit: Suit = 'heart') => mk(id, 'shan', suit);
const tao = (id: string, suit: Suit = 'heart') => mk(id, 'tao', suit);
const jiu = (id: string, suit: Suit = 'spade') => mk(id, 'jiu', suit);

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
    p.flags = { shaCountThisTurn: 0, jiuActive: false };
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
    p.flags = { shaCountThisTurn: 0, jiuActive: false };
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
    expect(pa.hand).toHaveLength(4 + 2);
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
      p.flags = { shaCountThisTurn: 0, jiuActive: false };
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

  it('体力计算：maxHp = ceil((主将 + 副将) / 2)', () => {
    const setup: SeatSetup[] = [
      { seatId: A, name: '甲' },
      { seatId: B, name: '乙' },
    ];
    const state = createGame(setup, 'TEST', { mode: 'guozhan' });
    const pairA = findSameFactionPair(state.draft!.deals[A]!)!;
    const mainHero = getHero(pairA.main)!;
    const deputyHero = getHero(pairA.deputy)!;
    const expectedHp = Math.ceil((mainHero.maxHp + deputyHero.maxHp) / 2);
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
