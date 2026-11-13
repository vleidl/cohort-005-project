import { useEffect, useState } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds";
import { db } from "~/db";
import { requireAdmin } from "~/lib/access.server";
import {
  approveRefundRequest,
  declineRefundRequest,
  describeDecisionRefusal,
  listOpenRefundRequests,
  type DecisionRefusal,
  type RefundQueueEntry,
} from "~/lib/refunds.server";
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
  }
}

function throwRefusal(refusal: DecisionRefusal): never {
  const status = {
    not_found: 404,
    already_decided: 409,
    own_request: 403,
    decline_reason_missing: 400,
  } satisfies Record<DecisionRefusal, number>;

  throw data(describeDecisionRefusal(refusal), { status: status[refusal] });
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { openRefundRequests } = loaderData;

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
        <RefundQueueSection entries={openRefundRequests} />
        {/* Further sections (Refunds to send, Discretionary Refund Requests) go here. */}
      </div>
    </div>
  );
}

// ─── Section: Open Refund Requests ───

function RefundQueueSection({ entries }: { entries: RefundQueueEntry[] }) {
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
            <RefundQueueCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}

function RefundQueueCard({ entry }: { entry: RefundQueueEntry }) {
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
            </p>
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

        <DecisionForm refundRequestId={entry.id} />
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
