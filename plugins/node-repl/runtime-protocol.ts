import { Buffer } from 'node:buffer'
import type { Attachment } from './runtime-types.ts'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGES_PER_EXEC = 4
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function decodedBase64Size(value: string) {
  const compact = value.replaceAll(/\s/gv, '')
  if (compact === '' || !/^[+\/0-9a-z]*={0,2}$/iv.test(compact)) {
    throw new Error('node_repl kernel sent invalid base64 image data')
  }

  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding)
}

function assertValidAttachmentType(attachment: Record<string, unknown>): {
  mime: string
  url: string
} {
  if (
    attachment.type !== 'file' ||
    typeof attachment.mime !== 'string' ||
    !SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mime) ||
    typeof attachment.url !== 'string'
  ) {
    throw new Error('node_repl kernel sent a malformed image attachment')
  }

  return { mime: attachment.mime, url: attachment.url }
}

function assertValidAttachmentFilename(filename: unknown) {
  if (
    filename !== undefined &&
    (typeof filename !== 'string' ||
      filename === '' ||
      filename.length > 255 ||
      /[\0\/\\]/v.test(filename))
  ) {
    throw new Error('node_repl kernel sent an invalid image filename')
  }
}

function validateAttachmentPayload(url: string, mime: string) {
  const match = /^data:(?<mime>[^,;]+);base64,(?<data>[\s\S]+)$/iv.exec(url)
  if (!match || match.groups?.mime?.toLowerCase() !== mime) {
    throw new Error('node_repl kernel sent an invalid image data URL')
  }

  const size = decodedBase64Size(match.groups?.data ?? '')
  if (size === 0 || size > MAX_IMAGE_BYTES) {
    throw new Error('node_repl kernel sent an image outside the allowed size range')
  }
}

function validateAttachment(item: unknown): Attachment {
  if (item === null || typeof item !== 'object') {
    throw new Error('node_repl kernel sent a malformed image attachment')
  }

  const attachment = item as Record<string, unknown>
  const { mime, url } = assertValidAttachmentType(attachment)
  validateAttachmentPayload(url, mime)
  assertValidAttachmentFilename(attachment.filename)
  return {
    type: 'file',
    mime,
    url,
    ...(typeof attachment.filename === 'string' && { filename: attachment.filename })
  }
}

export function attachments(value: unknown): Attachment[] {
  if (value === undefined) {
    return []
  }

  if (!Array.isArray(value) || value.length > MAX_IMAGES_PER_EXEC) {
    throw new Error('node_repl kernel sent invalid image attachments')
  }

  return value.map((item) => validateAttachment(item))
}
