/**
 * Trusted browser-file bootstrap (SPEC 5/C12). The saved HTML container
 * embeds the original tagged source as an escaped JSON string inside a
 * `<script type="application/json">` block, plus a reference to the trusted
 * application bundle. Extraction here uses plain string scanning -- no
 * DOMParser/browser DOM -- so the same payload decodes identically inside
 * and outside a browser, and no script from an untrusted document ever runs
 * just because this function reads it.
 */
interface BootstrapOptions {
  readonly bundleRef: string;
  readonly title?: string;
}

const PAYLOAD_MARKER = 'id="doc-payload">';

export function buildBootstrapHtml(source: string, options: BootstrapOptions): string {
  const payload = JSON.stringify(source).replace(/<\//g, "<\\/");
  const title = options.title ?? "document";
  return [
    "<!doctype html>",
    "<html>",
    `<head><meta charset="utf-8" /><title>${title}</title></head>`,
    "<body>",
    `<script type="application/json" ${PAYLOAD_MARKER}${payload}</script>`,
    `<script type="module" src="${options.bundleRef}"></script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

export function extractPayloadFromHtml(html: string): string {
  const start = html.indexOf(PAYLOAD_MARKER);
  if (start === -1) throw new Error("no document payload found in container");
  const contentStart = start + PAYLOAD_MARKER.length;
  const end = html.indexOf("</script>", contentStart);
  if (end === -1) throw new Error("unterminated document payload");
  return JSON.parse(html.slice(contentStart, end)) as string;
}
