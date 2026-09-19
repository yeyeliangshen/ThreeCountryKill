import { describe, it, expect } from 'vitest';
import {
  configFromPreset,
  createGame,
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
  it('扩展开关真的生效：君主进池 + 势备牌堆都由 config 决定', () => {
    const seats = [
      { seatId: 'A', name: '甲', heroId: 'vanilla' },
      { seatId: 'B', name: '乙', heroId: 'vanilla' },
    ];
    const deal = (cfg?: GuozhanRoomConfig) => {
      const st = createGame(seats, 'T', { mode: 'guozhan', freePick: true, config: cfg });
      return st.draft!.deals['A']!;
    };
    const full = deal(configFromPreset('full2026'));
    // 全开：君主进池（君操、君刘、君孙、君袁都在）
    expect(full).toContain('juncaocao');
    expect(full).toContain('junyuanshao');
    const std = deal(configFromPreset('standard'));
    // 标准：君主将不在选将池里（君临天下关掉 = 这套君主规则整体不启用）
    expect(std).not.toContain('juncaocao');
    expect(std).not.toContain('junliubei');
    expect(std).not.toContain('junsunquan');
    expect(std).not.toContain('junyuanshao');
    expect(std).toContain('caocao'); // 但标准版曹操还在

    // 牌堆：势备开关 → 108 / 160
    const mk = (cfg?: GuozhanRoomConfig) =>
      createGame(seats, 'T', { mode: 'guozhan', config: cfg }).deck.length;
    expect(mk(configFromPreset('standard'))).toBe(108);
    expect(mk(configFromPreset('full2026'))).toBe(160);
    // 不传 config = 全开（历史行为），房间层的默认值是另一回事
    expect(mk()).toBe(160);

    // 兼容旧的布尔写法
    expect(createGame(seats, 'T', { mode: 'guozhan', shibei: false }).deck.length).toBe(108);
    expect(createGame(seats, 'T', { mode: 'guozhan', shibei: true }).deck.length).toBe(160);
  });
});
