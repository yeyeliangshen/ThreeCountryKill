/**
 * **测试场景编辑器**（开发工具，用户 2026-09-23 拍板加；规格见 docs §5.206）。
 *
 * 它不是游戏规则，是「人工真机验收」用的现场构造器：给谁发哪张牌、放进哪个区域，
 * 免得为了截一张寒冰剑 / 度势② / 分区面板的图而反复刷牌。
 *
 * 用户给的三条边界，本文件逐条钉：
 *   ① **只有开发模式的对局才接受**（`createGame(..., { testScenario: true })`）；
 *      正式对局发这个意图 → 直接拒（不是「悄悄生效」）。
 *   ② **不绕过正常规则流程**：牌只从它当前所在的那个区域取走（同一张牌不会出现在两个区域），
 *      装备走 `playEquip`（顶掉旧装备、旧装备进弃牌堆），判定区照 `playDelayedTrick` 的校验
 *      （不能有同名延时锦囊）——所以布置出来的局面与真打出来的局面同构。
 *   ③ 每次布置都在牌局日志里留 `TEST_DEAL_OVERRIDE` 标记，且区域规则是硬的：
 *      装备牌只能去手牌/装备区，延时锦囊只能去手牌/判定区，别的牌只能去手牌。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, testDealZonesFor, testScenarioCatalog } from '../src';
import type { Card, GameState } from '@sgs/protocol';
import { cardLocations, allCardIds } from './fuzzHarness';

const A = 's0';
const B = 's1';
const C = 's2';

/** 国战局：甲（关羽）乙（许褚）丙（吕布），跳过选将、手牌清空；`dev` 打开测试场景 */
function gz(dev = true): GameState {
  const state = createGame(
    [
      { seatId: A, name: '甲', heroId: 'guanyu' },
      { seatId: B, name: '乙', heroId: 'xuchu' },
      { seatId: C, name: '丙', heroId: 'lvbu' },
    ],
    'TEST',
    { mode: 'guozhan', config: undefined, testScenario: dev },
  );
  state.draft = null;
  const HERO: Record<string, string> = { [A]: 'guanyu', [B]: 'xuchu', [C]: 'lvbu' };
  for (const p of state.players) {
    p.heroId = HERO[p.seatId]!;
    p.deputyHeroId = null;
    p.heroRevealed = true;
    p.maxHp = 4;
    p.hp = 4;
    p.hand = [];
  }
  state.log = [];
  return state;
}

/** 从目录里按显示名找一张牌（找不到就是目录与牌堆口径不一致，测试要红） */
function pick(name: string): { id: string; zone: 'hand' | 'equip' | 'judge' } {
  const hit = testScenarioCatalog({ mode: 'guozhan' }).find((c) => c.name === name);
  if (!hit) throw new Error(`目录里没有【${name}】`);
  return { id: hit.id, zone: hit.zone };
}

const deal = (state: GameState, seatId: string, cardId: string, zone: 'hand' | 'equip' | 'judge') =>
  applyIntent(state, seatId, { type: 'testScenario', deals: [{ seatId, cardId, zone }] });

const player = (state: GameState, seatId: string) =>
  state.players.find((p) => p.seatId === seatId)!;
const cardName = (c: Card) => (c.equipName ? c.equipName : c.type);

describe('测试场景：开关没开就不接受（正式对局的门槛）', () => {
  it('testScenario 关着时，布置意图被拒，且牌局一点没动', () => {
    const state = gz(false);
    const { id } = pick('寒冰剑');
    const before = JSON.stringify(state.players.map((p) => [p.hand, p.equipment, p.judgment]));
    const res = deal(state, A, id, 'hand');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/未开启/);
    expect(JSON.stringify(state.players.map((p) => [p.hand, p.equipment, p.judgment]))).toBe(
      before,
    );
    expect(state.log).toHaveLength(0);
  });
});

describe('测试场景：手牌 / 装备区 / 判定区', () => {
  it('发一张装备牌进手牌：牌从牌堆移到他手里，全场也只有这一张', () => {
    const state = gz();
    const jian = pick('寒冰剑');
    expect(deal(state, B, jian.id, 'hand').ok).toBe(true);
    const b = player(state, B);
    expect(b.hand.map((c) => c.id)).toEqual([jian.id]);
    // 「一张牌只能在一个区域」：全场各处只出现一次
    expect(cardLocations(state, jian.id)).toHaveLength(1);
    expect(state.log.map((e) => e.message).join('')).toMatch(/TEST_DEAL_OVERRIDE/);
  });

  it('装到装备区走正式装备路径：进 weapon 槽，日志里是「装备了」', () => {
    const state = gz();
    const jian = pick('寒冰剑');
    expect(deal(state, B, jian.id, 'equip').ok).toBe(true);
    const b = player(state, B);
    expect(b.equipment.weapon?.id).toBe(jian.id);
    expect(b.hand).toHaveLength(0); // 不在手里
    expect(cardLocations(state, jian.id)).toEqual([`${B}.equip.weapon`]);
  });

  it('顶掉旧武器时，旧的那张进弃牌堆（不是凭空消失）', () => {
    const state = gz();
    const guojia = pick('青釭剑'); // 任意一件非寒冰剑的武器
    const jian = pick('寒冰剑');
    expect(deal(state, B, guojia.id, 'equip').ok).toBe(true);
    expect(deal(state, B, jian.id, 'equip').ok).toBe(true);
    const b = player(state, B);
    expect(b.equipment.weapon?.id).toBe(jian.id);
    expect(state.discard.map((c) => c.id)).toContain(guojia.id);
    expect(cardLocations(state, guojia.id)).toHaveLength(1);
    expect(cardLocations(state, guojia.id)[0]).toMatch(/^discard\[/);
  });

  it('延时锦囊置入判定区（乐不思蜀 / 闪电都行）', () => {
    const state = gz();
    const lebu = pick('乐不思蜀');
    const shandian = pick('闪电');
    expect(deal(state, B, lebu.id, 'judge').ok).toBe(true);
    expect(deal(state, B, shandian.id, 'judge').ok).toBe(true);
    const b = player(state, B);
    expect(b.judgment.map((c) => c.type)).toEqual(['lebu', 'shandian']);
    expect(b.hand).toHaveLength(0);
  });

  it('判定区已有同名延时锦囊 → 拒（与正式使用时的校验同一条）', () => {
    const state = gz();
    const lebu = pick('乐不思蜀');
    expect(deal(state, B, lebu.id, 'judge').ok).toBe(true);
    // 直接去牌堆里找**另一张**同名实体牌（目录按显示名去重，只给一条）
    const lebu2 = state.deck.find((c) => c.type === 'lebu' && c.id !== lebu.id);
    if (!lebu2) throw new Error('牌堆里没有第二张【乐不思蜀】');
    const res = deal(state, B, lebu2.id, 'judge');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/判定区已有/);
    expect(player(state, B).judgment).toHaveLength(1);
  });

  it('把别人手里的牌挪给目标（牌只从它当前所在的区域取走）', () => {
    const state = gz();
    const tao = pick('桃');
    expect(deal(state, A, tao.id, 'hand').ok).toBe(true);
    expect(deal(state, B, tao.id, 'hand').ok).toBe(true);
    expect(player(state, A).hand).toHaveLength(0);
    expect(player(state, B).hand.map((c) => c.id)).toEqual([tao.id]);
    expect(cardLocations(state, tao.id)).toHaveLength(1);
  });
});

describe('测试场景：区域规则是硬的（用户给的约束）', () => {
  it('寒冰剑（装备）只能去手牌或装备区，塞判定区 → 拒', () => {
    const state = gz();
    const jian = pick('寒冰剑');
    const res = deal(state, B, jian.id, 'judge');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/不能放进判定区/);
    expect(player(state, B).judgment).toHaveLength(0);
  });

  it('乐不思蜀 / 闪电（延时锦囊）可以去手牌，也可以去判定区', () => {
    const state = gz();
    const lebu = pick('乐不思蜀');
    const shandian = pick('闪电');
    expect(deal(state, B, lebu.id, 'hand').ok).toBe(true);
    expect(deal(state, B, shandian.id, 'judge').ok).toBe(true);
    expect(player(state, B).hand.map((c) => c.id)).toEqual([lebu.id]);
    expect(player(state, B).judgment.map((c) => c.id)).toEqual([shandian.id]);
  });

  it('普通牌只能去手牌：闪 → 装备区 / 判定区都拒', () => {
    const state = gz();
    const shan = pick('闪');
    expect(deal(state, B, shan.id, 'equip').ok).toBe(false);
    expect(deal(state, B, shan.id, 'judge').ok).toBe(false);
    expect(deal(state, B, shan.id, 'hand').ok).toBe(true);
  });

  it('testDealZonesFor 就是界面按钮的可用性判据（同一份规则）', () => {
    expect(testDealZonesFor({ type: 'weapon' })).toEqual(['hand', 'equip']);
    expect(testDealZonesFor({ type: 'armor' })).toEqual(['hand', 'equip']);
    expect(testDealZonesFor({ type: 'lebu' })).toEqual(['hand', 'judge']);
    expect(testDealZonesFor({ type: 'shandian' })).toEqual(['hand', 'judge']);
    expect(testDealZonesFor({ type: 'sha' })).toEqual(['hand']);
    expect(testDealZonesFor({ type: 'huogong' })).toEqual(['hand']);
  });
});

describe('测试场景：「节」与其它边界', () => {
  it('发 3 张「节」给陆逊（度势② 的前置），第 4 张被拒', () => {
    const state = gz();
    expect(applyIntent(state, A, { type: 'testScenario', jie: [{ seatId: A, count: 3 }] }).ok).toBe(
      true,
    );
    expect(player(state, A).jie).toHaveLength(3);
    const res = applyIntent(state, A, { type: 'testScenario', jie: [{ seatId: A, count: 1 }] });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/最多 3 张/);
  });

  it('张数不合法（0 / 负数）→ 拒', () => {
    const state = gz();
    expect(applyIntent(state, A, { type: 'testScenario', jie: [{ seatId: A, count: 0 }] }).ok).toBe(
      false,
    );
    expect(
      applyIntent(state, A, { type: 'testScenario', jie: [{ seatId: A, count: -2 }] }).ok,
    ).toBe(false);
  });

  it('空布置 → 拒（避免误点）', () => {
    const state = gz();
    expect(applyIntent(state, A, { type: 'testScenario', deals: [] }).ok).toBe(false);
  });

  it('不存在的牌 id → 拒，且不会留下半成品', () => {
    const state = gz();
    const before = allCardIds(state).length;
    const res = applyIntent(state, A, {
      type: 'testScenario',
      deals: [{ seatId: A, cardId: 'NOT-A-CARD', zone: 'hand' }],
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/牌不在场上/);
    expect(allCardIds(state)).toHaveLength(before); // 一张牌都没少
  });

  it('一次布置里同一张牌出现两次 → 拒（避免「取走一次、放两次」）', () => {
    const state = gz();
    const tao = pick('桃');
    const res = applyIntent(state, A, {
      type: 'testScenario',
      deals: [
        { seatId: A, cardId: tao.id, zone: 'hand' },
        { seatId: B, cardId: tao.id, zone: 'hand' },
      ],
    });
    expect(res.ok).toBe(false);
    expect(player(state, A).hand).toHaveLength(0);
    expect(player(state, B).hand).toHaveLength(0);
  });
});

describe('测试场景：目录与正式牌堆是同一份口径', () => {
  it('目录里的 id 在真牌局里都能找到（抽查各类各一张都能发出去）', () => {
    const state = gz();
    const catalog = testScenarioCatalog({ mode: 'guozhan' });
    const samples = ['寒冰剑', '火杀', '乐不思蜀', '闪电', '桃', '过河拆桥', '火攻', '火烧连营'];
    for (const name of samples) {
      const hit = catalog.find((c) => c.name === name);
      expect(hit, `目录缺少【${name}】`).toBeTruthy();
      const res = deal(state, C, hit!.id, 'hand');
      expect(res.ok, `发【${name}】失败：${res.ok === false ? res.error : ''}`).toBe(true);
    }
    expect(player(state, C).hand).toHaveLength(samples.length);
  });

  it('关掉某个扩展包后，目录里就没有那个包的牌（口径跟着房间配置走）', () => {
    const full = testScenarioCatalog({ mode: 'guozhan' }).length;
    const base = testScenarioCatalog({
      mode: 'guozhan',
      config: {
        schemaVersion: 1,
        extensions: {
          shibei: 'off',
          buchen: 'off',
          junlintianxia: 'off',
          zhen: 'off',
          shi: 'off',
          bian: 'off',
          quan: 'off',
        },
      },
    }).length;
    expect(base).toBeLessThan(full);
    expect(base).toBeGreaterThan(30); // 基础牌堆那几十张还在
  });

  it('目录按显示名去重（杀只列一条，带张数），且装备显示具体牌名', () => {
    const catalog = testScenarioCatalog({ mode: 'guozhan' });
    const names = catalog.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length); // 没有重名条目
    const sha = catalog.find((c) => c.name === '杀');
    expect(sha?.copies).toBeGreaterThan(1);
    expect(catalog.some((c) => c.name === '寒冰剑')).toBe(true);
    expect(catalog.some((c) => c.name === '武器')).toBe(false); // 不能只显示槽位名
    void cardName;
  });
});
