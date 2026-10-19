/**
 * **观星面板**（用户 §十一的口径：中央观星区、**拖动排序**）。
 *
 * 引擎的观星仍是**两步询问**（第一步选「置于牌堆顶」的、第二步选「沉底」的，都按
 * 选择顺序排）——本组件不改询问结构，只把那两步的通用选牌行换成**专用大面板**：
 *
 * ```
 * ┌────────────── 【观星】 牌堆顶（第一张最先被抽到） ──────────────┐
 * │  [♠7 杀]   [♥2 桃]   [♦K 闪]        ← 已选区：带 ①②③ 序号，可拖动重排
 * ├─────────────────────────── 未安排 ────────────────────────────┤
 * │  [♣5 闪]   [♠3 杀]                              ← 点一下/拖上来即加入已选
 * └───────────────────────────────────────────────────────────────┘
 * ```
 *
 * - **桌面**：拖卡片进已选区（追加到末尾）、拖到已选区某张牌**上**（插到它前面）、
 *   拖回未安排区（移出）；已选区内互相拖 = 重排。
 * - **手机**（HTML5 拖不动）：**点一下**＝加入已选区末尾（与旧交互一致）、
 *   点已选的牌＝移出。重排手机上用牌上的「◀ ▶」小按钮。
 * - 「顺序」就是一切：观星顶序＝先抽到；界面把**当前顺序**如实画出来（序号 ①②③），
 *   确认时按这个顺序发 `pickCards`——顺序语义完全由引擎既有约定承担，面板只做展示与编辑。
 *
 * ⚠️ 它只是 `pickCards` 的一种**皮肤**：检测条件＝`pickTitle` 含「观星」；其它
 *    选牌（刚烈/仁德/五谷…）照旧走通用行。回答的 intent 形状完全相同。
 */
import { useState, type DragEvent } from 'react';
import {
  cardDescription,
  cardShortName,
  isDelayedTrick,
  isEquipCard,
  isInstantTrick,
  isRed,
  rankLabel,
  type Card,
} from '@sgs/protocol';

export interface GuanxingPanelProps {
  title: string;
  cards: Card[];
  /** 已选的牌 id（有序）——父组件的 pickSel 是唯一事实源 */
  selected: string[];
  /** 加入到已选末尾（受 pickMax 约束的判断在父组件的 toggle 里） */
  onAdd: (id: string) => void;
  /** 移出已选 */
  onRemove: (id: string) => void;
  /** 把 id 移动到已选序列的 targetIndex 处（拖拽重排） */
  onReorder: (id: string, targetIndex: number) => void;
  min: number;
  max: number;
  onConfirm: () => void;
  bindTip: (title: string, desc: string) => Record<string, unknown>;
}

export function isGuanxingPick(title: string | undefined): boolean {
  return !!title && title.includes('观星');
}

export function GuanxingPanel({
  title,
  cards,
  selected,
  onAdd,
  onRemove,
  onReorder,
  min,
  max,
  onConfirm,
  bindTip,
}: GuanxingPanelProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const selSet = new Set(selected);
  const rest = cards.filter((c) => !selSet.has(c.id));
  // 第二步（沉底）与第一步（置顶）的文案差别只在标题里；区名跟着标题走，不自己猜步骤
  const isBottomStep = title.includes('底');
  const zoneLabel = isBottomStep ? '牌堆底（先点＝沉得越靠前、越先被抽到）' : '牌堆顶（第一张最先被抽到）';

  const dropOnZone = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    if (dragId && !selSet.has(dragId)) onAdd(dragId);
    setDragId(null);
  };
  const dropBefore = (targetId: string) => (e: DragEvent<HTMLElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragId) return;
    if (selSet.has(dragId)) {
      const targetIndex = selected.indexOf(targetId);
      onReorder(dragId, targetIndex < 0 ? selected.length : targetIndex);
    } else {
      const targetIndex = selected.indexOf(targetId);
      onAdd(dragId);
      // 加入后落在目标前面：onAdd 追加到末尾，再挪一步（父组件按 id 找，追加的那个就是它）
      if (targetIndex >= 0) onReorder(dragId, targetIndex);
    }
    setDragId(null);
  };
  const dropOnRest = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    if (dragId && selSet.has(dragId)) onRemove(dragId);
    setDragId(null);
  };

  const cardNode = (card: Card, order: number | null): JSX.Element => (
    <button
      key={card.id}
      className={`card ${isRed(card) ? 'red' : 'black'} legal ${order !== null ? 'picked' : ''} ${
        isEquipCard(card) ? 'cat-equip' : isDelayedTrick(card) ? 'cat-delayed' : isInstantTrick(card) ? 'cat-trick' : 'cat-basic'
      }`}
      draggable
      onDragStart={() => setDragId(card.id)}
      onDragEnd={() => setDragId(null)}
      onDrop={order !== null ? dropBefore(card.id) : undefined}
      aria-label={cardShortName(card)}
      {...bindTip(cardShortName(card), cardDescription(card, 'guozhan'))}
      onClick={() => (order !== null ? onRemove(card.id) : onAdd(card.id))}
    >
      <span className="c-idx">
        <span className="c-rank">{rankLabel(card.rank)}</span>
        <span className="c-suit">
          {{ spade: '♠', heart: '♥', club: '♣', diamond: '♦' }[card.suit]}
        </span>
      </span>
      <span className="c-name">
        <span className={cardShortName(card).length >= 5 ? 'long' : undefined}>{cardShortName(card)}</span>
      </span>
      {order !== null && (
        <>
          <span className="c-order" title="顺序（可拖动重排）">
            {order}
          </span>
            {/* 手机上的重排（HTML5 拖不动）：左右各一颗小按钮 */}
            <span className="gx-nudge" role="group" aria-label="调整顺序">
              <span
                role="button"
                tabIndex={0}
                aria-label="往前挪"
                onClick={(e) => {
                  e.stopPropagation();
                  if (order > 1) onReorder(card.id, order - 2);
                }}
              >
                ◀
              </span>
              <span
                role="button"
                tabIndex={0}
                aria-label="往后挪"
                onClick={(e) => {
                  e.stopPropagation();
                  if (order < selected.length) onReorder(card.id, order);
                }}
              >
                ▶
              </span>
            </span>
        </>
      )}
    </button>
  );

  return (
    <div className="guanxing" role="group" aria-label={title}>
      <div className="gx-title">{title}</div>
      <div
        className="gx-zone gx-top"
        onDragOver={(e) => e.preventDefault()}
        onDrop={dropOnZone}
        aria-label={zoneLabel}
      >
        <div className="gx-zone-label">{zoneLabel}</div>
        <div className="gx-cards">
          {selected.map((id, i) => {
            const card = cards.find((c) => c.id === id);
            return card ? cardNode(card, i + 1) : null;
          })}
          {selected.length === 0 && (
            <div className="gx-empty">把要{isBottomStep ? '沉底' : '置顶'}的牌拖到这里（或点一下牌）</div>
          )}
        </div>
      </div>
      <div
        className="gx-zone gx-rest"
        onDragOver={(e) => e.preventDefault()}
        onDrop={dropOnRest}
        aria-label="未安排"
      >
        <div className="gx-zone-label">
          未安排{isBottomStep ? '（不选＝按原序留在牌堆顶）' : '（这一步不选的牌进入下一步）'}
        </div>
        <div className="gx-cards">
          {rest.map((card) => cardNode(card, null))}
          {rest.length === 0 && <div className="gx-empty">（都在上面了）</div>}
        </div>
      </div>
      <button
        className="primary"
        aria-disabled={selected.length < min || selected.length > max}
        onClick={onConfirm}
      >
        确定（已选 {selected.length} / {min === max ? min : `${min}-${max}`} 张）
      </button>
    </div>
  );
}
