// 称号の判定（設定値 title_rules を受け取る純粋な関数）
import type { TitleRule } from "../settings/definitions";

export interface RunnerStats {
  monthlyRuns: number;
  totalRuns: number;
  avgRating: number | null;
}

export function earnedTitles(rules: Record<string, TitleRule>, s: RunnerStats): string[] {
  return Object.entries(rules)
    .filter(([, r]) => {
      if (r.monthly_runs != null && s.monthlyRuns < r.monthly_runs) return false;
      if (r.total_runs != null && s.totalRuns < r.total_runs) return false;
      if (r.min_avg_rating != null && (s.avgRating == null || s.avgRating < r.min_avg_rating)) return false;
      return true;
    })
    .map(([name]) => name);
}
