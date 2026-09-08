import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * `git check-ignore -q` exits 0 when the path is ignored, 1 when it is not, and above 1 on a real
 * error (not a git repo, bad arguments) — the three cases this function distinguishes rather than
 * collapsing "not ignored" and "git failed" into one caught exception.
 */
function isGitIgnored(relativePath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', relativePath], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) {
      return false;
    }
    throw error;
  }
}

/**
 * `.gitignore`'s `/eval/benchmark/` rule is a confidentiality control, not a convenience one — a
 * cache entry or results row under the benchmark lane (`eval/run.ts`'s `--lane benchmark`) can embed
 * a client document's content, and that must never reach a commit even if nobody remembers to check
 * before staging. Asserted here, not just declared in `.gitignore`, because an ignore rule nobody
 * has verified is exactly the failure this repo already has a written decision record about — an
 * "inertness pin" that turned out to pin nothing.
 */
describe('.gitignore — benchmark eval lane boundary', () => {
  it('ignores a model cache entry under the benchmark lane', () => {
    expect(isGitIgnored('eval/benchmark/cache/model/deadbeef.json')).toBe(true);
  });

  it('ignores an embedding cache entry under the benchmark lane', () => {
    expect(isGitIgnored('eval/benchmark/cache/embedding/deadbeef.json')).toBe(true);
  });

  it('ignores a results file under the benchmark lane', () => {
    expect(isGitIgnored('eval/benchmark/results/abc1234.json')).toBe(true);
  });

  // Control case: without this, a passing test above would prove nothing — a rule that ignored all
  // of `eval/` (or all of the repo) would pass the same assertions for the wrong reason. The
  // synthetic lane's cache and results are meant to stay tracked, so the rule must be scoped to
  // `eval/benchmark/` specifically, not `eval/` as a whole.
  it('does not ignore the synthetic lane cache and results', () => {
    expect(isGitIgnored('eval/cache/model/deadbeef.json')).toBe(false);
    expect(isGitIgnored('eval/results/abc1234.json')).toBe(false);
  });
});

/**
 * The public eval lane (`eval/run.ts`'s `--lane public`) fetches SEC EDGAR filings and ingests them
 * through the eval harness path — the fetched bytes, the XBRL companyfacts JSON, the ingest ledger
 * and every cache entry can only ever be reproduced by re-fetching or re-recording, so none of them
 * may reach a commit even if nobody remembers to check before staging. The dataset, both manifests
 * and clean-sha results stay tracked deliberately — the claims rewrite (ADR-0024's successor) cites
 * them.
 */
describe('.gitignore — public eval lane boundary', () => {
  it('ignores a fetched filing under the public corpus', () => {
    expect(isGitIgnored('eval/public/corpus/0000000001/0000000001-25-000001/x.htm')).toBe(true);
  });

  it('ignores a companyfacts XBRL file under the public corpus', () => {
    expect(isGitIgnored('eval/public/corpus/xbrl/CIK0000000001.json')).toBe(true);
  });

  it('ignores the ingest ledger', () => {
    expect(isGitIgnored('eval/public/corpus/ingest-ledger.json')).toBe(true);
  });

  it('ignores a model cache entry under the public lane', () => {
    expect(isGitIgnored('eval/public/cache/model/deadbeef.json')).toBe(true);
  });

  it('ignores a dirty-sha results file under the public lane', () => {
    expect(isGitIgnored('eval/public/results/abc-dirty.json')).toBe(true);
  });

  // Control cases: the dataset, both manifests, a clean-sha results file and the pre-registered
  // bars must stay tracked — the claims rewrite in Phase 5's final steps cites all of them.
  it('does not ignore the public dataset, manifests, clean-sha results, or bars.json', () => {
    expect(isGitIgnored('eval/public/dataset/cases.json')).toBe(false);
    expect(isGitIgnored('eval/public/dataset/manifest.json')).toBe(false);
    expect(isGitIgnored('eval/public/corpus-manifest.json')).toBe(false);
    expect(isGitIgnored('eval/public/results/abc1234.json')).toBe(false);
    expect(isGitIgnored('eval/public/results/verifier/run-1/summary.md')).toBe(false);
    expect(isGitIgnored('eval/public/bars.json')).toBe(false);
  });
});
