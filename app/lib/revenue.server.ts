import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  notExists,
  sql,
  sum,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "~/db";
import {
  RefundMoneyState,
  RefundStatus,
  coupons,
  courses,
  enrollments,
  purchases,
  refunds,
  users,
} from "~/db/schema";
import { rangeStart, splitRevenue, type AnalyticsRange } from "~/lib/analytics";
import { getDiscountForCountry } from "~/lib/ppp";

// ─── Instructor Revenue ───
// What an instructor's courses earned, net of Issued Refunds.
//
// Only an Issued Refund is subtracted: the money has gone back to the
// learner. A Pending or Failed Refund still counts as revenue until the money
// is confirmed as sent.
//
// A Refund belongs to the period of the sale it gives back, not the day it
// was issued, so a period's revenue never goes below zero.
//
// Learners' refund reasons never leave this module: Instructors see amounts
// and counts only.

export type RevenueSummary = {
  grossCents: number;
  feeCents: number;
  netCents: number;
  purchaseCount: number;
};

export type CourseRevenue = RevenueSummary & {
  courseId: number;
  title: string;
  /** Approved Refund Requests on the course, whatever their money state. */
  refundCount: number;
};

/** Purchases on the instructor's courses (null: every instructor) in the range. */
function purchaseScope(instructorId: number | null, range: AnalyticsRange) {
  return scopeOn(purchases.createdAt, instructorId, range);
}

/**
 * What a purchase still earns: what was paid, less any Issued Refund on it.
 * Use it in place of `purchases.amountPaid` wherever revenue is summed.
 */
export function revenueAfterIssuedRefunds() {
  return sql<number>`(${purchases.amountPaid} - coalesce((select sum(${refunds.amountRefunded}) from ${refunds} where ${refunds.purchaseId} = ${purchases.id} and ${refunds.status} = ${RefundStatus.Approved} and ${refunds.refundState} = ${RefundMoneyState.Issued}), 0))`;
}

/** Refunds per course, for sales in the range. */
function refundCountsByCourse(
  db: Db,
  instructorId: number | null,
  range: AnalyticsRange
) {
  const rows = db
    .select({ courseId: purchases.courseId, refundCount: count(refunds.id) })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        eq(refunds.status, RefundStatus.Approved),
        purchaseScope(instructorId, range)
      )
    )
    .groupBy(purchases.courseId)
    .all();

  return new Map(rows.map((row) => [row.courseId, row.refundCount]));
}

/** Revenue per course, biggest earner first. Courses with no sales are absent. */
export function getCourseRevenue(
  db: Db,
  instructorId: number | null,
  range: AnalyticsRange
): CourseRevenue[] {
  const rows = db
    .select({
      courseId: courses.id,
      title: courses.title,
      gross: sum(revenueAfterIssuedRefunds()),
      purchaseCount: count(purchases.id),
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(purchaseScope(instructorId, range))
    .groupBy(courses.id)
    .all();

  const refundCounts = refundCountsByCourse(db, instructorId, range);

  return rows
    .map((row) => ({
      courseId: row.courseId,
      title: row.title,
      // sum() returns null over an empty set, and a string when SQLite has rows.
      ...splitRevenue(Number(row.gross ?? 0)),
      purchaseCount: row.purchaseCount,
      refundCount: refundCounts.get(row.courseId) ?? 0,
    }))
    .sort((a, b) => b.grossCents - a.grossCents);
}

/** Gross revenue, the platform's fee and the instructor's net for the range. */
export function getRevenueSummary(
  db: Db,
  instructorId: number | null,
  range: AnalyticsRange
): RevenueSummary {
  const courseRevenue = getCourseRevenue(db, instructorId, range);
  const gross = courseRevenue.reduce(
    (total, course) => total + course.grossCents,
    0
  );
  return {
    ...splitRevenue(gross),
    purchaseCount: courseRevenue.reduce(
      (total, course) => total + course.purchaseCount,
      0
    ),
  };
}

// ─── Revenue breakdowns ───
// The analytics page's other revenue figures, net of Issued Refunds like
// everything above.

export type StudentRevenue = {
  userId: number;
  name: string;
  revenueCents: number;
};

export type TopBuyer = {
  userId: number;
  name: string;
  email: string;
  spendCents: number;
  purchaseCount: number;
  seatsBought: number;
  seatsUnredeemed: number;
  enrolled: boolean;
};

export type CountryRevenueRow = {
  country: string | null;
  purchaseCount: number;
  grossCents: number;
  netCents: number;
  sharePercent: number;
  averagePaidCents: number;
  discountPercent: number | null;
};

export type CourseCountryRevenue = {
  grossCents: number;
  netCents: number;
  purchaseCount: number;
  discountedGrossCents: number;
  discountedNetCents: number;
  discountedSharePercent: number;
  rows: CountryRevenueRow[];
};

/** Rows on the instructor's courses (null: every instructor) dated in the range. */
export function scopeOn(
  dateColumn: SQLiteColumn,
  instructorId: number | null,
  range: AnalyticsRange
) {
  const conditions = [];

  if (instructorId !== null) {
    conditions.push(eq(courses.instructorId, instructorId));
  }

  const start = rangeStart(range);
  if (start !== null) {
    conditions.push(gte(dateColumn, start));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** Rows dated in the range. */
export function sinceRange(dateColumn: SQLiteColumn, range: AnalyticsRange) {
  const start = rangeStart(range);
  return start === null ? undefined : gte(dateColumn, start);
}

/** Rows on the instructor's courses (null: every instructor). */
export function ownedBy(instructorId: number | null) {
  return instructorId === null
    ? undefined
    : eq(courses.instructorId, instructorId);
}

/**
 * What each student enrolled in the range paid for the instructor's courses:
 * their own purchases, plus a share of any team Purchase whose seat they
 * claimed.
 */
export function getStudentRevenue(
  db: Db,
  instructorId: number | null,
  range: AnalyticsRange
): StudentRevenue[] {
  const students = db
    .selectDistinct({ userId: users.id, name: users.name })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(scopeOn(enrollments.enrolledAt, instructorId, range))
    .orderBy(users.name)
    .all();

  if (students.length === 0) return [];

  const studentIds = students.map((student) => student.userId);

  // Correlated: did this purchase mint seats for other people?
  const mintedSeats = db
    .select({ one: sql`1` })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchases.id));

  const direct = db
    .select({
      userId: purchases.userId,
      paid: sum(revenueAfterIssuedRefunds()),
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        inArray(purchases.userId, studentIds),
        notExists(mintedSeats),
        ownedBy(instructorId)
      )
    )
    .groupBy(purchases.userId)
    .all();

  const seatCounts = db
    .select({ purchaseId: coupons.purchaseId, seats: count().as("seats") })
    .from(coupons)
    .groupBy(coupons.purchaseId)
    .as("seat_counts");

  const viaSeat = db
    .select({
      userId: coupons.redeemedByUserId,
      // Divided rather than rounded per row: the shares are summed first and
      // rounded once, so five seats out of 3333 cents still add up.
      paid: sql<number>`sum(${revenueAfterIssuedRefunds()} * 1.0 / ${seatCounts.seats})`,
    })
    .from(coupons)
    .innerJoin(purchases, eq(coupons.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .innerJoin(seatCounts, eq(seatCounts.purchaseId, coupons.purchaseId))
    .where(
      and(inArray(coupons.redeemedByUserId, studentIds), ownedBy(instructorId))
    )
    .groupBy(coupons.redeemedByUserId)
    .all();

  const paidByUser = new Map<number, number>();
  const credit = (userId: number | null, paid: unknown) => {
    if (userId === null) return;
    paidByUser.set(userId, (paidByUser.get(userId) ?? 0) + Number(paid ?? 0));
  };

  for (const row of direct) credit(row.userId, row.paid);
  for (const row of viaSeat) credit(row.userId, row.paid);

  return students.map((student) => ({
    ...student,
    revenueCents: Math.round(paidByUser.get(student.userId) ?? 0),
  }));
}

const TOP_BUYER_LIMIT = 10;

/** The biggest spenders on the instructor's courses in the range. */
export function getTopBuyers(
  db: Db,
  instructorId: number | null,
  range: AnalyticsRange
): TopBuyer[] {
  const buyers = db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      spend: sum(revenueAfterIssuedRefunds()),
      purchaseCount: count(purchases.id),
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .innerJoin(users, eq(users.id, purchases.userId))
    .where(purchaseScope(instructorId, range))
    .groupBy(users.id)
    .orderBy(desc(sum(revenueAfterIssuedRefunds())))
    .limit(TOP_BUYER_LIMIT)
    .all();

  if (buyers.length === 0) return [];

  const buyerIds = buyers.map((buyer) => buyer.userId);

  // Seats are counted in their own query: joining coupons to purchases above
  // would repeat each purchase once per seat and multiply the spend the
  // leaderboard ranks on.
  const seats = db
    .select({
      userId: purchases.userId,
      bought: count(coupons.id),
      unredeemed: sql<number>`sum(case when ${coupons.redeemedByUserId} is null then 1 else 0 end)`,
    })
    .from(coupons)
    .innerJoin(purchases, eq(coupons.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        inArray(purchases.userId, buyerIds),
        purchaseScope(instructorId, range)
      )
    )
    .groupBy(purchases.userId)
    .all();

  const seatsByUser = new Map(seats.map((row) => [row.userId, row]));

  // No range here: "never enrolled" is a fact about the person, not about the
  // last thirty days.
  const enrolled = new Set(
    db
      .selectDistinct({ userId: enrollments.userId })
      .from(enrollments)
      .innerJoin(courses, eq(enrollments.courseId, courses.id))
      .where(and(inArray(enrollments.userId, buyerIds), ownedBy(instructorId)))
      .all()
      .map((row) => row.userId)
  );

  return buyers.map((buyer) => ({
    userId: buyer.userId,
    name: buyer.name,
    email: buyer.email,
    spendCents: Number(buyer.spend ?? 0),
    purchaseCount: buyer.purchaseCount,
    seatsBought: seatsByUser.get(buyer.userId)?.bought ?? 0,
    seatsUnredeemed: Number(seatsByUser.get(buyer.userId)?.unredeemed ?? 0),
    enrolled: enrolled.has(buyer.userId),
  }));
}

/** A course's revenue in the range, split by the country of each sale. */
export function getCourseRevenueByCountry(
  db: Db,
  courseId: number,
  range: AnalyticsRange
): CourseCountryRevenue {
  const rows = db
    .select({
      country: purchases.country,
      gross: sum(revenueAfterIssuedRefunds()),
      purchaseCount: count(purchases.id),
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.courseId, courseId),
        sinceRange(purchases.createdAt, range)
      )
    )
    .groupBy(purchases.country)
    .all()
    .map((row) => ({
      country: row.country,
      grossCents: Number(row.gross ?? 0),
      purchaseCount: row.purchaseCount,
    }))
    .sort((a, b) => b.grossCents - a.grossCents);

  const grossCents = rows.reduce((total, row) => total + row.grossCents, 0);
  const purchaseCount = rows.reduce(
    (total, row) => total + row.purchaseCount,
    0
  );

  const share = (cents: number) =>
    grossCents === 0 ? 0 : Math.round((cents / grossCents) * 100);

  let discountedGrossCents = 0;

  const breakdown = rows.map((row) => {
    const discountPercent =
      row.country === null ? null : getDiscountForCountry(row.country) * 100;

    if (discountPercent !== null && discountPercent > 0) {
      discountedGrossCents += row.grossCents;
    }

    return {
      ...row,
      netCents: splitRevenue(row.grossCents).netCents,
      sharePercent: share(row.grossCents),
      averagePaidCents: Math.round(row.grossCents / row.purchaseCount),
      discountPercent,
    };
  });

  return {
    grossCents,
    netCents: splitRevenue(grossCents).netCents,
    purchaseCount,
    discountedGrossCents,
    discountedNetCents: splitRevenue(discountedGrossCents).netCents,
    discountedSharePercent: share(discountedGrossCents),
    rows: breakdown,
  };
}
