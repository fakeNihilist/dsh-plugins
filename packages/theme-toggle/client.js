/**
 * Browser half of the light/dark quick switch.
 *
 * Where it lives: the sidebar declares `sidebar.footer.action` — "optional
 * actions beside Settings at the sidebar foot" — and renders it in the footer
 * block just above the account/settings seat. The account flyout itself has no
 * list seat: `settings.launcher` is a single occupant owned by the account menu,
 * so adding a row inside that menu would mean replacing the menu (and losing
 * Settings / Feedback / Sign out). The footer action seat is the additive,
 * `replaceRisk: none` extension point next to it, so the button lands directly
 * above the account button in the same footer area of the red box.
 *
 * What it does: reads the current resolved color scheme from `ctx.theme`
 * (`active.colorScheme`, which already resolves `system` through the OS) and
 * writes the opposite fixed preference with `ctx.theme.setTheme`. That is the
 * theme service's only sanctioned preference write: the choice persists through
 * the Host settings store and every open page follows through `theme/change`.
 * The button itself reads only `--dsw-*` tokens, so it follows whichever theme
 * (built-in or palette override) is active, including a 256-color/light/dark
 * switch while it is mounted.
 *
 * Localization: the bundle declares the `theme-toggle` locale namespace and the
 * slot passes `t` from `locale: NS`, so labels re-read on a language switch.
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-theme-toggle",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    //#region locale

    /** Locale namespace owned by this plugin. */
    const NS = "theme-toggle";

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      switchToLight: "切换到浅色",
      switchToDark: "切换到深色",
      light: "浅色",
      dark: "深色",
    };

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      switchToLight: "Switch to light",
      switchToDark: "Switch to dark",
      light: "Light",
      dark: "Dark",
    };

    //#endregion

    //#region toggle logic

    /**
     * The fixed preference a click should switch to.
     *
     * @param {"light" | "dark"} colorScheme - current resolved scheme.
     * @returns {"light" | "dark"} the opposite scheme.
     */
    function nextPreference(colorScheme) {
      return colorScheme === "dark" ? "light" : "dark";
    }

    //#endregion

    //#region icons

    /** Sun outline: the target when the page is dark. */
    function SunIcon() {
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: 16,
          height: 16,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.4,
          strokeLinecap: "round",
          "aria-hidden": true,
          focusable: "false",
        },
        h("circle", { cx: 8, cy: 8, r: 3.1 }),
        h("path", { d: "M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7" }),
        h("path", { d: "M3.35 3.35l1.2 1.2M11.45 11.45l1.2 1.2M12.65 3.35l-1.2 1.2M4.55 11.45l-1.2 1.2" }),
      );
    }

    /** Crescent moon: the target when the page is light. */
    function MoonIcon() {
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: 16,
          height: 16,
          fill: "currentColor",
          "aria-hidden": true,
          focusable: "false",
        },
        h("path", {
          d: "M10.6 1.9a6.3 6.3 0 1 0 3.5 11.5 6.9 6.9 0 0 1-3.5-11.5Z",
        }),
      );
    }

    //#endregion

    //#region component

    /**
     * One footer action: a single button that flips the saved theme preference.
     *
     * @param {object} props - owner props (`wide`) plus the inject face.
     */
    function ThemeToggle(props) {
      const { wide, t, getTheme, setTheme, subscribeTheme } = props;
      const translate = typeof t === "function" ? t : (key) => en[key] ?? key;
      const [snapshot, setSnapshot] = React.useState(getTheme);
      React.useEffect(() => subscribeTheme((next) => setSnapshot(next)), [subscribeTheme]);
      const [hovered, setHovered] = React.useState(false);

      const scheme = snapshot?.active?.colorScheme === "dark" ? "dark" : "light";
      const target = nextPreference(scheme);
      const label = target === "light" ? translate("switchToLight") : translate("switchToDark");

      return h(
        "button",
        {
          type: "button",
          className: "dsh-theme-toggle",
          "data-target": target,
          "aria-label": label,
          title: label,
          onClick: () => setTheme(target),
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          style: {
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: wide === false ? "center" : "flex-start",
            gap: 8,
            width: wide === false ? 28 : "100%",
            height: 28,
            padding: wide === false ? 0 : "0 8px",
            border: "none",
            borderRadius: 8,
            background: hovered ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
            color: "var(--dsw-alias-label-secondary)",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 13,
            lineHeight: "20px",
            fontWeight: 400,
            flex: "none",
            transition: "background-color .12s",
          },
        },
        h(target === "light" ? SunIcon : MoonIcon),
        wide === false
          ? null
          : h(
              "span",
              {
                style: {
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                },
              },
              target === "light" ? translate("light") : translate("dark"),
            ),
      );
    }

    //#endregion

    //#region plugin

    /** Services this browser half needs. */
    const inject = ["slots", "locale", "theme"];

    /**
     * Register the dictionaries and the footer action.
     *
     * @param {object} ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "theme-toggle: dictionaries");

      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          {
            name: "sidebar.footer.action",
            id: "theme-toggle",
            order: 10,
            locale: NS,
            inject: () => ({
              getTheme: () => ctx.theme.getTheme(),
              setTheme: (id) => ctx.theme.setTheme(id),
              subscribeTheme: (listener) => ctx.on("theme/change", listener),
            }),
          },
          ThemeToggle,
        ),
      );
    }

    //#endregion

    return {
      inject,
      apply,
      __internals: { NS, zh, en, nextPreference, ThemeToggle, SunIcon, MoonIcon },
    };
  },
});
