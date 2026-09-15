import type { ButtonHTMLAttributes, ReactElement, Ref } from 'react';
import Button from './Button';

interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'children'
> {
  icon: ReactElement;
  'aria-label': string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  ref?: Ref<HTMLButtonElement>;
}

/** Icon-only `Button`. `aria-label` is required in the type — an icon-only control has no text
 * content, so without it the button would ship with no accessible name. Carries `btn--icon` so an
 * icon-only control keeps a minimum 24x24px hit target (WCAG 2.2 SC 2.5.8) independent of the icon
 * size a caller passes, rather than shrinking to fit whatever glyph is inside it. Passes its ref
 * through to `Button`'s underlying `<button>` — a keyboard reorder control needs to move focus onto
 * a specific button after a state change, which only works if the DOM node is reachable from the
 * caller. */
export default function IconButton({
  icon,
  ref,
  className,
  size = 'sm',
  ...rest
}: IconButtonProps) {
  return (
    <Button
      ref={ref}
      size={size}
      className={['btn--icon', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {icon}
    </Button>
  );
}
