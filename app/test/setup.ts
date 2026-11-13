import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "~/db/schema";
import { setCurrentUserId } from "~/lib/session";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

/**
 * Creates a fresh in-memory SQLite database with all tables for testing.
 * Each call returns a new isolated database instance.
 *
 * Uses the same Drizzle migrations as the live database, ensuring
 * test and production schemas are always in sync.
 */
export function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const testDb = drizzle(sqlite, { schema });

  migrate(testDb, { migrationsFolder });

  return testDb;
}

/**
 * Seeds a minimal set of base data (user, category, course) that most tests need.
 * Returns the created IDs for use in test assertions.
 */
export function seedBaseData(testDb: ReturnType<typeof createTestDb>) {
  const user = testDb
    .insert(schema.users)
    .values({
      name: "Test User",
      email: "test@example.com",
      role: schema.UserRole.Student,
    })
    .returning()
    .get();

  const instructor = testDb
    .insert(schema.users)
    .values({
      name: "Test Instructor",
      email: "instructor@example.com",
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();

  const category = testDb
    .insert(schema.categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get();

  const course = testDb
    .insert(schema.courses)
    .values({
      title: "Test Course",
      slug: "test-course",
      description: "A test course",
      salesCopy: "## Test Course\n\nSales copy for the test course.",
      instructorId: instructor.id,
      categoryId: category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();

  return { user, instructor, category, course };
}

type TestDb = ReturnType<typeof createTestDb>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** An ISO timestamp `days` whole days before now. */
export function daysAgo(days: number) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

let userCounter = 0;

/** Adds a user with the given role. */
export function addUser(
  testDb: TestDb,
  name: string,
  role: schema.UserRole = schema.UserRole.Student
) {
  userCounter += 1;
  return testDb
    .insert(schema.users)
    .values({ name, email: `user${userCounter}@example.com`, role })
    .returning()
    .get();
}

/** Adds one module holding `count` lessons to a course. Returns the lesson ids. */
export function addLessons(testDb: TestDb, courseId: number, count: number) {
  const courseModule = testDb
    .insert(schema.modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();

  const lessonIds: number[] = [];
  for (let i = 0; i < count; i++) {
    const lesson = testDb
      .insert(schema.lessons)
      .values({
        moduleId: courseModule.id,
        title: `Lesson ${i + 1}`,
        position: i + 1,
        videoUrl: "https://example.com/video",
      })
      .returning()
      .get();
    lessonIds.push(lesson.id);
  }
  return lessonIds;
}

/**
 * A learner buying a course for themselves: a Purchase plus the Enrollment
 * the purchase flow creates alongside it.
 */
export function buyCourse(
  testDb: TestDb,
  userId: number,
  courseId: number,
  options: { amountPaid?: number; purchasedAt?: string } = {}
) {
  const purchasedAt = options.purchasedAt ?? new Date().toISOString();
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId,
      courseId,
      amountPaid: options.amountPaid ?? 4900,
      createdAt: purchasedAt,
    })
    .returning()
    .get();

  testDb
    .insert(schema.enrollments)
    .values({ userId, courseId, enrolledAt: purchasedAt })
    .run();

  return purchase;
}

/**
 * A Request carrying a session for `userId`, for code that resolves the
 * current user from the request (getAccess and friends).
 */
export async function requestAs(userId: number) {
  const setCookie = await setCurrentUserId(new Request("http://test/"), userId);
  const cookie = setCookie.split(";")[0];
  return new Request("http://test/", { headers: { Cookie: cookie } });
}
