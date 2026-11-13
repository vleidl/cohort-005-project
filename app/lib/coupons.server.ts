import { and, eq } from "drizzle-orm";
import type { Db } from "~/db";
import { coupons, enrollments, purchases } from "~/db/schema";

// ─── Coupons ───
// A team Purchase hands out one Coupon per seat. Redeeming a Coupon claims
// the seat and enrolls the team member who redeemed it.

export type RedeemResult =
  | { ok: true; enrollment: typeof enrollments.$inferSelect }
  | { ok: false; error: string };

/** A Coupon is voided when its team Purchase is refunded. */
export const VOIDED_COUPON_MESSAGE =
  "This coupon was cancelled because its purchase was refunded.";

export function getCouponByCode(db: Db, code: string) {
  return db.select().from(coupons).where(eq(coupons.code, code)).get();
}

/** A team member claims a seat with a Coupon code. */
export function redeemCoupon(
  db: Db,
  code: string,
  userId: number,
  userCountry: string
): RedeemResult {
  const coupon = getCouponByCode(db, code);
  if (!coupon) {
    return { ok: false, error: "Coupon not found" };
  }

  if (coupon.voidedAt !== null) {
    return { ok: false, error: VOIDED_COUPON_MESSAGE };
  }

  if (coupon.redeemedByUserId !== null) {
    return { ok: false, error: "Coupon has already been redeemed" };
  }

  const existingEnrollment = db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, coupon.courseId)
      )
    )
    .get();

  if (existingEnrollment) {
    return { ok: false, error: "You are already enrolled in this course" };
  }

  const purchase = db
    .select()
    .from(purchases)
    .where(eq(purchases.id, coupon.purchaseId))
    .get();

  if (purchase?.country && purchase.country !== userCountry) {
    return {
      ok: false,
      error:
        "This coupon can only be redeemed from the same country as the purchaser",
    };
  }

  db.update(coupons)
    .set({
      redeemedByUserId: userId,
      redeemedAt: new Date().toISOString(),
    })
    .where(eq(coupons.id, coupon.id))
    .run();

  const enrollment = db
    .insert(enrollments)
    .values({ userId, courseId: coupon.courseId })
    .returning()
    .get();

  return { ok: true, enrollment };
}
