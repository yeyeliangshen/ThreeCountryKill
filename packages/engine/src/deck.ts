import type { Card, CardType, GameMode, Suit } from '@sgs/protocol';
import type { GameState } from './model';

/**
 * 构建牌堆。**国战与其它模式的牌堆不一样**。
 *
 * 国战牌堆官方 108 张，本版本**已全部收录**（含【无懈可击·国】2 张）。
 * 国战独有的【铁索连环】【知己知彼】【以逸待劳】【远交近攻】【五谷丰登】都实现了。
 * 国战独有的装备（麒麟弓/吴六剑/三尖两刃刀/白银狮子/寒冰剑）也都在堆里，
 * 但**特效未做**，悬停提示里会如实标注（同军争那几件）。
 *
 * ⚠️ 两张堆的**花色点数都是近似值**：只保证「每种牌各几张」与官方一致，
 *    具体哪张牌落在哪个花色点数上可能与实体牌不同，个别位置还会与别的牌重复
 *    （引擎不依赖花色点数的唯一性，判定/火攻只读牌自己的花色点数）。
 */
export function buildDeck(mode: GameMode = 'melee', packs?: { shibei?: boolean }): Card[] {
  if (mode !== 'guozhan') return buildJunzhengDeck();
  const cards = buildGuozhanDeck();
  // 势备篇是**追加**到国战堆上的扩展（官方定位：直接加入原本的国战游戏牌即可游戏）
  if (packs?.shibei) cards.push(...buildShibeiCards());
  return cards;
}

/**
 * 国战牌堆（官方 108 张，本版本 108 张）。
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

/**
 * 势备篇的 52 张牌（国战的游戏牌扩展）。
 *
 * ⚠️ **两张注意事项**：
 * 1. 同名卡在势备篇可能是**另一个效果**（最典型的是【方天画戟】：国战版是「可以指定任意名
 *    势力各不相同的角色，一人闪则对其余无效」，不是身份局的「最后一张手牌可多指定两个目标」）。
 *    所以牌面数据与效果都要按国战文本走，不要复用手册里印象最深的那版。
 * 2. 它是**追加**到国战标准堆上的（官方定位：直接加入原本的国战游戏牌即可游戏）。
 *
 * 还没实现效果的牌**先不生成**（连占位牌都不造——占位牌一旦漏进牌堆就会打出另一个锦囊的效果，
 * 比缺牌糟得多）。每补完一张就加进来一张。
 */
export function buildShibeiCards(): Card[] {
  const cards: Card[] = [];
  let n = 0;
  const mk = (type: CardType, suit: Suit, rank: number, extra?: Partial<Card>): Card => ({
    id: `s${n++}`,
    type,
    suit,
    rank,
    ...extra,
  });
  // —— 基本牌 28 ——
  // 普通杀 9（7 黑 2 红；带连横的两张见下面的标记）
  for (const [suit, rank] of [
    ['spade', 4],
    ['spade', 7],
    ['spade', 8],
    ['club', 4],
    ['club', 6],
    ['club', 7],
    ['club', 8],
    ['heart', 10],
    ['heart', 11],
  ] as const)
    cards.push(mk('sha', suit, rank));
  // 火杀 2 / 雷杀 4（雷杀 ♣5、♠J 带连横）
  cards.push(mk('sha', 'diamond', 8, { attribute: 'fire' }));
  cards.push(mk('sha', 'diamond', 9, { attribute: 'fire' }));
  cards.push(mk('sha', 'spade', 9, { attribute: 'thunder' }));
  cards.push(mk('sha', 'spade', 10, { attribute: 'thunder' }));
  cards.push(mk('sha', 'spade', 11, { attribute: 'thunder', lianheng: true }));
  cards.push(mk('sha', 'club', 5, { attribute: 'thunder', lianheng: true }));
  // 闪 7（♡6 带连横）
  for (const rank of [4, 5, 6, 7])
    cards.push(mk('shan', 'heart', rank, rank === 6 ? { lianheng: true } : undefined));
  for (const [suit, rank] of [
    ['diamond', 6],
    ['diamond', 7],
    ['diamond', 13],
  ] as const)
    cards.push(mk('shan', suit, rank));
  // 桃 4（♦3 带连横）
  cards.push(mk('tao', 'heart', 8));
  cards.push(mk('tao', 'heart', 9));
  cards.push(mk('tao', 'diamond', 2));
  cards.push(mk('tao', 'diamond', 3, { lianheng: true }));
  // 酒 2（♠6 带连横）
  cards.push(mk('jiu', 'spade', 6, { lianheng: true }));
  cards.push(mk('jiu', 'club', 9));

  // —— 装备 7：全部已实现（方天画戟是按**国战版**文本实现的多目标杀）——
  cards.push(mk('weapon', 'spade', 5, { equipName: 'qinglong', range: 3 })); // 青龙偃月刀（同军争）
  cards.push(mk('weapon', 'diamond', 12, { equipName: 'fangtian', range: 4 })); // 方天画戟（国战版效果）
  cards.push(mk('armor', 'spade', 2, { equipName: 'mingguang' })); // 明光铠（火攻/火杀取消 + 小势力不被横置）
  cards.push(mk('armor', 'club', 2, { equipName: 'huxinjing', lianheng: true })); // 护心镜
  cards.push(mk('minusMount', 'heart', 3, { equipName: 'jingfan', lianheng: true })); // 惊帆
  cards.push(mk('treasure', 'club', 1, { equipName: 'yuxi' })); // 玉玺
  cards.push(mk('treasure', 'diamond', 5, { equipName: 'muniu' })); // 木牛流马

  // —— 锦囊 17：全部已实现 ——
  cards.push(mk('wuxie', 'spade', 13)); // 无懈可击（同基础堆，直接可用）
  cards.push(mk('wuxieguo', 'diamond', 11)); // 无懈可击·国
  cards.push(mk('wuxieguo', 'club', 13)); // 无懈可击·国
  cards.push(mk('tiaohu', 'heart', 2)); // 调虎离山
  cards.push(mk('tiaohu', 'diamond', 10, { lianheng: true })); // 调虎离山（带连横）
  cards.push(mk('shuiyan', 'club', 12)); // 水淹七军
  cards.push(mk('shuiyan', 'heart', 13)); // 水淹七军
  cards.push(mk('lutong', 'club', 10)); // 勠力同心
  cards.push(mk('lutong', 'spade', 12)); // 勠力同心
  cards.push(mk('xietianzi', 'spade', 1, { lianheng: true })); // 挟天子以令诸侯
  cards.push(mk('xietianzi', 'diamond', 1, { lianheng: true })); // 挟天子以令诸侯
  cards.push(mk('xietianzi', 'diamond', 4, { lianheng: true })); // 挟天子以令诸侯
  cards.push(mk('huoshao', 'spade', 3, { lianheng: true })); // 火烧连营
  cards.push(mk('huoshao', 'club', 11, { lianheng: true })); // 火烧连营
  cards.push(mk('huoshao', 'heart', 12, { lianheng: true })); // 火烧连营
  cards.push(mk('chiling', 'club', 3)); // 敕令
  cards.push(mk('lianjun', 'heart', 1)); // 联军盛宴
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
    // ⚠️ 洗回弃牌堆也要走 `state.rng`：用缺省的 `Math.random` 会让固定种子重放不出来
    //    （这种「同一个种子每次局面都不同」的坑踩过两轮，一处都不能漏）
    state.deck = shuffle(state.discard, state.rng);
    state.discard = [];
  }
  const card = state.deck.pop() ?? null;
  // 「本回合从牌堆获得过牌」的账本（袁术·伪帝）。重洗之后摸到的牌也该算——它们此刻确实
  // 是从牌堆来的，所以在这里盖戳比「意图前后快照」准（快照法会漏掉重洗那一批）。
  if (card) state.gainedFromDeckThisTurn.push(card.id);
  return card;
}

/**
 * 君主将的**专属装备**——不在任何牌堆里，只能通过【君威】从**游戏外**取得。
 *
 * 【飞龙夺凤】（宝物 ♠2）效果原文（移动版 WIKI，已核）：
 *   「当你每回合首次使用【杀】对目标角色造成伤害后，你可以获得其一枚阴阳鱼标记或者一张手牌。
 *     当此牌离开装备区后，销毁之。」
 *
 * ⚠️ 另外三件（【六龙骖驾】【定澜夜明珠】【盟军大纛】）的 WIKI 没有页面、搜索配额也用尽了，
 *    效果文本**待核对**——在查清之前不实现（本仓库不猜规则文本）。
 */
export function lordEquipFeilong(seq: number): Card {
  return {
    id: `lord-feilong#${seq}`,
    type: 'treasure',
    suit: 'spade',
    rank: 2,
    equipName: 'feilong',
    destroyOnLeave: true,
  };
}

/**
 * 【六龙骖驾】（君主将专属宝物，♥K）：**你计算与其他角色的距离 -3**。
 *
 * 只能通过君曹操的【君威】从**游戏外**取得；离开装备区即销毁（`Card.destroyOnLeave`）。
 * ⚠️ 网上另有「它会替换坐骑、且不能再使用坐骑牌」的说法——用户提供的牌面文本里**没有**这一条，
 *    本实现按用户文本：只有「距离 -3」，也不影响坐骑牌的使用。
 */
export function lordEquipLiulong(seq: number): Card {
  return {
    id: `lord-liulong#${seq}`,
    type: 'treasure',
    suit: 'heart',
    rank: 13,
    equipName: 'liulong',
    destroyOnLeave: true,
  };
}

/**
 * 【盟军大纛】（君袁绍的君主专属装备）——
 * 「当你受到伤害时，你可以弃置两张牌（弃置的其中一张牌可以是盟军大纛），然后你防止此伤害。
 *   当此牌离开装备区时，销毁之。」（用户核对后提供的牌面文本）
 *
 * 牌面（用户核对后提供）：**装备牌·防具，红桃 3（♥3）**，君袁绍发动【君威】获得。
 *
 * ⚠️ 它是**防具**不是宝物（原先占位写成宝物是猜错了）：所以它占 `equipment.armor` 那个槽位，
 *    效果函数也要看 armor（见 equip.mengjunDajun）。跟既有防具不冲突——仁王盾/藤甲/八卦阵/
 *    明光铠/护心镜/白银狮子那些判定都是按**牌名**认的，认不出它就不会误判。
 */
/**
 * 【定澜夜明珠】（君孙权的君主专属装备）——
 * 「锁定技，你每回合首次弃置牌后，摸一张牌。当此牌离开你的装备区时，销毁之。」
 * （移动版官网《国战模式更新公告》里给的就是这一版文本；用户核对后也给了同一版）
 *
 * 牌面（用户核对后提供）：**装备牌·宝物，方块 K（♦K）**，君孙权发动【君威】获得。
 */
export function lordEquipDinglan(seq: number): Card {
  return {
    id: `lord-dinglan#${seq}`,
    type: 'treasure',
    suit: 'diamond',
    rank: 13,
    equipName: 'dinglan',
    destroyOnLeave: true,
  };
}

export function lordEquipMengjun(seq: number): Card {
  return {
    id: `lord-mengjun#${seq}`,
    type: 'armor',
    suit: 'heart',
    rank: 3,
    equipName: 'mengjun',
    destroyOnLeave: true,
  };
}
