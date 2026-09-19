// 国战扩展模块（用户给定的架构，见 docs/guozhan-roster.md §5.77 ④）
//
// 目的：**不要让 `if (config.shibei)` 散落在几十个系统里**。每个扩展把自己那部分能力
// 声明成一个模块，`createGame` 按 config 收集模块、逐个应用。
//
// 职责划分（用户给定，互不越界）：
// - 势备篇：只管**牌堆内容**（标准 108 + 势备 52）。不关心君主是谁、不实现建国。
// - 不臣篇：**武将 + 特殊规则 + 特殊牌区域**（野心家武将、双势力武将、暴露野心/建立新势力、
//   势力锦囊、府库、第一次洗牌洗入）。
// - 2026 君临天下：**君主规则覆盖**（君主化、只能作主将、不成为超员野心家、珠棱璧合全员、
//   【君威】、场外专属装备、离开装备区销毁）。
//
// ⚠️ 加新扩展时：只在本文件加一个描述对象，**不要**回引擎里撒条件分支。

import type { GuozhanExtensions } from './config';
import type { Hero } from './heroes';
import { buildShibeiCards } from './deck';
import type { Card } from '@sgs/protocol';

/** 扩展模块能挂的能力（按 §5.77 ④ 的接口） */
export interface GuozhanExtension {
  id: string;
  /** 这个扩展当前是否启用（看配置里对应开关的版本字符串） */
  enabled: (ext: GuozhanExtensions) => boolean;
  /**
   * 调整**选将池**。`pool` 是基础池（已按模式筛过），返回新的池。
   * 纯函数：不要就地改传入的数组。
   */
  modifyGeneralPool?: (pool: Hero[], ext: GuozhanExtensions) => Hero[];
  /**
   * 调整**初始牌堆**（在基础牌堆之后追加自己的牌）。
   * 纯函数：返回新的数组。
   */
  modifyInitialDeck?: (deck: Card[], ext: GuozhanExtensions) => Card[];
}

/**
 * 势备篇：只往牌堆里追加 52 张（28 基本 / 17 锦囊 / 7 装备）。
 * 它的 17 张锦囊里含【无懈可击】×1 与【无懈可击·国】×2——那是**这一包自带的**，
 * 与标准堆里的同名牌是两份实体（用户口径，见 §5.76）。
 */
export const ShibeiExtension: GuozhanExtension = {
  id: 'shibei',
  enabled: (ext) => ext.shibei !== 'off',
  modifyInitialDeck: (deck) => [...deck, ...buildShibeiCards()],
};

/**
 * 2026 君临天下：君主规则覆盖。
 *
 * 已经落在引擎里的部分（君主特性、君主技、专属装备、君主不会被转成野心家等）走的是
 * `Hero.isLord` / `lordBanner` 这些**武将数据**，不需要在这里再写一遍；
 * 这个模块只负责「**关掉时君主将不进选将池**」这条池子层面的覆盖。
 */
export const Junlintianxia2026Extension: GuozhanExtension = {
  id: 'junlintianxia2026',
  // ⚠️ 它**常驻启用**：这个模块的动作是「**关掉时**把君主将踢出池」，所以不能靠
  //    `enabled` 开关来决定跑不跑（那样开着反而会把君主踢掉）。
  //    条件留在**模块内部**——这正是这套架构要的效果：系统里看不到 `if (ext.junlintianxia)`。
  enabled: () => true,
  /** 关掉君临天下 = 这套君主规则整体不启用 → 君主将不进选将池（标准版曹操/刘备/孙权/袁绍照旧在） */
  modifyGeneralPool: (pool, ext) =>
    ext.junlintianxia === 'off' ? pool.filter((h) => !h.isLord) : pool,
};

/**
 * 不臣篇：武将 + 特殊规则 + 特殊牌区域。
 *
 * 已实装的部分：**双势力武将的势力确定规则**（`heroes.determineDualFaction`，
 * 2023 口径）与**这 12 张双势力武将牌的登记**。关掉本扩展时它们不进选将池。
 *
 * ⚠️ 仍是占位/未实装的部分：野心家武将（SP司马昭/公孙渊/孙綝/界钟会）、势力锦囊
 * （号令天下/克复中原/固国安邦/文和乱武）、府库/特殊区、暴露野心/建立新势力、
 * 以及 23 名不臣篇武将的技能文本——都缺官方文本，刻意不写空分支，等有内容再加。
 */
export const BuchenExtension: GuozhanExtension = {
  id: 'buchen',
  // 常驻启用：它的动作是「关掉时把不臣篇武将踢出池」，条件留在模块内部（同君临天下那条）
  enabled: () => true,
  // 「不开启不臣篇 → 选不到任何不臣篇武将」：按**包**整包过滤。
  // ⚠️ 单势力那 4 位（徐庶/吴景/严白虎/董昭）以前漏掉了——只按双势力/野心家过滤是不够的，
  //    用户明确要求「不开启不臣篇就应当选不到不臣篇的武将」。
  modifyGeneralPool: (pool, ext) =>
    ext.buchen === 'off' ? pool.filter((h) => h.pack !== 'buchen') : pool,
};

/** 全部扩展模块（顺序 = 应用顺序） */
export const GUOZHAN_EXTENSIONS: GuozhanExtension[] = [
  ShibeiExtension,
  BuchenExtension,
  Junlintianxia2026Extension,
];

/**

 * 当前配置下启用的扩展。

 *

 * ⚠️ 「启用」的语义是**「这个模块此刻要不要动手」**，不是「配置里开没开」：

 * 有的模块（君临天下）的动作本身就是「关掉时做点什么」，于是它常驻启用、在内部读配置。

 */

export function activeExtensions(ext: GuozhanExtensions): GuozhanExtension[] {
  return GUOZHAN_EXTENSIONS.filter((e) => e.enabled(ext));
}

/** 基础选将池 → 按启用的扩展逐个调整 */
export function applyPoolExtensions(pool: Hero[], ext: GuozhanExtensions): Hero[] {
  return activeExtensions(ext).reduce(
    (acc, e) => e.modifyGeneralPool?.(acc, ext) ?? acc,
    pool,
  );
}

/** 基础牌堆 → 按启用的扩展逐个调整 */
export function applyDeckExtensions(deck: Card[], ext: GuozhanExtensions): Card[] {
  return activeExtensions(ext).reduce(
    (acc, e) => e.modifyInitialDeck?.(acc, ext) ?? acc,
    deck,
  );
}
