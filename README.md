# Stupid Redact

Vite + React app that redacts PII from text locally in the browser with `openai/privacy-filter` and Transformers.js.

## Run

```sh
bun install
bun run dev
```

Open the local Vite URL in a WebGPU-capable browser such as recent Chrome or Edge. The first run downloads the quantized model into the browser cache; inference runs locally after that.

## Build

```sh
bun run build
```

## Deploy

```sh
bun run deploy
```

The Cloudflare Worker is configured in `wrangler.jsonc` and serves the app at `redact.stupidtech.net`.

## Notes

- Input text stays in the browser. No application server is used.
- Redaction uses model span offsets when provided, preserving original whitespace, line breaks, and paragraph formatting.
- The model can miss or over-redact PII. Use review and domain-specific evaluation for sensitive workflows.
