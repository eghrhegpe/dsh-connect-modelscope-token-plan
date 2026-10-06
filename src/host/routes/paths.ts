/**
 * 路由字面量。浏览器 bundle（src/client/const.ts）无法从 host-config 导入，
 * 两边各写一份字面量——由 test/panel.test.mjs 的 §6/§6b 钉住两端解析出的完整
 * 路径集合双向相等，改名时先红再改。（原注释指向 test/config.test.mjs，但那套
 * 钉的是 CONFIG_DEFAULTS ↔ cordis.patch.yml，不含路由字面量。）
 * @module dsh-connect-modelscope-token-plan/routes/paths
 */
export const SNAPSHOT_PATH = "/api/dsh-connect-modelscope-token-plan/snapshot";
export const MODELS_PATH = "/api/dsh-connect-modelscope-token-plan/models";
export const TOKEN_PATH = "/api/dsh-connect-modelscope-token-plan/token";
export const TOKEN_FORGET_PATH = "/api/dsh-connect-modelscope-token-plan/token/forget";
export const PROBE_PATH = "/api/dsh-connect-modelscope-token-plan/probe";
export const PROVIDER_PATH = "/api/dsh-connect-modelscope-token-plan/provider";
