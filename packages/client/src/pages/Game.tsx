import { useEffect, useState } from 'react';
import { CARD_TYPE_NAME, SUIT_NAME, isRed, type Card, type CardType, type GameMode, type PlayerView } from '@sgs/protocol';
import { getHero, ROLE_NAME } from '@sgs/engine';
import { useStore } from '../store';

const PHASE_NAME: Record<string, string> = {
  draw: '摸牌',
  play: '出牌',
  discard: '弃牌',
  turnEnd: '回合结束',
  gameOver: '游戏结束',
  draft: '选将',
};

const MODE_NAME: Record<GameMode, string> = {
  junzheng: '军争',
  '2v2': '2v2',
  melee: '混战',
  guozhan: '国战',
};

/** 把服务端 winner 字符串转成人类可读的胜方文案 */
function winnerText(mode: GameMode, winner: string, players: PlayerView[]): string {
  if (mode === 'junzheng') {
    if (winner === 'rebel') return '反贼胜利';
    if (winner === 'lord') return '主忠方胜利';
    if (winner === 'renegade') return '内奸胜利';
    return '游戏结束';
  }
  if (mode === '2v2') {
    if (winner === 'team0') return '队伍1胜利';
    if (winner === 'team1') return '队伍2胜利';
    return '游戏结束';
  }
  // melee：winner 是存活者 seatId
  const wp = players.find((p) => p.seatId === winner);
  return wp ? `${wp.name} 获胜` : '游戏结束';
}

export function Game() {
  const snapshot = useStore((s) => s.snapshot);
  const sendIntent = useStore((s) => s.sendIntent);
  const pickHero = useStore((s) => s.pickHero);

  // 出牌阶段：选中一张需目标的牌后，再选目标
  const [selected, setSelected] = useState<{ cardId: string; as?: CardType } | null>(null);
  // 弃牌阶段：已选待弃的牌
  const [picks, setPicks] = useState<string[]>([]);
  // 选将阶段：已选中但未确认的武将（防误触）
  const [pickedHero, setPickedHero] = useState<string | null>(null);

  // 提示一变就清空本地选择
  useEffect(() => {
    setSelected(null);
    setPicks([]);
    setPickedHero(null);
  }, [snapshot?.prompt]);

  if (!snapshot) return <div className="game loading">加载中…</div>;

  const me = snapshot.players.find((p) => p.seatId === snapshot.seatId)!;
  const myHero = getHero(me.heroId);
  const others = snapshot.players.filter((p) => p.seatId !== snapshot.seatId);
  const prompt = snapshot.prompt;
  const legalSet = new Set(prompt?.legalCardIds ?? []);
  const targetSet = new Set(prompt?.legalTargetIds ?? []);
  const myTurn = snapshot.turn.seatId === snapshot.seatId;
  const isGameOver = snapshot.turn.phase === 'gameOver' && snapshot.winner !== null;

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
          <>
            <div className="hero-list">
              {options.map((id) => {
                const h = getHero(id);
                if (!h) return null;
                const isPicked = pickedHero === id;
                return (
                  <button
                    key={id}
                    className={`hero-card ${isPicked ? 'picked' : ''}`}
                    onClick={() => setPickedHero(id)}
                  >
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
            <button
              className="primary big"
              disabled={!pickedHero}
              onClick={() => pickedHero && pickHero(pickedHero)}
            >
              {pickedHero ? `确认选择 ${getHero(pickedHero)?.name ?? ''}` : '请选择武将'}
            </button>
          </>
        ) : (
          <div className="hint">已选将，等待其他玩家…</div>
        )}
      </div>
    );
  }

  // 游戏结束：显示胜方覆盖层
  if (isGameOver) {
    return (
      <div className="game game-over-screen">
        <div className="game-over-banner">
          <div className="game-over-title">{winnerText(snapshot.mode, snapshot.winner!, snapshot.players)}</div>
          <div className="hint">游戏结束</div>
        </div>
        <div className="players-row">
          {snapshot.players.map((p) => {
            const hero = getHero(p.heroId);
            return (
              <div key={p.seatId} className={`player ${!p.isAlive ? 'dead' : ''} team-${p.team ?? 0}`}>
                <div className="p-name">{p.name}</div>
                <div className="p-hero">{hero?.name ?? '?'}</div>
                <div className="p-hp">
                  {Array.from({ length: p.maxHp }).map((_, i) => (
                    <span key={i} className={`hp-cell ${i < p.hp ? 'on' : ''}`} />
                  ))}
                </div>
                {!p.isAlive && <div className="p-dead">阵亡</div>}
              </div>
            );
          })}
        </div>
        <div className="log">
          {snapshot.log
            .slice(-10)
            .map((l, i) => (
              <div key={i} className={`log-line log-${l.kind}`}>
                {l.message}
              </div>
            ))}
        </div>
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
          const isLord = p.role === 'lord';
          const teamClass = snapshot.mode === '2v2' ? `team-${p.team ?? 0}` : '';
          return (
            <button
              key={p.seatId}
              className={`player ${isCurrent ? 'current' : ''} ${!p.isAlive ? 'dead' : ''} ${isTarget ? 'targetable' : ''} ${teamClass}`}
              onClick={isTarget ? () => pickTarget(p.seatId) : undefined}
              disabled={!isTarget}
            >
              <div className="p-name">
                {p.name}
                {isCurrent && <span className="dot">●</span>}
                {isLord && <span className="lord-tag">主</span>}
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
          [{MODE_NAME[snapshot.mode]}]{' '}
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
      <div className={`me-bar ${myTurn ? 'my-turn' : ''} ${snapshot.mode === '2v2' ? `team-${me.team ?? 0}` : ''}`}>
        <span className="me-name">{me.name}</span>
        {me.role && snapshot.mode === 'junzheng' && (
          <span className={`role-badge role-${me.role}`}>{ROLE_NAME[me.role]}</span>
        )}
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
