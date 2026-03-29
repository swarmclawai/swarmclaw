import { z } from 'zod'
import type { ProtocolStepDefinition } from '@/types'
import { validateStepDag, validateStepRefs } from '@/lib/server/protocols/step-dag-validation'
import { ProtocolTemplateUpsertBaseSchema } from './schemas'

/** Full protocol template upsert schema with server-side DAG validation.
 *  For client-side use (without server deps), use ProtocolTemplateUpsertBaseSchema from './schemas'. */
export const ProtocolTemplateUpsertSchema = ProtocolTemplateUpsertBaseSchema.superRefine((value, ctx) => {
  if (value.defaultPhases.length === 0 && value.steps.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['steps'],
      message: 'Provide at least one phase or one step.',
    })
  }
  if (value.steps.length > 0) {
    const steps = value.steps as ProtocolStepDefinition[]
    const dagResult = validateStepDag(steps)
    if (!dagResult.valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps'],
        message: `Cycle detected in step dependencies: ${dagResult.cycle?.join(' → ')}`,
      })
    }
    const invalidRefs = validateStepRefs(steps)
    for (const ref of invalidRefs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps'],
        message: `Step references unknown step ID: "${ref}"`,
      })
    }
  }
})
