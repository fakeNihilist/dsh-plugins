/**
 * Host half of the theme-toggle bundle.
 *
 * The button is pure browser UI: the Client half registers into the sidebar's
 * footer action seat and calls the existing theme service. This half exists so
 * the bundle appears in the profile's plugin inventory and can be enabled or
 * disabled like any other plugin; it registers nothing and holds no state.
 */
export function apply() {}
