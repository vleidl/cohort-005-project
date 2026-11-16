// PROTOTYPE — throwaway, never merge to main.
// Question (wayfinder "Per-Channel content", #35): what does each Notification
// kind and each Nudge say in each Channel? Every kind is rendered as its in-app
// row (Notifications page, "Notification UI" variant D) next to its email copy
// (plain-text, as `app/lib/mailer.server.ts` sends today). Three copy styles,
// switchable via `?variant=A|B|C`:
//   A — Plain report: who did what, where. Terse row; the email is the row plus a link.
//   B — Next step first: every row leads with what to do (or what changed for you).
//   C — Letter with context: quotes the Reply, Question or reason; emails keep the
//       existing refund emails' "Hi <name> … — The Cadence team" voice.
// Links, Important/Nudge tags and footers are shared: they come from decisions
// already made. All data are fixtures; nothing is read from or written to the DB.
import { useSearchParams } from "react-router";
import { ArrowRight, Check, Mail } from "lucide-react";
import { PrototypeSwitcher } from "~/components/prototype-switcher";

const SITE = "https://cadence.dev";

type Footer = "switchable" | "always" | "nudge";

type Kind = {
  key: string;
  name: string; // the kind as named in "Which events notify whom" / "Nudge rules"
  recipient: string;
  important: boolean;
  nudge?: boolean;
  emailByDefault: boolean;
  footer: Footer;
  offLabel?: string; // "Stop emailing me about <offLabel>", also the Settings switch label
  to: string;
  linkNote: string;
  firstName: string;
  minutesAgo: number;
};

const KINDS: Kind[] = [
  // ─── Any Comment author ───
  {
    key: "reply",
    name: "Reply to your Comment",
    recipient: "Comment author (any role)",
    important: true,
    emailByDefault: true,
    footer: "switchable",
    offLabel: "replies to my comments",
    to: "/courses/intro-to-typescript/lessons/12#comment-88",
    linkNote: "The lesson, scrolled to the Reply (needs a comment anchor; none exists today)",
    firstName: "Alex",
    minutesAgo: 25,
  },
  // ─── Student ───
  {
    key: "firstVideo",
    name: "First video on a lesson",
    recipient: "Student enrolled on the course",
    important: false,
    emailByDefault: false,
    footer: "switchable",
    offLabel: "new videos in my courses",
    to: "/courses/advanced-react-patterns/lessons/31",
    linkNote: "The lesson",
    firstName: "Alex",
    minutesAgo: 180,
  },
  {
    key: "courseArchived",
    name: "Course Archived",
    recipient: "Student enrolled on the course",
    important: true,
    emailByDefault: true,
    footer: "switchable",
    offLabel: "archived courses",
    to: "/courses/nodejs-fundamentals",
    linkNote: "The course page (archived courses still play for enrolled Students today)",
    firstName: "Alex",
    minutesAgo: 60 * 5,
  },
  {
    key: "notStarted",
    name: "Nudge: Not started",
    recipient: "Student, 3 days after enrolling, nothing Watched",
    important: false,
    nudge: true,
    emailByDefault: true,
    footer: "nudge",
    to: "/courses/intro-to-typescript/lessons/1",
    linkNote: "The first lesson that has a video",
    firstName: "Alex",
    minutesAgo: 60 * 20,
  },
  {
    key: "stalled",
    name: "Nudge: Stalled",
    recipient: "Student, 7 days without watching an unfinished course",
    important: false,
    nudge: true,
    emailByDefault: true,
    footer: "nudge",
    to: "/courses/advanced-react-patterns/lessons/27",
    linkNote: "The next lesson they haven't completed (where the course page's Continue button goes)",
    firstName: "Alex",
    minutesAgo: 60 * 26,
  },
  // ─── Buyer (Student or Team Admin) ───
  {
    key: "refundApproved",
    name: "Refund Request approved (Individual Purchase)",
    recipient: "Buyer",
    important: true,
    emailByDefault: true,
    footer: "always",
    to: "/courses/css-grid-mastery",
    linkNote: "The course page, which shows the refund state",
    firstName: "Alex",
    minutesAgo: 60 * 30,
  },
  {
    key: "refundApprovedTeam",
    name: "Refund Request approved (Team Licence)",
    recipient: "Buyer (Team Admin)",
    important: true,
    emailByDefault: true,
    footer: "always",
    to: "/team",
    linkNote: "The Team page, which shows the licence as Refunded",
    firstName: "Robin",
    minutesAgo: 60 * 30,
  },
  {
    key: "refundDeclined",
    name: "Refund Request declined",
    recipient: "Buyer",
    important: true,
    emailByDefault: true,
    footer: "always",
    to: "/courses/intro-to-typescript",
    linkNote: "The course page (or /team for a Team Licence), where a new Refund Request can be raised",
    firstName: "Alex",
    minutesAgo: 60 * 50,
  },
  {
    key: "refundIssued",
    name: "Refund Issued",
    recipient: "Buyer",
    important: true,
    emailByDefault: true,
    footer: "always",
    to: "/courses/css-grid-mastery",
    linkNote: "The course page (or /team). No trigger exists yet: no payout state in the app",
    firstName: "Alex",
    minutesAgo: 60 * 24 * 3,
  },
  // ─── Instructor ───
  {
    key: "newQuestion",
    name: "New Question",
    recipient: "The course's Instructor",
    important: true,
    emailByDefault: true,
    footer: "switchable",
    offLabel: "new questions on my lessons",
    to: "/instructor/questions",
    linkNote: "The Questions page (could go to the lesson's comment once anchors exist)",
    firstName: "Dana",
    minutesAgo: 12,
  },
  {
    key: "firstRating",
    name: "First rating on a course",
    recipient: "The course's Instructor",
    important: false,
    emailByDefault: false,
    footer: "switchable",
    offLabel: "first ratings on my courses",
    to: "/instructor/analytics",
    linkNote: "Analytics (where ratings are shown to Instructors)",
    firstName: "Dana",
    minutesAgo: 60 * 8,
  },
  {
    key: "archivedByAdmin",
    name: "Course archived by a Platform Admin",
    recipient: "The course's Instructor",
    important: true,
    emailByDefault: true,
    footer: "switchable",
    offLabel: "my courses being archived by Cadence",
    to: "/instructor/7",
    linkNote: "The course's editor",
    firstName: "Dana",
    minutesAgo: 60 * 24 * 2,
  },
  // ─── Platform Admin ───
  {
    key: "newRefundRequest",
    name: "New Open Refund Request",
    recipient: "Every Platform Admin",
    important: true,
    emailByDefault: true,
    footer: "switchable",
    offLabel: "new refund requests",
    to: "/admin/refunds?status=open",
    linkNote: "Refunds, filtered to Open",
    firstName: "Jordan",
    minutesAgo: 40,
  },
  {
    key: "failedRefund",
    name: "Failed Refund",
    recipient: "Every Platform Admin",
    important: true,
    emailByDefault: true,
    footer: "switchable",
    offLabel: "failed refunds",
    to: "/admin/refunds?status=approved",
    linkNote: "Refunds, filtered to Approved (there is no Failed filter yet). No trigger exists yet",
    firstName: "Jordan",
    minutesAgo: 60 * 6,
  },
  // ─── Team Admin ───
  {
    key: "seatClaimed",
    name: "Seat claimed",
    recipient: "Team Admin",
    important: false,
    emailByDefault: false,
    footer: "switchable",
    offLabel: "seats being claimed",
    to: "/team",
    linkNote: "The Team page",
    firstName: "Robin",
    minutesAgo: 90,
  },
  {
    key: "lastSeat",
    name: "Last Unclaimed Seat claimed",
    recipient: "Team Admin",
    important: true,
    emailByDefault: true,
    footer: "switchable",
    offLabel: "running out of seats",
    to: "/courses/advanced-react-patterns/purchase",
    linkNote: "The purchase page for more Seats (or /team)",
    firstName: "Robin",
    minutesAgo: 60 * 3,
  },
];

// ─── Copy per variant ────────────────────────────────────────────────────────

type Copy = {
  row: React.ReactNode;
  quote?: string; // a second, muted line under the row
  action: string;
  subject: string;
  body: string[]; // plain-text lines; the shared footer is appended
};

const b = (s: string) => <strong className="font-semibold">{s}</strong>;
const url = (k: Kind) => SITE + k.to;
const sig = "— The Cadence team";

const REPLY_TEXT = "Constrain T with `extends` — the video covers it at 3:40.";
const QUESTION_TEXT =
  "Why does `T extends string ? A : B` distribute over the union here but not in the previous example?";
const REFUND_REASON =
  "The course covers much less than the description promised.";
const DECLINE_NOTE =
  "You've watched most of the course, which is past the Watch Limit.";

const VARIANTS: Record<
  string,
  { name: string; blurb: string; copy: Record<string, (k: Kind) => Copy> }
> = {
  A: {
    name: "Plain report",
    blurb:
      "Who did what, where. Short rows; the email subject is the row and the body adds one line and the link. No greeting, no sign-off.",
    copy: {
      reply: (k) => ({
        row: <>{b("Priya Shah")} replied to your comment on {b("Generics in practice")}</>,
        action: "View reply",
        subject: "Priya Shah replied to your comment on Generics in practice",
        body: [
          `Priya Shah replied to your comment on "Generics in practice" (Intro to TypeScript).`,
          "",
          `View the reply: ${url(k)}`,
        ],
      }),
      firstVideo: (k) => ({
        row: <>{b("Server components")} in {b("Advanced React Patterns")} now has a video</>,
        action: "Watch",
        subject: "Server components in Advanced React Patterns now has a video",
        body: [
          `The lesson "Server components" in "Advanced React Patterns" now has a video.`,
          "",
          `Watch it: ${url(k)}`,
        ],
      }),
      courseArchived: (k) => ({
        row: <>{b("Node.js Fundamentals")} has been archived</>,
        action: "Open course",
        subject: "Node.js Fundamentals has been archived",
        body: [
          `"Node.js Fundamentals" has been archived. It's no longer listed on Cadence, but you're still enrolled and can still watch it.`,
          "",
          `Open the course: ${url(k)}`,
        ],
      }),
      notStarted: (k) => ({
        row: <>You haven't started {b("Intro to TypeScript")} yet</>,
        action: "Start",
        subject: "You haven't started Intro to TypeScript yet",
        body: [
          `You enrolled on "Intro to TypeScript" 3 days ago and haven't started it yet.`,
          "",
          `Start the first lesson: ${url(k)}`,
        ],
      }),
      stalled: (k) => ({
        row: <>You haven't watched {b("Advanced React Patterns")} for a week</>,
        action: "Resume",
        subject: "You haven't watched Advanced React Patterns for a week",
        body: [
          `You haven't watched "Advanced React Patterns" for a week. You're 40% of the way through.`,
          "",
          `Carry on where you left off: ${url(k)}`,
        ],
      }),
      refundApproved: (k) => ({
        row: <>Your refund request for {b("CSS Grid Mastery")} was approved</>,
        action: "View course",
        subject: "Your refund request for CSS Grid Mastery was approved",
        body: [
          `Your refund request for "CSS Grid Mastery" was approved. $49.00 is on its way back to you, and you no longer have access to the course.`,
          "",
          `View the course: ${url(k)}`,
        ],
      }),
      refundApprovedTeam: (k) => ({
        row: <>Your refund request for the {b("Advanced React Patterns")} Team Licence was approved</>,
        action: "View team",
        subject: "Your refund request for the Advanced React Patterns Team Licence was approved",
        body: [
          `Your refund request for the "Advanced React Patterns" Team Licence was approved. $490.00 is on its way back to you, and its 7 Unclaimed Seats can no longer be claimed.`,
          "",
          `View your team: ${url(k)}`,
        ],
      }),
      refundDeclined: (k) => ({
        row: <>Your refund request for {b("Intro to TypeScript")} was declined</>,
        action: "View course",
        subject: "Your refund request for Intro to TypeScript was declined",
        body: [
          `Your refund request for "Intro to TypeScript" was declined. You still have the course.`,
          "",
          `Reason: ${DECLINE_NOTE}`,
          "",
          `View the course: ${url(k)}`,
        ],
      }),
      refundIssued: (k) => ({
        row: <>Your $49.00 refund for {b("CSS Grid Mastery")} has been sent</>,
        action: "View course",
        subject: "Your $49.00 refund for CSS Grid Mastery has been sent",
        body: [
          `Your $49.00 refund for "CSS Grid Mastery" has been sent. It can take a few days to show in your account.`,
          "",
          `View the course: ${url(k)}`,
        ],
      }),
      newQuestion: (k) => ({
        row: <>{b("Sam Lee")} asked a question on {b("Conditional types")}</>,
        action: "Answer",
        subject: "Sam Lee asked a question on Conditional types",
        body: [
          `Sam Lee asked a question on "Conditional types" (Intro to TypeScript).`,
          "",
          `Answer it: ${url(k)}`,
        ],
      }),
      firstRating: (k) => ({
        row: <>{b("Advanced React Patterns")} got its first rating: ★★★★☆</>,
        action: "View",
        subject: "Advanced React Patterns got its first rating",
        body: [
          `"Advanced React Patterns" got its first rating: 4 out of 5.`,
          "",
          `View your analytics: ${url(k)}`,
        ],
      }),
      archivedByAdmin: (k) => ({
        row: <>{b("Jordan Blake")} archived your course {b("Node.js Fundamentals")}</>,
        action: "View course",
        subject: "Jordan Blake archived your course Node.js Fundamentals",
        body: [
          `Jordan Blake (Cadence) archived your course "Node.js Fundamentals". It's no longer listed; enrolled Students can still watch it.`,
          "",
          `View the course: ${url(k)}`,
        ],
      }),
      newRefundRequest: (k) => ({
        row: <>{b("Mia Chen")} asked for a $49.00 refund for {b("CSS Grid Mastery")}</>,
        action: "Decide",
        subject: "Mia Chen asked for a $49.00 refund for CSS Grid Mastery",
        body: [
          `Mia Chen asked for a $49.00 refund for "CSS Grid Mastery" (Individual Purchase).`,
          "",
          `Decide it: ${url(k)}`,
        ],
      }),
      failedRefund: (k) => ({
        row: <>The $49.00 refund to {b("Mia Chen")} for {b("CSS Grid Mastery")} failed</>,
        action: "View refund",
        subject: "The $49.00 refund to Mia Chen for CSS Grid Mastery failed",
        body: [
          `The $49.00 refund to Mia Chen for "CSS Grid Mastery" failed. Mia hasn't been told.`,
          "",
          `View the refund: ${url(k)}`,
        ],
      }),
      seatClaimed: (k) => ({
        row: <>{b("Leo Park")} claimed a Seat on {b("Advanced React Patterns")} (4 of 10)</>,
        action: "View team",
        subject: "Leo Park claimed a Seat on Advanced React Patterns",
        body: [
          `Leo Park claimed a Seat on "Advanced React Patterns". 4 of 10 Seats are now claimed.`,
          "",
          `View your team: ${url(k)}`,
        ],
      }),
      lastSeat: (k) => ({
        row: <>The last Seat on {b("Advanced React Patterns")} was claimed (10 of 10)</>,
        action: "Buy more Seats",
        subject: "The last Seat on Advanced React Patterns was claimed",
        body: [
          `Leo Park claimed the last Seat on "Advanced React Patterns". All 10 Seats are now claimed.`,
          "",
          `Buy more Seats: ${url(k)}`,
        ],
      }),
    },
  },

  B: {
    name: "Next step first",
    blurb:
      "Every row and subject starts with what to do now; when there's nothing to do, it starts with what changed for you. Emails are a short greeting, one line of why, and the link.",
    copy: {
      reply: (k) => ({
        row: <>Read {b("Priya Shah")}'s reply to your comment on {b("Generics in practice")}</>,
        action: "Read reply",
        subject: "Read Priya Shah's reply to your comment",
        body: [
          `Hi ${k.firstName},`,
          "",
          `Priya Shah replied to your comment on "Generics in practice" in Intro to TypeScript.`,
          "",
          `Read it and carry on the conversation: ${url(k)}`,
        ],
      }),
      firstVideo: (k) => ({
        row: <>Watch the new video: {b("Server components")} in {b("Advanced React Patterns")}</>,
        action: "Watch",
        subject: "Watch the new video: Server components",
        body: [
          `Hi ${k.firstName},`,
          "",
          `"Server components" in Advanced React Patterns now has its video.`,
          "",
          `Watch it: ${url(k)}`,
        ],
      }),
      courseArchived: (k) => ({
        row: <>You can still watch {b("Node.js Fundamentals")}, but it has been archived</>,
        action: "Keep watching",
        subject: "Node.js Fundamentals was archived: you can still watch it",
        body: [
          `Hi ${k.firstName},`,
          "",
          `"Node.js Fundamentals" has been archived, so new Students can't buy it. Nothing changes for you: you're still enrolled and can keep watching.`,
          "",
          `Keep watching: ${url(k)}`,
        ],
      }),
      notStarted: (k) => ({
        row: <>Start {b("Intro to TypeScript")} with {b("Why TypeScript?")} (6 min)</>,
        action: "Start lesson 1",
        subject: "Start Intro to TypeScript: lesson 1 is 6 minutes",
        body: [
          `Hi ${k.firstName},`,
          "",
          `You enrolled on Intro to TypeScript 3 days ago. The first lesson, "Why TypeScript?", takes 6 minutes.`,
          "",
          `Start it: ${url(k)}`,
        ],
      }),
      stalled: (k) => ({
        row: <>Pick up {b("Advanced React Patterns")} at {b("Compound components")}</>,
        action: "Resume",
        subject: "Pick up Advanced React Patterns at Compound components",
        body: [
          `Hi ${k.firstName},`,
          "",
          `It's been a week since you last watched Advanced React Patterns. You're 40% through; next up is "Compound components".`,
          "",
          `Pick up where you left off: ${url(k)}`,
        ],
      }),
      refundApproved: (k) => ({
        row: <>Expect $49.00 back: your refund for {b("CSS Grid Mastery")} was approved</>,
        action: "View course",
        subject: "Expect $49.00 back: refund approved for CSS Grid Mastery",
        body: [
          `Hi ${k.firstName},`,
          "",
          `We approved your refund request for "CSS Grid Mastery". $49.00, the full amount you paid, is on its way back to you. Your access to the course has ended.`,
          "",
          `View the course: ${url(k)}`,
        ],
      }),
      refundApprovedTeam: (k) => ({
        row: <>Expect $490.00 back: your refund for the {b("Advanced React Patterns")} Team Licence was approved</>,
        action: "View team",
        subject: "Expect $490.00 back: refund approved for your Team Licence",
        body: [
          `Hi ${k.firstName},`,
          "",
          `We approved your refund request for the "Advanced React Patterns" Team Licence. $490.00 is on its way back to you. Its 7 Unclaimed Seats can no longer be claimed.`,
          "",
          `View your team: ${url(k)}`,
        ],
      }),
      refundDeclined: (k) => ({
        row: <>You keep {b("Intro to TypeScript")}: your refund request was declined</>,
        action: "See why",
        subject: "You keep Intro to TypeScript: refund request declined",
        body: [
          `Hi ${k.firstName},`,
          "",
          `We decided not to refund "Intro to TypeScript". ${DECLINE_NOTE}`,
          "",
          "You still have everything you bought. If something changes, you can raise a new refund request.",
          "",
          `View the course: ${url(k)}`,
        ],
      }),
      refundIssued: (k) => ({
        row: <>Check your account: your $49.00 refund for {b("CSS Grid Mastery")} was sent</>,
        action: "View course",
        subject: "Check your account: $49.00 refund sent",
        body: [
          `Hi ${k.firstName},`,
          "",
          `We've sent your $49.00 refund for "CSS Grid Mastery". It can take a few days to show in your account.`,
          "",
          `View the course: ${url(k)}`,
        ],
      }),
      newQuestion: (k) => ({
        row: <>Answer {b("Sam Lee")}'s question on {b("Conditional types")}</>,
        action: "Answer",
        subject: "Answer Sam Lee's question on Conditional types",
        body: [
          `Hi ${k.firstName},`,
          "",
          `Sam Lee asked a question on "Conditional types" in Intro to TypeScript.`,
          "",
          `Answer it: ${url(k)}`,
        ],
      }),
      firstRating: (k) => ({
        row: <>See your first rating: {b("Advanced React Patterns")} got ★★★★☆</>,
        action: "See rating",
        subject: "See your first rating on Advanced React Patterns",
        body: [
          `Hi ${k.firstName},`,
          "",
          `A Student gave "Advanced React Patterns" its first rating: 4 out of 5.`,
          "",
          `See your analytics: ${url(k)}`,
        ],
      }),
      archivedByAdmin: (k) => ({
        row: <>Check {b("Node.js Fundamentals")}: a Platform Admin archived it</>,
        action: "Review course",
        subject: "Check Node.js Fundamentals: Cadence archived it",
        body: [
          `Hi ${k.firstName},`,
          "",
          `A Platform Admin archived your course "Node.js Fundamentals". It's no longer listed, so no one new can buy it; enrolled Students keep it.`,
          "",
          `Review the course: ${url(k)}`,
        ],
      }),
      newRefundRequest: (k) => ({
        row: <>Decide {b("Mia Chen")}'s $49.00 refund request for {b("CSS Grid Mastery")}</>,
        action: "Decide",
        subject: "Decide a $49.00 refund request: CSS Grid Mastery",
        body: [
          `Hi ${k.firstName},`,
          "",
          `Mia Chen asked for a $49.00 refund for "CSS Grid Mastery". Until someone decides, Mia keeps the course.`,
          "",
          `Decide it: ${url(k)}`,
        ],
      }),
      failedRefund: (k) => ({
        row: <>Fix the payout: the $49.00 refund to {b("Mia Chen")} failed</>,
        action: "Fix payout",
        subject: "Fix the payout: $49.00 refund to Mia Chen failed",
        body: [
          `Hi ${k.firstName},`,
          "",
          `The $49.00 refund to Mia Chen for "CSS Grid Mastery" couldn't be sent. Mia hasn't been told; the Refund Request stays approved.`,
          "",
          `Fix it: ${url(k)}`,
        ],
      }),
      seatClaimed: (k) => ({
        row: <>See who joined: {b("Leo Park")} claimed a Seat on {b("Advanced React Patterns")}</>,
        action: "View team",
        subject: "Leo Park joined Advanced React Patterns",
        body: [
          `Hi ${k.firstName},`,
          "",
          `Leo Park claimed a Seat on "Advanced React Patterns". 6 of 10 Seats are still unclaimed.`,
          "",
          `View your team: ${url(k)}`,
        ],
      }),
      lastSeat: (k) => ({
        row: <>Buy more Seats: all 10 on {b("Advanced React Patterns")} are claimed</>,
        action: "Buy more Seats",
        subject: "Buy more Seats: Advanced React Patterns is full",
        body: [
          `Hi ${k.firstName},`,
          "",
          `Leo Park claimed the last Seat on "Advanced React Patterns". Anyone else on your team will need a new Seat.`,
          "",
          `Buy more Seats: ${url(k)}`,
        ],
      }),
    },
  },

  C: {
    name: "Letter with context",
    blurb:
      "Rows carry the content itself (the Reply, the Question, the refund reason) as a quoted second line. Emails read as letters in today's refund-email voice, subject \"<what> — <course>\", and say why you got them.",
    copy: {
      reply: (k) => ({
        row: <>{b("Priya Shah")} replied to your comment on {b("Generics in practice")}</>,
        quote: REPLY_TEXT,
        action: "Reply",
        subject: "New reply to your comment — Generics in practice",
        body: [
          `Hi ${k.firstName},`,
          "",
          `Priya Shah replied to your comment on "Generics in practice" (Intro to TypeScript):`,
          "",
          `  "${REPLY_TEXT}"`,
          "",
          `Read the thread and reply: ${url(k)}`,
          "",
          sig,
          "",
          "You're getting this because you wrote the comment Priya replied to.",
        ],
      }),
      firstVideo: (k) => ({
        row: <>New video in {b("Advanced React Patterns")}: {b("Server components")}</>,
        quote: "Module 3 · 14 min",
        action: "Watch",
        subject: "New video — Advanced React Patterns",
        body: [
          `Hi ${k.firstName},`,
          "",
          `Dana Kim has added the video for "Server components" (Module 3, 14 min) in "Advanced React Patterns".`,
          "",
          `Watch it: ${url(k)}`,
          "",
          sig,
          "",
          "You're getting this because you're enrolled on Advanced React Patterns.",
        ],
      }),
      courseArchived: (k) => ({
        row: <>{b("Node.js Fundamentals")} has been archived</>,
        quote: "You're still enrolled and can keep watching. It's no longer listed for new Students.",
        action: "Open course",
        subject: "Course archived — Node.js Fundamentals",
        body: [
          `Hi ${k.firstName},`,
          "",
          `"Node.js Fundamentals" has been archived. It's no longer listed on Cadence, so new Students can't buy it.`,
          "",
          "Nothing changes for you: you're still enrolled, and every lesson is still there for you to watch.",
          "",
          `Open the course: ${url(k)}`,
          "",
          sig,
          "",
          "You're getting this because you're enrolled on Node.js Fundamentals.",
        ],
      }),
      notStarted: (k) => ({
        row: <>Ready to start {b("Intro to TypeScript")}?</>,
        quote: "Lesson 1, \"Why TypeScript?\", takes 6 minutes.",
        action: "Start",
        subject: "Ready to start? — Intro to TypeScript",
        body: [
          `Hi ${k.firstName},`,
          "",
          `You enrolled on "Intro to TypeScript" 3 days ago. The first lesson, "Why TypeScript?", takes 6 minutes, a good way in.`,
          "",
          `Start it: ${url(k)}`,
          "",
          sig,
          "",
          "We send at most one of these a week, and never about a course you've finished.",
        ],
      }),
      stalled: (k) => ({
        row: <>Pick up {b("Advanced React Patterns")} where you left off</>,
        quote: "40% watched · next: Compound components",
        action: "Resume",
        subject: "Pick up where you left off — Advanced React Patterns",
        body: [
          `Hi ${k.firstName},`,
          "",
          `It's been a week since you last watched "Advanced React Patterns". You're 40% of the way through, and next up is "Compound components".`,
          "",
          `Pick up where you left off: ${url(k)}`,
          "",
          sig,
          "",
          "We send at most one of these a week, and never about a course you've finished.",
        ],
      }),
      refundApproved: (k) => ({
        row: <>Refund approved for {b("CSS Grid Mastery")}</>,
        quote: "$49.00 is on its way back to you. Your access to the course has ended.",
        action: "View course",
        subject: "Refund approved — CSS Grid Mastery",
        body: [
          `Hi ${k.firstName},`,
          "",
          `We have approved your refund request for "CSS Grid Mastery".`,
          "$49.00, the full amount you paid, is on its way back to you.",
          "Your access to the course has ended.",
          "",
          sig,
        ],
      }),
      refundApprovedTeam: (k) => ({
        row: <>Refund approved for the {b("Advanced React Patterns")} Team Licence</>,
        quote: "$490.00 is on its way back to you. Its 7 Unclaimed Seats can no longer be claimed.",
        action: "View team",
        subject: "Refund approved — Advanced React Patterns (Team Licence)",
        body: [
          `Hi ${k.firstName},`,
          "",
          `We have approved your refund request for the "Advanced React Patterns" Team Licence.`,
          "$490.00, the full amount you paid, is on its way back to you.",
          "Its 7 Unclaimed Seats can no longer be claimed.",
          "",
          sig,
        ],
      }),
      refundDeclined: (k) => ({
        row: <>Refund declined for {b("Intro to TypeScript")}</>,
        quote: DECLINE_NOTE,
        action: "View course",
        subject: "Refund declined — Intro to TypeScript",
        body: [
          `Hi ${k.firstName},`,
          "",
          `We have looked at your refund request for "Intro to TypeScript" and decided not to refund it.`,
          "",
          DECLINE_NOTE,
          "",
          "You still have everything you bought. If something changes, you can raise a new refund request.",
          "",
          sig,
        ],
      }),
      refundIssued: (k) => ({
        row: <>Refund sent for {b("CSS Grid Mastery")}</>,
        quote: "$49.00 is on its way. It can take a few days to show in your account.",
        action: "View course",
        subject: "Refund sent — CSS Grid Mastery",
        body: [
          `Hi ${k.firstName},`,
          "",
          `We have sent your refund for "CSS Grid Mastery": $49.00, the full amount you paid.`,
          "It can take a few days to show in your account.",
          "",
          sig,
        ],
      }),
      newQuestion: (k) => ({
        row: <>{b("Sam Lee")} asked a question on {b("Conditional types")}</>,
        quote: QUESTION_TEXT,
        action: "Answer",
        subject: "New question — Conditional types",
        body: [
          `Hi ${k.firstName},`,
          "",
          `Sam Lee asked a question on "Conditional types" (Intro to TypeScript):`,
          "",
          `  "${QUESTION_TEXT}"`,
          "",
          `Answer it: ${url(k)}`,
          "",
          sig,
          "",
          "You're getting this because you teach Intro to TypeScript.",
        ],
      }),
      firstRating: (k) => ({
        row: <>{b("Advanced React Patterns")} has its first rating</>,
        quote: "★★★★☆ 4 out of 5",
        action: "View",
        subject: "First rating — Advanced React Patterns",
        body: [
          `Hi ${k.firstName},`,
          "",
          `A Student has rated "Advanced React Patterns" for the first time: 4 out of 5.`,
          "",
          `See your analytics: ${url(k)}`,
          "",
          sig,
          "",
          "You're getting this because you teach Advanced React Patterns. We only tell you about the first rating.",
        ],
      }),
      archivedByAdmin: (k) => ({
        row: <>{b("Jordan Blake")} archived {b("Node.js Fundamentals")}</>,
        quote: "No longer listed for new Students. Enrolled Students can still watch it.",
        action: "View course",
        subject: "Your course was archived — Node.js Fundamentals",
        body: [
          `Hi ${k.firstName},`,
          "",
          `Jordan Blake, a Platform Admin, has archived your course "Node.js Fundamentals".`,
          "It's no longer listed on Cadence, so no one new can buy it. Students already enrolled can still watch it.",
          "",
          "If you think this is a mistake, reply to this email.",
          "",
          `View the course: ${url(k)}`,
          "",
          sig,
        ],
      }),
      newRefundRequest: (k) => ({
        row: <>{b("Mia Chen")} asked for a $49.00 refund for {b("CSS Grid Mastery")}</>,
        quote: REFUND_REASON,
        action: "Decide",
        subject: "Refund request — CSS Grid Mastery ($49.00)",
        body: [
          `Hi ${k.firstName},`,
          "",
          `Mia Chen asked for a refund of $49.00 for "CSS Grid Mastery" (Individual Purchase). Their reason:`,
          "",
          `  "${REFUND_REASON}"`,
          "",
          `Decide it: ${url(k)}`,
          "",
          sig,
          "",
          "Every Platform Admin gets this; whoever decides first closes it for everyone.",
        ],
      }),
      failedRefund: (k) => ({
        row: <>Refund to {b("Mia Chen")} failed: $49.00 for {b("CSS Grid Mastery")}</>,
        quote: "Mia hasn't been told. The Refund Request stays approved.",
        action: "View refund",
        subject: "Refund failed — Mia Chen, CSS Grid Mastery ($49.00)",
        body: [
          `Hi ${k.firstName},`,
          "",
          `The $49.00 refund to Mia Chen for "CSS Grid Mastery" couldn't be sent.`,
          "Mia hasn't been told. The Refund Request stays approved, so the money still needs to reach them.",
          "",
          `View the refund: ${url(k)}`,
          "",
          sig,
          "",
          "Every Platform Admin gets this.",
        ],
      }),
      seatClaimed: (k) => ({
        row: <>{b("Leo Park")} claimed a Seat on {b("Advanced React Patterns")}</>,
        quote: "4 of 10 Seats claimed",
        action: "View team",
        subject: "Seat claimed — Advanced React Patterns",
        body: [
          `Hi ${k.firstName},`,
          "",
          `Leo Park (leo.park@example.com) claimed a Seat on your "Advanced React Patterns" Team Licence. 4 of 10 Seats are now claimed.`,
          "",
          `View your team: ${url(k)}`,
          "",
          sig,
          "",
          "You're getting this because you manage this Team Licence.",
        ],
      }),
      lastSeat: (k) => ({
        row: <>All Seats on {b("Advanced React Patterns")} are claimed</>,
        quote: "Leo Park claimed the last one (10 of 10).",
        action: "Buy more Seats",
        subject: "No Seats left — Advanced React Patterns",
        body: [
          `Hi ${k.firstName},`,
          "",
          `Leo Park claimed the last Seat on your "Advanced React Patterns" Team Licence. All 10 Seats are now claimed, so no one else on your team can join until you buy more.`,
          "",
          `Buy more Seats: ${url(k)}`,
          "",
          sig,
          "",
          "You're getting this because you manage this Team Licence.",
        ],
      }),
    },
  },
};

function footer(k: Kind): string[] {
  const settings = `Notification settings: ${SITE}/settings#notifications`;
  switch (k.footer) {
    case "switchable":
      return [
        `Stop emailing me about ${k.offLabel}: ${SITE}/n/off/<signed-token>`,
        settings,
      ];
    case "nudge":
      return [
        `Stop sending me these nudges (in the app too): ${SITE}/n/off/<signed-token>`,
        settings,
      ];
    case "always":
      return [
        "We always email you about refunds, because they change what you paid for or can access.",
        settings,
      ];
  }
}

function ago(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 60 / 24)}d`;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const GROUPS = [
  { label: "Any Comment author", keys: ["reply"] },
  { label: "Student", keys: ["firstVideo", "courseArchived", "notStarted", "stalled"] },
  { label: "Buyer", keys: ["refundApproved", "refundApprovedTeam", "refundDeclined", "refundIssued"] },
  { label: "Instructor", keys: ["newQuestion", "firstRating", "archivedByAdmin"] },
  { label: "Platform Admin", keys: ["newRefundRequest", "failedRefund"] },
  { label: "Team Admin", keys: ["seatClaimed", "lastSeat"] },
];

function InAppRow({ k, c }: { k: Kind; c: Copy }) {
  return (
    <div className="flex items-start gap-3 rounded-md border-l-4 border-l-primary bg-primary/5 px-3 py-2.5">
      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">{c.row}</p>
        {c.quote && (
          <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
            {c.quote}
          </p>
        )}
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{ago(k.minutesAgo)} ago</span>
          {k.important && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
              Important
            </span>
          )}
          {k.nudge && (
            <span className="rounded bg-sky-100 px-1.5 py-0.5 font-medium text-sky-900 dark:bg-sky-900/40 dark:text-sky-200">
              Nudge
            </span>
          )}
        </div>
      </div>
      <button className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground">
        {c.action}
      </button>
      <button
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted"
        title="Mark as read"
      >
        <Check className="size-4" />
      </button>
    </div>
  );
}

function EmailPreview({ k, c }: { k: Kind; c: Copy }) {
  return (
    <div className="overflow-hidden rounded-md border text-sm">
      <div className="space-y-0.5 border-b bg-muted/50 px-3 py-2 text-xs">
        <div>
          <span className="text-muted-foreground">From </span>Cadence
          &lt;hello@cadence.dev&gt;
        </div>
        <div>
          <span className="text-muted-foreground">Subject </span>
          <span className="font-semibold">{c.subject}</span>
        </div>
        <div className="text-muted-foreground">
          {k.footer === "always"
            ? "Always sent"
            : k.emailByDefault
              ? "Sent by default"
              : "Off by default (sent only if switched on in Settings)"}
        </div>
      </div>
      <pre className="whitespace-pre-wrap px-3 py-2 font-sans text-[13px] leading-relaxed">
        {c.body.join("\n")}
        {"\n\n"}
        <span className="text-muted-foreground">
          {"──────────\n" + footer(k).join("\n")}
        </span>
      </pre>
    </div>
  );
}

export default function NotificationContentPrototype() {
  const [searchParams] = useSearchParams();
  const key = VARIANTS[searchParams.get("variant") ?? "A"]
    ? (searchParams.get("variant") ?? "A")
    : "A";
  const variant = VARIANTS[key];
  const byKey = Object.fromEntries(KINDS.map((k) => [k.key, k]));

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6 pb-24">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-fuchsia-700">
          Prototype — Per-Channel content
        </p>
        <h1 className="text-2xl font-bold">
          {key}: {variant.name}
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{variant.blurb}</p>
      </header>

      {GROUPS.map((g) => (
        <section key={g.label} className="space-y-4">
          <h2 className="border-b pb-1 text-lg font-semibold">{g.label}</h2>
          {g.keys.map((kk) => {
            const k = byKey[kk];
            const c = variant.copy[kk](k);
            return (
              <article key={kk} className="space-y-2">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <h3 className="font-medium">{k.name}</h3>
                  <span className="text-xs text-muted-foreground">
                    to {k.recipient}
                  </span>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <InAppRow k={k} c={c} />
                    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                      <ArrowRight className="mt-0.5 size-3 shrink-0" />
                      <span>
                        <code className="text-foreground">{k.to}</code> —{" "}
                        {k.linkNote}
                      </span>
                    </p>
                  </div>
                  <div className="space-y-1">
                    <EmailPreview k={k} c={c} />
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Mail className="size-3" />
                      Opening the email's link marks the Notification read.
                    </p>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      ))}

      <PrototypeSwitcher
        variants={Object.entries(VARIANTS).map(([k, v]) => ({
          key: k,
          name: v.name,
        }))}
        current={key}
      />
    </div>
  );
}

