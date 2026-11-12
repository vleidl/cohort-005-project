import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

vi.mock("~/lib/session", () => ({
  getCurrentUserId: async () => base.user.id,
}));

vi.mock("~/lib/country.server", () => ({
  resolveCountry: async () => null,
}));

import {
  getRefundEligibility,
  getTeamRefundEligibility,
  requestRefund,
  requestSeatRefund,
} from "./refunds.server";
import { getAccess } from "./access.server";
import { redeemSeat } from "./seats.server";

// Noon, local time, so calendar-day arithmetic never straddles midnight.
function day(year: number, month: number, date: number) {
  return new Date(year, month - 1, date, 12);
}

const PURCHASED = day(2026, 1, 1);

let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
  testDb
    .update(schema.courses)
    .set({ price: 10000 })
    .run();
});

function buy(amountPaid: number, at = PURCHASED) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid,
      country: null,
      createdAt: at.toISOString(),
    })
    .returning()
    .get();
  testDb
    .insert(schema.enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();
  return purchase;
}

function buySeats(seatCount: number, amountPaid: number, at = PURCHASED) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid,
      country: null,
      createdAt: at.toISOString(),
    })
    .returning()
    .get();
  const team = testDb.insert(schema.teams).values({}).returning().get();
  const seats = Array.from({ length: seatCount }, (_, i) =>
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: `seat-${purchase.id}-${i}`,
        purchaseId: purchase.id,
      })
      .returning()
      .get()
  );
  return { purchase, seats };
}

function claim(seat: { id: number }) {
  testDb
    .update(schema.coupons)
    .set({ redeemedByUserId: base.instructor.id, redeemedAt: PURCHASED.toISOString() })
    .where(eq(schema.coupons.id, seat.id))
    .run();
}

function addLessons(count: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module", position: 1 })
    .returning()
    .get();
  return Array.from({ length: count }, (_, i) =>
    testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: `Lesson ${i + 1}`, position: i + 1 })
      .returning()
      .get()
  );
}

function complete(lessonId: number) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId: base.user.id,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
    })
    .run();
}

function watch(lessonId: number, positionSeconds: number) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({
      userId: base.user.id,
      lessonId,
      eventType: "progress",
      positionSeconds,
    })
    .run();
}

describe("getRefundEligibility", () => {
  it("offers the Amount Paid, not the list price, inside the Refund Window", () => {
    buy(7000);

    expect(
      getRefundEligibility(base.user.id, base.course.id, day(2026, 1, 5))
    ).toMatchObject({
      eligible: true,
      amount: 7000,
      lastDayInWindow: "2026-01-15",
    });
  });

  it("stays open for the whole fourteenth day, then closes", () => {
    buy(7000, new Date(2026, 0, 1, 23, 0));

    expect(
      getRefundEligibility(base.user.id, base.course.id, new Date(2026, 0, 15, 23, 59))
    ).toMatchObject({ eligible: true });
    expect(
      getRefundEligibility(base.user.id, base.course.id, new Date(2026, 0, 16, 0, 1))
    ).toEqual({
      eligible: false,
      reason: "The 14-day refund window closed on 2026-01-15.",
    });
  });

  it("closes once half the Course's Lessons are completed", () => {
    buy(7000);
    const lessons = addLessons(4);
    complete(lessons[0].id);

    const now = day(2026, 1, 5);
    expect(
      getRefundEligibility(base.user.id, base.course.id, now)
    ).toMatchObject({ eligible: true });

    complete(lessons[1].id);
    expect(getRefundEligibility(base.user.id, base.course.id, now)).toEqual({
      eligible: false,
      reason: "You have completed half or more of this course.",
    });
  });

  it("closes once two hours of video have been watched, counting each Lesson's furthest point once", () => {
    buy(7000);
    const lessons = addLessons(4);
    watch(lessons[0].id, 3600);
    watch(lessons[0].id, 1800); // rewatching does not add time
    watch(lessons[1].id, 3599);

    const now = day(2026, 1, 5);
    expect(
      getRefundEligibility(base.user.id, base.course.id, now)
    ).toMatchObject({ eligible: true });

    watch(lessons[1].id, 3600);
    expect(getRefundEligibility(base.user.id, base.course.id, now)).toEqual({
      eligible: false,
      reason: "You have watched two hours or more of this course.",
    });
  });

  it("ignores Team Purchases the student made for others", () => {
    buySeats(3, 30000, day(2026, 1, 2));
    expect(
      getRefundEligibility(base.user.id, base.course.id, day(2026, 1, 5))
    ).toBeNull();

    buy(7000);
    expect(
      getRefundEligibility(base.user.id, base.course.id, day(2026, 1, 5))
    ).toMatchObject({ eligible: true, amount: 7000 });
  });
});

async function canViewContent() {
  const access = await getAccess(new Request("http://localhost/"), base.course.id);
  return access.canViewContent;
}

describe("requestRefund", () => {
  it("refunds the Amount Paid straight away and ends access to the Course", async () => {
    buy(7000);
    expect(await canViewContent()).toBe(true);

    const result = requestRefund(
      base.user.id,
      base.course.id,
      "Not what I expected.",
      day(2026, 1, 5)
    );

    expect(result).toMatchObject({ refunded: true, amount: 7000 });
    expect(await canViewContent()).toBe(false);
    expect(
      getRefundEligibility(base.user.id, base.course.id, day(2026, 1, 5))
    ).toBeNull();
  });

  it("refuses an ineligible request and leaves the Purchase as it was", async () => {
    buy(7000);

    expect(
      requestRefund(base.user.id, base.course.id, "Too late?", day(2026, 1, 20))
    ).toEqual({
      refunded: false,
      reason: "The 14-day refund window closed on 2026-01-15.",
    });
    expect(await canViewContent()).toBe(true);
  });

  it("lets a student who bought the Course again refund the new Purchase", () => {
    buy(7000);
    requestRefund(base.user.id, base.course.id, "Not now.", day(2026, 1, 5));

    buy(8000, day(2026, 3, 1));

    expect(
      getRefundEligibility(base.user.id, base.course.id, day(2026, 3, 2))
    ).toMatchObject({ eligible: true, amount: 8000, lastDayInWindow: "2026-03-15" });
  });
});

describe("refunding Seats of a Team Purchase", () => {
  it("refunds the chosen number of unclaimed Seats, each at its share of the Amount Paid", () => {
    const { purchase, seats } = buySeats(10, 30000);
    claim(seats[0]);
    claim(seats[1]);
    claim(seats[2]);

    const now = day(2026, 1, 5);
    expect(getTeamRefundEligibility(base.user.id, purchase.id, now)).toMatchObject({
      eligible: true,
      refundableSeats: 7,
      amountPerSeat: 3000,
    });

    expect(
      requestSeatRefund(base.user.id, purchase.id, 5, "Hired fewer people.", now)
    ).toMatchObject({ refunded: true, amount: 15000 });

    expect(getTeamRefundEligibility(base.user.id, purchase.id, now)).toMatchObject({
      eligible: true,
      refundableSeats: 2,
    });
  });

  it("only lets the person who made the Team Purchase refund it", () => {
    const { purchase } = buySeats(4, 12000);

    expect(
      requestSeatRefund(base.instructor.id, purchase.id, 1, "Not mine.", day(2026, 1, 5))
    ).toEqual({
      refunded: false,
      reason: "Only the person who made this Team Purchase can refund its Seats.",
    });
  });

  it("closes for the whole Team Purchase when the Refund Window ends", () => {
    const { purchase } = buySeats(4, 12000);

    expect(
      getTeamRefundEligibility(base.user.id, purchase.id, day(2026, 1, 15))
    ).toMatchObject({ eligible: true });
    expect(
      getTeamRefundEligibility(base.user.id, purchase.id, day(2026, 1, 16))
    ).toEqual({
      eligible: false,
      reason: "The 14-day refund window closed on 2026-01-15.",
    });
  });

  it("never refunds a Claimed Seat", () => {
    const { purchase, seats } = buySeats(3, 9000);
    claim(seats[0]);
    claim(seats[1]);
    const now = day(2026, 1, 5);

    expect(
      requestSeatRefund(base.user.id, purchase.id, 2, "Too many.", now)
    ).toEqual({
      refunded: false,
      reason: "Only 1 unclaimed Seat can be refunded.",
    });

    requestSeatRefund(base.user.id, purchase.id, 1, "The last one.", now);
    expect(getTeamRefundEligibility(base.user.id, purchase.id, now)).toEqual({
      eligible: false,
      reason: "No unclaimed Seats are left to refund.",
    });
  });

  it("stops a refunded Seat from being claimed, while unrefunded Seats still can be", () => {
    const { purchase, seats } = buySeats(2, 6000);
    requestSeatRefund(base.user.id, purchase.id, 1, "One too many.", day(2026, 1, 5));

    expect(redeemSeat(seats[0].code, base.instructor.id, "US")).toEqual({
      ok: false,
      error: "This Seat has been refunded.",
    });
    expect(redeemSeat(seats[1].code, base.instructor.id, "US")).toMatchObject({
      ok: true,
    });
  });

  it("returns exactly the Amount Paid once every Seat is refunded, even when it doesn't divide evenly", () => {
    const { purchase } = buySeats(3, 10000);
    const now = day(2026, 1, 5);

    expect(
      requestSeatRefund(base.user.id, purchase.id, 1, "First one back.", now)
    ).toMatchObject({ amount: 3333 });
    expect(
      requestSeatRefund(base.user.id, purchase.id, 2, "The rest back.", now)
    ).toMatchObject({ amount: 6667 });

    expect(getTeamRefundEligibility(base.user.id, purchase.id, now)).toEqual({
      eligible: false,
      reason: "Every Seat of this Team Purchase has been refunded.",
    });
  });
});
