/**
 * Browser half of the eye-care theme.
 *
 * What this plugin is: a warm, low-blue-light color layer for the DSH Web GUI.
 * The dark palette — the one the built-in `dark` preference resolves to —
 * replaces the neutral blue-grey surfaces with a faintly moss-tinted near-black
 * (#161a15), softens pure white text into warm cream (#e8e4d6), and drops the
 * blue accents to muted celadon (#86b8a2). The light palette keeps the same
 * character with warm off-white paper surfaces. Both palettes are supplied, so
 * the layer follows the user's `light` / `dark` / `system` preference and the
 * OS scheme flip without any state of its own.
 *
 * Why `overrideTokens` instead of `register`: a registered third-party theme id
 * is an in-process extension that does not cross the built-in settings schema
 * in this release — the Appearance row only offers light / dark / system, so a
 * registered theme could never be selected. `ctx.theme.overrideTokens` stacks a
 * partial token layer over whatever theme is active, which is exactly the
 * promised behavior: install the plugin, and the GUI is warmer. Removing the
 * plugin (or disabling its row) removes the layer and restores the built-in
 * palette; the durable preference is never written by this plugin.
 *
 * Only `--dsw-*` tokens that carry color are overridden. Radii, shadows,
 * typography scales, mask/overlay alphas, and menu blur keep their shipped
 * values, so layout and elevation behavior are untouched.
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-eye-care-theme",
  factory() {
    /** Layer identity. One layer per source; unloading the plugin removes it. */
    const SOURCE = "dsh-plugin-eye-care-theme";

    /**
     * Color overrides as `[light, dark]` pairs.
     *
     * Dark values are the primary design: a very low-saturation moss-black base
     * (green channel a few points above red and blue) under cream text, with
     * celadon accents. Light values are warm paper (#f5f3e8) with the same
     * accents darkened for contrast. Alpha borders are warm white / warm black
     * at the shipped alpha steps, so hairlines keep their intended weight.
     */
    const COLORS = {
      //#region base surfaces
      "--dsw-alias-bg-base": ["#f5f3e8", "#161a15"],
      "--dsw-alias-bg-document-preview": ["#ecebe0", "#161a15"],
      "--dsw-alias-bg-layer-1": ["#fcfbf5", "#1e231d"],
      "--dsw-alias-bg-layer-2": ["#fcfbf5", "#262c25"],
      "--dsw-alias-bg-layer-3": ["#fcfbf5", "#2e352c"],
      "--dsw-alias-bg-module-platform": ["#efede2", "#2e352c"],
      "--dsw-alias-bg-multi-select": ["#efede2", "#1d221c"],
      "--dsw-alias-bg-overlay": ["#e7e4d6", "#5c655a"],
      "--dsw-alias-bg-skeleton": ["#0000000a", "#e8e4d614"],
      "--dsw-specific-sidebar-fill": ["#f6f4ea", "#131712"],
      //#endregion

      //#region borders
      "--dsw-alias-border-inverted": ["#0000", "#e8e4d60f"],
      "--dsw-alias-border-inverted2": ["#0000", "#e8e4d614"],
      "--dsw-alias-border-l1": ["#2b322710", "#e8e4d614"],
      "--dsw-alias-border-l2": ["#2b32271a", "#e8e4d624"],
      "--dsw-alias-border-l2-darkmode-thin": ["#2b32271a", "#e8e4d614"],
      "--dsw-alias-border-l3": ["#2b32271f", "#e8e4d633"],
      "--dsw-alias-border-l4": ["#2b322729", "#e8e4d647"],
      //#endregion

      //#region labels
      "--dsw-alias-label-primary": ["#2a3027", "#e8e4d6"],
      "--dsw-alias-label-primary-bluish": ["#1f3a2c", "#e8e4d6"],
      "--dsw-alias-label-primary-dimmed": ["#21261f", "#d9d6c7"],
      "--dsw-alias-label-primary-foreground": ["#fcfbf5", "#12150f"],
      "--dsw-alias-label-primary-inverted": ["#fcfbf5", "#2e352c"],
      "--dsw-alias-label-secondary": ["#5c6355", "#bdb9ab"],
      "--dsw-alias-label-tertiary": ["#7d8476", "#9a9788"],
      "--dsw-alias-label-caption": ["#a4a99c", "#7c7a6e"],
      "--dsw-alias-label-dimmed": ["#e6e3d7", "#3d463a"],
      "--dsw-alias-label-document-preview": ["#5c6355", "#bdb9ab"],
      "--dsw-alias-label-shimmer": [
        "color-mix(in srgb, #2a3027 30%, transparent)",
        "color-mix(in srgb, #e8e4d6 45%, transparent)",
      ],
      "--dsw-alias-label-deep-diving": [
        "color-mix(in srgb, #3d7a62 70%, #14301f)",
        "color-mix(in srgb, #86b8a2 55%, #9a9788)",
      ],
      "--dsw-alias-label-deep-diving-shimmer": [
        "color-mix(in srgb, #3d7a62 30%, #14301f)",
        "color-mix(in srgb, #b5d9c8 65%, #86b8a2)",
      ],
      "--dsw-alias-link": ["#3d7a62", "#9ac7b4"],
      //#endregion

      //#region brand and buttons
      "--dsw-alias-brand-primary": ["#2a3027", "#e8e4d6"],
      "--dsw-alias-brand-primary-invert": ["#2a3027", "#e8e4d6"],
      "--dsw-alias-brand-primary-new-colorprimary-new-color": ["#3d7a62", "#86b8a2"],
      "--dsw-alias-brand-text": ["#2a3027", "#e8e4d6"],
      "--dsw-alias-button-contrast-fill": ["#5c6355", "#e8e4d6"],
      "--dsw-alias-button-elevated-fill": ["#fcfbf5", "#3d463a"],
      "--dsw-alias-button-floating-fill": ["#fcfbf5", "#2e352c"],
      "--dsw-alias-button-floating-hover": ["#f2efe3", "#364034"],
      "--dsw-alias-button-ghost-active-border": ["#9ba192", "#9a9788"],
      "--dsw-alias-button-ghost-active-fill": ["#e9e6d8", "#3d463a"],
      "--dsw-alias-button-ghost-active-hover": ["#e3dfd0", "#5c655a"],
      "--dsw-alias-button-info-fill": ["#3d7a62", "#8fb8a8"],
      "--dsw-alias-button-info-hover": ["#5d9a80", "#739b8b"],
      "--dsw-alias-button-primary-dimmed": ["#e9e6d8", "#3d463a"],
      "--dsw-alias-button-primary-fill": ["#2a3027", "#e8e4d6"],
      "--dsw-alias-button-primary-hover": ["#3d463a", "#d9d4c2"],
      "--dsw-alias-button-tool-bar-fill": ["#706e6480", "#5c655a80"],
      "--dsw-alias-button-tool-bar-fill-invisible": ["#1f1f1f5c", "#1c211a5c"],
      "--dsw-alias-button-tool-bar-hover": ["#706e6499", "#5c655a99"],
      //#endregion

      //#region interaction layers
      "--dsw-alias-interactive-bg-active": ["#2a30271a", "#e8e4d624"],
      "--dsw-alias-interactive-bg-hover": ["#2a30270f", "#e8e4d614"],
      "--dsw-alias-interactive-bg-hover-accent": ["#2a302724", "#e8e4d63d"],
      "--dsw-alias-interactive-bg-hover-danger": ["#c14a3a0d", "#d97b6a26"],
      "--dsw-alias-interactive-bg-hover-solid": ["#f2efe3", "#2e352c"],
      "--dsw-alias-turn-trigger-bg": ["#fbf9f0", "#e8e4d614"],
      "--dsw-alias-turn-trigger-bg-hover": ["#f0ede0", "#e8e4d624"],
      //#endregion

      //#region states
      "--dsw-alias-state-business-primary": ["#3d7a62", "#86b8a2"],
      "--dsw-alias-state-business-tertiary": ["#e2efe8", "#33473d"],
      "--dsw-alias-state-error-primary": ["#c14a3a", "#d97b6a"],
      "--dsw-alias-state-error-secondary": ["#d97b6a", "#e09484"],
      "--dsw-alias-state-success-primary": ["#2f8a4c", "#7fbf8e"],
      "--dsw-alias-state-success-secondary": ["#4ea86c", "#93d3a1"],
      "--dsw-alias-state-success-tertiary": ["#e4f3e8", "#2a4433"],
      "--dsw-alias-state-warn-label": ["#b9771f", "#d9a45c"],
      "--dsw-alias-state-warn-primary": ["#d38f2d", "#d9a45c"],
      "--dsw-alias-state-warn-secondary": ["#dfa548", "#e5b674"],
      "--dsw-alias-state-warn-tertiary": ["#f8efdc", "#332d22"],
      "--dsw-alias-state-idle-primary": ["#d9d6c8", "#5c655a"],
      "--dsw-alias-bg-document-selection": [
        "color-mix(in srgb, #3d7a62 35%, transparent)",
        "color-mix(in srgb, #86b8a2 40%, transparent)",
      ],
      //#endregion

      //#region scrollbars
      "--dsw-alias-scrollbar-bg-l1": ["#dcd9ca", "#3a4437"],
      "--dsw-alias-scrollbar-bg-l2": ["#dcd9ca", "#5c655a"],
      "--dsw-alias-scrollbar-hover-l1": ["#c9c5b4", "#4a5545"],
      "--dsw-alias-scrollbar-hover-l2": ["#c9c5b4", "#6a7566"],
      //#endregion

      //#region markdown and diffs
      "--dsw-alias-markdown-citation": ["#e9e6d8", "#2e352c"],
      "--dsw-alias-markdown-code-block": ["#f2efe3", "#141813"],
      "--dsw-alias-markdown-code-block-banner": ["#f2efe3", "#262c25"],
      "--dsw-alias-markdown-code-segment-selected": ["#fcfbf5", "#2e352c"],
      "--dsw-alias-markdown-code-segment-unselected": ["#f0ede0", "#141813"],
      "--dsw-alias-markdown-inline-code": ["#f0ede0", "#262c25"],
      "--dsw-alias-markdown-placeholder": ["#efede2", "#262c25"],
      "--dsw-alias-markdown-tag": ["#e9e6d8", "#262c25"],
      "--dsw-alias-code-diff-added": ["#2f8a4c14", "#7fbf8e1f"],
      "--dsw-alias-code-diff-deleted": ["#c14a3a14", "#e08a741f"],
      "--dsw-alias-file-diff-added-bg": ["#e7f2e6", "#1f2e20"],
      "--dsw-alias-file-diff-added-gutter": ["#eef7ee", "#182417"],
      "--dsw-alias-file-diff-added-marker": ["#2f8a4c", "#7fbf8e"],
      "--dsw-alias-file-diff-deleted-bg": ["#f8e8e2", "#35211d"],
      "--dsw-alias-file-diff-deleted-gutter": ["#fbeee9", "#241612"],
      "--dsw-alias-file-diff-deleted-marker": ["#b03a2c", "#e08a74"],
      //#endregion

      //#region menus, surfaces, and small controls
      "--dsw-menu-surface-fill": ["#f6f4ea94", "#3d463a73"],
      "--dsw-specific-menu": ["#f6f4ea94", "#3d463a73"],
      "--dsw-alias-menu-group-header-fill": ["#f6f4eaf0", "#2b3227f0"],
      "--dsw-alias-menu-icon": ["#2e352c", "#d9d6c7"],
      "--dsw-specific-bubble": ["#eaf0e6", "#262c25"],
      "--dsw-specific-bubble-highlight": ["#d8e6da", "#3d463a"],
      "--dsw-specific-input-major": ["#fcfbf5", "#262c25"],
      "--dsw-specific-login-input": ["#f6f4ea", "#131712"],
      "--dsw-specific-selector": ["#efede2", "#2e352c"],
      "--dsw-specific-sidebar-nav-item-active": ["#e9e6d8", "#36402f"],
      "--dsw-specific-sidebar-nav-item-active-accent": ["#e2efe8", "#2e352c"],
      "--dsw-specific-sidebar-nav-item-hover": ["#f0ede0", "#262c25"],
      "--dsw-specific-tip": ["#efede2", "#2e352c"],
      "--dsw-alias-settings-card-fill": ["#fcfbf5", "#262c25"],
      "--dsw-alias-settings-card-stroke": ["#2b322729", "#e8e4d647"],
      "--dsw-alias-onboarding-accent": ["#3d7a62", "#7fb39c"],
      "--dsw-alias-onboarding-card-fill": [
        "color-mix(in srgb, #fcfbf5 80%, transparent)",
        "color-mix(in srgb, #262c25 80%, transparent)",
      ],
      "--dsw-alias-onboarding-checkbox-border": [
        "color-mix(in srgb, #2a3027 20%, transparent)",
        "#e8e4d624",
      ],
      "--dsw-alias-onboarding-secondary-fill": ["#fcfbf5", "#444d41"],
      "--dsw-alias-switch-thumb": ["#fcfbf5", "#bdb9ab"],
      "--dsw-alias-toast-bg": ["#2e352c", "#3d463a"],
      "--dsw-alias-toast-label": ["#fcfbf5", "#e8e4d6"],
      "--dsw-alias-tooltip-bg": ["#2e352c", "#3d463a"],
      "--dsw-alias-tooltip-key-bg": [
        "color-mix(in srgb, #2e352c, #fcfbf5 18%)",
        "color-mix(in srgb, #3d463a, #e8e4d6 18%)",
      ],
      //#endregion
    };

    /** Expand the pair table into the service's `{ light, dark }` shape once. */
    const tokens = Object.fromEntries(
      Object.entries(COLORS).map(([name, [light, dark]]) => [name, { light, dark }]),
    );

    return {
      inject: ["theme"],
      apply(ctx) {
        ctx.effect(
          () => ctx.theme.overrideTokens(SOURCE, tokens),
          "eye-care-theme: token layer",
        );
      },
    };
  },
});
