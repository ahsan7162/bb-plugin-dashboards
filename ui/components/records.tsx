// RecordList and Record: items from a system; picking one writes its id to a $variable (the drill-down path).
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { defineComponent, reactive } from "@openuidev/react-lang";
import { z } from "zod/v4";
import { isSet, list, text, tone, useBound, webUrl, type Tone } from "./bound";

const id = z.union([z.string(), z.number()]);

export const RecordItem = defineComponent({
  name: "Record",
  props: z.object({ id, title: z.string(), status: z.string().optional(), owner: z.string().optional(), age: z.string().optional(), link: z.string().optional() }),
  description:
    'One item of a RecordList: id (what picking it writes), title, then optional status (a badge), owner, age ("3d", "2 h ago") and link (an http or https address of the item in its home system).',
  component: () => null, // RecordList draws its records itself; a Record is allowed nowhere else
});

type RecordProps = z.infer<typeof RecordItem.props>;

export const RecordList = defineComponent({
  name: "RecordList",
  props: z.object({
    records: z.array(RecordItem.ref),
    selected: reactive(id.optional()),
    tones: z.record(z.string(), tone).optional(),
  }),
  description:
    'Items from a system (issues, incidents, orders): RecordList(@Each(rows, "r", Record(r.id, r.title, r.status, r.owner, r.age, r.link)), $selected, {"Open": "warning", "Done": "good"}). Picking an item writes its id to selected\'s $variable ($selected = null), and picking it again clears it; a Drawer reading $selected shows the details. tones colours each status like Column\'s tones.',
  component: ({ props, statementId }) => {
    const records = list(props.records).flatMap((r) => (r?.props ? [r.props as RecordProps] : []));
    // Without a $variable or a statement name, the record ids tell two lists apart (as the filters use their options).
    const field = useBound<string | number>(props.selected, "records", statementId ?? records.map((r) => r.id).join("|"));
    const tones: Partial<Record<string, Tone>> = props.tones ?? {};
    if (records.length === 0) return <p className="bbd-records-none">No items.</p>;
    return (
      <ul className="bbd-records">
        {records.map((record, i) => {
          const picked = isSet(field.value) && String(field.value) === String(record.id);
          const href = webUrl(record.link);
          const status = text(record.status);
          return (
            <li key={`${String(record.id)}:${i}`} className="bbd-record">
              {/* Writes the id as the data has it, so @Filter(rows, "id", "==", $selected) matches numbers too. */}
              <button type="button" className="bbd-record-pick" aria-pressed={picked} onClick={() => field.setValue(picked ? "" : record.id)}>
                <span className="bbd-record-title">{text(record.title)}</span>
                <span className="bbd-record-meta">
                  {status ? (
                    <span className="bbd-badge" data-tone={tones[status] ?? "neutral"}>
                      {status}
                    </span>
                  ) : null}
                  {record.owner ? <span>{text(record.owner)}</span> : null}
                  {record.age ? <span>{text(record.age)}</span> : null}
                </span>
              </button>
              {href ? (
                <UrlLink href={href} className="bbd-record-link" aria-label={`Open ${text(record.title)}`}>
                  ↗
                </UrlLink>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  },
});
