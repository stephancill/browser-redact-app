# Stupid Redact

Cross-platform local app that redacts PII from text on your machine without sending data to a server.

## Run

```sh
bun install
bun run dev
```

Open the local Vite URL in a WebGPU-capable browser such as recent Chrome or Edge. The first run downloads the quantized model into the browser cache; inference runs locally after that.

## Desktop Development

The Electron app downloads the OPF runtime on demand in packaged builds. For local development, build that runtime first:

```sh
bun run desktop:runtime
```

Then run the desktop app:

```sh
bun run desktop:dev
```

You can point development at a different OPF-compatible executable with `OPF_BIN=/path/to/opf-runner`.

## Desktop Release

Build a platform-specific installer:

```sh
bun run desktop:build
```

The installer is small. End users only need to download and install the app.

The OPF runtime and model checkpoint are downloaded on first use into the app data directory and reused after that. First use requires an internet connection.

The runtime is platform-specific. Build the installer on each target OS, or use CI runners for macOS, Windows, and Linux.

## Web Build

```sh
bun run build
```

Open the local Vite URL in a WebGPU-capable browser such as recent Chrome or Edge. The web build uses browser WebGPU and has stricter compatibility than the desktop app.

## Web Development

```sh
bun install
bun run dev
```

## Deploy

```sh
bun run deploy
```

The Cloudflare Worker is configured in `wrangler.jsonc` and serves the app at `redact.stupidtech.net`.

## Notes

- Input text stays on the local machine. No application server is used.
- Redaction uses model span offsets when provided, preserving original whitespace, line breaks, and paragraph formatting.
- The web build requires WebGPU with a large enough per-buffer limit. WASM/CPU is not currently supported by the quantized ONNX model.
- The browser downloads model weights on first use and should reuse its browser cache on later visits, subject to browser storage quota and eviction policies.
- The desktop app runs a downloaded OPF runtime locally, so it can support machines that cannot run the browser WebGPU path.
- The desktop app downloads the runtime and model on demand to the app data directory instead of bundling them in the installer.
- The model can miss or over-redact PII. Use review and domain-specific evaluation for sensitive workflows.
