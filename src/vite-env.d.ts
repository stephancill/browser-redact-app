/// <reference types="vite/client" />

type NativeRedactResult = {
  redacted: string;
  spanCount?: number;
  spans?: Array<{
    start: number;
    end: number;
    label?: string;
    placeholder?: string;
  }>;
};

type NativeProgressMessage = {
  message?: string;
  progress?: number;
};

interface Window {
  stupidRedact?: {
    warmup: () => Promise<void>;
    redact: (text: string) => Promise<NativeRedactResult>;
    onProgress: (callback: (message: NativeProgressMessage | string) => void) => () => void;
  };
}
