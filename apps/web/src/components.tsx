import { AlertTriangle, CheckCircle2, LoaderCircle, Radio } from "lucide-react";
import type { ReactNode } from "react";
import type { EventItem } from "./api";

export const PageHeader = ({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) => (
  <header className="mb-8 border-b border-line pb-6">
    <p className="eyebrow mb-2">{eyebrow}</p>
    <h1 className="text-2xl font-semibold tracking-tight text-white">
      {title}
    </h1>
    <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{description}</p>
  </header>
);

export const EmptyState = ({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
}) => (
  <div className="panel flex min-h-56 flex-col items-center justify-center px-8 py-10 text-center">
    <div className="mb-4 text-muted">{icon ?? <Radio size={22} />}</div>
    <h2 className="text-sm font-medium text-slate-100">{title}</h2>
    <div className="mt-2 max-w-lg text-sm leading-6 text-muted">{children}</div>
  </div>
);

export const QueryState = ({ error }: { error: Error }) => (
  <div
    className="panel flex items-start gap-3 border-amber-900/70 bg-amber-950/20 p-4 text-sm text-amber-200"
    role="alert"
  >
    <AlertTriangle className="mt-0.5 shrink-0" size={16} />
    <div>
      <p className="font-medium">HQ API is unavailable</p>
      <p className="mt-1 text-amber-300/70">
        {error.message}. Start the API to leave the development empty state.
      </p>
    </div>
  </div>
);

export const LoadingState = () => (
  <div
    className="flex items-center gap-2 py-10 text-sm text-muted"
    role="status"
  >
    <LoaderCircle className="animate-spin" size={16} /> Loading HQ state…
  </div>
);

const statusStyle: Record<EventItem["processingStatus"], string> = {
  queued: "text-slate-400",
  processing: "text-blue-300",
  succeeded: "text-emerald-300",
  retryable_failed: "text-amber-300",
  permanently_failed: "text-red-300",
};

export const EventsTable = ({
  events,
  onSelect,
}: {
  events: EventItem[];
  onSelect?: (event: EventItem) => void;
}) => (
  <div className="overflow-x-auto border border-line">
    <table className="w-full min-w-[760px] border-collapse text-left text-sm">
      <thead className="bg-[#0e1115] text-[11px] uppercase tracking-wider text-muted">
        <tr>
          <th className="px-4 py-3 font-medium">Occurred</th>
          <th className="px-4 py-3 font-medium">Type</th>
          <th className="px-4 py-3 font-medium">Source</th>
          <th className="px-4 py-3 font-medium">Status</th>
          <th className="px-4 py-3 font-medium">Trace</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {events.map((event) => (
          <tr
            key={event.id}
            className={
              onSelect === undefined
                ? "bg-panel"
                : "cursor-pointer bg-panel hover:bg-[#161a20]"
            }
            onClick={onSelect === undefined ? undefined : () => onSelect(event)}
            onKeyDown={
              onSelect === undefined
                ? undefined
                : (keyboardEvent) => {
                    if (
                      keyboardEvent.key === "Enter" ||
                      keyboardEvent.key === " "
                    )
                      onSelect(event);
                  }
            }
            tabIndex={onSelect === undefined ? undefined : 0}
          >
            <td className="whitespace-nowrap px-4 py-3 text-slate-300">
              {new Date(event.occurredAt).toLocaleString()}
            </td>
            <td className="px-4 py-3 font-mono text-xs text-slate-100">
              {event.type}
            </td>
            <td className="px-4 py-3 text-slate-300">{event.source}</td>
            <td
              className={`px-4 py-3 text-xs font-medium ${statusStyle[event.processingStatus]}`}
            >
              <span className="inline-flex items-center gap-1.5">
                {event.processingStatus === "succeeded" && (
                  <CheckCircle2 size={13} />
                )}
                {event.processingStatus.replaceAll("_", " ")}
              </span>
            </td>
            <td className="px-4 py-3 font-mono text-xs text-muted">
              {event.traceId.slice(0, 8)}…
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
