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

/**
 * POST 并解析 body；非 JSON 响应返回 null。
 *
 * 这里**故意不**检查 `response.ok`（与 {@link getJson} 不同）：host 的写操作错误
 * 响应体是 `{ok:false, code, error}`，调用方靠 `body.error` 给用户看具体原因
 * （令牌格式错、额度耗尽、上游超时）。丢掉它就只能显示一句通用的「操作失败」，
 * 用户无从下手。getJson 可以直接返回 null——读操作没有错误详情可展示。
 */
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

/**
 * 写路径的成败判定收口：失败返回 Error，成功返回 null。
 *
 * `postJson` 只把「HTTP/解析失败」折成 `null`，域失败是 `{ok:false, error}`（Host 对
 * 写操作恒回 HTTP 200，成败看 body）。三个写回调曾各判一次，而**「忘掉令牌」漏判**——
 * 它直接 `await postJson(...)` 就往下走，于是 Host 侧刻意传播的失败（凭据文件只读时
 * `ms-auth.forget` 抛错，见其文件头「谎报成功比失败更糟」）在界面上表现为「什么都没
 * 发生」：没有错误行、busy 清掉、刷新后的快照里令牌还在。判据收在这里一份，三个调用
 * 方（开关/清单、保存令牌、忘掉令牌）不可能再各自漂移。
 * @param {ApiBody|null} body - postJson 的返回值。
 * @param {string} fallback - body 里没有可读原因时的一句话。
 * @returns {Error|null} 失败原因；`null` = 成功。
 */
export function writeFailure(body: ApiBody | null, fallback: string): Error | null {
  if (body !== null && body.ok === true) return null;
  const reason = typeof body?.error === "string" && body.error.trim() !== "" ? body.error : fallback;
  return new Error(reason);
}
