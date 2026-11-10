-- Web Components applications offer each other (manifest v2 embeds; docs/hub/HUB_GAPS.md G5)
CREATE TABLE "product_embeds" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "script_url" TEXT NOT NULL,
    "attributes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_embeds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_embeds_tag_key" ON "product_embeds"("tag");
CREATE INDEX "product_embeds_application_id_idx" ON "product_embeds"("application_id");

ALTER TABLE "product_embeds" ADD CONSTRAINT "product_embeds_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
