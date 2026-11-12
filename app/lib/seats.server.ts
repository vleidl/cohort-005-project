import { and, eq } from "drizzle-orm";
import { db } from "~/db";
import { coupons, enrollments, purchases } from "~/db/schema";

export type RedeemResult =
  | { ok: true; enrollment: typeof enrollments.$inferSelect }
  | { ok: false; error: string };

/**
 * Claims a Seat of a Team Purchase by its code, enrolling the student in the
 * Course.
 */
export function redeemSeat(
  code: string,
  userId: number,
  userCountry: string
): RedeemResult {
  const seat = db.select().from(coupons).where(eq(coupons.code, code)).get();
  if (!seat) {
    return { ok: false, error: "Seat not found." };
  }

  if (seat.refundId !== null) {
    return { ok: false, error: "This Seat has been refunded." };
  }

  if (seat.redeemedByUserId !== null) {
    return { ok: false, error: "This Seat has already been claimed." };
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
        "This Seat can only be claimed from the same country as the person who bought it.",
    };
  }

  db.update(coupons)
    .set({
      redeemedByUserId: userId,
      redeemedAt: new Date().toISOString(),
    })
    .where(eq(coupons.id, seat.id))
    .run();

  const enrollment = db
    .insert(enrollments)
    .values({ userId, courseId: seat.courseId })
    .returning()
    .get();

  return { ok: true, enrollment };
}
