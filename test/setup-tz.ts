// Every suite runs under UTC. This is load-bearing for the fixture determinism spec — zip
// entries store DOS timestamps encoded from local calendar fields, so the committed corpus only
// matches a regeneration when the zone is pinned. Keeping it global also stops any future
// date-formatting assertion from passing here and failing on a CI runner in another zone.
process.env.TZ = 'UTC';
