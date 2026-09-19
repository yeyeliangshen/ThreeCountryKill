// 国战「规则扩展开关」的类型定义（前后端共享）
//
// 放在 protocol 而不是 engine：房间状态、联机广播、重连恢复都要序列化它，
// 而 protocol 是最底层（engine 依赖 protocol，不能反过来）。预设/校验/冻结在
// engine 的 config.ts 里（它们只有引擎与服务端用得上）。
//
// 设计要点见 docs/guozhan-roster.md §5.77：
// - 三个开关**彼此独立**，不是互斥的「模式」；「全开」只是一个预设。
// - 版本用**字符串枚举**而不是布尔：旧/新势备、旧/2023 不臣、旧/2026 君临都会碰到。
// - 带 `schemaVersion`：存档/录像/重连恢复要迁移时才知道按哪一版解释。

/**
 * 配置 schema 版本。**加字段或改变量含义时必须 +1**，并在迁移里写明旧版本怎么读。
 */
export const GUOZHAN_CONFIG_SCHEMA_VERSION = 1 as const;

/** 势备篇：牌堆内容扩展（标准 108 + 势备 52） */
export type ShibeiVersion = 'off' | 'current';
/** 不臣篇：武将 + 特殊规则 + 特殊牌区域（野心家武将、暴露野心/建国、势力锦囊、府库） */
export type BuchenVersion = 'off' | 'current';
/** 君临天下：君主规则覆盖（君主化、【君威】、场外专属装备）。'2026' = 现行移动版口径 */
export type JunlintianxiaVersion = 'off' | '2026';

export interface GuozhanExtensions {
  shibei: ShibeiVersion;
  buchen: BuchenVersion;
  junlintianxia: JunlintianxiaVersion;
}

export interface GuozhanRoomConfig {
  schemaVersion: typeof GUOZHAN_CONFIG_SCHEMA_VERSION;
  extensions: GuozhanExtensions;
}

/** 各开关允许的取值（校验器与界面共用，避免两处各写一份） */
export const GUOZHAN_VERSION_OPTIONS: {
  shibei: readonly ShibeiVersion[];
  buchen: readonly BuchenVersion[];
  junlintianxia: readonly JunlintianxiaVersion[];
} = {
  shibei: ['off', 'current'],
  buchen: ['off', 'current'],
  junlintianxia: ['off', '2026'],
};
