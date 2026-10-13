import { z } from "zod";
import { canonicalJSON } from "../lib/canonical.ts";
import { ListId } from "./identifiers.ts";

export const COLOR_PRESETS = ["red", "orange", "yellow", "green", "light-blue", "blue", "indigo", "pink", "purple", "brown", "grey", "rose"] as const;
export const ColorPreset = z.enum(COLOR_PRESETS).describe("One of the twelve built-in Reminders list colour presets.");
export type ColorPresetName = typeof COLOR_PRESETS[number];

type NativeColor = {
  colorRGBSpace: 2; red: number; daHexString: string; green: number; alpha: 1;
  daSymbolicColorName: string; ckSymbolicColorName: string; blue: number;
};

// Exact palette values extracted from native private-list captures. Keep this
// module independent of CloudKit so the transport can validate the same set.
export const NATIVE_LIST_COLORS: Readonly<Record<ColorPresetName, NativeColor>> = {
  red: { colorRGBSpace: 2, red: 1, daHexString: "#FF383C", green: 0.2196078431372549, alpha: 1, daSymbolicColorName: "red", ckSymbolicColorName: "red", blue: 0.23529411764705882 },
  orange: { colorRGBSpace: 2, red: 1, daHexString: "#FF8D28", green: 0.5529411764705883, alpha: 1, daSymbolicColorName: "orange", ckSymbolicColorName: "orange", blue: 0.1568627450980392 },
  yellow: { colorRGBSpace: 2, red: 1, daHexString: "#FFCC00", green: 0.8, alpha: 1, daSymbolicColorName: "yellow", ckSymbolicColorName: "yellow", blue: 0 },
  green: { colorRGBSpace: 2, red: 0.5137254901960784, daHexString: "#83D754", green: 0.8431372549019608, alpha: 1, daSymbolicColorName: "green", ckSymbolicColorName: "green", blue: 0.32941176470588235 },
  "light-blue": { colorRGBSpace: 2, red: 0.35294117647058826, daHexString: "#5AC8FA", green: 0.7843137254901961, alpha: 1, daSymbolicColorName: "custom", ckSymbolicColorName: "lightBlue", blue: 0.9803921568627451 },
  blue: { colorRGBSpace: 2, red: 0, daHexString: "#0088FF", green: 0.5333333333333333, alpha: 1, daSymbolicColorName: "blue", ckSymbolicColorName: "blue", blue: 1 },
  indigo: { colorRGBSpace: 2, red: 0.34509803921568627, daHexString: "#5856D6", green: 0.33725490196078434, alpha: 1, daSymbolicColorName: "custom", ckSymbolicColorName: "indigo", blue: 0.8392156862745098 },
  pink: { colorRGBSpace: 2, red: 1, daHexString: "#FF2D55", green: 0.17647058823529413, alpha: 1, daSymbolicColorName: "custom", ckSymbolicColorName: "pink", blue: 0.3333333333333333 },
  purple: { colorRGBSpace: 2, red: 0.796078431372549, daHexString: "#CB30E0", green: 0.18823529411764706, alpha: 1, daSymbolicColorName: "purple", ckSymbolicColorName: "purple", blue: 0.8784313725490196 },
  brown: { colorRGBSpace: 2, red: 0.6745098039215687, daHexString: "#AC7F5E", green: 0.4980392156862745, alpha: 1, daSymbolicColorName: "brown", ckSymbolicColorName: "brown", blue: 0.3686274509803922 },
  grey: { colorRGBSpace: 2, red: 0.3568627450980392, daHexString: "#5B626A", green: 0.3843137254901961, alpha: 1, daSymbolicColorName: "custom", ckSymbolicColorName: "gray", blue: 0.41568627450980394 },
  rose: { colorRGBSpace: 2, red: 0.8509803921568627, daHexString: "#D9A69F", green: 0.6509803921568628, alpha: 1, daSymbolicColorName: "custom", ckSymbolicColorName: "rose", blue: 0.6235294117647059 },
};

const COLOR_JSON = Object.fromEntries(COLOR_PRESETS.map(preset => [preset, JSON.stringify(NATIVE_LIST_COLORS[preset])])) as Record<ColorPresetName, string>;
const colorByCanonicalValue = new Map(COLOR_PRESETS.map(preset => [canonicalJSON(NATIVE_LIST_COLORS[preset]), preset]));

// Construct at runtime so TypeScript can keep the repository's ES2022 target;
// the supported Worker V8 runtime supplies Unicode properties of strings.
const RGI_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");
export function isSingleEmojiGrapheme(value: string): boolean {
  if (value.length < 1 || value.length > 32 || /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value)) return false;
  return RGI_EMOJI.test(value);
}

export const EmojiInput = z.string().max(32).refine(isSingleEmojiGrapheme,
  "Supply one emoji grapheme from the native emoji picker.").describe("One emoji grapheme, such as 🛒 or 🏷️. Plain text, multiple emoji and clearing are not supported.");

const UpdateListAppearanceFields = z.object({
  listId: ListId
    .describe("Exact list ID returned by a Reminders list read; do not use a title or invent an ID."),
  recordChangeTag: z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value))
    .describe("Current Apple version tag returned by get_reminder_list_appearance. Stale tags fail without retry."),
  colorPreset: ColorPreset.optional(),
  emoji: EmojiInput.optional(),
}).strict();
export const UpdateListAppearanceInput = UpdateListAppearanceFields.refine(value => value.colorPreset !== undefined || value.emoji !== undefined,
  "Provide a colorPreset, an emoji, or both.");
export const UpdateListAppearanceRequest = UpdateListAppearanceFields.extend({ expectedGeneration: z.number().int().nonnegative().safe()
  .describe("Apple session generation from connection_status. Supply it to bind this mutation to the current session.") }).strict()
  .refine(value => value.colorPreset !== undefined || value.emoji !== undefined, "Provide a colorPreset, an emoji, or both.");

export function colorValueForPreset(preset: ColorPresetName): string { return COLOR_JSON[preset]; }

function parseNativeJSON(value: unknown, maxBytes = 2_048): unknown | null {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > maxBytes) return null;
  try { return JSON.parse(value) as unknown; }
  catch { return null; }
}

export function isNativeColorValue(value: unknown): boolean {
  const parsed = parseNativeJSON(value);
  return parsed !== null && colorByCanonicalValue.has(canonicalJSON(parsed));
}

export function isNativeEmojiValue(value: unknown): boolean {
  const parsed = parseNativeJSON(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const object = parsed as Record<string, unknown>;
  return Object.keys(object).length === 1 && typeof object.Emoji === "string" && isSingleEmojiGrapheme(object.Emoji);
}

export const ListColorAppearance = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z.object({ kind: z.literal("preset"), preset: ColorPreset }).strict(),
  z.object({ kind: z.literal("custom") }).strict(),
  z.object({ kind: z.literal("unsupported") }).strict(),
]);
export const ListBadgeAppearance = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("emoji"), emoji: EmojiInput }).strict(),
  z.object({ kind: z.literal("unsupported") }).strict(),
]);

function unwrapNativeString(field: unknown): { kind: "absent" } | { kind: "value"; value: string } | { kind: "unsupported" } {
  if (field === undefined) return { kind: "absent" };
  if (!field || typeof field !== "object" || Array.isArray(field)) return { kind: "unsupported" };
  const wrapper = field as Record<string, unknown>;
  if (wrapper.type !== "STRING" || typeof wrapper.value !== "string") return { kind: "unsupported" };
  return { kind: "value", value: wrapper.value };
}

export function readListAppearance(fields: Record<string, unknown>) {
  const color = unwrapNativeString(fields.Color);
  let colorAppearance: z.infer<typeof ListColorAppearance>;
  if (color.kind === "absent") colorAppearance = { kind: "default" };
  else if (color.kind === "unsupported") colorAppearance = { kind: "unsupported" };
  else {
    const parsed = parseNativeJSON(color.value);
    if (parsed === null) colorAppearance = { kind: "unsupported" };
    else {
      const preset = colorByCanonicalValue.get(canonicalJSON(parsed));
      colorAppearance = preset ? { kind: "preset", preset } : { kind: "custom" };
    }
  }

  const badge = unwrapNativeString(fields.BadgeEmblem);
  let badgeAppearance: z.infer<typeof ListBadgeAppearance>;
  if (badge.kind === "absent") badgeAppearance = { kind: "none" };
  else if (badge.kind === "unsupported") badgeAppearance = { kind: "unsupported" };
  else {
    const parsed = parseNativeJSON(badge.value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) badgeAppearance = { kind: "unsupported" };
    else {
      const object = parsed as Record<string, unknown>;
      badgeAppearance = Object.keys(object).length === 1 && typeof object.Emoji === "string" && isSingleEmojiGrapheme(object.Emoji)
        ? { kind: "emoji", emoji: object.Emoji } : { kind: "unsupported" };
    }
  }
  return { color: colorAppearance, badge: badgeAppearance };
}

export function nativeEmojiField(emoji: string): string { return `{"Emoji" : ${JSON.stringify(EmojiInput.parse(emoji))}}`; }

export function canonicalNativeJSONField(fieldName: string, field: unknown): unknown {
  if (!field || typeof field !== "object" || Array.isArray(field)) return field;
  const wrapper = field as Record<string, unknown>;
  if (wrapper.type !== "STRING" || typeof wrapper.value !== "string" || !["Color", "BadgeEmblem", "ResolutionTokenMap"].includes(fieldName)) return field;
  const parsed = parseNativeJSON(wrapper.value, fieldName === "ResolutionTokenMap" ? 65_536 : 2_048);
  return parsed === null ? field : { ...wrapper, value: canonicalJSON(parsed) };
}
