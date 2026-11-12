import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  notExists,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { db } from "~/db";
import {
  coupons,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  videoWatchEvents,
  LessonProgressStatus,
} from "~/db/schema";

export const REFUND_WINDOW_DAYS = 14;

/** The Refund Reason a student gives with every Refund Request. */
export const refundReasonSchema = z
  .string()
  .trim()
  .min(10, "Tell us a little more about why you want a refund.")
  .max(1000, "Please keep your reason under 1000 characters.");
const MAX_COMPLETED_FRACTION = 0.5;
const MAX_WATCHED_SECONDS = 2 * 60 * 60;

// The Refund Window is counted in whole calendar days, not hours — someone who
// buys at 23:00 still gets the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayInWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

// The student's own Purchase that has not been refunded yet. A Team Purchase
// (one with Seats) is bought for others and is refunded Seat by Seat instead.
export function getLatestOwnPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.userId, userId),
        eq(purchases.courseId, courseId),
        notExists(
          db
            .select({ id: coupons.id })
            .from(coupons)
            .where(eq(coupons.purchaseId, purchases.id))
        ),
        notExists(
          db
            .select({ id: refunds.id })
            .from(refunds)
            .where(eq(refunds.purchaseId, purchases.id))
        )
      )
    )
    .orderBy(desc(purchases.createdAt))
    .get();
}

function windowClosedReason(lastDay: string) {
  return `The ${REFUND_WINDOW_DAYS}-day refund window closed on ${lastDay}.`;
}

function getLessonIds(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

// The furthest point reached in each Lesson, summed — rewatching a Lesson does
// not count twice.
function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

export type RefundEligibility =
  | {
      eligible: true;
      purchaseId: number;
      amount: number;
      lastDayInWindow: string;
    }
  | { eligible: false; reason: string };

/**
 * Whether the student may make a Refund Request for their Purchase of this
 * course, or null if they hold no Purchase that could be refunded.
 */
export function getRefundEligibility(
  userId: number,
  courseId: number,
  now: Date = new Date()
): RefundEligibility | null {
  const purchase = getLatestOwnPurchase(userId, courseId);
  if (!purchase) return null;

  const lastDay = lastDayInWindow(purchase.createdAt);
  if (calendarDay(now) > lastDay) {
    return { eligible: false, reason: windowClosedReason(lastDay) };
  }

  const lessonIds = getLessonIds(courseId);
  if (
    lessonIds.length > 0 &&
    getCompletedLessonCount(userId, lessonIds) / lessonIds.length >=
      MAX_COMPLETED_FRACTION
  ) {
    return {
      eligible: false,
      reason: "You have completed half or more of this course.",
    };
  }

  if (getSecondsWatched(userId, lessonIds) >= MAX_WATCHED_SECONDS) {
    return {
      eligible: false,
      reason: "You have watched two hours or more of this course.",
    };
  }

  return {
    eligible: true,
    purchaseId: purchase.id,
    amount: purchase.amountPaid,
    lastDayInWindow: lastDay,
  };
}

export type RefundResult =
  | { refunded: true; refundId: number; amount: number }
  | { refunded: false; reason: string };

/**
 * A Refund Request for the student's own Purchase. When eligible it is granted
 * on the spot: the Amount Paid is refunded and access to the Course ends.
 */
export function requestRefund(
  userId: number,
  courseId: number,
  reason: string,
  now: Date = new Date()
): RefundResult {
  const eligibility = getRefundEligibility(userId, courseId, now);

  if (!eligibility) {
    return {
      refunded: false,
      reason: "You have no purchase of this course to refund.",
    };
  }
  if (!eligibility.eligible) {
    return { refunded: false, reason: eligibility.reason };
  }

  const refund = db.transaction((tx) => {
    const created = tx
      .insert(refunds)
      .values({
        purchaseId: eligibility.purchaseId,
        reason,
        amountRefunded: eligibility.amount,
        refundedAt: now.toISOString(),
      })
      .returning()
      .get();

    tx.delete(enrollments)
      .where(
        and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
      )
      .run();

    return created;
  });

  return { refunded: true, refundId: refund.id, amount: refund.amountRefunded };
}

function getSeats(purchaseId: number) {
  return db
    .select()
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .orderBy(coupons.id)
    .all();
}

export type TeamRefundEligibility =
  | {
      eligible: true;
      refundableSeats: number;
      amountPerSeat: number;
      lastDayInWindow: string;
    }
  | { eligible: false; reason: string };

/**
 * Whether the buyer of a Team Purchase may refund some of its Seats. Only
 * unclaimed Seats are refundable, each at an equal share of the Amount Paid.
 */
export function getTeamRefundEligibility(
  userId: number,
  purchaseId: number,
  now: Date = new Date()
): TeamRefundEligibility {
  const purchase = db
    .select()
    .from(purchases)
    .where(eq(purchases.id, purchaseId))
    .get();
  const seats = getSeats(purchaseId);

  if (!purchase || seats.length === 0) {
    return { eligible: false, reason: "This is not a Team Purchase." };
  }

  if (purchase.userId !== userId) {
    return {
      eligible: false,
      reason: "Only the person who made this Team Purchase can refund its Seats.",
    };
  }

  const lastDay = lastDayInWindow(purchase.createdAt);
  if (calendarDay(now) > lastDay) {
    return { eligible: false, reason: windowClosedReason(lastDay) };
  }

  if (seats.every((seat) => seat.refundId !== null)) {
    return {
      eligible: false,
      reason: "Every Seat of this Team Purchase has been refunded.",
    };
  }

  const refundable = seats.filter(
    (seat) => seat.redeemedByUserId === null && seat.refundId === null
  );
  if (refundable.length === 0) {
    return { eligible: false, reason: "No unclaimed Seats are left to refund." };
  }

  return {
    eligible: true,
    refundableSeats: refundable.length,
    // Rounded down for display; seatsRefundAmount settles the odd cents.
    amountPerSeat: Math.floor(purchase.amountPaid / seats.length),
    lastDayInWindow: lastDay,
  };
}

/**
 * What refunding `count` more Seats returns, when `alreadyRefunded` of
 * `totalSeats` have been refunded before. Shares are taken cumulatively, so
 * once every Seat is refunded the total is exactly the Amount Paid.
 */
function seatsRefundAmount(
  amountPaid: number,
  totalSeats: number,
  alreadyRefunded: number,
  count: number
) {
  const refundedUpTo = (seatCount: number) =>
    Math.floor((amountPaid * seatCount) / totalSeats);
  return refundedUpTo(alreadyRefunded + count) - refundedUpTo(alreadyRefunded);
}

/**
 * A Refund Request for some unclaimed Seats of a Team Purchase. When eligible
 * it is granted on the spot and the refunded Seats can no longer be claimed.
 */
export function requestSeatRefund(
  userId: number,
  purchaseId: number,
  seatCount: number,
  reason: string,
  now: Date = new Date()
): RefundResult {
  const eligibility = getTeamRefundEligibility(userId, purchaseId, now);

  if (!eligibility.eligible) {
    return { refunded: false, reason: eligibility.reason };
  }
  if (seatCount > eligibility.refundableSeats) {
    const seats = eligibility.refundableSeats === 1 ? "Seat" : "Seats";
    return {
      refunded: false,
      reason: `Only ${eligibility.refundableSeats} unclaimed ${seats} can be refunded.`,
    };
  }

  const refund = db.transaction((tx) => {
    const purchase = tx
      .select()
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .get();
    const seats = tx
      .select()
      .from(coupons)
      .where(eq(coupons.purchaseId, purchaseId))
      .all();
    if (!purchase) throw new Error("Team Purchase disappeared mid-refund");

    const seatIds = tx
      .select({ id: coupons.id })
      .from(coupons)
      .where(
        and(
          eq(coupons.purchaseId, purchaseId),
          isNull(coupons.redeemedByUserId),
          isNull(coupons.refundId)
        )
      )
      .orderBy(coupons.id)
      .limit(seatCount)
      .all()
      .map((seat) => seat.id);

    const created = tx
      .insert(refunds)
      .values({
        purchaseId,
        reason,
        amountRefunded: seatsRefundAmount(
          purchase.amountPaid,
          seats.length,
          seats.filter((seat) => seat.refundId !== null).length,
          seatIds.length
        ),
        refundedAt: now.toISOString(),
      })
      .returning()
      .get();

    tx.update(coupons)
      .set({ refundId: created.id })
      .where(inArray(coupons.id, seatIds))
      .run();

    return created;
  });

  return { refunded: true, refundId: refund.id, amount: refund.amountRefunded };
}
