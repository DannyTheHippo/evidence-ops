import { useCopyToClipboard } from '../../lib/use-copy-to-clipboard';
import { IconCopy } from '../icons';
import Button from './Button';
import IconButton from './IconButton';

interface CopyButtonProps {
  text: string;
  label?: string;
  /** Renders an icon-only control with `label` as its `aria-label` instead of visible text. */
  iconOnly?: boolean;
}

/** `Button` wrapping `useCopyToClipboard`, the shared "Copy" affordance for a minted token or
 * invite link. A missing Clipboard API and a rejected write both land on the hook's `error`, which
 * relabels the button rather than leaving it looking like the copy succeeded — the button never
 * appears to work when it did not. The label swap alone is visual only, so a visually-hidden
 * `role="status"` region announces the same outcome for a screen reader. */
function CopyButtonForText({ text, label = 'Copy', iconOnly = false }: CopyButtonProps) {
  const { copied, error, copy } = useCopyToClipboard();

  const buttonLabel = copied ? 'Copied' : error ? 'Copy failed' : label;
  const announcement = copied
    ? 'Copied to clipboard.'
    : error
      ? 'Could not copy to clipboard.'
      : '';

  return (
    <>
      {iconOnly ? (
        <IconButton
          icon={<IconCopy />}
          aria-label={buttonLabel}
          variant="secondary"
          size="sm"
          onClick={() => copy(text)}
        />
      ) : (
        <Button variant="secondary" size="sm" onClick={() => copy(text)}>
          <IconCopy />
          {buttonLabel}
        </Button>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}

/** Keys `CopyButtonForText` on `text` so its copied/failed state resets whenever the value to copy
 * changes. `useCopyToClipboard`'s state lives inside that hook, out of this component's reach — a
 * caller that swaps in a freshly rotated token onto an already-mounted button would otherwise keep
 * showing "Copied" from the previous value. Changing `key` forces React to unmount the stale
 * instance and mount a fresh one instead, which is a full reset. */
export default function CopyButton(props: CopyButtonProps) {
  return <CopyButtonForText key={props.text} {...props} />;
}
