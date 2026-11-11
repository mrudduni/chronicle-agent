/**
 * Secret redaction for anything derived from the log.
 *
 * People paste API keys and passwords into chats. The raw log keeps exactly
 * what was typed (it's the user's own record), but nothing derived (the search
 * index, embeddings, summaries, prompts built from memory) should carry them.
 */
const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,               // OpenAI / Anthropic style keys
  /\btvly-[A-Za-z0-9_-]{16,}\b/g,             // Tavily
  /\bAKIA[0-9A-Z]{16}\b/g,                     // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,           // GitHub tokens
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,          // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@]+:[^\s@]+@/gi, // credentials in connection strings
];

export function redact(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}
