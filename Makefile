# Shipyard — common tasks. Run `make` (or `make help`) to list them.

SHELL := /bin/bash
.DEFAULT_GOAL := help

NPM        ?= npm
DATA_DIR   ?= $(HOME)/.shipyard
API_PORT   ?= 4317

export SHIPYARD_DATA_DIR := $(DATA_DIR)
export SHIPYARD_PORT     := $(API_PORT)

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage: make \033[36m<target>\033[0m\n"} \
		/^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 } \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)
	@echo

##@ Setup

.PHONY: install
install: ## Install dependencies for all workspaces
	$(NPM) install

node_modules: package.json package-lock.json
	$(NPM) install
	@touch node_modules

.PHONY: doctor
doctor: ## Check that node, git, the Claude CLI and the GitHub CLI are ready
	@ok=1; \
	check() { if eval "$$2" >/dev/null 2>&1; then printf "  \033[32m✓\033[0m %s\n" "$$1"; else printf "  \033[31m✗\033[0m %s  →  %s\n" "$$1" "$$3"; ok=0; fi; }; \
	check "node >= 22"           'node -e "process.exit(+process.versions.node.split(\".\")[0] >= 22 ? 0 : 1)"' "install Node 22+"; \
	check "git"                  "git --version"     "install git"; \
	check "claude CLI"           "claude --version"  "npm install -g @anthropic-ai/claude-code, then run claude once to sign in"; \
	check "gh CLI"               "gh --version"      "brew install gh"; \
	check "gh signed in"         "gh auth status"    "gh auth login"; \
	check "dependencies"         "test -d node_modules" "make install"; \
	[ $$ok = 1 ]

##@ Develop

.PHONY: dev
dev: node_modules ## Run API (:4317) and UI (:5317) with hot reload
	$(NPM) run dev

.PHONY: server
server: node_modules ## Run only the API with hot reload
	$(NPM) run dev -w @shipyard/server

.PHONY: web
web: node_modules ## Run only the UI dev server (expects the API on :4317)
	$(NPM) run dev -w @shipyard/web

.PHONY: typecheck
typecheck: node_modules shared ## Type-check every workspace
	$(NPM) run typecheck

.PHONY: test
test: node_modules shared ## Run the test suite
	$(NPM) test

.PHONY: test-watch
test-watch: node_modules shared ## Run server tests in watch mode
	cd apps/server && npx vitest

.PHONY: check
check: typecheck test ## Type-check and test (run before committing)

##@ Build & run

.PHONY: shared
shared: node_modules
	@$(NPM) run build -w @shipyard/shared >/dev/null

.PHONY: build
build: node_modules ## Build shared, server and web for production
	$(NPM) run build

.PHONY: start
start: build ## Build, then serve API + UI from one process on :4317
	NODE_ENV=production $(NPM) start

##@ Database

.PHONY: db-generate
db-generate: node_modules ## Generate a migration after editing apps/server/src/db/schema.ts
	$(NPM) run db:generate

.PHONY: db-shell
db-shell: ## Open the SQLite database in the sqlite3 shell
	sqlite3 "$(DATA_DIR)/shipyard.db"

.PHONY: db-backup
db-backup: ## Back up the database into ~/.shipyard/backups/
	@mkdir -p "$(DATA_DIR)/backups"
	sqlite3 "$(DATA_DIR)/shipyard.db" ".backup '$(DATA_DIR)/backups/shipyard-$$(date +%Y%m%d-%H%M%S).db'"
	@echo "Backed up to $(DATA_DIR)/backups/"

##@ Housekeeping

.PHONY: worktrees
worktrees: ## List the git worktrees Shipyard created for implementation runs
	@find "$(DATA_DIR)/worktrees" -mindepth 2 -maxdepth 2 -type d 2>/dev/null || echo "No worktrees yet."

.PHONY: audit
audit: ## Check dependencies for known vulnerabilities
	$(NPM) audit

.PHONY: clean
clean: ## Remove build output (dist folders)
	rm -rf packages/shared/dist apps/server/dist apps/web/dist

.PHONY: distclean
distclean: clean ## Remove build output and node_modules
	rm -rf node_modules apps/*/node_modules packages/*/node_modules
