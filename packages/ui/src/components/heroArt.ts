// 武将原画。按 <武将 id>.jpg 放进 packages/ui/assets/heroes/ 就会自动生效
// （id 见 packages/engine/src/heroes.ts，如 guanyu / sunquan）。
// 没有对应文件的武将（例如中立的「平民」）返回 null，调用方回退到占位框。
const ART = import.meta.glob('../../assets/heroes/*.{jpg,jpeg,png,webp}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const BY_ID: Record<string, string> = {};
for (const [path, url] of Object.entries(ART)) {
  const id = path.split('/').pop()?.replace(/\.[^.]+$/, '');
  if (id) BY_ID[id] = url;
}

export function heroArt(heroId: string | null | undefined): string | null {
  return heroId ? BY_ID[heroId] ?? null : null;
}
