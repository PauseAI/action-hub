-- CreateEnum
CREATE TYPE "ChapterTransferKind" AS ENUM ('SELF', 'SEND', 'BRING');

-- AlterEnum
ALTER TYPE "ChapterAuditAction" ADD VALUE 'TRANSFER_REQUESTED';

-- AlterTable
ALTER TABLE "chapter_transfer_requests" ADD COLUMN     "kind" "ChapterTransferKind" NOT NULL DEFAULT 'SELF',
ADD COLUMN     "requested_by_id" INTEGER;

-- AddForeignKey
ALTER TABLE "chapter_transfer_requests" ADD CONSTRAINT "chapter_transfer_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "volunteers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
