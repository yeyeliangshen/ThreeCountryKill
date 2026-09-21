import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 「hook 排在提前 return 之后」的**静态守门测试**。
 *
 * 为什么值得单独立一条（2026-09-21 真事）：`Game` 里有一个 `useEffect` 排在
 * `if (!snapshot) return <div>加载中…</div>` 之后。进房时先是「加载中」那一帧（少调一个
 * hook），快照到达后那一帧多调一个 → React 抛
 * "Rendered more hooks than during the previous render" → **整棵树卸载** →
 * 深色底上就是一块**黑屏**（手机上切屏回来必现，用户报的就是这个）。
 *
 * 运行期的规则（Rules of Hooks）没有 linter 兜着，就靠这条静态扫描：
 * 在**同一个函数**里，一旦出现过顶格的 `return <...>` / `return (...)`，
 * 后面就不许再出现顶格的 `useXxx(`。
 *
 * ⚠️ 只扫**函数体顶层**（缩进 ≤ 4 的那一层），函数里的回调/嵌套函数自己的 return 不算；
 *    文件里多个组件各扫各的（`Portrait` 这类内部组件有自己的作用域）。
 */
const HOOK_RE = /^\s{0,2}(?:const\s+\w+\s*=\s*)?use[A-Z][A-Za-z]*\s*\(/;
const RETURN_RE = /^\s{0,2}(?:if\s*\(.*\)\s*)?return\s*[<(]/;
/** 名字像 hook、其实是 store 动作/普通函数的（`useStore(...)` 是真 hook，不在这里） */
const NOT_HOOKS = ['useSkill'];
const FUNC_START_RE = /^((?:export\s+)?function\s+[A-Za-z0-9_$]+|const\s+[A-Za-z0-9_$]+\s*=\s*\()/;

function listTsx(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listTsx(p, out);
    else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) out.push(p);
  }
  return out;
}

describe('Rules of Hooks（静态）：提前 return 之后不许再写 hook', () => {
  const files = listTsx(join(process.cwd(), 'src'));

  it('扫描到的文件数合理（防止路径写错导致空扫描）', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${file.replace(process.cwd(), '').replace(/\\/g, '/')} 没有 hook-after-early-return`, () => {
      const lines = readFileSync(file, 'utf8').split('\n');
      const bad: string[] = [];
      let seenTopReturn = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // 新的顶层函数/组件开始 → 作用域重来（每个组件各自判）
        if (FUNC_START_RE.test(line)) seenTopReturn = false;
        if (RETURN_RE.test(line)) seenTopReturn = true;
        else if (
          seenTopReturn &&
          HOOK_RE.test(line) &&
          !NOT_HOOKS.some((n) => line.includes(`${n}(`))
        ) {
          bad.push(`第 ${i + 1} 行：${line.trim().slice(0, 70)}`);
        }
      }
      expect(bad, 'hook 排在了提前 return 之后——请把它往上挪（否则会出现「渲染的 hook 数变了」的黑屏）').toEqual([]);
    });
  }
});
