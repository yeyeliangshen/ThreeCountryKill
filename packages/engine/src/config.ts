// 国战「规则扩展开关」——预设、校验、冻结（用户给定的架构，见 docs/guozhan-roster.md §5.77）
//
// 类型定义（GuozhanRoomConfig 等）在 **protocol**：房间状态、联机广播、重连恢复都要序列化它，
// 而 protocol 是最底层。这里只放引擎/服务端用得上的东西：预设、校验器、冻结。
//
// 设计要点（都是用户明确要求的，改之前先看 §5.77）：
// - **三个开关彼此独立**，不是互斥的「模式」；「全开」只是预设，不是另一套规则代码。
// - **预设不许进入规则判断**：preset → 配置 → 校验 → 建局，底层只看版本字符串。
// - 房间开局后三个开关**冻结**（见 `freezeConfig`）——武将池、势力锦囊、野心家状态都
//   没法中途迁移。
//
// 类型与取值表从 protocol 再导出，调用方只 import 这一个模块也能拿到全部东西。
export {
  GUOZHAN_CONFIG_SCHEMA_VERSION,
  GUOZHAN_VERSION_OPTIONS,
  type BuchenVersion,
  type GuozhanExtensions,
  type GuozhanRoomConfig,
  type JunlintianxiaVersion,
  type ShibeiVersion,
} from '@sgs/protocol';
import {
  GUOZHAN_CONFIG_SCHEMA_VERSION,
  GUOZHAN_VERSION_OPTIONS,
  type GuozhanExtensions,
  type GuozhanRoomConfig,
} from '@sgs/protocol';

/**
 * 预设。**它只负责生成配置**——绝不要写 `if (preset === 'full2026')` 这种判断，
 * 那样「自定义」和「全扩展2026」会产生两套行为（见 §5.77 的第 ② 条）。
 */
export const GUOZHAN_PRESETS = {
  standard: {
    schemaVersion: GUOZHAN_CONFIG_SCHEMA_VERSION,
    extensions: {
      shibei: 'off',
      buchen: 'off',
      junlintianxia: 'off',
      zhen: 'off',
      shi: 'off',
      bian: 'off',
      quan: 'off',
    },
  },
  full2026: {
    schemaVersion: GUOZHAN_CONFIG_SCHEMA_VERSION,
    extensions: {
      shibei: 'current',
      buchen: 'current',
      junlintianxia: '2026',
      zhen: 'current',
      shi: 'current',
      bian: 'current',
      quan: 'current',
    },
  },
} as const satisfies Record<string, GuozhanRoomConfig>;

export type GuozhanPresetName = keyof typeof GUOZHAN_PRESETS;

/**
 * **新房间的默认预设**（用户拍板：线上默认「标准国战」）。
 *
 * ⚠️ 这是**房间层**的默认值（服务端建房时用它生成配置传给 `createGame`）。引擎自身不替产品
 * 定默认——`createGame` 不传 `config` 时按「全开」处理（历史行为不变，既有测试与随机测试的
 * 覆盖面因此不缩水）。
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
  for (const key of ['shibei', 'buchen', 'junlintianxia', 'zhen', 'shi', 'bian', 'quan'] as const) {
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
