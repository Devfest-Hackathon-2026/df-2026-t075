.PHONY: setup dev agent-check voice-check live-check check check-web check-agent check-db build e2e format docker-check
.PHONY: check-functions check-firestore check-firestore-emulator check-deployed-firestore deploy-web deploy-function
.PHONY: voice-worker meeting-voice-worker e2e-voice e2e-camera

FIREBASE ?= npx --yes firebase-tools@15.35.0
AGENT_ENV_FILE = $(if $(wildcard apps/agent/.env),--env-file .env)

setup:
	npm ci
	npm ci --prefix apps/functions
	cd apps/agent && uv sync --locked

dev:
	npm run dev

agent-check:
	cd apps/agent && uv run --locked python -m classroom_agent

voice-worker:
	cd apps/agent && uv run --locked $(AGENT_ENV_FILE) python -m classroom_agent.bootstrap.voice_worker

meeting-voice-worker:
	cd apps/agent && uv run --locked $(AGENT_ENV_FILE) python -m classroom_agent.bootstrap.voice_worker --meeting

# Calls Google services and is billed. See apps/agent/README.md before running.
voice-check:
	@cd apps/agent && uv run --locked $(AGENT_ENV_FILE) python -m classroom_agent voice-check \
		--audio "$(abspath $(or $(AUDIO),$(error Set AUDIO to a recorded WAV)))" \
		$(if $(REFERENCE),--reference "$(REFERENCE)") \
		$(if $(REPEAT),--repeat $(REPEAT))

# Serves a microphone test page on 127.0.0.1. Every turn is billed.
live-check:
	cd apps/agent && uv run --locked $(AGENT_ENV_FILE) python -m classroom_agent live-check \
		$(if $(PORT),--port $(PORT)) \
		$(if $(SAMPLE),--sample "$(abspath $(SAMPLE))") \
		$(if $(PATIENCE),--patience $(PATIENCE))

check: check-web check-agent check-functions

check-functions:
	npm --prefix apps/functions test

check-firestore: build
	FIRESTORE_TEST_MODE=live node --test tests/runtime/firestore-event.test.mjs

check-firestore-emulator: build
	FIRESTORE_TEST_MODE=emulator $(FIREBASE) emulators:exec --only firestore,functions --project demo-meeting-events "node --test tests/runtime/firestore-event.test.mjs"

check-deployed-firestore:
	node scripts/check-deployed-firestore.mjs

deploy-web:
	bash scripts/deploy-web.sh

deploy-function:
	$(FIREBASE) deploy --non-interactive --project "$${GOOGLE_CLOUD_PROJECT:?Set the target project}" --only functions:meeting-events:confirmFirestoreCheck

check-db: build
	npm run test:db

check-web:
	npm run check
	npm run build
	npm run test:runtime

check-agent:
	cd apps/agent && uv run --locked ruff format --check .
	cd apps/agent && uv run --locked ruff check .
	cd apps/agent && uv run --locked mypy src tests
	cd apps/agent && uv run --locked lint-imports
	cd apps/agent && uv run --locked pytest --cov --cov-report=term-missing --cov-report=xml

build:
	npm run build

e2e: build
	npm run test:e2e

# Requires the meeting worker, matching LiveKit credentials and a consented WAV.
e2e-voice: build
	PLAYWRIGHT_NO_COPY_PROMPT=1 MEETING_VOICE_ENABLED=1 MEETING_VOICE_LIVE=1 $(FIREBASE) emulators:exec --only auth,firestore --project demo-meeting-auth "npx playwright test tests/e2e/meeting-voice.spec.ts --workers=1"

# Uses a real LiveKit server and two virtual cameras. No AI worker is required.
e2e-camera: build
	PLAYWRIGHT_NO_COPY_PROMPT=1 MEETING_VOICE_ENABLED=1 MEETING_CAMERA_LIVE=1 $(FIREBASE) emulators:exec --only auth,firestore --project demo-meeting-auth "npx playwright test tests/e2e/meeting-camera.spec.ts tests/e2e/meeting-camera-map.spec.mjs --workers=1"

format:
	npm run format
	cd apps/agent && uv run --locked ruff format .

docker-check:
	bash scripts/docker-check.sh
