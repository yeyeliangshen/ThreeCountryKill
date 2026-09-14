import { useEffect, useState } from 'react';
import { CARD_TYPE_NAME, SUIT_NAME, isRed, type Card, type CardType, type Faction, type GameMode, type PlayerView } from '@sgs/protocol';
import { getHero, ROLE_NAME, FACTION_NAME } from '@sgs/engine';
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

/** 国战：武将显示——亮将后显示名，未亮显示「暗将」 */
function heroDisplay(p: PlayerView, mode: GameMode): string {
  if (mode === 'guozhan') {
    const main = p.heroRevealed && p.heroId ? getHero(p.heroId)?.name : null;
    const deputy = p.deputyRevealed && p.deputyHeroId ? getHero(p.deputyHeroId)?.name : null;
    if (main && deputy) return `${main} / ${deputy}`;
    if (main) return `${main} · 暗将`;
    if (deputy) return `暗将 · ${deputy}`;
    return '暗将';
  }
  return getHero(p.heroId)?.name ?? '?';
}

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
  if (mode === 'guozhan') {
    const fname = FACTION_NAME[winner as Faction];
    return fname ? `${fname}势力胜利` : '游戏结束';
  }
  // melee：winner 是存活者 seatId
  const wp = players.find((p) => p.seatId === winner);
  return wp ? `${wp.name} 获胜` : '游戏结束';
}

export function Game() {
  const snapshot = useStore((s) => s.snapshot);
  const sendIntent = useStore((s) => s.sendIntent);
  const pickHero = useStore((s) => s.pickHero);
  const pickHeroes = useStore((s) => s.pickHeroes);
  const revealHero = useStore((s) => s.revealHero);

  // 出牌阶段：选中一张需目标的牌后，再选目标
  const [selected, setSelected] = useState<{ cardId: string; as?: CardType } | null>(null);
  // 弃牌阶段：已选待弃的牌
  const [picks, setPicks] = useState<string[]>([]);
  // 选将阶段：已选中但未确认的武将（防误触）
  const [pickedHero, setPickedHero] = useState<string | null>(null);
  // 国战选将：主将 + 副将
  const [mainPick, setMainPick] = useState<string | null>(null);
  const [deputyPick, setDeputyPick] = useState<string | null>(null);

  // 提示一变就清空本地选择
  useEffect(() => {
    setSelected(null);
    setPicks([]);
    setPickedHero(null);
    setMainPick(null);
    setDeputyPick(null);
  }, [snapshot?.prompt]);

  if (!snapshot) return <div className="game loading">加载中…</div>;

  const me = snapshot.players.find((p) => p.seatId === snapshot.seatId)!;
  const myHero = getHero(me.heroId);
  const myDeputyHero = getHero(me.deputyHeroId);
  const others = snapshot.players.filter((p) => p.seatId !== snapshot.seatId);
  const prompt = snapshot.prompt;
  const legalSet = new Set(prompt?.legalCardIds ?? []);
  const targetSet = new Set(prompt?.legalTargetIds ?? []);
  const myTurn = snapshot.turn.seatId === snapshot.seatId;
  const isGameOver = snapshot.turn.phase === 'gameOver' && snapshot.winner !== null;
  const isGuozhan = snapshot.mode === 'guozhan';

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

  // —— 国战选将：点击武将分配主将/副将槽位 ——
  function pickGuozhanHero(id: string) {
    if (id === mainPick) { setMainPick(null); return; }       // 取消主将
    if (id === deputyPick) { setDeputyPick(null); return; }   // 取消副将
    if (!mainPick) { setMainPick(id); return; }               // 主将空 → 设主将
    if (!deputyPick) {                                         // 副将空 → 检查同阵营
      const mainHero = getHero(mainPick);
      const h = getHero(id);
      if (mainHero && h && mainHero.faction === h.faction) {
        setDeputyPick(id);
      } else {
        setMainPick(id);   // 不同阵营：替换主将，清空副将
      }
      return;
    }
    setMainPick(id);   // 两槽满 → 替换主将，清空副将
    setDeputyPick(null);
  }

  // 选将阶段：聚焦选将面板，不渲染空牌桌 / 0 体力条
  if (snapshot.turn.phase === 'draft') {
    const options = prompt?.kind === 'pickHero' ? prompt.legalHeroIds ?? [] : [];
    const guozhanCanConfirm = !!mainPick && !!deputyPick && mainPick !== deputyPick;

    if (isGuozhan) {
      return (
        <div className="draft">
          <div className="draft-title">选将阶段 · 国战</div>
          {options.length > 0 ? (
            <>
              <div className="hero-list">
                {options.map((id) => {
                  const h = getHero(id);
                  if (!h) return null;
                  const isMain = mainPick === id;
                  const isDeputy = deputyPick === id;
                  return (
                    <button
                      key={id}
                      className={`hero-card faction-${h.faction} ${isMain || isDeputy ? 'picked' : ''}`}
                      onClick={() => pickGuozhanHero(id)}
                    >
                      <div className="hero-name">
                        {h.name}
                      </div>
                      <div className="hero-hp">体力 {h.maxHp}</div>
                      <div className="hero-skills">
                        {h.skills.map((sk) => (
                          <div key={sk.name}>
                            <b>{sk.name}</b>
                          </div>
                        ))}
                      </div>
                      {isMain && <div className="hero-slot-tag">主将</div>}
                      {isDeputy && <div className="hero-slot-tag">副将</div>}
                    </button>
                  );
                })}
              </div>
              <button
                className="primary big"
                disabled={!guozhanCanConfirm}
                onClick={() => {
                  if (mainPick && deputyPick) pickHeroes(mainPick, deputyPick);
                }}
              >
                {guozhanCanConfirm
                  ? `确认：${getHero(mainPick)?.name ?? ''} + ${getHero(deputyPick)?.name ?? ''}`
                  : '请选择 2 位同阵营武将'}
              </button>
            </>
          ) : (
            <div className="hint">已选将，等待其他玩家…</div>
          )}
        </div>
      );
    }

    // 非国战：单选将
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
            const factionClass = isGuozhan && p.faction ? `faction-${p.faction}` : '';
            return (
              <div key={p.seatId} className={`player ${!p.isAlive ? 'dead' : ''} team-${p.team ?? 0} ${factionClass}`}>
                <div className="p-name">
                  {p.name}
                  {snapshot.mode === 'junzheng' && p.role && (
                    <span className={`role-badge role-${p.role}`}>{ROLE_NAME[p.role]}</span>
                  )}
                  {isGuozhan && p.faction && (
                    <span className={`faction-badge ${p.faction}`}>{FACTION_NAME[p.faction]}</span>
                  )}
                </div>
                <div className="p-hero">
                  {isGuozhan
                    ? `${hero?.name ?? '?'} / ${getHero(p.deputyHeroId)?.name ?? '?'}`
                    : (hero?.name ?? '?')}
                </div>
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
          const isTarget = !!selected && targetSet.has(p.seatId) && p.isAlive;
          const isCurrent = snapshot.turn.seatId === p.seatId;
          const isLord = p.role === 'lord';
          const teamClass = snapshot.mode === '2v2' ? `team-${p.team ?? 0}` : '';
          const factionClass = isGuozhan && p.faction ? `faction-${p.faction}` : '';
          return (
            <button
              key={p.seatId}
              className={`player ${isCurrent ? 'current' : ''} ${!p.isAlive ? 'dead' : ''} ${isTarget ? 'targetable' : ''} ${teamClass} ${factionClass}`}
              onClick={isTarget ? () => pickTarget(p.seatId) : undefined}
              disabled={!isTarget}
            >
              <div className="p-name">
                {p.name}
                {isCurrent && <span className="dot">●</span>}
                {isLord && p.isAlive && <span className="lord-tag">主</span>}
                {!p.isAlive && p.role && snapshot.mode === 'junzheng' && (
                  <span className={`role-badge role-${p.role}`}>{ROLE_NAME[p.role]}</span>
                )}
                {isGuozhan && p.faction && (
                  <span className={`faction-badge ${p.faction}`}>{FACTION_NAME[p.faction]}</span>
                )}
              </div>
              <div className="p-hero">{heroDisplay(p, snapshot.mode)}</div>
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
      <div className={`me-bar ${myTurn ? 'my-turn' : ''} ${snapshot.mode === '2v2' ? `team-${me.team ?? 0}` : ''} ${isGuozhan && me.faction ? `faction-${me.faction}` : ''}`}>
        <span className="me-name">{me.name}</span>
        {me.role && snapshot.mode === 'junzheng' && (
          <span className={`role-badge role-${me.role}`}>{ROLE_NAME[me.role]}</span>
        )}
        {isGuozhan && me.faction && (
          <span className={`faction-badge ${me.faction}`}>{FACTION_NAME[me.faction]}</span>
        )}
        {isGuozhan ? (
          <>
            <span className="me-hero">
              {myHero?.name ?? '?'}
              {!me.heroRevealed && '（暗）'}
            </span>
            <span className="me-hero-deputy">
              {myDeputyHero?.name ?? '?'}
              {!me.deputyRevealed && '（暗）'}
            </span>
          </>
        ) : (
          <span className="me-hero">{myHero?.name}</span>
        )}
        <span className="me-hp">
          体力 {me.hp}/{me.maxHp}
        </span>
        {/* 国战：出牌阶段亮将按钮 */}
        {isGuozhan && myTurn && prompt?.kind === 'play' && (
          <>
            {!me.heroRevealed && me.heroId && (
              <button className="ghost reveal-btn" onClick={() => revealHero(me.heroId!)}>
                亮主将
              </button>
            )}
            {!me.deputyRevealed && me.deputyHeroId && (
              <button className="ghost reveal-btn" onClick={() => revealHero(me.deputyHeroId!)}>
                亮副将
              </button>
            )}
          </>
        )}
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
