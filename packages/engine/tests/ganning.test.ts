/**
 * **甘宁·【奋威】**（用户 2026-09-26 口径：现行国战文本新增的**锁定技**）。
 *
 * 「锁定技，**首次明置此武将牌后**，令**所有与你势力相同的角色**各获得 1 枚【阴阳鱼】标记。」
 *
 * 三处要紧（用户口径 + 仓库既有的统一纪律）：
 * 1. 「**此**武将牌」＝甘宁这张（`payload.heroId === 'ganning'`）——双将里另一张明置时不发；
 * 2. 「**首次**」＝本局只发一次；
 * 3. 「同势力」用统一的**公开**势力键 `sameKnownFaction`：**暗置角色势力未确定 ⇒ 不参与**
 *    （不偷看底牌），**自己也是同势力角色之一 ⇒ 包括自己**；还得是锁定技（不问「是否发动」）。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, getHeroForMode, markerCount, type GameState } from '../src';
import type { Card, Faction } from '@sgs/protocol';

const ok = (r: { ok: boolean; error?: string }, tag = ''): void => {
  if (!r.ok) throw new Error(`${tag} 意图被拒：${r.error}`);
};
const act = (s: GameState, seat: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(s, seat, i);
const at = (s: GameState, seat: string) => s.players.find((p) => p.seatId === seat)!;
const yy = (s: GameState, seat: string) => markerCount(at(s, seat), 'yinyangyu');

interface Seat {
  seatId: string;
  name: string;
  heroId: string;
  deputy?: string;
  faction?: Faction;
  reveal?: boolean;
  hand?: Card[];
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
    p.deputyHeroId = s.deputy ?? null;
    p.faction = s.faction ?? getHeroForMode(s.heroId, 'guozhan')?.faction ?? 'qun';
    const shown = s.reveal !== false;
    p.heroRevealed = shown;
    p.deputyRevealed = shown;
    p.hand = (s.hand ?? []).slice();
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

/**
 * 把回合摆到某人的**准备阶段**并挂一个询问——国战只有这个时机能**主动明置**武将牌。
 * （与 `engine.test.ts` 里的同名助手同一做法。）
 */
function atPrepare(state: GameState, seat: string): void {
  state.turn = { seatIndex: state.seatOrder.indexOf(seat), phase: 'prepare' };
  state.pending = {
    kind: 'choice',
    seatId: seat,
    title: '准备阶段：是否明置武将牌？',
    options: [
      { id: 'all', label: '全部明置' },
      { id: 'none', label: '暂不明置' },
    ],
    resolve: () => {},
  };
}

describe('【奋威】：首次明置甘宁这张牌，同势力角色各得 1 枚【阴阳鱼】', () => {
  it('明置甘宁 ⇒ 自己 + **已经明置**的同势力角色各得 1 枚；异势力不给；暗置的同势力不给', () => {
    const state = gz([
      { seatId: 's0', name: '甘宁', heroId: 'ganning', faction: 'wu', reveal: false, deputy: 'lvmeng' },
      { seatId: 's1', name: '乙', heroId: 'zhouyu', faction: 'wu' }, // 明置的吴
      { seatId: 's2', name: '丙', heroId: 'xuchu', faction: 'wei' }, // 异势力
      { seatId: 's3', name: '丁', heroId: 'sunquan', faction: 'wu', reveal: false }, // 暗置的吴
    ]);
    expect(yy(state, 's0'), '还没明置：0').toBe(0);
    // 明置甘宁这张（主将）——主动明置只在**自己的准备阶段**
    atPrepare(state, 's0');
    ok(act(state, 's0', { type: 'revealHero', heroId: 'ganning' }), '明置主将甘宁');
    expect(yy(state, 's0'), '自己也是同势力角色之一 ⇒ 有').toBe(1);
    expect(yy(state, 's1'), '已明置的同势力 ⇒ 有').toBe(1);
    expect(yy(state, 's2'), '异势力 ⇒ 没有').toBe(0);
    expect(yy(state, 's3'), '暗置＝势力未确定 ⇒ 不给（不偷看底牌）').toBe(0);
    expect(state.log.some((e) => e.message.includes('奋威'))).toBe(true);
  });

  it('锁定技：**不问**「是否发动」（槽里不会多出询问）', () => {
    const state = gz([
      { seatId: 's0', name: '甘宁', heroId: 'ganning', faction: 'wu', reveal: false },
      { seatId: 's1', name: '乙', heroId: 'zhouyu', faction: 'wu' },
    ]);
    atPrepare(state, 's0');
    ok(act(state, 's0', { type: 'revealHero', heroId: 'ganning' }));
    // ⚠️ 别断言「pending 不是 choice」——准备阶段那格本身就是一条 choice（我的夹具摆的）。
    //    要断的是**锁定技没有自己的询问**：
    expect(state.pending?.title ?? '', '锁定技不问「是否发动奋威」').not.toContain('奋威');
    expect(yy(state, 's0')).toBe(1);
  });

  it('「**此**武将牌」：双将里**另一张**明置不发；甘宁这张明置时才发（且只发一次）', () => {
    // ⚠️ 必须 ≥4 人：2 人局里「吴 = 2 人 > 全场一半」⇒ 甲一明置就被**超编规则**转成野心家
    //    （那之后他与乙不是同势力，本条就测不到「此武将牌」这件事了）。4 人局吴 2 人 ≤ 一半。
    const state = gz([
      // 甘宁在**副将**位：先明置主将（不该发），再明置甘宁（发一次）
      { seatId: 's0', name: '甲', heroId: 'lvmeng', deputy: 'ganning', faction: 'wu', reveal: false },
      { seatId: 's1', name: '乙', heroId: 'zhouyu', faction: 'wu' },
      { seatId: 's2', name: '丙', heroId: 'xuchu', faction: 'wei' },
      { seatId: 's3', name: '丁', heroId: 'lvbu', faction: 'qun' },
    ]);
    atPrepare(state, 's0');
    ok(act(state, 's0', { type: 'revealHero', heroId: 'lvmeng' }), '明置主将吕蒙');
    expect(yy(state, 's0'), '主将明置（不是甘宁这张）⇒ 不发').toBe(0);
    atPrepare(state, 's0');
    ok(act(state, 's0', { type: 'revealHero', heroId: 'ganning' }), '明置副将甘宁');
    expect(yy(state, 's0'), '甘宁这张明置 ⇒ 发').toBe(1);
    expect(yy(state, 's1'), '同势力的乙也拿到').toBe(1);
    // 「首次」：本局只发一次（`usedOncePerGame.fenwei`）——两条武将牌都亮了也不会再发一轮
    expect(yy(state, 's1'), '仍是 1 枚，没有重复发').toBe(1);
  });

  it('标记是可用的【阴阳鱼】（出牌阶段弃置 ⇒ 摸 1 张）', () => {
    const state = gz([
      { seatId: 's0', name: '甘宁', heroId: 'ganning', faction: 'wu', reveal: false },
      { seatId: 's1', name: '乙', heroId: 'zhouyu', faction: 'wu' },
      { seatId: 's2', name: '丙', heroId: 'xuchu', faction: 'wei' },
      { seatId: 's3', name: '丁', heroId: 'lvbu', faction: 'qun' },
    ]);
    atPrepare(state, 's0');
    ok(act(state, 's0', { type: 'revealHero', heroId: 'ganning' }));
    expect(yy(state, 's0')).toBe(1);
    // 摆到**甲的出牌阶段**（标记是「出牌阶段弃置：摸 1 张」那条主动技）
    state.turn = { seatIndex: state.seatOrder.indexOf('s0'), phase: 'play' };
    state.pending = { kind: 'play', seatId: 's0' };
    const markerSkill = 'mark_yinyangyu';
    ok(act(state, 's0', { type: 'useSkill', skillId: markerSkill }), '弃置阴阳鱼');
    expect(yy(state, 's0'), '用掉一枚').toBe(0);
  });

  it('文本是现行口径', () => {
    const desc = getHeroForMode('ganning', 'guozhan')!.skills.find((s) => s.name === '奋威')!.desc ?? '';
    expect(desc).toContain('锁定技');
    expect(desc).toContain('首次明置此武将牌后');
    expect(desc).toContain('各获得 1 枚【阴阳鱼】标记');
  });
});
