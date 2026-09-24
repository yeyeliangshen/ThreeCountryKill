/**
 * 国战「预亮 / 明置」缺陷修复（用户 2026-09-22 口径，原文）：
 *
 * > 「预亮」与「明置」是两个不同概念：预亮技能只是表示，当该技能满足发动或触发条件时，
 * > 系统允许进入相应的亮将/技能处理流程；**预亮本身并不代表武将牌已经明置**。
 * > 同时，拥有锁定技的暗置武将在自己的出牌阶段内，应允许玩家主动点击对应锁定技，
 * > 将该武将牌主动明置。不能因为技能属于锁定技，或已经存在「预亮」机制，就取消主动亮将入口。
 *
 * 三条要求各自钉在这里：
 * ① 锁定技预亮后，时机到来 ⇒ **自动明置 + 结算**（锁定技没有「是否发动」，所以不询问）；
 * ② 自己的出牌阶段点锁定技 ⇒ intent `revealBySkill` **明置**（不是发动技能）；
 * ③ 明置之后按「已明置」的正常状态结算（本文件末尾两条）。
 *
 * 用例里的「改动前 ✗」标注了旧实现为什么红——这些断言**改动前必红**，不是补录。
 */
import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  createGame,
  emptyFlags,
  getHero,
  prelitableSkills,
  toSnapshot,
  type GameState,
} from '../src';
import type { Card } from '@sgs/protocol';

const A = 's0';
const B = 's1';
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
const sha = (id: string) => mk(id, 'sha', 'spade', 5);

/** 国战牌局：直接指定武将牌（绕开选将），默认甲的出牌阶段 */
function gz(
  seats: { seatId: string; name: string; heroId: string; deputy?: string; hand?: Card[] }[],
  turnSeat = A,
): GameState {
  const state = createGame(
    seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  for (const s of seats) {
    const p = state.players.find((x) => x.seatId === s.seatId)!;
    p.heroId = s.heroId;
    p.deputyHeroId = s.deputy ?? s.heroId;
    p.maxHp = 4;
    p.hp = 4;
    p.faction = getHero(s.heroId)!.faction;
    p.hand = (s.hand ?? []).slice();
    p.flags = emptyFlags();
    p.heroRevealed = false;
    p.deputyRevealed = false;
  }
  const idx = state.seatOrder.indexOf(turnSeat);
  state.turn = { seatIndex: idx < 0 ? 0 : idx, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[state.turn.seatIndex]! };
  state.log = [];
  return state;
}
const at = (state: GameState, seatId: string) => state.players.find((p) => p.seatId === seatId)!;

describe('预亮：锁定技也能预亮，但预亮本身绝不明置', () => {
  it('锁定技出现在 prelitableSkills 里（改动前 ✗：lockedNames 那一行把它 continue 掉了）', () => {
    // 甲＝张飞（主）/马超（副）：张飞·咆哮的**国战版**是锁定技、带 useCard 钩子；
    // 马超·马术是常驻字段技（没有钩子、没有时机可挂）；马超·铁骑是非锁定触发技。
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputy: 'machao' },
      { seatId: B, name: '乙', heroId: 'guojia' },
    ]);
    const offered = prelitableSkills(state, at(state, A)).map((s) => s.name);
    expect(offered, '锁定技（咆哮）现在可以预亮').toContain('咆哮');
    expect(offered, '非锁定触发技（铁骑）照旧').toContain('铁骑');
    expect(offered, '常驻字段技（马术：没有钩子，没有时机）不能预亮').not.toContain('马术');
    // 快照下发同一份名单（界面据此给预亮入口）
    expect(toSnapshot(state, A).players.find((x) => x.seatId === A)?.prelitableSkills).toContain(
      '咆哮',
    );
  });

  it('预亮锁定技：只是登记意向，一个武将都没明置', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputy: 'machao' },
      { seatId: B, name: '乙', heroId: 'guojia' },
    ]);
    const a = at(state, A);
    ok(act(state, A, { type: 'prelightSkill', skillName: '咆哮' }));
    expect(a.prelitSkills).toEqual(['咆哮']);
    expect(a.heroRevealed, '预亮 ≠ 明置').toBe(false);
    expect(a.deputyRevealed, '预亮 ≠ 明置').toBe(false);
    expect(
      state.log.some((l) => l.message.includes('亮将')),
      '预亮不该产生任何亮将日志',
    ).toBe(false);
    // 再点一次是取消，同样不明置
    ok(act(state, A, { type: 'prelightSkill', skillName: '咆哮' }));
    expect(a.prelitSkills).toEqual([]);
    expect(a.heroRevealed).toBe(false);
  });
});

describe('锁定技预亮后的时机：自动明置 + 结算（不询问）', () => {
  it('预亮【咆哮】后用【杀】：自动明置张飞，第二张【杀】再按钩子摸牌（改动前 ✗：locked 的钩子被整段跳过 ⇒ 一直暗着）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputy: 'machao', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'guojia' },
    ]);
    const a = at(state, A);
    state.deck = [sha('d1')];
    ok(act(state, A, { type: 'prelightSkill', skillName: '咆哮' }));
    expect(a.heroRevealed).toBe(false);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(a.heroRevealed, '锁定技的钩子时机一到就自动明置').toBe(true);
    expect(state.log.some((l) => l.message.includes('亮将：张飞'))).toBe(true);
    // 不弹询问：出【杀】时甲这边没有「是否明置【张飞】并发动？」这一步，
    // 控制权直接走到乙的响应（非锁定技的对照见下一条）。
    expect(state.pending?.kind).toBe('respondSha');
    ok(act(state, B, { type: 'pass' }));
    // 明置后按正常状态结算：咆哮给了「无限张杀」⇒ 第二张【杀】用得出（改前暗置 ⇒ 上限 1，这里会被拒）
    ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [B] }), '第二张【杀】');
    // 钩子本身也生效了（国战版咆哮：第二张【杀】后摸一张）
    expect(state.log.some((l) => l.message.includes('发动【咆哮】，摸了 1 张牌'))).toBe(true);
    expect(a.hand.map((c) => c.id)).toEqual(['d1']);
  });

  it('对照：同样时机（useCard）下的**非锁定**预亮技照旧先问「是否明置并发动」', () => {
    // 马超·铁骑（非锁定，useCard 钩子）：预亮后用【杀】仍然弹询问——这条保证改动没有
    // 把非锁定技的询问路径一起改成自动。
    const state = gz([
      { seatId: A, name: '甲', heroId: 'machao', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'guojia' },
    ]);
    const a = at(state, A);
    ok(act(state, A, { type: 'prelightSkill', skillName: '铁骑' }));
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(state.pending?.kind, '非锁定技维持询问').toBe('choice');
    expect(state.pending?.kind === 'choice' ? state.pending.title : '').toContain('明置');
    expect(a.heroRevealed, '还没选「发动」之前不能明置').toBe(false);
    ok(act(state, A, { type: 'chooseOption', optionId: 'no' }));
    expect(a.heroRevealed).toBe(false);
  });
});

describe('revealBySkill：自己的出牌阶段用锁定技主动明置（不是发动技能）', () => {
  it('暗置张飞 + 自己的出牌阶段：点【咆哮】⇒ 明置，且不是预亮', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputy: 'machao' },
      { seatId: B, name: '乙', heroId: 'guojia' },
    ]);
    const a = at(state, A);
    ok(act(state, A, { type: 'revealBySkill', skillName: '咆哮' }));
    expect(a.heroRevealed, '明置了主将张飞').toBe(true);
    expect(a.deputyRevealed, '副将没动').toBe(false);
    expect(a.prelitSkills, '这是明置，不是预亮').toEqual([]);
    expect(state.log.some((l) => l.message.includes('亮将：张飞'))).toBe(true);
    // 明置之后这张牌不再需要（也不该）出现在预亮名单里
    const offered = prelitableSkills(state, a).map((s) => s.name);
    expect(offered).not.toContain('咆哮');
    expect(offered, '副将那边的技能照旧可预亮').toContain('铁骑');
  });

  it('锁定**字段**技（马超·马术）同样能这样明置——「锁定技」三种落法都认', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'guanyu', deputy: 'machao' },
      { seatId: B, name: '乙', heroId: 'guojia' },
    ]);
    const a = at(state, A);
    ok(act(state, A, { type: 'revealBySkill', skillName: '马术' }));
    expect(a.deputyRevealed, '明置的是副将马超').toBe(true);
    expect(a.heroRevealed, '主将关羽没动').toBe(false);
  });

  it('拒绝：不是自己的出牌阶段（乙的回合 / 自己的准备阶段）', () => {
    const state = gz(
      [
        { seatId: A, name: '甲', heroId: 'zhangfei', deputy: 'machao' },
        { seatId: B, name: '乙', heroId: 'guojia' },
      ],
      B,
    );
    const a = at(state, A);
    const r1 = act(state, A, { type: 'revealBySkill', skillName: '咆哮' });
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('出牌阶段');
    // 自己的准备阶段也不行（那条路是 intent `revealHero`）
    state.turn = { seatIndex: state.seatOrder.indexOf(A), phase: 'prepare' };
    state.pending = { kind: 'play', seatId: A };
    const r2 = act(state, A, { type: 'revealBySkill', skillName: '咆哮' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('出牌阶段');
    expect(a.heroRevealed).toBe(false);
  });

  it('拒绝：该武将已经明置', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputy: 'machao' },
      { seatId: B, name: '乙', heroId: 'guojia' },
    ]);
    const a = at(state, A);
    a.heroRevealed = true;
    const r = act(state, A, { type: 'revealBySkill', skillName: '咆哮' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('已经明置');
  });

  it('拒绝：不是锁定技（自己武将牌上的非锁定技 / 压根没这个技能）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'machao' },
      { seatId: B, name: '乙', heroId: 'guojia' },
    ]);
    const a = at(state, A);
    const r1 = act(state, A, { type: 'revealBySkill', skillName: '铁骑' });
    expect(r1.ok).toBe(false);
    expect(r1.error, '铁骑是触发技，不是锁定技').toContain('不是锁定技');
    const r2 = act(state, A, { type: 'revealBySkill', skillName: '武圣' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('没有【武圣】');
    expect(a.heroRevealed).toBe(false);
  });

  it('拒绝：别人的锁定技 / 明置武将身上的锁定技（技能名对不上的那两类）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputy: 'machao' },
      { seatId: B, name: '乙', heroId: 'lvbu' },
    ]);
    // 吕布·无双（锁定技）不在甲自己的武将牌上
    const r = act(state, A, { type: 'revealBySkill', skillName: '无双' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有【无双】');
  });

  it('【建安】的封锁照旧生效（君主旗让这张牌「暂时不能明置」时拒掉这个入口）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputy: 'machao' },
      { seatId: B, name: '乙', heroId: 'guojia' },
    ]);
    const a = at(state, A);
    a.lordGrant = {
      skillHeroId: 'zhangfei',
      skillName: '咆哮',
      blockedHeroId: 'zhangfei',
      lordSeatId: B, // 君主还在 ⇒ 封锁有效
    };
    const r = act(state, A, { type: 'revealBySkill', skillName: '咆哮' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('建安');
    expect(a.heroRevealed).toBe(false);
  });
});

describe('明置之后：技能按「已明置」的正常状态结算', () => {
  it('明置张飞后，咆哮的字段与钩子都走**已明置**那条路（不再依赖预亮）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputy: 'machao', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'guojia' },
    ]);
    const a = at(state, A);
    state.deck = [sha('d1')];
    ok(act(state, A, { type: 'revealBySkill', skillName: '咆哮' }));
    expect(a.prelitSkills, '没有预亮过，照样生效（明置后的正常状态）').toEqual([]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'pass' }));
    // 出杀无次数限制（字段型部分）＋ 第二张杀后摸牌（钩子部分）
    ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [B] }), '第二张【杀】');
    expect(state.log.some((l) => l.message.includes('发动【咆哮】，摸了 1 张牌'))).toBe(true);
    expect(a.hand.map((c) => c.id)).toEqual(['d1']);
  });

  it('明置之后再预亮同一个技能会被拒（已明置武将的技能本来就生效）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'zhangfei', deputy: 'machao' },
      { seatId: B, name: '乙', heroId: 'guojia' },
    ]);
    ok(act(state, A, { type: 'revealBySkill', skillName: '咆哮' }));
    const r = act(state, A, { type: 'prelightSkill', skillName: '咆哮' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不能预亮');
  });
});
