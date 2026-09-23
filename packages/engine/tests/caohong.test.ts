/**
 * **曹洪（魏·君临天下·阵）**：按 **2026-08-28 阵法技改版**（用户 2026-09-26 口径）。
 *
 * 【鹤翼】阵法技、锁定技，**两态互斥**（旧版只有「同队列其他角色有飞影」这一半）：
 * - 常规（没进队列）：**曹洪自己**视为拥有【飞影】；
 * - 队列（与同势力连续相邻 ≥2）：**改为**同队列的**其他**角色视为拥有【飞影】，曹洪自己**不再**享受。
 *
 * 【护援】结束阶段：把一张装备牌**置入**一名角色的装备区（**栏位须为空**、装备牌可来自
 * 手牌或**自己装备区**、可以给自己），然后**可以**弃置「**接收者**距离 1」的一名角色的一张牌
 * （距离在装备置入**之后**现算；弃谁的牌由曹洪挑、手牌只给牌背、判定区不在候选）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyIntent,
  createGame,
  distance,
  emptyFlags,
  formationQueue,
  getHeroForMode,
  hasFeiying,
  heyiInFormation,
  toSnapshot,
  type GameState,
} from '../src';
import type { Card, Faction } from '@sgs/protocol';

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
const wpn = (id: string, name = 'qinggang'): Card =>
  ({ ...mk(id, 'weapon', 'spade', 6), equipName: name, range: 2 }) as Card;
const armor = (id: string, name = 'bagua'): Card =>
  ({ ...mk(id, 'armor', 'club', 2), equipName: name }) as Card;
/** −1 马（他计算与其他角色的距离 −1）——验「置入后重算」要用它，见下面那条用例的说明 */
const minusHorse = (id: string): Card =>
  ({ ...mk(id, 'minusMount', 'diamond', 13), equipName: 'chitu' }) as Card;

interface Seat {
  seatId: string;
  name: string;
  heroId: string;
  faction?: Faction;
  hand?: Card[];
  equip?: { slot: 'weapon' | 'armor' | 'plusMount' | 'minusMount' | 'treasure'; card: Card };
  reveal?: boolean;
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
    const shown = s.reveal !== false;
    p.heroRevealed = shown;
    p.deputyRevealed = shown;
    p.hand = (s.hand ?? []).slice();
    if (s.equip) p.equipment[s.equip.slot] = s.equip.card;
    p.flags = emptyFlags();
    p.maxHp = 4;
    p.hp = 4;
  }
  const idx = state.seatOrder.indexOf(turnSeat);
  state.turn = { seatIndex: idx < 0 ? 0 : idx, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[state.turn.seatIndex]! };
  state.log = [];
  return state;
}

describe('【鹤翼】两态互斥（2026-08-28 改版）', () => {
  /** 无队列：曹洪(魏) 的左右都是蜀 */
  function noQueue(): GameState {
    return gz([
      { seatId: 's0', name: '曹洪', heroId: 'caohong', faction: 'wei' },
      { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu' },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'shu' },
      { seatId: 's3', name: '丁', heroId: 'guanyu', faction: 'shu' },
    ]);
  }
  /** 有队列：曹洪 与相邻的乙（同为魏）连续相邻 */
  function inQueue(): GameState {
    return gz([
      { seatId: 's0', name: '曹洪', heroId: 'caohong', faction: 'wei' },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'shu' },
      { seatId: 's3', name: '丁', heroId: 'guanyu', faction: 'shu' },
    ]);
  }

  it('常规态：**曹洪自己**有飞影（别人算到他的距离 +1），别人之间不受影响', () => {
    const state = noQueue();
    expect(heyiInFormation(state, at(state, 's0')), '没队列').toBe(false);
    expect(hasFeiying(state, at(state, 's0')), '常规 ⇒ 曹洪自己视为拥有飞影').toBe(true);
    expect(distance(state, 's2', 's0'), '丙 → 曹洪：2 + 1（飞影）= 3').toBe(3);
    expect(distance(state, 's2', 's1'), '丙 → 乙：正常 1').toBe(1);
  });

  it('队列态：飞影**转移**给同队列的其他人，曹洪自己**不再**有（不是全员都有）', () => {
    const state = inQueue();
    expect(formationQueue(state, at(state, 's0')).map((p) => p.seatId).sort(), '队列=曹洪+乙').toEqual([
      's0',
      's1',
    ]);
    expect(heyiInFormation(state, at(state, 's0')), '进了队列').toBe(true);
    expect(hasFeiying(state, at(state, 's0')), '曹洪自己的飞影熄灭').toBe(false);
    expect(hasFeiying(state, at(state, 's1')), '同队列的乙获得飞影').toBe(true);
    expect(distance(state, 's2', 's1'), '丙 → 乙：1 + 1（鹤翼给的飞影）= 2').toBe(2);
    expect(distance(state, 's2', 's0'), '丙 → 曹洪：不再 +1，就是 2').toBe(2);
  });

  it('队列**断开** ⇒ 立刻回到常规（曹洪自己重新有飞影）', () => {
    const state = inQueue();
    expect(hasFeiying(state, at(state, 's1'))).toBe(true);
    // 乙 改成蜀 ⇒ 队列断开
    at(state, 's1').faction = 'shu';
    expect(heyiInFormation(state, at(state, 's0'))).toBe(false);
    expect(hasFeiying(state, at(state, 's0')), '回到常规').toBe(true);
    expect(hasFeiying(state, at(state, 's1')), '乙失去鹤翼给的飞影').toBe(false);
    expect(distance(state, 's2', 's1')).toBe(1);
  });

  it('队列成员**死亡** ⇒ 实时重算（不等下一回合）', () => {
    // ⚠️ 用 5 人局：阵法技有个既有的全局前提「存活角色 ≥4」（与风扬同一口径），
    //    4 人局死一个就整条阵法不成立、看不出「重算」这件事。
    const state = gz([
      { seatId: 's0', name: '曹洪', heroId: 'caohong', faction: 'wei' },
      { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'shu' },
      { seatId: 's3', name: '丁', heroId: 'guanyu', faction: 'shu' },
      { seatId: 's4', name: '戊', heroId: 'zhangfei', faction: 'shu' },
    ]);
    expect(heyiInFormation(state, at(state, 's0')), '乙在 ⇒ 队列成立').toBe(true);
    expect(hasFeiying(state, at(state, 's0')), '队列态 ⇒ 曹洪自己没有飞影').toBe(false);
    at(state, 's1').alive = false; // 乙死了 ⇒ 曹洪边上只剩蜀
    expect(heyiInFormation(state, at(state, 's0'))).toBe(false);
    expect(hasFeiying(state, at(state, 's0')), '回到常规 ⇒ 飞影回到曹洪身上').toBe(true);
  });

  it('（既有的）阵法技全局前提：存活不足 4 人时整条阵法不成立', () => {
    const state = inQueue();
    at(state, 's3').alive = false; // 只剩 3 人
    expect(hasFeiying(state, at(state, 's0')), '常规态也不给').toBe(false);
    expect(hasFeiying(state, at(state, 's1'))).toBe(false);
  });

  it('**暗将不参与**公开势力队列（不偷看底牌）', () => {
    const state = inQueue();
    at(state, 's1').heroRevealed = false;
    at(state, 's1').deputyRevealed = false; // 乙还是魏将，但没明置
    expect(heyiInFormation(state, at(state, 's0')), '暗将不算队列').toBe(false);
    expect(hasFeiying(state, at(state, 's1')), '暗将也没有飞影').toBe(false);
  });

  it('快照把「飞影归谁 / 鹤翼形态」作为**公开状态**下发（界面据此画标）', () => {
    const noQ = noQueue();
    const viewOf = (state: GameState, viewer: string, seat: string) =>
      toSnapshot(state, viewer).players.find((x) => x.seatId === seat)!;
    // 常规态：曹洪自己有飞影（来源＝他自己），形态 normal
    expect(viewOf(noQ, 's2', 's0').feiying, '别人也看得到曹洪有飞影').toBe(true);
    expect(viewOf(noQ, 's2', 's0').feiyingFrom, '来源＝曹洪自己').toBe('s0');
    expect(viewOf(noQ, 's2', 's0').heyiMode).toBe('normal');
    expect(viewOf(noQ, 's2', 's1').feiying).toBeUndefined();

    const q = inQueue();
    expect(viewOf(q, 's2', 's0').feiying, '队列态：曹洪自己没有').toBeUndefined();
    expect(viewOf(q, 's2', 's0').heyiMode).toBe('formation');
    expect(viewOf(q, 's2', 's1').feiying, '同队列的乙有').toBe(true);
    expect(viewOf(q, 's2', 's1').feiyingFrom, '来源＝曹洪').toBe('s0');
    expect(viewOf(q, 's2', 's1').heyiMode, '乙自己没有鹤翼').toBeUndefined();
  });

  it('飞影**实时**参与距离判定：【杀】够不到曹洪', () => {
    const state = noQueue();
    // 丙 与 曹洪 距离 3（含飞影），丙 的【杀】打不到他
    at(state, 's2').hand = [mk('c1', 'sha', 'spade', 7)];
    state.turn = { seatIndex: 2, phase: 'play' };
    state.pending = { kind: 'play', seatId: 's2' };
    bad(
      act(state, 's2', { type: 'playCard', cardId: 'c1', targetIds: ['s0'] }),
      '距离 3 ⇒ 杀够不到',
    );
    ok(
      act(state, 's2', { type: 'playCard', cardId: 'c1', targetIds: ['s1'] }),
      '打距离 1 的乙可以',
    );
  });

  it('仓库里**没有**「阵法召唤」（2026-08-28 已移除）', () => {
    const src = readFileSync(join(__dirname, '../src/heroes.ts'), 'utf8');
    // ⚠️ 只看**技能 id / 主动技**：源码里有「2026-08-28 官方删除、本仓库随之删掉」的历史注释，
    //    那是存底、不是实现（用注释里的字面词去断言会把存底也一起禁掉）。
    expect(src).not.toContain('zhenfa_summon');
    // 曹洪的阵法技也不该是主动技
    const h = getHeroForMode('caohong', 'guozhan')!;
    expect(h.activeSkills ?? []).toHaveLength(0);
  });

  it('文本是现行口径（常规/队列两句都在）', () => {
    const desc = getHeroForMode('caohong', 'guozhan')!.skills.find((s) => s.name === '鹤翼')!.desc ?? '';
    expect(desc).toContain('阵法技，锁定技');
    expect(desc).toContain('常规：你视为拥有【飞影】');
    expect(desc).toContain('队列：改为与你处于同一队列的其他角色视为拥有【飞影】');
  });
});

describe('【护援】：结束阶段置入装备（栏位须为空）+ 可选拆牌', () => {
  /**
   * 曹洪（甲）+ 接收者（乙）+ 两个陪坐；把回合推到**甲的结束阶段**。
   * 座次是环 s0→s1→s2→s3：先手给丁(s3)，收掉丁的回合就轮到甲；再把甲的出牌阶段走完，
   * 才到他的结束阶段（【护援】挂在那里）。
   */
  function endPhase(seats: Seat[]): GameState {
    const state = gz(seats, 's3');
    ok(act(state, 's3', { type: 'endPhase' }), '丁结束');
    while (state.pending?.kind === 'discard') ok(act(state, 's3', { type: 'discard', cardIds: [] }));
    ok(act(state, 's0', { type: 'endPhase' }), '甲的出牌阶段结束');
    let guard = 0;
    while (state.pending?.kind === 'discard' && guard++ < 8) {
      const need = (state.pending as { count?: number }).count ?? 1;
      const ids = at(state, 's0').hand.map((c) => c.id).slice(0, need);
      ok(act(state, 's0', { type: 'discard', cardIds: ids }), '甲弃牌');
    }
    return state;
  }
  /** 甲（曹洪）发动护援、选一张牌、选接收者 */
  function huyuan(state: GameState, cardId: string, toSeat: string): void {
    const ask = state.pending;
    expect(ask?.kind, '结束阶段问护援').toBe('choice');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }), '发动');
    ok(act(state, 's0', { type: 'pickCards', cardIds: [cardId] }), '选装备牌');
    ok(act(state, 's0', { type: 'chooseOption', optionId: toSeat }), '选接收者');
  }

  it('只在**结束阶段**问，且可以不发动', () => {
    const state = endPhase([
      { seatId: 's0', name: '曹洪', heroId: 'caohong', faction: 'wei', hand: [armor('h1')] },
      { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu' },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'shu' },
      { seatId: 's3', name: '丁', heroId: 'guanyu', faction: 'shu' },
    ]);
    expect(state.pending?.kind, '结束阶段的那一问').toBe('choice');
    if (state.pending?.kind === 'choice') expect(state.pending.title).toContain('护援');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'no' }), '不发动');
    expect(at(state, 's1').equipment.armor, '什么都没发生').toBeNull();
  });

  it('手牌里的装备可以置入别人的**空栏位**；**已占用的同类栏位不能选**', () => {
    const state = endPhase([
      { seatId: 's0', name: '曹洪', heroId: 'caohong', faction: 'wei', hand: [wpn('h1'), armor('h2')] },
      { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu', equip: { slot: 'weapon', card: wpn('b1') } },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'shu' },
      { seatId: 's3', name: '丁', heroId: 'guanyu', faction: 'shu' },
    ]);
    // 选武器：乙的武器栏已占 ⇒ 乙不该出现在接收者里
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, 's0', { type: 'pickCards', cardIds: ['h1'] }), '选青釭剑');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.options.map((o) => o.id), '乙（武器栏已占）不在候选').not.toContain('s1');
      expect(state.pending.options.map((o) => o.id), '空栏位的丙丁在').toEqual(['s0', 's2', 's3']);
    }
    ok(act(state, 's0', { type: 'chooseOption', optionId: 's2' }), '给丙');
    expect(at(state, 's2').equipment.weapon?.id).toBe('h1');
    expect(at(state, 's1').equipment.weapon?.id, '乙的武器没被顶掉').toBe('b1');
  });

  it('**自己装备区**里的装备也可以移给别人（先派「失去装备」，再置入）', () => {
    const state = endPhase([
      { seatId: 's0', name: '曹洪', heroId: 'caohong', faction: 'wei', equip: { slot: 'armor', card: armor('m1') } },
      { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu' },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'shu' },
      { seatId: 's3', name: '丁', heroId: 'guanyu', faction: 'shu' },
    ]);
    huyuan(state, 'm1', 's1');
    expect(at(state, 's0').equipment.armor, '自己槽腾空了').toBeNull();
    expect(at(state, 's1').equipment.armor?.id, '乙拿到了').toBe('m1');
  });

  it('可以**给自己**（自己对应栏位为空时）', () => {
    const state = endPhase([
      { seatId: 's0', name: '曹洪', heroId: 'caohong', faction: 'wei', hand: [armor('h1')] },
      { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu' },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'shu' },
      { seatId: 's3', name: '丁', heroId: 'guanyu', faction: 'shu' },
    ]);
    huyuan(state, 'h1', 's0');
    expect(at(state, 's0').equipment.armor?.id).toBe('h1');
  });

  it('第二段以**接收者**为距离中心；本人不算；曹洪自己可以算', () => {
    // 环形 甲-乙-丙-丁：乙 的距离 1 只有 甲 和 丙
    const state = endPhase([
      { seatId: 's0', name: '曹洪', heroId: 'caohong', faction: 'wei', hand: [armor('h1')] },
      { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [mk('b1', 'tao', 'heart', 3)] },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'shu', hand: [mk('c1', 'tao', 'heart', 4)] },
      { seatId: 's3', name: '丁', heroId: 'guanyu', faction: 'shu', hand: [mk('d1', 'tao', 'heart', 5)] },
    ]);
    huyuan(state, 'h1', 's1');
    const p = state.pending;
    expect(p?.kind, '第二段的那一问').toBe('choice');
    if (p?.kind === 'choice') {
      const ids = p.options.map((o) => o.id);
      // ⚠️ 曹洪处于**常规态** ⇒ 他身上的飞影让「别人算到他的距离 +1」⇒ 乙 → 甲 也是 2、甲不在候选里；
      //    丁 在环上的距离是 2。所以这里只剩丙。
      expect(ids, '只有丙（甲被自己的飞影挡住、丁距离 2、乙本人不算）').toEqual(['s2', 'no']);
      expect(p.relatedSeats, '把「护援中心」标出来').toEqual(['s1']);
    }
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'no' }), '可以不弃置');
    expect(at(state, 's2').hand, '没人被拆').toHaveLength(1);
  });

  it('**距离在装备置入之后重算**：送一张 −1 马给乙 ⇒ 距离 2 的丁进入候选', () => {
    // ⚠️ 方向很要紧：第二段量的是「**接收者** → 其他人」的距离。
    //    · +1 马（别人算到**他**的距离 +1）**不会**改变他本人的出向距离 ⇒ 用它做不出判别力；
    //    · **−1 马**（他计算与其他人的距离 −1）才会把他与别人的距离缩短 ⇒ 用它验「置入后重算」。
    //    这里：乙 → 丁 本来 2，拿到 −1 马后变 1 ⇒ 丁应当出现在候选里（送之前不在）。
    const state = endPhase([
      { seatId: 's0', name: '曹洪', heroId: 'caohong', faction: 'wei', hand: [minusHorse('h1')] },
      { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu' },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'shu' },
      { seatId: 's3', name: '丁', heroId: 'guanyu', faction: 'shu' },
    ]);
    expect(distance(state, 's1', 's3'), '送之前：乙 → 丁 = 2').toBe(2);
    huyuan(state, 'h1', 's1');
    expect(at(state, 's1').equipment.minusMount?.id, '马确实置入了乙的 −1 马栏位').toBe('h1');
    expect(distance(state, 's1', 's3'), '送之后（−1 马）：= 1').toBe(1);
    const p = state.pending;
    if (p?.kind === 'choice') {
      // 丁（2 → 1）进来了；曹洪（s0）也在：乙→曹洪本来是 1 + 曹洪飞影 1 = 2，−1 马正好抵掉飞影 ⇒ 1
      expect(p.options.map((o) => o.id), '丁现在够得着；曹洪因 −1 马抵消了飞影也在').toEqual([
        's0',
        's2',
        's3',
        'no',
      ]);
    }
  });

  it('弃手牌只给牌背（看不到牌面），而且**由曹洪挑**（不是随机）', () => {
    // 把装备给乙（接收者本人不算第二段目标）⇒ 第二段选**丙**（乙的另一个邻居）
    const state = endPhase([
      { seatId: 's0', name: '曹洪', heroId: 'caohong', faction: 'wei', hand: [armor('h1')] },
      { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu' },
      {
        seatId: 's2',
        name: '丙',
        heroId: 'lvbu',
        faction: 'shu',
        hand: [mk('c1', 'tao', 'heart', 3), mk('c2', 'shan', 'heart', 4)],
      },
      { seatId: 's3', name: '丁', heroId: 'guanyu', faction: 'shu' },
    ]);
    huyuan(state, 'h1', 's1');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 's2' }), '拆丙');
    const p = state.pending;
    expect(p?.kind).toBe('choice');
    if (p?.kind === 'choice') {
      expect(p.options.map((o) => o.id), '手牌只给「第 k 张」').toEqual(['hand:0', 'hand:1']);
      expect(p.options.every((o) => !o.label.includes('·')), '不给牌名').toBe(true);
    }
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'hand:1' }), '点第 2 张');
    expect(at(state, 's2').hand.map((c) => c.id), '点哪张弃哪张').toEqual(['c1']);
    expect(state.discard.some((c) => c.id === 'c2')).toBe(true);
  });

  it('**只要有任意一张能放下去的装备牌就该问**（旧写法只看第一张 ⇒ 会吞掉机会）', () => {
    // 甲 手里：青釭剑（武器）+ 八卦阵（防具）；全场武器栏都被占、防具栏都空着
    // ⇒ 武器放不下、防具放得下 ⇒ **照样应该问**（并且候选里只出现防具那张）
    const state = endPhase([
      {
        seatId: 's0',
        name: '曹洪',
        heroId: 'caohong',
        faction: 'wei',
        hand: [wpn('h1'), armor('h2')],
        // 连**自己**的武器栏也占住 ⇒ 全场没有任何一个武器栏是空的（自己也算接收者，别漏了他）
        equip: { slot: 'weapon', card: wpn('e0') },
      },
      { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu', equip: { slot: 'weapon', card: wpn('b1') } },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'shu', equip: { slot: 'weapon', card: wpn('c1') } },
      { seatId: 's3', name: '丁', heroId: 'guanyu', faction: 'shu', equip: { slot: 'weapon', card: wpn('d1') } },
    ]);
    expect(state.pending?.kind, '还有防具能放 ⇒ 该问').toBe('choice');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }), '发动');
    // 选牌候选里只该有**放得下的**那张（武器放不下）
    const p = state.pending;
    expect(p?.kind, '选装备牌').toBe('pickCards');
    if (p?.kind === 'pickCards') {
      expect(p.cards.map((c) => c.id), '只给放得下的那张').toEqual(['h2']);
    }
    ok(act(state, 's0', { type: 'pickCards', cardIds: ['h2'] }), '选八卦阵');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 's1' }), '给乙（防具栏空）');
    expect(at(state, 's1').equipment.armor?.id).toBe('h2');
  });

  it('判定区**不在**第二段的候选里（「一张牌」不含判定区）', () => {
    const state = endPhase([
      { seatId: 's0', name: '曹洪', heroId: 'caohong', faction: 'wei', hand: [armor('h1')] },
      { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu' },
      {
        seatId: 's2',
        name: '丙',
        heroId: 'lvbu',
        faction: 'shu',
        hand: [mk('c1', 'tao', 'heart', 3)],
      },
      { seatId: 's3', name: '丁', heroId: 'guanyu', faction: 'shu' },
    ]);
    at(state, 's2').judgment = [mk('j1', 'lebu', 'spade', 6)];
    huyuan(state, 'h1', 's1');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 's2' }), '拆丙');
    const p = state.pending;
    expect(p?.kind).toBe('choice');
    if (p?.kind === 'choice') {
      expect(p.options.map((o) => o.id), '只有手牌那一张，没有判定牌').toEqual(['hand:0']);
    }
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'hand:0' }));
    expect(at(state, 's2').judgment.map((c) => c.id), '判定区原样不动').toEqual(['j1']);
  });
});
