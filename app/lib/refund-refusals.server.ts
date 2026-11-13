import { data } from "react-router";
import {
  REFUND_COMPLETION_LIMIT,
  REFUND_WATCH_LIMIT_SECONDS,
  REFUND_WINDOW_DAYS,
  type DecisionRefusal,
  type DiscretionaryRefusal,
  type RefundIneligibility,
  type RefundStateRefusal,
} from "~/lib/refunds.server";

// ─── Refund refusals ───
// What each refusal from the refunds module tells the person, and the HTTP
// status a route answers with. One map per refusal union, so a new refusal
// fails the type check until it has both. Routes throw them with
// `throwRefusal`; the course page reads the message for its refund offer.

export type RefusalResponse = { message: string; status: number };

const NOT_ADMIN: RefusalResponse = {
  message: "Only Admins can do that.",
  status: 403,
};

const CLAIMED_TEAM_SEAT_MESSAGE =
  "A team seat from this purchase has been claimed, so it can't be refunded.";

function describeWatchLimit() {
  const hours = REFUND_WATCH_LIMIT_SECONDS / 3600;
  if (Number.isInteger(hours)) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.round(REFUND_WATCH_LIMIT_SECONDS / 60)} minutes`;
}

const COMPLETION_LIMIT_PERCENT = Math.round(REFUND_COMPLETION_LIMIT * 100);

/** A learner stopped by Refund Eligibility. */
export const REFUND_INELIGIBILITY = {
  not_purchaser: {
    message: "Only the person who bought this course can ask for a refund.",
    status: 403,
  },
  request_already_open: {
    message:
      "You already have an open refund request on this purchase. We will email you when it is decided.",
    status: 409,
  },
  already_refunded: {
    message:
      "You have already had a refund for this course, so this purchase can't be refunded.",
    status: 403,
  },
  claimed_team_seat: { message: CLAIMED_TEAM_SEAT_MESSAGE, status: 403 },
  window_closed: {
    message: `The ${REFUND_WINDOW_DAYS}-day refund window has closed.`,
    status: 403,
  },
  watched_too_much: {
    message: `You have watched ${describeWatchLimit()} or more of this course, so it can't be refunded.`,
    status: 403,
  },
  completed_too_much: {
    message: `You have completed ${COMPLETION_LIMIT_PERCENT}% or more of this course's lessons, so it can't be refunded.`,
    status: 403,
  },
} satisfies Record<RefundIneligibility, RefusalResponse>;

/** An Admin's approve or decline refused. */
export const DECISION_REFUSALS = {
  not_admin: NOT_ADMIN,
  not_found: { message: "That refund request doesn't exist.", status: 404 },
  already_decided: {
    message: "This request was already decided.",
    status: 409,
  },
  own_request: {
    message: "You can't decide a refund request on your own purchase.",
    status: 403,
  },
  decline_reason_missing: {
    message: "Give the learner a reason for declining.",
    status: 400,
  },
  own_discretionary_request: {
    message:
      "You raised this Discretionary Refund Request, so a different Admin has to decide it.",
    status: 403,
  },
  sole_admin_discretionary_request: {
    message:
      "You raised this Discretionary Refund Request and you are the only Admin. It can't be decided until a second Admin exists.",
    status: 403,
  },
} satisfies Record<DecisionRefusal, RefusalResponse>;

/** An Admin's Discretionary Refund Request refused. */
export const DISCRETIONARY_REFUSALS = {
  not_admin: NOT_ADMIN,
  not_purchaser: {
    message: "That learner didn't make this purchase.",
    status: 422,
  },
  request_already_open: {
    message:
      "This purchase already has an Open Refund Request. Decide that one instead.",
    status: 422,
  },
  claimed_team_seat: { message: CLAIMED_TEAM_SEAT_MESSAGE, status: 422 },
  purchase_already_refunded: {
    message: "This purchase has already been refunded.",
    status: 422,
  },
} satisfies Record<DiscretionaryRefusal, RefusalResponse>;

/** An Admin's change to a Refund's money state refused. */
export const REFUND_STATE_REFUSALS = {
  not_admin: NOT_ADMIN,
  no_refund: {
    message:
      "That refund doesn't exist. Only an approved refund request has a refund.",
    status: 404,
  },
  already_issued: {
    message: "This refund was already issued, so it can't change.",
    status: 409,
  },
  already_failed: {
    message: "This refund is already marked failed.",
    status: 409,
  },
} satisfies Record<RefundStateRefusal, RefusalResponse>;

/** Ends a loader or action with the refusal's message and status. */
export function throwRefusal<R extends string>(
  refusals: Record<R, RefusalResponse>,
  refusal: R
): never {
  const { message, status } = refusals[refusal];
  throw data(message, { status });
}
