/**
 * Dispatch of a saved prompt into an EXISTING agent pane (SWA-23). Exactly
 * the handoff brief's one-shot path — same holds (typing, agent working or
 * asking), same generation and liveness checks, never retried — so a prompt
 * can never land in a plain shell or submit text the user is typing. Only the
 * wording of the outcome differs: that path speaks of "the brief" in "the new
 * pane".
 */
import { deliverHandoffBrief, type AgentLivenessProbe, type HandoffDeliveryCallbacks } from '@/lib/handoff-delivery'

export function rewordForPrompt(message: string): string {
  return message
    .replace(/The new pane/g, 'The pane')
    .replace(/the new pane/g, 'the pane')
    .replace(/the brief/g, 'the prompt')
}

export function deliverSavedPrompt(
  terminalId: string,
  generation: number | undefined,
  text: string,
  cb: HandoffDeliveryCallbacks,
  probe?: AgentLivenessProbe
): () => void {
  return deliverHandoffBrief(
    terminalId,
    generation,
    text,
    {
      held: cb.held,
      delivered: cb.delivered,
      pasted: (reason) => cb.pasted(rewordForPrompt(reason)),
      failed: (error) => cb.failed(rewordForPrompt(error))
    },
    probe
  )
}
