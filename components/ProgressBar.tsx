"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { Graph, JobStatus } from "@/lib/graph";
import { useViberon } from "@/store/viberon";

type StatusResponse = {
  status?: JobStatus;
  progress?: number;
  error?: string;
  errors?: string[];
  graph?: Graph;
};

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
};

const POLL_INTERVAL_MS = 1000;

export interface ProgressBarProps {
  jobId: string;
  onComplete?: () => void;
}

export function ProgressBar({ jobId, onComplete }: ProgressBarProps) {
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<JobStatus>("queued");
  const [error, setError] = useState<string | null>(null);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const poll = async () => {
      try {
        const response = await fetch(`/api/repos/${jobId}/status`);

        if (cancelled) return;

        if (response.status === 404) {
          stop();
          setStatus("failed");
          setError("Job not found");
          toast.error("Job not found");
          return;
        }

        const body = (await response.json().catch(() => ({}))) as StatusResponse;
        if (cancelled) return;

        if (typeof body.progress === "number") {
          setProgress(Math.max(0, Math.min(100, body.progress)));
        }
        if (body.status) {
          setStatus(body.status);
        }

        if (body.status === "succeeded") {
          stop();
          if (body.graph) {
            useViberon.getState().setGraph(body.graph);
          }
          setProgress(100);
          onCompleteRef.current?.();
          return;
        }

        if (body.status === "failed") {
          stop();
          const message = body.error ?? "Ingestion failed";
          setError(message);
          toast.error(message);
        }
      } catch {
        // Transient network errors: keep polling on the next tick.
      }
    };

    void poll();
    timer = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      stop();
    };
  }, [jobId]);

  return (
    <div className="w-full">
      <div className="mb-2 flex items-center justify-between text-sm text-muted-foreground">
        <span>{STATUS_LABELS[status]}</span>
        <span className="font-mono tabular-nums">{Math.round(progress)}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
        className="relative h-1 w-full overflow-hidden rounded-[2px] bg-[var(--vb-fill)]"
      >
        <div
          className="absolute left-0 top-0 h-full bg-primary transition-[width] duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
      {status === "failed" && error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default ProgressBar;
