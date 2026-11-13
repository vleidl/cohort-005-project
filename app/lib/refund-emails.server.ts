import { eq } from "drizzle-orm";
import type { Db } from "~/db";
import { courses, purchases, users } from "~/db/schema";
import { formatPrice } from "~/lib/utils";

// ─── Refund emails ───
// What the refunds module tells the learner. Each builder looks up the
// learner and course and returns the email; `sendEmail` delivers it.
// There is no mail transport yet, so built emails go to the server log.
//
// The confirmation email's "Our team reviews every refund request by hand"
// line is kept as the spec wrote it. New copy speaks as "we" or "Cadence".

type EmailPurchase = Pick<
  typeof purchases.$inferSelect,
  "userId" | "courseId" | "amountPaid"
>;
// There is no mail transport yet, so built emails go to the server log.

export type RefundEmail = { to: string; subject: string; body: string };

export function sendEmail(email: RefundEmail) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}

function emailContext(db: Db, purchase: EmailPurchase) {
  const learner = db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, purchase.userId))
    .get();
  const course = db
    .select({ title: courses.title })
    .from(courses)
    .where(eq(courses.id, purchase.courseId))
    .get();

  return {
    to: learner?.email ?? "",
    learnerName: learner?.name ?? "there",
    courseTitle: course?.title ?? "your course",
  };
}

export function buildRefundApprovedEmail(
  db: Db,
  purchase: EmailPurchase
): RefundEmail {
  const { to, learnerName, courseTitle } = emailContext(db, purchase);

  return {
    to,
    subject: `Refund approved — ${courseTitle}`,
    body: [
      `Hi ${learnerName},`,
      "",
      `We have approved your refund request for "${courseTitle}".`,
      `We are sending you ${formatPrice(purchase.amountPaid)}, the full amount you paid.`,
      "Your access to the course has ended. If you buy it again later, your progress will be waiting for you.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export function buildRefundDeclinedEmail(
  db: Db,
  purchase: EmailPurchase,
  declineReason: string
): RefundEmail {
  const { to, learnerName, courseTitle } = emailContext(db, purchase);

  return {
    to,
    subject: `Refund request declined — ${courseTitle}`,
    body: [
      `Hi ${learnerName},`,
      "",
      `We have looked at your refund request for "${courseTitle}" and declined it.`,
      "",
      "Our reason:",
      declineReason,
      "",
      "You keep full access to the course.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export function buildDiscretionaryRefundRequestedEmail(
  db: Db,
  purchase: EmailPurchase
): RefundEmail {
  const { to, learnerName, courseTitle } = emailContext(db, purchase);

  return {
    to,
    subject: `Refund requested — ${courseTitle}`,
    body: [
      `Hi ${learnerName},`,
      "",
      `We have raised a refund request on your behalf for "${courseTitle}".`,
      `The refund is for ${formatPrice(purchase.amountPaid)}, the amount you paid.`,
      "",
      "A second person at Cadence will review it. You do not need to do anything — we will email you again when it is done.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export function buildRefundRequestedEmail(
  db: Db,
  purchase: EmailPurchase
): RefundEmail {
  const { to, learnerName, courseTitle } = emailContext(db, purchase);

  return {
    to,
    subject: `Refund requested — ${courseTitle}`,
    body: [
      `Hi ${learnerName},`,
      "",
      `We have your refund request for "${courseTitle}".`,
      `The refund is for ${formatPrice(purchase.amountPaid)}, the amount you paid.`,
      "",
      "Our team reviews every refund request by hand. You do not need to do anything else — we will email you again when it is done.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}
