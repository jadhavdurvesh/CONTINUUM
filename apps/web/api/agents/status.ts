export default function handler(req: any, res: any) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const supabaseConfigured = Boolean(
    process.env.SUPABASE_URL &&
    (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY)
  );
  const providers = [
    process.env.OPENAI_API_KEY ? "OpenAI" : "",
    process.env.GROQ_API_KEY ? "Groq" : "",
    process.env.OPENROUTER_API_KEY ? "OpenRouter" : "",
  ].filter(Boolean);
  const configured = supabaseConfigured && providers.length > 0;
  return res.status(200).json({
    configured,
    supabaseConfigured,
    providers,
    message: !supabaseConfigured
      ? "Vercel needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY."
      : providers.length === 0
        ? "Cloud data is configured. Add at least one server-side model provider key in Vercel."
        : "Cloud agent orchestration and provider failover are ready.",
  });
}
