import { Route, Routes } from "react-router-dom";
import { AppLayout } from "./layout";
import {
  AiActivityPage,
  AttentionPage,
  EventsPage,
  IntegrationsPage,
  OverviewPage,
  PlaceholderPage,
} from "./pages";

const placeholders = [
  "Inbox",
  "CRM",
  "Pipelines",
  "Tasks",
  "Meetings",
  "Customers",
  "Product",
  "Marketing",
  "DevOps",
  "Security",
  "Billing",
  "Automations",
];

export const App = () => (
  <Routes>
    <Route element={<AppLayout />}>
      <Route index element={<OverviewPage />} />
      <Route path="events" element={<EventsPage />} />
      <Route path="attention" element={<AttentionPage />} />
      <Route path="integrations" element={<IntegrationsPage />} />
      <Route path="ai-activity" element={<AiActivityPage />} />
      {placeholders.map((title) => (
        <Route
          key={title}
          path={title.toLowerCase()}
          element={<PlaceholderPage title={title} />}
        />
      ))}
    </Route>
  </Routes>
);
