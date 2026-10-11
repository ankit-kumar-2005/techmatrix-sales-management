import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A recording stand-in for the supabase-js query builder, for unit tests
 * of code that takes an injected client (the domain services, the MCP
 * read/write tools). It never touches a network: every terminal call is
 * recorded and answered by the test's own responder, so a test can assert
 * EXACTLY which table, payload, filters and modifiers a code path sent —
 * which is what "behaves identically" means for a query-building module.
 *
 * Supports the subset of the builder this codebase uses. An unsupported
 * method fails loudly (TypeError) rather than silently passing.
 */

export type RecordedCall = {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "rpc";
  payload?: unknown;
  columns?: string;
  returning?: string;
  options?: unknown;
  filters: Array<[string, ...unknown[]]>;
  modifiers: Array<[string, ...unknown[]]>;
  terminal: "maybeSingle" | "single" | "await";
};

export type FakeResponse = { data: unknown; error: unknown; count?: number | null };
export type Responder = (call: RecordedCall) => FakeResponse;

const FILTERS = ["eq", "neq", "gt", "lt", "gte", "lte", "ilike", "is", "in", "not", "or", "contains"] as const;
const MODIFIERS = ["order", "limit", "range"] as const;

type FakeBuilder = PromiseLike<FakeResponse> & {
  select: (columns?: string, options?: unknown) => FakeBuilder;
  insert: (payload: unknown, options?: unknown) => FakeBuilder;
  update: (payload: unknown, options?: unknown) => FakeBuilder;
  upsert: (payload: unknown, options?: unknown) => FakeBuilder;
  maybeSingle: () => Promise<FakeResponse>;
  single: () => Promise<FakeResponse>;
} & Record<(typeof FILTERS)[number] | (typeof MODIFIERS)[number], (...args: unknown[]) => FakeBuilder>;

export function createFakeSupabase(responder: Responder): { client: SupabaseClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  function builder(table: string): FakeBuilder {
    const call: RecordedCall = { table, op: "select", filters: [], modifiers: [], terminal: "await" };

    const finish = (terminal: RecordedCall["terminal"]): Promise<FakeResponse> => {
      call.terminal = terminal;
      calls.push(call);
      return Promise.resolve(responder(call));
    };

    const self = {
      select(columns?: string, options?: unknown) {
        if (call.op === "select") {
          call.columns = columns;
          call.options = options;
        } else {
          call.returning = columns;
        }
        return self;
      },
      insert(payload: unknown, options?: unknown) {
        call.op = "insert";
        call.payload = payload;
        call.options = options;
        return self;
      },
      update(payload: unknown, options?: unknown) {
        call.op = "update";
        call.payload = payload;
        call.options = options;
        return self;
      },
      upsert(payload: unknown, options?: unknown) {
        call.op = "upsert";
        call.payload = payload;
        call.options = options;
        return self;
      },
      maybeSingle: () => finish("maybeSingle"),
      single: () => finish("single"),
      then<T1 = FakeResponse, T2 = never>(
        onFulfilled?: ((value: FakeResponse) => T1 | PromiseLike<T1>) | null,
        onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
      ) {
        return finish("await").then(onFulfilled, onRejected);
      },
    } as unknown as FakeBuilder;

    for (const name of FILTERS) {
      self[name] = (...args: unknown[]) => {
        call.filters.push([name, ...args]);
        return self;
      };
    }
    for (const name of MODIFIERS) {
      self[name] = (...args: unknown[]) => {
        call.modifiers.push([name, ...args]);
        return self;
      };
    }
    return self;
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: (fn: string, args?: unknown) => {
      const call: RecordedCall = { table: fn, op: "rpc", payload: args, filters: [], modifiers: [], terminal: "await" };
      calls.push(call);
      return Promise.resolve(responder(call));
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

/** The value of the first `.eq(column, value)` filter on a call, if any. */
export function eqValue(call: RecordedCall, column: string): unknown {
  return call.filters.find(([method, col]) => method === "eq" && col === column)?.[2];
}
