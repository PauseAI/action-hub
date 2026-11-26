-- CreateEnum
CREATE TYPE "StaffMergeGate" AS ENUM ('MAILBOXES', 'SECOND_ADMIN');

-- CreateTable
CREATE TABLE "staff_merge_requests" (
    "id" SERIAL NOT NULL,
    "kept_id" INTEGER NOT NULL,
    "merged_id" INTEGER NOT NULL,
    "requested_by_id" INTEGER,
    "gate" "StaffMergeGate" NOT NULL,
    "kept_token" TEXT,
    "merged_token" TEXT,
    "kept_confirmed_at" TIMESTAMP(3),
    "merged_confirmed_at" TIMESTAMP(3),
    "approved_by_id" INTEGER,
    "settled_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_merge_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_merge_requests_kept_token_key" ON "staff_merge_requests"("kept_token");

-- CreateIndex
CREATE UNIQUE INDEX "staff_merge_requests_merged_token_key" ON "staff_merge_requests"("merged_token");

-- CreateIndex
CREATE INDEX "idx_staff_merge_requests_kept" ON "staff_merge_requests"("kept_id");

-- CreateIndex
CREATE INDEX "idx_staff_merge_requests_merged" ON "staff_merge_requests"("merged_id");

-- AddForeignKey
ALTER TABLE "staff_merge_requests" ADD CONSTRAINT "staff_merge_requests_kept_id_fkey" FOREIGN KEY ("kept_id") REFERENCES "volunteers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "staff_merge_requests" ADD CONSTRAINT "staff_merge_requests_merged_id_fkey" FOREIGN KEY ("merged_id") REFERENCES "volunteers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "staff_merge_requests" ADD CONSTRAINT "staff_merge_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "volunteers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "staff_merge_requests" ADD CONSTRAINT "staff_merge_requests_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "volunteers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

