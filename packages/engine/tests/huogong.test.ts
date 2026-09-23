/**
 * 【火攻】的目标必须**有手牌**（用户 2026-09-22 报的缺陷）：
 * 火攻要目标「展示一张手牌」，没手牌的人根本没法结算 —— 既不该进可点目标列表，
 * 也不能被任何交互路径强行指定。
 *
 * 这一条钉的是**引擎侧的校验**（界面的过滤是另一半：见 Game.tsx 的 `selectedTargetNeedsHand`，
 * 两边必须同一口径）。
 */
import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  buildPrompt,
  configFromPreset,
  createGame,
  dropTargetsWithoutHand,
  emptyFlags,
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
const huogong = (id: string) => mk(id, 'huogong', 'heart', 2);

function gz(handB: Card[]): GameState {
  const state = createGame(
    [
      { seatId: A, name: '甲', heroId: 'guanyu' },
      { seatId: B, name: '乙', heroId: 'zhangfei' },
      { seatId: C, name: '丙', heroId: 'caocao' },
    ],
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  for (const p of state.players) {
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.maxHp = 4;
    p.hp = 4;
    p.hand = [];
    p.flags = emptyFlags();
  }
  const a = state.players.find((p) => p.seatId === A)!;
  const b = state.players.find((p) => p.seatId === B)!;
  a.hand = [huogong('h1')];
  b.hand = handB.slice();
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: A };
  state.log = [];
  return state;
}

describe('火攻：目标必须有手牌（用户 2026-09-22）', () => {
  it('目标没手牌 → 引擎拒绝，且牌没打出去', () => {
    const state = gz([]);
    const res = applyIntent(state, A, { type: 'playCard', cardId: 'h1', targetIds: [B] });
    expect(res.ok, '不能对没手牌的角色用【火攻】').toBe(false);
    const a = state.players.find((p) => p.seatId === A)!;
    expect(a.hand.map((c) => c.id)).toEqual(['h1']); // 牌还在手里
    expect(state.pending).toEqual({ kind: 'play', seatId: A }); // 控制权也没动
  });

  it('目标有手牌 → 照常结算（火攻要的是「展示一张手牌」）', () => {
    const state = gz([mk('b1', 'sha', 'spade', 5)]);
    const res = applyIntent(state, A, { type: 'playCard', cardId: 'h1', targetIds: [B] });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    // 火攻开局是「目标展示一张手牌」的响应窗口
    expect(['respondTrick', 'wuxieQueue']).toContain(state.pending?.kind);
  });

  it('另一个没手牌的旁观者不受影响（只有被指定的那个会被拦）', () => {
    const state = gz([mk('b1', 'sha', 'spade', 5)]);
    const c = state.players.find((p) => p.seatId === C)!;
    c.hand = [];
    expect(applyIntent(state, A, { type: 'playCard', cardId: 'h1', targetIds: [B] }).ok).toBe(true);
    expect(c.hand).toHaveLength(0);
  });

  /**
   * 用户 2026-09-25 交接记录的真机缺陷：第二阶段提示把**内部英文花色值**拼进了用户文案
   * （真机上显示「弃一张黑色club花色手牌」）。花色名统一走 protocol 的 `SUIT_NAME`
   * （全仓库唯一一份中文花色名）。
   */
  it('第二阶段的提示用中文花色名，不出现内部枚举值', () => {
    const state = gz([mk('b1', 'sha', 'club', 5)]);
    ok(applyIntent(state, A, { type: 'playCard', cardId: 'h1', targetIds: [B] }));
    // 无懈窗口依次弃权，直到问乙「展示一张手牌」
    while (state.pending?.kind === 'wuxieQueue') {
      const asked = state.pending.askQueue[state.pending.askIndex]!;
      ok(act(state, asked, { type: 'pass' }), '无懈弃权');
    }
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }), '乙展示手牌');
    const msg = buildPrompt(state, A).message ?? '';
    expect(msg, '轮到甲弃同花色手牌').toContain('【火攻】');
    expect(msg).toContain('梅花');
    expect(msg, '内部花色值（英文）不许出现在用户文案里').not.toMatch(
      /spade|heart|club|diamond/,
    );
  });
});

/**
 * 「其他交互路径」也不能指定无手牌角色（用户 2026-09-23 复报：引擎的目标校验只管住了
 * **直接出牌** 那一条路，技能发起的虚拟锦囊完全不经过它）。
 *
 * 这三条钉的是引擎侧的三条路：技能的目标候选（奇策/役鬼共用 `qiceTargets`）与
 * 虚拟锦囊的结算入口（`castVirtualTrick`）。
 */
const vanilla = (id: string, name: string, hand: Card[]): SeatSpec => ({
  seatId: id,
  name,
  heroId: 'vanilla',
  hand,
});

interface SeatSpec {
  seatId: string;
  name: string;
  heroId: string;
  hand: Card[];
}

const HERO_OF: Record<string, string> = { s0: 'xunyou', s1: 'guanyu', s2: 'zhangfei' };

/** 国战局：甲=荀攸/左慈（由用例指定），乙=无手牌，丙=有手牌 */
function gzSkill(heroId: string, cHand: Card[]): GameState {
  HERO_OF[A] = heroId;
  const state = createGame(
    [
      { seatId: A, name: '甲', heroId },
      { seatId: B, name: '乙', heroId: 'vanilla' },
      { seatId: C, name: '丙', heroId: 'vanilla' },
    ],
    'TEST',
    // 荀攸/左慈都是**不臣篇**武将（pack: 'bian'）⇒ 必须开全扩，否则「你没有这个技能」
    { mode: 'guozhan', config: configFromPreset('full2026') },
  );
  state.draft = null;
  for (const p of state.players) {
    p.heroId = HERO_OF[p.seatId] ?? p.heroId;
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.maxHp = 4;
    p.hp = 4;
    p.flags = emptyFlags();
  }
  const a = state.players.find((p) => p.seatId === A)!;
  const b = state.players.find((p) => p.seatId === B)!;
  const c = state.players.find((p) => p.seatId === C)!;
  a.hand = [mk('a1', 'sha', 'heart', 5)];
  b.hand = []; // 无手牌
  c.hand = cHand.slice();
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

describe('【火攻】的目标必须有手牌：技能路径也要拦（用户 2026-09-23 复报）', () => {
  it('奇策（荀攸）当【火攻】：无手牌的角色不进目标候选', () => {
    const state = gzSkill('xunyou', [mk('c1', 'shan', 'spade', 3)]);
    ok(applyIntent(state, A, { type: 'useSkill', skillId: 'qice', targetIds: [] }));
    // 第一步：选当哪张锦囊
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind !== 'choice') return;
    const hg = state.pending.options.find((o) => o.id === 'huogong');
    expect(hg, '奇策应能当【火攻】').toBeTruthy();
    ok(act(state, A, { type: 'chooseOption', optionId: 'huogong' }));
    // 第二步：选目标——候选里**不能**有乙（他没手牌）
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind !== 'choice') return;
    const ids = state.pending.options.map((o) => o.id);
    expect(ids, '无手牌的角色不该出现在【火攻】的目标候选里').not.toContain(B);
    expect(ids).toContain(C);
  });

  it('役鬼（左慈）当【火攻】：无手牌的角色不进目标候选', () => {
    const state = gzSkill('zuoci', [mk('c1', 'shan', 'spade', 3)]);
    const a = state.players.find((p) => p.seatId === A)!;
    // 直接摆两张「魂」（役鬼的真实获得流程不在本用例的射程内）
    a.hun = ['guanyu', 'zhangfei'];
    ok(applyIntent(state, A, { type: 'useSkill', skillId: 'yigui_use', targetIds: [] }));
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind !== 'choice') return;
    // ⚠️ 2026-09-25 起：役鬼**先问移去哪张「魂」**（由左慈自己挑），再问视为使用哪张牌
    ok(act(state, A, { type: 'chooseOption', optionId: '0' }));
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind !== 'choice') return;
    const hg = state.pending.options.find((o) => o.id === 'huogong');
    expect(hg, '役鬼应能当【火攻】').toBeTruthy();
    ok(act(state, A, { type: 'chooseOption', optionId: 'huogong' }));
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind !== 'choice') return;
    const ids = state.pending.options.map((o) => o.id);
    expect(ids, '无手牌的角色不该出现在【火攻】的目标候选里').not.toContain(B);
  });

  it('结算入口的兜底判据：无手牌的目标被剔除，其余照旧（【火攻】专属，其它锦囊不动）', () => {
    const state = gzSkill('vanilla', [mk('c1', 'shan', 'spade', 3)]);
    const b = state.players.find((p) => p.seatId === B)!;
    b.hand = []; // 乙无手牌
    const c = state.players.find((p) => p.seatId === C)!;
    // 【火攻】：乙被剔除、丙保留
    expect(dropTargetsWithoutHand(state, 'huogong', [B, C])).toEqual([C]);
    // 【决斗】【过河拆桥】：不受影响（它们没有「目标要有手牌」这条）
    expect(dropTargetsWithoutHand(state, 'juedou', [B, C])).toEqual([B, C]);
    expect(dropTargetsWithoutHand(state, 'guohe', [B, C])).toEqual([B, C]);
    // 一个都不剩 ← 这次使用就没有可结算的目标（调用方按空名单处理）
    expect(dropTargetsWithoutHand(state, 'huogong', [B])).toEqual([]);
    // 丙有手牌时照常
    c.hand = [mk('c9', 'sha', 'club', 7)];
    expect(dropTargetsWithoutHand(state, 'huogong', [C])).toEqual([C]);
  });
});
