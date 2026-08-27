import type { Tool } from '@opencode-ai/schema/tool'
import type { Attachment, ExecuteOutcome, JobSnapshot } from './runtime-types.ts'

type ToolAttachment = Pick<Attachment, 'url' | 'mime' | 'filename'>

function buildResult(result: {
  output: string
  attachments: readonly ToolAttachment[]
}): Tool.Result {
  const text =
    result.output === '' ? 'JavaScript executed successfully (no console output).' : result.output
  const files: Tool.FileContent[] = result.attachments.map((attachment) => {
    const hasFilename = attachment.filename !== undefined && attachment.filename !== ''
    return {
      type: 'file' as const,
      uri: attachment.url,
      mime: attachment.mime,
      ...(hasFilename && { name: attachment.filename })
    }
  })
  const content: string | Tool.Content[] =
    files.length > 0 ? [{ type: 'text', text }, ...files] : text
  return {
    output: text,
    content
  }
}

function formatJob(job: JobSnapshot) {
  const lines = [`Job: ${job.id}`, `State: ${job.state}`, `Started: ${job.startedAt}`]
  if (job.finishedAt !== undefined) {
    lines.push(`Finished: ${job.finishedAt}`)
  }

  if (job.output !== undefined) {
    lines.push(`Output:\n${job.output === '' ? '(no output)' : job.output}`)
  }

  if (job.error !== undefined) {
    lines.push(`Error: ${job.error}`)
  }

  return lines.join('\n')
}

function buildJobResult(job: JobSnapshot): Tool.Result {
  const activeGuidance = ['running', 'cancelling'].includes(job.state)
    ? '\n\nThe job is still ' +
      `${job.state}. Call node_repl_job with wait again when no other work is available, or status for an immediate snapshot. Do not submit another REPL cell.`
    : ''
  return buildResult({
    output: formatJob(job) + activeGuidance,
    attachments: job.attachments ?? []
  })
}

function formatJobList(jobs: JobSnapshot[]) {
  return jobs.length === 0
    ? 'No Node.js REPL jobs.'
    : jobs.map((job) => formatJob(job)).join('\n\n')
}

const metadataKey = <const K extends string>(key: K): K => key

export function formatJobActionResult(job: JobSnapshot): Tool.Result {
  return {
    ...buildJobResult(job),
    metadata: { [metadataKey('job_id')]: job.id, state: job.state }
  }
}

export function formatJobListResult(jobs: JobSnapshot[]): Tool.Result {
  const output = formatJobList(jobs)
  return { output, content: output }
}

export function formatExecutionOutcome(outcome: ExecuteOutcome): Tool.Result {
  if (outcome.kind === 'completed') {
    return buildResult(outcome.result)
  }

  if (outcome.kind === 'background') {
    const output =
      `JavaScript is still running. Call node_repl_job with wait when no other work is available, or status for an immediate snapshot. Do not submit another REPL cell while this job is active.\n\n` +
      formatJob(outcome.job)
    return {
      output,
      content: output,
      metadata: { [metadataKey('job_id')]: outcome.job.id, state: outcome.job.state }
    }
  }

  const output = `JavaScript kernel is busy running ${outcome.job.id}.\n\nState: ${outcome.job.state}\nInspect, wait for, or cancel that job before submitting another cell.`
  return {
    output,
    content: output,
    metadata: { [metadataKey('job_id')]: outcome.job.id, state: outcome.job.state }
  }
}
