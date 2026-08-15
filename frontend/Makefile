# hermes-office-mobile - Vibe Coding 门禁
.PHONY: all install build lint gate dev test clean
all: install build

install:
	@npm ci 2>/dev/null || npm install

build:
	@npm run build

gate:
	@echo '[Gate] 检查代码质量...'
	@npm run build
	@echo '[Gate] ✅ 通过'

dev:
	@npm run dev

test:
	@cd frontend && npm run build

clean:
	@rm -rf frontend/dist

commit: gate
	@git add -A && git commit

