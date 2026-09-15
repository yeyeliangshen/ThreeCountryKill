// 武将面板：原画 + 体力勾玉 + 技能名。
//
// 布局（自上而下）：
//   原画（没有原画时用占位框）—— 体力勾玉竖排叠在原画右上角
//   名字 / 身份阵营标记 / 装备区 / 判定区
//   技能名（只显示名字，悬停看效果；能发动时点一下就发动）
//
// 原画按 <武将 id>.jpg 放在 packages/ui/assets/heroes/ 下即可，见 heroArt.ts。
import { ROLE_NAME, FACTION_NAME } from '@sgs/engine';
import {
  cardDescription,
  cardShortName,
  type Card,
  type Faction,
  type GameMode,
  type PlayerView,
} from '@sgs/protocol';
import { heroArt } from './heroArt';
import { useHoverTip } from './HoverTip';

/** 一个武将占位（国战有主将 / 副将两个） */
export interface HeroSlot {
  /** 用于查原画；PlayerView 里可能为 undefined */
  heroId?: string | null;
  name: string;
  faction: Faction | null;
  /** 国战未亮将 */
  hidden: boolean;
  /** 国战：'主将' / '副将'；其他模式为 null */
  slotLabel: string | null;
  /** 有值则显示「亮将」按钮 */
  onReveal?: () => void;
}

/** 技能列表里的一项 */
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

function Portrait({
  slot,
  hp,
  maxHp,
  bind,
}: {
  slot: HeroSlot;
  hp: number;
  maxHp: number;
  bind: (title: string, desc: string) => Record<string, unknown>;
}) {
  const art = heroArt(slot.heroId);
  return (
    <div
      className={`portrait ${slot.faction ? `faction-${slot.faction}` : ''} ${slot.hidden ? 'unrevealed' : ''}`}
      {...bind(`${slot.name}　体力 ${hp}/${maxHp}`, slot.hidden ? '国战暗将：亮将后才能使用技能。' : '')}
    >
      {art ? (
        <img className="portrait-photo" src={art} alt={slot.name} />
      ) : (
        // 没有原画的武将（如中立「平民」）回退成名字占位
        <span className="portrait-name">{slot.name}</span>
      )}
      {slot.hidden && <span className="portrait-dim">暗</span>}
      {/* 体力：绿色勾玉，竖排在原画右上角 */}
      <span className="portrait-hp">
        {Array.from({ length: maxHp }).map((_, i) => (
          <span key={i} className={`hp-cell ${i < hp ? 'on' : ''}`} />
        ))}
      </span>
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
  const { bind, tipNode } = useHoverTip();
  const teamClass = mode === '2v2' ? `team-${me.team ?? 0}` : '';
  const factionClass = mode === 'guozhan' && me.faction ? `faction-${me.faction}` : '';
  return (
    <div className={`hero-panel ${teamClass} ${factionClass} ${me.isAlive ? '' : 'dead'}`}>
      <div className="hero-portraits">
        {slots.map((s, i) => (
          <Portrait key={i} slot={s} hp={me.hp} maxHp={me.maxHp} bind={bind} />
        ))}
      </div>

      <div className="hero-head">
        <span className="me-name">{me.name}</span>
        <span className="hero-names">{slots.map((s) => s.name).join(' + ')}</span>
        {me.role && mode === 'junzheng' && (
          <span className={`role-badge role-${me.role}`}>{ROLE_NAME[me.role]}</span>
        )}
        {mode === 'guozhan' && me.faction && (
          <span className={`faction-badge ${me.faction}`}>{FACTION_NAME[me.faction]}</span>
        )}
        <span className="hero-hp-text">
          {me.hp}/{me.maxHp}
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

      {/* 技能：只列名字，悬停看效果；能用的点一下就发动 */}
      <div className="skill-list">
        {skills.length === 0 ? (
          <span className="skill-none">无技能</span>
        ) : (
          skills.map((sk) => (
            <button
              key={sk.name}
              className={`skill-chip ${sk.usable ? 'usable' : ''} ${sk.active ? 'active' : ''}`}
              // 用 aria-disabled 而不是 disabled：禁用元素收不到鼠标事件，
              // 那样就没法悬停看技能说明了（和手牌同样的处理）
              aria-disabled={!sk.usable}
              {...bind(sk.name, sk.desc)}
              onClick={() => {
                if (!sk.usable) return;
                sk.onClick();
              }}
            >
              {sk.name}
            </button>
          ))
        )}
      </div>

      {tipNode}
    </div>
  );
}
