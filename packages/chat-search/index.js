/**
 * Host half of the in-session chat search plugin.
 *
 * Pure UI plugin: the empty `apply` exists so the package appears in the profile's
 * cordis.yml / Loader tree, which is how the browser half is discovered — the
 * Platform Seed reads this package's `dsh.client` declaration and loads
 * `exports["./client"]` into the Web client.
 *
 * There is deliberately nothing else here. Searching the conversation reads the
 * already-rendered transcript in the browser, so no Host route, Host tool, or
 * Host service is involved: the plugin adds no model-visible surface and cannot
 * affect a request, its prompt, or its KV cache.
 *
 * @module dsh-plugin-chat-search
 */

/** Cordis plugin name. */
export const name = 'chat-search';

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply() {}
