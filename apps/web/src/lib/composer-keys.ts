export interface EnterKeyEvent {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}

/**
 * True when an Enter keypress should submit the composer: plain Enter, not
 * Shift+Enter (newline), and not a keystroke that commits an IME composition
 * (isComposing is true while a CJK candidate is being selected — sending on
 * it would submit a half-composed string and clobber the textarea).
 */
export function isSendKey(e: EnterKeyEvent): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing;
}
