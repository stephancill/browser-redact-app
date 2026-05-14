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
};

type WorkerResponse =
  | { id: number; type: "ready" }
  | { id: number; type: "progress"; status: string; progress?: number }
  | { id: number; type: "result"; redacted: string; entities: Entity[] }
  | { id: number; type: "error"; error: string };

let classifierPromise: ReturnType<typeof createClassifier> | undefined;

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

async function createClassifier() {
  return pipeline("token-classification", "openai/privacy-filter", {
    device: "webgpu",
    dtype: "q4",
    progress_callback: (progress: { status?: string; progress?: number; file?: string }) => {
      postMessage({
        id: 0,
        type: "progress",
        status: progress.file
          ? `${progress.status}: ${progress.file}`
          : (progress.status ?? "Loading model"),
        progress: progress.progress,
      } satisfies WorkerResponse);
    },
  });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, text } = event.data;

  try {
    classifierPromise ??= createClassifier();
    const classifier = await classifierPromise;

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
