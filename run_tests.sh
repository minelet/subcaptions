#!/bin/sh
# Runs every automated test that does not need a network, a GPU or real clips. Exit code != 0 if anything fails.
set -e
cd "$(dirname "$0")"
echo "## caption timing (your real Groq fixture)";   node test/caption_timing.test.js public/index.html | tail -1
echo "## builder fuzz";                              node test/builder_fuzz.test.js public/index.html | tail -1
echo "## timing guard (legacy path)";                node test/guard.test.js | tail -1
echo "## aligned pipeline (client)";                 node test/aligned_pipeline.test.js public/index.html | tail -1
echo "## align proxy (vercel)";                      node aligner/tests/test_proxy.js | tail -1
echo "## aligner contract + gate logic (python)";    (cd aligner && python3 -m unittest discover -s tests 2>&1 | tail -3)
