type AnnouncementListener = (message: string) => void;

const listeners = new Set<AnnouncementListener>();

export function subscribeAnnouncements(listener: AnnouncementListener): void {
  listeners.add(listener);
}

export function unsubscribeAnnouncements(listener: AnnouncementListener): void {
  listeners.delete(listener);
}

/**
 * Publishes `message` to every subscribed listener — normally the single mounted `Announcer` —
 * for a screen reader to speak. Module-scope pub/sub, matching `toast.ts`, rather than component
 * state: the caller announcing a page title or an action's outcome usually sits far from
 * `Announcer` in the tree. Fans out every call, including an identical repeat — the listener
 * decides how to make a repeat audible.
 */
export function announce(message: string): void {
  for (const listener of listeners) listener(message);
}

// Test-only reset of the module-scope listener set.
export function clearAnnouncements(): void {
  listeners.clear();
}
