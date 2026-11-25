-- Quick tasks become requests for help: tasks in 'Global requests', the holding pool's
-- standing project (lib/requests.ts), made here if no one has asked there yet. Each keeps its
-- row, so its id, comments, history and any skill endorsement given for it stay attached.
INSERT INTO "work_items" (
  "type", "status", "standing_requests", "title", "description", "national_chapter_id",
  "is_org_proposed", "auto_accept_tasks", "reviewed_at", "created_at", "updated_at"
)
SELECT 'PROJECT', 'in_progress', true, 'Global requests',
  'Small things people anywhere have asked for help with. Anyone can take one.', NULL,
  true, false, now(), now(), now()
WHERE EXISTS (SELECT 1 FROM "work_items" WHERE "type" = 'QUICK_TASK')
  AND NOT EXISTS (
    SELECT 1 FROM "work_items"
    WHERE "type" = 'PROJECT' AND "standing_requests" AND "national_chapter_id" IS NULL
  );

WITH "global" AS (
  SELECT "id" FROM "work_items"
  WHERE "type" = 'PROJECT' AND "standing_requests" AND "national_chapter_id" IS NULL
  ORDER BY "id" LIMIT 1
),
"last" AS (
  SELECT COALESCE(MAX("sort_order"), 0) AS "n" FROM "work_items"
  WHERE "parent_id" = (SELECT "id" FROM "global")
),
"moved" AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "created_at", "id") AS "n"
  FROM "work_items" WHERE "type" = 'QUICK_TASK'
)
UPDATE "work_items" AS "w" SET
  "type" = 'TASK',
  "parent_id" = (SELECT "id" FROM "global"),
  -- A quick task nobody has claimed is 'open'; a task's word for that is 'not_started'.
  "status" = CASE "w"."status" WHEN 'open' THEN 'not_started' ELSE "w"."status" END,
  -- A task follows its project's chapter and place.
  "national_chapter_id" = NULL,
  "local_group_id" = NULL,
  "reach" = 'COUNTRY_WIDE',
  -- The nudge and release clocks count from the claim, which quick tasks never recorded.
  "claimed_at" = CASE
    WHEN "w"."assignee_id" IS NULL THEN NULL
    ELSE COALESCE("w"."claimed_at", "w"."updated_at", "w"."created_at")
  END,
  "sort_order" = (SELECT "n" FROM "last") + "moved"."n"
FROM "moved"
WHERE "w"."id" = "moved"."id";
