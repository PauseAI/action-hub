-- CreateEnum
CREATE TYPE "OnboardingRole" AS ENUM ('LEAD', 'DEPUTY', 'MEMBER');

-- CreateTable
CREATE TABLE "onboarding_members" (
    "volunteer_id" INTEGER NOT NULL,
    "role" "OnboardingRole" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_members_pkey" PRIMARY KEY ("volunteer_id")
);

-- CreateTable
CREATE TABLE "onboarding_slots" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "first_day" DATE NOT NULL,
    "every_weeks" INTEGER NOT NULL,
    "time" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_calls" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "slot_id" INTEGER,
    "slot_day" DATE,
    "host_id" INTEGER,
    "confirmed_at" TIMESTAMP(3),
    "cover_requested_at" TIMESTAMP(3),
    "reminded_at" TIMESTAMP(3),
    "team_asked_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "action_token" TEXT NOT NULL,
    "luma_event_id" TEXT,
    "luma_url" TEXT,
    "luma_host_email" TEXT,
    "luma_stale" BOOLEAN NOT NULL DEFAULT true,
    "luma_guests" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "meet_link" TEXT,
    "luma_title" TEXT,
    "luma_description" TEXT,

    CONSTRAINT "onboarding_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_calls_action_token_key" ON "onboarding_calls"("action_token");

-- CreateIndex
CREATE INDEX "idx_onboarding_calls_starts" ON "onboarding_calls"("starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_calls_slot_id_slot_day_key" ON "onboarding_calls"("slot_id", "slot_day");

-- AddForeignKey
ALTER TABLE "onboarding_members" ADD CONSTRAINT "onboarding_members_volunteer_id_fkey" FOREIGN KEY ("volunteer_id") REFERENCES "volunteers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "onboarding_calls" ADD CONSTRAINT "onboarding_calls_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "onboarding_slots"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "onboarding_calls" ADD CONSTRAINT "onboarding_calls_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "volunteers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

