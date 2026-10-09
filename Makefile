# TermWeave developer shortcuts. Each target runs one documented command.
.DEFAULT_GOAL := help
.PHONY: help check install start test typecheck build

help: ## list targets
	@grep -E '^[a-z]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'
check: ## report missing prerequisites (installs nothing)
	sh install.sh --check
install: ## build reviewed local source into ~/.local/share/termweave-owned
	TERMWEAVE_INSTALL_DIR="$$HOME/.local/share/termweave-owned" sh install.sh --install
start: ## start the installed server on loopback
	bun "$$HOME/.local/share/termweave-owned/scripts/owned-server.ts" start
test: ## unit tests
	bun test src/lib shared
typecheck: ## TypeScript check
	bunx tsc --noEmit -p .
build: ## build the browser client
	bun run build
