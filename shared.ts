// Used by both server.ts and the browser code; imports nothing, so neither side pulls in the other.

/** Realtime channel; each save publishes `{ dashboardId, version }` on it. */
export const DASHBOARD_SAVED = "dashboard-saved";
/** Realtime channel; storing agent data publishes `{ dashboardId, sources }` on it (no new version). */
export const DASHBOARD_DATA = "dashboard-data";
/** The shortest refresh interval of a script source, in seconds: refused below it at save, answered from the cache when asked sooner. */
export const SCRIPT_MIN_REFRESH_SECONDS = 30;
/** Code-fence language of the card block. No other plugin claims it; a duplicate claim falls back to a plain code block. */
export const CARD_LANGUAGE = "bb-dashboard";

const DASHBOARD_ID = /^[0-9a-f]{12}$/;

/** A fence body, tab params or ping payload is untrusted: only a well-formed id gets through. */
export function dashboardIdFrom(value: unknown): string | null {
  const id = typeof value === "object" && value !== null && "dashboardId" in value ? value.dashboardId : value;
  return typeof id === "string" && DASHBOARD_ID.test(id.trim()) ? id.trim() : null;
}

/** The block the agent puts in its reply; bb renders it as the dashboard's card. */
export const cardBlock = (id: string) => "```" + CARD_LANGUAGE + "\n" + id + "\n```";

/** The theme's font choices: generic families only, so the browser never fetches a font. */
export const FONTS = {
  sans: "system-ui, sans-serif",
  serif: "ui-serif, serif",
  mono: "ui-monospace, monospace",
} as const;
export type FontChoice = keyof typeof FONTS;
