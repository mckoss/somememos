// Report formatting. The default output is aggregates only (metrics per
// setting and case counts), which is what may be recorded in this public
// repository. Per-case detail is included only when asked for, and is private
// when the data is real.

import type { Aggregate } from './metrics.js';
import type { EvalReport } from './replay.js';

export interface FormatOptions {
  /** Which aggregate to show: every case (default), orientation cases or search cases. */
  readonly subset?: 'all' | 'orientation' | 'search';
  /** Digits after the decimal point. Default 3. */
  readonly digits?: number;
}

/** The aggregate table as aligned plain text: one row per setting. */
export function formatReportText(report: EvalReport, options: FormatOptions = {}): string {
  const subset = options.subset ?? 'all';
  const digits = options.digits ?? 3;
  const header = ['setting', ...report.ks.map((k) => `R@${k}`), 'MRR', 'cases', 'skipped'];
  const rows = report.settings.map((s) => {
    const a: Aggregate = s[subset];
    return [
      s.name,
      ...report.ks.map((k) => (a.recall[k] ?? 0).toFixed(digits)),
      a.mrr.toFixed(digits),
      String(a.cases),
      String(a.skipped),
    ];
  });
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] as string).length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) =>
        i === 0 ? cell.padEnd(widths[i] as number) : cell.padStart(widths[i] as number),
      )
      .join('  ')
      .trimEnd();
  return (
    [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n') + '\n'
  );
}

export interface JsonOptions {
  /** Include per-case detail if the report has it. Default false. PRIVATE when the data is real. */
  readonly includeDetail?: boolean;
}

/** The report as a JSON-ready object: aggregates only unless `includeDetail`. */
export function reportToJson(report: EvalReport, options: JsonOptions = {}): unknown {
  const out: Record<string, unknown> = {
    ks: [...report.ks],
    settings: report.settings.map((s) => ({
      name: s.name,
      all: s.all,
      orientation: s.orientation,
      search: s.search,
    })),
  };
  if (options.includeDetail && report.detail) out.detail = report.detail;
  return out;
}
