// A dashboard's optional theme, checked when saved: the library's token names only, and values that
// cannot load anything (no url()), because the panel will put them into CSS variables. The font is a
// generic family the panel applies itself (the library has no font token).
import { z } from "zod";
import { FONTS, type FontChoice } from "../shared";
import { THEME_TOKENS } from "./generated";

const cssValue = z
  .string()
  .regex(/^(?!.*url\()[#%(),./\w\s-]{1,120}$/i, "a CSS colour, length or shadow: letters, digits, spaces and #%(),./- only, no url()");
const tokens = z.partialRecord(z.enum(THEME_TOKENS), cssValue);

export const themeSchema = z
  .object({
    light: tokens.optional().describe("Token overrides for light mode, e.g. {accent: \"#1f6f43\", series1: \"#2a9d8f\", radius: \"6px\"}"),
    dark: tokens.optional().describe("Token overrides for dark mode; light applies to both when dark is left out"),
    font: z
      .enum(Object.keys(FONTS) as [FontChoice, ...FontChoice[]])
      .optional()
      .describe("sans (system sans-serif), serif or mono (monospace); left out, bb's own font"),
  })
  .strict();

export type Theme = z.infer<typeof themeSchema>;

/** A theme as read back from the database. One saved before font became a fixed choice keeps its colours and loses its font. */
export function storedTheme(raw: unknown): Theme | null {
  const theme = themeSchema.safeParse(raw);
  if (theme.success) return theme.data;
  const { font: _font, ...rest } = raw as Record<string, unknown>;
  return themeSchema.safeParse(rest).data ?? null;
}
