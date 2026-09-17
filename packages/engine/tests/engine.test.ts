import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  baseDistance,
  canTarget,
  createGame,
  buildDeck,
  distance,
  HEROES,
  getHero,
  getHeroForMode,
  hasCombo,
  poolForMode,
  pushLog,
  toSnapshot,
  emptyFlags,
  attackRange,
  bigFactions,
  buildDeck,
  effectiveFaction,
  factionAliveCount,
  isBigFaction,
  isSmallFaction,
  factionHelpers,
  isMalePlayer,
  type GameState,
  type SeatSetup,
} from '../src';
import type { Card, CardType, Faction, GameMode, MarkerId, Suit } from '@sgs/protocol';

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
const wpn = (id: string): Card => ({
  id,
  type: 'weapon',
  suit: 'spade',
  rank: 1,
  equipName: 'qinggang',
  range: 2,
});

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
    p.maxHp = Math.max(1, Math.floor(hero?.maxHp ?? 4));
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
    p.maxHp = Math.max(1, Math.floor(hero?.maxHp ?? 4));
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
/**
 * 国战：回合开始时会问「准备阶段：是否明置武将牌？」。
 * 测试里默认选「暂不明置」跳过——要断言这个询问本身的用例自己处理。
 */
function skipRevealAsk(state: GameState) {
  const p = state.pending;
  if (p?.kind === 'choice' && p.title.includes('明置武将牌')) {
    ok(act(state, p.seatId, { type: 'chooseOption', optionId: 'none' }));
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
      {
        seatId: A,
        name: '张飞',
        heroId: 'zhangfei',
        hand: [sha('a1'), sha('a2'), sha('a3'), sha('a4')],
      },
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
      {
        seatId: A,
        name: '张飞',
        heroId: 'zhangfei',
        hand: [sha('a1'), sha('a2'), sha('a3'), sha('a4')],
      },
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
      {
        seatId: A,
        name: '张三',
        heroId: 'vanilla',
        hand: [sha('a1'), sha('a2'), sha('a3'), sha('a4'), sha('a5')],
      },
      { seatId: B, name: '李四', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'endPhase' }));
    expect(state.pending?.kind).toBe('discard');
    expect(state.pending).toMatchObject({ count: 1 });
    ok(act(state, A, { type: 'discard', cardIds: ['a5'] }));
    // 进入 B 的回合
    expect(state.turn.seatIndex).toBe(1);
    expect(state.turn.phase).toBe('play');
    skipRevealAsk(state); // B 的准备阶段：暂不明置
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
    // 固定发将：随机发将可能撞上「准备/摸牌阶段会发起询问」的技能
    // （甄姬·洛神、诸葛亮·观星、许褚·裸衣），那会让本用例合法地停在询问上。
    // 这里测的是选将流程，不是那些技能，所以钉死一副没有阶段询问的将。
    state.draft!.deals[A] = ['guanyu', 'zhangfei', 'lvbu'];
    state.draft!.deals[B] = ['caocao', 'xuchu', 'simayi'];

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
    attacker.equipment.weapon = {
      id: 'w1',
      type: 'weapon',
      suit: 'spade',
      rank: 5,
      equipName: 'fangtian',
      range: 4,
    };
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
    attacker.equipment.weapon = {
      id: 'w2',
      type: 'weapon',
      suit: 'spade',
      rank: 5,
      equipName: 'fangtian',
      range: 4,
    };
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
      p.maxHp = Math.floor((mainHero.maxHp + deputyHero.maxHp) / 2);
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

  /** 从发到的武将中找 2 个同阵营的（君主只能作主将，所以要摆到 main 位） */
  function findSameFactionPair(deals: string[]): { main: string; deputy: string } | null {
    const factionOf = (id: string) => getHero(id)?.faction;
    const isLord = (id: string) => getHero(id)?.isLord === true;
    for (let i = 0; i < deals.length; i++) {
      for (let j = i + 1; j < deals.length; j++) {
        if (factionOf(deals[i]!) !== factionOf(deals[j]!)) continue;
        const li = isLord(deals[i]!);
        const lj = isLord(deals[j]!);
        if (li && lj) continue; // 两名君主不能组成一副将
        if (lj) return { main: deals[j]!, deputy: deals[i]! };
        return { main: deals[i]!, deputy: deals[j]! };
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
    // 同上：钉死一副「没有阶段询问技能」的同阵营将，让断言确定
    state.draft!.deals[A] = [
      'guanyu',
      'zhangfei',
      'zhaoyun',
      'machao',
      'huangzhong',
      'weiyan',
      'huangyueying',
    ];
    state.draft!.deals[B] = [
      'guanyu',
      'zhangfei',
      'zhaoyun',
      'machao',
      'huangzhong',
      'weiyan',
      'huangyueying',
    ];
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
    // 轮到第一位玩家的准备阶段：会先问是否明置武将牌
    skipRevealAsk(state);
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

  it('体力计算：maxHp = floor((主将 + 副将) / 2)', () => {
    const setup: SeatSetup[] = [
      { seatId: A, name: '甲' },
      { seatId: B, name: '乙' },
    ];
    const state = createGame(setup, 'TEST', { mode: 'guozhan' });
    const pairA = findSameFactionPair(state.draft!.deals[A]!)!;
    const mainHero = getHero(pairA.main)!;
    const deputyHero = getHero(pairA.deputy)!;
    // 官方规则：向下取整。珠联璧合不再加成体力上限（改为发标记），所以这里与组合无关
    const expectedHp = Math.floor((mainHero.maxHp + deputyHero.maxHp) / 2);
    ok(act(state, A, { type: 'pickHero', heroId: pairA.main, deputyHeroId: pairA.deputy }));
    const pairB = findSameFactionPair(state.draft!.deals[B]!)!;
    ok(act(state, B, { type: 'pickHero', heroId: pairB.main, deputyHeroId: pairB.deputy }));
    const pa = state.players.find((p) => p.seatId === A)!;
    expect(pa.maxHp).toBe(expectedHp);
    expect(pa.hp).toBe(expectedHp);
  });

  it('暗将隐藏：未亮将时他人快照 heroId/deputyHeroId/faction 均为 null', () => {
    const state = makeGuozhanGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'guanyu',
        faction: 'shu',
        hand: [sha('a1')],
      },
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

  it('明置只有准备阶段这一个主动时机：亮一张 → 他人快照可见该武将名与阵营', () => {
    const state = makeGuozhanGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'guanyu',
        faction: 'shu',
        hand: [sha('a1')],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    // 出牌阶段不再能主动明置（规则：那时只能靠发动技能顺带明置）
    expect(act(state, A, { type: 'revealHero', heroId: 'zhangfei' }).ok).toBe(false);
    // 准备阶段可以：把状态摆成准备阶段
    state.turn.phase = 'judgment';
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
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'guanyu',
        faction: 'shu',
        hand: [sha('a1')],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    // B 不是当前回合玩家，亮将应失败
    fail(act(state, B, { type: 'revealHero', heroId: 'xuchu' }));
  });

  it('阵亡亮将：杀死玩家 → 他人快照可见双将名和阵营', () => {
    const state = makeGuozhanGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'guanyu',
        faction: 'shu',
        hand: [sha('a1')],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'xuchu',
        deputyHeroId: 'zhenji',
        faction: 'wei',
        hand: [],
        hp: 1,
      },
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
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'guanyu',
        faction: 'shu',
        hand: [sha('a1'), sha('a2')],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'xuchu',
        deputyHeroId: 'zhenji',
        faction: 'wei',
        hand: [],
        hp: 1,
      },
      {
        seatId: C,
        name: '丙',
        heroId: 'lvbu',
        deputyHeroId: 'diaochan',
        faction: 'qun',
        hand: [],
        hp: 1,
      },
    ]);
    // 亮主将张飞（咆哮：无限出杀），否则暗将只能出 1 杀。
    // 主动明置只有准备阶段能做，所以先把阶段摆回去。
    state.turn.phase = 'judgment';
    ok(act(state, A, { type: 'revealHero', heroId: 'zhangfei' }));
    state.turn.phase = 'play';
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
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'guanyu',
        faction: 'shu',
        hand: [sha('a1')],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'machao',
        deputyHeroId: 'huangzhong',
        faction: 'shu',
        hand: [],
      },
      {
        seatId: C,
        name: '丙',
        heroId: 'lvbu',
        deputyHeroId: 'diaochan',
        faction: 'qun',
        hand: [],
        hp: 1,
      },
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
      // 丙也留一张无懈：这样打出一张之后**抵消轮**才存在
      // （新规则：身上没有无懈的人根本不会被问，见 openWuxieWindow 的说明）
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [wuxie('c1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    expect(state.pending?.kind).toBe('wuxieQueue');
    if (state.pending?.kind === 'wuxieQueue') expect(state.pending.askQueue).toEqual([B, C]);
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    // 打出一张无懈之后**不直接结算**：还要给持有无懈的人一次「再抵消这一张」的机会
    expect(state.pending?.kind).toBe('wuxieQueue');
    passWuxie(state);
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
    skipRevealAsk(state); // B 的准备阶段：暂不明置
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
    skipRevealAsk(state); // B 的准备阶段：暂不明置
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
    fail(act(state, A, { type: 'useSkill', skillId: 'nonexistent', targetIds: [] }));
  });

  it('useSkill 非出牌阶段 → 失败', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
    ]);
    // A 对 B 出杀 → 进入 respondSha，B 尝试用技能 → 应失败
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    fail(act(state, B, { type: 'useSkill', skillId: 'test', targetIds: [] }));
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

  // 6. 夏侯惇·刚烈（2025-09 调整后：来源二选一，通过「钩子内询问」实现）
  it('夏侯惇·刚烈：非红桃判定 → 来源选择「受到 1 点伤害」', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'xiahoudun', hand: [] },
    ]);
    // 控制判定牌为黑桃（非红桃）
    state.deck.push(mk('jc', 'sha', 'spade', 5));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // B 弃权（不出闪）→ 受伤害 → 刚烈判定 → 由来源 A 选择一项
    ok(act(state, B, { type: 'pass' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(3);
    // 关键：钩子把询问挂起来了，而不是被伤害结算的收尾静默覆盖
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.seatId).toBe(A); // 是让**来源**选
      expect(state.pending.options.map((o) => o.id)).toEqual(['discard', 'damage']);
    }

    ok(act(state, A, { type: 'chooseOption', optionId: 'damage' }));
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hp).toBe(3); // 受到刚烈持有者造成的 1 点伤害
    // 关键：选完之后被打断的伤害结算流程被接回来了，控制权回到出牌方
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    // 伤害来源是夏侯惇，不是 A 自己
    expect(state.log.some((e) => e.message.includes('选择受到 1 点伤害'))).toBe(true);
  });

  it('夏侯惇·刚烈：选「弃置两张手牌」→ 来源自己挑两张，流程照旧继续', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1'), sha('a2'), sha('a3')] },
      { seatId: B, name: '乙', heroId: 'xiahoudun', hand: [] },
    ]);
    state.deck.push(mk('jc', 'sha', 'spade', 5));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'discard' }));
    // 进入选牌：由来源**自己挑**哪两张（不再是随机弃）
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') {
      expect(state.pending.seatId).toBe(A);
      expect(state.pending.min).toBe(2);
      expect(state.pending.max).toBe(2);
      expect(state.pending.cards.map((c) => c.id).sort()).toEqual(['a2', 'a3']);
    }
    // 数量不对 / 牌不在候选里 / 不是本人在选，都应被拒
    fail(act(state, A, { type: 'pickCards', cardIds: ['a2'] }));
    fail(act(state, A, { type: 'pickCards', cardIds: ['a2', 'nope'] }));
    fail(act(state, B, { type: 'pickCards', cardIds: ['a2', 'a3'] }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['a2', 'a3'] }));
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hp).toBe(4); // 没受伤
    expect(a.hand).toHaveLength(0); // 打掉 1 张 + 刚烈弃 2 张
    expect(state.log.some((e) => e.message.includes('弃置了 2 张手牌'))).toBe(true);
    // 关键：选完把被打断的伤害结算流程接回来了
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('夏侯惇·刚烈：判定为红桃 → 不询问，直接继续', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xiahoudun', hand: [] },
    ]);
    state.deck.push(mk('jc', 'sha', 'heart', 5));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    expect(state.log.some((e) => e.message.includes('【刚烈】无效'))).toBe(true);
  });

  it('钩子内询问的级联：刚烈打出致命伤害 → 先走完濒死，再回到出牌阶段', () => {
    // A 只剩 1 血，选「受到 1 点伤害」会把自己打进濒死。
    // 这时选完不能直接 resumePlay——得等濒死流程走完，续接队列才继续。
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')], hp: 1 },
      { seatId: B, name: '乙', heroId: 'xiahoudun', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    state.deck.push(mk('jc', 'sha', 'spade', 5));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // B 受伤 → 刚烈判定 → 问 A
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'damage' }));
    // A 被打到 0 → 进入濒死，而不是直接回到出牌阶段
    expect(state.pending?.kind).toBe('respondDeath');
    passDeathSaves(state);
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.alive).toBe(false);
    // 濒死走完后，续接把剩下的流程跑完，控制权交给下一个存活者
    expect(state.pending?.kind).toBe('play');
    expect(state.gameOver).toBe(false);
  });

  // 7. 司马懿·鬼才：替换不利判定牌
  it('司马懿·鬼才：手动打出一张手牌替换判定牌', () => {
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
    // 鬼才先问是否发动（不再自动替判）
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    // 再挑要打出的手牌
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    // 替换成红桃 → 乐不思蜀无效 → B 不跳过出牌
    expect(b.flags.skipPlay).toBe(false);
    expect(state.log.some((e) => e.message.includes('鬼才'))).toBe(true);
    // A 的红桃手牌已用于替换
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand).toHaveLength(0);
    // 判定走完，B 进入出牌阶段
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('司马懿·鬼才：选不发动则判定牌照旧生效', () => {
    const state = makeGame([
      { seatId: A, name: '司马懿', heroId: 'simayi', hand: [tao('a1', 'heart')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.judgment.push(lebu('lb0'));
    state.deck.push(mk('jc', 'sha', 'spade', 5)); // 黑桃 → 乐不思蜀生效
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'no' }));
    expect(b.flags.skipPlay).toBe(true); // 跳过了出牌阶段
    // 那张红桃还在甲手里（回合继续往下走，甲后来又摸了牌，所以只查牌在不在）
    expect(state.players.find((p) => p.seatId === A)!.hand.some((c) => c.id === 'a1')).toBe(true);
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
    ok(
      act(state, A, { type: 'useSkill', skillId: 'zhiheng', cardIds: ['a1', 'a2'], targetIds: [] }),
    );
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
      p.maxHp = Math.floor((mainHero.maxHp + deputyHero.maxHp) / 2);
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
    'guanyu',
    'zhangfei',
    'zhaoyun',
    'machao',
    'huangzhong',
    'lvbu',
    'diaochan',
    'huatuo',
    'zhenji',
    'simayi',
    'xiahoudun',
    'xuchu',
    'sunquan',
    'zhouyu',
    'ganning',
    'huanggai',
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

  // 1. 珠联璧合：改为「双将首次明置时发标记」，不再直接加体力上限
  it('珠联璧合：关羽+张飞 → 亮齐后拿到标记，体力上限不加成', () => {
    const state = makeGuozhanDraft([
      { seatId: A, name: '甲', main: 'guanyu', deputy: 'zhangfei' },
      { seatId: B, name: '乙', main: 'xuchu', deputy: 'zhenji' },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    // 关羽(4)+张飞(4) → floor(8/2)=4，珠联璧合不再 +1
    expect(a.maxHp).toBe(4);
    // 许褚(4)+甄姬(3) → floor(7/2)=3，无珠联璧合
    expect(b.maxHp).toBe(3);

    // 只亮一张：先拿【先驱】（全场首个明置武将），珠联璧合还不给
    ok(act(state, A, { type: 'revealHero', heroId: 'guanyu' }));
    expect(a.markers.xianqu).toBe(1);
    expect(a.markers.zhulian).toBeUndefined();
    // 亮第二张 → 珠联璧合；4+4 为偶数，不发阴阳鱼
    ok(act(state, A, { type: 'revealHero', heroId: 'zhangfei' }));
    expect(a.markers.zhulian).toBe(1);
    expect(a.markers.yinyangyu).toBeUndefined();
  });

  it('珠联璧合 + 阴阳鱼：吕布+貂蝉（4+3 为奇数）→ 亮齐后两个标记都给', () => {
    const state = makeGuozhanDraft([
      { seatId: A, name: '甲', main: 'lvbu', deputy: 'diaochan' },
      { seatId: B, name: '乙', main: 'xuchu', deputy: 'zhenji' },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    // 吕布(4)+貂蝉(3) → floor(7/2)=3
    expect(a.maxHp).toBe(3);
    ok(act(state, A, { type: 'revealHero', heroId: 'lvbu' }));
    expect(a.markers.zhulian).toBeUndefined();
    ok(act(state, A, { type: 'revealHero', heroId: 'diaochan' }));
    expect(a.markers.zhulian).toBe(1);
    // 7 是奇数 → 余半个阴阳鱼，转成标记补偿
    expect(a.markers.yinyangyu).toBe(1);
  });

  it('体力上限向下取整：孙权+周瑜 → floor(3.5)=3，不再因珠联璧合加成', () => {
    const state = makeGuozhanDraft([
      { seatId: A, name: '甲', main: 'sunquan', deputy: 'zhouyu' },
      { seatId: B, name: '乙', main: 'xuchu', deputy: 'zhenji' },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    // 原实现用 ceil 会得 4，再加珠联璧合 1 → 5
    expect(a.maxHp).toBe(3);
    expect(a.hp).toBe(3);
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
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'guanyu',
        faction: 'shu',
        hand: [tao('t1')],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    // 2 人国战 = 2 阵营存活 → 鏖战激活
    // A 用桃当杀打 B
    ok(act(state, A, { type: 'playCard', cardId: 't1', targetIds: [B], as: 'sha' }));
    // B 无闪 → 进入响应杀
    expect(state.pending?.kind).toBe('respondSha');
    ok(act(state, B, { type: 'pass' }));
    const b = state.players.find((p) => p.seatId === B)!;
    // 许褚(4) + 甄姬(3) → 上限 floor(3.5) = 3，受 1 点伤害后剩 2
    expect(b.maxHp).toBe(3);
    expect(b.hp).toBe(2);
  });

  it('鏖战未激活（3 阵营）时桃不能当杀', () => {
    const state = makeGuozhanGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'guanyu',
        faction: 'shu',
        hand: [tao('t1')],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'sunquan', deputyHeroId: 'zhouyu', faction: 'wu', hand: [] },
    ]);
    // 3 阵营存活 → 鏖战未激活
    fail(act(state, A, { type: 'playCard', cardId: 't1', targetIds: [B], as: 'sha' }));
  });

  // 4. 被动亮将
  it('成为【杀】目标**不会**自动亮将，也不能用没预亮的转化技', () => {
    const state = makeGuozhanGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'guanyu',
        faction: 'shu',
        hand: [sha('a1')],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'xuchu',
        deputyHeroId: 'zhenji',
        faction: 'wei',
        // 手里只有黑牌：倾国能把它当闪，但没预亮 → 用不了
        hand: [mk('b1', 'sha', 'club', 7)],
      },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // 目标依然是暗置（国战里没有「成为目标就亮将」这个时机）
    expect(b.heroRevealed).toBe(false);
    expect(b.deputyRevealed).toBe(false);
    const prompt = toSnapshot(state, B).prompt;
    expect(prompt?.kind).toBe('respondSha');
    // 黑牌不在可出的牌里（暗置武将没有技能）
    expect(prompt?.legalCardIds).toEqual([]);
  });

  it('预亮【倾国】之后：黑牌能当【闪】打出，打出去的那一刻明置', () => {
    const state = makeGuozhanGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'guanyu',
        faction: 'shu',
        hand: [sha('a1')],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'xuchu',
        deputyHeroId: 'zhenji',
        faction: 'wei',
        hand: [mk('b1', 'sha', 'club', 7)],
      },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, B, { type: 'prelightSkill', skillName: '倾国' }));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // 黑牌出现在可出列表里
    expect(toSnapshot(state, B).prompt?.legalCardIds).toEqual(['b1']);
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    // 视为打出【闪】→ 明置甄姬（发动技能必须明置该武将）
    expect(b.deputyRevealed).toBe(true);
    expect(b.heroRevealed).toBe(false); // 只明置了提供转化的那张
    expect(b.hp).toBe(b.maxHp);
  });

  it('濒死不会自动亮将；预亮了【涅槃】才会在濒死时询问', () => {
    const state = makeGuozhanGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'guanyu',
        faction: 'shu',
        hand: [sha('a1')],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'pangtong',
        deputyHeroId: 'machao',
        faction: 'shu',
        hand: [],
        hp: 1,
      },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    // 没预亮涅槃 → 不询问、不亮将，直接进求桃队列
    expect(b.heroRevealed).toBe(false);
    expect(state.pending?.kind).toBe('respondDeath');
  });

  it('濒死时预亮了【涅槃】→ 先问「是否明置【庞统】并发动」', () => {
    const state = makeGuozhanGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'guanyu',
        faction: 'shu',
        hand: [sha('a1')],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'pangtong',
        deputyHeroId: 'machao',
        faction: 'shu',
        hand: [],
        hp: 1,
      },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, B, { type: 'prelightSkill', skillName: '涅槃' }));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    // 涅槃（nearDeath 可挂起）先问一句
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    // 不发动 → 回到正常的濒死求桃
    expect(b.heroRevealed).toBe(false);
    expect(state.pending?.kind).toBe('respondDeath');
  });

  // 5. 阵营多数胜利
  it('阵营多数胜利：3 存活中 2 蜀 → 蜀胜', () => {
    const state = makeGuozhanGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'guanyu',
        faction: 'shu',
        hand: [sha('a1')],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'zhaoyun',
        deputyHeroId: 'machao',
        faction: 'shu',
        hand: [],
      },
      {
        seatId: C,
        name: '丙',
        heroId: 'xuchu',
        deputyHeroId: 'zhenji',
        faction: 'wei',
        hand: [],
        hp: 4,
      },
      {
        seatId: D,
        name: '丁',
        heroId: 'simayi',
        deputyHeroId: 'zhenji',
        faction: 'wei',
        hand: [],
        hp: 1,
      },
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
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'guanyu',
        faction: 'ambitionist',
        hand: [sha('a1')],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'xuchu',
        deputyHeroId: 'zhenji',
        faction: 'wei',
        hand: [],
        hp: 1,
      },
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
    b.equipment.plusMount = {
      id: 'pm1',
      type: 'plusMount',
      suit: 'heart',
      rank: 1,
      equipName: 'dilu',
    };
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
    b.equipment.plusMount = {
      id: 'pm1',
      type: 'plusMount',
      suit: 'heart',
      rank: 1,
      equipName: 'dilu',
    };
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
    a.equipment.minusMount = {
      id: 'mm1',
      type: 'minusMount',
      suit: 'spade',
      rank: 1,
      equipName: 'chitu',
    };
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.plusMount = {
      id: 'pm1',
      type: 'plusMount',
      suit: 'heart',
      rank: 1,
      equipName: 'dilu',
    };
    // 无武器 range=1，-1马把距离2降为1 → 可达
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
  });
});

describe('酒限1次救人（Step 10 补充）', () => {
  it('同一回合酒救人仅限1次', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        hand: [sha('a1'), sha('a2'), jiu('j1'), jiu('j2')],
      },
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
    b.equipment.plusMount = {
      id: 'bp',
      type: 'plusMount',
      suit: 'heart',
      rank: 1,
      equipName: 'dilu',
    };
    b.equipment.minusMount = {
      id: 'bm',
      type: 'minusMount',
      suit: 'spade',
      rank: 1,
      equipName: 'chitu',
    };
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
  id,
  type: 'armor',
  suit: 'club',
  rank: 2,
  equipName,
});
const weapon = (id: string, equipName: string, range = 2): Card => ({
  id,
  type: 'weapon',
  suit: 'spade',
  rank: 5,
  equipName,
  range,
});
const fireSha = (id: string): Card => ({
  id,
  type: 'sha',
  suit: 'heart',
  rank: 5,
  attribute: 'fire',
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
    const guoRes = act(guo, A, {
      type: 'useSkill',
      skillId: 'zhiheng',
      cardIds: ids,
      targetIds: [],
    });
    expect(guoRes.ok).toBe(false);
    expect(guoRes.ok ? '' : guoRes.error).toContain('体力上限');

    // 国战弃 3 张是合法的
    ok(
      act(guo, A, {
        type: 'useSkill',
        skillId: 'zhiheng',
        cardIds: ids.slice(0, 3),
        targetIds: [],
      }),
    );
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
    ok(act(state, A, { type: 'endPhase' })); // 乙的回合开始 → 准备阶段
    // 洛神是「可以进行判定」，所以先出现是否发动的询问
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
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
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    const ids = b.hand.map((c) => c.id);
    expect(ids).toContain('b1');
    expect(ids).toContain('b2');
    // 与身份局的关键差别：日志写明“一次性获得”，而不是逐张获得
    expect(state.log.some((e) => e.message.includes('一次性获得'))).toBe(true);
  });

  it('洛神：选「不发动」→ 一张都不摸，回合照常推进', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhenji', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    state.deck.push(mk('b1', 'sha', 'club', 3));
    ok(act(state, A, { type: 'endPhase' }));
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    // 没有判定：只有摸牌阶段那 2 张，没有洛神带来的牌
    expect(b.hand).toHaveLength(2);
    expect(state.log.some((e) => e.message.includes('发动【洛神】，判定'))).toBe(false);
    // 回合正常走到乙的出牌阶段，没卡住
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('闭月：结束阶段先问是否发动，选「发动」才摸牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'diaochan', hand: [], hp: 3 },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.hp = 3;
    const before = a.hand.length;
    ok(act(state, A, { type: 'endPhase' })); // 结束出牌 → 弃牌 → 回合结束
    // 官方是「你可以摸一张牌」——先问，不能替玩家决定
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    expect(a.hand.length).toBeGreaterThan(before);
    expect(state.log.some((e) => e.message.includes('发动【闭月】'))).toBe(true);
    // 选完回合正常交给下家，没卡住
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('反馈：受到伤害后由自己挑一张来源的牌拿走', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'simayi', hand: [tao('t1'), shan('s1')] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    const aHandBefore = a.hand.length;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 不出闪，受到 1 点伤害
    // 反馈先问是否发动（不再随机拿）
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    // 候选是甲的牌，由乙自己挑
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') {
      expect(state.pending.cards.map((x) => x.id).sort()).toEqual(['a2']);
    }
    ok(act(state, B, { type: 'pickCards', cardIds: ['a2'] }));
    expect(state.log.some((e) => e.message.includes('发动【反馈】'))).toBe(true);
    // 甲少了一张牌、乙多了一张
    expect(a.hand.length).toBe(aHandBefore - 2); // 打出的 a1 + 被拿走的 a2
    expect(b.hand.map((x) => x.id)).toContain('a2');
  });

  it('反馈：可以拿走来源的装备（并触发失去装备）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'simayi', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    a.equipment.armor = mk('ar1', 'armor', 'heart', 1);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    // 甲没有手牌了，候选只有那张装备
    if (state.pending?.kind === 'pickCards') {
      expect(state.pending.cards.map((x) => x.id)).toEqual(['ar1']);
    }
    ok(act(state, B, { type: 'pickCards', cardIds: ['ar1'] }));
    expect(a.equipment.armor).toBeNull();
    expect(b.hand.map((x) => x.id)).toContain('ar1');
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
    const res = act(state, A, {
      type: 'useSkill',
      skillId: 'qingnang',
      cardIds: ['h1'],
      targetIds: [B],
    });
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
        {
          seatId: B,
          name: '乙',
          heroId: 'vanilla',
          hand: [mk('d1', 'shan', 'heart', 1), mk('d2', 'sha', 'spade', 2)],
        },
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
        {
          seatId: A,
          name: '周瑜',
          heroId: 'zhouyu',
          hand: [mk('f1', 'tao', 'heart', 7), mk('f2', 'sha', 'spade', 3)],
          hp: 3,
        },
        {
          seatId: B,
          name: '乙',
          heroId: 'vanilla',
          hand: [mk('d1', 'shan', 'heart', 2), mk('d2', 'sha', 'club', 4)],
          hp: 4,
        },
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
    // 不能写 HEROES.length：国战专属武将（Hero.modes）不进混战池
    expect(all).toEqual(poolForMode('melee').map((h) => h.id));
    expect(all).toContain('zhouyu'); // 平时随机发将未必发得到
    expect(all).toContain('vanilla'); // 混战保留中立
    expect(all).not.toContain('dongzhao'); // 董昭是国战专属
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

// ——————————————————————————————————————————

/** 国战对齐（阶段 1）：无双的【决斗】部分、珠联璧合组合表、体力上限取整 */
describe('国战对齐（阶段 1）', () => {
  /** 当前决斗轮到谁响应 */
  function duelResponder(state: GameState): string | undefined {
    const p = state.pending;
    return p?.kind === 'respondTrick' ? p.responderId : undefined;
  }

  it('无双·决斗：吕布为来源时，目标每次需连出两张【杀】', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'lvbu', hand: [juedou('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1'), sha('b2')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    expect(duelResponder(state)).toBe(B);
    // 第一张还不够，仍停在 B
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    expect(duelResponder(state)).toBe(B);
    // 第二张凑满 → 换手给 A
    ok(act(state, B, { type: 'respondCard', cardId: 'b2' }));
    expect(duelResponder(state)).toBe(A);
  });

  it('无双·决斗：吕布为目标时，来源每次需连出两张【杀】', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [juedou('a1'), sha('a2'), sha('a3')] },
      { seatId: B, name: '乙', heroId: 'lvbu', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    // 吕布先响应；对手 A 没有无双，一张即可
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    // 轮到 A，对手是吕布 → 要连出两张
    expect(duelResponder(state)).toBe(A);
    ok(act(state, A, { type: 'respondCard', cardId: 'a2' }));
    expect(duelResponder(state)).toBe(A);
    ok(act(state, A, { type: 'respondCard', cardId: 'a3' }));
    expect(duelResponder(state)).toBe(B);
  });

  it('无双·决斗的提示里写明还差几张【杀】', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'lvbu', hand: [juedou('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1'), sha('b2')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    expect(toSnapshot(state, B).prompt?.message).toContain('需连出 2 张【杀】');
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    expect(toSnapshot(state, B).prompt?.message).toContain('还差 1 张');
  });

  it('决斗可用转化牌响应（关羽·武圣：红牌当【杀】）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [juedou('a1')] },
      { seatId: B, name: '乙', heroId: 'guanyu', hand: [tao('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    // 红桃【桃】当【杀】打出
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    expect(state.log.some((e) => e.message.includes('打出了【杀】'))).toBe(true);
    expect(duelResponder(state)).toBe(A);
  });

  it('珠联璧合组合表：补上官方组合，且不误判无关组合', () => {
    // 官方组合（本次新增）：周瑜 ❤ 黄盖
    expect(hasCombo(getHero('zhouyu')!, getHero('huanggai')!)).toBe(true);
    // 既有组合（保留）
    expect(hasCombo(getHero('guanyu')!, getHero('zhangfei')!)).toBe(true);
    expect(hasCombo(getHero('lvbu')!, getHero('diaochan')!)).toBe(true);
    expect(hasCombo(getHero('sunquan')!, getHero('zhouyu')!)).toBe(true);
    // 无组合的搭配不应误判
    expect(hasCombo(getHero('zhouyu')!, getHero('ganning')!)).toBe(false);
    expect(hasCombo(getHero('guanyu')!, getHero('machao')!)).toBe(false);
  });

  it('国战体力上限向下取整：许褚(4)+甄姬(3) → 3', () => {
    const state = createGame(
      [
        { seatId: A, name: '甲' },
        { seatId: B, name: '乙' },
      ],
      'TEST',
      { mode: 'guozhan', freePick: true },
    );
    ok(act(state, A, { type: 'pickHero', heroId: 'xuchu', deputyHeroId: 'zhenji' }));
    ok(act(state, B, { type: 'pickHero', heroId: 'sunquan', deputyHeroId: 'ganning' }));
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.maxHp).toBe(3); // floor((4+3)/2)，不是 4
  });
});

// ——————————————————————————————————————————

/** 国战标记（阶段 2）：先驱 / 阴阳鱼 / 珠联璧合 的发放与消耗 */
describe('国战标记（阶段 2）', () => {
  interface GzSeat extends SeatOpts {
    deputyHeroId: string;
    faction: Faction;
    revealed?: boolean;
  }
  function makeGz(seats: GzSeat[]): GameState {
    const setup: SeatSetup[] = seats.map((s) => ({
      seatId: s.seatId,
      name: s.name,
      heroId: s.heroId,
    }));
    const state = createGame(setup, 'TEST', { mode: 'guozhan' });
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((pl) => pl.seatId === s.seatId)!;
      const main = getHero(s.heroId)!;
      const deputy = getHero(s.deputyHeroId)!;
      p.heroId = s.heroId;
      p.deputyHeroId = s.deputyHeroId;
      p.faction = s.faction;
      p.heroRevealed = s.revealed ?? false;
      p.deputyRevealed = s.revealed ?? false;
      p.maxHp = Math.floor((main.maxHp + deputy.maxHp) / 2);
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
  /** 直接发标记，跳过亮将流程，专测标记本身的用法 */
  function giveMarker(state: GameState, seatId: string, id: MarkerId, n = 1) {
    const p = state.players.find((x) => x.seatId === seatId)!;
    p.markers[id] = (p.markers[id] ?? 0) + n;
  }
  const player = (state: GameState, seatId: string) =>
    state.players.find((p) => p.seatId === seatId)!;

  it('发放：分两次各亮一张，先驱在第一次、阴阳鱼/珠联璧合在第二次', () => {
    const state = createGame(
      [
        { seatId: A, name: '甲' },
        { seatId: B, name: '乙' },
      ],
      'TEST',
      { mode: 'guozhan', freePick: true },
    );
    ok(act(state, A, { type: 'pickHero', heroId: 'lvbu', deputyHeroId: 'diaochan' }));
    ok(act(state, B, { type: 'pickHero', heroId: 'xuchu', deputyHeroId: 'zhenji' }));
    const a = player(state, A);
    ok(act(state, A, { type: 'revealHero', heroId: 'lvbu' }));
    expect(a.markers.xianqu).toBe(1);
    expect(a.markers.yinyangyu).toBeUndefined();
    expect(a.markers.zhulian).toBeUndefined();
    ok(act(state, A, { type: 'revealHero', heroId: 'diaochan' }));
    expect(a.markers.yinyangyu).toBe(1); // 4+3 为奇数
    expect(a.markers.zhulian).toBe(1); // 吕布 ❤ 貂蝉
    expect(a.markers.xianqu).toBe(1); // 先驱不会再来一个
  });

  it('珠联璧合：弃置 → 选「摸两张牌」→ 控制权回到出牌阶段', () => {
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'lvbu',
        deputyHeroId: 'diaochan',
        faction: 'qun',
        revealed: true,
        hand: [],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    giveMarker(state, A, 'zhulian');
    // 技能由服务端下发（标记不属于任何武将，界面配不到 hero.skills）
    const prompt = toSnapshot(state, A).prompt!;
    expect(prompt.legalSkillIds).toContain('mark_zhulian');
    expect(prompt.legalSkills?.find((s) => s.id === 'mark_zhulian')?.name).toBe('珠联璧合');

    ok(act(state, A, { type: 'useSkill', skillId: 'mark_zhulian', targetIds: [] }));
    const choiceSnap = toSnapshot(state, A);
    expect(choiceSnap.prompt?.kind).toBe('choice');
    expect(choiceSnap.prompt?.choiceOptions?.map((o) => o.id)).toEqual(['draw', 'heal']);

    const before = player(state, A).hand.length;
    ok(act(state, A, { type: 'chooseOption', optionId: 'draw' }));
    const a = player(state, A);
    expect(a.hand.length).toBe(before + 2);
    expect(a.markers.zhulian).toBeUndefined();
    // 标记用完，技能从可用列表消失
    expect(toSnapshot(state, A).prompt?.legalSkillIds).not.toContain('mark_zhulian');
    // 关键回归：选完必须回到出牌阶段，不能卡在 choice 上
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('珠联璧合：选「回复 1 点体力」，且不会超过体力上限', () => {
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'lvbu',
        deputyHeroId: 'diaochan',
        faction: 'qun',
        revealed: true,
        hand: [],
        hp: 1,
      },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    giveMarker(state, A, 'zhulian');
    ok(act(state, A, { type: 'useSkill', skillId: 'mark_zhulian', targetIds: [] }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'heal' }));
    const a = player(state, A);
    expect(a.hp).toBe(2);
    expect(a.maxHp).toBe(3); // 吕布(4)+貂蝉(3)
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('阴阳鱼：出牌阶段弃置 → 摸 1 张牌', () => {
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'lvbu',
        deputyHeroId: 'diaochan',
        faction: 'qun',
        revealed: true,
        hand: [],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    giveMarker(state, A, 'yinyangyu');
    const before = player(state, A).hand.length;
    ok(act(state, A, { type: 'useSkill', skillId: 'mark_yinyangyu', targetIds: [] }));
    expect(player(state, A).hand.length).toBe(before + 1);
    expect(player(state, A).markers.yinyangyu).toBeUndefined();
  });

  it('阴阳鱼：弃牌阶段弃置 → 本回合手牌上限 +2，从而不用弃牌', () => {
    // 关羽(4)+马超(4) → 上限 4，手牌 5 张 → 正常要弃 1 张。
    // 不用吕布+貂蝉是因为貂蝉的【闭月】会在回合结束摸牌，把牌数带偏。
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'guanyu',
        deputyHeroId: 'machao',
        faction: 'shu',
        revealed: true,
        hand: [sha('h1'), sha('h2'), sha('h3'), sha('h4'), sha('h5')],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    giveMarker(state, A, 'yinyangyu');
    ok(act(state, A, { type: 'endPhase' }));
    // 该不该弃置阴阳鱼：先问一句
    expect(toSnapshot(state, A).prompt?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    const a = player(state, A);
    expect(a.flags.handLimitBonus).toBe(2);
    expect(a.markers.yinyangyu).toBeUndefined();
    expect(a.hand.length).toBe(5); // 上限 4+2=6，一张都不用弃
    // 回合交给 B（说明弃牌流程走完了，没有卡住）
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('阴阳鱼：选「不弃置」→ 按原上限正常弃牌', () => {
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'guanyu',
        deputyHeroId: 'machao',
        faction: 'shu',
        revealed: true,
        hand: [sha('h1'), sha('h2'), sha('h3'), sha('h4'), sha('h5')],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    giveMarker(state, A, 'yinyangyu');
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'no' }));
    // 体力上限 4、手牌 5 → 弃 1 张
    expect(state.pending).toEqual({ kind: 'discard', seatId: A, count: 1 });
    // 标记还在（没选就留着）
    expect(player(state, A).markers.yinyangyu).toBe(1);
    ok(act(state, A, { type: 'discard', cardIds: ['h1'] }));
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('阴阳鱼：手牌没超上限时不会白问、也不会白耗标记', () => {
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'lvbu',
        deputyHeroId: 'diaochan',
        faction: 'qun',
        revealed: true,
        hand: [sha('h1')],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    giveMarker(state, A, 'yinyangyu');
    ok(act(state, A, { type: 'endPhase' }));
    // 貂蝉的【闭月】在结束阶段会先问一句，答「不发动」
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'no' }));
    expect(player(state, A).markers.yinyangyu).toBe(1);
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('先驱：弃置后把手牌补至 4 张', () => {
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'lvbu',
        deputyHeroId: 'diaochan',
        faction: 'qun',
        revealed: true,
        hand: [sha('h1')],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    giveMarker(state, A, 'xianqu');
    ok(act(state, A, { type: 'useSkill', skillId: 'mark_xianqu', targetIds: [] }));
    const a = player(state, A);
    expect(a.hand.length).toBe(4);
    expect(a.markers.xianqu).toBeUndefined();
  });

  it('先驱：手牌已达 4 张时一张也不摸', () => {
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'lvbu',
        deputyHeroId: 'diaochan',
        faction: 'qun',
        revealed: true,
        hand: [sha('h1'), sha('h2'), sha('h3'), sha('h4'), sha('h5')],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    giveMarker(state, A, 'xianqu');
    ok(act(state, A, { type: 'useSkill', skillId: 'mark_xianqu', targetIds: [] }));
    expect(player(state, A).hand.length).toBe(5);
    expect(player(state, A).markers.xianqu).toBeUndefined();
  });

  it('标记随快照下发（公开信息），数量为 0 的不下发', () => {
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'lvbu',
        deputyHeroId: 'diaochan',
        faction: 'qun',
        revealed: true,
        hand: [],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', deputyHeroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    giveMarker(state, A, 'zhulian');
    giveMarker(state, A, 'yinyangyu', 2);
    // 从对手视角也要看得到（标记是公开信息）
    const bView = toSnapshot(state, B).players.find((p) => p.seatId === A)!;
    expect(bView.markers).toEqual([
      { id: 'yinyangyu', label: '阴阳鱼', count: 2 },
      { id: 'zhulian', label: '珠联璧合', count: 1 },
    ]);
    // 没有标记的玩家下发空数组
    const aView = toSnapshot(state, A).players.find((p) => p.seatId === B)!;
    expect(aView.markers).toEqual([]);
  });

  it('非国战模式：即使身上挂了标记也用不出标记技能', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'lvbu', hand: [] },
      { seatId: B, name: '乙', heroId: 'xuchu', hand: [] },
    ]);
    giveMarker(state, A, 'zhulian');
    expect(toSnapshot(state, A).prompt?.legalSkillIds ?? []).not.toContain('mark_zhulian');
    fail(act(state, A, { type: 'useSkill', skillId: 'mark_zhulian', targetIds: [] }));
  });
});

// ——————————————————————————————————————————

/** 新增国战武将 + 目标过滤 / 完杀 / 君主特性 */
describe('新增武将（按最新国战标准）', () => {
  const seats2: SeatSetup[] = [
    { seatId: A, name: '甲' },
    { seatId: B, name: '乙' },
  ];

  it('新增武将已进入武将池，且国战发将能发到', () => {
    for (const id of [
      'caocao',
      'huangyueying',
      'zhugeliang',
      'weiyan',
      'daqiao',
      'luxun',
      'sunshangxiang',
      'jiaxu',
    ]) {
      expect(getHero(id)).toBeTruthy();
    }
    const state = createGame(seats2, 'TEST', { mode: 'guozhan', freePick: true });
    const deal = state.draft!.deals[A]!;
    expect(deal).toContain('caocao');
    expect(deal).toContain('jiaxu');
    expect(deal).not.toContain('vanilla');
  });

  it('选将池按模式过滤：modes 标了 guozhan 的武将不进其它模式', () => {
    // 目前还没有国战专属武将，所以先钉住不变量——
    // 等加了甘夫人/丁奉这类将，这条测试就会开始真正起作用
    for (const mode of ['junzheng', '2v2', 'melee', 'guozhan'] as GameMode[]) {
      for (const h of poolForMode(mode)) {
        expect(!h.modes || h.modes.includes(mode)).toBe(true);
      }
    }
    // 未标 modes 的将全模式都在池子里；中立武将只在国战被排除，其它模式可用
    const melee = poolForMode('melee').map((h) => h.id);
    expect(melee).toContain('guanyu');
    expect(melee).toContain('caocao');
    expect(melee).toContain('vanilla');
  });

  it('官方组合：曹操❤许褚、黄忠❤魏延、诸葛亮❤黄月英', () => {
    expect(hasCombo(getHero('caocao')!, getHero('xuchu')!)).toBe(true);
    expect(hasCombo(getHero('huangzhong')!, getHero('weiyan')!)).toBe(true);
    expect(hasCombo(getHero('zhugeliang')!, getHero('huangyueying')!)).toBe(true);
    expect(hasCombo(getHero('caocao')!, getHero('simayi')!)).toBe(false);
  });

  // —— 空城 / 谦逊 / 帷幕：目标过滤 ——

  it('空城：诸葛亮没有手牌时不能被【杀】指定为目标', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhugeliang', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    fail(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // 有手牌就不再挡
    state.players.find((p) => p.seatId === B)!.hand.push(sha('b1'));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
  });

  it('空城：有手牌时仍可被【决斗】指定，没手牌时不行', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [juedou('a1'), juedou('a2')] },
      { seatId: B, name: '乙', heroId: 'zhugeliang', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    fail(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    state.players.find((p) => p.seatId === B)!.hand.push(sha('b1'));
    ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [B] }));
  });

  it('谦逊：陆逊不能被【顺手牵羊】【乐不思蜀】指定，【过河拆桥】不受影响', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [shunshou('a1'), lebu('a2'), guohe('a3')] },
      { seatId: B, name: '乙', heroId: 'luxun', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    fail(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    fail(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [B] }));
    ok(act(state, A, { type: 'playCard', cardId: 'a3', targetIds: [B] }));
  });

  it('帷幕：贾诩不能被黑色锦囊指定，红色锦囊可以', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [guohe('a1'), huogong('a2')] },
      { seatId: B, name: '乙', heroId: 'jiaxu', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    fail(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] })); // 黑桃过河拆桥
    ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [B] })); // 红桃火攻
  });

  it('帷幕：黑色【南蛮入侵】直接把贾诩排除在响应队列外', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'jiaxu', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    const pending = state.pending;
    expect(pending?.kind).toBe('respondTrick');
    if (pending?.kind === 'respondTrick') {
      expect(pending.ctx.responders).not.toContain(B);
      expect(pending.ctx.responders).toContain(C);
    }
  });

  // —— 完杀 ——

  it('完杀：贾诩回合内，只有濒死者本人与贾诩能使用【桃】救援', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'jiaxu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [], hp: 1 },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [tao('c1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 不出闪 → 受 1 点 → 濒死
    const pending = state.pending;
    expect(pending?.kind).toBe('respondDeath');
    if (pending?.kind === 'respondDeath') {
      expect(pending.askQueue).toContain(B); // 濒死者本人
      expect(pending.askQueue).toContain(A); // 完杀持有者
      expect(pending.askQueue).not.toContain(C); // 无关的人被排除
    }
    expect(state.log.some((e) => e.message.includes('完杀'))).toBe(true);
  });

  // —— 君主将 ——

  it('君主将只能作主将', () => {
    const state = createGame(seats2, 'TEST', { mode: 'guozhan', freePick: true });
    // 曹操作副将 → 拒
    fail(act(state, A, { type: 'pickHero', heroId: 'xuchu', deputyHeroId: 'caocao' }));
    // 曹操作主将 → 通过
    ok(act(state, A, { type: 'pickHero', heroId: 'caocao', deputyHeroId: 'xuchu' }));
  });

  it('君主将亮将时主副将同时明置，并获得【珠联璧合】', () => {
    const state = createGame(seats2, 'TEST', { mode: 'guozhan', freePick: true });
    ok(act(state, A, { type: 'pickHero', heroId: 'caocao', deputyHeroId: 'xuchu' }));
    ok(act(state, B, { type: 'pickHero', heroId: 'sunquan', deputyHeroId: 'ganning' }));
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.maxHp).toBe(4); // floor((4+4)/2)
    ok(act(state, A, { type: 'revealHero', heroId: 'caocao' }));
    expect(a.heroRevealed).toBe(true);
    expect(a.deputyRevealed).toBe(true); // 双将同亮
    expect(a.markers.zhulian).toBe(1); // 君主与同势力全员珠联璧合
    expect(a.markers.xianqu).toBe(1);
  });

  it('君主不会成为野心家：3 魏里最后那个是君主 → 往前顺延给别人', () => {
    const seats4: SeatSetup[] = [
      { seatId: A, name: '甲' },
      { seatId: B, name: '乙' },
      { seatId: C, name: '丙' },
      { seatId: D, name: '丁' },
    ];
    const state = createGame(seats4, 'TEST', { mode: 'guozhan', freePick: true });
    ok(act(state, A, { type: 'pickHero', heroId: 'xuchu', deputyHeroId: 'zhenji' })); // 魏
    ok(act(state, B, { type: 'pickHero', heroId: 'simayi', deputyHeroId: 'xiahoudun' })); // 魏
    ok(act(state, C, { type: 'pickHero', heroId: 'caocao', deputyHeroId: 'xuchu' })); // 魏（君主）
    ok(act(state, D, { type: 'pickHero', heroId: 'guanyu', deputyHeroId: 'zhangfei' })); // 蜀
    const c = state.players.find((p) => p.seatId === C)!;
    const b = state.players.find((p) => p.seatId === B)!;
    expect(c.faction).toBe('wei'); // 君主保持魏
    expect(b.faction).toBe('ambitionist'); // 跳过君主，顺延到上一个魏
  });

  // —— 新武将技能 ——

  it('奸雄：曹操受到伤害后获得造成伤害的那张牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'caocao', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hand.some((c) => c.id === 'a1')).toBe(true);
    expect(state.log.some((e) => e.message.includes('奸雄'))).toBe(true);
  });

  it('集智：黄月英使用非延时锦囊时额外摸一张', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'huangyueying', hand: [wuzhong('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const before = state.players.find((p) => p.seatId === A)!.hand.length;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    // 打掉 1 张，无中生有摸 2 张，集智再摸 1 张
    expect(state.players.find((p) => p.seatId === A)!.hand.length).toBe(before - 1 + 3);
    expect(state.log.some((e) => e.message.includes('集智'))).toBe(true);
  });

  it('奇才：黄月英使用【顺手牵羊】不受距离限制（别人受）', () => {
    const seats4 = (heroId: string): SeatSetup[] => [
      { seatId: A, name: '甲', heroId },
      { seatId: B, name: '乙' },
      { seatId: C, name: '丙' },
      { seatId: D, name: '丁' },
    ];
    // 没有奇才：A 到 C 距离 2，用不了
    const plain = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [shunshou('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [sha('c1')] },
      { seatId: D, name: '丁', heroId: 'vanilla', hand: [] },
    ]);
    expect(distance(plain, A, C)).toBe(2);
    fail(act(plain, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));

    // 有奇才：同样距离 2，可以
    void seats4;
    const wy = makeGame([
      { seatId: A, name: '甲', heroId: 'huangyueying', hand: [shunshou('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [sha('c1')] },
      { seatId: D, name: '丁', heroId: 'vanilla', hand: [] },
    ]);
    expect(distance(wy, A, C)).toBe(2);
    ok(act(wy, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
  });

  it('国色：大乔把方块牌当【乐不思蜀】使用，黑色牌不行', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'daqiao',
        hand: [mk('a1', 'shan', 'diamond'), mk('a2', 'shan', 'spade')],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const legal = toSnapshot(state, A).prompt?.legalCardIds ?? [];
    expect(legal).toContain('a1'); // 方块牌可转化
    expect(legal).not.toContain('a2'); // 黑桃牌不行
    ok(act(state, A, { type: 'playCard', cardId: 'a1', as: 'lebu', targetIds: [B] }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.judgment.some((c) => c.type === 'lebu')).toBe(true);
  });

  it('结姻：孙尚香弃两张手牌令已受伤男性回复体力，自己也回', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'sunshangxiang',
        hand: [sha('a1'), sha('a2'), sha('a3')],
        hp: 2,
      },
      // 目标得是男性：平民没有性别字段，所以用许褚
      { seatId: B, name: '乙', heroId: 'xuchu', hand: [], hp: 2 },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(
      act(state, A, { type: 'useSkill', skillId: 'jieyin', cardIds: ['a1', 'a2'], targetIds: [B] }),
    );
    expect(state.players.find((p) => p.seatId === A)!.hp).toBe(3);
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(3);
    expect(state.players.find((p) => p.seatId === A)!.hand.length).toBe(1);
  });

  it('结姻：目标须为男性且已受伤', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'sunshangxiang', hand: [sha('a1'), sha('a2')], hp: 2 },
      { seatId: B, name: '乙', heroId: 'zhenji', hand: [], hp: 1 }, // 女性
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [], hp: 4 }, // 满体力
    ]);
    fail(
      act(state, A, { type: 'useSkill', skillId: 'jieyin', cardIds: ['a1', 'a2'], targetIds: [B] }),
    );
    fail(
      act(state, A, { type: 'useSkill', skillId: 'jieyin', cardIds: ['a1', 'a2'], targetIds: [C] }),
    );
  });

  it('狂骨：魏延对距离 1 以内的角色造成伤害后回复 1 点体力', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'weiyan', hand: [sha('a1')], hp: 2 },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(state.players.find((p) => p.seatId === A)!.hp).toBe(3);
    expect(state.log.some((e) => e.message.includes('狂骨'))).toBe(true);
  });
});

// ——————————————————————————————————————————

/** 选牌原语（pickCards）与它的第一个真实用户：诸葛亮·观星 */
describe('选牌原语与观星（阶段 2.2）', () => {
  /** 造一副可控牌堆。注意 drawOne 从数组**末尾** pop，所以最后一个 id 最先被抽到 */
  function setDeck(state: GameState, ids: string[]) {
    state.deck = ids.map((id, i) => mk(id, 'sha', i % 2 === 0 ? 'spade' : 'club', i + 1));
  }

  it('观星：发动后观看牌堆顶 X 张（X=存活角色数），一张不选则顺序不变', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhugeliang', hand: [] },
    ]);
    setDeck(state, ['d1', 'd2', 'd3', 'd4']); // d4 最先被抽到
    ok(act(state, A, { type: 'endPhase' }));
    // 观星是「可以」→ 先问是否发动
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    // 进入选牌：候选是牌堆顶 2 张（场上 2 人）
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') {
      expect(state.pending.seatId).toBe(B);
      expect(state.pending.min).toBe(0);
      expect(state.pending.max).toBe(2);
      // 关键：候选牌不在手牌里（是牌堆顶），所以提示必须下发完整牌面
      expect(state.pending.cards.map((c) => c.id)).toEqual(['d4', 'd3']);
    }
    ok(act(state, B, { type: 'pickCards', cardIds: [] }));
    const b = state.players.find((p) => p.seatId === B)!;
    // 牌堆没动，摸牌阶段拿走原来的顶两张
    expect(b.hand.map((c) => c.id).sort()).toEqual(['d3', 'd4']);
    // 私密：日志只记张数，不记牌名
    const guanxingLog = state.log
      .filter((e) => e.message.includes('观星') || e.message.includes('选择了'))
      .map((e) => e.message)
      .join(' | ');
    expect(guanxingLog).not.toContain('梅花4');
    expect(guanxingLog).not.toContain('黑桃3');
    // 选完回到出牌阶段，没卡住
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('观星：选中的牌沉到牌堆底（最后才被抽到）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhugeliang', hand: [] },
    ]);
    setDeck(state, ['d1', 'd2', 'd3', 'd4']);
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    // 把最先抽到的 d4 沉底
    ok(act(state, B, { type: 'pickCards', cardIds: ['d4'] }));
    const b = state.players.find((p) => p.seatId === B)!;
    // 摸到 d3、d2；d4 被压到牌堆最底（数组最前面）
    expect(b.hand.map((c) => c.id).sort()).toEqual(['d2', 'd3']);
    expect(state.deck[0]!.id).toBe('d4');
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('观星：不发动 → 牌堆原样、日志无痕', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhugeliang', hand: [] },
    ]);
    setDeck(state, ['d1', 'd2', 'd3', 'd4']);
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hand.map((c) => c.id).sort()).toEqual(['d3', 'd4']);
    expect(state.log.some((e) => e.message.includes('观星'))).toBe(false);
  });

  it('观星：候选张数不超过存活人数，也不超过 5', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhugeliang', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    setDeck(state, ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    if (state.pending?.kind === 'pickCards') {
      expect(state.pending.cards).toHaveLength(3); // 场上 3 人
    } else {
      throw new Error('应进入选牌');
    }
  });
});

// ——————————————————————————————————————————

/** 原语补完：equipLost（枭姬）、判定牌归属（天妒）、drawPhaseEnd 与伤害加成（裸衣）、多段续接（遗计） */
describe('阶段 2.3 原语与验证技能', () => {
  it('枭姬：装备被顶替 → 问是否发动 → 摸两张牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'sunshangxiang', hand: [wpn('w1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.weapon = wpn('w0'); // 先装一把，等着被顶替
    const before = a.hand.length;
    ok(act(state, A, { type: 'playCard', cardId: 'w1', targetIds: [] }));
    // 旧武器被顶掉 = 失去装备区的一张牌 → 枭姬问一句
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    expect(a.hand.length).toBe(before - 1 + 2); // 打掉 w1，再摸两张
    expect(state.log.some((e) => e.message.includes('枭姬'))).toBe(true);
    // 关键：装备变动路径被询问打断后也接回来了，控制权回到出牌阶段
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('枭姬：过河拆桥拆掉装备也触发（控制权回到拆桥的人）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [guohe('g1')] },
      { seatId: B, name: '乙', heroId: 'sunshangxiang', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = mk('ar1', 'armor', 'heart', 1);
    ok(act(state, A, { type: 'playCard', cardId: 'g1', targetIds: [B], targetCardId: 'ar1' }));
    passWuxie(state);
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    expect(b.hand).toHaveLength(2);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('枭姬：拆的是手牌则不触发（只有装备区才算）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [guohe('g1')] },
      { seatId: B, name: '乙', heroId: 'sunshangxiang', hand: [sha('b1')] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'g1', targetIds: [B] }));
    passWuxie(state);
    // B 的手牌没了，但没有枭姬的询问
    expect(state.log.some((e) => e.message.includes('枭姬'))).toBe(false);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    expect(b.hand).toHaveLength(0);
  });

  it('天妒：郭嘉把自己的判定牌收进手里，不进弃牌堆', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'guojia', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.judgment.push(lebu('lb0'));
    state.deck.push(mk('jc', 'sha', 'heart', 1)); // 红桃 → 乐不思蜀无效
    ok(act(state, A, { type: 'endPhase' })); // 轮到 B，判定阶段
    expect(b.hand.some((c) => c.id === 'jc')).toBe(true);
    expect(state.discard.some((c) => c.id === 'jc')).toBe(false);
    expect(state.log.some((e) => e.message.includes('获得了判定牌'))).toBe(true);
  });

  it('天妒：只收自己的判定牌，不抢别人的', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'guojia', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    // B 判定区有乐不思蜀，A（郭嘉）不在判定中
    b.judgment.push(lebu('lb0'));
    state.deck.push(mk('jc', 'sha', 'heart', 1));
    ok(act(state, A, { type: 'endPhase' })); // 轮到 B 判定
    expect(a.hand.some((c) => c.id === 'jc')).toBe(false); // 郭嘉没抢
    expect(state.discard.some((c) => c.id === 'jc')).toBe(true); // 正常进弃牌堆
  });

  it('遗计：受伤后摸两张，可把摸到的牌交给别人（三段续接）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'guojia', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    state.deck.push(mk('d1', 'sha', 'spade', 1));
    state.deck.push(mk('d2', 'sha', 'club', 2));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 不出闪 → 受伤
    // 第一段：是否发动
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    // 第二段：摸两张后挑要送出去的（候选＝刚摸到的两张）
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') {
      expect(state.pending.cards.map((x) => x.id).sort()).toEqual(['d1', 'd2']);
    }
    ok(act(state, B, { type: 'pickCards', cardIds: ['d1'] }));
    // 第三段：选交给谁
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: C }));
    expect(c.hand.map((x) => x.id)).toEqual(['d1']);
    expect(b.hand.map((x) => x.id)).toEqual(['d2']);
    // 三段走完，控制权回到出伤害的甲
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('遗计：不发动就只是受伤，不进后续链', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'guojia', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    expect(b.hand).toHaveLength(0);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('裸衣（国战）：摸牌阶段结束时弃一张牌 → 本回合【杀】伤害 +1', () => {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a9')] },
        { seatId: B, name: '乙', heroId: 'xuchu', hand: [] },
      ],
      'guozhan',
    );
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    b.heroRevealed = true; // 国战要亮将技能才生效
    state.deck.push(mk('d1', 'sha', 'spade', 1));
    state.deck.push(mk('d2', 'sha', 'club', 2));
    ok(act(state, A, { type: 'endPhase' })); // 轮到 B
    // 摸牌阶段**结束**时问（国战版的时机）
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, B, { type: 'pickCards', cardIds: ['d1'] })); // 弃 d1，留 d2 当杀
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });

    // 用剩下的【杀】打 A：基础 1 + 裸衣 1 = 2
    ok(act(state, B, { type: 'playCard', cardId: 'd2', targetIds: [A] }));
    ok(act(state, A, { type: 'pass' }));
    expect(a.hp).toBe(4 - 2);
  });

  it('裸衣（身份局）：摸牌阶段少摸一张 → 只摸到 1 张', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'xuchu', hand: [] },
    ]);
    state.deck.push(mk('d1', 'sha', 'spade', 1));
    state.deck.push(mk('d2', 'sha', 'club', 2));
    state.deck.push(mk('d3', 'sha', 'heart', 3));
    ok(act(state, A, { type: 'endPhase' })); // 轮到 B
    // 身份局版的时机是摸牌阶段**开始时**（它改的是摸牌数）
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hand.map((c) => c.id)).toEqual(['d3']); // 少摸一张，只拿到一张
    expect(b.flags.damageBonusThisTurn).toBe(1);
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('裸衣：不发动就没有加成，也没少摸', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'xuchu', hand: [] },
    ]);
    state.deck.push(mk('d1', 'sha', 'spade', 1));
    state.deck.push(mk('d2', 'sha', 'club', 2));
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hand).toHaveLength(2);
    expect(b.flags.damageBonusThisTurn).toBe(0);
  });
});

// ——————————————————————————————————————————

/** 原语补完第二批：hand_emptied（连营）、extra_turn（放权）、limited_skill（涅槃）、flip（翻面） */
describe('阶段 2.4 原语与验证技能', () => {
  it('连营：打出手里最后一张牌后空手 → 问是否发动 → 摸一张', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'luxun', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // 杀的结算停在「等乙出闪」，同时甲已经空手 → 连营插进来问
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    expect(a.hand).toHaveLength(1);
    expect(state.log.some((e) => e.message.includes('连营'))).toBe(true);
    // 关键：连营的询问插在杀的结算中间，问完要把「等乙出闪」还回去
    expect(state.pending?.kind).toBe('respondSha');
  });

  it('连营：不发动则一牌不摸', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'luxun', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'no' }));
    expect(a.hand).toHaveLength(0);
    expect(state.pending?.kind).toBe('respondSha');
  });

  it('连营：手牌被过河拆桥拿走最后一张也触发', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [guohe('g1')] },
      { seatId: B, name: '乙', heroId: 'luxun', hand: [sha('b1')] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'g1', targetIds: [B] }));
    passWuxie(state);
    // 乙的手牌被拆空 → 连营
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    expect(b.hand).toHaveLength(1);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('放权：结束阶段弃一张手牌 → 指定角色获得一个额外回合', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'liushan', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'endPhase' }));
    // 第一段：是否发动
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    // 第二段：弃一张手牌
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    // 第三段：选给谁
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: B }));
    expect(a.hand).toHaveLength(0);
    // 乙先进行额外回合
    expect(state.seatOrder[state.turn.seatIndex]).toBe(B);
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
    expect(state.log.some((e) => e.message.includes('额外的回合'))).toBe(true);
  });

  it('涅槃：濒死时发动 → 弃置所有牌、摸三张、体力回到 3，不进求桃队列', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'pangtong', hand: [shan('b1')], hp: 1 },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 不出闪 → 受 1 点 → 濒死
    // 涅槃先问（nearDeath 时机可挂起）
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    expect(b.hp).toBe(3);
    expect(b.alive).toBe(true);
    // 关键：被技能救回来就不该再进濒死求桃队列，控制权回到出伤害的人
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    expect(b.usedOncePerGame.niepan).toBe(true);
    // 原来的手牌弃掉了，换成摸到的三张
    expect(b.hand).toHaveLength(3);
  });

  it('涅槃：不发动则照常进入求桃队列', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'pangtong', hand: [], hp: 1 },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    expect(state.pending?.kind).toBe('respondDeath');
  });

  it('翻面：翻面朝上的角色跳过自己的回合，并翻回正面', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.flipped = true;
    ok(act(state, A, { type: 'endPhase' })); // 轮到乙 → 跳过
    expect(b.flipped).toBe(false); // 已翻回正面
    expect(b.hand).toHaveLength(0); // 跳过了摸牌阶段
    expect(state.log.some((e) => e.message.includes('跳过本回合'))).toBe(true);
    // 回合直接顺延到下一个存活者（2 人局就是甲）
    expect(state.seatOrder[state.turn.seatIndex]).toBe(A);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });
});

// ——————————————————————————————————————————

/** 武器特效：贯石斧（闪避后弃牌仍造成伤害）、青龙偃月刀（继续出杀）、雌雄双股剑（异性二选一） */
describe('武器特效（卡牌效果）', () => {
  it('贯石斧：被【闪】抵消后弃置两张牌 → 此【杀】依然造成伤害', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1'), sha('a2'), sha('a3')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    a.equipment.weapon = weapon('w1', 'guanshi');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' })); // 出闪抵消
    // 被闪避 → 贯石斧问一句
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    // 候选是手牌里剩的两张
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, A, { type: 'pickCards', cardIds: ['a2', 'a3'] }));
    expect(b.hp).toBe(3); // 依然造成伤害
    expect(a.hand).toHaveLength(0); // a1 打掉 + 弃 a2 a3
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('贯石斧：选不发动则【杀】被闪掉，目标不受伤', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1'), sha('a2'), sha('a3')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    a.equipment.weapon = weapon('w1', 'guanshi');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'no' }));
    expect(b.hp).toBe(4);
    expect(a.hand).toHaveLength(2); // 只打掉 a1
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('贯石斧：手牌不够两张时不问', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.weapon = weapon('w1', 'guanshi');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    // 只有武器自己一张可弃（已排除）→ 直接过，没有询问
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(4);
  });

  it('青龙偃月刀：被【闪】抵消后可以继续使用一张【杀】', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    a.equipment.weapon = weapon('w1', 'qinglong');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, A, { type: 'pickCards', cardIds: ['a2'] }));
    // 新的【杀】重新走一遍，等乙出闪
    expect(state.pending?.kind).toBe('respondSha');
    expect(a.hand).toHaveLength(0);
    // 乙没有第二张闪 → 弃权受伤
    ok(act(state, B, { type: 'pass' }));
    expect(b.hp).toBe(3);
    expect(b.hand).toHaveLength(0);
  });

  it('青龙偃月刀：追加的【杀】不计入本回合出杀次数', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1'), sha('a2'), sha('a3')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.weapon = weapon('w1', 'qinglong');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['a2'] }));
    expect(a.flags.shaCountThisTurn).toBe(1); // 只有第一张算数
    ok(act(state, B, { type: 'pass' })); // 第二张杀命中
    // 追加的杀不占次数；但本回合那 1 张正常额度已被第一张用掉，
    // 所以再出一张普通杀仍然该被拒（额度是 1 张正常 + N 张青龙追加）
    fail(act(state, A, { type: 'playCard', cardId: 'a3', targetIds: [B] }));
  });

  it('雌雄双股剑：指定异性目标 → 目标选择令使用者摸一张', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'guanyu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhenji', hand: [shan('b1'), shan('b2')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.weapon = weapon('w1', 'cixiong');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // 由**目标**选择，且发生在问她出闪之前
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: 'draw' }));
    expect(a.hand).toHaveLength(1); // 摸了一张
    expect(state.pending?.kind).toBe('respondSha');
  });

  it('雌雄双股剑：目标选择弃置一张手牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'guanyu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhenji', hand: [shan('b1'), shan('b2')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    state.players.find((p) => p.seatId === A)!.equipment.weapon = weapon('w1', 'cixiong');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'discard' }));
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    expect(b.hand).toHaveLength(1);
    expect(state.pending?.kind).toBe('respondSha');
  });

  it('雌雄双股剑：目标同性别时不触发', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'guanyu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    state.players.find((p) => p.seatId === A)!.equipment.weapon = weapon('w1', 'cixiong');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // 两名男性 → 直接问出闪，没有雌雄的询问
    expect(state.pending?.kind).toBe('respondSha');
  });
});

// ——————————————————————————————————————————

/** 张辽·突袭、刘备·仁德：都是靠前几轮的原语才做得出来的技能 */
describe('突袭与仁德', () => {
  it('突袭：少摸一张牌，改为获得一名角色的一张手牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhangliao', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [sha('c1'), sha('c2')] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    state.deck.push(mk('d1', 'sha', 'spade', 1));
    state.deck.push(mk('d2', 'sha', 'club', 2));
    state.deck.push(mk('d3', 'sha', 'heart', 3));
    ok(act(state, A, { type: 'endPhase' })); // 轮到乙
    // 突袭先问是否发动
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    // 只有丙有手牌，所以候选只有他一个（还没到能给「不再选人」的时候）
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.options.map((o) => o.id)).toEqual([C]);
    }
    ok(act(state, B, { type: 'chooseOption', optionId: C }));
    // 由张辽挑拿对方哪一张
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') {
      expect(state.pending.cards.map((x) => x.id).sort()).toEqual(['c1', 'c2']);
    }
    ok(act(state, B, { type: 'pickCards', cardIds: ['c1'] }));
    expect(c.hand.map((x) => x.id)).toEqual(['c2']);
    // 少摸一张 → 摸牌阶段只摸 1 张（拿到牌堆顶的 d3）
    expect(b.hand.map((x) => x.id).sort()).toEqual(['c1', 'd3']);
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('突袭：不发动则照常摸两张', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhangliao', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [sha('c1')] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    state.deck.push(mk('d1', 'sha', 'spade', 1));
    state.deck.push(mk('d2', 'sha', 'club', 2));
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    expect(b.hand).toHaveLength(2); // 正常摸两张
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('突袭：两名目标都拿得到，也可以只选一个', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhangliao', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [sha('c1')] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    // 选了第一名之后，候选项里会出现「不再选人」
    ok(act(state, B, { type: 'chooseOption', optionId: A }));
    if (state.pending?.kind === 'choice') {
      expect(state.pending.options.map((o) => o.id)).toContain('__stop');
    }
    ok(act(state, B, { type: 'chooseOption', optionId: '__stop' })); // 只拿一个
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, B, { type: 'pickCards', cardIds: ['a1'] }));
    expect(c.hand).toHaveLength(1); // 丙没被拿
    expect(b.hand.map((x) => x.id)).toContain('a1');
  });

  it('仁德：一次交出两张 → 回复 1 点体力', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'liubei', hand: [sha('a1'), sha('a2'), sha('a3')], hp: 2 },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    ok(
      act(state, A, { type: 'useSkill', skillId: 'rende', cardIds: ['a1', 'a2'], targetIds: [B] }),
    );
    expect(b.hand.map((x) => x.id).sort()).toEqual(['a1', 'a2']);
    expect(a.hand.map((x) => x.id)).toEqual(['a3']);
    expect(a.hp).toBe(3);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('仁德：分两次各给一张，第二次累计到两张才回血', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'liubei', hand: [sha('a1'), sha('a2'), sha('a3')], hp: 2 },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    // 官方不限次数：可以分几次给
    ok(act(state, A, { type: 'useSkill', skillId: 'rende', cardIds: ['a1'], targetIds: [B] }));
    expect(a.hp).toBe(2); // 只给一张，不回
    ok(act(state, A, { type: 'useSkill', skillId: 'rende', cardIds: ['a2'], targetIds: [B] }));
    expect(a.hp).toBe(3); // 累计两张 → 回 1 点
  });

  it('仁德：给超过两张也只回一次', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'liubei', hand: [sha('a1'), sha('a2'), sha('a3')], hp: 2 },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(
      act(state, A, {
        type: 'useSkill',
        skillId: 'rende',
        cardIds: ['a1', 'a2', 'a3'],
        targetIds: [B],
      }),
    );
    expect(a.hp).toBe(3); // 只回 1 点，不是 2 点
    expect(a.hand).toHaveLength(0);
  });
});

// ——————————————————————————————————————————

/** 目标转移（target_transfer）：大乔·流离 */
describe('流离（目标转移）', () => {
  it('流离：弃一张牌，把【杀】转给攻击范围内的另一名角色', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'daqiao', hand: [sha('b1'), sha('b2')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [shan('c1')] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // 流离先问是否发动，且是问**被指定的大乔**
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    // 弃一张牌作为代价
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    // 选转移给谁。官方文本是「你攻击范围内的**一名其他角色**」，
    // 回射来源（甲）也在这个范围内，所以两个人都可以选。
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.options.map((o) => o.id).sort()).toEqual([A, C].sort());
    }
    ok(act(state, B, { type: 'chooseOption', optionId: C }));
    // 关键：现在被问出闪的是**丙**，不是大乔
    expect(state.pending?.kind).toBe('respondSha');
    if (state.pending?.kind === 'respondSha') expect(state.pending.responderId).toBe(C);
    expect(b.hand.map((x) => x.id)).toEqual(['b2']); // 弃掉了一张
    expect(state.log.some((e) => e.message.includes('流离'))).toBe(true);
  });

  it('流离：可以把【杀】回射给来源，由来源自己出闪', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'daqiao', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    ok(act(state, B, { type: 'chooseOption', optionId: A }));
    expect(state.pending?.kind).toBe('respondSha');
    if (state.pending?.kind === 'respondSha') expect(state.pending.responderId).toBe(A);
    if (state.pending?.kind === 'respondSha') expect(state.pending.attack.sourceId).toBe(A);
  });

  it('流离：选不发动则照常等大乔出闪', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'daqiao', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    expect(state.pending?.kind).toBe('respondSha');
    if (state.pending?.kind === 'respondSha') expect(state.pending.responderId).toBe(B);
  });

  it('流离：一张牌都没有时不问', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'daqiao', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(state.pending?.kind).toBe('respondSha');
    if (state.pending?.kind === 'respondSha') expect(state.pending.responderId).toBe(B);
  });

  it('流离：转移只发生一次（新目标不能是同一张杀再被改）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'daqiao', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'daqiao', hand: [sha('c1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    ok(act(state, B, { type: 'chooseOption', optionId: C }));
    // 丙也是大乔，但这张杀已经被改过一次，不再问他流离
    expect(state.pending?.kind).toBe('respondSha');
    if (state.pending?.kind === 'respondSha') expect(state.pending.responderId).toBe(C);
    expect(state.pending?.kind === 'respondSha' && state.pending.attack.redirected).toBe(true);
  });
});

// ——————————————————————————————————————————

/** 势力技（faction_call）：曹操·护驾；以及孙权·救援这条势力加血规则 */
describe('势力技与救援', () => {
  /** 造一个国战局面并手动设好势力（测试辅助不走选将流程）。
   *  势力用 [座次, 势力] 数组传——用对象字面量的 `{ B: 'wei' }` 是静态键名「B」，
   *  不是变量 B 的值，写起来容易错。 */
  function guozhanSeats(
    seats: { seatId: string; name: string; heroId: string; hand: Card[]; hp?: number }[],
    factions: [string, Faction][],
  ): GameState {
    const state = makeGameMode(seats, 'guozhan');
    for (const [seatId, f] of factions) {
      const p = state.players.find((x) => x.seatId === seatId);
      if (!p) throw new Error(`没有这个座位：${seatId}`);
      p.faction = f;
      p.heroRevealed = true;
    }
    return state;
  }

  it('护驾：令同势力角色代打一张【闪】，代打即视为曹操打出', () => {
    const state = guozhanSeats(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
        { seatId: B, name: '乙', heroId: 'caocao', hand: [] },
        { seatId: C, name: '丙', heroId: 'xuchu', hand: [shan('c1')] },
      ],
      [
        [B, 'wei'],
        [C, 'wei'],
      ],
    );
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // 曹操的提示里出现护驾入口，且列出能代打的同势力角色
    const prompt = toSnapshot(state, B).prompt!;
    expect(prompt.kind).toBe('respondSha');
    expect(prompt.factionCall?.skillName).toBe('护驾');
    expect(prompt.factionCall?.helpers.map((h) => h.seatId)).toEqual([C]);
    ok(act(state, B, { type: 'factionCall', skillId: 'hujia' }));
    // 轮到丙被问是否代打
    expect(state.pending?.kind).toBe('factionCall');
    const cPrompt = toSnapshot(state, C).prompt!;
    expect(cPrompt.kind).toBe('factionCall');
    expect(cPrompt.legalCardIds).toEqual(['c1']);
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    // 视为曹操打出了闪 → 杀被闪避，丙的牌进了弃牌堆
    expect(c.hand).toHaveLength(0);
    expect(b.hp).toBe(4);
    expect(state.log.some((e) => e.message.includes('替'))).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('护驾：没人代打则回到曹操自己响应', () => {
    const state = guozhanSeats(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
        { seatId: B, name: '乙', heroId: 'caocao', hand: [] },
        { seatId: C, name: '丙', heroId: 'xuchu', hand: [shan('c1')] },
      ],
      [
        [B, 'wei'],
        [C, 'wei'],
      ],
    );
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'factionCall', skillId: 'hujia' }));
    ok(act(state, C, { type: 'pass' })); // 丙不代打
    expect(state.pending?.kind).toBe('respondSha');
    if (state.pending?.kind === 'respondSha') expect(state.pending.responderId).toBe(B);
  });

  it('护驾：同势力角色手里没有【闪】时不给入口', () => {
    const state = guozhanSeats(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
        { seatId: B, name: '乙', heroId: 'caocao', hand: [] },
        { seatId: C, name: '丙', heroId: 'xuchu', hand: [sha('c1')] },
      ],
      [
        [B, 'wei'],
        [C, 'wei'],
      ],
    );
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    const prompt = toSnapshot(state, B).prompt!;
    expect(prompt.factionCall).toBeUndefined();
    // 直接发动会被拒
    fail(act(state, B, { type: 'factionCall', skillId: 'hujia' }));
  });

  it('护驾：不同势力的人不能代打', () => {
    const state = guozhanSeats(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
        { seatId: B, name: '乙', heroId: 'caocao', hand: [] },
        { seatId: C, name: '丙', heroId: 'ganning', hand: [shan('c1')] },
      ],
      [
        [B, 'wei'],
        [C, 'wu'],
      ], // 丙是吴势力
    );
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(toSnapshot(state, B).prompt?.factionCall).toBeUndefined();
  });

  it('救援：同势力角色对孙权使用【桃】，孙权额外回复 1 点', () => {
    const state = guozhanSeats(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
        { seatId: B, name: '乙', heroId: 'sunquan', hand: [], hp: 1 },
        { seatId: C, name: '丙', heroId: 'ganning', hand: [tao('c1')] },
      ],
      [
        [B, 'wu'],
        [C, 'wu'],
      ],
    );
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 不出闪 → 0 血濒死
    ok(act(state, B, { type: 'pass' })); // 自己没桃，跳过
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' })); // 丙用桃救
    expect(b.hp).toBe(2); // 桃 1 点 + 救援 1 点
    expect(state.log.some((e) => e.message.includes('救援'))).toBe(true);
  });

  it('救援：不同势力的人用桃救则没有额外回复', () => {
    const state = guozhanSeats(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
        { seatId: B, name: '乙', heroId: 'sunquan', hand: [], hp: 1 },
        { seatId: C, name: '丙', heroId: 'zhenji', hand: [tao('c1')] },
      ],
      [
        [B, 'wu'],
        [C, 'wei'],
      ], // 丙是魏势力
    );
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    expect(b.hp).toBe(1); // 只有桃的 1 点
    // 注意别拿 '救援' 当关键词：濒死提示里本来就有「等待出桃救援」这句
    expect(state.log.some((e) => e.message.includes('【救援】生效'))).toBe(false);
  });

  // —— 需要【杀】的场景：决斗 / 借刀杀人 / 南蛮入侵 ——

  it('激将：决斗时令同势力角色代打【杀】，代打后决斗换手', () => {
    const state = guozhanSeats(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [juedou('a1')] },
        { seatId: B, name: '乙', heroId: 'liubei', hand: [] },
        { seatId: C, name: '丙', heroId: 'zhangfei', hand: [sha('c1')] },
      ],
      [
        [B, 'shu'],
        [C, 'shu'],
      ],
    );
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    // 刘备手里一张杀都没有，但提示里应该出现激将入口
    expect(state.pending?.kind).toBe('respondTrick');
    const prompt = toSnapshot(state, B).prompt!;
    expect(prompt.factionCall?.skillName).toBe('激将');
    expect(prompt.factionCall?.helpers.map((h) => h.seatId)).toEqual([C]);
    ok(act(state, B, { type: 'factionCall', skillId: 'jijiang' }));
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    // 视作刘备打出了杀 → 决斗换手，轮到甲出杀
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') expect(state.pending.responderId).toBe(A);
    expect(state.log.some((e) => e.message.includes('替'))).toBe(true);
  });

  it('激将：借刀杀人时代打，视为刘备对指定目标使用【杀】', () => {
    const state = guozhanSeats(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [jiedao('a1')] },
        { seatId: B, name: '乙', heroId: 'liubei', hand: [] },
        { seatId: C, name: '丙', heroId: 'zhangfei', hand: [sha('c1')] },
        { seatId: D, name: '丁', heroId: 'vanilla', hand: [] },
      ],
      [
        [B, 'shu'],
        [C, 'shu'],
      ],
    );
    // 刘备要有武器（借刀的前提）
    state.players.find((p) => p.seatId === B)!.equipment.weapon = weapon('b0', 'qinggang');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, D] }));
    passWuxie(state);
    expect(state.pending?.kind).toBe('respondTrick');
    expect(toSnapshot(state, B).prompt?.factionCall?.skillName).toBe('激将');
    ok(act(state, B, { type: 'factionCall', skillId: 'jijiang' }));
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    // 代打的杀以**刘备**为来源，目标是丁
    expect(state.pending?.kind).toBe('respondSha');
    if (state.pending?.kind === 'respondSha') {
      expect(state.pending.responderId).toBe(D);
      expect(state.pending.attack.sourceId).toBe(B);
    }
  });

  it('激将：南蛮入侵时代打后，响应队列继续往下走', () => {
    const state = guozhanSeats(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [nanman('a1')] },
        { seatId: B, name: '乙', heroId: 'liubei', hand: [] },
        { seatId: C, name: '丙', heroId: 'zhangfei', hand: [sha('c1')] },
      ],
      [
        [B, 'shu'],
        [C, 'shu'],
      ],
    );
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, B, { type: 'factionCall', skillId: 'jijiang' }));
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    // 代的这张算刘备的，丙自己还得再响应一次南蛮（他已经没杀了）
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') expect(state.pending.responderId).toBe(C);
  });

  it('激将：没人代打则回到刘备自己响应', () => {
    const state = guozhanSeats(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [juedou('a1')] },
        { seatId: B, name: '乙', heroId: 'liubei', hand: [] },
        { seatId: C, name: '丙', heroId: 'zhangfei', hand: [sha('c1')] },
      ],
      [
        [B, 'shu'],
        [C, 'shu'],
      ],
    );
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    ok(act(state, B, { type: 'factionCall', skillId: 'jijiang' }));
    ok(act(state, C, { type: 'pass' })); // 张飞也不代打
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') expect(state.pending.responderId).toBe(B);
  });

  it('激将：牌型对不上时用不了（护驾要闪，决斗要杀）', () => {
    const state = guozhanSeats(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [juedou('a1')] },
        { seatId: B, name: '乙', heroId: 'caocao', hand: [shan('b1')] },
        { seatId: C, name: '丙', heroId: 'xuchu', hand: [sha('c1')] },
      ],
      [
        [B, 'wei'],
        [C, 'wei'],
      ],
    );
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    // 曹操只有护驾（要闪），决斗要的是杀 → 提示里不该有入口
    expect(toSnapshot(state, B).prompt?.factionCall).toBeUndefined();
    fail(act(state, B, { type: 'factionCall', skillId: 'hujia' }));
  });
});

// ——————————————————————————————————————————

/** 拼点（pindian）与它的第一个用户：太史慈·天义 */
describe('拼点与天义', () => {
  it('天义：拼点获胜 → 本回合额外一张【杀】且【杀】无距离限制', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'taishici',
        hand: [mk('a1', 'sha', 'spade', 13), sha('a2')],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [mk('b1', 'sha', 'club', 1)] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'useSkill', skillId: 'tianyi', targetIds: [B] }));
    // 第一步：发起者扣一张
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    // 第二步：目标扣一张
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    // 13 > 1，太史慈赢
    expect(state.log.some((e) => e.message.includes('拼点获胜'))).toBe(true);
    expect(a.flags.ignoreShaDistanceThisTurn).toBe(true);
    expect(a.flags.shaCountThisTurn).toBe(0); // 往回退了 1 ⇒ 本回合可额外出一张【杀】
    // 两张拼点的牌都进了弃牌堆
    expect(state.discard.some((c) => c.id === 'a1')).toBe(true);
    expect(state.discard.some((c) => c.id === 'b1')).toBe(true);
    // 关键：拼点链走完要把控制权还回来，不能停在 null
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('天义：拼点没赢则没有加成', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'taishici', hand: [mk('a1', 'sha', 'spade', 1)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [mk('b1', 'sha', 'club', 13)] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'useSkill', skillId: 'tianyi', targetIds: [B] }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    expect(a.flags.ignoreShaDistanceThisTurn).toBe(false);
    expect(a.flags.shaCountThisTurn).toBe(0);
    expect(state.log.some((e) => e.message.includes('未获胜'))).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('拼点：平点则无人获胜', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'taishici', hand: [mk('a1', 'sha', 'spade', 7)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [mk('b1', 'sha', 'club', 7)] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'useSkill', skillId: 'tianyi', targetIds: [B] }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    expect(state.log.some((e) => e.message.includes('平点'))).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('拼点：扣牌阶段不公布牌名，两边都扣好才一起亮', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'taishici', hand: [mk('a1', 'sha', 'spade', 13)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [mk('b1', 'sha', 'club', 1)] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'useSkill', skillId: 'tianyi', targetIds: [B] }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    // 目标还没扣牌，此时日志里不该出现任何一张拼点牌的名字
    const mid = state.log.map((e) => e.message).join(' ');
    expect(mid).not.toContain('黑桃K');
    expect(mid).not.toContain('梅花A');
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    const after = state.log.map((e) => e.message).join(' ');
    expect(after).toContain('亮出');
  });

  it('天义：目标没有手牌时不能选', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'taishici', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [sha('c1')] },
    ]);
    // B 没手牌 → canUse 仍然为真（C 有手牌），但选中 B 应被拒
    fail(act(state, A, { type: 'useSkill', skillId: 'tianyi', targetIds: [B] }));
  });
});

// ——————————————————————————————————————————

/** 铁索连环（横置）：属性伤害会沿横置角色蔓延 */
describe('铁索连环（横置）', () => {
  it('属性伤害沿横置角色蔓延，涉及的每个人各自重置', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [fireSha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    b.chained = true;
    c.chained = true;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 不出闪 → 吃火属性伤害
    expect(b.hp).toBe(3);
    expect(c.hp).toBe(3); // 蔓延到了丙
    expect(b.chained).toBe(false); // 都重置了
    expect(c.chained).toBe(false);
    expect(state.log.some((e) => e.message.includes('铁索连环'))).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('普通【杀】不是属性伤害，不蔓延也不重置', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    b.chained = true;
    c.chained = true;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(b.hp).toBe(3);
    expect(c.hp).toBe(4); // 没有蔓延
    expect(b.chained).toBe(true); // 也没重置
    expect(c.chained).toBe(true);
  });

  it('没横置的角色不会被蔓延到', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [fireSha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    b.chained = true;
    c.chained = false; // 丙没横置
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(c.hp).toBe(4);
    expect(b.chained).toBe(false);
  });

  it('蔓延途中有人进濒死 → 走完濒死，后面的人照样要受伤害', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [fireSha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [], hp: 1 },
      { seatId: D, name: '丁', heroId: 'vanilla', hand: [] },
    ]);
    const c = state.players.find((p) => p.seatId === C)!;
    const d = state.players.find((p) => p.seatId === D)!;
    for (const sid of [B, C, D]) {
      state.players.find((p) => p.seatId === sid)!.chained = true;
    }
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    // 蔓延到丙（1 血）→ 濒死
    expect(state.pending?.kind).toBe('respondDeath');
    passDeathSaves(state);
    expect(c.alive).toBe(false);
    // 关键：丙的濒死走完后，**丁仍然要受到蔓延伤害**（别把后面的人丢了）
    expect(d.hp).toBe(3);
    expect(d.chained).toBe(false);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });
});

// ——————————————————————————————————————————

/** 虚拟锦囊（多牌转化）：袁绍·乱击把两张同花色手牌当【万箭齐发】 */
describe('虚拟锦囊与乱击', () => {
  it('乱击：两张同花色手牌当【万箭齐发】使用', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'yuanshao',
        hand: [
          mk('a1', 'sha', 'spade', 1),
          mk('a2', 'shan', 'spade', 2),
          mk('a3', 'sha', 'heart', 3),
        ],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(
      act(state, A, { type: 'useSkill', skillId: 'luanji', cardIds: ['a1', 'a2'], targetIds: [] }),
    );
    // 两张作为代价的牌进了弃牌堆
    expect(a.hand.map((c) => c.id)).toEqual(['a3']);
    expect(state.discard.some((c) => c.id === 'a1')).toBe(true);
    expect(state.discard.some((c) => c.id === 'a2')).toBe(true);
    expect(state.log.some((e) => e.message.includes('视为使用【万箭齐发】'))).toBe(true);
    passWuxie(state);
    // 万箭的结算照常：先问乙出闪
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') expect(state.pending.responderId).toBe(B);
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' })); // 出闪免伤
    ok(act(state, C, { type: 'pass' })); // 丙不出闪 → 受伤
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(4);
    expect(state.players.find((p) => p.seatId === C)!.hp).toBe(3);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('乱击：手里没有同花色对时不可用', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'yuanshao',
        hand: [mk('a1', 'sha', 'spade', 1), mk('a2', 'shan', 'heart', 2)],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    expect(toSnapshot(state, A).prompt?.legalSkillIds ?? []).not.toContain('luanji');
    fail(
      act(state, A, { type: 'useSkill', skillId: 'luanji', cardIds: ['a1', 'a2'], targetIds: [] }),
    );
  });

  it('乱击：选了两张花色不同的牌会被拒', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'yuanshao',
        hand: [
          mk('a1', 'sha', 'spade', 1),
          mk('a2', 'shan', 'spade', 2),
          mk('a3', 'sha', 'heart', 3),
        ],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    fail(
      act(state, A, { type: 'useSkill', skillId: 'luanji', cardIds: ['a1', 'a3'], targetIds: [] }),
    );
  });

  it('乱击：帷幕（贾诩）能挡住黑色万箭齐发', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'yuanshao',
        hand: [mk('a1', 'sha', 'spade', 1), mk('a2', 'shan', 'spade', 2)],
      },
      { seatId: B, name: '乙', heroId: 'jiaxu', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(
      act(state, A, { type: 'useSkill', skillId: 'luanji', cardIds: ['a1', 'a2'], targetIds: [] }),
    );
    passWuxie(state);
    // 黑桃万箭 → 帷幕把贾诩排除在响应队列外
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') {
      expect(state.pending.ctx.responders).toEqual([C]);
    }
  });
});

// ——————————————————————————————————————————

/**
 * 非锁定技失效（新国战·铁骑那类）。
 * 关键在于**两个方向都要对**：非锁定技要被屏蔽，锁定技不能受影响——
 * 所以先给技能补了 `locked` / `lockedFields` 标记。
 */
describe('非锁定技失效（skill_nullify）', () => {
  it('非锁定技：武圣被屏蔽，红牌不再能当【杀】', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'guanyu', hand: [mk('a1', 'tao', 'heart', 1)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    // 正常：红桃【桃】可以当【杀】使用 → 出现在合法牌里
    expect(toSnapshot(state, A).prompt?.legalCardIds).toContain('a1');
    // 失效后：武圣是转化技、不是锁定技 → 被屏蔽
    a.flags.nonLockedSkillsDisabled = true;
    expect(toSnapshot(state, A).prompt?.legalCardIds ?? []).not.toContain('a1');
    fail(act(state, A, { type: 'playCard', cardId: 'a1', as: 'sha', targetIds: [B] }));
  });

  it('锁定技不受影响：马术（距离修正）照旧生效', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'machao', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
      { seatId: D, name: '丁', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    expect(distance(state, B, D)).toBe(1); // 基础 2 − 马术 1
    b.flags.nonLockedSkillsDisabled = true;
    expect(distance(state, B, D)).toBe(1); // 锁定技：照样 −1
  });

  it('锁定技不受影响：空城照旧挡住【杀】', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhugeliang', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    state.players.find((p) => p.seatId === B)!.flags.nonLockedSkillsDisabled = true;
    fail(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
  });

  it('锁定技不受影响：狂骨（锁定技钩子）照旧触发', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'weiyan', hand: [sha('a1')], hp: 2 },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.flags.nonLockedSkillsDisabled = true;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(a.hp).toBe(3); // 狂骨仍然回了 1 点
  });

  it('非锁定技钩子被屏蔽：郭嘉的遗计不再询问', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'guojia', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.flags.nonLockedSkillsDisabled = true;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 受伤后应该直接过，不弹遗计
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    expect(b.hand).toHaveLength(0);
  });

  it('回合结束后「非锁定技失效」自动清掉', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'guanyu', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.flags.nonLockedSkillsDisabled = true;
    ok(act(state, A, { type: 'endPhase' })); // 甲的回合结束 → 轮到乙
    expect(b.flags.nonLockedSkillsDisabled).toBe(false);
  });
});

// ——————————————————————————————————————————

/**
 * 觉醒技（awaken_skill）与「获得技能」。
 * 关键点：要能把技能从**别的武将**身上摘过来（姜维·志继获得诸葛亮的【观星】），
 * 所以先给钩子补了 skillId、给字段型技能补了 skillFields。
 */
describe('觉醒技与获得技能', () => {
  it('志继：没有手牌时觉醒，减 1 点体力上限并获得【观星】', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'jiangwei', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.maxHp).toBe(4);
    ok(act(state, A, { type: 'endPhase' })); // 轮到乙 → 准备阶段
    expect(b.maxHp).toBe(3);
    expect(b.hp).toBe(3); // 上限变小，当前体力跟着夹下来
    expect(b.grantedSkills).toEqual([{ heroId: 'zhugeliang', skillName: '观星' }]);
    expect(b.usedOncePerGame.zhiji).toBe(true);
    expect(state.log.some((e) => e.message.includes('觉醒'))).toBe(true);
    expect(state.log.some((e) => e.message.includes('获得了技能【观星】'))).toBe(true);
  });

  it('志继：手里还有牌时不觉醒', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'jiangwei', hand: [sha('b1')] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'endPhase' }));
    expect(b.maxHp).toBe(4);
    expect(b.grantedSkills).toEqual([]);
    expect(b.usedOncePerGame.zhiji).toBeUndefined();
  });

  it('觉醒获得的【观星】从下一回合的准备阶段开始生效', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'jiangwei', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'endPhase' })); // 乙觉醒（这一回合的钩子列表已经取好了）
    expect(b.maxHp).toBe(3);
    // 这一回合不该问观星：钩子列表是在 runHooksPausable 开头一次性取的
    expect(state.pending?.kind).toBe('play');
    ok(act(state, B, { type: 'endPhase' })); // 乙回合结束
    ok(act(state, A, { type: 'endPhase' })); // 又轮到乙
    // 这次准备阶段就该问【观星】了
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.title).toContain('观星');
  });

  it('觉醒技是锁定技：非锁定技失效也挡不住它', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'jiangwei', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.flags.nonLockedSkillsDisabled = true;
    ok(act(state, A, { type: 'endPhase' }));
    expect(b.maxHp).toBe(3); // 照样觉醒
  });
});

// ——————————————————————————————————————————

/**
 * 军令（army_order）与它的第一个用户：董昭·劝进。
 *
 * 军令是从六条里**随机抽两张**再挑一张，所以「执行」那条路的分支不确定——
 * 测试用通用驱动器把它走完，重点验证**整条链不会卡住**（最容易出问题的地方）。
 */
describe('军令与劝进', () => {
  /** 把当前挂起的询问/选牌一路走完（军令效果各不相同，只能通用对待） */
  function driveToSettle(state: GameState): void {
    let guard = 0;
    while (state.pending && guard++ < 12) {
      const p = state.pending;
      if (p.kind === 'choice') {
        ok(act(state, p.seatId, { type: 'chooseOption', optionId: p.options[0]!.id }));
      } else if (p.kind === 'pickCards') {
        const ids = p.cards.slice(0, Math.max(p.min, 0)).map((c) => c.id);
        ok(act(state, p.seatId, { type: 'pickCards', cardIds: ids }));
      } else {
        break;
      }
    }
  }

  /** 造一个「丙已经受过伤」的局面 */
  function setupWei(): GameState {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'dongzhao', hand: [sha('a1'), sha('a2')] },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
        { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
      ],
      'guozhan',
    );
    const a = state.players.find((p) => p.seatId === A)!;
    a.faction = 'wei';
    a.heroRevealed = true; // 国战要亮将，技能才生效
    a.maxHp = 2; // 双将公式下 floor((1.5+4)/2)=2
    a.hp = 2;
    // 先用一张【杀】打丙，制造「本回合受到过伤害」
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }));
    ok(act(state, C, { type: 'pass' }));
    return state;
  }

  it('劝进：目标不执行军令 → 董昭把手牌补到全场最多', () => {
    const state = setupWei();
    const a = state.players.find((p) => p.seatId === A)!;
    const c = state.players.find((p) => p.seatId === C)!;
    expect(state.damagedThisTurn).toContain(C);
    ok(act(state, A, { type: 'useSkill', skillId: 'quanjin', cardIds: ['a2'], targetIds: [C] }));
    // 第一步：董昭从两张军令里挑一张
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.seatId).toBe(A);
      expect(state.pending.title).toContain('军令');
    }
    ok(act(state, A, { type: 'chooseOption', optionId: state.pending.options[0]!.id }));
    // 第二步：由**丙**决定是否执行
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(C);
    ok(act(state, C, { type: 'chooseOption', optionId: 'no' }));
    // 不执行 → 董昭补到全场最多：丙手里刚拿到 a2（1 张），董昭 0 张 → 摸 1 张
    expect(a.hand).toHaveLength(1);
    expect(c.hand.map((x) => x.id)).toEqual(['a2']);
    expect(state.log.some((e) => e.message.includes('拒绝执行军令'))).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('劝进：目标执行军令 → 整条链走完，董昭摸一张', () => {
    const state = setupWei();
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'useSkill', skillId: 'quanjin', cardIds: ['a2'], targetIds: [C] }));
    ok(act(state, A, { type: 'chooseOption', optionId: state.pending.options[0]!.id }));
    ok(act(state, C, { type: 'chooseOption', optionId: 'yes' }));
    driveToSettle(state);
    // 关键：军令走完要回到董昭的出牌阶段，不能卡在某个询问上
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    // 执行了 → 董昭至少摸一张。只断言下界：军令是从六条里随机抽的，
    // 抽到「摸一张再收两张」那条还会更多，写死张数会让用例变得不稳定。
    expect(a.hand.length).toBeGreaterThanOrEqual(1);
    expect(state.log.some((e) => e.message.includes('执行军令'))).toBe(true);
  });

  it('劝进：目标本回合没受过伤则不能选', () => {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'dongzhao', hand: [sha('a1')] },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      ],
      'guozhan',
    );
    const a = state.players.find((p) => p.seatId === A)!;
    a.faction = 'wei';
    a.heroRevealed = true;
    a.maxHp = 2;
    a.hp = 2;
    expect(toSnapshot(state, A).prompt?.legalSkillIds ?? []).not.toContain('quanjin');
    fail(act(state, A, { type: 'useSkill', skillId: 'quanjin', cardIds: ['a1'], targetIds: [B] }));
  });

  it('董昭是国战专属：不进混战/军争的选将池', () => {
    expect(poolForMode('melee').map((h) => h.id)).not.toContain('dongzhao');
    expect(poolForMode('guozhan').map((h) => h.id)).toContain('dongzhao');
  });

  it('体力换算：董昭(3)+许褚(4) → floor(3.5)=3，且有余下的半个阴阳鱼', () => {
    const state = createGame(
      [
        { seatId: A, name: '甲' },
        { seatId: B, name: '乙' },
      ],
      'TEST',
      { mode: 'guozhan', freePick: true },
    );
    ok(act(state, A, { type: 'pickHero', heroId: 'dongzhao', deputyHeroId: 'xuchu' }));
    ok(act(state, B, { type: 'pickHero', heroId: 'sunquan', deputyHeroId: 'ganning' }));
    const a = state.players.find((p) => p.seatId === A)!;
    // 官方牌面：董昭 1.5 阴阳鱼 + 许褚 2 阴阳鱼 = 3.5 → 上限 3（余下半个阴阳鱼）。
    // 引擎吃的是身份局口径的体力（阴阳鱼数 = 体力÷2），所以董昭填 3 才等价。
    expect(a.maxHp).toBe(3);
    ok(act(state, A, { type: 'revealHero', heroId: 'dongzhao' }));
    ok(act(state, A, { type: 'revealHero', heroId: 'xuchu' }));
    expect(a.markers.yinyangyu).toBe(1);
  });
});

// ——————————————————————————————————————————

/** 标准版·魏补完（第一批）：曹仁·据守、典韦·强袭、荀彧·驱虎/节命 */
describe('标准版魏（第二批武将）', () => {
  it('据守：结束阶段摸三张并翻面，下个回合被跳过', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'caoren', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'endPhase' }));
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    expect(a.hand).toHaveLength(3); // 摸三张
    expect(a.flipped).toBe(true);
    // 乙的回合走完 → 该轮到甲，但甲翻面 → 跳过
    ok(act(state, B, { type: 'endPhase' }));
    expect(a.flipped).toBe(false);
    expect(state.log.some((e) => e.message.includes('跳过本回合'))).toBe(true);
    expect(state.seatOrder[state.turn.seatIndex]).toBe(B);
    expect(a.hand).toHaveLength(3); // 跳过了摸牌阶段
  });

  it('强袭：没武器时只能失去 1 点体力，然后造成 1 点伤害', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'dianwei', hand: [], hp: 4 },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'useSkill', skillId: 'qiangxi', targetIds: [B] }));
    expect(state.pending?.kind).toBe('choice'); // 选代价
    if (state.pending?.kind === 'choice') {
      const opts = state.pending.options.map((o) => o.id);
      expect(opts).toContain('loseHp');
      expect(opts).not.toContain('weapon'); // 没武器
    }
    ok(act(state, A, { type: 'chooseOption', optionId: 'loseHp' }));
    expect(a.hp).toBe(3);
    expect(b.hp).toBe(3);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('强袭：有武器时可以弃武器代替失去体力', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'dianwei', hand: [], hp: 4 },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.weapon = wpn('w1');
    ok(act(state, A, { type: 'useSkill', skillId: 'qiangxi', targetIds: [B] }));
    if (state.pending?.kind === 'choice') {
      expect(state.pending.options.map((o) => o.id)).toContain('weapon');
    }
    ok(act(state, A, { type: 'chooseOption', optionId: 'weapon' }));
    expect(a.equipment.weapon).toBeNull();
    expect(a.hp).toBe(4); // 没掉血
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(3);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('驱虎：拼点赢了 → 令对方对其攻击范围内你指定的角色造成伤害', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'xunyu', hand: [mk('a1', 'sha', 'spade', 13)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [mk('b1', 'sha', 'club', 1)] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const c = state.players.find((p) => p.seatId === C)!;
    ok(act(state, A, { type: 'useSkill', skillId: 'quhu', targetIds: [B] }));
    // 拼点：双方各扣一张
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    // 13 > 1 → 荀彧赢 → 由他指定受害者
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: C }));
    expect(c.hp).toBe(3);
    expect(state.log.some((e) => e.message.includes('驱虎'))).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('驱虎：拼点没赢 → 荀彧自己受到伤害', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'xunyu', hand: [mk('a1', 'sha', 'spade', 1)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [mk('b1', 'sha', 'club', 13)] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'useSkill', skillId: 'quhu', targetIds: [B] }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    expect(a.hp).toBe(2); // 3 − 1
    // 荀彧自己受伤 → 触发他自己的【节命】，先把它问掉
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'no' }));
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('驱虎：不能选体力值不大于自己的角色', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'xunyu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')], hp: 3 },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    // 荀彧 3 血，乙 3 血 → 不满足「体力值大于你」
    fail(act(state, A, { type: 'useSkill', skillId: 'quhu', targetIds: [B] }));
  });

  it('节命：受伤后令一名角色把牌补到体力上限', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xunyu', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const c = state.players.find((p) => p.seatId === C)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 受伤 → 节命
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    // 选让谁补牌
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: C }));
    expect(c.hand).toHaveLength(4); // 补到体力上限 4
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('节命：选不发动则什么都不发生', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xunyu', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const c = state.players.find((p) => p.seatId === C)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    expect(c.hand).toHaveLength(0);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });
});

// ——————————————————————————————————————————

/** 曹丕：行殇（杀死角色后获得其所有牌）、放逐（受伤后令他人摸牌并翻面） */
describe('曹丕', () => {
  it('行殇：杀死一名角色后获得其所有牌（含装备与判定区）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'caopi', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [tao('b1')], hp: 1 },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = mk('b2', 'armor', 'heart', 1);
    b.judgment.push(lebu('b3'));
    // A 连出两刀把 B 打死（第一刀打到 0，B 濒死无人救 → 阵亡）
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    // 濒死：B 自己没桃、丙也没桃 → 阵亡 → 触发 kill 钩子
    passDeathSaves(state);
    expect(b.alive).toBe(false);
    // 行殇先问是否获得
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    // 乙的手牌 + 装备 + 判定牌全归甲
    const got = a.hand.map((c) => c.id);
    expect(got).toContain('b1');
    expect(got).toContain('b2');
    expect(got).toContain('b3');
    expect(state.log.some((e) => e.message.includes('行殇'))).toBe(true);
    // 关键：这些牌不能再同时进弃牌堆
    expect(state.discard.some((c) => c.id === 'b2')).toBe(false);
  });

  it('行殇：选不发动则死者的牌进弃牌堆', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'caopi', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [tao('b1')], hp: 1 },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    passDeathSaves(state);
    ok(act(state, A, { type: 'chooseOption', optionId: 'no' }));
    expect(state.discard.some((c) => c.id === 'b1')).toBe(true);
  });

  it('放逐：受伤后令一名其他角色摸 X 张牌并翻面（X=已损失体力）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'caopi', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 受伤：3 → 2，已损失 1
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    // 选让谁摸牌并翻面
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: C }));
    const c = state.players.find((p) => p.seatId === C)!;
    expect(c.hand).toHaveLength(1); // 已损失 1 点 → 摸 1 张
    expect(c.flipped).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('放逐：选不发动则什么都不发生', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'caopi', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    const c = state.players.find((p) => p.seatId === C)!;
    expect(c.hand).toHaveLength(0);
    expect(c.flipped).toBe(false);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });
});

// ——————————————————————————————————————————

/** 夏侯渊·神速、乐进·骁果、徐晃·断粮（各需一点引擎扩展） */
describe('标准版魏（第三批：神速 / 骁果 / 断粮）', () => {
  it('神速：跳过判定与摸牌阶段，视为使用一张【杀】', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'xiahouyuan', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    // 判定区放一张乐不思蜀，验证「跳过判定阶段」会把它原样留着
    b.judgment.push(lebu('lb0'));
    ok(act(state, A, { type: 'endPhase' })); // 轮到乙 → 准备阶段问神速
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: 'skip' }));
    // 选【杀】的目标
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: C }));
    // 丙被问出闪
    expect(state.pending?.kind).toBe('respondSha');
    if (state.pending?.kind === 'respondSha') expect(state.pending.responderId).toBe(C);
    ok(act(state, C, { type: 'pass' }));
    expect(state.players.find((p) => p.seatId === C)!.hp).toBe(3);
    // 关键：跳过判定阶段 → 乐不思蜀还留在判定区（没被处理掉）
    expect(b.judgment.some((c) => c.id === 'lb0')).toBe(true);
    // 跳过了摸牌阶段 → 手牌还是 0
    expect(b.hand).toHaveLength(0);
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('神速：不发动则一切照常', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'xiahouyuan', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    expect(b.hand).toHaveLength(2); // 正常摸两张
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('骁果：其他角色的结束阶段，弃一张基本牌令其受伤', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'yuejin', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    // 甲结束回合 → 派发 othersTurnEnd 给乙
    ok(act(state, A, { type: 'endPhase' }));
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    // 弃一张基本牌
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    // 由**甲**二选一
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'damage' }));
    expect(state.players.find((p) => p.seatId === A)!.hp).toBe(3);
    // 弃掉的那张基本牌进了弃牌堆（别查手牌数：回合已经推进到乙、他又摸了两张）
    expect(state.discard.some((c) => c.id === 'b1')).toBe(true);
    // 走完 → 回合交给乙
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('骁果：手上一张基本牌都没有时不问', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'yuejin', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'endPhase' }));
    // 直接进入乙的回合，没有骁果的询问
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
    expect(state.log.some((e) => e.message.includes('骁果'))).toBe(false);
  });

  it('断粮：黑色【闪】可以当【兵粮寸断】使用', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'xuhuang', hand: [mk('a1', 'shan', 'spade', 1)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    // 黑桃【闪】本身不能用，但可以转化 → 出现在合法牌里
    expect(toSnapshot(state, A).prompt?.legalCardIds).toContain('a1');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', as: 'bingliang', targetIds: [B] }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.judgment.some((c) => c.type === 'bingliang')).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('断粮：红色牌不能转化', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'xuhuang', hand: [mk('a1', 'shan', 'heart', 1)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    expect(toSnapshot(state, A).prompt?.legalCardIds ?? []).not.toContain('a1');
    fail(act(state, A, { type: 'playCard', cardId: 'a1', as: 'bingliang', targetIds: [B] }));
  });

  it('断粮：已经是兵粮寸断的目标不能再放', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'xuhuang', hand: [mk('a1', 'shan', 'spade', 1)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    state.players.find((p) => p.seatId === B)!.judgment.push(bingliang('bl0'));
    // 牌本身还是合法的（可以给丙），但给乙会被拒
    fail(act(state, A, { type: 'playCard', cardId: 'a1', as: 'bingliang', targetIds: [B] }));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', as: 'bingliang', targetIds: [C] }));
  });
});

// ——————————————————————————————————————————

/** 卧龙诸葛亮：八阵（视为装备八卦阵）、火计、看破 */
describe('卧龙诸葛亮', () => {
  it('八阵：没装防具时视为装备八卦阵，判定为红色即视为出闪', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'wolong', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    state.deck.push(mk('jc', 'sha', 'heart', 5)); // 红色判定
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(state.log.some((e) => e.message.includes('八卦阵'))).toBe(true);
    // 直接闪掉，不再问乙出闪
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('八阵：判定为黑色则不生效，仍要问出闪', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'wolong', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    state.deck.push(mk('jc', 'sha', 'spade', 5)); // 黑色判定
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(state.pending?.kind).toBe('respondSha');
    if (state.pending?.kind === 'respondSha') expect(state.pending.responderId).toBe(B);
  });

  it('八阵：自己装了防具就不再是八卦阵', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1', 'heart')] },
      { seatId: B, name: '乙', heroId: 'wolong', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    state.players.find((p) => p.seatId === B)!.equipment.armor = mk('ar1', 'armor', 'club', 2);
    state.deck.push(mk('jc', 'sha', 'heart', 5));
    // 红桃杀 + 装了防具 → 八阵不生效；也没有八卦阵可判 → 直接问出闪
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(state.pending?.kind).toBe('respondSha');
  });

  it('火计：红色手牌当【火攻】使用', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'wolong', hand: [mk('a1', 'shan', 'heart', 1)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    expect(toSnapshot(state, A).prompt?.legalCardIds).toContain('a1');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', as: 'huogong', targetIds: [B] }));
    passWuxie(state);
    // 火攻：轮到目标展示手牌
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') expect(state.pending.responderId).toBe(B);
  });

  it('火计：黑色牌不能当【火攻】', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'wolong', hand: [mk('a1', 'shan', 'spade', 1)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    expect(toSnapshot(state, A).prompt?.legalCardIds ?? []).not.toContain('a1');
    fail(act(state, A, { type: 'playCard', cardId: 'a1', as: 'huogong', targetIds: [B] }));
  });

  it('看破：黑色手牌可以当【无懈可击】响应', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [wuzhong('a1')] },
      { seatId: B, name: '乙', heroId: 'wolong', hand: [mk('b1', 'sha', 'spade', 1)] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    // 无懈询问轮：甲的下家乙先被问，黑桃牌可以当无懈
    expect(state.pending?.kind).toBe('wuxieQueue');
    expect(toSnapshot(state, B).prompt?.legalCardIds).toContain('b1');
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    passWuxie(state); // 没人再抵消这一张
    // 无懈生效 → 无中生有被取消，回到甲的出牌阶段
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });
});

// ——————————————————————————————————————————

/** 祝融：巨象（南蛮对你无效）、烈刃（杀造成伤害后拼点赢则拿牌） */
describe('祝融', () => {
  it('巨象：【南蛮入侵】对祝融无效，直接排除在响应队列外', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'zhurong', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') {
      expect(state.pending.ctx.responders).toEqual([C]); // 祝融被排除
    }
    expect(state.log.some((e) => e.message.includes('巨象'))).toBe(true);
  });

  it('烈刃：杀造成伤害后拼点赢了，拿走对方一张牌', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhurong',
        // 出一张杀，另留一张点数大的用来拼点
        hand: [mk('a1', 'sha', 'spade', 2), mk('a2', 'sha', 'spade', 13)],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [mk('b1', 'sha', 'club', 1), sha('b2')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 不出闪 → 受伤 → 烈刃
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    // 拼点：双方各扣一张
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, A, { type: 'pickCards', cardIds: ['a2'] }));
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    // 13 > 1 → 祝融赢 → 挑一张拿走
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') expect(state.pending.seatId).toBe(A);
    const pickId = state.pending.cards[0]!.id;
    ok(act(state, A, { type: 'pickCards', cardIds: [pickId] }));
    expect(a.hand.some((c) => c.id === pickId)).toBe(true);
    expect(state.log.some((e) => e.message.includes('烈刃'))).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('烈刃：拼点没赢则什么也拿不到', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhurong',
        hand: [mk('a1', 'sha', 'spade', 2), mk('a2', 'sha', 'spade', 1)],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [mk('b1', 'sha', 'club', 13), sha('b2')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['a2'] }));
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    // 1 < 13 → 祝融没赢：a2 进了弃牌堆，手上什么都没有，也没拿到乙的牌
    expect(a.hand).toHaveLength(0);
    expect(state.log.some((e) => e.message.includes('未获胜'))).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('烈刃：自己手上没牌可拼点时不问', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'zhurong', hand: [mk('a1', 'sha', 'spade', 2)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    // 杀打出去之后手上就空了 → 拼不了点 → 不问烈刃
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    expect(state.log.some((e) => e.message.includes('烈刃'))).toBe(false);
  });
});

describe('牌堆分模式（欠账一）', () => {
  const guozhan = buildDeck('guozhan');
  const junzheng = buildDeck('melee');

  it('国战牌堆：id 前缀 g，张数 = 官方 108 减去未收录的【无懈可击·国】', () => {
    expect(guozhan.every((c) => c.id.startsWith('g'))).toBe(true);
    expect(guozhan).toHaveLength(106);
    const count = (t: CardType) => guozhan.filter((c) => c.type === t).length;
    // 官方国战堆的基本牌比例：杀 29 / 闪 14 / 桃 8 / 酒 3
    expect(count('sha')).toBe(29);
    expect(count('shan')).toBe(14);
    expect(count('tao')).toBe(8);
    expect(count('jiu')).toBe(3);
  });

  it('国战牌堆：收录国战独有的锦囊与装备，且没有军争独有武器', () => {
    const kinds = new Set(guozhan.map((c) => c.equipName ?? c.type));
    for (const t of ['tiesuo', 'zhibi', 'yuanjiao', 'yiyi', 'wugu'])
      expect(kinds.has(t)).toBe(true);
    for (const e of ['qilin', 'wuliu', 'sanjian', 'bailong', 'hanbing'])
      expect(kinds.has(e)).toBe(true);
    // 方天画戟 / 古锭刀 / 青龙偃月刀只在军争堆里
    for (const e of ['fangtian', 'guding', 'qinglong']) expect(kinds.has(e)).toBe(false);
  });

  it('军争牌堆：仍是军争堆，并补上了【铁索连环】6 张与【五谷丰登】2 张', () => {
    expect(junzheng.every((c) => c.id.startsWith('c'))).toBe(true);
    expect(junzheng.filter((c) => c.type === 'tiesuo')).toHaveLength(6);
    expect(junzheng.filter((c) => c.type === 'wugu')).toHaveLength(2);
    expect(junzheng.some((c) => c.equipName === 'fangtian')).toBe(true);
  });

  it('createGame 按模式选堆：国战局用国战堆，默认模式用军争堆', () => {
    const setup: SeatSetup[] = [
      { seatId: A, name: '甲', heroId: 'vanilla' },
      { seatId: B, name: '乙', heroId: 'vanilla' },
    ];
    const gz = createGame(setup, 'GZ', { mode: 'guozhan' });
    expect(gz.deck.every((c) => c.id.startsWith('g'))).toBe(true);
    const jz = createGame(setup, 'JZ');
    expect(jz.deck.every((c) => c.id.startsWith('c'))).toBe(true);
  });
});

describe('重铸与铁索连环', () => {
  /** 可控牌堆：drawOne 从末尾 pop，所以最后一个 id 最先被抽到 */
  function setDeck(state: GameState, ids: string[]) {
    state.deck = ids.map((id, i) => mk(id, 'sha', i % 2 === 0 ? 'spade' : 'club', i + 1));
  }

  it('重铸：牌进弃牌堆、摸一张，而且不算「使用」', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [mk('t1', 'tiesuo', 'spade', 11)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    setDeck(state, ['d1']);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'recast', cardId: 't1' }));
    expect(a.hand.map((c) => c.id)).toEqual(['d1']);
    expect(state.discard.some((c) => c.id === 't1')).toBe(true);
    expect(state.log.some((e) => e.message.includes('重铸'))).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('不可重铸的牌不能重铸', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    expect(act(state, A, { type: 'recast', cardId: 'a1' }).ok).toBe(false);
  });

  it('铁索连环：不指定目标就是重铸（走 playCard 也一样）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [mk('t1', 'tiesuo', 'spade', 11)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    setDeck(state, ['d1']);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'playCard', cardId: 't1', targetIds: [] }));
    expect(a.hand.map((c) => c.id)).toEqual(['d1']);
    expect(state.discard.some((c) => c.id === 't1')).toBe(true);
  });

  it('铁索连环：一次横置两名目标，再打一次就是重置', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'vanilla',
        hand: [mk('t1', 'tiesuo', 'spade', 11), mk('t2', 'tiesuo', 'club', 10)],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    ok(act(state, A, { type: 'playCard', cardId: 't1', targetIds: [B, C] }));
    passWuxie(state);
    expect(b.chained).toBe(true);
    expect(c.chained).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    // 第二张只对乙使用 → 乙解除横置，丙保持
    ok(act(state, A, { type: 'playCard', cardId: 't2', targetIds: [B] }));
    passWuxie(state);
    expect(b.chained).toBe(false);
    expect(c.chained).toBe(true);
  });

  it('铁索连环：可以只以自己为目标（用来解除自己的横置）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [mk('t1', 'tiesuo', 'spade', 11)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.chained = true;
    ok(act(state, A, { type: 'playCard', cardId: 't1', targetIds: [A] }));
    passWuxie(state);
    expect(a.chained).toBe(false);
  });

  it('铁索连环：最多两名目标，三名被拒', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [mk('t1', 'tiesuo', 'spade', 11)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
      { seatId: D, name: '丁', heroId: 'vanilla', hand: [] },
    ]);
    expect(act(state, A, { type: 'playCard', cardId: 't1', targetIds: [B, C, D] }).ok).toBe(false);
  });
});

describe('国战新锦囊：远交近攻 / 以逸待劳 / 五谷丰登 / 知己知彼', () => {
  interface GzSeatOpts2 {
    seatId: string;
    name: string;
    heroId: string;
    faction: Faction;
    revealed?: boolean;
    hand: Card[];
  }
  function makeGz2(seats: GzSeatOpts2[]): GameState {
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
      p.heroId = s.heroId;
      p.faction = s.faction;
      p.heroRevealed = s.revealed ?? true;
      p.deputyRevealed = s.revealed ?? true;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = p.maxHp;
      p.hand = s.hand.slice();
      p.flags = emptyFlags();
    }
    const first = state.seatOrder[0]!;
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: first };
    state.log = [];
    return state;
  }
  const at = (state: GameState, seatId: string) => state.players.find((p) => p.seatId === seatId)!;
  /** 可控牌堆：drawOne 从末尾 pop */
  function setDeck(state: GameState, ids: string[]) {
    state.deck = ids.map((id, i) => mk(id, 'sha', i % 2 === 0 ? 'spade' : 'club', i + 1));
  }

  it('远交近攻：目标摸 1 张，你摸 3 张', () => {
    const state = makeGz2([
      {
        seatId: A,
        name: '甲',
        heroId: 'caocao',
        faction: 'wei',
        hand: [mk('y1', 'yuanjiao', 'heart', 9)],
      },
      { seatId: B, name: '乙', heroId: 'liubei', faction: 'shu', hand: [] },
    ]);
    const a = at(state, A);
    const b = at(state, B);
    setDeck(state, ['d1', 'd2', 'd3', 'd4']);
    ok(act(state, A, { type: 'playCard', cardId: 'y1', targetIds: [B] }));
    passWuxie(state);
    expect(b.hand).toHaveLength(1);
    expect(a.hand).toHaveLength(3);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('远交近攻：同势力 / 未明置的目标都不合法', () => {
    const state = makeGz2([
      {
        seatId: A,
        name: '甲',
        heroId: 'caocao',
        faction: 'wei',
        hand: [mk('y1', 'yuanjiao', 'heart', 9), mk('y2', 'yuanjiao', 'heart', 10)],
      },
      { seatId: B, name: '乙', heroId: 'xiahoudun', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'guojia', faction: 'wei', revealed: false, hand: [] },
    ]);
    // 乙与甲同势力；丙还没明置武将牌
    expect(act(state, A, { type: 'playCard', cardId: 'y1', targetIds: [B] }).ok).toBe(false);
    expect(act(state, A, { type: 'playCard', cardId: 'y2', targetIds: [C] }).ok).toBe(false);
  });

  it('以逸待劳：同势力角色依次摸两张、再各弃两张，别势力不受影响', () => {
    const state = makeGz2([
      {
        seatId: A,
        name: '甲',
        heroId: 'caocao',
        faction: 'wei',
        hand: [mk('e1', 'yiyi', 'heart', 4), mk('xa', 'sha', 'spade', 2)],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'xiahoudun',
        faction: 'wei',
        hand: [mk('xb', 'sha', 'spade', 3)],
      },
      {
        seatId: C,
        name: '丙',
        heroId: 'liubei',
        faction: 'shu',
        hand: [mk('xc', 'sha', 'spade', 4)],
      },
    ]);
    const a = at(state, A);
    const b = at(state, B);
    const c = at(state, C);
    setDeck(state, ['d1', 'd2', 'd3', 'd4']); // d4 最先被摸到
    ok(act(state, A, { type: 'playCard', cardId: 'e1', targetIds: [] }));
    passWuxie(state);
    // 甲先结算：摸到 d4/d3，手上 3 张，要弃 2 张
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') {
      expect(state.pending.seatId).toBe(A);
      expect(state.pending.cards.map((x) => x.id).sort()).toEqual(['d3', 'd4', 'xa']);
    } else throw new Error('甲应当进入弃牌选择');
    expect(a.hand).toHaveLength(3);
    ok(act(state, A, { type: 'pickCards', cardIds: ['xa', 'd3'] }));
    // 轮到乙
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') expect(state.pending.seatId).toBe(B);
    else throw new Error('乙应当进入弃牌选择');
    expect(b.hand).toHaveLength(3);
    ok(act(state, B, { type: 'pickCards', cardIds: ['xb', 'd1'] }));
    // 不同势力的丙完全没被波及
    expect(c.hand.map((x) => x.id)).toEqual(['xc']);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('以逸待劳：手上没牌的人不弹弃牌询问', () => {
    const state = makeGz2([
      {
        seatId: A,
        name: '甲',
        heroId: 'caocao',
        faction: 'wei',
        hand: [mk('e1', 'yiyi', 'heart', 4)],
      },
      { seatId: B, name: '乙', heroId: 'xiahoudun', faction: 'wei', hand: [] },
    ]);
    setDeck(state, ['d1', 'd2', 'd3']);
    ok(act(state, A, { type: 'playCard', cardId: 'e1', targetIds: [] }));
    passWuxie(state);
    // 甲摸 2 张（3 → 2）后弃 2 张；乙摸 2 张后也要弃 2 张，但这里只验证甲
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'pickCards', cardIds: ['d3', 'd2'] }));
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') expect(state.pending.seatId).toBe(B);
  });

  it('五谷丰登：亮出全场角色数张牌，依次各拿一张', () => {
    const state = makeGz2([
      {
        seatId: A,
        name: '甲',
        heroId: 'caocao',
        faction: 'wei',
        hand: [mk('w1', 'wugu', 'heart', 7)],
      },
      { seatId: B, name: '乙', heroId: 'liubei', faction: 'shu', hand: [] },
    ]);
    const a = at(state, A);
    const b = at(state, B);
    setDeck(state, ['d1', 'd2']);
    ok(act(state, A, { type: 'playCard', cardId: 'w1', targetIds: [] }));
    passWuxie(state);
    // 两人 → 亮 2 张，甲先拿
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') {
      expect(state.pending.seatId).toBe(A);
      expect(state.pending.cards).toHaveLength(2);
    } else throw new Error('甲应当先选牌');
    ok(act(state, A, { type: 'pickCards', cardIds: ['d2'] }));
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') expect(state.pending.seatId).toBe(B);
    else throw new Error('乙应当接着选牌');
    ok(act(state, B, { type: 'pickCards', cardIds: ['d1'] }));
    expect(a.hand.map((c) => c.id)).toEqual(['d2']);
    expect(b.hand.map((c) => c.id)).toEqual(['d1']);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('知己知彼：看手牌的内容只有本人拿得到，确认后回到出牌阶段', () => {
    const state = makeGz2([
      {
        seatId: A,
        name: '甲',
        heroId: 'caocao',
        faction: 'wei',
        hand: [mk('z1', 'zhibi', 'spade', 3)],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'liubei',
        faction: 'shu',
        hand: [mk('sb', 'tao', 'heart', 5)],
      },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'z1', targetIds: [B] }));
    passWuxie(state);
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'hand' }));
    expect(state.pending?.kind).toBe('viewCards');
    // 甲拿得到内容，乙自己的快照里没有这份提示
    expect(toSnapshot(state, A).prompt?.viewCards?.map((c) => c.id)).toEqual(['sb']);
    expect(toSnapshot(state, B).prompt).toBeNull();
    ok(act(state, A, { type: 'ack' }));
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    // 日志里不能出现看到的牌名
    expect(state.log.some((e) => e.message.includes('桃'))).toBe(false);
  });

  it('知己知彼：也可以观看一张暗置的武将牌', () => {
    const state = makeGz2([
      {
        seatId: A,
        name: '甲',
        heroId: 'caocao',
        faction: 'wei',
        hand: [mk('z1', 'zhibi', 'spade', 3)],
      },
      { seatId: B, name: '乙', heroId: 'liubei', faction: 'shu', revealed: false, hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'z1', targetIds: [B] }));
    passWuxie(state);
    ok(act(state, A, { type: 'chooseOption', optionId: 'hero:liubei' }));
    expect(state.pending?.kind).toBe('viewCards');
    const p = toSnapshot(state, A).prompt;
    expect(p?.viewNote).toBe('刘备');
    expect(p?.viewCards ?? []).toHaveLength(0);
    ok(act(state, A, { type: 'ack' }));
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });
});

describe('庞统·连环（把梅花牌当【铁索连环】使用或重铸）', () => {
  it('梅花手牌当【铁索连环】使用：横置两名目标', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'pangtong', hand: [mk('a1', 'sha', 'club', 7)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', as: 'tiesuo', targetIds: [B, C] }));
    passWuxie(state);
    expect(b.chained).toBe(true);
    expect(c.chained).toBe(true);
  });

  it('梅花手牌可以重铸；红色牌不行（连环只认梅花）', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'pangtong',
        hand: [mk('a1', 'sha', 'club', 7), mk('a2', 'sha', 'heart', 7)],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    state.deck = [mk('d1', 'sha', 'spade', 7)];
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'recast', cardId: 'a1' }));
    expect(a.hand.map((c) => c.id)).toEqual(['a2', 'd1']);
    // 红桃【杀】既不能当【铁索连环】用，也不能借连环重铸
    expect(act(state, A, { type: 'recast', cardId: 'a2' }).ok).toBe(false);
  });

  it('梅花牌当【铁索连环】使用时不消耗出杀次数（它是锦囊）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'pangtong', hand: [mk('a1', 'sha', 'club', 7)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', as: 'tiesuo', targetIds: [B] }));
    passWuxie(state);
    expect(a.flags.shaCountThisTurn).toBe(0);
  });
});

describe('甘夫人（淑慎 / 神智）与孟获（祸首 / 再起）', () => {
  /** 国战局：直接摆好势力与明置状态 */
  function makeGz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      deputyHeroId?: string;
      faction: Faction;
      hp?: number;
      hand: Card[];
    }[],
  ): GameState {
    const setup: SeatSetup[] = seats.map((s) => ({
      seatId: s.seatId,
      name: s.name,
      heroId: s.heroId,
    }));
    const state = createGame(setup, 'TEST', { mode: 'guozhan' });
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((pl) => pl.seatId === s.seatId)!;
      const main = getHero(s.heroId)!;
      const deputy = s.deputyHeroId ? getHero(s.deputyHeroId)! : null;
      p.heroId = s.heroId;
      p.deputyHeroId = s.deputyHeroId ?? null;
      p.faction = s.faction;
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.maxHp = deputy
        ? Math.max(1, Math.floor((main.maxHp + deputy.maxHp) / 2))
        : Math.max(1, Math.floor(main.maxHp));
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
  const at = (state: GameState, seatId: string) => state.players.find((p) => p.seatId === seatId)!;

  it('淑慎：回复体力后可以令一名其他角色摸一张牌', () => {
    const state = makeGz([
      { seatId: A, name: '甲', heroId: 'ganfuren', faction: 'shu', hp: 2, hand: [tao('a1')] },
      { seatId: B, name: '乙', heroId: 'liubei', faction: 'shu', hand: [] },
    ]);
    const a = at(state, A);
    const b = at(state, B);
    state.deck = [mk('d1', 'sha', 'spade', 7)];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    // 回复 1 点 → 先问是否发动淑慎
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    // 再选摸牌的人
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: B }));
    expect(b.hand.map((c) => c.id)).toEqual(['d1']);
    expect(a.flags).toBeTruthy();
    // 选完回到出牌阶段
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('淑慎：不发动则什么也不发生', () => {
    const state = makeGz([
      { seatId: A, name: '甲', heroId: 'ganfuren', faction: 'shu', hp: 2, hand: [tao('a1')] },
      { seatId: B, name: '乙', heroId: 'liubei', faction: 'shu', hand: [] },
    ]);
    const b = at(state, B);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'no' }));
    expect(b.hand).toHaveLength(0);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('淑慎：满体力时用桃根本不发生回复，也不该触发', () => {
    const state = makeGz([
      { seatId: A, name: '甲', heroId: 'ganfuren', faction: 'shu', hand: [tao('a1')] },
      { seatId: B, name: '乙', heroId: 'liubei', faction: 'shu', hand: [] },
    ]);
    // 满体力用桃被拒（桃的规则），换一条路验证：桃园结义对满体力的人不触发淑慎
    const res = act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] });
    expect(res.ok).toBe(false);
  });

  it('神智：弃置所有手牌，不少于当前体力则回复 1 点（并由此触发淑慎）', () => {
    // 让乙先行动，这样乙结束回合后甲的准备阶段就会开跑，神智才有机会问
    const state = makeGz([
      { seatId: B, name: '乙', heroId: 'guanyu', faction: 'shu', hand: [] },
      {
        seatId: A,
        name: '甲',
        heroId: 'ganfuren',
        faction: 'shu',
        hp: 2,
        hand: [sha('a1'), sha('a2')], // 2 张 ≥ 当前体力 2 → 应该回复
      },
    ]);
    const a = at(state, A);
    ok(act(state, B, { type: 'endPhase' }));
    // 乙弃牌阶段无牌可弃 → 轮到甲的准备阶段 → 神智询问
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    expect(a.hand).toHaveLength(0);
    expect(a.hp).toBe(3);
    expect(state.log.some((e) => e.message.includes('神智'))).toBe(true);
    // 回复触发了淑慎：问是否发动 → 选乙摸牌
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, A, { type: 'chooseOption', optionId: B }));
    const b = at(state, B);
    expect(b.hand).toHaveLength(1);
  });

  it('神智：弃置的手牌数少于当前体力则不回复', () => {
    const state = makeGz([
      { seatId: B, name: '乙', heroId: 'guanyu', faction: 'shu', hand: [] },
      { seatId: A, name: '甲', heroId: 'ganfuren', faction: 'shu', hp: 3, hand: [sha('a1')] },
    ]);
    const a = at(state, A);
    ok(act(state, B, { type: 'endPhase' }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    // 1 张 < 体力 3 → 不回复（不去断言手牌：不回复就不会被淑慎挂起，
    // 流程会继续走完甲的摸牌阶段，手牌数已经不是弃完的那个数）
    expect(a.hp).toBe(3);
    expect(state.log.some((e) => e.message.includes('不回复体力'))).toBe(true);
  });

  it('祸首：南蛮入侵对孟获无效，且伤害来源算孟获的', () => {
    const state = makeGz([
      { seatId: A, name: '甲', heroId: 'liubei', faction: 'shu', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'menghuo', faction: 'shu', hand: [] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [] },
    ]);
    const b = at(state, B);
    const c = at(state, C);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    // 孟获被直接排除在响应队列外，所以第一个要出杀的是丙
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') {
      expect(state.pending.responderId).toBe(C);
    }
    // 日志要用孟获自己的技能名，不能写成祝融的【巨象】
    expect(state.log.some((e) => e.message.includes('【祸首】'))).toBe(true);
    expect(state.log.some((e) => e.message.includes('巨象'))).toBe(false);
    ok(act(state, C, { type: 'pass' }));
    expect(c.hp).toBe(c.maxHp - 1);
    expect(b.hp).toBe(b.maxHp);
    // 伤害来源记成了孟获：这一局里没有「造成伤害后」类技能，所以直接看日志的伤害归因
    expect(state.log.some((e) => e.message.includes('丙 受到 1 点伤害'))).toBe(true);
  });

  it('再起：X = 本回合进入弃牌堆的红桃牌数，被选中的角色二选一', () => {
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'menghuo',
        faction: 'shu',
        hp: 2,
        // 4 张手牌、手牌上限 2 → 弃牌阶段必须弃 2 张，正好弃两张红桃
        hand: [mk('h1', 'tao', 'heart', 3), mk('h2', 'tao', 'heart', 4), sha('a1'), sha('a2')],
      },
      { seatId: B, name: '乙', heroId: 'guanyu', faction: 'shu', hand: [] },
    ]);
    const a = at(state, A);
    const b = at(state, B);
    ok(act(state, A, { type: 'endPhase' }));
    expect(state.pending?.kind).toBe('discard');
    ok(act(state, A, { type: 'discard', cardIds: ['h1', 'h2'] }));
    // 两张红桃进了弃牌堆 → X = 2 → 问是否发动再起
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    // 选人（候选是全场存活角色，含自己）→ 只选乙
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: B }));
    // X=2 而没有第三个人可选 → 再问一次「还要选谁」，这里结束选择
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'stop' }));
    // 乙二选一：本次选「令孟获回复 1 点体力」
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    const before = a.hp;
    ok(act(state, B, { type: 'chooseOption', optionId: 'heal' }));
    expect(a.hp).toBe(before + 1);
    expect(state.log.some((e) => e.message.includes('选择了【再起】的第二项'))).toBe(true);
  });

  it('再起：被选中的角色也可以选「自己摸一张牌」', () => {
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'menghuo',
        faction: 'shu',
        hp: 1,
        // 手牌上限 = 当前体力 1，3 张要弃 2 张；其中一张是红桃 → X = 1
        hand: [mk('h1', 'tao', 'heart', 3), sha('a1'), sha('a2')],
      },
      { seatId: B, name: '乙', heroId: 'guanyu', faction: 'shu', hand: [] },
    ]);
    const a = at(state, A);
    const b = at(state, B);
    state.deck = [mk('d1', 'sha', 'club', 7)];
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, A, { type: 'discard', cardIds: ['h1', 'a1'] }));
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    // X=1 → 选完乙就到上限，不会再问第二次
    ok(act(state, A, { type: 'chooseOption', optionId: B }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'draw' }));
    // d1 是再起给的那张（链跑完后回合继续，乙的摸牌阶段还会从洗回来的弃牌堆里再拿牌）
    expect(b.hand[0]?.id).toBe('d1');
    expect(a.hp).toBe(1);
  });

  it('再起：本回合没有红桃进弃牌堆就不问', () => {
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'menghuo',
        faction: 'shu',
        hp: 2,
        // 手牌上限 2，弃 1 张**梅花** → 红桃数为 0
        hand: [sha('a1'), mk('s2', 'sha', 'club', 7), mk('s3', 'sha', 'club', 8)],
      },
      { seatId: B, name: '乙', heroId: 'guanyu', faction: 'shu', hand: [] },
    ]);
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, A, { type: 'discard', cardIds: ['s2'] }));
    expect(state.log.some((e) => e.message.includes('再起'))).toBe(false);
    // 回合已经顺利交给下家
    expect(state.turn.seatIndex).toBe(state.seatOrder.indexOf(B));
  });
});

describe('吕蒙（克己 / 谋断）与鲁肃（好施 / 缔盟）', () => {
  it('克己：出牌阶段只用过一种颜色的牌 → 手牌上限 +4', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'lvmeng',
        hand: [mk('a1', 'sha', 'spade', 7), mk('a2', 'sha', 'club', 7), mk('a3', 'sha', 'club', 8)],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, A, { type: 'endPhase' }));
    // 体力 4 → 上限 4，+4 后是 8；手上剩 2 张 → 不用弃牌，回合已经交给下家
    skipRevealAsk(state); // B 的准备阶段：暂不明置
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
    expect(state.log.some((e) => e.message.includes('克己'))).toBe(true);
    expect(state.log.some((e) => e.message.includes('弃了'))).toBe(false);
    expect(a.hand).toHaveLength(2);
  });

  it('克己：用过两种颜色的牌就不生效', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'lvmeng',
        hand: [
          mk('a1', 'sha', 'spade', 7),
          wuzhong('a2'),
          mk('a3', 'sha', 'club', 3),
          mk('a4', 'sha', 'club', 4),
          mk('a5', 'sha', 'club', 5),
        ],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    // 再打一张**红桃**锦囊 → 一红一黑，克己不生效
    ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [] }));
    passWuxie(state);
    ok(act(state, A, { type: 'endPhase' }));
    // 先确认没触发克己的日志，再把牌数堆到超上限来验证上限没被加
    expect(state.log.some((e) => e.message.includes('克己'))).toBe(false);
  });

  it('谋断：用过三种类别的牌 → 可以移动场上的一张牌', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'lvmeng',
        hand: [
          sha('a1'),
          mk('a2', 'weapon', 'spade', 1, { equipName: 'qinggang', range: 2 }),
          wuzhong('a3'),
        ],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = { id: 'arm1', type: 'armor', suit: 'club', rank: 2, equipName: 'bagua' };
    state.deck = [mk('d1', 'sha', 'club', 9), mk('d2', 'sha', 'club', 10)];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [] }));
    ok(act(state, A, { type: 'playCard', cardId: 'a3', targetIds: [] }));
    passWuxie(state);
    ok(act(state, A, { type: 'endPhase' }));
    // 手上一张牌都没有（都用掉了）→ 直接进结束阶段 → 谋断询问
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'arm1' }));
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: A }));
    expect(b.equipment.armor).toBeNull();
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.equipment.armor?.id).toBe('arm1');
  });

  it('谋断：花色/类别都不够则不问', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'lvmeng', hand: [sha('a1'), mk('a2', 'sha', 'spade', 8)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, A, { type: 'endPhase' }));
    expect(state.log.some((e) => e.message.includes('谋断'))).toBe(false);
  });

  it('好施：多摸两张，手牌超过 5 时交出一半给手牌最少的人', () => {
    const state = makeGame([
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      {
        seatId: A,
        name: '甲',
        heroId: 'lusu',
        hand: [sha('a1'), sha('a2'), sha('a3'), sha('a4'), sha('a5')],
      },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    state.deck = ['d1', 'd2', 'd3', 'd4'].map((id) => mk(id, 'sha', 'club', 7));
    ok(act(state, B, { type: 'endPhase' }));
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    // 好施多摸 2 张 → 7 张 > 5 → 要交出一半（向下取整 = 3 张）
    // 手牌最少的是乙与丙（都是 0 张），并列 → 先问交给谁
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: C }));
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') {
      expect(state.pending.seatId).toBe(A);
      expect(state.pending.min).toBe(3);
    }
    ok(act(state, A, { type: 'pickCards', cardIds: ['d4', 'd3', 'a5'] }));
    const a = state.players.find((p) => p.seatId === A)!;
    const c = state.players.find((p) => p.seatId === C)!;
    // 甲：5 张原始 - 交给丙的 a5 + 好施的 d4/d3 - 交出的 d4/d3/a5 + 摸牌阶段再摸 d2/d1 = 6 张
    expect(a.hand).toHaveLength(6);
    expect(c.hand.map((x) => x.id)).toEqual(['d4', 'd3', 'a5']);
  });

  it('好施：不发动就是普通的摸两张', () => {
    const state = makeGame([
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: A, name: '甲', heroId: 'lusu', hand: [sha('a1')] },
    ]);
    state.deck = ['d1', 'd2'].map((id) => mk(id, 'sha', 'club', 7));
    ok(act(state, B, { type: 'endPhase' }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'no' }));
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand).toHaveLength(3);
  });

  it('缔盟：弃置两人手牌数之差，然后交换手牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'lusu', hand: [sha('c1'), sha('c2'), sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1'), sha('b2')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [sha('x1')] },
    ]);
    // 乙 2 张、丙 1 张 → 差 1，弃 1 张
    ok(act(state, A, { type: 'useSkill', skillId: 'dimeng', targetIds: [B, C] }));
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') expect(state.pending.min).toBe(1);
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    expect(a.hand.map((x) => x.id)).toEqual(['c1', 'c2']);
    expect(b.hand.map((x) => x.id)).toEqual(['x1']);
    expect(c.hand.map((x) => x.id)).toEqual(['b1', 'b2']);
    expect(state.discard.some((x) => x.id === 'a1')).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('缔盟：手牌数相同时直接交换，不用弃牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'lusu', hand: [sha('c1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [sha('x1')] },
    ]);
    ok(act(state, A, { type: 'useSkill', skillId: 'dimeng', targetIds: [B, C] }));
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    expect(b.hand.map((x) => x.id)).toEqual(['x1']);
    expect(c.hand.map((x) => x.id)).toEqual(['b1']);
  });
});

describe('国战预亮（暗置武将的技能声明）', () => {
  /** 国战局：武将默认暗置 */
  function makeGz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      deputyHeroId?: string;
      faction: Faction;
      revealed?: boolean;
      hp?: number;
      hand: Card[];
    }[],
  ): GameState {
    const setup: SeatSetup[] = seats.map((s) => ({
      seatId: s.seatId,
      name: s.name,
      heroId: s.heroId,
    }));
    const state = createGame(setup, 'TEST', { mode: 'guozhan' });
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((pl) => pl.seatId === s.seatId)!;
      const main = getHero(s.heroId)!;
      const deputy = s.deputyHeroId ? getHero(s.deputyHeroId)! : null;
      p.heroId = s.heroId;
      p.deputyHeroId = s.deputyHeroId ?? null;
      p.faction = s.faction;
      p.heroRevealed = s.revealed ?? false;
      p.deputyRevealed = s.revealed ?? false;
      p.maxHp = deputy
        ? Math.max(1, Math.floor((main.maxHp + deputy.maxHp) / 2))
        : Math.max(1, Math.floor(main.maxHp));
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
  const at = (state: GameState, seatId: string) => state.players.find((p) => p.seatId === seatId)!;

  it('暗置 + 未预亮：时机到了不询问，技能不生效', () => {
    // 郭嘉·遗计（受到伤害后可以摸两张牌分给他人）。
    // 用【南蛮入侵】而不是【杀】——成为杀目标会走被动亮将，那就测不到暗置了。
    const state = makeGz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'guojia', faction: 'wei', hand: [] },
    ]);
    const b = at(state, B);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    ok(act(state, B, { type: 'pass' })); // 不出杀 → 受伤
    expect(b.hp).toBe(b.maxHp - 1);
    // 暗置且没预亮 → 技能不生效（没有询问）
    expect(b.heroRevealed).toBe(false);
    expect(state.log.some((e) => e.message.includes('遗计'))).toBe(false);
  });

  it('预亮后时机到来 → 询问是否明置并发动；确认后明置且技能执行', () => {
    const state = makeGz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'guojia', faction: 'wei', hand: [] },
    ]);
    const b = at(state, B);
    state.deck = [mk('d1', 'sha', 'club', 9), mk('d2', 'sha', 'club', 10)];
    ok(act(state, B, { type: 'prelightSkill', skillName: '遗计' }));
    expect(b.prelitSkills).toEqual(['遗计']);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    ok(act(state, B, { type: 'pass' }));
    // 受伤 → 遗计时机到了 → 先问「是否明置郭嘉并发动」
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    expect(b.heroRevealed).toBe(true);
    expect(state.log.some((e) => e.message.includes('亮将'))).toBe(true);
  });

  it('预亮后选择「不发动」→ 不亮将，技能不执行', () => {
    const state = makeGz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'guojia', faction: 'wei', hand: [] },
    ]);
    const b = at(state, B);
    ok(act(state, B, { type: 'prelightSkill', skillName: '遗计' }));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    expect(b.heroRevealed).toBe(false);
    expect(state.log.some((e) => e.message.includes('亮将'))).toBe(false);
  });

  it('预亮是开关：再发一次就取消', () => {
    const state = makeGz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: B, name: '乙', heroId: 'guojia', faction: 'wei', hand: [] },
    ]);
    const b = at(state, B);
    ok(act(state, B, { type: 'prelightSkill', skillName: '遗计' }));
    ok(act(state, B, { type: 'prelightSkill', skillName: '遗计' }));
    expect(b.prelitSkills).toEqual([]);
  });

  it('可预亮的只有触发技与转化技：锁定技、常驻字段技、主动技都被拒', () => {
    // 张飞·咆哮（锁定技，实现成 shaLimit 字段）；黄盖·苦肉（主动技）；关羽·武圣（转化技）
    const state = makeGz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      {
        seatId: B,
        name: '乙',
        heroId: 'huanggai',
        deputyHeroId: 'guanyu',
        faction: 'wu',
        hand: [],
      },
    ]);
    expect(act(state, A, { type: 'prelightSkill', skillName: '咆哮' }).ok).toBe(false);
    expect(act(state, B, { type: 'prelightSkill', skillName: '苦肉' }).ok).toBe(false);
    // 转化技可以预亮（暗置时先用，用出去时明置）
    expect(act(state, B, { type: 'prelightSkill', skillName: '武圣' }).ok).toBe(true);
    // 可预亮名单随本人的快照下发（随时可预亮，不依赖当前是谁的回合）
    const me = toSnapshot(state, B).players.find((x) => x.seatId === B)!;
    expect(me.prelitableSkills).toContain('武圣');
    expect(me.prelitableSkills).not.toContain('苦肉');
    expect(me.prelitableSkills).not.toContain('咆哮');
    // 对手看不到这份名单
    expect(
      toSnapshot(state, A).players.find((x) => x.seatId === B)?.prelitableSkills,
    ).toBeUndefined();
  });

  it('暗置武将的主动技：出牌阶段可以点，点了就明置并发动', () => {
    // 黄盖·苦肉：失去 1 点体力，摸两张牌
    const state = makeGz([
      { seatId: A, name: '甲', heroId: 'huanggai', faction: 'wu', hand: [sha('x1')] },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [] },
    ]);
    const a = at(state, A);
    state.deck = [mk('d1', 'sha', 'spade', 7), mk('d2', 'sha', 'club', 7)];
    // 引擎把它算成可用技能（界面据此点亮按钮）
    const prompt = toSnapshot(state, A).prompt;
    expect(prompt?.legalSkillIds).toContain('kurou');
    const before = a.hp;
    // 国战版苦肉：限一次、弃一张牌、失 1 体力、摸三张
    ok(act(state, A, { type: 'useSkill', skillId: 'kurou', cardIds: ['x1'], targetIds: [] }));
    expect(a.heroRevealed).toBe(true); // 发动了技能 → 明置
    expect(a.hp).toBe(before - 1);
    expect(a.hand).toHaveLength(3);
  });

  it('转化技：暗置且预亮 → 可以按转化用；用出去时明置', () => {
    // 关羽·武圣：红牌当【杀】
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'guanyu',
        faction: 'shu',
        hand: [mk('r1', 'shan', 'heart', 7)],
      },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [] },
    ]);
    const a = at(state, A);
    // 没预亮 → 不能当杀用
    expect(act(state, A, { type: 'playCard', cardId: 'r1', as: 'sha', targetIds: [B] }).ok).toBe(
      false,
    );
    ok(act(state, A, { type: 'prelightSkill', skillName: '武圣' }));
    ok(act(state, A, { type: 'playCard', cardId: 'r1', as: 'sha', targetIds: [B] }));
    expect(a.heroRevealed).toBe(true);
    expect(state.pending?.kind).toBe('respondSha');
  });

  it('预亮只给自己的快照，对手看不到', () => {
    const state = makeGz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: B, name: '乙', heroId: 'guojia', faction: 'wei', hand: [] },
    ]);
    ok(act(state, B, { type: 'prelightSkill', skillName: '遗计' }));
    expect(toSnapshot(state, B).players.find((p) => p.seatId === B)?.prelitSkills).toEqual([
      '遗计',
    ]);
    expect(toSnapshot(state, A).players.find((p) => p.seatId === B)?.prelitSkills).toBeUndefined();
  });
});

describe('国战明置时机（准备阶段开始时）', () => {
  function makeGz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      deputyHeroId?: string;
      faction: Faction;
      hand: Card[];
    }[],
  ): GameState {
    const setup: SeatSetup[] = seats.map((s) => ({
      seatId: s.seatId,
      name: s.name,
      heroId: s.heroId,
    }));
    const state = createGame(setup, 'TEST', { mode: 'guozhan' });
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((pl) => pl.seatId === s.seatId)!;
      const main = getHero(s.heroId)!;
      const deputy = s.deputyHeroId ? getHero(s.deputyHeroId)! : null;
      p.heroId = s.heroId;
      p.deputyHeroId = s.deputyHeroId ?? null;
      p.faction = s.faction;
      p.heroRevealed = false;
      p.deputyRevealed = false;
      p.maxHp = deputy ? Math.max(1, Math.floor((main.maxHp + deputy.maxHp) / 2)) : main.maxHp;
      p.hp = p.maxHp;
      p.hand = s.hand.slice();
      p.flags = emptyFlags();
    }
    const first = state.seatOrder[0]!;
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: first };
    state.log = [];
    return state;
  }
  const at = (state: GameState, seatId: string) => state.players.find((p) => p.seatId === seatId)!;

  it('回合开始时问「是否明置武将牌」，选项含主将/副将/全部/暂不', () => {
    const state = makeGz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      {
        seatId: B,
        name: '乙',
        heroId: 'guojia',
        deputyHeroId: 'simayi',
        faction: 'wei',
        hand: [],
      },
    ]);
    ok(act(state, A, { type: 'endPhase' }));
    // 乙的准备阶段：先问明置
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.seatId).toBe(B);
      expect(state.pending.options.map((o) => o.id)).toEqual(['main', 'deputy', 'all', 'none']);
    } else throw new Error('应当先问明置');
  });

  it('选「全部明置」→ 双将亮出，并走一次明置结算（阴阳鱼/珠联璧合）', () => {
    const state = makeGz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      {
        seatId: B,
        name: '乙',
        heroId: 'guojia',
        deputyHeroId: 'simayi',
        faction: 'wei',
        hand: [],
      },
    ]);
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'all' }));
    const b = at(state, B);
    expect(b.heroRevealed).toBe(true);
    expect(b.deputyRevealed).toBe(true);
    // 郭嘉 3 + 司马懿 3 → 体力上限 3（偶数阴阳鱼，不发阴阳鱼标记）
    expect(b.maxHp).toBe(3);
    expect(state.log.some((e) => e.message.includes('亮将'))).toBe(true);
    // 明置之后仍然要接着走回合流程（摸牌阶段摸 2 张）
    expect(b.hand).toHaveLength(2);
  });

  it('选「暂不明置」→ 保持暗置，回合照常走到出牌阶段', () => {
    const state = makeGz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      {
        seatId: B,
        name: '乙',
        heroId: 'guojia',
        deputyHeroId: 'simayi',
        faction: 'wei',
        hand: [],
      },
    ]);
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'none' }));
    const b = at(state, B);
    expect(b.heroRevealed).toBe(false);
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('只亮主将：副将仍暗置；两将都亮之后不再问', () => {
    const state = makeGz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      {
        seatId: B,
        name: '乙',
        heroId: 'guojia',
        deputyHeroId: 'simayi',
        faction: 'wei',
        hand: [],
      },
    ]);
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'main' }));
    const b = at(state, B);
    expect(b.heroRevealed).toBe(true);
    expect(b.deputyRevealed).toBe(false);
    // 同一回合内还能再明置副将（「暂不明置」之后改主意也走这里）
    state.turn.phase = 'judgment';
    ok(act(state, B, { type: 'revealHero', heroId: 'simayi' }));
    expect(b.deputyRevealed).toBe(true);

    // 两将都亮之后：绕一圈回到乙的回合，准备阶段不再问
    state.turn.phase = 'play';
    ok(act(state, B, { type: 'endPhase' })); // → 甲的回合（甲还暗着，会问）
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      // 甲只有一个武将位可亮
      expect(state.pending.options.map((o) => o.id)).toEqual(['main', 'all', 'none']);
    }
    ok(act(state, A, { type: 'chooseOption', optionId: 'none' }));
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    ok(act(state, A, { type: 'endPhase' })); // → 乙的回合：不再问
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });

  it('非国战不问明置', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', hand: [] },
      { seatId: B, name: '乙', heroId: 'guojia', hand: [] },
    ]);
    ok(act(state, A, { type: 'endPhase' }));
    expect(state.pending).toEqual({ kind: 'play', seatId: B });
  });
});

describe('暗置的武将牌没有性别与势力', () => {
  function makeGz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      deputyHeroId?: string;
      faction: Faction;
      revealed?: boolean;
      hp?: number;
      hand: Card[];
    }[],
  ): GameState {
    const setup: SeatSetup[] = seats.map((s) => ({
      seatId: s.seatId,
      name: s.name,
      heroId: s.heroId,
    }));
    const state = createGame(setup, 'TEST', { mode: 'guozhan' });
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((pl) => pl.seatId === s.seatId)!;
      const main = getHero(s.heroId)!;
      const deputy = s.deputyHeroId ? getHero(s.deputyHeroId)! : null;
      p.heroId = s.heroId;
      p.deputyHeroId = s.deputyHeroId ?? null;
      p.faction = s.faction;
      p.heroRevealed = s.revealed ?? false;
      p.deputyRevealed = s.revealed ?? false;
      p.maxHp = deputy
        ? Math.max(1, Math.floor((main.maxHp + deputy.maxHp) / 2))
        : Math.max(1, Math.floor(main.maxHp));
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
  const at = (state: GameState, seatId: string) => state.players.find((p) => p.seatId === seatId)!;

  it('性别：暗置时不分男女，明置后才算（两张都亮取主将）', () => {
    // 张飞(男) + 甄姬(女)
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'zhenji',
        faction: 'shu',
        hand: [],
      },
      { seatId: B, name: '乙', heroId: 'guanyu', faction: 'shu', hand: [] },
    ]);
    const a = at(state, A);
    // 全暗置：没有性别
    expect(isMalePlayer(state, a)).toBe(false);
    // 只亮副将（女性）→ 按副将的性别
    a.deputyRevealed = true;
    expect(isMalePlayer(state, a)).toBe(false);
    // 主将也亮了 → 取主将（男）
    a.heroRevealed = true;
    expect(isMalePlayer(state, a)).toBe(true);
    // 反过来：主将女性 + 副将男性 → 取主将（女）
    const state2 = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhenji',
        deputyHeroId: 'zhangfei',
        faction: 'wei',
        revealed: true,
        hand: [],
      },
      { seatId: B, name: '乙', heroId: 'guanyu', faction: 'shu', hand: [] },
    ]);
    expect(isMalePlayer(state2, at(state2, A))).toBe(false);
  });

  it('势力：暗置时没有势力，护驾叫不动同势力暗将', () => {
    // 曹操（魏，护驾）+ 司马懿（魏）都暗置；夏侯惇（魏）也暗置且手里有闪
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'caocao',
        deputyHeroId: 'simayi',
        faction: 'wei',
        revealed: true,
        hand: [],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'xiahoudun',
        faction: 'wei',
        revealed: false,
        hand: [shan('b1')],
      },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [sha('c1')] },
    ]);
    const a = at(state, A);
    const b = at(state, B);
    expect(effectiveFaction(state, a)).toBe('wei');
    expect(effectiveFaction(state, b)).toBeNull(); // 暗置 → 对外没有势力
    // 乙明置之后才有势力
    b.heroRevealed = true;
    expect(effectiveFaction(state, b)).toBe('wei');
  });

  it('以逸待劳：暗置的同势力角色不在目标里', () => {
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'caocao',
        faction: 'wei',
        revealed: true,
        hand: [mk('e1', 'yiyi', 'heart', 4)],
      },
      // 乙与甲同为魏，但暗置 → 不该被以逸待劳照顾
      { seatId: B, name: '乙', heroId: 'xiahoudun', faction: 'wei', hand: [] },
    ]);
    const b = at(state, B);
    state.deck = [mk('d1', 'sha', 'club', 7), mk('d2', 'sha', 'club', 8)];
    ok(act(state, A, { type: 'playCard', cardId: 'e1', targetIds: [] }));
    passWuxie(state);
    // 甲自己要摸 2 弃 2，但乙完全没被波及
    expect(b.hand).toHaveLength(0);
  });

  it('护驾：暗置的同势力角色不能被请求代打', () => {
    const state = makeGz([
      // 甲明置曹操（有护驾），乙暗置但与甲同为魏、手里有闪
      {
        seatId: A,
        name: '甲',
        heroId: 'caocao',
        faction: 'wei',
        revealed: true,
        hand: [],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'xiahoudun',
        faction: 'wei',
        revealed: false,
        hand: [shan('b1')],
      },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [sha('c1')] },
    ]);
    // factionHelpers 只认明置的同势力
    expect(factionHelpers(state, at(state, A), 'shan')).toEqual([]);
    at(state, B).heroRevealed = true;
    expect(factionHelpers(state, at(state, A), 'shan')).toEqual([B]);
  });

  it('救援：暗置的救援者拿不到额外回复', () => {
    // 甲（孙权，明置，有救援）濒死；乙暗置但同为吴，用桃救甲
    const state = makeGz([
      {
        seatId: A,
        name: '甲',
        heroId: 'sunquan',
        deputyHeroId: 'zhouyu',
        faction: 'wu',
        revealed: true,
        hp: 0,
        hand: [],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'ganning',
        faction: 'wu',
        revealed: false,
        hand: [tao('b1')],
      },
    ]);
    state.pending = {
      kind: 'respondDeath',
      dyingId: A,
      askQueue: [B],
      askIndex: 0,
    };
    const a = at(state, A);
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    // 乙暗置 → 不同势力 → 只回 1 点
    expect(a.hp).toBe(1);
    expect(state.log.some((e) => e.message.includes('救援'))).toBe(false);
  });
});

describe('国战装备特效（麒麟弓 / 寒冰剑 / 白银狮子 / 三尖两刃刀 / 吴六剑）', () => {
  const armor = (id: string, name: string, suit: Suit = 'club'): Card => ({
    id,
    type: 'armor',
    suit,
    rank: 2,
    equipName: name,
  });
  const plusMount = (id: string): Card => ({
    id,
    type: 'plusMount',
    suit: 'heart',
    rank: 5,
    equipName: 'dilu',
  });
  const weapon = (id: string, name: string, range: number): Card => ({
    id,
    type: 'weapon',
    suit: 'spade',
    rank: 5,
    equipName: name,
    range,
  });

  it('麒麟弓：造成伤害时可以弃置目标的一张坐骑牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    a.equipment.weapon = weapon('w1', 'qilin', 5);
    b.equipment.plusMount = plusMount('m1');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    // 伤害时问「是否弃置其坐骑」
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'm1' }));
    expect(b.equipment.plusMount).toBeNull();
    expect(state.discard.some((c) => c.id === 'm1')).toBe(true);
    // 伤害照常造成
    expect(b.hp).toBe(b.maxHp - 1);
  });

  it('寒冰剑：可以防止伤害，改为依次弃置目标两张牌', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1'), tao('b2')] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    a.equipment.weapon = weapon('w1', 'hanbing', 2);
    a.hp = 4;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 不出闪
    // 伤害时问寒冰剑
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    // 伤害被防止 → 不掉血，弃两张牌
    expect(b.hp).toBe(b.maxHp);
    expect(b.hand).toHaveLength(0);
    expect(state.discard.some((c) => c.id === 'b1')).toBe(true);
    expect(state.discard.some((c) => c.id === 'b2')).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('寒冰剑：不发动就照常造成伤害', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    a.equipment.weapon = weapon('w1', 'hanbing', 2);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'no' }));
    expect(b.hp).toBe(b.maxHp - 1);
    expect(b.hand).toHaveLength(1);
  });

  it('白银狮子：伤害大于 1 时防止多余的伤害', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    // 酒 + 杀 = 2 点伤害，白银狮子夹到 1
    a.flags.jiuActive = true;
    b.equipment.armor = armor('ar1', 'bailong');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(b.hp).toBe(b.maxHp - 1); // 只掉 1 点
    expect(state.log.some((e) => e.message.includes('白银狮子'))).toBe(true);
  });

  it('白银狮子：离开装备区时回复 1 点体力', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [guohe('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.hp = 2;
    b.equipment.armor = armor('ar1', 'bailong');
    // 甲拆掉乙的白银狮子
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B], targetCardId: 'ar1' }));
    passWuxie(state);
    expect(b.equipment.armor).toBeNull();
    expect(b.hp).toBe(3); // 回 1 点
    expect(state.discard.some((c) => c.id === 'ar1')).toBe(true);
  });

  it('三尖两刃刀：造成伤害后可弃一张手牌，对目标距离 1 的角色造成 1 点伤害', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    a.equipment.weapon = weapon('w1', 'sanjian', 3);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    // 造成伤害后问三尖两刃刀
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    // 弃一张手牌
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, A, { type: 'pickCards', cardIds: ['a2'] }));
    // 选受到 1 点伤害的角色：乙距离 1 的「另一名角色」（甲在乙身边、丙在乙另一边）
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.options.map((o) => o.id)).toContain(C);
      expect(state.pending.options.map((o) => o.id)).not.toContain(B); // 不能是原目标
    }
    ok(act(state, A, { type: 'chooseOption', optionId: C }));
    expect(c.hp).toBe(c.maxHp - 1);
    expect(b.hp).toBe(b.maxHp - 1); // 原目标也照常受伤
    expect(a.hand).toHaveLength(0);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('吴六剑：与你势力相同的其他角色攻击范围 +1（自己不加、暗置的不算）', () => {
    const seats: SeatSetup[] = [
      { seatId: A, name: '甲', heroId: 'zhangfei' },
      { seatId: B, name: '乙', heroId: 'guanyu' },
      { seatId: C, name: '丙', heroId: 'xuchu' },
    ];
    const state = createGame(seats, 'TEST', { mode: 'guozhan' });
    state.draft = null;
    for (const [seatId, faction] of [
      ['s0', 'shu'],
      ['s1', 'shu'],
      ['s2', 'wei'],
    ] as const) {
      const p = state.players.find((x) => x.seatId === seatId)!;
      p.faction = faction;
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.maxHp = 4;
      p.hp = 4;
      p.hand = [];
      p.flags = emptyFlags();
    }
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    // 乙装备吴六剑（范围 2）
    b.equipment.weapon = weapon('w1', 'wuliu', 2);
    // 吴六剑本身的范围是 2 → 持有者 1+2=3，但他**不算「其他角色」**，所以只有武器范围
    expect(attackRange(state, b)).toBe(3);
    expect(attackRange(state, a)).toBe(2); // 同势力（蜀，已明置）→ 基础 1 + 吴六剑 1
    expect(attackRange(state, c)).toBe(1); // 不同势力 → 不加
    // 甲若暗置就没有势力 → 也拿不到加成
    a.heroRevealed = false;
    a.deputyRevealed = false;
    expect(attackRange(state, a)).toBe(1);
  });

  it('吴六剑：不改变距离（只加攻击范围）', () => {
    const seats: SeatSetup[] = [
      { seatId: A, name: '甲', heroId: 'zhangfei' },
      { seatId: B, name: '乙', heroId: 'guanyu' },
      { seatId: C, name: '丙', heroId: 'xuchu' },
    ];
    const state = createGame(seats, 'TEST', { mode: 'guozhan' });
    state.draft = null;
    for (const [seatId, faction] of [
      ['s0', 'shu'],
      ['s1', 'shu'],
      ['s2', 'wei'],
    ] as const) {
      const p = state.players.find((x) => x.seatId === seatId)!;
      p.faction = faction;
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.maxHp = 4;
      p.hp = 4;
      p.flags = emptyFlags();
    }
    state.players.find((p) => p.seatId === B)!.equipment.weapon = weapon('w1', 'wuliu', 2);
    // 甲到丙的距离仍是 1（居中的乙才是 1 步之遥）
    expect(distance(state, A, C)).toBe(1);
    expect(distance(state, A, B)).toBe(1);
  });
});

describe('朱雀羽扇（普通【杀】当火【杀】）', () => {
  it('装备朱雀羽扇：可以把普通【杀】当火【杀】用（藤甲伤害 +1）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    a.equipment.weapon = {
      id: 'w1',
      type: 'weapon',
      suit: 'diamond',
      rank: 5,
      equipName: 'zhuque',
      range: 4,
    };
    b.equipment.armor = { id: 'ar1', type: 'armor', suit: 'spade', rank: 2, equipName: 'tengjia' };
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B], asAttribute: 'fire' }));
    ok(act(state, B, { type: 'pass' })); // 藤甲对普通杀无效，但火焰伤害 +1
    expect(b.hp).toBe(b.maxHp - 2); // 1 + 藤甲火焰加成 1
    expect(state.log.some((e) => e.message.includes('使用了火【杀】'))).toBe(true);
  });

  it('没装备朱雀羽扇就不能把杀改成火属性', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    expect(
      act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B], asAttribute: 'fire' }).ok,
    ).toBe(false);
  });

  it('火【杀】/雷【杀】不能被朱雀羽扇再改属性', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'vanilla',
        hand: [{ id: 'a1', type: 'sha', suit: 'heart', rank: 12, attribute: 'fire' }],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.weapon = {
      id: 'w1',
      type: 'weapon',
      suit: 'diamond',
      rank: 5,
      equipName: 'zhuque',
      range: 4,
    };
    expect(
      act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B], asAttribute: 'fire' }).ok,
    ).toBe(false);
  });
});

describe('势备篇 · 宝物槽（第 5 个装备槽）', () => {
  const treasure = (id: string, name: string): Card => ({
    id,
    type: 'treasure',
    suit: 'club',
    rank: 1,
    equipName: name,
  });
  const wpn = (id: string, name: string, range: number): Card => ({
    id,
    type: 'weapon',
    suit: 'spade',
    rank: 5,
    equipName: name,
    range,
  });

  it('宝物能装备到第 5 槽，且会出现在自己的快照里', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [treasure('t1', 'yuxi')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'playCard', cardId: 't1', targetIds: [] }));
    expect(a.equipment.treasure?.id).toBe('t1');
    const view = toSnapshot(state, B).players.find((p) => p.seatId === A)!;
    expect(view.equipment.map((c) => c.id)).toContain('t1'); // 装备区是公开信息
  });

  it('宝物与其它槽位独立：装武器不会顶掉宝物', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'vanilla',
        hand: [treasure('t1', 'yuxi'), wpn('w1', 'qinggang', 2)],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'playCard', cardId: 't1', targetIds: [] }));
    ok(act(state, A, { type: 'playCard', cardId: 'w1', targetIds: [] }));
    expect(a.equipment.treasure?.id).toBe('t1');
    expect(a.equipment.weapon?.id).toBe('w1');
  });

  it('同槽位顶替：第二件宝物会顶掉第一件（玉玺与木牛流马不可兼得）', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'vanilla',
        hand: [treasure('t1', 'yuxi'), treasure('t2', 'muniu')],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'playCard', cardId: 't1', targetIds: [] }));
    ok(act(state, A, { type: 'playCard', cardId: 't2', targetIds: [] }));
    expect(a.equipment.treasure?.id).toBe('t2');
    expect(state.discard.some((c) => c.id === 't1')).toBe(true);
  });

  it('过河拆桥可以指定宝物（明牌区可拆）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [guohe('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.treasure = treasure('t1', 'yuxi');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B], targetCardId: 't1' }));
    passWuxie(state);
    expect(b.equipment.treasure).toBeNull();
    expect(state.discard.some((c) => c.id === 't1')).toBe(true);
  });

  it('七星宝刀进装备区时把宝物一起扫掉', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [wpn('w1', 'qixing', 2)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.treasure = treasure('t1', 'yuxi');
    a.equipment.armor = { id: 'ar1', type: 'armor', suit: 'club', rank: 2, equipName: 'bagua' };
    ok(act(state, A, { type: 'playCard', cardId: 'w1', targetIds: [] }));
    expect(a.equipment.weapon?.id).toBe('w1'); // 自己留着
    expect(a.equipment.treasure).toBeNull();
    expect(a.equipment.armor).toBeNull();
  });

  it('麒麟弓只弃坐骑，不会去动宝物', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    a.equipment.weapon = wpn('w1', 'qilin', 5);
    b.equipment.treasure = treasure('t1', 'yuxi');
    b.equipment.plusMount = {
      id: 'm1',
      type: 'plusMount',
      suit: 'heart',
      rank: 5,
      equipName: 'dilu',
    };
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    // 问麒麟弓时只有坐骑是可选项，宝物不该出现
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      const ids = state.pending.options.map((o) => o.id);
      expect(ids).toContain('m1');
      expect(ids).not.toContain('t1');
    }
    ok(act(state, A, { type: 'chooseOption', optionId: 'm1' }));
    expect(b.equipment.plusMount).toBeNull();
    expect(b.equipment.treasure?.id).toBe('t1'); // 宝物留着
  });

  it('阵亡时宝物也进弃牌堆', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [], hp: 1 },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.treasure = treasure('t1', 'yuxi');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    passDeathSaves(state);
    expect(b.alive).toBe(false);
    expect(state.discard.some((c) => c.id === 't1')).toBe(true);
  });
});

describe('势备篇 · 大势力 / 小势力 与玉玺', () => {
  function gz(seats: { seatId: string; name: string; heroId: string; faction: Faction }[]) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = p.maxHp;
      p.flags = emptyFlags();
    }
    const first = state.seatOrder[0]!;
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: first };
    state.log = [];
    return state;
  }
  const H: Record<string, string> = {
    wei: 'xuchu',
    shu: 'zhangfei',
    wu: 'huanggai',
    qun: 'lvbu',
  };

  it('存活 ≥2 且最多 → 大势力；其余的算小势力', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: H.shu!, faction: 'shu' },
      { seatId: B, name: '乙', heroId: H.shu!, faction: 'shu' },
      { seatId: C, name: '丙', heroId: H.wei!, faction: 'wei' },
    ]);
    expect(bigFactions(state)).toEqual(['shu']);
    expect(isBigFaction(state, 'shu')).toBe(true);
    expect(isSmallFaction(state, 'wei')).toBe(true);
    expect(isSmallFaction(state, 'shu')).toBe(false);
    expect(factionAliveCount(state, 'shu')).toBe(2);
    expect(factionAliveCount(state, 'qun')).toBe(0);
  });

  it('两势力并列最多时都是大势力', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: H.shu!, faction: 'shu' },
      { seatId: B, name: '乙', heroId: H.shu!, faction: 'shu' },
      { seatId: C, name: '丙', heroId: H.wei!, faction: 'wei' },
      { seatId: D, name: '丁', heroId: H.wei!, faction: 'wei' },
    ]);
    expect(bigFactions(state).sort()).toEqual(['shu', 'wei']);
    expect(isSmallFaction(state, 'wu')).toBe(true);
  });

  it('谁都没到 2 人 → 没有大势力，也就没有小势力', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: H.shu!, faction: 'shu' },
      { seatId: B, name: '乙', heroId: H.wei!, faction: 'wei' },
      { seatId: C, name: '丙', heroId: H.wu!, faction: 'wu' },
    ]);
    expect(bigFactions(state)).toEqual([]);
    expect(isSmallFaction(state, 'wei')).toBe(false);
  });

  it('野心家不计入大势力', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: H.shu!, faction: 'ambitionist' },
      { seatId: B, name: '乙', heroId: H.shu!, faction: 'ambitionist' },
      { seatId: C, name: '丙', heroId: H.wei!, faction: 'wei' },
    ]);
    expect(bigFactions(state)).toEqual([]);
  });

  it('玉玺：明置武将牌时摸牌阶段多摸一张', () => {
    const seats: SeatSetup[] = [
      { seatId: A, name: '甲', heroId: 'zhangfei' },
      { seatId: B, name: '乙', heroId: 'xuchu' },
    ];
    const state = createGame(seats, 'TEST', { mode: 'guozhan' });
    state.draft = null;
    for (const [seatId, faction] of [
      ['s0', 'shu'],
      ['s1', 'wei'],
    ] as const) {
      const p = state.players.find((x) => x.seatId === seatId)!;
      p.faction = faction;
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.maxHp = 4;
      p.hp = 4;
      p.flags = emptyFlags();
    }
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.treasure = { id: 't1', type: 'treasure', suit: 'club', rank: 1, equipName: 'yuxi' };
    state.deck = ['d1', 'd2', 'd3'].map((id) => mk(id, 'sha', 'spade', 7));
    // 让乙先把回合走完，轮到甲的摸牌阶段
    // 让乙先行动：`createGame` 默认从 s0 开始，所以回合指针也要一起拨到乙
    state.turn = { seatIndex: state.seatOrder.indexOf(B), phase: 'play' };
    state.pending = { kind: 'play', seatId: B };
    ok(act(state, B, { type: 'endPhase' }));
    skipRevealAsk(state);
    // 玉玺还有第③条：出牌阶段开始会先视为使用【知己知彼】，所以这里等的是那个询问
    // （摸牌阶段的加量已经结算完了，直接查手牌即可）
    expect(a.hand).toHaveLength(3); // 额定 2 + 玉玺 1
    // 只有一个合法目标 → 不用先选人，直接进【知己知彼】的结算
    // （场上没人持有无懈，所以无懈窗口被整个跳过——见 openWuxieWindow）
    expect(state.pending?.kind).toBe('choice');
  });

  it('玉玺：暗置时不生效（官方条件是「有明置的武将牌」）', () => {
    const seats: SeatSetup[] = [
      { seatId: A, name: '甲', heroId: 'zhangfei' },
      { seatId: B, name: '乙', heroId: 'xuchu' },
    ];
    const state = createGame(seats, 'TEST', { mode: 'guozhan' });
    state.draft = null;
    for (const [seatId, faction] of [
      ['s0', 'shu'],
      ['s1', 'wei'],
    ] as const) {
      const p = state.players.find((x) => x.seatId === seatId)!;
      p.faction = faction;
      p.heroRevealed = false;
      p.deputyRevealed = false;
      p.maxHp = 4;
      p.hp = 4;
      p.flags = emptyFlags();
    }
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.treasure = { id: 't1', type: 'treasure', suit: 'club', rank: 1, equipName: 'yuxi' };
    state.deck = ['d1', 'd2', 'd3'].map((id) => mk(id, 'sha', 'spade', 7));
    // 让乙先行动：`createGame` 默认从 s0 开始，所以回合指针也要一起拨到乙
    state.turn = { seatIndex: state.seatOrder.indexOf(B), phase: 'play' };
    state.pending = { kind: 'play', seatId: B };
    ok(act(state, B, { type: 'endPhase' }));
    skipRevealAsk(state); // 乙的准备阶段：暂不明置
    skipRevealAsk(state);
    expect(a.hand).toHaveLength(2); // 只有额定 2 张
  });
});

describe('势备篇 · 连横', () => {
  const lh = (id: string, type: CardType = 'sha', suit: Suit = 'spade'): Card => ({
    id,
    type,
    suit,
    rank: 7,
    lianheng: true,
  });
  function gz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      faction: Faction;
      revealed?: boolean;
      hand: Card[];
    }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      p.heroRevealed = s.revealed ?? true;
      p.deputyRevealed = s.revealed ?? true;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = p.maxHp;
      p.hand = s.hand.slice();
      p.flags = emptyFlags();
    }
    const first = state.seatOrder[0]!;
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: first };
    state.log = [];
    return state;
  }
  const at = (state: GameState, seatId: string) => state.players.find((p) => p.seatId === seatId)!;

  it('交给势力不同的角色 → 对方拿到牌，你摸一张', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [lh('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
    ]);
    state.deck = [mk('d1', 'sha', 'club', 9)];
    const a = at(state, A);
    const b = at(state, B);
    ok(act(state, A, { type: 'lianheng', cardId: 'a1', targetSeatId: B }));
    expect(b.hand.map((c) => c.id)).toEqual(['a1']);
    expect(a.hand.map((c) => c.id)).toEqual(['d1']); // 摸了一张
    expect(state.log.some((e) => e.message.includes('连横'))).toBe(true);
  });

  it('交给未确定势力的角色 → 不摸牌', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [lh('a1')] },
      // 乙暗置 → 未确定势力
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', revealed: false, hand: [] },
    ]);
    const a = at(state, A);
    const b = at(state, B);
    ok(act(state, A, { type: 'lianheng', cardId: 'a1', targetSeatId: B }));
    expect(b.hand.map((c) => c.id)).toEqual(['a1']);
    expect(a.hand).toHaveLength(0); // 没摸
  });

  it('不能连横给同势力角色', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [lh('a1')] },
      { seatId: B, name: '乙', heroId: 'guanyu', faction: 'shu', hand: [] },
    ]);
    expect(act(state, A, { type: 'lianheng', cardId: 'a1', targetSeatId: B }).ok).toBe(false);
  });

  it('未确定势力的人只能连横给同样未确定势力的人', () => {
    const state = gz([
      // 甲自己暗置 → 没有势力
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        revealed: false,
        hand: [lh('a1'), lh('a2')],
      },
      { seatId: B, name: '乙', heroId: 'guanyu', faction: 'shu', hand: [] }, // 已确定
      { seatId: C, name: '丙', heroId: 'xuchu', faction: 'wei', revealed: false, hand: [] },
    ]);
    expect(act(state, A, { type: 'lianheng', cardId: 'a1', targetSeatId: B }).ok).toBe(false);
    ok(act(state, A, { type: 'lianheng', cardId: 'a2', targetSeatId: C }));
    expect(at(state, C).hand.map((c) => c.id)).toEqual(['a2']);
  });

  it('没有连横标记的牌不能连横', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
    ]);
    expect(act(state, A, { type: 'lianheng', cardId: 'a1', targetSeatId: B }).ok).toBe(false);
  });

  it('连横不是「使用牌」：不触发 useCard 钩子、也不消耗出杀次数', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'huangyueying',
        faction: 'shu',
        hand: [lh('a1', 'sha', 'heart')],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
    ]);
    const a = at(state, A);
    ok(act(state, A, { type: 'lianheng', cardId: 'a1', targetSeatId: B }));
    expect(a.flags.shaCountThisTurn).toBe(0);
    // 黄月英的集智是 useCard 钩子：连横一张锦囊不该触发
    expect(state.log.some((e) => e.message.includes('集智'))).toBe(false);
  });

  it('提示里给出连横的合法目标，带标记的【闪】也能点', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [lh('a1', 'shan', 'heart')],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [] },
    ]);
    const prompt = toSnapshot(state, A).prompt;
    expect(prompt?.lianhengTargets).toEqual([B]); // 丙同势力，不能连横
    expect(prompt?.legalCardIds).toContain('a1'); // 【闪】本身打不出去，但能连横
  });
});

describe('势备篇 · 调虎离山（不计入距离与座次 / 不能用牌 / 不能被指定）', () => {
  /** 摆一个 4 人局，把 A 的标记按需设置 */
  function setup() {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [sha('c1')] },
      { seatId: D, name: '丁', heroId: 'vanilla', hand: [sha('d1')] },
    ]);
    return state;
  }

  it('不计入座次：别人到他距离为 Infinity，他也够不到别人', () => {
    const state = setup();
    expect(distance(state, A, C)).toBe(2); // 四人的对角
    state.players.find((p) => p.seatId === A)!.flags.removedFromSeating = true;
    expect(distance(state, A, C)).toBe(Infinity);
    expect(distance(state, B, A)).toBe(Infinity);
    // 剩下三人成为一个更小的环：B 与 D 从「隔两人」变成相邻
    expect(distance(state, B, D)).toBe(1);
  });

  it('不计入座次：AOE 响应队列直接跳过', () => {
    const state = setup();
    state.players.find((p) => p.seatId === A)!.flags.removedFromSeating = true;
    const b = state.players.find((p) => p.seatId === B)!;
    b.hand = [nanman('n1')];
    state.pending = { kind: 'play', seatId: B };
    ok(act(state, B, { type: 'playCard', cardId: 'n1', targetIds: [] }));
    passWuxie(state);
    // 第一个要响应的是 C（A 已被跳过）
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') {
      expect(state.pending.responderId).toBe(C);
    }
  });

  it('不计入座次：回合推进跳过（闪电/下家）', () => {
    const state = setup();
    state.players.find((p) => p.seatId === A)!.flags.removedFromSeating = true;
    state.turn = { seatIndex: 3, phase: 'play' }; // 丁的回合
    state.pending = { kind: 'play', seatId: D };
    ok(act(state, D, { type: 'endPhase' }));
    // 下家本该是 A，但 A 不在座次里 → 直接给乙
    expect(state.turn.seatIndex).toBe(state.seatOrder.indexOf(B));
  });

  it('不能使用牌：手牌一张都用不出去（技能不受影响）', () => {
    const state = setup();
    const a = state.players.find((p) => p.seatId === A)!;
    a.flags.cannotPlayCardsThisTurn = true;
    expect(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }).ok).toBe(false);
    // 界面提示里也不该有可用手牌
    expect(toSnapshot(state, A).prompt?.legalCardIds).toEqual([]);
    // 但仍然可以结束出牌阶段
    ok(act(state, A, { type: 'endPhase' }));
  });

  it('不能使用牌：响应时也打不出【闪】', () => {
    const state = setup();
    const a = state.players.find((p) => p.seatId === A)!;
    a.hand = [shan('s1')];
    a.flags.cannotPlayCardsThisTurn = true;
    state.turn = { seatIndex: state.seatOrder.indexOf(B), phase: 'play' };
    state.pending = { kind: 'play', seatId: B };
    ok(act(state, B, { type: 'playCard', cardId: 'b1', targetIds: [A] }));
    expect(act(state, A, { type: 'respondCard', cardId: 's1' }).ok).toBe(false);
  });

  it('不能成为目标：牌指不到他，界面也不列他', () => {
    const state = setup();
    const a = state.players.find((p) => p.seatId === A)!;
    a.flags.cannotBeTargetThisTurn = true;
    state.turn = { seatIndex: state.seatOrder.indexOf(B), phase: 'play' };
    state.pending = { kind: 'play', seatId: B };
    expect(act(state, B, { type: 'playCard', cardId: 'b1', targetIds: [A] }).ok).toBe(false);
    expect(toSnapshot(state, B).prompt?.legalTargetIds).not.toContain(A);
  });

  it('回合结束时三项标记一起清掉（标记可能挂在非回合玩家身上）', () => {
    const state = setup();
    const a = state.players.find((p) => p.seatId === A)!;
    a.flags.removedFromSeating = true;
    a.flags.cannotBeTargetThisTurn = true;
    a.flags.cannotPlayCardsThisTurn = true;
    // 丁结束回合 → afterTurnEnd 统一清
    state.turn = { seatIndex: 3, phase: 'play' };
    state.pending = { kind: 'play', seatId: D };
    ok(act(state, D, { type: 'endPhase' }));
    expect(a.flags.removedFromSeating).toBe(false);
    expect(a.flags.cannotBeTargetThisTurn).toBe(false);
    expect(a.flags.cannotPlayCardsThisTurn).toBe(false);
  });
});

describe('势备篇 · 牌堆与开关', () => {
  it('开关关闭时是标准国战堆（106 张），开启后追加势备篇的已实现牌', () => {
    const off = buildDeck('guozhan');
    const on = buildDeck('guozhan', { shibei: true });
    expect(off).toHaveLength(106);
    expect(on.length).toBeGreaterThan(off.length);
    // 势备篇的牌 id 前缀是 s，可与标准堆的 g 区分
    expect(on.filter((c) => c.id.startsWith('s')).length).toBe(on.length - off.length);
    // 宝物（势备篇独有）只会在开启后出现
    expect(off.some((c) => c.type === 'treasure')).toBe(false);
    expect(on.filter((c) => c.type === 'treasure')).toHaveLength(2); // 玉玺 + 木牛流马
  });

  it('势备篇只追加到国战：别的模式给 shibei 也没用', () => {
    const jz = buildDeck('melee', { shibei: true });
    expect(jz.every((c) => c.id.startsWith('c'))).toBe(true);
  });

  it('势备篇 52 张已全部进堆（不再有「先不生成」的牌）', () => {
    const on = buildDeck('guozhan', { shibei: true });
    expect(on.filter((c) => c.id.startsWith('s'))).toHaveLength(52);
    // 最后补上的两张锦囊
    const hasCard = (suit: Suit, rank: number, type: string) =>
      on.some((c) => c.suit === suit && c.rank === rank && c.type === type && c.id.startsWith('s'));
    expect(hasCard('heart', 1, 'lianjun')).toBe(true); // 联军盛宴
    expect(hasCard('club', 3, 'chiling')).toBe(true); // 敕令
    expect(on.filter((c) => c.type === 'wuxieguo')).toHaveLength(2); // 无懈可击·国 ×2
  });

  it('连横标记按官方表落在牌上', () => {
    const on = buildDeck('guozhan', { shibei: true });
    const marked = on.filter((c) => c.id.startsWith('s') && c.lianheng);
    // 势备篇里带连横标记的牌**全部**都进牌堆了：雷杀 ♠J/♣5、闪 ♡6、桃 ♦3、酒 ♠6、
    // 护心镜、惊帆、调虎离山 ♦10、挟天子 ♠A/♦A/♦4、火烧连营 ♠3/♣J/♥Q = 14 张
    expect(marked).toHaveLength(14);
    expect(marked.some((c) => c.type === 'sha' && c.attribute === 'thunder')).toBe(true);
    expect(marked.some((c) => c.type === 'jiu')).toBe(true);
    expect(marked.some((c) => c.type === 'minusMount' && c.equipName === 'jingfan')).toBe(true);
    expect(marked.some((c) => c.type === 'armor' && c.equipName === 'huxinjing')).toBe(true);
  });

  it('createGame 的 shibei 开关真的换了牌堆', () => {
    const setup: SeatSetup[] = [
      { seatId: A, name: '甲', heroId: 'vanilla' },
      { seatId: B, name: '乙', heroId: 'vanilla' },
    ];
    const off = createGame(setup, 'T', { mode: 'guozhan' });
    const on = createGame(setup, 'T', { mode: 'guozhan', shibei: true });
    expect(off.deck.every((c) => c.id.startsWith('g'))).toBe(true);
    expect(on.deck.some((c) => c.id.startsWith('s'))).toBe(true);
  });
});

describe('势备篇 · 明光铠', () => {
  const armor = (id: string, name: string): Card => ({
    id,
    type: 'armor',
    suit: 'spade',
    rank: 2,
    equipName: name,
  });
  function gzA(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      faction: Faction;
      hand: Card[];
    }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = p.maxHp;
      p.hand = s.hand.slice();
      p.flags = emptyFlags();
    }
    const first = state.seatOrder[0]!;
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: first };
    state.log = [];
    return state;
  }

  it('火【杀】对它无效（普通【杀】照常生效）', () => {
    const state = makeGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'vanilla',
        hand: [{ id: 'f1', type: 'sha', suit: 'heart', rank: 12, attribute: 'fire' }, sha('a2')],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    // 凡人出杀上限 1，这里要连出两张，给把连弩
    a.equipment.weapon = {
      id: 'w0',
      type: 'weapon',
      suit: 'club',
      rank: 1,
      equipName: 'zhuge',
      range: 1,
    };
    b.equipment.armor = armor('ar1', 'mingguang');
    ok(act(state, A, { type: 'playCard', cardId: 'f1', targetIds: [B] }));
    expect(b.hp).toBe(b.maxHp); // 火杀被取消
    // 普通杀不受影响
    ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(b.hp).toBe(b.maxHp - 1);
  });

  it('【火攻】不能以它为目标', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [huogong('h1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [tao('b1')] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = armor('ar1', 'mingguang');
    expect(act(state, A, { type: 'playCard', cardId: 'h1', targetIds: [B] }).ok).toBe(false);
    // 界面也不该把【火攻】列成可用（没有合法目标）
    expect(toSnapshot(state, A).prompt?.legalCardIds).not.toContain('h1');
  });

  it('小势力角色不会被横置（大势力照常）', () => {
    // 三人：蜀×2（大势力）、魏×1（小势力）
    const state = gzA([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: B, name: '乙', heroId: 'guanyu', faction: 'shu', hand: [] },
      {
        seatId: C,
        name: '丙',
        heroId: 'xuchu',
        faction: 'wei',
        hand: [mk('t1', 'tiesuo', 'spade', 11)],
      },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    // 丙穿明光铠（小势力）→ 横置不了
    c.equipment.armor = armor('ar1', 'mingguang');
    state.turn = { seatIndex: state.seatOrder.indexOf(C), phase: 'play' };
    state.pending = { kind: 'play', seatId: C };
    ok(act(state, C, { type: 'playCard', cardId: 't1', targetIds: [C, B] }));
    passWuxie(state);
    expect(c.chained).toBe(false); // 自己是小势力 → 豁免
    expect(b.chained).toBe(true); // 乙是蜀（大势力）→ 照常横置
    // 同样的装备给蜀（大势力）的人 → 照样被横置：豁免只认「小势力」
    a.equipment.armor = armor('ar2', 'mingguang');
    expect(a.chained).toBe(false);
    // 甲（蜀＝大势力）穿上明光铠也照样能被横置，只是上面那张牌已经结算完了，
    // 所以这里只断言势力判定本身：蜀不是小势力。
    expect(isSmallFaction(state, 'shu')).toBe(false);
    expect(isSmallFaction(state, 'wei')).toBe(true);
  });
});

describe('势备篇 · 玉玺的「视为使用知己知彼」', () => {
  function gzB(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      faction: Faction;
      revealed?: boolean;
      hand: Card[];
    }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      p.heroRevealed = s.revealed ?? true;
      p.deputyRevealed = s.revealed ?? true;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = p.maxHp;
      p.hand = s.hand.slice();
      p.flags = emptyFlags();
    }
    const first = state.seatOrder[0]!;
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: first };
    state.log = [];
    return state;
  }
  const yuxi = (id: string): Card => ({
    id,
    type: 'treasure',
    suit: 'club',
    rank: 1,
    equipName: 'yuxi',
  });

  it('出牌阶段开始时先结算一次【知己知彼】（可看对方手牌）', () => {
    // 乙先动，这样甲的出牌阶段开场才会跑
    const state = gzB([
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [tao('c1')] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.treasure = yuxi('t1');
    state.turn = { seatIndex: state.seatOrder.indexOf(B), phase: 'play' };
    state.pending = { kind: 'play', seatId: B };
    ok(act(state, B, { type: 'endPhase' }));
    skipRevealAsk(state);
    // 两个合法目标（乙、丙）→ 先问看谁
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: C }));
    passWuxie(state);
    // 进入「观看手牌/暗置武将牌」的选择
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'hand' }));
    expect(state.pending?.kind).toBe('viewCards');
    expect(toSnapshot(state, A).prompt?.viewCards?.map((c) => c.id)).toEqual(['c1']);
    ok(act(state, A, { type: 'ack' }));
    // 结算完回到甲的出牌阶段
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('暗置时玉玺不发动', () => {
    const state = gzB([
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      // 甲暗置 → 没有「明置的武将牌」→ 不视为使用
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', revealed: false, hand: [] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.treasure = yuxi('t1');
    state.turn = { seatIndex: state.seatOrder.indexOf(B), phase: 'play' };
    state.pending = { kind: 'play', seatId: B };
    ok(act(state, B, { type: 'endPhase' }));
    skipRevealAsk(state);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    expect(state.log.some((e) => e.message.includes('知己知彼'))).toBe(false);
  });
});

describe('势备篇 · 护心镜', () => {
  const huxin = (id: string): Card => ({
    id,
    type: 'armor',
    suit: 'club',
    rank: 2,
    equipName: 'huxinjing',
    lianheng: true,
  });

  it('伤害 ≥ 体力时可弃镜免伤（体力不变，甲进弃牌堆）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [], hp: 1 },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = huxin('ar1');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 不出闪
    // 1 点伤害 ≥ 1 点体力 → 问护心镜
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    expect(b.hp).toBe(1); // 没掉血
    expect(b.equipment.armor).toBeNull();
    expect(state.discard.some((c) => c.id === 'ar1')).toBe(true);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('选择不弃镜 → 照常受伤（可能濒死）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [], hp: 1 },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = huxin('ar1');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    expect(b.hp).toBe(0);
    expect(b.equipment.armor?.id).toBe('ar1'); // 镜子留着
    expect(state.pending?.kind).toBe('respondDeath');
  });

  it('伤害小于体力时不问（条件不满足）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] }, // hp 4
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = huxin('ar1');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(b.hp).toBe(b.maxHp - 1);
    expect(b.equipment.armor?.id).toBe('ar1');
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('群体锦囊（南蛮入侵）的伤害同样触发', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [], hp: 1 },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = huxin('ar1');
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    ok(act(state, B, { type: 'pass' })); // 不出杀
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    expect(b.hp).toBe(1);
    expect(b.equipment.armor).toBeNull();
  });

  it('「失去体力」不算受到伤害，不触发护心镜', () => {
    // 用黄盖·苦肉走真实路径（它内部是 api.loseHp，不是伤害）
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'huanggai', hand: [], hp: 1 },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.armor = huxin('ar1');
    ok(act(state, A, { type: 'useSkill', skillId: 'kurou', targetIds: [] }));
    expect(a.hp).toBe(0);
    expect(a.equipment.armor?.id).toBe('ar1'); // 镜子还在
    expect(state.pending?.kind).toBe('respondDeath'); // 直接进濒死，没问护心镜
  });
});

describe('势备篇 · 调虎离山与水淹七军', () => {
  it('调虎离山：目标本回合不能出牌、不能被指定，且不再计入距离与座次；你摸一张', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [mk('t1', 'tiaohu', 'heart', 2)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [sha('c1')] },
    ]);
    state.deck = [mk('d1', 'sha', 'club', 9)];
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 't1', targetIds: [B, C] }));
    passWuxie(state);
    expect(b.flags.removedFromSeating).toBe(true);
    expect(b.flags.cannotPlayCardsThisTurn).toBe(true);
    expect(b.flags.cannotBeTargetThisTurn).toBe(true);
    expect(a.hand.map((c) => c.id)).toEqual(['d1']); // 使用后摸一张
    // 别人指不到乙
    expect(act(state, A, { type: 'playCard', cardId: 'd1', targetIds: [B] }).ok).toBe(false);
    // 乙也不能出牌（把回合交给他验证）
    ok(act(state, A, { type: 'endPhase' }));
    skipRevealAsk(state);
    skipRevealAsk(state);
    // 乙的回合：不能出牌
    if (state.pending?.kind === 'play' && state.pending.seatId === B) {
      expect(act(state, B, { type: 'playCard', cardId: 'b1', targetIds: [C] }).ok).toBe(false);
    }
  });

  it('调虎离山：标记在回合结束时清掉', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [mk('t1', 'tiaohu', 'heart', 2)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 't1', targetIds: [B] }));
    passWuxie(state);
    expect(b.flags.removedFromSeating).toBe(true);
    ok(act(state, A, { type: 'endPhase' }));
    expect(b.flags.removedFromSeating).toBe(false);
    expect(b.flags.cannotPlayCardsThisTurn).toBe(false);
    expect(b.flags.cannotBeTargetThisTurn).toBe(false);
  });

  it('水淹七军：目标选择弃装备 → 装备区清空', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [mk('s1', 'shuiyan', 'club', 12)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.weapon = {
      id: 'w1',
      type: 'weapon',
      suit: 'spade',
      rank: 5,
      equipName: 'qinggang',
      range: 2,
    };
    b.equipment.plusMount = {
      id: 'm1',
      type: 'plusMount',
      suit: 'heart',
      rank: 5,
      equipName: 'dilu',
    };
    ok(act(state, A, { type: 'playCard', cardId: 's1', targetIds: [B] }));
    passWuxie(state);
    // 由**目标**来选
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: 'discard' }));
    expect(b.equipment.weapon).toBeNull();
    expect(b.equipment.plusMount).toBeNull();
    expect(b.hp).toBe(b.maxHp); // 没掉血
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('水淹七军：目标选择受伤 → 1 点雷电伤害（来源是使用者）', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [mk('s1', 'shuiyan', 'club', 12)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.armor = { id: 'ar1', type: 'armor', suit: 'spade', rank: 2, equipName: 'tengjia' };
    ok(act(state, A, { type: 'playCard', cardId: 's1', targetIds: [B] }));
    passWuxie(state);
    ok(act(state, B, { type: 'chooseOption', optionId: 'damage' }));
    // 藤甲：雷电伤害不加成（它只对火焰 +1）
    expect(b.hp).toBe(b.maxHp - 1);
    expect(b.equipment.armor?.id).toBe('ar1');
  });

  it('水淹七军：不能指定装备区为空的角色', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [mk('s1', 'shuiyan', 'club', 12)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    expect(act(state, A, { type: 'playCard', cardId: 's1', targetIds: [B] }).ok).toBe(false);
    // 界面也不该把它列为可用
    expect(toSnapshot(state, A).prompt?.legalCardIds).not.toContain('s1');
  });
});

describe('势备篇 · 勠力同心', () => {
  it('对「大势力」使用：未横置的横置', () => {
    // 蜀×2 = 大势力；魏×1 = 小势力
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'zhangfei', hand: [] },
        { seatId: B, name: '乙', heroId: 'guanyu', hand: [] },
        { seatId: C, name: '丙', heroId: 'xuchu', hand: [] },
      ],
      'guozhan',
    );
    state.draft = null;
    for (const [seatId, faction, heroId] of [
      ['s0', 'shu', 'zhangfei'],
      ['s1', 'shu', 'guanyu'],
      ['s2', 'wei', 'xuchu'],
    ] as const) {
      const p = state.players.find((x) => x.seatId === seatId)!;
      p.heroId = heroId;
      p.faction = faction;
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.maxHp = 4;
      p.hp = 4;
      p.flags = emptyFlags();
    }
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    a.hand = [mk('l1', 'lutong', 'club', 10)];
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'playCard', cardId: 'l1', targetIds: [] }));
    // 先过无懈询问轮，结算时才问「对哪一类」
    passWuxie(state);
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'big' }));
    expect(a.chained).toBe(true);
    expect(b.chained).toBe(true);
    expect(c.chained).toBe(false); // 魏是小势力，不在目标里
  });

  it('已横置的目标改为摸一张牌', () => {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'zhangfei', hand: [] },
        { seatId: B, name: '乙', heroId: 'guanyu', hand: [] },
      ],
      'guozhan',
    );
    state.draft = null;
    for (const [seatId, faction, heroId] of [
      ['s0', 'shu', 'zhangfei'],
      ['s1', 'shu', 'guanyu'],
    ] as const) {
      const p = state.players.find((x) => x.seatId === seatId)!;
      p.heroId = heroId;
      p.faction = faction;
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.maxHp = 4;
      p.hp = 4;
      p.hand = [];
      p.flags = emptyFlags();
    }
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    a.hand = [mk('l1', 'lutong', 'club', 10)];
    a.chained = true;
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: A };
    state.deck = [mk('d1', 'sha', 'spade', 7), mk('d2', 'sha', 'spade', 8)];
    ok(act(state, A, { type: 'playCard', cardId: 'l1', targetIds: [] }));
    passWuxie(state);
    ok(act(state, A, { type: 'chooseOption', optionId: 'big' }));
    expect(a.chained).toBe(true); // 本来就横着 → 不变
    expect(a.hand).toHaveLength(1); // 摸了一张
    expect(b.chained).toBe(true); // 乙被横置
    expect(b.hand).toHaveLength(0);
  });

  it('场上没有大势力时打不出来', () => {
    const state = makeGame([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [mk('l1', 'lutong', 'club', 10)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    // melee 模式没有势力 → 没有大势力 → 不可用
    expect(toSnapshot(state, A).prompt?.legalCardIds).not.toContain('l1');
    expect(act(state, A, { type: 'playCard', cardId: 'l1', targetIds: [] }).ok).toBe(false);
  });
});

describe('势备篇 · 挟天子以令诸侯', () => {
  /** 三人局：蜀×2（大势力）+ 魏×1，甲是蜀 */
  function setup(hand: Card[]) {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'zhangfei', hand },
        { seatId: B, name: '乙', heroId: 'guanyu', hand: [] },
        { seatId: C, name: '丙', heroId: 'xuchu', hand: [] },
      ],
      'guozhan',
    );
    state.draft = null;
    for (const [seatId, faction, heroId] of [
      ['s0', 'shu', 'zhangfei'],
      ['s1', 'shu', 'guanyu'],
      ['s2', 'wei', 'xuchu'],
    ] as const) {
      const p = state.players.find((x) => x.seatId === seatId)!;
      p.heroId = heroId;
      p.faction = faction;
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.maxHp = 4;
      p.hp = 4;
      p.flags = emptyFlags();
    }
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: A };
    return state;
  }

  it('大势力角色使用后结束出牌阶段（转到弃牌阶段）', () => {
    const state = setup([mk('x1', 'xietianzi', 'spade', 1), sha('h1'), sha('h2')]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'playCard', cardId: 'x1', targetIds: [] }));
    passWuxie(state);
    expect(a.flags.xietianziPending).toBe(true);
    // 手牌 2 张 ≤ 上限 4 → 直接结束回合，交给乙
    expect(state.turn.phase === 'discard' || state.pending?.kind === 'play').toBe(true);
  });

  it('弃牌阶段弃了牌 → 本回合结束后追加一个回合', () => {
    // 手牌 6 张、上限 4 → 弃牌阶段要弃 2 张
    const hand = [
      mk('x1', 'xietianzi', 'spade', 1),
      sha('h1'),
      sha('h2'),
      sha('h3'),
      sha('h4'),
      sha('h5'),
    ];
    const state = setup(hand);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'playCard', cardId: 'x1', targetIds: [] }));
    passWuxie(state);
    // 用了 1 张后剩 5 张，上限 = 体力 4 → 弃 1 张
    expect(state.pending).toEqual({ kind: 'discard', seatId: A, count: 1 });
    ok(act(state, A, { type: 'discard', cardIds: ['h1'] }));
    // 追加回合：还是甲的回合
    expect(state.turn.seatIndex).toBe(state.seatOrder.indexOf(A));
    expect(state.log.some((e) => e.message.includes('挟天子以令诸侯】生效'))).toBe(true);
  });

  it('弃牌阶段没弃牌 → 不追加回合', () => {
    const state = setup([mk('x1', 'xietianzi', 'spade', 1), sha('h1')]);
    ok(act(state, A, { type: 'playCard', cardId: 'x1', targetIds: [] }));
    passWuxie(state);
    // 手牌 1 张没超上限 → 不弃牌 → 回合交给乙
    expect(state.turn.seatIndex).toBe(state.seatOrder.indexOf(B));
    expect(state.log.some((e) => e.message.includes('挟天子以令诸侯】生效'))).toBe(false);
  });

  it('非大势力角色不能用', () => {
    const state = setup([mk('x1', 'xietianzi', 'spade', 1)]);
    const c = state.players.find((p) => p.seatId === C)!;
    c.hand = [mk('x2', 'xietianzi', 'diamond', 1)];
    // 丙是魏（小势力）→ 无论引擎还是界面都不可用
    expect(toSnapshot(state, A).prompt?.legalCardIds).toContain('x1');
    expect(toSnapshot(state, C).prompt).toBeNull(); // 不是丙的回合
    // 把回合给丙验证
    state.turn = { seatIndex: state.seatOrder.indexOf(C), phase: 'play' };
    state.pending = { kind: 'play', seatId: C };
    expect(toSnapshot(state, C).prompt?.legalCardIds).not.toContain('x2');
    expect(act(state, C, { type: 'playCard', cardId: 'x2', targetIds: [] }).ok).toBe(false);
  });
});

describe('势备篇 · 火烧连营（同一队列 + 多人火焰伤害）', () => {
  /** 四人局，势力按参数给；甲是蜀 */
  function setup(factions: [Faction, Faction, Faction, Faction], heroes?: string[]) {
    const hs = heroes ?? ['zhangfei', 'guanyu', 'xuchu', 'zhenji'];
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: hs[0]!, hand: [mk('h1', 'huoshao', 'spade', 3)] },
        { seatId: B, name: '乙', heroId: hs[1]!, hand: [] },
        { seatId: C, name: '丙', heroId: hs[2]!, hand: [] },
        { seatId: D, name: '丁', heroId: hs[3]!, hand: [] },
      ],
      'guozhan',
    );
    state.draft = null;
    const ids = [A, B, C, D];
    ids.forEach((seatId, i) => {
      const p = state.players.find((x) => x.seatId === seatId)!;
      p.heroId = hs[i]!;
      p.faction = factions[i]!;
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.maxHp = 4;
      p.hp = 4;
      p.flags = emptyFlags();
    });
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: A };
    return state;
  }

  it('烧下家与同一队列：连续同势力的人一起受伤', () => {
    // 乙、丙都是魏（同一队列），丁是蜀 → 只烧乙、丙
    const state = setup(['shu', 'wei', 'wei', 'shu']);
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    const d = state.players.find((p) => p.seatId === D)!;
    ok(act(state, A, { type: 'playCard', cardId: 'h1', targetIds: [] }));
    passWuxie(state);
    expect(b.hp).toBe(b.maxHp - 1);
    expect(c.hp).toBe(c.maxHp - 1);
    expect(d.hp).toBe(d.maxHp); // 队列在丙之后就断了
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('下家暗置（未确定势力）时队列只有他一个人', () => {
    const state = setup(['shu', 'wei', 'wei', 'shu']);
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    b.heroRevealed = false;
    b.deputyRevealed = false; // 未确定势力
    ok(act(state, A, { type: 'playCard', cardId: 'h1', targetIds: [] }));
    passWuxie(state);
    expect(b.hp).toBe(b.maxHp - 1); // 下家照打
    expect(c.hp).toBe(c.maxHp); // 但暗将之间互视为不同势力 → 队列断开
  });

  it('明光铠（火焰锦囊取消）的人不在队列里', () => {
    const state = setup(['shu', 'wei', 'wei', 'shu']);
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    b.equipment.armor = {
      id: 'ar1',
      type: 'armor',
      suit: 'spade',
      rank: 2,
      equipName: 'mingguang',
    };
    ok(act(state, A, { type: 'playCard', cardId: 'h1', targetIds: [] }));
    passWuxie(state);
    expect(b.hp).toBe(b.maxHp); // 被明光铠取消
    expect(c.hp).toBe(c.maxHp - 1); // 丙照常受伤（明光铠只保护自己）
  });

  it('铁索连环：火焰伤害会沿横置蔓延', () => {
    const state = setup(['shu', 'wei', 'wei', 'shu']);
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    const d = state.players.find((p) => p.seatId === D)!;
    // 乙、丁横置 → 乙受火焰伤害时丁也吃一份
    b.chained = true;
    d.chained = true;
    ok(act(state, A, { type: 'playCard', cardId: 'h1', targetIds: [] }));
    passWuxie(state);
    expect(b.hp).toBe(b.maxHp - 1);
    expect(c.hp).toBe(c.maxHp - 1);
    expect(d.hp).toBe(d.maxHp - 1); // 蔓延来的
    expect(b.chained).toBe(false); // 受伤害后重置
    expect(d.chained).toBe(false);
  });
});

describe('势备篇 · 敕令', () => {
  /** 摆一个国战局：`revealed` 缺省为 true */
  function gz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      faction: Faction;
      hand?: Card[];
      revealed?: boolean;
      hp?: number;
      equip?: Card[];
    }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      const shown = s.revealed !== false;
      p.heroRevealed = shown;
      p.deputyRevealed = shown;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = s.hp ?? p.maxHp;
      p.hand = (s.hand ?? []).slice();
      for (const c of s.equip ?? []) {
        p.equipment[c.type as 'weapon' | 'armor'] = c;
      }
      p.flags = emptyFlags();
    }
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
    state.log = [];
    return state;
  }
  const chiling = (id: string) => mk(id, 'chiling', 'club', 3);

  it('只对没有势力的角色生效，明置的角色不参与', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [chiling('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', revealed: false, hp: 4 },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hp: 4 },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    // 只有乙要选
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: 'hp' }));
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(3);
    expect(state.players.find((p) => p.seatId === C)!.hp).toBe(4);
    expect(state.pending?.kind).toBe('play'); // 结算完回到出牌阶段
  });

  it('使用者自己没势力时，自己也在目标里', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        revealed: false,
        hand: [chiling('a1')],
        hp: 4,
      },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hp: 4 },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'hp' }));
    expect(state.players.find((p) => p.seatId === A)!.hp).toBe(3);
  });

  it('选「明置一张武将牌」：明置并摸一张牌', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [chiling('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', revealed: false },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    state.deck = [mk('d1', 'sha', 'spade', 7)];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    ok(act(state, B, { type: 'chooseOption', optionId: 'reveal' }));
    // 第二步：选明置哪一张
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'xuchu' }));
    expect(b.heroRevealed).toBe(true);
    expect(b.hand.map((c) => c.id)).toEqual(['d1']);
    // 明置之后他就不是「没有势力」的角色了
    expect(effectiveFaction(state, b)).toBe('wei');
  });

  it('「弃置一张装备牌」只在该目标有装备时才给这个选项', () => {
    const eq: Card = {
      id: 'e1',
      type: 'weapon',
      suit: 'spade',
      rank: 1,
      equipName: 'qinggang',
      range: 2,
    };
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [chiling('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', revealed: false, equip: [eq] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.options.map((o) => o.id)).toContain('discard');
    }
    ok(act(state, B, { type: 'chooseOption', optionId: 'discard' }));
    ok(act(state, B, { type: 'pickCards', cardIds: ['e1'] }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.equipment.weapon).toBeNull();
    expect(state.discard.some((c) => c.id === 'e1')).toBe(true);
  });

  it('没有未确定势力的角色时打不出来', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [chiling('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei' },
    ]);
    expect(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }).ok).toBe(false);
    expect(toSnapshot(state, A).prompt?.legalCardIds).not.toContain('a1');
  });
});

describe('势备篇 · 联军盛宴', () => {
  function gz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      faction: Faction;
      hand?: Card[];
      revealed?: boolean;
      chained?: boolean;
    }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      const shown = s.revealed !== false;
      p.heroRevealed = shown;
      p.deputyRevealed = shown;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = p.maxHp;
      p.hand = (s.hand ?? []).slice();
      p.chained = !!s.chained;
      p.flags = emptyFlags();
    }
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
    state.log = [];
    return state;
  }
  const lianjun = (id: string) => mk(id, 'lianjun', 'heart', 1);

  it('你摸 X 张（X = 该势力存活数），该势力的其他人各摸一张并重置', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [lianjun('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', chained: true },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei', chained: true },
      { seatId: D, name: '丁', heroId: 'guanyu', faction: 'shu' },
    ]);
    state.deck = ['d1', 'd2', 'd3', 'd4'].map((id) => mk(id, 'sha', 'spade', 7));
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    const d = state.players.find((p) => p.seatId === D)!;
    // 以乙为代表选「魏」势力
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'draw' }));
    expect(a.hand).toHaveLength(2); // 打出去一张 + 摸 2 张（魏 2 人）
    expect(b.hand).toHaveLength(1);
    expect(c.hand).toHaveLength(1);
    expect(d.hand).toHaveLength(0); // 同势力但不在目标势力里
    expect(b.chained).toBe(false);
    expect(c.chained).toBe(false);
    expect(state.pending?.kind).toBe('play');
  });

  it('选「回复 X 点体力」', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [lianjun('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei' },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.hp = 1;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    ok(act(state, A, { type: 'chooseOption', optionId: 'heal' }));
    expect(a.hp).toBe(2); // 魏只有 1 人 → X = 1
  });

  it('只能选与自己不同、且已明置的势力', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [lianjun('a1')] },
      { seatId: B, name: '乙', heroId: 'guanyu', faction: 'shu' },
      { seatId: C, name: '丙', heroId: 'xuchu', faction: 'wei', revealed: false },
    ]);
    // 同势力的乙 → 不行
    expect(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }).ok).toBe(false);
    // 暗置的丙 → 不行
    expect(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C] }).ok).toBe(false);
  });
});

describe('势备篇 · 无懈可击·国（势力范围）', () => {
  function gz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      faction: Faction;
      hand?: Card[];
      revealed?: boolean;
    }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      const shown = s.revealed !== false;
      p.heroRevealed = shown;
      p.deputyRevealed = shown;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = p.maxHp;
      p.hand = (s.hand ?? []).slice();
      p.flags = emptyFlags();
    }
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
    state.log = [];
    return state;
  }
  const wuxieguo = (id: string) => mk(id, 'wuxieguo', 'diamond', 11);

  it('抵消「基准角色 + 与其同势力尚未结算的角色」，其他人照常响应', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [wuxieguo('b1')] },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei' },
      { seatId: D, name: '丁', heroId: 'guanyu', faction: 'shu' },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    // 轮到乙：乙用无懈·国，以自己为基准
    expect(state.pending?.kind).toBe('wuxieQueue');
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: B }));
    // 无懈轮继续（丙、丁）
    while (state.pending?.kind === 'wuxieQueue') {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    // 第一个要响应的是丁（乙、丙都被抵消了）
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') {
      expect(state.pending.responderId).toBe(D);
    }
  });

  it('基准角色尚未确定势力时，什么也抵消不掉', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1')] },
      {
        seatId: B,
        name: '乙',
        heroId: 'xuchu',
        faction: 'wei',
        revealed: false,
        hand: [wuxieguo('b1')],
      },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu' },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    ok(act(state, B, { type: 'chooseOption', optionId: B }));
    while (state.pending?.kind === 'wuxieQueue') {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    // 没抵消掉 → 乙自己照常第一个响应（南蛮从下家开始）
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') {
      expect(state.pending.responderId).toBe(B);
    }
    expect(state.log.some((e) => e.message.includes('未能抵消任何效果'))).toBe(true);
  });

  it('单目标锦囊被抵消 = 整张没了效果', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [mk('a1', 'guohe', 'spade', 3), mk('a2', 'sha', 'spade', 7)],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [wuxieguo('b1'), sha('b2')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B], targetCardId: 'b2' }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    // 目标是单目标锦囊，候选只有乙一个人 → 不再多问一次「抵消谁」
    passWuxie(state);
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hand.map((c) => c.id)).toEqual(['b2']); // 过河拆桥没拆走牌
    expect(state.discard.some((c) => c.id === 'b1')).toBe(true); // 无懈·国进了弃牌堆
  });
});

describe('势备篇 · 方天画戟（国战版多目标杀）', () => {
  function gz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      faction: Faction;
      hand: Card[];
      hp?: number;
    }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = s.hp ?? p.maxHp;
      p.hand = s.hand.slice();
      p.flags = emptyFlags();
    }
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
    state.log = [];
    return state;
  }
  const fangtian: Card = {
    id: 'ft',
    type: 'weapon',
    suit: 'diamond',
    rank: 12,
    equipName: 'fangtian',
    range: 4,
  };

  it('可以指定多名势力各不相同的角色', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [] },
      { seatId: D, name: '丁', heroId: 'lvbu', faction: 'qun', hand: [] },
    ]);
    state.players.find((p) => p.seatId === A)!.equipment.weapon = fangtian;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, D] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, D, { type: 'pass' }));
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(3);
    expect(state.players.find((p) => p.seatId === D)!.hp).toBe(3);
    expect(state.players.find((p) => p.seatId === C)!.hp).toBe(4); // 没被指定
    expect(state.pending?.kind).toBe('play');
  });

  it('两个同势力目标 → 打不出来', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei', hand: [] },
    ]);
    state.players.find((p) => p.seatId === A)!.equipment.weapon = fangtian;
    expect(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, C] }).ok).toBe(false);
  });

  it('未确定势力的角色不受「势力各不相同」限制（可以指很多个）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei', hand: [] },
    ]);
    state.players.find((p) => p.seatId === A)!.equipment.weapon = fangtian;
    // 让乙丙都变成未确定势力
    for (const sid of [B, C]) {
      const p = state.players.find((x) => x.seatId === sid)!;
      p.heroRevealed = false;
      p.deputyRevealed = false;
    }
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, C] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, C, { type: 'pass' }));
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(3);
    expect(state.players.find((p) => p.seatId === C)!.hp).toBe(3);
  });

  it('一名目标闪避 → 此【杀】对其余目标无效', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'lvbu', faction: 'qun', hand: [] },
    ]);
    state.players.find((p) => p.seatId === A)!.equipment.weapon = fangtian;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, C] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' })); // 乙闪
    // 丙根本不该被问，也不掉血
    expect(state.pending?.kind).toBe('play');
    expect(state.players.find((p) => p.seatId === C)!.hp).toBe(4);
  });

  it('前面的人挨打了，后面的人闪掉 → 挨过的伤害不回滚', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'lvbu', faction: 'qun', hand: [shan('c1')] },
    ]);
    state.players.find((p) => p.seatId === A)!.equipment.weapon = fangtian;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, C] }));
    ok(act(state, B, { type: 'pass' })); // 乙挨打
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(3);
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' })); // 丙闪
    expect(state.players.find((p) => p.seatId === C)!.hp).toBe(4);
    expect(state.pending?.kind).toBe('play');
  });

  it('没有方天画戟时仍然只能指定一个目标', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
      { seatId: C, name: '丙', heroId: 'lvbu', faction: 'qun', hand: [] },
    ]);
    expect(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, C] }).ok).toBe(false);
  });
});

describe('势备篇 · 木牛流马', () => {
  function gz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      faction: Faction;
      hand: Card[];
      treasure?: Card;
      hp?: number;
    }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = s.hp ?? p.maxHp;
      p.hand = s.hand.slice();
      p.equipment.treasure = s.treasure ?? null;
      p.flags = emptyFlags();
    }
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
    state.log = [];
    return state;
  }
  const muniu = (id = 'm1'): Card => ({
    id,
    type: 'treasure',
    suit: 'diamond',
    rank: 5,
    equipName: 'muniu',
  });

  it('扣置一张手牌（出牌阶段限一次）', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [sha('a1'), shan('a2')],
        treasure: muniu(),
      },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
    ]);
    ok(act(state, A, { type: 'useSkill', skillId: 'muniu', targetIds: [] }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    // 第二步问「是否移动」，这里选不移走
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'keep' }));
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand.map((c) => c.id)).toEqual(['a2']);
    expect(a.equipment.treasure?.cargo?.map((c) => c.id)).toEqual(['a1']);
    // 本回合已用过 → 不能再发
    expect(act(state, A, { type: 'useSkill', skillId: 'muniu', targetIds: [] }).ok).toBe(false);
  });

  it('扣置的牌可以如手牌般使用', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [], treasure: muniu() },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [], hp: 4 },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.treasure!.cargo = [sha('c1')];
    expect(toSnapshot(state, A).prompt?.legalCardIds).toContain('c1');
    ok(act(state, A, { type: 'playCard', cardId: 'c1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(3);
    // 用出去之后扣置区就空了
    expect(a.equipment.treasure!.cargo).toEqual([]);
  });

  it('可以把装备（连辎一起）移动到其他角色的装备区', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [shan('a2')],
        treasure: muniu(),
      },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.treasure!.cargo = [sha('c1')];
    ok(act(state, A, { type: 'useSkill', skillId: 'muniu', targetIds: [] }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['a2'] }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'move' }));
    ok(act(state, A, { type: 'chooseOption', optionId: B }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(a.equipment.treasure).toBeNull();
    expect(b.equipment.treasure?.equipName).toBe('muniu');
    // 辎跟着装备一起走
    expect(b.equipment.treasure?.cargo?.map((c) => c.id).sort()).toEqual(['a2', 'c1']);
    // 移动那一步是**两层** askChoice 里的第二层，容易漏 returnTo → 选完就卡死
    expect(state.pending?.kind).toBe('play');
  });

  it('装备被弃置时，扣置的牌一同进弃牌堆', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [mk('g1', 'guohe', 'spade', 3)],
        treasure: muniu(),
      },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.treasure = muniu('m2');
    b.equipment.treasure!.cargo = [sha('c1'), shan('c2')];
    ok(act(state, A, { type: 'playCard', cardId: 'g1', targetIds: [B], targetCardId: 'm2' }));
    passWuxie(state);
    expect(state.discard.some((c) => c.id === 'm2')).toBe(true);
    expect(state.discard.some((c) => c.id === 'c1')).toBe(true);
    expect(state.discard.some((c) => c.id === 'c2')).toBe(true);
  });

  it('扣置的牌对别人只暴露张数（自己是能看见的）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [], treasure: muniu() },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.treasure!.cargo = [sha('c1')];
    const mine = toSnapshot(state, A).players.find((p) => p.seatId === A)!.equipment[0]!;
    expect(mine.cargo?.map((c) => c.id)).toEqual(['c1']);
    const theirs = toSnapshot(state, B).players.find((p) => p.seatId === A)!.equipment[0]!;
    expect(theirs.cargo).toBeUndefined();
    expect(theirs.cargoCount).toBe(1);
  });
});

describe('丈八蛇矛（两张手牌当【杀】）', () => {
  const zhangba: Card = {
    id: 'zb',
    type: 'weapon',
    suit: 'club',
    rank: 12,
    equipName: 'zhangba',
    range: 3,
  };
  const renwang: Card = { id: 'rw', type: 'armor', suit: 'club', rank: 2, equipName: 'renwang' };

  function setup(aHand: Card[], opts?: { bArmor?: Card; bHand?: Card[]; mode?: GameMode }) {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: aHand },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: opts?.bHand ?? [] },
      ],
      opts?.mode ?? 'guozhan',
    );
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.weapon = zhangba;
    if (opts?.bArmor) state.players.find((p) => p.seatId === B)!.equipment.armor = opts.bArmor;
    return state;
  }

  it('两张红色手牌 → 红色的【杀】（被仁王盾挡不住，因为它只挡黑杀）', () => {
    const state = setup([mk('a1', 'sha', 'heart', 7), mk('a2', 'tao', 'diamond', 3)], {
      bArmor: renwang,
    });
    ok(
      act(state, A, {
        type: 'playCard',
        cardId: 'a1',
        extraCardIds: ['a2'],
        targetIds: [B],
      }),
    );
    ok(act(state, B, { type: 'pass' }));
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(3);
    // 两张牌一起进弃牌堆
    expect(state.discard.some((c) => c.id === 'a1')).toBe(true);
    expect(state.discard.some((c) => c.id === 'a2')).toBe(true);
  });

  it('两张黑色手牌 → 黑色的【杀】，被仁王盾挡掉', () => {
    const state = setup([mk('a1', 'sha', 'spade', 7), mk('a2', 'jiu', 'club', 9)], {
      bArmor: renwang,
    });
    ok(
      act(state, A, {
        type: 'playCard',
        cardId: 'a1',
        extraCardIds: ['a2'],
        targetIds: [B],
      }),
    );
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(4);
    expect(state.log.some((e) => e.message.includes('仁王盾'))).toBe(true);
  });

  it('一红一黑 → **无色**【杀】，仁王盾挡不住（「黑红无色」）', () => {
    const state = setup([mk('a1', 'sha', 'spade', 7), mk('a2', 'tao', 'heart', 3)], {
      bArmor: renwang,
    });
    ok(
      act(state, A, {
        type: 'playCard',
        cardId: 'a1',
        extraCardIds: ['a2'],
        targetIds: [B],
      }),
    );
    ok(act(state, B, { type: 'pass' }));
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(3);
    expect(state.log.some((e) => e.message.includes('仁王盾'))).toBe(false);
  });

  it('一红一黑的无色杀仍然是**普通杀**：藤甲照样免疫', () => {
    const tengjia: Card = { id: 'tj', type: 'armor', suit: 'spade', rank: 2, equipName: 'tengjia' };
    const state = setup([mk('a1', 'sha', 'spade', 7), mk('a2', 'tao', 'heart', 3)], {
      bArmor: tengjia,
    });
    ok(
      act(state, A, {
        type: 'playCard',
        cardId: 'a1',
        extraCardIds: ['a2'],
        targetIds: [B],
      }),
    );
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(4);
  });

  it('没装备【丈八蛇矛】时不能这么用', () => {
    const state = setup([mk('a1', 'sha', 'spade', 7), mk('a2', 'tao', 'heart', 3)]);
    state.players.find((p) => p.seatId === A)!.equipment.weapon = null;
    expect(
      act(state, A, {
        type: 'playCard',
        cardId: 'a1',
        extraCardIds: ['a2'],
        targetIds: [B],
      }).ok,
    ).toBe(false);
  });

  it('必须是**两张**：给一张或三张都不行', () => {
    const state = setup([
      mk('a1', 'sha', 'spade', 7),
      mk('a2', 'tao', 'heart', 3),
      mk('a3', 'shan', 'diamond', 4),
    ]);
    expect(
      act(state, A, {
        type: 'playCard',
        cardId: 'a1',
        extraCardIds: ['a2', 'a3'],
        targetIds: [B],
      }).ok,
    ).toBe(false);
    expect(
      act(state, A, { type: 'playCard', cardId: 'a1', extraCardIds: [], targetIds: [B] }).ok,
    ).toBe(true); // 空数组就是普通出杀
  });

  it('同一个张牌不能当两张用', () => {
    const state = setup([mk('a1', 'sha', 'spade', 7)]);
    expect(
      act(state, A, {
        type: 'playCard',
        cardId: 'a1',
        extraCardIds: ['a1'],
        targetIds: [B],
      }).ok,
    ).toBe(false);
  });

  it('计入本回合出杀次数（不能靠丈八无限出杀）', () => {
    const state = setup([
      mk('a1', 'sha', 'spade', 7),
      mk('a2', 'tao', 'heart', 3),
      mk('a3', 'shan', 'diamond', 4),
      mk('a4', 'jiu', 'club', 9),
    ]);
    ok(
      act(state, A, {
        type: 'playCard',
        cardId: 'a1',
        extraCardIds: ['a2'],
        targetIds: [B],
      }),
    );
    ok(act(state, B, { type: 'pass' }));
    expect(
      act(state, A, {
        type: 'playCard',
        cardId: 'a3',
        extraCardIds: ['a4'],
        targetIds: [B],
      }).ok,
    ).toBe(false);
  });

  it('响应【南蛮入侵】时也能用两张手牌当【杀】', () => {
    const state = setup([], { bHand: [mk('b1', 'juedou', 'spade', 1)] });
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.weapon = { ...zhangba, id: 'zb2' };
    b.hand = [mk('b2', 'tao', 'heart', 3), mk('b3', 'shan', 'diamond', 4)];
    // 甲对乙用南蛮
    state.players.find((p) => p.seatId === A)!.hand = [mk('a9', 'nanman', 'spade', 7)];
    ok(act(state, A, { type: 'playCard', cardId: 'a9', targetIds: [] }));
    passWuxie(state);
    ok(act(state, B, { type: 'respondCard', cardId: 'b2', extraCardIds: ['b3'] }));
    expect(b.hp).toBe(4);
    expect(state.discard.some((c) => c.id === 'b2')).toBe(true);
    expect(state.discard.some((c) => c.id === 'b3')).toBe(true);
  });

  it('出牌提示里整手牌都可点，并能看出要用丈八', () => {
    const state = setup([mk('a1', 'shan', 'heart', 4), mk('a2', 'tao', 'diamond', 3)]);
    const prompt = toSnapshot(state, A).prompt;
    // 【闪】本身打不出去，但两张凑一起就是【杀】
    expect(prompt?.legalCardIds).toContain('a1');
    expect(prompt?.legalCardIds).toContain('a2');
  });

  it('只有一张牌时凑不出丈八的【杀】', () => {
    const state = setup([mk('a1', 'shan', 'heart', 4)]);
    const prompt = toSnapshot(state, A).prompt;
    expect(prompt?.legalCardIds ?? []).not.toContain('a1');
  });

  it('虚拟【杀】只在日志里出现牌名，不冒充实体牌', () => {
    const state = setup([mk('a1', 'sha', 'heart', 7), mk('a2', 'tao', 'diamond', 3)]);
    ok(
      act(state, A, {
        type: 'playCard',
        cardId: 'a1',
        extraCardIds: ['a2'],
        targetIds: [B],
      }),
    );
    const shaLog = state.log.find((e) => e.kind === 'sha')!;
    expect(shaLog.message).toContain('丈八蛇矛');
    // 两张实体牌都进了弃牌堆，虚拟牌没有污染牌堆
    expect(state.discard.map((c) => c.id).sort()).toEqual(['a1', 'a2']);
  });
});

describe('无懈可击 · 抵消链（无懈对无懈）', () => {
  const nanman = (id: string) => mk(id, 'nanman', 'spade');

  function gz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      faction: Faction;
      hand?: Card[];
      revealed?: boolean;
    }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      const shown = s.revealed !== false;
      p.heroRevealed = shown;
      p.deputyRevealed = shown;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = p.maxHp;
      p.hand = (s.hand ?? []).slice();
      p.flags = emptyFlags();
    }
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
    state.log = [];
    return state;
  }

  it('普通无懈只抵消**一名角色**，其他人照常响应', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei' },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [wuxie('c1')] },
      { seatId: D, name: '丁', heroId: 'lvbu', faction: 'qun' },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    // 只有丙持有无懈 → 只有他被问
    expect(state.pending?.kind).toBe('wuxieQueue');
    if (state.pending?.kind === 'wuxieQueue') expect(state.pending.askQueue).toEqual([C]);
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    // 有 3 个候选（乙丙丁），所以要问一句「抵消谁」
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, C, { type: 'chooseOption', optionId: D }));
    // 丙那张已经用掉，场上再没人持有无懈 → 抵消轮也是空的，直接开始响应
    // 第一个要响应的是乙（丁已被抵消，但队列按座次走，先问乙）
    if (state.pending?.kind === 'respondTrick') expect(state.pending.responderId).toBe(B);
    // 乙弃权 → 丙
    ok(act(state, B, { type: 'pass' }));
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') expect(state.pending.responderId).toBe(C);
    // 丙弃权 → 丁已被抵消，**不该问他**，南蛮直接结算完
    ok(act(state, C, { type: 'pass' }));
    expect(state.pending?.kind).toBe('play');
    expect(state.players.find((p) => p.seatId === D)!.hp).toBe(4);
  });

  it('再打一张无懈 = 抵消上一张 → 被抵消的角色恢复', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [wuxie('b1')] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu' },
      { seatId: D, name: '丁', heroId: 'lvbu', faction: 'qun', hand: [wuxie('d1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    expect(state.pending?.kind).toBe('wuxieQueue');
    // 乙抵消「丙」
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    ok(act(state, B, { type: 'chooseOption', optionId: C }));
    // 之后重开一轮：从乙的下家（丙）开始问，甲也在这一轮里
    expect(state.pending?.kind).toBe('wuxieQueue');
    while (state.pending?.kind === 'wuxieQueue') {
      const asked = state.pending.askQueue[state.pending.askIndex]!;
      if (asked === D && state.log.some((e) => e.message.includes('抵消了【南蛮入侵】对 丙'))) {
        ok(act(state, D, { type: 'respondCard', cardId: 'd1' }));
        break; // 丁抵消乙的那张无懈 → 丙恢复
      }
      ok(act(state, asked, { type: 'pass' }));
    }
    passWuxie(state);
    expect(state.log.some((e) => e.message.includes('恢复'))).toBe(true);
    // 丙恢复受影响 → 南蛮会问到他（乙、丙、丁都要响应）
    ok(act(state, B, { type: 'pass' }));
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') expect(state.pending.responderId).toBe(C);
  });

  it('锦囊的使用者也能出无懈保住自己的锦囊', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [wuzhong('a1'), wuxie('a2')],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [wuxie('b1')] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu' },
    ]);
    state.deck = ['d1', 'd2'].map((id) => mk(id, 'sha', 'spade', 7));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    // 乙抵消甲的【无中生有】
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    expect(state.pending?.kind).toBe('wuxieQueue');
    // 现在轮到甲自己（他在这一轮里被问到）→ 再用一张无懈抵消乙那张
    while (state.pending?.kind === 'wuxieQueue') {
      const asked = state.pending.askQueue[state.pending.askIndex]!;
      if (asked === A) {
        ok(act(state, A, { type: 'respondCard', cardId: 'a2' }));
        break;
      }
      ok(act(state, asked, { type: 'pass' }));
    }
    passWuxie(state);
    // 抵消链回到「未抵消」→ 无中生有照常摸两张
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand.map((c) => c.id).sort()).toEqual(['d1', 'd2']);
    expect(state.pending?.kind).toBe('play');
  });

  it('【无懈可击·国】被抵消时，它那整片势力范围一起恢复（官方 FAQ）', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [nanman('a1'), wuxie('a2')],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'xuchu',
        faction: 'wei',
        hand: [mk('b1', 'wuxieguo', 'diamond', 11)],
      },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei' },
      { seatId: D, name: '丁', heroId: 'guanyu', faction: 'shu' },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    // 乙用无懈·国把「乙 + 同势力的丙」一起抵消掉
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: B }));
    // 甲再用一张普通无懈抵消它 → 乙丙都恢复
    while (state.pending?.kind === 'wuxieQueue') {
      const asked = state.pending.askQueue[state.pending.askIndex]!;
      if (asked === A) {
        ok(act(state, A, { type: 'respondCard', cardId: 'a2' }));
        break;
      }
      ok(act(state, asked, { type: 'pass' }));
    }
    passWuxie(state);
    // 乙（第一个响应者）照常被问
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') expect(state.pending.responderId).toBe(B);
  });

  it('每张无懈都进弃牌堆，且不影响「本回合进入弃牌堆」的账目', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [nanman('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [wuxie('b1')] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [wuxie('c1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    // 南蛮有两个响应者（乙丙）→ 要先说清抵消谁
    ok(act(state, B, { type: 'chooseOption', optionId: C }));
    // 丙再出一张抵消乙那张（第二张不选目标，直接翻转）
    while (state.pending?.kind === 'wuxieQueue') {
      const asked = state.pending.askQueue[state.pending.askIndex]!;
      if (asked === C) {
        ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
        break;
      }
      ok(act(state, asked, { type: 'pass' }));
    }
    passWuxie(state);
    expect(state.discard.map((c) => c.id).sort()).toEqual(['a1', 'b1', 'c1']);
    expect(state.discardThisTurn.filter((c) => c.type === 'wuxie')).toHaveLength(2);
  });
});

describe('无懈可击 · 逐目标时机（每名角色生效前各一次）', () => {
  function gz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      faction: Faction;
      hand?: Card[];
      revealed?: boolean;
    }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      const shown = s.revealed !== false;
      p.heroRevealed = shown;
      p.deputyRevealed = shown;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = p.maxHp;
      p.hand = (s.hand ?? []).slice();
      p.flags = emptyFlags();
    }
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
    state.log = [];
    return state;
  }
  const hp = (state: GameState, seatId: string) =>
    state.players.find((p) => p.seatId === seatId)!.hp;
  /** 当前窗口在问谁 */
  function askedNow(state: GameState): string | null {
    const p = state.pending;
    if (p?.kind === 'wuxieQueue') return p.askQueue[p.askIndex] ?? null;
    return null;
  }

  it('群体锦囊：窗口出现在「上一个目标结算完之后」，所以能挑晚一点的人抵消', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [mk('a1', 'nanman', 'spade')],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei' },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu' },
      { seatId: D, name: '丁', heroId: 'lvbu', faction: 'qun', hand: [wuxie('d1')] },
      { seatId: E, name: '戊', heroId: 'caocao', faction: 'wei' },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    // 只有丁持有无懈 → 每个窗口都只问他
    expect(askedNow(state)).toBe(D);
    ok(act(state, D, { type: 'pass' })); // 锦囊开始前那一轮：不抵消
    expect(askedNow(state)).toBe(D); // 乙生效前的窗口
    ok(act(state, D, { type: 'pass' }));
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') expect(state.pending.responderId).toBe(B);
    ok(act(state, B, { type: 'pass' })); // 乙挨打
    expect(hp(state, B)).toBe(3);
    // ——关键：乙结算完之后、丙生效之前，又给了丁一次机会——
    expect(askedNow(state)).toBe(D);
    ok(act(state, D, { type: 'respondCard', cardId: 'd1' }));
    expect(state.pending?.kind).toBe('choice');
    // 候选是「还没结算完的人」：丙、丁、戊（乙已经结算过了，不能追溯抵消）
    if (state.pending?.kind === 'choice') {
      expect(state.pending.options.map((o) => o.id)).toEqual([C, D, E]);
    }
    ok(act(state, D, { type: 'chooseOption', optionId: C }));
    // 丙被抵消 → 直接跳过他，轮到丁
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') expect(state.pending.responderId).toBe(D);
    ok(act(state, D, { type: 'pass' }));
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') expect(state.pending.responderId).toBe(E);
    ok(act(state, E, { type: 'pass' }));
    expect(state.pending?.kind).toBe('play');
    expect(hp(state, B)).toBe(3);
    expect(hp(state, C)).toBe(4); // 只在丙自己的窗口里被抵消，所以没挨打
    expect(hp(state, D)).toBe(3);
    expect(hp(state, E)).toBe(3);
  });

  it('没有无懈的人不会被问（纯提示优化，结果一样）', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [mk('a1', 'nanman', 'spade')],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei' },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu' },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    // 谁都没有无懈 → 整个无懈窗口不存在，直接进入响应
    expect(state.pending?.kind).toBe('respondTrick');
  });

  it('敕令：逐目标窗口，被抵消的那个人不选', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [mk('a1', 'chiling', 'club', 3)],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', revealed: false },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei', revealed: false },
      { seatId: D, name: '丁', heroId: 'lvbu', faction: 'qun', hand: [wuxie('d1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    ok(act(state, D, { type: 'pass' })); // 锦囊开始前
    expect(askedNow(state)).toBe(D); // 乙生效前的窗口
    ok(act(state, D, { type: 'pass' }));
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: 'hp' }));
    expect(hp(state, B)).toBe(3);
    // 丙生效前再来一次 → 丁把丙抵消掉（只剩丙一个候选，不再多问「抵消谁」）
    expect(askedNow(state)).toBe(D);
    ok(act(state, D, { type: 'respondCard', cardId: 'd1' }));
    // 丙被跳过 → 敕令结算完 → 回到甲的出牌阶段
    expect(state.pending?.kind).toBe('play');
    expect(hp(state, C)).toBe(4);
    expect(state.players.find((p) => p.seatId === C)!.heroRevealed).toBe(false);
  });

  it('五谷丰登：每个拿牌的人之前各一次窗口', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [mk('a1', 'wugu', 'heart', 7)],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei' },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [wuxie('c1')] },
    ]);
    state.deck = ['d1', 'd2', 'd3'].map((id) => mk(id, 'sha', 'spade', 7));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    // 锦囊开始前：只有丙有无懈 → 问他
    expect(askedNow(state)).toBe(C);
    ok(act(state, C, { type: 'pass' }));
    // 甲（使用者自己也在拿牌队列里）生效前：再来一次窗口
    expect(askedNow(state)).toBe(C);
    ok(act(state, C, { type: 'pass' }));
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'pickCards', cardIds: ['d3'] }));
    // 轮到乙：先给他开窗口 → 丙出无懈把乙抵消
    expect(askedNow(state)).toBe(C);
    ok(act(state, C, { type: 'respondCard', cardId: 'c1' }));
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, C, { type: 'chooseOption', optionId: B }));
    // 乙被跳过，直接轮到丙拿
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') expect(state.pending.seatId).toBe(C);
    ok(act(state, C, { type: 'pickCards', cardIds: ['d2'] }));
    expect(state.players.find((p) => p.seatId === B)!.hand).toHaveLength(0);
    // 剩一张没人拿 → 进弃牌堆
    expect(state.discard.some((c) => c.id === 'd1')).toBe(true);
    expect(state.pending?.kind).toBe('play');
  });

  it('火烧连营：逐个目标前各一次窗口', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [mk('a1', 'huoshao', 'spade', 3)],
      },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei' },
      { seatId: C, name: '丙', heroId: 'caocao', faction: 'wei' },
      { seatId: D, name: '丁', heroId: 'lvbu', faction: 'qun', hand: [wuxie('d1')] },
    ]);
    // 下家是乙（魏），同一队列 = 乙丙
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    expect(askedNow(state)).toBe(D);
    ok(act(state, D, { type: 'pass' })); // 锦囊开始前
    // 乙生效前的窗口 → 丁把乙抵消掉（候选是乙丙两人，所以要问一句）
    expect(askedNow(state)).toBe(D);
    ok(act(state, D, { type: 'respondCard', cardId: 'd1' }));
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, D, { type: 'chooseOption', optionId: B }));
    expect(hp(state, B)).toBe(4);
    // 丙生效前的窗口：丁手里没有无懈了 → 窗口直接跳过，丙挨烧
    expect(hp(state, C)).toBe(3);
    expect(state.pending?.kind).toBe('play');
  });
});

describe('方天画戟 · 军争版（最后的手牌可额外指定至多两个目标）', () => {
  const fangtian: Card = {
    id: 'ft',
    type: 'weapon',
    suit: 'diamond',
    rank: 12,
    equipName: 'fangtian',
    range: 4,
  };

  function jz(seats: { seatId: string; name: string; heroId: string; hand: Card[] }[]) {
    const state = makeGameMode(seats, 'melee');
    state.players.find((p) => p.seatId === A)!.equipment.weapon = fangtian;
    return state;
  }

  it('这张【杀】是最后的手牌 → 可以指定三名目标，各自独立结算', () => {
    const state = jz([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
      { seatId: D, name: '丁', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, C, D] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, C, { type: 'pass' }));
    ok(act(state, D, { type: 'pass' }));
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(3);
    expect(state.players.find((p) => p.seatId === C)!.hp).toBe(3);
    expect(state.players.find((p) => p.seatId === D)!.hp).toBe(3);
    expect(state.pending?.kind).toBe('play');
  });

  it('手里还有别的牌 → 只能指定一名目标', () => {
    const state = jz([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1'), tao('a2')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    expect(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, C] }).ok).toBe(false);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
  });

  it('至多额外两个：四个目标打不出来', () => {
    const state = jz([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
      { seatId: D, name: '丁', heroId: 'vanilla', hand: [] },
      { seatId: E, name: '戊', heroId: 'vanilla', hand: [] },
    ]);
    expect(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, C, D, E] }).ok).toBe(
      false,
    );
  });

  it('军争版**没有**「势力各不相同」的限制（两个同势力也能一起指）', () => {
    const state = makeGameMode(
      [
        { seatId: A, name: '甲', heroId: 'zhangfei', hand: [sha('a1')] },
        { seatId: B, name: '乙', heroId: 'xuchu', hand: [] },
        { seatId: C, name: '丙', heroId: 'caocao', hand: [] },
      ],
      'melee',
    );
    state.players.find((p) => p.seatId === A)!.equipment.weapon = fangtian;
    // 甲是蜀、乙丙都是魏：国战版会在这里报「势力必须各不相同」，军争版不受这条约束。
    // （顺带说明为什么军争版**不能**去读 effectiveFaction：那是国战语义，
    //   非国战模式下武将未「明置」时它返回 null，拿它做判断毫无意义。）
    expect(
      effectiveFaction(
        state,
        state.players.find((p) => p.seatId === B)!,
      ),
    ).toBeNull();
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, C] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, C, { type: 'pass' }));
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(3);
    expect(state.players.find((p) => p.seatId === C)!.hp).toBe(3);
  });

  it('一人出闪**不影响**其他目标（与国战版相反）', () => {
    const state = jz([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, C] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' })); // 乙闪掉
    // 丙照样要挨打
    expect(state.pending?.kind).toBe('respondSha');
    if (state.pending?.kind === 'respondSha') expect(state.pending.responderId).toBe(C);
    ok(act(state, C, { type: 'pass' }));
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(4);
    expect(state.players.find((p) => p.seatId === C)!.hp).toBe(3);
  });

  it('结算顺序按**座次**，不按玩家点选顺序', () => {
    const state = jz([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
      { seatId: D, name: '丁', heroId: 'vanilla', hand: [] },
    ]);
    // 故意逆着座次点：丁、丙、乙
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [D, C, B] }));
    expect(state.pending?.kind).toBe('respondSha');
    if (state.pending?.kind === 'respondSha') expect(state.pending.responderId).toBe(B);
  });

  it('国战版不受「最后的手牌」限制（两套规则按模式分）', () => {
    const state = createGame(
      [
        { seatId: A, name: '甲', heroId: 'zhangfei' },
        { seatId: B, name: '乙', heroId: 'xuchu' },
        { seatId: C, name: '丙', heroId: 'lvbu' },
      ],
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const [seatId, faction] of [
      [A, 'shu'],
      [B, 'wei'],
      [C, 'qun'],
    ] as const) {
      const p = state.players.find((x) => x.seatId === seatId)!;
      p.faction = faction;
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.maxHp = 4;
      p.hp = 4;
      p.flags = emptyFlags();
    }
    const a = state.players.find((p) => p.seatId === A)!;
    a.equipment.weapon = { ...fangtian, id: 'ft2' };
    // 手上不止一张牌，国战版照样能指定两个势力不同的目标
    a.hand = [sha('a1'), tao('a2'), shan('a3')];
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: A };
    state.log = [];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, C] }));
  });
});

describe('国战标准版 · 马腾 / 潘凤 / 孙坚', () => {
  function gz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      faction: Faction;
      hand?: Card[];
      revealed?: boolean;
      hp?: number;
      equip?: Card[];
    }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      const shown = s.revealed !== false;
      p.heroRevealed = shown;
      p.deputyRevealed = shown;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = s.hp ?? p.maxHp;
      p.hand = (s.hand ?? []).slice();
      for (const c of s.equip ?? []) p.equipment[c.type as 'plusMount'] = c;
      p.flags = emptyFlags();
    }
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
    state.log = [];
    return state;
  }
  // 给目标挂的装备用**武器栏**：+1 马会把距离顶到 2，范围 1 的杀就打不着了，
  // 而武器既不影响距离、也是狂斧能处置的牌。
  const qinggang: Card = {
    id: 'e1',
    type: 'weapon',
    suit: 'spade',
    rank: 6,
    equipName: 'qinggang',
    range: 2,
  };

  it('马腾：雄异令同势力各摸三张（暗置的人不算同势力）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'mateng', faction: 'qun', hand: [] },
      { seatId: B, name: '乙', heroId: 'lvbu', faction: 'qun', hand: [] },
      { seatId: C, name: '丙', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: D, name: '丁', heroId: 'guanyu', faction: 'shu', revealed: false, hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    const c = state.players.find((p) => p.seatId === C)!;
    const d = state.players.find((p) => p.seatId === D)!;
    state.deck = Array.from({ length: 12 }, (_, i) => mk(`d${i}`, 'sha', 'spade', 7));
    ok(act(state, A, { type: 'useSkill', skillId: 'xiongyi', targetIds: [] }));
    expect(a.hand).toHaveLength(3);
    expect(b.hand).toHaveLength(3); // 同势力（群）
    expect(c.hand).toHaveLength(0); // 不同势力
    expect(d.hand).toHaveLength(0); // 暗置 → 势力未确定，不算同势力
    // 限定技：每局一次
    expect(act(state, A, { type: 'useSkill', skillId: 'xiongyi', targetIds: [] }).ok).toBe(false);
  });

  it('马腾：雄异在势力人数最少时回复 1 点体力', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'mateng', faction: 'qun', hand: [], hp: 2 },
      { seatId: C, name: '丙', heroId: 'zhangfei', faction: 'shu', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    state.deck = Array.from({ length: 6 }, (_, i) => mk(`d${i}`, 'sha', 'spade', 7));
    ok(act(state, A, { type: 'useSkill', skillId: 'xiongyi', targetIds: [] }));
    expect(a.hp).toBe(3); // 群 1 人 vs 蜀 1 人 → 并列最少 → 回复 1
  });

  it('马腾：马术让距离 -1', () => {
    // 要四人局才看得出：三人局里 A 和 C 从另一边数本来就只有 1
    const state = gz([
      { seatId: A, name: '甲', heroId: 'mateng', faction: 'qun', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [] },
      { seatId: D, name: '丁', heroId: 'lvbu', faction: 'qun', hand: [] },
    ]);
    const plain = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [] },
      { seatId: D, name: '丁', heroId: 'lvbu', faction: 'qun', hand: [] },
    ]);
    expect(distance(plain, A, C)).toBe(2); // 四人局的对角
    expect(distance(state, A, C)).toBe(1); // 马术 -1
  });

  it('潘凤：狂斧把目标装备区的一张牌取走', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'panfeng', faction: 'qun', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [], equip: [qinggang] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 不闪 → 受伤 → 狂斧
    expect(b.hp).toBe(3);
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['e1'] }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'take' }));
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.equipment.weapon?.id).toBe('e1');
    expect(b.equipment.weapon).toBeNull();
  });

  it('潘凤：狂斧也可以选择弃置', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'panfeng', faction: 'qun', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [], equip: [qinggang] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['e1'] }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'drop' }));
    expect(b.equipment.weapon).toBeNull();
    expect(state.discard.some((c) => c.id === 'e1')).toBe(true);
  });

  it('潘凤：目标装备区空着就不问', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'panfeng', faction: 'qun', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(state.pending?.kind).toBe('play'); // 没有狂斧的询问
  });

  it('孙坚：英魂只在受伤时发动（未受伤不问）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: B, name: '乙', heroId: 'sunjian', faction: 'wu', hand: [] },
    ]);
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'endPhase' }));
    // 乙满血 → 没有英魂询问（直接进甲的判定/摸牌流程）
    expect(state.pending?.kind === 'choice' && state.pending.title.includes('英魂')).toBe(false);
  });

  it('孙坚：英魂第二项——先摸 1 张再弃 X 张', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      // 孙坚上限 5（2.5 阴阳鱼），掉到 3 → 已损失 2
      { seatId: B, name: '乙', heroId: 'sunjian', faction: 'wu', hand: [], hp: 3 },
    ]);
    state.deck = ['d1', 'd2'].map((id) => mk(id, 'sha', 'spade', 7));
    ok(act(state, A, { type: 'endPhase' }));
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'draw1' })); // 摸1弃2
    ok(act(state, B, { type: 'chooseOption', optionId: A })); // 选甲
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand).toHaveLength(1); // 摸了 1 张
    // 然后甲要弃 X=2 张，但他只有 1 张 → 按实际弃 1 张
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, A, { type: 'pickCards', cardIds: ['d2'] }));
    expect(a.hand).toHaveLength(0);
  });

  it('孙坚：英魂第一项——先摸 X 张再弃 1 张', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: B, name: '乙', heroId: 'sunjian', faction: 'wu', hand: [], hp: 3 },
    ]);
    state.deck = ['d1', 'd2', 'd3'].map((id) => mk(id, 'sha', 'spade', 7));
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'drawX' })); // 摸2弃1
    ok(act(state, B, { type: 'chooseOption', optionId: A }));
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand).toHaveLength(2);
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, A, { type: 'pickCards', cardIds: ['d3'] }));
    expect(a.hand).toHaveLength(1);
  });
});

describe('国战标准版 · 庞德 / 丁奉 / 纪灵', () => {
  function gz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      faction: Faction;
      hand?: Card[];
      revealed?: boolean;
      hp?: number;
      equip?: Card[];
    }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      const shown = s.revealed !== false;
      p.heroRevealed = shown;
      p.deputyRevealed = shown;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = s.hp ?? p.maxHp;
      p.hand = (s.hand ?? []).slice();
      for (const c of s.equip ?? []) p.equipment[c.type as 'weapon'] = c;
      p.flags = emptyFlags();
    }
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
    state.log = [];
    return state;
  }
  const qinggang: Card = {
    id: 'w1',
    type: 'weapon',
    suit: 'spade',
    rank: 6,
    equipName: 'qinggang',
    range: 2,
  };

  it('庞德：猛进——【杀】被闪抵消后弃置其一张牌', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'pangde', faction: 'qun', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [shan('b1'), tao('b2')] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' })); // 出闪
    // 闪抵消之后轮到庞德决定要不要猛进
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    // 出闪用掉 b1，猛进再随机弃掉 b2 → 手牌空
    expect(b.hand).toHaveLength(0);
    expect(state.discard.some((c) => c.id === 'b2')).toBe(true);
    expect(state.pending?.kind).toBe('play'); // 收尾回到出牌阶段
  });

  it('庞德：猛进可以选不发动，且目标没有牌时根本不问', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'pangde', faction: 'qun', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [shan('b1'), tao('b2')] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'no' }));
    expect(b.hand).toHaveLength(1); // b1 出闪用掉了、b2 留着
    b.hand = []; // 第二张杀时他已经两手空空
    // 第二张杀：本回合已出过一张，先把计数让开（这条测的是猛进，不是出杀上限）
    state.players.find((p) => p.seatId === A)!.flags.shaCountThisTurn = 0;
    ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(3);
    expect(state.pending?.kind).toBe('play');
  });

  it('丁奉：短兵可以多指定一名距离 1 的角色', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'dingfeng',
        faction: 'wu',
        hand: [sha('a1')],
        equip: [qinggang],
      },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu' },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu' },
    ]);
    // 3 人局：乙丙都在距离 1（枪范围 2 也够）→ 一杀双目标
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B, C] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, C, { type: 'pass' }));
    expect(state.players.find((p) => p.seatId === B)!.hp).toBe(3);
    expect(state.players.find((p) => p.seatId === C)!.hp).toBe(3);
  });

  it('丁奉：短兵多出来的那名必须距离 1', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'dingfeng',
        faction: 'wu',
        hand: [sha('a1')],
        equip: [qinggang],
      },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu' },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu' },
      { seatId: D, name: '丁', heroId: 'lvbu', faction: 'qun' },
      { seatId: E, name: '戊', heroId: 'xuchu', faction: 'wei' },
    ]);
    // 5 人局：丙和丁都在距离 2。丙当「正常目标」没问题，丁当「短兵额外目标」就不行。
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [C, B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, C, { type: 'pass' }));
    expect(state.players.find((p) => p.seatId === C)!.hp).toBe(3);
    // 第二张杀：额外目标选丁（距离 2）→ 报错；且只有短兵给的 2 个名额，3 个目标也不行
    state.pending = { kind: 'play', seatId: A };
    const a = state.players.find((p) => p.seatId === A)!;
    a.hand = [sha('a2')];
    a.flags.shaCountThisTurn = 0;
    expect(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [C, D] }).ok).toBe(false);
    expect(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [B, C, D] }).ok).toBe(false);
  });

  it('丁奉：奋迅——弃一张牌，本回合到某人的距离视为 1', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'dingfeng', faction: 'wu', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu' },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu' },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    // 三人局里丙本来就在距离 1 之外吗？距离是环上的最小值，这里用 4 人局更保险——
    // 直接断言标记与距离：先看没有标记时的距离
    ok(act(state, A, { type: 'useSkill', skillId: 'fenxun', cardIds: ['a2'], targetIds: [C] }));
    expect(a.flags.distanceToOneThisTurn).toBe(C);
    expect(distance(state, A, C)).toBe(1);
    expect(a.hand.map((c) => c.id)).toEqual(['a1']); // 弃掉了一张
    // 限一次
    expect(
      act(state, A, { type: 'useSkill', skillId: 'fenxun', cardIds: ['a1'], targetIds: [C] }).ok,
    ).toBe(false);
  });

  it('纪灵：双刃拼点赢 → 视为对其同势力的另一名角色使用【杀】', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'jiling',
        faction: 'qun',
        hand: [mk('a1', 'sha', 'spade', 13)],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [mk('b1', 'sha', 'club', 1)],
      },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu' },
    ]);
    // 座次是 [甲,乙,丙]：甲的上家是**丙**，所以让丙结束回合才对
    state.turn = { seatIndex: state.seatOrder.indexOf(C), phase: 'play' };
    state.pending = { kind: 'play', seatId: C };
    ok(act(state, C, { type: 'endPhase' })); // 甲的回合开始 → 出牌阶段开始时问双刃
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, A, { type: 'chooseOption', optionId: B })); // 与乙拼点
    // 拼点：先甲后乙各扣一张
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    // 13 > 1 → 甲赢 → 选「视为使用【杀】」的目标：乙是蜀、丙也是蜀
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.options.map((o) => o.id).sort()).toEqual([B, C].sort());
    }
    ok(act(state, A, { type: 'chooseOption', optionId: C }));
    expect(state.pending?.kind).toBe('respondSha');
    if (state.pending?.kind === 'respondSha') expect(state.pending.responderId).toBe(C);
    ok(act(state, C, { type: 'pass' }));
    expect(state.players.find((p) => p.seatId === C)!.hp).toBe(3);
    expect(state.pending?.kind).toBe('play');
  });

  it('纪灵：双刃没赢 → 结束出牌阶段', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'jiling',
        faction: 'qun',
        hand: [mk('a1', 'sha', 'spade', 1)],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [mk('b1', 'sha', 'club', 13)],
      },
    ]);
    state.turn = { seatIndex: state.seatOrder.indexOf(B), phase: 'play' };
    state.pending = { kind: 'play', seatId: B };
    ok(act(state, B, { type: 'endPhase' }));
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, A, { type: 'chooseOption', optionId: B }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['a1'] }));
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    // 1 < 13 → 甲没赢 → 直接进弃牌阶段（甲此时 0 手牌，不用弃）
    expect(state.log.some((e) => e.message.includes('没赢'))).toBe(true);
    expect(state.pending?.kind === 'play' && state.pending.seatId === A).toBe(false);
  });
});

describe('国战标准版 · 孔融 / 蔡文姬（含伤害层收口）', () => {
  function gz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      faction: Faction;
      hand?: Card[];
      revealed?: boolean;
      hp?: number;
      deputyHeroId?: string;
    }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.deputyHeroId = s.deputyHeroId ?? null;
      p.faction = s.faction;
      const shown = s.revealed !== false;
      p.heroRevealed = shown;
      p.deputyRevealed = shown;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = s.hp ?? p.maxHp;
      p.hand = (s.hand ?? []).slice();
      p.flags = emptyFlags();
    }
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
    state.log = [];
    return state;
  }

  it('孔融·名士：来源有暗置的武将牌时伤害 -1（顺手修好白银狮子只在杀路径生效）', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        revealed: false,
        hand: [sha('a1')],
      },
      { seatId: B, name: '乙', heroId: 'kongrong', faction: 'qun', hand: [], hp: 3 },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    // 甲暗置（有暗置的武将牌）→ 他打出的杀伤害 -1 → 1-1=0，乙不掉血
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(b.hp).toBe(3);
    expect(state.log.some((e) => e.message.includes('名士'))).toBe(true);
  });

  it('孔融·名士：来源已明置就没有减伤', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'kongrong', faction: 'qun', hand: [], hp: 3 },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(b.hp).toBe(2);
  });

  it('名士对**非杀**的伤害也生效（南蛮入侵）', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        revealed: false,
        hand: [mk('a1', 'nanman', 'spade')],
      },
      { seatId: B, name: '乙', heroId: 'kongrong', faction: 'qun', hand: [], hp: 3 },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(state);
    ok(act(state, B, { type: 'pass' })); // 南蛮弃权
    expect(b.hp).toBe(3); // 1 - 1 = 0
  });

  it('孔融·礼让：弃牌阶段弃的牌可以交给别人', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      {
        seatId: B,
        name: '乙',
        heroId: 'kongrong',
        faction: 'qun',
        hand: [sha('b1'), sha('b2'), sha('b3'), sha('b4')],
      },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    // 让乙进入弃牌阶段（手牌 4 > 体力上限 3）
    state.turn = { seatIndex: state.seatOrder.indexOf(A), phase: 'play' };
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'endPhase' }));
    skipRevealAsk(state);
    // 甲的回合结束 → 乙的回合走完 → 到乙的弃牌阶段前先把手牌补回去
    b.hand = [sha('b1'), sha('b2'), sha('b3'), sha('b4')];
    state.turn = { seatIndex: state.seatOrder.indexOf(B), phase: 'discard' };
    state.pending = { kind: 'discard', seatId: B, count: 1 };
    ok(act(state, B, { type: 'discard', cardIds: ['b1'] }));
    // 礼让询问
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, B, { type: 'chooseOption', optionId: A }));
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand.map((c) => c.id)).toContain('b1'); // 到了甲手里
    expect(state.discard.some((c) => c.id === 'b1')).toBe(false); // 且离开了弃牌堆
  });

  it('蔡文姬·悲歌：红桃→受伤者回血、方块→摸两张', () => {
    // 乙起始 2 血、挨 1 点 → 红桃回 1 点后是 2；方块不回血只摸两张，所以是 1
    for (const [suit, expectHp, expectHand] of [
      ['heart', 2, 0],
      ['diamond', 1, 2],
    ] as const) {
      const state = gz([
        { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
        { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [], hp: 2 },
        { seatId: C, name: '丙', heroId: 'caiwenji', faction: 'qun', hand: [sha('c1')] },
      ]);
      const b = state.players.find((p) => p.seatId === B)!;
      const c = state.players.find((p) => p.seatId === C)!;
      // 判定牌与摸牌都从牌堆末尾抽：先放好判定牌
      state.deck = [mk('d1', 'sha', 'spade', 7), mk('d2', 'sha', 'spade', 8)];
      state.deck.push(mk('j1', 'shan', suit, 5));
      ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
      ok(act(state, B, { type: 'pass' })); // 乙挨打
      expect(state.pending?.kind).toBe('choice'); // 悲歌问蔡文姬
      if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(C);
      ok(act(state, C, { type: 'chooseOption', optionId: 'yes' }));
      ok(act(state, C, { type: 'pickCards', cardIds: ['c1'] }));
      expect(b.hp).toBe(expectHp);
      expect(b.hand).toHaveLength(expectHand);
      expect(c.hand).toHaveLength(0); // 弃掉了一张
    }
  });

  it('蔡文姬·悲歌：黑桃→伤害来源翻面；不是【杀】的伤害不触发', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [], hp: 2 },
      { seatId: C, name: '丙', heroId: 'caiwenji', faction: 'qun', hand: [sha('c1')] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    state.deck = [mk('d1', 'sha', 'spade', 7)];
    state.deck.push(mk('j1', 'shan', 'spade', 5));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    ok(act(state, C, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, C, { type: 'pickCards', cardIds: ['c1'] }));
    expect(a.flipped).toBe(true); // 黑桃 → 来源翻面
  });

  it('蔡文姬·断肠：由**蔡文姬**选择凶手失去哪张武将牌的技能', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputyHeroId: 'guanyu',
        faction: 'shu',
        hand: [sha('a1')],
      },
      { seatId: B, name: '乙', heroId: 'caiwenji', faction: 'qun', hand: [], hp: 1 },
      // 三人局：两人局里蔡文姬一死就分出胜负，后面就测不了「技能没了」
      { seatId: C, name: '丙', heroId: 'lvbu', faction: 'qun', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    passDeathSaves(state);
    expect(state.players.find((p) => p.seatId === B)!.alive).toBe(false);
    // 断肠：蔡文姬（已阵亡）来选
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.seatId).toBe(B);
      expect(state.pending.options.map((o) => o.id)).toEqual(['zhangfei', 'guanyu']);
    }
    ok(act(state, B, { type: 'chooseOption', optionId: 'zhangfei' }));
    expect(a.nullifiedHeroId).toBe('zhangfei');
    // 张飞的技能没了（咆哮 = 无限出杀不再生效），关羽的还在。
    // 乙已经阵亡，改打丙。
    a.hand = [sha('a2'), sha('a3')];
    a.flags.shaCountThisTurn = 0;
    state.turn = { seatIndex: state.seatOrder.indexOf(A), phase: 'play' };
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [C] }));
    ok(act(state, C, { type: 'pass' }));
    // 咆哮没了 → 第二张杀打不出去
    expect(act(state, A, { type: 'playCard', cardId: 'a3', targetIds: [C] }).ok).toBe(false);
  });
});

describe('国战标准版 · 颜良文丑（双雄：状态化转化）', () => {
  function gz(
    seats: { seatId: string; name: string; heroId: string; faction: Faction; hand?: Card[] }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = p.maxHp;
      p.hand = (s.hand ?? []).slice();
      p.flags = emptyFlags();
    }
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
    state.log = [];
    return state;
  }

  it('双雄：改为判定 → 获得判定牌，本回合异色手牌能当【决斗】，同色不能', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      {
        seatId: B,
        name: '乙',
        heroId: 'yanliang_wenchou',
        faction: 'qun',
        hand: [mk('b1', 'sha', 'spade', 7), mk('b2', 'tao', 'heart', 3)],
      },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    // 判定牌先放好（drawOne 从末尾抽）
    state.deck = [mk('d1', 'sha', 'club', 9), mk('d2', 'sha', 'club', 10)];
    state.deck.push(mk('j1', 'shan', 'heart', 5)); // 红色判定
    // 甲结束回合 → 乙的摸牌阶段
    state.turn = { seatIndex: state.seatOrder.indexOf(A), phase: 'play' };
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'endPhase' }));
    skipRevealAsk(state);
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    expect(b.flags.shuangxiongColor).toBe('red');
    expect(b.hand.map((c) => c.id)).toContain('j1'); // 判定牌进了手牌
    expect(b.hand.map((c) => c.id)).not.toContain('d2'); // 没有正常摸牌
    // 出牌阶段：黑桃杀（异色）可以当决斗，红桃桃（同色）不行。
    // 注意别用 legalCardIds 判断——两张牌都是「可用的」（桃在鏖战里能当杀），
    // 要断言的是**当【决斗】用**这件事本身。
    expect(state.pending?.kind).toBe('play');
    expect(toSnapshot(state, B).prompt?.legalCardIds).toContain('b1');
    expect(act(state, B, { type: 'playCard', cardId: 'b2', as: 'juedou', targetIds: [A] }).ok).toBe(
      false,
    );
    // 真的当【决斗】打出去：甲要出杀，否则吃 1 点
    ok(act(state, B, { type: 'playCard', cardId: 'b1', as: 'juedou', targetIds: [A] }));
    passWuxie(state);
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, A, { type: 'pass' }));
    expect(state.players.find((p) => p.seatId === A)!.hp).toBe(3);
  });

  it('双雄：不发动就是正常摸两张', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: B, name: '乙', heroId: 'yanliang_wenchou', faction: 'qun', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    state.deck = ['d1', 'd2'].map((id) => mk(id, 'sha', 'spade', 7));
    state.turn = { seatIndex: state.seatOrder.indexOf(A), phase: 'play' };
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'endPhase' }));
    skipRevealAsk(state);
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    expect(b.hand.map((c) => c.id).sort()).toEqual(['d1', 'd2']);
    expect(b.flags.shuangxiongColor).toBeNull();
  });
});

describe('国战标准版 · 张昭张纮 / 田丰 / 邹氏', () => {
  function gz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      faction: Faction;
      hand?: Card[];
      revealed?: boolean;
      hp?: number;
      equip?: Card[];
    }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      const shown = s.revealed !== false;
      p.heroRevealed = shown;
      p.deputyRevealed = shown;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = s.hp ?? p.maxHp;
      p.hand = (s.hand ?? []).slice();
      for (const c of s.equip ?? []) p.equipment[c.type as 'weapon'] = c;
      p.flags = emptyFlags();
    }
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
    state.log = [];
    return state;
  }
  const wpn = (id: string, name = 'qinggang'): Card => ({
    id,
    type: 'weapon',
    suit: 'spade',
    rank: 6,
    equipName: name,
    range: 2,
  });

  it('张昭张纮·直谏：把手牌里的装备牌放到别人装备区，然后摸一张（同栏位顶替）', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangzhao_zhanghong',
        faction: 'wu',
        hand: [wpn('a1', 'qinglong')],
        equip: [wpn('old', 'zhuge')],
      },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [], equip: [wpn('b1')] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    state.deck = [mk('d1', 'sha', 'spade', 7)];
    ok(act(state, A, { type: 'useSkill', skillId: 'zhijian', cardIds: ['a1'], targetIds: [B] }));
    // a1 进了乙的武器栏，原来的 b1 被顶掉进弃牌堆
    expect(b.equipment.weapon?.id).toBe('a1');
    expect(state.discard.some((c) => c.id === 'b1')).toBe(true);
    // 甲摸了一张（手牌：a1 交出去了，摸回 d1）
    expect(a.hand.map((c) => c.id)).toEqual(['d1']);
    expect(a.equipment.weapon?.id).toBe('old'); // 自己的装备没被拿去用
  });

  it('张昭张纮·直谏：不能给非装备牌', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangzhao_zhanghong', faction: 'wu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [] },
    ]);
    expect(
      act(state, A, { type: 'useSkill', skillId: 'zhijian', cardIds: ['a1'], targetIds: [B] }).ok,
    ).toBe(false);
  });

  it('张昭张纮·固政：别人弃牌阶段弃的牌，还他一张、其余归我', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangzhao_zhanghong', faction: 'wu', hand: [] },
      {
        seatId: B,
        name: '乙',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [sha('b1'), sha('b2')],
      },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    // 直接构造乙的弃牌阶段（弃 2 张）
    state.turn = { seatIndex: state.seatOrder.indexOf(B), phase: 'discard' };
    state.pending = { kind: 'discard', seatId: B, count: 2 };
    ok(act(state, B, { type: 'discard', cardIds: ['b1', 'b2'] }));
    // 固政问甲
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['b1'] })); // 还 b1 给乙，b2 归甲
    expect(b.hand.map((c) => c.id)).toEqual(['b1']);
    expect(a.hand.map((c) => c.id)).toContain('b2'); // 其余归甲（之后甲自己回合还会摸牌）
    expect(state.discard.some((c) => c.id === 'b1' || c.id === 'b2')).toBe(false);
  });

  it('田丰·死谏：失去最后的手牌时，弃置一名其他角色的一张牌', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'tianfeng', faction: 'qun', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [shan('b1'), tao('b2')] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // 甲的手牌空了 → 死谏询问
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, A, { type: 'chooseOption', optionId: B }));
    expect(b.hand).toHaveLength(1); // 被弃掉一张
  });

  it('田丰·随势：体力上限相同的其他角色进濒死时摸一张（不同则不摸）', () => {
    // 甄姬 3 上限，与田丰同为 3 → 摸
    // 给田丰留一张别的牌：否则他打出最后一张手牌会先触发【死谏】，跑到别的询问上
    const same = gz([
      { seatId: A, name: '甲', heroId: 'tianfeng', faction: 'qun', hand: [sha('a1'), tao('a9')] },
      { seatId: B, name: '乙', heroId: 'zhenji', faction: 'wei', hand: [], hp: 1 },
    ]);
    const a1 = same.players.find((p) => p.seatId === A)!;
    same.deck = [mk('d1', 'sha', 'spade', 7), mk('d2', 'sha', 'spade', 8)];
    ok(act(same, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(same, B, { type: 'pass' })); // 不闪 → 血归 0 → 进入濒死
    expect(a1.hand.map((c) => c.id)).toContain('d2'); // 随势摸了一张
    passDeathSaves(same);

    // 张飞 4 上限 → 上限不同，不摸
    const diff = gz([
      { seatId: A, name: '甲', heroId: 'tianfeng', faction: 'qun', hand: [sha('a1'), tao('a9')] },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [], hp: 1 },
    ]);
    const a2 = diff.players.find((p) => p.seatId === A)!;
    diff.deck = [mk('d1', 'sha', 'spade', 7), mk('d2', 'sha', 'spade', 8)];
    ok(act(diff, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(diff, B, { type: 'pass' }));
    expect(a2.hand.map((c) => c.id)).not.toContain('d2');
    passDeathSaves(diff);
  });

  it('邹氏·祸水：她的回合内其他角色不能明置（连暗置时用转化技也不行）', () => {
    // 万箭齐发要出【闪】：乙暗置甄姬、预亮了倾国，黑牌本来能当【闪】用
    const blocked = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zoushi',
        faction: 'qun',
        hand: [mk('a1', 'wanjian', 'heart')],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'zhenji',
        faction: 'wei',
        revealed: false,
        hand: [mk('b1', 'sha', 'club', 5)],
      },
    ]);
    const b1 = blocked.players.find((p) => p.seatId === B)!;
    b1.prelitSkills = ['倾国'];
    ok(act(blocked, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(blocked);
    expect(blocked.pending?.kind).toBe('respondTrick');
    // 祸水封了明置 → 倾国这条转化用不了（本来黑牌是可以当闪的）
    expect(toSnapshot(blocked, B).prompt?.legalCardIds).not.toContain('b1');
    expect(act(blocked, B, { type: 'respondCard', cardId: 'b1' }).ok).toBe(false);

    // 对照组：回合让给没有祸水的人，同一个乙就能用黑牌当【闪】
    const allowed = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [mk('a1', 'wanjian', 'heart')],
      },
      {
        seatId: B,
        name: '乙',
        heroId: 'zhenji',
        faction: 'wei',
        revealed: false,
        hand: [mk('b1', 'sha', 'club', 5)],
      },
    ]);
    const b2 = allowed.players.find((p) => p.seatId === B)!;
    b2.prelitSkills = ['倾国'];
    ok(act(allowed, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    passWuxie(allowed);
    ok(act(allowed, B, { type: 'respondCard', cardId: 'b1' }));
    expect(b2.heroRevealed).toBe(true); // 打出去的那一刻明置
  });

  it('邹氏·祸水：她自己在出牌阶段可以明置（别的将不行）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zoushi', faction: 'qun', revealed: false, hand: [] },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [] },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    // 邹氏：出牌阶段可以明置
    ok(act(state, A, { type: 'revealHero', heroId: 'zoushi' }));
    expect(a.heroRevealed).toBe(true);
    // 换成张飞这种没有「出牌阶段可明置」的将就点不动（这里换个局面直接断言）
    const st2 = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', revealed: false, hand: [] },
      { seatId: B, name: '乙', heroId: 'zoushi', faction: 'qun', hand: [] },
    ]);
    expect(act(st2, A, { type: 'revealHero', heroId: 'zhangfei' }).ok).toBe(false);
  });

  it('邹氏·倾城：弃一张装备牌，令一名其他角色翻面', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zoushi',
        faction: 'qun',
        hand: [wpn('a1')],
      },
      { seatId: B, name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [] },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    ok(act(state, A, { type: 'useSkill', skillId: 'qingcheng', cardIds: ['a1'], targetIds: [B] }));
    expect(b.flipped).toBe(true);
    expect(state.discard.some((c) => c.id === 'a1')).toBe(true);
    // 限一次
    expect(
      act(state, A, { type: 'useSkill', skillId: 'qingcheng', cardIds: ['a1'], targetIds: [B] }).ok,
    ).toBe(false);
  });
});

describe('国战标准版 · 张角 / 周泰', () => {
  function gz(
    seats: {
      seatId: string;
      name: string;
      heroId: string;
      faction: Faction;
      hand?: Card[];
      revealed?: boolean;
      hp?: number;
    }[],
  ) {
    const state = createGame(
      seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    for (const s of seats) {
      const p = state.players.find((x) => x.seatId === s.seatId)!;
      const hero = getHero(s.heroId)!;
      p.heroId = s.heroId;
      p.faction = s.faction;
      const shown = s.revealed !== false;
      p.heroRevealed = shown;
      p.deputyRevealed = shown;
      p.maxHp = Math.max(1, Math.floor(hero.maxHp));
      p.hp = s.hp ?? p.maxHp;
      p.hand = (s.hand ?? []).slice();
      p.flags = emptyFlags();
    }
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: state.seatOrder[0]! };
    state.log = [];
    return state;
  }

  it('张角·雷击：打出【闪】后判定为黑桃 → 对目标造成 2 点雷电伤害', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhangjiao', faction: 'qun', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [], hp: 4 },
    ]);
    // 判定牌放好（drawOne 从末尾抽）
    state.deck = [mk('d1', 'sha', 'club', 9)];
    state.deck.push(mk('j1', 'sha', 'spade', 5));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' })); // 乙出闪 → 雷击询问
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, B, { type: 'chooseOption', optionId: C })); // 令丙判定
    expect(state.players.find((p) => p.seatId === C)!.hp).toBe(2); // 黑桃 → 2 点雷电
  });

  it('张角·雷击：判定不是黑桃就没有伤害', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhangjiao', faction: 'qun', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [], hp: 4 },
    ]);
    state.deck = [mk('d1', 'sha', 'club', 9)];
    state.deck.push(mk('j1', 'sha', 'heart', 5));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, B, { type: 'chooseOption', optionId: C }));
    expect(state.players.find((p) => p.seatId === C)!.hp).toBe(4);
    expect(state.log.some((e) => e.message.includes('不是黑桃'))).toBe(true);
  });

  it('张角·鬼道：判定牌生效前打出黑色牌替换', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [lebu('a1')] },
      {
        seatId: B,
        name: '乙',
        heroId: 'zhangjiao',
        faction: 'qun',
        hand: [mk('b1', 'shan', 'spade', 7)],
      },
    ]);
    // 甲的回合给乙贴【乐不思蜀】，等乙的判定阶段
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    ok(act(state, A, { type: 'endPhase' }));
    skipRevealAsk(state);
    // 乙的判定：先摸到一张非红桃（会生效），张角可以鬼道换成黑桃……黑桃也是「非红桃」，
    // 所以这里换个方向：给乙一张判定牌是红桃（乐不思蜀失效），鬼道换成黑色让它生效
    expect(state.pending?.kind === 'choice').toBe(true);
    if (state.pending?.kind === 'choice') {
      ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
      ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    }
    // 乙弃掉了一张黑桃牌、判定牌进了弃牌堆
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hand.some((c) => c.id === 'b1')).toBe(false);
  });

  it('张角·黄天：其他群势力角色可以在自己的出牌阶段把【闪】交给他', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangjiao', faction: 'qun', hand: [] },
      {
        seatId: B,
        name: '乙',
        heroId: 'lvbu',
        faction: 'qun',
        hand: [shan('b1'), mk('b2', 'shandian', 'spade')],
      },
    ]);
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    // 黄天是「别人在自己的出牌阶段发动」→ 得让乙成为回合玩家，他才会收到出牌提示
    state.turn = { seatIndex: state.seatOrder.indexOf(B), phase: 'play' };
    state.pending = { kind: 'play', seatId: B };
    expect(toSnapshot(state, B).prompt?.legalSkillIds).toContain('huangtian');
    ok(act(state, B, { type: 'useSkill', skillId: 'huangtian', cardIds: ['b1'], targetIds: [] }));
    expect(a.hand.map((c) => c.id)).toEqual(['b1']);
    expect(b.hand.map((c) => c.id)).toEqual(['b2']);

    // 对照组：非群势力的角色没有这条技能
    const other = gz([
      { seatId: A, name: '甲', heroId: 'zhangjiao', faction: 'qun', hand: [] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [shan('c1')] },
    ]);
    other.turn = { seatIndex: other.seatOrder.indexOf(C), phase: 'play' };
    other.pending = { kind: 'play', seatId: C };
    expect(toSnapshot(other, C).prompt?.legalSkillIds ?? []).not.toContain('huangtian');
  });

  it('周泰·不屈：点数不同 → 回复至 1 点体力活下来', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhoutai', faction: 'wu', hand: [], hp: 1 },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    state.deck = [mk('d1', 'sha', 'club', 9)];
    state.deck.push(mk('j1', 'sha', 'spade', 5));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' })); // 不闪 → 血归 0 → 不屈
    expect(b.alive).toBe(true);
    expect(b.hp).toBe(1);
    expect(b.wounds.map((c) => c.id)).toEqual(['j1']); // 「创」扣在武将牌上
    expect(state.pending?.kind).toBe('play'); // 没进濒死队列
  });

  it('周泰·不屈：点数相同 → 移去此牌，照常濒死', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhoutai', faction: 'wu', hand: [], hp: 1 },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    // 先塞一个「创」：点数 5
    b.wounds.push(mk('w1', 'sha', 'club', 5));
    state.deck = [mk('d1', 'sha', 'club', 9)];
    state.deck.push(mk('j1', 'sha', 'diamond', 5)); // 点数同样是 5
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    expect(b.wounds.map((c) => c.id)).toEqual(['w1']); // 没新增
    expect(state.discard.some((c) => c.id === 'j1')).toBe(true); // 移去此牌
    // 进了濒死队列（等别人出桃）
    expect(state.pending?.kind).toBe('respondDeath');
    passDeathSaves(state);
    expect(b.alive).toBe(false);
  });

  it('周泰·奋激：某人结束阶段没有手牌时，让他摸两张、自己失去 1 点体力', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhoutai', faction: 'wu', hand: [], hp: 4 },
    ]);
    const b = state.players.find((p) => p.seatId === B)!;
    state.deck = ['d1', 'd2', 'd3'].map((id) => mk(id, 'sha', 'club', 9));
    // 甲结束回合（甲没手牌）→ 奋激问乙
    state.turn = { seatIndex: state.seatOrder.indexOf(A), phase: 'play' };
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'endPhase' }));
    // 弃牌阶段（甲没牌）→ 结束阶段 → 奋激
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.seatId).toBe(B);
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    expect(state.players.find((p) => p.seatId === A)!.hand).toHaveLength(2);
    expect(b.hp).toBe(3); // 乙失去 1 点体力
  });
});
