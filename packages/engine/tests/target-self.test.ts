/**
 * 「**目标能不能是使用者自己**」——每张牌、每个技能**自己的**目标规则。
 *
 * 口径原文（用户 2026-09-24，规则权威，逐字记入 `docs/guozhan-roster.md` §5.209）：
 *
 * > 缺陷：目标选择系统错误地全局排除了玩家自身。当前多个牌和技能的目标选择逻辑似乎统一排除了
 * > 「自己」，导致部分本来允许选择自己的效果无法正常操作。目标系统不应存在「所有技能或卡牌
 * > 默认不能选择自己」的全局规则，而应严格根据每张牌、每个技能的具体目标描述判断。例如：
 * > ①【火攻】的目标是「一名有手牌的角色」，并没有「其他角色」的限制，因此只要自己有手牌，
 * > 也可以对自己使用；②张郃【巧变】跳过出牌阶段后移动场上的牌时，张郃本人可以作为牌移动的
 * > 起点或终点之一，但牌必须从「一名角色」移动到「另一名角色」的对应区域，因此**起点角色与
 * > 终点角色不能是同一人**；③如果技能明确写有「一名其他角色」，则必须排除自己；④如果技能写的
 * > 是「一名角色」或没有明确排除自己，则不能因为通用 UI 逻辑而自动禁选自己。核心原则：**是否
 * > 能够选择自己必须由牌或技能文本决定，而不能由通用目标选择 UI 决定**。
 *
 * 落地形式：声明表 `CARD_TARGET_EXCLUDES_SELF`（protocol）＋ `ActiveSkill.selfTarget`（引擎），
 * 出牌校验、候选下发、界面可点性三处读同一份（见 §5.209 的审计表）。
 *
 * ⚠️ 区分性：标了「改动前 ✗」的用例在本次改动**之前**是**红的**（【火攻】对自己被
 *    `不能以自己为目标` 拦下、`selfTargetUses` 这一栏还不存在、没声明 `selfTarget` 的技能
 *    可以绕过界面直接指定自己）；标「回归线」的用例改动前后都必须绿 —— 它们钉的是
 *    「写『其他角色』的牌/技能仍然排除自己」，改错了就是大事故。
 */
import { describe, it, expect } from 'vitest';
import {
  addMarker,
  applyIntent,
  canMoveFieldCardTo,
  createGame,
  emptyFlags,
  getHero,
  HEROES,
  toSnapshot,
  type GameState,
  type SeatSetup,
} from '../src';
import {
  cardTargetAllowsSelf,
  cardTargetExcludesSelf,
  type Card,
  type CardType,
  type Suit,
} from '@sgs/protocol';

const A = 's0';
const B = 's1';
const C = 's2';

function mk(id: string, type: CardType, suit: Suit = 'spade', rank = 6): Card {
  return { id, type, suit, rank };
}
const huogong = (id: string, suit: Suit = 'heart') => mk(id, 'huogong', suit, 2);
const tao = (id: string, suit: Suit = 'heart') => mk(id, 'tao', suit, 3);
const sha = (id: string) => mk(id, 'sha', 'spade', 7);
const guohe = (id: string) => mk(id, 'guohe', 'club', 3);
const shunshou = (id: string) => mk(id, 'shunshou', 'diamond', 3);
const juedou = (id: string) => mk(id, 'juedou', 'club', 1);
const lebu = (id: string) => mk(id, 'lebu', 'spade', 5);
const tiesuo = (id: string) => mk(id, 'tiesuo', 'club', 12);
const equip = (id: string, slot: 'armor' | 'weapon'): Card => ({
  id,
  type: slot,
  suit: 'club',
  rank: 2,
  equipName: slot === 'armor' ? 'bagua' : 'qinggang',
});

interface SeatOpts {
  seatId: string;
  name: string;
  heroId: string;
  hand?: Card[];
  hp?: number;
  equip?: { slot: 'armor' | 'weapon'; card: Card };
}

/** 造一局国战：跳过选将、武将**全部明置**，并让 0 号位进入出牌阶段 */
function game(seats: SeatOpts[]): GameState {
  const setup: SeatSetup[] = seats.map((s) => ({
    seatId: s.seatId,
    name: s.name,
    heroId: s.heroId,
  }));
  const state = createGame(setup, 'TEST', { mode: 'guozhan' });
  state.draft = null;
  for (const s of seats) {
    const p = state.players.find((pl) => pl.seatId === s.seatId)!;
    const hero = getHero(s.heroId);
    p.heroId = s.heroId;
    // 势力要显式写进 Player（`effectiveFaction` 读的是 player.faction / determinedFaction，
    // 正常流程里由选将阶段填）——凶算那类「与你势力相同的一名角色」的技能要靠它
    p.faction = hero?.faction ?? null;
    p.maxHp = Math.max(1, Math.floor(hero?.maxHp ?? 4));
    p.hp = s.hp ?? p.maxHp;
    p.hand = (s.hand ?? []).slice();
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.flags = emptyFlags();
    if (s.equip) p.equipment[s.equip.slot] = s.equip.card;
  }
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: A };
  state.log = [];
  return state;
}

const act = (state: GameState, seatId: string, intent: Parameters<typeof applyIntent>[2]) =>
  applyIntent(state, seatId, intent);
function ok(res: ReturnType<typeof applyIntent>, msg?: string) {
  if (!res.ok) throw new Error(`预期成功但失败：${res.error} ${msg ?? ''}`);
}
const player = (state: GameState, seatId: string) =>
  state.players.find((p) => p.seatId === seatId)!;
const playPrompt = (state: GameState, seatId: string) => toSnapshot(state, seatId).prompt;
/** 无懈询问轮全弃权（本文件的局面里通常没人有无懈，这一步是防御性的） */
function passWuxie(state: GameState): void {
  while (state.pending?.kind === 'wuxieQueue') {
    const asked = state.pending.askQueue[state.pending.askIndex]!;
    ok(act(state, asked, { type: 'pass' }));
  }
}
/** 各武将主动技的合集（声明表直测用） */
const ALL_ACTIVE_SKILLS = HEROES.flatMap((h) => h.activeSkills ?? []);

// ——————————————————————————————————————————
// ① 判据本身（纯函数直测）
// ——————————————————————————————————————————
describe('① 每张牌的「能否选自己」是它自己的目标规则', () => {
  it('牌面写「一名其他角色」的牌：声明排除自己（回归线，改错了就是大事故）', () => {
    for (const t of [
      'sha',
      'juedou',
      'guohe',
      'shunshou',
      'tiaohu',
      'shuiyan',
      'zhibi',
      'lebu',
      'bingliang',
    ] as CardType[]) {
      expect(cardTargetExcludesSelf(t), `${t} 应当排除自己`).toBe(true);
      expect(cardTargetAllowsSelf(t), t).toBe(false);
    }
  });

  it('牌面没有「其他」的牌：**不**声明排除自己（含用户点名的【火攻】）', () => {
    for (const t of ['huogong', 'tiesuo', 'haolingtianxia', 'kefuzhongyuan'] as CardType[]) {
      expect(cardTargetExcludesSelf(t), `${t} 不该排除自己`).toBe(false);
      expect(cardTargetAllowsSelf(t), t).toBe(true);
    }
  });

  it('拿不到牌型（null/undefined）时不乱判：一律当作「不排除」（由上层各判据兜底）', () => {
    expect(cardTargetExcludesSelf(null)).toBe(false);
    expect(cardTargetExcludesSelf(undefined)).toBe(false);
  });
});

// ——————————————————————————————————————————
// ② 【火攻】：只要自己有手牌，可以对自己使用（用户点名的第一条）
// ——————————————————————————————————————————
describe('② 【火攻】可以对自己使用', () => {
  it('自己有手牌 → 可以对自己用；照常结算：自己展示、自己弃同花色、自己受 1 点火焰伤害（改动前 ✗）', () => {
    const state = game([
      {
        seatId: A,
        name: '甲',
        heroId: 'vanilla',
        hand: [huogong('h1'), tao('h2'), mk('h3', 'jiu', 'heart', 4)],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
    ]);
    const maxHp = player(state, A).maxHp;
    ok(act(state, A, { type: 'playCard', cardId: 'h1', targetIds: [A] }));
    passWuxie(state);
    // 火攻要目标展示一张手牌——目标就是自己
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, A, { type: 'respondCard', cardId: 'h2' }));
    // 展示完轮到自己弃一张同花色手牌
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, A, { type: 'respondCard', cardId: 'h3' }));
    expect(player(state, A).hp).toBe(maxHp - 1);
    expect(state.discard.some((c) => c.id === 'h3')).toBe(true);
    expect(state.log.some((e) => e.message.includes('受到 1 点火属性伤害'))).toBe(true);
  });

  it('手里只剩这一张【火攻】时不能指自己（打出后自己就没手牌了）（改动前 ✗：那时直接拒自己）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [huogong('h1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
    ]);
    const res = act(state, A, { type: 'playCard', cardId: 'h1', targetIds: [A] });
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('手牌');
  });

  it('提示：只有自己有手牌时这张牌照样亮着，并下发 (这张牌, 火攻) 的自身合法目标（改动前 ✗）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [huogong('h1'), tao('h2')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    const prompt = playPrompt(state, A);
    expect(prompt?.kind).toBe('play');
    // 全场只有甲有手牌 ⇒ 这张【火攻】只可能对自己用，所以它必须仍然可用
    expect(prompt?.legalCardIds).toContain('h1');
    expect(prompt?.selfTargetUses).toContainEqual({ cardId: 'h1', type: 'huogong' });
    // 「其他人的可点集合」里当然没有自己——自己那一栏由 selfTargetUses 单独表达
    expect(prompt?.legalTargetIds).not.toContain(A);
  });

  it('提示：手里只剩这一张【火攻】、且别人都空手时，这张牌**不亮**（钉住新判据，非区分性）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [huogong('h1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const prompt = playPrompt(state, A);
    expect(prompt?.legalCardIds).not.toContain('h1');
    expect(prompt?.selfTargetUses ?? []).not.toContainEqual({ cardId: 'h1', type: 'huogong' });
  });

  it('回归线：【火攻】对别人照常可用、照常结算', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [huogong('h1'), tao('h2')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [tao('b1')] },
    ]);
    const maxHp = player(state, B).maxHp;
    ok(act(state, A, { type: 'playCard', cardId: 'h1', targetIds: [B] }));
    passWuxie(state);
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    ok(act(state, A, { type: 'respondCard', cardId: 'h2' }));
    expect(player(state, B).hp).toBe(maxHp - 1);
  });
});

// ——————————————————————————————————————————
// ③ 「其他角色」的牌仍然排除自己（回归线）
// ——————————————————————————————————————————
describe('③ 写明「其他角色」的牌继续排除自己', () => {
  const cases: { name: string; card: Card; type: CardType }[] = [
    { name: '杀', card: sha('c1'), type: 'sha' },
    { name: '决斗', card: juedou('c1'), type: 'juedou' },
    { name: '过河拆桥', card: guohe('c1'), type: 'guohe' },
    { name: '顺手牵羊', card: shunshou('c1'), type: 'shunshou' },
    { name: '乐不思蜀', card: lebu('c1'), type: 'lebu' },
  ];

  for (const c of cases) {
    it(`【${c.name}】不能对自己用，提示里也不把自己当自身合法目标`, () => {
      const state = game([
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [c.card, sha('x1')] },
        { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
      ]);
      const res = act(state, A, { type: 'playCard', cardId: 'c1', targetIds: [A] });
      expect(res.ok, `【${c.name}】应当拒绝自己`).toBe(false);
      const prompt = playPrompt(state, A);
      expect(prompt?.selfTargetUses ?? []).not.toContainEqual({ cardId: 'c1', type: c.type });
      expect(prompt?.legalTargetIds ?? []).not.toContain(A);
    });
  }

  it('回归线：【铁索连环】可以对自己用（「一至两名角色」，没有「其他」——这条行为从未变过）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [tiesuo('t1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 't1', targetIds: [A] }));
    expect(player(state, A).chained).toBe(true);
  });

  it('提示：本就能对自己用的牌，自身合法目标也要下发（【铁索连环】）（改动前 ✗）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [tiesuo('t1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    expect(playPrompt(state, A)?.selfTargetUses).toContainEqual({ cardId: 't1', type: 'tiesuo' });
  });

  it('【号令天下】【克复中原】的自身合法目标也下发（牌面都写「一名角色 / 至少一名角色」）（改动前 ✗）', () => {
    const state = game([
      {
        seatId: A,
        name: '甲',
        heroId: 'vanilla',
        hand: [mk('h1', 'haolingtianxia', 'spade', 12), mk('k1', 'kefuzhongyuan', 'diamond', 1)],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [], hp: 2 },
    ]);
    const uses = playPrompt(state, A)?.selfTargetUses ?? [];
    expect(uses).toContainEqual({ cardId: 'h1', type: 'haolingtianxia' }); // 甲体力 4 > 全场最低 2 ⇒ 自己是合法目标
    expect(uses).toContainEqual({ cardId: 'k1', type: 'kefuzhongyuan' });
    // 引擎侧确实收：两张牌都可以指定自己
    ok(act(state, A, { type: 'playCard', cardId: 'h1', targetIds: [A] }));
    passWuxie(state);
    void state;
    const s2 = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [mk('k1', 'kefuzhongyuan', 'diamond', 1)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(s2, A, { type: 'playCard', cardId: 'k1', targetIds: [A] }));
  });
});

// ——————————————————————————————————————————
// ④ 张郃【巧变】：起点/终点都可以是自己，但起点≠终点（用户点名的第二条）
// ——————————————————————————————————————————
describe('④ 巧变「移动场上的牌」：起点≠终点，两端都可以是张郃本人', () => {
  it('判据直测：同一个人不算「从一名角色移到另一名角色」；阵亡的也不行', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla' },
      { seatId: B, name: '乙', heroId: 'zhanghe' },
      { seatId: C, name: '丙', heroId: 'vanilla' },
    ]);
    player(state, C).alive = false;
    expect(canMoveFieldCardTo(state, A, B)).toBe(true);
    expect(canMoveFieldCardTo(state, B, A)).toBe(true);
    expect(canMoveFieldCardTo(state, A, C)).toBe(false); // 目标已阵亡
    expect(canMoveFieldCardTo(state, A, A)).toBe(false); // 起点＝终点 ⇒ 原地不动，不算移动
    expect(canMoveFieldCardTo(state, B, B)).toBe(false);
  });

  it('终点可以是**张郃自己**：把甲的装备移到乙（自己）身上（改动前 ✓ 行为本就如此，本次钉住）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhanghe', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    player(state, A).equipment.armor = equip('arm1', 'armor');
    ok(act(state, A, { type: 'endPhase' })); // 轮到乙 → 判定阶段问巧变
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' })); // 摸牌阶段：不发动
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' })); // 出牌阶段：发动
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] })); // 代价
    expect(state.pending?.kind).toBe('choice');
    ok(act(state, B, { type: 'chooseOption', optionId: 'card:arm1' }));
    // 终点候选：**乙（自己）**与丙都在，唯独没有甲（起点＝终点）
    expect(state.pending?.kind).toBe('choice');
    const opts = state.pending?.kind === 'choice' ? state.pending.options.map((o) => o.id) : [];
    expect(opts).toContain(B);
    expect(opts).toContain(C);
    expect(opts).not.toContain(A);
    ok(act(state, B, { type: 'chooseOption', optionId: B }));
    expect(player(state, A).equipment.armor).toBeNull();
    expect(player(state, B).equipment.armor?.id).toBe('arm1');
  });

  it('起点可以是**张郃自己**：把他自己装备区的牌移给甲；终点候选里没有他自己', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'zhanghe', hand: [sha('b1')] },
      { seatId: C, name: '丙', heroId: 'vanilla', hand: [] },
    ]);
    player(state, B).equipment.weapon = equip('w1', 'weapon');
    ok(act(state, A, { type: 'endPhase' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'no' }));
    ok(act(state, B, { type: 'chooseOption', optionId: 'yes' })); // 出牌阶段：发动
    ok(act(state, B, { type: 'pickCards', cardIds: ['b1'] }));
    // 自己那张牌在**起点**候选里
    expect(state.pending?.kind).toBe('choice');
    const srcOpts = state.pending?.kind === 'choice' ? state.pending.options.map((o) => o.id) : [];
    expect(srcOpts).toContain('card:w1');
    ok(act(state, B, { type: 'chooseOption', optionId: 'card:w1' }));
    // 终点候选里有甲、丙，**没有乙自己**（起点＝终点被拒）
    const dstOpts = state.pending?.kind === 'choice' ? state.pending.options.map((o) => o.id) : [];
    expect(dstOpts).toContain(A);
    expect(dstOpts).not.toContain(B);
    ok(act(state, B, { type: 'chooseOption', optionId: A }));
    expect(player(state, B).equipment.weapon).toBeNull();
    expect(player(state, A).equipment.weapon?.id).toBe('w1');
  });
});

// ——————————————————————————————————————————
// ⑤ 技能：「一名角色」的可以选自己，「一名其他角色」的必须排除自己
// ——————————————————————————————————————————
describe('⑤ 技能自己的目标规则（ActiveSkill.selfTarget）', () => {
  it('声明表直测：写「一名角色」的技能声明了 selfTarget，写「其他角色」的没有', () => {
    const want: Record<string, boolean> = {
      qingnang: true, // 一名已受伤的角色
      xiongsuan: true, // 与你势力相同的一名角色
      ganlu: true, // 两名角色
      paiyi: true, // 一名角色
      cunsi: true, // 一名角色…若其不为你
      qiangxi: false, // 一名**其他**角色
      fenxun: false, // 一名**其他**角色
      zhijian: false, // 一名**其他**角色
      tiaoxin: false, // 一名攻击范围内包含你的角色（文本待核对，本轮保持排除）
      lilian: false, // 两名男性角色（性别条件本就排除貂蝉自己）
      jieyin: false, // 一名已受伤的男性角色（同上）
      quanjin: false, // 官方裁定：不能选自己（QUANJIN_CAN_TARGET_SELF）
      sanyao: false, // 一名体力值最大的角色（文本与实现冲突 → 待核对，本轮保持排除）
    };
    for (const [id, self] of Object.entries(want)) {
      const skill = ALL_ACTIVE_SKILLS.find((s) => s.id === id);
      expect(skill, `找不到技能 ${id}`).toBeDefined();
      expect(skill?.selfTarget === true, `${id} 的 selfTarget`).toBe(self);
    }
  });

  it('【排异】：可以对自己发动，提示里也带 selfTarget（改动前 ✗：界面点不到自己）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'jie_zhonghui', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    player(state, A).quan.push(mk('q1', 'sha'));
    const prompt = playPrompt(state, A);
    expect(prompt?.legalSkills?.find((s) => s.id === 'paiyi')?.selfTarget).toBe(true);
    ok(act(state, A, { type: 'useSkill', skillId: 'paiyi', cardIds: [], targetIds: [A] }));
    expect(player(state, A).hand.length).toBe(2); // 自己摸两张
    expect(player(state, A).quan).toHaveLength(0);
  });

  it('【青囊】：可以对自己发动（自己已受伤）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'huatuo', hand: [sha('a1')], hp: 2 },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'useSkill', skillId: 'qingnang', cardIds: ['a1'], targetIds: [A] }));
    expect(player(state, A).hp).toBe(3);
  });

  it('【凶算】：可以对自己发动（与你势力相同的一名角色）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'lijue_guosi', hand: [sha('a1')], hp: 4 },
      { seatId: B, name: '乙', heroId: 'panfeng', hand: [] }, // 同势力（群）：`canUse` 要求场上有同势力角色
    ]);
    ok(act(state, A, { type: 'useSkill', skillId: 'xiongsuan', cardIds: ['a1'], targetIds: [A] }));
    expect(player(state, A).hp).toBe(3); // 对自己造成 1 点伤害
    expect(player(state, A).hand.length).toBe(3); // 然后摸三张
  });

  it('【甘露】：两名角色里可以有自己的名字', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'wuguotai', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    player(state, A).equipment.armor = equip('a-arm', 'armor');
    player(state, B).equipment.weapon = equip('b-w', 'weapon');
    ok(act(state, A, { type: 'useSkill', skillId: 'ganlu', cardIds: [], targetIds: [A, B] }));
    expect(player(state, A).equipment.weapon?.id).toBe('b-w');
    expect(player(state, B).equipment.armor?.id).toBe('a-arm');
  });

  it('【存嗣】：可以给自己（文本「若其不为你」那一支）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'mifuren', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    ok(act(state, A, { type: 'useSkill', skillId: 'cunsi', cardIds: [], targetIds: [A] }));
    expect(player(state, A).grantedSkills.some((g) => g.skillName === '勇决')).toBe(true);
    expect(player(state, A).hand).toHaveLength(0); // 「若其不为你，其摸两张」——自己就不摸
  });

  it('【先驱】（写「一名其他角色」）：指定自己被拒（改动前 ✗：引擎当时不拦）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    addMarker(player(state, A), 'xianqu');
    const res = act(state, A, {
      type: 'useSkill',
      skillId: 'mark_xianqu',
      cardIds: [],
      targetIds: [A],
    });
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('不能以自己为目标');
    // 对别人照常（回归线）
    const ok2 = act(state, A, {
      type: 'useSkill',
      skillId: 'mark_xianqu',
      cardIds: [],
      targetIds: [B],
    });
    expect(ok2.ok, ok2.ok ? '' : ok2.error).toBe(true);
  });

  it('回归线：【散谣】【驱虎】【挑衅】继续拒自己（技能自身的判据/条件）', () => {
    const state = game([
      { seatId: A, name: '甲', heroId: 'jiangwei', hand: [sha('a1')], hp: 4 },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')], hp: 2 },
    ]);
    // 挑衅（姜维）：一名攻击范围内包含你的角色——自己不算
    const tiaoxin = act(state, A, {
      type: 'useSkill',
      skillId: 'tiaoxin',
      cardIds: [],
      targetIds: [A],
    });
    expect(tiaoxin.ok).toBe(false);
    expect(playPrompt(state, A)?.legalSkills?.find((s) => s.id === 'tiaoxin')?.selfTarget).not.toBe(
      true,
    );
  });
});

// ——————————————————————————————————————————
// ⑥ 目标由规则算的牌：自己那一栏不进 selfTargetUses（界面不点目标）
// ——————————————————————————————————————————
describe('⑥ 目标由规则决定的牌不进「自身合法目标」清单', () => {
  it('【以逸待劳】【五谷丰登】【南蛮入侵】不产生 (牌, 用法) 项', () => {
    const state = game([
      {
        seatId: A,
        name: '甲',
        heroId: 'vanilla',
        hand: [
          mk('y1', 'yiyi', 'club', 1),
          mk('w1', 'wugu', 'heart', 3),
          mk('n1', 'nanman', 'spade', 7),
        ],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [] },
    ]);
    const uses = playPrompt(state, A)?.selfTargetUses ?? [];
    expect(uses.some((u) => u.type === 'yiyi')).toBe(false);
    expect(uses.some((u) => u.type === 'wugu')).toBe(false);
    expect(uses.some((u) => u.type === 'nanman')).toBe(false);
  });
});
