/**
 * **「操作别人区域里的牌」的通用分区选牌面板**（用户 2026-09-23 定的口径）。
 *
 * 规则层给布局（`ZonePickLayout`），界面照着画：
 *
 * ```
 * ┌────────目标 A────────┐  ┌────────目标 B────────┐   ← 不同角色**横向分栏**
 * │        名字           │  │        名字           │
 * │  🂠 🂠 🂠 🂠           │  │  🂠 🂠 🂠              │   ← 上部：手牌（一律牌背）
 * │  [八卦阵] [绝影]      │  │  [仁王盾] [的卢]      │   ← 中部：装备（公开牌名）
 * │  [乐不思蜀]           │  │                       │   ← 下部：判定区（只有规则允许时才有）
 * └──────────────────────┘  └──────────────────────┘
 * ```
 *
 * **不写「手牌区 / 装备区 / 判定区」这些文字**——靠位置区分（用户明确要求）。
 * 每一区的 item 由引擎决定：带 `card` 的画牌面（公开区），**不带 `card` 的画牌背**（隐藏手牌，
 * 牌面根本没下发）——技能不参与这个判断，界面也不猜。
 */
import { cardDescription, cardShortName, type Card, type ZonePickLayout } from '@sgs/protocol';
import { cardBack } from './cardBack';

export interface ZonePickPanelProps {
  layout: ZonePickLayout;
  players: { seatId: string; name: string }[];
  /** 点某一张 → 发它的 optionId（引擎照旧按 `chooseOption` 解析） */
  onPick: (optionId: string) => void;
  bindTip: (title: string, desc: string) => Record<string, unknown>;
}

export function ZonePickPanel({ layout, players, onPick, bindTip }: ZonePickPanelProps) {
  const nameOf = (seatId: string) => players.find((p) => p.seatId === seatId)?.name ?? seatId;
  return (
    <div className={`zone-pick ${layout.targets.length > 1 ? 'multi' : 'single'}`}>
      {layout.targets.map((t) => (
        <div key={t.seatId} className="zp-target">
          <div className="zp-name">{nameOf(t.seatId)}</div>
          {t.zones.map((z) => (
            <div key={z.zone} className={`zp-zone zp-${z.zone}`}>
              {z.items.map((it) => {
                const card = it.card as Card | undefined;
                if (!card) {
                  // 隐藏的手牌：只画牌背（服务端就没下发牌面）
                  return (
                    <button
                      key={it.optionId}
                      type="button"
                      className="zp-card zp-back"
                      aria-label="对方的一张手牌（看不到牌面）"
                      onClick={() => onPick(it.optionId)}
                    >
                      {cardBack ? <img className="zp-back-img" src={cardBack} alt="牌背" /> : '🂠'}
                    </button>
                  );
                }
                return (
                  <button
                    key={it.optionId}
                    type="button"
                    className="zp-card zp-face"
                    aria-label={cardShortName(card)}
                    {...bindTip(cardShortName(card), cardDescription(card))}
                    onClick={() => onPick(it.optionId)}
                  >
                    {cardShortName(card)}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
