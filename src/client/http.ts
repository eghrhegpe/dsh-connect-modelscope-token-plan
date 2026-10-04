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

/** POST 并解析 body；非 JSON 响应返回 null。 */
export async function postJson(path: string, payload: Record<string, unknown>): Promise<ApiBody | null> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    cache: "no-store",
    body: JSON.stringify(payload)
  });
  return await response.json().catch(() => null) as ApiBody | null;
}

/** POST 并要求 ok:true；否则抛 Host 自己的 error 文案。 */
export async function postJsonOrThrow(path: string, payload: Record<string, unknown>): Promise<ApiBody> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    cache: "no-store",
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => null) as ApiBody | null;
  if (body === null || body.ok !== true) {
    throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return body;
}

/** GET 同源 JSON；非 2xx 或非 JSON 返回 null（调用方决定怎么降级）。 */
export async function getJson(path: string): Promise<ApiBody | null> {
  const response = await fetch(path, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) return null;
  return await response.json().catch(() => null) as ApiBody | null;
}
