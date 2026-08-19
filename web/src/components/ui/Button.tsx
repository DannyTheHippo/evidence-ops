import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  children: ReactNode;
  // Not typed by ButtonHTMLAttributes — declared explicitly so IconButton can forward its own
  // ref through to this component's underlying DOM node.
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
  ref,
  ...rest
}: ButtonProps) {
  const classes = ['btn', variantClass[variant], size === 'sm' ? 'btn--sm' : null, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button ref={ref} type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
