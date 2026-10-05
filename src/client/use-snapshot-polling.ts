/**
 * 快照轮询 hook（与姊妹插件 use-snapshot-polling.ts 受控复制）：generation
 * guard 防乱序覆盖、跟随 Host 声明的 cadence、隐藏页暂停（use-polling-interval）、
 * 失败退避、卸载即停。loadedOnce 门槛把首帧定为「加载中」而不是误闪的配置表单。
 * @module dsh-connect-modelscope-token-plan/use-snapshot-polling
 */
import { useEffect, useCallback, useRef, useState } from "./runtime.ts";
import { errorOfStatus, interpretSnapshot, type PanelFailure } from "./snapshot.ts";
import { statedCadenceMs, errorText } from "./format.ts";
import { usePollingInterval } from "./use-polling-interval.ts";
import { SNAPSHOT_PATH } from "./const.ts";
import type { Snapshot as SnapshotData } from "../shared/wire.ts";

export function useSnapshotPolling(defaultCadenceMs = 30_000) {
  const [data, setData] = useState<SnapshotData | null>(null);
  const [error, setError] = useState<PanelFailure | string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [cadenceMs, setCadenceMs] = useState(defaultCadenceMs);
  /** Host 少给的顶层键（契约漂移）；透给面板当 shapeWarning，不静默。 */
  const [missingKeys, setMissingKeys] = useState<readonly string[]>([]);

  // generation guard：慢响应不许覆盖新响应；手动刷新可以顶掉在途的定时轮询。
  const generation = useRef(0);
  const inFlight = useRef<{ abort?: () => void } | null>(null);
  // cadence 的回退值经ref 读，不进 useCallback 依赖：否则 Host 每次改声明
  // cadence 都会让 load 换新引用，连锁换掉三个写回调，再连锁换掉 ProviderCard
  // 的 onToggle/onSaveList/onReset —— 组件树无意义地多渲染一轮。
  const cadenceRef = useRef(cadenceMs);
  cadenceRef.current = cadenceMs;

  const load = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    const isCurrent = () => generation.current === mine;
    inFlight.current?.abort?.();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    inFlight.current = controller;
    try {
      const response = await fetch(SNAPSHOT_PATH, {
        headers: { accept: "application/json" },
        cache: "no-store",
        ...(controller ? { signal: controller.signal } : {})
      });
      if (!isCurrent()) return;
      if (!response.ok) {
        setError(errorOfStatus(response.status));
        return;
      }
      // Host 挂掉时（反向代理/登录墙）响应的 `ok` 仍可能是 true 而 body 是
      // HTML ——裸 `json()` 会抛 SyntaxError，而 `errorText` 对 Error 返回
      // `.message`，于是那段 HTML 源码会被整个塞进面板正文。解析失败一律读作
      // null，交给 interpretSnapshot 的 "unexpected payload" 分支（同仓http.ts
      // 的 postJson 早就是这么做的，这里是漏）。
      const body = await response.json().catch(() => null);
      if (!isCurrent()) return;
      const read = interpretSnapshot(body);
      if (read.data === null) {
        setData(null);
        setMissingKeys([]);
        setError(read.error);
        return;
      }
      setData(read.data);
      setMissingKeys(read.missingKeys ?? []);
      setError(null);
      setUpdatedAt(Date.now());
      const stated = (read.data as { pollSeconds?: unknown })?.pollSeconds;
      if (typeof stated === "number" && Number.isFinite(stated)) {
        setCadenceMs(statedCadenceMs(stated, cadenceRef.current));
      }
    } catch (reason) {
      // abort 是我们自己的顶替，不是网络故障。
      if (!isCurrent()) return;
      setError(errorText(reason));
    } finally {
      if (isCurrent()) setLoadedOnce(true);
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, []);

  const failed = error !== null;
  usePollingInterval(load, cadenceMs, { failed });

  // 仅卸载时（空依赖）作废在途轮询：与循环 hook 的 cleanup 分开，那个在每次
  // cadence 重建时也会跑，而此刻本 hook 仍在挂载、请求仍然有效。
  useEffect(() => () => {
    generation.current += 1;
    inFlight.current?.abort?.();
  }, []);

  return { data, error, loadedOnce, updatedAt, load, missingKeys };
}
