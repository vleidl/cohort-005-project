import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  sql,
} from "drizzle-orm";
import type { Db } from "~/db";
import {
  courses,
  seats,
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
  UserRole,
} from "~/db/schema";
import {
  buildDiscretionaryRefundRequestedEmail,
  buildRefundApprovedEmail,
  buildRefundDeclinedEmail,
  buildRefundRequestedEmail,
  sendEmail,
  type RefundEmail,
} from "~/lib/refund-emails.server";

// ─── Refunds ───
// Refund Requests: raising, deciding and listing them. Routes load the
// session, call in, and turn the outcome into a response — so the course
// page's refund offer and the refund action can never disagree.
//
// Close by: the Refund's money states (`~/lib/refund-money.server`), the
// emails to the learner (`~/lib/refund-emails.server`), and what each
// refusal tells the person (`~/lib/refund-refusals.server`).
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

/** The learner's most recent purchase of a course, if any. */
export function findLatestPurchase(
  db: Db,
  learnerId: number,
  courseId: number
) {
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

export type RefundOffer =
  | { available: true; amount: number; lastDayInWindow: string }
  | { available: false; rule: RefundIneligibility };

/**
 * What the course page offers the learner on their latest purchase: a
 * refund, the rule that stops one, or nothing (null) when they have no
 * purchase to refund. Asks the same Refund Eligibility check as
 * `raiseRefundRequest`, so the page never offers a refund the action would
 * refuse.
 */
export function getRefundOffer(
  db: Db,
  learner: Learner,
  courseId: number,
  now: Date = new Date()
): RefundOffer | null {
  const purchase = findLatestPurchase(db, learner.id, courseId);
  if (!purchase) return null;

  // A team buyer isn't enrolled — the seats are for their team — but can
  // still refund a team Purchase nobody has claimed a seat from. Anyone
  // else who isn't enrolled has nothing left to refund.
  if (
    !isEnrolled(db, learner.id, courseId) &&
    !isTeamPurchase(db, purchase.id)
  ) {
    return null;
  }

  const eligibility = checkRefundEligibility(db, learner, purchase, now);
  if (!eligibility.eligible) {
    return { available: false, rule: eligibility.rule };
  }

  return {
    available: true,
    amount: eligibility.amount,
    lastDayInWindow: eligibility.lastDayInWindow,
  };
}

/**
 * Whether buying the course again could be refunded the normal way. False
 * once the learner has had a Refund for the course: at most one Refund per
 * course, so a repurchase can only be refunded through a Discretionary
 * Refund Request. The course page warns them before they buy.
 */
export function canRefundRepurchase(
  db: Db,
  learner: Learner,
  courseId: number
) {
  return !hasApprovedRefundForCourse(db, learner.id, courseId);
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

export type Admin = { id: number };
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

    return {
      ok: true as const,
      refundRequest: decided,
      purchase: guarded.purchase,
    };
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

    return {
      ok: true as const,
      refundRequest: decided,
      purchase: guarded.purchase,
    };
  });

  if (!outcome.ok) return outcome;

  const email = buildRefundDeclinedEmail(db, outcome.purchase, reason);
  sendEmail(email);
  return { ok: true, refundRequest: outcome.refundRequest, email };
}

/** Why an Admin's decision was refused. */
export type DecisionRefusal =
  | "not_admin"
  | "not_found"
  | "already_decided"
  | "own_request"
  | "decline_reason_missing"
  | "own_discretionary_request"
  | "sole_admin_discretionary_request";

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
  if (!isAdmin(db, admin)) return refuse("not_admin");

  const row = db
    .select({ request: refunds, purchase: purchases })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .where(eq(refunds.id, refundRequest.id))
    .get();

  if (!row) return refuse("not_found");
  if (row.request.status !== RefundStatus.Open)
    return refuse("already_decided");

  // No conflict of interest: an Admin can't decide on their own money.
  if (row.purchase.userId === admin.id) return refuse("own_request");

  // A Discretionary Refund Request sets the rules aside, so a different
  // Admin must decide it. With no other Admin, it waits until one exists.
  if (row.request.discretionary && row.request.raisedByUserId === admin.id) {
    return refuse(
      hasOtherAdmin(db, admin.id)
        ? "own_discretionary_request"
        : "sole_admin_discretionary_request"
    );
  }

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
 * approval effects here; `now` is the approval time, for anything that
 * needs stamping.
 */
function applyApproval(tx: Db, purchase: Purchase, now: Date) {
  endEnrollment(tx, purchase);
  voidUnclaimedSeats(tx, purchase, now);
}

/**
 * Seats that were paid back can't still let someone in. Claimed seats are
 * never voided: Refund Eligibility refuses a team Purchase once any seat is
 * claimed, so by approval every Seat on it is unclaimed.
 */
function voidUnclaimedSeats(tx: Db, purchase: Purchase, now: Date) {
  tx.update(seats)
    .set({ voidedAt: now.toISOString() })
    .where(
      and(
        eq(seats.purchaseId, purchase.id),
        isNull(seats.claimedAt),
        isNull(seats.voidedAt)
      )
    )
    .run();
}

/**
 * The learner loses access at once. Only the Enrollment goes: lesson
 * progress, quiz attempts and watch history stay, hidden because they're
 * shown only to enrolled learners, and come back when a repurchase creates a
 * new Enrollment (ADR 0002). Don't delete them here.
 *
 * The Enrollment stays while the learner holds another purchase of the
 * course with no Approved Refund Request — the same rule ratings use to
 * decide a learner is refunded (`~/lib/ratings.server`). Runs after the
 * approval is recorded, so this purchase already counts as refunded.
 */
function endEnrollment(tx: Db, purchase: Purchase) {
  if (hasUnrefundedPurchaseOfCourse(tx, purchase.userId, purchase.courseId)) {
    return;
  }

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
  /** The Admin who raised a Discretionary Refund Request; null otherwise. */
  raisedBy: { id: number; name: string } | null;
  /**
   * A Discretionary Refund Request whose raiser is the only Admin: nobody
   * can decide it until a second Admin exists.
   */
  soleAdminWarning: boolean;
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
      raisedBy: getRaisedBy(db, request.raisedByUserId),
      soleAdminWarning:
        request.discretionary &&
        request.raisedByUserId !== null &&
        !hasOtherAdmin(db, request.raisedByUserId),
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

function getRaisedBy(db: Db, raisedByUserId: number | null) {
  if (raisedByUserId === null) return null;
  return (
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, raisedByUserId))
      .get() ?? null
  );
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

// ─── Discretionary Refund Requests ───
// For genuinely exceptional cases, an Admin raises a Refund Request on a
// learner's behalf with their own reason. It sets Refund Eligibility aside —
// the window, watch limit, completion limit and one-Refund-per-course rule —
// and a different Admin must decide it (see `guardDecision`), so one person
// can't send money out against the rules alone (ADR 0001).

/**
 * The rules even a Discretionary Refund Request never overrides. It sets
 * aside one Refund per course, but never one Refund per purchase.
 */
export type DiscretionaryRefundIneligibility =
  | Extract<
      RefundIneligibility,
      "not_purchaser" | "request_already_open" | "claimed_team_seat"
    >
  | "purchase_already_refunded";

/** Why a Discretionary Refund Request couldn't be raised. */
export type DiscretionaryRefusal =
  DiscretionaryRefundIneligibility | "not_admin";

export type RaiseDiscretionaryRefundRequestOutcome =
  | {
      ok: true;
      refundRequest: typeof refunds.$inferSelect;
      email: RefundEmail;
    }
  | { ok: false; rule: DiscretionaryRefusal };

/**
 * An Admin raises a Discretionary Refund Request for a learner's purchase.
 * It still can't take a claimed seat from a team, or open a second request
 * on a purchase that already has one.
 */
export function raiseDiscretionaryRefundRequest(
  db: Db,
  admin: Admin,
  learner: Learner,
  purchase: Purchase,
  reason: string,
  now: Date = new Date()
): RaiseDiscretionaryRefundRequestOutcome {
  const outcome = db.transaction((tx) => {
    if (!isAdmin(tx, admin)) {
      return { ok: false as const, rule: "not_admin" as const };
    }

    const rule = checkDiscretionaryRules(tx, learner, purchase);
    if (rule) return { ok: false as const, rule };

    const refundRequest = tx
      .insert(refunds)
      .values({
        purchaseId: purchase.id,
        status: RefundStatus.Open,
        reason,
        requestedAt: now.toISOString(),
        discretionary: true,
        raisedByUserId: admin.id,
      })
      .returning()
      .get();

    return { ok: true as const, refundRequest };
  });

  if (!outcome.ok) return outcome;

  const email = buildDiscretionaryRefundRequestedEmail(db, purchase);
  sendEmail(email);

  return { ...outcome, email };
}

export type PurchaseForDiscretionaryRefund = {
  id: number;
  amountPaid: number;
  purchasedAt: string;
  learner: { id: number; name: string; email: string };
  course: { id: number; title: string };
};

/** Purchases an Admin can choose from when raising one, newest first. */
export function listPurchasesForDiscretionaryRefund(
  db: Db
): PurchaseForDiscretionaryRefund[] {
  return db
    .select({
      id: purchases.id,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
      learner: { id: users.id, name: users.name, email: users.email },
      course: { id: courses.id, title: courses.title },
    })
    .from(purchases)
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .orderBy(desc(purchases.createdAt), desc(purchases.id))
    .all();
}

/**
 * Callers pass an Admin, but the module checks the role itself: no route
 * can decide a Refund Request or move money for someone who isn't one.
 */
export function isAdmin(db: Db, admin: Admin) {
  return !!db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, admin.id), eq(users.role, UserRole.Admin)))
    .get();
}

/** Whether some Admin other than this one could decide a request. */
function hasOtherAdmin(db: Db, adminId: number) {
  return !!db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, UserRole.Admin), ne(users.id, adminId)))
    .get();
}

function checkDiscretionaryRules(
  db: Db,
  learner: Learner,
  purchase: Purchase
): DiscretionaryRefundIneligibility | null {
  if (purchase.userId !== learner.id) return "not_purchaser";
  if (hasOpenRefundRequest(db, purchase.id)) return "request_already_open";
  if (hasApprovedRefundRequest(db, purchase.id))
    return "purchase_already_refunded";
  if (hasClaimedSeat(db, purchase.id)) return "claimed_team_seat";
  return null;
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

function hasApprovedRefundRequest(db: Db, purchaseId: number) {
  return !!db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Approved)
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

function hasUnrefundedPurchaseOfCourse(
  db: Db,
  learnerId: number,
  courseId: number
) {
  return !!db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.userId, learnerId),
        eq(purchases.courseId, courseId),
        notExists(
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
    .get();
}

function isEnrolled(db: Db, learnerId: number, courseId: number) {
  return !!db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, learnerId), eq(enrollments.courseId, courseId))
    )
    .get();
}

function isTeamPurchase(db: Db, purchaseId: number) {
  return !!db
    .select({ id: seats.id })
    .from(seats)
    .where(eq(seats.purchaseId, purchaseId))
    .get();
}

function hasClaimedSeat(db: Db, purchaseId: number) {
  return !!db
    .select({ id: seats.id })
    .from(seats)
    .where(
      and(eq(seats.purchaseId, purchaseId), isNotNull(seats.claimedAt))
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
