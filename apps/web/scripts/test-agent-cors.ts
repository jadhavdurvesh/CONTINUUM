import { isAllowedAgentOrigin, setAgentCors } from "../api/_lib/cors";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error("Agent CORS test failed: " + message);
}
process.env.CONTINUUM_DASHBOARD_ORIGIN = "https://dashboard.example.com/, https://second.example.com";
assert(isAllowedAgentOrigin("https://dashboard.example.com"), "configured dashboard origin (trailing slash tolerated)");
assert(isAllowedAgentOrigin("https://second.example.com"), "second configured origin");
assert(isAllowedAgentOrigin("http://localhost:3000"), "local desktop renderer");
assert(isAllowedAgentOrigin("http://127.0.0.1:4567"), "IPv4 loopback");
assert(!isAllowedAgentOrigin("https://attacker.example"), "arbitrary external origin rejected");
assert(!isAllowedAgentOrigin("https://dashboard.example.com.attacker.example"), "suffix lookalike rejected");
assert(!isAllowedAgentOrigin("null"), "opaque origin rejected");
const captured: Record<string, string> = {};
const allowed = setAgentCors(
  { headers: { origin: "http://localhost:3000" } },
  { setHeader: (name: string, value: string) => { captured[name] = value; } }
);
assert(allowed, "trusted origin allowed");
assert(captured["Access-Control-Allow-Origin"] === "http://localhost:3000", "trusted origin reflected");
assert(captured["Access-Control-Allow-Headers"] === "Authorization, Content-Type", "preflight permits bearer auth and JSON");
const denied = setAgentCors({ headers: { origin: "https://attacker.example" } }, { setHeader: () => undefined });
assert(!denied, "untrusted origin denied");
console.log("Agent CORS tests passed.");
