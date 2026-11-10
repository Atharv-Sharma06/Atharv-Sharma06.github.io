-- Hand-written migration: subscription periods are stored as the calendar days the
-- user entered, not as instants.
--
-- A period used to be kept as two instants: local midnight of its first day, and
-- local midnight after its last day, in the timezone that was set when it was entered.
-- Changing the timezone setting afterwards moved every period by a day, and a period
-- that ended on the eve of a daylight-saving change at midnight read back one day
-- long. A plan runs from one calendar day to another, so that is what is stored now;
-- the instants are derived from the days with whatever timezone is current.

ALTER TABLE "subscription_periods" DROP CONSTRAINT "subscription_periods_no_overlap";
ALTER TABLE "subscription_periods" DROP CONSTRAINT "subscription_periods_range";
DROP INDEX "subscription_periods_user_id_started_at_idx";

ALTER TABLE "subscription_periods" ADD COLUMN "start_date" DATE;
ALTER TABLE "subscription_periods" ADD COLUMN "last_date" DATE;

-- Existing periods keep the days they show today, in the timezone that is set today
-- (UTC when that setting is not a timezone PostgreSQL knows, so that no stored value can
-- stop the migration).
--
-- The last day is the day before the end instant. Where local midnight happens twice
-- (clocks going back at 01:00), the stored end can be the second midnight, one instant
-- after which still lies on the new day; stepping back on the local clock instead finds
-- the right day there. Where midnight is skipped (clocks going forward at 00:00), the
-- local clock reads 01:00 and stepping back on it does not leave the new day, while
-- stepping back on the instant does. Taking the earlier of the two is right in both
-- cases and agrees with either everywhere else.
--
-- Should the timezone differ from the one the periods were entered in, two of them can
-- land on the same first day. Every period then starts at least one day after the one
-- before it (a running maximum of start day minus position, plus position), and each one
-- ends the day before the next starts, so no day belongs to two plans and the
-- constraints below can always be added.
WITH zoned AS (
  SELECT sp."id", sp."user_id", sp."started_at", sp."ended_at",
         COALESCE((SELECT tz."name" FROM pg_timezone_names tz WHERE lower(tz."name") = lower(u."timezone") LIMIT 1), 'UTC') AS zone
    FROM "subscription_periods" sp JOIN "users" u ON u."id" = sp."user_id"
), days AS (
  SELECT "id", "user_id",
         ("started_at" AT TIME ZONE zone)::date AS s,
         LEAST((("ended_at" - interval '1 microsecond') AT TIME ZONE zone)::date,
               (("ended_at" AT TIME ZONE zone) - interval '1 microsecond')::date) AS l,
         row_number() OVER (PARTITION BY "user_id" ORDER BY "started_at", "id")::int AS n
    FROM zoned
), starts AS (
  SELECT "id", "user_id", n, l,
         max(s - n) OVER (PARTITION BY "user_id" ORDER BY n ROWS UNBOUNDED PRECEDING) + n AS s
    FROM days
), settled AS (
  SELECT "id", s,
         LEAST(l, (lead(s) OVER (PARTITION BY "user_id" ORDER BY n) - 1)) AS l
    FROM starts
)
UPDATE "subscription_periods" sp
   SET "start_date" = settled.s,
       "last_date" = CASE WHEN settled.l IS NULL THEN NULL ELSE GREATEST(settled.l, settled.s) END
  FROM settled
 WHERE settled."id" = sp."id";

ALTER TABLE "subscription_periods" ALTER COLUMN "start_date" SET NOT NULL;
ALTER TABLE "subscription_periods" DROP COLUMN "started_at";
ALTER TABLE "subscription_periods" DROP COLUMN "ended_at";

-- A period ends on or after the day it starts ...
ALTER TABLE "subscription_periods" ADD CONSTRAINT "subscription_periods_range" CHECK (
  "last_date" IS NULL OR "last_date" >= "start_date"
);
-- ... and no day belongs to two periods of the same user. As before, both columns are
-- compared as ranges so the constraint needs no extension; the days are inclusive.
ALTER TABLE "subscription_periods" ADD CONSTRAINT "subscription_periods_no_overlap"
  EXCLUDE USING gist (
    int4range("user_id", "user_id", '[]') WITH &&,
    daterange("start_date", "last_date", '[]') WITH &&
  );

-- CreateIndex
CREATE INDEX "subscription_periods_user_id_start_date_idx" ON "subscription_periods"("user_id", "start_date");

COMMENT ON COLUMN "subscription_periods"."start_date" IS 'First day on the plan, as a calendar day in the user''s timezone.';
COMMENT ON COLUMN "subscription_periods"."last_date" IS 'Last day on the plan (inclusive). NULL while the plan is still active.';
