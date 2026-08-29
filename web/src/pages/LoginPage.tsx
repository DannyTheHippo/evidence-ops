import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, register } from '../api/client';
import AuthCanvas from '../components/AuthCanvas';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import PasswordInput from '../components/ui/PasswordInput';
import PasswordRules, {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../components/ui/PasswordRules';
import { useFormSubmit } from '../lib/use-form-submit';

type Mode = 'login' | 'signup';
type Field = 'email' | 'password';

// A cheap client-side format check only — the server is the real authority on what counts as a
// valid email, and rejects anything this lets through.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface CredentialsFormProps {
  mode: Mode;
  email: string;
  onEmailChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
}

/**
 * The email/password fields and their submit lifecycle, keyed on `mode` by its caller so
 * switching between sign-in and account creation always starts `useFormSubmit` fresh — no stale
 * error or touched field survives the toggle. Email and password values live in the parent
 * instead, so a value already typed survives the same toggle.
 */
function CredentialsForm({
  mode,
  email,
  onEmailChange,
  password,
  onPasswordChange,
}: CredentialsFormProps) {
  const navigate = useNavigate();

  function validate(): Partial<Record<Field, string>> {
    const errors: Partial<Record<Field, string>> = {};
    if (!email.trim()) errors.email = 'Email is required.';
    else if (!EMAIL_PATTERN.test(email)) errors.email = 'Enter a valid email address.';

    if (!password) {
      errors.password = 'Password is required.';
    } else if (
      // Length is a signup-only constraint — refusing to attempt a sign-in because the stored
      // password happens to be short would reject a credential the server itself accepts.
      mode === 'signup' &&
      (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH)
    ) {
      errors.password = `Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters.`;
    }
    return errors;
  }

  async function submit() {
    if (mode === 'signup') await register(email, password);
    await login(email, password);
    await navigate('/');
  }

  const { pending, formError, onSubmit, fieldProps } = useFormSubmit<Field>({
    validate,
    submit,
  });

  return (
    <>
      {formError && (
        <p className="error" role="alert">
          {formError}
        </p>
      )}
      <form onSubmit={onSubmit} className="form" noValidate>
        <Input
          {...fieldProps('email')}
          label="Email"
          type="email"
          value={email}
          onChange={onEmailChange}
          autoComplete="email"
        />
        <div className="field">
          <PasswordInput
            {...fieldProps('password')}
            label="Password"
            value={password}
            onChange={onPasswordChange}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
          {mode === 'signup' && <PasswordRules password={password} />}
        </div>
        <Button type="submit" variant="primary" className="auth-submit">
          {pending
            ? mode === 'login'
              ? 'Signing in…'
              : 'Creating account…'
            : mode === 'login'
              ? 'Sign in'
              : 'Create an account'}
        </Button>
      </form>
    </>
  );
}

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);

  function toggleMode() {
    setMode((current) => (current === 'login' ? 'signup' : 'login'));
    // Scheduled for the next frame, matching useFormSubmit's own scheduleFocus: the title text
    // only reflects the new mode once this render commits.
    requestAnimationFrame(() => headingRef.current?.focus());
  }

  return (
    <AuthCanvas
      title={mode === 'login' ? 'Sign in' : 'Create an account'}
      ref={headingRef}
      footer={
        <Button type="button" variant="ghost" onClick={toggleMode}>
          {mode === 'login' ? 'Need an account? Create one' : 'Have an account? Sign in'}
        </Button>
      }
    >
      <CredentialsForm
        key={mode}
        mode={mode}
        email={email}
        onEmailChange={setEmail}
        password={password}
        onPasswordChange={setPassword}
      />
    </AuthCanvas>
  );
}
