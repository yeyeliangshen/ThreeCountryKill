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

    it('开局不进摸牌堆（仍是 160 张），第一次重洗才把已实装的几张洗进来', () => {
      const state = gz3();
      expect(state.deck.length).toBe(160);
      // 四张**全部已实装** → 都在待洗区（这条断言同时守着「别把没实现的牌塞进牌堆」——
      // 没有 effect handler 的牌抽到就是一张打不出的死牌）
      expect(state.pendingFactionTricks.map((c) => c.type)).toEqual([
        'guoanjianbang',
        'haolingtianxia',
        'kefuzhongyuan',
        'wenheluanwu',
      ]);
      // 把摸牌堆摸空、并往弃牌堆放几张（重洗的前提是「牌堆空 + 弃牌堆非空」）→ 四张随新堆洗入
      let guard = 0;
      while (state.deck.length > 0 && guard++ < 400) state.discard.push(drawOne(state)!);
      expect(state.deck.length).toBe(0);
      const drawn = drawOne(state); // 这一步触发重洗，并顺带摸走一张
      expect(state.pendingFactionTricks.length).toBe(0);
      const pool = [...state.deck, ...(drawn ? [drawn] : [])];
      expect(pool.some((c) => c.type === 'guoanjianbang'), '固国安邦 应已洗进摸牌堆').toBe(true);
      expect(pool.some((c) => c.type === 'haolingtianxia'), '号令天下 应已洗进摸牌堆').toBe(true);
      expect(pool.some((c) => c.type === 'kefuzhongyuan'), '克复中原 应已洗进摸牌堆').toBe(true);
      expect(pool.some((c) => c.type === 'wenheluanwu'), '文和乱武 应已洗进摸牌堆').toBe(true);
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

    /**
     * 【号令天下】（魏 ♠Q）——口径见 docs §5.136/§5.136.3 与 §5.138.1（用户 2026-09-18 定版）：
     * 「其余角色」＝**除目标外的所有角色、含使用者本人**；
     * ①产生的【杀】受次数限制且计入次数；魏势力选①不用弃手牌、选②改为「获得」。
     */
    const haoling = () =>
      ({ id: 'h1', type: 'haolingtianxia', suit: 'spade', rank: 12 }) as never;

    it('号令天下：目标须是「体力值不是最少」的角色；其余角色含**使用者本人**、按座次依次选择', () => {
      const state = gz3();
      const a = state.players.find((p) => p.seatId === 'A')!;
      const b = state.players.find((p) => p.seatId === 'B')!;
      const c = state.players.find((p) => p.seatId === 'C')!;
      a.faction = 'wei';
      b.faction = 'wei';
      c.faction = 'shu';
      a.hp = 4;
      a.maxHp = 4;
      b.hp = 4;
      b.maxHp = 4;
      c.hp = 2; // 体力最少 → 不能当目标
      c.maxHp = 2;
      a.hand = [haoling()];
      b.hand = [{ id: 'b1', type: 'sha', suit: 'spade', rank: 7 } as never];
      c.hand = [];
      // 体力值最少的角色不能成为目标
      const bad = act(state, 'A', { type: 'playCard', cardId: 'h1', targetIds: ['C'] });
      expect(bad.ok, '体力值最少的角色不该能当目标').toBe(false);
      // 指乙（4 > 2）
      const r = act(state, 'A', { type: 'playCard', cardId: 'h1', targetIds: ['B'] });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      // 第一问给丙（甲的下家、且不是目标）
      const q1 = state.pending;
      if (q1?.kind !== 'choice') throw new Error(`预期选择，实际是 ${q1?.kind}`);
      expect(q1.seatId).toBe('C');
      act(state, 'C', { type: 'chooseOption', optionId: 'card' });
      // 丙（蜀，非魏）→ 弃置乙一张牌：乙只有手牌 → 随机弃置
      const q2 = state.pending;
      if (q2?.kind !== 'choice') throw new Error(`预期选牌目标，实际是 ${q2?.kind}`);
      act(state, 'C', { type: 'chooseOption', optionId: '__hand' });
      expect(b.hand.length, '乙的手牌被弃置了一张').toBe(0);
      // 第二问给**甲自己**（使用者本人也是「其余角色」——这正是 2026-09-18 定的那条口径）
      const q3 = state.pending;
      if (q3?.kind !== 'choice') throw new Error(`预期轮到使用者本人，实际是 ${q3?.kind}`);
      expect(q3.seatId, '「其余角色」含使用者本人').toBe('A');
      expect(q3.options.some((o) => o.id === 'sha')).toBe(true);
      act(state, 'A', { type: 'chooseOption', optionId: 'sha' }); // 魏：不用弃手牌
      expect(a.hand.length, '魏势力选①不用弃手牌').toBe(0);
      // 乙的【闪】窗口 → 不出 → 掉 1 血；整张牌就此结算完、控制权回到甲的出牌阶段
      const q4 = state.pending;
      if (q4?.kind !== 'respondSha') throw new Error(`预期求闪，实际是 ${q4?.kind}`);
      expect(q4.responderId).toBe('B');
      act(state, 'B', { type: 'pass' });
      expect(b.hp).toBe(3);
      expect(a.flags.shaCountThisTurn, '由此产生的【杀】计入次数').toBe(1);
      expect(state.pending?.kind).toBe('play');
    });

    it('号令天下：②魏势力改为「获得其一张牌」（非魏是弃置）；①的代价付不出时不给这一项', () => {
      const state = gz3();
      const a = state.players.find((p) => p.seatId === 'A')!;
      const b = state.players.find((p) => p.seatId === 'B')!;
      const c = state.players.find((p) => p.seatId === 'C')!;
      a.faction = 'wei';
      b.faction = 'shu';
      c.faction = 'wei'; // 魏 → ①免手牌、②改为获得
      a.hp = 4;
      a.maxHp = 4;
      b.hp = 4;
      b.maxHp = 4;
      c.hp = 2;
      c.maxHp = 2;
      a.hand = [haoling()];
      b.hand = [];
      b.equipment.weapon = {
        id: 'bw',
        type: 'weapon',
        equipName: 'qinggang',
        suit: 'spade',
        rank: 5,
      } as never;
      const r = act(state, 'A', { type: 'playCard', cardId: 'h1', targetIds: ['B'] });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      // 丙（魏、手里没牌）→ ① 仍然可选（魏不用弃手牌）
      const q1 = state.pending;
      if (q1?.kind !== 'choice') throw new Error(`预期选择，实际是 ${q1?.kind}`);
      expect(q1.options.some((o) => o.id === 'sha'), '魏势力选①不用手牌').toBe(true);
      act(state, 'C', { type: 'chooseOption', optionId: 'card' });
      // ②魏＝获得：装备是明牌，直接点它
      const q2 = state.pending;
      if (q2?.kind !== 'choice') throw new Error(`预期选牌，实际是 ${q2?.kind}`);
      expect(q2.options.some((o) => o.id === 'bw')).toBe(true);
      act(state, 'C', { type: 'chooseOption', optionId: 'bw' });
      expect(b.equipment.weapon, '乙的装备被拿走了').toBe(null);
      expect(c.hand.some((x) => x.id === 'bw'), '丙获得了那张装备牌').toBe(true);
      // 轮到甲（使用者本人）
      const q3 = state.pending;
      if (q3?.kind !== 'choice') throw new Error(`预期轮到使用者本人，实际是 ${q3?.kind}`);
      expect(q3.seatId).toBe('A');
      act(state, 'A', { type: 'chooseOption', optionId: 'sha' });
      const q4 = state.pending;
      if (q4?.kind !== 'respondSha') throw new Error(`预期求闪，实际是 ${q4?.kind}`);
      act(state, 'B', { type: 'pass' });
      expect(b.hp).toBe(3);
    });

    it('号令天下：① 受**次数限制**——本回合出杀已用完就不给这一项（只有②）', () => {
      const state = gz3();
      const a = state.players.find((p) => p.seatId === 'A')!;
      const b = state.players.find((p) => p.seatId === 'B')!;
      const c = state.players.find((p) => p.seatId === 'C')!;
      a.faction = 'wei';
      b.faction = 'shu';
      c.faction = 'shu'; // 非魏，手里有一张手牌（不然①会因为付不出代价而消失）
      a.hp = 4;
      a.maxHp = 4;
      b.hp = 4;
      b.maxHp = 4;
      c.hp = 2;
      c.maxHp = 2;
      c.hand = [{ id: 'c1', type: 'shan', suit: 'heart', rank: 2 } as never];
      c.flags.shaCountThisTurn = 1; // 本回合已经出过杀了（上限 1）
      a.hand = [haoling()];
      b.hand = [{ id: 'b1', type: 'sha', suit: 'spade', rank: 7 } as never];
      const r = act(state, 'A', { type: 'playCard', cardId: 'h1', targetIds: ['B'] });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      const q1 = state.pending;
      if (q1?.kind !== 'choice') throw new Error(`预期选择，实际是 ${q1?.kind}`);
      expect(q1.seatId).toBe('C');
      expect(q1.options.some((o) => o.id === 'sha'), '次数已用完，①不该出现').toBe(false);
      expect(q1.options.some((o) => o.id === 'card')).toBe(true);
    });

    /**
     * 【克复中原】（蜀 ♦A）——口径见 docs §5.136/§5.136.3：
     * 「对至少一名角色使用，每名目标 ①视为使用普通【杀】或 ②摸一张；蜀势力角色的【杀】基础伤害 +1、
     *   摸牌改为摸 2；产生的【杀】受正常次数限制。」
     * ⚠️ 2026-09-18 明确：选①的角色**自己**是那张虚拟【杀】的使用者、**自行挑合法目标**。
     */
    const kfzy = () => ({ id: 'k1', type: 'kefuzhongyuan', suit: 'diamond', rank: 1 }) as never;

    it('克复中原：每名目标各自二选一；蜀势力摸 2、非蜀摸 1（可多名目标）', () => {
      const state = gz3();
      const a = state.players.find((p) => p.seatId === 'A')!;
      const b = state.players.find((p) => p.seatId === 'B')!;
      const c = state.players.find((p) => p.seatId === 'C')!;
      a.faction = 'shu';
      b.faction = 'shu'; // 蜀 → 摸 2
      c.faction = 'wei'; // 非蜀 → 摸 1
      a.hp = 4;
      b.hp = 4;
      c.hp = 4;
      a.hand = [kfzy()];
      b.hand = [];
      c.hand = [];
      const r = act(state, 'A', { type: 'playCard', cardId: 'k1', targetIds: ['B', 'C'] });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      // 按座次：先是乙（甲的下家）
      const q1 = state.pending;
      if (q1?.kind !== 'choice') throw new Error(`预期选择，实际是 ${q1?.kind}`);
      expect(q1.seatId).toBe('B');
      act(state, 'B', { type: 'chooseOption', optionId: 'draw' });
      expect(b.hand.length, '蜀势力摸两张').toBe(2);
      // 再是丙
      const q2 = state.pending;
      if (q2?.kind !== 'choice') throw new Error(`预期选择，实际是 ${q2?.kind}`);
      expect(q2.seatId).toBe('C');
      act(state, 'C', { type: 'chooseOption', optionId: 'draw' });
      expect(c.hand.length, '非蜀摸一张').toBe(1);
      expect(state.pending?.kind).toBe('play');
    });

    it('克复中原①：选择者**自己**成为虚拟【杀】的使用者、自行挑目标；蜀的基础伤害 +1 且计入次数', () => {
      const state = gz3();
      const a = state.players.find((p) => p.seatId === 'A')!;
      const b = state.players.find((p) => p.seatId === 'B')!;
      const c = state.players.find((p) => p.seatId === 'C')!;
      a.faction = 'wei';
      b.faction = 'shu'; // 选①的这一个是蜀 → 伤害 +1
      c.faction = 'wei';
      a.hp = 4;
      b.hp = 4;
      c.hp = 4;
      a.hand = [kfzy()];
      b.hand = [];
      c.hand = [];
      const r = act(state, 'A', { type: 'playCard', cardId: 'k1', targetIds: ['B'] });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      const q1 = state.pending;
      if (q1?.kind !== 'choice') throw new Error(`预期选择，实际是 ${q1?.kind}`);
      expect(q1.options.some((o) => o.id === 'sha')).toBe(true);
      act(state, 'B', { type: 'chooseOption', optionId: 'sha' });
      // 乙自己挑目标：合法目标里**没有他自己**，只有甲、丙
      const q2 = state.pending;
      if (q2?.kind !== 'choice') throw new Error(`预期选杀的目标，实际是 ${q2?.kind}`);
      expect(q2.seatId).toBe('B');
      expect(q2.options.map((o) => o.id).sort()).toEqual(['A', 'C']);
      act(state, 'B', { type: 'chooseOption', optionId: 'C' });
      const q3 = state.pending;
      if (q3?.kind !== 'respondSha') throw new Error(`预期求闪，实际是 ${q3?.kind}`);
      expect(q3.responderId).toBe('C');
      act(state, 'C', { type: 'pass' });
      expect(c.hp, '蜀势力的【杀】基础伤害 1+1').toBe(2);
      expect(b.flags.shaCountThisTurn, '产生的【杀】计入次数').toBe(1);
      expect(state.pending?.kind).toBe('play');
    });

    it('克复中原①：受**正常次数限制**——本回合出杀已用完就不给这一项', () => {
      const state = gz3();
      const a = state.players.find((p) => p.seatId === 'A')!;
      const b = state.players.find((p) => p.seatId === 'B')!;
      const c = state.players.find((p) => p.seatId === 'C')!;
      a.faction = 'wei';
      b.faction = 'wei';
      c.faction = 'wei';
      a.hp = 4;
      b.hp = 4;
      c.hp = 4;
      b.flags.shaCountThisTurn = 1; // 本回合已经出过杀了（上限 1）
      a.hand = [kfzy()];
      b.hand = [];
      c.hand = [];
      const r = act(state, 'A', { type: 'playCard', cardId: 'k1', targetIds: ['B'] });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      const q1 = state.pending;
      if (q1?.kind !== 'choice') throw new Error(`预期选择，实际是 ${q1?.kind}`);
      expect(q1.options.some((o) => o.id === 'sha'), '次数已用完，①不该出现').toBe(false);
      expect(q1.options.some((o) => o.id === 'draw')).toBe(true);
    });

    /**
     * 【文和乱武】（群 ♣Q）——口径见 docs §5.136 表 + §5.136.3：
     * 「对所有角色使用。目标依次展示全部手牌，**你**选择：①若其可弃置的手牌类别不全相同，弃置两张
     *   类别不同的手牌；若全同类则弃置一张；②观看并弃置其一张手牌。**群势力角色**结算后若没有手牌，
     *   将手牌补至当前体力值。」
     */
    const whlw = () => ({ id: 'w1', type: 'wenheluanwu', suit: 'club', rank: 12 }) as never;

    it('文和乱武：对**所有角色**（含使用者）依次结算；由使用者挑牌，类别不同时弃两张', () => {
      const state = gz3();
      const a = state.players.find((p) => p.seatId === 'A')!;
      const b = state.players.find((p) => p.seatId === 'B')!;
      const c = state.players.find((p) => p.seatId === 'C')!;
      a.faction = 'wei'; // 使用者本人也在目标里；非群，避免补牌干扰断言
      b.faction = 'wei';
      c.faction = 'wei';
      a.hp = 4;
      b.hp = 4;
      c.hp = 4;
      a.hand = [whlw()];
      // 乙：两张**不同类别**（基本 + 锦囊）→ ①要弃两张不同类别的
      b.hand = [
        { id: 'b-sha', type: 'sha', suit: 'spade', rank: 7 } as never,
        { id: 'b-guohe', type: 'guohe', suit: 'club', rank: 3 } as never,
      ];
      c.hand = [];
      const r = act(state, 'A', { type: 'playCard', cardId: 'w1', targetIds: [] });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      // 第一问给乙（甲的下家），且是**问甲**（由使用者挑牌）
      const q1 = state.pending;
      if (q1?.kind !== 'choice') throw new Error(`预期选择，实际是 ${q1?.kind}`);
      expect(q1.seatId).toBe('A');
      expect(q1.options.some((o) => o.label.includes('两张'))).toBe(true);
      act(state, 'A', { type: 'chooseOption', optionId: 'two' });
      // 第一张：随便挑（基本牌）
      const p1 = state.pending;
      if (p1?.kind !== 'pickCards') throw new Error(`预期挑第一张，实际是 ${p1?.kind}`);
      expect(p1.seatId).toBe('A');
      act(state, 'A', { type: 'pickCards', cardIds: ['b-sha'] });
      // 第二张只能在**别的类别**里挑 → 选项里只有那张锦囊
      const p2 = state.pending;
      if (p2?.kind !== 'pickCards') throw new Error(`预期挑第二张，实际是 ${p2?.kind}`);
      expect(p2.cards.map((x) => x.id)).toEqual(['b-guohe']);
      act(state, 'A', { type: 'pickCards', cardIds: ['b-guohe'] });
      expect(b.hand.length, '乙被弃置两张').toBe(0);
      // 丙空手 → 不问；然后轮到甲自己（手牌已空）→ 整张牌结算完
      expect(state.pending?.kind).toBe('play');
    });

    it('文和乱武：目标手牌**类别全同**时只弃一张；②可任挑一张', () => {
      const state = gz3();
      const a = state.players.find((p) => p.seatId === 'A')!;
      const b = state.players.find((p) => p.seatId === 'B')!;
      const c = state.players.find((p) => p.seatId === 'C')!;
      a.faction = 'wei';
      b.faction = 'wei';
      c.faction = 'wei';
      a.hp = 4;
      b.hp = 4;
      c.hp = 4;
      a.hand = [whlw()];
      b.hand = [
        { id: 'b-sha', type: 'sha', suit: 'spade', rank: 7 } as never,
        { id: 'b-tao', type: 'tao', suit: 'heart', rank: 4 } as never,
      ];
      c.hand = [];
      const r = act(state, 'A', { type: 'playCard', cardId: 'w1', targetIds: [] });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      const q1 = state.pending;
      if (q1?.kind !== 'choice') throw new Error(`预期选择，实际是 ${q1?.kind}`);
      expect(q1.options.some((o) => o.label.includes('类别全同'))).toBe(true);
      act(state, 'A', { type: 'chooseOption', optionId: 'one' }); // ②观看并弃置一张
      const p1 = state.pending;
      if (p1?.kind !== 'pickCards') throw new Error(`预期挑牌，实际是 ${p1?.kind}`);
      expect(p1.cards.length).toBe(2); // 两张都能挑
      act(state, 'A', { type: 'pickCards', cardIds: ['b-tao'] });
      expect(b.hand.map((x) => x.id)).toEqual(['b-sha']);
    });

    it('文和乱武：群势力目标结算后没手牌 → 补至其当前体力值（非群不补）', () => {
      const state = gz3();
      const a = state.players.find((p) => p.seatId === 'A')!;
      const b = state.players.find((p) => p.seatId === 'B')!;
      const c = state.players.find((p) => p.seatId === 'C')!;
      a.faction = 'wei';
      b.faction = 'qun'; // 群、空手、3 血 → 补 3 张
      c.faction = 'wei'; // 非群：不补
      a.hp = 4;
      b.hp = 3;
      b.maxHp = 3;
      c.hp = 4;
      a.hand = [whlw()];
      b.hand = [];
      c.hand = [];
      const r = act(state, 'A', { type: 'playCard', cardId: 'w1', targetIds: [] });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      expect(b.hand.length, '群势力空手 → 补到当前体力值 3 张').toBe(3);
      expect(c.hand.length, '非群不补').toBe(0);
      expect(a.hand.length, '甲也是非群，不补').toBe(0);
    });
  });

  /**
   * 【暴露野心 → 建立新势力】——不臣篇**野心家武将**的机制，口径见 docs §5.141
   * （用户 2026-09-18 给的全文 + 官方公告）。要点：
   * - 触发：即将满足胜利条件时，若仍有「只明置了副将的野心家武将」→ 先处理暴露，不能直接结束游戏；
   * - 暴露后：明置主将、身份/势力**转为野心家**；**存活不足 3 人也能建国**；
   * - 建国后**所有存活玩家**分别选加入/不加入（旧版「只能拉一个」已作废）；
   * - 不加入者**可选**补偿：手牌补至 4 张 + 回复 1 点体力。
   */
  describe('不臣篇 · 暴露野心／建立新势力', () => {
    /** 4 人局：甲＝孙綝（野心家主将，**只明置了副将关羽**，暂按蜀算）+ 乙丙蜀 + 丁魏 */
    const gzAmb = () => {
      const state = createGame(
        [
          { seatId: 'A', name: '甲', heroId: 'sunchen' },
          { seatId: 'B', name: '乙', heroId: 'vanilla' },
          { seatId: 'C', name: '丙', heroId: 'vanilla' },
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
      const [a, b, c, d] = state.players as [typeof state.players[0], typeof state.players[0], typeof state.players[0], typeof state.players[0]];
      a.heroId = 'sunchen';
      a.deputyHeroId = 'guanyu';
      a.faction = 'ambitionist';
      a.determinedFaction = 'shu'; // 暂时按副将确定势力（只明置副将期间）
      a.deputyRevealed = true;
      a.heroRevealed = false;
      for (const p of [b, c]) {
        p.heroId = 'vanilla';
        p.deputyHeroId = 'vanilla';
        p.faction = 'shu';
        p.heroRevealed = true;
        p.deputyRevealed = true;
      }
      d.heroId = 'vanilla';
      d.deputyHeroId = 'vanilla';
      d.faction = 'wei';
      d.heroRevealed = true;
      d.deputyRevealed = true;
      state.turn = { seatIndex: 0, phase: 'play' };
      state.pending = { kind: 'play', seatId: 'A' };
      return { state, a, b, c, d };
    };

    /** 甲杀丁（丁 1 血）→ 丁阵亡 → 胜利判定被「暴露野心」截断 */
    const triggerVictory = (state: ReturnType<typeof gzAmb>['state'], a: ReturnType<typeof gzAmb>['a'], d: ReturnType<typeof gzAmb>['d']): void => {
      d.hp = 1;
      a.hand = [{ id: 'a-sha', type: 'sha', suit: 'spade', rank: 7 } as never];
      const r = act(state, 'A', { type: 'playCard', cardId: 'a-sha', targetIds: ['D'] });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      let guard = 0;
      while (state.pending && state.pending.kind === 'respondSha' && guard++ < 5) {
        act(state, 'D', { type: 'pass' });
      }
      // 求桃轮：所有人弃权 → 丁阵亡
      guard = 0;
      while (state.pending?.kind === 'respondDeath' && guard++ < 10) {
        const asked = state.pending.askQueue[state.pending.askIndex]!;
        act(state, asked, { type: 'pass' });
      }
    };

    it('即将胜利时先处理暴露野心：建国 → 邀请所有存活玩家（加入者共享 forceId、不加入者可选补偿）', () => {
      const { state, a, b, c, d } = gzAmb();
      triggerVictory(state, a, d);
      // 蜀 3 人 > 半数 → 本该蜀胜，但因为甲的野心家主将还没明置 → 先问暴露
      const q1 = state.pending;
      if (q1?.kind !== 'choice') throw new Error(`预期暴露野心询问，实际是 ${q1?.kind}`);
      expect(q1.seatId).toBe('A');
      expect(q1.title).toContain('暴露野心');
      act(state, 'A', { type: 'chooseOption', optionId: 'yes' });
      expect(a.heroRevealed, '暴露后主将明置').toBe(true);
      expect(a.determinedFaction, '身份/势力转为野心家').toBe('ambitionist');
      // ⚠️ 暴露之后**直接进建国流程**——2023 公告是「当野心家暴露野心，建立新势力时……」一句，
      //    不再多问一句「是否建立新势力」（用户 2026-09-18 明确：拆成两个窗口依据不足）。
      const forceId = a.forceId;
      expect(forceId, '暴露即建国，生成独立 forceId').toBeTruthy();
      // 邀请其他存活玩家：乙、丙（丁已阵亡）——顺序＝以当前回合角色为基准按座次
      const q3 = state.pending;
      if (q3?.kind !== 'choice') throw new Error(`预期邀请乙，实际是 ${q3?.kind}`);
      expect(q3.seatId).toBe('B');
      act(state, 'B', { type: 'chooseOption', optionId: 'yes' });
      expect(b.forceId, '加入者共享发起者的 forceId').toBe(forceId);
      expect(b.faction).toBe('ambitionist');
      const q4 = state.pending;
      if (q4?.kind !== 'choice') throw new Error(`预期邀请丙，实际是 ${q4?.kind}`);
      expect(q4.seatId).toBe('C');
      act(state, 'C', { type: 'chooseOption', optionId: 'no' });
      // 不加入 → 可选补偿：手牌补到 4 张、回复 1 点体力
      c.hp = 3;
      const q5 = state.pending;
      if (q5?.kind !== 'choice') throw new Error(`预期补偿询问，实际是 ${q5?.kind}`);
      act(state, 'C', { type: 'chooseOption', optionId: 'yes' });
      expect(c.hand.length, '手牌**补到** 4 张').toBe(4);
      expect(c.hp, '回复 1 点体力').toBe(4);
      expect(c.forceId, '不加入者保留原势力').toBeUndefined();
      // 结构变了 → 重新判：甲+乙的新势力 2 人 > 半数（3 人局）→ 新势力胜
      expect(state.gameOver).toBe(true);
      expect(state.winner).toBe(forceId);
    });

    it('一次建国总流程里最多加入一个新势力：已加入者不再被别的野心家邀请（发起者也不算可拉拢）', () => {
      // 甲与丙**都是暗着主将的野心家武将**；乙、丁是普通角色。
      // 乙阵亡后「魏」过半（丙按副将算魏）→ 先处理暴露 → 甲建国 → 之后轮到丙建国。
      const state = createGame(
        [
          { seatId: 'A', name: '甲', heroId: 'sunchen' },
          { seatId: 'B', name: '乙', heroId: 'vanilla' },
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
      const a = state.players[0]!;
      const b = state.players[1]!;
      const c = state.players[2]!;
      const d = state.players[3]!;
      a.heroId = 'sunchen';
      a.deputyHeroId = 'guanyu';
      a.faction = 'ambitionist';
      a.determinedFaction = 'shu'; // 暂时按副将（关羽）算蜀
      a.deputyRevealed = true;
      for (const p of [b]) {
        p.heroId = 'vanilla';
        p.deputyHeroId = 'vanilla';
        p.faction = 'shu';
        p.heroRevealed = true;
        p.deputyRevealed = true;
      }
      c.heroId = 'sp_simazhao';
      c.deputyHeroId = 'simayi';
      c.faction = 'ambitionist';
      c.determinedFaction = 'wei'; // 暂时按副将（司马懿）算魏
      c.deputyRevealed = true;
      d.heroId = 'vanilla';
      d.deputyHeroId = 'vanilla';
      d.faction = 'wei';
      d.heroRevealed = true;
      d.deputyRevealed = true;
      state.turn = { seatIndex: 0, phase: 'play' };
      state.pending = { kind: 'play', seatId: 'A' };
      // 甲杀乙 → 乙阵亡 → 魏 2/3 过半 → 但甲、丙的主将都没明置 → 先处理暴露
      b.hp = 1;
      a.hand = [{ id: 'a-sha', type: 'sha', suit: 'spade', rank: 7 } as never];
      const r = act(state, 'A', { type: 'playCard', cardId: 'a-sha', targetIds: ['B'] });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      let guard = 0;
      while (state.pending && state.pending.kind === 'respondSha' && guard++ < 5) {
        act(state, 'B', { type: 'pass' });
      }
      guard = 0;
      while (state.pending?.kind === 'respondDeath' && guard++ < 10) {
        const asked = state.pending.askQueue[state.pending.askIndex]!;
        act(state, asked, { type: 'pass' });
      }
      // ① 甲先暴露（暴露即建国）→ 邀请丙、丁
      const q1 = state.pending;
      if (q1?.kind !== 'choice') throw new Error(`预期甲暴露野心，实际是 ${q1?.kind}`);
      expect(q1.seatId).toBe('A');
      act(state, 'A', { type: 'chooseOption', optionId: 'yes' });
      const force1 = a.forceId!;
      expect(force1, '甲暴露即建国').toBeTruthy();
      // 丙不加入、丁加入甲的新势力
      const q2 = state.pending;
      if (q2?.kind !== 'choice') throw new Error(`预期邀请丙，实际是 ${q2?.kind}`);
      expect(q2.seatId).toBe('C');
      act(state, 'C', { type: 'chooseOption', optionId: 'no' });
      const q2b = state.pending;
      if (q2b?.kind !== 'choice') throw new Error(`预期补偿询问（丙），实际是 ${q2b?.kind}`);
      act(state, 'C', { type: 'chooseOption', optionId: 'no' }); // 补偿是可选的，这里不领
      const q3 = state.pending;
      if (q3?.kind !== 'choice') throw new Error(`预期邀请丁，实际是 ${q3?.kind}`);
      expect(q3.seatId).toBe('D');
      act(state, 'D', { type: 'chooseOption', optionId: 'yes' });
      expect(d.forceId, '丁加入了甲的新势力').toBe(force1);
      // ② 结构变了、但丙还是没暴露的野心家武将 → 继续处理丙
      const q4 = state.pending;
      if (q4?.kind !== 'choice') throw new Error(`预期丙暴露野心，实际是 ${q4?.kind}`);
      expect(q4.seatId).toBe('C');
      act(state, 'C', { type: 'chooseOption', optionId: 'yes' });
      const force2 = c.forceId!;
      expect(force2, '丙建国拿到**自己的** forceId').not.toBe(force1);
      // ③ 丙的邀请名单里**不该有**甲（建国发起者）与丁（已加入甲的新势力）→ 没有人可问，直接收口
      expect(
        !!state.pending && state.pending.kind === 'choice' && state.pending.title.includes('是否加入'),
        '已加入/已建国的人不再被别的野心家邀请',
      ).toBe(false);
      expect(d.forceId, '丁没有被丙拉走').toBe(force1);
      // ④ 收口后重判胜负：甲 + 丁 的新势力 2/3 过半 → 甲那个势力赢
      expect(state.gameOver).toBe(true);
      expect(state.winner).toBe(force1);
    });

    it('选择不暴露 → 照原样结算胜利（该势力胜）', () => {
      const { state, a, d } = gzAmb();
      triggerVictory(state, a, d);
      const q1 = state.pending;
      if (q1?.kind !== 'choice') throw new Error(`预期暴露野心询问，实际是 ${q1?.kind}`);
      act(state, 'A', { type: 'chooseOption', optionId: 'no' });
      expect(state.gameOver, '不暴露 → 该赢的还是赢').toBe(true);
      expect(state.winner).toBe('shu');
      expect(a.heroRevealed, '没暴露就不明置主将').toBe(false);
    });

    it('「势力超编转成的普通野心家」**没有**这套流程（两套规则别混）', () => {
      const state = createGame(
        [
          { seatId: 'A', name: '甲', heroId: 'vanilla' },
          { seatId: 'B', name: '乙', heroId: 'vanilla' },
          { seatId: 'C', name: '丙', heroId: 'vanilla' },
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
        p.heroId = 'vanilla';
        p.deputyHeroId = 'vanilla';
        p.heroRevealed = true;
        p.deputyRevealed = true;
      }
      const [a, b, c, d] = state.players as [typeof state.players[0], typeof state.players[0], typeof state.players[0], typeof state.players[0]];
      a.faction = 'shu';
      a.determinedFaction = 'shu';
      b.faction = 'shu';
      b.determinedFaction = 'shu';
      c.faction = 'wei';
      c.determinedFaction = 'wei';
      // 甲：因人数超编转成的野心家（不是野心家武将——主将牌是普通武将）
      d.faction = 'wei';
      d.determinedFaction = 'wei';
      a.faction = 'ambitionist';
      a.forceId = 'force:99';
      state.turn = { seatIndex: 0, phase: 'play' };
      state.pending = { kind: 'play', seatId: 'A' };
      // 杀丁 → 丁阵亡 → 胜利判定：乙（蜀）+ 甲（野心家）… 丙丁都没了？这里只要求「不出现暴露野心询问」
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
      // 只要没有「暴露野心」的询问即可（转成的野心家没有这套流程）
      expect(state.pending?.kind === 'choice' && state.pending.title.includes('暴露野心')).toBe(false);
    });
  });

  it('buchen 开关整包管住：off 时**所有**不臣篇武将（含单势力那 4 位）都不进选将池', () => {    const seats = [
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
