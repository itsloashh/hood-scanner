// Stock research data written by the Python engine (stocks/) into data/stocks in the repo.
import { rawJson } from './source';

const get = <T,>(path: string, fallback: T, _revalidate?: number) => rawJson<T>(`data/stocks/${path}`, fallback);

export type Row = {
  id: string;
  ticker: string;
  name: string | null;
  exchange: string;
  country: 'US' | 'CA';
  currency: string;
  sector: string | null;
  industry: string | null;
  model: string;
  cap: 'micro' | 'small' | 'mid' | 'large' | null;
  experimental: boolean;
  mcap: number | null;
  price: number;
  price_date: string;
  off_high: number | null;
  ret_3m: number | null;
  ret_1y: number | null;
  score: number;
  class: string;
  profile: 'value' | 'growth' | 'dividend';
  scores: Record<string, number>;
  confidence: number;
  risk: 'Low' | 'Moderate' | 'High' | 'Speculative';
  quarantined: boolean;
  flags: number;
  yield: number | null;
  pe: number | null;
  ev_ebitda: number | null;
  fcf_yield: number | null;
  rev_growth: number | null;
  insider_buyers_90d: number;
  inst_adds: number;
  upside: number | null;
  reward_risk: number | null;
  verified: boolean;
  dual_listed: boolean;
};

export type ComponentScore = { name: string; points: number; max: number; reasons: string[]; withheld: string[]; missing: string[]; not_applicable: string[] };
export type ProfileResult = { profile: string; score: number; class: string; components: Record<string, ComponentScore>; caps: string[]; version: string };
export type Valued = { value: number; start?: string | null; end: string; filed: string; form: string; accn: string; basis?: string; concept?: string; restated?: boolean };

export type Detail = {
  row: Row;
  security: { security_id: string; ticker: string; name: string; cik: string | null; exchange: string; country: string; listings: { ticker: string; exchange: string; currency: string; verified?: string }[]; former_names?: string[]; sic?: number; model: string };
  metrics: Record<string, number | null | string | object>;
  history_multiples: { years: { end: string; pe?: number; ps?: number; fcf_yield?: number }[]; pe_3y: number | null; pe_5y: number | null; ps_5y: number | null } | null;
  price_stats: Record<string, number | string | boolean | null>;
  results: Record<string, ProfileResult>;
  best_profile: string;
  why: string[];
  confidence: { confidence: number; notes: string[] };
  risk: { label: string; quarantine: string[]; review: string[] };
  scenarios: { available: boolean; why?: string; method?: string; horizon?: string; bear?: number; base?: number; bull?: number; upside_base?: number; downside_bear?: number; reward_risk?: number | null; assumptions?: string[]; invalidation?: string[] };
  dividends: { yield: number | null; why?: string; ttm_amount?: number; payments_12m?: number; years_paid?: number; cuts?: string[]; growth_5y?: number | null; history: { ex_date: string; amount: number }[] };
  insider: { buys: { insider: string; role: string; senior: boolean; date: string; filed: string; shares: number; price: number; value: number; owned_after: number | null; url: string }[]; buyers_30d: number; buyers_90d: number; buys_value_90d: number; sells_value_90d: number };
  institutional: { manager: string; change: string; pct_change: number | null; shares: number; shares_prev: number; weight: number; period: string; filed: string; text: string; source: string }[];
  holders_13dg: { form: string; filed: string; url: string }[];
  events: { item: string; type: string; text: string; filed: string; url: string }[];
  sources: { provider: string; url: string; reliability: string; publication_date: string | null; reporting_period: string | null; retrieved: string; verification: string; field?: string; concept?: string; form?: string }[];
  statements: (Record<string, Valued | number | boolean | null | Valued[] | string> & { annual_revenue?: Valued[]; annual_net_income?: Valued[]; annual_ocf?: Valued[] }) | null;
  chart: [string, number][];
  verification: Record<string, boolean | number | null>;
  eligibility: string;
  yahoo?: string;
  zones?: { at: number; price: number; swing: ZonePlan | null; scalp: ZonePlan | null } | null;
};
export type ZonePlan = { entry: number[]; stop: number; hold: number[]; tps: { label: string; price: number; rr: number | null; why?: string }[]; atr: number; basis: string };

export type Universe = { updated: string; count: number; rows: Row[] };
export type Etf = { id: string; ticker: string; label: string; currency: string; price: number; price_date: string; score: number; confidence: number; available: boolean; total_return_1y?: number; price_return_1y?: number; yield?: number | null; vol_1y?: number; max_dd_1y?: number; ret_3m?: number; nav_erosion?: boolean; chart?: [string, number][] };
export type Rotation = Record<string, { rel_1m: number; rel_3m: number; breadth_above_ma50: number | null; rel_volume: number | null; state: string }>;
export type Opportunities = { updated: string; score_version: string; by_profile: Record<string, string[]>; top: string[]; experimental_micro: string[]; quarantined: string[]; etfs: Etf[]; rotation: Rotation; sector_medians: Record<string, Record<string, number>> };
export type MacroReading = { label: string; unit?: string; source?: string; url?: string; status?: string; last?: number; date?: string; change?: number | null; direction?: string; reading?: string; stale?: boolean; yoy?: number | null; sector_impacts?: Record<string, number> };
export type Macro = { updated: string; readings: Record<string, MacroReading>; sector_tilt: Record<string, number>; usdcad: number | null };
export type Provider = { name: string; kind: string; status: string; why?: string; key?: string | null; cost?: string; coverage?: string; freshness?: string; limits?: string; licensing?: string; calls?: number; errors?: number; last_error?: string | null };
export type Health = { updated: string; error: string | null; minutes: number; stages: Record<string, { ok: boolean; sec: number; error?: string }>; providers: Record<string, Provider>; scored?: number };
export type Perf = { updated: string; candidates: { security_id: string; ticker: string; discovered: string; score: number; class: string; profile: string; cap: string; experimental: boolean; start_price: number; ret_30d: number | null; ret_90d: number | null; ret_total: number | null; bench_total: number | null; max_drawdown: number | null; status: string }[]; groups: Record<string, { n: number; avg_return: number | null; avg_excess: number | null; hit_rate: number | null }>; notes: string[] };
export type Backtest = { updated: string; buckets: Record<string, { n: number; avg_3m: number | null; excess_3m: number | null; hit_3m: number | null; avg_6m: number | null; excess_6m: number | null }>; dates: { date: string; n: number }[]; limits: string[]; weights: Record<string, number> };

export const loadUniverse = () => get<Universe>('universe.json', { updated: '', count: 0, rows: [] });
export const loadOpps = () => get<Opportunities | null>('opportunities.json', null);
export const loadMacro = () => get<Macro | null>('macro.json', null);
export const loadHealth = () => get<Health | null>('health.json', null, 120);
export const loadPerf = () => get<Perf | null>('performance.json', null);
export const loadBacktest = () => get<Backtest | null>('backtest.json', null);
export const loadDetail = (id: string) => get<Detail | null>(`sec/${encodeURIComponent(id)}.json`, null);

export const PROFILE_LABEL: Record<string, string> = { value: 'Value', growth: 'Growth', dividend: 'Dividend' };
export const COMPONENT_LABEL: Record<string, string> = {
  financial_health: 'Financial health',
  valuation: 'Undervaluation',
  institutional: 'Institutional',
  growth_catalysts: 'Growth & catalysts',
  market_sector: 'Market & sector',
  insider_strategic: 'Insider & strategic',
  data_quality: 'Data quality',
  income_quality: 'Income quality',
};

export function classTone(score: number) {
  return score >= 80 ? 'text-gold-2' : score >= 70 ? 'text-up' : score >= 60 ? 'text-info' : 'text-dim';
}
export function riskTone(r: string) {
  return r === 'Low' ? 'text-up' : r === 'Moderate' ? 'text-gold-2' : r === 'High' ? 'text-warn' : 'text-down';
}

export type StockAlertLog = { alert_id: string; security_id: string | null; alert_type: string; trigger_event: string | null; score: number | null; created_at: string; delivery_status: string };
export type StockRules = { updated: string; alert: Record<string, number>; eligibility: Record<string, number>; caps: Record<string, number>; classes: [number, string][]; score_version: string; dividend: Record<string, number>; managers: number };
export const loadStockAlerts = () => get<{ log: StockAlertLog[] } | null>('alerts.json', null);
export const loadStockRules = () => get<StockRules | null>('rules.json', null);
