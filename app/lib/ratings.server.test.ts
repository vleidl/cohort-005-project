import { describe, it, expect, beforeEach, vi } from "vitest";
import * as schema from "~/db/schema";
import { createTestDb, seedBaseData, addUser, buyCourse } from "~/test/setup";
import { getCourseRatingSummaries } from "./ratings.server";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";

let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let admin: typeof schema.users.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  admin = addUser(db, "Admin", schema.UserRole.Admin);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

function rate(userId: number, rating: number) {
  db.insert(schema.courseRatings)
    .values({ userId, courseId: base.course.id, rating })
    .run();
}

function buyAndRate(name: string, rating: number) {
  const learner = addUser(db, name);
  const purchase = buyCourse(db, learner.id, base.course.id);
  rate(learner.id, rating);
  return { learner, purchase };
}

function refund(
  learner: { id: number },
  purchase: typeof schema.purchases.$inferSelect
) {
  const raised = raiseRefundRequest(db, learner, purchase, "Not for me.");
  if (!raised.ok) throw new Error(`expected a request, got ${raised.rule}`);
  const decided = approveRefundRequest(db, admin, raised.refundRequest);
  if (!decided.ok) throw new Error(`expected approval, got ${decided.refusal}`);
}

function summary() {
  return getCourseRatingSummaries(db, [base.course.id]).get(base.course.id);
}

describe("course rating summaries", () => {
  it("averages every rating on the course", () => {
    buyAndRate("Ada", 5);
    buyAndRate("Grace", 2);

    expect(summary()).toEqual({ average: 3.5, count: 2 });
  });

  it("gives a course nobody has rated no average and a zero count", () => {
    expect(summary()).toEqual({ average: null, count: 0 });
  });

  it("leaves out the rating of a learner whose Refund Request was approved", () => {
    // The average should reflect people who kept the course. Someone who got
    // their money back is no longer a customer of it.
    buyAndRate("Ada", 5);
    const grace = buyAndRate("Grace", 1);

    refund(grace.learner, grace.purchase);

    expect(summary()).toEqual({ average: 5, count: 1 });
  });

  it("counts a refunded learner's rating again once they buy the course again", () => {
    // Buying again makes them a customer again, and the rating they left
    // still stands for the course they now own.
    buyAndRate("Ada", 5);
    const grace = buyAndRate("Grace", 1);
    refund(grace.learner, grace.purchase);

    buyCourse(db, grace.learner.id, base.course.id);

    expect(summary()).toEqual({ average: 3, count: 2 });
  });

  it("keeps counting a learner whose Refund Request is still open", () => {
    // Raising a request decides nothing. Until an Admin approves, they keep
    // the course and their rating.
    buyAndRate("Ada", 5);
    const grace = buyAndRate("Grace", 1);
    raiseRefundRequest(db, grace.learner, grace.purchase, "Not for me.");

    expect(summary()).toEqual({ average: 3, count: 2 });
  });

  it("leaves out a refunded learner only on the course they were refunded for", () => {
    // The catalogue summarises many courses at once. A Refund on one course
    // says nothing about how the learner rated another.
    const other = db
      .insert(schema.courses)
      .values({
        title: "Other Course",
        slug: "other-course",
        description: "Another course",
        salesCopy: "## Other Course",
        instructorId: base.instructor.id,
        categoryId: base.category.id,
        status: schema.CourseStatus.Published,
      })
      .returning()
      .get();
    const grace = buyAndRate("Grace", 1);
    buyCourse(db, grace.learner.id, other.id);
    db.insert(schema.courseRatings)
      .values({ userId: grace.learner.id, courseId: other.id, rating: 4 })
      .run();

    refund(grace.learner, grace.purchase);

    const summaries = getCourseRatingSummaries(db, [base.course.id, other.id]);
    expect(summaries.get(base.course.id)).toEqual({ average: null, count: 0 });
    expect(summaries.get(other.id)).toEqual({ average: 4, count: 1 });
  });
});
