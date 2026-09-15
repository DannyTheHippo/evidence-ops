import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode, Ref } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  /** Sets `aria-busy` and swaps the label to `busyLabel`. The button stays focusable and
   * enabled — `disabled` while focused drops focus to <body>; a busy button guards its own
   * `onClick` instead. */
  busy?: boolean;
  busyLabel?: string;
  children: ReactNode;
  // Not typed by ButtonHTMLAttributes — declared explicitly so a caller can reach this
  // component's underlying DOM node, e.g. to move focus onto it after a state change.
  ref?: Ref<HTMLButtonElement>;
}

const variantClass: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'btn--primary',
  secondary: 'btn--secondary',
  ghost: 'btn--ghost',
  danger: 'btn--danger',
};

/** Native `<button>` styled from the `.btn` family in `primitives.css`. Defaults to
 * `type="button"` so a button placed inside a form never submits unless the caller opts in. */
export default function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  className,
  children,
  busy = false,
  busyLabel,
  onClick,
  ref,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    variantClass[variant],
    size === 'sm' ? 'btn--sm' : null,
    busy ? 'btn--busy' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const handleClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    if (busy) return;
    onClick?.(event);
  };

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      aria-busy={busy || undefined}
      onClick={handleClick}
      {...rest}
    >
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}
