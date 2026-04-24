# QueryDoctor

QueryDoctor is a local-first CLI that diagnoses slow PostgreSQL queries and validates potential index fixes using HypoPG before applying anything to production.

## What it does

For the top slow statements in `pg_stat_statements`, QueryDoctor:

1. Sanitizes parameterized SQL
2. Runs `EXPLAIN (FORMAT JSON)`
3. Detects likely root causes (seq scans, wildcard LIKE, sorts)
4. Simulates an index with HypoPG
5. Compares planner cost before/after
6. Prints recommended SQL + confidence

## Requirements

- Node.js 18+
- PostgreSQL with:
  - `pg_stat_statements`
  - `hypopg`
- `DATABASE_URL` set in your environment

## Install

```bash
npm install
```

## Run

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/dbname npm start
```

Or after linking globally:

```bash
npm link
querydoctor
```

## Safety

- QueryDoctor does not create real indexes.
- It only creates hypothetical indexes (`hypopg_create_index`) and resets them (`hypopg_reset`).
- It performs read-only diagnosis queries and EXPLAIN plans.
