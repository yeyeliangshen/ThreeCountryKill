/**
 * 「武将牌上的牌区」的**统一口径**（公开信息）——自己的面板（HeroPanel）与对手那一行
 * （Game.tsx 的 players-row）共用这一份。
 *
 * 为什么抽出来：这些牌区以前只在自己的面板上画，对手那一行没有 ⇒ 对手有几张「节」/「权」/
 * 「田」看不到（用户 2026-09-21 的要求是「看其他玩家也要显示出…」，2026-09-22 补「节」时
 * 在真机上发现对手行确实缺这一块）。两处各写一份必然分叉，所以只有一个列表函数。
 *
 * 口径：
 * - **实体牌**（权/异/函/节）逐张列出**牌名**（`cardShortName`）——以前画的是内部的
 *   类型 id（`sha`/`lebu`），那是漏到界面上的实现细节；
 * - **只有张数的**（田/幻/魂/创/城）画「X·N」；
 * - 没有这些牌区时**整块不渲染**（不给空壳）。
 */
import { cardShortName, type Card, type PlayerView } from '@sgs/protocol';

/** 这些牌区都是公开信息，所以两张快照（自己 / 别人）里的字段一样，取一个子集即可 */
export type SpecialZoneView = Pick<
  PlayerView,
  | 'tianCount'
  | 'qianhuanCount'
  | 'hunCount'
  | 'kongchengCount'
  | 'wounds'
  | 'quan'
  | 'yi'
  | 'han'
  | 'luCount'
  | 'luNames'
  | 'jie'
>;

export interface ZoneChipView {
  /** React key */
  key: string;
  /** 芯片文字（如「节·过河拆桥」「田·2」） */
  label: string;
  /** 悬浮说明 */
  tip: string;
}

/** 要不要渲染这一块（没有就整块不渲染） */
export function hasSpecialZones(p: SpecialZoneView | null | undefined): boolean {
  return specialZoneChips(p).length > 0;
}

/** 把武将牌上的各牌区摊成一列芯片（顺序固定，便于测试与视觉稳定） */
export function specialZoneChips(p: SpecialZoneView | null | undefined): ZoneChipView[] {
  if (!p) return [];
  const out: ZoneChipView[] = [];
  const count = (n: number | undefined, label: string, tip: string) => {
    if (n) out.push({ key: label, label: `${label}·${n}`, tip });
  };
  const cards = (list: Card[] | undefined, label: string, tip: string) => {
    for (const c of list ?? []) {
      out.push({ key: `${label}-${c.id}`, label: `${label}·${cardShortName(c)}`, tip });
    }
  };
  count(p.tianCount, '田', '邓艾·屯田放在武将牌上的牌：距离 -X');
  count(p.qianhuanCount, '幻', '于吉·千幻放在武将牌上的牌');
  count(p.hunCount, '魂', '左慈·役鬼扣在武将牌上的武将牌');
  count(p.wounds?.length, '创', '周泰·不屈扣在武将牌上的牌（点数都不同才挡得住死）');
  count(p.kongchengCount, '城', '国战【空城】暂存牌：下个摸牌阶段开始时一次性获得');
  count(p.luCount, '戮', '孙綝·嗜戮扣在武将牌上的武将牌');
  cards(p.quan, '权', '界钟会·权计放在武将牌旁的牌');
  cards(p.yi, '异', '公孙渊·怀异放在武将牌旁的牌');
  cards(p.han, '函', '孟达·求安放在武将牌旁的牌');
  cards(p.jie, '节', '陆逊·谦逊收下的锦囊牌：满 3 张后【谦逊】不再触发；【度势】第二项要弃三张');
  return out;
}
