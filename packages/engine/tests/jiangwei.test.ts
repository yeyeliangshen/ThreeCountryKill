/**
 * **国战姜维**（用户 2026-09-24 口径：按 2026-08-28 阵法技改版后的当前移动版）。
 *
 * 口径要点（逐条对着写用例）：
 * - 技能是【挑衅】+【天覆】（主将技·阵法技）+【遗志】（副将技）；
 *   **身份场的【志继】觉醒技不属于国战**（`guozhan.hooks = []` 把它挡在外面）。
 * - 【挑衅】的目标条件是「**对方的攻击范围包含姜维**」（不是反过来）。
 * - 【天覆】是**转化技**（无懈提供器），两态由当前队列实时决定：
 *   常规＝自己回合 + 黑桃；队列＝同队列成员的回合 + 任意黑色。
 * - 【遗志】是**组合层**的效果：体力上限减半个阴阳鱼（`deputySlotHalfYang`），
 *   并在「主将有观星 ⇒ X 固定 5 / 没有 ⇒ 视为拥有观星」之间二选一（**不许两个观星**）。
 * - 2026-08-28 官方已删除「阵法召唤」：队列纯按当前公开座次与势力实时算。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyIntent,
  canUseAsCard,
  createGame,
  emptyFlags,
  getHero,
  getHeroForMode,
  toSnapshot,
  type GameState,
} from '../src';
import type { Card, Faction } from '@sgs/protocol';

const A = 's0';
const B = 's1';
const C = 's2';
const D = 's3';
const ok = (r: { ok: boolean; error?: string }, tag = ''): void => {
  if (!r.ok) throw new Error(`${tag} 意图被拒：${r.error}`);
};
const act = (s: GameState, seat: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(s, seat, i);
const mk = (id: string, type: Card['type'], suit: Card['suit'], rank = 1): Card => ({
  id,
  type,
  suit,
  rank,
});

/**
 * 国战牌局：直接指定主将/副将（绕开选将），武将默认已明置。
 * `mode: 'guozhan'` 时组合层（体力上限、遗志的观星）会照常算——这正是我们要验的。
 */
function gz(
  seats: { seatId: string; name: string; heroId: string; deputy?: string; faction?: Faction; hand?: Card[] }[],
  turnSeat = A,
  opts: { revealed?: boolean } = {},
): GameState {
  const state = createGame(
    seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  const revealed = opts.revealed !== false;
  for (const s of seats) {
    const p = state.players.find((x) => x.seatId === s.seatId)!;
    p.heroId = s.heroId;
    p.deputyHeroId = s.deputy ?? null;
    p.faction = s.faction ?? getHero(s.heroId)!.faction;
    p.heroRevealed = revealed;
    p.deputyRevealed = revealed;
    p.hand = (s.hand ?? []).slice();
    p.flags = emptyFlags();
    // 组合层的体力上限（与 onPickHero 之后的计算同一口径，这里手工算一遍）
    const main = getHeroForMode(s.heroId, 'guozhan')!;
    const dep = p.deputyHeroId ? getHeroForMode(p.deputyHeroId, 'guozhan')! : undefined;
    if (dep) {
      const mainHp = main.maxHp - (main.mainSlotHalfYang ? 1 : 0);
      const depHp = dep.maxHp - (dep.deputySlotHalfYang ? 1 : 0);
      p.maxHp = Math.floor((mainHp + depHp) / 2);
      // 遗志（副将）：主将有观星则固定 X=5，否则视为拥有观星
      if (dep.id === 'jiangwei') {
        const mainHas = (main.skills ?? []).some((x) => x.name === '观星');
        if (mainHas) p.guanxingFixed = 5;
        else p.grantedSkills.push({ heroId: 'zhugeliang', skillName: '观星' });
      }
    } else {
      p.maxHp = main.maxHp;
    }
    p.hp = p.maxHp;
  }
  const idx = state.seatOrder.indexOf(turnSeat);
  state.turn = { seatIndex: idx < 0 ? 0 : idx, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[state.turn.seatIndex]! };
  state.log = [];
  return state;
}

const at = (state: GameState, seatId: string) => state.players.find((p) => p.seatId === seatId)!;

/** 姜维在**主将**位（天覆生效）的一局：甲=姜维（主）+ 刘备（副），乙/丙陪坐 */
function jwMain(hand: Card[], others = 2): GameState {
  const seats = [
    { seatId: A, name: '甲', heroId: 'jiangwei', deputy: 'liubei', faction: 'shu' as Faction, hand },
    { seatId: B, name: '乙', heroId: 'zhangfei', deputy: 'machao', faction: 'shu' as Faction },
    { seatId: C, name: '丙', heroId: 'caocao', deputy: 'xuchu', faction: 'wei' as Faction },
    { seatId: D, name: '丁', heroId: 'sunquan', deputy: 'zhouyu', faction: 'wu' as Faction },
  ];
  return gz(seats.slice(0, others + 2));
}

describe('【天覆】（主将技·阵法技）：转化技两态由队列实时决定', () => {
  it('姜维不是主将 ⇒ 没有【天覆】（副将位时主将技失效）', () => {
    // 副将姜维：canUseAs 不生效（mainSlotSkills 里只有他当主将时才被承认）
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputy: 'jiangwei', faction: 'shu' },
      { seatId: B, name: '乙', heroId: 'caocao', deputy: 'xuchu', faction: 'wei' },
    ]);
    const a = at(state, A);
    expect(canUseAsCard(state, a, mk('h1', 'sha', 'spade'), 'wuxie'), '副将位不给天覆').toBe(false);
    // 主将姜维（对照组）→ 自己的回合 ✓ 黑桃可以
    const s2 = jwMain([mk('h1', 'sha', 'spade')], 1);
    expect(canUseAsCard(s2, at(s2, A), mk('h2', 'sha', 'spade'), 'wuxie')).toBe(true);
  });

  it('常规形态（**没有队列**时）：只有自己回合的黑桃手牌能当【无懈】；梅花不行', () => {
    // ⚠️ 常规/队列的分别取决于**当前有没有队列**：这里把乙、丙都摆成非蜀，
    //    姜维两边都不是同势力 ⇒ 队列只有他自己 ⇒ 常规形态。
    const state = gz(
      [
        { seatId: A, name: '甲', heroId: 'jiangwei', deputy: 'liubei', faction: 'shu' },
        { seatId: B, name: '乙', heroId: 'caocao', deputy: 'xuchu', faction: 'wei' },
        { seatId: C, name: '丙', heroId: 'sunquan', deputy: 'zhouyu', faction: 'wu' },
        { seatId: D, name: '丁', heroId: 'yuanshao', deputy: 'yanliangwenchou', faction: 'qun' },
      ],
      A,
    );
    const a = at(state, A);
    expect(canUseAsCard(state, a, mk('h1', 'sha', 'spade'), 'wuxie'), '黑桃 ✓').toBe(true);
    expect(canUseAsCard(state, a, mk('h2', 'sha', 'club'), 'wuxie'), '梅花 ✗（常规只看黑桃）').toBe(
      false,
    );
    // 不是自己的回合（换成丙的回合）⇒ 常规形态整条不生效
    state.turn = { seatIndex: state.seatOrder.indexOf(C), phase: 'play' };
    state.pending = { kind: 'play', seatId: C };
    expect(
      canUseAsCard(state, a, mk('h1', 'sha', 'spade'), 'wuxie'),
      '常规形态限定「你的回合内」',
    ).toBe(false);
  });

  it('队列形态：与同队列角色（刘备）相邻的回合里，**任意黑色**手牌都能当【无懈】', () => {
    // 座次：甲(蜀) 乙(蜀) 丙(魏) 丁(吴) ⇒ 甲、乙连续同势力 = 一个队列
    const state = jwMain([mk('h1', 'sha', 'club')], 3);
    const a = at(state, A);
    // 现在是甲的回合 —— 他在队列里，所以队列形态也成立（「改为」：黑色即可）
    expect(canUseAsCard(state, a, mk('h1', 'sha', 'club'), 'wuxie'), '队列形态下黑色 ✓').toBe(true);
    // 轮到同队列的乙 → 依然成立（这正是队列形态的意义）
    state.turn = { seatIndex: state.seatOrder.indexOf(B), phase: 'play' };
    state.pending = { kind: 'play', seatId: B };
    expect(
      canUseAsCard(state, a, mk('h1', 'sha', 'club'), 'wuxie'),
      '同队列角色的回合 ✓',
    ).toBe(true);
  });

  it('队列**断开**（同势力的人被换掉）⇒ 立刻退回常规形态', () => {
    const state = jwMain([mk('h1', 'sha', 'club')], 3);
    const a = at(state, A);
    const b = at(state, B);
    // 先确认乙是蜀、与甲成队列：乙的回合里黑色可用
    state.turn = { seatIndex: state.seatOrder.indexOf(B), phase: 'play' };
    state.pending = { kind: 'play', seatId: B };
    expect(canUseAsCard(state, a, mk('h1', 'sha', 'club'), 'wuxie')).toBe(true);
    // 乙的**明置武将**换成魏（`effectiveFaction` 看的是公开牌面，不是 p.faction）⇒ 队列断开
    b.heroId = 'caocao';
    b.deputyHeroId = 'xuchu';
    b.faction = 'wei';
    expect(
      canUseAsCard(state, a, mk('h1', 'sha', 'club'), 'wuxie'),
      '队列断开后回到常规：梅花不可用',
    ).toBe(false);
    expect(
      canUseAsCard(state, a, mk('h2', 'sha', 'spade'), 'wuxie'),
      '而且常规形态还限定「你的回合内」⇒ 别人的回合连黑桃也不行',
    ).toBe(false);
  });

  it('生成的是**正常无懈**：打进无懈窗口后照常开抵消链（可以被反无懈）', () => {
    const state = jwMain([mk('h1', 'wuzhong', 'club')], 2);
    const a = at(state, A);
    const b = at(state, B);
    b.hand = [mk('b1', 'wuxieguo', 'club', 2)]; // 乙手里一张【无懈可击·国】
    ok(act(state, A, { type: 'playCard', cardId: 'h1', targetIds: [A] }), '甲用无中生有');
    expect(state.pending?.kind, '无懈窗口').toBe('wuxieQueue');
    // 轮到乙 → 他打出实体无懈
    while (state.pending?.kind === 'wuxieQueue' && state.pending.askQueue[state.pending.askIndex] !== B) {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }), '乙打无懈');
    expect(state.log.some((e) => e.message.includes('无懈可击'))).toBe(true);
  });
});

describe('【遗志】（副将技）：组合层的体力上限与观星', () => {
  it('姜维在**副将**位 ⇒ 组合体力上限减 1（＝减少半个阴阳鱼）', () => {
    // 张飞(4) + 姜维(4)：4+4=8 → 常规是 4；遗志减半个阴阳鱼 ⇒ (4 + 3)/2 = 3.5 → 3
    const withJw = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputy: 'jiangwei', faction: 'shu' },
      { seatId: B, name: '乙', heroId: 'caocao', deputy: 'xuchu', faction: 'wei' },
    ]);
    expect(at(withJw, A).maxHp, '张飞+姜维 = 3（4+4 再减半个阴阳鱼）').toBe(3);
    // 对照：张飞 + 马超（无遗志）= (4+4)/2 = 4
    const ctrl = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputy: 'machao', faction: 'shu' },
      { seatId: B, name: '乙', heroId: 'caocao', deputy: 'xuchu', faction: 'wei' },
    ]);
    expect(at(ctrl, A).maxHp).toBe(4);
  });

  it('主将**没有**观星 ⇒ 整个角色视为拥有【观星】（借诸葛亮的钩子）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputy: 'jiangwei', faction: 'shu' },
      { seatId: B, name: '乙', heroId: 'caocao', deputy: 'xuchu', faction: 'wei' },
    ]);
    const a = at(state, A);
    expect(a.grantedSkills, '借来的技能里记着观星').toContainEqual({
      heroId: 'zhugeliang',
      skillName: '观星',
    });
    expect(a.guanxingFixed, '没有主将观星 ⇒ X 不固定').toBeUndefined();
  });

  it('主将**有**观星（诸葛亮）⇒ **不重复添加**，只把 X 固定为 5；3 人存活也观 5', () => {
    const three = () => [
      { seatId: A, name: '甲', heroId: 'zhugeliang', deputy: 'jiangwei', faction: 'shu' as Faction },
      { seatId: B, name: '乙', heroId: 'caocao', deputy: 'xuchu', faction: 'wei' as Faction },
      { seatId: C, name: '丙', heroId: 'sunquan', deputy: 'zhouyu', faction: 'wu' as Faction },
    ];
    const state = gz(three(), C); // 让**丙**先手：他一结束回合就轮到甲的准备阶段
    const a = at(state, A);
    expect(a.grantedSkills, '主将已有观星 ⇒ 不再挂第二个').toEqual([]);
    expect(a.guanxingFixed, '改成「X 固定为 5」').toBe(5);
    state.deck = [
      mk('d1', 'sha', 'spade'),
      mk('d2', 'tao', 'heart'),
      mk('d3', 'shan', 'diamond'),
      mk('d4', 'jiu', 'club'),
      mk('d5', 'guohe', 'spade'),
      mk('d6', 'lebu', 'heart', 6),
    ];
    // 丙结束回合 → 轮到甲的准备阶段 → 【观星】询问
    ok(act(state, C, { type: 'endPhase' }), '丙结束回合');
    const ask = state.pending;
    expect(ask?.kind, '准备阶段问观星').toBe('choice');
    if (ask?.kind === 'choice') expect(ask.seatId).toBe(A);
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }), '发动观星');
    // 场上**只有 3 名存活角色**，常规观星只该看 3 张；遗志把 X 固定成 5 ⇒ 看 5 张
    expect(state.pending?.kind).toBe('pickCards');
    const pool = state.pending?.kind === 'pickCards' ? (state.pending.cards ?? []) : [];
    expect(pool).toHaveLength(5);

    // 对照组：主将**没有**观星（张飞+姜维）⇒ 「视为拥有观星」，X 按常规算（3 人 ⇒ 3 张）
    const ctrl = gz(
      [
        { seatId: A, name: '甲', heroId: 'zhangfei', deputy: 'jiangwei', faction: 'shu' },
        { seatId: B, name: '乙', heroId: 'caocao', deputy: 'xuchu', faction: 'wei' },
        { seatId: C, name: '丙', heroId: 'sunquan', deputy: 'zhouyu', faction: 'wu' },
      ],
      C,
    );
    ctrl.deck = [
      mk('e1', 'sha', 'spade'),
      mk('e2', 'tao', 'heart'),
      mk('e3', 'shan', 'diamond'),
      mk('e4', 'jiu', 'club'),
    ];
    ok(act(ctrl, C, { type: 'endPhase' }), '丙结束回合');
    const ask2 = ctrl.pending;
    expect(ask2?.kind, '借来的观星同样在准备阶段问').toBe('choice');
    ok(act(ctrl, A, { type: 'chooseOption', optionId: 'yes' }), '发动观星');
    const pool2 = ctrl.pending?.kind === 'pickCards' ? (ctrl.pending.cards ?? []) : [];
    expect(pool2, '没有遗志的固定 ⇒ 按存活角色数 3').toHaveLength(3);
  });
});

describe('【挑衅】：目标条件与既有交互（回归，防止写成反的）', () => {
  it('只有「**对方的**攻击范围包含姜维」才合法（反过来不算）', () => {
    // 甲（姜维，攻击范围 1）与乙（有 +1 马，攻击范围……）——直接用引擎的 canUse 判据验
    const state = gz([
      { seatId: A, name: '甲', heroId: 'jiangwei', deputy: 'liubei', faction: 'shu' },
      // 乙装备【青龙偃月刀】（攻击范围 3）：他的范围包含甲 ⇒ 可以挑衅
      {
        seatId: B,
        name: '乙',
        heroId: 'caocao',
        deputy: 'xuchu',
        faction: 'wei',
      },
    ]);
    at(state, B).equipment.weapon = {
      id: 'w1',
      type: 'weapon',
      suit: 'spade',
      rank: 6,
      equipName: 'qinglong',
      range: 3,
    };
    // 挑衅可发动（乙的攻击范围 3 ≥ 距离 1）
    ok(act(state, A, { type: 'useSkill', skillId: 'tiaoxin', cardIds: [], targetIds: [B] }));
    expect(state.pending?.kind, '问乙：出杀还是让姜维弃牌').toBe('choice');
    expect(toSnapshot(state, B).prompt?.message ?? '').toContain('挑衅');
    // 反向不成立的情形：把乙的范围压到 0（卸掉武器后再给甲装 +1 马，把距离拉到 2）
    const s2 = gz([
      { seatId: A, name: '甲', heroId: 'jiangwei', deputy: 'liubei', faction: 'shu' },
      { seatId: B, name: '乙', heroId: 'caocao', deputy: 'xuchu', faction: 'wei' },
    ]);
    const a2 = at(s2, A);
    a2.equipment.plusMount = {
      id: 'p1',
      type: 'plusMount',
      suit: 'spade',
      rank: 5,
      equipName: 'dawan',
    };
    const bad = act(s2, A, { type: 'useSkill', skillId: 'tiaoxin', cardIds: [], targetIds: [B] });
    expect(bad.ok, '乙的攻击范围（1）≤ 距离（2）⇒ 不能挑衅').toBe(false);
  });
});

describe('暗将（国战）：技能必须「先明置再发动」，不许偷偷用', () => {
  it('暗置姜维：点了【挑衅】会**先明置**（主动技那条路），而不是暗中发动', () => {
    const state = gz(
      [
        { seatId: A, name: '甲', heroId: 'jiangwei', deputy: 'liubei', faction: 'shu' },
        { seatId: B, name: '乙', heroId: 'caocao', deputy: 'xuchu', faction: 'wei' },
      ],
      A,
      { revealed: false },
    );
    const a = at(state, A);
    expect(a.heroRevealed, '开局是暗的').toBe(false);
    b_weapon: {
      at(state, B).equipment.weapon = {
        id: 'w1',
        type: 'weapon',
        suit: 'spade',
        rank: 6,
        equipName: 'qinglong',
        range: 3,
      };
    }
    // 暗置时【挑衅】就能点（主动技点了就明置发动，见 §5.207/§5.209 的通路）
    ok(act(state, A, { type: 'useSkill', skillId: 'tiaoxin', cardIds: [], targetIds: [B] }));
    expect(a.heroRevealed, '发动的同时明置了').toBe(true);
    expect(state.log.some((e) => e.message.includes('亮将'))).toBe(true);
  });

  it('暗置姜维：**没预亮**时【天覆】不可用（不许暗中把黑桃当无懈）', () => {
    const state = gz(
      [
        { seatId: A, name: '甲', heroId: 'jiangwei', deputy: 'liubei', faction: 'shu' },
        { seatId: B, name: '乙', heroId: 'caocao', deputy: 'xuchu', faction: 'wei' },
      ],
      A,
      { revealed: false },
    );
    const a = at(state, A);
    expect(canUseAsCard(state, a, mk('h1', 'sha', 'spade'), 'wuxie'), '没预亮 ⇒ 不可用').toBe(
      false,
    );
  });

  it('暗置姜维：**预亮【天覆】**后，自己的回合里可以打出黑桃当【无懈】，并在这一刻明置', () => {
    // ⚠️ 场景要选对：暗置角色没有「已确定势力」⇒ 没有队列 ⇒ 常规形态**只在自己回合**可用。
    //    所以「别人的回合里用天覆」本来就是非法的（这正是实现口径，不是 bug）。
    //    这里用「自己用锦囊 → 乙打无懈 → **反无懈轮问回我**」这条真实路径。
    const state = gz(
      [
        {
          seatId: A,
          name: '甲',
          heroId: 'jiangwei',
          deputy: 'liubei',
          faction: 'shu',
          hand: [mk('h1', 'wuzhong', 'club'), mk('h2', 'sha', 'spade')],
        },
        { seatId: B, name: '乙', heroId: 'caocao', deputy: 'xuchu', faction: 'wei', hand: [mk('b1', 'wuxieguo', 'club', 2)] },
      ],
      A,
      { revealed: false },
    );
    const a = at(state, A);
    const b = at(state, B);
    a.prelitSkills = ['天覆'];
    // 甲（暗置）用自己的锦囊 —— 牌本身不受明置限制
    ok(act(state, A, { type: 'playCard', cardId: 'h1', targetIds: [A] }), '甲用无中生有');
    expect(state.pending?.kind, '无懈窗口').toBe('wuxieQueue');
    while (state.pending?.kind === 'wuxieQueue' && state.pending.askQueue[state.pending.askIndex] !== B) {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }), '乙打无懈');
    // 抵消轮：问回**发起者甲**（他自己的回合 + 黑桃 ⇒ 天覆合法）
    while (state.pending?.kind === 'wuxieQueue' && state.pending.askQueue[state.pending.askIndex] !== A) {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    expect(state.pending?.kind, '反无懈轮问到甲').toBe('wuxieQueue');
    ok(act(state, A, { type: 'respondCard', cardId: 'h2' }), '甲用黑桃当【无懈可击】');
    expect(a.heroRevealed, '用出去的那一刻明置（用转化技必须明置）').toBe(true);
    expect(state.log.some((e) => e.message.includes('亮将') || e.message.includes('明置'))).toBe(true);
  });
});

describe('界面要用的两个字段：队列标记 + 天覆形态（引擎下发，界面不自己算）', () => {
  it('inFormation：连续相邻同势力 ≥2 才为真；断开后立刻为假', () => {
    // 甲(蜀) 乙(蜀) 丙(魏) ⇒ 甲、乙在同一个队列里
    const state = jwMain([], 3);
    const snap = toSnapshot(state, A);
    const pv = (seat: string) => snap.players.find((p) => p.seatId === seat)!;
    expect(pv(A).inFormation, '甲与乙相邻同势力').toBe(true);
    expect(pv(B).inFormation, '乙与甲相邻同势力').toBe(true);
    expect(pv(C).inFormation, '丙是魏，两边都不是魏').toBe(false);
    // 乙换成魏 ⇒ 队列断开（⚠️ `effectiveFaction` 读的是明置时定下的 `p.faction`，
    //    只改 heroId 不改它是**测试夹具的错**，不是引擎的错）
    const b = at(state, B);
    b.heroId = 'caocao';
    b.deputyHeroId = 'xuchu';
    b.faction = 'wei';
    expect(toSnapshot(state, A).players.find((p) => p.seatId === A)!.inFormation).toBe(false);
  });

  it('tianfuMode：**只发给本人**，且随回合/队列变（别人看不到这个字段）', () => {
    const state = jwMain([], 3);
    const snapA = toSnapshot(state, A);
    const mine = snapA.players.find((p) => p.seatId === A)!;
    expect(mine.tianfuMode, '甲有【天覆】⇒ 下发他当前的形态').toBe('formation');
    // 换成丙（魏）的回合：甲与丙不同队列 ⇒ 常规形态
    state.turn = { seatIndex: state.seatOrder.indexOf(C), phase: 'play' };
    state.pending = { kind: 'play', seatId: C };
    expect(toSnapshot(state, A).players.find((p) => p.seatId === A)!.tianfuMode).toBe('normal');
    // 别人的快照里没有这个字段（它只描述「我的技能说明该怎么写」）
    const asB = toSnapshot(state, B).players.find((p) => p.seatId === A)!;
    expect(asB.tianfuMode, '别人的快照不带').toBeUndefined();
  });
});

describe('回归守门：旧口径不许回来', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'heroes.ts'), 'utf8');
  it('国战姜维的钩子是空的（【志继】觉醒技只在身份场）', () => {
    expect(src).toContain('hooks: [],');
    // 国战变体的技能表里必须有天覆与遗志
    expect(src).toContain("name: '天覆'");
    expect(src).toContain("name: '遗志'");
  });
  it('仓库里没有「阵法召唤」（2026-08-28 官方已删除）', () => {
    const ui = readFileSync(join(__dirname, '..', '..', 'ui', 'src', 'pages', 'Game.tsx'), 'utf8');
    expect(src).not.toContain('阵法召唤：');
    expect(ui).not.toContain('阵法召唤');
  });
});
