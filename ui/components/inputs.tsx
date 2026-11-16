// View controls bound to a $variable (SearchBox, Toggle, Slider) and AskAgent. They change what the
// page shows and nothing else; AskAgent only raises an OpenUI action for the panel to handle.
import { useId } from "react";
import { defineComponent, reactive, useTriggerAction } from "@openuidev/react-lang";
import { z } from "zod/v4";
import { text, useBound } from "./bound";

export const SearchBox = defineComponent({
  name: "SearchBox",
  props: z.object({ value: reactive(z.string()), placeholder: z.string().optional() }),
  description:
    'Type to filter. value takes the $variable that holds the text ($q = ""); read it with @Filter(rows, "title", "contains", $q) or a Table\'s search argument. placeholder says what is searched.',
  component: ({ props, statementId }) => {
    const field = useBound<string>(props.value, "search", statementId ?? props.placeholder);
    const label = text(props.placeholder) || "Search";
    return (
      <div className="bbd-search">
        <span className="bbd-search-icon" aria-hidden="true">
          ⌕
        </span>
        <input type="search" className="bbd-search-input" aria-label={label} placeholder={label} value={text(field.value)} onChange={(e) => field.setValue(e.target.value)} />
      </div>
    );
  },
});

export const Toggle = defineComponent({
  name: "Toggle",
  props: z.object({ value: reactive(z.boolean()), label: z.string() }),
  description: 'An on/off view option, e.g. Toggle($failing, "Only failing") with $failing = false; read it in a ternary: $failing ? @Filter(rows, "status", "==", "Failing") : rows.',
  component: ({ props, statementId }) => {
    const field = useBound<boolean>(props.value, "toggle", statementId ?? props.label);
    const on = field.value === true;
    return (
      <button type="button" role="switch" aria-checked={on} className="bbd-toggle" onClick={() => field.setValue(!on)}>
        <span className="bbd-switch" aria-hidden="true">
          <span className="bbd-switch-thumb" />
        </span>
        <span>{text(props.label)}</span>
      </button>
    );
  },
});

export const Slider = defineComponent({
  name: "Slider",
  props: z.object({ value: reactive(z.number()), label: z.string(), min: z.number(), max: z.number(), step: z.number().optional() }),
  description: 'A number the user drags, e.g. a threshold or "top N": Slider($top, "Show top", 3, 20) with $top = 5. step defaults to 1.',
  component: ({ props, statementId }) => {
    const field = useBound<number>(props.value, "slider", statementId ?? props.label);
    const id = useId(); // ties the label to the input; state is named by useBound
    const min = Number.isFinite(props.min) ? props.min : 0;
    const max = Number.isFinite(props.max) && props.max > min ? props.max : min + 1;
    const value = typeof field.value === "number" && Number.isFinite(field.value) ? Math.min(max, Math.max(min, field.value)) : min;
    return (
      <div className="bbd-slider">
        <label htmlFor={id} className="bbd-slider-label">
          {text(props.label)}
        </label>
        <output htmlFor={id} className="bbd-slider-value">
          {value}
        </output>
        <input id={id} type="range" className="bbd-slider-input" min={min} max={max} step={props.step && props.step > 0 ? props.step : 1} value={value} onChange={(e) => field.setValue(Number(e.target.value))} />
      </div>
    );
  },
});

export const AskAgent = defineComponent({
  name: "AskAgent",
  props: z.object({ label: z.string(), message: z.string() }),
  description:
    'A button that asks the agent about what is on screen, e.g. AskAgent("Explain this spike", "Why did checkout errors rise on Tuesday?"). Clicking sends message to the agent in this thread; it costs a model call, so offer it only for questions the page cannot answer itself.',
  component: ({ props }) => {
    const triggerAction = useTriggerAction();
    // A plain message is delivered to Renderer's onAction as a continue_conversation event; the panel decides what to do.
    return (
      <button type="button" className="bbd-ask" onClick={() => void triggerAction(text(props.message))}>
        <span aria-hidden="true">✦</span>
        {text(props.label)}
      </button>
    );
  },
});
