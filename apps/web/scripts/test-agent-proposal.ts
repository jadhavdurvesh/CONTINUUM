import { isBlockedProposalPath, parseProposal } from "../api/_lib/proposal";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error("Agent proposal test failed: " + message);
}
function rejects(raw: string, label: string) {
  let threw = false;
  try { parseProposal(raw); } catch { threw = true; }
  assert(threw, label);
}
const ok = (files: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ summary: "s", files, next_role: "reviewer", status: "needs_review", ...extra });

assert(parseProposal(ok([{ path: "src/a.ts", content: "x" }])).files.length === 1, "valid proposal accepted");
assert(parseProposal("```json\n" + ok([]) + "\n```").files.length === 0, "code-fenced JSON accepted");
assert(parseProposal("Here you go: " + ok([]) + " Hope that helps!").summary === "s", "prose around JSON tolerated");
assert(parseProposal(ok([], { next_role: "hacker" })).next_role === "reviewer", "unknown role falls back");
assert(parseProposal(ok([{ path: "a.ts", content: "x" }], { status: "completed" })).status === "needs_review", "completed with files needs review");

for (const bad of ["../x", "/etc/passwd", "a/../../b", "C:\\x", "a//b", ".env", "app/.env.local", "key.pem", "a\u0000b", ".git/config",
                   ".github/workflows/ci.yml", ".husky/pre-commit", ".vscode/tasks.json", "node_modules/x/index.js", "secrets/a.txt"]) {
  rejects(ok([{ path: bad, content: "x" }]), "path rejected: " + JSON.stringify(bad));
}
rejects(ok([{ path: "a.ts", content: "1" }, { path: "A.ts", content: "2" }]), "case-insensitive duplicate rejected");
rejects(ok(Array.from({ length: 13 }, (_, i) => ({ path: "f" + i, content: "" }))), "more than 12 files rejected");
rejects("not json", "garbage rejected");
rejects(JSON.stringify({ files: [] }), "missing summary rejected");
assert(isBlockedProposalPath(".github/workflows/x.yml") && !isBlockedProposalPath("docs/github.md"), "blocklist precision");
console.log("Agent proposal tests passed.");
