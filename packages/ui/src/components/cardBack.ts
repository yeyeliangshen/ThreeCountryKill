// 卡背图（用户给的素材）。与武将原画同一套取法：按文件名自动发现，
// 没有文件时返回 null，界面回退成文字（不会让构建炸）。
//
// ⚠️ 用途：只表示**暗牌**（对方的手牌）——「目标区域选牌」里手牌那几个选项，
// 以及任何需要画一张「盖着的牌」的地方。牌面信息一律不显示（规格第九条）。
const BACKS = import.meta.glob('../../assets/cardback.{png,jpg,jpeg,webp}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export const cardBack: string | null = Object.values(BACKS)[0] ?? null;
