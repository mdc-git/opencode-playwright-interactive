import { Buffer } from 'node:buffer'
import type { Attachment } from './runtime-types.ts'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGES_PER_EXEC = 4
const MAX_FILENAME_LENGTH = 255
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const BASE64_PAYLOAD_PATTERN = /^[+\/0-9a-z]*={0,2}$/iv
const FORBIDDEN_FILENAME_CHARS = /[\0\/\\]/v
const DATA_URL_PATTERN = /^data:(?<mime>[^,;]+);base64,(?<data>[\s\S]+)$/iv

function assertBase64Payload(compact: string) {
  if (compact === '' || !BASE64_PAYLOAD_PATTERN.test(compact)) {
    throw new Error('node_repl kernel sent invalid base64 image data')
  }
}

function base64Padding(compact: string) {
  return compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0
}

function decodedBase64Size(value: string) {
  const compact = value.replaceAll(/\s/gv, '')
  assertBase64Payload(compact)
  return Math.max(0, Math.floor((compact.length * 3) / 4) - base64Padding(compact))
}

function isSupportedImageAttachment(
  attachment: Record<string, unknown>
): attachment is Record<string, unknown> & { mime: string; url: string } {
  return (
    attachment.type === 'file' &&
    typeof attachment.mime === 'string' &&
    SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mime) &&
    typeof attachment.url === 'string'
  )
}

function assertValidAttachmentType(attachment: Record<string, unknown>): {
  mime: string
  url: string
} {
  if (!isSupportedImageAttachment(attachment)) {
    throw new Error('node_repl kernel sent a malformed image attachment')
  }

  return { mime: attachment.mime, url: attachment.url }
}

function isValidFilename(filename: unknown): filename is string {
  return (
    typeof filename === 'string' &&
    filename !== '' &&
    filename.length <= MAX_FILENAME_LENGTH &&
    !FORBIDDEN_FILENAME_CHARS.test(filename)
  )
}

function assertValidAttachmentFilename(filename: unknown) {
  if (filename !== undefined && !isValidFilename(filename)) {
    throw new Error('node_repl kernel sent an invalid image filename')
  }
}

function assertDataUrlGroups(url: string) {
  const match = DATA_URL_PATTERN.exec(url)
  if (!match?.groups) {
    throw new Error('node_repl kernel sent an invalid image data URL')
  }

  return match.groups
}

function validImageData(url: string, mime: string) {
  const groups = assertDataUrlGroups(url)
  if (groups.mime?.toLowerCase() !== mime) {
    throw new Error('node_repl kernel sent an invalid image data URL')
  }

  return groups.data ?? ''
}

function validateAttachmentPayload(url: string, mime: string) {
  const size = decodedBase64Size(validImageData(url, mime))
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
