-- AlterTable
ALTER TABLE "work_items" ADD COLUMN     "estimated_total_hours" INTEGER,
ADD COLUMN     "is_outline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "planned_at" TIMESTAMP(3);

-- Projects already approved were planned the old way, all at once: they count as planned.
UPDATE "work_items"
SET "planned_at" = COALESCE("reviewed_at", "created_at")
WHERE "type" = 'PROJECT'
  AND "status" NOT IN ('draft', 'pending_review', 'needs_discussion');

-- Tasks on volunteer proposals not yet approved are the proposal's rough outline. Org and
-- template drafts skip review and Planning, so theirs stay real.
UPDATE "work_items" AS t
SET "is_outline" = true, "featured_as_quick_task" = false
FROM "work_items" AS p
WHERE t."type" = 'TASK'
  AND t."parent_id" = p."id"
  AND p."type" = 'PROJECT'
  AND p."status" IN ('draft', 'pending_review', 'needs_discussion')
  AND p."is_org_proposed" IS NOT TRUE
  AND p."template_origin_id" IS NULL;
