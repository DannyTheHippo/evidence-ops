import { IconCheck } from '../icons';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

interface PasswordRulesProps {
  password: string;
}

/** States the account password's exact constraint — `RegisterRequestDto` accepts 8-72 characters,
 * nothing else, no required symbol, digit, or case — before a submit attempt can reject it.
 * Marks the rule met once `password` satisfies it, so typing is its own feedback. */
export default function PasswordRules({ password }: PasswordRulesProps) {
  const met = password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;

  return (
    <p className="field-hint" aria-live="polite">
      {met && <IconCheck size={12} />} {PASSWORD_MIN_LENGTH}-{PASSWORD_MAX_LENGTH} characters
    </p>
  );
}
