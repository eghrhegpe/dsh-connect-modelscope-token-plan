/**
 * 路由族的注册门面。`apply()`（index.ts）是唯一挂载缝：装配 wiring、交给
 * registerRoutes；每个路由一个模块、闭包自己的 wiring 子集，绝不直接 import
 * 服务。注册顺序即注销顺序（teardown 按此跑）。
 * @module dsh-connect-modelscope-token-plan/routes
 */
import { registerSnapshotRoute } from "./routes/snapshot.ts";
import { registerModelsRoute } from "./routes/models.ts";
import { registerTokenRoute } from "./routes/token.ts";
import { registerProbeRoute } from "./routes/probe.ts";
import type { Wiring } from "./types.ts";

/** 注册全部四条路由，返回 off() 注销回调（注册序）。 */
export function registerRoutes(ctx: any, wiring: Wiring): Array<() => void> {
  return [
    registerSnapshotRoute(ctx, wiring),
    registerModelsRoute(ctx, wiring),
    ...(registerTokenRoute(ctx, wiring) as Array<() => void>),
    registerProbeRoute(ctx, wiring)
  ];
}
