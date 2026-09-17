/// <reference types="vite/client" />

/**
 * 构建版本戳：由本包的 vite.config.ts 在构建时注入（短 commit + 构建时间）。
 *
 * 这里要声明一份**而不是只声明在 @sgs/ui 里**——client 的 tsc 会把 ui 的源码
 * 一并纳入本次检查，只放在 ui 包里这个程序看不到，`pnpm typecheck` 会报
 * “Cannot find name '__BUILD_STAMP__'”。
 */
declare const __BUILD_STAMP__: string | undefined;
