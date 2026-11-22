CREATE TYPE "public"."auth_token_type" AS ENUM('verify_email', 'reset_password');--> statement-breakpoint
CREATE TYPE "public"."campaign_event_type" AS ENUM('impression', 'click');--> statement-breakpoint
CREATE TYPE "public"."campaign_placement" AS ENUM('hero_banner', 'banner_seccion', 'popup', 'barra_superior');--> statement-breakpoint
CREATE TYPE "public"."campaign_target" AS ENUM('producto', 'curso', 'edicion', 'categoria');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('borrador', 'publicado', 'archivado');--> statement-breakpoint
CREATE TYPE "public"."coupon_scope" AS ENUM('todo', 'productos', 'cursos', 'categorias', 'items');--> statement-breakpoint
CREATE TYPE "public"."coupon_type" AS ENUM('porcentaje', 'monto_fijo', 'envio_gratis');--> statement-breakpoint
CREATE TYPE "public"."deposit_type" AS ENUM('monto', 'porcentaje');--> statement-breakpoint
CREATE TYPE "public"."edition_status" AS ENUM('abierta', 'llena', 'cerrada', 'finalizada', 'cancelada');--> statement-breakpoint
CREATE TYPE "public"."enrollment_status" AS ENUM('lista', 'reservada', 'abonada', 'pagada', 'vencida', 'cancelada');--> statement-breakpoint
CREATE TYPE "public"."guest_subject" AS ENUM('order', 'enrollment');--> statement-breakpoint
CREATE TYPE "public"."order_item_type" AS ENUM('product', 'service');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pendiente_pago', 'pagado', 'preparando', 'enviado', 'entregado', 'cancelado');--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('order', 'enrollment');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('wompi', 'efectivo', 'transferencia');--> statement-breakpoint
CREATE TYPE "public"."payment_mode" AS ENUM('total', 'reserva', 'abono', 'lista');--> statement-breakpoint
CREATE TYPE "public"."payment_purpose" AS ENUM('total', 'reserva', 'abono', 'saldo');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pendiente', 'aprobado', 'rechazado', 'error', 'anulado');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('nueva', 'contactada', 'cerrada');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('CLIENTE', 'ADMIN', 'SUPER_ADMIN');--> statement-breakpoint
CREATE TYPE "public"."service_mode" AS ENUM('pago_online', 'cotizacion');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" varchar(80) NOT NULL,
	"entity_type" varchar(60) NOT NULL,
	"entity_id" varchar(60),
	"before" jsonb,
	"after" jsonb,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "auth_token_type" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "guest_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"subject_type" "guest_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"email" varchar(254) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_id" uuid,
	"user_agent" text,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"password_hash" text NOT NULL,
	"name" varchar(120) NOT NULL,
	"phone" varchar(20),
	"document" varchar(30),
	"role" "role" DEFAULT 'CLIENTE' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"data_policy_accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"slug" varchar(140) NOT NULL,
	"description" text,
	"image_url" text,
	"image_public_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"url" text NOT NULL,
	"public_id" text NOT NULL,
	"alt" varchar(200),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"slug" varchar(220) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price" integer NOT NULL,
	"compare_at_price" integer,
	"stock" integer DEFAULT 0 NOT NULL,
	"sku" varchar(60),
	"category_id" uuid,
	"weight_grams" integer,
	"width_mm" integer,
	"height_mm" integer,
	"depth_mm" integer,
	"materials" text,
	"status" "content_status" DEFAULT 'borrador' NOT NULL,
	"is_unique" boolean DEFAULT false NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug"),
	CONSTRAINT "products_sku_unique" UNIQUE("sku"),
	CONSTRAINT "products_price_chk" CHECK ("products"."price" >= 0),
	CONSTRAINT "products_stock_chk" CHECK ("products"."stock" >= 0),
	CONSTRAINT "products_compare_chk" CHECK ("products"."compare_at_price" IS NULL OR "products"."compare_at_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quote_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid,
	"name" varchar(120) NOT NULL,
	"email" varchar(254) NOT NULL,
	"phone" varchar(20),
	"desired_date" timestamp with time zone,
	"details" text NOT NULL,
	"status" "quote_status" DEFAULT 'nueva' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"url" text NOT NULL,
	"public_id" text NOT NULL,
	"alt" varchar(200),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"slug" varchar(220) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price" integer,
	"mode" "service_mode" DEFAULT 'cotizacion' NOT NULL,
	"status" "content_status" DEFAULT 'borrador' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_slug_unique" UNIQUE("slug"),
	CONSTRAINT "services_price_chk" CHECK ("services"."price" IS NULL OR "services"."price" >= 0),
	CONSTRAINT "services_online_price_chk" CHECK ("services"."mode" <> 'pago_online' OR "services"."price" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "course_editions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"location" varchar(200) NOT NULL,
	"instructor" varchar(120),
	"max_seats" integer NOT NULL,
	"price" integer NOT NULL,
	"enrollment_deadline" timestamp with time zone NOT NULL,
	"status" "edition_status" DEFAULT 'abierta' NOT NULL,
	"allowed_payment_modes" "payment_mode"[] DEFAULT ARRAY['total']::payment_mode[] NOT NULL,
	"reservation_hours" integer DEFAULT 48 NOT NULL,
	"deposit_type" "deposit_type" DEFAULT 'porcentaje' NOT NULL,
	"deposit_value" integer DEFAULT 30 NOT NULL,
	"balance_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_editions_seats_chk" CHECK ("course_editions"."max_seats" > 0),
	CONSTRAINT "course_editions_price_chk" CHECK ("course_editions"."price" >= 0),
	CONSTRAINT "course_editions_reservation_chk" CHECK ("course_editions"."reservation_hours" > 0),
	CONSTRAINT "course_editions_deposit_chk" CHECK ("course_editions"."deposit_value" > 0)
);
--> statement-breakpoint
CREATE TABLE "course_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"url" text NOT NULL,
	"public_id" text NOT NULL,
	"alt" varchar(200),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"slug" varchar(220) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"level" varchar(40),
	"duration_text" varchar(120),
	"includes" text,
	"status" "content_status" DEFAULT 'borrador' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courses_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "edition_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edition_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	CONSTRAINT "edition_sessions_range_chk" CHECK ("edition_sessions"."ends_at" > "edition_sessions"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edition_id" uuid NOT NULL,
	"user_id" uuid,
	"contact_name" varchar(120) NOT NULL,
	"contact_email" varchar(254) NOT NULL,
	"contact_phone" varchar(20) NOT NULL,
	"contact_document" varchar(30),
	"status" "enrollment_status" DEFAULT 'lista' NOT NULL,
	"payment_mode" "payment_mode" NOT NULL,
	"total_amount" integer NOT NULL,
	"paid_amount" integer DEFAULT 0 NOT NULL,
	"reserved_until" timestamp with time zone,
	"balance_due_at" timestamp with time zone,
	"waitlist_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollments_amounts_chk" CHECK ("enrollments"."total_amount" >= 0 AND "enrollments"."paid_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(40),
	"type" "coupon_type" NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"applies_to" "coupon_scope" DEFAULT 'todo' NOT NULL,
	"target_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"min_purchase" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"max_uses" integer,
	"max_uses_per_email" integer,
	"is_automatic" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_value_chk" CHECK ("coupons"."value" >= 0),
	CONSTRAINT "coupons_pct_chk" CHECK ("coupons"."type" <> 'porcentaje' OR "coupons"."value" BETWEEN 1 AND 100),
	CONSTRAINT "coupons_code_auto_chk" CHECK (("coupons"."is_automatic" AND "coupons"."code" IS NULL) OR (NOT "coupons"."is_automatic" AND "coupons"."code" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"item_type" "order_item_type" NOT NULL,
	"product_id" uuid,
	"service_id" uuid,
	"name_snapshot" varchar(200) NOT NULL,
	"unit_price" integer NOT NULL,
	"quantity" integer NOT NULL,
	"line_total" integer NOT NULL,
	CONSTRAINT "order_items_qty_chk" CHECK ("order_items"."quantity" > 0 AND "order_items"."unit_price" >= 0),
	CONSTRAINT "order_items_ref_chk" CHECK (("order_items"."product_id" IS NULL) <> ("order_items"."service_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "orders_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" uuid,
	"contact_name" varchar(120) NOT NULL,
	"contact_email" varchar(254) NOT NULL,
	"contact_phone" varchar(20) NOT NULL,
	"contact_document" varchar(30),
	"status" "order_status" DEFAULT 'pendiente_pago' NOT NULL,
	"subtotal" integer NOT NULL,
	"discount_total" integer DEFAULT 0 NOT NULL,
	"shipping_total" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"coupon_id" uuid,
	"shipping_address" jsonb,
	"tracking_number" varchar(80),
	"needs_review" boolean DEFAULT false NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_number_unique" UNIQUE("number"),
	CONSTRAINT "orders_amounts_chk" CHECK ("orders"."subtotal" >= 0 AND "orders"."discount_total" >= 0 AND "orders"."shipping_total" >= 0 AND "orders"."total" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"order_id" uuid,
	"enrollment_id" uuid,
	"purpose" "payment_purpose" NOT NULL,
	"amount" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'COP' NOT NULL,
	"method" "payment_method" DEFAULT 'wompi' NOT NULL,
	"status" "payment_status" DEFAULT 'pendiente' NOT NULL,
	"reference" varchar(80) NOT NULL,
	"wompi_transaction_id" varchar(80),
	"wompi_raw" jsonb,
	"recorded_by" uuid,
	"note" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_reference_unique" UNIQUE("reference"),
	CONSTRAINT "payments_wompi_transaction_id_unique" UNIQUE("wompi_transaction_id"),
	CONSTRAINT "payments_amount_chk" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_currency_chk" CHECK ("payments"."currency" = 'COP'),
	CONSTRAINT "payments_subject_chk" CHECK (("payments"."kind" = 'order' AND "payments"."order_id" IS NOT NULL AND "payments"."enrollment_id" IS NULL)
        OR ("payments"."kind" = 'enrollment' AND "payments"."enrollment_id" IS NOT NULL AND "payments"."order_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(30) NOT NULL,
	"event_id" varchar(120) NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_provider_event_uq" UNIQUE("provider","event_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"type" "campaign_event_type" NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "campaign_events_uq" UNIQUE("campaign_id","type","day")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"placement" "campaign_placement" NOT NULL,
	"image_desktop_url" text,
	"image_desktop_public_id" text,
	"image_mobile_url" text,
	"image_mobile_public_id" text,
	"title" varchar(200),
	"text" text,
	"cta_text" varchar(60),
	"cta_url" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"pages" text[] DEFAULT '{}'::text[] NOT NULL,
	"popup_frequency_hours" integer DEFAULT 24 NOT NULL,
	"target_type" "campaign_target",
	"target_id" uuid,
	"coupon_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_range_chk" CHECK ("campaigns"."ends_at" > "campaigns"."starts_at"),
	CONSTRAINT "campaigns_target_chk" CHECK (("campaigns"."target_type" IS NULL) = ("campaigns"."target_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coupon_id" uuid NOT NULL,
	"order_id" uuid,
	"enrollment_id" uuid,
	"email" varchar(254) NOT NULL,
	"discount_amount" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_redemptions_order_uq" UNIQUE("coupon_id","order_id"),
	CONSTRAINT "coupon_redemptions_enrollment_uq" UNIQUE("coupon_id","enrollment_id"),
	CONSTRAINT "coupon_redemptions_ref_chk" CHECK (("coupon_redemptions"."order_id" IS NULL) <> ("coupon_redemptions"."enrollment_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "site_settings" (
	"key" varchar(80) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_images" ADD CONSTRAINT "service_images_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_editions" ADD CONSTRAINT "course_editions_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_images" ADD CONSTRAINT "course_images_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition_sessions" ADD CONSTRAINT "edition_sessions_edition_id_course_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."course_editions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_edition_id_course_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."course_editions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_events" ADD CONSTRAINT "campaign_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_type_idx" ON "auth_tokens" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX "guest_links_subject_idx" ON "guest_links" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "product_images_product_idx" ON "product_images" USING btree ("product_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "product_images_primary_uq" ON "product_images" USING btree ("product_id") WHERE "product_images"."is_primary";--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "products_status_idx" ON "products" USING btree ("status");--> statement-breakpoint
CREATE INDEX "products_featured_idx" ON "products" USING btree ("is_featured");--> statement-breakpoint
CREATE INDEX "products_search_idx" ON "products" USING gin (to_tsvector('spanish', "name" || ' ' || "description"));--> statement-breakpoint
CREATE INDEX "quote_requests_status_idx" ON "quote_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "service_images_service_idx" ON "service_images" USING btree ("service_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "service_images_primary_uq" ON "service_images" USING btree ("service_id") WHERE "service_images"."is_primary";--> statement-breakpoint
CREATE INDEX "course_editions_course_status_idx" ON "course_editions" USING btree ("course_id","status");--> statement-breakpoint
CREATE INDEX "course_editions_deadline_idx" ON "course_editions" USING btree ("enrollment_deadline");--> statement-breakpoint
CREATE INDEX "course_images_course_idx" ON "course_images" USING btree ("course_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "course_images_primary_uq" ON "course_images" USING btree ("course_id") WHERE "course_images"."is_primary";--> statement-breakpoint
CREATE INDEX "edition_sessions_edition_idx" ON "edition_sessions" USING btree ("edition_id","starts_at");--> statement-breakpoint
CREATE INDEX "enrollments_edition_status_idx" ON "enrollments" USING btree ("edition_id","status");--> statement-breakpoint
CREATE INDEX "enrollments_user_idx" ON "enrollments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "enrollments_email_idx" ON "enrollments" USING btree (lower("contact_email"));--> statement-breakpoint
CREATE INDEX "enrollments_reserved_until_idx" ON "enrollments" USING btree ("reserved_until") WHERE "enrollments"."status" = 'reservada';--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_active_uq" ON "enrollments" USING btree ("edition_id",lower("contact_email")) WHERE "enrollments"."status" IN ('lista','reservada','abonada','pagada');--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_code_lower_uq" ON "coupons" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "orders_email_idx" ON "orders" USING btree (lower("contact_email"));--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_created_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_enrollment_idx" ON "payments" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaigns_active_idx" ON "campaigns" USING btree ("placement","is_active","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "coupon_redemptions_email_idx" ON "coupon_redemptions" USING btree ("coupon_id",lower("email"));