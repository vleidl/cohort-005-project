import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import {
  createTestDb,
  seedBaseData,
  addLessons,
  addUser,
  buyCourse,
  daysAgo,
  requestAs,
} from "~/test/setup";
import {
  checkRefundEligibility,
  raiseRefundRequest,
  type RefundIneligibility,
} from "./refunds.server";
import { getAccess } from "./access.server";

let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  lessonIds = addLessons(db, base.course.id, 10);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

// ─── Scenario helpers ───
// These set up what a learner has done, the way the app would record it.

function watch(userId: number, lessonId: number, seconds: number) {
  db.insert(schema.videoWatchEvents)
    .values({
      userId,
      lessonId,
      eventType: "progress",
      positionSeconds: seconds,
    })
    .run();
}

function complete(userId: number, completedLessonIds: number[]) {
  for (const lessonId of completedLessonIds) {
    db.insert(schema.lessonProgress)
      .values({
        userId,
        lessonId,
        status: schema.LessonProgressStatus.Completed,
        completedAt: new Date().toISOString(),
      })
      .run();
  }
}

// Approving and declining belong to later slices of the refunds module; until
// then these record the decision directly.
function decide(refundRequestId: number, status: schema.RefundStatus) {
  db.update(schema.refunds)
    .set({ status })
    .where(eq(schema.refunds.id, refundRequestId))
    .run();
}

function teamPurchaseWithCoupon(buyerId: number) {
  const purchase = buyCourse(db, buyerId, base.course.id);
  const team = db.insert(schema.teams).values({}).returning().get();
  const coupon = db
    .insert(schema.coupons)
    .values({
      teamId: team.id,
      courseId: base.course.id,
      code: `TEAM-${purchase.id}`,
      purchaseId: purchase.id,
    })
    .returning()
    .get();
  return { purchase, coupon };
}

/**
 * The course page offers a refund exactly when the refund action would
 * accept one — both ask checkRefundEligibility. Asserting both here keeps
 * them from drifting apart again.
 */
function expectBlockedBy(
  learner: { id: number },
  purchase: typeof schema.purchases.$inferSelect,
  rule: RefundIneligibility
) {
  expect(checkRefundEligibility(db, learner, purchase)).toEqual({
    eligible: false,
    rule,
  });
  expect(raiseRefundRequest(db, learner, purchase, "Please refund.")).toEqual({
    ok: false,
    rule,
  });
}

describe("raising a Refund Request", () => {
  it("lets a learner who just bought the course raise one for the amount they paid", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id, {
      amountPaid: 7900,
    });

    expect(checkRefundEligibility(db, base.user, purchase)).toMatchObject({
      eligible: true,
      amount: 7900,
    });

    const outcome = raiseRefundRequest(
      db,
      base.user,
      purchase,
      "Not what I expected."
    );

    expect(outcome).toMatchObject({
      ok: true,
      refundRequest: {
        status: schema.RefundStatus.Open,
        reason: "Not what I expected.",
        discretionary: false,
      },
    });
  });

  it("emails the learner a confirmation promising a follow-up", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id, {
      amountPaid: 7900,
    });

    const outcome = raiseRefundRequest(db, base.user, purchase, "Wrong one.");

    if (!outcome.ok) throw new Error("expected the request to be raised");
    expect(outcome.email.to).toBe(base.user.email);
    expect(outcome.email.subject).toBe("Refund requested — Test Course");
    expect(outcome.email.body).toContain("$79");
    expect(outcome.email.body).toContain("we will email you again when it is done");
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("subject=Refund requested — Test Course")
    );
  });
});

describe("Refund Eligibility", () => {
  // Each rule is tested on its own: everything else about the learner is
  // eligible, so the one thing set up is the only thing that can block.

  it("blocks a second request while one is still open", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    raiseRefundRequest(db, base.user, purchase, "First ask.");

    expectBlockedBy(base.user, purchase, "request_already_open");
  });

  describe("the 14-calendar-day window", () => {
    it("is still open on the fourteenth day after purchase", () => {
      const purchase = buyCourse(db, base.user.id, base.course.id, {
        purchasedAt: daysAgo(14),
      });

      expect(checkRefundEligibility(db, base.user, purchase).eligible).toBe(
        true
      );
    });

    it("has closed on the fifteenth day", () => {
      const purchase = buyCourse(db, base.user.id, base.course.id, {
        purchasedAt: daysAgo(15),
      });

      expectBlockedBy(base.user, purchase, "window_closed");
    });

    // Counted in whole days: a purchase late in the evening still gets all
    // of its fourteenth day, not just until the same time of day.
    it("counts whole calendar days, not hours", () => {
      const purchasedAt = new Date(2026, 0, 1, 23, 30);
      const lateOnDay14 = new Date(2026, 0, 15, 23, 59);
      const purchase = buyCourse(db, base.user.id, base.course.id, {
        purchasedAt: purchasedAt.toISOString(),
      });

      expect(
        checkRefundEligibility(db, base.user, purchase, lateOnDay14).eligible
      ).toBe(true);
    });
  });

  describe("the 2-hour watch limit", () => {
    it("still allows a learner who has watched just under 2 hours", () => {
      const purchase = buyCourse(db, base.user.id, base.course.id);
      watch(base.user.id, lessonIds[0], 3600);
      watch(base.user.id, lessonIds[1], 3599);

      expect(checkRefundEligibility(db, base.user, purchase).eligible).toBe(
        true
      );
    });

    it("blocks a learner who has watched 2 hours across lessons", () => {
      const purchase = buyCourse(db, base.user.id, base.course.id);
      watch(base.user.id, lessonIds[0], 3600);
      watch(base.user.id, lessonIds[1], 3600);

      expectBlockedBy(base.user, purchase, "watched_too_much");
    });

    // Rewatching a lesson doesn't add up: only the furthest point reached
    // in each lesson counts.
    it("counts each lesson's furthest point once, not every rewatch", () => {
      const purchase = buyCourse(db, base.user.id, base.course.id);
      watch(base.user.id, lessonIds[0], 3000);
      watch(base.user.id, lessonIds[0], 3000);
      watch(base.user.id, lessonIds[0], 3000);

      expect(checkRefundEligibility(db, base.user, purchase).eligible).toBe(
        true
      );
    });
  });

  describe("the 50% completion limit", () => {
    it("still allows a learner who has completed under half the lessons", () => {
      const purchase = buyCourse(db, base.user.id, base.course.id);
      complete(base.user.id, lessonIds.slice(0, 4));

      expect(checkRefundEligibility(db, base.user, purchase).eligible).toBe(
        true
      );
    });

    it("blocks a learner who has completed half the lessons", () => {
      const purchase = buyCourse(db, base.user.id, base.course.id);
      complete(base.user.id, lessonIds.slice(0, 5));

      expectBlockedBy(base.user, purchase, "completed_too_much");
    });
  });

  it("blocks a team Purchase once one of its seats has been claimed", () => {
    const { purchase, coupon } = teamPurchaseWithCoupon(base.user.id);
    const teamMember = addUser(db, "Team Member");
    db.update(schema.coupons)
      .set({
        redeemedByUserId: teamMember.id,
        redeemedAt: new Date().toISOString(),
      })
      .where(eq(schema.coupons.id, coupon.id))
      .run();

    expectBlockedBy(base.user, purchase, "claimed_team_seat");
  });

  it("allows a team Purchase whose seats are all unclaimed", () => {
    const { purchase } = teamPurchaseWithCoupon(base.user.id);

    expect(checkRefundEligibility(db, base.user, purchase).eligible).toBe(true);
  });

  // A learner gets at most one Refund per course. Buying it again after a
  // Refund is allowed, but that purchase can't be refunded the normal way.
  it("blocks a repurchase after an earlier Refund for the same course", () => {
    const firstPurchase = buyCourse(db, base.user.id, base.course.id, {
      purchasedAt: daysAgo(10),
    });
    const raised = raiseRefundRequest(db, base.user, firstPurchase, "Ask.");
    if (!raised.ok) throw new Error("expected the request to be raised");
    decide(raised.refundRequest.id, schema.RefundStatus.Approved);

    const repurchase = buyCourse(db, base.user.id, base.course.id);

    expectBlockedBy(base.user, repurchase, "already_refunded");
  });

  it("does not count a declined request as an earlier Refund", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    const raised = raiseRefundRequest(db, base.user, purchase, "Ask.");
    if (!raised.ok) throw new Error("expected the request to be raised");
    decide(raised.refundRequest.id, schema.RefundStatus.Declined);

    expect(checkRefundEligibility(db, base.user, purchase).eligible).toBe(true);
  });

  it("only lets the purchaser ask", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    const someoneElse = addUser(db, "Someone Else");

    expectBlockedBy(someoneElse, purchase, "not_purchaser");
  });
});

describe("while a Refund Request is open", () => {
  // Access is lost only when an Admin approves. A learner who is declined
  // shouldn't have been locked out in the meantime.
  it("keeps the learner's full access to the course", async () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    raiseRefundRequest(db, base.user, purchase, "Thinking about it.");

    const access = await getAccess(
      db,
      await requestAs(base.user.id),
      base.course.id
    );

    expect(access.enrolled).toBe(true);
    expect(access.canViewContent).toBe(true);
  });
});
