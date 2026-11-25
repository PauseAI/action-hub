-- AlterTable
ALTER TABLE "volunteers" ADD COLUMN     "fast_track" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fast_track_next_ask_at" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "fast_track_set_at" TIMESTAMP(3),
ADD COLUMN     "fast_track_set_by_id" INTEGER;

-- AlterTable
ALTER TABLE "work_items" ADD COLUMN     "always_ask_to_join" BOOLEAN NOT NULL DEFAULT false;


-- Volunteers already past the first mark are next asked about three tasks from where they are,
-- not all at once on their next accepted task. Counts as acceptedTaskCount (lib/fast-track.ts).
UPDATE "volunteers" v SET "fast_track_next_ask_at" = 3 + (
  SELECT count(DISTINCT e."work_item_id")
  FROM "work_item_events" e
  JOIN "work_items" t ON t."id" = e."work_item_id"
  LEFT JOIN "work_items" p ON p."id" = t."parent_id"
  WHERE e."actor_id" = v."id"
    AND e."kind" = 'submitted'
    AND t."type" = 'TASK'
    AND t."status" = 'completed'
    AND t."assignee_id" = v."id"
    AND (p."assignee_id" IS NULL OR p."assignee_id" <> v."id")
);
