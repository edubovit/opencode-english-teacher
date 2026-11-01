import { z } from "zod"

export const PLUGIN_ID = "opencode-english-teacher"
export const RPC_ID = "english-teacher"
export const PROTOCOL_VERSION = 1

export const ModelRefSchema = z.object({
  providerID: z.string().min(1),
  id: z.string().min(1),
  variant: z.string().min(1).optional(),
}).strict()

export const CorrectionSchema = z.object({
  original: z.string().min(1).max(300),
  replacement: z.string().max(300),
  explanation: z.string().max(180).optional(),
}).strict()

export const AnalysisSchema = z.object({
  corrections: z.array(CorrectionSchema).max(5),
}).strict()

export const CommentSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  preview: z.string().max(240),
  sourceTime: z.number().finite(),
  completedAt: z.number().finite(),
  model: ModelRefSchema,
  corrections: z.array(CorrectionSchema).min(1).max(5),
}).strict()

export const StatusSchema = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  sessionID: z.string().min(1),
  enabled: z.boolean(),
  eligible: z.boolean(),
  overridden: z.boolean(),
  pending: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  error: z.string().nullable(),
}).strict()

export const ViewSchema = z.object({
  status: StatusSchema,
  comment: CommentSchema.nullable(),
  position: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict()

export const ListSchema = z.object({
  items: z.array(CommentSchema),
  next: z.string().nullable(),
  total: z.number().int().nonnegative(),
}).strict()

export type ModelRef = z.infer<typeof ModelRefSchema>
export type Correction = z.infer<typeof CorrectionSchema>
export type Comment = z.infer<typeof CommentSchema>
export type Status = z.infer<typeof StatusSchema>
export type View = z.infer<typeof ViewSchema>
export type CommentList = z.infer<typeof ListSchema>
