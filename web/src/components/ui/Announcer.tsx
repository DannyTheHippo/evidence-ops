import { useEffect, useRef, useState, type ReactElement } from 'react';

interface AnnouncerProps {
  /** Subscribes the region to an announcement store. Omitted, the region mounts and announces
   * nothing — the shell supplies the store. */
  subscribe?: (listener: (message: string) => void) => void;
  unsubscribe?: (listener: (message: string) => void) => void;
}

/**
 * Single screen-reader live region for the whole app, mounted once beside `Toaster`. A screen
 * reader does not re-announce an unchanged live-region text node, so a repeated identical message
 * toggles a trailing zero-width space to force a text mutation on every announcement.
 */
export default function Announcer({ subscribe, unsubscribe }: AnnouncerProps = {}): ReactElement {
  const [message, setMessage] = useState('');
  const lastMessage = useRef<string | null>(null);
  const repeated = useRef(false);

  useEffect(() => {
    if (!subscribe || !unsubscribe) return undefined;

    const listener = (next: string) => {
      repeated.current = next === lastMessage.current ? !repeated.current : false;
      lastMessage.current = next;
      setMessage(repeated.current ? `${next}\u200b` : next);
    };

    subscribe(listener);
    return () => unsubscribe(listener);
  }, [subscribe, unsubscribe]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
