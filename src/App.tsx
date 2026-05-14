import { useEffect, useRef, useState } from "react";

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
  | { id: number; type: "result"; redacted: string; entities: Entity[] }
  | { id: number; type: "error"; error: string };

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

export function App() {
  const [input, setInput] = useState(sampleText);
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState("Model not loaded");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const requestId = useRef(0);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL("./piiWorker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;

      if (message.type === "progress") {
        const pct = typeof message.progress === "number" ? ` ${message.progress.toFixed(0)}%` : "";
        setStatus(`${message.status}${pct}`);
        return;
      }

      if (message.id !== requestId.current) return;

      if (message.type === "ready") {
        setStatus("Running local inference...");
        return;
      }

      if (message.type === "result") {
        setOutput(message.redacted);
        setStatus(
          `Redacted ${message.entities.length} span${message.entities.length === 1 ? "" : "s"}`,
        );
        setIsRunning(false);
        return;
      }

      setError(message.error);
      setStatus("Inference failed");
      setIsRunning(false);
    };

    worker.onerror = (event) => {
      setError(event.message);
      setStatus("Worker failed");
      setIsRunning(false);
    };

    worker.onmessageerror = () => {
      setError("The inference worker sent an unreadable message.");
      setStatus("Worker failed");
      setIsRunning(false);
    };

    return () => {
      workerRef.current = null;
      worker.terminate();
    };
  }, []);

  const runRedaction = () => {
    setCopied(false);
    setError("");
    setIsRunning(true);
    requestId.current += 1;

    if (window.stupidRedact) {
      setStatus("Running local inference...");
      window.stupidRedact
        .redact(input)
        .then((result) => {
          setOutput(result.redacted);
          setStatus(
            typeof result.spanCount === "number"
              ? `Redacted ${result.spanCount} spans`
              : "Redacted text",
          );
        })
        .catch((error: unknown) => {
          setError(error instanceof Error ? error.message : "Local inference failed");
          setStatus("Inference failed");
        })
        .finally(() => setIsRunning(false));
      return;
    }

    setStatus(
      hasWebGpu()
        ? "Loading OpenAI Privacy Filter locally..."
        : "WebGPU is required for this model.",
    );
    workerRef.current?.postMessage({ id: requestId.current, text: input, backend: getBackend() });
  };

  const copyOutput = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
  };

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
          <span className={isRunning ? "pulse" : "dot"} />
          <span>{status}</span>
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
        <button className="secondary" onClick={copyOutput} disabled={!output}>
          {copied ? "Copied" : "Copy output"}
        </button>
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
