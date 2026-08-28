import { useCopyToClipboard } from '../../lib/use-copy-to-clipboard';
import { IconCopy } from '../icons';
import Button from './Button';

interface CopyButtonProps {
  text: string;
  label?: string;
}

/** `Button` wrapping `useCopyToClipboard`, the shared "Copy" affordance for a minted token or
 * invite link. A missing Clipboard API and a rejected write both land on the hook's `error`, which
 * relabels the button rather than leaving it looking like the copy succeeded — the button never
 * appears to work when it did not. The label swap alone is visual only, so a visually-hidden
 * `role="status"` region announces the same outcome for a screen reader. */
export default function CopyButton({ text, label = 'Copy' }: CopyButtonProps) {
  const { copied, error, copy } = useCopyToClipboard();

  const buttonLabel = copied ? 'Copied' : error ? 'Copy failed' : label;
  const announcement = copied
    ? 'Copied to clipboard.'
    : error
      ? 'Could not copy to clipboard.'
      : '';

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => copy(text)}>
        <IconCopy />
        {buttonLabel}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}
