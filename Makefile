# Convenience targets. Everything here is a thin wrapper over an npm script or a documented
# command — nothing happens in this file that is not also written down in DEMO.md.
.PHONY: help install node schema seed calibrate replay explain bench audit test typecheck check clean

DB_URL ?= postgresql://root@localhost:26257/sleeper?sslmode=disable
STORE  ?= /tmp/sleeper-crdb

help:
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## npm ci
	npm ci

# ── Local cluster ─────────────────────────────────────────────────────────────
node: ## Start a local single-node CockroachDB and create the database
	cockroach start-single-node --insecure --listen-addr=localhost:26257 \
		--http-addr=localhost:8081 --store=$(STORE) --background
	@until cockroach sql --insecure -e 'SELECT 1' >/dev/null 2>&1; do sleep 1; done
	cockroach sql --insecure -e 'CREATE DATABASE IF NOT EXISTS sleeper'
	@echo "ready — export DATABASE_URL='$(DB_URL)'"

schema: ## Apply tables and vector indexes
	DATABASE_URL='$(DB_URL)' npm run schema

seed: ## Load the playbook and held-out arc corpora
	DATABASE_URL='$(DB_URL)' SLEEPER_OFFLINE=1 npm run seed

calibrate: ## Fit thresholds on the playbook split only (needs Bedrock)
	DATABASE_URL='$(DB_URL)' npm run calibrate

# ── The demo ──────────────────────────────────────────────────────────────────
replay: ## Replay the xz timeline through the gate
	DATABASE_URL='$(DB_URL)' SLEEPER_OFFLINE=1 npm run replay

explain: ## Evidence trail for a hold — make explain HOLD=<uuid>
	DATABASE_URL='$(DB_URL)' npm run explain -- --hold $(HOLD)

audit: ## Drive the Managed MCP Server path end to end (needs COCKROACH_MCP_API_KEY)
	npm run mcp:audit

bench: ## Benchmark (refuses to compute accuracy offline, by design)
	DATABASE_URL='$(DB_URL)' npm run bench

# ── Checks ────────────────────────────────────────────────────────────────────
typecheck: ## tsc --noEmit
	npm run typecheck

test: ## Full suite against the local node
	DATABASE_URL='$(DB_URL)' SLEEPER_OFFLINE=1 npm test

check: typecheck test ## What CI runs

clean: ## Stop the local node and delete its store
	-cockroach quit --insecure 2>/dev/null || true
	rm -rf $(STORE)
