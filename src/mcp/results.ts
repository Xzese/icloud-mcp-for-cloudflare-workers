import { publicError } from "../errors.ts";

export function toolSuccess<T extends Record<string, unknown>>(result: T) {
  return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

export function toolError(error: unknown) {
  const detail = publicError(error, crypto.randomUUID());
  return { isError: true, ...toolSuccess({ error_code: detail.code, error: detail }) };
}
