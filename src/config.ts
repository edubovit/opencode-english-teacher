import { z } from "zod"
import type { ModelRef } from "./contracts.ts"

const OptionsSchema = z.object({
  enabledByDefault: z.boolean().default(true),
  model: z.string().regex(/^[^/\s#]+\/[^\s#]+$/).optional(),
  variant: z.string().regex(/^\S+$/).optional(),
}).strict()

export interface Options {
  enabledByDefault: boolean
  model?: ModelRef
  variant?: string
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

export function parseOptions(raw: unknown): Options {
  const result = OptionsSchema.safeParse(raw === undefined ? {} : raw)
  if (!result.success) {
    throw new ConfigError("Invalid English teacher options. Use enabledByDefault (boolean), model (provider/model), and variant (name).")
  }
  const { enabledByDefault, model, variant } = result.data
  const separator = model?.indexOf("/") ?? -1
  return {
    enabledByDefault,
    ...(model ? { model: { providerID: model.slice(0, separator), id: model.slice(separator + 1) } } : {}),
    ...(variant ? { variant } : {}),
  }
}

export function selectModel(options: Options, sessionModel?: ModelRef): ModelRef {
  const model = options.model ?? sessionModel
  if (!model) throw new ConfigError("The session has no available model for English analysis.")
  return {
    providerID: model.providerID,
    id: model.id,
    ...((options.variant ?? model.variant) ? { variant: options.variant ?? model.variant } : {}),
  }
}
