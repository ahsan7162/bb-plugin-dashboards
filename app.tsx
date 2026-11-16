// bb-plugin-dashboards frontend: the card in replies, the dashboard's side-panel tab and the Dashboards page.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { CARD_LANGUAGE } from "./shared";
import { DashboardCard } from "./ui/card";
import { DASHBOARDS_PAGE, DashboardsPage } from "./ui/gallery";
import { DASHBOARD_TAB, DashboardTab } from "./ui/panel";

export default definePluginApp((app) => {
  app.slots.experimental_tab({ ...DASHBOARD_TAB, title: "Dashboard", icon: "LayoutDashboard", component: DashboardTab });
  app.slots.experimental_codeFenceRenderer({ id: "dashboard-card", languages: [CARD_LANGUAGE], component: DashboardCard });
  app.slots.navPanel({ ...DASHBOARDS_PAGE, component: DashboardsPage });
});
