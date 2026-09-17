/// <reference types="vite/client" />

/**
 * 构建版本戳：由 packages/client/vite.config.ts 在构建时注入
 * （短 commit + 构建时间）。开发模式下没有注入，界面会回落到占位文案。
 */
declare const __BUILD_STAMP__: string | undefined;
