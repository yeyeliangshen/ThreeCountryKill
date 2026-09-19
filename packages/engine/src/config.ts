// 国战「规则扩展开关」——配置类型、预设、校验（用户给定的架构，见 docs/guozhan-roster.md §5.77）
//
// 设计要点（都是用户明确要求的，改之前先看 §5.77）：
// - **三个开关彼此独立**，不是互斥的「模式」；「全开」只是预设，不是另一套规则代码。
// - 版本用**字符串枚举**而不是布尔：旧/新势备、旧/2023 不臣、旧/2026 君临都会碰到，
//   布尔以后一定会含糊（`buchen: true` 到底是哪一版？）。
// - **预设不许进入规则判断**：preset → 配置 → 校验 → 建局，底层只看配置里的版本字符串。
// - 房间配置带 `schemaVersion`：以后存档/录像/重连恢复要迁移时才知道按哪一版解释。
// - 房间开局后三个开关**冻结**（见 `freezeConfig`）——武将池、势力锦囊、野心家状态都
//   没法中途迁移。

/**
 * 配置 schema 版本。**加字段或改变量含义时必须 +1**，并在迁移里写明旧版本怎么读。
 * 现在只有 1：三个扩展开关 + 各自的版本字符串。
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

/** 各开关允许的取值（校验器与界面都用它，避免两处各写一份） */
export const GUOZHAN_VERSION_OPTIONS = {
  shibei: ['off', 'current'],
  buchen: ['off', 'current'],
  junlintianxia: ['off', '2026'],
} as const;

/**
 * 预设。**它只负责生成配置**——绝不要写 `if (preset === 'full2026')` 这种判断，
 * 那样「自定义」和「全扩展2026」会产生两套行为（见 §5.77 的第 ② 条）。
 */
export const GUOZHAN_PRESETS = {
  standard: {
    schemaVersion: GUOZHAN_CONFIG_SCHEMA_VERSION,
    extensions: { shibei: 'off', buchen: 'off', junlintianxia: 'off' },
  },
  full2026: {
    schemaVersion: GUOZHAN_CONFIG_SCHEMA_VERSION,
    extensions: { shibei: 'current', buchen: 'current', junlintianxia: '2026' },
  },
} as const satisfies Record<string, GuozhanRoomConfig>;

export type GuozhanPresetName = keyof typeof GUOZHAN_PRESETS;

/**
 * **新房间的默认预设**（用户拍板：线上默认「标准国战」）。
 *
 * 理由（用户给的）：① 标准国战是最稳的兼容基线，老玩家进新房间不会因为版本更新突然多出
 * 不臣/势备/君主规则；② 排查问题时容易判断是 Base 还是某个扩展；③「全扩展2026」改变的不只
 * 是牌堆，还有选将池、势力判定、胜利流程、特殊区域、君主规则，当默认值会把边缘交互天然变复杂。
 */
export const DEFAULT_GUOZHAN_PRESET: GuozhanPresetName = 'standard';

/**
 * **开发/测试环境的默认预设**（用户自己玩的目标：势备 + 不臣 + 2026 君临全开）。
 * 产品默认值与个人游玩偏好解耦——服务端可以用环境变量把它切到 'full2026'。
 */
export const DEV_DEFAULT_GUOZHAN_PRESET: GuozhanPresetName = 'full2026';

/** 预设名 → 完整配置（深拷贝，拿到手可以随便改，不会污染预设常量） */
export function configFromPreset(name: GuozhanPresetName): GuozhanRoomConfig {
  const p = GUOZHAN_PRESETS[name] ?? GUOZHAN_PRESETS.standard;
  return {
    schemaVersion: p.schemaVersion,
    extensions: { ...p.extensions },
  };
}

/**
 * 扩展之间的依赖/冲突/覆盖关系。
 *
 * 现在三个开关互不冲突（势备只管牌堆、不臣只管武将机制、君临只管君主规则），所以两张表都是
 * 空的——**表留着**，将来加版本时按下面这个样子填数据即可，不要去改校验代码：
 * - `requires`：开 A 必须先开 B（例：'某个依赖势备区域的不臣子机制'）
 * - `conflicts`：A 与 B 不能同时开（例：`junlintianxia: 'legacy'` × `'2026'`）
 * - `overrides`：A 生效时 B 的规则被覆盖（例：2026 君临 **overrides** 旧君临专属装备规则——
 *   旧普通牌堆里的【定澜夜明珠】、武器版【飞龙夺凤】、坐骑版【六龙骖驾】那批不进全开牌堆）
 */
export const GUOZHAN_RULE_RELATIONS: {
  requires: { extension: keyof GuozhanExtensions; needs: keyof GuozhanExtensions }[];
  conflicts: { a: string; b: string; reason: string }[];
  overrides: { winner: string; loser: string; reason: string }[];
} = {
  requires: [],
  conflicts: [],
  overrides: [],
};

export type ConfigValidation = { ok: true } | { ok: false; errors: string[] };

/**
 * 校验房间配置。**所有来自客户端/存档的配置都必须过这一关**——类型只是编译期的，
 * 联机时配置是网络数据。
 */
export function validateGuozhanConfig(cfg: unknown): ConfigValidation {
  const errors: string[] = [];
  if (!cfg || typeof cfg !== 'object') return { ok: false, errors: ['配置必须是对象'] };
  const c = cfg as Partial<GuozhanRoomConfig>;
  if (c.schemaVersion !== GUOZHAN_CONFIG_SCHEMA_VERSION) {
    errors.push(
      `配置 schemaVersion 必须是 ${GUOZHAN_CONFIG_SCHEMA_VERSION}（收到 ${String(c.schemaVersion)}）`,
    );
  }
  const ext = c.extensions as Partial<GuozhanExtensions> | undefined;
  if (!ext || typeof ext !== 'object') {
    errors.push('缺少 extensions');
    return { ok: false, errors };
  }
  for (const key of ['shibei', 'buchen', 'junlintianxia'] as const) {
    const allowed = GUOZHAN_VERSION_OPTIONS[key] as readonly string[];
    const v = ext[key];
    if (!allowed.includes(String(v))) {
      errors.push(`${key} 的取值 ${String(v)} 不合法（只能是 ${allowed.join(' / ')}）`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // requires / conflicts 是数据表，这里按表判（现在都是空的，加版本时只填表）
  for (const rel of GUOZHAN_RULE_RELATIONS.requires) {
    if (ext[rel.extension] !== 'off' && ext[rel.needs] === 'off') {
      errors.push(`${rel.extension} 需要同时开启 ${rel.needs}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

/**
 * 开局后**冻结**配置：返回一份只读副本。
 *
 * 规则（用户明确要求）：大厅里三个开关可以随便改，**开局后一个都不能动**——武将池、
 * 势力锦囊、野心家状态都没法中途迁移。房间侧应在 `started` 那一刻调它，之后只读这份。
 */
export function freezeConfig(cfg: GuozhanRoomConfig): Readonly<GuozhanRoomConfig> {
  return Object.freeze({
    schemaVersion: cfg.schemaVersion,
    extensions: Object.freeze({ ...cfg.extensions }),
  });
}
