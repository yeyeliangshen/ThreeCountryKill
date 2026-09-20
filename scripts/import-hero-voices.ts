/**
 * 把「三国杀语音资源包」里的**武将技能语音**导入到界面资源目录。
 *
 *   npx tsx scripts/import-hero-voices.ts            # 真导入（写文件）
 *   npx tsx scripts/import-hero-voices.ts --dry       # 只试算：命中多少、多大，不写文件
 *
 * 源目录默认是 `E:/BaiduNetdiskDownload/三国杀语音资源(1)`（可用 `VOICE_SRC` 覆盖），
 * 目标是 `packages/ui/assets/voice/hero/<武将 id>/`。**只拷我们实现的那几个技能**的语音
 * （每技能至多 2 条，两条是资源里自带的「技能1 / 技能2」变体，客户端随机挑一条），外加 `阵亡`。
 *
 * 源资源的形状（实测）：
 *
 *   V8.0三服全武将技能语音-<势力>/<序号>-<武将>/<版本或皮肤>[/<皮肤档位>]/<技能名><n>.mp3
 *
 * 匹配规则（顺序即优先级）：
 *   1. 候选＝「祖先目录名里**包含**该武将名」的所有叶子目录（源里同一武将有多套：标/界/手杀/传说…，
 *      还有别名，如 `17-蔡琰（蔡文姬）`、`4-许攸（官渡）`）；
 *   2. 候选按「**命中我们实现的技能数**」排序——最稳的判据：源里技能名与我们的一致才算命中
 *      （所以 `界钟会` 会自动落到「钟会」下那个有【权计】的版本上）；
 *   3. 同分时按版本偏好：`国战` > 我们的前缀（`界`/`SP`/`君`）匹配到的版本 > `标`/`普通`/`手杀`/`Online`
 *      > 皮肤（`传说`/`史诗`/`限定`）> 其它。挑到的是**标准语音**，不是皮肤语音。
 *
 * ⚠️ 源里偶尔有错别字（例：`侍才` vs 我们的【恃才】），那种技能会**漏掉**（宁缺勿错——不拿别的技能凑数）。
 *    覆盖不到就静默不出声，见 packages/ui/src/audio/voice.ts。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HEROES } from '../packages/engine/src/heroes';

const DRY = process.argv.includes('--dry');
const SRC = process.env.VOICE_SRC ?? 'E:/BaiduNetdiskDownload/三国杀语音资源(1)';
const DEST = path.join(__dirname, '..', 'packages', 'ui', 'assets', 'voice', 'hero');
const AUDIO = /\.(ogg|mp3|m4a|wav)$/i;

const cjk = (s: string): string => (s.match(/[\u4e00-\u9fa5]/g) ?? []).join('');
const stripIndex = (s: string): string => s.replace(/^\d+-/, '');

interface HeroLike {
  id: string;
  name: string;
  faction: string;
  notDraftable?: boolean;
  skills?: { name: string }[];
  guozhan?: { skills?: { name: string }[] };
}

/** 我们实现的所有技能名（含国战覆盖版） */
function skillsOf(h: HeroLike): string[] {
  return [
    ...new Set([...(h.skills ?? []).map((s) => s.name), ...(h.guozhan?.skills ?? []).map((s) => s.name)]),
  ];
}

/**
 * 源里的**别名**（同一个武将、资源包用了另一个名字）。
 * 都是查证过的：`甄姬` 在源里叫「甄宓」（同一个人的两种写法），`蔡文姬` 在源里叫「蔡琰（蔡文姬）」
 * （那种带括号的会被下面的「祖先名包含」规则自然接住，所以不必列在这里）。
 */
const ALIAS: Record<string, string> = { 甄姬: '甄宓' };

/** 我们的武将名去掉「界 / SP / 君」前缀，用来在源目录里找同名武将（别名先换掉） */
const baseName = (n: string): string => cjk(ALIAS[n] ?? n).replace(/^(界|君|SP)/, '');
const prefixOf = (n: string): '界' | 'SP' | '君' | null =>
  n.startsWith('界') ? '界' : /^SP/.test(n) ? 'SP' : n.startsWith('君') ? '君' : null;

interface Variant {
  dir: string;
  ancestors: string[];
  files: string[];
}

function collectVariants(root: string): Variant[] {
  const out: Variant[] = [];
  const walk = (dir: string, ancestors: string[]): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = entries.filter((e) => e.isFile() && AUDIO.test(e.name)).map((e) => e.name);
    if (files.length > 0) out.push({ dir, ancestors, files });
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), [...ancestors, e.name]);
  };
  walk(root, []);
  return out;
}

/** 源里的文件名 → 技能名（去掉扩展名与结尾的序号） */
const skillOfFile = (file: string): string => file.replace(AUDIO, '').replace(/\d+$/, '');

function versionScore(dirText: string, prefix: '界' | 'SP' | '君' | null): number {
  if (/国战/.test(dirText)) return 5;
  if (prefix === '界' && /界/.test(dirText)) return 4;
  if (prefix === 'SP' && /SP|sp/.test(dirText)) return 4;
  if (prefix === '君' && /君/.test(dirText)) return 4;
  if (/标|普通|手杀|Online|小程序/.test(dirText)) return 2;
  return 1; // 皮肤（传说/史诗/限定…）与其它
}

function main(): void {
  if (!fs.existsSync(SRC)) {
    console.error(`源目录不存在：${SRC}（可用 VOICE_SRC 覆盖）`);
    process.exit(1);
  }
  const heroes = (Object.values(HEROES) as HeroLike[]).filter(
    (h) => !h.notDraftable && h.faction !== 'neutral',
  );
  const variants = collectVariants(SRC);
  console.log(`源目录：${SRC}\n变体目录 ${variants.length} 个；我们的武将 ${heroes.length} 位`);

  const report: string[] = ['| 武将 | id | 用哪一套 | 覆盖到的技能 | 缺 |', '| --- | --- | --- | --- | --- |'];
  let copied = 0;
  let bytes = 0;
  const missingHeroes: string[] = [];

  for (const h of heroes) {
    const base = baseName(h.name);
    const prefix = prefixOf(h.name);
    const skills = skillsOf(h);
    const cands = variants
      .map((v) => {
        const inAncestors = v.ancestors.some((a) => cjk(stripIndex(a)).includes(base));
        if (!inAncestors) return null;
        const hit = skills.filter((s) => v.files.some((f) => skillOfFile(f) === s));
        return { v, hit, score: versionScore(v.dir, prefix) };
      })
      .filter((x): x is { v: Variant; hit: string[]; score: number } => !!x)
      .sort((a, b) => b.hit.length - a.hit.length || b.score - a.score || b.v.files.length - a.v.files.length);
    const best = cands[0];
    if (!best || best.hit.length === 0) {
      missingHeroes.push(`${h.name}(${h.id})`);
      continue;
    }
    const destDir = path.join(DEST, h.id);
    const lack = skills.filter((s) => !best.hit.includes(s));
    const done: string[] = [];
    if (!DRY) fs.mkdirSync(destDir, { recursive: true });
    for (const s of best.hit) {
      const files = best.v.files.filter((f) => skillOfFile(f) === s).slice(0, 2);
      for (const f of files) {
        const to = path.join(destDir, f);
        const size = fs.statSync(path.join(best.v.dir, f)).size;
        bytes += size;
        copied++;
        if (!DRY) fs.copyFileSync(path.join(best.v.dir, f), to);
      }
      done.push(s);
    }
    const dead = best.v.files.find((f) => skillOfFile(f) === '阵亡');
    if (dead) {
      bytes += fs.statSync(path.join(best.v.dir, dead)).size;
      copied++;
      if (!DRY) fs.copyFileSync(path.join(best.v.dir, dead), path.join(destDir, dead));
    } else {
      lack.push('阵亡');
    }
    report.push(
      `| ${h.name} | \`${h.id}\` | ${path.relative(SRC, best.v.dir).split(path.sep).join(' / ')} | ${done.join('、')} | ${lack.join('、') || '—'} |`,
    );
  }

  console.log(
    `\n${DRY ? '【试算】' : '【已导入】'}武将 ${heroes.length - missingHeroes.length}/${heroes.length}；` +
      `文件 ${copied} 个、约 ${(bytes / 1048576).toFixed(1)} MB`,
  );
  if (missingHeroes.length > 0) console.log(`源里没有（或技能名对不上）：${missingHeroes.join('、')}`);
  if (!DRY) {
    const mapPath = path.join(__dirname, '..', 'docs', 'hero-voice-map.md');
    fs.writeFileSync(
      mapPath,
      [
        '# 武将语音映射（由 `scripts/import-hero-voices.ts` 生成）',
        '',
        `源：\`${SRC}\``,
        '',
        '只导入**我们实现的那几个技能**（每技能至多 2 条）+ `阵亡`；技能名对不上就留空（宁缺勿错）。',
        '「用哪一套」＝源里挑中的那个版本/皮肤目录；同分时优先 `国战` 版本，其次 `标/普通/手杀`，最后才是皮肤。',
        '⚠️ 源里没有（或技能名对不上）的武将会**没有语音**，静默不出声——见下面「缺」列与末尾说明。',
        '',
        ...report,
        '',
      ].join('\n'),
      'utf8',
    );
    console.log(`映射表写到 docs/hero-voice-map.md`);
  }
}

main();
