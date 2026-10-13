// Server-side orchestration only. Password/KDF/SPAKE secrets never enter this module.
import { AppError } from "../../errors.ts";
import { integer, unb64 } from "../../crypto/bytes.ts";
import { SRP_N } from "../../crypto/srp.ts";
import type { PushConnector } from "../../transport/apple-websocket.ts";
import { AppleAuthHTTP } from "./http.ts";
import { AppleBridge } from "./bridge.ts";
import { parseBootOptions } from "./boot-context.ts";
import { parseChallenge, StartMessage, type AuthInput, type SrpChallenge } from "./protocol.ts";
import { advancePcs, freshPcsCheckpoint, type RemindersPcsResult } from "./pcs.ts";
import type { AppleSession } from "../../persistence/apple-sessions.ts";
import { type ServiceSettings, DEFAULT_SERVICE_SETTINGS } from "../../services/settings.ts";
import { type AppleServices } from "./services.ts";
export type { AppleSession } from "../../persistence/apple-sessions.ts";
import { loginAssurance, requireNoAppleRejection } from "./policy.ts";

export type AuthEvent =
  | { type: "srp-challenge"; challenge: SrpChallenge }
  | { type: "bridge-challenge"; salt: string }
  | { type: "bridge-response"; serverShare: string; serverConfirmation: string }
  | { type: "bridge-encrypted"; encryptedCode: string }
  | { type: "complete"; state: RemindersPcsResult["state"]; action?: string; nextAttemptAt: number; expiresAt: number };
type Phase = "new" | "srp" | "bridge-share" | "bridge-confirmation" | "bridge-validation" | "done" | "busy" | "closed";
export class AppleSignInFlow {
  private phase: Phase = "new";
  private accountName = "";
  private challenge: SrpChallenge | null = null;
  private bridge: AppleBridge | null = null;
  private deviceVerified = false;
  private revision = 0;
  readonly http: AppleAuthHTTP; readonly signal: AbortSignal;
  readonly persist: (session: AppleSession, result: RemindersPcsResult) => Promise<void>; readonly connect?: PushConnector;
  readonly thirtyDays: boolean;
  readonly settings: () => Promise<ServiceSettings>;
  constructor(http: AppleAuthHTTP, signal: AbortSignal, persist: (session: AppleSession, result: RemindersPcsResult) => Promise<void>, connect?: PushConnector, thirtyDays = true, settings: () => Promise<ServiceSettings> = async () => structuredClone(DEFAULT_SERVICE_SETTINGS)) { this.http = http; this.signal = signal; this.persist = persist; this.connect = connect; this.thirtyDays = thirtyDays; this.settings = settings; }
  private alive(revision: number) {
    if (this.signal.aborted || revision !== this.revision) throw new AppError("RESTART_REQUIRED", "This sign-in attempt expired or its connection was lost. Restart sign-in.", 409);
  }
  private begin(phase: Phase) {
    this.alive(this.revision);
    if (this.phase !== phase) throw new AppError("RESTART_REQUIRED", "This verification step is out of order. Restart sign-in.", 409);
    this.phase = "busy"; return this.revision;
  }
  async start(value: unknown): Promise<AuthEvent> {
    const revision = this.begin("new");
    try {
      const input = StartMessage.safeParse(value);
      if (!input.success) throw new AppError("VALIDATION_ERROR", "Use the secure connection form and confirm encrypted session storage.");
      const a = integer(unb64(input.data.publicA, 256));
      if (a <= 0n || a >= SRP_N) throw new AppError("VALIDATION_ERROR", "Invalid Apple sign-in public value.");
      this.accountName = input.data.accountName;
      await this.http.bootstrap(); this.alive(revision);
      const reply = await this.http.auth("/signin/init", "POST", { accountName: this.accountName, a: input.data.publicA, protocols: ["s2k", "s2k_fo"] });
      this.http.expect(reply, [200]); this.alive(revision);
      this.challenge = parseChallenge(reply.body); this.phase = "srp";
      return { type: "srp-challenge", challenge: this.challenge };
    } catch (error) { this.close(); throw error; }
  }
  async advance(input: AuthInput): Promise<AuthEvent> {
    const expected: Partial<Record<AuthInput["type"], Phase>> = { "srp-proof": "srp", "bridge-share": "bridge-share", "bridge-confirmation": "bridge-confirmation", "bridge-validation": "bridge-validation" };
    if (input.type === "cancel") { this.close(); throw new AppError("RESTART_REQUIRED", "The sign-in attempt was cancelled.", 409); }
    const revision = this.begin(expected[input.type]!);
    try {
      let result: AuthEvent;
      switch (input.type) {
        case "srp-proof": {
          const reply = await this.http.auth("/signin/complete?isRememberMeEnabled=true", "POST", { accountName: this.accountName, c: this.challenge!.c, m1: input.m1, m2: input.m2, rememberMe: true, trustTokens: [] });
          this.http.expect(reply, [200, 204, 409]); this.alive(revision);
          // A 409 HSA2 challenge is an intermediate state, not a successful
          // factor result. Apple may include challenge-specific service errors.
          this.accountName = ""; this.challenge = null;
          if (reply.status !== 409) throw new AppError("UNSUPPORTED_AUTH", "Apple did not offer fresh trusted-device verification. This connection requires the modern device verification route and will not reuse an unverified login.");
          const authType = reply.body?.authType ?? reply.body?.authenticationType;
          if (typeof authType !== "string" || !/^hsa2$/i.test(authType)) throw new AppError("UNSUPPORTED_AUTH", "Apple returned an unsupported authentication method. Use the official iCloud interface to resolve it.");
          result = await this.verification(revision); break;
        }
        case "bridge-share": {
          const response = await this.bridge!.share(input.data); this.alive(revision); this.phase = "bridge-confirmation";
          result = { type: "bridge-response", ...response }; break;
        }
        case "bridge-confirmation": {
          const response = await this.bridge!.confirm(input.data); this.alive(revision); this.phase = "bridge-validation";
          result = { type: "bridge-encrypted", ...response }; break;
        }
        case "bridge-validation": await this.bridge!.validate(input.code); this.alive(revision); this.deviceVerified = true; return await this.finish(revision);
      }
      this.alive(revision); return result;
    } catch (error) { this.close(); throw error; }
  }
  private async verification(revision: number): Promise<AuthEvent> {
    const html = await this.http.auth("", "GET", undefined, { Accept: "text/html" }); this.http.expect(html, [200]); this.alive(revision);
    const context = parseBootOptions(html.text, html.body);
    // Copy only security-key indicators from JSON. Its SMS-oriented shape must
    // never erase the bridge bootstrap extracted from Apple's HTML shell.
    const json = await this.http.auth("", "GET", undefined, { Accept: "application/json" }); this.http.expect(json, [200]); this.alive(revision);
    const keyNames = json.body?.keyNames;
    if (context.securityKeyRequired || json.body?.fsaChallenge || (Array.isArray(keyNames) && keyNames.length)) throw new AppError("UNSUPPORTED_AUTH", "This account requires an Apple security key, which this connection cannot support. Keep your account protection enabled and use Apple's official interface.");
    if (context.bridge) {
      this.bridge = new AppleBridge(this.http, context.bridge, this.signal, this.connect);
      const challenge = await this.bridge.start(); this.alive(revision);
      this.phase = "bridge-share"; return { type: "bridge-challenge", salt: challenge.salt };
    }
    throw new AppError("UNSUPPORTED_AUTH", "Apple did not offer the modern trusted-device route. SMS, phone and legacy verification are disabled; use Apple's official interface.");
  }
  private async finish(revision: number): Promise<AuthEvent> {
    if (!this.deviceVerified) throw new AppError("VERIFICATION_REQUIRED", "Complete fresh trusted-device verification before establishing Apple session trust.", 409);
    const trust = await this.http.auth("/2sv/trust"); this.http.expect(trust, [200, 204]); this.alive(revision);
    requireNoAppleRejection(trust.body);
    const discovered = await this.http.accountLogin(); this.alive(revision);
    const { drive, ...connection } = discovered;
    const settings = await this.settings(); this.alive(revision);
    // Login can request Reminders consent only when selected. Drive intent never
    // triggers PCS: the dashboard must invoke explicit Drive approval afterwards.
    const initial = freshPcsCheckpoint();
    const result: RemindersPcsResult = settings.reminders.enabled && connection.cloudKitURL
      ? await advancePcs(this.http, connection.dsid, initial, Date.now(), "reminders", async () => {
        if (!(await this.settings()).reminders.enabled) throw new AppError("FORBIDDEN", "Reminders was disabled before Apple approval.", 403);
        this.alive(revision);
      })
      : { state: "READY", checkpoint: initial };
    this.alive(revision);
    const services: AppleServices = { version: 1,
      reminders: !connection.cloudKitURL ? { state: "UNAVAILABLE" } : !settings.reminders.enabled ? { state: "CONSENT_REQUIRED" } :
        { state: result.state, pcs: result.checkpoint, ...(result.state === "DEVICE_APPROVAL_PENDING" ? { action: result.action } : {}) },
      drive: drive ? { state: "CONSENT_REQUIRED", connection: drive } : { state: "UNAVAILABLE" } };
    const login = loginAssurance(Date.now(), this.thirtyDays);
    await this.persist({ auth: this.http.snapshot(), connection, pcs: result.checkpoint, login, services }, result); this.alive(revision);
    this.phase = "done"; this.bridge?.close(); this.bridge = null;
    return { type: "complete", state: result.state, ...(result.state === "DEVICE_APPROVAL_PENDING" ? { action: result.action } : {}), nextAttemptAt: result.checkpoint.nextAttemptAt, expiresAt: login.expiresAt };
  }
  close() { this.revision++; this.phase = "closed"; this.bridge?.close(); this.bridge = null; this.challenge = null; this.deviceVerified = false; this.accountName = ""; }
}
