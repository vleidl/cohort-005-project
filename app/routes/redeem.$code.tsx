import { Link, useFetcher, redirect } from "react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/redeem.$code";
import { getCurrentUserId } from "~/lib/session";
import { resolveCountry } from "~/lib/country.server";
import { parseParams, parseFormData } from "~/lib/validation";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Ticket, AlertCircle, CheckCircle2, Globe } from "lucide-react";
import { data } from "react-router";
import { db } from "~/db";
import { purchases, courses, enrollments } from "~/db/schema";
import {
  getSeatByCode,
  claimSeat,
  VOIDED_SEAT_MESSAGE,
} from "~/lib/seats.server";
import { eq, and } from "drizzle-orm";

function getCourseById(id: number) {
  return db.select().from(courses).where(eq(courses.id, id)).get();
}

function isUserEnrolled(userId: number, courseId: number) {
  const existing = db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();

  return !!existing;
}

const claimParamsSchema = z.object({
  code: z.string().min(1),
});

const claimActionSchema = z.object({
  intent: z.literal("confirm-claim"),
});

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData?.course?.title ?? "Claim Seat";
  return [
    { title: `Claim a seat: ${title} — Cadence` },
    { name: "description", content: `Claim your seat in ${title}` },
  ];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const { code } = parseParams(params, claimParamsSchema);

  const seat = getSeatByCode(db, code);
  if (!seat) {
    throw data("Seat not found.", { status: 404 });
  }

  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw redirect(
      `/login?redirectTo=${encodeURIComponent(`/redeem/${code}`)}`
    );
  }

  const course = getCourseById(seat.courseId);
  if (!course) {
    throw data("Course not found.", { status: 404 });
  }

  const voided = seat.voidedAt !== null;
  const alreadyClaimed = seat.claimedByUserId !== null;
  const alreadyEnrolled = isUserEnrolled(currentUserId, seat.courseId);

  // Check country mismatch upfront so we can show a clear message
  let countryMismatch = false;
  if (!voided && !alreadyClaimed && !alreadyEnrolled) {
    const userCountry = await resolveCountry(request);
    const purchase = db
      .select()
      .from(purchases)
      .where(eq(purchases.id, seat.purchaseId))
      .get();
    if (purchase?.country && purchase.country !== (userCountry ?? "")) {
      countryMismatch = true;
    }
  }

  return {
    course: { id: course.id, title: course.title, slug: course.slug },
    code,
    voided,
    alreadyClaimed,
    alreadyEnrolled,
    countryMismatch,
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const { code } = parseParams(params, claimParamsSchema);

  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("You must be logged in.", { status: 401 });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, claimActionSchema);

  if (!parsed.success) {
    throw data("Invalid action.", { status: 400 });
  }

  const userCountry = await resolveCountry(request);
  const result = claimSeat(db, code, currentUserId, userCountry ?? "");

  if (!result.ok) {
    return data({ error: result.error }, { status: 400 });
  }

  const course = getCourseById(result.enrollment.courseId);
  if (!course) {
    throw redirect("/courses");
  }

  throw redirect(`/courses/${course.slug}/welcome`);
}

export default function ClaimSeat({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    course,
    code,
    voided,
    alreadyClaimed,
    alreadyEnrolled,
    countryMismatch,
  } = loaderData;
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    const error =
      fetcher.data?.error ?? (actionData as { error?: string })?.error;
    if (error) {
      toast.error(error);
    }
  }, [fetcher.data, actionData]);

  return (
    <div className="mx-auto max-w-2xl p-6 lg:p-8">
      <h1 className="mb-2 text-2xl font-bold">Claim Seat</h1>
      <p className="mb-8 text-muted-foreground">
        You&apos;ve been invited to enroll in a course.
      </p>

      <Card>
        <CardContent className="p-8 text-center">
          <div className="mb-4 inline-flex size-16 items-center justify-center rounded-full bg-primary/10">
            <Ticket className="size-8 text-primary" />
          </div>

          <h2 className="mb-2 text-xl font-semibold">{course.title}</h2>
          <p className="mb-6 text-sm text-muted-foreground">
            Seat code:{" "}
            <code className="rounded bg-muted px-2 py-0.5">{code}</code>
          </p>

          {voided ? (
            <div className="rounded-lg bg-destructive/10 p-4">
              <div className="flex items-center justify-center gap-2 text-destructive">
                <AlertCircle className="size-5" />
                <span className="font-medium">
                  This seat has been cancelled
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {VOIDED_SEAT_MESSAGE} Please ask the person who shared this
                link about getting access another way.
              </p>
            </div>
          ) : alreadyClaimed ? (
            <div className="rounded-lg bg-destructive/10 p-4">
              <div className="flex items-center justify-center gap-2 text-destructive">
                <AlertCircle className="size-5" />
                <span className="font-medium">
                  This seat has already been claimed
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Someone has already claimed this seat. Please ask the person who
                shared this link for a new seat.
              </p>
            </div>
          ) : alreadyEnrolled ? (
            <div className="rounded-lg bg-green-50 p-4 dark:bg-green-900/20">
              <div className="flex items-center justify-center gap-2 text-green-700 dark:text-green-400">
                <CheckCircle2 className="size-5" />
                <span className="font-medium">
                  You&apos;re already enrolled
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                You already have access to this course. The seat has not been
                claimed, so it can still be shared with someone else.
              </p>
              <Link to={`/courses/${course.slug}`}>
                <Button className="mt-4" size="lg">
                  Go to Course
                </Button>
              </Link>
            </div>
          ) : countryMismatch ? (
            <div className="rounded-lg bg-amber-50 p-4 dark:bg-amber-900/20">
              <div className="flex items-center justify-center gap-2 text-amber-700 dark:text-amber-400">
                <Globe className="size-5" />
                <span className="font-medium">Region restriction</span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                This seat can only be claimed from the same country as the
                person who purchased it. Your location doesn&apos;t match the
                purchaser&apos;s country.
              </p>
            </div>
          ) : (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="confirm-claim" />
              <Button
                size="lg"
                className="w-full max-w-sm"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Enrolling..." : "Enroll Now"}
              </Button>
            </fetcher.Form>
          )}

          <div className="mt-6">
            <Link
              to={`/courses/${course.slug}`}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              View course details
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
