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
