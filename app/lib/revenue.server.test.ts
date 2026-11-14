import { describe, it, expect, beforeEach, vi } from "vitest";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";
import {
  createTestDb,
  seedBaseData,
  addUser,
  buyCourse,
  daysAgo,
} from "~/test/setup";
import {
  getCourseRevenue,
  getCourseRevenueByCountry,
  getRevenueSummary,
  getStudentRevenue,
  getTopBuyers,
} from "./revenue.server";
import {
  approveRefundRequest,
  declineRefundRequest,
  raiseRefundRequest,
} from "./refunds.server";
import { markRefundFailed, markRefundIssued } from "./refund-money.server";

let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let admin: typeof schema.users.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  admin = addUser(db, "Admin", schema.UserRole.Admin);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

// ─── Scenario helpers ───

const LEARNER_REASON = "My manager says this course is a waste of money.";

function buy(name: string, amountPaid: number) {
  const learner = addUser(db, name);
  const purchase = buyCourse(db, learner.id, base.course.id, { amountPaid });
  return { learner, purchase };
}

/** A learner's Refund Request, approved by an Admin: a Pending Refund. */
function approvedRefund(name: string, amountPaid: number) {
  const { learner, purchase } = buy(name, amountPaid);
  const raised = raiseRefundRequest(db, learner, purchase, LEARNER_REASON);
  if (!raised.ok) throw new Error(`expected a request, got ${raised.rule}`);
  const decided = approveRefundRequest(db, admin, raised.refundRequest);
  if (!decided.ok) throw new Error(`expected approval, got ${decided.refusal}`);
  return decided.refundRequest;
}

function issuedRefund(name: string, amountPaid: number) {
  const refund = approvedRefund(name, amountPaid);
  const issued = markRefundIssued(db, admin, refund);
  if (!issued.ok) throw new Error(`expected issued, got ${issued.refusal}`);
}

function failedRefund(name: string, amountPaid: number) {
  const refund = approvedRefund(name, amountPaid);
  const failed = markRefundFailed(db, admin, refund);
  if (!failed.ok) throw new Error(`expected failed, got ${failed.refusal}`);
}

describe("instructor revenue", () => {
  it("counts every sale while nothing has been refunded", () => {
    buy("Ada", 10000);
    buy("Grace", 5000);

    expect(getRevenueSummary(db, base.instructor.id, "all")).toEqual({
      grossCents: 15000,
      feeCents: 3000,
      netCents: 12000,
      purchaseCount: 2,
    });
  });

  it("subtracts an Issued Refund from revenue", () => {
    // Issued means the money has gone back to the learner, so the
    // instructor no longer earned it.
    buy("Ada", 10000);
    issuedRefund("Grace", 5000);

    expect(getRevenueSummary(db, base.instructor.id, "all")).toMatchObject({
      grossCents: 10000,
      feeCents: 2000,
      netCents: 8000,
    });
  });

  it("keeps Pending and Failed Refunds in revenue", () => {
    // Until the money is confirmed as sent, the instructor's numbers still
    // include it. A Failed Refund may never go out at all.
    buy("Ada", 10000);
    approvedRefund("Grace", 5000);
    failedRefund("Linus", 2000);

    expect(getRevenueSummary(db, base.instructor.id, "all")).toMatchObject({
      grossCents: 17000,
    });
  });

  it("subtracts an Issued Refund from its course's revenue", () => {
    buy("Ada", 10000);
    issuedRefund("Grace", 5000);

    expect(getCourseRevenue(db, base.instructor.id, "all")).toMatchObject([
      {
        courseId: base.course.id,
        grossCents: 10000,
        feeCents: 2000,
        netCents: 8000,
      },
    ]);
  });
});

describe("refund counts per course", () => {
  it("counts each Refund on the course, whatever its money state", () => {
    // A Refund exists once a Refund Request is approved; the count tells an
    // instructor how many learners were let go, not how many were paid yet.
    buy("Ada", 10000);
    approvedRefund("Grace", 5000);
    failedRefund("Linus", 2000);
    issuedRefund("Margaret", 3000);

    expect(getCourseRevenue(db, base.instructor.id, "all")).toMatchObject([
      { courseId: base.course.id, refundCount: 3 },
    ]);
  });

  it("does not count Open or Declined Refund Requests", () => {
    const open = buy("Ada", 10000);
    raiseRefundRequest(db, open.learner, open.purchase, LEARNER_REASON);
    const declined = buy("Grace", 5000);
    const raised = raiseRefundRequest(
      db,
      declined.learner,
      declined.purchase,
      LEARNER_REASON
    );
    if (!raised.ok) throw new Error(`expected a request, got ${raised.rule}`);
    declineRefundRequest(db, admin, raised.refundRequest, "Watched it all.");

    expect(getCourseRevenue(db, base.instructor.id, "all")).toMatchObject([
      { courseId: base.course.id, refundCount: 0 },
    ]);
  });

  it("never passes a learner's refund reason to the instructor", () => {
    // What a learner told Cadence stays with Cadence.
    issuedRefund("Grace", 5000);

    const shown = JSON.stringify([
      getRevenueSummary(db, base.instructor.id, "all"),
      getCourseRevenue(db, base.instructor.id, "all"),
    ]);
    expect(shown).not.toContain(LEARNER_REASON);
  });
});

// ─── The rest of the analytics page ───
// Every revenue figure an instructor sees is net of Issued Refunds, not just
// the summary: by country, per student and per top buyer.

function boughtIn(country: string, name: string, amountPaid: number) {
  const bought = buy(name, amountPaid);
  db.update(schema.purchases)
    .set({ country })
    .where(eq(schema.purchases.id, bought.purchase.id))
    .run();
  return bought;
}

function refundAndIssue(purchase: typeof schema.purchases.$inferSelect) {
  const learner = { id: purchase.userId };
  const raised = raiseRefundRequest(db, learner, purchase, LEARNER_REASON);
  if (!raised.ok) throw new Error(`expected a request, got ${raised.rule}`);
  const decided = approveRefundRequest(db, admin, raised.refundRequest);
  if (!decided.ok) throw new Error(`expected approval, got ${decided.refusal}`);
  const issued = markRefundIssued(db, admin, raised.refundRequest);
  if (!issued.ok) throw new Error(`expected issued, got ${issued.refusal}`);
}

describe("revenue by country", () => {
  it("subtracts an Issued Refund from its country and from the discounted share", () => {
    boughtIn("US", "Ada", 10000);
    boughtIn("IN", "Grace", 3000);
    refundAndIssue(boughtIn("IN", "Linus", 3000).purchase);

    const breakdown = getCourseRevenueByCountry(db, base.course.id, "all");

    expect(breakdown).toMatchObject({
      grossCents: 13000,
      netCents: 10400,
      discountedGrossCents: 3000,
      discountedNetCents: 2400,
    });
    expect(breakdown.rows.map((row) => [row.country, row.grossCents])).toEqual([
      ["US", 10000],
      ["IN", 3000],
    ]);
  });
});

describe("revenue per student", () => {
  it("credits a student only what they kept paying after an Issued Refund", () => {
    const learner = addUser(db, "Ada");
    const older = buyCourse(db, learner.id, base.course.id, {
      amountPaid: 5000,
      purchasedAt: daysAgo(3),
    });
    buyCourse(db, learner.id, base.course.id, { amountPaid: 4000 });
    refundAndIssue(older);

    expect(getStudentRevenue(db, base.instructor.id, "all")).toEqual([
      { userId: learner.id, name: "Ada", revenueCents: 4000 },
    ]);
  });
});

describe("top buyers", () => {
  it("ranks buyers by what they spent after Issued Refunds", () => {
    buy("Ada", 6000);
    refundAndIssue(buy("Grace", 10000).purchase);

    expect(
      getTopBuyers(db, base.instructor.id, "all").map((buyer) => [
        buyer.name,
        buyer.spendCents,
      ])
    ).toEqual([
      ["Ada", 6000],
      ["Grace", 0],
    ]);
  });
});
