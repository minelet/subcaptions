// ─────────────────────────────────────────────────────────────────────────
// Rank & Streak System
//
// Implements the spec exactly:
//  - 7 ranks total. Rungs 1-5 (Starter..Limited Edition) come from pack
//    purchases. Gold+ and Diamond+ are a streak-based overlay tier earned by
//    3 / 5 consecutive monthly purchases, layered on top of whatever purchase
//    rung the user holds (e.g. "Bulk + Diamond+").
//  - A purchase grants its pack's rung immediately. Rung NEVER decreases on a
//    purchase, even a cheaper one (only ever rises, or decays from missing
//    periods - see below). Any purchase, of any price, counts toward streak.
//  - A "period" is 30-31 days. One purchase per period counts; extra
//    purchases in the same period do not stack additional streak progress.
//  - Missing a period:
//      * streak_count resets to 0 immediately (Gold+/Diamond+ overlay is lost
//        until 3/5 are earned again)
//      * rank_rung decays -1 per missed 31-day period (independent of the
//        streak reset), floored at 0 ("None")
//  - Gold+ (streak >= 3) drips 200 credits every 2 weeks.
//    Diamond+ (streak >= 5) drips 200 credits every week.
//    Drips are computed lazily from elapsed time since last_drip_at, and only
//    while the user is actively maintaining their streak (i.e. has not missed
//    a period - a lapsed streak stops earning drips even before the next
//    purchase recalculates everything).
// ─────────────────────────────────────────────────────────────────────────

const { sql } = require('./db');

const MS_PER_DAY = 86400 * 1000;
const PERIOD_DAYS = 31;          // a period is missed once 31 days elapse with no purchase
const GOLD_STREAK = 3;           // consecutive months to reach Gold+
const DIAMOND_STREAK = 5;        // consecutive months to reach Diamond+ (3 + 2 more)
const GOLD_DRIP_DAYS = 14;       // Gold+: 200 credits every 2 weeks
const DIAMOND_DRIP_DAYS = 7;     // Diamond+: 200 credits every week
const DRIP_AMOUNT = 200;

const RUNG_NAMES = [
  'None',
  'Starter',
  'Popular',
  'Pro',
  'Bulk',
  'Limited Edition',
];
const MAX_RUNG = RUNG_NAMES.length - 1; // 5

function rungName(rung) {
  return RUNG_NAMES[Math.max(0, Math.min(MAX_RUNG, rung))];
}

function streakTier(streakCount) {
  if (streakCount >= DIAMOND_STREAK) return 'diamond';
  if (streakCount >= GOLD_STREAK) return 'gold';
  return 'none';
}

function streakTierLabel(tier) {
  if (tier === 'diamond') return 'Diamond+';
  if (tier === 'gold') return 'Gold+';
  return null;
}

// Composite display label, e.g. "Bulk + Diamond+", "Starter", "Diamond+".
function displayRank(rung, streakCount) {
  const tier = streakTierLabel(streakTier(streakCount));
  const base = rung > 0 ? rungName(rung) : null;
  if (base && tier) return `${base} + ${tier}`;
  return base || tier || null;
}

// How many full 31-day periods have elapsed between two dates (>= 0).
function periodsElapsed(from, to) {
  if (!from) return 0;
  const diffDays = (to.getTime() - from.getTime()) / MS_PER_DAY;
  return Math.max(0, Math.floor(diffDays / PERIOD_DAYS));
}

// ── Pure decay calculation ──────────────────────────────────────────────
// Given a user's current state and "now", determine whether period(s) have
// been missed since their last purchase, and if so compute the decayed state.
// This is "Recovery Logic": missed periods are calculated and full decay is
// applied BEFORE any new purchase is considered.
function applyDecay(state, now) {
  const { rankRung, streakCount, lastPurchaseAt, periodDeadlineAt } = state;

  if (!lastPurchaseAt || !periodDeadlineAt) {
    // Never purchased, or no active period to evaluate - nothing to decay.
    return { ...state, missedPeriods: 0, decayed: false };
  }

  if (now.getTime() <= periodDeadlineAt.getTime()) {
    // Still within the current period - no miss yet.
    return { ...state, missedPeriods: 0, decayed: false };
  }

  // At least one period has been missed. Count how many full periods passed
  // since the deadline was first crossed (deadline itself = end of period 1).
  const overDays = (now.getTime() - periodDeadlineAt.getTime()) / MS_PER_DAY;
  const missedPeriods = 1 + Math.floor(overDays / PERIOD_DAYS);

  const newRung = Math.max(0, rankRung - missedPeriods);

  return {
    rankRung: newRung,
    streakCount: 0, // any miss resets the streak immediately
    // Once decayed, there is no "current period" until the next purchase.
    lastPurchaseAt: null,
    periodDeadlineAt: null,
    missedPeriods,
    decayed: true,
    previousRung: rankRung,
    previousStreak: streakCount,
  };
}

// ── Purchase processing ─────────────────────────────────────────────────
// packRung: the rung implied by the pack just purchased (1-5).
// Returns the new state to persist, plus metadata for logging/response.
function applyPurchase(state, packRung, now) {
  // Step 1: recovery logic — apply any owed decay BEFORE the new purchase.
  const decayed = applyDecay(state, now);

  // Step 2: streak math.
  // The spec defines a "period" as 30-31 days:
  //   - A purchase is "too soon" (same period, already counted) if it comes
  //     less than 30 days after the previous qualifying purchase.
  //   - A purchase 30-31 days later is the next qualifying period: streak +1.
  //   - A purchase more than 31 days later = missed period: decay applied first
  //     (handled by applyDecay above), then streak restarts at 1.
  // "Multiple purchases in same period do NOT stack" = only the first purchase
  // in any 30-day window counts toward the streak.
  const MIN_PERIOD_DAYS = 30;
  const alreadyCountedThisPeriod =
    !decayed.decayed &&
    decayed.lastPurchaseAt !== null &&
    (now.getTime() - decayed.lastPurchaseAt.getTime()) < MIN_PERIOD_DAYS * MS_PER_DAY;
  // Note: if decay was triggered (!decayed.decayed is false), the streak already
  // reset to 0 and lastPurchaseAt was cleared, so this will always be false there.

  const newStreakCount = alreadyCountedThisPeriod
    ? decayed.streakCount           // same period: no additional streak progress
    : decayed.streakCount + 1;      // new period (or first ever): increment

  // Step 3: rung — never decreases on a purchase.
  // Jump-starts to packRung if it's higher than whatever rung remained after
  // decay; buying a lower/equal pack just refreshes the deadline and streak.
  const newRung = Math.max(decayed.rankRung, packRung);

  const tierBefore = streakTier(state.streakCount);
  const tierAfter  = streakTier(newStreakCount);

  return {
    rankRung:         newRung,
    streakCount:      newStreakCount,
    lastPurchaseAt:   alreadyCountedThisPeriod ? decayed.lastPurchaseAt : now,
    periodDeadlineAt: alreadyCountedThisPeriod
      ? decayed.periodDeadlineAt  // deadline unchanged for same-period extra purchase
      : new Date(now.getTime() + PERIOD_DAYS * MS_PER_DAY),
    // Reset the drip clock when crossing a tier boundary so the new tier's
    // cadence always starts fresh from the moment the tier was reached.
    resetDripClock: tierBefore !== tierAfter,
    alreadyCountedThisPeriod,
    decay: decayed.decayed
      ? { missedPeriods: decayed.missedPeriods, previousRung: decayed.previousRung, previousStreak: decayed.previousStreak }
      : null,
    tierBefore,
    tierAfter,
  };
}

// ── Credit drip calculation ─────────────────────────────────────────────
// Lazily compute how many drip intervals have elapsed since last_drip_at,
// based on the user's CURRENT streak tier (post-decay). A lapsed streak
// (tier === 'none') earns no further drips.
function calcDripCredits(tier, lastDripAt, now) {
  if (tier === 'none' || !lastDripAt) return { owedCredits: 0, newLastDripAt: lastDripAt };

  const dripDays = tier === 'diamond' ? DIAMOND_DRIP_DAYS : GOLD_DRIP_DAYS;
  const dripMs = dripDays * MS_PER_DAY;
  const elapsedMs = now.getTime() - lastDripAt.getTime();
  const intervals = Math.floor(elapsedMs / dripMs);

  if (intervals <= 0) return { owedCredits: 0, newLastDripAt: lastDripAt };

  return {
    owedCredits: intervals * DRIP_AMOUNT,
    newLastDripAt: new Date(lastDripAt.getTime() + intervals * dripMs),
  };
}

// ── DB orchestration: reconcile a user's rank/streak state to "now" ───────
// Call this lazily whenever a user is loaded (login, /api/me, session check).
// Applies decay if a period was missed, and pays out any owed Gold+/Diamond+
// credit drips. Idempotent and safe to call repeatedly.
async function reconcileUser(userRow, now = new Date()) {
  const state = {
    rankRung: userRow.rank_rung || 0,
    streakCount: userRow.streak_count || 0,
    lastPurchaseAt: userRow.last_purchase_at ? new Date(userRow.last_purchase_at) : null,
    periodDeadlineAt: userRow.period_deadline_at ? new Date(userRow.period_deadline_at) : null,
  };

  const decayed = applyDecay(state, now);

  let lastDripAt = userRow.last_drip_at ? new Date(userRow.last_drip_at) : null;
  const tierNow = streakTier(decayed.streakCount);

  // If a streak just lapsed, stop the drip clock (no more credits accrue).
  if (decayed.decayed) {
    lastDripAt = null;
  }
  // If user is in a drip-earning tier but has no drip anchor yet (e.g. just
  // crossed into Gold+/Diamond+ on a prior purchase that didn't set one),
  // start the clock now rather than retroactively.
  if (tierNow !== 'none' && !lastDripAt) {
    lastDripAt = now;
  }

  const { owedCredits, newLastDripAt } = calcDripCredits(tierNow, lastDripAt, now);

  const needsWrite =
    decayed.decayed ||
    owedCredits > 0 ||
    lastDripAt?.getTime() !== (userRow.last_drip_at ? new Date(userRow.last_drip_at).getTime() : undefined);

  if (needsWrite) {
    const newRank = displayRank(decayed.rankRung, decayed.streakCount);
    await sql`
      UPDATE users
      SET rank_rung = ${decayed.rankRung},
          streak_count = ${decayed.streakCount},
          last_purchase_at = ${decayed.lastPurchaseAt},
          period_deadline_at = ${decayed.periodDeadlineAt},
          last_drip_at = ${newLastDripAt},
          credits = credits + ${owedCredits},
          credits_bought = credits_bought + ${owedCredits},
          rank = ${newRank},
          rank_expires_at = ${decayed.periodDeadlineAt}
      WHERE id = ${userRow.id}
    `;

    if (decayed.decayed) {
      await sql`
        INSERT INTO streak_events (user_id, event_type, detail)
        VALUES (${userRow.id}, 'decay', ${JSON.stringify({
          missedPeriods: decayed.missedPeriods,
          rungBefore: decayed.previousRung,
          rungAfter: decayed.rankRung,
          streakBefore: decayed.previousStreak,
        })})
      `;
    }
    if (owedCredits > 0) {
      await sql`
        INSERT INTO streak_events (user_id, event_type, detail)
        VALUES (${userRow.id}, 'drip', ${JSON.stringify({ tier: tierNow, credits: owedCredits })})
      `;
    }
  }

  return {
    rank_rung: decayed.rankRung,
    streak_count: decayed.streakCount,
    last_purchase_at: decayed.lastPurchaseAt,
    period_deadline_at: decayed.periodDeadlineAt,
    last_drip_at: newLastDripAt,
    rank: displayRank(decayed.rankRung, decayed.streakCount),
    rank_expires_at: decayed.periodDeadlineAt,
    credits: (userRow.credits || 0) + owedCredits,
    credits_bought: (userRow.credits_bought || 0) + owedCredits,
    creditsDripped: owedCredits,
  };
}

// ── DB orchestration: process a qualifying purchase ───────────────────────
// packId must map to a rung 1-5 via PACKS (see lib/packs.js). Call this from
// any purchase-confirmation path (PayPal capture, self-confirm, admin grant).
async function recordPurchase(userId, packRung, now = new Date()) {
  const result = await sql`
    SELECT rank_rung, streak_count, last_purchase_at, period_deadline_at, last_drip_at, credits, credits_bought
    FROM users WHERE id = ${userId}
  `;
  const row = result.rows[0];
  if (!row) throw new Error('User not found');

  const state = {
    rankRung: row.rank_rung || 0,
    streakCount: row.streak_count || 0,
    lastPurchaseAt: row.last_purchase_at ? new Date(row.last_purchase_at) : null,
    periodDeadlineAt: row.period_deadline_at ? new Date(row.period_deadline_at) : null,
  };

  const result2 = applyPurchase(state, packRung, now);

  let lastDripAt = row.last_drip_at ? new Date(row.last_drip_at) : null;
  if (result2.tierAfter !== 'none' && (result2.resetDripClock || !lastDripAt)) {
    lastDripAt = now; // fresh drip clock on entering/changing tier
  }
  if (result2.tierAfter === 'none') {
    lastDripAt = null;
  }

  const newRank = displayRank(result2.rankRung, result2.streakCount);

  await sql`
    UPDATE users
    SET rank_rung = ${result2.rankRung},
        streak_count = ${result2.streakCount},
        last_purchase_at = ${result2.lastPurchaseAt},
        period_deadline_at = ${result2.periodDeadlineAt},
        last_drip_at = ${lastDripAt},
        rank = ${newRank},
        rank_expires_at = ${result2.periodDeadlineAt}
    WHERE id = ${userId}
  `;

  await sql`
    INSERT INTO streak_events (user_id, event_type, detail)
    VALUES (${userId}, 'purchase', ${JSON.stringify({
      packRung,
      rungAfter: result2.rankRung,
      streakAfter: result2.streakCount,
      tierAfter: result2.tierAfter,
      decay: result2.decay,
    })})
  `;

  return {
    rank: newRank,
    rankRung: result2.rankRung,
    streakCount: result2.streakCount,
    tier: result2.tierAfter,
    periodDeadlineAt: result2.periodDeadlineAt,
    decay: result2.decay,
  };
}

module.exports = {
  // constants exposed for admin UI / tests
  RUNG_NAMES,
  MAX_RUNG,
  GOLD_STREAK,
  DIAMOND_STREAK,
  GOLD_DRIP_DAYS,
  DIAMOND_DRIP_DAYS,
  DRIP_AMOUNT,
  PERIOD_DAYS,
  // pure helpers
  rungName,
  streakTier,
  streakTierLabel,
  displayRank,
  periodsElapsed,
  applyDecay,
  applyPurchase,
  calcDripCredits,
  // DB orchestration
  reconcileUser,
  recordPurchase,
};
