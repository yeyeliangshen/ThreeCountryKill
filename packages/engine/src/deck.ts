import type { Card, CardType, GameMode, Suit } from '@sgs/protocol';
import type { GameState } from './model';

/**
 * 构建牌堆。**国战与其它模式的牌堆不一样**。
 *
 * 国战牌堆（官方 108 张）里只剩【无懈可击·国】2 张没收录——它要「抵消对某一**势力**
 * 全部角色的效果」，是无懈可击目标模型上的一个新维度，还没做。
 * 除此之外国战独有的【铁索连环】【知己知彼】【以逸待劳】【远交近攻】都已实现。
 * 国战独有的装备（麒麟弓/吴六剑/三尖两刃刀/白银狮子/寒冰剑）也都在堆里，
 * 但**特效未做**，悬停提示里会如实标注（同军争那几件）。
 *
 * ⚠️ 两张堆的**花色点数都是近似值**：只保证「每种牌各几张」与官方一致，
 *    具体哪张牌落在哪个花色点数上可能与实体牌不同，个别位置还会与别的牌重复
 *    （引擎不依赖花色点数的唯一性，判定/火攻只读牌自己的花色点数）。
 */
export function buildDeck(mode: GameMode = 'melee'): Card[] {
  return mode === 'guozhan' ? buildGuozhanDeck() : buildJunzhengDeck();
}

/**
 * 国战牌堆（官方 108 张，本版本 106 张）。
 * 基本牌比例、装备种类与军争不同（黑杀更多、属性杀更多、没有方天画戟/古锭刀/青龙偃月刀）。
 */
function buildGuozhanDeck(): Card[] {
  const cards: Card[] = [];
  let n = 0;
  const mk = (type: CardType, suit: Suit, rank: number, extra?: Partial<Card>): Card => ({
    id: `g${n++}`,
    type,
    suit,
    rank,
    ...extra,
  });

  // —— 杀 ×29（普通 21：黑 17 / 红 4；雷杀 5；火杀 3）——
  for (const r of [4, 6, 7, 8, 9, 10, 13]) cards.push(mk('sha', 'spade', r));
  for (const r of [4, 5, 6, 7, 8, 9, 10, 11, 13]) cards.push(mk('sha', 'club', r));
  for (const r of [10, 11]) cards.push(mk('sha', 'heart', r));
  for (const r of [6, 8, 9]) cards.push(mk('sha', 'diamond', r));
  // 火杀 3
  cards.push(mk('sha', 'diamond', 8, { attribute: 'fire' }));
  cards.push(mk('sha', 'diamond', 9, { attribute: 'fire' }));
  cards.push(mk('sha', 'heart', 12, { attribute: 'fire' }));
  // 雷杀 5
  cards.push(mk('sha', 'club', 5, { attribute: 'thunder' }));
  cards.push(mk('sha', 'spade', 9, { attribute: 'thunder' }));
  cards.push(mk('sha', 'spade', 10, { attribute: 'thunder' }));
  cards.push(mk('sha', 'heart', 11, { attribute: 'thunder' }));
  cards.push(mk('sha', 'diamond', 10, { attribute: 'thunder' }));

  // —— 闪 ×14（红桃 3 / 方块 11）——
  for (const r of [4, 5, 6]) cards.push(mk('shan', 'heart', r));
  for (const r of [2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13]) cards.push(mk('shan', 'diamond', r));

  // —— 桃 ×8（红桃 7 / 方块 1）——
  for (const r of [1, 2, 3, 4, 5, 6, 7]) cards.push(mk('tao', 'heart', r));
  cards.push(mk('tao', 'diamond', 2));

  // —— 酒 ×3 ——
  cards.push(mk('jiu', 'spade', 6));
  cards.push(mk('jiu', 'club', 9));
  cards.push(mk('jiu', 'diamond', 3));

  // —— 装备 ×20 ——
  // 武器 10（没有方天画戟/古锭刀/青龙偃月刀；多了寒冰剑/麒麟弓/吴六剑/三尖两刃刀）
  cards.push(mk('weapon', 'club', 1, { equipName: 'zhuge', range: 1 })); // 诸葛连弩
  cards.push(mk('weapon', 'spade', 6, { equipName: 'qinggang', range: 2 })); // 青釭剑
  cards.push(mk('weapon', 'spade', 2, { equipName: 'cixiong', range: 2 })); // 雌雄双股剑
  cards.push(mk('weapon', 'club', 12, { equipName: 'zhangba', range: 3 })); // 丈八蛇矛
  cards.push(mk('weapon', 'club', 5, { equipName: 'guanshi', range: 4 })); // 贯石斧
  cards.push(mk('weapon', 'diamond', 5, { equipName: 'zhuque', range: 4 })); // 朱雀羽扇
  cards.push(mk('weapon', 'spade', 5, { equipName: 'hanbing', range: 2 })); // 寒冰剑
  cards.push(mk('weapon', 'diamond', 12, { equipName: 'qilin', range: 5 })); // 麒麟弓
  cards.push(mk('weapon', 'spade', 12, { equipName: 'wuliu', range: 2 })); // 吴六剑
  cards.push(mk('weapon', 'club', 10, { equipName: 'sanjian', range: 3 })); // 三尖两刃刀
  // 防具 4
  cards.push(mk('armor', 'club', 2, { equipName: 'bagua' })); // 八卦阵
  cards.push(mk('armor', 'club', 2, { equipName: 'renwang' })); // 仁王盾
  cards.push(mk('armor', 'spade', 2, { equipName: 'tengjia' })); // 藤甲
  cards.push(mk('armor', 'club', 6, { equipName: 'bailong' })); // 白银狮子
  // 坐骑 6
  cards.push(mk('plusMount', 'heart', 5, { equipName: 'dilu' }));
  cards.push(mk('plusMount', 'diamond', 13, { equipName: 'jueying' }));
  cards.push(mk('plusMount', 'heart', 13, { equipName: 'zhuafei' }));
  cards.push(mk('minusMount', 'spade', 5, { equipName: 'chitu' }));
  cards.push(mk('minusMount', 'diamond', 5, { equipName: 'zizong' }));
  cards.push(mk('minusMount', 'spade', 13, { equipName: 'dawanma' }));

  // —— 即时锦囊 ——
  cards.push(mk('juedou', 'spade', 1));
  cards.push(mk('juedou', 'club', 1));
  cards.push(mk('nanman', 'spade', 7));
  cards.push(mk('nanman', 'club', 7));
  cards.push(mk('wanjian', 'heart', 1));
  cards.push(mk('jiedao', 'club', 12));
  cards.push(mk('guohe', 'spade', 3));
  cards.push(mk('guohe', 'spade', 4));
  cards.push(mk('guohe', 'club', 3));
  cards.push(mk('shunshou', 'spade', 3));
  cards.push(mk('shunshou', 'spade', 4));
  cards.push(mk('shunshou', 'diamond', 3));
  cards.push(mk('wuzhong', 'heart', 7));
  cards.push(mk('wuzhong', 'heart', 8));
  cards.push(mk('wuxie', 'spade', 11));
  cards.push(mk('huogong', 'heart', 2));
  cards.push(mk('huogong', 'diamond', 2));
  cards.push(mk('taoyuan', 'heart', 3));
  cards.push(mk('tiesuo', 'spade', 11));
  cards.push(mk('tiesuo', 'spade', 12));
  cards.push(mk('tiesuo', 'club', 10));
  cards.push(mk('zhibi', 'spade', 3));
  cards.push(mk('zhibi', 'club', 3));
  cards.push(mk('yuanjiao', 'heart', 9));
  cards.push(mk('yiyi', 'heart', 4));
  cards.push(mk('yiyi', 'club', 7));
  cards.push(mk('wugu', 'heart', 7));

  // —— 延时锦囊 ——
  cards.push(mk('lebu', 'spade', 6));
  cards.push(mk('lebu', 'heart', 6));
  cards.push(mk('shandian', 'spade', 1));
  cards.push(mk('bingliang', 'spade', 10));
  cards.push(mk('bingliang', 'club', 4));

  return cards;
}

/** 军争/混战/2v2 共用的牌堆（参照标准军争堆，约 110 张） */
function buildJunzhengDeck(): Card[] {
  const cards: Card[] = [];
  let n = 0;
  const mk = (type: CardType, suit: Suit, rank: number, extra?: Partial<Card>): Card => ({
    id: `c${n++}`,
    type,
    suit,
    rank,
    ...extra,
  });

  // —— 杀 ×31 ——
  // 普通杀 23
  for (const r of [7, 8, 9, 10, 11]) cards.push(mk('sha', 'spade', r));
  for (const r of [5, 6, 7, 8, 9, 10, 11]) cards.push(mk('sha', 'club', r));
  for (const r of [7, 8, 9, 10, 11]) cards.push(mk('sha', 'heart', r));
  for (const r of [6, 7, 8, 9, 10, 11]) cards.push(mk('sha', 'diamond', r));
  // 火杀 4（红）
  cards.push(mk('sha', 'heart', 12, { attribute: 'fire' }));
  cards.push(mk('sha', 'heart', 13, { attribute: 'fire' }));
  cards.push(mk('sha', 'diamond', 4, { attribute: 'fire' }));
  cards.push(mk('sha', 'diamond', 5, { attribute: 'fire' }));
  // 雷杀 4（黑）
  cards.push(mk('sha', 'spade', 4, { attribute: 'thunder' }));
  cards.push(mk('sha', 'spade', 5, { attribute: 'thunder' }));
  cards.push(mk('sha', 'spade', 6, { attribute: 'thunder' }));
  cards.push(mk('sha', 'club', 4, { attribute: 'thunder' }));

  // —— 闪 ×18（红）——
  for (const r of [2, 3, 4, 5, 6, 7, 8, 9, 10]) cards.push(mk('shan', 'heart', r));
  for (const r of [2, 3, 6, 7, 8, 9, 10, 11, 12]) cards.push(mk('shan', 'diamond', r));

  // —— 桃 ×8（红）——
  cards.push(mk('tao', 'heart', 1));
  cards.push(mk('tao', 'heart', 2));
  cards.push(mk('tao', 'heart', 3));
  cards.push(mk('tao', 'heart', 4));
  cards.push(mk('tao', 'heart', 5));
  cards.push(mk('tao', 'heart', 6));
  cards.push(mk('tao', 'diamond', 12));
  cards.push(mk('tao', 'diamond', 13));

  // —— 酒 ×5（黑）——
  cards.push(mk('jiu', 'spade', 3));
  cards.push(mk('jiu', 'spade', 9));
  cards.push(mk('jiu', 'club', 3));
  cards.push(mk('jiu', 'club', 6));
  cards.push(mk('jiu', 'club', 9));

  // —— 装备 ——
  // 武器
  cards.push(mk('weapon', 'club', 1, { equipName: 'zhuge', range: 1 })); // 诸葛连弩
  cards.push(mk('weapon', 'diamond', 1, { equipName: 'zhuge', range: 1 }));
  cards.push(mk('weapon', 'spade', 6, { equipName: 'qinggang', range: 2 })); // 青釭剑
  cards.push(mk('weapon', 'spade', 2, { equipName: 'cixiong', range: 2 })); // 雌雄双股剑
  cards.push(mk('weapon', 'spade', 5, { equipName: 'qinglong', range: 3 })); // 青龙偃月刀
  cards.push(mk('weapon', 'club', 12, { equipName: 'zhangba', range: 3 })); // 丈八蛇矛
  cards.push(mk('weapon', 'club', 5, { equipName: 'guanshi', range: 4 })); // 贯石斧
  cards.push(mk('weapon', 'diamond', 12, { equipName: 'fangtian', range: 4 })); // 方天画戟
  cards.push(mk('weapon', 'spade', 4, { equipName: 'qixing', range: 2 })); // 七星宝刀
  cards.push(mk('weapon', 'diamond', 5, { equipName: 'zhuque', range: 4 })); // 朱雀羽扇
  cards.push(mk('weapon', 'club', 2, { equipName: 'guding', range: 2 })); // 古锭刀
  // 防具
  cards.push(mk('armor', 'club', 2, { equipName: 'bagua' })); // 八卦阵
  cards.push(mk('armor', 'club', 2, { equipName: 'bagua' }));
  cards.push(mk('armor', 'club', 2, { equipName: 'renwang' })); // 仁王盾
  cards.push(mk('armor', 'spade', 2, { equipName: 'tengjia' })); // 藤甲
  // +1马（防御马）
  cards.push(mk('plusMount', 'heart', 5, { equipName: 'dilu' })); // 的卢
  cards.push(mk('plusMount', 'diamond', 13, { equipName: 'jueying' })); // 绝影
  cards.push(mk('plusMount', 'heart', 13, { equipName: 'zhuafei' })); // 爪黄飞电
  // −1马（进攻马）
  cards.push(mk('minusMount', 'spade', 5, { equipName: 'chitu' })); // 赤兔
  cards.push(mk('minusMount', 'diamond', 5, { equipName: 'zizong' })); // 紫骍
  cards.push(mk('minusMount', 'spade', 13, { equipName: 'dawanma' })); // 大宛马

  // —— 即时锦囊 ×30 ——
  cards.push(mk('juedou', 'spade', 1)); // 决斗
  cards.push(mk('juedou', 'club', 1));
  cards.push(mk('nanman', 'spade', 7)); // 南蛮入侵
  cards.push(mk('nanman', 'club', 7));
  cards.push(mk('wanjian', 'heart', 1)); // 万箭齐发
  cards.push(mk('wanjian', 'diamond', 1));
  cards.push(mk('jiedao', 'club', 12)); // 借刀杀人
  cards.push(mk('jiedao', 'club', 13));
  cards.push(mk('guohe', 'spade', 3)); // 过河拆桥
  cards.push(mk('guohe', 'spade', 4));
  cards.push(mk('guohe', 'spade', 11));
  cards.push(mk('shunshou', 'spade', 3)); // 顺手牵羊
  cards.push(mk('shunshou', 'spade', 4));
  cards.push(mk('wuzhong', 'heart', 8)); // 无中生有
  cards.push(mk('wuzhong', 'heart', 9));
  cards.push(mk('wuxie', 'spade', 11)); // 无懈可击
  cards.push(mk('wuxie', 'club', 12));
  cards.push(mk('wuxie', 'club', 13));
  cards.push(mk('huogong', 'heart', 2)); // 火攻
  cards.push(mk('huogong', 'diamond', 2));
  cards.push(mk('taoyuan', 'heart', 3)); // 桃园结义
  // 铁索连环 ×6（♠J♠Q / ♣10 ♣J ♣Q ♣K）
  cards.push(mk('tiesuo', 'spade', 11));
  cards.push(mk('tiesuo', 'spade', 12));
  cards.push(mk('tiesuo', 'club', 10));
  cards.push(mk('tiesuo', 'club', 11));
  cards.push(mk('tiesuo', 'club', 12));
  cards.push(mk('tiesuo', 'club', 13));
  // 五谷丰登 ×2
  cards.push(mk('wugu', 'heart', 4));
  cards.push(mk('wugu', 'diamond', 4));

  // —— 延时锦囊 ×7 ——
  cards.push(mk('lebu', 'spade', 6)); // 乐不思蜀
  cards.push(mk('lebu', 'club', 6));
  cards.push(mk('lebu', 'heart', 6));
  cards.push(mk('shandian', 'spade', 1)); // 闪电
  cards.push(mk('bingliang', 'spade', 10)); // 兵粮寸断
  cards.push(mk('bingliang', 'club', 4));
  cards.push(mk('bingliang', 'club', 10));

  return cards;
}

/** Fisher-Yates 洗牌，返回新数组 */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/** 简单可种子化 RNG（测试/重放用） */
export function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从牌堆顶抽一张；牌堆空时把弃牌堆洗回 */
export function drawOne(state: GameState): Card | null {
  if (state.deck.length === 0) {
    if (state.discard.length === 0) return null;
    state.deck = shuffle(state.discard);
    state.discard = [];
  }
  return state.deck.pop() ?? null;
}
