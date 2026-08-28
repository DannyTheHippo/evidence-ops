import mongoose from 'mongoose';
import {
  CanonicalEntity,
  CanonicalEntitySchema,
  type HarvestedAliasStatus,
} from '../../../../../src/database/schemas/evidence/canonical-entity/canonical-entity.schema';

const CanonicalEntityModel = mongoose.model<CanonicalEntity>(
  'CanonicalEntityHookOnly',
  CanonicalEntitySchema,
);

const buildHarvestedAlias = (status: HarvestedAliasStatus, alias = 'Property') => ({
  alias,
  aliasNormalized: alias.toLowerCase(),
  status,
  quote: `Northgate Business Park (the "${alias}")`,
  locator: { kind: 'pdf-page' as const, page: 4, extractorVersion: 'pdf-1' },
  documentVersionId: new mongoose.Types.ObjectId(),
  harvestedAt: new Date('2026-07-02T00:00:00.000Z'),
});

const buildEntity = (harvestedAliases: ReturnType<typeof buildHarvestedAlias>[] = []) =>
  new CanonicalEntityModel({
    tenantId: 'tenant-a',
    canonicalName: 'Northgate Business Park',
    aliases: ['Northgate Bus. Park'],
    harvestedAliases,
  });

describe('CanonicalEntity schema', () => {
  describe('the pre-validate hook that derives aliasesNormalized', () => {
    /**
     * Swept over the whole status set rather than sampled, because this one predicate is the only
     * thing standing between a harvested alias and tenant-wide fact regrouping: `applied` resolves,
     * everything else does not, and a status added later without a decision here would silently
     * start resolving.
     */
    const RESOLVES_BY_STATUS: Record<HarvestedAliasStatus, boolean> = {
      proposed: false,
      applied: true,
      revoked: false,
    };

    for (const [status, resolves] of Object.entries(RESOLVES_BY_STATUS)) {
      it(`${resolves ? 'folds' : 'does not fold'} a ${status} harvested alias into aliasesNormalized`, async () => {
        const entity = buildEntity([buildHarvestedAlias(status as HarvestedAliasStatus)]);

        await entity.validate();

        expect(entity.aliasesNormalized).toContain('northgate bus. park');
        expect(entity.aliasesNormalized.includes('property')).toBe(resolves);
      });
    }

    it('stops resolving by an applied alias once it is revoked', async () => {
      const entity = buildEntity([buildHarvestedAlias('applied')]);
      await entity.validate();
      expect(entity.aliasesNormalized).toContain('property');

      entity.harvestedAliases[0].status = 'revoked';
      await entity.validate();

      expect(entity.aliasesNormalized).not.toContain('property');
      // The entry itself survives, so a later harvest of the same definition sees it and leaves
      // the revocation standing rather than re-proposing.
      expect(entity.harvestedAliases).toHaveLength(1);
    });

    it('does not duplicate an alias an operator also authored', async () => {
      const entity = buildEntity([buildHarvestedAlias('applied', 'Northgate Bus. Park')]);

      await entity.validate();

      expect(entity.aliasesNormalized).toEqual(['northgate bus. park']);
    });

    it('derives the normalized forms from the display forms on every validate pass', async () => {
      const entity = buildEntity([buildHarvestedAlias('applied')]);
      await entity.validate();

      entity.canonicalName = 'Northgate  Business   Park II';
      entity.aliases = ['NORTHGATE II'];
      await entity.validate();

      expect(entity.canonicalNameNormalized).toBe('northgate business park ii');
      expect(entity.aliasesNormalized).toEqual(['northgate ii', 'property']);
    });
  });

  describe('validation (offline — no database connection)', () => {
    it('requires every field of a harvested alias', () => {
      const entity = buildEntity();
      entity.harvestedAliases.push({} as never);

      const error = entity.validateSync();

      // `validateSync` does not run `pre('validate')` middleware, so the hook-derived
      // `canonicalNameNormalized` is reported missing here too; only the subdocument's own
      // required paths are the subject of this assertion.
      const harvestedErrors = Object.keys(error?.errors ?? {})
        .filter((path) => path.startsWith('harvestedAliases.'))
        .sort();

      expect(harvestedErrors).toEqual([
        'harvestedAliases.0.alias',
        'harvestedAliases.0.aliasNormalized',
        'harvestedAliases.0.documentVersionId',
        'harvestedAliases.0.harvestedAt',
        'harvestedAliases.0.locator',
        'harvestedAliases.0.quote',
        'harvestedAliases.0.status',
      ]);
    });

    it('refuses a harvested alias status outside the declared set', () => {
      const entity = buildEntity([
        { ...buildHarvestedAlias('applied'), status: 'auto-approved' as never },
      ]);

      expect(entity.validateSync()?.errors['harvestedAliases.0.status']).toBeDefined();
    });

    it('defaults harvestedAliases to an empty array', () => {
      const entity = new CanonicalEntityModel({
        tenantId: 'tenant-a',
        canonicalName: 'Northgate Business Park',
      });

      expect(entity.harvestedAliases).toEqual([]);
    });
  });
});
