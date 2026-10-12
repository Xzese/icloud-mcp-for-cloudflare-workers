import { AppError } from "../errors.ts";
import { limitedBytes } from "../transport/apple-http.ts";

export const SHOPPING_ASSET_MAX_BYTES = 16 * 1024;
const MAX_NATIVE_METADATA_LENGTH = 2_048;
const MAX_RECEIPT_STRING_LENGTH = 8_192;
const REQUEST_TIMEOUT_MS = 8_000;
const SHOPPING_ASSET_FIELDS = [
  "MembershipsOfRemindersInSectionsAsData",
  "GroceryLocalCorrectionsAsData",
] as const;

export type ShoppingAssetFieldName = typeof SHOPPING_ASSET_FIELDS[number];

export interface AssetReceipt {
  referenceChecksum: string;
  size: number;
  fileChecksum: string;
  wrappingKey: string;
  receipt: string;
}

interface NativeAssetReference {
  fileChecksum: string;
  wrappingKey: string;
  referenceChecksum: string;
  size: number;
  downloadURL: string;
}

export interface ShoppingAssetToken {
  recordName: string;
  fieldName: ShoppingAssetFieldName;
  url: string;
}

export interface ShoppingAssetExpectation {
  recordName: string;
  fieldName: ShoppingAssetFieldName;
}

function protocolChanged(message: string): never {
  throw new AppError("PROTOCOL_CHANGED", message);
}

function upstreamUnavailable(): AppError {
  return new AppError("UPSTREAM_UNAVAILABLE", "Apple's Shopping asset service could not complete the request.", 503, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function boundedOpaque(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function supportedFieldName(value: unknown): value is ShoppingAssetFieldName {
  return typeof value === "string" && (SHOPPING_ASSET_FIELDS as readonly string[]).includes(value);
}

function validListRecordName(value: unknown): value is string {
  return typeof value === "string" && /^List\/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(value);
}

function validateAppleAssetURL(value: unknown, host: "cvws.icloud-content.com" | "cws.icloud-content.com", path: RegExp): URL {
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192 || value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) {
    protocolChanged("Apple returned an invalid Shopping asset address.");
  }

  let url: URL;
  try { url = new URL(value); }
  catch { protocolChanged("Apple returned an invalid Shopping asset address."); }

  if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password || url.port ||
      value.includes("#") || url.hash || !path.test(url.pathname)) {
    protocolChanged("Apple returned a misdirected or unsupported Shopping asset address.");
  }
  return url;
}

function readNativeAssetReference(field: unknown): NativeAssetReference {
  if (!isRecord(field) || !hasExactKeys(field, ["type", "value"]) || field.type !== "ASSETID" || !isRecord(field.value) ||
      !hasExactKeys(field.value, ["fileChecksum", "wrappingKey", "referenceChecksum", "size", "downloadURL"])) {
    protocolChanged("The native Shopping asset reference has an unsupported shape.");
  }

  const value = field.value;
  const fileChecksum = value.fileChecksum;
  const wrappingKey = value.wrappingKey;
  const referenceChecksum = value.referenceChecksum;
  const size = value.size;
  const downloadURL = value.downloadURL;
  if (!boundedOpaque(fileChecksum, MAX_NATIVE_METADATA_LENGTH) ||
      !boundedOpaque(wrappingKey, MAX_NATIVE_METADATA_LENGTH) ||
      !boundedOpaque(referenceChecksum, MAX_NATIVE_METADATA_LENGTH) ||
      typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > SHOPPING_ASSET_MAX_BYTES) {
    protocolChanged("The native Shopping asset metadata is invalid or exceeds its byte budget.");
  }
  validateAppleAssetURL(downloadURL, "cvws.icloud-content.com", /^\/B\//);
  return { fileChecksum, wrappingKey, referenceChecksum, size, downloadURL: downloadURL as string };
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); }
  catch { /* The response is already unusable; no further read is attempted. */ }
}

function requireSuccessfulResponse(response: Response): void {
  if (response.status !== 200) {
    throw new AppError("PROTOCOL_CHANGED", "Apple returned an unexpected Shopping asset response.");
  }
}

function sanitizedTransportError(error: unknown): never {
  if (error instanceof AppError) throw error;
  throw upstreamUnavailable();
}

export async function downloadShoppingAsset(
  field: unknown,
  send: typeof fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const asset = readNativeAssetReference(field);
  const url = validateAppleAssetURL(asset.downloadURL, "cvws.icloud-content.com", /^\/B\//);

  try {
    const response = await send(url.href, {
      method: "GET",
      headers: { Accept: "application/octet-stream" },
      credentials: "omit",
      redirect: "manual",
      signal: requestSignal(signal),
    });
    if (response.status !== 200) {
      await cancelBody(response);
      requireSuccessfulResponse(response);
    }
    const bytes = await limitedBytes(response, SHOPPING_ASSET_MAX_BYTES);
    if (bytes.byteLength !== asset.size) protocolChanged("The Shopping asset size does not match its native reference.");
    return bytes;
  } catch (error) { sanitizedTransportError(error); }
}

function validateUploadToken(token: unknown, expected: unknown): { url: URL; fieldName: ShoppingAssetFieldName } {
  if (!isRecord(expected) || !hasExactKeys(expected, ["recordName", "fieldName"]) ||
      !validListRecordName(expected.recordName) || !supportedFieldName(expected.fieldName)) {
    protocolChanged("The expected Shopping asset identity is invalid.");
  }
  if (!isRecord(token) || !hasExactKeys(token, ["recordName", "fieldName", "url"]) ||
      !validListRecordName(token.recordName) || !supportedFieldName(token.fieldName) ||
      token.recordName !== expected.recordName || token.fieldName !== expected.fieldName) {
    protocolChanged("Apple returned a Shopping asset upload token for a different List field.");
  }
  return {
    url: validateAppleAssetURL(token.url, "cws.icloud-content.com", /^\/\d+\/singleFileUpload$/),
    fieldName: token.fieldName,
  };
}

function parseAssetReceipt(bytes: Uint8Array, expectedSize: number): AssetReceipt {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { protocolChanged("Apple returned an invalid Shopping asset upload receipt."); }

  if (!isRecord(parsed) || !hasExactKeys(parsed, ["singleFile"]) || !isRecord(parsed.singleFile) ||
      !hasExactKeys(parsed.singleFile, ["referenceChecksum", "size", "fileChecksum", "wrappingKey", "receipt"])) {
    protocolChanged("Apple returned a Shopping asset receipt with an unsupported shape.");
  }
  const receipt = parsed.singleFile;
  if (!boundedOpaque(receipt.referenceChecksum, MAX_RECEIPT_STRING_LENGTH) ||
      !boundedOpaque(receipt.fileChecksum, MAX_RECEIPT_STRING_LENGTH) ||
      !boundedOpaque(receipt.wrappingKey, MAX_RECEIPT_STRING_LENGTH) ||
      !boundedOpaque(receipt.receipt, MAX_RECEIPT_STRING_LENGTH) ||
      typeof receipt.size !== "number" || !Number.isSafeInteger(receipt.size) || receipt.size !== expectedSize) {
    protocolChanged("Apple returned an invalid Shopping asset upload receipt.");
  }
  return {
    referenceChecksum: receipt.referenceChecksum,
    size: receipt.size,
    fileChecksum: receipt.fileChecksum,
    wrappingKey: receipt.wrappingKey,
    receipt: receipt.receipt,
  };
}

export async function uploadShoppingAsset(
  token: ShoppingAssetToken,
  expected: ShoppingAssetExpectation,
  bytes: Uint8Array,
  send: typeof fetch,
  signal?: AbortSignal,
): Promise<AssetReceipt> {
  const validated = validateUploadToken(token, expected);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > SHOPPING_ASSET_MAX_BYTES) {
    protocolChanged("The Shopping asset upload exceeds the supported byte budget.");
  }

  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  try {
    const response = await send(validated.url.href, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body,
      credentials: "omit",
      redirect: "manual",
      signal: requestSignal(signal),
    });
    if (response.status !== 200) {
      await cancelBody(response);
      requireSuccessfulResponse(response);
    }
    const receiptBytes = await limitedBytes(response, SHOPPING_ASSET_MAX_BYTES);
    return parseAssetReceipt(receiptBytes, bytes.byteLength);
  } catch (error) { sanitizedTransportError(error); }
}
