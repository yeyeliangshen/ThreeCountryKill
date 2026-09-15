import { useEffect, useRef, useState } from 'react';
import {
  SUIT_NAME, SUIT_SYMBOL, rankLabel, cardLabel, cardShortName, cardDescription,
  isRed, isBasicCard, isEquipCard, isInstantTrick, isDelayedTrick,
  type Card, type CardType, type Faction, type GameMode, type PlayerView, type Snapshot,
} from '@sgs/protocol';
import {
  getHero,
  getHeroForMode,
  heroCanUseAs,
  ROLE_NAME,
  FACTION_NAME,
  type Hero,
  type ActiveSkill,
} from '@sgs/engine';
import { HeroPanel, type HeroSlot } from '../components/HeroPanel';
import { SkillButtons, type SkillRow } from '../components/SkillButtons';
import { heroArt } from '../components/heroArt';
import { useHoverTip } from '../components/HoverTip';
import { useStore } from '../store';

const PHASE_NAME: Record<string, string> = {
  judgment: '判定',
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

/** 出牌阶段：这张牌需要选几个目标 */
function targetCount(card: Card): number {
  if (isEquipCard(card)) return 0;
  if (card.type === 'tao' || card.type === 'jiu') return 0;
  if (card.type === 'wuzhong' || card.type === 'taoyuan') return 0;
  if (card.type === 'shandian') return 0;
  if (card.type === 'nanman' || card.type === 'wanjian') return 0;
  if (card.type === 'jiedao') return 2;
  return 1; // sha, juedou, guohe, shunshou, huogong, lebu, bingliang
}

/** 这张牌能否在出牌阶段直接使用（无需转化） */
function isDirectlyPlayable(card: Card): boolean {
  if (card.type === 'sha' || card.type === 'tao' || card.type === 'jiu') return true;
  if (isEquipCard(card)) return true;
  if (isDelayedTrick(card)) return true;
  if (isInstantTrick(card) && card.type !== 'wuxie') return true;
  return false;
}

/** 从快照获取当前玩家的活跃武将（国战：已亮将；其他：主将） */
function getMyActiveHeroes(me: PlayerView, mode: GameMode): Hero[] {
  const isGuozhan = mode === 'guozhan';
  if (isGuozhan) {
    const heroes: Hero[] = [];
    if (me.heroRevealed && me.heroId) {
      const h = getHeroForMode(me.heroId, mode);
      if (h) heroes.push(h);
    }
    if (me.deputyRevealed && me.deputyHeroId) {
      const h = getHeroForMode(me.deputyHeroId, mode);
      if (h) heroes.push(h);
    }
    return heroes;
  }
  // 非国战也必须按模式取：同一个武将国战/军争的技能不一样
  const h = getHeroForMode(me.heroId, mode);
  return h ? [h] : [];
}

/** 国战鏖战状态：仅 2 个非野心家阵营存活 */
function isAoyuMode(snapshot: Snapshot): boolean {
  if (snapshot.mode !== 'guozhan') return false;
  const alive = snapshot.players.filter((p) => p.isAlive);
  const factions = new Set(
    alive.map((p) => p.faction).filter((f): f is Faction => !!f && f !== 'ambitionist'),
  );
  return factions.size === 2;
}

/** 出牌阶段：确定牌的 `as` 转化类型 */
function cardAsType(card: Card, heroes: Hero[], aoyu: boolean): CardType | undefined {
  if (isDirectlyPlayable(card)) return undefined;
  const conversions: CardType[] = ['sha', 'guohe', 'tao', 'shan'];
  for (const type of conversions) {
    if (heroes.some((h) => heroCanUseAs(h, card, type))) return type;
  }
  if (aoyu && card.type === 'tao') return 'sha';
  return undefined;
}

/** 从武将列表中查找技能定义 */
function findSkill(heroes: Hero[], skillId: string): ActiveSkill | undefined {
  for (const h of heroes) {
    const sk = h.activeSkills?.find((s) => s.id === skillId);
    if (sk) return sk;
  }
  return undefined;
}

export function Game() {
  const snapshot = useStore((s) => s.snapshot);
  const sendIntent = useStore((s) => s.sendIntent);
  const pickHero = useStore((s) => s.pickHero);
  const pickHeroes = useStore((s) => s.pickHeroes);
  const revealHero = useStore((s) => s.revealHero);
  const useSkill = useStore((s) => s.useSkill);

  // 出牌阶段：选中一张需目标的牌后，再选目标
  const [selected, setSelected] = useState<{
    cardId: string;
    as?: CardType;
    need: number;
    picked: string[];
  } | null>(null);
  // 弃牌阶段：已选待弃的牌
  const [picks, setPicks] = useState<string[]>([]);
  // 选将阶段：已选中但未确认的武将（防误触）
  const [pickedHero, setPickedHero] = useState<string | null>(null);
  // 国战选将：主将 + 副将
  const [mainPick, setMainPick] = useState<string | null>(null);
  const [deputyPick, setDeputyPick] = useState<string | null>(null);
  // 主动技能交互模式
  const [skillMode, setSkillMode] = useState<{
    skillId: string;
    skill: ActiveSkill;
    cardIds: string[];
    targetIds: string[];
  } | null>(null);
  // 手牌悬停提示（固定定位，避免被 .hand 的滚动容器裁切）。
  // 武将技能用的是同一套，见 components/HoverTip.tsx
  const { bind: bindTip, hide: hideTip, tipNode } = useHoverTip();

  // 提示一变就清空本地选择
  useEffect(() => {
    setSelected(null);
    setPicks([]);
    setPickedHero(null);
    setMainPick(null);
    setDeputyPick(null);
    setSkillMode(null);
  }, [snapshot?.prompt]);

  // 出牌记录：新事件滚到底，否则最新一条可能在可视区外
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = logBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [snapshot?.log]);

  if (!snapshot) return <div className="game loading">加载中…</div>;

  const me = snapshot.players.find((p) => p.seatId === snapshot.seatId)!;
  // 技能说明要按模式取：国战与军争的同名技能描述不同
  const myHero = getHeroForMode(me.heroId, snapshot.mode);
  const myDeputyHero = getHeroForMode(me.deputyHeroId, snapshot.mode);
  const others = snapshot.players.filter((p) => p.seatId !== snapshot.seatId);
  const prompt = snapshot.prompt;
  const legalSet = new Set(prompt?.legalCardIds ?? []);
  const targetSet = new Set(prompt?.legalTargetIds ?? []);
  const myTurn = snapshot.turn.seatId === snapshot.seatId;
  const isGameOver = snapshot.turn.phase === 'gameOver' && snapshot.winner !== null;
  const isGuozhan = snapshot.mode === 'guozhan';
  const aoyu = isAoyuMode(snapshot);
  const myHeroes = getMyActiveHeroes(me, snapshot.mode);
  const skillIds = prompt?.kind === 'play' ? prompt.legalSkillIds ?? [] : [];

  // —— 出牌：选中需目标的牌 ——
  function pickPlayCard(card: Card) {
    if (!prompt || prompt.kind !== 'play' || !legalSet.has(card.id)) return;
    const need = targetCount(card);
    if (need === 0) {
      // 无需目标：直接出
      const as = cardAsType(card, myHeroes, aoyu);
      sendIntent({
        type: 'playCard',
        cardId: card.id,
        ...(as ? { as } : {}),
        targetIds: [],
      });
      return;
    }
    // 需目标：进入选择模式
    const as = cardAsType(card, myHeroes, aoyu);
    setSelected({ cardId: card.id, ...(as ? { as } : {}), need, picked: [] });
  }

  function pickTarget(targetId: string) {
    if (!selected) return;
    const next = [...selected.picked, targetId];
    if (next.length < selected.need) {
      // 还需继续选目标
      setSelected({ ...selected, picked: next });
      return;
    }
    // 目标选满 → 发送
    sendIntent({
      type: 'playCard',
      cardId: selected.cardId,
      ...(selected.as ? { as: selected.as } : {}),
      targetIds: next,
    });
    setSelected(null);
  }

  // —— 响应杀/濒死/锦囊/无懈：直接出牌（引擎自动检测转化） ——
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

  // —— 主动技能交互 ——
  function enterSkillMode(skillId: string) {
    const skill = findSkill(myHeroes, skillId);
    if (!skill) return;
    setSkillMode({ skillId, skill, cardIds: [], targetIds: [] });
  }
  function toggleSkillCard(cardId: string) {
    if (!skillMode) return;
    setSkillMode((prev) => {
      if (!prev) return prev;
      const has = prev.cardIds.includes(cardId);
      // 上限由技能自己给（国战·制衡 = 体力上限，苦肉/离间/反间 = 1），
      // 不在客户端按技能 id 硬编码——否则两边各写一套上限迟早对不上
      const maxCards = prev.skill.maxCards?.({ maxHp: me.maxHp, handCount: me.handCount }) ?? 99;
      if (has) return { ...prev, cardIds: prev.cardIds.filter((c) => c !== cardId) };
      if (prev.cardIds.length >= maxCards) return prev;
      return { ...prev, cardIds: [...prev.cardIds, cardId] };
    });
  }
  function toggleSkillTarget(targetId: string) {
    if (!skillMode) return;
    setSkillMode((prev) => {
      if (!prev) return prev;
      const has = prev.targetIds.includes(targetId);
      const { minTargets, maxTargets } = prev.skill;
      if (has) return { ...prev, targetIds: prev.targetIds.filter((t) => t !== targetId) };
      if (prev.targetIds.length >= maxTargets) return prev;
      return { ...prev, targetIds: [...prev.targetIds, targetId] };
    });
  }
  function confirmSkill() {
    if (!skillMode) return;
    const { skillId, cardIds, targetIds } = skillMode;
    useSkill(skillId, cardIds, targetIds);
    setSkillMode(null);
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

  // 判定当前选中牌的目标提示文案
  function selectedHint(): string {
    if (!selected) return '';
    if (selected.need === 2) {
      if (selected.picked.length === 0) return '请选择武器持有者';
      return '请选择出杀目标';
    }
    return '请选择目标（点上方对手）';
  }

  // 技能确认按钮是否可用
  function skillCanConfirm(): boolean {
    if (!skillMode) return false;
    const { skill, cardIds, targetIds } = skillMode;
    const cardsOk = !skill.needsCards || cardIds.length >= 1;
    const targetsOk = targetIds.length >= skill.minTargets && targetIds.length <= skill.maxTargets;
    return cardsOk && targetsOk;
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

  // 是否处于"选目标"或"技能模式"的交互态
  const targeting = !!selected || !!skillMode;

  // 判断某对手是否可被点击（选目标 / 技能选目标）
  function canClickTarget(p: PlayerView): boolean {
    if (!p.isAlive) return false;
    if (!targeting) return false;
    if (skillMode) {
      if (skillMode.targetIds.includes(p.seatId)) return true;
      return targetSet.has(p.seatId) && skillMode.targetIds.length < skillMode.skill.maxTargets;
    }
    if (selected) {
      if (selected.picked.includes(p.seatId)) return true;
      return targetSet.has(p.seatId) && selected.picked.length < selected.need;
    }
    return false;
  }

  function handleTargetClick(p: PlayerView) {
    if (skillMode) {
      toggleSkillTarget(p.seatId);
      return;
    }
    if (selected) {
      if (selected.picked.includes(p.seatId)) return; // 已选
      pickTarget(p.seatId);
    }
  }

  // —— 武将面板：原画 + 体力勾玉 + 技能名 ——
  const canRevealNow = myTurn && prompt?.kind === 'play' && !skillMode && !selected;
  const heroSlots: HeroSlot[] = isGuozhan
    ? [
        {
          heroId: me.heroId,
          name: myHero?.name ?? '?',
          faction: myHero?.faction ?? null,
          hidden: !me.heroRevealed,
          slotLabel: '主将',
          onReveal:
            canRevealNow && !me.heroRevealed && me.heroId
              ? () => revealHero(me.heroId!)
              : undefined,
        },
        {
          heroId: me.deputyHeroId,
          name: myDeputyHero?.name ?? '?',
          faction: myDeputyHero?.faction ?? null,
          hidden: !me.deputyRevealed,
          slotLabel: '副将',
          onReveal:
            canRevealNow && !me.deputyRevealed && me.deputyHeroId
              ? () => revealHero(me.deputyHeroId!)
              : undefined,
        },
      ]
    : [
        {
          heroId: me.heroId,
          name: myHero?.name ?? '?',
          faction: myHero?.faction ?? null,
          hidden: false,
          slotLabel: null,
        },
      ];

  // 列出国战主副将的全部技能，主动技能在可用时可点发动。
  // 暗将的技能不会出现在 legalSkillIds 里（引擎按亮将状态过滤 activeHeroes），
  // 所以会显示成不可点——正好提示玩家得先亮将。
  const skillRows: SkillRow[] = [];
  for (const hero of isGuozhan ? [myHero, myDeputyHero] : [myHero]) {
    if (!hero) continue;
    for (const s of hero.skills) {
      const act = hero.activeSkills?.find((a) => a.name === s.name);
      const active = !!act && skillMode?.skillId === act.id;
      skillRows.push({
        name: s.name,
        desc: s.desc,
        usable: !!act && skillIds.includes(act.id) && !selected && (!skillMode || active),
        active,
        onClick: () => {
          if (!act) return;
          if (active) setSkillMode(null);
          else enterSkillMode(act.id);
        },
      });
    }
  }

  return (
    <div className="game">
      {/* 左栏：牌桌（对手 / 操作 / 手牌）。窄屏时这层容器消失，直接排单列 */}
      <div className="board">
        {/* 其他玩家 */}
        <div className="players-row">
        {others.map((p) => {
          const isTarget = canClickTarget(p);
          const isPickedTarget = targeting && (
            (selected?.picked.includes(p.seatId)) ||
            (skillMode?.targetIds.includes(p.seatId))
          );
          const isCurrent = snapshot.turn.seatId === p.seatId;
          const isLord = p.role === 'lord';
          const teamClass = snapshot.mode === '2v2' ? `team-${p.team ?? 0}` : '';
          const factionClass = isGuozhan && p.faction ? `faction-${p.faction}` : '';
          const art = heroArt(p.heroId);
          return (
            <button
              key={p.seatId}
              className={`player ${isCurrent ? 'current' : ''} ${!p.isAlive ? 'dead' : ''} ${isTarget ? 'targetable' : ''} ${isPickedTarget ? 'picked-target' : ''} ${teamClass} ${factionClass}`}
              onClick={isTarget ? () => handleTargetClick(p) : undefined}
              disabled={!isTarget}
            >
              <div className="p-top">
                {/* 画像占位框，和我自己的武将面板同一套视觉 */}
                {/* 小头像：对手原画（没原画时回退成武将名） */}
                <span className={`portrait small ${factionClass}`}>
                  {art ? (
                    <img className="portrait-photo" src={art} alt="" />
                  ) : (
                    <span className="portrait-name">{heroDisplay(p, snapshot.mode)}</span>
                  )}
                </span>
                <span className="p-info">
                  <span className="p-name">
                    {p.name}
                    {isCurrent && <span className="dot">●</span>}
                    {isLord && p.isAlive && <span className="lord-tag">主</span>}
                    {!p.isAlive && p.role && snapshot.mode === 'junzheng' && (
                      <span className={`role-badge role-${p.role}`}>{ROLE_NAME[p.role]}</span>
                    )}
                    {isGuozhan && p.faction && (
                      <span className={`faction-badge ${p.faction}`}>{FACTION_NAME[p.faction]}</span>
                    )}
                  </span>
                  <span className="p-hp">
                    {Array.from({ length: p.maxHp }).map((_, i) => (
                      <span key={i} className={`hp-cell ${i < p.hp ? 'on' : ''}`} />
                    ))}
                  </span>
                  <span className="p-hand">手 {p.handCount}</span>
                </span>
              </div>
              {/* 装备区 */}
              {p.equipment.length > 0 && (
                <div className="p-equip">
                  {p.equipment.map((c) => (
                    <span
                      key={c.id}
                      className={`equip-icon equip-${c.type}`}
                      title={`${cardShortName(c)}\n${cardDescription(c)}`}
                    >
                      {cardShortName(c)}
                    </span>
                  ))}
                </div>
              )}
              {/* 判定区 */}
              {p.judgment.length > 0 && (
                <div className="p-judge">
                  {p.judgment.map((c) => (
                    <span
                      key={c.id}
                      className="judge-icon"
                      title={`${cardShortName(c)}\n${cardDescription(c)}`}
                    >
                      {cardShortName(c)}
                    </span>
                  ))}
                </div>
              )}
              {!p.isAlive && <div className="p-dead">阵亡</div>}
            </button>
          );
        })}
        </div>

        {/* 提示/操作区 */}
      {prompt ? (
        <div className={`prompt prompt-${prompt.kind}`}>
          <div className="prompt-msg">{prompt.message}</div>

          {/* 出牌阶段：结束出牌（主动技能在武将面板里发动） */}
          {prompt.kind === 'play' && !skillMode && !selected && (
            <>
              <button className="ghost" onClick={() => sendIntent({ type: 'endPhase' })}>
                结束出牌
              </button>
            </>
          )}

          {/* 技能交互模式 */}
          {prompt.kind === 'play' && skillMode && (
            <div className="skill-mode">
              <span className="hint">
                【{skillMode.skill.name}】
                {skillMode.skill.needsCards && skillMode.cardIds.length === 0 && ' · 请选择手牌'}
                {skillMode.skill.minTargets > 0 && skillMode.targetIds.length < skillMode.skill.minTargets && ` · 请选${skillMode.skill.minTargets - skillMode.targetIds.length > 0 ? '目标' : ''}目标`}
              </span>
              <button
                className="primary"
                disabled={!skillCanConfirm()}
                onClick={confirmSkill}
              >
                确认技能
              </button>
              <button className="ghost" onClick={() => setSkillMode(null)}>
                取消
              </button>
            </div>
          )}

          {/* 选目标提示 */}
          {selected && prompt.kind === 'play' && (
            <span className="hint">{selectedHint()}</span>
          )}

          {/* 弃权按钮（响应类提示） */}
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
          {prompt.kind === 'respondTrick' && (
            <button className="ghost" onClick={() => sendIntent({ type: 'pass' })}>
              弃权
            </button>
          )}
          {prompt.kind === 'wuxieQueue' && (
            <button className="ghost" onClick={() => sendIntent({ type: 'pass' })}>
              不使用
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
          const isSkillCard = !!skillMode && skillMode.cardIds.includes(card.id);
          const fireClass = card.type === 'sha' && card.attribute === 'fire' ? 'fire-attr' : '';
          const thunderClass = card.type === 'sha' && card.attribute === 'thunder' ? 'thunder-attr' : '';
          // 牌面底部的分类色条：基本牌 / 锦囊 / 延时锦囊 / 装备
          const catClass = isEquipCard(card)
            ? 'cat-equip'
            : isDelayedTrick(card)
              ? 'cat-delayed'
              : isInstantTrick(card)
                ? 'cat-trick'
                : 'cat-basic';
          const name = cardShortName(card);
          // 技能模式下需要选手牌 → 全手牌可点
          const skillCardClickable = !!skillMode && skillMode.skill.needsCards;
          const cardDisabled = skillMode ? !skillCardClickable : !legal;
          return (
            <button
              key={card.id}
              className={`card ${isRed(card) ? 'red' : 'black'} ${legal ? 'legal' : 'dim'} ${isPick ? 'picked' : ''} ${isSkillCard ? 'picked' : ''} ${fireClass} ${thunderClass} ${catClass}`}
              aria-disabled={cardDisabled}
              aria-label={cardLabel(card)}
              onMouseEnter={bindTip(
                `${SUIT_NAME[card.suit]}${rankLabel(card.rank)} · ${name}`,
                cardDescription(card),
              ).onMouseEnter}
              onMouseLeave={hideTip}
              onClick={() => {
                if (cardDisabled) return;
                if (!prompt) return;
                if (skillMode) {
                  if (skillCardClickable) toggleSkillCard(card.id);
                  return;
                }
                if (prompt.kind === 'pickHero') return;
                if (prompt.kind === 'play') pickPlayCard(card);
                else if (prompt.kind === 'discard') togglePick(card.id);
                else pickRespondCard(card);
              }}
            >
              {/* 左上角标：点数 + 花色。闪电/乐不思蜀/兵粮寸断都靠花色点数判定，
                  所以这两项必须直接看得见 */}
              <span className="c-idx">
                <span className="c-rank">{rankLabel(card.rank)}</span>
                <span className="c-suit">{SUIT_SYMBOL[card.suit]}</span>
              </span>
              <span className="c-name">
                <span className={name.length >= 5 ? 'long' : undefined}>{name}</span>
              </span>
            </button>
          );
        })}
      </div>
      </div>

      {/* 右栏：技能列在左边，右边是出牌记录 + 武将面板。
          这样记录和面板同宽（都在 .side-main 里），技能又在面板框左侧。
          窄屏时两层容器消失，按 order 排成单列 */}
      <aside className="side">
        <SkillButtons skills={skillRows} />

        <div className="side-main">
          {/* 出牌记录 */}
          <div className="center">
            <div className="turn-info">
              [{MODE_NAME[snapshot.mode]}]{' '}
              {snapshot.players.find((p) => p.seatId === snapshot.turn.seatId)?.name} 的回合 ·{' '}
              {PHASE_NAME[snapshot.turn.phase] ?? snapshot.turn.phase}
            </div>
            <div className="log" ref={logBoxRef}>
              {snapshot.log
                .slice(-40)
                .map((l) => (
                  <div key={l.id} className={`log-line log-${l.kind}`}>
                    {l.message}
                  </div>
                ))}
            </div>
          </div>

          {/* 武将面板 */}
          <HeroPanel me={me} mode={snapshot.mode} slots={heroSlots} />
        </div>
      </aside>

      {tipNode}
    </div>
  );
}
