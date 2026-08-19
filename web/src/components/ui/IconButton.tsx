import { forwardRef, type ButtonHTMLAttributes, type ReactElement } from 'react';
import Button from './Button';

interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'children'
> {
  icon: ReactElement;
  'aria-label': string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
}

/** Icon-only `Button`. `aria-label` is required in the type — an icon-only control has no text
 * content, so without it the button would ship with no accessible name. Forwards its ref to the
 * underlying `<button>` — a keyboard reorder control needs to move focus onto a specific button
 * after a state change, which only works if the DOM node is reachable from the caller. */
const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, ...rest },
  ref,
) {
  return (
    <Button ref={ref} {...rest}>
      {icon}
    </Button>
  );
});

export default IconButton;
