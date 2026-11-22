ALTER TABLE "enrollments" ADD COLUMN "reservation_reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "balance_reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "last_session_reminder_for" timestamp with time zone;