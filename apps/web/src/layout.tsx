import {
  Activity,
  AlarmClock,
  Bot,
  Boxes,
  CalendarDays,
  ChevronRight,
  CircleDollarSign,
  ContactRound,
  GitBranch,
  Inbox,
  LayoutDashboard,
  Megaphone,
  PackageSearch,
  Radar,
  Settings2,
  ShieldCheck,
  UsersRound,
  Workflow,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";

const navigation = [
  ["Overview", "/", LayoutDashboard],
  ["Events", "/events", Activity],
  ["Attention", "/attention", Radar],
  ["Inbox", "/inbox", Inbox],
  ["CRM", "/crm", ContactRound],
  ["Pipelines", "/pipelines", GitBranch],
  ["Tasks", "/tasks", AlarmClock],
  ["Meetings", "/meetings", CalendarDays],
  ["Customers", "/customers", UsersRound],
  ["Product", "/product", PackageSearch],
  ["Marketing", "/marketing", Megaphone],
  ["DevOps", "/devops", Boxes],
  ["Security", "/security", ShieldCheck],
  ["Billing", "/billing", CircleDollarSign],
  ["Automations", "/automations", Workflow],
  ["Integrations", "/integrations", Settings2],
  ["AI Activity", "/ai-activity", Bot],
] as const;

export const AppLayout = () => (
  <div className="min-h-screen bg-canvas md:grid md:grid-cols-[224px_minmax(0,1fr)]">
    <aside className="border-b border-line bg-[#0d1014] md:sticky md:top-0 md:h-screen md:border-b-0 md:border-r">
      <div className="flex h-16 items-center gap-3 border-b border-line px-5">
        <div className="flex h-7 w-7 items-center justify-center bg-slate-100 text-xs font-bold text-slate-950">
          Z
        </div>
        <div>
          <p className="text-sm font-semibold tracking-tight text-white">
            Zentra HQ
          </p>
          <p className="text-[10px] uppercase tracking-[0.18em] text-muted">
            Command center
          </p>
        </div>
      </div>
      <nav
        className="flex gap-1 overflow-x-auto p-3 md:block md:h-[calc(100vh-8rem)] md:overflow-y-auto"
        aria-label="Primary"
      >
        {navigation.map(([label, path, Icon]) => (
          <NavLink
            key={path}
            to={path}
            end={path === "/"}
            className={({ isActive }) =>
              `flex shrink-0 items-center gap-2.5 px-3 py-2 text-xs font-medium transition-colors md:mb-0.5 ${
                isActive
                  ? "bg-[#1a1f27] text-white"
                  : "text-muted hover:bg-[#15191f] hover:text-slate-200"
              }`
            }
          >
            <Icon size={15} strokeWidth={1.8} />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="hidden border-t border-line px-5 py-4 md:block">
        <div className="flex items-center justify-between text-xs text-muted">
          <span className="inline-flex items-center gap-2">
            <span className="h-1.5 w-1.5 bg-emerald-400" />
            M0 local
          </span>
          <ChevronRight size={13} />
        </div>
      </div>
    </aside>
    <main className="min-w-0">
      <div className="mx-auto max-w-[1280px] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
        <Outlet />
      </div>
    </main>
  </div>
);
