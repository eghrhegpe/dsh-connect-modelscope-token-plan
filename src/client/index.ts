/**
 * dsh-connect-modelscope-token-plan — Client half (entry).
 *
 * 在 Plugins 页注册 `plugins.bundle.config` 卡（三 tab：额度 / 模型 / 接入）。
 * 数据来自 Host 的只读快照路由，仅在本卡挂载期间轮询。源码经 tsdown 打成根
 * client.js（IIFE）；测试加载**产物**，浏览器跑什么测试就跑什么。
 * @module dsh-connect-modelscope-token-plan/client
 */

/**
 * 工厂体：浏览器与 Node 共用。除 react（loader 注入）外零依赖；参数名为
 * loaderRequire 而非 require，让打包器无从把它当模块语法改写。Node 套件用
 * 替身 React 跑同一个工厂，测到的定义就是浏览器跑的定义。
 * @param loaderRequire - the loader's require; hands out `react`.
 */
import { inject, apply } from "./apply.ts";
import { NS } from "./const.ts";
import { interpretSnapshot, viewOf, providerOf, errorOfStatus, GUIDANCE_BY_CODE, FORM_EXCLUDED_CODES } from "./snapshot.ts";
import { clockLong, count, errorText, format, isoTime, statedCadenceMs } from "./format.ts";
import { provideClientReact } from "./runtime.ts";
import { en, zh } from "./i18n.ts";
import { S } from "./styles.ts";
import { BalanceCard, EventsList, LocalDailyCard, ModelUsageTable, ProviderCard, SectionCard, TokenForm, TrendBars } from "./cards.ts";
import { PanelPage } from "./panel-page.ts";
import { usePollingInterval } from "./use-polling-interval.ts";
import { useSnapshotPolling } from "./use-snapshot-polling.ts";
import { getJson, postJson } from "./http.ts";

function clientFactory(loaderRequire: (specifier: string) => unknown): {
  inject: string[];
  apply: typeof apply;
  panel: object;
} {
  provideClientReact(loaderRequire("react"));

  /** 测试面：浏览器用的真实定义，没有一件只为测试而存在。 */
  const panel = Object.freeze({
    interpretSnapshot,
    viewOf,
    providerOf,
    errorOfStatus,
    dictionaries: Object.freeze({ zh, en }),
    tables: Object.freeze({ GUIDANCE_BY_CODE, FORM_EXCLUDED_CODES }),
    styles: S,
    helpers: Object.freeze({
      clockLong,
      count,
      errorText,
      format,
      isoTime,
      statedCadenceMs,
      usePollingInterval,
      useSnapshotPolling,
      getJson,
      postJson,
    }),
    components: Object.freeze({
      BalanceCard,
      EventsList,
      LocalDailyCard,
      ModelUsageTable,
      PanelPage,
      ProviderCard,
      SectionCard,
      TokenForm,
      TrendBars
    })
  });

  return { inject, apply, panel };
}

/** Host 加载的注册物：id + 工厂。 */
const REGISTRATION = { id: NS, factory: clientFactory };

// 三种模块世界（IIFE 让顶层没有 import/export，三种世界看到同一批语句）：
// - 浏览器：DSH loader 调 window.__ModuleLoader__.load(...)
// - Node CJS：require() 得到 module.exports
// - Node ESM：client-surface 先装捕获版 __ModuleLoader__ 再 import
if (typeof window !== "undefined") {
  const loader = (window as Window & typeof globalThis & { __ModuleLoader__?: { load: (registration: object) => void } }).__ModuleLoader__;
  if (loader !== undefined) loader.load(REGISTRATION);
}
if (typeof module !== "undefined" && module !== null && module.exports !== undefined) {
  module.exports = REGISTRATION;
}
