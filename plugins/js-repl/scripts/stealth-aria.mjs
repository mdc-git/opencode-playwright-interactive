const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
  'slider',
  'spinbutton',
  'scrollbar'
])

const ESCAPE_MAP = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

const parseFlagValue = (value) => (value === 'true' ? true : value === 'false' ? false : value)

function unquoteValue(value) {
  if (!value.startsWith('"') || !value.endsWith('"')) {
    return value
  }

  let out = ''
  for (let i = 1; i < value.length - 1; i++) {
    const char = value[i]
    if (char !== '\\') {
      out += char
      continue
    }

    const next = value[++i]
    if (next === '\\' || next === '"') {
      out += next
    } else if (next === 'x') {
      out += String.fromCodePoint(Number.parseInt(value.slice(i + 1, i + 3), 16))
      i += 2
    } else if (Object.hasOwn(ESCAPE_MAP, next)) {
      out += ESCAPE_MAP[next]
    } else {
      throw new TypeError('Unexpected escape in aria snapshot value: \\' + next)
    }
  }

  return out
}

function applyNodeAttr(node, name, value) {
  if (name === 'ref') {
    node.ref = value
    return
  }

  if (value === undefined) {
    node[name] = true
    return
  }

  if (name === 'level') {
    node.level = Number(value)
    return
  }

  if (['true', 'false', 'mixed'].includes(value)) {
    node[name] = parseFlagValue(value)
    return
  }

  node[name] = value
}

function parseTextNode(body, ctx) {
  const parent = ctx.stack.at(-1)
  if (!parent) {
    return
  }

  const separator = body.indexOf(':')
  if (separator <= 0) {
    return
  }

  const kind = body.slice(0, separator)
  const value = unquoteValue(body.slice(separator + 1).trim())
  if (kind === '/url') {
    parent.url = value
  } else if (kind === '/placeholder') {
    parent.placeholder = value
  } else {
    parent.text = (parent.text ? parent.text + ' ' : '') + value
  }
}

function parseElementNode(body, depth, ctx, rawLine) {
  while (ctx.stack.length > 0 && ctx.stack.at(-1).depth >= depth) {
    ctx.stack.pop()
  }

  const keyMatch = body.match(
    /^(?<role>[\w\-]+)(?:\s+(?<name>"(?:[^"\\]|\\.)*"))?(?<attrs>(?:\s+\[[^\]]*\])*)(?::(?<text>[\s\S]*))?$/v
  )
  if (!keyMatch) {
    throw new TypeError('Unrecognized aria snapshot line: ' + rawLine)
  }

  const node = {
    depth,
    role: keyMatch.groups.role,
    name: keyMatch.groups.name ? JSON.parse(keyMatch.groups.name) : ''
  }
  const attrs = keyMatch.groups.attrs || ''
  for (const attr of attrs.matchAll(/\[(?<key>[\w\-]+)(?:=(?<value>[^\]]*))?\]/gv)) {
    applyNodeAttr(node, attr.groups.key, attr.groups.value)
  }

  if (keyMatch.groups.text !== undefined) {
    node.text = unquoteValue(keyMatch.groups.text.trim())
  }

  ctx.stack.push(node)
  ctx.nodes.push(node)
}

function parseAriaNode(body, depth, ctx, rawLine) {
  if (body.startsWith('/') || body.startsWith('text:')) {
    parseTextNode(body, ctx)
    return
  }

  parseElementNode(body, depth, ctx, rawLine)
}

function parseAriaSnapshotYaml(yaml) {
  const ctx = { stack: [], nodes: [] }
  for (const rawLine of yaml.split(/\r?\n/v)) {
    const trimmed = rawLine.trim()
    if (!trimmed || !trimmed.startsWith('- ')) {
      continue
    }

    const depth = (rawLine.length - rawLine.trimStart().length) / 2
    parseAriaNode(trimmed.slice(2), depth, ctx, rawLine)
  }

  return ctx.nodes
}

function buildLocatorFromNode(parsed, currentPage) {
  if (parsed.ref) {
    return currentPage.locator('aria-ref=' + parsed.ref)
  }

  if (!parsed.name) {
    return null
  }

  const options = { name: parsed.name, exact: true }
  if (parsed.checked !== undefined) {
    options.checked = parsed.checked
  }

  if (parsed.selected !== undefined) {
    options.selected = parsed.selected
  }

  if (parsed.disabled !== undefined) {
    options.disabled = parsed.disabled
  }

  return currentPage.getByRole(parsed.role, options).first()
}

function buildInteractiveEntry(parsed, currentPage, index) {
  if (!INTERACTIVE_ROLES.has(parsed.role) && parsed.cursor !== 'pointer') {
    return null
  }

  const locator = buildLocatorFromNode(parsed, currentPage)
  if (!locator) {
    return null
  }

  return Object.freeze({
    index,
    role: parsed.role,
    name: parsed.name || parsed.text || parsed.placeholder || '',
    disabled: parsed.disabled,
    checked: parsed.checked,
    selected: parsed.selected,
    expanded: parsed.expanded,
    pressed: parsed.pressed,
    invalid: parsed.invalid,
    level: parsed.level,
    url: parsed.url || '',
    placeholder: parsed.placeholder || '',
    locator
  })
}

function matchName(entry, options) {
  if (options.name === undefined) {
    return true
  }

  if (options.name instanceof RegExp) {
    options.name.lastIndex = 0
    return options.name.test(entry.name || '')
  }

  const expected = String(options.name)
  return options.exact
    ? entry.name === expected
    : (entry.name || '').toLocaleLowerCase().includes(expected.toLocaleLowerCase())
}

function matchSemanticQuery(entry, role, options) {
  if (entry.role !== role) {
    return false
  }

  if (options.disabled !== undefined && entry.disabled !== options.disabled) {
    return false
  }

  if (options.checked !== undefined && entry.checked !== options.checked) {
    return false
  }

  if (options.selected !== undefined && entry.selected !== options.selected) {
    return false
  }

  return matchName(entry, options)
}

export { buildInteractiveEntry, matchSemanticQuery, parseAriaSnapshotYaml }
