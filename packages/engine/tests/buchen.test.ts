import { describe, it, expect } from 'vitest';
import { applyIntent, configFromPreset, createGame, determineDualFaction, effectiveFaction, getHero } from '../src';

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

  it('两个共同势力的组合现在会被拒（选势力界面未实现，不猜也不默认）', () => {
    const state = createGame(
      [
        { seatId: 'A', name: '甲', heroId: 'vanilla' },
        { seatId: 'B', name: '乙', heroId: 'vanilla' },
      ],
      'T',
      { mode: 'guozhan', freePick: true, config: configFromPreset('full2026') },
    );
    const res = act(state, 'A', { type: 'pickHero', heroId: 'mengda', deputyHeroId: 'xiahouba' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('两个可选势力');
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
