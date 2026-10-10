import { digest, hex, utf8 } from "../crypto/bytes.ts";
import { AppError } from "../errors.ts";

export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(object[key])}`).join(",")}}`;
  }
  throw new AppError("VALIDATION_ERROR", "Only bounded JSON data can be canonicalized.", 400);
}

export const jsonBytes = (value: unknown) => utf8(canonicalJSON(value)).length;
export const fingerprint = async (value: unknown) => hex(await digest(utf8(canonicalJSON(value))));

export const accountScope = (owner: string, dsid: string) => fingerprint(["reminder-account-v1", owner, dsid]);
