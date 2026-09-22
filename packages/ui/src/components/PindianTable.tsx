/**
 * **拼点区**（牌桌中央那块独立 UI）——用户 2026-09-23 的规格：
 *
 * > 拼点开始时…初始显示双方各自的**一张空牌位**；任意一方完成选择后，对应牌位先以**牌背**
 * > 朝上展示，不能提前暴露牌面；只有当双方都完成选择后，才**同时翻开**两张牌，展示具体牌面
 * > 与点数；翻牌后要有明显的视觉表现：两边牌与点数、谁点数更大、谁胜谁负、平点也要明确；
 * > 整个过程是「等待选择 → 牌背入场 → 双方翻牌 → 比较点数 → 展示胜负」的**桌面动画流程**，
 * > 而不是只靠文字提示。
 *
 * 数据侧由引擎把关（`PindianView`：双方扣好之前连 `card` 字段都没有 ⇒ 界面**没法**提前泄露）。
 * 这里只负责把三个状态演出来：
 *
 *   ① 空位（chosen=false）      → 虚线圈 + 「等待扣置」
 *   ② 已扣置未翻（chosen=true）  → 牌背翻入（`.pd-card` 的 flip-in）＋ 微微发亮
 *   ③ 翻牌（revealed=true）      → 两张牌**同时**翻到正面（3D flip）→ 结果条（点数 + 胜/负/平）
 *
 * 动画全部走 CSS（不引动画库）：牌桌本来就重渲染频繁，用 CSS 过渡最稳，也便于
 * `prefers-reduced-motion` 一刀关掉（见 styles.css 里那一段）。
 */
import { cardShortName, type Card, type PindianView, type PlayerView } from '@sgs/protocol';
import { cardBack } from './cardBack';

export interface PindianTableProps {
  pindian: PindianView;
  /** 全场玩家（取名字用；拼点双方一定在里面） */
  players: PlayerView[];
  /** 观战席（本人）：用来把「自己那格」标出来 */
  meSeatId: string;
}

/** 一方的牌位 */
function SideSlot({
  side,
  name,
  isMe,
  revealed,
}: {
  side: PindianView['sides'][number];
  name: string;
  isMe: boolean;
  revealed: boolean;
}) {
  const card = side.card as Card | undefined;
  return (
    <div className={`pd-side ${isMe ? 'mine' : ''} ${side.chosen ? 'chosen' : ''}`}>
      <div className="pd-name">
        {side.isInitiator && <span className="pd-tag">发起</span>}
        {name}
      </div>
      <div className={`pd-slot ${side.chosen ? 'filled' : 'empty'}`}>
        {!side.chosen ? (
          <span className="pd-wait">等待扣置</span>
        ) : revealed && card ? (
          // 翻到正面：牌名 + 花色点数 + 点数（拼点比的就是点数）
          <span className="pd-face">
            <span className="pd-card-name">{cardShortName(card)}</span>
            <span className="pd-point">{side.point}</span>
          </span>
        ) : (
          // 已扣置、还没翻：**牌背**
          <span className="pd-back">
            {cardBack ? <img className="pd-back-img" src={cardBack} alt="扣置的牌" /> : '🂠'}
          </span>
        )}
      </div>
    </div>
  );
}

export function PindianTable({ pindian, players, meSeatId }: PindianTableProps) {
  const nameOf = (seatId: string) => players.find((p) => p.seatId === seatId)?.name ?? seatId;
  const [left, right] = pindian.sides;
  if (!left || !right) return null;
  const winnerName = pindian.winnerSeatId ? nameOf(pindian.winnerSeatId) : null;
  const loserSeatId = pindian.winnerSeatId
    ? (pindian.sides.find((s) => s.seatId !== pindian.winnerSeatId)?.seatId ?? null)
    : null;

  return (
    <div className={`pindian-table ${pindian.revealed ? 'revealed' : 'waiting'}`}>
      <div className="pd-title">
        {pindian.revealed ? '拼点 · 结果' : '拼点 · 扣置中'}
        {!pindian.revealed && (
          <span className="pd-progress">
            （已扣 {pindian.sides.filter((s) => s.chosen).length}/2）
          </span>
        )}
      </div>
      <div className="pd-row">
        {pindian.sides.map((side) => (
          <SideSlot
            key={side.seatId}
            side={side}
            name={nameOf(side.seatId)}
            isMe={side.seatId === meSeatId}
            revealed={pindian.revealed}
          />
        ))}
        {/* 中间的比大小：翻牌后才出现，两根竖条 + 「>」/「=」 */}
        {pindian.revealed && (
          <div className="pd-vs" aria-hidden="true">
            {pindian.tie ? '=' : '>'}
          </div>
        )}
      </div>
      {/* 结果条：点数、谁大、谁胜谁负（或平点）——压着动画的尾声出现（CSS animation-delay） */}
      {pindian.revealed && (
        <div className={`pd-result ${pindian.tie ? 'tie' : 'decided'}`}>
          <span className="pd-points">
            {left.point} : {right.point}
          </span>
          <span className="pd-verdict">
            {pindian.tie
              ? '平点 · 无人获胜'
              : `${winnerName} 胜（点数更大） · ${loserSeatId ? nameOf(loserSeatId) : ''} 负`}
          </span>
        </div>
      )}
    </div>
  );
}
