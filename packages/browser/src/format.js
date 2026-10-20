/**
 * Model-facing text for tool results.
 *
 * @module dsh-plugin-browser/format
 */

/** Render one tab line. */
function tabLine(tab) {
  const flags = [tab.active ? 'active' : '', tab.lifecycle && tab.lifecycle !== 'active' ? tab.lifecycle : '']
    .filter(Boolean)
    .join(', ')
  const suffix = flags ? ` (${flags})` : ''
  const title = tab.title ? ` — ${tab.title}` : ''
  return `${tab.tabId}${suffix}: ${tab.url || 'about:blank'}${title}`
}

/** Render a tab list. */
export function formatTabs(tabs, activeTabId) {
  if (!tabs || tabs.length === 0) return 'No browser tabs are open.'
  const lines = tabs.map((tab) => tabLine(tab))
  if (activeTabId) lines.push(`\nActive: ${activeTabId}`)
  return lines.join('\n')
}

/** Render a freshly opened tab. */
export function formatOpen(tab) {
  return `Opened ${tab.tabId}\nURL: ${tab.url || 'about:blank'}\nTitle: ${tab.title || '(none)'}`
}

/** Render an action result. */
export function formatAction(result) {
  const target = result.target ? ` ${result.target}` : ''
  const lines = [`Done: ${result.action}${target}`, `URL: ${result.url}`, `Title: ${result.title || '(none)'}`]
  if (result.value !== undefined) {
    lines.push(`Value: ${typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2)}`)
  }
  return lines.join('\n')
}

/** Render a download list. */
export function formatDownloads(downloads) {
  if (!downloads || downloads.length === 0) return 'No downloads were observed for this tab.'
  return downloads
    .map((entry) => {
      if (entry.state === 'saved') {
        return `${entry.id}: saved ${entry.bytes} bytes → ${entry.path}`
      }
      return `${entry.id}: ${entry.state}${entry.error ? ` (${entry.error})` : ''}`
    })
    .join('\n')
}

/** Render a pending dialog. */
export function formatDialog(dialog) {
  if (!dialog) return 'No JavaScript dialog is pending.'
  const lines = [`${dialog.type}: ${dialog.message}`]
  if (dialog.defaultValue !== undefined) lines.push(`Default: ${dialog.defaultValue}`)
  lines.push('Call browser_dialog with accept or dismiss to continue.')
  return lines.join('\n')
}

/** Render a screenshot result. */
export function formatCapture(result) {
  return `Screenshot saved to: ${result.path}\n${result.bytes} bytes (${result.kind})\nOpen it with your image reader when visual layout matters.`
}

/** Render a recording result. */
export function formatRecording(result) {
  return `Recording saved to: ${result.path}\n${result.bytes} bytes, ${result.actions} action(s)`
}

/** Render a download save result. */
export function formatSavedDownload(result) {
  return `Saved to: ${result.path}\n${result.bytes} bytes`
}

/** Render a headed/headless view toggle. */
export function formatView(result) {
  if (!result.changed) {
    return `Browser window is already ${result.visible ? 'visible' : 'hidden'}.`
  }
  const restored = result.restored > 0 ? `; reopened ${result.restored} tab(s)` : ''
  return `Browser window ${result.visible ? 'shown as a separate Chrome window' : 'hidden (headless)'}${restored}.`
}
