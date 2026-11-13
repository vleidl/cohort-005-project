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
  approveRefundRequest,
  checkRefundEligibility,
  declineRefundRequest,
  describeLearnerRefundOutcome,
  listOpenRefundRequests,
  listOutstandingRefunds,
  listPurchasesForDiscretionaryRefund,
  listRefundRequestsForLearner,
  markRefundFailed,
  markRefundIssued,
  raiseDiscretionaryRefundRequest,
  raiseRefundRequest,
  type RefundIneligibility,
} from "./refunds.server";
import { getAccess, requireAdmin } from "./access.server";
import { redeemCoupon } from "./coupons.server";

let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];
let admin: typeof schema.users.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  lessonIds = addLessons(db, base.course.id, 10);
  admin = addUser(db, "Admin", schema.UserRole.Admin);
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

/**
 * The lessons the course page shows a learner as completed. It shows
 * progress only to enrolled learners, so this asks access resolution first.
 */
async function visibleCompletedLessons(userId: number) {
  const access = await getAccess(db, await requestAs(userId), base.course.id);
  if (!access.enrolled) return [];
  return db
    .select({ lessonId: schema.lessonProgress.lessonId })
    .from(schema.lessonProgress)
    .where(eq(schema.lessonProgress.userId, userId))
    .orderBy(schema.lessonProgress.lessonId)
    .all()
    .map((row) => row.lessonId);
}

/** A learner raises a Refund Request the scenario expects to succeed. */
function raise(
  learner: { id: number },
  purchase: typeof schema.purchases.$inferSelect,
  reason = "Not what I expected."
) {
  const outcome = raiseRefundRequest(db, learner, purchase, reason);
  if (!outcome.ok) throw new Error(`expected a request, got ${outcome.rule}`);
  return outcome.refundRequest;
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
    approveRefundRequest(db, admin, raise(base.user, firstPurchase));

    const repurchase = buyCourse(db, base.user.id, base.course.id);

    expectBlockedBy(base.user, repurchase, "already_refunded");
  });

  it("does not count a declined request as an earlier Refund", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    declineRefundRequest(
      db,
      admin,
      raise(base.user, purchase),
      "Please finish the first module before deciding."
    );

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

describe("approving a Refund Request", () => {
  it("takes the learner's access to the course away at once", async () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    const request = raise(base.user, purchase);

    const outcome = approveRefundRequest(db, admin, request);

    expect(outcome.ok).toBe(true);
    const access = await getAccess(
      db,
      await requestAs(base.user.id),
      base.course.id
    );
    expect(access.enrolled).toBe(false);
    expect(access.canViewContent).toBe(false);
  });

  // Access follows the purchases: refunding an older purchase doesn't take
  // away what a later, unrefunded purchase of the course paid for.
  it("keeps access while another purchase of the course is unrefunded", async () => {
    const older = buyCourse(db, base.user.id, base.course.id, {
      purchasedAt: daysAgo(3),
    });
    buyCourse(db, base.user.id, base.course.id);

    expect(approveRefundRequest(db, admin, raise(base.user, older)).ok).toBe(
      true
    );

    const access = await getAccess(
      db,
      await requestAs(base.user.id),
      base.course.id
    );
    expect(access.enrolled).toBe(true);
  });

  // ADR 0002: progress is hidden, not deleted, so it comes back on a
  // repurchase. Deleting it would lose what Admins need to judge later asks.
  it("hides the learner's progress, and brings it back when they buy again", async () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    complete(base.user.id, lessonIds.slice(0, 2));
    approveRefundRequest(db, admin, raise(base.user, purchase));

    expect(await visibleCompletedLessons(base.user.id)).toEqual([]);

    buyCourse(db, base.user.id, base.course.id);

    expect(await visibleCompletedLessons(base.user.id)).toEqual(
      lessonIds.slice(0, 2)
    );
  });

  it("creates a Pending Refund for the full amount paid", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id, {
      amountPaid: 7900,
    });

    const outcome = approveRefundRequest(db, admin, raise(base.user, purchase));

    expect(outcome).toMatchObject({
      ok: true,
      refundRequest: {
        status: schema.RefundStatus.Approved,
        amountRefunded: 7900,
        refundState: schema.RefundMoneyState.Pending,
        resolvedByUserId: admin.id,
      },
    });
  });

  it("emails the learner that their money is on the way", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id, {
      amountPaid: 7900,
    });

    const outcome = approveRefundRequest(db, admin, raise(base.user, purchase));

    if (!outcome.ok) throw new Error("expected approval");
    expect(outcome.email.to).toBe(base.user.email);
    expect(outcome.email.subject).toBe("Refund approved — Test Course");
    expect(outcome.email.body).toContain("$79");
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("subject=Refund approved — Test Course")
    );
  });

  // ADR 0001: eligibility gates asking, not deciding. A slow review must not
  // cost the learner a refund they were entitled to ask for.
  describe("judging the request as it was raised", () => {
    it("can still be approved after the 14-day window has closed", () => {
      const purchase = buyCourse(db, base.user.id, base.course.id, {
        purchasedAt: daysAgo(13),
      });
      const request = raise(base.user, purchase);
      const threeWeeksLater = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);

      expect(
        approveRefundRequest(db, admin, request, threeWeeksLater).ok
      ).toBe(true);
    });

    it("can still be approved after the learner kept watching", () => {
      const purchase = buyCourse(db, base.user.id, base.course.id);
      const request = raise(base.user, purchase);
      watch(base.user.id, lessonIds[0], 3600);
      watch(base.user.id, lessonIds[1], 3600);
      complete(base.user.id, lessonIds.slice(0, 8));

      expect(approveRefundRequest(db, admin, request).ok).toBe(true);
    });
  });
});

describe("declining a Refund Request", () => {
  it("needs a reason for the learner", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    const request = raise(base.user, purchase);

    expect(declineRefundRequest(db, admin, request, "   ")).toEqual({
      ok: false,
      refusal: "decline_reason_missing",
    });
    // Refusing the decline left the request open for a proper decision.
    expect(approveRefundRequest(db, admin, request).ok).toBe(true);
  });

  it("keeps the Admin's reason apart from the learner's, and emails it to them", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    const request = raise(base.user, purchase, "Too advanced for me.");

    const outcome = declineRefundRequest(
      db,
      admin,
      request,
      "You have completed most of the course."
    );

    if (!outcome.ok) throw new Error("expected the decline");
    expect(outcome.refundRequest).toMatchObject({
      status: schema.RefundStatus.Declined,
      reason: "Too advanced for me.",
      declineReason: "You have completed most of the course.",
      amountRefunded: null,
      refundState: null,
    });
    expect(outcome.email.to).toBe(base.user.email);
    expect(outcome.email.body).toContain(
      "You have completed most of the course."
    );
  });

  it("leaves the learner's access alone", async () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    declineRefundRequest(db, admin, raise(base.user, purchase), "No.");

    const access = await getAccess(
      db,
      await requestAs(base.user.id),
      base.course.id
    );
    expect(access.enrolled).toBe(true);
  });
});

describe("decision guards", () => {
  // The guarded update means the first of two decisions wins; the second
  // Admin is told, rather than silently overwriting it.
  it("tells a second Admin the request was already decided", () => {
    const otherAdmin = addUser(db, "Other Admin", schema.UserRole.Admin);
    const purchase = buyCourse(db, base.user.id, base.course.id);
    const request = raise(base.user, purchase);

    approveRefundRequest(db, admin, request);

    expect(declineRefundRequest(db, otherAdmin, request, "No.")).toEqual({
      ok: false,
      refusal: "already_decided",
    });
    expect(approveRefundRequest(db, otherAdmin, request)).toEqual({
      ok: false,
      refusal: "already_decided",
    });
  });

  // No conflict of interest: an Admin who bought a course can ask for a
  // refund like anyone else, but another Admin has to decide it.
  it("refuses an Admin deciding their own Refund Request", () => {
    const purchase = buyCourse(db, admin.id, base.course.id);
    const request = raise(admin, purchase);

    expect(approveRefundRequest(db, admin, request)).toEqual({
      ok: false,
      refusal: "own_request",
    });
    expect(declineRefundRequest(db, admin, request, "No.")).toEqual({
      ok: false,
      refusal: "own_request",
    });

    const otherAdmin = addUser(db, "Other Admin", schema.UserRole.Admin);
    expect(approveRefundRequest(db, otherAdmin, request).ok).toBe(true);
  });
});

describe("the refund queue", () => {
  // Instructors have no say in refunds; only Admins decide them.
  it("is reachable only by Admins", async () => {
    await expect(
      requireAdmin(db, await requestAs(base.user.id))
    ).rejects.toMatchObject({ init: { status: 403 } });
    await expect(
      requireAdmin(db, await requestAs(base.instructor.id))
    ).rejects.toMatchObject({ init: { status: 403 } });
    await expect(
      requireAdmin(db, new Request("http://test/"))
    ).rejects.toMatchObject({ init: { status: 401 } });

    await expect(
      requireAdmin(db, await requestAs(admin.id))
    ).resolves.toMatchObject({ id: admin.id });
  });

  // Oldest first, so nobody waits longest.
  it("lists only Open Refund Requests, oldest first", () => {
    const second = addUser(db, "Second Learner");
    const third = addUser(db, "Third Learner");
    const firstRequest = raise(
      base.user,
      buyCourse(db, base.user.id, base.course.id)
    );
    const secondRequest = raise(
      second,
      buyCourse(db, second.id, base.course.id)
    );
    const decided = raise(third, buyCourse(db, third.id, base.course.id));
    declineRefundRequest(db, admin, decided, "No.");

    expect(listOpenRefundRequests(db).map((r) => r.id)).toEqual([
      firstRequest.id,
      secondRequest.id,
    ]);
  });

  it("shows what an Admin needs to judge the request", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id, {
      amountPaid: 7900,
      purchasedAt: daysAgo(3),
    });
    watch(base.user.id, lessonIds[0], 600);
    watch(base.user.id, lessonIds[1], 300);
    complete(base.user.id, lessonIds.slice(0, 3));
    raise(base.user, purchase, "Too basic for me.");

    const [entry] = listOpenRefundRequests(db);

    expect(entry).toMatchObject({
      reason: "Too basic for me.",
      learner: { id: base.user.id, name: "Test User", email: base.user.email },
      course: { id: base.course.id, title: "Test Course" },
      purchase: { id: purchase.id, amountPaid: 7900, purchasedAt: purchase.createdAt },
      secondsWatched: 900,
      lessonsCompleted: 3,
      lessonCount: 10,
      earlierRequests: [],
    });
  });

  // A repeat ask reads differently from a first one.
  it("shows earlier Refund Requests on the same purchase", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    const first = raise(base.user, purchase, "First ask.");
    declineRefundRequest(db, admin, first, "Try the second module first.");
    raise(base.user, purchase, "Tried it, still not for me.");

    const [entry] = listOpenRefundRequests(db);

    expect(entry.reason).toBe("Tried it, still not for me.");
    expect(entry.earlierRequests).toEqual([
      expect.objectContaining({
        id: first.id,
        status: schema.RefundStatus.Declined,
        reason: "First ask.",
        declineReason: "Try the second module first.",
      }),
    ]);
  });
});

describe("Discretionary Refund Requests", () => {
  // One Refund per course stops the normal route after a repurchase, but an
  // Admin can still set the rules aside for a genuinely exceptional case.
  it("lets an Admin raise one where Refund Eligibility says no", () => {
    approveRefundRequest(
      db,
      admin,
      raise(base.user, buyCourse(db, base.user.id, base.course.id))
    );
    const repurchase = buyCourse(db, base.user.id, base.course.id);
    expectBlockedBy(base.user, repurchase, "already_refunded");

    const outcome = raiseDiscretionaryRefundRequest(
      db,
      admin,
      base.user,
      repurchase,
      "Charged twice by mistake."
    );

    expect(outcome.ok).toBe(true);
    const [entry] = listOpenRefundRequests(db);
    expect(entry).toMatchObject({
      purchase: { id: repurchase.id },
      reason: "Charged twice by mistake.",
      discretionary: true,
      raisedBy: { id: admin.id, name: "Admin" },
    });
  });

  // A claimed seat belongs to the team member who claimed it, and one
  // purchase never has two undecided requests — discretion doesn't change that.
  it("never overrides a claimed team seat", () => {
    const { purchase, coupon } = teamPurchaseWithCoupon(base.user.id);
    const member = addUser(db, "Team Member");
    db.update(schema.coupons)
      .set({ redeemedByUserId: member.id, redeemedAt: new Date().toISOString() })
      .where(eq(schema.coupons.id, coupon.id))
      .run();

    expect(
      raiseDiscretionaryRefundRequest(db, admin, base.user, purchase, "Please.")
    ).toEqual({ ok: false, rule: "claimed_team_seat" });
  });

  // Discretion overrides one Refund per course, never one Refund per
  // purchase: the same money can't be sent back twice.
  it("never refunds a purchase that already has an Approved Refund Request", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    approveRefundRequest(db, admin, raise(base.user, purchase));

    expect(
      raiseDiscretionaryRefundRequest(db, admin, base.user, purchase, "Again.")
    ).toEqual({ ok: false, rule: "purchase_already_refunded" });
    expect(listOpenRefundRequests(db)).toEqual([]);
  });

  it("never overrides an existing Open Refund Request", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    raise(base.user, purchase);

    expect(
      raiseDiscretionaryRefundRequest(db, admin, base.user, purchase, "Please.")
    ).toEqual({ ok: false, rule: "request_already_open" });
    expect(listOpenRefundRequests(db)).toHaveLength(1);
  });

  // One person can't send money out against the rules alone.
  it("refuses the raising Admin deciding it, and lets a different Admin", () => {
    const otherAdmin = addUser(db, "Other Admin", schema.UserRole.Admin);
    const request = raiseDiscretionary(
      buyCourse(db, base.user.id, base.course.id)
    );

    expect(approveRefundRequest(db, admin, request)).toEqual({
      ok: false,
      refusal: "own_discretionary_request",
    });
    expect(declineRefundRequest(db, admin, request, "No.")).toEqual({
      ok: false,
      refusal: "own_discretionary_request",
    });

    expect(approveRefundRequest(db, otherAdmin, request).ok).toBe(true);
  });

  // With no second Admin, nobody can decide it — say so rather than leave
  // the raiser wondering why it's stuck.
  it("is blocked and flagged while its raiser is the only Admin", () => {
    const request = raiseDiscretionary(
      buyCourse(db, base.user.id, base.course.id)
    );

    expect(approveRefundRequest(db, admin, request)).toEqual({
      ok: false,
      refusal: "sole_admin_discretionary_request",
    });
    expect(declineRefundRequest(db, admin, request, "No.")).toEqual({
      ok: false,
      refusal: "sole_admin_discretionary_request",
    });
    expect(listOpenRefundRequests(db)).toEqual([
      expect.objectContaining({ id: request.id, soleAdminWarning: true }),
    ]);

    const secondAdmin = addUser(db, "Second Admin", schema.UserRole.Admin);
    expect(listOpenRefundRequests(db)).toEqual([
      expect.objectContaining({ id: request.id, soleAdminWarning: false }),
    ]);
    expect(declineRefundRequest(db, secondAdmin, request, "No.").ok).toBe(true);
  });

  // The Admin picks the learner's purchase to raise one for.
  it("offers every purchase to choose from, newest first", () => {
    const older = buyCourse(db, base.user.id, base.course.id, {
      amountPaid: 4900,
      purchasedAt: daysAgo(40),
    });
    const second = addUser(db, "Second Learner");
    const newer = buyCourse(db, second.id, base.course.id, {
      amountPaid: 7900,
      purchasedAt: daysAgo(2),
    });

    expect(listPurchasesForDiscretionaryRefund(db)).toEqual([
      {
        id: newer.id,
        amountPaid: 7900,
        purchasedAt: newer.createdAt,
        learner: { id: second.id, name: "Second Learner", email: second.email },
        course: { id: base.course.id, title: "Test Course" },
      },
      {
        id: older.id,
        amountPaid: 4900,
        purchasedAt: older.createdAt,
        learner: { id: base.user.id, name: "Test User", email: base.user.email },
        course: { id: base.course.id, title: "Test Course" },
      },
    ]);
  });

  it("doesn't flag ordinary Refund Requests", () => {
    raise(base.user, buyCourse(db, base.user.id, base.course.id));

    expect(listOpenRefundRequests(db)).toEqual([
      expect.objectContaining({
        discretionary: false,
        raisedBy: null,
        soleAdminWarning: false,
      }),
    ]);
  });
});

/** An Admin raises a Discretionary Refund Request the scenario expects to succeed. */
function raiseDiscretionary(purchase: typeof schema.purchases.$inferSelect) {
  const outcome = raiseDiscretionaryRefundRequest(
    db,
    admin,
    { id: purchase.userId },
    purchase,
    "Exceptional circumstances."
  );
  if (!outcome.ok) throw new Error(`expected a request, got ${outcome.rule}`);
  return outcome.refundRequest;
}

describe("a learner's Refund Requests in Settings", () => {
  // Decided requests stay listed, so the learner can follow the outcome.
  it("lists all of the learner's requests, including decided ones", () => {
    const other = addUser(db, "Other Learner");
    const purchase = buyCourse(db, base.user.id, base.course.id);
    const declined = raise(base.user, purchase, "First ask.");
    declineRefundRequest(db, admin, declined, "Try the second module first.");
    const approved = raise(base.user, purchase, "Second ask.");
    approveRefundRequest(db, admin, approved);
    raise(other, buyCourse(db, other.id, base.course.id));

    expect(
      listRefundRequestsForLearner(db, base.user)
        .map((r) => r.id)
        .sort()
    ).toEqual([declined.id, approved.id].sort());
  });

  /** The outcome text Settings shows for the learner's only request. */
  function shownOutcome() {
    const [refundRequest] = listRefundRequestsForLearner(db, base.user);
    return describeLearnerRefundOutcome(refundRequest.outcome);
  }

  it("shows an Open Refund Request as waiting on us", () => {
    raise(base.user, buyCourse(db, base.user.id, base.course.id));

    expect(shownOutcome()).toBe("Waiting on us");
  });

  it("shows an approved request as Refund pending until the money is sent", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    approveRefundRequest(db, admin, raise(base.user, purchase));

    expect(shownOutcome()).toBe("Refund pending");
  });

  it("shows Refund issued once the money has gone out", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    const refundRequest = raise(base.user, purchase);
    approveRefundRequest(db, admin, refundRequest);
    markRefundIssued(db, admin, refundRequest);

    expect(shownOutcome()).toBe("Refund issued");
  });

  // A failed send is a problem only an Admin can fix, so the learner isn't
  // alarmed by it: to them the money is still on its way.
  it("never shows a Failed Refund as failed — it stays Refund pending", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    const refundRequest = raise(base.user, purchase);
    approveRefundRequest(db, admin, refundRequest);
    markRefundFailed(db, admin, refundRequest);

    expect(shownOutcome()).toBe("Refund pending");
  });

  it("shows a declined request with the Admin's reason", () => {
    const purchase = buyCourse(db, base.user.id, base.course.id);
    declineRefundRequest(
      db,
      admin,
      raise(base.user, purchase, "Not for me."),
      "You have finished most of the course."
    );

    const [refundRequest] = listRefundRequestsForLearner(db, base.user);

    expect(refundRequest.reason).toBe("Not for me.");
    expect(describeLearnerRefundOutcome(refundRequest.outcome)).toBe(
      "Declined: You have finished most of the course."
    );
  });
});

describe("moving the money for a Refund", () => {
  function approvedRefund(learner = base.user, amountPaid = 4900) {
    const purchase = buyCourse(db, learner.id, base.course.id, { amountPaid });
    const request = raise(learner, purchase);
    approveRefundRequest(db, admin, request);
    return request;
  }

  it("lists a new Refund as Pending for the full amount paid", () => {
    const request = approvedRefund(base.user, 7900);

    expect(listOutstandingRefunds(db)).toEqual([
      expect.objectContaining({
        id: request.id,
        refundState: schema.RefundMoneyState.Pending,
        amountRefunded: 7900,
        learner: expect.objectContaining({ id: base.user.id }),
        course: expect.objectContaining({ id: base.course.id }),
      }),
    ]);
  });

  // A temporary failure to send money isn't the end: the Admin retries
  // and marks it Issued later.
  it("allows Pending → Failed → Issued", () => {
    const request = approvedRefund();

    expect(markRefundFailed(db, admin, request)).toMatchObject({
      ok: true,
      refund: { refundState: schema.RefundMoneyState.Failed },
    });
    expect(listOutstandingRefunds(db)).toEqual([
      expect.objectContaining({
        id: request.id,
        refundState: schema.RefundMoneyState.Failed,
      }),
    ]);

    expect(markRefundIssued(db, admin, request)).toMatchObject({
      ok: true,
      refund: { refundState: schema.RefundMoneyState.Issued },
    });
    expect(listOutstandingRefunds(db)).toEqual([]);
  });

  it("allows Pending → Issued", () => {
    const request = approvedRefund();

    expect(markRefundIssued(db, admin, request).ok).toBe(true);
    expect(listOutstandingRefunds(db)).toEqual([]);
  });

  // The decision and the money are separate: a failed transfer doesn't
  // reopen or undo the decision.
  it("leaves the Refund Request Approved when the Refund fails", () => {
    const request = approvedRefund();

    expect(markRefundFailed(db, admin, request)).toMatchObject({
      ok: true,
      refund: { status: schema.RefundStatus.Approved },
    });
    expect(listOpenRefundRequests(db)).toEqual([]);
  });

  it("records when the Refund's state last changed", () => {
    const request = approvedRefund();
    const later = new Date(Date.now() + 60_000);

    markRefundFailed(db, admin, request, later);

    expect(listOutstandingRefunds(db)).toEqual([
      expect.objectContaining({ refundStateChangedAt: later.toISOString() }),
    ]);
  });

  // Issued means the money has gone; nothing can change after that.
  it("refuses any change after the Refund is Issued", () => {
    const request = approvedRefund();
    markRefundIssued(db, admin, request);

    expect(markRefundFailed(db, admin, request)).toEqual({
      ok: false,
      refusal: "already_issued",
    });
    expect(markRefundIssued(db, admin, request)).toEqual({
      ok: false,
      refusal: "already_issued",
    });
  });

  it("refuses marking a Failed Refund Failed again", () => {
    const request = approvedRefund();
    markRefundFailed(db, admin, request);

    expect(markRefundFailed(db, admin, request)).toEqual({
      ok: false,
      refusal: "already_failed",
    });
  });

  // Only an Approved Refund Request has a Refund to move.
  it("refuses Refund Requests that have no Refund", () => {
    const open = raise(base.user, buyCourse(db, base.user.id, base.course.id));
    const learner = addUser(db, "Declined Learner");
    const declined = raise(learner, buyCourse(db, learner.id, base.course.id));
    declineRefundRequest(db, admin, declined, "No.");

    for (const request of [open, declined, { id: 9999 }]) {
      expect(markRefundIssued(db, admin, request)).toEqual({
        ok: false,
        refusal: "no_refund",
      });
      expect(markRefundFailed(db, admin, request)).toEqual({
        ok: false,
        refusal: "no_refund",
      });
    }
  });
});

describe("refunding a team Purchase", () => {
  // The team buyer isn't enrolled themselves: the seats are for the team.
  function buyTeamSeats(buyerId: number, seats: number) {
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: buyerId,
        courseId: base.course.id,
        amountPaid: 4900 * seats,
      })
      .returning()
      .get();
    const team = db.insert(schema.teams).values({}).returning().get();
    const codes = Array.from({ length: seats }, (_, i) => {
      const code = `SEAT-${purchase.id}-${i}`;
      db.insert(schema.coupons)
        .values({
          teamId: team.id,
          courseId: base.course.id,
          code,
          purchaseId: purchase.id,
        })
        .run();
      return code;
    });
    return { purchase, codes };
  }

  // Seats that were paid back must not still let someone in.
  it("voids every unclaimed Coupon on approval, so none of its seats can be redeemed", async () => {
    const buyer = addUser(db, "Team Buyer");
    const { purchase, codes } = buyTeamSeats(buyer.id, 3);

    expect(approveRefundRequest(db, admin, raise(buyer, purchase)).ok).toBe(
      true
    );

    for (const code of codes) {
      const teamMember = addUser(db, "Team Member");
      expect(redeemCoupon(db, code, teamMember.id, "")).toEqual({
        ok: false,
        error: "This coupon was cancelled because its purchase was refunded.",
      });
      const access = await getAccess(
        db,
        await requestAs(teamMember.id),
        base.course.id
      );
      expect(access.enrolled).toBe(false);
    }
  });
});
