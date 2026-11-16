// The one library dashboards render with: OpenUI's dashboard library (45 components) plus this
// plugin's own view components, added with the library's extend into Card.content and Section.rows
// (and into Tab.rows and Drawer.content, which reuse those two unions). Nothing new goes in a Row,
// which holds Cards only. scripts/generate.ts builds the save check's schema and the guide from it.
// The Dashboard root keeps its schema and gains the live-data Bridge (ui/live.tsx), so every program
// carries it inside the Renderer.
import { library as dashboard } from "@openuidev/dashboard-library";
import type { ComponentRenderProps } from "@openuidev/react-lang";
import { Bridge } from "./live";
import { AskAgent, SearchBox, Slider, Toggle } from "./components/inputs";
import { Freshness, RefreshButton } from "./components/live";
import { RecordItem, RecordList } from "./components/records";
import { Badge, Callout, Empty, LinkOut, Markdown } from "./components/text";
import { Frame } from "./components/frame";
import { Drawer, Tab, Tabs } from "./components/views";
import "./components/styles.css";

const CARD = ["Card.content", "Drawer.content"]; // inside a card, or a drawer, which holds what a card holds
const SECTION = ["Section.rows", "Tab.rows"]; // full width between Rows, or in a tab, which holds what a section holds

const Dashboard = dashboard.components.Dashboard!;
function DashboardWithBridge(props: ComponentRenderProps) {
  return (
    <>
      <Bridge />
      <Dashboard.component {...props} />
    </>
  );
}

export const library = dashboard.extend({
  components: {
    override: [{ ...Dashboard, component: DashboardWithBridge }],
    add: [
      { component: Tabs, slots: ["Section.rows"] },
      Tab, // only inside Tabs
      { component: Drawer, slots: ["Card.content", ...SECTION] },
      ...[SearchBox, Toggle, Slider, Markdown, Callout, Empty, Frame, AskAgent, Freshness, RefreshButton].map((component) => ({ component, slots: [...CARD, ...SECTION] })),
      ...[RecordList, Badge, LinkOut].map((component) => ({ component, slots: CARD })),
      RecordItem, // only inside RecordList
    ],
  },
});
