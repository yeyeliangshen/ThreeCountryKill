#!/usr/bin/env node
/**
 * 导出**国战全武将技能表**为纯文本（用户 2026-09-25 要的那份 txt）。
 *
 * 口径：**直接从代码生成**——技能名与技能文本都取自 `Hero.skills`（引擎里那份），
 * 所以它永远和实现一致。⚠️ 不要手工编辑输出的 txt（会立刻和代码分叉；【离间】那次
 * 「简化版」文本就是这么漏出去的，见 docs/guozhan-roster.md §5.228 §五）。
 *
 * 用法：
 *   npx tsx scripts/export-guozhan-skills.mjs                    # 打到 stdout
 *   npx tsx scripts/export-guozhan-skills.mjs > guozhan-skills.txt
 */
import { poolForMode } from '../packages/engine/src/index.ts';
import { GUOZHAN_ROSTER, PACK_NAME } from '../packages/engine/src/data/roster.ts';

const FACTION_ORDER = ['wei', 'shu', 'wu', 'qun', 'neutral', 'ambitionist'];
const FACTION_NAME = { wei: '魏', shu: '蜀', wu: '吴', qun: '群', neutral: '中立', ambitionist: '野心家' };
const PACK_ORDER = ['standard', 'zhen', 'shi', 'bian', 'quan', 'buchen', 'jun'];

/** 国战可选武将（含不臣篇的双势力/野心家），按包与势力排出稳定顺序 */
const heroes = poolForMode('guozhan');
const packOf = new Map(GUOZHAN_ROSTER.map((r) => [r.id, r.pack]));
const sortKey = (h) => {
  const p = PACK_ORDER.indexOf(packOf.get(h.id) ?? 'standard');
  const f = FACTION_ORDER.indexOf(h.faction);
  return [p < 0 ? 99 : p, f < 0 ? 99 : f, h.name];
};
heroes.sort((a, b) => {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
});

const out = [];
out.push('# 国战武将技能表（由 scripts/export-guozhan-skills.mjs 从代码生成，勿手工编辑）');
out.push(`# 生成时间：${new Date().toISOString()}`);
out.push(`# 共 ${heroes.length} 名国战武将；技能文本＝引擎里那一份（与实现一致）`);
out.push('');
let lastPack = null;
for (const h of heroes) {
  const pack = packOf.get(h.id) ?? 'standard';
  if (pack !== lastPack) {
    out.push(`\n===== ${PACK_NAME[pack] ?? pack} =====`);
    lastPack = pack;
  }
  const skills = h.skills ?? [];
  const names = skills.map((s) => `【${s.name}】`).join('');
  out.push(`\n${h.name}（${FACTION_NAME[h.faction] ?? h.faction}·体力 ${h.maxHp}）${names}`);
  for (const s of skills) out.push(`  【${s.name}】${s.desc ?? '（无文本）'}`);
}
process.stdout.write(out.join('\n') + '\n');
