import { and, eq, exists, inArray, not, or, sql } from "drizzle-orm";
import type { Db } from "~/db";
import {
  courseRatings,
  purchases,
  refunds,
  RefundStatus,
} from "~/db/schema";

export type CourseRatingSummary = {
  average: number | null;
  count: number;
};

export const EMPTY_RATING_SUMMARY: CourseRatingSummary = {
  average: null,
  count: 0,
};

/**
 * The star-rating average and count for each course, as the catalogue and
 * the course page show them. Every requested course gets an entry.
 *
 * A rating is left out while its learner is refunded: they have an Approved
 * Refund Request for the course and haven't bought it again. Their comments
 * are unaffected; only the rating stops counting.
 */
export function getCourseRatingSummaries(
  db: Db,
  courseIds: number[]
): Map<number, CourseRatingSummary> {
  const summaries = new Map<number, CourseRatingSummary>();

  if (courseIds.length === 0) return summaries;

  const rows = db
    .select({
      courseId: courseRatings.courseId,
      average: sql<number | null>`avg(${courseRatings.rating})`,
      count: sql<number>`count(*)`,
    })
    .from(courseRatings)
    .where(
      and(
        inArray(courseRatings.courseId, courseIds),
        or(
          not(exists(approvedRefundOnCourse(db))),
          exists(unrefundedPurchaseOfCourse(db))
        )
      )
    )
    .groupBy(courseRatings.courseId)
    .all();

  for (const row of rows) {
    summaries.set(row.courseId, {
      average: row.average === null ? null : Math.round(row.average * 10) / 10,
      count: row.count,
    });
  }

  for (const courseId of courseIds) {
    if (!summaries.has(courseId)) summaries.set(courseId, EMPTY_RATING_SUMMARY);
  }

  return summaries;
}

/** An Approved Refund Request by the rater on a purchase of the rated course. */
function approvedRefundOnCourse(db: Db) {
  return db
    .select({ id: refunds.id })
    .from(refunds)
    .innerJoin(purchases, eq(purchases.id, refunds.purchaseId))
    .where(
      and(
        eq(purchases.userId, courseRatings.userId),
        eq(purchases.courseId, courseRatings.courseId),
        eq(refunds.status, RefundStatus.Approved)
      )
    );
}

/** A purchase of the rated course by the rater with no Approved Refund Request. */
function unrefundedPurchaseOfCourse(db: Db) {
  return db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.userId, courseRatings.userId),
        eq(purchases.courseId, courseRatings.courseId),
        not(
          exists(
            db
              .select({ id: refunds.id })
              .from(refunds)
              .where(
                and(
                  eq(refunds.purchaseId, purchases.id),
                  eq(refunds.status, RefundStatus.Approved)
                )
              )
          )
        )
      )
    );
}
