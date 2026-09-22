/**
 * 手牌区出牌的**两步流程**：「首次点击只选中并展示，再点『使用/确定』才正式打出」。
 *
 * ⚠️ 为什么值得单独一个文件（用户 2026-09-25 口径，见 docs/guozhan-roster.md §5.210）：
 * 以前 `beginPlay()` 里有一条**按目标数分流**的捷径——`range.max === 0`
 * （【无中生有】【桃园结义】【五谷丰登】【南蛮入侵】【万箭齐发】【酒】、装备牌…）
 * 就**直接 `sendIntent({ type: 'playCard' })`**，而需要目标的牌才进 `selected` 选中态。
 * 于是「这张牌不需要目标」被当成了「可以省掉确认」的理由：手牌区点一下【无中生有】就立即
 * 生效、不可撤销，误触就是把牌打出去。用户口径：**不应因为某张牌无需选择目标，就把「选中牌」
 * 和「正式使用牌」合并成一次不可撤销的点击**。
 *
 * 修法：**出牌一律先进选中态**（`beginPlay` 不再有分流），选中态的文案由这里的两条纯函数
 * 生成——`max === 0` 时按钮写「使用【无中生有】」、提示写「已选中…点『使用』打出」，
 * 而不是渲染出「确认：对  使用【X】」这种空目标的残句（这也是当初那条捷径留下的痕迹）。
 */
import { cardShortName, CARD_TYPE_NAME, type Card, type CardType } from '@sgs/protocol';

/**
 * 这张牌**按这个用法**要不要选目标——即选中之后是不是还要点角色。
 *
 * `max === 0` 就是用户点名的「无需选择目标」那一类（【无中生有】【桃园结义】【五谷丰登】
 * 【南蛮入侵】【万箭齐发】【酒】、装备牌…）。**它们同样要走两步**，这个判据只用来措辞。
 */
export function needsTargetPick(min: number, max: number): boolean {
  return max > 0 || min > 0;
}

/**
 * 选中态确认按钮上的字。
 *
 * - 需要目标的牌：`确认：对 甲、乙 使用【杀】`（把「对谁用什么」写全，免得再误点）；
 * - **无需目标的牌**：`使用【无中生有】`（以前点一下就走，现在要点它——所以它必须自己说清
 *   「点我就打出这张牌」，而不是一句空泛的「确认」）。
 *
 * `targetNames` 为空**不代表**「无目标牌」：需要目标但还没点人的时候也为空，
 * 那时按钮是禁用态（`selectedCanConfirm()` 为假），文案不必带空目标。
 */
export function playConfirmText(name: string, targetNames: string[]): string {
  if (targetNames.length === 0) return `使用【${name}】`;
  return `确认：对 ${targetNames.join('、')} 使用【${name}】`;
}

export interface PlayHint {
  /** 生效牌名（有转化用法时是转化后那张牌的牌名） */
  name: string;
  min: number;
  max: number;
  /** 已点选的目标名 */
  targetNames: string[];
  /** 这张牌按这个用法能不能把自己选成目标（读服务端下发的合法目标，见 targetRules.ts） */
  canTargetSelf: boolean;
}

/**
 * 选中态提示行的字（「现在该干什么」）。
 *
 * 顺序与改动前一致（够目标 → 两名目标的分步提示 → 多选提示 → 单目标提示），
 * 只在最前面加了一支 **`max === 0`**：无需目标的牌选中之后没有下一步可选，
 * 提示必须指向按钮（「点『使用』打出」），否则玩家会以为卡住了。
 */
export function playHintText(h: PlayHint): string {
  const names = h.targetNames.join('、');
  // 无需目标的牌：选中即「已展示」，打法就剩按钮那一下
  if (!needsTargetPick(h.min, h.max)) {
    return `已选中【${h.name}】——点「使用」打出（点「取消」放回手牌）`;
  }
  // 目标够了：把「对谁用」摆出来，并提示还要点一下确认（点目标不再直接出牌）
  if (h.targetNames.length >= h.min) {
    if (h.min === 2) {
      return `已选：${names}（第 1 个是武器持有者、第 2 个是出杀目标）——点「确认」发出`;
    }
    return `目标：${names} —— 点「确认」发出`;
  }
  if (h.min === 2) {
    if (h.targetNames.length === 0) return '请选择武器持有者';
    return '请选择出杀目标';
  }
  if (h.max > 1) {
    // 「可含自己」也读服务端下发的合法目标，不在界面里二次判断
    return `请选择 1 至 2 名目标（${h.canTargetSelf ? '可含自己' : '不含自己'}），已选 ${h.targetNames.length} 名`;
  }
  return '请选择目标（点上方对手，选完再点确认）';
}

/** 牌名：有转化用法时按**转化后**的牌型取名（武圣把红牌当【杀】：按钮上要写【杀】） */
export function effectiveCardName(card: Card, as?: CardType): string {
  if (as && as !== card.type) return CARD_TYPE_NAME[as];
  return cardShortName(card);
}
