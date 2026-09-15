import { IconCheck } from '../icons';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

interface PasswordRulesProps {
  /** Lets a caller point the field's `aria-describedby` at this rule. */
  id?: string;
  password: string;
}

/** States the account password's exact constraint — `RegisterRequestDto` accepts 8-72 characters,
 * nothing else, no required symbol, digit, or case — before a submit attempt can reject it.
 * Marks the rule met once `password` satisfies it, so typing is its own feedback. The met state
 * is carried in the live region's text, not only the icon, so the region has a change to
 * announce. */
export default function PasswordRules({ id, password }: PasswordRulesProps) {
  const met = password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;

  return (
    <p id={id} className="field-hint" aria-live="polite">
      {met && <IconCheck size={12} />} {PASSWORD_MIN_LENGTH}-{PASSWORD_MAX_LENGTH} characters
      {met ? ' — met' : ''}
    </p>
  );
}
