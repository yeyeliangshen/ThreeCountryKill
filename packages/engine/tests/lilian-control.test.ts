/**
 * **回归：虚拟锦囊打完，控制权必须还给「发起者」而不是「使用者」**（用户 2026-09-26 报的缺陷）。
 *
 * 现象（用户两次报告合起来才是完整现场）：
 * - 「貂蝉离间的时候会导致跳到别人的回合」；
 * - 「被离间的玩家会出现**结束回合按钮**」。
 *
 * 根因：`endTrickResolution` 有**两条**收尾路——
 * - 快路径（场上没有 `cardUseEnded` 听众）：`resumePlay(ctx.resumeSeatId ?? ctx.sourceId)` ✓ 一直是对的；
 * - 慢路径（有听众，如许攸·成略）：`resumePlay(ctx.sourceId)` ✗ **漏了 resumeSeatId**。
 *
 * 于是只要场上一名许攸活着，貂蝉用【离间】（虚拟【决斗】的使用者＝第二目标、发起者＝貂蝉），
 * 决斗打完出牌阶段就塞给**决斗使用者**：他不是回合玩家、却看到「结束出牌」按钮；一点，
 * 引擎就把**貂蝉的**回合结束掉 ⇒ 「跳到别人的回合」。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, getHeroForMode, toSnapshot, type GameState } from '../src';
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

interface Seat {
  seatId: string;
  name: string;
  heroId: string;
  faction?: Faction;
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
    p.deputyHeroId = null;
    p.faction = s.faction ?? getHeroForMode(s.heroId, 'guozhan')?.faction ?? 'qun';
    p.heroRevealed = true;
    p.deputyRevealed = true;
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
const turnOf = (s: GameState) => s.seatOrder[s.turn.seatIndex];
const pend = (s: GameState) =>
  s.pending
    ? `${(s.pending as { kind: string }).kind}:${
        (s.pending as { seatId?: string; responderId?: string }).seatId ??
        (s.pending as { responderId?: string }).responderId ??
        ''
      }`
    : 'null';
/** 把离间那张虚拟【决斗】整条打完（无懈全过、双方都不出杀） */
function playOutDuel(state: GameState): void {
  let guard = 0;
  while (state.pending && guard++ < 20) {
    const p = state.pending as {
      kind: string;
      seatId?: string;
      responderId?: string;
      askQueue?: string[];
      askIndex?: number;
      title?: string;
      options?: { id: string; label: string }[];
    };
    if (p.kind === 'wuxieQueue') ok(act(state, p.askQueue![p.askIndex!]!, { type: 'pass' }), '无懈过');
    else if (p.kind === 'respondTrick') ok(act(state, p.responderId!, { type: 'pass' }), '决斗不出杀');
    else if (p.kind === 'choice') {
      // 许攸·成略的询问选「不」
      const id = /成略/.test(p.title ?? '')
        ? (p.options!.find((o) => /不|否/.test(o.label))?.id ?? p.options!.at(-1)!.id)
        : p.options![0]!.id;
      ok(act(state, p.seatId!, { type: 'chooseOption', optionId: id }), '答询问');
    } else if (p.kind === 'discard') ok(act(state, p.seatId!, { type: 'discard', cardIds: [] }));
    else break;
  }
}

describe('离间的虚拟【决斗】：控制权还给**貂蝉**，不许塞给决斗使用者', () => {
  it('场上有 cardUseEnded 听众（许攸）时，决斗打完 pending 仍是**貂蝉**的出牌阶段（旧实现给了张飞）', () => {
    const state = gz([
      { seatId: 's0', name: '貂蝉', heroId: 'diaochan', faction: 'qun', hand: [mk('a1', 'jiu', 'diamond', 9)] },
      { seatId: 's1', name: '关羽', heroId: 'guanyu', faction: 'shu' }, // 第一目标＝决斗目标
      { seatId: 's2', name: '张飞', heroId: 'zhangfei', faction: 'shu' }, // 第二目标＝决斗使用者
      { seatId: 's3', name: '许攸', heroId: 'xuyou', faction: 'wei' }, // cardUseEnded 持有者
    ]);
    ok(act(state, 's0', { type: 'useSkill', skillId: 'lilian', cardIds: ['a1'], targetIds: ['s1', 's2'] }), '离间');
    playOutDuel(state);
    expect(turnOf(state), '回合仍是貂蝉的').toBe('s0');
    expect(pend(state), '出牌阶段回到貂蝉手里（修复前这里是 play:s2）').toBe('play:s0');
    // 界面侧：「结束出牌」按钮只在 prompt.kind==='play' 时渲染 ⇒ 只有貂蝉看得到
    const promptOf = (seat: string) => toSnapshot(state, seat).prompt?.kind ?? 'null';
    expect(promptOf('s0')).toBe('play');
    expect(promptOf('s2'), '决斗使用者不该看到出牌提示（即不该有结束按钮）').toBe('null');
    expect(promptOf('s1')).toBe('null');
  });

  it('对照组：**没有**听众时本来就对（快路径）', () => {
    const state = gz([
      { seatId: 's0', name: '貂蝉', heroId: 'diaochan', faction: 'qun', hand: [mk('a1', 'jiu', 'diamond', 9)] },
      { seatId: 's1', name: '关羽', heroId: 'guanyu', faction: 'shu' },
      { seatId: 's2', name: '张飞', heroId: 'zhangfei', faction: 'shu' },
      { seatId: 's3', name: '吕布', heroId: 'lvbu', faction: 'qun' }, // 没有	cardUseEnded 钩子
    ]);
    ok(act(state, 's0', { type: 'useSkill', skillId: 'lilian', cardIds: ['a1'], targetIds: ['s1', 's2'] }), '离间');
    playOutDuel(state);
    expect(turnOf(state)).toBe('s0');
    expect(pend(state)).toBe('play:s0');
  });

  it('决斗使用者**点**「结束出牌」会被拒（貂蝉的阶段轮不到他结束）——修复前的真实事故路径', () => {
    const state = gz([
      { seatId: 's0', name: '貂蝉', heroId: 'diaochan', faction: 'qun', hand: [mk('a1', 'jiu', 'diamond', 9)] },
      { seatId: 's1', name: '关羽', heroId: 'guanyu', faction: 'shu' },
      { seatId: 's2', name: '张飞', heroId: 'zhangfei', faction: 'shu' },
      { seatId: 's3', name: '许攸', heroId: 'xuyou', faction: 'wei' },
    ]);
    ok(act(state, 's0', { type: 'useSkill', skillId: 'lilian', cardIds: ['a1'], targetIds: ['s1', 's2'] }), '离间');
    playOutDuel(state);
    // 修复前：pending=play:s2 ⇒ 张飞的 endPhase 会**成功**并把貂蝉的回合结束掉（跳回合事故）
    bad(act(state, 's2', { type: 'endPhase' }), '决斗使用者结束貂蝉的阶段');
    expect(turnOf(state), '回合没被跳走').toBe('s0');
    // 貂蝉自己结束才生效（⚠️ 可能要推两次：出牌阶段里刚跑过技能链时，第一次 endPhase
    //    只把 phase 翻成 discard、弃牌询问还没摆上槽——§5.240 登记过的既有 quirk）
    ok(act(state, 's0', { type: 'endPhase' }), '貂蝉自己结束');
    let guard = 0;
    while (state.pending?.kind !== 'play' || (state.pending as { seatId?: string }).seatId === 's0') {
      if (guard++ > 20) throw new Error('回合没推进');
      const p = state.pending;
      if (!p) break;
      if (p.kind === 'discard') {
        const need = (p as { count?: number }).count ?? 1;
        const ids = at(state, 's0').hand.map((c) => c.id).slice(0, need);
        ok(act(state, 's0', { type: 'discard', cardIds: ids }), '貂蝉弃牌');
      } else if (p.kind === 'choice' && (p as { seatId?: string }).seatId === 's0' && /闭月/.test((p as { title?: string }).title ?? '')) {
        ok(act(state, 's0', { type: 'chooseOption', optionId: 'no' }), '不闭月');
      } else break;
    }
    if ((state.pending as { seatId?: string })?.seatId === 's0' && state.pending?.kind === 'play') {
      ok(act(state, 's0', { type: 'endPhase' }), '再推一次（§5.240 quirk）');
      guard = 0;
      while (state.pending?.kind === 'discard' && guard++ < 6) {
        const need = (state.pending as { count?: number }).count ?? 1;
        const ids = at(state, 's0').hand.map((c) => c.id).slice(0, need);
        ok(act(state, 's0', { type: 'discard', cardIds: ids }), '貂蝉弃牌');
      }
    }
    expect(turnOf(state), '正常推进到下家').toBe('s1');
  });

  it('普通出牌（使用者＝回合玩家）不受影响：许攸在场时关羽正常出【杀】、结算完回到关羽', () => {
    const state = gz(
      [
        { seatId: 's0', name: '关羽', heroId: 'guanyu', faction: 'shu', hand: [mk('a1', 'sha', 'spade', 7)] },
        { seatId: 's1', name: '张飞', heroId: 'zhangfei', faction: 'shu' },
        { seatId: 's2', name: '许攸', heroId: 'xuyou', faction: 'wei' },
      ],
      's0',
    );
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }), '出杀');
    ok(act(state, 's1', { type: 'pass' }), '不闪');
    // 伤害后可能挂许攸·成略的询问：答掉
    let guard = 0;
    while (state.pending && guard++ < 8) {
      const p = state.pending as { kind: string; seatId?: string; title?: string; options?: { id: string; label: string }[] };
      if (p.kind === 'choice') {
        const id = /成略/.test(p.title ?? '')
          ? (p.options!.find((o) => /不|否/.test(o.label))?.id ?? p.options!.at(-1)!.id)
          : p.options![0]!.id;
        ok(act(state, p.seatId!, { type: 'chooseOption', optionId: id }));
      } else break;
    }
    expect(pend(state), '回到关羽的出牌阶段').toBe('play:s0');
    expect(turnOf(state)).toBe('s0');
  });
});
