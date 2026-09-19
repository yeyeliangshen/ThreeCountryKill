import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  configFromPreset,
  createGame,
  determineDualFaction,
  effectiveFaction,
  getHero,
  toSnapshot,
} from '../src';

const act = (s: ReturnType<typeof createGame>, seat: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(s, seat, i);

describe('不臣篇 · 双势力规则（第①步）', () => {
  it('determineDualFaction：单势力+双势力→自动跟随；两张双势力一个共同势力→自动取；两个共同势力→要玩家选', () => {
    const mengda = getHero('mengda')!; // 魏/蜀
    const tangzi = getHero('tangzi')!; // 魏/吴
    const guanyu = getHero('guanyu')!; // 蜀
    const sunquan = getHero('sunquan')!; // 吴
    expect(determineDualFaction(mengda, guanyu, 'guozhan')).toEqual({ kind: 'auto', faction: 'shu' });
    // 孟达（魏/蜀）+ 孙权（吴）没有任何共同势力 → 这**不是合法搭配**（选将时就被同阵营校验拦掉），
    // 判定函数对这类组合不表态（返回 null）
    expect(determineDualFaction(mengda, sunquan, 'guozhan')).toBeNull();
    // 魏/蜀 + 魏/吴 → 只有魏是共同势力
    expect(determineDualFaction(mengda, tangzi, 'guozhan')).toEqual({ kind: 'auto', faction: 'wei' });
    // 魏/蜀 + 魏/蜀（夏侯霸）→ 两个共同势力 → 要玩家选
    const xiahouba = getHero('xiahouba')!;
    expect(determineDualFaction(mengda, xiahouba, 'guozhan')).toEqual({
      kind: 'choice',
      options: ['wei', 'shu'],
    });
    // 两张单势力 → 不归它管
    expect(determineDualFaction(guanyu, sunquan, 'guozhan')).toBeNull();
  });

  it('确定过的势力优先于「明置即确定」：会盟/同势力判断都读它', () => {
    const state = createGame(
      [
        { seatId: 'A', name: '甲', heroId: 'vanilla' },
        { seatId: 'B', name: '乙', heroId: 'vanilla' },
      ],
      'T',
      { mode: 'guozhan', freePick: true, config: configFromPreset('full2026') },
    );
    // 孟达（魏/蜀）+ 关羽（蜀）→ 自动确定为蜀
    expect(act(state, 'A', { type: 'pickHero', heroId: 'mengda', deputyHeroId: 'guanyu' }).ok).toBe(true);
    const a = state.players.find((p) => p.seatId === 'A')!;
    expect(a.determinedFaction).toBe('shu');
    // 暗置时没有任何势力（未确定势力不算势力）
    expect(effectiveFaction(state, a)).toBeNull();
    // 亮将后按**确定的**蜀算（而不是主将牌面写的魏）
    a.heroRevealed = true;
    expect(effectiveFaction(state, a)).toBe('shu');
  });

  it('两个共同势力的组合：由玩家自己选势力（2023 规则）', () => {
    const state = createGame(
      [
        { seatId: 'A', name: '甲', heroId: 'vanilla' },
        { seatId: 'B', name: '乙', heroId: 'vanilla' },
      ],
      'T',
      { mode: 'guozhan', freePick: true, config: configFromPreset('full2026') },
    );
    const res = act(state, 'A', { type: 'pickHero', heroId: 'mengda', deputyHeroId: 'xiahouba' });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    // ⚠️ 回归：选将阶段的**询问必须盖过 pickHero 提示**——以前 buildPrompt 只要 state.draft
    //    在就一律回 pickHero，客户端于是既看不到也答不了这条询问（实测界面卡在选将页，§5.133）。
    const prompt = toSnapshot(state, 'A').prompt;
    expect(prompt?.kind).toBe('choice');
    expect(prompt?.choiceOptions?.map((o) => o.id).sort()).toEqual(['shu', 'wei']);
    const ask = state.pending;
    if (ask?.kind !== 'choice') throw new Error(`预期选势力询问，实际是 ${ask?.kind}`);
    expect(ask.title).toContain('选势力');
    expect(ask.options.map((o) => o.id).sort()).toEqual(['shu', 'wei']);
    const res2 = act(state, 'A', { type: 'chooseOption', optionId: 'shu' });
    expect(res2.ok, res2.ok ? '' : res2.error).toBe(true);
    const pa = state.players.find((p) => p.seatId === 'A')!;
    expect(pa.determinedFaction).toBe('shu');
    expect(state.log.some((x) => x.message.includes('选择了势力'))).toBe(true);
  });

  it('buchen 开关整包管住：off 时**所有**不臣篇武将（含单势力那 4 位）都不进选将池', () => {
    const seats = [
      { seatId: 'A', name: '甲', heroId: 'vanilla' },
      { seatId: 'B', name: '乙', heroId: 'vanilla' },
    ];
    const pool = (cfg: ReturnType<typeof configFromPreset>) =>
      createGame(seats, 'T', { mode: 'guozhan', freePick: true, config: cfg }).draft!.deals['A']!;
    const off = pool(configFromPreset('standard'));
    // 单势力不臣篇武将（以前漏掉的）
    for (const id of ['xushu', 'yanbaihu', 'wujing', 'dongzhao']) {
      expect(off, `标准国战不该发到 ${id}`).not.toContain(id);
    }
    // 双势力 / 野心家
    for (const id of ['mengda', 'xuyou', 'sp_simazhao']) {
      expect(off, `标准国战不该发到 ${id}`).not.toContain(id);
    }
    // 但标准/其他包的武将照旧在池里
    expect(off).toContain('guanyu');
    expect(off).toContain('caocao');
    // 开了就都在
    const on = pool(configFromPreset('full2026'));
    expect(on).toContain('xushu');
    expect(on).toContain('dongzhao');
  });

  it('buchen 开关管住双势力武将：off 时它们不进选将池', () => {
    const seats = [
      { seatId: 'A', name: '甲', heroId: 'vanilla' },
      { seatId: 'B', name: '乙', heroId: 'vanilla' },
    ];
    const pool = (cfg: ReturnType<typeof configFromPreset>) =>
      createGame(seats, 'T', { mode: 'guozhan', freePick: true, config: cfg }).draft!.deals['A']!;
    const off = pool(configFromPreset('standard'));
    expect(off).not.toContain('mengda');
    const on = pool(configFromPreset('full2026'));
    expect(on).toContain('mengda');
    expect(on).toContain('xuyou');
  });
});
