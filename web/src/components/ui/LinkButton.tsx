import type { AnchorHTMLAttributes, ReactNode, Ref } from 'react';
import { Link } from 'react-router-dom';

interface LinkButtonBaseProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLAnchorElement>;
}

type LinkButtonProps = LinkButtonBaseProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'className' | 'children'> &
  ({ to: string; href?: never } | { to?: never; href: string });

const variantClass: Record<NonNullable<LinkButtonBaseProps['variant']>, string> = {
  primary: 'btn--primary',
  secondary: 'btn--secondary',
  ghost: 'btn--ghost',
  danger: 'btn--danger',
};

/** Anchor-rendering counterpart to `Button`, styled from the same `.btn` family, for a navigation
 * action rather than an in-page one. Renders a react-router `<Link>` given `to` (in-app
 * navigation) or a plain `<a>` given `href` (an external destination, a `mailto:` link, or a file
 * download) — a caller supplies exactly one of the two. */
export default function LinkButton({
  variant = 'primary',
  size = 'md',
  to,
  href,
  className,
  children,
  ref,
  ...rest
}: LinkButtonProps) {
  const classes = ['btn', variantClass[variant], size === 'sm' ? 'btn--sm' : null, className]
    .filter(Boolean)
    .join(' ');

  if (to) {
    return (
      <Link to={to} className={classes} ref={ref} {...rest}>
        {children}
      </Link>
    );
  }

  return (
    <a href={href} className={classes} ref={ref} {...rest}>
      {children}
    </a>
  );
}
