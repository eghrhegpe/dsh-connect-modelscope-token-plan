/**
 * 路由族共享的 HTTP 原语：JSON 形状、有界 body 读取、标准拒绝与信任围栏。
 * 与姊妹插件 routes/http.ts 受控复制；每个拒绝的措辞只此一份，路由无法
 * 漂移出自己的 403/405。不 import 任何 Host peer。
 * @module dsh-connect-modelscope-token-plan/routes/http
 */
import { isAdmitted } from "../host-config.ts";
import { errMsg, redactSecrets } from "../util.ts";

/** JSON 路由的族默认响应头。 */
export const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer"
};

/** 写一个带族头的 JSON 响应。 */
export function writeJson(res: any, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, ...headers });
  res.end(payload);
}

/** 提交体的字节上限： hostile 页面不能对着路由流一个无限 body。 */
export const MAX_JSON_BODY_BYTES = 4096;

/**
 * 读一个小的 JSON 请求体，超限即拒。刻意无趣：不协商 content-type、不流式，
 * 有界收集 + 解析。
 */
export async function readJsonBody(request: any, limit = MAX_JSON_BODY_BYTES): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.byteLength;
      if (received > limit) return { ok: false, error: "request body is too large" };
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, error: "could not read the request body" };
  }
  if (chunks.length === 0) return { ok: false, error: "a JSON body is required" };
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "the body must be a JSON object" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: "the body is not valid JSON" };
  }
}

/** 信任围栏拒绝时的一律 403（面板认这个形状）。 */
export function refuseOrigin(response: any) {
  writeJson(response, 403, { ok: false, error: "forbidden: origin mismatch" });
}

/** 方法不允许时的一律 405。方法拒绝不是新答案，不带 cache-control。 */
export function refuseMethod(response: any) {
  writeJson(response, 405, { ok: false, error: "method not allowed" });
}

/**
 * 把 catch 到的错误脱敏后再进响应的 error 字段（家规红线 1：凭据永不进
 * 日志或响应）。redactSecrets 幂等，双重应用无害。
 */
export function redactedError(error: unknown): string {
  const text = redactSecrets(errMsg(error));
  return text.trim() === "" ? "request failed" : text;
}

/**
 * 写盘/操作失败的统一响应：HTTP 恒 200、成败看 body（与快照路由同一语义，
 * 一次写失败不许顺着渲染树炸穿）。**用户显式操作的失败必须上屏**，所以
 * 调用方不吞、这里只负责脱敏后的标准形状。provider 开关/清单/reset 与
 * token save/forget 五处 catch 曾各写一遍这个 writeJson——集中成一份，
 * 措辞与形状不会漂移。
 * @param {object} response - webServer 的响应对象。
 * @param {unknown} error - catch 到的任意值（未必是 Error）。
 * @returns {void}
 */
export function respondError(response: any, error: unknown): void {
  writeJson(response, 200, { ok: false, error: redactedError(error) }, { "cache-control": "no-store" });
}

/** 读并校验 JSON body，失败时写 400 并返回 null（调用方的停手信号）。 */
export async function readJsonBodyOr400(request: any, response: any, limit = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown> | null> {
  const body = await readJsonBody(request, limit);
  if (!body.ok) {
    writeJson(response, 400, { ok: false, error: body.error }, { "cache-control": "no-store" });
    return null;
  }
  return body.value;
}

/**
 * 给每个路由包上同一道信任围栏（isAdmitted），403 措辞只此一份。
 * 被包的 handler 不得再重复围栏——那只是第二道死守卫。
 */
export function withOrigin(handler: (request: any, response: any) => Promise<void>, allowedHosts: Set<string>) {
  return async (request: any, response: any) => {
    if (!isAdmitted(request, allowedHosts)) {
      refuseOrigin(response);
      return;
    }
    return handler(request, response);
  };
}
