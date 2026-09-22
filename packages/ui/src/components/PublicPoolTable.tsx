/**
 * **牌桌上公开摆着的牌池**（【五谷丰登】）——用户 2026-09-23 的规格：
 *
 * > 不应再通过文字按钮或文字选项让玩家选择牌。把亮出的所有牌按固定顺序**平铺在牌桌中央**，
 * > 所有需要选择的玩家都能看到；按正常结算顺序依次选择：当前玩家直接**点击牌桌上的一张牌**，
 * > 被选中的牌**立即从展示区域移除**并移动到手牌区，剩余牌的位置和状态实时更新；
 * > 选完自动轮到下一名玩家；直到所有人选完或牌被取空。
 *
 * 分工（与前几次一致）：**规则层决定「现在轮到谁、谁能点」**（快照里的 `interactive` 是按
 * 观看者算好的），界面只负责画这一排牌与把点击变成 `pickCards`。
 *
 * ⚠️ 被拿走的牌**留在原位**、只是标上「谁拿走了」——这样「第几张被谁拿走」一眼看得出，
 * 也就是牌桌上那一排牌的真实手感（而不是让后面的牌往前挤）。
 */
import { CARD_TYPE_NAME, cardDescription, cardShortName, isRed, type PublicPoolView } from '@sgs/protocol';

export interface PublicPoolProps {
  pool: PublicPoolView;
  players: { seatId: string; name: string }[];
  /** 点牌拿走（只有 `pool.interactive` 为真时才会被调用） */
  onPick: (cardId: string) => void;
  /** 悬浮提示绑定器（桌面悬停 / 手机长按） */
  bindTip: (title: string, desc: string) => Record<string, unknown>;
}

export function PublicPoolTable({ pool, players, onPick, bindTip }: PublicPoolProps) {
  const nameOf = (seatId: string) => players.find((p) => p.seatId === seatId)?.name ?? seatId;
  const taken = pool.slots.filter((s) => s.takenBySeatId).length;
  const left = pool.slots.length - taken;
  const title = CARD_TYPE_NAME[pool.source] ?? pool.source;

  return (
    <div className={`pool-table ${pool.interactive ? 'mine' : ''}`}>
      <div className="pool-title">
        【{title}】· 亮出 {pool.slots.length} 张
        <span className="pool-progress">
          （已拿走 {taken} / 剩 {left}）
        </span>
        {pool.currentSeatId ? (
          <span className="pool-turn">
            {pool.currentSeatId === undefined ? '' : `轮到 ${nameOf(pool.currentSeatId)} 选`}
          </span>
        ) : (
          <span className="pool-turn done">都选完了</span>
        )}
      </div>
      <div className="pool-row">
        {pool.slots.map((slot) => {
          const gone = !!slot.takenBySeatId;
          // 还能点的条件：还没被拿走 + 轮到我（`interactive` 由服务端按观看者算好）
          const clickable = !gone && pool.interactive;
          const cls = [
            'pool-card',
            gone ? 'taken' : '',
            clickable ? 'clickable' : '',
            isRed(slot.card) ? 'red' : 'black',
          ]
            .filter(Boolean)
            .join(' ');
          const body = (
            <>
              <span className="pc-name">{cardShortName(slot.card)}</span>
              <span className="pc-taken">
                {gone ? `${nameOf(slot.takenBySeatId!)} 拿走` : ''}
              </span>
            </>
          );
          return clickable ? (
            <button
              key={slot.card.id}
              type="button"
              className={cls}
              aria-label={`拿走【${cardShortName(slot.card)}】`}
              {...bindTip(cardShortName(slot.card), cardDescription(slot.card))}
              onClick={() => onPick(slot.card.id)}
            >
              {body}
            </button>
          ) : (
            <div
              key={slot.card.id}
              className={cls}
              {...(gone
                ? bindTip(
                    `${cardShortName(slot.card)}（被 ${nameOf(slot.takenBySeatId!)} 拿走）`,
                    cardDescription(slot.card),
                  )
                : bindTip(cardShortName(slot.card), cardDescription(slot.card)))}
            >
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}
