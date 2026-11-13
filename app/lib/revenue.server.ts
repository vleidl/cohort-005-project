import { and, count, eq, gte, sql, sum } from "drizzle-orm";
import type { Db } from "~/db";
import {
  RefundMoneyState,
  RefundStatus,
  courses,
  purchases,
  refunds,
} from "~/db/schema";
import { rangeStart, splitRevenue, type AnalyticsRange } from "~/lib/analytics";

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
  const conditions = [];
  if (instructorId !== null) {
    conditions.push(eq(courses.instructorId, instructorId));
  }
  const start = rangeStart(range);
  if (start !== null) {
    conditions.push(gte(purchases.createdAt, start));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
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
