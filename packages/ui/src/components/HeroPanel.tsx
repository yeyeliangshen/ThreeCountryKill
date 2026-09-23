// 武将面板。
//
// 结构：
//   ┌─ 面板 ─────────────────────┐
//   │  群   ┌──────────────┐     │   左列上部：国家徽章 + 竖排武将名
//   │  华   │              │     │   右侧：原画（完整显示，不裁切）
//   │  佗   │     原画      │     │
//   │       │              │     │   面板高度 = 原画高度，原画下面不留白
//   │  ◆    └──────────────┘     │   左列下部：装备判定 + 竖排血量（压到底部）
//   │  ◆                         │
//   └───────────────────────────┘
// 技能不在这里——是左边独立的一列按钮（面板框外），见 SkillButtons.tsx。
// 不显示玩家自己的名字（甲/乙），只显示武将信息。
//
// 原画按 <武将 id>.jpg 放在 packages/ui/assets/heroes/ 下，见 heroArt.ts。
import { ROLE_NAME, FACTION_NAME } from '@sgs/engine';
import {
  cardDescription,
  cardShortName,
  type Card,
  type Faction,
  type GameMode,
  type PlayerView,
} from '@sgs/protocol';
import { EquipChip } from './EquipChip';
import { ChainBadge } from './ChainFx';
import { SkillTipChip } from './SkillTip';
import type { SkillTip } from '../skillTips';
import { equipSkillButtonOf } from '../equipSkill';
import { specialZoneChips } from '../specialZones';
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

export interface HeroPanelProps {
  me: PlayerView;
  mode: GameMode;
  slots: HeroSlot[];
  /** 可以把「自己」选成目标时（铁索连环），面板整体可点 */
  onSelect?: () => void;
  targetable?: boolean;
  picked?: boolean;
  /**
   * **装备区的牌可以当代价**时（技能声明了 `costFrom: 'handEquip'`，用户 2026-09-21 口径），
   * 把已装备的牌**点亮成可点按钮**：点一下就是选中它当代价。
   *
   * 为什么要单独开一个口：文本写「弃置一张**牌**」的技能，装备区里的那张也是合法选择——
   * 以前界面只让点手牌，玩家根本不知道装备能用（更别提去点它）。
   */
  equipPick?: {
    /** 现在能不能点（技能正在等着选代价牌） */
    selectable: boolean;
    /** 已经选中的牌 id（高亮用） */
    selectedIds: string[];
    onPick: (cardId: string) => void;
  };
  /**
   * 装备牌**自带可用主动技**时（目前只有【木牛流马】）：点这张装备牌＝发动那个技能。
   * 缺口背景见 `equipSkillButtonOf` 的注释（用户 2026-09-22：装了木牛流马点它没反应）。
   */
  equipUse?: {
    /** 服务端下发的可用技能 id 列表（`prompt.legalSkillIds`） */
    skillIds: readonly string[];
    onUse: (skillId: string) => void;
  };
  /**
   * 连环状态的进入 / 解除动画类与传导脉冲（用户 2026-09-24 口径①③④）。
   *
   * 只接受**算好的类名与延时**（判据与顺序都在 `chainState.ts` / `useChainFx` 里，
   * 见 `packages/ui/src/components/ChainFx.tsx`）——面板自己不判断连环状态，
   * 免得又变成第二套规则。`chained` 的常驻标记仍由 `me.chained` 直接决定。
   */
  chainFx?: {
    /** 贴在面板根上的动画类（`chain-in-a` / `chain-out-b` …）；没有就不传 */
    cls?: string;
    /** 传导脉冲：类名 + 延时（延时 = 引擎给的传导序号 × 步长） */
    hit?: { cls: string; delayMs: number };
  };
  /**
   * **我自己刚发动 / 刚触发的技能提示**（用户 2026-09-25 口径①~④）。
   *
   * 只接受上层算好的那一条（判据在 `ui/src/skillTips.ts`，组件是 `components/SkillTip.tsx`）——
   * 面板自己不判断「哪个技能该显示、什么时候收」，免得又变成第二套规则。
   * 对手那一行用的是同一个组件，只是挂在对方那张牌的右下角（见 Game.tsx 的 `.player-slot`）。
   */
  skillTip?: {
    tip: SkillTip;
    /** 发动者名（只用于无障碍播报） */
    seatName: string;
    /** 技能完整描述（来自引擎的武将技能文本） */
    desc: string;
    onToggle: () => void;
  };
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
      {...bind(
        `${slot.name}　体力 ${hp}/${maxHp}`,
        slot.hidden ? '国战暗将：亮将后才能使用技能。' : '',
      )}
    >
      {art ? (
        <img className="portrait-photo" src={art} alt={slot.name} />
      ) : (
        // 没有原画的武将（如中立「平民」）回退成名字占位
        <span className="portrait-name">{slot.name}</span>
      )}
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

export function HeroPanel({
  me,
  mode,
  slots,
  onSelect,
  targetable,
  picked,
  equipPick,
  equipUse,
  chainFx,
  skillTip,
}: HeroPanelProps) {
  const { bind, tipNode } = useHoverTip();
  const teamClass = mode === '2v2' ? `team-${me.team ?? 0}` : '';
  // 国战用玩家的阵营（可能是野心家），其他模式用武将自身的阵营
  const faction = mode === 'guozhan' ? me.faction : (slots[0]?.faction ?? null);
  const factionClass = mode === 'guozhan' && me.faction ? `faction-${me.faction}` : '';
  const zoneChips = specialZoneChips(me);

  return (
    <div
      className={`hero-panel ${teamClass} ${factionClass} ${me.isAlive ? '' : 'dead'} ${targetable ? 'targetable' : ''} ${picked ? 'picked-target' : ''} ${me.chained ? 'chained' : ''} ${chainFx?.cls ?? ''}`}
      onClick={onSelect}
    >
      {/* 连环传导的脉冲（口径④）：延时由引擎给的顺序算出来，逐棒在自己面板上闪一下。
          绝对定位 + `pointer-events: none`（见 styles.css），不占位、不挡点击。 */}
      {chainFx?.hit && (
        <span
          className={`chain-hit ${chainFx.hit.cls}`}
          style={{ animationDelay: `${chainFx.hit.delayMs}ms` }}
        />
      )}
      {/* 左列：顶部是国家徽章 + 竖排武将名，底部是装备判定 + 竖排血量 */}
      <div className="hero-info">
        {/* 特殊牌区（公开信息）：口径统一在 specialZones.ts —— 自己的面板与**对手那一行**
            共用同一份列表（以前只有自己的面板画，对手有几张「节」看不到）。 */}
        {zoneChips.length > 0 ? (
          <div className="special-zones">
            {zoneChips.map((c) => (
              <span key={c.key} className="zone-chip" {...bind(c.label.split('·')[0]!, c.tip)}>
                {c.label}
              </span>
            ))}
          </div>
        ) : null}
        <div className="hero-info-top">
          {me.role && mode === 'junzheng' && (
            <span className={`role-badge role-${me.role}`}>{ROLE_NAME[me.role]}</span>
          )}
          {faction && <span className={`faction-badge ${faction}`}>{FACTION_NAME[faction]}</span>}
          {/* ⚠️ 国战标记**不在这里放**（用户 2026-09-21）：它们已经和技能一起排在技能条上，
              在武将框里再放一份是重复信息。这里的「翻/横」是**状态**不是标记，留着。 */}
          {me.flipped && (
            <span
              className="marker-chip mark-flip"
              {...bind('翻面', '武将牌翻面朝上：跳过你的下一个回合，然后翻回正面。')}
            >
              翻
            </span>
          )}
          {/* 横置状态（铁索连环）：属性伤害会沿横置的角色蔓延。
              用户 2026-09-24：这枚徽标抽成了 `ChainBadge`（对手那一行现在也画同一枚），
              文案与提示词只有一处（ui/src/chainState.ts）。 */}
          {me.chained && <ChainBadge bind={bind} />}
        {/* 队列标记（与对手那一行同款）：自己也在队列里时要一眼看得出来 */}
        {me.inFormation && (
          <span
            className="queue-badge"
            {...bind('队列', '与相邻的同势力角色组成队列（阵法技的前提）')}
          >
            队
          </span>
        )}
          <span className="hi-name">{slots.map((s) => s.name).join(' + ')}</span>
        </div>

        {/* 底部：装备判定 + 血量（勾玉竖排，压到面板底部） */}
        <div className="hero-info-foot">
          {(me.equipment.length > 0 || me.judgment.length > 0) && (
            <span className="hero-zones">
              {me.equipment.map((c: Card) => {
                // 「自带可用主动技」的装备牌（木牛流马）：点它＝发动那个技能
                const useSkillId = equipUse
                  ? equipSkillButtonOf(c.equipName, equipUse.skillIds)
                  : null;
                if (useSkillId && !equipPick?.selectable) {
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className="equip-slot-use"
                      onClick={() => equipUse!.onUse(useSkillId)}
                    >
                      <EquipChip card={c} mode={mode} bind={bind} />
                    </button>
                  );
                }
                if (!equipPick?.selectable) {
                  return <EquipChip key={c.id} card={c} mode={mode} bind={bind} />;
                }
                const on = equipPick.selectedIds.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`equip-slot-pick ${on ? 'picked' : ''}`}
                    onClick={() => equipPick.onPick(c.id)}
                  >
                    <EquipChip card={c} mode={mode} bind={bind} />
                  </button>
                );
              })}
              {me.judgment.map((c: Card) => (
                <span
                  key={c.id}
                  className="judge-icon"
                  {...bind(cardShortName(c), cardDescription(c, mode))}
                >
                  {cardShortName(c)}
                </span>
              ))}
            </span>
          )}
          <span className="hi-hp">
            {Array.from({ length: me.maxHp }).map((_, i) => (
              <span key={i} className={`hp-cell ${i < me.hp ? 'on' : ''}`} />
            ))}
          </span>
        </div>
      </div>

      {/* 原画：按 1 : 1.415 完整显示，不裁切。高度决定面板高度 */}
      <div className="hero-portraits">
        {slots.map((s, i) => (
          <Portrait key={i} slot={s} hp={me.hp} maxHp={me.maxHp} bind={bind} />
        ))}
      </div>

      {tipNode}
      {/* 技能提示（口径①~④）：我自己发动的技能同样要看得见（别人有提示、自己没有会显得漏了）。
          挂在面板右下角，与对手那张牌上的提示同一个组件、同一套判据。 */}
      {skillTip && (
        <SkillTipChip
          tip={skillTip.tip}
          seatName={skillTip.seatName}
          desc={skillTip.desc}
          onToggle={skillTip.onToggle}
        />
      )}
    </div>
  );
}
