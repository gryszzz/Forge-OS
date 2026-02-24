/**
 * useAnalyticsWorker
 * Off-threads the heavy calculatePerformanceMetrics calculation into
 * analyticsEngine.worker.ts so the UI thread stays responsive.
 */
import { useEffect, useRef, useState } from "react";
import type { PerformanceMetrics, TechnicalIndicators } from "../../../workers/analyticsEngine.worker";

let _workerReqId = 0;

export type AnalyticsWorkerResult = {
  metrics: PerformanceMetrics | null;
  indicators: TechnicalIndicators | null;
  busy: boolean;
  error: string | null;
};

export function useAnalyticsWorker(decisions: any[], queue: any[]): AnalyticsWorkerResult {
  const workerRef = useRef<Worker | null>(null);
  const [result, setResult] = useState<AnalyticsWorkerResult>({
    metrics: null,
    indicators: null,
    busy: false,
    error: null,
  });

  // Boot the worker once
  useEffect(() => {
    try {
      workerRef.current = new Worker(
        new URL("../../../workers/analyticsEngine.worker.ts", import.meta.url),
        { type: "module" }
      );
      workerRef.current.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if (!msg) return;
        if (msg.ok) {
          setResult({ metrics: msg.metrics, indicators: msg.indicators, busy: false, error: null });
        } else {
          setResult(prev => ({ ...prev, busy: false, error: String(msg.error || "worker error") }));
        }
      };
      workerRef.current.onerror = (e) => {
        setResult(prev => ({ ...prev, busy: false, error: String(e.message || "worker crashed") }));
      };
    } catch {
      // Worker not available (e.g. SSR) – fall back to null metrics
    }
    return () => { workerRef.current?.terminate(); };
  }, []);

  // Post a new calculation whenever decisions or queue change
  useEffect(() => {
    if (!workerRef.current) return;
    const id = ++_workerReqId;
    setResult(prev => ({ ...prev, busy: true, error: null }));
    workerRef.current.postMessage({ id, decisions, queue });
  }, [decisions, queue]);

  return result;
}
