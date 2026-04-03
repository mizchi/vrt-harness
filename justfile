# vrt-harness task runner

default:
  just --list

# ---- VRT (Visual Regression + Semantic Testing) ----

# Run VRT unit tests
vrt-test:
  node --test --experimental-strip-types src/**/*.test.ts

# Run VRT demo (kitty graphics)
vrt-demo:
  node --experimental-strip-types src/demo.ts

# Run fix loop demo (detect → reason → fix → verify)
vrt-demo-fix:
  node --experimental-strip-types src/demo-fix-loop.ts

# Run multi-scenario demo (3 complex scenarios)
vrt-demo-multi:
  node --experimental-strip-types src/demo-scenarios.ts

# Run 6-step dashboard rebuild demo
vrt-demo-multistep:
  node --experimental-strip-types src/demo-multistep.ts

# CSS recovery challenge (AI fixes random CSS deletion using VRT)
css-challenge *args:
  node --experimental-strip-types src/css-challenge.ts {{args}}

# CSS challenge benchmark (detection/recovery rates)
css-bench *args:
  NO_IMAGES=1 node --experimental-strip-types src/css-challenge-bench.ts {{args}}

# CSS benchmark (selector block deletion mode)
css-bench-selector *args:
  NO_IMAGES=1 node --experimental-strip-types src/css-challenge-bench.ts --mode selector {{args}}

# CSS benchmark on all fixtures
css-bench-all trials="30":
  NO_IMAGES=1 node --experimental-strip-types src/css-challenge-bench.ts --trials {{trials}} --fixture all

# CSS benchmark with crater backend (requires crater BiDi server on :9222)
css-bench-crater *args:
  NO_IMAGES=1 node --experimental-strip-types src/css-challenge-bench.ts --backend crater {{args}}

# CSS benchmark with crater prescanner + Chromium fallback
css-bench-prescanner *args:
  NO_IMAGES=1 node --experimental-strip-types src/css-challenge-bench.ts --backend prescanner {{args}}

# CSS detection pattern report (accumulated data analysis)
css-report:
  node --experimental-strip-types src/detection-report.ts

# Review generated approval suggestions and merge them into approval.json
vrt-approve *args:
  node --experimental-strip-types src/vrt-approve.ts {{args}}

# Migration VRT compare (before vs after)
migration-compare *args:
  node --experimental-strip-types src/migration-compare.ts {{args}}

# Migration fix loop (report -> fix -> rerun)
migration-fix-loop *args:
  node --experimental-strip-types src/migration-fix-loop.ts {{args}}

# Adapt migration-report.json to flaker TestCaseResult[] JSON
flaker-vrt-adapt *args:
  node --experimental-strip-types src/flaker-vrt-report-adapter.ts {{args}}

# Migration: Reset CSS comparison
migration-reset:
  node --experimental-strip-types src/migration-compare.ts --dir fixtures/migration/reset-css --baseline normalize.html --variants modern-normalize.html destyle.html no-reset.html

# Migration: Tailwind to vanilla CSS
migration-tailwind:
  node --experimental-strip-types src/migration-compare.ts fixtures/migration/tailwind-to-vanilla/before.html fixtures/migration/tailwind-to-vanilla/after.html

# Migration: shadcn/ui to luna
migration-shadcn:
  node --experimental-strip-types src/migration-compare.ts --dir fixtures/migration/shadcn-to-luna --baseline before.html --variants after.html

# Performance benchmark (deterministic APIs only)
bench:
  node --experimental-strip-types src/benchmark.ts

# API server (Hono, localhost)
api-server *args:
  node --experimental-strip-types src/api-server.ts {{args}}

# A11y-driven smoke test (random interaction)
smoke-test *args:
  node --experimental-strip-types src/smoke-runner.ts {{args}}

# Run Playwright VRT
vrt:
  playwright test

# Update VRT snapshots
vrt-update:
  playwright test --update-snapshots
