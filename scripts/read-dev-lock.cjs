// Print "<pid>\t<appUrl>" from Next's dev-server lock, or nothing if unreadable.
//
// A separate file rather than `node -e`: the inline form has to survive shell
// quoting in two places, and the version that lived inside dev-all.sh used
// require() on a file named `lock` — which has no extension, so require() threw
// and a bare catch swallowed it, reporting "no lock" over a lock that was there.
try {
  const fs = require("node:fs");
  const l = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  process.stdout.write(`${l.pid ?? ""}\t${l.appUrl ?? ""}`);
} catch (e) {
  // Surface it. An unreadable lock and an absent one are different facts, and
  // this script's whole subject is telling those apart.
  process.stderr.write(`dev-all: unreadable dev lock: ${e.message}\n`);
}
