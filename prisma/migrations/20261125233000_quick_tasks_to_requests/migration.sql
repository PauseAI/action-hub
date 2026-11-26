-- Quick tasks become requests for help: tasks in their chapter's standing 'Requests for help'
-- project, or in 'Global requests' for the holding pool (lib/requests.ts). A standing project
-- is made here where none exists yet. Each quick task keeps its row, so its id, comments,
-- history and any skill endorsement given for it stay attached.
INSERT INTO "work_items" (
  "type", "status", "standing_requests", "title", "description", "national_chapter_id",
  "is_org_proposed", "auto_accept_tasks", "reviewed_at", "created_at", "updated_at"
)
SELECT DISTINCT 'PROJECT', 'in_progress', true,
  CASE WHEN c."id" IS NULL THEN 'Global requests' ELSE 'Requests for help: ' || c."name" END,
  CASE WHEN c."id" IS NULL
    THEN 'Small things people anywhere have asked for help with. Anyone can take one.'
    ELSE 'Small things people in ' || c."name" || ' have asked for help with. Anyone can take one.'
  END,
  c."id", true, false, now(), now(), now()
FROM "work_items" q
LEFT JOIN "national_chapters" c ON c."id" = q."national_chapter_id"
WHERE q."type" = 'QUICK_TASK'
  AND NOT EXISTS (
    SELECT 1 FROM "work_items" p
    WHERE p."type" = 'PROJECT' AND p."standing_requests"
      AND p."national_chapter_id" IS NOT DISTINCT FROM c."id"
  );

WITH "standing" AS (
  SELECT DISTINCT ON ("national_chapter_id") "id", "national_chapter_id"
  FROM "work_items"
  WHERE "type" = 'PROJECT' AND "standing_requests"
  ORDER BY "national_chapter_id", "id"
),
"moved" AS (
  SELECT q."id", s."id" AS "project_id",
    (SELECT COALESCE(MAX(t."sort_order"), 0) FROM "work_items" t WHERE t."parent_id" = s."id")
      + ROW_NUMBER() OVER (PARTITION BY s."id" ORDER BY q."created_at", q."id") AS "sort_order"
  FROM "work_items" q
  LEFT JOIN "national_chapters" c ON c."id" = q."national_chapter_id"
  JOIN "standing" s ON s."national_chapter_id" IS NOT DISTINCT FROM c."id"
  WHERE q."type" = 'QUICK_TASK'
)
UPDATE "work_items" AS "w" SET
  "type" = 'TASK',
  "parent_id" = "moved"."project_id",
  -- A quick task nobody has claimed is 'open'; a task's word for that is 'not_started'.
  "status" = CASE "w"."status" WHEN 'open' THEN 'not_started' ELSE "w"."status" END,
  -- A task follows its project's chapter and place.
  "national_chapter_id" = NULL,
  "local_group_id" = NULL,
  "reach" = 'COUNTRY_WIDE',
  "claimed_at" = CASE
    WHEN "w"."assignee_id" IS NULL THEN NULL
    ELSE COALESCE("w"."claimed_at", "w"."updated_at", "w"."created_at")
  END,
  -- The nudge job counts a task's inactivity from its last update: start it from the move, so
  -- an old claim gets the usual first nudge rather than an immediate final warning.
  "updated_at" = now(),
  "sort_order" = "moved"."sort_order"
FROM "moved"
WHERE "w"."id" = "moved"."id";
