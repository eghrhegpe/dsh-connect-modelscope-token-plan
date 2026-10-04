/**
 * 路由字面量。浏览器 bundle（src/client/const.ts）无法从 host-config 导入，
 * 两边各写一份字面量——由 test/config.test.mjs 钉住相等，改名时先红再改。
 * @module dsh-connect-modelscope-token-plan/routes/paths
 */
export const SNAPSHOT_PATH = "/api/dsh-connect-modelscope-token-plan/snapshot";
export const MODELS_PATH = "/api/dsh-connect-modelscope-token-plan/models";
export const TOKEN_PATH = "/api/dsh-connect-modelscope-token-plan/token";
export const TOKEN_FORGET_PATH = "/api/dsh-connect-modelscope-token-plan/token/forget";
export const PROBE_PATH = "/api/dsh-connect-modelscope-token-plan/probe";
export const PROVIDER_PATH = "/api/dsh-connect-modelscope-token-plan/provider";
