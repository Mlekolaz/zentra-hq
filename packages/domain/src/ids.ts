import { randomUUID } from "node:crypto";
import { z } from "zod";

export const uuidSchema = z.uuid();

export type EntityId = string;
export type EventId = string;
export type RawEventId = string;
export type CorrelationId = string;
export type TraceId = string;
export type ConnectorAccountId = string;
export type WorkspaceId = string;
export type MemberId = string;

export const newId = (): string => randomUUID();
export const newTraceId = (): TraceId => randomUUID();
