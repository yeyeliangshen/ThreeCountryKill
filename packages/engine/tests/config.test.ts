import { describe, it, expect } from 'vitest';
import {
  configFromPreset,
  DEFAULT_GUOZHAN_PRESET,
  DEV_DEFAULT_GUOZHAN_PRESET,
  freezeConfig,
  GUOZHAN_CONFIG_SCHEMA_VERSION,
  GUOZHAN_PRESETS,
  validateGuozhanConfig,
  type GuozhanRoomConfig,
} from '../src';

describe('国战扩展开关：配置 / 预设 / 校验', () => {
  it('预设生成的都是合法配置，且带 schemaVersion', () => {
    for (const name of Object.keys(GUOZHAN_PRESETS) as (keyof typeof GUOZHAN_PRESETS)[]) {
      const cfg = configFromPreset(name);
      expect(cfg.schemaVersion).toBe(GUOZHAN_CONFIG_SCHEMA_VERSION);
      expect(validateGuozhanConfig(cfg)).toEqual({ ok: true });
    }
  });

  it('线上默认是「标准国战」，开发默认才是全开（产品默认与个人偏好解耦）', () => {
    expect(DEFAULT_GUOZHAN_PRESET).toBe('standard');
    expect(configFromPreset(DEFAULT_GUOZHAN_PRESET).extensions).toEqual({
      shibei: 'off',
      buchen: 'off',
      junlintianxia: 'off',
    });
    expect(DEV_DEFAULT_GUOZHAN_PRESET).toBe('full2026');
    expect(configFromPreset('full2026').extensions).toEqual({
      shibei: 'current',
      buchen: 'current',
      junlintianxia: '2026',
    });
  });

  it('拿到的配置是副本：改了不会污染预设常量', () => {
    const a = configFromPreset('full2026');
    a.extensions.buchen = 'off';
    expect(configFromPreset('full2026').extensions.buchen).toBe('current');
  });

  it('校验器拦得住网络/存档里的脏数据（类型只是编译期的）', () => {
    const bad = (v: unknown) => validateGuozhanConfig(v);
    expect(bad(null).ok).toBe(false);
    expect(bad({}).ok).toBe(false);
    expect(bad({ schemaVersion: 1 }).ok).toBe(false); // 缺 extensions
    expect(bad({ schemaVersion: 2, extensions: {} }).ok).toBe(false); // schema 版本不对
    const wrongVersion = {
      schemaVersion: 1,
      extensions: { shibei: 'legacy', buchen: 'off', junlintianxia: 'off' },
    };
    const res = bad(wrongVersion);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join()).toContain('shibei');
  });

  it('开局后冻结：改不动（大厅里可以改，开局后一个都不能动）', () => {
    const frozen = freezeConfig(configFromPreset('standard')) as GuozhanRoomConfig;
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.extensions)).toBe(true);
    expect(() => {
      (frozen.extensions as { buchen: string }).buchen = 'current';
    }).toThrow();
    expect(frozen.extensions.buchen).toBe('off');
  });
});
