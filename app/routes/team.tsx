import { useEffect, useState } from "react";
import { Link, redirect, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/team";
import { getCurrentUserId } from "~/lib/session";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Users, BookOpen, Copy, Check, AlertTriangle } from "lucide-react";
import { data, isRouteErrorResponse } from "react-router";
import { db } from "~/db";
import {
  teams,
  teamMembers,
  coupons,
  courses,
  purchases,
  users,
  TeamMemberRole,
} from "~/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { parseFormData } from "~/lib/validation";
import {
  getTeamRefundEligibility,
  refundReasonSchema,
  requestSeatRefund,
  type TeamRefundEligibility,
} from "~/lib/refunds.server";
import { formatPrice } from "~/lib/utils";

function getTeamForAdmin(userId: number) {
  const membership = db
    .select()
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.userId, userId),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .get();

  if (!membership) return undefined;

  return db.select().from(teams).where(eq(teams.id, membership.teamId)).get();
}

function getCouponsForTeam(teamId: number) {
  return db.select().from(coupons).where(eq(coupons.teamId, teamId)).all();
}

// Team Purchases this user made, newest first.
function getTeamPurchasesByBuyer(userId: number) {
  return db
    .selectDistinct({
      id: purchases.id,
      courseTitle: courses.title,
      amountPaid: purchases.amountPaid,
      createdAt: purchases.createdAt,
    })
    .from(purchases)
    .innerJoin(coupons, eq(coupons.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(purchases.userId, userId))
    .orderBy(desc(purchases.createdAt))
    .all();
}

function getCourseById(id: number) {
  return db.select().from(courses).where(eq(courses.id, id)).get();
}

function getUserById(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

interface CourseStats {
  courseId: number;
  courseTitle: string;
  courseSlug: string;
  totalSeats: number;
  claimedSeats: number;
}

interface SeatRow {
  id: number;
  code: string;
  courseId: number;
  courseTitle: string;
  redeemedByEmail: string | null;
  refunded: boolean;
  createdAt: string;
}

interface TeamPurchaseRow {
  id: number;
  courseTitle: string;
  amountPaid: number;
  createdAt: string;
  refund: TeamRefundEligibility;
}

const refundSeatsSchema = z.object({
  intent: z.literal("refund-seats"),
  purchaseId: z.coerce.number().int(),
  seatCount: z.coerce.number().int().min(1, "Refund at least one Seat."),
  reason: refundReasonSchema,
});

export function meta() {
  return [
    { title: "Team — Cadence" },
    { name: "description", content: "Manage your team's course seats" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

  const team = getTeamForAdmin(currentUserId);

  if (!team) {
    throw data("You don't have a team. Purchase team seats to create one.", {
      status: 403,
    });
  }

  // Refunded Seats are gone from the team; they only appear in the list below.
  const allSeats = getCouponsForTeam(team.id);
  const activeSeats = allSeats.filter((seat) => seat.refundId === null);

  // Build per-course stats
  const courseMap = new Map<
    number,
    {
      courseId: number;
      courseTitle: string;
      courseSlug: string;
      total: number;
      claimed: number;
    }
  >();

  for (const coupon of activeSeats) {
    if (!courseMap.has(coupon.courseId)) {
      const course = getCourseById(coupon.courseId);
      courseMap.set(coupon.courseId, {
        courseId: coupon.courseId,
        courseTitle: course?.title ?? "Unknown Course",
        courseSlug: course?.slug ?? "",
        total: 0,
        claimed: 0,
      });
    }
    const entry = courseMap.get(coupon.courseId)!;
    entry.total++;
    if (coupon.redeemedByUserId !== null) {
      entry.claimed++;
    }
  }

  const courseStats: CourseStats[] = Array.from(courseMap.values()).map(
    (e) => ({
      courseId: e.courseId,
      courseTitle: e.courseTitle,
      courseSlug: e.courseSlug,
      totalSeats: e.total,
      claimedSeats: e.claimed,
    })
  );

  // Build seat rows with redeemer email
  const seatRows: SeatRow[] = allSeats.map((coupon) => {
    let redeemedByEmail: string | null = null;
    if (coupon.redeemedByUserId !== null) {
      const user = getUserById(coupon.redeemedByUserId);
      redeemedByEmail = user?.email ?? null;
    }
    const course = getCourseById(coupon.courseId);
    return {
      id: coupon.id,
      code: coupon.code,
      courseId: coupon.courseId,
      courseTitle: course?.title ?? "Unknown Course",
      redeemedByEmail,
      refunded: coupon.refundId !== null,
      createdAt: coupon.createdAt,
    };
  });

  const teamPurchases: TeamPurchaseRow[] = getTeamPurchasesByBuyer(
    currentUserId
  ).map((purchase) => ({
    ...purchase,
    refund: getTeamRefundEligibility(currentUserId, purchase.id),
  }));

  return { courseStats, seatRows, teamPurchases };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

  const buyer = getUserById(currentUserId);
  if (!buyer) {
    throw data("User not found.", { status: 404 });
  }

  const parsed = parseFormData(await request.formData(), refundSeatsSchema);
  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  const { purchaseId, seatCount, reason } = parsed.data;
  const result = requestSeatRefund(currentUserId, purchaseId, seatCount, reason);

  if (!result.refunded) {
    throw data(result.reason, { status: 403 });
  }

  // There is no mail transport wired up yet, so the message goes to the log.
  console.log(
    [
      `[email] to=${buyer.email} subject=Refund confirmed — ${seatCount} ${seatCount === 1 ? "Seat" : "Seats"}`,
      `Hi ${buyer.name},`,
      "",
      `We have refunded ${seatCount} unclaimed ${seatCount === 1 ? "Seat" : "Seats"}.`,
      `${formatPrice(result.amount)} is on its way back to the card you paid with.`,
      "",
      "— The Cadence team",
    ].join("\n")
  );

  return redirect("/team");
}

function RefundSeats({ purchase }: { purchase: TeamPurchaseRow }) {
  const fetcher = useFetcher<{ errors?: Record<string, string> }>();
  const isSubmitting = fetcher.state !== "idle";
  const { refund } = purchase;

  useEffect(() => {
    const firstError = Object.values(fetcher.data?.errors ?? {})[0];
    if (fetcher.state === "idle" && firstError) {
      toast.error(firstError);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <h3 className="font-semibold">{purchase.courseTitle}</h3>
        <p className="text-xs text-muted-foreground">
          {formatPrice(purchase.amountPaid)} paid on{" "}
          {new Date(purchase.createdAt).toLocaleDateString()}
        </p>
      </CardHeader>
      <CardContent>
        {refund.eligible ? (
          <fetcher.Form method="post" className="space-y-2">
            <input type="hidden" name="intent" value="refund-seats" />
            <input type="hidden" name="purchaseId" value={purchase.id} />
            <p className="text-xs text-muted-foreground">
              {refund.refundableSeats} unclaimed{" "}
              {refund.refundableSeats === 1 ? "Seat" : "Seats"} can be
              refunded at {formatPrice(refund.amountPerSeat)} each, until{" "}
              {refund.lastDayInWindow}.
            </p>
            <Input
              type="number"
              name="seatCount"
              min={1}
              max={refund.refundableSeats}
              defaultValue={1}
              required
              aria-label="Seats to refund"
            />
            <Textarea
              name="reason"
              rows={2}
              required
              placeholder="Why do you want these Seats refunded?"
            />
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? "Sending..." : "Request a refund"}
            </Button>
          </fetcher.Form>
        ) : (
          <>
            <Button size="sm" variant="outline" disabled>
              Request a refund
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">
              {refund.reason}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    const url = `${window.location.origin}/redeem/${code}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
      title="Copy redemption link"
    >
      {copied ? (
        <>
          <Check className="size-3" />
          Copied
        </>
      ) : (
        <>
          <Copy className="size-3" />
          Copy link
        </>
      )}
    </button>
  );
}

export default function Team({ loaderData }: Route.ComponentProps) {
  const { courseStats, seatRows, teamPurchases } = loaderData;
  const [courseFilter, setCourseFilter] = useState<number | "all">("all");

  const filteredSeats =
    courseFilter === "all"
      ? seatRows
      : seatRows.filter((c) => c.courseId === courseFilter);

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Team</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Team Management</h1>
        <p className="mt-1 text-muted-foreground">
          Manage your team&apos;s course seats and their links
        </p>
      </div>

      {/* Per-course stats */}
      {courseStats.length > 0 && (
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {courseStats.map((stat) => (
            <Card key={stat.courseId}>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <BookOpen className="size-4 text-muted-foreground" />
                  <h3 className="font-semibold truncate">{stat.courseTitle}</h3>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-2xl font-bold">
                      {stat.claimedSeats}
                      <span className="text-base font-normal text-muted-foreground">
                        {" "}
                        / {stat.totalSeats}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      seats claimed
                    </p>
                  </div>
                  <Link to={`/courses/${stat.courseSlug}/purchase?mode=team`}>
                    <Button variant="outline" size="sm">
                      Buy more seats
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Refunds of unclaimed Seats */}
      {teamPurchases.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-4 text-lg font-semibold">Your team purchases</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {teamPurchases.map((purchase) => (
              <RefundSeats key={purchase.id} purchase={purchase} />
            ))}
          </div>
        </div>
      )}

      {/* Seat list */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Seats</h2>
          {courseStats.length > 1 && (
            <select
              value={courseFilter}
              onChange={(e) =>
                setCourseFilter(
                  e.target.value === "all" ? "all" : Number(e.target.value)
                )
              }
              className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
              <option value="all">All courses</option>
              {courseStats.map((stat) => (
                <option key={stat.courseId} value={stat.courseId}>
                  {stat.courseTitle}
                </option>
              ))}
            </select>
          )}
        </div>

        {filteredSeats.length === 0 ? (
          <p className="text-sm text-muted-foreground">No seats yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Code</th>
                  <th className="px-4 py-3 text-left font-medium">Course</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-left font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredSeats.map((coupon) => (
                  <tr key={coupon.id} className="border-b last:border-0">
                    <td className="px-4 py-3">
                      <code className="rounded bg-muted px-2 py-0.5 text-xs">
                        {coupon.code}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {coupon.courseTitle}
                    </td>
                    <td className="px-4 py-3">
                      {coupon.refunded ? (
                        <span className="text-muted-foreground">Refunded</span>
                      ) : coupon.redeemedByEmail ? (
                        <span className="text-muted-foreground">
                          Claimed by {coupon.redeemedByEmail}
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                          Unclaimed
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {!coupon.redeemedByEmail && !coupon.refunded && (
                        <CopyButton code={coupon.code} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "No team found";
      message =
        typeof error.data === "string"
          ? error.data
          : "You don't have a team yet.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
          <Link to="/courses">
            <Button variant="outline">Browse Courses</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
