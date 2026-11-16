// PROTOTYPE — throwaway, never merge to main.
// Question (wayfinder "Notification UI", #29): how should in-app Notifications
// look and behave? Three structurally different variants, mounted in the real
// app layout, switchable via `?variant=A|B|C`:
//   A — Bell + dropdown in the sidebar header; badge = unread; click = read + go.
//   B — "Notifications" page from a sidebar nav item; badge = unseen (opening the
//       page clears it); rows stay unread until opened; "Needs action" / "All" tabs.
//   C — Right-hand rail; Important Notifications are to-do cards that stay until
//       done or dismissed; informational ones are a quiet feed, read once shown.
//   D — A's bell, but the popup lists unread only; "See all" opens B's page.
// Data is fixtures picked by role (+ Team Admin); read state lives in memory only.
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  Bell,
  BellDot,
  Check,
  ChevronRight,
  Inbox,
  PanelRightClose,
  PanelRightOpen,
  X,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { UserRole } from "~/db/schema";

// ─── Fixtures ────────────────────────────────────────────────────────────────

export type ProtoNotification = {
  id: string;
  kind: string; // the Notification kind, as named in the event catalogue
  important: boolean; // Important Notification (act, money or access)
  nudge?: boolean;
  text: React.ReactNode;
  action: string; // label for the primary affordance
  to: string;
  minutesAgo: number;
  initiallyRead?: boolean;
};

const b = (s: string) => <strong className="font-semibold">{s}</strong>;

const STUDENT: ProtoNotification[] = [
  {
    id: "s-reply",
    kind: "Reply to your Comment",
    important: true,
    text: (
      <>
        {b("Priya Shah")} replied to your comment on {b("Generics in practice")}
      </>
    ),
    action: "Read reply",
    to: "/courses",
    minutesAgo: 95,
  },
  {
    id: "s-video",
    kind: "First video on a lesson",
    important: false,
    text: (
      <>
        New video in {b("Advanced React Patterns")}: {b("Server components")}
      </>
    ),
    action: "Watch",
    to: "/courses",
    minutesAgo: 180,
  },
  {
    id: "s-nudge",
    kind: "Nudge: Stalled",
    important: false,
    nudge: true,
    text: (
      <>
        You haven't watched {b("Intro to TypeScript")} for a week. Pick up at
        Lesson 4: Generics.
      </>
    ),
    action: "Resume",
    to: "/dashboard",
    minutesAgo: 60 * 20,
  },
  {
    id: "s-refund",
    kind: "Refund Request approved",
    important: true,
    text: (
      <>
        Your Refund Request for {b("CSS Grid Mastery")} was approved. Your
        access has ended; the money is on its way.
      </>
    ),
    action: "View purchase",
    to: "/dashboard",
    minutesAgo: 60 * 26,
  },
  {
    id: "s-archived",
    kind: "Course Archived",
    important: true,
    text: (
      <>
        {b("Node.js Fundamentals")} has been archived. You can still watch what
        you've started.
      </>
    ),
    action: "Open course",
    to: "/courses",
    minutesAgo: 60 * 24 * 5,
    initiallyRead: true,
  },
  {
    id: "s-video-old",
    kind: "First video on a lesson",
    important: false,
    text: (
      <>
        New video in {b("Intro to TypeScript")}: {b("Narrowing")}
      </>
    ),
    action: "Watch",
    to: "/courses",
    minutesAgo: 60 * 24 * 9,
    initiallyRead: true,
  },
];

const INSTRUCTOR: ProtoNotification[] = [
  {
    id: "i-q1",
    kind: "New Question",
    important: true,
    text: (
      <>
        {b("Sam Lee")} asked a question on {b("Generics in practice")}
      </>
    ),
    action: "Answer",
    to: "/instructor/questions",
    minutesAgo: 12,
  },
  {
    id: "i-q2",
    kind: "New Question",
    important: true,
    text: (
      <>
        {b("Ana Ruiz")} asked a question on {b("Conditional types")}
      </>
    ),
    action: "Answer",
    to: "/instructor/questions",
    minutesAgo: 140,
  },
  {
    id: "i-rating",
    kind: "First rating on a course",
    important: false,
    text: <>{b("Intro to TypeScript")} got its first rating: ★★★★☆</>,
    action: "See analytics",
    to: "/instructor/analytics",
    minutesAgo: 60 * 7,
  },
  {
    id: "i-archived",
    kind: "Course archived by a Platform Admin",
    important: true,
    text: <>A Platform Admin archived your course {b("Legacy jQuery")}</>,
    action: "Open course",
    to: "/instructor",
    minutesAgo: 60 * 30,
  },
  {
    id: "i-reply",
    kind: "Reply to your Comment",
    important: true,
    text: (
      <>
        {b("Sam Lee")} replied to your comment on {b("Mapped types")}
      </>
    ),
    action: "Read reply",
    to: "/instructor/questions",
    minutesAgo: 60 * 24 * 3,
    initiallyRead: true,
  },
];

const PLATFORM_ADMIN: ProtoNotification[] = [
  {
    id: "a-failed",
    kind: "Failed Refund",
    important: true,
    text: (
      <>
        Refund to {b("Jo Park")} for {b("Advanced React Patterns")} failed. The
        buyer hasn't been told.
      </>
    ),
    action: "Fix payout",
    to: "/admin/refunds",
    minutesAgo: 8,
  },
  {
    id: "a-rr1",
    kind: "New Open Refund Request",
    important: true,
    text: (
      <>
        {b("Lena Wolf")} asked for a refund on {b("CSS Grid Mastery")}
      </>
    ),
    action: "Decide",
    to: "/admin/refunds",
    minutesAgo: 45,
  },
  {
    id: "a-rr2",
    kind: "New Open Refund Request",
    important: true,
    text: (
      <>
        {b("Tom Brady")} asked for a refund on {b("Intro to TypeScript")}
      </>
    ),
    action: "Decide",
    to: "/admin/refunds",
    minutesAgo: 60 * 5,
  },
  {
    id: "a-reply",
    kind: "Reply to your Comment",
    important: true,
    text: (
      <>
        {b("Ana Ruiz")} replied to your comment on {b("Conditional types")}
      </>
    ),
    action: "Read reply",
    to: "/instructor/questions",
    minutesAgo: 60 * 24 * 2,
    initiallyRead: true,
  },
];

const TEAM_ADMIN: ProtoNotification[] = [
  {
    id: "t-last",
    kind: "Last Unclaimed Seat claimed",
    important: true,
    text: (
      <>
        {b("Chris Ng")} claimed the last Seat on your Team Licence for{" "}
        {b("Advanced React Patterns")}
      </>
    ),
    action: "Buy more Seats",
    to: "/team",
    minutesAgo: 30,
  },
  {
    id: "t-seat",
    kind: "Seat claimed",
    important: false,
    text: (
      <>
        {b("Mia Lopez")} claimed a Seat on {b("Advanced React Patterns")}
      </>
    ),
    action: "See team",
    to: "/team",
    minutesAgo: 60 * 6,
  },
];

function fixturesFor(
  role: UserRole | null,
  isTeamAdmin: boolean,
  many: boolean
) {
  const base =
    role === UserRole.Instructor
      ? INSTRUCTOR
      : role === UserRole.Admin
        ? PLATFORM_ADMIN
        : role === UserRole.Student
          ? STUDENT
          : [];
  const all = isTeamAdmin ? [...TEAM_ADMIN, ...base] : base;
  // ?many=1 — pad with ~45 older copies spread over ~4 weeks; the newest 18
  // of them unread, so the list is long and the unread count is in the 20s.
  const extra =
    many && all.length > 0
      ? Array.from({ length: 45 }, (_, i) => ({
          ...all[i % all.length],
          id: `${all[i % all.length].id}-x${i}`,
          minutesAgo: 60 * 4 + i * 60 * 14,
          initiallyRead: i >= 18,
        }))
      : [];
  return [...all, ...extra].sort((x, y) => x.minutesAgo - y.minutesAgo);
}

function ago(m: number) {
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 60 / 24)}d`;
}

// ─── In-memory state ─────────────────────────────────────────────────────────

type ProtoState = {
  variant: string;
  items: ProtoNotification[];
  read: Set<string>;
  dismissed: Set<string>;
  seenAt: number; // B only: count of items present when the page was last opened
  markRead: (id: string) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  markSeen: () => void;
  open: (n: ProtoNotification) => void;
};

const Ctx = createContext<ProtoState | null>(null);
const useProto = () => useContext(Ctx)!;

export const NOTIFICATION_VARIANTS = [
  { key: "A", name: "Bell + dropdown" },
  { key: "B", name: "Notifications page" },
  { key: "C", name: "Action rail" },
  { key: "D", name: "Bell (unread) + See all page" },
];

export function NotificationsPrototypeProvider({
  role,
  isTeamAdmin,
  children,
}: {
  role: UserRole | null;
  isTeamAdmin: boolean;
  children: React.ReactNode;
}) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const variant = searchParams.get("variant") ?? "A";
  const many = searchParams.get("many") === "1";
  const items = useMemo(
    () => fixturesFor(role, isTeamAdmin, many),
    [role, isTeamAdmin, many]
  );
  const initialRead = () =>
    new Set(items.filter((n) => n.initiallyRead).map((n) => n.id));
  const [read, setRead] = useState<Set<string>>(initialRead);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [seenAt, setSeenAt] = useState(0);

  // Reset when the DevUI switches user.
  useEffect(() => {
    setRead(initialRead());
    setDismissed(new Set());
    setSeenAt(0);
  }, [items]);

  const markRead = (id: string) => setRead((s) => new Set(s).add(id));
  const state: ProtoState = {
    variant,
    items,
    read,
    dismissed,
    seenAt,
    markRead,
    markAllRead: () => setRead(new Set(items.map((n) => n.id))),
    dismiss: (id) => {
      markRead(id);
      setDismissed((s) => new Set(s).add(id));
    },
    markSeen: () => setSeenAt(items.length),
    open: (n) => {
      markRead(n.id);
      // keep ?variant= across navigation so the prototype stays put
      navigate(`${n.to}?variant=${variant}${many ? "&many=1" : ""}`);
    },
  };
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function PrototypeVolumeToggle() {
  const [searchParams, setSearchParams] = useSearchParams();
  const many = searchParams.get("many") === "1";
  return (
    <button
      onClick={() => {
        const p = new URLSearchParams(searchParams);
        if (many) p.delete("many");
        else p.set("many", "1");
        setSearchParams(p, { replace: true, preventScrollReset: true });
      }}
      className="rounded-full bg-white/20 px-2 py-0.5 hover:bg-white/30"
    >
      {many ? "Few" : "Dozens"}
    </button>
  );
}

export function usePrototypeStateSummary() {
  const s = useProto();
  const unread = s.items.filter((n) => !s.read.has(n.id)).length;
  return `${s.items.length} total · ${unread} unread${
    s.variant === "B"
      ? ` · ${Math.max(0, s.items.length - s.seenAt)} unseen`
      : ""
  }${s.variant === "C" ? ` · ${s.dismissed.size} dismissed` : ""}`;
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

function Badge({ n, className }: { n: number; className?: string }) {
  if (n <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-bold leading-5 text-white",
        className
      )}
    >
      {n > 9 ? "9+" : n}
    </span>
  );
}

function KindTag({ n }: { n: ProtoNotification }) {
  if (n.nudge)
    return (
      <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-sky-800 dark:bg-sky-900 dark:text-sky-100">
        Nudge
      </span>
    );
  if (n.important)
    return (
      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800 dark:bg-amber-900 dark:text-amber-100">
        Important
      </span>
    );
  return null;
}

// ─── Variant A: bell + dropdown in the sidebar header ────────────────────────

export function SidebarHeaderSlot() {
  const s = useProto();
  if (s.variant === "A") return <BellDropdown />;
  if (s.variant === "D") return <BellDropdown unreadOnly />;
  return null;
}

function BellDropdown({ unreadOnly = false }: { unreadOnly?: boolean }) {
  const s = useProto();
  const [open, setOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const unread = s.items.filter((n) => !s.read.has(n.id)).length;
  const shown = unreadOnly ? s.items.filter((n) => !s.read.has(n.id)) : s.items;

  return (
    <div className="relative ml-auto">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent"
        title="Notifications"
      >
        {unread > 0 ? (
          <BellDot className="size-5" />
        ) : (
          <Bell className="size-5" />
        )}
        <Badge n={unread} className="absolute -right-1.5 -top-1" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-full top-0 z-50 ml-3 w-96 rounded-lg border bg-popover text-popover-foreground shadow-xl">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <span className="font-semibold">Notifications</span>
              <button
                onClick={s.markAllRead}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Mark all as read
              </button>
            </div>
            <ul className="max-h-[28rem] overflow-y-auto">
              {shown.length === 0 && (
                <li className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {unreadOnly ? "You're all caught up." : "Nothing yet."}
                </li>
              )}
              {shown.map((n) => {
                const isRead = s.read.has(n.id);
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => {
                        setOpen(false);
                        s.open(n);
                      }}
                      className={cn(
                        "flex w-full gap-3 border-b px-4 py-3 text-left text-sm hover:bg-accent",
                        !isRead && "bg-primary/5"
                      )}
                    >
                      <span
                        className={cn(
                          "mt-1.5 size-2 shrink-0 rounded-full",
                          isRead ? "bg-transparent" : "bg-primary"
                        )}
                      />
                      <span className="flex-1">
                        <span className={cn(isRead && "text-muted-foreground")}>
                          {n.text}
                        </span>
                        <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          {ago(n.minutesAgo)} ago <KindTag n={n} />
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {unreadOnly ? (
              <button
                onClick={() => {
                  setOpen(false);
                  const p = new URLSearchParams(searchParams);
                  p.set("inbox", "1");
                  setSearchParams(p);
                }}
                className="w-full px-4 py-2.5 text-center text-sm font-medium text-primary hover:bg-accent"
              >
                See all Notifications ({s.items.length})
              </button>
            ) : (
              <div className="px-4 py-2 text-center text-xs text-muted-foreground">
                {s.items.length} Notifications, all in this one list. No
                separate page in this variant.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Variant B: sidebar nav item → full Notifications page ───────────────────

export function SidebarNavSlot() {
  const s = useProto();
  const [searchParams, setSearchParams] = useSearchParams();
  if (s.variant !== "B") return null;
  const unseen = Math.max(0, s.items.length - s.seenAt);
  const active = searchParams.get("inbox") === "1";
  return (
    <button
      onClick={() => {
        const p = new URLSearchParams(searchParams);
        p.set("inbox", "1");
        setSearchParams(p);
      }}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}
    >
      <Inbox className="size-4" />
      Notifications
      <Badge n={unseen} className="ml-auto" />
    </button>
  );
}

/** Returns the page to render instead of <Outlet/>, or null. */
export function useMainOverride(): React.ReactNode | null {
  const s = useProto();
  const [searchParams] = useSearchParams();
  if (
    (s.variant === "B" || s.variant === "D") &&
    searchParams.get("inbox") === "1"
  )
    return <NotificationsPage />;
  return null;
}

function NotificationsPage() {
  const s = useProto();
  const [tab, setTab] = useState<"action" | "all">("action");
  useEffect(() => s.markSeen(), []);

  const list = s.items.filter((n) => tab === "all" || n.important);
  const groups: [string, ProtoNotification[]][] = [
    ["Today", list.filter((n) => n.minutesAgo < 60 * 24)],
    [
      "This week",
      list.filter((n) => n.minutesAgo >= 60 * 24 && n.minutesAgo < 60 * 24 * 7),
    ],
    ["Earlier", list.filter((n) => n.minutesAgo >= 60 * 24 * 7)],
  ];
  const unreadImportant = s.items.filter(
    (n) => n.important && !s.read.has(n.id)
  ).length;

  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Notifications</h1>
          <p className="text-sm text-muted-foreground">
            {s.variant === "D"
              ? "The bell counts unread. Each row stays unread until you open it or tick it."
              : "Opening this page clears the sidebar badge. Each row stays unread until you open it."}
          </p>
        </div>
        <button
          onClick={s.markAllRead}
          className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
        >
          <Check className="size-4" /> Mark all as read
        </button>
      </div>

      <div className="mb-4 flex gap-1 border-b">
        {(
          [
            ["action", `Needs action`, unreadImportant],
            ["all", "All", 0],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium",
              tab === key
                ? "border-primary"
                : "border-transparent text-muted-foreground"
            )}
          >
            {label}
            {count > 0 && <Badge n={count} />}
          </button>
        ))}
      </div>

      {list.length === 0 && (
        <p className="py-12 text-center text-muted-foreground">Nothing here.</p>
      )}
      {groups
        .filter(([, g]) => g.length > 0)
        .map(([label, g]) => (
          <section key={label} className="mb-6">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {label}
            </h2>
            <div className="divide-y rounded-lg border">
              {g.map((n) => {
                const isRead = s.read.has(n.id);
                return (
                  <div
                    key={n.id}
                    className={cn(
                      "flex items-center gap-4 p-4",
                      !isRead && "bg-primary/5"
                    )}
                  >
                    <div className="flex-1">
                      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{n.kind}</span> ·{" "}
                        <span>{ago(n.minutesAgo)} ago</span>
                        <KindTag n={n} />
                      </div>
                      <div
                        className={cn(
                          "text-sm",
                          isRead && "text-muted-foreground"
                        )}
                      >
                        {n.text}
                      </div>
                    </div>
                    {!isRead && (
                      <button
                        onClick={() => s.markRead(n.id)}
                        title="Mark as read"
                        className="rounded p-1 text-muted-foreground hover:bg-accent"
                      >
                        <Check className="size-4" />
                      </button>
                    )}
                    <button
                      onClick={() => s.open(n)}
                      className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                    >
                      {n.action} <ChevronRight className="size-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
    </div>
  );
}

// ─── Variant C: right-hand action rail ───────────────────────────────────────

export function RightRailSlot() {
  const s = useProto();
  const [collapsed, setCollapsed] = useState(false);
  if (s.variant !== "C") return null;

  const todo = s.items.filter(
    (n) =>
      (n.important || n.nudge) && !s.dismissed.has(n.id) && !s.read.has(n.id)
  );
  const feed = s.items.filter((n) => !n.important && !n.nudge);

  if (collapsed)
    return (
      <aside className="flex w-12 shrink-0 flex-col items-center gap-2 border-l py-3">
        <button
          onClick={() => setCollapsed(false)}
          className="rounded p-1.5 hover:bg-accent"
          title="Open"
        >
          <PanelRightOpen className="size-4" />
        </button>
        <Badge n={todo.length} />
      </aside>
    );

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l bg-muted/30">
      <div className="flex h-14 items-center justify-between border-b px-4">
        <span className="font-semibold">
          {todo.length > 0
            ? `${todo.length} need${todo.length === 1 ? "s" : ""} you`
            : "All caught up"}
        </span>
        <button
          onClick={() => setCollapsed(true)}
          className="rounded p-1.5 hover:bg-accent"
          title="Collapse"
        >
          <PanelRightClose className="size-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-2 p-3">
          {todo.map((n) => (
            <div
              key={n.id}
              className={cn(
                "rounded-lg border bg-background p-3 shadow-sm",
                n.nudge ? "border-sky-300" : "border-amber-300"
              )}
            >
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-2">
                  <KindTag n={n} /> {ago(n.minutesAgo)} ago
                </span>
                <button
                  onClick={() => s.dismiss(n.id)}
                  title="Dismiss"
                  className="rounded p-0.5 hover:bg-accent"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <p className="mb-3 text-sm">{n.text}</p>
              <div className="flex items-center justify-between">
                <button
                  onClick={() => s.open(n)}
                  className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {n.action}
                </button>
                {n.nudge && (
                  <Link
                    to="/settings"
                    className="text-xs text-muted-foreground underline"
                  >
                    Turn off Nudges
                  </Link>
                )}
              </div>
            </div>
          ))}
          {todo.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Nothing needs you right now.
            </p>
          )}
        </div>
        <div className="border-t p-3">
          <div className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Activity
          </div>
          <ul className="space-y-1">
            {feed.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => s.open(n)}
                  className="w-full rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {n.text}{" "}
                  <span className="opacity-60">· {ago(n.minutesAgo)}</span>
                </button>
              </li>
            ))}
            {feed.length === 0 && (
              <li className="px-2 text-xs text-muted-foreground">
                No activity.
              </li>
            )}
          </ul>
          <p className="mt-3 px-1 text-[11px] text-muted-foreground">
            Activity counts as read once shown; only cards above ever badge.
          </p>
        </div>
      </div>
    </aside>
  );
}
