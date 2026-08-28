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
 * content, so without it the button would ship with no accessible name. Passes its ref through to
 * `Button`'s underlying `<button>` — a keyboard reorder control needs to move focus onto a
 * specific button after a state change, which only works if the DOM node is reachable from the
 * caller. */
export default function IconButton({ icon, ref, ...rest }: IconButtonProps) {
  return (
    <Button ref={ref} {...rest}>
      {icon}
    </Button>
  );
}
