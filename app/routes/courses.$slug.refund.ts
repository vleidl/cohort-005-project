import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { courses, users } from "~/db/schema";
import { eq } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import { refundReasonSchema, requestRefund } from "~/lib/refunds.server";
import { formatPrice } from "~/lib/utils";

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundActionSchema = z.object({
  reason: refundReasonSchema,
});

function getCourseBySlug(slug: string) {
  return db.select().from(courses).where(eq(courses.slug, slug)).get();
}

/**
 * The confirmation the student gets in their inbox. There is no mail
 * transport wired up yet, so the built message goes to the server log.
 */
function buildRefundEmail(input: {
  studentName: string;
  studentEmail: string;
  courseTitle: string;
  amount: number;
}) {
  return {
    to: input.studentEmail,
    subject: `Refund confirmed — ${input.courseTitle}`,
    body: [
      `Hi ${input.studentName},`,
      "",
      `We have refunded your purchase of "${input.courseTitle}".`,
      `${formatPrice(input.amount)}, the amount you paid, is on its way back to the card you paid with.`,
      "",
      "Your access to the course has ended. You are welcome to buy it again at any time.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundParamsSchema);
  const course = getCourseBySlug(slug);

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const student = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!student) {
    throw data("User not found", { status: 404 });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  const result = requestRefund(currentUserId, course.id, parsed.data.reason);

  if (!result.refunded) {
    throw data(result.reason, { status: 403 });
  }

  const email = buildRefundEmail({
    studentName: student.name,
    studentEmail: student.email,
    courseTitle: course.title,
    amount: result.amount,
  });

  console.log(
    `[email] to=${email.to} subject=${email.subject}\n${email.body}`
  );

  return redirect("/settings");
}
