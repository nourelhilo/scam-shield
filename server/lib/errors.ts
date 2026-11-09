import type { z } from "zod";

/** Error with a stable machine-readable code and an HTTP status. Messages are safe to show users. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "VALIDATION_ERROR", message, details);
export const unauthorized = (message = "Sign in to continue.") => new AppError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "You do not have permission to do that.") => new AppError(403, "FORBIDDEN", message);
export const notFound = (message = "Not found.") => new AppError(404, "NOT_FOUND", message);

/** Convert a Zod error into a user-safe list of field problems (no input values are echoed). */
export function zodIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

export function parseOrThrow<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest("The request is invalid.", zodIssues(result.error));
  }
  return result.data;
}
