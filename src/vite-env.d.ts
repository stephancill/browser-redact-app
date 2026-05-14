/// <reference types="vite/client" />

type NativeRedactResult = {
  redacted: string;
  spanCount?: number;
};

interface Window {
  stupidRedact?: {
    redact: (text: string) => Promise<NativeRedactResult>;
  };
}
