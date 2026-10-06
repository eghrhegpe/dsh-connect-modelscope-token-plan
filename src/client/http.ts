/**
 * Client 半边唯一的 POST seam：同族 fixed request shape + `.json().catch`
 * 兜底（与姊妹插件 http.ts 受控复制）。Host 对一切预期结果回 HTTP 200、
 * 成败看 body 的 ok 字段；4xx 只属于参数校验层。
 * @module dsh-connect-modelscope-token-plan/client/http
 */

/** Host 的 JSON 应答；字段全部可选——兜底是 body 本身，不是承诺形状。 */
export interface ApiBody {
  ok?: boolean;
  error?: string | null;
  code?: string;
  [key: string]: unknown;
}

/**
 * 单次请求的内部超时：面板写路径（开关/清单/令牌/probe）挂起时不能无限禁
 * 用按钮——abort 后 finally 会清 busy。GET 轮询由 use-snapshot-polling 自带
 * AbortController，这里管的是「没有外部 signal」的调用（provider 兜底 GET 与
 * 全部 POST）。读轮询的 abort 是「顶替」，这里的 abort 是「超时」，两者不冲突。
 */
const FETCH_TIMEOUT_MS = 20_000;

/** 一次带超时的 fetch；内部 controller，调用方无需传 signal。 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller === null ? null : setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, ...(controller === null ? {} : { signal: controller.signal }) });
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** POST 并解析 body；非 JSON 响应返回 null。 */
export async function postJson(path: string, payload: Record<string, unknown>): Promise<ApiBody | null> {
  const response = await fetchWithTimeout(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    cache: "no-store",
    body: JSON.stringify(payload)
  });
  return await response.json().catch(() => null) as ApiBody | null;
}

/** GET 同源 JSON；非 2xx 或非 JSON 返回 null（调用方决定怎么降级）。 */
export async function getJson(path: string): Promise<ApiBody | null> {
  const response = await fetchWithTimeout(path, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) return null;
  return await response.json().catch(() => null) as ApiBody | null;
}
