#!/bin/sh
# Stratified mining run. Two streams in parallel (the workers don't saturate the CPU alone).
cd "$(dirname "$0")/../.."
M="node --no-warnings scripts/mine-playtak.mjs"
( $M --size 6 --limit 6000 --threads 7 --out data/puzzles/playtak-6.jsonl
  $M --size 4 --limit 1500 --threads 7 --out data/puzzles/playtak-4.jsonl
  $M --size 8 --limit 800  --threads 7 --out data/puzzles/playtak-8.jsonl ) > data/mine-a.log 2>&1 &
( $M --size 5 --limit 6000 --threads 7 --out data/puzzles/playtak-5.jsonl
  $M --size 7 --limit 1500 --threads 7 --out data/puzzles/playtak-7.jsonl ) > data/mine-b.log 2>&1 &
wait
