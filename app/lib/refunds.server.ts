import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "~/db";
import {
  courses,
  coupons,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  users,
  videoWatchEvents,
  LessonProgressStatus,
  RefundStatus,
} from "~/db/schema";
import { formatPrice } from "~/lib/utils";

// ─── Refunds ───
// Every refund operation lives here. Routes load the session, call in, and
// turn the outcome into a response — so the course page's refund offer and
// the refund action can never disagree.
//
// Every operation takes the database as its first argument (the test seam),
// then positional parameters (project convention). Expected refusals come
// back as typed outcomes, not thrown errors.
//
// Vocabulary follows GLOSSARY.md: the `refunds` table holds Refund Requests;
// the money is the Refund.

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

type Learner = { id: number };
type Purchase = Pick<
  typeof purchases.$inferSelect,
  "id" | "userId" | "courseId" | "amountPaid" | "createdAt"
>;

/** The Refund Eligibility rule that stops a learner raising a Refund Request. */
export type RefundIneligibility =
  | "not_purchaser"
  | "request_already_open"
  | "already_refunded"
  | "claimed_team_seat"
  | "window_closed"
  | "watched_too_much"
  | "completed_too_much";

export type RefundEligibility =
  | { eligible: true; amount: number; lastDayInWindow: string }
  | { eligible: false; rule: RefundIneligibility };

/** What the learner is told when a rule stops them. */
export function describeRefundIneligibility(rule: RefundIneligibility) {
  switch (rule) {
    case "not_purchaser":
      return "Only the person who bought this course can ask for a refund.";
    case "request_already_open":
      return "You already have an open refund request on this purchase. We will email you when it is decided.";
    case "already_refunded":
      return "You have already had a refund for this course, so this purchase can't be refunded.";
    case "claimed_team_seat":
      return "A team seat from this purchase has been claimed, so it can't be refunded.";
    case "window_closed":
      return `The ${REFUND_WINDOW_DAYS}-day refund window has closed.`;
    case "watched_too_much":
      return "You have watched more than 2 hours of this course, so it can't be refunded.";
    case "completed_too_much":
      return "You have completed half or more of this course's lessons, so it can't be refunded.";
  }
}

/** The learner's most recent purchase of a course, if any. */
export function findLatestPurchase(db: Db, learnerId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(
      and(eq(purchases.userId, learnerId), eq(purchases.courseId, courseId))
    )
    .orderBy(desc(purchases.createdAt), desc(purchases.id))
    .get();
}

/**
 * Whether the learner may raise a Refund Request on this purchase, or the
 * rule that stops them. The one source of truth for both the course page's
 * refund offer and the refund action.
 *
 * Checked only when a request is raised — never when an Admin decides it
 * (ADR 0001).
 */
export function checkRefundEligibility(
  db: Db,
  learner: Learner,
  purchase: Purchase,
  now: Date = new Date()
): RefundEligibility {
  if (purchase.userId !== learner.id) {
    return { eligible: false, rule: "not_purchaser" };
  }

  // Only one undecided request per purchase at a time.
  if (hasOpenRefundRequest(db, purchase.id)) {
    return { eligible: false, rule: "request_already_open" };
  }

  // At most one Refund per course. A repurchase after a Refund can't be
  // refunded through the normal route — only a Discretionary Refund Request.
  if (hasApprovedRefundForCourse(db, learner.id, purchase.courseId)) {
    return { eligible: false, rule: "already_refunded" };
  }

  // A claimed seat from a team Purchase belongs to the team member who
  // claimed it, so the buyer can't hand the purchase back.
  if (hasClaimedSeat(db, purchase.id)) {
    return { eligible: false, rule: "claimed_team_seat" };
  }

  const lastDayInWindow = lastDayOfWindow(purchase.createdAt);
  if (calendarDay(now) > lastDayInWindow) {
    return { eligible: false, rule: "window_closed" };
  }

  const lessonIds = getCourseLessonIds(db, purchase.courseId);

  if (
    getSecondsWatched(db, learner.id, lessonIds) >= REFUND_WATCH_LIMIT_SECONDS
  ) {
    return { eligible: false, rule: "watched_too_much" };
  }

  if (
    lessonIds.length > 0 &&
    getCompletedLessonCount(db, learner.id, lessonIds) / lessonIds.length >=
      REFUND_COMPLETION_LIMIT
  ) {
    return { eligible: false, rule: "completed_too_much" };
  }

  return { eligible: true, amount: purchase.amountPaid, lastDayInWindow };
}

export type RaiseRefundRequestOutcome =
  | {
      ok: true;
      refundRequest: typeof refunds.$inferSelect;
      email: RefundEmail;
    }
  | { ok: false; rule: RefundIneligibility };

/**
 * A learner raises a Refund Request with their reason. Checks Refund
 * Eligibility, creates an Open Refund Request, and sends the learner the
 * confirmation email.
 */
export function raiseRefundRequest(
  db: Db,
  learner: Learner,
  purchase: Purchase,
  reason: string,
  now: Date = new Date()
): RaiseRefundRequestOutcome {
  // better-sqlite3 is synchronous, so the check and the insert can't
  // interleave with another request inside this transaction.
  const outcome = db.transaction((tx) => {
    const eligibility = checkRefundEligibility(tx, learner, purchase, now);
    if (!eligibility.eligible) {
      return { ok: false as const, rule: eligibility.rule };
    }

    const refundRequest = tx
      .insert(refunds)
      .values({
        purchaseId: purchase.id,
        status: RefundStatus.Open,
        reason,
        requestedAt: now.toISOString(),
      })
      .returning()
      .get();

    return { ok: true as const, refundRequest };
  });

  if (!outcome.ok) return outcome;

  const email = buildRefundRequestedEmail(db, purchase);
  sendEmail(email);

  return { ...outcome, email };
}

// ─── Emails ───
// There is no mail transport yet, so built emails go to the server log.

export type RefundEmail = { to: string; subject: string; body: string };

function sendEmail(email: RefundEmail) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}

function buildRefundRequestedEmail(db: Db, purchase: Purchase): RefundEmail {
  const learner = db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, purchase.userId))
    .get();
  const course = db
    .select({ title: courses.title })
    .from(courses)
    .where(eq(courses.id, purchase.courseId))
    .get();

  const learnerName = learner?.name ?? "there";
  const courseTitle = course?.title ?? "your course";

  return {
    to: learner?.email ?? "",
    subject: `Refund requested — ${courseTitle}`,
    body: [
      `Hi ${learnerName},`,
      "",
      `We have your refund request for "${courseTitle}".`,
      `The refund is for ${formatPrice(purchase.amountPaid)}, the amount you paid.`,
      "",
      "Our team reviews every refund request by hand. You do not need to do anything else — we will email you again when it is done.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

// ─── Eligibility helpers ───

function hasOpenRefundRequest(db: Db, purchaseId: number) {
  return !!db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Open)
      )
    )
    .get();
}

function hasApprovedRefundForCourse(
  db: Db,
  learnerId: number,
  courseId: number
) {
  return !!db
    .select({ id: refunds.id })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .where(
      and(
        eq(purchases.userId, learnerId),
        eq(purchases.courseId, courseId),
        eq(refunds.status, RefundStatus.Approved)
      )
    )
    .get();
}

function hasClaimedSeat(db: Db, purchaseId: number) {
  return !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
}

function getCourseLessonIds(db: Db, courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

/** Watch time is the furthest point reached in each lesson, summed. */
function getSecondsWatched(db: Db, learnerId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, learnerId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

function getCompletedLessonCount(
  db: Db,
  learnerId: number,
  lessonIds: number[]
) {
  if (lessonIds.length === 0) return 0;

  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, learnerId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return row?.count ?? 0;
}

// The fourteen-day window is counted in whole days, not hours — someone who
// buys at 23:00 still gets the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayOfWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}
