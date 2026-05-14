const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { get } = require("node:https");
const path = require("node:path");

const isDev = !app.isPackaged;
const opfExecutableName = process.platform === "win32" ? "opf-runner.exe" : "opf-runner";
const runtimeAssetName = `opf-runner-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
const runtimeDownloadUrl = `https://github.com/stephancill/browser-redact-app/releases/latest/download/${runtimeAssetName}`;

function progressFromMessage(message) {
  const match = message.match(/(\d+(?:\.\d+)?)%/);
  if (!match) return undefined;

  return Math.max(0, Math.min(100, Number(match[1])));
}

function sendProgress(event, message, progress = progressFromMessage(message)) {
  event.sender.send("redact:progress", { message, progress });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Stupid Redact",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    window.loadURL(process.env.ELECTRON_START_URL || "http://127.0.0.1:5199");
  } else {
    window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

function parseOpfOutput(stdout) {
  const text = stdout.trim();
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");

  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    const payload = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    if (typeof payload.redacted_text === "string") {
      return {
        redacted: payload.redacted_text,
        spans: Array.isArray(payload.detected_spans) ? payload.detected_spans : [],
      };
    }
  }

  const lines = text.split(/\r?\n/).filter(Boolean);

  for (const line of lines.toReversed()) {
    try {
      const payload = JSON.parse(line);
      if (typeof payload.redacted_text === "string") {
        return {
          redacted: payload.redacted_text,
          spans: Array.isArray(payload.detected_spans) ? payload.detected_spans : [],
        };
      }
    } catch {
      // Keep looking for the JSON line; OPF may print progress or warnings.
    }
  }

  return { redacted: text, spans: [] };
}

async function downloadFile(url, destination, onProgress) {
  await new Promise((resolve, reject) => {
    const tempDestination = `${destination}.download`;
    rmSync(tempDestination, { force: true });

    const request = get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        response.resume();
        downloadFile(response.headers.location, destination, onProgress).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to download runtime: HTTP ${response.statusCode}`));
        return;
      }

      const file = createWriteStream(tempDestination);
      const total = Number(response.headers["content-length"] ?? 0);
      let received = 0;

      response.on("data", (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const progress = Math.round((received / total) * 100);
          onProgress(`Downloading runtime ${progress}%`, progress);
        } else {
          onProgress(`Downloading runtime ${Math.round(received / 1024 / 1024)} MB`);
        }
      });

      response.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          renameSync(tempDestination, destination);
          if (process.platform !== "win32") chmodSync(destination, 0o755);
          resolve();
        });
      });
      file.on("error", reject);
    });

    request.on("error", reject);
  });
}

async function getOpfCommand(onProgress) {
  if (process.env.OPF_BIN) return { command: process.env.OPF_BIN, args: [] };

  const runtimePath = path.join(app.getPath("userData"), "runtime", opfExecutableName);
  mkdirSync(path.dirname(runtimePath), { recursive: true });

  if (!existsSync(runtimePath)) {
    onProgress("Downloading local runtime...");
    await downloadFile(runtimeDownloadUrl, runtimePath, onProgress);
    onProgress("Local runtime ready");
  }

  return { command: runtimePath, args: [] };
}

function getRuntimeHome() {
  if (process.env.STUPID_REDACT_RUNTIME_HOME) {
    mkdirSync(process.env.STUPID_REDACT_RUNTIME_HOME, { recursive: true });
    return process.env.STUPID_REDACT_RUNTIME_HOME;
  }

  const homePath = path.join(app.getPath("userData"), "opf-home");
  mkdirSync(homePath, { recursive: true });
  return homePath;
}

async function runOpfText({ event, text, status }) {
  const opf = await getOpfCommand((message, progress) => sendProgress(event, message, progress));
  const runtimeHome = getRuntimeHome();
  const inputPath = path.join(app.getPath("userData"), `redact-input-${Date.now()}.txt`);
  writeFileSync(inputPath, text, "utf8");
  sendProgress(event, status);

  return await new Promise((resolve, reject) => {
    const child = spawn(
      opf.command,
      [
        ...opf.args,
        "--device",
        "cpu",
        "--output-mode",
        "typed",
        "--format",
        "json",
        "--json-indent",
        "0",
        "--no-print-color-coded-text",
        "-f",
        inputPath,
      ],
      {
        env: {
          ...process.env,
          HOME: runtimeHome,
          USERPROFILE: runtimeHome,
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Local OPF inference timed out."));
    }, 30 * 60_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      const message = chunk.toString();
      stderr += message;

      const lastLine = message
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);

      if (lastLine) sendProgress(event, lastLine);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      rmSync(inputPath, { force: true });
      if (error.code === "ENOENT") {
        reject(
          new Error(
            "The bundled redaction runtime is missing. Rebuild the app with: bun run desktop:runtime",
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      rmSync(inputPath, { force: true });

      if (code !== 0) {
        reject(new Error(stderr.trim() || `OPF exited with code ${code}`));
        return;
      }

      try {
        resolve(parseOpfOutput(stdout));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end();
  });
}

let warmupPromise;

function warmupModel(event) {
  if (!warmupPromise) {
    warmupPromise = runOpfText({
      event,
      text: "warmup@example.com",
      status: "Preparing local model...",
    }).catch((error) => {
      warmupPromise = undefined;
      throw error;
    });
  }

  return warmupPromise.then(() => undefined);
}

ipcMain.handle("redact:warmup", async (event) => {
  await warmupModel(event);
});

ipcMain.handle("redact:text", async (event, text) => {
  if (typeof text !== "string" || text.length === 0) {
    return { redacted: "", spanCount: 0 };
  }

  if (warmupPromise) await warmupPromise.catch(() => undefined);

  const result = await runOpfText({ event, text, status: "Starting local redaction..." });
  return {
    redacted: result.redacted,
    spans: result.spans,
    spanCount: result.spans.length || (result.redacted === text ? 0 : undefined),
  };
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
