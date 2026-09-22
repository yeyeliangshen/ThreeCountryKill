/**
 * 【玉玺】（势备篇宝物）的两条锁定技效果——用户 2026-09-23 报「装备后出牌阶段开始时
 * 没按锁定技视为使用【知己知彼】」，并要求顺带核查摸牌阶段那一张：
 *
 * 1. **摸牌阶段**：若你有处于**明置**状态的武将牌，额定摸牌数 +1（暗置不生效）；
 * 2. **出牌阶段开始时**：若你有明置的武将牌，**视为使用一张【知己知彼】**——
 *    走**完整的锦囊流程**（自己选合法目标、可被无懈可击抵消），不是直接看牌。
 *
 * 口径来源：docs 里记的 OL 2026 两条（§5.76 一带的「玉玺」条目），
 * 与 `hasYuxi`（含袁术·庸肆的虚拟玉玺）同一条判定。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, toSnapshot, type GameState } from '../src';
import type { Card, Faction } from '@sgs/protocol';

const A = 's0';
const B = 's1';
const C = 's2';
const D = 's3';

const mk = (id: string, type: Card['type'], suit: Card['suit'], rank = 1): Card => ({
  id,
  type,
  suit,
  rank,
});
const yuxi = (): Card => mk('yx1', 'treasure', 'club', 1);

function gz(opts: { revealed: boolean }): GameState {
  const state = createGame(
    [
      { seatId: A, name: '甲', heroId: 'guanyu' },
      { seatId: B, name: '乙', heroId: 'sunquan' },
      { seatId: C, name: '丙', heroId: 'caocao' },
      { seatId: D, name: '丁', heroId: 'zhangfei' },
    ],
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  const set = (seatId: string, heroId: string, faction: Faction, revealed: boolean) => {
    const p = state.players.find((x) => x.seatId === seatId)!;
    p.heroId = heroId;
    p.faction = faction;
    p.heroRevealed = revealed;
    p.deputyRevealed = false;
    p.maxHp = 4;
    p.hp = 4;
    p.hand = [];
    p.flags = emptyFlags();
  };
  set(A, 'guanyu', 'shu', true);
  set(B, 'sunquan', 'wu', opts.revealed); // 玉玺的持有者
  set(C, 'caocao', 'wei', true);
  set(D, 'zhangfei', 'shu', true);
  // 甲先行动（甲的出牌阶段结束 → 轮到乙，乙会在自己的出牌阶段开始时触发玉玺）
  state.players.find((p) => p.seatId === A)!.hand = [mk('a1', 'sha', 'spade', 5)];
  const b = state.players.find((p) => p.seatId === B)!;
  b.equipment.treasure = { ...yuxi(), equipName: 'yuxi' } as Card;
  state.players.find((p) => p.seatId === C)!.hand = [mk('c1', 'tao', 'heart', 3)];
  state.players.find((p) => p.seatId === D)!.hand = [mk('d9', 'tao', 'heart', 4)];
  // 牌堆：乙摸牌阶段要摸的牌（摸牌从堆尾 pop，所以放两/三张在尾部）
  state.deck = [
    mk('d1', 'sha', 'club', 1),
    mk('d2', 'sha', 'club', 2),
    mk('d3', 'sha', 'club', 3),
  ];
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: A };
  state.log = [];
  return state;
}

const act = (state: GameState, seatId: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(state, seatId, i);
const ok = (r: ReturnType<typeof applyIntent>) => {
  if (!r.ok) throw new Error(`预期成功但失败：${r.error}`);
};
const logs = (s: GameState) => s.log.map((e) => e.message).join(' | ');

/**
 * 把回合交给乙（甲的出牌阶段结束 → 乙的准备/判定/摸牌 → 出牌阶段开始）。
 *
 * ⚠️ 乙**暗置**时，准备阶段会有「是否明置武将牌？」的询问——用例只关心玉玺，
 * 这里一律答「暂不明置」（否则整条回合流程停在准备阶段，后面什么都测不到：踩过一次，
 * 暗置那两条用例当时就是因为这个而「看起来玉玺乱触发」）。
 */
function passTurnToB(state: GameState): void {
  ok(act(state, A, { type: 'endPhase' }));
  let guard = 0;
  while (
    state.pending?.kind === 'choice' &&
    state.pending.title.includes('明置') &&
    guard++ < 4
  ) {
    const none =
      state.pending.options.find((o) => o.id === 'none') ?? state.pending.options.at(-1)!;
    ok(act(state, B, { type: 'chooseOption', optionId: none.id }));
  }
}

describe('【玉玺】· 出牌阶段开始时视为使用【知己知彼】', () => {
  it('已明置 + 装备玉玺：进乙的出牌阶段时，先问「观看谁」（正常锦囊的目标选择）', () => {
    const state = gz({ revealed: true });
    passTurnToB(state);
    // 走到「选目标」这一步：玉玺的视为使用要求**自己选合法目标**
    expect(state.pending?.kind, JSON.stringify(state.pending)).toBe('choice');
    if (state.pending?.kind !== 'choice') return;
    expect(state.pending.seatId).toBe(B);
    expect(state.pending.title).toContain('玉玺');
    const opts = state.pending.options.map((o) => o.id);
    expect(opts).toContain(C);
    expect(opts).toContain(D);
    expect(opts, '不能观看自己').not.toContain(B);
    expect(logs(state)).not.toContain('视为使用了【知己知彼】'); // 还没选目标，不算用出去
  });

  it('选完目标 → 走**正常锦囊流程**：先「视为使用」（可被无懈），再问看手牌还是看武将牌', () => {
    const state = gz({ revealed: true });
    // 丁**暗置**（未确定势力）——知己知彼对暗置角色多一条「观看其武将牌」
    state.players.find((p) => p.seatId === D)!.heroRevealed = false;
    passTurnToB(state);
    if (state.pending?.kind !== 'choice') throw new Error('应为玉玺的选目标询问');
    // 选**暗置**的丁：这样两条都在——「观看其手牌」「观看其一张暗置的武将牌」
    ok(act(state, B, { type: 'chooseOption', optionId: D }));
    // 全场没人有无懈 ⇒ 无懈窗口自动关掉（这一步本身就说明它**经过了**那条流程）
    expect(logs(state)).toContain('视为使用了【知己知彼】');
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind !== 'choice') return;
    expect(state.pending.title).toContain('知己知彼');
    const ids = state.pending.options.map((o) => o.id);
    expect(ids, '观看手牌这一条要在').toContain('hand');
    expect(ids.some((id) => id.startsWith('hero:')), '暗置武将牌那一条也要在').toBe(true);
  });

  it('无懈可击能抵消它（这是「视为使用」而不是「直接看牌」的判据）', () => {
    const state = gz({ revealed: true });
    // 给丙一张无懈可击
    const c = state.players.find((p) => p.seatId === C)!;
    c.hand = [mk('wx1', 'wuxie', 'spade', 11)];
    passTurnToB(state);
    if (state.pending?.kind !== 'choice') throw new Error('应为玉玺的选目标询问');
    ok(act(state, B, { type: 'chooseOption', optionId: C }));
    expect(state.pending?.kind).toBe('wuxieQueue');
    // 丙打出无懈 → 这次视为使用被抵消，乙直接回到出牌阶段
    const asked = state.pending.askQueue[state.pending.askIndex]!;
    if (asked === C) {
      ok(act(state, C, { type: 'respondCard', cardId: 'wx1' }));
      while (state.pending?.kind === 'wuxieQueue') {
        ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
      }
    }
    expect(logs(state)).toContain('抵消');
    // 没有任何「观看」的询问（被抵消了）
    expect(state.pending?.kind === 'choice' && state.pending.title.includes('知己知彼')).toBe(false);
  });

  it('暗置（没有明置武将牌）→ 玉玺**不**触发（官方条件）', () => {
    const state = gz({ revealed: false });
    passTurnToB(state);
    expect(state.pending, '暗置时进乙的出牌阶段应直接是出牌 pending').toEqual({
      kind: 'play',
      seatId: B,
    });
    expect(logs(state)).not.toContain('玉玺');
  });

  it('只剩**一个**合法目标时不问「观看谁」（唯一的那个直接进结算）', () => {
    const state = gz({ revealed: true });
    for (const sid of [C, D]) {
      state.players.find((x) => x.seatId === sid)!.alive = false;
    }
    passTurnToB(state);
    // 不问目标，直接「视为使用」并问看什么
    expect(logs(state)).toContain('视为使用了【知己知彼】');
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind !== 'choice') return;
    expect(state.pending.title).toContain('知己知彼');
  });

  it('场上没有其他存活角色时：不触发，也不会卡住', () => {
    const state = gz({ revealed: true });
    for (const sid of [C, D]) {
      state.players.find((x) => x.seatId === sid)!.alive = false;
    }
    const a = state.players.find((p) => p.seatId === A)!;
    a.alive = false; // 甲也走 → 只剩乙
    // 甲不能行动了，直接把回合交给乙
    state.turn = { seatIndex: 1, phase: 'play' };
    state.pending = { kind: 'play', seatId: B };
    const r = act(state, B, { type: 'endPhase' });
    expect(r.ok).toBe(true);
    // 没有目标 ⇒ 玉玺什么也不做（不产生任何「知己知彼」询问）
    expect(logs(state)).not.toContain('知己知彼');
  });

  /** 用户的现场是**两人局**（陪练 + 真人）——单独钉一遍，别只在 4 人局里过 */
  it('两人局：装玉玺的一方进自己出牌阶段时，照样「视为使用【知己知彼】」并问看什么', () => {
    const state = createGame(
      [
        { seatId: A, name: '甲', heroId: 'guanyu' },
        { seatId: B, name: '乙', heroId: 'sunquan' },
      ],
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    const set = (seatId: string, heroId: string, faction: Faction) => {
      const p = state.players.find((x) => x.seatId === seatId)!;
      p.heroId = heroId;
      p.faction = faction;
      p.heroRevealed = true;
      p.deputyRevealed = false;
      p.maxHp = 4;
      p.hp = 4;
      p.hand = [];
      p.flags = emptyFlags();
    };
    set(A, 'guanyu', 'shu');
    set(B, 'sunquan', 'wu');
    state.players.find((p) => p.seatId === A)!.hand = [mk('a1', 'sha', 'spade', 5)];
    state.players.find((p) => p.seatId === B)!.equipment.treasure = {
      ...yuxi(),
      equipName: 'yuxi',
    } as Card;
    state.deck = [mk('d1', 'sha', 'club', 1), mk('d2', 'sha', 'club', 2), mk('d3', 'sha', 'club', 3)];
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: A };
    state.log = [];
    passTurnToB(state);
    expect(logs(state), '两人局也应触发').toContain('视为使用了【知己知彼】');
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind !== 'choice') return;
    expect(state.pending.title).toContain('知己知彼');
    // 目标只能是甲（唯一的其他角色）
    expect(state.pending.seatId).toBe(B);
  });

  /** 玉玺是**打出装的**（不是夹具直接塞槽里）——两条路都要能触发 */
  it('从手牌打出【玉玺】装上后，下个出牌阶段照样触发', () => {
    const state = gz({ revealed: true });
    const b = state.players.find((p) => p.seatId === B)!;
    b.equipment.treasure = null; // 先不装
    b.hand = [{ ...yuxi(), equipName: 'yuxi' } as Card];
    // 轮到乙：先过准备/判定/摸牌，到出牌阶段时装上玉玺，然后结束出牌
    passTurnToB(state);
    // 这一回合还没装玉玺 ⇒ 不触发（但摸牌那张也不该有）
    expect(logs(state)).not.toContain('玉玺');
    const yx = b.hand.find((c) => c.equipName === 'yuxi')!;
    ok(act(state, B, { type: 'playCard', cardId: yx.id }));
    expect(b.equipment.treasure?.equipName).toBe('yuxi');
    ok(act(state, B, { type: 'endPhase' }));
    // 往下推进（别人的回合一律过），直到乙的下个出牌阶段触发玉玺
    let guard = 0;
    while (guard++ < 40 && !logs(state).includes('视为使用了【知己知彼】')) {
      const st = state.pending;
      if (!st) throw new Error('控制权丢了');
      const who = 'seatId' in st ? st.seatId : (st.responderId ?? st.askQueue[st.askIndex] ?? '');
      if (st.kind === 'play') ok(act(state, who, { type: 'endPhase' }));
      else if (st.kind === 'choice') ok(act(state, who, { type: 'chooseOption', optionId: st.options[0]!.id }));
      else if (st.kind === 'wuxieQueue') ok(act(state, st.askQueue[st.askIndex]!, { type: 'pass' }));
      else if (st.kind === 'respondSha') ok(act(state, who, { type: 'pass' }));
      else if (st.kind === 'discard') {
        const p = state.players.find((x) => x.seatId === who)!;
        ok(act(state, who, { type: 'discard', cardIds: p.hand.slice(0, st.count).map((c) => c.id) }));
      } else throw new Error('推进时遇到没处理的询问：' + st.kind);
    }
    expect(logs(state), '装上玉玺后，下个出牌阶段应触发').toContain('视为使用了【知己知彼】');
  });
});

describe('【玉玺】· 摸牌阶段额外摸一张（顺带核查）', () => {
  it('已明置 + 装备玉玺 → 摸牌阶段多摸一张', () => {
    const state = gz({ revealed: true });
    passTurnToB(state);
    const b = state.players.find((p) => p.seatId === B)!;
    // 额定 2 张 + 玉玺 1 张 = 3 张（用完的牌堆只放 3 张，正好全部摸走）
    expect(b.hand.length).toBe(3);
  });

  it('暗置 → 不多摸（与出牌阶段那条同一个条件）', () => {
    const state = gz({ revealed: false });
    passTurnToB(state);
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hand.length).toBe(2);
  });
});
