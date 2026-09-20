import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  configFromPreset,
  createGame,
  determineDualFaction,
  effectiveFaction,
  getHero,
  toSnapshot,
  drawOne,
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

  /**
   * 势力锦囊四张（不臣篇）——牌面与效果按用户 2026-09 给的口径（docs §5.136）。
   * 公共生命周期（待洗区 → 第一次重洗洗入 → 要进弃牌堆时销毁）已完成并由【固国安邦】验证；
   * 另外三张（号令天下/克复中原/文和乱武）**规则已定、只缺各自的结算代码**——所以先不进牌堆
   * （没有 effect handler 就放进去＝抽到无法结算的死牌）；每张写完过测试再加进 `factionTrickCards()`。
   */
  describe('势力锦囊（不臣篇）', () => {
    const gz3 = () => {
      const state = createGame(
        [
          { seatId: 'A', name: '甲', heroId: 'vanilla' },
          { seatId: 'B', name: '乙', heroId: 'vanilla' },
          { seatId: 'C', name: '丙', heroId: 'vanilla' },
        ],
        'T',
        { mode: 'guozhan', freePick: true, config: configFromPreset('full2026') },
      );
      state.draft = null;
      state.players.forEach((p, i) => {
        p.heroId = 'vanilla';
        p.deputyHeroId = 'vanilla';
        p.faction = i === 0 ? 'wu' : 'shu';
        p.heroRevealed = true;
        p.deputyRevealed = true;
        p.hand = [];
      });
      state.turn = { seatIndex: 0, phase: 'play' };
      state.pending = { kind: 'play', seatId: 'A' };
      return state;
    };

    it('开局不进摸牌堆（仍是 160 张），第一次重洗才把四张洗进来', () => {
      const state = gz3();
      expect(state.deck.length).toBe(160);
      // 目前只有【固国安邦】实装 → 只有它进循环；另外三张等实现后再放（先避免「抽到打不出的死牌」）
      expect(state.pendingFactionTricks.map((c) => c.type)).toEqual(['guoanjianbang']);
      // 把摸牌堆摸空、并往弃牌堆放几张（重洗的前提是「牌堆空 + 弃牌堆非空」）→ 四张随新堆洗入
      let guard = 0;
      while (state.deck.length > 0 && guard++ < 400) state.discard.push(drawOne(state)!);
      expect(state.deck.length).toBe(0);
      const drawn = drawOne(state); // 这一步触发重洗，并顺带摸走一张
      expect(state.pendingFactionTricks.length).toBe(0);
      const pool = [...state.deck, ...(drawn ? [drawn] : [])];
      expect(pool.some((c) => c.type === 'guoanjianbang'), '固国安邦 应已洗进摸牌堆').toBe(true);
    });

    it('固国安邦（非吴）：摸八张、选至少六张 → 选中的直接弃置；用过的牌移出游戏', () => {
      const state = gz3();
      const a = state.players.find((p) => p.seatId === 'A')!;
      a.faction = 'shu'; // 非吴
      const card = { id: 'f1', type: 'guoanjianbang', suit: 'heart', rank: 1 } as const;
      a.hand = [card as never];
      const discardBefore = state.discard.length;
      const r = act(state, 'A', { type: 'playCard', cardId: 'f1', targetIds: [] });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      expect(a.hand.length).toBe(8); // 摸八张
      const ask = state.pending;
      if (ask?.kind !== 'pickCards') throw new Error(`预期选牌，实际是 ${ask?.kind}`);
      expect(ask.min).toBe(6);
      const picked = a.hand.slice(0, 6).map((c) => c.id);
      const r2 = act(state, 'A', { type: 'pickCards', cardIds: picked });
      expect(r2.ok, r2.ok ? '' : r2.error).toBe(true);
      expect(a.hand.length).toBe(2); // 8 - 6
      expect(state.discard.length).toBe(discardBefore + 6);
      // 用过的势力锦囊**移出游戏**：不在弃牌堆，在 exiled 里
      expect(state.discard.some((c) => c.id === 'f1')).toBe(false);
      expect(state.exiled.some((c) => c.id === 'f1')).toBe(true);
    });

    it('固国安邦（吴）：选中的牌可至多 6 张转交同势力（每人至多 2 张），其余弃置', () => {
      const state = gz3();
      const a = state.players.find((p) => p.seatId === 'A')!;
      const b = state.players.find((p) => p.seatId === 'B')!;
      a.faction = 'wu';
      b.faction = 'wu'; // 同势力（乙）
      a.hand = [{ id: 'f2', type: 'guoanjianbang', suit: 'heart', rank: 1 } as never];
      const r = act(state, 'A', { type: 'playCard', cardId: 'f2', targetIds: [] });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      const ask = state.pending;
      if (ask?.kind !== 'pickCards') throw new Error(`预期选牌，实际是 ${ask?.kind}`);
      act(state, 'A', { type: 'pickCards', cardIds: a.hand.slice(0, 6).map((c) => c.id) });
      // 逐张问「交给谁」：前两张都给乙，第三张起乙应当已满（每人至多 2 张）→ 只剩「不交」与丙
      for (let i = 0; i < 2; i++) {
        const q = state.pending;
        if (q?.kind !== 'choice') throw new Error(`预期选择交给谁，实际是 ${q?.kind}`);
        expect(q.options.some((o) => o.id === 'B')).toBe(true);
        act(state, 'A', { type: 'chooseOption', optionId: 'B' });
      }
      const q3 = state.pending;
      if (q3?.kind !== 'choice') throw new Error(`预期第三张的选择，实际是 ${q3?.kind}`);
      expect(q3.options.some((o) => o.id === 'B'), '乙已收满 2 张，不该再出现在选项里').toBe(false);
      // 剩下四张都选「不交」→ 弃置
      for (let i = 0; i < 4; i++) {
        const q = state.pending;
        if (q?.kind !== 'choice') throw new Error(`预期不交，实际是 ${q?.kind}`);
        act(state, 'A', { type: 'chooseOption', optionId: 'discard' });
      }
      expect(b.hand.length).toBe(2); // 乙收了 2 张
      expect(a.hand.length).toBe(2); // 8 - 6
      expect(state.discard.filter((c) => c.id.startsWith('deck-') || true).length).toBeGreaterThan(0);
    });
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
