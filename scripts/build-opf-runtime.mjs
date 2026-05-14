import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(rootDir, ".runtime-build");
const runtimeDir = join(rootDir, "runtime");
const isWindows = process.platform === "win32";
const pythonBin = process.env.PYTHON_BIN ?? (isWindows ? "python" : "python3");
const venvDir = join(buildDir, "venv");
const venvBinDir = isWindows ? join(venvDir, "Scripts") : join(venvDir, "bin");
const python = join(venvBinDir, isWindows ? "python.exe" : "python");
const pyinstaller = join(venvBinDir, isWindows ? "pyinstaller.exe" : "pyinstaller");
const runnerPath = join(buildDir, "opf_runner.py");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

rmSync(buildDir, { force: true, recursive: true });
rmSync(runtimeDir, { force: true, recursive: true });
mkdirSync(buildDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });

run(pythonBin, ["-m", "venv", venvDir]);
run(python, ["-m", "pip", "install", "--upgrade", "pip"]);
run(python, [
  "-m",
  "pip",
  "install",
  "pyinstaller",
  "git+https://github.com/openai/privacy-filter",
]);

writeFileSync(
  runnerPath,
  `import multiprocessing\nfrom opf.__main__ import main\n\nif __name__ == "__main__":\n    multiprocessing.freeze_support()\n    main()\n`,
);

run(pyinstaller, [
  "--onefile",
  "--name",
  "opf-runner",
  "--collect-all",
  "tiktoken",
  "--collect-all",
  "tiktoken_ext",
  "--hidden-import",
  "tiktoken_ext.openai_public",
  "--distpath",
  runtimeDir,
  "--workpath",
  join(buildDir, "pyinstaller"),
  "--specpath",
  buildDir,
  runnerPath,
]);

const executable = join(runtimeDir, isWindows ? "opf-runner.exe" : "opf-runner");

if (!existsSync(executable)) {
  console.error(`Failed to build bundled OPF runtime at ${executable}`);
  process.exit(1);
}

console.log(`Built bundled OPF runtime at ${executable}`);
