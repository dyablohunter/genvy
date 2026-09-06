import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Estimated AI spend ledger, per provider, persisted at `library/usage.json`
 * (the library ROOT — WIPE ALL clears assets/ and files/ but the spend
 * history survives). All figures are estimates from published pricing, not
 * billing data.
 */

export interface ProviderUsage {
  cents: number;
  calls: number;
  /** Account balance the provider last reported, in cents (when it does). */
  balanceCents?: number;
  /** True once any call's cost came from the provider instead of an estimate. */
  exact?: boolean;
}

class UsageTracker {
  private totals: Record<string, ProviderUsage> = {};
  private file = '';
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  async init(libraryDir: string) {
    this.file = path.join(libraryDir, 'usage.json');
    try {
      this.totals = JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, ProviderUsage>;
    } catch {
      this.totals = {};
    }
  }

  /** Record one call's estimated cost (in cents). */
  add(provider: string, cents: number) {
    const entry = (this.totals[provider] ??= { cents: 0, calls: 0 });
    entry.cents += cents;
    entry.calls += 1;
    this.scheduleSave();
  }

  /**
   * Record what the provider says a call actually cost, plus the balance it
   * reports. Reported figures replace the estimate for that call.
   */
  addExact(provider: string, info: { cents?: number; balanceCents?: number }) {
    const entry = (this.totals[provider] ??= { cents: 0, calls: 0 });
    if (info.cents !== undefined) {
      entry.cents += info.cents;
      entry.calls += 1;
      entry.exact = true;
    }
    if (info.balanceCents !== undefined) entry.balanceCents = info.balanceCents;
    this.scheduleSave();
  }

  snapshot(): { providers: ({ id: string } & ProviderUsage)[]; totalCents: number } {
    const providers = Object.entries(this.totals).map(([id, u]) => ({ id, ...u }));
    return { providers, totalCents: providers.reduce((sum, p) => sum + p.cents, 0) };
  }

  private scheduleSave() {
    if (this.writeTimer || !this.file) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void fs.writeFile(this.file, JSON.stringify(this.totals, null, 2)).catch(() => {
        /* spend ledger is best-effort */
      });
    }, 500);
  }
}

export const usage = new UsageTracker();

/**
 * DeepSeek pricing (deepseek-chat, cache miss): ~$0.27/M input, ~$1.10/M
 * output tokens. Returns cents; falls back to a flat estimate when the API
 * response carried no usage block.
 */
export function deepseekCostCents(promptTokens?: number, completionTokens?: number): number {
  if (promptTokens === undefined && completionTokens === undefined) return 0.05;
  return ((promptTokens ?? 0) * 27 + (completionTokens ?? 0) * 110) / 1e6;
}
