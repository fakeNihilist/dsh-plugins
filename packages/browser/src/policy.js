/**
 * URL, network, and artifact-path policy for the browser plugin.
 *
 * The model may navigate anywhere the user can reach, but this module keeps the
 * plugin from becoming a confused deputy: only HTTP(S) (and optionally file:)
 * targets are navigable, cloud metadata endpoints are always refused, and
 * artifact paths stay inside the session workspace unless an absolute output
 * directory was configured on purpose.
 *
 * @module dsh-plugin-browser/policy
 */

import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'
import { isAbsolute, relative, resolve } from 'node:path'

/** Error carrying a stable machine-readable code for tool failures. */
export class BrowserPolicyError extends Error {
  /**
   * @param {string} code - stable failure code.
   * @param {string} message - model-facing explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'BrowserPolicyError'
    this.code = code
  }
}

/** Hosts that only resolve to a loopback address. */
const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost'])

/** Cloud metadata endpoints are refused under every private-network policy. */
const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata.azure.internal',
])

/** Exact metadata addresses (IPv4 and IPv6). */
const METADATA_ADDRESSES = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  'fd00:ec2::254',
])

/** Windows device names that cannot be used as a file basename. */
const RESERVED_FILENAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/** Strip a trailing dot and surrounding brackets from a hostname. */
function normalizeHostname(hostname) {
  let host = String(hostname).trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

/** Whether a hostname is a literal loopback name rather than an IP. */
function isLoopbackName(hostname) {
  const host = normalizeHostname(hostname)
  return LOOPBACK_NAMES.has(host) || host.endsWith('.localhost')
}

/** Parse one IPv4 dotted quad into four octets, or null. */
function parseIPv4(address) {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
  return octets
}

/** Classify one IP address into the policy vocabulary. */
function classifyAddress(address) {
  const host = normalizeHostname(address)
  if (METADATA_ADDRESSES.has(host)) return 'metadata'

  const version = isIP(host)
  if (version === 6) {
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return 'loopback'
    if (host === '::' || host === '0:0:0:0:0:0:0:0') return 'blocked'
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host)
    if (mapped) return classifyAddress(mapped[1])
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return 'private'
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return 'link-local'
    if (/^ff[0-9a-f]{2}:/i.test(host)) return 'blocked'
    return 'public'
  }

  if (version === 4) {
    const octets = parseIPv4(host)
    if (!octets) return 'blocked'
    const [a, b] = octets
    if (a === 127) return 'loopback'
    if (a === 0) return 'blocked'
    if (a === 10) return 'private'
    if (a === 172 && b >= 16 && b <= 31) return 'private'
    if (a === 192 && b === 168) return 'private'
    if (a === 169 && b === 254) return 'link-local'
    if (a === 100 && b >= 64 && b <= 127) return 'private'
    if (a >= 224) return 'blocked'
    return 'public'
  }

  return 'public'
}

/** Classify a hostname that may be an IP, a loopback name, or a DNS name. */
export function classifyHost(hostname) {
  const host = normalizeHostname(hostname)
  if (!host) return 'blocked'
  if (isLoopbackName(host)) return 'loopback'
  if (METADATA_HOSTS.has(host) || host.endsWith('.internal')) return 'metadata'
  if (host.endsWith('.local')) return 'private'
  if (isIP(host)) return classifyAddress(host)
  return 'public'
}

/**
 * Whether a classified destination is allowed by the configured policy.
 *
 * `all` still refuses metadata; `loopback` allows only loopback; `none`
 * refuses every non-public destination.
 */
function allowsClass(classification, allowPrivateNetwork) {
  if (classification === 'metadata' || classification === 'blocked') return false
  if (classification === 'public') return true
  if (allowPrivateNetwork === 'all') return true
  if (allowPrivateNetwork === 'loopback') return classification === 'loopback'
  return false
}

/** Resolve a DNS name to every address, with a bounded wait. */
async function resolveAddresses(hostname) {
  let timer
  try {
    const lookup = dns.lookup(hostname, { all: true, verbatim: true })
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('dns lookup timeout')), 3000)
    })
    const results = await Promise.race([lookup, timeout])
    return results.map((entry) => entry.address)
  } catch {
    // A name that does not resolve cannot be reached; navigation will report
    // the concrete error. Do not turn DNS failure into a policy denial.
    return []
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Normalize user/model input into an absolute navigable URL.
 *
 * A bare host is upgraded to HTTPS, except loopback names which default to
 * HTTP because local dev servers rarely serve TLS.
 *
 * @param {string} input - URL or bare host.
 * @param {{ allowFileUrls?: boolean }} [options]
 * @returns {string} normalized absolute URL.
 */
export function normalizeBrowserUrl(input, options = {}) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new BrowserPolicyError('invalid_url', 'A URL is required')

  if (/^about:/i.test(raw)) {
    if (raw.toLowerCase() === 'about:blank') return 'about:blank'
    throw new BrowserPolicyError('invalid_url', 'Only about:blank is navigable')
  }

  if (/^(javascript|data|blob|chrome|devtools|view-source|chrome-extension):/i.test(raw)) {
    throw new BrowserPolicyError('invalid_url', 'That protocol is not allowed')
  }
  if (/^file:/i.test(raw)) {
    if (!options.allowFileUrls) throw new BrowserPolicyError('invalid_url', 'file: URLs are disabled')
    return new URL(raw).href
  }

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)
  const scheme = schemeMatch?.[1]?.toLowerCase()
  if (scheme && !['http', 'https'].includes(scheme)) {
    throw new BrowserPolicyError('invalid_url', `Protocol ${scheme}: is not allowed`)
  }

  let candidate = raw
  if (!scheme) {
    if (raw.startsWith('//')) {
      candidate = `https:${raw}`
    } else {
      const hostPart = raw.split('/')[0]
      const hostname = hostPart.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
      const protocol = isLoopbackName(hostname) || classifyHost(hostname) === 'loopback' ? 'http' : 'https'
      candidate = `${protocol}://${raw}`
    }
  }

  let url
  try {
    url = new URL(candidate)
  } catch {
    throw new BrowserPolicyError('invalid_url', `Cannot parse URL: ${input}`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new BrowserPolicyError('invalid_url', `Protocol ${url.protocol} is not allowed`)
  }
  if (url.username || url.password) {
    throw new BrowserPolicyError('invalid_url', 'URLs with embedded credentials are not allowed')
  }
  return url.href
}

/**
 * Refuse a normalized URL whose destination violates the network policy.
 *
 * @param {string} urlString - normalized absolute URL.
 * @param {{ allowPrivateNetwork?: 'all'|'loopback'|'none', allowFileUrls?: boolean }} [options]
 * @returns {Promise<void>} resolves when the destination is allowed.
 */
export async function assertAllowedUrl(urlString, options = {}) {
  const allowPrivateNetwork = options.allowPrivateNetwork ?? 'loopback'
  if (urlString === 'about:blank') return
  const url = new URL(urlString)

  if (url.protocol === 'file:') {
    if (!options.allowFileUrls) throw new BrowserPolicyError('policy_denied', 'file: URLs are disabled')
    return
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new BrowserPolicyError('invalid_url', `Protocol ${url.protocol} is not allowed`)
  }

  const host = normalizeHostname(url.hostname)
  const literal = classifyHost(host)
  if (literal !== 'public') {
    if (!allowsClass(literal, allowPrivateNetwork)) {
      throw new BrowserPolicyError(
        'policy_denied',
        `Destination ${host} is ${literal} and allowPrivateNetwork=${allowPrivateNetwork}`,
      )
    }
    return
  }

  // A DNS name: resolve it so a public-looking hostname cannot point at the
  // loopback interface or a metadata service.
  const addresses = await resolveAddresses(host)
  for (const address of addresses) {
    const classification = classifyAddress(address)
    if (!allowsClass(classification, allowPrivateNetwork)) {
      throw new BrowserPolicyError(
        'policy_denied',
        `Destination ${host} resolves to ${address} (${classification}), which allowPrivateNetwork=${allowPrivateNetwork} refuses`,
      )
    }
  }
}

/**
 * Make one filename safe on every supported platform without changing its
 * extension when one is present.
 */
export function sanitizeFilename(name, fallback = 'download') {
  const flattened = String(name ?? '').replace(/[\\/]+/g, '/')
  const raw = flattened.slice(flattened.lastIndexOf('/') + 1).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
  const collapsed = raw.replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '')
  const candidate = collapsed.slice(0, 120)
  if (!candidate) return fallback
  return RESERVED_FILENAMES.test(candidate) ? `_${candidate}` : candidate
}

/** Whether `candidate` is the root itself or lives under it. */
export function isWithin(root, candidate) {
  const rootPath = resolve(root)
  const candidatePath = resolve(candidate)
  const rel = relative(rootPath, candidatePath)
  if (rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Resolve an artifact destination inside a configured output directory.
 *
 * @param {string} cwd - session workspace.
 * @param {string} configuredDir - relative to the workspace, or absolute.
 * @param {string} name - file basename.
 * @returns {string} absolute destination path; the directory is not created.
 */
export function resolveArtifactPath(cwd, configuredDir, name) {
  const root = isAbsolute(configuredDir) ? resolve(configuredDir) : resolve(cwd, configuredDir)
  const destination = resolve(root, sanitizeFilename(name))
  if (!isWithin(root, destination)) {
    throw new BrowserPolicyError('policy_denied', `Artifact path escapes ${root}`)
  }
  return destination
}

/**
 * Resolve a model/consumer-provided output path. Absolute paths are accepted
 * only when they stay inside the workspace; relative paths resolve against it.
 */
export function resolveUserPath(cwd, input, fallbackName) {
  const value = String(input ?? '').trim()
  if (!value) return resolveArtifactPath(cwd, '.dsh-browser', fallbackName)
  const destination = isAbsolute(value) ? resolve(value) : resolve(cwd, value)
  if (!isWithin(cwd, destination)) {
    throw new BrowserPolicyError('policy_denied', 'Output path must stay inside the workspace')
  }
  return destination
}
