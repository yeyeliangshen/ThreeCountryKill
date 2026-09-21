// 武将牌小卡（对手卡片上用）：国战显示**两张**（主将 / 副将），暗置那张只显示「暗」。
//
// 为什么单独抽一个组件（用户 2026-09-21）：
//   1. 对手面板原来只画了 `heroArt(p.heroId)` 一张图——**国战里看不全别人的两个将**，
//      副将整个是隐形的（名字只在不显示原画时才作为回退文案出现）；
//   2. 悬浮（手机上长按）要看得到**明置武将的技能效果**，所以每张小卡都挂 tooltip，
//      内容由 `heroChipsOf` 这个纯函数算出来（好测）。
import type { Faction, GameMode, PlayerView } from '@sgs/protocol';
import { getHero } from '@sgs/engine';
import { heroArt } from './heroArt';
import { useHoverTip } from './HoverTip';

/** 一张武将小卡要显示/提示的东西（纯数据，`heroChipsOf` 生成，便于单测） */
export interface HeroChipInfo {
  /** React key */
  key: string;
  /** 国战：'主将' / '副将'；其他模式 null */
  slotLabel: string | null;
  /** 显示名（暗置时是「暗」） */
  label: string;
  /** 有原画才画图；暗置时为 null */
  heroId: string | null;
  faction: Faction | null;
  hidden: boolean;
  /** tooltip 标题 */
  tipTitle: string;
  /** tooltip 正文（技能名 + 效果，一行一条） */
  tipDesc: string;
}

/** 暗置武将牌的提示文案：技能是暗信息，只能等亮将 */
const HIDDEN_TIP: [string, string] = ['暗将', '国战暗置的武将牌：亮将之后才能看到技能。'];

/** 把一名武将的技能整理成 tooltip 正文（一行一条；没技能也不留空） */
export function skillsTipDesc(hero: { skills: { name: string; desc: string }[] }): string {
  if (hero.skills.length === 0) return '（没有技能）';
  return hero.skills.map((s) => `【${s.name}】${s.desc}`).join('\n');
}

/** 一名（明置的）武将小卡的提示文案 */
function revealedChip(
  hero: {
    name: string;
    faction: Faction;
    secondFaction?: Faction;
    maxHp: number;
    skills: { name: string; desc: string }[];
  },
  slotLabel: string | null,
): { tipTitle: string; tipDesc: string } {
  const title = slotLabel ? `${hero.name}（${slotLabel}）` : hero.name;
  return { tipTitle: title, tipDesc: skillsTipDesc(hero) };
}

/**
 * 由玩家快照算出要画的武将小卡。
 *
 * 国战两张：明置的显示武将名（+ 技能提示），暗置只显示「暗」；
 * 其他模式一张（武将名照旧）。**这是公开信息**：PlayerView 里未明置的武将 id 本来就是 null。
 * 阵亡/游戏结束时服务端会把两张都置为已明置，于是自然两张都露出来。
 */
export function heroChipsOf(
  p: Pick<
    PlayerView,
    'seatId' | 'heroId' | 'deputyHeroId' | 'heroRevealed' | 'deputyRevealed'
  >,
  mode: GameMode,
): HeroChipInfo[] {
  const chipOf = (
    heroId: string | null | undefined,
    revealed: boolean | undefined,
    slotLabel: string | null,
    key: string,
  ): HeroChipInfo => {
    const hero = revealed && heroId ? getHero(heroId) : null;
    if (!hero) {
      return {
        key,
        slotLabel,
        label: '暗',
        heroId: null,
        faction: null,
        hidden: true,
        tipTitle: HIDDEN_TIP[0],
        tipDesc: HIDDEN_TIP[1],
      };
    }
    const { tipTitle, tipDesc } = revealedChip(hero, slotLabel);
    return {
      key,
      slotLabel,
      label: hero.name,
      heroId: heroId ?? null,
      faction: hero.faction,
      hidden: false,
      tipTitle,
      tipDesc,
    };
  };

  if (mode === 'guozhan') {
    return [
      chipOf(p.heroId, p.heroRevealed, '主将', `${p.seatId}-main`),
      chipOf(p.deputyHeroId, p.deputyRevealed, '副将', `${p.seatId}-deputy`),
    ];
  }
  return [chipOf(p.heroId, true, null, `${p.seatId}-hero`)];
}

/**
 * 画一排武将小卡。点按/长按（手机）都能看提示，见 HoverTip。
 * `onClick` 用于「点这张卡＝选中这名玩家」的场景（可以把自己选成目标时）。
 */
export function HeroChips({
  chips,
  onClick,
}: {
  chips: HeroChipInfo[];
  onClick?: () => void;
}) {
  const { bind, tipNode } = useHoverTip();
  return (
    <span className="p-heroes">
      {chips.map((c) => {
        const art = heroArt(c.heroId);
        return (
          <span
            key={c.key}
            className={`portrait small ${c.faction ? `faction-${c.faction}` : ''} ${c.hidden ? 'unrevealed' : ''}`}
            // 长按/悬浮出提示：明置武将给出技能名与效果；暗置给出「亮将后才能看到」
            {...bind(c.tipTitle, c.tipDesc)}
            onClick={onClick}
          >
            {art ? (
              <img className="portrait-photo" src={art} alt={c.label} />
            ) : (
              <span className="portrait-name">{c.hidden ? '暗' : c.label}</span>
            )}
            {c.hidden && <span className="portrait-dim">暗</span>}
            {c.slotLabel && <span className="portrait-tag">{c.slotLabel}</span>}
          </span>
        );
      })}
      {tipNode}
    </span>
  );
}
