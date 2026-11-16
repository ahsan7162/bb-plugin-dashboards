// Display-only components: Badge, LinkOut, Markdown, Callout, Empty.
import { Markdown as BbMarkdown, UrlLink } from "@get-bb/plugin-sdk/app";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod/v4";
import { text, tone, webUrl } from "./bound";

export const Badge = defineComponent({
  name: "Badge",
  props: z.object({ text: z.string(), tone: tone.optional() }),
  description: 'A coloured status word, e.g. Badge("Critical", "bad"). tone: "neutral" (default), "good", "bad", "warning" or "info".',
  component: ({ props }) => (
    <span className="bbd-badge bbd-enter" data-tone={props.tone ?? "neutral"}>
      {text(props.text)}
    </span>
  ),
});

export const LinkOut = defineComponent({
  name: "LinkOut",
  props: z.object({ label: z.string(), url: z.string() }),
  description: "A link that opens url in the user's browser, e.g. the item in its home system. Only http and https addresses; any other is refused.",
  component: ({ props }) => {
    const href = webUrl(props.url);
    if (href === null) return <span className="bbd-link-plain">{text(props.label)}</span>;
    return (
      <UrlLink href={href} className="bbd-link">
        {text(props.label)}
        <span aria-hidden="true" className="bbd-link-arrow">
          ↗
        </span>
      </UrlLink>
    );
  },
});

export const Markdown = defineComponent({
  name: "Markdown",
  props: z.object({ text: z.string() }),
  description: "Written explanation in Markdown between the charts: what the numbers mean, what changed, what to look at.",
  // bb's own renderer, so it reads like a chat message.
  component: ({ props }) => (
    <div className="bbd-markdown bbd-enter">
      <BbMarkdown content={text(props.text)} />
    </div>
  ),
});

const CALLOUT_ICON = { info: "i", success: "✓", warning: "!", error: "!" } as const;

export const Callout = defineComponent({
  name: "Callout",
  props: z.object({ text: z.string(), tone: z.enum(["info", "warning", "error", "success"]).optional(), title: z.string().optional() }),
  description: 'A highlighted note, e.g. Callout("Two regions report late; their numbers are a day old.", "warning"). tone: "info" (default), "warning", "error" or "success".',
  component: ({ props }) => {
    const kind = props.tone ?? "info";
    return (
      <div className="bbd-callout bbd-enter" data-tone={kind} role="note">
        <span className="bbd-callout-icon" aria-hidden="true">
          {CALLOUT_ICON[kind] ?? "i"}
        </span>
        <div>
          {props.title ? <p className="bbd-callout-title">{text(props.title)}</p> : null}
          <p className="bbd-callout-text">{text(props.text)}</p>
        </div>
      </div>
    );
  },
});

export const Empty = defineComponent({
  name: "Empty",
  props: z.object({ title: z.string(), reason: z.string().optional() }),
  description: 'What to show when there is nothing to show, with the reason, e.g. Empty("No open incidents", "Nothing has failed in the last 24 hours.").',
  component: ({ props }) => (
    <div className="bbd-empty bbd-enter">
      <p className="bbd-empty-title">{text(props.title)}</p>
      {props.reason ? <p className="bbd-empty-reason">{text(props.reason)}</p> : null}
    </div>
  ),
});
