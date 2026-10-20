/**
 * Minimal, dependency-free tool definition compiler.
 *
 * The Host's tools registry accepts a structural ToolDefinition: a parameter
 * JSON Schema, an output schema plus renderer, an execute body, and optional
 * timeout/concurrency flags. This module compiles the author-facing DSL used
 * by this plugin into that shape and validates arguments before dispatch.
 *
 * It exists so an installed plugin never has to resolve `@deepseek-ai/dsh-tools`
 * from its own real path: the Host provides the registry, the plugin provides
 * only data.
 *
 * @module dsh-plugin-browser/tool
 */

/** Argument-validation failure rendered as a normal tool error. */
export class ToolArgsError extends Error {
  /** @param {string[]} violations - human-readable validation failures. */
  constructor(violations) {
    super(`Invalid arguments:\n- ${violations.join('\n- ')}`)
    this.name = 'ToolArgsError'
    this.violations = violations
  }
}

/** Copy supported annotations onto a JSON Schema node. */
function annotations(spec) {
  const node = {}
  if (spec.description !== undefined) node.description = spec.description
  if (spec.title !== undefined) node.title = spec.title
  if (spec.default !== undefined) node.default = spec.default
  if (spec.examples !== undefined) node.examples = spec.examples
  return node
}

/**
 * Compile one author-facing value schema to the Host's supported JSON Schema
 * subset. Property-level `required` is lifted into the parent object.
 */
export function valueSchemaSpecToJsonSchema(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('schema spec must be an object')

  if (spec.oneOf) {
    return {
      ...annotations(spec),
      oneOf: spec.oneOf.map((branch) => valueSchemaSpecToJsonSchema(branch)),
    }
  }

  if (spec.type === 'json') return annotations(spec)

  if (spec.type === 'object') {
    const properties = {}
    const required = []
    for (const [key, property] of Object.entries(spec.properties ?? {})) {
      properties[key] = valueSchemaSpecToJsonSchema(property)
      if (property.required === true) required.push(key)
    }
    return {
      ...annotations(spec),
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: spec.additionalProperties === true,
    }
  }

  if (spec.type === 'array') {
    return {
      ...annotations(spec),
      type: 'array',
      ...(spec.items ? { items: valueSchemaSpecToJsonSchema(spec.items) } : {}),
    }
  }

  const node = { ...annotations(spec), type: spec.type }
  if (spec.enum !== undefined) node.enum = [...spec.enum]
  if (spec.const !== undefined) node.const = spec.const
  return node
}

/**
 * Compile the implicit parameter root. It is an open object so an extra
 * argument never becomes a validation failure at the root.
 */
export function parameterSchemaSpecToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, property] of Object.entries(spec ?? {})) {
    properties[key] = valueSchemaSpecToJsonSchema(property)
    if (property.required === true) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: true,
  }
}

/** Whether a value matches one JSON Schema primitive type. */
function matchesType(type, value) {
  if (type === undefined) return true
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    default:
      return true
  }
}

/** Validate one value against a compiled schema, collecting violations. */
function validateValue(schema, value, path, violations) {
  if (!schema || typeof schema !== 'object') return
  if (!matchesType(schema.type, value)) {
    violations.push(`${path} must be a ${schema.type}`)
    return
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    violations.push(`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`)
  }
  if (schema.const !== undefined && value !== schema.const) {
    violations.push(`${path} must be ${JSON.stringify(schema.const)}`)
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => {
      const local = []
      validateValue(branch, value, path, local)
      return local.length === 0
    })
    if (matches.length === 0) violations.push(`${path} does not match any allowed shape`)
    return
  }
  if (schema.type === 'array' && schema.items) {
    value.forEach((item, index) => validateValue(schema.items, item, `${path}[${index}]`, violations))
  }
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      if (value[required] === undefined) violations.push(`${path}.${required} is required`)
    }
    const properties = schema.properties ?? {}
    for (const [key, property] of Object.entries(properties)) {
      if (value[key] !== undefined) validateValue(property, value[key], `${path}.${key}`, violations)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) violations.push(`${path}.${key} is not allowed`)
      }
    }
  }
}

/** Validate arguments against compiled parameters. */
export function validateArgs(parameters, args) {
  const violations = []
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return ['arguments must be an object']
  }
  validateValue(parameters, args, 'arguments', violations)
  return violations
}

/**
 * Build a registry-ready tool definition from the plugin's author-facing DSL.
 *
 * @param {object} options - name, description, parameter DSL, output, execute.
 * @returns {object} structural ToolDefinition accepted by the Host registry.
 */
export function defineTool(options) {
  if (!options || typeof options !== 'object') throw new TypeError('defineTool requires options')
  if (typeof options.name !== 'string' || !options.name) throw new TypeError('defineTool requires a name')
  if (typeof options.execute !== 'function') throw new TypeError(`tool "${options.name}" requires execute`)
  if (!options.output || typeof options.output.render !== 'function') {
    throw new TypeError(`tool "${options.name}" requires output.render`)
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new TypeError(`tool "${options.name}" timeoutMs must be a positive finite number`)
  }

  const parameters = parameterSchemaSpecToJsonSchema(options.parameters)
  const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema)
  if (outputSchema.type !== 'object' && outputSchema.type !== undefined && outputSchema.oneOf === undefined) {
    // The Host accepts every JSON root, but this plugin's renderers all return
    // an object. Keep the declaration honest.
    throw new TypeError(`tool "${options.name}" output schema must be an object root`)
  }

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: options.output.render,
      ...(options.output.presentationMeta ? { presentationMeta: options.output.presentationMeta } : {}),
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.isConcurrencySafe ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
    async execute(args, exec) {
      const violations = validateArgs(parameters, args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return await options.execute(args, exec)
    },
  }
}
