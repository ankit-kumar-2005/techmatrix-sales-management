import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LEAD_SOURCES } from "@/features/leads/schemas";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_DUE_DATE_OFFSET_DAYS,
  MAX_ROUND_ROBIN_POOL,
  MAX_SUBJECT_LENGTH,
} from "../config/safeguards";
import { MAX_DECISION_OUTCOMES } from "../config/safeguards";
import { getFieldDefinition } from "./fields";
import {
  ACTION_TASK_CREATE,
  ASSIGNMENT_SET_VARIABLE,
  CONDITION_LEAD_SOURCE_IS,
  DECISION_DEFAULT_BRANCH,
  DECISION_MULTI_OUTCOME,
  REGISTRY_ENTRIES,
  SUBJECT_TOKENS,
  TRIGGER_LEAD_CREATED,
  getAllRegistryKeys,
  getEntriesByKind,
  getRegistryEntry,
} from "./definitions";

/**
 * REGISTRY INVARIANTS.
 *
 * The registry is what makes the AI path safe and what makes the palette
 * honest, so the properties it is relied on for are asserted here rather
 * than assumed. Several of these would fail loudly in the product if
 * broken, but two of them — a default config that does not satisfy its
 * own schema, and a field that names an option list its schema rejects —
 * would fail quietly, as a node that cannot be saved the moment it is
 * dragged onto the canvas.
 */

describe("registry shape", () => {
  it("has at least one trigger, one condition, one decision, one assignment and one action", () => {
    assert.ok(getEntriesByKind("trigger").length >= 1);
    assert.ok(getEntriesByKind("condition").length >= 1);
    assert.ok(getEntriesByKind("decision").length >= 1);
    assert.ok(getEntriesByKind("assignment").length >= 1);
    assert.ok(getEntriesByKind("action").length >= 1);
  });

  it("has no duplicate keys", () => {
    const keys = getAllRegistryKeys();
    assert.equal(new Set(keys).size, keys.length);
  });

  it("returns undefined for anything not registered", () => {
    // The whole rejection mechanism for an AI-proposed step that does
    // not exist. There is no separate blocklist to keep in sync — the
    // absence of an entry IS the refusal.
    for (const key of ["", "task.delete", "sql.execute", "lead.delete", "__proto__", "constructor"]) {
      assert.equal(getRegistryEntry(key), undefined, `${key} must not resolve`);
    }
  });

  it("gives every entry the metadata its eight consumers read", () => {
    for (const entry of REGISTRY_ENTRIES) {
      assert.ok(entry.label.trim().length > 0, `${entry.key} needs a label`);
      assert.ok(entry.description.trim().length > 0, `${entry.key} needs a description`);
      assert.ok(entry.example.trim().length > 0, `${entry.key} needs an example`);
      assert.ok(entry.limitations.length > 0, `${entry.key} must state what it cannot do`);
      assert.ok(entry.configSchema, `${entry.key} needs a config schema`);
    }
  });
});

describe("every default config is either valid or only missing a required choice", () => {
  /**
   * THE REAL INVARIANT, and it is not "every default parses".
   *
   * Some capabilities genuinely cannot ship a complete default, because
   * the registry has no way to know anything about a given tenant:
   * task.create cannot guess who a task should go to, and lead.source.is
   * cannot guess which sources an admin cares about. Their defaults are
   * deliberately incomplete, and the builder surfaces that as "pick who
   * this should be assigned to" / "pick at least one source" — which is
   * the correct first thing to ask.
   *
   * What must never happen is a default that is invalid for a reason the
   * admin cannot see and fix. So the assertion is: if a default does not
   * parse, every complaint must be about a field that this entry marks
   * `required: true` and therefore renders with a visible error. A
   * default that failed on a field the admin has no control over — or on
   * no field at all — would be a node that is broken the instant it is
   * dragged onto the canvas, with nothing to click.
   *
   * This is the assertion that caught lead.source.is shipping
   * `sources: []` against a schema requiring at least one. That turned
   * out to be legitimate and visible; the point is that it was noticed.
   */
  const requiredFieldNames = (entry: (typeof REGISTRY_ENTRIES)[number]) =>
    new Set(entry.fields.filter((field) => field.required).map((field) => field.name));

  for (const entry of REGISTRY_ENTRIES) {
    it(`${entry.key}`, () => {
      const parsed = entry.configSchema.safeParse(entry.defaultConfig);
      if (parsed.success) return;

      const required = requiredFieldNames(entry);
      assert.ok(parsed.error.issues.length > 0);

      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "");
        assert.ok(
          field !== "" && required.has(field),
          `${entry.key}'s default fails on "${field || "(the object itself)"}", which is not a required field the ` +
            "builder would show an error against — so this node would be unfixably invalid on the canvas",
        );
      }
    });
  }

  it("keeps task.create's incomplete default down to the assignee alone", () => {
    // Named explicitly because this one is load-bearing: the assignee is
    // the single thing an admin must supply, and if the default started
    // failing on anything else as well, the first-run experience would
    // silently get worse.
    const parsed = getRegistryEntry(ACTION_TASK_CREATE)!.configSchema.safeParse(
      getRegistryEntry(ACTION_TASK_CREATE)!.defaultConfig,
    );
    assert.equal(parsed.success, false);
    assert.ok(
      !parsed.success && parsed.error.issues.every((issue) => issue.path[0] === "assigneeId"),
      "only the assignee should be missing from task.create's default",
    );
  });
});

describe("field descriptors agree with their schemas", () => {
  it("every select field offers options its schema accepts", () => {
    for (const entry of REGISTRY_ENTRIES) {
      for (const field of entry.fields) {
        if (field.kind !== "select") continue;
        assert.ok(field.options && field.options.length > 0, `${entry.key}.${field.name} needs options`);

        for (const option of field.options) {
          const candidate = { ...entry.defaultConfig, [field.name]: option.value };
          const parsed = entry.configSchema.safeParse(candidate);
          // The option must not be rejected FOR THIS FIELD. Other fields
          // may still be incomplete (see task.create's assignee above),
          // so only this field's own path is examined.
          const rejectedHere =
            !parsed.success && parsed.error.issues.some((issue) => issue.path[0] === field.name);
          assert.ok(!rejectedHere, `${entry.key}.${field.name} offers "${option.value}" but its schema rejects it`);
        }
      }
    }
  });

  it("numeric field bounds come from the safeguards config", () => {
    const task = getRegistryEntry(ACTION_TASK_CREATE);
    assert.ok(task);
    const dueInDays = task.fields.find((field) => field.name === "dueInDays");
    assert.ok(dueInDays);
    assert.equal(dueInDays.max, MAX_DUE_DATE_OFFSET_DAYS);
    assert.equal(dueInDays.min, 0);

    const subject = task.fields.find((field) => field.name === "subject");
    assert.equal(subject?.maxLength, MAX_SUBJECT_LENGTH);

    const description = task.fields.find((field) => field.name === "description");
    assert.equal(description?.maxLength, MAX_DESCRIPTION_LENGTH);
  });

  it("every visibleWhen names a field that exists on the same entry", () => {
    for (const entry of REGISTRY_ENTRIES) {
      for (const field of entry.fields) {
        if (!field.visibleWhen) continue;
        assert.ok(
          entry.fields.some((other) => other.name === field.visibleWhen!.field),
          `${entry.key}.${field.name} depends on "${field.visibleWhen.field}", which is not a field here`,
        );
      }
    }
  });
});

describe("task.create enforces the safeguard bounds", () => {
  const base = {
    subject: "Call someone",
    description: null,
    type: "Call",
    priority: "Medium",
    dueInDays: 1,
    assignmentMode: "Fixed",
    assigneeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    rotation: [],
  };

  const schema = getRegistryEntry(ACTION_TASK_CREATE)!.configSchema;

  it("accepts a valid config", () => {
    assert.equal(schema.safeParse(base).success, true);
  });

  it("rejects a subject longer than the limit", () => {
    assert.equal(schema.safeParse({ ...base, subject: "x".repeat(MAX_SUBJECT_LENGTH + 1) }).success, false);
  });

  it("rejects a due-date offset past the limit", () => {
    assert.equal(schema.safeParse({ ...base, dueInDays: MAX_DUE_DATE_OFFSET_DAYS + 1 }).success, false);
  });

  it("rejects a rotation larger than the limit", () => {
    const rotation = Array.from(
      { length: MAX_ROUND_ROBIN_POOL + 1 },
      (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    );
    assert.equal(
      schema.safeParse({ ...base, assignmentMode: "RoundRobin", assigneeId: null, rotation }).success,
      false,
    );
  });

  it("rejects an assignee that is not a uuid", () => {
    // Nothing downstream trusts this value either — the SQL function
    // re-checks tenant and Active status — but a non-uuid is caught here
    // so it never reaches a query at all.
    assert.equal(schema.safeParse({ ...base, assigneeId: "'; drop table tasks; --" }).success, false);
  });

  it("rejects a task type outside the tasks table's own CHECK constraint", () => {
    assert.equal(schema.safeParse({ ...base, type: "Telepathy" }).success, false);
  });

  it("rejects a priority outside the tasks table's own CHECK constraint", () => {
    assert.equal(schema.safeParse({ ...base, priority: "Urgent" }).success, false);
  });

  it("rejects an unknown assignment mode", () => {
    assert.equal(schema.safeParse({ ...base, assignmentMode: "Random" }).success, false);
  });
});

describe("lead.created — entry condition ('Only run when…')", () => {
  const schema = getRegistryEntry(TRIGGER_LEAD_CREATED)!.configSchema;
  const base = { eventType: "created", updateMode: "every_time" };
  const flatCondition = {
    kind: "group",
    match: "all",
    rules: [{ kind: "rule", field: "deal_value", operator: "greater_than", value: 100, valueTo: null }],
  };

  it("accepts entryCondition: null (off)", () => {
    assert.equal(schema.safeParse({ ...base, entryCondition: null }).success, true);
  });

  it("defaults entryCondition to null when absent — an old saved trigger", () => {
    const parsed = schema.safeParse(base);
    assert.equal(parsed.success, true);
    assert.equal(parsed.success && (parsed.data as { entryCondition: unknown }).entryCondition, null);
  });

  it("accepts a valid flat condition", () => {
    assert.equal(schema.safeParse({ ...base, entryCondition: flatCondition }).success, true);
  });

  it("rejects a nested group inside entryCondition — entry conditions are flat only", () => {
    const nested = { kind: "group", match: "any", rules: [flatCondition, { kind: "rule", field: "source", operator: "equals", value: "IndiaMART", valueTo: null }] };
    const nestedInside = { kind: "group", match: "all", rules: [nested] };
    assert.equal(schema.safeParse({ ...base, entryCondition: nestedInside }).success, false);
  });

  it("rejects a malformed entryCondition the same way lead.match would", () => {
    const empty = { kind: "group", match: "all", rules: [] };
    assert.equal(schema.safeParse({ ...base, entryCondition: empty }).success, false);
  });
});

describe("lead.decision — named, ordered outcomes", () => {
  const schema = getRegistryEntry(DECISION_MULTI_OUTCOME)!.configSchema;
  const rule = { kind: "rule", field: "deal_value", operator: "greater_than", value: 100, valueTo: null };
  const outcome = (id: string, name: string) => ({ id, name, root: { kind: "group", match: "all", rules: [rule] } });

  it("accepts a valid, single-outcome config", () => {
    assert.equal(schema.safeParse({ outcomes: [outcome("a", "A")] }).success, true);
  });

  it("rejects an empty outcome list", () => {
    assert.equal(schema.safeParse({ outcomes: [] }).success, false);
  });

  it("rejects more than the configured maximum of outcomes", () => {
    const outcomes = Array.from({ length: MAX_DECISION_OUTCOMES + 1 }, (_, i) => outcome(`o${i}`, `O${i}`));
    assert.equal(schema.safeParse({ outcomes }).success, false);
  });

  it("rejects two outcomes sharing the same id", () => {
    assert.equal(schema.safeParse({ outcomes: [outcome("dup", "One"), outcome("dup", "Two")] }).success, false);
  });

  it("rejects two outcomes sharing the same name", () => {
    assert.equal(schema.safeParse({ outcomes: [outcome("a", "Same"), outcome("b", "Same")] }).success, false);
  });

  it('rejects "default" as an outcome id — it is reserved for the Otherwise path', () => {
    assert.equal(schema.safeParse({ outcomes: [outcome(DECISION_DEFAULT_BRANCH, "Whatever")] }).success, false);
  });

  it("rejects an outcome whose condition group is malformed, same rules as a plain condition", () => {
    const broken = outcome("a", "A");
    broken.root.rules = [];
    assert.equal(schema.safeParse({ outcomes: [broken] }).success, false);
  });
});

describe("workflow.assign — temporary variables", () => {
  const schema = getRegistryEntry(ASSIGNMENT_SET_VARIABLE)!.configSchema;
  const base = { variable: "note", operator: "set", valueSource: "static", staticValue: "x", fieldKey: "" };

  it("accepts a valid static assignment", () => {
    assert.equal(schema.safeParse({ assignments: [base] }).success, true);
  });

  it("accepts a valid field-sourced assignment", () => {
    assert.equal(
      schema.safeParse({ assignments: [{ ...base, valueSource: "field", fieldKey: "company", staticValue: "" }] }).success,
      true,
    );
  });

  it("rejects a variable name that is not a valid identifier", () => {
    for (const bad of ["1note", "note name", "note-name", "note.name", ""]) {
      assert.equal(schema.safeParse({ assignments: [{ ...base, variable: bad }] }).success, false, bad);
    }
  });

  it("rejects a static source with no value typed in", () => {
    assert.equal(schema.safeParse({ assignments: [{ ...base, staticValue: "" }] }).success, false);
  });

  it("rejects a field source naming a field that is not in the field registry", () => {
    assert.equal(
      schema.safeParse({ assignments: [{ ...base, valueSource: "field", fieldKey: "not_a_real_field" }] }).success,
      false,
    );
  });

  it("rejects an empty assignment list", () => {
    assert.equal(schema.safeParse({ assignments: [] }).success, false);
  });
});

describe("the source field/picker — one canonical list, no fake values", () => {
  it("the condition builder's Source field reads exactly LEAD_SOURCES, nothing hardcoded separately", () => {
    const field = getFieldDefinition("source");
    assert.ok(field?.enumOptions);
    assert.deepEqual(
      field.enumOptions.map((option) => option.value),
      LEAD_SOURCES,
    );
  });

  it('the Source field never offers a fake "Manual" (or any other) placeholder value', () => {
    const field = getFieldDefinition("source");
    assert.ok(!field?.enumOptions?.some((option) => option.value === "Manual"));
    assert.ok(!LEAD_SOURCES.includes("Manual"));
  });

  it('"is empty" and "is not empty" are still valid on the Source field, for matching a hand-entered lead', () => {
    const field = getFieldDefinition("source");
    assert.ok(field);
    // enum operators are fixed in OPERATORS_BY_TYPE, not per-field — this
    // just confirms the source field is still typed "enum" and therefore
    // still gets them, since that typing is what this whole fix leans on.
    assert.equal(field.type, "enum");
  });

  it("lead.source.is (the older fixed condition) offers the same unified list too", () => {
    const entry = getRegistryEntry(CONDITION_LEAD_SOURCE_IS);
    const sourcesField = entry?.fields.find((field) => field.name === "sources");
    assert.equal(sourcesField?.kind, "source-multi");
    // source-multi has no options list of its own on the descriptor — it
    // is rendered directly from LEAD_SOURCES in node-config-panel.tsx —
    // so the real assertion is just that this field still exists and is
    // still the shared kind, not a second copy of the list.
  });

  it("LEAD_SOURCES includes every connected integration and has no duplicates", () => {
    assert.ok(LEAD_SOURCES.includes("IndiaMART"));
    assert.equal(new Set(LEAD_SOURCES).size, LEAD_SOURCES.length);
  });
});

describe("subject tokens", () => {
  it("are all in the {{lead.*}} shape the renderer looks for", () => {
    for (const token of SUBJECT_TOKENS) {
      assert.match(token.token, /^\{\{lead\.[a-z_]+\}\}$/);
      assert.ok(token.description.trim().length > 0);
    }
  });

  it("are unique", () => {
    const tokens = SUBJECT_TOKENS.map((entry) => entry.token);
    assert.equal(new Set(tokens).size, tokens.length);
  });
});
