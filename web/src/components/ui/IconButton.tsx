import type { ButtonHTMLAttributes, ReactElement } from 'react';
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
 * content, so without it the button would ship with no accessible name. */
export default function IconButton({ icon, ...rest }: IconButtonProps) {
  return <Button {...rest}>{icon}</Button>;
}
