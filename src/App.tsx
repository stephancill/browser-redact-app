import { useEffect, useRef, useState } from "react";
import { redactDocx, type RedactionSpan } from "./docx";

type Entity = {
  entity_group?: string;
  entity?: string;
  score?: number;
  word?: string;
  start?: number;
  end?: number;
};

type WorkerResponse =
  | { id: number; type: "ready" }
  | { id: number; type: "progress"; status: string; progress?: number }
  | { id: number; type: "result"; redacted: string; entities: Entity[]; spans: RedactionSpan[] }
  | { id: number; type: "error"; error: string };

type RedactResult = {
  redacted: string;
  spanCount?: number;
  spans?: RedactionSpan[];
};

type PendingRequest = {
  resolve: (result: RedactResult) => void;
  reject: (error: Error) => void;
};

type ProgressMessage = string | { message?: string; progress?: number };

const sampleText = `Subject: Q2 Planning Follow-Up

Hi Jordan,

Thanks again for meeting earlier today. I wanted to follow up with the revised timeline for the Q2 rollout and confirm that the product launch is scheduled for September 18, 2026. For reference, the project file is listed under 4829-1037-5581. If anything changes on your side, feel free to reply here at maya.chen@example.com or call me at +1 (415) 555-0124.

Best,

Maya Chen`;

const hasWebGpu = () => "gpu" in navigator;

const getBackend = () => {
  const backend = new URLSearchParams(window.location.search).get("backend");
  return backend === "webgpu" ? backend : "auto";
};

const isDesktop = () => Boolean(window.stupidRedact);
const releaseUrl = "https://github.com/stephancill/browser-redact-app/releases/latest";

function getProgress(message: string) {
  const match = message.match(/(\d+(?:\.\d+)?)%/);
  return match ? Math.max(0, Math.min(100, Number(match[1]))) : null;
}

function downloadBlob({ blob, fileName }: { blob: Blob; fileName: string }) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function App() {
  const [input, setInput] = useState(sampleText);
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState("Model not loaded");
  const [progress, setProgress] = useState<number | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [docxName, setDocxName] = useState("");
  const [docxBlob, setDocxBlob] = useState<Blob | null>(null);
  const [docxOutputName, setDocxOutputName] = useState("");
  const requestId = useRef(0);
  const workerRef = useRef<Worker | null>(null);
  const pendingRequests = useRef(new Map<number, PendingRequest>());

  const updateProgress = (message: ProgressMessage) => {
    const status = typeof message === "string" ? message : (message.message ?? "Loading model");
    const nextProgress =
      typeof message === "string"
        ? getProgress(message)
        : (message.progress ?? getProgress(status));

    setStatus(status);
    setProgress(nextProgress);
  };

  useEffect(() => {
    const unsubscribeProgress = window.stupidRedact?.onProgress(updateProgress);

    if (window.stupidRedact) {
      setIsPreparing(true);
      setStatus("Preparing local model...");
      setProgress(null);
      window.stupidRedact
        .warmup()
        .then(() => {
          setStatus("Local model ready");
          setProgress(100);
        })
        .catch((error: unknown) => {
          setError(error instanceof Error ? error.message : "Local model warmup failed");
          setStatus("Model warmup failed");
          setProgress(null);
        })
        .finally(() => setIsPreparing(false));
    }

    const worker = new Worker(new URL("./piiWorker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;

      if (message.type === "progress") {
        const pct = typeof message.progress === "number" ? ` ${message.progress.toFixed(0)}%` : "";
        setStatus(`${message.status}${pct}`);
        setProgress(message.progress ?? null);
        return;
      }

      const pending = pendingRequests.current.get(message.id);

      if (message.type === "ready") {
        setStatus("Running local inference...");
        setProgress(null);
        return;
      }

      if (!pending) return;

      pendingRequests.current.delete(message.id);

      if (message.type === "result") {
        pending.resolve({
          redacted: message.redacted,
          spans: message.spans,
          spanCount: message.entities.length,
        });
        return;
      }

      pending.reject(new Error(message.error));
    };

    worker.onerror = (event) => {
      for (const pending of pendingRequests.current.values()) {
        pending.reject(new Error(event.message));
      }
      pendingRequests.current.clear();
      setStatus("Worker failed");
      setProgress(null);
      setIsRunning(false);
    };

    worker.onmessageerror = () => {
      for (const pending of pendingRequests.current.values()) {
        pending.reject(new Error("The inference worker sent an unreadable message."));
      }
      pendingRequests.current.clear();
      setStatus("Worker failed");
      setProgress(null);
      setIsRunning(false);
    };

    return () => {
      unsubscribeProgress?.();
      pendingRequests.current.clear();
      workerRef.current = null;
      worker.terminate();
    };
  }, []);

  const redactText = async (text: string): Promise<RedactResult> => {
    if (window.stupidRedact) {
      setStatus("Running local inference...");
      setProgress(null);
      return await window.stupidRedact.redact(text);
    }

    setStatus(
      hasWebGpu()
        ? "Loading OpenAI Privacy Filter locally..."
        : "WebGPU is required for this model.",
    );
    setProgress(null);

    requestId.current += 1;
    const id = requestId.current;

    return await new Promise((resolve, reject) => {
      pendingRequests.current.set(id, { resolve, reject });
      workerRef.current?.postMessage({ id, text, backend: getBackend() });
    });
  };

  const runRedaction = async () => {
    setCopied(false);
    setError("");
    setIsRunning(true);

    try {
      const result = await redactText(input);
      setOutput(result.redacted);
      setStatus(
        typeof result.spanCount === "number"
          ? `Redacted ${result.spanCount} span${result.spanCount === 1 ? "" : "s"}`
          : "Redacted text",
      );
      setProgress(null);
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : "Local inference failed");
      setStatus("Inference failed");
      setProgress(null);
    } finally {
      setIsRunning(false);
    }
  };

  const uploadDocx = async (file: File | undefined) => {
    if (!file) return;

    setCopied(false);
    setError("");
    setIsRunning(true);
    setDocxName(file.name);
    setDocxBlob(null);
    setDocxOutputName("");
    setOutput("");

    try {
      const result = await redactDocx({ file, redactText, onStatus: setStatus });
      setInput(result.text);
      setOutput(`DOCX ready: ${result.fileName}`);
      setDocxBlob(result.blob);
      setDocxOutputName(result.fileName);
      setStatus("DOCX redaction complete");
      setProgress(null);
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : "DOCX redaction failed");
      setStatus("DOCX redaction failed");
      setProgress(null);
    } finally {
      setIsRunning(false);
    }
  };

  const copyOutput = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
  };

  const showProgress = isPreparing || (isRunning && progress !== null);

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <h1>Stupid Redact</h1>
          <p className="lede">
            Redact PII from text on your machine without sending data to a server.
          </p>
        </div>
        <div className="statusCard">
          <span>{status}</span>
          {showProgress && (
            <div className="progressTrack" aria-label="Model loading progress">
              <div
                className={progress === null ? "progressBar indeterminate" : "progressBar"}
                style={progress === null ? undefined : { width: `${progress}%` }}
              />
            </div>
          )}
        </div>
      </section>

      {!isDesktop() && !hasWebGpu() && (
        <p className="warning">
          This browser cannot run the local model. Download the desktop app from{" "}
          <a href={releaseUrl}>GitHub Releases</a>.
        </p>
      )}

      {error && <p className="error">{error}</p>}

      <section className="actions">
        <button onClick={runRedaction} disabled={isRunning || input.trim().length === 0}>
          {isRunning ? "Redacting..." : "Remove PII locally"}
        </button>
        <label className="fileButton">
          Upload DOCX
          <input
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(event) => uploadDocx(event.target.files?.[0])}
            disabled={isRunning}
          />
        </label>
        <button
          className="secondary"
          onClick={() => docxBlob && downloadBlob({ blob: docxBlob, fileName: docxOutputName })}
          disabled={!docxBlob}
        >
          Download DOCX
        </button>
        <button className="secondary" onClick={copyOutput} disabled={!output}>
          {copied ? "Copied" : "Copy output"}
        </button>
        {docxName && <span className="fileName">{docxName}</span>}
      </section>

      <section className="panes">
        <label className="pane">
          <span>Input</span>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            spellCheck={false}
          />
        </label>

        <label className="pane">
          <span>Redacted output</span>
          <textarea
            value={output}
            readOnly
            placeholder="Redacted text will appear here."
            spellCheck={false}
          />
        </label>
      </section>
    </main>
  );
}
