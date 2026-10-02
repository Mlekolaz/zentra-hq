import { useQuery } from "@tanstack/react-query";
import { Bot, Radar, Unplug } from "lucide-react";
import { useState } from "react";
import { api, type EventItem } from "./api";
import {
  EmptyState,
  EventsTable,
  LoadingState,
  PageHeader,
  QueryState,
} from "./components";

export const OverviewPage = () => {
  const query = useQuery({
    queryKey: ["overview"],
    queryFn: api.overview,
    refetchInterval: 5_000,
  });
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Overview"
        description="Current event flow and the small set of conditions requiring operator attention. M0 reports system facts only."
      />
      {query.isPending && <LoadingState />}
      {query.error !== null && <QueryState error={query.error} />}
      {query.data !== undefined && (
        <div className="space-y-8">
          <section
            className="grid border-l border-t border-line sm:grid-cols-2 lg:grid-cols-4"
            aria-label="System totals"
          >
            {[
              ["Total events", query.data.totalEvents],
              ["Events today", query.data.eventsToday],
              ["Failed processing", query.data.failedProcessing],
              ["Pending approvals", query.data.pendingApprovals],
            ].map(([label, value]) => (
              <div
                key={label}
                className="border-b border-r border-line bg-panel px-5 py-5"
              >
                <p className="eyebrow">{label}</p>
                <p className="mt-3 text-2xl font-semibold tabular-nums text-white">
                  {value}
                </p>
              </div>
            ))}
          </section>
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-slate-100">
                Recent canonical events
              </h2>
              <span className="text-xs text-muted">
                Auto-refreshes every 5 seconds
              </span>
            </div>
            {query.data.recentEvents.length === 0 ? (
              <EmptyState title="No canonical events yet">
                The development store is empty. Send the signed Zentra event
                from the README to verify the full ingestion flow.
              </EmptyState>
            ) : (
              <EventsTable events={query.data.recentEvents} />
            )}
          </section>
        </div>
      )}
    </>
  );
};

export const EventsPage = () => {
  const [selected, setSelected] = useState<EventItem | null>(null);
  const query = useQuery({
    queryKey: ["events"],
    queryFn: api.events,
    refetchInterval: 3_000,
  });
  return (
    <>
      <PageHeader
        eyebrow="Event store"
        title="Events"
        description="Normalized facts accepted by the canonical event boundary."
      />
      {query.isPending && <LoadingState />}
      {query.error !== null && <QueryState error={query.error} />}
      {query.data !== undefined &&
        (query.data.events.length === 0 ? (
          <EmptyState title="No events to inspect">
            In-memory development mode starts empty on every API restart.
          </EmptyState>
        ) : (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
            <EventsTable events={query.data.events} onSelect={setSelected} />
            <aside className="panel min-h-56 p-5" aria-live="polite">
              <p className="eyebrow">Technical detail</p>
              {selected === null ? (
                <p className="mt-4 text-sm leading-6 text-muted">
                  Select an event to inspect identifiers and delivery timing.
                </p>
              ) : (
                <dl className="mt-5 space-y-4 text-xs">
                  {Object.entries({
                    "Event ID": selected.id,
                    "Raw event ID": selected.rawEventId,
                    "Trace ID": selected.traceId,
                    Received: new Date(selected.receivedAt).toLocaleString(),
                    Occurred: new Date(selected.occurredAt).toLocaleString(),
                  }).map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-muted">{label}</dt>
                      <dd className="mt-1 break-all font-mono text-slate-200">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </aside>
          </div>
        ))}
    </>
  );
};

export const IntegrationsPage = () => {
  const query = useQuery({
    queryKey: ["integrations"],
    queryFn: api.integrations,
  });
  return (
    <>
      <PageHeader
        eyebrow="Sources"
        title="Integrations"
        description="Connector capabilities and runtime health for trusted and development sources."
      />
      {query.isPending && <LoadingState />}
      {query.error !== null && <QueryState error={query.error} />}
      {query.data?.integrations.map((integration) => (
        <article
          key={integration.provider}
          className="panel flex flex-col gap-5 p-5 sm:flex-row sm:items-start sm:justify-between"
        >
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium capitalize text-white">
                {integration.provider} Connector
              </h2>
              {integration.developmentOnly && (
                <span className="border border-line px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">
                  Development
                </span>
              )}
            </div>
            <p className="mt-2 text-xs text-muted">
              {integration.capabilities.join(" · ")}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-emerald-300">
            <span className="h-1.5 w-1.5 bg-emerald-400" />
            {integration.health.status}
          </div>
        </article>
      ))}
    </>
  );
};

export const AttentionPage = () => (
  <>
    <PageHeader
      eyebrow="Attention management"
      title="Attention"
      description="The future operator queue for high-value, urgent, or risky work."
    />
    <EmptyState
      icon={<Radar size={22} />}
      title="Attention Engine is intentionally inactive"
    >
      Attention Engine zostanie dodany po zasileniu HQ realnymi eventami. M0
      does not fabricate priorities or production activity.
    </EmptyState>
  </>
);

export const AiActivityPage = () => (
  <>
    <PageHeader
      eyebrow="Governed intelligence"
      title="AI Activity"
      description="Future classification, extraction, drafting, and recommendation traces."
    />
    <EmptyState icon={<Bot size={22} />} title="AI runtime not enabled in M0">
      No model provider, prompt execution, embeddings, or autonomous agents are
      connected. Policy remains deterministic and outside AI.
    </EmptyState>
  </>
);

export const PlaceholderPage = ({ title }: { title: string }) => (
  <>
    <PageHeader
      eyebrow="Future module"
      title={title}
      description="This surface is reserved in the command center information architecture."
    />
    <EmptyState
      icon={<Unplug size={22} />}
      title={`${title} is not part of M0`}
    >
      The foundation supports adding this capability later without introducing a
      fake integration today.
    </EmptyState>
  </>
);
