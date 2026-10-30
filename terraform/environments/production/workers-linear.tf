# =============================================================================
# Linear Bot Worker
# =============================================================================

resource "cloudflare_queue" "linear_events" {
  count      = var.enable_linear_bot ? 1 : 0
  account_id = var.cloudflare_account_id
  queue_name = "open-inspect-linear-events-${local.name_suffix}"
}

resource "cloudflare_queue" "linear_events_dlq" {
  count      = var.enable_linear_bot ? 1 : 0
  account_id = var.cloudflare_account_id
  queue_name = "open-inspect-linear-events-dlq-${local.name_suffix}"
}

# Build linear-bot worker bundle (only runs during apply, not plan)
resource "null_resource" "linear_bot_build" {
  count = var.enable_linear_bot ? 1 : 0

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = "${var.project_root}/packages/linear-bot"
  }
}

module "linear_bot_worker" {
  count  = var.enable_linear_bot ? 1 : 0
  source = "../../modules/cloudflare-worker"

  account_id       = var.cloudflare_account_id
  worker_name      = "open-inspect-linear-bot-${local.name_suffix}"
  worker_subdomain = var.cloudflare_worker_subdomain
  script_path      = local.linear_bot_script_path

  kv_namespaces = {
    LINEAR_KV = {
      namespace_id = module.linear_kv[0].namespace_id
    }
  }

  d1_databases = {
    WEBHOOK_DB = {
      database_id = cloudflare_d1_database.main.id
    }
  }

  r2_buckets = {
    WEBHOOK_PAYLOADS = {
      bucket_name = cloudflare_r2_bucket.webhook_payloads.name
    }
  }

  queue_bindings = {
    LINEAR_EVENTS_QUEUE = {
      queue_name = cloudflare_queue.linear_events[0].queue_name
    }
  }

  service_bindings = {
    CONTROL_PLANE = {
      service_name = "open-inspect-control-plane-${local.name_suffix}"
    }
  }

  enable_service_bindings = var.enable_service_bindings

  plain_text_bindings = merge(
    {
      CONTROL_PLANE_URL    = { value = local.control_plane_url }
      WEB_APP_URL          = { value = local.web_app_url }
      DEPLOYMENT_NAME      = { value = var.deployment_name }
      APP_NAME             = { value = var.app_name }
      DEFAULT_MODEL        = { value = var.linear_bot_default_model }
      CLASSIFICATION_MODEL = { value = var.classification_model }
      LINEAR_CLIENT_ID     = { value = var.linear_client_id }
      WORKER_URL           = { value = "https://open-inspect-linear-bot-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev" }
    },
    local.classifier_reasoning_effort_bindings
  )

  secrets = merge(
    {
      LINEAR_WEBHOOK_SECRET = { value = var.linear_webhook_secret }
      LINEAR_CLIENT_SECRET  = { value = var.linear_client_secret }
      SERVICE_AUTH_SECRET   = { value = random_password.service_auth_secret_linear_bot.result }
      LINEAR_API_KEY        = { value = var.linear_api_key }
    },
    local.classifier_secret_bindings
  )

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]
  cron_triggers       = ["35 * * * *"]

  depends_on = [null_resource.linear_bot_build[0], module.linear_kv[0], null_resource.d1_migrations, cloudflare_r2_bucket_lifecycle.webhook_payloads]
}

resource "cloudflare_queue_consumer" "linear_events" {
  count             = var.enable_linear_bot ? 1 : 0
  account_id        = var.cloudflare_account_id
  queue_id          = cloudflare_queue.linear_events[0].queue_id
  type              = "worker"
  script_name       = module.linear_bot_worker[0].worker_name
  dead_letter_queue = cloudflare_queue.linear_events_dlq[0].queue_name
  settings = {
    batch_size       = 1
    max_wait_time_ms = 1000
    max_concurrency  = 5
    max_retries      = 50
    retry_delay      = 60
  }
  depends_on = [module.linear_bot_worker]
}
