/**
 * Screenshot paste for agent CLIs that cannot read an image off the Windows
 * clipboard themselves. The backend saves the clipboard image to a temp PNG;
 * this decides which panes get that treatment and what text to type. Claude
 * Code and Codex both attach an image whose path arrives as a (bracketed)
 * paste, so the path itself is the whole protocol.
 */

const IMAGE_PASTE_AGENTS = new Set(['claude-code', 'codex'])

/** Whether Ctrl+V with an image on the clipboard should paste it as a file for this pane. */
export function supportsImagePaste(agentId: string | undefined): boolean {
  return agentId !== undefined && IMAGE_PASTE_AGENTS.has(agentId)
}

/**
 * Text to paste for a saved image: the bare path, or double-quoted when it has
 * whitespace (both CLIs strip the quotes before checking for an image — the
 * same shape a terminal drag-drop produces). Ends with one space so the user
 * can keep typing the prompt. A path the quoting cannot carry yields `''`.
 */
export function imagePasteText(path: string): string {
  // A newline would submit the prompt mid-path; an embedded `"` would end the
  // quoted word early. Our own temp names never contain either.
  if (path === '' || /[\r\n"]/.test(path)) return ''
  return /\s/.test(path) ? `"${path}" ` : `${path} `
}
