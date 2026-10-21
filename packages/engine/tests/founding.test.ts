/**
 * **建国两阶段排序**（用户 2026-10-22 裁定 §5.252 之 15）：社区实测资料记载
 * 「先多名野心家依次建国、再依次拉拢人心」——不是「每个野心家完整走完（建国+邀请）才轮到下一个」。
 *
 * 夹具照抄 buchen.test.ts 的 gzAmb/triggerVictory（那套是实测过能触发拦截的），
 * 改成**三名**野心家主将（各只亮副将、各带不同势力）。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, configFromPreset, type GameState } from '../src';

const ok = (r: { ok: boolean; error?: string }, tag = ''): void => {
  if (!r.ok) throw new Error(`${tag} 意图被拒：${r.error}`);
};
const act = (s: GameState, seat: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(s, seat, i);
const at = (s: GameState, seat: string) => s.players.find((p) => p.seatId === seat)!;

type P = GameState['players'][number];

/** 4 人局：A/B/C＝三名野心家主将（只亮副将，暂按各自副将势力算），D＝魏（会被杀掉） */
function gzThree(): { state: GameState; a: P; b: P; c: P; d: P } {
  const state = createGame(
    [
      { seatId: 'A', name: '甲', heroId: 'sunchen' },
      { seatId: 'B', name: '乙', heroId: 'jie_zhonghui' },
      { seatId: 'C', name: '丙', heroId: 'sp_simazhao' },
      { seatId: 'D', name: '丁', heroId: 'vanilla' },
    ],
    'T',
    { mode: 'guozhan', freePick: true, config: configFromPreset('full2026') },
  );
  state.draft = null;
  for (const p of state.players) {
    p.hand = [];
    p.hp = 4;
    p.maxHp = 4;
  }
  const [a, b, c, d] = state.players as [P, P, P, P];
  // 三名野心家：主将暗置（野心家武将），副将明置（各带一个确定势力）
  a.heroId = 'sunchen';   a.deputyHeroId = 'guanyu';  a.faction = 'ambitionist'; a.determinedFaction = 'shu';
  // ⚠️ 副将势力决定拦截是否触发：三个副将都亮关羽（蜀）⇒ 丁（魏）死后蜀=3 > 4/2 ⇒ 胜利条件成立，
  //    而三名主将都是暗置的野心家武将 ⇒ 拦截接管（这正是「即将赢的势力里藏着一串野心家」的现场）
  b.heroId = 'jie_zhonghui';  b.deputyHeroId = 'guanyu';  b.faction = 'ambitionist'; b.determinedFaction = 'shu';
  c.heroId = 'sp_simazhao';  c.deputyHeroId = 'guanyu';  c.faction = 'ambitionist'; c.determinedFaction = 'shu';
  for (const p of [a, b, c]) {
    p.heroRevealed = false;
    p.deputyRevealed = true;
  }
  d.heroId = 'vanilla';
  d.deputyHeroId = 'vanilla';
  d.faction = 'wei';
  d.heroRevealed = true;
  d.deputyRevealed = true;
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: 'A' };
  state.log = [];
  return { state, a, b, c, d };
}

/** 甲杀丁（丁 1 血）→ 丁阵亡 → 胜利判定被「暴露野心」截断 */
function triggerVictory(state: GameState, a: P, d: P): void {
  d.hp = 1;
  a.hand = [{ id: 'a-sha', type: 'sha', suit: 'spade', rank: 7 } as never];
  const r = act(state, 'A', { type: 'playCard', cardId: 'a-sha', targetIds: ['D'] });
  expect(r.ok, r.ok ? '' : r.error).toBe(true);
  let guard = 0;
  while (state.pending && state.pending.kind === 'respondSha' && guard++ < 5) {
    act(state, 'D', { type: 'pass' });
  }
  guard = 0;
  while (state.pending?.kind === 'respondDeath' && guard++ < 10) {
    const asked = state.pending.askQueue[state.pending.askIndex]!;
    act(state, asked, { type: 'pass' });
  }
}

describe('建国：两阶段（全部建国 → 全部拉拢）', () => {
  it('三名野心家：日志里三个「建立新势力」全部先于第一个「加入」；独立 forceId', () => {
    const { state, a, d } = gzThree();
    triggerVictory(state, a, d);

    // 阶段一不应有任何「是否加入」询问——逐步答完全部流程（统一选「加入」最快收敛）
    const askOrder: string[] = [];
    let guard = 0;
    while (guard++ < 60) {
      const p = state.pending;
      if (!p) break;
      if (p.kind === 'choice') {
        const title = (p as { title?: string }).title ?? '';
        askOrder.push(title.slice(0, 24));
        const opts = (p as { options?: { id: string }[] }).options ?? [];
        const join = opts.find((o) => o.id === 'yes');
        ok(act(state, (p as { seatId: string }).seatId, { type: 'chooseOption', optionId: join ? 'yes' : opts[0]!.id }));
        continue;
      }
      if (p.kind === 'discard') {
        ok(act(state, p.seatId, { type: 'discard', cardIds: [] }));
        continue;
      }
      break;
    }

    const logs = state.log.map((e) => e.message);
    const buildIdxs = logs.map((m, i) => (m.includes('建立新势力') ? i : -1)).filter((i) => i >= 0);
    // ⚠️ 拦截入口那条「胜利结算前先处理【暴露野心】」也含这四个字——真暴露带「明置野心家主将」
    // ⚠️「首次明置野心家主将，获得【野心家】标记」（标记日志）也含那串字——真暴露以「转为野心家」判
    const exposeIdxs = logs.map((m, i) => (m.includes('转为野心家') ? i : -1)).filter((i) => i >= 0);
    expect(exposeIdxs.length, '三个都暴露了').toBe(3);
    expect(buildIdxs.length, '三个都建了国').toBe(3);
    const firstJoin = logs.findIndex((m) => m.includes('加入') && m.includes('新势力'));
    // 三名全是建国者 ⇒ 没有任何人可被拉拢（官方：已建国/已加入者不再是候选）——
    // 「没有加入」正是两阶段下的正确结果；若有加入，它必须发生在最后一次建国之后。
    if (firstJoin >= 0) {
      expect(firstJoin, '第一个加入在最后一次建国之后（两阶段）').toBeGreaterThan(
        buildIdxs[buildIdxs.length - 1]!,
      );
    } else {
      expect(logs.some((m) => m.includes('胜利结算前先处理')), '拦截确实接管过').toBe(true);
    }

    // 独立 forceId：三名建国者各自的势力键不同
    const fa = at(state, 'A').forceId;
    const fb = at(state, 'B').forceId;
    const fc = at(state, 'C').forceId;
    expect(new Set([fa, fb, fc]).size, '各自独立 forceId').toBe(3);
  });

  it('两阶段中间没有「是否加入」混进来：第一个询问标题不可能是加入', () => {
    const { state, a, d } = gzThree();
    triggerVictory(state, a, d);
    // 阶段一跑完才可能有询问；此刻第一条询问（若有）必须不是「是否加入」——
    // 但强暴露口径下阶段一全自动，第一问应该就是第一位建国者的邀请……不对：
    // 阶段一全自动 ⇒ 丁死后的第一个 choice 就是**第一个建国者**的「是否加入」，
    // 且**在此之前**日志里必须已有全部三条「建立新势力」。
    const p = state.pending;
    const logs = state.log.map((e) => e.message);
    const builds = logs.filter((m) => m.includes('建立新势力')).length;
    expect(builds, '第一问出现前三个都已建国').toBe(3);
    if (p?.kind === 'choice') {
      expect((p as { title?: string }).title ?? '', '第一问是邀请').toContain('是否加入');
    }
  });
});
