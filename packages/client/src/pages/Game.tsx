import { useEffect, useState } from 'react';
import { CARD_TYPE_NAME, SUIT_NAME, isRed, type Card, type CardType } from '@sgs/protocol';
import { getHero } from '@sgs/engine';
import { useStore } from '../store';

const PHASE_NAME: Record<string, string> = {
  draw: '摸牌',
  play: '出牌',
  discard: '弃牌',
  turnEnd: '回合结束',
  gameOver: '游戏结束',
  draft: '选将',
};

export function Game() {
  const snapshot = useStore((s) => s.snapshot);
  const sendIntent = useStore((s) => s.sendIntent);
  const pickHero = useStore((s) => s.pickHero);

  // 出牌阶段：选中一张需目标的牌后，再选目标
  const [selected, setSelected] = useState<{ cardId: string; as?: CardType } | null>(null);
  // 弃牌阶段：已选待弃的牌
  const [picks, setPicks] = useState<string[]>([]);

  // 提示一变就清空本地选择
  useEffect(() => {
    setSelected(null);
    setPicks([]);
  }, [snapshot?.prompt]);

  if (!snapshot) return <div className="game loading">加载中…</div>;

  const me = snapshot.players.find((p) => p.seatId === snapshot.seatId)!;
  const myHero = getHero(me.heroId);
  const others = snapshot.players.filter((p) => p.seatId !== snapshot.seatId);
  const prompt = snapshot.prompt;
  const legalSet = new Set(prompt?.legalCardIds ?? []);
  const targetSet = new Set(prompt?.legalTargetIds ?? []);
  const myTurn = snapshot.turn.seatId === snapshot.seatId;

  // —— 出牌：选中需目标的牌 ——
  function pickPlayCard(card: Card) {
    if (!prompt || prompt.kind !== 'play' || !legalSet.has(card.id)) return;
    if (card.type === 'tao' || card.type === 'jiu') {
      sendIntent({ type: 'playCard', cardId: card.id, targetIds: [] });
      return;
    }
    // 杀（直接或武圣转化）——需选目标
    const as: CardType | undefined = card.type === 'sha' ? undefined : 'sha';
    setSelected({ cardId: card.id, as });
  }

  function pickTarget(targetId: string) {
    if (!selected) return;
    sendIntent({
      type: 'playCard',
      cardId: selected.cardId,
      ...(selected.as ? { as: selected.as } : {}),
      targetIds: [targetId],
    });
    setSelected(null);
  }

  // —— 响应杀/濒死：直接出牌 ——
  function pickRespondCard(card: Card) {
    if (!prompt || !legalSet.has(card.id)) return;
    sendIntent({ type: 'respondCard', cardId: card.id });
  }

  // —— 弃牌 ——
  function togglePick(cardId: string) {
    if (!prompt || prompt.kind !== 'discard') return;
    setPicks((prev) =>
      prev.includes(cardId) ? prev.filter((c) => c !== cardId) : prev.length < prompt.mustSelectTargetCount ? [...prev, cardId] : prev,
    );
  }
  function confirmDiscard() {
    if (picks.length !== prompt?.mustSelectTargetCount) return;
    sendIntent({ type: 'discard', cardIds: picks });
  }

  // 选将阶段：聚焦选将面板，不渲染空牌桌 / 0 体力条
  if (snapshot.turn.phase === 'draft') {
    const options = prompt?.kind === 'pickHero' ? prompt.legalHeroIds ?? [] : [];
    return (
      <div className="draft">
        <div className="draft-title">选将阶段</div>
        {options.length > 0 ? (
          <div className="hero-list">
            {options.map((id) => {
              const h = getHero(id);
              if (!h) return null;
              return (
                <button key={id} className="hero-card" onClick={() => pickHero(id)}>
                  <div className="hero-name">
                    {h.name}
                    {h.id === 'vanilla' && <small>（白板）</small>}
                  </div>
                  <div className="hero-hp">体力 {h.maxHp}</div>
                  <div className="hero-skills">
                    {h.skills.map((sk) => (
                      <div key={sk.name}>
                        <b>{sk.name}</b>
                      </div>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="hint">已选将，等待其他玩家…</div>
        )}
      </div>
    );
  }

  return (
    <div className="game">
      {/* 其他玩家 */}
      <div className="players-row">
        {others.map((p) => {
          const hero = getHero(p.heroId);
          const isTarget = !!selected && targetSet.has(p.seatId) && p.isAlive;
          const isCurrent = snapshot.turn.seatId === p.seatId;
          return (
            <button
              key={p.seatId}
              className={`player ${isCurrent ? 'current' : ''} ${!p.isAlive ? 'dead' : ''} ${isTarget ? 'targetable' : ''}`}
              onClick={isTarget ? () => pickTarget(p.seatId) : undefined}
              disabled={!isTarget}
            >
              <div className="p-name">
                {p.name}
                {isCurrent && <span className="dot">●</span>}
              </div>
              <div className="p-hero">{hero?.name ?? '?'}</div>
              <div className="p-hp">
                {Array.from({ length: p.maxHp }).map((_, i) => (
                  <span key={i} className={`hp-cell ${i < p.hp ? 'on' : ''}`} />
                ))}
              </div>
              <div className="p-hand">手 {p.handCount}</div>
              {!p.isAlive && <div className="p-dead">阵亡</div>}
            </button>
          );
        })}
      </div>

      {/* 中部：回合信息 + 日志 */}
      <div className="center">
        <div className="turn-info">
          {snapshot.players.find((p) => p.seatId === snapshot.turn.seatId)?.name} 的回合 ·{' '}
          {PHASE_NAME[snapshot.turn.phase] ?? snapshot.turn.phase}
        </div>
        <div className="log">
          {snapshot.log
            .slice(-6)
            .map((l, i) => (
              <div key={i} className={`log-line log-${l.kind}`}>
                {l.message}
              </div>
            ))}
        </div>
      </div>

      {/* 我的玩家条 */}
      <div className={`me-bar ${myTurn ? 'my-turn' : ''}`}>
        <span className="me-name">{me.name}</span>
        <span className="me-hero">{myHero?.name}</span>
        <span className="me-hp">
          体力 {me.hp}/{me.maxHp}
        </span>
      </div>

      {/* 提示/操作区 */}
      {prompt ? (
        <div className={`prompt prompt-${prompt.kind}`}>
          <div className="prompt-msg">{prompt.message}</div>
          {prompt.kind === 'respondSha' && (
            <button className="ghost" onClick={() => sendIntent({ type: 'pass' })}>
              弃权（不出闪）
            </button>
          )}
          {prompt.kind === 'respondDeath' && (
            <button className="ghost" onClick={() => sendIntent({ type: 'pass' })}>
              弃权（不救）
            </button>
          )}
          {prompt.kind === 'discard' && (
            <button
              className="primary"
              disabled={picks.length !== prompt.mustSelectTargetCount}
              onClick={confirmDiscard}
            >
              弃牌（{picks.length}/{prompt.mustSelectTargetCount}）
            </button>
          )}
          {prompt.kind === 'play' && (
            <button className="ghost" onClick={() => sendIntent({ type: 'endPhase' })}>
              结束出牌
            </button>
          )}
          {selected && prompt.kind === 'play' && (
            <span className="hint">请选择目标（点上方对手）</span>
          )}
        </div>
      ) : (
        <div className="prompt prompt-wait">
          {myTurn ? '…' : '等待其他玩家行动…'}
        </div>
      )}

      {/* 我的手牌 */}
      <div className="hand">
        {snapshot.myHand.map((card) => {
          const legal = legalSet.has(card.id);
          const isPick =
            (prompt?.kind === 'discard' && picks.includes(card.id)) ||
            (prompt?.kind === 'play' && selected?.cardId === card.id);
          return (
            <button
              key={card.id}
              className={`card ${isRed(card) ? 'red' : 'black'} ${legal ? 'legal' : 'dim'} ${isPick ? 'picked' : ''}`}
              disabled={!legal}
              onClick={() => {
                if (!prompt) return;
                if (prompt.kind === 'pickHero') return;
                if (prompt.kind === 'play') pickPlayCard(card);
                else if (prompt.kind === 'discard') togglePick(card.id);
                else pickRespondCard(card);
              }}
            >
              <span className="c-suit">{SUIT_NAME[card.suit]}</span>
              <span className="c-type">{CARD_TYPE_NAME[card.type]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
