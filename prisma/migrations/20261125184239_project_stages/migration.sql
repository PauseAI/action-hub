-- AlterTable
ALTER TABLE "work_items" ADD COLUMN     "estimated_total_hours" INTEGER,
ADD COLUMN     "is_outline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "planned_at" TIMESTAMP(3);

-- Projects already approved were planned the old way, all at once: they count as planned.
UPDATE "work_items"
SET "planned_at" = COALESCE("reviewed_at", "created_at")
WHERE "type" = 'PROJECT'
  AND "status" NOT IN ('draft', 'pending_review', 'needs_discussion');

-- Tasks on proposals not yet approved are the proposal's rough outline.
UPDATE "work_items" AS t
SET "is_outline" = true
FROM "work_items" AS p
WHERE t."type" = 'TASK'
  AND t."parent_id" = p."id"
  AND p."type" = 'PROJECT'
  AND p."status" IN ('draft', 'pending_review', 'needs_discussion');
