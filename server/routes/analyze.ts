import type { FastifyInstance, FastifyRequest } from "fastify";
import { RATE_LIMITS } from "../lib/limits.ts";
import type { AnalysisResult } from "../analysis/analysis-service.ts";
import { AnalyzeRequestSchema, MAX_CONTENT_CHARS } from "../analysis/schemas.ts";
import { isParsableUrl } from "../detection/detect.ts";
import { AppError, badRequest, parseOrThrow, unauthorized } from "../lib/errors.ts";
import { validateImageUpload } from "../ocr/file-validation.ts";

/** Persist a result to the user's history (opt-in). Evidence snippets are stripped first. */
async function saveResult(app: FastifyInstance, request: FastifyRequest, result: AnalysisResult, contentLength: number) {
  const auth = request.auth;
  if (!auth) throw unauthorized("Sign in to save scans to your history.");
  const scan = await app.ctx.repos.scans.create(auth.user.id, {
    input_type: result.inputType,
    content_length: contentLength,
    language: result.language,
    risk_level: result.riskLevel,
    indicators: result.indicators.map(({ evidence: _evidence, ...rest }) => rest),
    explanation: result.explanation,
    recommendations: result.recommendations,
    analysis_method: result.analysisMethod,
    ai_status: result.ai.status,
    ml_status: result.mlPrediction.status,
    model_version: result.modelVersion,
  });
  result.saved = true;
  result.scanId = scan.id;
}

export async function analyzeRoutes(app: FastifyInstance) {
  app.post("/api/analyze", { config: { rateLimit: RATE_LIMITS.analyze } }, async (request, reply) => {
    const body = parseOrThrow(AnalyzeRequestSchema, request.body);
    if (body.save && !request.auth) throw unauthorized("Sign in to save scans to your history.");
    const content = body.content.trim();
    if (body.type === "url" && !isParsableUrl(content)) {
      throw badRequest("Enter a full web address, for example https://example.com/page.", [{ path: "content", message: "Not a valid web address." }]);
    }

    const result = await app.ctx.analysis.analyze({ type: body.type, content, email: body.email });
    if (body.save) await saveResult(app, request, result, content.length + (body.email?.body?.length ?? 0));
    reply.header("Cache-Control", "no-store");
    return result;
  });

  /**
   * Screenshot analysis: OCR the image, then analyse the extracted text like a text message.
   * multipart/form-data with one `file` field (PNG/JPEG/WebP) and optional `save` = "true".
   */
  app.post("/api/analyze/image", { config: { rateLimit: RATE_LIMITS.upload }, bodyLimit: app.ctx.config.uploadMaxBytes + 64 * 1024 }, async (request, reply) => {
    if (!request.isMultipart()) throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the screenshot as multipart/form-data.");
    let fileBuffer: Buffer | null = null;
    let save = false;
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "file" || fileBuffer) {
          part.file.resume();
          throw badRequest("Send exactly one file in a field named \"file\".");
        }
        fileBuffer = await part.toBuffer(); // throws FST_REQ_FILE_TOO_LARGE past the limit
      } else if (part.fieldname === "save") {
        save = String(part.value) === "true";
      }
    }
    if (!fileBuffer) throw badRequest("Attach a screenshot in a field named \"file\".");
    if (save && !request.auth) throw unauthorized("Sign in to save scans to your history.");

    validateImageUpload(fileBuffer, app.ctx.config.uploadMaxBytes);
    const ocr = await app.ctx.ocr.extractText(fileBuffer);

    const text = ocr.text.replace(/\s+\n/g, "\n").trim().slice(0, MAX_CONTENT_CHARS);
    const result = await app.ctx.analysis.analyze({ type: "text", content: text }, "image");
    if (save) await saveResult(app, request, result, text.length);
    reply.header("Cache-Control", "no-store");
    return {
      ...result,
      ocr: {
        engine: "tesseract",
        characters: text.length,
        confidence: ocr.confidence,
        // Returned so the user can check what was read. It is not stored.
        extractedText: text,
        truncated: ocr.text.trim().length > MAX_CONTENT_CHARS,
      },
    };
  });
}
