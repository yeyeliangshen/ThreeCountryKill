import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card } from '@sgs/protocol';
import { effectiveCardName, needsTargetPick, playConfirmText, playHintText } from './playFlow';

/**
 * 出牌的**两步流程**（用户 2026-09-25 报的缺陷，见 docs/guozhan-roster.md §5.210）：
 * 手牌区单击只**选中并展示**，再点「使用/确定」才正式打出——【无中生有】这类
 * **无需选择目标**的牌也不例外。
 *
 * 改动前的毛病出在 `Game.tsx` 的 `beginPlay()`：它按目标数分流，`range.max === 0` 就
 * **直接 `sendIntent({ type: 'playCard' })`**（「不需要目标」被当成了「可以省掉确认」），
 * 于是点一下【无中生有】就立即生效、不可撤销。这里把「无需目标也要两步」的文案与
 * 「那条捷径不许回来」都钉成用例。
 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const card = (type: Card['type'], extra?: Partial<Card>): Card =>
  ({ id: 'c1', type, suit: 'heart', rank: 1, ...extra }) as Card;

describe('无需目标的牌也必须走两步：文案分得清「选中」与「打出」', () => {
  it('「要不要点目标」只看目标区间（无中生有/桃源/五谷/南蛮/万箭/酒/装备 都是 0）', () => {
    expect(needsTargetPick(0, 0)).toBe(false);
    for (const [min, max] of [
      [1, 1],
      [1, 2],
      [2, 2],
      [1, 99],
    ] as const) {
      expect(needsTargetPick(min, max), `${min}-${max}`).toBe(true);
    }
  });

  it('【无中生有】这种 0 目标牌：按钮写「使用【无中生有】」，不是空目标的「确认：对 …」', () => {
    const label = playConfirmText('无中生有', []);
    expect(label).toBe('使用【无中生有】');
    // 改动前那条捷径留下的痕迹：没选目标时渲染出「确认：对  使用【X】」（两个空格之间是空的）
    expect(label).not.toContain('对');
    expect(label).not.toContain('  ');
  });

  it('需要目标的牌文案照旧（不许退化）：有目标写清对谁用、还没点人时不说「对」', () => {
    expect(playConfirmText('杀', ['甲', '乙'])).toBe('确认：对 甲、乙 使用【杀】');
    expect(playConfirmText('杀', [])).toBe('使用【杀】');
  });

  it('0 目标牌的提示指向按钮（点「使用」打出），而不是「请选择目标」', () => {
    const hint = playHintText({
      name: '无中生有',
      min: 0,
      max: 0,
      targetNames: [],
      canTargetSelf: false,
    });
    expect(hint).toContain('已选中【无中生有】');
    expect(hint, '要告诉玩家下一步点哪儿（触屏没有 hover）').toContain('使用');
    expect(hint, '不能再说「请选择目标」——它没有目标可选').not.toContain('请选择目标');
  });

  it('需要目标的提示一字未改（够目标 / 两名目标 / 多选 / 单目标四支都在）', () => {
    const base = { name: '杀', max: 1, canTargetSelf: false };
    expect(playHintText({ ...base, min: 1, targetNames: ['甲'] })).toBe(
      '目标：甲 —— 点「确认」发出',
    );
    expect(playHintText({ ...base, min: 1, targetNames: [] })).toBe(
      '请选择目标（点上方对手，选完再点确认）',
    );
    expect(playHintText({ ...base, min: 2, max: 2, targetNames: ['甲'] })).toBe('请选择出杀目标');
    expect(playHintText({ ...base, min: 2, max: 2, targetNames: ['武', '甲'] })).toContain(
      '第 1 个是武器持有者',
    );
    expect(playHintText({ ...base, min: 1, max: 2, targetNames: [] })).toContain(
      '请选择 1 至 2 名目标',
    );
    expect(
      playHintText({ ...base, min: 1, max: 2, targetNames: [], canTargetSelf: true }),
    ).toContain('可含自己');
  });

  it('牌名按**生效牌型**取（转化牌给转化后那张的名字：武圣的红牌当【杀】）', () => {
    expect(effectiveCardName(card('wuzhong'))).toBe('无中生有');
    expect(effectiveCardName(card('shan'), 'sha')).toBe('杀');
    // 没用转化时照旧读牌面（装备读装备名）
    expect(effectiveCardName(card('sha'), 'sha')).toBe('杀');
  });
});

/**
 * 静态守门：**「无需目标 ⇒ 点击直接 playCard」这条捷径不许回来**。
 *
 * 这是本次缺陷的根因所在——`beginPlay()` 里那条 `range.max === 0` 分支。
 * 用例把「出牌只剩一条路（先选中、再由确认按钮发出）」钉在源码上：谁要是再加一条
 * 「特殊牌不用确认」的分支，这里当场红。
 */
describe('Game.tsx：出牌只有「选中 → 使用/确定」一条路', () => {
  const src = readFileSync(join(__dirname, 'pages', 'Game.tsx'), 'utf8');
  const beginPlay = stripComments(
    src.slice(src.indexOf('function beginPlay('), src.indexOf('function beginRecast(')),
  );
  /** `confirmTargets()`：选中态那个按钮的处理函数，唯一一处发出 playCard 的地方 */
  const confirmTargets = stripComments(
    src.slice(src.indexOf('function confirmTargets('), src.indexOf('function pickRespondCard(')),
  );

  it('beginPlay 里**没有任何** sendIntent / 按目标数分流的捷径（一律 setSelected）', () => {
    expect(beginPlay, 'beginPlay 必须找到').not.toBe('');
    expect(beginPlay).toContain('setSelected(');
    expect(beginPlay, '无需目标的牌不许在这里直接发出去').not.toContain('sendIntent(');
    expect(beginPlay, '那条 max === 0 的捷径必须删干净').not.toContain('range.max === 0');
  });

  it('整个文件的 playCard 只有确认那一次（出牌路径收敛成一条）', () => {
    const body = stripComments(src);
    expect(body.match(/type: 'playCard'/g) ?? []).toHaveLength(1);
    expect(confirmTargets).toContain("type: 'playCard'");
    // 目标为空也照发（无需目标的牌就是空目标）：这正是它同时服务于两类牌的凭据
    expect(confirmTargets).toContain('targetIds: selected.picked');
  });

  it('确认按钮与「取消」就渲染在选中态那一块里，用的还是同一套选中态', () => {
    expect(src).toContain('playConfirmText(');
    expect(src).toContain('playHintText(');
    // 选中态块：提示 + 确认按钮（文案走 playConfirmText）+「取消」把选中态清掉
    const block = src.slice(
      src.indexOf("{selected && prompt.kind === 'play' && ("),
      src.indexOf('{/* 诸葛恪·【傲才】'),
    );
    expect(block).toContain('selectedHint()');
    expect(block).toContain('onClick={confirmTargets}');
    expect(block).toContain('selectedConfirmLabel()');
    expect(block).toContain('setSelected(null)');
  });

  it('那次「生效前确认」的老弹框（confirmUse）已删干净，避免两条出牌路径', () => {
    // 注释里留了迁移说明，所以只看**代码**（去掉注释后不该再有这个状态）
    expect(stripComments(src)).not.toContain('confirmUse');
    expect(stripComments(src)).not.toContain('use-confirm');
  });

  it('手牌点击仍然只到「选中」为止：play 阶段走 pickPlayCard（第二步交给按钮）', () => {
    expect(src).toContain("if (prompt.kind === 'play') pickPlayCard(card);");
    // 再点同一张牌＝取消（两步流程里点两下不该把牌打出去）
    expect(src).toContain('function pickPlayCard(card: Card)');
    const pick = stripComments(
      src.slice(src.indexOf('function pickPlayCard('), src.indexOf('function pickTarget(')),
    );
    expect(pick).toContain('setSelected(null)');
    expect(pick, 'pickPlayCard 不许直接出牌').not.toContain('sendIntent(');
  });
});
