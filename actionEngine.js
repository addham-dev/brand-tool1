/* ═══════════════════════════════════════════════════════════════════
   actionEngine.js — Hasbro KAM Action Engine (Phase 1)
   Deterministic port of "Amazon Vendor KAM Intelligence Report v3.0".
   One primary action per ASIN — first match wins, no blanks.

   HARD RULES (keep — from handoff):
   1. One action per ASIN — first match wins, no blanks.
   2. Never recommend deals or ads on negative-PPM items (Phase 2+ — no PPM yet).
   3. Never raise a PO for a discontinued item (Phase 3+ — no line plan yet).
   4. New launches: traffic not discounts — no deals in first 90 days
      (exception: Forward WoC > 20).
   5. Forward WoC drives actions; trailing WoC is context.
      (Phase 1: no sellable_onhand column exists — availability uses the
       OOS%/unfilled proxy; WoC & PO Required unlock with Phase 3 inventory.)
   6. Zero units in an OOS week = missing demand signal, not zero demand —
      excluded from demand averages.
   7. Traffic and conversion are separate problems: high GV + low CVR =
      content/price/reviews; low GV + high CVR = ads/traffic.

   ANALYTICAL PRINCIPLES (engine comments, verbatim intent):
   - The plan already accounts for seasonality — behind plan is real, not timing.
   - Aged stock is cash tied up incurring fees (Phase 3).
   - Ad format efficiency varies — quote actual ROAS where it exists,
     never generic format preference. (Phase 1: ads are brand+market grain,
     so per-ASIN recs use the documented no-performance-data fallback table
     and brand ROAS is shown as context.)
   - Zero PPM with zero revenue is missing data (Phase 2).
   - Divide-by-zero: LY=0 → "new", never an error. No NaN into payloads.
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── CONFIG — every threshold lives here. Per-market overrides via
      CONFIG.markets[MKT] = { KEY: value }. Calibrate after first run. ── */
var CONFIG = {
  // Demand forecasting
  FORECAST_WEEKS: 4,             // recency-weighted window
  FORECAST_WEIGHTS: [4, 3, 2, 1],// newest → oldest
  OOS_EXCLUDE_PCT: 50,           // weeks with oos_pct ≥ this are excluded from demand
  TREND_WEEKS: 6,                // last 6 vs prior 6 revenue
  TREND_CAP_LOW: 0.7,
  TREND_CAP_HIGH: 1.5,
  SEASONALITY_DEFAULT: 1.0,      // hook — prior-year uplift lands later

  // Tier 1 — availability (OOS-proxy, no SOH column in Phase 1)
  OOS_CRITICAL_PCT: 95,          // effectively out of stock all week
  OOS_HIGH_PCT: 50,              // out of stock most of the week
  MIN_WEEKLY_REV_FOR_OOS: 100,   // € recent weekly revenue for OOS to matter
  MIN_UNFILLED_FOR_ESCALATION: 50,

  // Tier 5 — conversion
  CVR_ACTION_MAX: 5,             // % — below this, conversion action
  CVR_CRITICAL: 3,               // % — below this, High severity
  CVR_MIN_WEEKLY_GV: 150,        // enough traffic for CVR to be meaningful

  // Tier 6 — traffic
  GV_LOW_WEEKLY: 100,            // low traffic threshold
  GV_DECENT_CVR: 4,              // % — converts fine when traffic arrives
  GV_MIN_WEEKLY_REV: 250,        // € — revenue worth defending
  GV_DROP_PCT: 0.30,             // >30% drop vs trend → suppression check
  GV_DROP_MAX_GV: 600,           // only investigate drops on smaller-traffic ASINs

  // Tier 8 — inferred launch (proper detection is Phase 3 line plan)
  LAUNCH_WINDOW_WEEKS: 8,        // ≈60 days at weekly grain

  // General
  MIN_WEEKLY_REV_FOR_ACTION: 50, // € — below this, Monitor regardless
  TARGET_WOC: 8,                 // reserved for Phase 3 (needs SOH)

  markets: {}                    // e.g. { FR: { CVR_ACTION_MAX: 4 } }
};

function cfgFor(market) {
  var o = CONFIG.markets[market] || {};
  var out = {};
  Object.keys(CONFIG).forEach(function (k) { if (k !== 'markets') out[k] = (k in o) ? o[k] : CONFIG[k]; });
  return out;
}

function n(v) { var x = Number(v); return isFinite(x) ? x : 0; } // NaN-proof
function fmtEuro(v) { v = n(v); return v >= 1e6 ? '€' + (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? '€' + (v / 1e3).toFixed(1) + 'K' : '€' + Math.round(v); }

/* ── Series aggregation ─────────────────────────────────────────────
   rows: snapshot rows for ONE market, any number of weeks, ASIN-mixed.
   Returns map asin → { asin, title, brand, weeks:[{ws,rev,units,gv,oos,unfilled,ordRev,ordUnits}] sorted ASC } */
function buildSeries(rows) {
  var byAsin = {};
  rows.forEach(function (r) {
    if (!r || !r.asin) return;
    var a = byAsin[r.asin] || (byAsin[r.asin] = { asin: r.asin, title: r.product_title || '', brand: r.brand_classified || 'OTHER', weeks: {} });
    if (!a.title && r.product_title) a.title = r.product_title;
    var w = a.weeks[r.week_start] || (a.weeks[r.week_start] = { ws: r.week_start, rev: 0, units: 0, gv: 0, oos: 0, oosN: 0, unfilled: 0, ordRev: 0, ordUnits: 0 });
    w.rev += n(r.dispatched_revenue); w.units += n(r.dispatched_units);
    w.gv += n(r.glance_views); w.unfilled += n(r.unfilled_units);
    w.ordRev += n(r.ordered_revenue); w.ordUnits += n(r.ordered_units);
    if (r.oos_pct != null) { w.oos += n(r.oos_pct); w.oosN++; } // avg if multi-row
  });
  Object.keys(byAsin).forEach(function (k) {
    var a = byAsin[k];
    a.weeks = Object.values(a.weeks).sort(function (x, y) { return x.ws < y.ws ? -1 : 1; });
    a.weeks.forEach(function (w) { if (w.oosN > 1) w.oos = w.oos / w.oosN; delete w.oosN; });
  });
  return byAsin;
}

/* ── Demand forecast (weekly grain) ─────────────────────────────────
   Recency-weighted avg of last FORECAST_WEEKS dispatched units,
   EXCLUDING OOS weeks (zero units from no stock ≠ zero demand),
   × trend factor (capped) × seasonality (default 1.0). */
function forecast(series, cfg) {
  var weeks = series.weeks;
  var recent = weeks.slice(-cfg.FORECAST_WEEKS);
  var wsum = 0, dsum = 0, excluded = 0, wi = cfg.FORECAST_WEIGHTS.slice(0, recent.length).reverse(); // oldest-first alignment
  recent.forEach(function (w, i) {
    if (w.oos >= cfg.OOS_EXCLUDE_PCT) { excluded++; return; } // rule 6
    var weight = wi[i] || 1;
    wsum += weight; dsum += w.units * weight;
  });
  var base = wsum > 0 ? dsum / wsum : 0;

  var t2 = weeks.slice(-cfg.TREND_WEEKS), t1 = weeks.slice(-cfg.TREND_WEEKS * 2, -cfg.TREND_WEEKS);
  var r2 = t2.reduce(function (s, w) { return s + w.rev; }, 0);
  var r1 = t1.reduce(function (s, w) { return s + w.rev; }, 0);
  var trend = r1 > 0 ? Math.min(cfg.TREND_CAP_HIGH, Math.max(cfg.TREND_CAP_LOW, r2 / r1)) : 1.0;

  var projected = base * trend * cfg.SEASONALITY_DEFAULT;
  return { projectedWeekly: projected, trendFactor: trend, excludedOOSWeeks: excluded, baseAvg: base };
}

/* ── Per-ASIN rollup for the decision tree ── */
function rollup(series, cfg) {
  var weeks = series.weeks;
  var last = weeks[weeks.length - 1] || { rev: 0, units: 0, gv: 0, oos: 0, unfilled: 0, ws: null };
  var l4 = weeks.slice(-4);
  var avg = function (f) { return l4.length ? l4.reduce(function (s, w) { return s + w[f]; }, 0) / l4.length : 0; };
  var wkRev = avg('rev'), wkGv = avg('gv'), wkUnits = avg('units'), wkUnfilled = avg('unfilled');
  var cvr = wkGv > 0 ? (wkUnits / wkGv) * 100 : 0;
  // GV trend: last 2 weeks avg vs prior 4 avg
  var g2 = weeks.slice(-2).reduce(function (s, w) { return s + w.gv; }, 0) / Math.max(1, Math.min(2, weeks.length));
  var g4 = weeks.slice(-6, -2); var g4avg = g4.length ? g4.reduce(function (s, w) { return s + w.gv; }, 0) / g4.length : 0;
  var gvDrop = g4avg > 0 ? 1 - (g2 / g4avg) : 0;
  // Inferred launch: nothing in first half of window, sales in second half
  var half = Math.floor(weeks.length / 2);
  var firstHalfRev = weeks.slice(0, half).reduce(function (s, w) { return s + w.rev; }, 0);
  var secondHalfRev = weeks.slice(half).reduce(function (s, w) { return s + w.rev; }, 0);
  var weeksWithSales = weeks.filter(function (w) { return w.units > 0; }).length;
  var isInferredLaunch = weeks.length >= 6 && firstHalfRev === 0 && secondHalfRev > 0 && weeksWithSales <= cfg.LAUNCH_WINDOW_WEEKS;
  var fc = forecast(series, cfg);
  // Healthy ASP from non-OOS weeks — at-risk revenue must not be diluted
  // by the OOS weeks themselves (trailing avg during an outage understates
  // exactly the thing you're trying to size).
  var hw = weeks.filter(function (w) { return w.oos < cfg.OOS_EXCLUDE_PCT && w.units > 0; });
  var hRev = hw.reduce(function (s, w) { return s + w.rev; }, 0), hU = hw.reduce(function (s, w) { return s + w.units; }, 0);
  var healthyAsp = hU > 0 ? hRev / hU : 0;
  var atRiskWeekly = fc.projectedWeekly * healthyAsp;
  return {
    asin: series.asin, title: series.title, brand: series.brand,
    lastWeek: last, weeklyRev: wkRev, weeklyGv: wkGv, weeklyUnits: wkUnits,
    weeklyUnfilled: wkUnfilled, cvr: cvr, gvDrop: gvDrop, recentGv: g2,
    isInferredLaunch: isInferredLaunch, forecast: fc, weeks: weeks,
    healthyAsp: healthyAsp, atRiskWeekly: atRiskWeekly
  };
}

/* ── THE DECISION TREE — first match wins ──
   Phase 1 tiers: 1 (availability, OOS-proxy), 5 (conversion),
   6 (traffic incl. suppression check), 8 (inferred launch), 9 (monitor).
   Tiers 2/3/4/7 DEFERRED — require Net PPM (Phase 2) / inventory (Phase 3). */
function classify(a, cfg, isPreorder) {
  var f = a.forecast, lw = a.lastWeek;

  // Pre-orders are not OOS — different problem, different page.
  if (isPreorder) {
    return { tier: 9, action: 'Monitor', severity: 'OK', reason: 'Pre-order line — ' + fmtEuro(a.weeks.reduce(function (s, w) { return s + w.ordRev; }, 0)) + ' ordered, ships on release. Tracked in Pre-Order Pipeline, excluded from availability actions.' };
  }

  // TIER 1 — AVAILABILITY (always trumps everything)
  if (lw.oos >= cfg.OOS_CRITICAL_PCT && Math.max(a.weeklyRev, a.atRiskWeekly) >= cfg.MIN_WEEKLY_REV_FOR_OOS) {
    return { tier: 1, action: 'Fix Availability', severity: 'Critical', reason: 'OOS ' + lw.oos.toFixed(0) + '% last week — ' + fmtEuro(Math.max(a.atRiskWeekly, a.weeklyRev)) + '/wk at risk (projected demand × healthy ASP)' + (a.weeklyUnfilled > 0 ? ', ' + Math.round(a.weeklyUnfilled) + ' unfilled units/wk' : '') + '. Raise PO immediately (excl. inbound — no SOH data until Phase 3).' };
  }
  if (lw.oos >= cfg.OOS_HIGH_PCT && f.projectedWeekly > 3) {
    return { tier: 1, action: 'Fix Availability', severity: 'High', reason: 'OOS ' + lw.oos.toFixed(0) + '% with projected demand ' + f.projectedWeekly.toFixed(0) + ' u/wk (trend ×' + f.trendFactor.toFixed(2) + (f.excludedOOSWeeks ? ', ' + f.excludedOOSWeeks + ' OOS wk excluded' : '') + '). Confirm replenishment before revenue bleeds.' };
  }
  if (a.weeklyUnfilled >= cfg.MIN_UNFILLED_FOR_ESCALATION && a.weeklyRev >= cfg.MIN_WEEKLY_REV_FOR_OOS) {
    return { tier: 1, action: 'Fix Availability', severity: 'High', reason: Math.round(a.weeklyUnfilled) + ' unfilled units/wk on ' + fmtEuro(a.weeklyRev) + '/wk — demand exceeds supply. Check PO confirmation and inbound.' };
  }

  // Below action floor → Monitor early (no noise)
  if (a.weeklyRev < cfg.MIN_WEEKLY_REV_FOR_ACTION && a.weeklyGv < cfg.CVR_MIN_WEEKLY_GV) {
    return { tier: 9, action: 'Monitor', severity: 'OK', reason: fmtEuro(a.weeklyRev) + '/wk · ' + Math.round(a.weeklyGv) + ' GV/wk — below action thresholds.' };
  }

  // TIER 5 — CONVERSION GAP (traffic exists, doesn't convert; stock OK)
  if (!a.isInferredLaunch && a.cvr < cfg.CVR_ACTION_MAX && a.weeklyGv >= cfg.CVR_MIN_WEEKLY_GV && lw.oos < cfg.OOS_HIGH_PCT) {
    var sev5 = a.cvr < cfg.CVR_CRITICAL ? 'High' : 'Medium';
    return { tier: 5, action: 'Improve Conversion', severity: sev5, reason: 'CVR ' + a.cvr.toFixed(1) + '% on ' + Math.round(a.weeklyGv) + ' GV/wk — traffic arrives but doesn\u2019t convert. Investigate content, price vs competitors, reviews. (Traffic and conversion are separate problems.)' };
  }

  // TIER 6 — TRAFFIC GAP (converts fine, nobody arrives) + suppression check
  if (a.gvDrop > cfg.GV_DROP_PCT && a.recentGv < cfg.GV_DROP_MAX_GV && a.weeklyRev >= cfg.MIN_WEEKLY_REV_FOR_ACTION) {
    return { tier: 6, action: 'Drive GV', severity: 'High', reason: 'GV down ' + (a.gvDrop * 100).toFixed(0) + '% vs 4-wk trend (now ' + Math.round(a.recentGv) + '/wk) — investigate suppression, search rank loss, or buyability.' };
  }
  if (a.weeklyGv < cfg.GV_LOW_WEEKLY && a.cvr >= cfg.GV_DECENT_CVR && a.weeklyRev >= cfg.GV_MIN_WEEKLY_REV) {
    return { tier: 6, action: 'Drive GV', severity: 'High', reason: 'Only ' + Math.round(a.weeklyGv) + ' GV/wk but CVR ' + a.cvr.toFixed(1) + '% — converts when found. ' + fmtEuro(a.weeklyRev) + '/wk upside case for SP investment.' };
  }
  if (a.weeklyGv < cfg.GV_LOW_WEEKLY && a.weeklyRev >= cfg.GV_MIN_WEEKLY_REV) {
    return { tier: 6, action: 'Drive GV', severity: 'Medium', reason: Math.round(a.weeklyGv) + ' GV/wk on ' + fmtEuro(a.weeklyRev) + '/wk revenue — traffic is the constraint.' };
  }

  // TIER 8 — LAUNCH SUPPORT (inferred; proper detection = Phase 3 line plan)
  if (a.isInferredLaunch && lw.oos < cfg.OOS_HIGH_PCT) {
    return { tier: 8, action: 'Launch Support', severity: 'Medium', reason: 'Inferred new launch (first sales inside window) — run SP for discoverability, no discounts in first 90 days. Confirm against line plan.' };
  }

  // TIER 9 — MONITOR (default, with real figures)
  return { tier: 9, action: 'Monitor', severity: 'OK', reason: fmtEuro(a.weeklyRev) + '/wk · ' + Math.round(a.weeklyGv) + ' GV/wk · CVR ' + a.cvr.toFixed(1) + '% · OOS ' + lw.oos.toFixed(0) + '% — within acceptable parameters.' };
}

/* ── Ads recommendation — Phase 1 fallback table (no per-ASIN ads data;
      brand_health_ads is brand+market grain). Brand ROAS passed as context. ── */
function adRecommendation(a, cfg, brandRoas) {
  var lw = a.lastWeek;
  var ctx = brandRoas != null ? ' Brand AMS ROAS ' + brandRoas.toFixed(1) + 'x (brand-level — per-ASIN data lands with Pacvue ASIN export).' : '';
  if (lw.oos >= cfg.OOS_HIGH_PCT) return { rec: 'Pause all ads', why: 'OOS — spend on unbuyable listing is wasted.' + ctx };
  if (a.cvr < cfg.CVR_CRITICAL && a.weeklyGv >= cfg.CVR_MIN_WEEKLY_GV) return { rec: 'Sponsored Display', why: 'High traffic, CVR ' + a.cvr.toFixed(1) + '% — retarget browsers rather than buying more cold traffic.' + ctx };
  if (a.isInferredLaunch) return { rec: 'Sponsored Products', why: 'New launch — discoverability first, no discounts.' + ctx };
  if (a.weeklyGv < cfg.GV_LOW_WEEKLY && lw.oos < cfg.OOS_HIGH_PCT) return { rec: 'Sponsored Products', why: 'Low traffic, healthy stock — SP is the direct traffic lever.' + ctx };
  return { rec: 'Sponsored Products', why: 'Default in-stock recommendation.' + ctx };
}

/* ── Wasted-spend estimate — brand-level (honest with brand-grain ads):
      brand spend × share of brand revenue sitting on OOS ASINs. ── */
function wastedSpendEstimate(actions, adsSpendByBrand) {
  var byBrand = {};
  actions.forEach(function (x) {
    var b = byBrand[x.brand] || (byBrand[x.brand] = { rev: 0, oosRev: 0 });
    b.rev += x.weeklyRev;
    if (x.tier === 1) b.oosRev += x.weeklyRev;
  });
  var total = 0, parts = [];
  Object.keys(byBrand).forEach(function (br) {
    var b = byBrand[br], spend = n(adsSpendByBrand[br]);
    if (spend > 0 && b.rev > 0 && b.oosRev > 0) {
      var est = spend * (b.oosRev / b.rev);
      total += est; parts.push({ brand: br, estimate: est });
    }
  });
  return { total: total, parts: parts.sort(function (a, b) { return b.estimate - a.estimate; }) };
}

/* ── Entry point ──
   rows: snapshot rows (one market, N weeks)
   opts: { market, preorderAsins:Set|obj, adsRoasByBrand:{BRAND:roas}, adsSpendByBrand:{BRAND:spend} } */
function buildActions(rows, opts) {
  opts = opts || {};
  var cfg = cfgFor(opts.market || 'ALL');
  var pre = opts.preorderAsins || {};
  var isPre = function (asin) { return pre instanceof Set ? pre.has(asin) : !!pre[asin]; };
  var seriesMap = buildSeries(rows);
  var actions = Object.keys(seriesMap).map(function (k) {
    var a = rollup(seriesMap[k], cfg);
    var c = classify(a, cfg, isPre(a.asin));
    var ad = adRecommendation(a, cfg, opts.adsRoasByBrand ? opts.adsRoasByBrand[a.brand] : null);
    return {
      asin: a.asin, title: a.title, brand: a.brand, market: opts.market || 'ALL',
      tier: c.tier, action: c.action, severity: c.severity, reason: c.reason,
      adRec: ad.rec, adWhy: ad.why,
      weeklyRev: a.weeklyRev, weeklyGv: a.weeklyGv, cvr: a.cvr,
      oosPct: a.lastWeek.oos, unfilled: a.weeklyUnfilled,
      projectedWeekly: a.forecast.projectedWeekly, trendFactor: a.forecast.trendFactor,
      weeks: a.weeks // for sparklines
    };
  });
  var sevOrder = { Critical: 0, High: 1, Medium: 2, OK: 3 };
  actions.sort(function (x, y) { return (sevOrder[x.severity] - sevOrder[y.severity]) || (y.weeklyRev - x.weeklyRev); });
  var wasted = wastedSpendEstimate(actions, opts.adsSpendByBrand || {});
  return { actions: actions, wastedSpend: wasted };
}

/* ── CSV (excludes Monitor) ── */
function actionsToCsv(actions) {
  var esc = function (s) { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  var head = ['ASIN', 'Product', 'Brand', 'Market', 'Action', 'Severity', 'Reason', 'Ad Recommendation', 'Weekly Rev (€)', 'Weekly GV', 'CVR %', 'OOS %'];
  var lines = [head.join(',')];
  actions.filter(function (a) { return a.action !== 'Monitor'; }).forEach(function (a) {
    lines.push([a.asin, esc(a.title), a.brand, a.market, a.action, a.severity, esc(a.reason), esc(a.adRec), Math.round(a.weeklyRev), Math.round(a.weeklyGv), a.cvr.toFixed(1), a.oosPct.toFixed(0)].join(','));
  });
  return lines.join('\n');
}

var ActionEngine = { CONFIG: CONFIG, cfgFor: cfgFor, buildSeries: buildSeries, forecast: forecast, rollup: rollup, classify: classify, adRecommendation: adRecommendation, buildActions: buildActions, actionsToCsv: actionsToCsv, wastedSpendEstimate: wastedSpendEstimate };
if (typeof module !== 'undefined' && module.exports) module.exports = ActionEngine;
if (typeof window !== 'undefined') window.ActionEngine = ActionEngine;
