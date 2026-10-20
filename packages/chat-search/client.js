/**
 * Browser half of the in-session chat search plugin.
 *
 * Find-in-conversation: a Session-header control plus a floating find bar that
 * walks the rendered transcript, highlights every hit, and steps through them.
 *
 * Four decisions shape this module.
 *
 * 1. The transcript is searched as rendered DOM, not as Session events. Folding,
 *    Markdown, syntax highlighting, and tool-card presentation all live in the
 *    render tree, so the text a reader sees is the text this plugin matches, and a
 *    hit can be scrolled to without maintaining a second projection of the
 *    conversation.
 * 2. Matches are painted with the CSS Custom Highlight API. Ranges are laid over
 *    the existing text instead of wrapping it in new elements, so a search never
 *    mutates the React-owned DOM it is reading: no re-render can be broken by a
 *    search, and no search can be wiped out by a re-render.
 * 3. Collapsed content stays searchable. Folded transcript rows and reasoning
 *    blocks remain mounted with `hidden="until-found"`, so their text is in the
 *    walk. Stepping onto such a match dispatches the browser's own `beforematch`
 *    event, which is exactly the fold seam the Chat view already exposes for
 *    browser find -- the app's own handler decides whether a row can be revealed.
 * 4. A hit is scrolled to by its characters, not by its row. One row can hold an
 *    entire answer or tool result and be taller than the viewport, and a hit can sit
 *    inside a capped process group's own scroller; the walk therefore moves every
 *    scroll box between the hit and the document, centering the hit itself.
 *
 * Nothing is written outside the browser: the Host half registers no route, tool,
 * or prompt, so this plugin adds no model-visible surface and cannot affect a
 * request, its prompt, or its KV cache.
 *
 * Plain JavaScript by design. An installed client bundle receives React and the
 * Platform Seed's module table from the browser, so no build step is involved;
 * `package.json`'s `dsh.client` declaration is what discovers this file.
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-chat-search",
  factory(require) {
    const React = require("react");
    const { createPortal } = require("react-dom");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;

    //#region constants

    /** Locale namespace owned by this plugin. */
    const NS = "chatSearch";

    /** Read-only transcript column the search walks (declared by ui-chat's ChatView). */
    const FLOW_ATTR = "data-chat-flow";
    /** Transcript row attribute carrying the Chat node's stable anchor key. */
    const ROW_ATTR = "data-chat-anchor-key";
    /** Element names whose text is never transcript prose. */
    const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TEMPLATE"]);

    const ELEMENT_NODE = 1;
    const TEXT_NODE = 3;

    /**
     * Ceiling on collected matches.
     *
     * A one-character query in a long Session can match tens of thousands of times;
     * painting them all costs more than the answer is worth. The bar shows the
     * truncation (`2000+`) rather than hiding it.
     */
    const MAX_MATCHES = 2000;

    /**
     * Longest accepted pattern.
     *
     * Bounds both the regex engine's work and the cost of re-running a search on
     * every transcript mutation. Nobody searches a conversation for a
     * 500-character literal.
     */
    const MAX_PATTERN_LENGTH = 512;

    /** Quiet period before a keystroke or a transcript mutation re-runs the search. */
    const DEBOUNCE_MS = 150;

    /** Registry names for the two highlight layers. One find bar exists at a time. */
    const HIGHLIGHT_ALL = "dsh-chat-search";
    const HIGHLIGHT_ACTIVE = "dsh-chat-search-active";

    /** Document-level stylesheet identity, mirroring how shipped bundles tag theirs. */
    const CSS_TAG_ID = "dsh-plugin-chat-search/FindBar.css";

    /**
     * Find-bar and highlight styling.
     *
     * Named `STYLES`, not `CSS`: a lexical binding by that name shadows the platform's
     * `CSS` global, and the highlight registry is reached through it.
     *
     * Every colour is a theme token with a literal fallback, so the bar keeps working
     * when a token is renamed. The `::highlight()` rules are written twice: the literal
     * declaration is the floor, and the `color-mix` declaration that follows overrides it
     * wherever the engine understands it.
     */
    const STYLES = `
.dcs-trigger{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:6px;border:none;border-radius:28px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dcs-trigger svg{width:15px;height:15px}
.dcs-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dcs-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.dcs-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dcs-bar{position:fixed;z-index:60;box-sizing:border-box;display:flex;align-items:center;gap:2px;max-width:min(460px,calc(100vw - 32px));padding:5px 6px 5px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-panel,0 6px 24px rgba(0,0,0,.18));color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:20px;animation:dcs-enter .12s ease-out}
@keyframes dcs-enter{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.dcs-bar[data-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}
.dcs-leading{flex:none;display:inline-flex;align-items:center;margin-right:4px;color:var(--dsw-alias-label-tertiary)}
/* Icon exports are named by size class (Regular/Medium) on the current client and by
   pixel size (14/16) on older ones, so both families are normalized here rather than
   relying on a per-icon default. */
.dcs-leading svg{width:14px;height:14px}
.dcs-input{flex:1 1 auto;min-width:60px;padding:2px 0;border:0;outline:0;background:0 0;color:inherit;font:inherit}
.dcs-input::placeholder{color:var(--dsw-alias-label-secondary)}
.dcs-count{flex:none;min-width:50px;padding:0 4px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dcs-count[data-empty="true"]{color:var(--dsw-alias-label-tertiary)}
.dcs-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:7px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dcs-btn svg{width:14px;height:14px}
.dcs-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dcs-btn:disabled{opacity:.4;cursor:default}
.dcs-btn[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.dcs-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dcs-toggle{width:auto;min-width:26px;padding:0 5px;font-size:11px;font-weight:600;letter-spacing:.02em}
.dcs-divider{flex:none;width:1px;height:16px;margin:0 3px;background:var(--dsw-alias-border-l1)}
.dcs-announce{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
::highlight(dsh-chat-search){background-color:rgba(255,197,61,.34)}
::highlight(dsh-chat-search){background-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ffc53d) 34%,transparent)}
::highlight(dsh-chat-search-active){background-color:#ffab00;color:#1a1a1a}
::highlight(dsh-chat-search-active){background-color:var(--dsw-alias-state-warn-primary,#ffab00);color:var(--dsw-alias-bg-base,#1a1a1a)}
@media (prefers-reduced-motion:reduce){.dcs-bar{animation:none}}
`;

    //#endregion

    //#region text matching

    /** Escape a literal so it can be embedded in a `RegExp` source. */
    function escapeRegExp(text) {
      return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    /**
     * Compile one query into a reusable matcher.
     *
     * The pattern is compiled once per search rather than once per text node, and an
     * unusable pattern is reported instead of thrown: the find bar shows the problem
     * while the reader is still typing a half-finished expression.
     *
     * @param query - the raw query text.
     * @param options - `caseSensitive` and `regex` flags.
     * @returns `{ ok, match }`. `ok: false` means the pattern cannot be compiled, and
     *   `match` then always answers an empty list.
     */
    function compileQuery(query, options) {
      const caseSensitive = options.caseSensitive === true;
      const asRegex = options.regex === true;
      if (query === "" || query.length > MAX_PATTERN_LENGTH) {
        return { ok: true, match: () => [] };
      }

      if (!asRegex) {
        const needle = caseSensitive ? query : query.toLowerCase();
        return {
          ok: true,
          match(text) {
            // Case folding can change a string's length (U+0130 is the classic case),
            // which would misalign every offset after the fold. Fold only when both
            // sides keep their length; otherwise scan exactly.
            const foldable =
              !caseSensitive &&
              needle.length === query.length &&
              text.toLowerCase().length === text.length;
            const haystack = foldable ? text.toLowerCase() : text;
            const target = foldable ? needle : query;
            const spans = [];
            let from = 0;
            for (;;) {
              const at = haystack.indexOf(target, from);
              if (at === -1) break;
              spans.push({ start: at, end: at + target.length });
              if (spans.length >= MAX_MATCHES) break;
              from = at + target.length;
            }
            return spans;
          },
        };
      }

      let pattern;
      try {
        pattern = new RegExp(query, caseSensitive ? "g" : "gi");
      } catch {
        return { ok: false, match: () => [] };
      }
      return {
        ok: true,
        match(text) {
          const spans = [];
          pattern.lastIndex = 0;
          let found = pattern.exec(text);
          while (found !== null) {
            if (found[0].length === 0) {
              // A zero-width match never advances `lastIndex`, so `exec` would return
              // the same position forever. Step past it instead.
              pattern.lastIndex += 1;
            } else {
              spans.push({ start: found.index, end: found.index + found[0].length });
              if (spans.length >= MAX_MATCHES) break;
            }
            found = pattern.exec(text);
          }
          return spans;
        },
      };
    }

    /**
     * Match one string, for callers that keep no compiled matcher.
     * @returns match spans, or an empty list for an unusable pattern.
     */
    function findInText(text, query, options) {
      const compiled = compileQuery(query, options);
      return compiled.ok ? compiled.match(text) : [];
    }

    //#endregion

    //#region transcript walk

    /** Whether an element's subtree carries no transcript prose. */
    function isSkippedElement(element) {
      if (SKIP_TAGS.has(element.tagName)) return true;
      // The composer lives beside the transcript in the same scroll container; a
      // draft is not conversation text and must not be matched.
      if (element.hasAttribute("data-composer-seat")) return true;
      // Foot-gun guard for anything this plugin might render inside the column.
      return element.hasAttribute("data-chat-search-skip");
    }

    /**
     * Anchor key of the transcript row owning a node, or `null` outside a row.
     *
     * Walks parents instead of calling `closest()` so the function also works against
     * the `querySelector`-free tree the unit tests build.
     */
    function ownerRowKey(node) {
      for (let el = node.parentNode; el !== null && el !== undefined; el = el.parentNode) {
        if (el.nodeType !== ELEMENT_NODE) continue;
        const dataset = el.dataset;
        if (dataset !== undefined && dataset.chatAnchorKey !== undefined) {
          return dataset.chatAnchorKey;
        }
      }
      return null;
    }

    /**
     * Stable identity for one hit within its row.
     *
     * Keeps the reader on the same match when a streaming transcript re-runs the
     * search and every positional index shifts.
     */
    function identityOf(hit) {
      const key = hit.key === null || hit.key === undefined ? "" : String(hit.key);
      return `${key}\u0000${String(hit.ordinal)}`;
    }

    /**
     * Collect every match in a transcript subtree, in document order.
     *
     * Reads the tree only: nothing is wrapped, inserted, or removed. Skipped subtrees
     * are pruned as the walk descends, so a large transcript costs one visit per text
     * node rather than one `closest()` call per node.
     *
     * @param root - the transcript column element.
     * @param query - the raw query text.
     * @param options - `caseSensitive` and `regex` flags.
     * @returns `{ ok, truncated, hits }` with plain `{ node, start, end, key, ordinal }`
     *   descriptors; turning them into `Range`s is the caller's job.
     */
    function collectMatches(root, query, options) {
      const compiled = compileQuery(query, options);
      if (!compiled.ok) return { ok: false, truncated: false, hits: [] };

      const hits = [];
      const ordinals = new Map();

      /** @returns true when the match ceiling stopped the walk. */
      const visit = (element) => {
        for (let child = element.firstChild; child !== null; child = child.nextSibling) {
          if (child.nodeType === TEXT_NODE) {
            const data = child.data;
            if (data.length === 0) continue;
            for (const span of compiled.match(data)) {
              const key = ownerRowKey(child);
              const ordinal = ordinals.get(key) ?? 0;
              ordinals.set(key, ordinal + 1);
              hits.push({ node: child, start: span.start, end: span.end, key, ordinal });
              if (hits.length >= MAX_MATCHES) return true;
            }
          } else if (child.nodeType === ELEMENT_NODE) {
            if (isSkippedElement(child)) continue;
            if (visit(child)) return true;
          }
        }
        return false;
      };

      if (root !== null && root !== undefined) visit(root);
      // The per-node scan and the walk stop at the same ceiling, so reaching it is the
      // only signal available that further matches may exist further down.
      return { ok: true, truncated: hits.length >= MAX_MATCHES, hits };
    }

    //#endregion

    //#region browser-side helpers

    /**
     * Resolve this Session's transcript column from one of its header controls.
     *
     * The header and the Chat view are siblings under one Session-scoped conversation
     * container, so the first ancestor that owns a transcript is this Session's. That is
     * what keeps a Sidebar chat tab's conversation from being searched by the main
     * column's find bar.
     */
    function resolveFlow(from) {
      for (let el = from; el !== null && el !== undefined; el = el.parentNode) {
        if (el.nodeType !== ELEMENT_NODE) continue;
        if (typeof el.querySelector !== "function") continue;
        const found = el.querySelector(`[${FLOW_ATTR}]`);
        if (found !== null) return found;
      }
      if (typeof document === "undefined" || document === null) return null;
      return document.querySelector(`[${FLOW_ATTR}]`);
    }

    /** Element of the transcript row owning a node, or `null`. */
    function rowElementOf(node) {
      for (let el = node.parentNode; el !== null && el !== undefined; el = el.parentNode) {
        if (el.nodeType !== ELEMENT_NODE) continue;
        const dataset = el.dataset;
        if (dataset !== undefined && dataset.chatAnchorKey !== undefined) return el;
      }
      return null;
    }

    /**
     * The document's highlight registry, or `undefined` where the API is unavailable.
     *
     * Read off `globalThis` deliberately. This module also owns a stylesheet constant,
     * and an earlier revision named it `CSS` — a lexical binding that silently shadowed
     * the platform global, so every highlight call answered "unsupported" and matches
     * were counted but never painted. Naming the object explicitly makes that class of
     * mistake impossible.
     */
    function highlightRegistry() {
      const api = globalThis.CSS;
      if (api === undefined || api === null) return undefined;
      const registry = api.highlights;
      return registry === undefined || registry === null ? undefined : registry;
    }

    /** Whether the engine can paint ranges without touching the DOM. */
    function highlightsSupported() {
      return typeof globalThis.Highlight === "function" && highlightRegistry() !== undefined;
    }

    /**
     * Convert hit descriptors into live `Range`s.
     *
     * One range per hit, in the same order, so the active index addresses both lists.
     * Hits were just collected from the live tree, so every node is still connected.
     */
    function toRanges(hits) {
      const ranges = [];
      if (typeof document === "undefined" || document === null) return ranges;
      for (const hit of hits) {
        const range = document.createRange();
        range.setStart(hit.node, hit.start);
        range.setEnd(hit.node, hit.end);
        ranges.push(range);
      }
      return ranges;
    }

    /** Publish both highlight layers. Without the API the bar still counts and scrolls. */
    function paintHighlights(ranges, activeIndex) {
      const registry = highlightRegistry();
      if (registry === undefined || typeof globalThis.Highlight !== "function") return;
      const all = new globalThis.Highlight();
      for (const range of ranges) all.add(range);
      registry.set(HIGHLIGHT_ALL, all);
      const active = ranges[activeIndex];
      if (active === undefined) registry.delete(HIGHLIGHT_ACTIVE);
      else registry.set(HIGHLIGHT_ACTIVE, new globalThis.Highlight(active));
    }

    /** Drop both layers, leaving the transcript exactly as it was found. */
    function clearHighlights() {
      const registry = highlightRegistry();
      if (registry === undefined) return;
      registry.delete(HIGHLIGHT_ALL);
      registry.delete(HIGHLIGHT_ACTIVE);
    }

    /**
     * Unfold every collapsed ancestor of a match.
     *
     * Collapsed rows and folded reasoning carry `hidden="until-found"` and listen for
     * the browser's `beforematch` event to expand. Dispatching it is the supported
     * reveal seam -- the app's own handler decides, so a node with nothing to reveal
     * simply stays hidden instead of being forced open.
     *
     * @returns how many ancestors were asked to reveal.
     */
    function revealAncestors(node, stopAt) {
      const folded = [];
      for (
        let el = node.parentNode;
        el !== null && el !== undefined && el !== stopAt;
        el = el.parentNode
      ) {
        if (el.nodeType !== ELEMENT_NODE) continue;
        if (typeof el.hasAttribute !== "function") continue;
        if (el.hasAttribute("hidden")) folded.push(el);
      }
      // Innermost first, so an outer reveal observes settled inner state.
      for (const el of folded) el.dispatchEvent(new Event("beforematch"));
      return folded.length;
    }

    //#region scrolling to the match

    /** `overflow` values that make an element scroll its own content. */
    const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll", "overlay"]);

    /** Whether the reader asked for reduced motion, so scrolling must not animate. */
    function prefersReducedMotion() {
      if (typeof globalThis.matchMedia !== "function") return false;
      try {
        return globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
      } catch {
        return false;
      }
    }

    /**
     * Bounding box of the matched characters themselves, in viewport coordinates.
     *
     * A row is the wrong scroll unit. One `[data-chat-anchor-key]` box can hold a whole
     * answer, a reasoning block, or a tool result and be taller than the viewport, so
     * centering the row can leave the match itself off screen. The `Range` the highlight
     * layer already paints answers exactly where the characters are.
     *
     * @returns the first non-empty client rect, or `null` when the range cannot be measured.
     */
    function hitClientRect(hit) {
      if (typeof document === "undefined" || document === null) return null;
      if (typeof document.createRange !== "function") return null;
      try {
        const range = document.createRange();
        range.setStart(hit.node, hit.start);
        range.setEnd(hit.node, hit.end);
        const rects = typeof range.getClientRects === "function" ? range.getClientRects() : null;
        if (rects !== null && rects !== undefined) {
          for (const rect of rects) {
            if (rect.width > 0 || rect.height > 0) return rect;
          }
        }
        const rect =
          typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
        if (rect !== null && rect !== undefined && (rect.width > 0 || rect.height > 0)) return rect;
      } catch {
        // The node went away between indexing and stepping; the caller falls back to the row.
      }
      return null;
    }

    /**
     * Scroll boxes that can hide a hit, innermost first.
     *
     * Both ends matter: a match inside a capped process group is hidden by that group's
     * own body, and the group itself is hidden by the conversation scrollport above the
     * flow. Collecting the chain once, then moving each box in turn, is what makes a
     * nested hit visible; moving only the outermost box leaves it scrolled out of view
     * inside the inner one.
     */
    function scrollChain(node) {
      const chain = [];
      if (typeof globalThis.getComputedStyle !== "function") return chain;
      for (let el = node.parentNode; el !== null && el !== undefined; el = el.parentNode) {
        if (el.nodeType !== ELEMENT_NODE) continue;
        if (typeof el.getBoundingClientRect !== "function") continue;
        const style = globalThis.getComputedStyle(el);
        if (style === null || style === undefined) continue;
        const vertical =
          SCROLLABLE_OVERFLOW.has(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
        const horizontal =
          SCROLLABLE_OVERFLOW.has(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
        if (vertical || horizontal) chain.push({ element: el, vertical, horizontal });
      }
      return chain;
    }

    /** Clamp a scroll offset into an element's real scroll range. */
    function clampScroll(value, max) {
      return Math.min(Math.max(value, 0), Math.max(max, 0));
    }

    /**
     * Move one scroll box so the matched characters are inside it.
     *
     * Vertically a match that is outside a comfortable band is centered; horizontally it
     * is only brought into view, because sliding a code line changes the reader's column.
     * A match larger than its box is aligned to the leading edge instead of centered,
     * which would push its beginning out of view.
     *
     * @returns whether the box actually moved.
     */
    function revealInBox(box, hit, smooth) {
      const rect = hitClientRect(hit);
      if (rect === null) return false;
      const element = box.element;
      const frame = element.getBoundingClientRect();
      const viewLeft = frame.left + (element.clientLeft ?? 0);
      const viewTop = frame.top + (element.clientTop ?? 0);
      const viewWidth = element.clientWidth;
      const viewHeight = element.clientHeight;
      if (box.vertical && viewHeight <= 0) return false;
      if (box.horizontal && viewWidth <= 0) return false;

      const marginX = Math.min(24, viewWidth * 0.15);
      const marginY = Math.min(48, viewHeight * 0.15);
      let left = element.scrollLeft;
      let top = element.scrollTop;

      if (box.horizontal) {
        if (rect.width >= viewWidth - 2 * marginX || rect.left < viewLeft + marginX) {
          left = element.scrollLeft + rect.left - viewLeft - marginX;
        } else if (rect.right > viewLeft + viewWidth - marginX) {
          left = element.scrollLeft + rect.right - (viewLeft + viewWidth - marginX);
        }
      }
      if (box.vertical) {
        if (rect.top < viewTop + marginY || rect.bottom > viewTop + viewHeight - marginY) {
          const center =
            rect.height >= viewHeight - 2 * marginY ? marginY : (viewHeight - rect.height) / 2;
          top = element.scrollTop + rect.top - viewTop - center;
        }
      }

      const nextLeft = clampScroll(left, element.scrollWidth - viewWidth);
      const nextTop = clampScroll(top, element.scrollHeight - viewHeight);
      if (
        Math.abs(nextLeft - element.scrollLeft) < 1 &&
        Math.abs(nextTop - element.scrollTop) < 1
      ) {
        return false;
      }
      if (typeof element.scrollTo === "function") {
        element.scrollTo({
          left: nextLeft,
          top: nextTop,
          behavior: smooth ? "smooth" : "auto",
        });
      } else {
        element.scrollLeft = nextLeft;
        element.scrollTop = nextTop;
      }
      return true;
    }

    /**
     * Scroll every box hiding a hit, innermost first.
     *
     * Each box is measured after the previous one moved, because scrolling an inner box
     * changes where the outer box sees the same characters. Only the outermost box --
     * typically the conversation scrollport -- animates, so nested writes cannot race
     * each other.
     *
     * @returns whether the hit had any scroll box at all.
     */
    function scrollChainToHit(hit, smooth) {
      const chain = scrollChain(hit.node);
      for (let index = 0; index < chain.length; index += 1) {
        const last = index === chain.length - 1;
        revealInBox(chain[index], hit, smooth && last);
      }
      return chain.length > 0;
    }

    /** Fallback for environments without measurable scroll boxes: center the owning row. */
    function scrollRowToHit(hit) {
      const row = rowElementOf(hit.node);
      if (row === null || typeof row.scrollIntoView !== "function") return;
      row.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    }

    /** Supersedes any reveal still settling when a newer step takes over the viewport. */
    let scrollGeneration = 0;

    /**
     * Bring one match into view, unfolding its row first when it is collapsed.
     *
     * The first measurement waits one frame so a synchronous reveal has committed. A
     * reveal that animates grows the row over a few frames, so the position is re-measured
     * until the target geometry rests for two frames; otherwise the scroll would land on
     * the collapsed box and drift as the row expands.
     *
     * Every call supersedes the previous one: stepping again while a reveal is still
     * settling must not let the earlier target pull the viewport back.
     */
    function scrollToHit(hit, flow) {
      const generation = ++scrollGeneration;
      const revealed = revealAncestors(hit.node, flow);
      const animate = revealed === 0 && !prefersReducedMotion();
      let frames = 0;
      let signature = null;
      let stable = 0;
      const reach = () => {
        if (generation !== scrollGeneration) return;
        const rect = hitClientRect(hit);
        const current = rect === null ? null : `${Math.round(rect.top)}:${Math.round(rect.height)}`;
        if (current !== null && current === signature) stable += 1;
        else stable = 0;
        signature = current;
        if (!scrollChainToHit(hit, animate)) scrollRowToHit(hit);
        frames += 1;
        if (
          revealed > 0 &&
          stable < 2 &&
          frames < 16 &&
          typeof requestAnimationFrame === "function"
        ) {
          requestAnimationFrame(reach);
        }
      };
      if (typeof requestAnimationFrame !== "function") reach();
      else requestAnimationFrame(reach);
    }

    //#endregion

    //#endregion

    //#region find-bar coordination

    /**
     * Live find bars, keyed by handle.
     *
     * The Session header is Session-scoped, so a resident main column and a Sidebar
     * chat tab can each hold one. The map feeds the single global shortcut and enforces
     * the one-open-bar rule. Handles are stable and read live refs, so registration
     * happens once per mount.
     */
    const registry = new Map();

    /**
     * Choose which resident conversation the shortcut addresses.
     *
     * Focus wins, then visible area: the main column is the widest conversation
     * whenever both are docked, so an unfocused press lands on the primary one.
     */
    function pickSearchTarget() {
      if (registry.size === 0) return null;
      const entries = [...registry.values()];
      if (entries.length === 1) return entries[0];
      const focused = entries.find((entry) => entry.ownsFocus());
      if (focused !== undefined) return focused;
      const visible = entries.filter((entry) => entry.isVisible());
      if (visible.length === 0) return entries[0];
      let best = visible[0];
      for (const entry of visible) if (entry.area() > best.area()) best = entry;
      return best;
    }

    /** Ask every other find bar to close, so one bar owns the shortcuts. */
    function closeOtherBars(self) {
      for (const entry of registry.values()) {
        if (entry === self) continue;
        if (entry.isOpen()) entry.close();
      }
    }

    //#endregion

    //#region component

    const EMPTY_REPORT = { total: 0, active: -1, truncated: false, invalid: false };

    /**
     * Resolve one icon out of the client primitives.
     *
     * Export naming drifts between Harness lines: the 0.2 client ships size-classed names
     * (`IconSearchOutlineMedium`), while earlier builds shipped pixel-suffixed ones
     * (`IconSearchOutline16`). A missing export does not degrade — it reaches React as an
     * invalid element type, and a slot entry that throws during render *abdicates its own
     * cell*, so the control vanishes with no visible cause. Every spelling is therefore
     * tried, and the chain ends at a glyph drawn in place.
     */
    function resolveIcon(candidates, label, path) {
      for (const candidate of candidates) {
        if (typeof candidate === "function") return candidate;
      }
      console.warn(`chat-search: no client-primitives export for ${label}; using a drawn fallback`);
      return function FallbackIcon(props) {
        const size = props !== null && props !== undefined && props.size !== undefined ? props.size : 16;
        return h(
          "svg",
          {
            width: size,
            height: size,
            viewBox: "0 0 16 16",
            fill: "none",
            "aria-hidden": true,
          },
          h("path", {
            d: path,
            stroke: "currentColor",
            strokeWidth: 1.5,
            strokeLinecap: "round",
            strokeLinejoin: "round",
          }),
        );
      };
    }

    /** Icons the control draws, resolved once against the client primitives. */
    const IconSearch = resolveIcon(
      [
        primitives.IconSearchOutlineRegular,
        primitives.IconSearchOutlineMedium,
        primitives.IconSearchOutline16,
      ],
      "IconSearchOutline",
      "M10.4 10.4 13.5 13.5M12 7.3a4.7 4.7 0 1 1-9.4 0 4.7 4.7 0 0 1 9.4 0Z",
    );
    const IconChevronUp = resolveIcon(
      [
        primitives.IconChevronUpOutlineRegular,
        primitives.IconChevronUpOutlineMedium,
        primitives.IconChevronUpOutline14,
      ],
      "IconChevronUpOutline",
      "M3.5 9.5 7 6l3.5 3.5",
    );
    const IconChevronDown = resolveIcon(
      [
        primitives.IconChevronDownOutlineRegular,
        primitives.IconChevronDownOutlineMedium,
        primitives.IconChevronDownOutline14,
      ],
      "IconChevronDownOutline",
      "M3.5 6.5 7 10l3.5-3.5",
    );
    const IconClose = resolveIcon(
      [
        primitives.IconCloseOutlineRegular,
        primitives.IconCloseOutlineMedium,
        primitives.IconCloseOutline16,
      ],
      "IconCloseOutline",
      "M4 4l8 8M12 4l-8 8",
    );

    /** The Session-header find control: a magnifier button plus, while open, the
     * floating find bar it drives. */
    function ChatSearchControl(props) {
      // The slot owner binds `t` from the registration's locale namespace. Falling back
      // to the plugin's own English dictionary keeps a mis-bound locale from turning
      // into an invisible control.
      const t = typeof props.t === "function" ? props.t : (key) => en[key] ?? key;
      const sessionId = props.sessionId;

      const [open, setOpen] = React.useState(false);
      const [query, setQuery] = React.useState("");
      const [caseSensitive, setCaseSensitive] = React.useState(false);
      const [regex, setRegex] = React.useState(false);
      const [report, setReport] = React.useState(EMPTY_REPORT);
      // A usable resting place, replaced by the measured anchor before the first paint
      // that shows the bar. Waiting for a measurement would mean showing nothing at all
      // whenever the header has no layout box yet.
      const [anchor, setAnchor] = React.useState({ top: 72, right: 24 });

      // Refs first: the callbacks below read them, and the debounced search and the
      // MutationObserver both run outside a render and must see current values.
      const buttonRef = React.useRef(null);
      const inputRef = React.useRef(null);
      const barElementRef = React.useRef(null);
      const flowRef = React.useRef(null);
      const hitsRef = React.useRef([]);
      const rangesRef = React.useRef([]);
      const activeRef = React.useRef(-1);
      const identityRef = React.useRef(null);
      const restoreRef = React.useRef(null);
      const timerRef = React.useRef(null);
      const openRef = React.useRef(false);
      const queryRef = React.useRef("");
      const optionsRef = React.useRef({ caseSensitive: false, regex: false });
      const handleRef = React.useRef(null);
      const openBarRef = React.useRef(null);
      const closeRef = React.useRef(null);

      openRef.current = open;
      queryRef.current = query;
      optionsRef.current = { caseSensitive, regex };

      /** Run the search over the transcript and publish the resulting position. */
      const runSearch = React.useCallback((shouldScroll, reseed) => {
        const previous = flowRef.current;
        const flow =
          previous !== null && previous.isConnected !== false
            ? previous
            : resolveFlow(buttonRef.current);
        flowRef.current = flow;

        const current = queryRef.current;
        if (flow === null || current === "") {
          hitsRef.current = [];
          rangesRef.current = [];
          activeRef.current = -1;
          identityRef.current = null;
          clearHighlights();
          setReport(EMPTY_REPORT);
          return -1;
        }

        const found = collectMatches(flow, current, optionsRef.current);
        if (!found.ok) {
          hitsRef.current = [];
          rangesRef.current = [];
          activeRef.current = -1;
          identityRef.current = null;
          clearHighlights();
          setReport({ ...EMPTY_REPORT, invalid: true });
          return -1;
        }

        hitsRef.current = found.hits;
        rangesRef.current = toRanges(found.hits);

        // A re-index keeps the reader on the match they were already on. A fresh
        // pattern has no such identity, so it resumes near the previous position
        // rather than jumping back to the top of the conversation.
        let active = -1;
        if (!reseed && identityRef.current !== null) {
          active = found.hits.findIndex((hit) => identityOf(hit) === identityRef.current);
        }
        if (active === -1) {
          active =
            found.hits.length === 0
              ? -1
              : Math.min(Math.max(activeRef.current, 0), found.hits.length - 1);
        }
        activeRef.current = active;
        identityRef.current = active === -1 ? null : identityOf(found.hits[active]);
        paintHighlights(rangesRef.current, active);
        setReport({
          total: found.hits.length,
          active,
          truncated: found.truncated,
          invalid: false,
        });
        if (shouldScroll && active !== -1) scrollToHit(found.hits[active], flow);
        return active;
      }, []);

      /** Debounce a search so typing and streaming both stay smooth. */
      const schedule = React.useCallback(
        (shouldScroll, reseed) => {
          if (timerRef.current !== null) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            runSearch(shouldScroll, reseed);
          }, DEBOUNCE_MS);
        },
        [runSearch],
      );

      /** Move the active match, wrapping at both ends. */
      const step = React.useCallback((delta) => {
        const total = hitsRef.current.length;
        if (total === 0) return;
        const from = activeRef.current;
        const active =
          from === -1 ? (delta > 0 ? 0 : total - 1) : (from + delta + total) % total;
        activeRef.current = active;
        identityRef.current = identityOf(hitsRef.current[active]);
        paintHighlights(rangesRef.current, active);
        setReport((previous) => ({ ...previous, active }));
        scrollToHit(hitsRef.current[active], flowRef.current);
      }, []);

      /** Close the bar and hand the transcript back untouched. */
      const close = React.useCallback(() => {
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        openRef.current = false;
        setOpen(false);
        setQuery("");
        hitsRef.current = [];
        rangesRef.current = [];
        activeRef.current = -1;
        identityRef.current = null;
        clearHighlights();
        setReport(EMPTY_REPORT);
        const restore = restoreRef.current;
        restoreRef.current = null;
        if (
          restore !== null &&
          restore.isConnected !== false &&
          typeof restore.focus === "function"
        ) {
          restore.focus();
        }
      }, []);

      /** Open the bar, taking ownership from any other resident conversation. */
      const openBar = React.useCallback(() => {
        const self = handleRef.current;
        if (self !== null) closeOtherBars(self);
        const active =
          typeof document === "undefined" || document === null ? null : document.activeElement;
        restoreRef.current =
          active !== null && typeof active.focus === "function" ? active : null;
        openRef.current = true;
        setOpen(true);
      }, []);

      const toggle = React.useCallback(() => {
        if (openRef.current) close();
        else openBar();
      }, [close, openBar]);

      openBarRef.current = openBar;
      closeRef.current = close;

      if (handleRef.current === null) {
        handleRef.current = {
          open: () => openBarRef.current(),
          close: () => closeRef.current(),
          isOpen: () => openRef.current,
          ownsFocus: () => {
            if (typeof document === "undefined" || document === null) return false;
            const active = document.activeElement;
            if (active === null || active === undefined) return false;
            const bar = barElementRef.current;
            if (bar !== null && typeof bar.contains === "function" && bar.contains(active)) {
              return true;
            }
            const flow = flowRef.current;
            return flow !== null && typeof flow.contains === "function" && flow.contains(active);
          },
          isVisible: () => {
            const rect = flowRect(flowRef.current ?? resolveFlow(buttonRef.current));
            return rect !== null && rect.width > 0 && rect.height > 0;
          },
          area: () => {
            const rect = flowRect(flowRef.current ?? resolveFlow(buttonRef.current));
            return rect === null ? 0 : rect.width * rect.height;
          },
        };
      }

      // Resolve the transcript column before anything searches it.
      React.useLayoutEffect(() => {
        flowRef.current = open ? resolveFlow(buttonRef.current) : null;
      }, [open]);

      // Stop a pending re-index when the control goes away.
      React.useEffect(
        () => () => {
          if (timerRef.current !== null) clearTimeout(timerRef.current);
        },
        [],
      );

      // Search whenever the query, the flags, or the open state change.
      React.useEffect(() => {
        if (!open) return;
        schedule(true, true);
      }, [open, query, caseSensitive, regex, schedule]);

      // A streaming transcript re-indexes under the search. The observer follows it,
      // but never scrolls: the reader stays in charge of the viewport.
      React.useEffect(() => {
        if (!open || query === "" || typeof MutationObserver !== "function") return;
        const flow = flowRef.current ?? resolveFlow(buttonRef.current);
        if (flow === null) return;
        const observer = new MutationObserver(() => {
          schedule(false, false);
        });
        observer.observe(flow, { childList: true, subtree: true, characterData: true });
        return () => {
          observer.disconnect();
        };
      }, [open, query, schedule]);

      // Keep the bar under its trigger across header relayouts and window resizes.
      React.useLayoutEffect(() => {
        if (!open) return;
        const measure = () => {
          const button = buttonRef.current;
          const rect =
            button !== null && typeof button.getBoundingClientRect === "function"
              ? button.getBoundingClientRect()
              : null;
          const laid = rect !== null && (rect.width > 0 || rect.height > 0);
          // A header that has no layout box yet (still mounting, or behind a collapsed
          // panel) measures zero. Anchoring to the viewport corner keeps the bar usable
          // instead of refusing to open; the next resize pins it to its trigger.
          setAnchor({
            top: Math.round(laid ? rect.bottom + 8 : 72),
            right: Math.round(laid ? Math.max(12, window.innerWidth - rect.right) : 24),
          });
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
      }, [open]);

      // Focus the field on open, so the shortcut is one keystroke from typing.
      React.useLayoutEffect(() => {
        if (!open) return;
        const input = inputRef.current;
        if (input === null) return;
        input.focus();
        if (typeof input.select === "function") input.select();
      }, [open]);

      // A different Session is a different conversation: close rather than carry a
      // stale query and its highlights across the switch.
      const sessionRef = React.useRef(sessionId);
      React.useEffect(() => {
        if (sessionRef.current === sessionId) return;
        sessionRef.current = sessionId;
        closeRef.current();
      }, [sessionId]);

      // Publish the live handle for the global shortcut and the one-open-bar rule.
      React.useEffect(() => {
        const handle = handleRef.current;
        registry.set(handle, handle);
        return () => {
          registry.delete(handle);
        };
      }, []);

      const countLabel = report.invalid
        ? t("invalidPattern")
        : query === ""
          ? ""
          : report.total === 0
            ? t("noResults")
            : `${String(report.active + 1)}/${String(report.total)}${report.truncated ? "+" : ""}`;

      const announcement = report.invalid
        ? t("invalidPattern")
        : query === ""
          ? ""
          : report.total === 0
            ? t("noResults")
            : t("results", { active: report.active + 1, total: report.total });

      const onBarKeyDown = (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          step(event.shiftKey ? -1 : 1);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (event.key === "F3") {
          event.preventDefault();
          step(event.shiftKey ? -1 : 1);
        }
      };

      const trigger = h(
        "button",
        {
          key: "trigger",
          ref: buttonRef,
          type: "button",
          className: "dcs-trigger",
          "aria-label": t("open"),
          "aria-expanded": open ? "true" : "false",
          title: t("open"),
          onClick: toggle,
        },
        h(IconSearch, {}),
      );

      if (!open || typeof document === "undefined") return trigger;

      const bar = h(
        "div",
        {
          key: "bar",
          ref: barElementRef,
          className: "dcs-bar",
          role: "search",
          "data-chat-search-skip": "",
          "data-invalid": report.invalid ? "true" : undefined,
          style: { top: anchor.top, right: anchor.right },
          onKeyDown: onBarKeyDown,
        },
        h(
          "span",
          { key: "leading", className: "dcs-leading", "aria-hidden": "true" },
          h(IconSearch, {}),
        ),
        h("input", {
          key: "input",
          ref: inputRef,
          className: "dcs-input",
          type: "text",
          value: query,
          placeholder: t("placeholder"),
          "aria-label": t("placeholder"),
          "aria-invalid": report.invalid ? "true" : undefined,
          spellCheck: false,
          autoComplete: "off",
          autoCorrect: "off",
          autoCapitalize: "off",
          onChange: (event) => setQuery(event.target.value),
        }),
        h("span", { key: "divide-flags", className: "dcs-divider", "aria-hidden": "true" }),
        h(
          "button",
          {
            key: "case",
            type: "button",
            className: "dcs-btn dcs-toggle",
            "aria-pressed": caseSensitive ? "true" : "false",
            "aria-label": t("caseSensitive"),
            title: t("caseSensitive"),
            onClick: () => setCaseSensitive((value) => !value),
          },
          "Aa",
        ),
        h(
          "button",
          {
            key: "regex",
            type: "button",
            className: "dcs-btn dcs-toggle",
            "aria-pressed": regex ? "true" : "false",
            "aria-label": t("regex"),
            title: t("regex"),
            onClick: () => setRegex((value) => !value),
          },
          ".*",
        ),
        h("span", { key: "divide-count", className: "dcs-divider", "aria-hidden": "true" }),
        h(
          "span",
          {
            key: "count",
            className: "dcs-count",
            "data-empty": report.total === 0 ? "true" : undefined,
          },
          countLabel,
        ),
        h(
          "button",
          {
            key: "prev",
            type: "button",
            className: "dcs-btn",
            disabled: report.total === 0,
            "aria-label": t("prev"),
            title: t("prev"),
            onClick: () => step(-1),
          },
          h(IconChevronUp, {}),
        ),
        h(
          "button",
          {
            key: "next",
            type: "button",
            className: "dcs-btn",
            disabled: report.total === 0,
            "aria-label": t("next"),
            title: t("next"),
            onClick: () => step(1),
          },
          h(IconChevronDown, {}),
        ),
        h(
          "button",
          {
            key: "close",
            type: "button",
            className: "dcs-btn",
            "aria-label": t("close"),
            title: t("close"),
            onClick: close,
          },
          h(IconClose, {}),
        ),
        h(
          "span",
          { key: "announce", className: "dcs-announce", role: "status", "aria-live": "polite" },
          announcement,
        ),
      );

      return h(React.Fragment, null, trigger, createPortal(bar, document.body));
    }

    /** Bounding box of a resolved transcript column, or `null`. */
    function flowRect(flow) {
      if (flow === null || flow === undefined) return null;
      if (typeof flow.getBoundingClientRect !== "function") return null;
      return flow.getBoundingClientRect();
    }

    //#endregion

    //#region dictionaries

    /** Simplified Chinese dictionary; its key set is the source of truth. */
    const zh = {
      open: "\u5728\u5f53\u524d\u4f1a\u8bdd\u4e2d\u641c\u7d22",
      placeholder: "\u641c\u7d22\u672c\u4f1a\u8bdd\u7684\u804a\u5929\u5185\u5bb9",
      close: "\u5173\u95ed\u641c\u7d22",
      prev: "\u4e0a\u4e00\u4e2a\u5339\u914d",
      next: "\u4e0b\u4e00\u4e2a\u5339\u914d",
      caseSensitive: "\u533a\u5206\u5927\u5c0f\u5199",
      regex: "\u6b63\u5219\u8868\u8fbe\u5f0f",
      noResults: "\u65e0\u5339\u914d",
      invalidPattern: "\u8868\u8fbe\u5f0f\u65e0\u6548",
      results: "\u7b2c {active} / {total} \u4e2a\u5339\u914d",
    };

    /** English dictionary, key-identical to the Chinese source of truth. */
    const en = {
      open: "Search in this conversation",
      placeholder: "Search this conversation",
      close: "Close search",
      prev: "Previous match",
      next: "Next match",
      caseSensitive: "Match case",
      regex: "Regular expression",
      noResults: "No matches",
      invalidPattern: "Invalid pattern",
      results: "Match {active} of {total}",
    };

    //#endregion

    //#region plugin

    /** Services this browser half needs. */
    const inject = ["slots", "locale"];

    /**
     * Register the stylesheet, the dictionaries, the find shortcut, and the header
     * control.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        if (typeof document === "undefined" || document === null) return;
        if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) !== null) {
          return;
        }
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-plugin-chat-search";
        tag.dataset.pluginCss = CSS_TAG_ID;
        tag.textContent = STYLES;
        document.head.appendChild(tag);
        // The sheet outlives the plugin fiber on purpose, exactly as the shipped
        // bundles' stylesheets do: removing it would flash an unstyled bar on an HMR
        // re-activation while a find bar is open.
      }, "chat-search: stylesheet");

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "chat-search: dictionaries");

      ctx.effect(() => {
        /** Route Ctrl/Cmd+F to whichever resident conversation is being read. */
        const onKeyDown = (event) => {
          if (event.defaultPrevented) return;
          // Match the physical key so non-Latin layouts keep the shortcut; the letter
          // fallback keeps remapped layouts (for example Dvorak) working.
          if (event.code !== "KeyF" && event.key !== "f" && event.key !== "F") return;
          if (event.ctrlKey !== true && event.metaKey !== true) return;
          if (event.altKey === true) return;
          const target = pickSearchTarget();
          if (target === null) return;
          event.preventDefault();
          target.open();
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => document.removeEventListener("keydown", onKeyDown, true);
      }, "chat-search: find shortcut");

      ctx.slots.inject("conversation.session.header.utilities", () =>
        ctx.slots.register(
          {
            name: "conversation.session.header.utilities",
            id: "chat-search",
            order: 20,
            locale: NS,
            inject: () => ({}),
          },
          ChatSearchControl,
        ),
      );
    }

    //#endregion

    /**
     * Inert extras.
     *
     * The module loader reads `inject` and `apply`; everything here exists so the unit
     * tests can exercise the exact shipped artifact -- the pure matcher, the transcript
     * walk, and the shortcut's target selection -- with no browser and no second copy
     * of the logic.
     */
    const __internals = {
      NS,
      STYLES,
      CSS_TAG_ID,
      FLOW_ATTR,
      ROW_ATTR,
      MAX_MATCHES,
      MAX_PATTERN_LENGTH,
      DEBOUNCE_MS,
      HIGHLIGHT_ALL,
      HIGHLIGHT_ACTIVE,
      SKIP_TAGS,
      escapeRegExp,
      compileQuery,
      findInText,
      collectMatches,
      isSkippedElement,
      ownerRowKey,
      identityOf,
      rowElementOf,
      resolveFlow,
      revealAncestors,
      hitClientRect,
      scrollChain,
      scrollChainToHit,
      revealInBox,
      clampScroll,
      prefersReducedMotion,
      flowRect,
      pickSearchTarget,
      closeOtherBars,
      registry,
      toRanges,
      paintHighlights,
      clearHighlights,
      scrollToHit,
      ChatSearchControl,
      zh,
      en,
    };

    return { inject, apply, __internals };
  },
});
