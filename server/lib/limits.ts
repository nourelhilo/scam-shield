/** Per-route rate limits (requests per window, per client IP). In-memory: see docs/SECURITY.md. */
export const RATE_LIMITS = {
  analyze: { max: 20, timeWindow: "1 minute" },
  upload: { max: 6, timeWindow: "1 minute" },
  authStrict: { max: 10, timeWindow: "15 minutes" },
  emailSending: { max: 5, timeWindow: "1 hour" },
  feedback: { max: 10, timeWindow: "1 hour" },
} as const;
