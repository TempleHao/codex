import { z } from "zod";

/** Public job metadata never contains reading content or credential values. */
export const readingSyncStatusSchema = z.object({
  version: z.literal(1),
  state: z.enum(["needs_setup", "ready", "failed", "preserved"]),
  updatedAt: z.iso.datetime({ offset: true }),
  failureCode: z.enum([
    "configuration_missing", "invalid_configuration", "authorization_failed",
    "network_error", "upgrade_required", "invalid_data", "limit_exceeded",
    "notebook_limit_exceeded", "note_limit_exceeded",
    "read_failed", "previous_decryption_failed",
  ]).optional(),
}).strict();

export type ReadingSyncStatus = z.infer<typeof readingSyncStatusSchema>;
