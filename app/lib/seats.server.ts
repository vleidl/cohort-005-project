import { and, eq } from "drizzle-orm";
import type { Db } from "~/db";
import { seats, enrollments, purchases } from "~/db/schema";

// ─── Seats ───
// A Team Purchase hands out Seats, each with its own code. Claiming a Seat
// enrolls whoever claimed it.

export type ClaimSeatResult =
  | { ok: true; enrollment: typeof enrollments.$inferSelect }
  | { ok: false; error: string };

/** A Seat is voided when its Team Purchase is refunded. */
export const VOIDED_SEAT_MESSAGE =
  "This seat was cancelled because its purchase was refunded.";

export function getSeatByCode(db: Db, code: string) {
  return db.select().from(seats).where(eq(seats.code, code)).get();
}

/** Anyone with a Seat's code can claim it. */
export function claimSeat(
  db: Db,
  code: string,
  userId: number,
  userCountry: string
): ClaimSeatResult {
  const seat = getSeatByCode(db, code);
  if (!seat) {
    return { ok: false, error: "Seat not found" };
  }

  if (seat.voidedAt !== null) {
    return { ok: false, error: VOIDED_SEAT_MESSAGE };
  }

  if (seat.claimedByUserId !== null) {
    return { ok: false, error: "Seat has already been claimed" };
  }

  const existingEnrollment = db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, seat.courseId)
      )
    )
    .get();

  if (existingEnrollment) {
    return { ok: false, error: "You are already enrolled in this course" };
  }

  const purchase = db
    .select()
    .from(purchases)
    .where(eq(purchases.id, seat.purchaseId))
    .get();

  if (purchase?.country && purchase.country !== userCountry) {
    return {
      ok: false,
      error:
        "This seat can only be claimed from the same country as the purchaser",
    };
  }

  db.update(seats)
    .set({
      claimedByUserId: userId,
      claimedAt: new Date().toISOString(),
    })
    .where(eq(seats.id, seat.id))
    .run();

  const enrollment = db
    .insert(enrollments)
    .values({ userId, courseId: seat.courseId })
    .returning()
    .get();

  return { ok: true, enrollment };
}
