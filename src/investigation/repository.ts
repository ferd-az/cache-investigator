import type {
  FinalFinding,
  Investigation,
  InvestigationConfiguration,
  InvestigationEvent,
  InvestigationPlanStep,
  InvestigationScope,
  InvestigationStatus,
  InvestigationSummary,
  InvestigationTrigger
} from "./contracts.ts";

export type InvestigationSeed = {
  id: string;
  idempotencyKey: string;
  title: string;
  trigger: InvestigationTrigger;
  scope: InvestigationScope;
  configuration: InvestigationConfiguration;
  createdAt: string;
  plan: InvestigationPlanStep[];
};

type WithoutEnvelope<Event> = Event extends unknown
  ? Omit<Event, "id" | "investigationId" | "sequence" | "at">
  : never;

export type InvestigationEventBody = WithoutEnvelope<InvestigationEvent>;

export type InvestigationPatch = {
  status?: InvestigationStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  plan?: InvestigationPlanStep[];
  finding?: FinalFinding | null;
};

export interface InvestigationRepository {
  create(seed: InvestigationSeed): Promise<Investigation>;
  get(id: string): Promise<Investigation | null>;
  getByIdempotencyKey(key: string): Promise<Investigation | null>;
  list(): Promise<InvestigationSummary[]>;
  appendEvent(
    investigationId: string,
    operationKey: string,
    at: string,
    event: InvestigationEventBody
  ): Promise<InvestigationEvent>;
  patch(id: string, patch: InvestigationPatch): Promise<void>;
  loadCheckpoint<T>(id: string): Promise<T | null>;
  saveCheckpoint(id: string, checkpoint: unknown): Promise<void>;
}

type InvestigationRow = {
  id: string;
  idempotency_key: string;
  title: string;
  status: InvestigationStatus;
  trigger_json: string;
  scope_json: string;
  configuration_json: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  plan_json: string;
  finding_json: string | null;
  checkpoint_json: string | null;
};

type InvestigationSummaryRow = Pick<
  InvestigationRow,
  | "id"
  | "title"
  | "status"
  | "trigger_json"
  | "scope_json"
  | "created_at"
  | "started_at"
  | "completed_at"
  | "finding_json"
>;

type EventRow = {
  id: string;
  investigation_id: string;
  sequence: number;
  at: string;
  payload_json: string;
};

export class D1InvestigationRepository implements InvestigationRepository {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async create(seed: InvestigationSeed): Promise<Investigation> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO investigations (
          id, idempotency_key, title, status, trigger_json, scope_json,
          configuration_json, created_at, plan_json
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`
      )
      .bind(
        seed.id,
        seed.idempotencyKey,
        seed.title,
        JSON.stringify(seed.trigger),
        JSON.stringify(seed.scope),
        JSON.stringify(seed.configuration),
        seed.createdAt,
        JSON.stringify(seed.plan)
      )
      .run();

    const existing = await this.getByIdempotencyKey(seed.idempotencyKey);
    if (!existing) throw new Error("Investigation was not persisted");
    return existing;
  }

  async get(id: string): Promise<Investigation | null> {
    const row = await this.db
      .prepare("SELECT * FROM investigations WHERE id = ?")
      .bind(id)
      .first<InvestigationRow>();
    return row ? this.hydrate(row) : null;
  }

  async getByIdempotencyKey(key: string): Promise<Investigation | null> {
    const row = await this.db
      .prepare("SELECT * FROM investigations WHERE idempotency_key = ?")
      .bind(key)
      .first<InvestigationRow>();
    return row ? this.hydrate(row) : null;
  }

  async list(): Promise<InvestigationSummary[]> {
    const rows = await this.db
      .prepare(
        `SELECT
          id, title, status, trigger_json, scope_json, created_at,
          started_at, completed_at, finding_json
        FROM investigations
        ORDER BY created_at DESC`
      )
      .all<InvestigationSummaryRow>();
    return rows.results.map(toSummary);
  }

  async appendEvent(
    investigationId: string,
    operationKey: string,
    at: string,
    event: InvestigationEventBody
  ): Promise<InvestigationEvent> {
    const eventId = `evt:${operationKey}`;
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO investigation_events (
          investigation_id, id, operation_key, sequence, at, payload_json
        )
        SELECT ?, ?, ?,
          COALESCE(MAX(sequence), 0) + 1,
          ?, ?
        FROM investigation_events
        WHERE investigation_id = ?`
      )
      .bind(
        investigationId,
        eventId,
        operationKey,
        at,
        JSON.stringify(event),
        investigationId
      )
      .run();

    const row = await this.db
      .prepare(
        `SELECT id, investigation_id, sequence, at, payload_json
        FROM investigation_events
        WHERE investigation_id = ? AND operation_key = ?`
      )
      .bind(investigationId, operationKey)
      .first<EventRow>();
    if (!row) throw new Error("Investigation event was not persisted");
    return toEvent(row);
  }

  async patch(id: string, patch: InvestigationPatch): Promise<void> {
    const assignments: string[] = [];
    const bindings: Array<string | null> = [];
    if (patch.status !== undefined) {
      assignments.push("status = ?");
      bindings.push(patch.status);
    }
    if (patch.startedAt !== undefined) {
      assignments.push("started_at = ?");
      bindings.push(patch.startedAt);
    }
    if (patch.completedAt !== undefined) {
      assignments.push("completed_at = ?");
      bindings.push(patch.completedAt);
    }
    if (patch.plan !== undefined) {
      assignments.push("plan_json = ?");
      bindings.push(JSON.stringify(patch.plan));
    }
    if (patch.finding !== undefined) {
      assignments.push("finding_json = ?");
      bindings.push(patch.finding ? JSON.stringify(patch.finding) : null);
    }
    if (assignments.length === 0) return;

    bindings.push(id);
    await this.db
      .prepare(
        `UPDATE investigations SET ${assignments.join(", ")} WHERE id = ?`
      )
      .bind(...bindings)
      .run();
  }

  async loadCheckpoint<T>(id: string): Promise<T | null> {
    const row = await this.db
      .prepare("SELECT checkpoint_json FROM investigations WHERE id = ?")
      .bind(id)
      .first<{ checkpoint_json: string | null }>();
    return row?.checkpoint_json ? (JSON.parse(row.checkpoint_json) as T) : null;
  }

  async saveCheckpoint(id: string, checkpoint: unknown): Promise<void> {
    await this.db
      .prepare("UPDATE investigations SET checkpoint_json = ? WHERE id = ?")
      .bind(JSON.stringify(checkpoint), id)
      .run();
  }

  private async hydrate(row: InvestigationRow): Promise<Investigation> {
    const events = await this.db
      .prepare(
        `SELECT id, investigation_id, sequence, at, payload_json
        FROM investigation_events
        WHERE investigation_id = ?
        ORDER BY sequence ASC`
      )
      .bind(row.id)
      .all<EventRow>();

    return {
      id: row.id,
      title: row.title,
      status: row.status,
      trigger: JSON.parse(row.trigger_json) as InvestigationTrigger,
      scope: JSON.parse(row.scope_json) as InvestigationScope,
      configuration: JSON.parse(
        row.configuration_json
      ) as InvestigationConfiguration,
      createdAt: row.created_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      plan: JSON.parse(row.plan_json) as InvestigationPlanStep[],
      events: events.results.map(toEvent),
      ...(row.finding_json
        ? { finding: JSON.parse(row.finding_json) as FinalFinding }
        : {})
    };
  }
}

function toEvent(row: EventRow): InvestigationEvent {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    sequence: row.sequence,
    at: row.at,
    ...(JSON.parse(row.payload_json) as InvestigationEventBody)
  } as InvestigationEvent;
}

function toSummary(row: InvestigationSummaryRow): InvestigationSummary {
  const finding = row.finding_json
    ? (JSON.parse(row.finding_json) as FinalFinding)
    : undefined;

  return {
    id: row.id,
    title: row.title,
    status: row.status,
    trigger: JSON.parse(row.trigger_json) as InvestigationTrigger,
    scope: JSON.parse(row.scope_json) as InvestigationScope,
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(finding ? { confidence: finding.confidence } : {})
  };
}
