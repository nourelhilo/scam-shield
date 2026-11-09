import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt.ts";
import { AiOutputSchema, AiProviderError, type AiProvider, type AiRequest } from "./types.ts";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Injected for tests so no real network call is made. */
  fetch?: typeof fetch;
}

/**
 * Claude provider (Anthropic Messages API) using structured outputs.
 * Retries are disabled in the SDK and handled by AiService so the total time is bounded.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.model = options.model;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: 0,
      timeout: options.timeoutMs,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async analyze(request: AiRequest, signal: AbortSignal): Promise<unknown> {
    const { text } = buildUserMessage(request);
    try {
      const response = await this.client.beta.messages.parse(
        {
          model: this.model,
          max_tokens: this.options.maxOutputTokens,
          // Server-side fallback: if the model declines (e.g. a safety classifier false
          // positive on scam text), the API re-runs the request on a recommended fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          // Classification-style task: low effort keeps latency and cost down.
          output_config: { effort: "low", format: betaZodOutputFormat(AiOutputSchema) },
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: text }],
        },
        { signal },
      );
      if (response.stop_reason === "refusal") {
        throw new AiProviderError("The AI provider declined to analyse this content.", "refusal", false);
      }
      if (response.stop_reason === "max_tokens") {
        throw new AiProviderError("The AI response was cut off.", "invalid_output", false);
      }
      if (response.parsed_output == null) {
        throw new AiProviderError("The AI response did not match the expected format.", "invalid_output", false);
      }
      return response.parsed_output;
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

function toProviderError(error: unknown): AiProviderError {
  if (error instanceof AiProviderError) return error;
  // Most specific first.
  if (error instanceof Anthropic.APIUserAbortError || error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiProviderError("The AI provider timed out.", "timeout", true);
  }
  if (error instanceof Anthropic.RateLimitError) return new AiProviderError("The AI provider is rate limiting requests.", "rate_limited", true);
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AiProviderError("The AI provider rejected the server credentials.", "auth", false);
  }
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
    return new AiProviderError("The AI provider rejected the request.", "bad_request", false);
  }
  if (error instanceof Anthropic.InternalServerError) return new AiProviderError("The AI provider had an internal error.", "unavailable", true);
  if (error instanceof Anthropic.APIConnectionError) return new AiProviderError("Could not reach the AI provider.", "unavailable", true);
  if (error instanceof Anthropic.APIError) return new AiProviderError("The AI provider returned an error.", "unavailable", false);
  // SDK JSON/format parse errors and anything else.
  return new AiProviderError("The AI response could not be read.", "invalid_output", false);
}
