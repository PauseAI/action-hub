-- CreateIndex
CREATE INDEX "idx_chapter_audit_target_created" ON "chapter_audit_events"("target_volunteer_id", "created_at");
