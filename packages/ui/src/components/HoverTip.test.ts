/**
 * **说明浮层的交互判据**（用户 2026-09-25 口径，手机端那条是这次修的）：
 *
 * > 手机端点击武将技能、装备、卡牌等对象查看效果时，应弹出对应的说明信息；再次点击其他对象时
 * > 切换为新对象的信息。同时应支持点击牌桌空白区域立即关闭当前说明弹层…说明 UI 不应长期固定
 * > 在牌桌中央，也不应阻塞正常的选牌、选目标和响应操作。
 *
 * 仓库没有 jsdom（不能模拟 touch/click），所以这里分两层：
 * - **纯函数直测**：`tipPlacement`（夹进视口 + 上方放不下就翻到下方）；
 * - **源码守门**：把「同时只有一条说明」「点空白就关（捕获阶段）」「点一下即开 / 再点即收」
 *   「说明不吃指针」「手牌不许只挂鼠标那一半」这些结构性约定钉死。
 *
 * ⚠️ 带「改动前 ✗」的用例在本轮修复前必红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tipPlacement, HOVER_TIP_WIDTH } from './HoverTip';

const uiSrc = join(__dirname, '..', '..', 'src');
const read = (...p: string[]): string => readFileSync(join(__dirname, '..', ...p), 'utf8');
const hover = read('components', 'HoverTip.tsx');
const game = read('pages', 'Game.tsx');
const skillTip = read('components', 'SkillTip.tsx');
const css = readFileSync(join(uiSrc, 'styles.css'), 'utf8');

describe('仰位（tipPlacement）：夹进视口 + 上方放不下就翻到下方', () => {
  const vp = { width: 390, height: 844 };

  it('正常情况下挂在元素上方、水平居中（改动前 ✗：那时只有一个固定公式）', () => {
    const p = tipPlacement({ left: 160, right: 240, top: 400, bottom: 470, width: 80 }, vp);
    expect(p.below).toBe(false);
    expect(p.y).toBe(400);
    expect(p.x).toBe(200);
  });

  it('贴着屏幕上沿的元素 ⇒ 翻到下方（改动前 ✗：说明会被顶出屏幕＝「点了没反应」）', () => {
    const p = tipPlacement({ left: 100, right: 180, top: 8, bottom: 70, width: 80 }, vp);
    expect(p.below, '手机顶部那一排对手的牌').toBe(true);
    expect(p.y).toBe(70);
  });

  it('贴着左右边缘 ⇒ 夹在视口内（改动前 ✗：说明会横向跑出去一半）', () => {
    const left = tipPlacement({ left: 0, right: 40, top: 400, bottom: 470, width: 40 }, vp);
    expect(left.x).toBeGreaterThanOrEqual(HOVER_TIP_WIDTH / 2);
    const right = tipPlacement({ left: 370, right: 390, top: 400, bottom: 470, width: 20 }, vp);
    expect(right.x).toBeLessThanOrEqual(vp.width - HOVER_TIP_WIDTH / 2);
    // 两种极端都不许把说明推出屏幕
    for (const p of [left, right]) {
      expect(p.x - HOVER_TIP_WIDTH / 2).toBeGreaterThanOrEqual(0);
      expect(p.x + HOVER_TIP_WIDTH / 2).toBeLessThanOrEqual(vp.width);
    }
  });

  it('窄屏（说明比屏幕还宽）时按视口兜住，不产生负坐标', () => {
    const p = tipPlacement({ left: 10, right: 60, top: 300, bottom: 360, width: 50 }, { width: 200, height: 800 });
    expect(p.x).toBeGreaterThan(0);
  });
});

describe('同时只有一条说明（口径②：点另一个对象＝切换）', () => {
  it('模块级 owner：开新的会把旧的挤掉，而不是各挂一条', () => {
    expect(hover, '要有「当前说明归属」这一层').toContain('let activeOwner');
    expect(hover).toContain('setActiveOwner(idRef.current, el)');
    expect(hover, 'owner 不是自己就把自己的收掉').toContain(
      'if (activeOwner !== idRef.current) setTip(null)',
    );
  });
});

describe('点空白处立即关闭（口径③）', () => {
  it('全局收口：点在**当前说明的触发元素之外**就收（捕获阶段，先关旧的再开新的）', () => {
    expect(hover).toContain('function bindGlobalDismiss(');
    expect(hover, '点触发元素自己不在这里关（交给它的 toggle）').toContain(
      'if (activeTrigger && t instanceof Node && activeTrigger.contains(t)) return;',
    );
    expect(hover, '必须捕获阶段：冒泡会把刚打开的那条立刻关掉').toContain(
      "'touchstart', onDown, { capture: true, passive: true }",
    );
    expect(hover, '鼠标路径同样要能关（手机浏览器会补发鼠标事件）').toContain(
      "'mousedown', onDown, { capture: true }",
    );
  });

  it('技能提示展开的说明块同样吃这一条（改动前 ✗：只能再点技能名或等 30s 兜底）', () => {
    expect(skillTip, '展开时才挂').toContain('if (!tip.pinned) return;');
    expect(skillTip).toContain("'touchstart', onDown, { capture: true, passive: true }");
    expect(skillTip, '点技能名自己除外').toContain('if (root && t instanceof Node && root.contains(t)) return;');
  });
});

describe('点一下即开、再点即收（口径①）', () => {
  it('触摸：短按出说明（原来只有长按，点了没反应），再点同一个＝收起', () => {
    expect(hover).toContain('onTouchEnd:');
    expect(hover, '滑动/长按已经开过的不算点击').toContain(
      'if (!press || press.moved || press.opened) return;',
    );
    expect(hover, '再点同一个对象＝收起').toContain(
      'if (openRef.current && mineRef.current === el) hide();',
    );
    expect(hover, '长按仍然可用（用户 2026-09-21 的要求）').toContain('LONG_PRESS_MS');
  });
});

describe('不阻塞选牌、选目标、响应（口径④）', () => {
  it('说明自己不吃指针（样式保证，点了直接穿到牌桌）', () => {
    const block = css.slice(css.indexOf('.hover-tip {'), css.indexOf('.hover-tip-name {'));
    expect(block).toContain('pointer-events: none');
    expect(block, '翻到下方的那种也要一起管着').toContain('.hover-tip.below');
  });

  it('手牌**不许**只挂鼠标那一半（改动前 ✗：手机点出来的说明关不掉）', () => {
    expect(game, '旧写法：只取 bind 的 onMouseEnter').not.toMatch(/onMouseEnter=\{\s*bindTip/);
    expect(game).not.toContain('onMouseLeave={hideTip}');
    expect(game).toContain('{...bindTip(');
  });
});
