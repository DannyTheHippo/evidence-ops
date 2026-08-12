// Stricter than the global default throttler bucket (`config.throttle`, shared with e.g.
// `/health`): this is the one irreversible human-judgement boundary in the system, so it gets its
// own tighter limit rather than sharing headroom with unrelated read traffic. Deliberately not a
// new env var — that would cost the six-place configuration checklist (`contexts/configuration.md`)
// for a value that has no reason to differ across environments.
export const APPROVAL_DECISION_THROTTLE_LIMIT = 10;
