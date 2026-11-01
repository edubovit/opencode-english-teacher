import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { ListSchema, RPC_ID, StatusSchema, ViewSchema } from "./contracts.ts"

const sessionID = z.string().min(1).max(200)
const errors = { unavailable: z.null() }

export const EnglishTeacher = Rpc.define({
  id: RPC_ID,
  methods: {
    status: {
      input: z.object({ sessionID }).strict(),
      output: StatusSchema,
      errors,
    },
    view: {
      input: z.object({
        sessionID,
        id: z.string().min(1).max(200).optional(),
        direction: z.enum(["older", "newer"]).optional(),
      }).strict(),
      output: ViewSchema,
      errors,
    },
    list: {
      input: z.object({
        sessionID,
        cursor: z.string().max(1000).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }).strict(),
      output: ListSchema,
      errors,
    },
    setEnabled: {
      input: z.object({ sessionID, enabled: z.boolean() }).strict(),
      output: StatusSchema,
      errors,
    },
  },
  events: {
    changed: { schema: z.object({ sessionID }).strict() },
    corrected: {
      schema: z.object({ sessionID, commentID: z.string().min(1), sessionTitle: z.string() }).strict(),
    },
  },
})
