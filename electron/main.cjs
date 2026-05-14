const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const { mkdirSync } = require("node:fs");
const path = require("node:path");

const isDev = !app.isPackaged;
const opfExecutableName = process.platform === "win32" ? "opf-runner.exe" : "opf-runner";

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
  const lines = text.split(/\r?\n/).filter(Boolean);

  for (const line of lines.toReversed()) {
    try {
      const payload = JSON.parse(line);
      if (typeof payload.redacted_text === "string") return payload.redacted_text;
    } catch {
      // Keep looking for the JSON line; OPF may print progress or warnings.
    }
  }

  return text;
}

function getOpfCommand() {
  if (process.env.OPF_BIN) return { command: process.env.OPF_BIN, args: [] };

  const bundledPath = app.isPackaged
    ? path.join(process.resourcesPath, "runtime", opfExecutableName)
    : path.join(__dirname, "..", "runtime", opfExecutableName);

  return { command: bundledPath, args: [] };
}

function getCheckpointPath() {
  const checkpointPath = path.join(app.getPath("userData"), "models", "privacy-filter");
  mkdirSync(path.dirname(checkpointPath), { recursive: true });
  return checkpointPath;
}

ipcMain.handle("redact:text", async (_event, text) => {
  if (typeof text !== "string" || text.length === 0) {
    return { redacted: "", spanCount: 0 };
  }

  return await new Promise((resolve, reject) => {
    const opf = getOpfCommand();
    const child = spawn(opf.command, [...opf.args, "--device", "cpu", "--output-mode", "typed"], {
      env: { ...process.env, NO_COLOR: "1", OPF_CHECKPOINT: getCheckpointPath() },
      stdio: ["pipe", "pipe", "pipe"],
    });

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
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
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

      if (code !== 0) {
        reject(new Error(stderr.trim() || `OPF exited with code ${code}`));
        return;
      }

      try {
        const redacted = parseOpfOutput(stdout);
        resolve({ redacted, spanCount: redacted === text ? 0 : undefined });
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(text);
  });
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
