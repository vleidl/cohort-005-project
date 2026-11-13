import { useEffect, useState } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds";
import { db } from "~/db";
import { RefundMoneyState } from "~/db/schema";
import { requireAdmin } from "~/lib/access.server";
import {
  approveRefundRequest,
  declineRefundRequest,
  describeDecisionRefusal,
  describeDiscretionaryRefundIneligibility,
  listOpenRefundRequests,
  listPurchasesForDiscretionaryRefund,
  raiseDiscretionaryRefundRequest,
  describeRefundStateRefusal,
  listOutstandingRefunds,
  markRefundFailed,
  markRefundIssued,
  type DecisionRefusal,
  type OutstandingRefund,
  type PurchaseForDiscretionaryRefund,
  type RefundQueueEntry,
  type RefundStateRefusal,
} from "~/lib/refunds.server";
import { eq } from "drizzle-orm";
import { purchases } from "~/db/schema";
import { parseFormData } from "~/lib/validation";
import { formatDuration, formatPrice } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { AlertTriangle, ReceiptText } from "lucide-react";

// ─── Admin refund queue ───
// Admins decide Refund Requests here. The page is a thin wrapper over the
// refunds module: the loader lists, the action dispatches on `intent`.
//
// To add a section: add its data to the loader, an intent to
// `refundActionSchema` and a branch in `action`, and a section component
// rendered in `AdminRefunds`.

const refundActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId: z.coerce.number().int(),
    declineReason: z
      .string()
      .trim()
      .min(1, "Give the learner a reason for declining.")
      .max(1000, "Please keep the reason under 1000 characters."),
  }),
  z.object({
    intent: z.literal("raise_discretionary"),
    purchaseId: z.coerce.number().int(),
    reason: z
      .string()
      .trim()
      .min(1, "Explain why this purchase should be refunded.")
      .max(1000, "Please keep the reason under 1000 characters."),
  }),
  z.object({
    intent: z.literal("mark_issued"),
    refundId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("mark_failed"),
    refundId: z.coerce.number().int(),
  }),
]);

export function meta() {
  return [
    { title: "Refunds — Cadence" },
    { name: "description", content: "Decide Refund Requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const admin = await requireAdmin(db, request);

  return {
    adminId: admin.id,
    openRefundRequests: listOpenRefundRequests(db),
    purchasesForDiscretionaryRefund: listPurchasesForDiscretionaryRefund(db),
    outstandingRefunds: listOutstandingRefunds(db),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(db, request);

  const parsed = parseFormData(await request.formData(), refundActionSchema);
  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  const form = parsed.data;

  switch (form.intent) {
    case "approve": {
      const outcome = approveRefundRequest(db, admin, {
        id: form.refundRequestId,
      });
      if (!outcome.ok) throwRefusal(outcome.refusal);
      return { message: "Refund Request approved. The learner has been emailed." };
    }
    case "decline": {
      const outcome = declineRefundRequest(
        db,
        admin,
        { id: form.refundRequestId },
        form.declineReason
      );
      if (!outcome.ok) throwRefusal(outcome.refusal);
      return { message: "Refund Request declined. The learner has been emailed." };
    }
    case "raise_discretionary": {
      const purchase = db
        .select()
        .from(purchases)
        .where(eq(purchases.id, form.purchaseId))
        .get();
      if (!purchase) throw data("That purchase doesn't exist.", { status: 404 });

      const outcome = raiseDiscretionaryRefundRequest(
        db,
        admin,
        { id: purchase.userId },
        purchase,
        form.reason
      );
      if (!outcome.ok) {
        throw data(describeDiscretionaryRefundIneligibility(outcome.rule), {
          status: 422,
        });
      }
      return {
        message:
          "Discretionary Refund Request raised. A different Admin has to decide it.",
      };
    }
    case "mark_issued": {
      const outcome = markRefundIssued(db, admin, { id: form.refundId });
      if (!outcome.ok) throwRefundStateRefusal(outcome.refusal);
      return { message: "Refund marked Issued." };
    }
    case "mark_failed": {
      const outcome = markRefundFailed(db, admin, { id: form.refundId });
      if (!outcome.ok) throwRefundStateRefusal(outcome.refusal);
      return { message: "Refund marked Failed. Retry and mark it Issued once sent." };
    }
  }
}

function throwRefusal(refusal: DecisionRefusal): never {
  const status = {
    not_found: 404,
    already_decided: 409,
    own_request: 403,
    decline_reason_missing: 400,
    own_discretionary_request: 403,
    sole_admin_discretionary_request: 403,
  } satisfies Record<DecisionRefusal, number>;

  throw data(describeDecisionRefusal(refusal), { status: status[refusal] });
}

function throwRefundStateRefusal(refusal: RefundStateRefusal): never {
  const status = {
    no_refund: 404,
    already_issued: 409,
    already_failed: 409,
  } satisfies Record<RefundStateRefusal, number>;

  throw data(describeRefundStateRefusal(refusal), { status: status[refusal] });
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const {
    adminId,
    openRefundRequests,
    outstandingRefunds,
    purchasesForDiscretionaryRefund,
  } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refunds</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refunds</h1>
        <p className="mt-1 text-muted-foreground">
          Decide Refund Requests and track the money back to learners
        </p>
      </div>

      <div className="space-y-10">
        <RefundQueueSection entries={openRefundRequests} adminId={adminId} />
        <RefundsSection refunds={outstandingRefunds} />
        <DiscretionaryRefundSection purchases={purchasesForDiscretionaryRefund} />
        {/* Further sections go here. */}
      </div>
    </div>
  );
}

// ─── Section: Open Refund Requests ───

function RefundQueueSection({
  entries,
  adminId,
}: {
  entries: RefundQueueEntry[];
  adminId: number;
}) {
  return (
    <section>
      <h2 className="mb-1 text-xl font-semibold">Open Refund Requests</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Oldest first. {entries.length}{" "}
        {entries.length === 1 ? "request is" : "requests are"} waiting.
      </p>

      {entries.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">No Refund Requests are waiting.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => (
            <RefundQueueCard key={entry.id} entry={entry} adminId={adminId} />
          ))}
        </div>
      )}
    </section>
  );
}

function RefundQueueCard({
  entry,
  adminId,
}: {
  entry: RefundQueueEntry;
  adminId: number;
}) {
  const raisedByMe = entry.raisedBy?.id === adminId;

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-medium">
              {entry.learner.name}{" "}
              <span className="text-sm font-normal text-muted-foreground">
                {entry.learner.email}
              </span>
              {entry.discretionary && (
                <span className="ml-2 inline-flex items-center rounded-full bg-purple-100 px-2.5 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">
                  Discretionary
                </span>
              )}
            </p>
            {entry.discretionary && entry.raisedBy && (
              <p className="text-sm text-muted-foreground">
                Raised by {raisedByMe ? "you" : entry.raisedBy.name}. Refund
                Eligibility was set aside, so a different Admin decides it.
              </p>
            )}
            <Link
              to={`/courses/${entry.course.slug}`}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {entry.course.title}
            </Link>
          </div>
          <div className="text-right text-sm">
            <p className="font-semibold">{formatPrice(entry.purchase.amountPaid)}</p>
            <p className="text-muted-foreground">
              Bought {formatDate(entry.purchase.purchasedAt)} · asked{" "}
              {formatDate(entry.requestedAt)}
            </p>
          </div>
        </div>

        <blockquote className="border-l-2 pl-3 text-sm">{entry.reason}</blockquote>

        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div>
            <dt className="inline text-muted-foreground">Watched: </dt>
            <dd className="inline">
              {formatDuration(Math.round(entry.secondsWatched / 60), true, false, false)}
            </dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">Lessons completed: </dt>
            <dd className="inline">
              {entry.lessonsCompleted} of {entry.lessonCount}
            </dd>
          </div>
        </dl>

        {entry.earlierRequests.length > 0 && (
          <div className="text-sm">
            <p className="mb-1 font-medium">Earlier requests on this purchase</p>
            <ul className="space-y-1 text-muted-foreground">
              {entry.earlierRequests.map((earlier) => (
                <li key={earlier.id}>
                  {formatDate(earlier.requestedAt)} — {earlier.status}: “{earlier.reason}”
                  {earlier.declineReason && <> (declined: “{earlier.declineReason}”)</>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {raisedByMe && entry.soleAdminWarning ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            You raised this Discretionary Refund Request and you are the only
            Admin. It can't be decided until a second Admin exists.
          </p>
        ) : raisedByMe ? (
          <p className="text-sm text-muted-foreground">
            You raised this request, so another Admin has to decide it.
          </p>
        ) : (
          <DecisionForm refundRequestId={entry.id} />
        )}
      </CardContent>
    </Card>
  );
}

function DecisionForm({ refundRequestId }: { refundRequestId: number }) {
  const fetcher = useFetcher<typeof action>();
  const [declining, setDeclining] = useState(false);
  const busy = fetcher.state !== "idle";
  const errors = fetcher.data && "errors" in fetcher.data ? fetcher.data.errors : null;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "message" in fetcher.data) {
      toast.success(fetcher.data.message);
    }
  }, [fetcher.state, fetcher.data]);

  if (!declining) {
    return (
      <div className="flex gap-2">
        <fetcher.Form method="post">
          <input type="hidden" name="refundRequestId" value={refundRequestId} />
          <Button type="submit" name="intent" value="approve" size="sm" disabled={busy}>
            Approve
          </Button>
        </fetcher.Form>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setDeclining(true)}
        >
          Decline…
        </Button>
      </div>
    );
  }

  return (
    <fetcher.Form method="post" className="space-y-2">
      <input type="hidden" name="refundRequestId" value={refundRequestId} />
      <label className="block text-sm font-medium" htmlFor={`decline-${refundRequestId}`}>
        Reason for declining (the learner will see this)
      </label>
      <Textarea
        id={`decline-${refundRequestId}`}
        name="declineReason"
        required
        aria-invalid={errors?.declineReason ? true : undefined}
      />
      {errors?.declineReason && (
        <p className="text-sm text-destructive">{errors.declineReason}</p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          name="intent"
          value="decline"
          variant="destructive"
          size="sm"
          disabled={busy}
        >
          Decline
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setDeclining(false)}
        >
          Cancel
        </Button>
      </div>
    </fetcher.Form>
  );
}

// ─── Section: Refunds ───
// Pending and Failed Refunds: the money still to confirm as sent. Issued
// Refunds are done and drop off this list.

function RefundsSection({ refunds }: { refunds: OutstandingRefund[] }) {
  return (
    <section>
      <h2 className="mb-1 text-xl font-semibold">Refunds to send</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Pending and Failed Refunds. Mark each Issued once the money has gone out.
      </p>

      {refunds.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">No Refunds are waiting to be sent.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {refunds.map((refund) => (
            <RefundCard key={refund.id} refund={refund} />
          ))}
        </div>
      )}
    </section>
  );
}

function RefundCard({ refund }: { refund: OutstandingRefund }) {
  const failed = refund.refundState === RefundMoneyState.Failed;

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <p className="font-medium">
            {refund.learner.name}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              {refund.learner.email}
            </span>
          </p>
          <p className="text-sm text-muted-foreground">{refund.course.title}</p>
        </div>
        <div className="text-right text-sm">
          <p className="font-semibold">{formatPrice(refund.amountRefunded)}</p>
          <p className={failed ? "text-destructive" : "text-muted-foreground"}>
            {failed ? "Failed" : "Pending"}
            {refund.refundStateChangedAt && <> since {formatDate(refund.refundStateChangedAt)}</>}
          </p>
        </div>
        <RefundStateForm refundId={refund.id} failed={failed} />
      </CardContent>
    </Card>
  );
}

function RefundStateForm({ refundId, failed }: { refundId: number; failed: boolean }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "message" in fetcher.data) {
      toast.success(fetcher.data.message);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <fetcher.Form method="post" className="flex gap-2">
      <input type="hidden" name="refundId" value={refundId} />
      <Button type="submit" name="intent" value="mark_issued" size="sm" disabled={busy}>
        {failed ? "Retried — mark Issued" : "Mark Issued"}
      </Button>
      {!failed && (
        <Button
          type="submit"
          name="intent"
          value="mark_failed"
          variant="outline"
          size="sm"
          disabled={busy}
        >
          Mark Failed
        </Button>
      )}
    </fetcher.Form>
  );
}

// ─── Section: Discretionary Refund Requests ───

function DiscretionaryRefundSection({
  purchases,
}: {
  purchases: PurchaseForDiscretionaryRefund[];
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const errors = fetcher.data && "errors" in fetcher.data ? fetcher.data.errors : null;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "message" in fetcher.data) {
      toast.success(fetcher.data.message);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <section>
      <h2 className="mb-1 text-xl font-semibold">Raise a Discretionary Refund Request</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        For genuinely exceptional cases. It sets aside the refund window, watch
        and completion limits and the one-Refund-per-course rule, but never a
        claimed team seat or an Open Refund Request. A different Admin must
        decide it.
      </p>

      <Card>
        <CardContent className="p-5">
          {purchases.length === 0 ? (
            <p className="text-muted-foreground">There are no purchases yet.</p>
          ) : (
            <fetcher.Form method="post" className="space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium" htmlFor="discretionary-purchase">
                  Learner's purchase
                </label>
                <select
                  id="discretionary-purchase"
                  name="purchaseId"
                  required
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                >
                  {purchases.map((purchase) => (
                    <option key={purchase.id} value={purchase.id}>
                      {purchase.learner.name} ({purchase.learner.email}) —{" "}
                      {purchase.course.title} — {formatPrice(purchase.amountPaid)} on{" "}
                      {formatDate(purchase.purchasedAt)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium" htmlFor="discretionary-reason">
                  Your reason (the reviewing Admin will see this)
                </label>
                <Textarea
                  id="discretionary-reason"
                  name="reason"
                  required
                  aria-invalid={errors?.reason ? true : undefined}
                />
                {errors?.reason && (
                  <p className="text-sm text-destructive">{errors.reason}</p>
                )}
              </div>
              <Button
                type="submit"
                name="intent"
                value="raise_discretionary"
                size="sm"
                disabled={busy}
              >
                Raise Discretionary Refund Request
              </Button>
            </fetcher.Form>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ─── Helpers ───

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred on the refunds page.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
    } else if (error.status === 403) {
      title = "Access denied";
    } else if (error.status === 409) {
      title = "Already decided";
    } else {
      title = `Error ${error.status}`;
    }
    message = typeof error.data === "string" ? error.data : error.statusText;
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/admin/refunds">
            <Button variant="outline">Back to refunds</Button>
          </Link>
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
