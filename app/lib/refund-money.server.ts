import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "~/db";
import {
  courses,
  purchases,
  refunds,
  users,
  RefundMoneyState,
  RefundStatus,
} from "~/db/schema";
import { isAdmin, type Admin } from "~/lib/refunds.server";

// ─── Refund money states ───
// Approval creates a Pending Refund. There is no payment provider, so an
// Admin records by hand whether the money went out: Pending → Issued,
// Pending → Failed, or Failed → Issued (a retry). Issued is final. The
// Refund Request stays Approved throughout — the decision and the money are
// separate.

/** A Refund has no id of its own: it is known by its Refund Request's id. */
type RefundRef = { id: number };

/** The money an Approved Refund Request sends back, and where it stands. */
export type Refund = {
  refundRequestId: number;
  amountRefunded: number;
  state: RefundMoneyState;
  stateChangedAt: string | null;
};

/** Why a change to a Refund's state was refused. */
export type RefundStateRefusal =
  "not_admin" | "no_refund" | "already_issued" | "already_failed";

export type RefundStateOutcome =
  { ok: true; refund: Refund } | { ok: false; refusal: RefundStateRefusal };

/** An Admin confirms the money has been sent. Allowed from Pending or Failed. */
export function markRefundIssued(
  db: Db,
  admin: Admin,
  refund: RefundRef,
  now: Date = new Date()
): RefundStateOutcome {
  if (!isAdmin(db, admin)) return { ok: false, refusal: "not_admin" };
  return moveRefund(
    db,
    refund,
    [RefundMoneyState.Pending, RefundMoneyState.Failed],
    RefundMoneyState.Issued,
    now
  );
}

/** An Admin records that the money couldn't be sent. Allowed from Pending. */
export function markRefundFailed(
  db: Db,
  admin: Admin,
  refund: RefundRef,
  now: Date = new Date()
): RefundStateOutcome {
  if (!isAdmin(db, admin)) return { ok: false, refusal: "not_admin" };
  return moveRefund(
    db,
    refund,
    [RefundMoneyState.Pending],
    RefundMoneyState.Failed,
    now
  );
}

/**
 * Moves a Refund to `to` only while it is in one of the `from` states. The
 * state is part of the update's WHERE, so two Admins acting at once can't
 * both win; the loser is told why from the state that beat them.
 */
function moveRefund(
  db: Db,
  refund: RefundRef,
  from: RefundMoneyState[],
  to: RefundMoneyState,
  now: Date
): RefundStateOutcome {
  const moved = db
    .update(refunds)
    .set({ refundState: to, refundStateChangedAt: now.toISOString() })
    .where(
      and(
        eq(refunds.id, refund.id),
        eq(refunds.status, RefundStatus.Approved),
        inArray(refunds.refundState, from)
      )
    )
    .returning()
    .get();
  if (moved && moved.refundState !== null && moved.amountRefunded !== null) {
    return {
      ok: true,
      refund: {
        refundRequestId: moved.id,
        amountRefunded: moved.amountRefunded,
        state: moved.refundState,
        stateChangedAt: moved.refundStateChangedAt,
      },
    };
  }

  const current = db
    .select({ status: refunds.status, refundState: refunds.refundState })
    .from(refunds)
    .where(eq(refunds.id, refund.id))
    .get();

  if (current?.status !== RefundStatus.Approved) {
    return { ok: false, refusal: "no_refund" };
  }
  if (current.refundState === RefundMoneyState.Issued) {
    return { ok: false, refusal: "already_issued" };
  }
  return { ok: false, refusal: "already_failed" };
}

export type OutstandingRefund = {
  /** The Approved Refund Request this Refund belongs to. */
  id: number;
  refundState: RefundMoneyState;
  refundStateChangedAt: string | null;
  amountRefunded: number;
  approvedAt: string | null;
  learner: { id: number; name: string; email: string };
  course: { id: number; title: string; slug: string };
};

/**
 * Refunds whose money hasn't been confirmed as sent — Pending and Failed —
 * oldest approval first. Issued Refunds are done and drop off.
 */
export function listOutstandingRefunds(db: Db): OutstandingRefund[] {
  return db
    .select({
      id: refunds.id,
      refundState: refunds.refundState,
      refundStateChangedAt: refunds.refundStateChangedAt,
      amountRefunded: refunds.amountRefunded,
      approvedAt: refunds.resolvedAt,
      learner: { id: users.id, name: users.name, email: users.email },
      course: { id: courses.id, title: courses.title, slug: courses.slug },
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        eq(refunds.status, RefundStatus.Approved),
        inArray(refunds.refundState, [
          RefundMoneyState.Pending,
          RefundMoneyState.Failed,
        ])
      )
    )
    .orderBy(asc(refunds.resolvedAt), asc(refunds.id))
    .all()
    .flatMap(({ refundState, amountRefunded, ...rest }) =>
      refundState === null || amountRefunded === null
        ? []
        : [{ ...rest, refundState, amountRefunded }]
    );
}
