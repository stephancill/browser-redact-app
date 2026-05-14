import { _electron as electron } from "playwright-core";
import JSZip from "jszip";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronMain = join(rootDir, "electron", "main.cjs");
const runtimeBin = join(
  rootDir,
  "runtime",
  process.platform === "win32" ? "opf-runner.exe" : "opf-runner",
);
const sampleText = "Alice Smith can be reached at alice@example.com\nor +1 415 555 0199.";
const expectedText = "<PRIVATE_PERSON> can be reached at <PRIVATE_EMAIL>\nor <PRIVATE_PHONE>.";
const sampleDocx = join(tmpdir(), "stupid-redact-e2e.docx");

const zip = new JSZip();
zip.file(
  "[Content_Types].xml",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
);
zip.file(
  "_rels/.rels",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
);
zip.file(
  "word/document.xml",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Alice Smith can be reached at alice@example.com</w:t></w:r></w:p>
  </w:body>
</w:document>`,
);
await writeFile(sampleDocx, await zip.generateAsync({ type: "nodebuffer" }));

const app = await electron.launch({
  args: [electronMain],
  env: {
    ...process.env,
    ELECTRON_START_URL: `file://${join(rootDir, "dist", "index.html")}`,
    OPF_BIN: runtimeBin,
    STUPID_REDACT_RUNTIME_HOME: "/tmp/stupid-redact-e2e-home",
  },
});

try {
  const page = await app.firstWindow();
  await page.getByLabel("Input").fill(sampleText);
  await page.getByRole("button", { name: "Remove PII locally" }).click();
  await page.waitForFunction(
    (expected) => document.querySelectorAll("textarea")[1]?.value === expected,
    expectedText,
    { timeout: 120_000 },
  );
  await page.locator('input[type="file"]').setInputFiles(sampleDocx);
  await page.waitForFunction(
    () => document.querySelectorAll("textarea")[1]?.value.startsWith("DOCX ready:"),
    undefined,
    { timeout: 120_000 },
  );
} finally {
  await app.close();
}

console.log("Electron e2e passed");
