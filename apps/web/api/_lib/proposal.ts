export type AgentRole = "planner" | "coder" | "reviewer" | "qa";
export type AgentPayload = {
  summary: string;
  files: { path: string; content: string }[];
  next_role: AgentRole;
  status: "needs_review" | "completed";
  review_notes?: string;
};

export const ROLES: AgentRole[] = ["planner", "coder", "reviewer", "qa"];

const BLOCKED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".ssh", ".aws", ".azure", ".gnupg", ".venv", "venv", "node_modules",
  "private", "secret", "secrets",
  // Directories that run code automatically (CI, git hooks, editor tasks): an agent must never write here.
  ".github", ".husky", ".githooks", ".vscode", ".idea", ".gitlab",
]);
const BLOCKED_FILES = new Set([
  ".npmrc", ".pypirc", ".netrc", "credentials.json", "service-account.json", "id_rsa", "id_ed25519", "id_ecdsa",
  ".gitattributes", ".gitmodules", ".gitlab-ci.yml",
]);

export function isBlockedProposalPath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  return parts.some(part =>
    BLOCKED_DIRECTORIES.has(part) || BLOCKED_FILES.has(part) ||
    part === ".env" || part.startsWith(".env.") ||
    part.endsWith("_secret") || part.endsWith("_credentials")
  ) || /\.(pem|key|p12|pfx|keystore)$/i.test(path);
}

function extractJsonObject(raw: string): unknown {
  const text = raw.trim();
  try { return JSON.parse(text); } catch { /* fall through to tolerant extraction */ }
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(unfenced); } catch { /* fall through */ }
  // Last resort: first '{' to the last '}' (models sometimes add prose around the JSON).
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(unfenced.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw new Error("The model did not return a JSON proposal.");
}

export function parseProposal(raw: string): AgentPayload {
  const value = extractJsonObject(raw) as Partial<AgentPayload> | null;
  if (!value || typeof value !== "object" || typeof value.summary !== "string" || !value.summary.trim()
      || !Array.isArray(value.files) || value.files.length > 12) {
    throw new Error("The model returned an invalid proposal.");
  }
  const seen = new Set<string>();
  const files = value.files.map((file) => {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw new Error("A proposed file was malformed.");
    const path = file.path.replaceAll("\\", "/").trim();
    if (!path || path.length > 240 || path.startsWith("/") || /^[A-Za-z]:/.test(path)
        || /[\u0000-\u001f<>:"|?*]/.test(path)
        || path.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error("The proposal contains an unsafe relative path.");
    }
    if (isBlockedProposalPath(path)) {
      throw new Error("The proposal targets a credential, secret, generated, dependency, or automation path, which is blocked.");
    }
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error("The proposal lists the same path twice: " + path);
    seen.add(key);
    return { path, content: file.content.slice(0, 150000) };
  });
  const nextRole = ROLES.includes(value.next_role as AgentRole) ? value.next_role as AgentRole : "reviewer";
  return {
    summary: value.summary.slice(0, 8000),
    files,
    next_role: nextRole,
    status: value.status === "completed" && files.length === 0 ? "completed" : "needs_review",
    review_notes: typeof value.review_notes === "string" ? value.review_notes.slice(0, 8000) : "",
  };
}
