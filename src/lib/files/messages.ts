// Adapted from parsingk/Astera, debc3098; Apache-2.0. See third-party-licenses/Astera/.
export interface Message { key: string; params?: Record<string, string | number> }
const messages: Record<string, string> = {
  'files.validate.empty': 'Enter a name.', 'files.validate.reserved': 'This name is reserved.',
  'files.validate.separator': 'Use a name without path separators.', 'files.validate.badChar': 'The name contains an invalid character.',
  'files.validate.windowsReserved': 'This name is reserved on Windows.', 'files.validate.trailing': 'Names cannot end with a space or period.',
  'files.validate.tooLong': 'The name is too long.', 'files.move.intoSelf': 'Cannot move a folder into itself.',
  'files.move.alreadyThere': 'The item is already in that folder.', 'files.copy.intoSelf': 'Cannot copy a folder into itself.'
}
export const messageText = (message: Message): string => messages[message.key] ?? message.key
