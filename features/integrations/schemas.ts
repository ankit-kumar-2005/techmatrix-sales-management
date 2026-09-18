import { z } from "zod";
import { ASSIGNMENT_MODES } from "@/types/integration";

/** A uuid or "" (the TeamSelect/SelectField empty option), normalised
 *  to a real null. Same treatment manager_id gets in the invitation
 *  schema — an empty string from a <select> is not a value. */
const optionalUuid = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .nullable()
  .refine((value) => value === null || z.string().uuid().safeParse(value).success, {
    message: "Select a valid option.",
  });

export const updateIntegrationSettingsSchema = z.object({
  integration_id: z.string().uuid({ message: "Unknown integration." }),
  default_stage_id: optionalUuid,
  assignment_mode: z.enum(ASSIGNMENT_MODES, { message: "Choose how new leads are assigned." }),
  default_owner_id: optionalUuid,
  /**
   * The round-robin roster. Read with formData.getAll(), so it arrives
   * as an array of uuids — or as an empty array when the admin has
   * removed everyone, which is a legitimate state (the webhook then
   * leaves leads unassigned rather than failing).
   *
   * Deduped here because a malformed submit could repeat an id, and the
   * unique(integration_id, customer_user_id) constraint would otherwise
   * turn that into a failed save rather than a no-op.
   */
  participants: z
    .array(z.string().uuid())
    .max(200, { message: "That is more participants than a rotation can usefully hold." })
    .transform((ids) => [...new Set(ids)]),
});

export const integrationIdSchema = z.object({
  integration_id: z.string().uuid({ message: "Unknown integration." }),
});

export const setIntegrationStatusSchema = integrationIdSchema.extend({
  status: z.enum(["Active", "Inactive"]),
});
