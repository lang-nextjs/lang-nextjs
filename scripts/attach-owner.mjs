/**
 * attach-owner.mjs — map an HTML report's attachments back to the tests that produced them.
 *
 * WHY THIS IS NEEDED. The Playwright HTML reporter content-hashes attachment filenames into
 * data/, and the test -> attachment mapping is NOT in any greppable file: it lives base64'd
 * inside <template id="playwrightReportBase64"> in index.html. So `grep sse-received
 * playwright-report` returns zero on a report that plainly contains the attachment — a query
 * that cannot compute, returning a clean answer.
 *
 * WHAT IT COST TO NOT HAVE THIS (#114, 2026-08-31). A `sse-received` attachment reading "NO
 * BYTES REACHED THE BROWSER" was found in a CI artifact and published as the first evidence
 * constraining WHERE the fault is. Three greps for the attachment name returned nothing, so
 * the mapping was filed as an unreachable property of the artifact. It is not: the model is
 * base64 inside the template, and the owner turned out to be `sse-received-tabB` from the
 * shared-registry cross-tab test — a tab that NEVER OPENS A STREAM, whose only action is a
 * `request.post` from a second context. Zero bytes was correct for it and the finding was
 * false. ATTRIBUTION WAS THE DISCRIMINATOR: unattributable, "one page received nothing" would
 * have stood as suggestive evidence indefinitely, unfalsifiable and wrong.
 *
 * NOT A CHECKER. Nothing invokes this from a workflow and it gates nothing, so it has no
 * can-it-fail proof and assert-checker-proof-pairing does not ask for one. It does carry the
 * one guard a search tool must have: a walk that matches nothing SAYS SO on stderr, because
 * "found nothing" and "the search was wrong" are the two states this whole family of bugs
 * lives in.
 *
 * Usage: node scripts/attach-owner.mjs <path-to-playwright-report-dir> [name-filter]
 *   e.g. gh run download <id> -n playwright-report-mocked -D /tmp/art
 *        node scripts/attach-owner.mjs /tmp/art sse-received
 */
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const dir = process.argv[2];
const filter = process.argv[3] ?? "";
if (!dir || !existsSync(join(dir, "index.html"))) {
  console.error("usage: node attach-owner.mjs <playwright-report-dir> [name-filter]");
  process.exit(2);
}
const html = readFileSync(join(dir, "index.html"), "utf8");
const m = html.match(/<template[^>]*id=["']playwrightReportBase64["'][^>]*>([\s\S]*?)<\/template>/i);
if (!m) { console.error("FAIL: no playwrightReportBase64 template — reporter version differs; do not read this as 'no attachments'"); process.exit(1); }
let b = m[1].trim();
const c = b.indexOf("base64,");
if (c >= 0) b = b.slice(c + 7);
const tmp = mkdtempSync(join(tmpdir(), "prz-"));
writeFileSync(join(tmp, "r.zip"), Buffer.from(b, "base64"));
execFileSync("/usr/bin/unzip", ["-o", "-q", join(tmp, "r.zip"), "-d", join(tmp, "out")]);

const seen = new Set();
let rows = 0;
for (const f of readdirSync(join(tmp, "out")).filter((x) => x.endsWith(".json"))) {
  const walk = (o, title) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach((x) => walk(x, title));
    const t = o.title || title;
    if (Array.isArray(o.attachments)) {
      for (const a of o.attachments) {
        if (!a?.name || !a?.path) continue;
        if (filter && !a.name.includes(filter)) continue;
        const key = `${t}::${a.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows++;
        const p = join(dir, a.path);
        let head = "(file not in artifact)";
        if (existsSync(p)) head = readFileSync(p, "utf8").split("\n")[0].slice(0, 100);
        console.log(`TEST: ${t}\n  ${a.name} -> ${a.path}\n  first line: ${head}\n`);
      }
    }
    for (const k of Object.keys(o)) walk(o[k], t);
  };
  walk(JSON.parse(readFileSync(join(tmp, "out", f), "utf8")), null);
}
// A walk that finds nothing must say so, rather than printing nothing and reading as clean.
if (rows === 0) console.error(`NO ATTACHMENTS MATCHED${filter ? ` for filter "${filter}"` : ""} — this is a null result, not an absence of attachments.`);
