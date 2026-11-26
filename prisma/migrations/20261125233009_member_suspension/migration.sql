-- AlterEnum
ALTER TYPE "ChapterAuditAction" ADD VALUE 'MEMBER_SUSPENDED';
ALTER TYPE "ChapterAuditAction" ADD VALUE 'MEMBER_UNSUSPENDED';

-- AlterTable
ALTER TABLE "volunteers" ADD COLUMN     "suspended_at" TIMESTAMP(3),
ADD COLUMN     "suspended_by_id" INTEGER,
ADD COLUMN     "suspension_reason" TEXT;

-- AddForeignKey
ALTER TABLE "volunteers" ADD CONSTRAINT "volunteers_suspended_by_id_fkey" FOREIGN KEY ("suspended_by_id") REFERENCES "volunteers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
