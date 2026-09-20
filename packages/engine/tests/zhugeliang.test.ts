import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applyIntent,
  createGame,
  emptyFlags,
  getHero,
  hasCombo,
  seededRng,
  type Card,
  type Faction,
  type GameState,
  type SeatSetup,
} from '../src';

/**
 * 随机源钉死（与 engine.test.ts 同一纪律）：createGame 会洗牌，不钉的话「谁发到什么牌」
 * 每次不同，沾了具体牌面的断言就会偶发红。
 */
beforeEach(() => {
  const rnd = seededRng(20260921);
  vi.spyOn(Math, 'random').mockImplementation(() => rnd());
});
afterEach(() => {
  vi.restoreAllMocks();
});

const A = 's0';
const B = 's1';
const C = 's2';

function mk(id: string, type: Card['type'], suit: Card['suit'] = 'spade', rank = 1): Card {
  return { id, type, suit, rank };
}
const sha = (id: string, suit: Card['suit'] = 'spade') => mk(id, 'sha', suit);
const shan = (id: string, suit: Card['suit'] = 'heart') => mk(id, 'shan', suit);
const juedou = (id: string) => mk(id, 'juedou', 'spade');
const weapon = (id: string, equipName: string, range = 2): Card => ({
  id,
  type: 'weapon',
  suit: 'spade',
  rank: 5,
  equipName,
  range,
});

const act = (state: GameState, seatId: string, intent: Parameters<typeof applyIntent>[2]) =>
  applyIntent(state, seatId, intent);
function ok(res: ReturnType<typeof applyIntent>, msg?: string) {
  if (!res.ok) throw new Error(`预期成功但失败：${res.error} ${msg ?? ''}`);
}
/** 快速跳过无懈可击询问轮（所有人弃权） */
function passWuxie(state: GameState) {
  while (state.pending?.kind === 'wuxieQueue') {
    const asked = state.pending.askQueue[state.pending.askIndex]!;
    ok(act(state, asked, { type: 'pass' }));
  }
}
/** 回答「选择目标区域里的一张牌」（【过河拆桥】/【顺手牵羊】） */
function pickZoneCard(state: GameState, seat: string, optionId: string) {
  ok(act(state, seat, { type: 'chooseOption', optionId }));
}

interface GzSeat {
  seatId: string;
  name: string;
  heroId: string;
  deputyHeroId?: string;
  faction: Faction;
  revealed?: boolean;
  hand: Card[];
  hp?: number;
}

/**
 * 国战可控局面：默认双将已明置（空城那类锁定技只认已明置的武将牌）。
 * ⚠️ 副将默认给「关羽」这类没有回合钩子的武将——**同一张武将牌放两个槽位会让它的钩子被收两遍**
 *    （钩子是按武将牌收的），观星会被连问两次。
 */
function gzGame(seats: GzSeat[]): GameState {
  const setup: SeatSetup[] = seats.map((s) => ({
    seatId: s.seatId,
    name: s.name,
    heroId: s.heroId,
  }));
  const state = createGame(setup, 'TEST', { mode: 'guozhan' });
  state.draft = null;
  for (const s of seats) {
    const p = state.players.find((pl) => pl.seatId === s.seatId)!;
    const hero = getHero(s.heroId)!;
    const deputyId = s.deputyHeroId ?? 'guanyu';
    const deputy = getHero(deputyId)!;
    p.heroId = s.heroId;
    p.deputyHeroId = deputyId;
    p.faction = s.faction;
    p.heroRevealed = s.revealed ?? true;
    p.deputyRevealed = s.revealed ?? true;
    p.maxHp = Math.max(1, Math.floor((hero.maxHp + deputy.maxHp) / 2));
    p.hp = s.hp ?? p.maxHp;
    p.hand = s.hand.slice();
    p.flags = emptyFlags();
  }
  const first = state.seatOrder[0]!;
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: first };
  state.log = [];
  return state;
}
const at = (state: GameState, seatId: string) => state.players.find((p) => p.seatId === seatId)!;
/** 可控牌堆：drawOne 从末尾 pop（数组末尾是牌堆顶） */
function setDeck(state: GameState, ids: string[]) {
  state.deck = ids.map((id, i) => mk(id, 'sha', i % 2 === 0 ? 'spade' : 'club', i + 1));
}

/**
 * 国战诸葛亮（用户 2026-09-21 给的规格）。三个考点：
 *
 * ①【观星】X = 存活角色数且至多 5；**要看的张数不够时不是「只看剩下的」**——牌堆耗尽立刻把
 *   弃牌堆重洗成新摸牌堆再接着看（势力锦囊四张正是在这**第一次重洗**时洗进摸牌堆）。
 *   「任意顺序置于牌堆顶或牌堆底」三种摆法都要可达：全部放顶 / 全部放底 / 任意拆分。
 * ②【空城】第一段是**成为目标时**的检查：已经指定完目标的【杀】/【决斗】不会因为结算中诸葛亮
 *   变成 0 手牌就被追溯取消；青龙偃月刀「继续出杀」算**新的一次使用**，那时要重新判目标。
 * ③【空城】第二段（国战专属）：0 手牌时，其他角色于**其回合外**「交给」他的牌改为
 *   **置于武将牌上**（不进手牌，所以空城照旧成立），到他的下一个摸牌阶段开始时一次性获得；
 *   摸牌阶段被跳过（兵粮/神速）就顺延。⚠️ **只拦「交给」**——摸牌、五谷丰登、获得他人牌都不拦，
 *   否则「用五谷破空城」这条经典解法就没了。
 */
describe('国战诸葛亮：观星 × 空城（用户 2026-09-21 规格）', () => {
  // —— ① 观星 ——

  it('观星：全部放底（第一步一张不选＝没人留顶、第二步全选＝都沉底，顺序也由自己定）', () => {
    const state = gzGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhugeliang', faction: 'shu', hand: [] },
    ]);
    setDeck(state, ['d1', 'd2', 'd3', 'd4', 'd5']); // d5 最先被抽到；2 人 → 观星看 2 张
    ok(act(state, A, { type: 'endPhase' })); // 轮到乙：准备阶段 → 观星问一句
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    // 第一步一张不选：以前这里直接收工（当成「都不动」），于是「全部放底」根本表达不出来
    ok(act(state, B, { type: 'pickCards', cardIds: [] }));
    expect(state.pending?.kind).toBe('pickCards');
    if (state.pending?.kind === 'pickCards') {
      expect(state.pending.cards.map((c) => c.id)).toEqual(['d5', 'd4']);
    } else throw new Error('第二步应当把观星的两张都摆出来');
    // 第二步：两张都沉底（按点击顺序＝沉底后先被抽到的先点）
    ok(act(state, B, { type: 'pickCards', cardIds: ['d5', 'd4'] }));
    const b = at(state, B);
    // 摸牌阶段抽的是 d3、d2；d5/d4 已经躺到牌堆最底（后点的 d4 压在最下面）
    expect(b.hand.map((c) => c.id).sort()).toEqual(['d2', 'd3']);
    expect(state.deck[0]!.id).toBe('d4');
  });

  it('观星：牌堆不够时「立即重洗、继续结算」——势力锦囊正是在这第一次重洗洗入', () => {
    const state = gzGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhugeliang', faction: 'shu', hand: [] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [] },
    ]);
    // 3 人局 → 观星要看 3 张；牌堆只剩 2 张（弃牌堆还有 2 张）→ 第 3 张必然逼出重洗
    setDeck(state, ['d1', 'd2']);
    state.discard = [mk('x1', 'sha'), mk('x2', 'sha')];
    expect(state.pendingFactionTricks).toHaveLength(4);
    ok(act(state, A, { type: 'endPhase' })); // 轮到乙
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    const p = state.pending;
    expect(p?.kind).toBe('pickCards');
    if (p?.kind === 'pickCards') {
      // 2 张原顶 + 重洗后补的 1 张：总量仍是 min(5, 存活 3) = 3（不是「只剩 2 张就只看 2 张」）
      expect(p.cards).toHaveLength(3);
      expect(p.cards.map((c) => c.id).slice(0, 2)).toEqual(['d2', 'd1']);
    } else throw new Error('应进入观星选牌');
    // 势力锦囊四张已经随这次重洗进了摸牌堆（它们开局**不在**任何牌堆里）
    expect(state.pendingFactionTricks).toHaveLength(0);
    expect(state.log.some((e) => e.message.includes('势力锦囊'))).toBe(true);
  });

  it('珠联璧合：诸葛亮 ❤ 黄月英 / 姜维 / 蒋琬费祎（国战牌面 1.5 阴阳鱼 → 体力 3）', () => {
    const zg = getHero('zhugeliang')!;
    for (const id of ['huangyueying', 'jiangwei', 'jiangwan_feyi']) {
      expect(hasCombo(zg, getHero(id)!), `诸葛亮 ❤ ${id}`).toBe(true);
    }
    // 引擎里的体力是「阴阳鱼 × 2」的口径（3 = 1.5 阴阳鱼，与卧龙那条注释同一口径）
    expect(zg.maxHp).toBe(3);
    expect(zg.faction).toBe('shu');
  });

  // —— ② 空城第一段：只在「成为目标时」判 ——

  it('空城：指定目标之后才变成 0 手牌 → 不追溯取消已经打出的【决斗】', () => {
    const state = gzGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [juedou('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'zhugeliang', faction: 'shu', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [] },
    ]);
    const b = at(state, B);
    // 指定目标时乙手里有 1 张【杀】→ 空城不触发，可以成为目标
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    passWuxie(state);
    // 乙打出那张【杀】（手牌归零，此刻才进入空城状态）→ 甲再出一张【杀】→ 乙出不了 → 受伤
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    ok(act(state, A, { type: 'respondCard', cardId: 'a2' }));
    ok(act(state, B, { type: 'pass' }));
    expect(b.hand).toHaveLength(0);
    expect(b.hp, '【决斗】不会被中途触发的空城追溯取消').toBe(b.maxHp - 1);
  });

  it('空城：青龙偃月刀「继续出杀」算新的一次使用，那时要重新判目标', () => {
    const state = gzGame([
      { seatId: A, name: '甲', heroId: 'zhangfei', faction: 'shu', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'zhugeliang', faction: 'shu', hand: [shan('b1')] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [] },
    ]);
    const a = at(state, A);
    const b = at(state, B);
    a.equipment.weapon = weapon('w1', 'qinglong', 3);
    // 第一张【杀】：指定目标时乙有手牌 → 合法；乙用掉唯一的【闪】→ 手牌归零
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    expect(state.pending?.kind).toBe('choice'); // 青龙问「要不要继续出杀」
    ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, A, { type: 'pickCards', cardIds: ['a2'] }));
    // 新的【杀】要重新判目标：诸葛亮 0 手牌 → 空城挡住，这一张没打出去
    expect(state.log.some((e) => e.message.includes('空城'))).toBe(true);
    expect(b.hp).toBe(b.maxHp);
    expect(state.pending).toEqual({ kind: 'play', seatId: A });
  });

  // —— ③ 空城第二段：交给 → 置于武将牌上 → 下个摸牌阶段获得 ——

  it('国战空城：回合外 0 手牌被【仁德】交给两张牌 → 不进手牌，改置于武将牌上', () => {
    const state = gzGame([
      { seatId: A, name: '甲', heroId: 'liubei', faction: 'shu', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'zhugeliang', faction: 'shu', hand: [] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [] },
    ]);
    const b = at(state, B);
    ok(
      act(state, A, {
        type: 'useSkill',
        skillId: 'rende',
        cardIds: ['a1', 'a2'],
        targetIds: [B],
      }),
    );
    // 交给的牌被空城接住了：手牌仍是 0（空城照旧成立），牌扣在武将牌上
    expect(b.hand).toHaveLength(0);
    expect(b.kongcheng.map((c) => c.id)).toEqual(['a1', 'a2']);
    expect(state.log.some((e) => e.message.includes('置于其武将牌上'))).toBe(true);
  });

  it('国战空城：暂存的牌在下一个摸牌阶段开始时一次性获得', () => {
    const state = gzGame([
      { seatId: A, name: '甲', heroId: 'liubei', faction: 'shu', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'zhugeliang', faction: 'shu', hand: [] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [] },
    ]);
    const b = at(state, B);
    ok(
      act(state, A, {
        type: 'useSkill',
        skillId: 'rende',
        cardIds: ['a1', 'a2'],
        targetIds: [B],
      }),
    );
    expect(b.kongcheng).toHaveLength(2);
    setDeck(state, ['d1', 'd2', 'd3', 'd4']);
    ok(act(state, A, { type: 'endPhase' })); // 轮到乙
    // 乙的准备阶段：观星问一句 → 不发动
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    // 摸牌阶段开始时先把暂存的两张拿到手，再照常摸两张
    expect(b.kongcheng).toHaveLength(0);
    expect(b.hand.map((c) => c.id).sort()).toEqual(['a1', 'a2', 'd3', 'd4']);
    expect(state.log.some((e) => e.message.includes('摸牌阶段开始时获得'))).toBe(true);
  });

  it('国战空城：摸牌阶段被跳过 → 暂存牌顺延到下一个真正的摸牌阶段', () => {
    const state = gzGame([
      { seatId: A, name: '甲', heroId: 'liubei', faction: 'shu', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'zhugeliang', faction: 'shu', hand: [] },
      { seatId: C, name: '丙', heroId: 'guanyu', faction: 'shu', hand: [] },
    ]);
    const b = at(state, B);
    ok(
      act(state, A, {
        type: 'useSkill',
        skillId: 'rende',
        cardIds: ['a1', 'a2'],
        targetIds: [B],
      }),
    );
    // 乙的判定区放一张【兵粮寸断】，判定牌（牌堆顶 d3＝黑桃）不是梅花 → 跳过摸牌阶段。
    // ⚠️ 牌堆要在 endPhase **之前**摆好：轮转是同步走完的（判定就在那次调用里翻了牌）；
    //    setDeck 的奇偶决定花色——偶数下标才是黑桃，别把梅花顶上去了（梅花兵粮不生效）。
    b.judgment.push(mk('bl1', 'bingliang', 'spade', 6));
    setDeck(state, ['d1', 'd2', 'd3']);
    ok(act(state, A, { type: 'endPhase' })); // 轮到乙
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' })); // 观星：不发动
    expect(b.flags.skipDraw).toBe(true);
    // 没有「摸牌阶段开始时」这个时机 → 暂存牌一张都不能提前拿到
    expect(b.kongcheng).toHaveLength(2);
    expect(b.hand).toHaveLength(0);
    // 走完一圈回到乙：这次的摸牌阶段是真的，暂存牌照常入账
    ok(act(state, B, { type: 'endPhase' }));
    ok(act(state, C, { type: 'endPhase' }));
    ok(act(state, A, { type: 'endPhase' }));
    expect(state.pending?.kind).toBe('choice'); // 又轮到乙的准备阶段（观星）
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    expect(b.kongcheng).toHaveLength(0);
    // 暂存的两张先入账，然后才照常摸这回合的两张（摸到哪两张取决于重洗，只断言暂存牌到手）
    expect(b.hand.map((c) => c.id)).toEqual(expect.arrayContaining(['a1', 'a2']));
  });

  it('国战空城：只拦「交给」——【五谷丰登】拿牌照常进手牌（经典破空城解法）', () => {
    const state = gzGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'liubei',
        faction: 'shu',
        hand: [mk('w1', 'wugu', 'heart', 7)],
      },
      { seatId: B, name: '乙', heroId: 'zhugeliang', faction: 'shu', hand: [] },
    ]);
    const b = at(state, B);
    setDeck(state, ['d1', 'd2']);
    ok(act(state, A, { type: 'playCard', cardId: 'w1', targetIds: [] }));
    passWuxie(state);
    // 甲先拿一张，接着乙拿
    ok(act(state, A, { type: 'pickCards', cardIds: ['d2'] }));
    expect(state.pending?.kind).toBe('pickCards');
    ok(act(state, B, { type: 'pickCards', cardIds: ['d1'] }));
    // 五谷是「获得」不是「交给」→ 照常进手牌（空城就是这么被破掉的）
    expect(b.kongcheng).toHaveLength(0);
    expect(b.hand.map((c) => c.id)).toEqual(['d1']);
  });

  it('国战空城：自己的回合里别人把牌交给他 → 照常进手牌（「回合外」这个前提）', () => {
    const state = gzGame([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhugeliang',
        faction: 'shu',
        hand: [mk('g1', 'guohe', 'spade', 3)],
      },
      { seatId: B, name: '乙', heroId: 'kongrong', faction: 'qun', hand: [sha('b1')] },
    ]);
    const a = at(state, A);
    // 甲（诸葛亮，0 手牌）用【过河拆桥】弃掉乙的一张牌 → 乙的【礼让】问「要不要交给别人」
    ok(act(state, A, { type: 'playCard', cardId: 'g1', targetIds: [B] }));
    passWuxie(state);
    pickZoneCard(state, A, 'hand:0');
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, B, { type: 'chooseOption', optionId: A }));
    // 这是**诸葛亮自己的回合**：交给他的牌照常进手牌（不进武将牌暂存）
    expect(a.kongcheng).toHaveLength(0);
    expect(a.hand.map((c) => c.id)).toEqual(['b1']);
  });
});
