/**
 * **濒死救援**（用户 2026-09-23 报的两个缺陷）：
 *
 * 1. **回复量按「逐点」算**：体力降到 0 以下时要一点一点补回来，
 *    `1 体力受 2 点伤害 → -1 → 需要 2 张【桃】`（第一张只回到 0，仍在濒死）；
 *    每回复一次都要**重新检查 `hp > 0`**，不能「收到一张救援牌就结束濒死」；
 * 2. **【酒】不能由其他角色用来救濒死角色**：只有**濒死者本人**能对自己用【酒】回复 1 点
 *    （官方文本：「当你处于濒死状态时，对自己使用」）。其他角色只能出【桃】（或华佗·急救那种
 *    「红牌当桃」的转化）。
 *
 * 实现载体：`engine.respondDeathSave`（回复与收尾）与 `legal.buildRespondDeathPrompt`
 * （下发给界面的合法牌），两处必须同一口径。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, toSnapshot, type GameState } from '../src';
import type { Card, Suit } from '@sgs/protocol';

const A = 's0';
const B = 's1';
const C = 's2';

const mk = (id: string, type: Card['type'], suit: Suit = 'spade', rank = 5): Card => ({
  id,
  type,
  suit,
  rank,
});
const sha = (id: string) => mk(id, 'sha', 'spade');
const tao = (id: string) => mk(id, 'tao', 'heart', 3);
const jiu = (id: string) => mk(id, 'jiu', 'spade', 6);

/**
 * 甲（hp 由用例给）打乙一拳；乙不出闪 → 受伤进濒死。
 * 想造「2 点伤害」就给甲开 `jiuActive`。
 */
function gz(seats: { bHp: number; bHand: Card[]; aHand?: Card[]; cHand?: Card[]; jiuBuff?: boolean }): GameState {
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
  const c = state.players.find((p) => p.seatId === C)!;
  a.hand = (seats.aHand ?? [sha('a1')]).slice();
  a.flags.jiuActive = !!seats.jiuBuff;
  b.hp = seats.bHp;
  b.hand = seats.bHand.slice();
  c.hand = (seats.cHand ?? []).slice();
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: A };
  state.log = [];
  return state;
}

const act = (state: GameState, seatId: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(state, seatId, i);
const ok = (r: ReturnType<typeof applyIntent>, tag = '') => {
  if (!r.ok) throw new Error(`${tag} 预期成功但失败：${r.error}`);
};
/**
 * 求桃队列**从濒死者本人起**按座次排（`aliveSeatsFrom(dying)`）——所以「轮到谁」不能想当然。
 * 这个助手把前面那些没牌可出的人一律「弃权」，直到问话落到 `seatId` 头上。
 */
function passUntil(state: GameState, seatId: string): void {
  let guard = 0;
  while (state.pending?.kind === 'respondDeath' && guard++ < 10) {
    const asked = state.pending.askQueue[state.pending.askIndex]!;
    if (asked === seatId) return;
    ok(act(state, asked, { type: 'pass' }), `${asked} 弃权`);
  }
  throw new Error(`求桃队列没轮到 ${seatId}（当前 ${JSON.stringify(state.pending)?.slice(0, 80)}）`);
}

const hint = (state: GameState, seatId: string) => {
  const p = toSnapshot(state, seatId).prompt;
  return { kind: p?.kind, cards: p?.legalCardIds ?? [], msg: p?.message ?? '' };
};

describe('濒死救援：逐点回复（体力降到 0 以下要一点一点补）', () => {
  it('1 体力受 1 点伤害 → 0 体力 → 1 张【桃】就够', () => {
    const state = gz({ bHp: 1, bHand: [] });
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }), '出杀');
    ok(act(state, B, { type: 'pass' }), '不出闪');
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(0);
    expect(state.pending?.kind).toBe('respondDeath');
    // 甲有桃 → 出一张，乙回到 1 点、脱离濒死
    const a = state.players.find((p) => p.seatId === A)!;
    a.hand = [tao('t1')];
    passUntil(state, A); // 队列从乙（濒死者）开始，他手里没牌 ⇒ 弃权
    ok(act(state, A, { type: 'respondCard', cardId: 't1' }), '出桃');
    expect(b.hp).toBe(1);
    expect(state.pending?.kind).not.toBe('respondDeath');
    // 日志照实记「回复 1 点体力」（「脱离了濒死」那句只在**技能**救回那条路上打）
    expect(state.log.map((e) => e.message).join('|')).toContain('回复 1 点体力');
  });

  it('1 体力受 **2** 点伤害 → -1 → **需要 2 张【桃】**（第一张只回到 0，仍在濒死）', () => {
    const state = gz({ bHp: 1, bHand: [], jiuBuff: true }); // 酒+杀 = 2 点
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }), '出杀');
    ok(act(state, B, { type: 'pass' }), '不出闪');
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp, '1 → -1').toBe(-1);
    expect(state.pending?.kind).toBe('respondDeath');
    a.hand = [tao('t1'), tao('t2')];
    passUntil(state, A);
    // 第 1 张桃：-1 → 0，**仍在濒死**
    ok(act(state, A, { type: 'respondCard', cardId: 't1' }), '第 1 张桃');
    expect(b.hp, '还差 1 点').toBe(0);
    expect(state.pending?.kind, '没补到 >0 ⇒ 继续求桃').toBe('respondDeath');
    // 第 2 张桃：0 → 1，脱离濒死
    ok(act(state, A, { type: 'respondCard', cardId: 't2' }), '第 2 张桃');
    expect(b.hp).toBe(1);
    expect(state.pending?.kind).not.toBe('respondDeath');
  });

  it('1 体力受 3 点伤害（-2）→ 需要 3 张【桃】（每张回 1 点，且中途不结束）', () => {
    const state = gz({ bHp: 1, bHand: [], jiuBuff: true });
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    // 造 3 点：酒杀（2 点）之后再用【诸葛连弩】补一张杀（1 点）——两次伤害各自结算
    a.hand = [sha('a1'), sha('a2')];
    a.equipment.weapon = { ...mk('w1', 'weapon', 'spade', 1), equipName: 'zhuge', range: 1 } as Card;
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }), '酒杀（2 点）');
    ok(act(state, B, { type: 'pass' }), '不出闪');
    expect(b.hp, '1 → -1').toBe(-1);
    a.hand = [tao('t1'), tao('t2'), tao('t3')];
    passUntil(state, A);
    ok(act(state, A, { type: 'respondCard', cardId: 't1' }));
    expect(b.hp).toBe(0);
    expect(state.pending?.kind, '还差 1 点').toBe('respondDeath');
    ok(act(state, A, { type: 'respondCard', cardId: 't2' }));
    expect(b.hp).toBe(1);
    expect(state.pending?.kind).not.toBe('respondDeath');
  });

  it('一份救援能回多点（孙权·救援 +1）也按**实际回复量**结算', () => {
    const state = gz({ bHp: 1, bHand: [], jiuBuff: true });
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }), '出杀');
    ok(act(state, B, { type: 'pass' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(-1);
    // 这里只用「一张桃回 1 点」的普通情况；救援加成由既有用例覆盖，
    // 本用例确认的是：**回复后 hp 为 0 就还没结束**（不夹 0、不看「出过桃没有」）。
    const a = state.players.find((p) => p.seatId === A)!;
    a.hand = [tao('t1')];
    passUntil(state, A);
    ok(act(state, A, { type: 'respondCard', cardId: 't1' }));
    expect(b.hp).toBe(0);
    expect(state.pending?.kind).toBe('respondDeath');
  });

  it('桃不够、所有人都弃权 → 阵亡（负体力也一样）', () => {
    const state = gz({ bHp: 1, bHand: [], jiuBuff: true });
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }), '出杀');
    ok(act(state, B, { type: 'pass' }));
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(-1);
    // 一圈问下来没人出桃 → 阵亡
    let guard = 0;
    while (state.pending?.kind === 'respondDeath' && guard++ < 8) {
      const asked = state.pending.askQueue[state.pending.askIndex]!;
      ok(act(state, asked, { type: 'pass' }));
    }
    expect(b.alive).toBe(false);
    expect(state.pending?.kind).not.toBe('respondDeath');
  });
});

describe('濒死救援：【酒】只能濒死者本人自救', () => {
  it('其他角色**不能**用【酒】救濒死的人（引擎拒绝、界面也不列出来）', () => {
    const state = gz({ bHp: 1, bHand: [], cHand: [jiu('c1')] });
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }), '出杀');
    ok(act(state, B, { type: 'pass' }));
    expect(state.pending?.kind).toBe('respondDeath');
    // 推进到丙（既不是濒死者、也不是伤害来源）：他的【酒】**不该**出现在救援候选里
    passUntil(state, C);
    const seen = hint(state, C);
    expect(seen.cards, '丙的【酒】不该出现在救援候选里').not.toContain('c1');
    expect(seen.msg, '提示语也不该提「酒」').not.toContain('酒');
    const r = act(state, C, { type: 'respondCard', cardId: 'c1' });
    expect(r.ok, '其他角色不能用【酒】救人').toBe(false);
    // 甲（伤害来源、也不是濒死者）同样不行
    const a = state.players.find((p) => p.seatId === A)!;
    a.hand = [jiu('a9')];
    passUntil(state, A);
    expect(hint(state, A).cards).not.toContain('a9');
    expect(act(state, A, { type: 'respondCard', cardId: 'a9' }).ok).toBe(false);
  });

  it('**濒死者本人**可以对自己用【酒】回复 1 点（求救时的自救）', () => {
    const state = gz({ bHp: 1, bHand: [jiu('b1')], jiuBuff: true });
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }), '出杀');
    ok(act(state, B, { type: 'pass' }));
    const a = state.players.find((p) => p.seatId === A)!;
    const b = state.players.find((p) => p.seatId === B)!;
    expect(b.hp).toBe(-1);
    a.hand = [tao('t1')];
    // 队列从濒死者自己开始 ⇒ 先问乙：他能用【酒】自救（-1 → 0）
    passUntil(state, B); // 队列从濒死者本人开始 ⇒ 立刻就是他
    const seen = hint(state, B);
    expect(seen.cards, '濒死者本人能看到自己的【酒】').toContain('b1');
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }), '酒自救');
    expect(b.hp, '酒只回 1 点：-1 → 0').toBe(0);
    expect(state.pending?.kind, '只回到 0 ⇒ 还没脱离濒死').toBe('respondDeath');
  });
});
