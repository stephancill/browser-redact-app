import { env, pipeline } from "@huggingface/transformers";

env.allowRemoteModels = true;
env.allowLocalModels = false;
env.useBrowserCache = true;

type Entity = {
  entity_group?: string;
  entity?: string;
  score?: number;
  word?: string;
  start?: number;
  end?: number;
};

type WorkerRequest = {
  id: number;
  text: string;
  backend: BackendPreference;
};

type WorkerResponse =
  | { id: number; type: "ready" }
  | { id: number; type: "progress"; status: string; progress?: number }
  | { id: number; type: "result"; redacted: string; entities: Entity[] }
  | { id: number; type: "error"; error: string };

type BackendPreference = "auto" | "webgpu";

type Classifier = (text: string, options: { aggregation_strategy: "simple" }) => Promise<unknown>;

type ClassifierState = {
  classifier: Classifier;
};

type GpuNavigator = Navigator & {
  gpu?: {
    requestAdapter: () => Promise<{
      limits?: {
        maxBufferSize?: number;
      };
    } | null>;
  };
};

const minWebGpuBufferSize = 3_000_000_000;

const classifierPromises = new Map<BackendPreference, ReturnType<typeof createClassifier>>();

const labelFor = (entity: Entity) => {
  const raw = entity.entity_group ?? entity.entity ?? "PII";
  return `[${raw.replace(/^[BIES]-/, "").toUpperCase()}]`;
};

const redactWithOffsets = ({ text, entities }: { text: string; entities: Entity[] }) => {
  const spans = entities
    .filter((entity) => Number.isInteger(entity.start) && Number.isInteger(entity.end))
    .map((entity) => ({
      start: entity.start!,
      end: entity.end!,
      label: labelFor(entity),
    }))
    .filter((span) => span.start >= 0 && span.end > span.start && span.end <= text.length)
    .sort((a, b) => b.start - a.start);

  if (spans.length === 0) {
    return redactByWord({ text, entities });
  }

  return spans.reduce(
    (value, span) => `${value.slice(0, span.start)}${span.label}${value.slice(span.end)}`,
    text,
  );
};

const redactByWord = ({ text, entities }: { text: string; entities: Entity[] }) => {
  let redacted = text;
  let searchFrom = 0;

  for (const entity of entities) {
    const word = entity.word?.trim();
    if (!word) continue;

    const index = redacted.indexOf(word, searchFrom);
    if (index === -1) continue;

    const label = labelFor(entity);
    redacted = `${redacted.slice(0, index)}${label}${redacted.slice(index + word.length)}`;
    searchFrom = index + label.length;
  }

  return redacted;
};

const progressCallback = (progress: { status?: string; progress?: number; file?: string }) => {
  postMessage({
    id: 0,
    type: "progress",
    status: progress.file
      ? `${progress.status}: ${progress.file}`
      : (progress.status ?? "Loading model"),
    progress: progress.progress,
  } satisfies WorkerResponse);
};

const canUseWebGpu = async () => {
  const gpu = (navigator as GpuNavigator).gpu;
  if (!gpu) {
    throw new Error(
      "This model requires WebGPU. Open this app in a recent Chrome or Edge browser.",
    );
  }

  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new Error("WebGPU is available, but no compatible GPU adapter was found.");
  }

  const maxBufferSize = adapter?.limits?.maxBufferSize ?? 0;

  if (maxBufferSize < minWebGpuBufferSize) {
    throw new Error(
      `This GPU cannot load the local model. WebGPU maxBufferSize is ${maxBufferSize}, but at least ${minWebGpuBufferSize} is required.`,
    );
  }

  return true;
};

const isWebGpuBufferError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("WebGPU validation failed") && message.includes("max buffer size");
};

async function loadClassifier() {
  return (await pipeline("token-classification", "openai/privacy-filter", {
    device: "webgpu",
    dtype: "q4",
    progress_callback: progressCallback,
  })) as Classifier;
}

async function createClassifier(backend: BackendPreference): Promise<ClassifierState> {
  if (backend !== "auto" && backend !== "webgpu") throw new Error("Unsupported backend.");

  await canUseWebGpu();

  try {
    return { classifier: await loadClassifier() };
  } catch (error) {
    if (!isWebGpuBufferError(error)) throw error;

    throw new Error(
      "This GPU cannot load the local model because its WebGPU buffer limit is too low.",
    );
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, text, backend } = event.data;

  try {
    if (!classifierPromises.has(backend)) {
      classifierPromises.set(backend, createClassifier(backend));
    }

    const classifierPromise = classifierPromises.get(backend)!;
    const { classifier } = await classifierPromise;

    postMessage({ id, type: "ready" } satisfies WorkerResponse);

    const output = (await classifier(text, {
      aggregation_strategy: "simple",
    })) as Entity[];

    postMessage({
      id,
      type: "result",
      redacted: redactWithOffsets({ text, entities: output }),
      entities: output,
    } satisfies WorkerResponse);
  } catch (error) {
    postMessage({
      id,
      type: "error",
      error: error instanceof Error ? error.message : "Unknown worker error",
    } satisfies WorkerResponse);
  }
};
