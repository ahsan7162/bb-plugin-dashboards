// Helpers every new component shares: bound state, null-safe lists, and the link guard.
import { isReactiveAssign, useStateField, type StateField } from "@openuidev/react-lang";
import { z } from "zod/v4";

/**
 * A `$binding` prop's state, the way the library's filters do it (spikes/openui-lib/src/pickList.tsx):
 * the bound $variable, or for a plain value a field of the component's own. That field is named by
 * kind and statement (or label), never by tree position, so a remembered value finds its component
 * again after a patch.
 */
export function useBound<T>(value: unknown, kind: string, name: unknown): StateField<T> {
  return useStateField(isReactiveAssign(value) ? value.target : `${kind}:${String(name ?? "")}`, value) as StateField<T>;
}

/** A prop can arrive as null before its data is ready (a pluck of a Query default, a missing field). */
export const list = <T>(value: readonly T[] | null | undefined): T[] => (Array.isArray(value) ? [...value] : []);

/** Text for display: data fields can be null or numbers. */
export const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));

/** True when the bound value counts as set: not null, empty or false. */
export const isSet = (value: unknown) => value !== null && value !== undefined && value !== "" && value !== false;

/** Only http and https open; anything else (javascript:, data:, file:, a bare word) is not a link. server/validate.ts refuses the same at save. */
export function webUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const { protocol } = new URL(value.trim());
    return protocol === "http:" || protocol === "https:" ? value.trim() : null;
  } catch {
    return null;
  }
}

/** The library's status tones (Column's tones use the same words). */
export const tone = z.enum(["neutral", "good", "bad", "warning", "info"]);
export type Tone = z.infer<typeof tone>;
