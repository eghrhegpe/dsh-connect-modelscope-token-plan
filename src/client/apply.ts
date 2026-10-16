/**
 * Host 面向的挂载：字典注册 + 插件配置卡 + 对话框用量胶囊。
 *
 * 卡片渲染在 Plugins 页（`plugins.bundle.config` 槽）内，始终展开；没有
 * 侧边栏入口、没有独立 main 页。用户打开 Plugins 页导航到本插件即见。
 * 胶囊挂在输入框工具栏（`conversation.input.right` 槽），只在会话当前选中的
 * provider 是本插件时出现——门控在组件里（见 composer-usage-pill.ts）。
 * @module dsh-connect-modelscope-token-plan/client/apply
 */
import { NS } from "./const.ts";
import { en, zh } from "./i18n.ts";
import { PanelPage } from "./panel-page.ts";
import { ComposerUsagePill } from "./composer-usage-pill.ts";
import type { Tt } from "./runtime.ts";

/** 必需服务：槽系统 + locale 注册表。 */
export const inject = ["slots", "locale"];

/** client 根上下文的最小面；ctx 其余部分不透明。 */
export interface ClientCtx {
  effect: (fn: () => unknown, name?: string) => unknown;
  locale: {
    register: (ns: string, dicts: { zh: typeof zh; en: typeof en }) => unknown;
    bind: (ns: string) => (key: string) => string;
    subscribe: (fn: () => void) => unknown;
  };
  slots: {
    inject: (slot: string, register: () => unknown) => unknown;
    register: (declaration: Record<string, unknown>, component: unknown) => unknown;
  };
}

/**
 * 注册字典与配置卡。卡片由 Host 的 renderSlot("plugins.bundle.config", …)
 * 渲染；本卡无关闭按钮——导航归 Plugins 页所有。
 */
export function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en });
    } catch {
      return () => {};
    }
  }, `${NS}: dictionaries`);

  let translate: Tt = (key) => key;
  try {
    translate = ctx.locale.bind(NS);
  } catch {
    // 没有 locale 服务的外壳渲染 key 本身。
  }
  const tt: Tt = (key) => {
    try {
      return translate(key);
    } catch {
      return key;
    }
  };

  const disposers: Array<() => void> = [];
  try {
    disposers.push(
      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          {
            name: "plugins.bundle.config",
            key: NS,
            locale: NS,
            inject: () => ({ tt, localeSubscribe: ctx.locale.subscribe.bind(ctx.locale) })
          },
          PanelPage
        )
      ) as () => void
    );
  } catch (error) {
    console.warn(`[${NS}] config card registration failed:`, error);
  }

  // 对话框用量胶囊：输入框工具栏 `conversation.input.right` 座席。
  //
  // 座席契约以**宿主随包发布的客户端**为准（本机实测 app.asar 里的
  // `@deepseek-ai/dsh-client-ui-conversation`）：该 id 声明为
  // `{ kind: "list", scope: "session" }`——list 意味着**追加**进槽位现有的
  // fill 列表，绝不能顶掉别人的条目；session 作用域意味着渲染器物化注入
  // `useProjection`（宿主 `@deepseek-ai/dsh-client-ui-session` 的
  // `keyedHooks: ["projection"]` → `standardHookPropName` → `useProjection`）。
  // 所以这里 inject 只补本插件自己的字典翻译，投影由槽位系统给。
  //
  // 只注册一次：同一座席注册两份会真的出现两个胶囊（去重按注册路径算，不跨声明）。
  // 注册失败照§降级纪律：面板照常用、胶囊缺席，不抛。
  try {
    disposers.push(
      ctx.slots.inject("conversation.input.right", () =>
        ctx.slots.register(
          {
            name: "conversation.input.right",
            id: `${NS}-composer-pill`,
            locale: NS,
            order: 4,
            inject: () => ({ tt })
          },
          ComposerUsagePill
        )
      ) as () => void
    );
  } catch (error) {
    console.warn(`[${NS}] composer pill registration failed:`, error);
  }

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // 已随所属声明释放。
      }
    }
  }, `${NS}: ui mounts`);
}
