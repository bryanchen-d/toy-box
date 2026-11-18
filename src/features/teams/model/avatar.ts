import { z } from "zod";

export const avatarSchema = z
  .object({
    mark: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .regex(/^[MmZzLlHhVvCcSsQqTtAaEe0-9.,+\-\s]+$/, "Use SVG path data only.")
      .describe(
        "SVG path data for a distinctive outline mark in a 24 by 24 viewBox. Multiple subpaths are allowed. Keep the mark recognizable at 20 pixels.",
      ),
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .describe("A six-digit hex background color chosen to express this identity."),
  })
  .strict();

export type Avatar = z.output<typeof avatarSchema>;
