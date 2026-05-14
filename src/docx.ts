import JSZip from "jszip";

export type RedactionSpan = {
  start: number;
  end: number;
  label?: string;
  placeholder?: string;
};

export type RedactText = (text: string) => Promise<{ redacted: string; spans?: RedactionSpan[] }>;

type TextSegment = {
  node: Text;
  start: number;
  end: number;
};

const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const docxXmlPattern = /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/;

function getTextNodes(document: XMLDocument) {
  const nodes: Text[] = [];

  for (const element of document.getElementsByTagNameNS(wordNamespace, "t")) {
    const node = element.firstChild;
    if (node?.nodeType === Node.TEXT_NODE) nodes.push(node as Text);
  }

  return nodes;
}

function getTextSegments(nodes: Text[]) {
  let offset = 0;

  return nodes.map((node) => {
    const text = node.nodeValue ?? "";
    const segment = { node, start: offset, end: offset + text.length };
    offset += text.length;
    return segment;
  });
}

function placeholderFor(span: RedactionSpan) {
  return span.placeholder ?? span.label ?? "[PII]";
}

function applySpan(segments: TextSegment[], span: RedactionSpan) {
  const touched = segments.filter(
    (segment) => span.start < segment.end && span.end > segment.start,
  );
  if (touched.length === 0) return;

  const first = touched[0];
  const last = touched.at(-1)!;
  const firstText = first.node.nodeValue ?? "";
  const lastText = last.node.nodeValue ?? "";
  const prefix = firstText.slice(0, Math.max(0, span.start - first.start));
  const suffix = lastText.slice(Math.max(0, span.end - last.start));

  first.node.nodeValue = `${prefix}${placeholderFor(span)}${suffix}`;

  for (const segment of touched.slice(1)) {
    segment.node.nodeValue = "";
  }
}

async function redactXmlPart({ xml, redactText }: { xml: string; redactText: RedactText }) {
  const parser = new DOMParser();
  const document = parser.parseFromString(xml, "application/xml");
  const textNodes = getTextNodes(document);
  const segments = getTextSegments(textNodes);
  const text = segments.map((segment) => segment.node.nodeValue ?? "").join("");

  if (text.trim().length === 0) return { xml, text: "" };

  const result = await redactText(text);

  for (const span of [...(result.spans ?? [])].sort((a, b) => b.start - a.start)) {
    if (Number.isInteger(span.start) && Number.isInteger(span.end) && span.end > span.start) {
      applySpan(segments, span);
    }
  }

  return { xml: new XMLSerializer().serializeToString(document), text };
}

export async function redactDocx({
  file,
  redactText,
  onStatus,
}: {
  file: File;
  redactText: RedactText;
  onStatus: (status: string) => void;
}) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xmlFiles = Object.keys(zip.files).filter((name) => docxXmlPattern.test(name));
  const previewParts: string[] = [];

  for (const [index, name] of xmlFiles.entries()) {
    const entry = zip.file(name);
    if (!entry) continue;

    onStatus(`Redacting DOCX part ${index + 1}/${xmlFiles.length}`);
    const redacted = await redactXmlPart({ xml: await entry.async("text"), redactText });
    previewParts.push(redacted.text);
    zip.file(name, redacted.xml);
  }

  const blob = await zip.generateAsync({ type: "blob", mimeType: file.type });
  const baseName = file.name.replace(/\.docx$/i, "");

  return {
    blob,
    fileName: `${baseName || "document"}.redacted.docx`,
    text: previewParts.filter(Boolean).join("\n\n"),
  };
}
