import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "~/db";
import {
  courses,
  coupons,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  users,
  videoWatchEvents,
  LessonProgressStatus,
  RefundMoneyState,
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

// ─── Decisions ───
// An Admin approves or declines an Open Refund Request. Decisions are final:
// there are no reverse operations. Approval never rechecks Refund
// Eligibility (ADR 0001) — the request is judged as it was raised.

type Admin = { id: number };
type RefundRequestRef = { id: number };
type RefundRequestRow = typeof refunds.$inferSelect;

export type DecisionOutcome =
  | { ok: true; refundRequest: RefundRequestRow; email: RefundEmail }
  | { ok: false; refusal: DecisionRefusal };

/**
 * An Admin approves an Open Refund Request. In one transaction: records the
 * decision, creates a Pending Refund for the full amount paid, and ends the
 * learner's Enrollment (see `applyApproval`). Then emails the learner.
 */
export function approveRefundRequest(
  db: Db,
  admin: Admin,
  refundRequest: RefundRequestRef,
  now: Date = new Date()
): DecisionOutcome {
  const outcome = db.transaction((tx) => {
    const guarded = guardDecision(tx, admin, refundRequest);
    if (!guarded.ok) return guarded;

    const decided = decideIfOpen(tx, refundRequest, {
      status: RefundStatus.Approved,
      resolvedAt: now.toISOString(),
      resolvedByUserId: admin.id,
      amountRefunded: guarded.purchase.amountPaid,
      refundState: RefundMoneyState.Pending,
      refundStateChangedAt: now.toISOString(),
    });
    if (!decided) return refuse("already_decided");

    applyApproval(tx, guarded.purchase, now);

    return { ok: true as const, refundRequest: decided, purchase: guarded.purchase };
  });

  if (!outcome.ok) return outcome;

  const email = buildRefundApprovedEmail(db, outcome.purchase);
  sendEmail(email);
  return { ok: true, refundRequest: outcome.refundRequest, email };
}

/**
 * An Admin declines an Open Refund Request with a reason the learner will
 * see. The reason is kept apart from the learner's own. The learner may
 * raise a new request while they are still eligible.
 */
export function declineRefundRequest(
  db: Db,
  admin: Admin,
  refundRequest: RefundRequestRef,
  declineReason: string,
  now: Date = new Date()
): DecisionOutcome {
  const reason = declineReason.trim();

  const outcome = db.transaction((tx) => {
    const guarded = guardDecision(tx, admin, refundRequest);
    if (!guarded.ok) return guarded;

    if (!reason) return refuse("decline_reason_missing");

    const decided = decideIfOpen(tx, refundRequest, {
      status: RefundStatus.Declined,
      resolvedAt: now.toISOString(),
      resolvedByUserId: admin.id,
      declineReason: reason,
    });
    if (!decided) return refuse("already_decided");

    return { ok: true as const, refundRequest: decided, purchase: guarded.purchase };
  });

  if (!outcome.ok) return outcome;

  const email = buildRefundDeclinedEmail(db, outcome.purchase, reason);
  sendEmail(email);
  return { ok: true, refundRequest: outcome.refundRequest, email };
}

/** Why an Admin's decision was refused. */
export type DecisionRefusal =
  | "not_found"
  | "already_decided"
  | "own_request"
  | "decline_reason_missing";

/** What the Admin is told when a decision is refused. */
export function describeDecisionRefusal(refusal: DecisionRefusal) {
  switch (refusal) {
    case "not_found":
      return "That refund request doesn't exist.";
    case "already_decided":
      return "This request was already decided.";
    case "own_request":
      return "You can't decide a refund request on your own purchase.";
    case "decline_reason_missing":
      return "Give the learner a reason for declining.";
  }
}

function refuse(refusal: DecisionRefusal) {
  return { ok: false as const, refusal };
}

/**
 * The checks every decision passes before it changes anything. Add new
 * decision guards here so approve and decline both get them.
 */
function guardDecision(
  db: Db,
  admin: Admin,
  refundRequest: RefundRequestRef
):
  | { ok: true; request: RefundRequestRow; purchase: Purchase }
  | { ok: false; refusal: DecisionRefusal } {
  const row = db
    .select({ request: refunds, purchase: purchases })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .where(eq(refunds.id, refundRequest.id))
    .get();

  if (!row) return refuse("not_found");
  if (row.request.status !== RefundStatus.Open) return refuse("already_decided");

  // No conflict of interest: an Admin can't decide on their own money.
  if (row.purchase.userId === admin.id) return refuse("own_request");

  return { ok: true, request: row.request, purchase: row.purchase };
}

/**
 * Records a decision only while the request is still open. With two
 * simultaneous decisions, the first update wins and the second matches no
 * row, so it comes back undefined ("already decided").
 */
function decideIfOpen(
  db: Db,
  refundRequest: RefundRequestRef,
  decision: Partial<typeof refunds.$inferInsert>
) {
  return db
    .update(refunds)
    .set(decision)
    .where(
      and(
        eq(refunds.id, refundRequest.id),
        eq(refunds.status, RefundStatus.Open)
      )
    )
    .returning()
    .get();
}

/**
 * Everything approval does beyond recording the decision. Runs inside the
 * approval transaction, after the guarded update has won. Add further
 * approval effects (e.g. voiding a team Purchase's unclaimed Coupons) here;
 * `now` is the approval time, for anything that needs stamping.
 */
function applyApproval(tx: Db, purchase: Purchase, now: Date) {
  endEnrollment(tx, purchase);
}

/**
 * The learner loses access at once. Only the Enrollment goes: lesson
 * progress, quiz attempts and watch history stay, hidden because they're
 * shown only to enrolled learners, and come back when a repurchase creates a
 * new Enrollment (ADR 0002). Don't delete them here.
 */
function endEnrollment(tx: Db, purchase: Purchase) {
  tx.delete(enrollments)
    .where(
      and(
        eq(enrollments.userId, purchase.userId),
        eq(enrollments.courseId, purchase.courseId)
      )
    )
    .run();
}

// ─── Refund queue ───
// What Admins see when deciding. Each entry carries the review context, so
// an Admin can tell a genuine mismatch from a learner who finished the course.

export type RefundQueueEntry = {
  id: number;
  reason: string;
  requestedAt: string;
  discretionary: boolean;
  learner: { id: number; name: string; email: string };
  course: { id: number; title: string; slug: string };
  purchase: { id: number; amountPaid: number; purchasedAt: string };
  secondsWatched: number;
  lessonsCompleted: number;
  lessonCount: number;
  /** Decided Refund Requests on the same purchase, oldest first. */
  earlierRequests: EarlierRefundRequest[];
};

export type EarlierRefundRequest = Pick<
  RefundRequestRow,
  "id" | "status" | "reason" | "declineReason" | "requestedAt" | "resolvedAt"
>;

/** Open Refund Requests, oldest first, with their review context. */
export function listOpenRefundRequests(db: Db): RefundQueueEntry[] {
  const rows = db
    .select({
      request: refunds,
      purchase: purchases,
      learner: { id: users.id, name: users.name, email: users.email },
      course: { id: courses.id, title: courses.title, slug: courses.slug },
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.status, RefundStatus.Open))
    .orderBy(asc(refunds.requestedAt), asc(refunds.id))
    .all();

  return rows.map(({ request, purchase, learner, course }) => {
    const lessonIds = getCourseLessonIds(db, course.id);
    return {
      id: request.id,
      reason: request.reason,
      requestedAt: request.requestedAt,
      discretionary: request.discretionary,
      learner,
      course,
      purchase: {
        id: purchase.id,
        amountPaid: purchase.amountPaid,
        purchasedAt: purchase.createdAt,
      },
      secondsWatched: getSecondsWatched(db, learner.id, lessonIds),
      lessonsCompleted: getCompletedLessonCount(db, learner.id, lessonIds),
      lessonCount: lessonIds.length,
      earlierRequests: getEarlierRequests(db, purchase.id, request.id),
    };
  });
}

function getEarlierRequests(
  db: Db,
  purchaseId: number,
  currentRequestId: number
): EarlierRefundRequest[] {
  return db
    .select({
      id: refunds.id,
      status: refunds.status,
      reason: refunds.reason,
      declineReason: refunds.declineReason,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
    })
    .from(refunds)
    .where(
      and(eq(refunds.purchaseId, purchaseId), ne(refunds.id, currentRequestId))
    )
    .orderBy(asc(refunds.requestedAt), asc(refunds.id))
    .all();
}

// ─── Learner's Refund Requests ───
// What a learner sees in Settings: every request they have raised, decided
// or not, so they can follow its outcome.

export type LearnerRefundRequest = {
  id: number;
  reason: string;
  requestedAt: string;
  course: { id: number; title: string; slug: string };
  amountPaid: number;
  outcome: LearnerRefundOutcome;
};

/** Where a Refund Request stands, as the learner is allowed to see it. */
export type LearnerRefundOutcome =
  | { status: "open" }
  | { status: "refund_pending" }
  | { status: "refund_issued" }
  | { status: "declined"; declineReason: string };

/** All of the learner's Refund Requests, newest first. */
export function listRefundRequestsForLearner(
  db: Db,
  learner: Learner
): LearnerRefundRequest[] {
  const rows = db
    .select({
      request: refunds,
      course: { id: courses.id, title: courses.title, slug: courses.slug },
      amountPaid: purchases.amountPaid,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(purchases.userId, learner.id))
    .orderBy(desc(refunds.requestedAt), desc(refunds.id))
    .all();

  return rows.map(({ request, course, amountPaid }) => ({
    id: request.id,
    reason: request.reason,
    requestedAt: request.requestedAt,
    course,
    amountPaid,
    outcome: learnerOutcome(request),
  }));
}

/** What Settings tells the learner about a request's outcome. */
export function describeLearnerRefundOutcome(outcome: LearnerRefundOutcome) {
  switch (outcome.status) {
    case "open":
      return "Waiting on us";
    case "refund_pending":
      return "Refund pending";
    case "refund_issued":
      return "Refund issued";
    case "declined":
      return `Declined: ${outcome.declineReason}`;
  }
}

function learnerOutcome(request: RefundRequestRow): LearnerRefundOutcome {
  switch (request.status) {
    case RefundStatus.Open:
      return { status: "open" };
    case RefundStatus.Approved:
      // A Failed Refund is the Admins' problem to fix; the learner sees it
      // as still on its way.
      return request.refundState === RefundMoneyState.Issued
        ? { status: "refund_issued" }
        : { status: "refund_pending" };
    case RefundStatus.Declined:
      return { status: "declined", declineReason: request.declineReason ?? "" };
  }
}

// ─── Emails ───
// There is no mail transport yet, so built emails go to the server log.

export type RefundEmail = { to: string; subject: string; body: string };

function sendEmail(email: RefundEmail) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}

function emailContext(db: Db, purchase: Purchase) {
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

  return {
    to: learner?.email ?? "",
    learnerName: learner?.name ?? "there",
    courseTitle: course?.title ?? "your course",
  };
}

function buildRefundApprovedEmail(db: Db, purchase: Purchase): RefundEmail {
  const { to, learnerName, courseTitle } = emailContext(db, purchase);

  return {
    to,
    subject: `Refund approved — ${courseTitle}`,
    body: [
      `Hi ${learnerName},`,
      "",
      `We have approved your refund request for "${courseTitle}".`,
      `We are sending you ${formatPrice(purchase.amountPaid)}, the full amount you paid.`,
      "Your access to the course has ended. If you buy it again later, your progress will be waiting for you.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

function buildRefundDeclinedEmail(
  db: Db,
  purchase: Purchase,
  declineReason: string
): RefundEmail {
  const { to, learnerName, courseTitle } = emailContext(db, purchase);

  return {
    to,
    subject: `Refund request declined — ${courseTitle}`,
    body: [
      `Hi ${learnerName},`,
      "",
      `We have looked at your refund request for "${courseTitle}" and declined it.`,
      "",
      "Our reason:",
      declineReason,
      "",
      "You keep full access to the course.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

function buildRefundRequestedEmail(db: Db, purchase: Purchase): RefundEmail {
  const { to, learnerName, courseTitle } = emailContext(db, purchase);

  return {
    to,
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
