/**
 * Host half of the eye-care theme bundle.
 *
 * The plugin is entirely a browser-side token layer: the Client half calls
 * `ctx.theme.overrideTokens` and owns every pixel it changes. This half exists
 * so the bundle appears in the profile's plugin inventory and can be enabled
 * or disabled like any other plugin; it registers nothing and holds no state.
 */
export function apply() {}
