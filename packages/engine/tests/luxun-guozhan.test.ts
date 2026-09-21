/**
 * 陆逊**换版本**：国战版围绕「节」运转（用户 2026-09-22 给定口径，见 docs §5.182 / §5.190）。
 *
 * 这一版的两个技能是【谦逊】（成为其他角色锦囊牌的**唯一目标**时取消之并收成「节」）与
 * 【度势】（出牌阶段限一次，红手牌当【以逸待劳】），**没有【连营】**。
 *
 * ⚠️ 身份局/军争版的陆逊**不变**（还是「挡顺手/乐 + 连营」）——两版写在 `Hero.guozhan` 里分开，
 *    所以本文件的用例**必须用国战模式**建局（`{ mode: 'guozhan' }`）；身份局那套由
 *    `engine.test.ts` 的既有用例继续覆盖。
 */
import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  createGame,
  emptyFlags,
  getHero,
  getHeroForMode,
  toSnapshot,
  type GameState,
} from '../src';
import type { Card } from '@sgs/protocol';

const A = 's0';
const B = 's1';
const C = 's2';

const mk = (id: string, type: Card['type'], suit: Card['suit'], rank = 1): Card => ({
  id,
  type,
  suit,
  rank,
});
const guohe = (id: string, suit: Card['suit'] = 'spade') => mk(id, 'guohe', suit, 3);
const lebu = (id: string, suit: Card['suit'] = 'spade') => mk(id, 'lebu', suit, 6);
const nanman = (id: string) => mk(id, 'nanman', 'spade', 7);
const shunshou = (id: string, suit: Card['suit'] = 'spade') => mk(id, 'shunshou', suit, 3);

/** 国战局：甲（关羽）乙（陆逊）丙（张飞），全部已明置（谦逊只看「其他角色」与「唯一目标」） */
function gz(aHand: Card[], bHand: Card[]): GameState {
  const state = createGame(
    [
      { seatId: A, name: '甲', heroId: 'guanyu' },
      { seatId: B, name: '乙', heroId: 'luxun' },
      { seatId: C, name: '丙', heroId: 'zhangfei' },
    ],
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  // ⚠️ 必须显式写 heroId：`createGame` 不落将（那是选将阶段的事）。漏了的话
  //    `activeHeroes` 会返回**空数组**，用例会静默地验一个「没有技能的陆逊」（踩过一次）。
  const HERO: Record<string, string> = { [A]: 'guanyu', [B]: 'luxun', [C]: 'zhangfei' };
  for (const p of state.players) {
    p.heroId = HERO[p.seatId]!;
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.deputyHeroId = null;
    p.maxHp = 4;
    p.hp = 4;
    p.hand = [];
    p.flags = emptyFlags();
  }
  state.players.find((p) => p.seatId === A)!.hand = aHand.slice();
  state.players.find((p) => p.seatId === B)!.hand = bHand.slice();
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: A };
  state.log = [];
  return state;
}

const seat = (state: GameState, seatId: string) => state.players.find((p) => p.seatId === seatId)!;
const act = (state: GameState, seatId: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(state, seatId, i);
const ok = (r: ReturnType<typeof applyIntent>) => {
  if (!r.ok) throw new Error(`预期成功但失败：${r.error}`);
};
const logs = (state: GameState) => state.log.map((e) => e.message).join('|');

describe('陆逊（国战）·谦逊：唯一目标被取消并收成「节」', () => {
  it('【过河拆桥】打出去 → 乙的目标被取消、这张牌成为「节」，且**不开无懈窗口**', () => {
    const state = gz([guohe('a1')], [mk('b1', 'tao', 'heart', 9)]);
    const b = seat(state, B);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // 目标被取消 ⇒ 直接回到甲的出牌阶段（没有 respondTrick，也没有 wuxieQueue）
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
    // 那张【过河拆桥】从弃牌堆**捞出来**扣在乙的武将牌上
    expect(b.jie.map((c) => c.id)).toEqual(['a1']);
    expect(state.discard.some((c) => c.id === 'a1')).toBe(false);
    expect(logs(state)).toContain('谦逊');
    // 手牌没被动
    expect(b.hand.map((c) => c.id)).toEqual(['b1']);
  });

  it('「节」是**公开信息**：本人与对手的快照里都能看到（界面要显示张数）', () => {
    const state = gz([guohe('a1')], [mk('b1', 'tao', 'heart', 9)]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    const b = seat(state, B);
    expect(b.jie.map((c) => c.id)).toEqual(['a1']);
    // 对手（甲）的快照里也看得到：牌扣在武将牌上，是明面上的事
    const seenByA = toSnapshot(state, A).players.find((p) => p.seatId === B)!;
    expect(seenByA.jie?.map((c) => c.id)).toEqual(['a1']);
    // 本人（乙）同样
    const seenByB = toSnapshot(state, B).players.find((p) => p.seatId === B)!;
    expect(seenByB.jie?.map((c) => c.id)).toEqual(['a1']);
    // 丙没有被牵连
    const seenC = toSnapshot(state, A).players.find((p) => p.seatId === C)!;
    expect(seenC.jie ?? []).toEqual([]);
  });

  it('【顺手牵羊】【乐不思蜀】同理；乐**不进判定区**', () => {
    const state = gz([shunshou('a1'), lebu('a2')], [mk('b1', 'tao', 'heart', 9)]);
    const b = seat(state, B);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [B] }));
    expect(b.jie.map((c) => c.id).sort()).toEqual(['a1', 'a2']);
    expect(b.judgment).toHaveLength(0); // 乐不思蜀没进判定区
    expect(b.hand.map((c) => c.id)).toEqual(['b1']);
  });

  it('节满 3 之后不再触发：第 4 张单目标锦囊正常对他结算', () => {
    const state = gz([guohe('a1')], [mk('b1', 'tao', 'heart', 9)]);
    const b = seat(state, B);
    // 先摆满 3 张「节」
    b.jie = [mk('j1', 'shan', 'club', 2), mk('j2', 'shan', 'club', 3), mk('j3', 'shan', 'club', 4)];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    // 正常进结算：等甲选「拆哪个区域」（无懈窗口在这之后）
    expect(state.pending?.kind).toBe('choice');
    expect(b.jie).toHaveLength(3); // 没再多一张
    expect(logs(state)).not.toContain('谦逊');
  });

  it('多目标/全体锦囊**不触发**（南蛮入侵照常结算）', () => {
    const state = gz([nanman('a1')], [mk('b1', 'sha', 'spade', 5)]);
    const b = seat(state, B);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [] }));
    expect(b.jie).toHaveLength(0);
    expect(logs(state)).not.toContain('谦逊');
    // 南蛮的结算：乙被要求出【杀】（他没闪/杀也已给出——总之流程在走）
    expect(state.pending?.kind ?? '').not.toBe('play');
  });

  it('自己对自己用的单目标锦囊不算（必须是**其他角色**使用）', () => {
    const state = gz([], [mk('b1', 'wuzhong', 'heart', 7), mk('b2', 'tao', 'heart', 9)]);
    // 让乙自己行动
    state.turn = { seatIndex: 1, phase: 'play' };
    state.pending = { kind: 'play', seatId: B };
    const b = seat(state, B);
    state.deck.push(mk('d1', 'sha', 'club', 1), mk('d2', 'sha', 'club', 2));
    ok(act(state, B, { type: 'playCard', cardId: 'b1', targetIds: [] }));
    expect(b.jie).toHaveLength(0); // 【无中生有】不指定别人，也不该被自己的谦逊收掉
    expect(logs(state)).toContain('使用了【无中生有】');
    expect(logs(state)).not.toContain('谦逊');
  });
});

describe('陆逊（国战）· 换版本本身', () => {
  it('国战没有【连营】：失去最后一张手牌后不再问「是否发动【连营】」', () => {
    const state = gz([guohe('a1')], [mk('b1', 'tao', 'heart', 9)]);
    const b = seat(state, B);
    // 节满 3 ⇒ 谦逊不触发，好让拆桥真的拆到乙的**最后一张手牌**
    b.jie = [mk('j1', 'shan', 'club', 2), mk('j2', 'shan', 'club', 3), mk('j3', 'shan', 'club', 4)];
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(state.pending?.kind).toBe('choice'); // 「弃置其第 1 张手牌（暗，共 1 张）」
    expect(b.jie).toHaveLength(3);
    ok(act(state, A, { type: 'chooseOption', optionId: 'hand:0' }));
    while (state.pending?.kind === 'wuxieQueue') {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    expect(b.hand).toHaveLength(0);
    expect(logs(state)).not.toContain('连营');
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  it('两版分开：身份局的陆逊仍是「挡顺手/乐 + 连营」', () => {
    const gzHero = getHeroForMode('luxun', 'guozhan')!;
    const shiHero = getHeroForMode('luxun', 'melee')!;
    // 国战：有「唯一目标取消」、没有连营钩子、没有旧的 pure 判据
    expect(typeof gzHero.onSoleTrickTarget).toBe('function');
    expect(gzHero.cannotBeTargetOf).toBeUndefined();
    expect((gzHero.hooks ?? []).map((h) => h.skillId)).not.toContain('连营');
    expect((gzHero.activeSkills ?? []).map((s) => s.name)).toContain('度势');
    expect((gzHero.skills ?? []).map((s) => s.name).sort()).toEqual(['度势', '谦逊']);
    // 身份局：照旧
    expect(typeof shiHero.cannotBeTargetOf).toBe('function');
    expect(shiHero.onSoleTrickTarget).toBeUndefined();
    expect((shiHero.hooks ?? []).map((h) => h.skillId)).toContain('连营');
    expect((shiHero.skills ?? []).map((s) => s.name).sort()).toEqual(['连营', '谦逊'].sort());
    // 顶层定义与国战变体是**同一个 id**（不是两个武将）
    expect(getHero('luxun')!.id).toBe('luxun');
  });
});

describe('陆逊（国战）·度势：红手牌当【以逸待劳】', () => {
  it('出牌阶段限一次：选红手牌 → 转化使用【以逸待劳】（真的走锦囊流程），第二次拒发', () => {
    const state = gz([], []);
    state.turn = { seatIndex: 1, phase: 'play' };
    state.pending = { kind: 'play', seatId: B };
    const b = seat(state, B);
    b.faction = 'wu';
    // 手里两张红、一张黑：候选只应出现红的那两张
    b.hand = [
      mk('b1', 'sha', 'heart', 5),
      mk('b2', 'shan', 'diamond', 4),
      mk('b3', 'sha', 'spade', 6),
    ];
    // 同势力（吴）的丙：以逸待劳会对他一起生效
    const c = seat(state, C);
    c.faction = 'wu';
    state.deck.push(mk('d1', 'sha', 'club', 1), mk('d2', 'sha', 'club', 2));
    state.deck.push(mk('d3', 'sha', 'club', 3), mk('d4', 'sha', 'club', 4));

    ok(act(state, B, { type: 'useSkill', skillId: 'dushi', targetIds: [] }));
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind !== 'choice') return;
    expect(state.pending.options.map((o) => o.id)).toEqual(['yiyi']); // 选项二待核对，先不出现
    ok(act(state, B, { type: 'chooseOption', optionId: 'yiyi' }));
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind !== 'pickCards') return;
    expect(state.pending.cards.map((x) => x.id).sort()).toEqual(['b1', 'b2']); // 只有红牌
    // 选一张红牌 → 进弃牌堆、并以虚拟【以逸待劳】走完整流程（这里会开无懈窗口）
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    while (state.pending?.kind === 'wuxieQueue') {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    expect(state.discard.some((c) => c.id === 'b1')).toBe(true);
    expect(logs(state)).toContain('当【以逸待劳】使用');
    expect(logs(state)).toContain('使用了【以逸待劳】');
    // 限一次：本回合再发动要被拒
    const again = act(state, B, { type: 'useSkill', skillId: 'dushi', targetIds: [] });
    expect(again.ok).toBe(false);
  });
});
