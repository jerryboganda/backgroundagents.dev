# =============================================================================
# R2 Media Storage
# =============================================================================

resource "cloudflare_r2_bucket" "media" {
  account_id = var.cloudflare_account_id
  name       = var.r2_media_bucket_name != "" ? var.r2_media_bucket_name : "open-inspect-media-${local.name_suffix}"
  location   = var.r2_media_location
}

# Private webhook payloads, persisted before queueing oversized deliveries.
resource "cloudflare_r2_bucket" "webhook_payloads" {
  account_id = var.cloudflare_account_id
  name       = "open-inspect-webhook-payloads-${local.name_suffix}"
  location   = var.r2_media_location
}

# Retain through both queues' maximum 14-day windows, including DLQ redrive.
# Expiry also reclaims orphans when an R2 write succeeds but Queue.send fails.
resource "cloudflare_r2_bucket_lifecycle" "webhook_payloads" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.webhook_payloads.name

  rules = [{
    id      = "expire-oversized-webhooks"
    enabled = true
    conditions = {
      prefix = "webhooks/"
    }
    delete_objects_transition = {
      condition = {
        type    = "Age"
        max_age = 31 * 24 * 60 * 60
      }
    }
  }]
}
