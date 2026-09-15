// 武将面板：画像占位框 + 体力 + 技能列表。
//
// 还没有武将画像，先用一个带阵营色的方框占位。等有图了，把 Portrait 里的
// <span className="portrait-art"> 换成 <img className="portrait-art" src=... /> 即可，
// 外面的框、阵营色、槽位标签都不用动。
import { ROLE_NAME, FACTION_NAME } from '@sgs/engine';
import {
  cardDescription,
  cardShortName,
  type Card,
  type Faction,
  type GameMode,
  type PlayerView,
} from '@sgs/protocol';

/** 一个武将占位（国战有主将 / 副将两个） */
export interface HeroSlot {
  name: string;
  faction: Faction | null;
  /** 国战未亮将 */
  hidden: boolean;
  /** 国战：'主将' / '副将'；其他模式为 null */
  slotLabel: string | null;
  /** 有值则显示「亮将」按钮 */
  onReveal?: () => void;
}

/** 技能列表里的一行 */
export interface SkillRow {
  name: string;
  desc: string;
  /** 现在能不能点（引擎的 legalSkillIds 说了算） */
  usable: boolean;
  /** 正在配置这个技能 */
  active: boolean;
  onClick: () => void;
}

export interface HeroPanelProps {
  me: PlayerView;
  mode: GameMode;
  slots: HeroSlot[];
  skills: SkillRow[];
}

function Portrait({ slot, big }: { slot: HeroSlot; big?: boolean }) {
  return (
    <div
      className={`portrait ${big ? 'big' : ''} ${slot.faction ? `faction-${slot.faction}` : ''} ${slot.hidden ? 'unrevealed' : ''}`}
    >
      {/* 画像位（暂无图，用名字占位） */}
      <span className="portrait-art">{slot.name}</span>
      {slot.hidden && <span className="portrait-dim">暗</span>}
      {slot.slotLabel && <span className="portrait-tag">{slot.slotLabel}</span>}
      {slot.onReveal && (
        <button className="portrait-reveal" onClick={slot.onReveal}>
          亮将
        </button>
      )}
    </div>
  );
}

export function HeroPanel({ me, mode, slots, skills }: HeroPanelProps) {
  const teamClass = mode === '2v2' ? `team-${me.team ?? 0}` : '';
  const factionClass = mode === 'guozhan' && me.faction ? `faction-${me.faction}` : '';
  return (
    <div className={`hero-panel ${teamClass} ${factionClass} ${me.isAlive ? '' : 'dead'}`}>
      <div className="hero-portraits">
        {slots.map((s, i) => (
          <Portrait key={i} slot={s} big />
        ))}
      </div>

      <div className="hero-side">
        <div className="hero-head">
          <span className="me-name">{me.name}</span>
          {me.role && mode === 'junzheng' && (
            <span className={`role-badge role-${me.role}`}>{ROLE_NAME[me.role]}</span>
          )}
          {mode === 'guozhan' && me.faction && (
            <span className={`faction-badge ${me.faction}`}>{FACTION_NAME[me.faction]}</span>
          )}
          <span className="hero-hp">
            {Array.from({ length: me.maxHp }).map((_, i) => (
              <span key={i} className={`hp-cell ${i < me.hp ? 'on' : ''}`} />
            ))}
            <span className="hero-hp-text">
              {me.hp}/{me.maxHp}
            </span>
          </span>
        </div>

        {(me.equipment.length > 0 || me.judgment.length > 0) && (
          <div className="hero-zones">
            {me.equipment.map((c: Card) => (
              <span
                key={c.id}
                className={`equip-icon equip-${c.type}`}
                title={`${cardShortName(c)}\n${cardDescription(c)}`}
              >
                {cardShortName(c)}
              </span>
            ))}
            {me.judgment.map((c: Card) => (
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

        {/* 技能：能用的时候点一下就发动 */}
        <div className="skill-list">
          {skills.length === 0 ? (
            <span className="skill-none">无技能</span>
          ) : (
            skills.map((sk) => (
              <button
                key={sk.name}
                className={`skill-row ${sk.usable ? 'usable' : ''} ${sk.active ? 'active' : ''}`}
                // 用 aria-disabled 而不是 disabled：禁用元素收不到鼠标事件，
                // 那样就没法悬停看技能说明了（和手牌同样的处理）
                aria-disabled={!sk.usable}
                onClick={() => {
                  if (!sk.usable) return;
                  sk.onClick();
                }}
              >
                <span className="sk-name">{sk.name}</span>
                <span className="sk-desc">{sk.desc}</span>
                {sk.usable && <span className="sk-go">{sk.active ? '取消' : '发动'}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
